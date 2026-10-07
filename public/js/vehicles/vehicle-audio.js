import { vehicleOccupiedSeats } from '../../../shared/vehicle-seats.js';
import { vehicleDef, vehicleMaxHp } from '../../../shared/vehicle-defs.js';
import { vehicleStatus, vehicleMountOrder, decodeConquestPlayer } from '../../../shared/conquest-contract.js';

/** Presentation limits for the state-driven vehicle sounds (metres, counts). */
export const VEHICLE_AUDIO = Object.freeze({
  groundRange: 90, airRange: 170, maxEngineLoops: 4,
  burnRange: 70, maxBurnLoops: 2, wreckBurnSeconds: 14,
  hatchRange: 40, alarmFraction: 0.3,
});

const finite = value => Number.isFinite(value) ? value : 0;
const listenerOf = value => Array.isArray(value) ? value : [value?.x, value?.y ?? 0, value?.z];
const distanceTo = (pos, listener) => Math.hypot(pos[0] - listener[0], pos[1] - listener[1], pos[2] - listener[2]);
const LOCK_MODES = Object.freeze([null, 'locking', 'locked', 'inbound']);

/**
 * Owns the Conquest vehicle sounds that follow snapshot state: engine loops
 * (any occupied seat keeps a hull's engine running, so a jeep carrying only
 * passengers still drones), burning crackle, hatch slams when seats change,
 * reload clunks and, for the local crew, the damage alarm and lock tones.
 * Weapon reports come from authoritative shoot events (VehicleFx).
 */
export class VehicleAudio {
  constructor(sfx) {
    this.sfx = sfx;
    this.active = new Set();
    this.burning = new Set();
    this.seats = new Map();     // vehicleId -> occupied seat ids (for hatch cues)
    this.reloads = new Map();   // 'vehicleId:mountKey' -> reload100 last frame
    this._cues = false;
  }

  /**
   * rows: snapshot vehicle rows; listenerPosition: camera position;
   * context.self: the local player row (lock tones, alarm, reload clunks).
   */
  update(rows, listenerPosition, { self = null } = {}) {
    const listener = listenerOf(listenerPosition);
    const audible = listener.every(Number.isFinite);
    const list = Array.isArray(rows) ? rows : [];
    const selfId = self?.id != null ? String(self.id) : null;
    const candidates = [], fires = [];
    let ownHull = null, ownSeat = null;
    const presentSeats = new Map();
    for (const row of list) {
      const def = vehicleDef(row);
      if (!row || row.id == null || !def) continue;
      const pos = [row.x, row.y, row.z];
      if (!pos.every(Number.isFinite)) continue;
      const id = String(row.id);
      const alive = row.hp > 0 && !row.wreck;
      const seats = alive ? vehicleOccupiedSeats(row) : [];
      presentSeats.set(id, new Set(seats.map(seat => seat.id)));
      if (selfId) {
        const mine = seats.find(seat => String(seat.occupantId) === selfId);
        if (mine) { ownHull = row; ownSeat = mine.id; }
      }
      if (!audible) continue;
      const distance = distanceTo(pos, listener);
      const status = vehicleStatus(row);
      // Burning hulls and fresh wrecks crackle.
      const wreckAge = Number.isFinite(row.wreckAge) ? row.wreckAge : 0;
      if ((alive && status.burning) || (!alive && wreckAge < VEHICLE_AUDIO.wreckBurnSeconds)) {
        if (distance <= VEHICLE_AUDIO.burnRange) fires.push({ id, pos, distance, intensity: alive ? 0.8 : 1 - wreckAge / VEHICLE_AUDIO.wreckBurnSeconds });
      }
      if (!alive) continue;
      const speed = Math.abs(finite(row.speed));
      const trackSpeed = Math.max(Math.abs(finite(row.leftTrackSpeed)), Math.abs(finite(row.rightTrackSpeed)));
      const occupied = seats.length > 0;
      const rotorSpeed = Math.max(0, Math.min(1, finite(row.rotorSpeed)));
      const enginePower = Math.max(0, Math.min(1, finite(row.enginePower)));
      const handling = def.handling;
      const flying = handling === 'rotor' || handling === 'fixedwing';
      if (handling === 'rotor' ? rotorSpeed <= 0.01
        : handling === 'fixedwing' ? !occupied || row.engineOn === false || enginePower <= 0.01
          : !occupied && Math.max(speed, trackSpeed) < 0.15) continue;
      if (distance > (flying ? VEHICLE_AUDIO.airRange : VEHICLE_AUDIO.groundRange)) continue;
      candidates.push({ row, id, pos, distance, speed, trackSpeed, occupied, rotorSpeed, enginePower });
    }
    // Leave room in the shared six-loop budget for Bastion drones.
    candidates.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    const selected = candidates.slice(0, VEHICLE_AUDIO.maxEngineLoops);
    const next = new Set(selected.map(({ id }) => `conquest:${id}`));
    for (const key of this.active) if (!next.has(key)) this.sfx.stopVehicleLoop(key);
    for (const { row, id, pos, speed, trackSpeed, occupied, rotorSpeed, enginePower } of selected) {
      this.sfx.vehicleLoop(`conquest:${id}`, pos, row.type,
        { speed, trackSpeed, occupied, rotorSpeed, enginePower, engineOn: row.engineOn !== false });
    }
    this.active = next;

    fires.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    const burning = new Set();
    for (const fire of fires.slice(0, VEHICLE_AUDIO.maxBurnLoops)) {
      burning.add(fire.id);
      this.sfx.vehicleBurning?.(`burn:${fire.id}`, fire.pos, fire.intensity);
    }
    for (const id of this.burning) if (!burning.has(id)) this.sfx.stopVehicleBurning?.(`burn:${id}`);
    this.burning = burning;

    // Hatch cues when a nearby hull gains or loses crew.
    if (audible) for (const row of list) {
      if (row?.id == null) continue;
      const id = String(row.id), now = presentSeats.get(id), before = this.seats.get(id);
      if (!now || !before) continue;
      const pos = [row.x, row.y, row.z];
      if (!pos.every(Number.isFinite) || distanceTo(pos, listener) > VEHICLE_AUDIO.hatchRange) continue;
      const entered = [...now].some(seat => !before.has(seat)), left = [...before].some(seat => !now.has(seat));
      const mine = selfId != null && !!row.seatOccupants && Object.values(row.seatOccupants).map(String).includes(selfId);
      if (entered) this.sfx.vehicleHatch?.(pos, { enter: true, self: mine });
      else if (left && row.hp > 0) this.sfx.vehicleHatch?.(pos, { enter: false, self: false });
    }
    this.seats = presentSeats;

    this._crewCues(ownHull, ownSeat, self);
  }

  /** Alarm, lock tones and reload clunks for the local crew. */
  _crewCues(row, seatId, self) {
    if (!row) {
      if (this._cues) this.sfx.vehicleAlarm?.(false);
      this.sfx.vehicleLockTone?.(this._lockerMode(self));
      this._cues = false;
      this.reloads.clear();
      return;
    }
    this._cues = true;
    const ratio = finite(row.hp) / Math.max(1, vehicleMaxHp(row));
    this.sfx.vehicleAlarm?.(ratio > 0 && ratio < VEHICLE_AUDIO.alarmFraction);
    // A lock on the own hull outranks the own seeker.
    const threat = LOCK_MODES[Math.max(0, Math.min(3, finite(row.lk) | 0))];
    this.sfx.vehicleLockTone?.(threat || this._lockerMode(self));
    // Reload complete: the seat's mount reload counter returns to zero.
    const order = vehicleMountOrder(row.type);
    const seen = new Set();
    order.forEach((key, index) => {
      if (!key.startsWith(`${seatId}:`)) return;
      const state = Array.isArray(row.mounts?.[index]) ? row.mounts[index] : null;
      const reload = state ? finite(state[4]) : 0;
      const slot = `${row.id}:${key}`;
      seen.add(slot);
      const before = this.reloads.get(slot);
      if (Number.isFinite(before) && before > 0 && reload <= 0) {
        this.sfx.vehicleReload?.([row.x, row.y, row.z], { self: true, heavy: row.type === 'tank' && key.endsWith(':main') });
      }
      this.reloads.set(slot, reload);
    });
    for (const slot of this.reloads.keys()) if (!seen.has(slot)) this.reloads.delete(slot);
  }

  _lockerMode(self) {
    const progress = decodeConquestPlayer(self)?.lockProgress ?? 0;
    return progress >= 1 ? 'lock' : progress > 0 ? 'acquire' : null;
  }

  dispose() {
    for (const key of this.active) this.sfx.stopVehicleLoop(key);
    this.active.clear();
    for (const id of this.burning) this.sfx.stopVehicleBurning?.(`burn:${id}`);
    this.burning.clear();
    this.sfx.vehicleAlarm?.(false);
    this.sfx.vehicleLockTone?.(null);
    this.seats.clear();
    this.reloads.clear();
  }
}
