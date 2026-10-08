import { vehicleOccupiedSeats } from '../../../shared/vehicle-seats.js';
import { vehicleDef, vehicleMaxHp, mountAim } from '../../../shared/vehicle-defs.js';
import { vehicleStatus, vehicleMountOrder, decodeConquestPlayer } from '../../../shared/conquest-contract.js';

/** Presentation limits for the state-driven vehicle sounds (metres, counts). */
export const VEHICLE_AUDIO = Object.freeze({
  groundRange: 90, airRange: 170, maxEngineLoops: 4,
  burnRange: 70, maxBurnLoops: 2, wreckBurnSeconds: 14,
  hatchRange: 40, alarmFraction: 0.3,
  // Rotor spool cues: wind-up leaving rest, spool-down once an empty rotor slows.
  spoolRange: 170, spoolStart: 0.05, spoolDownFrom: 0.6,
  // Jet pass: a fast plane whose closest approach is near and imminent.
  flybyRange: 110, flybySpeed: 45, flybyLead: 4.6, flybyCooldown: 8,
  // Turret servo: traverse rate (rad/s) at full whine, hold after the last change.
  turretRange: 40, turretFullRate: 0.9, turretHold: 0.2,
  // Wading: hull within the river corridor near the surface; jeep skid on hard turns.
  wadeRange: 70, wadeDepth: 2.6, skidSpeed: 7, skidYawRate: 1.1, skidCooldown: 2.5,
});
const AIRCRAFT = new Set(['helicopter', 'transport', 'plane']);
const ROTORCRAFT = new Set(['helicopter', 'transport']);
const wrapAngle = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Horizontal distance from (x, z) to a polyline of [x, z] points. */
export function polylineDistance(x, z, points) {
  let best = Infinity;
  for (let i = 1; i < (points?.length || 0); i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i];
    const dx = bx - ax, dz = bz - az, len = dx * dx + dz * dz;
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}

/**
 * Closest approach of a body at `pos` moving with `vel` to `listener`:
 * { time (s, may be negative), distance (m), point }.
 */
export function closestApproach(pos, vel, listener) {
  const rx = pos[0] - listener[0], ry = pos[1] - listener[1], rz = pos[2] - listener[2];
  const vv = vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2];
  const time = vv > 1e-6 ? -(rx * vel[0] + ry * vel[1] + rz * vel[2]) / vv : 0;
  const point = [pos[0] + vel[0] * time, pos[1] + vel[1] * time, pos[2] + vel[2] * time];
  return { time, distance: Math.hypot(point[0] - listener[0], point[1] - listener[1], point[2] - listener[2]), point };
}
const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) / 1000;

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
  /** `river`: optional { points, width, surfaceY } (Conquest FRONTIER_PLAN.river) for the wading cue. */
  constructor(sfx, { river = null } = {}) {
    this.sfx = sfx;
    this.river = river && Array.isArray(river.points) ? river : null;
    this.active = new Set();
    this.burning = new Set();
    this.seats = new Map();     // vehicleId -> occupied seat ids (for hatch cues)
    this.reloads = new Map();   // 'vehicleId:mountKey' -> reload100 last frame
    this.motion = new Map();    // vehicleId -> per-hull cue state (rotor, flyby, turret, wade, skid)
    this.turrets = new Set();
    this.wading = new Set();
    this._cues = false;
  }

  /**
   * rows: snapshot vehicle rows; listenerPosition: camera position;
   * context.self: the local player row (lock tones, alarm, reload clunks).
   */
  update(rows, listenerPosition, { self = null, now = clock() } = {}) {
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
      this._motionCues(row, id, pos, distance, listener, seats, alive, selfId, now);
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
    for (const id of [...this.motion.keys()]) if (!presentSeats.has(id)) this._forget(id);
    // Leave room in the shared six-loop budget for Bastion drones.
    candidates.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    const selected = candidates.slice(0, VEHICLE_AUDIO.maxEngineLoops);
    const next = new Set(selected.map(({ id }) => `conquest:${id}`));
    for (const key of this.active) if (!next.has(key)) this.sfx.stopVehicleLoop(key);
    for (const { row, id, pos, speed, trackSpeed, occupied, rotorSpeed, enginePower } of selected) {
      // self: the listener rides this hull (interior layers); velocity: Doppler for aircraft.
      const velocity = [finite(row.vx), finite(row.vy), finite(row.vz)];
      this.sfx.vehicleLoop(`conquest:${id}`, pos, row.type,
        { speed, trackSpeed, occupied, rotorSpeed, enginePower, engineOn: row.engineOn !== false, self: row === ownHull, velocity });
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
      if (entered) this.sfx.vehicleHatch?.(pos, { enter: true, self: mine }, row.type);
      else if (left && row.hp > 0) this.sfx.vehicleHatch?.(pos, { enter: false, self: false }, row.type);
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
    const alarm = ratio > 0 && ratio < VEHICLE_AUDIO.alarmFraction;
    // Aircraft sound a master-caution chime, ground hulls a klaxon.
    if (alarm && AIRCRAFT.has(row.type)) this.sfx.vehicleAlarm?.(true, { air: true });
    else this.sfx.vehicleAlarm?.(alarm);
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

  /**
   * Per-hull cues derived from successive snapshot rows: rotor spool-up and
   * spool-down, jet passes at closest approach, turret traverse, wading and
   * jeep skids. Every cue is presentation of authoritative row fields.
   */
  _motionCues(row, id, pos, distance, listener, seats, alive, selfId, now) {
    let state = this.motion.get(id);
    if (!state) { state = { t: now, yaw: finite(row.yaw), rotor: finite(row.rotorSpeed), spooled: false, flybyAt: -Infinity,
      turret: null, turretAt: -Infinity, turretRate: 0, wade: false, skidAt: -Infinity }; this.motion.set(id, state); }
    const dt = Math.max(0, now - state.t);
    const self = selfId != null && seats.some(seat => String(seat.occupantId) === selfId);
    const kind = row.type;
    if (!alive) { this._stopHullCues(id); state.t = now; return; }

    if (ROTORCRAFT.has(kind)) {
      const rotor = Math.max(0, Math.min(1, finite(row.rotorSpeed)));
      if (self || distance <= VEHICLE_AUDIO.spoolRange) {
        if (state.rotor <= VEHICLE_AUDIO.spoolStart && rotor > VEHICLE_AUDIO.spoolStart) {
          this.sfx.vehicleRotorSpool?.(pos, 'up', { self, kind });
          state.spooled = false;
        } else if (!state.spooled && !seats.length && state.rotor >= VEHICLE_AUDIO.spoolDownFrom && rotor < state.rotor - 1e-3) {
          this.sfx.vehicleRotorSpool?.(pos, 'down', { self, kind });
          state.spooled = true;
        }
      }
      if (rotor > state.rotor + 1e-3) state.spooled = false;
      state.rotor = rotor;
    }

    if (kind === 'plane' && !self && now - state.flybyAt > VEHICLE_AUDIO.flybyCooldown) {
      const vel = [finite(row.vx), finite(row.vy), finite(row.vz)];
      if (Math.hypot(vel[0], vel[1], vel[2]) >= VEHICLE_AUDIO.flybySpeed) {
        const pass = closestApproach(pos, vel, listener);
        if (pass.time > 0 && pass.time <= VEHICLE_AUDIO.flybyLead && pass.distance <= VEHICLE_AUDIO.flybyRange) {
          state.flybyAt = now;
          this.sfx.jetFlyby?.(pass.point, { delay: pass.time });
        }
      }
    }

    if (kind === 'tank') {
      const aim = mountAim(row, 'main');
      const turret = aim ? wrapAngle(aim.yaw - finite(row.yaw)) : null;
      if (turret != null && state.turret != null) {
        const change = Math.abs(wrapAngle(turret - state.turret));
        if (change > 0.003) {
          // Rate over the snapshot interval (a long rest counts as one ~20 Hz tick).
          const since = now - state.turretAt;
          state.turretRate = change / (since > 0.25 || !(since > 0) ? 1 / 20 : since);
          state.turretAt = now;
          state.turret = turret;
        }
      } else if (turret != null) state.turret = turret;
      const moving = now - state.turretAt <= VEHICLE_AUDIO.turretHold;
      if (moving && (self || distance <= VEHICLE_AUDIO.turretRange)) {
        this.turrets.add(id);
        this.sfx.vehicleTurret?.(`turret:${id}`, pos, Math.min(1, state.turretRate / VEHICLE_AUDIO.turretFullRate), { self });
      } else if (this.turrets.delete(id)) this.sfx.vehicleTurret?.(`turret:${id}`, pos, 0, { self });
    }

    if ((kind === 'tank' || kind === 'jeep') && this.river) {
      const speed = Math.abs(finite(row.speed));
      const inWater = finite(row.y) <= this.river.surfaceY + VEHICLE_AUDIO.wadeDepth
        && polylineDistance(pos[0], pos[2], this.river.points) <= this.river.width / 2 + 1.5;
      const audible = self || distance <= VEHICLE_AUDIO.wadeRange;
      if (inWater && audible && speed > 0.4) {
        if (!state.wade) this.sfx.vehicleWadeSplash?.(pos, { self });
        state.wade = true;
        this.wading.add(id);
        this.sfx.vehicleWade?.(`wade:${id}`, pos, Math.min(1, 0.35 + speed / 10), { self });
      } else {
        if (!inWater) state.wade = false;
        if (this.wading.delete(id)) this.sfx.stopVehicleWade?.(`wade:${id}`);
      }
    }

    if (kind === 'jeep' && dt > 0 && dt < 0.5) {
      const yawRate = Math.abs(wrapAngle(finite(row.yaw) - state.yaw)) / dt;
      if (Math.abs(finite(row.speed)) >= VEHICLE_AUDIO.skidSpeed && yawRate >= VEHICLE_AUDIO.skidYawRate
        && now - state.skidAt > VEHICLE_AUDIO.skidCooldown && (self || distance <= VEHICLE_AUDIO.wadeRange)) {
        state.skidAt = now;
        this.sfx.vehicleSkid?.(pos);
      }
    }
    if (finite(row.yaw) !== state.yaw || dt > 0.25) { state.yaw = finite(row.yaw); state.t = now; }
  }

  _stopHullCues(id) {
    if (this.turrets.delete(id)) this.sfx.stopVehicleTurret?.(`turret:${id}`);
    if (this.wading.delete(id)) this.sfx.stopVehicleWade?.(`wade:${id}`);
  }

  _forget(id) {
    this._stopHullCues(id);
    this.motion.delete(id);
  }

  _lockerMode(self) {
    const progress = decodeConquestPlayer(self)?.lockProgress ?? 0;
    return progress >= 1 ? 'lock' : progress > 0 ? 'acquire' : null;
  }

  dispose() {
    for (const id of [...this.motion.keys()]) this._forget(id);
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
