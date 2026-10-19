import { vehicleOccupiedSeats } from '../../../shared/vehicle-seats.js';
import { VEHICLE_WEAPONS, vehicleDef, vehicleMaxHp, mountAim } from '../../../shared/vehicle-defs.js';
import { vehicleStatus, vehicleMountOrder, decodeConquestPlayer, vehicleHullType } from '../../../shared/conquest-contract.js';
import { isTitanType, decodeTitanRow } from '../../../shared/titan-contract.js';
import { createVoices } from '../audio/primitives.js';
import { LocalSampleBank } from '../audio/samples.js';

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
    this.titan = new TitanSynth(sfx);   // titanfall walkers: synthesized loops and one-shots (docs/titanfall.md §7.4)
  }

  // Titan one-shots (titan-presentation.js calls these from rig events and authoritative events).
  titanFootfall(pos, strength = 1, { self = false, chassis = null, skid = false } = {}) { this.titan.footfall(pos, strength, { self, chassis, skid }); }
  titanLanding(pos, strength = 1, { self = false, titanfall = false } = {}) { this.titan.landing(pos, strength, { self, titanfall }); }
  titanDash(pos, { self = false } = {}) { this.titan.dash(pos, { self }); }
  titanShot(weapon, pos, { self = false, charge = 0, split = false, ability = false, vehicleId = null } = {}) {
    this.titan.shot(weapon, pos, { self, charge, split, ability, vehicleId });
  }
  titanCue(kind, pos, { self = false } = {}) { this.titan.cue(kind, pos, { self }); }
  /** Where a titan primary round, a T-203 shell or a Leadwall pellet hit. */
  titanImpact(weapon, pos) { this.titan.impact(weapon, pos); }
  titanRicochet(pos) { this.titan.ricochet(pos); }
  /** Own rounds landing on armour ('hit') or dooming a titan ('doom'), heard in the head. */
  titanConfirm(kind = 'hit') { this.titan.confirm(kind); }
  /** The titan weapon bank (audio/titan-bank.js), decoded in the background; the synth stands in until then. */
  loadTitanBank(manifest, fetchImpl) { return this.titan.loadBank(manifest, fetchImpl); }
  unloadTitanBank() { this.titan.unloadBank(); }

  /**
   * rows: snapshot vehicle rows; listenerPosition: camera position;
   * context.self: the local player row (lock tones, alarm, reload clunks).
   */
  update(rows, listenerPosition, { self = null, now = clock() } = {}) {
    const listener = listenerOf(listenerPosition);
    const audible = listener.every(Number.isFinite);
    const list = Array.isArray(rows) ? rows : [];
    const selfId = self?.id != null ? String(self.id) : null;
    const candidates = [], fires = [], titans = [];
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
      // Titans: their own reactor and servo loops instead of a vehicle engine loop.
      if (isTitanType(row.type)) { if (distance <= TITAN_AUDIO.loopRange) titans.push({ row, id, pos, distance, self: seats.some(seat => String(seat.occupantId) === selfId) }); continue; }
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
    if (titans.length || this.titan.loops.size || this.titan.weapon.size || this.titan.bursts.size) this.titan.update(titans, listener, now);

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
    const kind = vehicleHullType(row.type);
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
    this.titan.dispose();
    this.seats.clear();
    this.reloads.clear();
  }
}

/** Titan audio tuning (metres, gains, counts; presentation only). */
export const TITAN_AUDIO = Object.freeze({
  loopRange: 110, maxLoops: 2, oneShotRange: 170, maxOneShots: 14, selfGain: 0.55,
  // Weapon bank voices have their own budget, so a Predator burst never starves the footfalls.
  weaponRange: 280, maxWeaponVoices: 20, maxRounds: 5, selfWeaponGain: 0.8,
  // Others' shots lose their top end with distance: low-pass from `lowpassFrom` m down to `lowpassFar` Hz at weaponRange.
  lowpassFrom: 60, lowpassFar: 2400,
  impactRange: 90, impactWindow: 0.12, impactBudget: 3, ricochetRange: 60, ricochetWindow: 0.15, ricochetBudget: 2,
  // Charge whine and barrel spin of other titans within this range (the own titan always).
  windRange: 55, confirmGap: 0.07, predatorTailAfter: 0.16, casingEvery: 4, bankRetries: Object.freeze([5, 20]),
});
/**
 * Levels of the titan bank groups: the bank's suggested relative gains (docs/audio/titan-sfx.md; each
 * group is levelled to within 1 LU) scaled to fire 0.85. The railgun crack is mastered quieter (~-19 LUFS),
 * a Leadwall pellet hit is one of up to ten per shot. Own shots are in the head at TITAN_AUDIO.selfWeaponGain.
 */
export const TITAN_WEAPON_MIX = Object.freeze({
  fire: 0.85, railFire: 1.02, split: 0.77, tail: 0.55, mech: 0.51, pump: 0.51, impact: 0.68, pellet: 0.3, burn: 0.42, ricochet: 0.42, reload: 0.51,
  charge: 0.6, hold: 0.38, ready: 0.6, rounds: 0.6, casings: 0.34, spinUp: 0.51, spin: 0.43, spinDown: 0.51,
  confirm: 0.51, doom: 0.77,
});
const WEAPON_VOICE = Object.freeze({
  splitter: 'splitter', t203: 't203', railgun: 'railgun', leadwall: 'leadwall', predatorClose: 'predator', predatorLong: 'predator', titanMelee: 'melee',
});

/**
 * Synthesized titan sounds on the shared audio engine (no samples): a reactor hum and a
 * servo whine per nearby hull, and one-shots for footfalls, landings, dashes, the mount
 * weapons and the titan cues (titanfall incoming, core, eject, embark, battery rip/insert).
 * Silent until the engine context runs; every voice ends by itself.
 */
export class TitanSynth {
  constructor(sfx) {
    this.sfx = sfx;
    this.loops = new Map();     // vehicle id -> { nodes, gain, panner, whine }
    this.oneShots = [];         // end times of live one-shots (budget)
    this.listener = null;
    this._voices = null; this._ctx = null;
    // Weapon bank (audio/titan-bank.js) and its voices.
    this.bank = null; this._bankGeneration = 0; this._bankTimer = 0; this.bankSlots = [];
    this.lastTake = new Map();  // group -> previous take
    this.weaponVoices = [];     // end times of live weapon voices (budget)
    this.rounds = [];           // end times of live Predator rounds
    this.bursts = new Map();    // vehicle id -> Predator burst { count, at, pos, self }
    this.weapon = new Map();    // vehicle id -> charge / spin / reload state
    this.budgets = new Map();   // impact and ricochet windows
    this.confirmAt = -Infinity;
  }

  _engine() {
    const engine = this.sfx?.objectiveAudio?.()?.engine;
    const ctx = engine?.ctx;
    if (!ctx || ctx.state !== 'running' || !engine.bus || !engine.noiseBuffer) return null;
    if (this._ctx !== ctx) {
      try { this._voices = createVoices(engine); this._ctx = ctx; } catch { return null; }
    }
    return { engine, ctx, v: this._voices };
  }

  _panner(ctx, pos, far = false) {
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
    panner.refDistance = far ? 14 : 8; panner.maxDistance = far ? 400 : 170; panner.rolloffFactor = far ? 0.9 : 1.05;
    this._place(panner, pos, ctx);
    return panner;
  }

  _place(panner, pos, ctx) {
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(pos[0], ctx.currentTime, 0.03);
      panner.positionY.setTargetAtTime(pos[1], ctx.currentTime, 0.03);
      panner.positionZ.setTargetAtTime(pos[2], ctx.currentTime, 0.03);
    } else panner.setPosition?.(pos[0], pos[1], pos[2]);
  }

  /** A one-shot destination at `pos` (dry for the own hull), or null when culled or over budget. */
  _out(pos, { self = false, life = 1, far = false, gain = 1 } = {}) {
    const audio = this._engine();
    if (!audio || !Array.isArray(pos) || !pos.every(Number.isFinite)) return null;
    const { engine, ctx } = audio, now = ctx.currentTime;
    if (!self && this.listener && distanceTo(pos, this.listener) > (far ? 400 : TITAN_AUDIO.oneShotRange)) return null;
    this.oneShots = this.oneShots.filter(end => end > now);
    if (this.oneShots.length >= TITAN_AUDIO.maxOneShots) return null;
    this.oneShots.push(now + life);
    const out = ctx.createGain();
    out.gain.value = gain * (self ? TITAN_AUDIO.selfGain : 1);
    if (self) out.connect(engine.bus);
    else { const panner = this._panner(ctx, pos, far); out.connect(panner).connect(engine.bus); }
    setTimeout(() => { try { out.disconnect(); } catch { /* gone */ } }, (life + 0.6) * 1000);
    return { out, v: audio.v, t: audio.v.nowT() };
  }

  footfall(pos, strength = 1, { self = false, chassis = null, skid = false } = {}) {
    const s = Math.max(0.3, Math.min(2, strength)), heavy = chassis === 'ogre' ? 0.8 : chassis === 'stryder' ? 1.2 : 1;
    const o = this._out(pos, { self, life: 0.6, gain: 0.85 * (self ? 0.7 : 1) });
    if (!o) return;
    const { out, v, t } = o;
    if (skid) { v.hiss(out, { t0: t, filter: 'bandpass', f: 900, q: 0.8, sweepTo: 420, g: 0.22 * s, att: 0.02, dec: 0.35 }); return; }
    v.tone(out, { t0: t, type: 'sine', f0: 74 * heavy, f1: 36 * heavy, g: 0.55 * s, att: 0.004, dec: 0.28 });
    v.hiss(out, { t0: t, filter: 'lowpass', f: 420, q: 0.7, g: 0.32 * s, att: 0.002, dec: 0.2 });
    v.tone(out, { t0: t + 0.012, type: 'square', f0: 190 * heavy, f1: 120 * heavy, g: 0.035 * s, att: 0.002, dec: 0.07 });
    v.hiss(out, { t0: t + 0.03, filter: 'bandpass', f: 2600, q: 3, g: 0.05 * s, att: 0.002, dec: 0.06 });
  }

  landing(pos, strength = 1, { self = false, titanfall = false } = {}) {
    const s = Math.max(0.4, Math.min(2.5, strength));
    const o = this._out(pos, { self, life: 1.6, far: titanfall, gain: titanfall ? 1.2 : 0.9 });
    if (!o) return;
    const { out, v, t } = o;
    v.tone(out, { t0: t, type: 'sine', f0: 60, f1: 26, g: 0.5 * Math.min(1.4, s), att: 0.004, dec: titanfall ? 1.1 : 0.55 });
    v.hiss(out, { t0: t, filter: 'lowpass', f: 520, sweepTo: 160, q: 0.6, g: 0.4 * Math.min(1.4, s), att: 0.003, dec: titanfall ? 1.3 : 0.5 });
    v.tone(out, { t0: t + 0.02, type: 'triangle', f0: 150, f1: 92, g: 0.08, att: 0.003, dec: 0.3 });
    if (titanfall) v.hiss(out, { t0: t + 0.05, filter: 'bandpass', f: 1800, q: 1.4, sweepTo: 600, g: 0.12, att: 0.01, dec: 0.9 });
  }

  dash(pos, { self = false } = {}) {
    const o = this._out(pos, { self, life: 0.7, gain: 0.8 });
    if (!o) return;
    const { out, v, t } = o;
    v.hiss(out, { t0: t, filter: 'highpass', f: 1400, sweepTo: 420, q: 0.7, g: 0.3, att: 0.01, dec: 0.45 });
    v.tone(out, { t0: t, type: 'sawtooth', f0: 85, f1: 150, g: 0.06, att: 0.02, dec: 0.32 });
  }

  // ---- titan weapon bank (audio/titan-bank.js) -------------------------------------------------

  /** Decode the titan weapon bank in the background; failed slots are retried (TITAN_AUDIO.bankRetries). */
  loadBank(manifest, fetchImpl = globalThis.fetch) {
    const engine = this.sfx?.objectiveAudio?.()?.engine;
    if (!manifest || typeof manifest !== 'object' || !engine?.ensure?.() || !engine.ctx) return Promise.resolve(Object.freeze({ loaded: 0, failed: 0 }));
    this.bank ??= new LocalSampleBank({ getContext: () => this.sfx?.objectiveAudio?.()?.engine?.ctx ?? null });
    this.bankSlots = Object.keys(manifest);
    const generation = ++this._bankGeneration, bank = this.bank;
    const attempt = (slots, retry) => bank.load(slots, fetchImpl).then(result => {
      const missing = Object.fromEntries(Object.entries(slots).filter(([slot]) => !bank.getBuffer(slot)));
      const wait = TITAN_AUDIO.bankRetries[retry];
      if (Object.keys(missing).length && Number.isFinite(wait) && generation === this._bankGeneration) {
        this._bankTimer = setTimeout(() => { if (generation === this._bankGeneration) attempt(missing, retry + 1); }, wait * 1000);
      }
      return result;
    }).catch(() => Object.freeze({ loaded: 0, failed: Object.keys(slots).length }));
    return attempt(manifest, 0);
  }

  unloadBank() {
    this._bankGeneration++;
    clearTimeout(this._bankTimer);
    this.bank?.clear();
    this.bank = null;
    this.bankSlots = [];
    this.lastTake.clear();
    for (const id of [...this.weapon.keys()]) this._forgetWeapon(id);
    this.bursts.clear();
  }

  /** Decoded takes of a bank group, in slot order. */
  _takes(group) {
    return this.bankSlots.filter(slot => slot.startsWith(`${group}.`) && this.bank?.getBuffer(slot));
  }
  has(group) { return this._takes(group).length > 0; }

  /** A random take of `group` that never repeats the previous one. */
  pick(group, random = Math.random) {
    const takes = this._takes(group);
    if (takes.length <= 1) return takes[0] ?? null;
    let index = Math.floor(random() * takes.length) % takes.length;
    if (takes[index] === this.lastTake.get(group)) index = (index + 1) % takes.length;
    this.lastTake.set(group, takes[index]);
    return takes[index];
  }

  /**
   * A weapon voice at `pos` (in the head for the own titan): its own budget, a distance low-pass for
   * others' shots. Returns { out, ctx, t } or null when culled, silent or over budget.
   */
  _weaponOut(pos, { self = false, life = 1, gain = 1, range = TITAN_AUDIO.weaponRange } = {}) {
    const audio = this._engine();
    if (!audio || !Array.isArray(pos) || !pos.every(Number.isFinite)) return null;
    const { engine, ctx } = audio, now = ctx.currentTime;
    const distance = !self && this.listener ? distanceTo(pos, this.listener) : 0;
    if (distance > range) return null;
    this.weaponVoices = this.weaponVoices.filter(end => end > now);
    if (this.weaponVoices.length >= TITAN_AUDIO.maxWeaponVoices) return null;
    this.weaponVoices.push(now + life);
    const out = ctx.createGain();
    out.gain.value = gain * (self ? TITAN_AUDIO.selfWeaponGain : 1);
    const nodes = [out];
    if (self) out.connect(engine.bus);
    else {
      let last = out;
      if (distance > TITAN_AUDIO.lowpassFrom) {
        const k = Math.min(1, (distance - TITAN_AUDIO.lowpassFrom) / (TITAN_AUDIO.weaponRange - TITAN_AUDIO.lowpassFrom));
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass'; filter.frequency.value = 16000 * (TITAN_AUDIO.lowpassFar / 16000) ** k; filter.Q.value = 0.5;
        last = last.connect(filter); nodes.push(filter);
      }
      const panner = this._panner(ctx, pos, true);
      last.connect(panner).connect(engine.bus); nodes.push(panner);
    }
    setTimeout(() => { for (const node of nodes) try { node.disconnect(); } catch { /* gone */ } }, (life + 0.6) * 1000);
    return { out, ctx, v: audio.v, t: audio.v.nowT(), distance };
  }

  /** Play a take of `group` into `out`: { gain, rate, delay (s), offset (s) }. False when nothing has decoded. */
  _take(group, out, { gain = 1, rate = 1, delay = 0, offset = 0, slot = null } = {}) {
    const take = slot ?? this.pick(group);
    return !!take && !!this.bank?.play(take, out, { gain, rate, delay, offset });
  }

  /** Seconds of the first take of `group` (0 when not decoded). */
  _duration(group) { return this.bank?.getBuffer(this._takes(group)[0])?.duration ?? 0; }

  /**
   * A titan primary report. `charge`: the railgun's event charge; `split`: an ION split shot;
   * `ability`: an ability ray borrowing the weapon's look (no mechanics, no burst bookkeeping).
   */
  shot(weapon, pos, { self = false, charge = 0, split = false, ability = false, vehicleId = null } = {}) {
    const voice = WEAPON_VOICE[weapon];
    if (!voice) return;
    // Firing consumes the charge even if a sample is missing or the report budget is full.
    if (voice === 'railgun' && vehicleId != null && !ability) this._stopWind(String(vehicleId));
    if (voice !== 'melee' && this.has(`tf.${voice}.fire`)) { this._sampledShot(voice, pos, { self, charge, split, ability, vehicleId }); return; }
    this._synthShot(voice, pos, { self, charge });
  }

  _sampledShot(voice, pos, { self, charge, split, ability, vehicleId }) {
    const M = TITAN_WEAPON_MIX, jitter = () => 0.97 + Math.random() * 0.06;
    const id = vehicleId != null ? String(vehicleId) : null;
    if (voice === 'predator') {
      // One heavy round per shot (at most maxRounds overlapping), brass every few rounds, the tail when the burst ends.
      const now = this._engine()?.ctx.currentTime ?? 0;
      this.rounds = this.rounds.filter(end => end > now);
      if (this.rounds.length < TITAN_AUDIO.maxRounds) {
        const o = this._weaponOut(pos, { self, life: 0.45, gain: M.rounds });
        const rate = jitter();
        if (o && this._take('tf.predator.fire', o.out, { rate })) this.rounds.push(now + this._duration('tf.predator.fire') / rate);
      }
      if (id && !ability) {
        const burst = this.bursts.get(id) ?? { count: 0 };
        burst.count++; burst.at = now; burst.pos = pos; burst.self = self;
        this.bursts.set(id, burst);
        if (burst.count % TITAN_AUDIO.casingEvery === 1 && (self || (this.listener && distanceTo(pos, this.listener) < 40))) {
          const o = this._weaponOut(pos, { self, life: 1.2, gain: M.casings });
          if (o) this._take('tf.predator.casings', o.out, { delay: 0.18 + Math.random() * 0.12, rate: jitter() });
        }
      }
      return;
    }
    const k = voice === 'railgun' ? 0.45 + 0.55 * Math.max(0, Math.min(1, Number.isFinite(charge) ? charge : 1)) : 1;
    const life = Math.max(this._duration(`tf.${voice}.fire`), 0.03 + this._duration(`tf.${voice}.tail`),
      voice === 't203' ? 0.58 + this._duration('tf.t203.mech') : voice === 'leadwall' ? 0.32 + this._duration('tf.leadwall.pump') : 0,
      split ? this._duration('tf.splitter.split') : 0) / 0.94 + 0.05;
    const o = this._weaponOut(pos, { self, life, gain: 1 });
    if (!o) return;
    const near = self || o.distance < 45;
    // Close up the dry report leads; far away the tail carries the shot.
    const tail = M.tail * (self ? 0.7 : 0.8 + Math.min(1, o.distance / 120) * 0.6);
    this._take(`tf.${voice}.fire`, o.out, { gain: (voice === 'railgun' ? M.railFire : M.fire) * k, rate: voice === 'railgun' ? 0.94 + 0.06 * k : jitter() });
    this._take(`tf.${voice}.tail`, o.out, { gain: tail * k, rate: jitter(), delay: 0.03 });
    if (voice === 'splitter' && split) this._take('tf.splitter.split', o.out, { gain: M.split, rate: jitter() });
    if (ability || !near) return;
    if (voice === 't203') this._take('tf.t203.mech', o.out, { gain: M.mech, delay: 0.5 + Math.random() * 0.08 });
    if (voice === 'leadwall') this._take('tf.leadwall.pump', o.out, { gain: M.pump, delay: 0.1 + Math.random() * 0.01 });
  }

  /** The synthesized report (the bank has not decoded): the previous voices, kept as the fallback. */
  _synthShot(voice, pos, { self = false, charge = 0 } = {}) {
    const o = this._out(pos, { self, life: voice === 'railgun' ? 1 : 0.6, gain: voice === 'predator' ? 0.55 : 0.9 });
    if (!o) return;
    const { out, v, t } = o;
    switch (voice) {
      case 'splitter':
        v.tone(out, { t0: t, type: 'square', f0: 940, f1: 420, g: 0.1, att: 0.001, dec: 0.08 });
        v.hiss(out, { t0: t, filter: 'bandpass', f: 3200, q: 1.2, g: 0.16, att: 0.001, dec: 0.06 });
        v.tone(out, { t0: t, type: 'sine', f0: 160, f1: 80, g: 0.18, att: 0.001, dec: 0.09 });
        break;
      case 't203':
        v.tone(out, { t0: t, type: 'sine', f0: 130, f1: 55, g: 0.42, att: 0.002, dec: 0.2 });
        v.hiss(out, { t0: t, filter: 'lowpass', f: 1600, sweepTo: 500, g: 0.3, att: 0.002, dec: 0.32 });
        break;
      case 'railgun': {
        const c = Math.max(0.3, Math.min(1, charge || 1));
        v.tone(out, { t0: t, type: 'sawtooth', f0: 1900 * c, f1: 180, g: 0.14, att: 0.002, dec: 0.38 });
        v.hiss(out, { t0: t, filter: 'bandpass', f: 5200, q: 0.9, sweepTo: 1400, g: 0.26 * c, att: 0.001, dec: 0.45 });
        v.tone(out, { t0: t, type: 'sine', f0: 70, f1: 40, g: 0.4 * c, att: 0.003, dec: 0.5 });
        break;
      }
      case 'leadwall':
        v.hiss(out, { t0: t, filter: 'lowpass', f: 2400, q: 0.6, g: 0.55, att: 0.001, dec: 0.24 });
        v.tone(out, { t0: t, type: 'sine', f0: 96, f1: 48, g: 0.45, att: 0.002, dec: 0.22 });
        v.hiss(out, { t0: t + 0.03, filter: 'bandpass', f: 4200, q: 2, g: 0.08, att: 0.001, dec: 0.12 });
        break;
      case 'predator':
        v.tone(out, { t0: t, type: 'square', f0: 230, f1: 110, g: 0.12, att: 0.001, dec: 0.05 });
        v.hiss(out, { t0: t, filter: 'bandpass', f: 1900, q: 1.1, g: 0.2, att: 0.001, dec: 0.045 });
        break;
      default:   // melee swing
        v.hiss(out, { t0: t, filter: 'bandpass', f: 700, q: 0.8, sweepTo: 300, g: 0.18, att: 0.03, dec: 0.25 });
    }
  }

  /** Where a titan round, a T-203 shell or a Leadwall pellet hit (budgeted; the T-203 adds its thermite sizzle). */
  impact(weapon, pos) {
    const voice = WEAPON_VOICE[weapon];
    if (!voice || voice === 'melee' || !Array.isArray(pos)) return;
    const shell = voice === 't203';
    if (!this._budget('impact', TITAN_AUDIO.impactWindow, shell ? Infinity : TITAN_AUDIO.impactBudget)) return;
    const group = `tf.${voice}.impact`;
    if (this.has(group)) {
      const o = this._weaponOut(pos, { life: shell ? 3.6 : 1.2, gain: voice === 'leadwall' ? TITAN_WEAPON_MIX.pellet : TITAN_WEAPON_MIX.impact, range: shell ? TITAN_AUDIO.weaponRange : TITAN_AUDIO.impactRange });
      if (!o) return;
      this._take(group, o.out, { rate: 0.95 + Math.random() * 0.1 });
      if (shell) this._take('tf.t203.burn', o.out, { gain: TITAN_WEAPON_MIX.burn / TITAN_WEAPON_MIX.impact, delay: 0.12 });
      return;
    }
    const o = this._out(pos, { life: shell ? 1.4 : 0.4, far: shell, gain: shell ? 1 : 0.5 });
    if (!o) return;
    const { out, v, t } = o;
    if (shell) {
      v.tone(out, { t0: t, type: 'sine', f0: 90, f1: 34, g: 0.5, att: 0.003, dec: 0.5 });
      v.hiss(out, { t0: t, filter: 'lowpass', f: 2200, sweepTo: 500, q: 0.6, g: 0.45, att: 0.002, dec: 0.6 });
      v.hiss(out, { t0: t + 0.1, filter: 'highpass', f: 3000, q: 0.7, g: 0.12, att: 0.05, dec: 1.1, rate: 1.4 });
    } else {
      v.hiss(out, { t0: t, filter: 'bandpass', f: voice === 'splitter' || voice === 'railgun' ? 3600 : 1500, q: 1, g: 0.25, att: 0.001, dec: 0.09 });
      v.tone(out, { t0: t, type: 'sine', f0: 140, f1: 70, g: 0.15, att: 0.002, dec: 0.08 });
    }
  }

  /** A Leadwall pellet off a voxel: a ricochet whine (budgeted). */
  ricochet(pos) {
    if (!this._budget('ricochet', TITAN_AUDIO.ricochetWindow, TITAN_AUDIO.ricochetBudget)) return;
    if (this.has('tf.leadwall.ricochet')) {
      const o = this._weaponOut(pos, { life: 1, gain: TITAN_WEAPON_MIX.ricochet, range: TITAN_AUDIO.ricochetRange });
      if (o) this._take('tf.leadwall.ricochet', o.out, { rate: 0.9 + Math.random() * 0.25 });
      return;
    }
    const o = this._out(pos, { life: 0.5, gain: 0.4 });
    if (!o) return;
    const f = 2400 + Math.random() * 1800;
    o.v.tone(o.out, { t0: o.t, type: 'sine', f0: f, f1: f * 0.55, g: 0.06, att: 0.004, dec: 0.32 });
    o.v.hiss(o.out, { t0: o.t, filter: 'bandpass', f: 3200, q: 2, g: 0.08, att: 0.001, dec: 0.06 });
  }

  /** Own hits, enemy doom and confirmed destruction. Heavy confirms bypass the hit cooldown. */
  confirm(kind = 'hit') {
    const doom = kind === 'doom' || kind === 'kill';
    const now = this._engine()?.ctx.currentTime ?? 0;
    if (!doom && now - this.confirmAt < TITAN_AUDIO.confirmGap) return;
    this.confirmAt = now;
    const group = kind === 'kill' ? 'tf.hit.kill' : doom ? 'tf.hit.doom' : 'tf.hit.confirm';
    if (this.has(group)) {
      const o = this._weaponOut([0, 0, 0], { self: true, life: doom ? 1.4 : 0.4, gain: doom ? TITAN_WEAPON_MIX.doom : TITAN_WEAPON_MIX.confirm });
      if (o) this._take(group, o.out, { rate: doom ? 1 : 0.96 + Math.random() * 0.08 });
      return;
    }
    const o = this._out([0, 0, 0], { self: true, life: 0.6, gain: doom ? 0.9 : 0.5 });
    if (!o) return;
    o.v.tone(o.out, { t0: o.t, type: 'square', f0: doom ? 520 : 1900, f1: doom ? 260 : 1500, g: doom ? 0.12 : 0.05, att: 0.001, dec: doom ? 0.4 : 0.05 });
    if (doom) o.v.tone(o.out, { t0: o.t, type: 'sine', f0: 110, f1: 55, g: 0.4, att: 0.002, dec: 0.5 });
  }

  /** Sliding budget per sound family. */
  _budget(name, window, budget) {
    const now = this._engine()?.ctx.currentTime;
    if (!Number.isFinite(now)) return false;
    const list = (this.budgets.get(name) || []).filter(at => now - at <= window);
    if (list.length >= budget) { this.budgets.set(name, list); return false; }
    list.push(now);
    this.budgets.set(name, list);
    return true;
  }

  /**
   * Charge whine (railgun) and barrel spin (Predator) from mount field 6 of a presented row, plus
   * the own magazine reload and the end of a Predator burst. `entry`: { row, id, pos, distance, self }.
   */
  _weaponState(entry, now) {
    const { row, id, pos, self } = entry;
    const mount = Array.isArray(row.mounts?.[0]) ? row.mounts[0] : null;
    const kind = row.type === 'titan_northstar' ? 'charge' : row.type === 'titan_legion' ? 'spin' : null;
    let state = this.weapon.get(id);
    if (!state) { state = { value: 0, reload: 0, wind: null, hold: null, ready: false }; this.weapon.set(id, state); }
    const value = mount ? Math.max(0, Math.min(1, finite(mount[5]) / 100)) : 0;
    const audible = self || entry.distance <= TITAN_AUDIO.windRange;
    if (kind && audible) this._wind(kind, id, state, value, pos, self);
    else if (state.wind || state.hold) this._stopWind(id);
    state.value = value;
    // Own magazine reload starting (not the one-round T-203, its breech is in the shot).
    const reload = mount ? finite(mount[4]) : 0;
    if (self && reload > 0 && !(state.reload > 0) && row.type !== 'titan_scorch') {
      const voice = { titan_ion: 'splitter', titan_ronin: 'leadwall', titan_legion: 'predator' }[row.type];
      const key = voice === 'predator' ? 'predatorClose' : voice;
      const seconds = VEHICLE_WEAPONS[key]?.reloadSeconds ?? 0;
      const duration = voice ? this._duration(`tf.${voice}.reload`) : 0;
      const remaining = Math.max(0, Math.min(1, reload / 100));
      const o = duration > 0 ? this._weaponOut(pos, { self: true, life: seconds * remaining + 0.2, gain: TITAN_WEAPON_MIX.reload }) : null;
      if (o) this._take(`tf.${voice}.reload`, o.out, { rate: duration / seconds, offset: duration * (1 - remaining) });
    }
    state.reload = reload;
    void now;
  }

  _wind(kind, id, state, value, pos, self) {
    const audio = this._engine();
    if (!audio) return;
    const { ctx } = audio, M = TITAN_WEAPON_MIX, prev = state.value;
    const rising = value > prev + 1e-3, falling = value < prev - 1e-3;
    if (state.panner) this._place(state.panner, pos, ctx);
    if (kind === 'charge') {
      if (value <= 0.02) { if (state.wind || state.hold) this._stopWind(id, 0.03); state.ready = false; return; }
      if (!state.wind && rising) {
        const seconds = VEHICLE_WEAPONS.railgun?.chargeSeconds ?? 1.6, dur = this._duration('tf.railgun.charge');
        state.wind = dur > 0
          ? this._windVoice(ctx, pos, self, 'tf.railgun.charge', { gain: M.charge, rate: dur / seconds, offset: value * dur, loop: false }, state)
          : this._windSynth(ctx, pos, self, 'charge', state);
      }
      if (state.wind?.synth) this._tuneSynthWind(state.wind, ctx, kind, value);
      if (value >= 1 && !state.ready) {
        state.ready = true;
        const o = this._weaponOut(pos, { self, life: 1, gain: M.ready * (self ? 1 : 0.6) });
        if (o && !this._take('tf.railgun.ready', o.out)) this._readySynth(o);
      }
      if (value >= 1 && !state.hold) {
        if (this.has('tf.railgun.hold')) {
          this._stopWind(id, 0.012);
          state.hold = this._windVoice(ctx, pos, self, 'tf.railgun.hold', { gain: M.hold, rate: 1, offset: 0, loop: true }, state);
        } else if (!state.wind?.synth) {
          this._stopWind(id, 0.012);
          state.wind = this._windSynth(ctx, pos, self, 'charge', state);
          this._tuneSynthWind(state.wind, ctx, kind, value);
        }
      }
      return;
    }
    // Spin: the spin-up take follows a rising spin, the loop holds full spin, the spin-down follows the barrels down.
    if (rising && state.wind?.group === 'tf.predator.spinDown') this._stopWind(id, 0.02);
    if (rising && !state.wind && value < 0.98) {
      const seconds = VEHICLE_WEAPONS.predatorClose?.spinUpSeconds ?? 0.6, dur = this._duration('tf.predator.spinUp');
      state.wind = dur > 0
        ? this._windVoice(ctx, pos, self, 'tf.predator.spinUp', { gain: M.spinUp, rate: dur / seconds, offset: value * dur, loop: false }, state)
        : this._windSynth(ctx, pos, self, 'spin', state);
    }
    if (state.wind?.synth) this._tuneSynthWind(state.wind, ctx, kind, value);
    if (value >= 0.98 && !state.hold && this.has('tf.predator.spin')) {
      this._stopWind(id, 0.012);
      state.hold = this._windVoice(ctx, pos, self, 'tf.predator.spin', { gain: M.spin, rate: 1, offset: Math.random(), loop: true }, state);
    } else if (value >= 0.98 && !state.hold && !state.wind?.synth) {
      this._stopWind(id, 0.012);
      state.wind = this._windSynth(ctx, pos, self, 'spin', state);
      this._tuneSynthWind(state.wind, ctx, kind, value);
    }
    if (falling && (state.hold || (state.wind && !state.wind.synth && state.wind.group !== 'tf.predator.spinDown'))) {
      const from = value;
      this._stopWind(id, 0.06);
      const duration = this._duration('tf.predator.spinDown'), seconds = VEHICLE_WEAPONS.predatorClose.spinDownSeconds;
      state.wind = duration > 0
        ? this._windVoice(ctx, pos, self, 'tf.predator.spinDown', { gain: M.spinDown * from, rate: duration / seconds, offset: (1 - from) * duration, loop: false }, state)
        : this._windSynth(ctx, pos, self, 'spin', state);
    }
    if (value <= 0.01 && state.wind?.synth) this._stopWind(id, 0.1);
  }

  /** A take as a held voice (a loop or a one-shot that can be cut): { source, gain, nodes }. */
  _windVoice(ctx, pos, self, group, { gain, rate, offset, loop }, state) {
    const buffer = this.bank?.getBuffer(this._takes(group)[0]);
    if (!buffer) return null;
    const engine = this._engine()?.engine;
    const source = ctx.createBufferSource();
    source.buffer = buffer; source.loop = loop;
    source.playbackRate.value = Math.max(0.25, Math.min(4, rate));
    const level = ctx.createGain();
    level.gain.value = gain * (self ? TITAN_AUDIO.selfWeaponGain : 1);
    // Joining a charge or a spinning loop can start in the middle of a waveform.
    level.gain.setValueAtTime(0.0001, ctx.currentTime);
    level.gain.linearRampToValueAtTime(gain * (self ? TITAN_AUDIO.selfWeaponGain : 1), ctx.currentTime + 0.012);
    source.connect(level);
    const nodes = [source, level];
    if (self) level.connect(engine.bus);
    else { state.panner ??= this._panner(ctx, pos, false); level.connect(state.panner); if (!state.pannerLive) { state.panner.connect(engine.bus); state.pannerLive = true; } }
    source.start(ctx.currentTime, Math.max(0, Math.min(buffer.duration - 0.01, offset % buffer.duration)));
    return { source, level, nodes, group };
  }

  /** Synthesized wind (no bank): a filtered saw whose pitch and level follow the charge or spin. */
  _windSynth(ctx, pos, self, kind, state) {
    const engine = this._engine()?.engine;
    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = kind === 'charge' ? 220 : 60;
    const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = kind === 'charge' ? 1400 : 500; filter.Q.value = 3;
    const level = ctx.createGain(); level.gain.value = 0.0001;
    osc.connect(filter).connect(level);
    if (self) level.connect(engine.bus);
    else { state.panner ??= this._panner(ctx, pos, false); level.connect(state.panner); if (!state.pannerLive) { state.panner.connect(engine.bus); state.pannerLive = true; } }
    osc.start();
    return { synth: true, source: osc, osc, filter, level, nodes: [osc, filter, level] };
  }

  _tuneSynthWind(wind, ctx, kind, value) {
    const t = ctx.currentTime;
    wind.osc.frequency.setTargetAtTime(kind === 'charge' ? 220 + 1500 * value : 60 + 320 * value, t, 0.04);
    wind.filter.frequency.setTargetAtTime(kind === 'charge' ? 1400 + 2600 * value : 500 + 900 * value, t, 0.04);
    wind.level.gain.setTargetAtTime((kind === 'charge' ? 0.03 + 0.06 * value : 0.02 + 0.05 * value), t, 0.05);
  }

  _readySynth(o) {
    o.v.tone(o.out, { t0: o.t, type: 'sine', f0: 1760, f1: 2640, g: 0.07, att: 0.002, dec: 0.18 });
  }

  /** Cut the charge / spin voices of hull `id` with a short fade. */
  _stopWind(id, fade = 0.04) {
    const state = this.weapon.get(id);
    if (!state) return;
    const ctx = this._ctx;
    for (const key of ['wind', 'hold']) {
      const voice = state[key];
      if (!voice) continue;
      state[key] = null;
      try {
        if (ctx && ctx.state !== 'closed') {
          voice.level.gain.setTargetAtTime(0.0001, ctx.currentTime, fade);
          voice.source.stop(ctx.currentTime + fade * 6);
        }
      } catch { /* context gone */ }
      setTimeout(() => { for (const node of voice.nodes) try { node.disconnect(); } catch { /* gone */ } }, fade * 6000 + 200);
    }
  }

  /** Hull `id` left: its wind voices and its panner. */
  _forgetWeapon(id) {
    this._stopWind(id, 0.02);
    const state = this.weapon.get(id);
    if (state?.panner) setTimeout(() => { try { state.panner.disconnect(); } catch { /* gone */ } }, 400);
    this.weapon.delete(id);
    this.bursts.delete(id);
  }

  /** A Predator burst that stopped: the tail of the last rounds. */
  _burstTails(now) {
    for (const [id, burst] of [...this.bursts]) {
      if (now - burst.at < TITAN_AUDIO.predatorTailAfter) continue;
      this.bursts.delete(id);
      if (burst.count < 3 || !this.has('tf.predator.tail')) continue;
      const o = this._weaponOut(burst.pos, { self: burst.self, life: 1.8, gain: TITAN_WEAPON_MIX.tail * Math.min(1, burst.count / 12) });
      if (o) this._take('tf.predator.tail', o.out);
    }
  }

  cue(kind, pos, { self = false } = {}) {
    const far = kind === 'drop';
    const o = this._out(pos, { self, life: kind === 'drop' ? 3 : 1.2, far, gain: 0.9 });
    if (!o) return;
    const { out, v, t } = o;
    switch (kind) {
      case 'drop':      // re-entry whistle over the marker
        v.tone(out, { t0: t, type: 'sine', f0: 1500, f1: 260, g: 0.08, att: 0.3, dec: 2.4 });
        v.hiss(out, { t0: t, filter: 'bandpass', f: 2600, q: 0.8, sweepTo: 500, sweepMs: 2.6, g: 0.12, att: 0.6, dec: 2.2 });
        break;
      case 'core':      // reactor surge
        v.tone(out, { t0: t, type: 'sawtooth', f0: 180, f1: 760, g: 0.1, att: 0.05, dec: 0.8 });
        v.tone(out, { t0: t, type: 'sine', f0: 60, f1: 120, g: 0.3, att: 0.05, dec: 0.9 });
        break;
      case 'eject':     // hatch charge and launch
        v.hiss(out, { t0: t, filter: 'lowpass', f: 3000, sweepTo: 400, g: 0.5, att: 0.001, dec: 0.6 });
        v.tone(out, { t0: t, type: 'sine', f0: 110, f1: 40, g: 0.5, att: 0.002, dec: 0.4 });
        v.hiss(out, { t0: t + 0.08, filter: 'highpass', f: 2000, sweepTo: 800, g: 0.18, att: 0.02, dec: 0.9 });
        break;
      case 'embark':    // hydraulics and the hatch closing
        v.hiss(out, { t0: t, filter: 'bandpass', f: 1200, q: 0.9, sweepTo: 500, g: 0.14, att: 0.05, dec: 0.6 });
        v.tone(out, { t0: t + 0.9, type: 'square', f0: 140, f1: 90, g: 0.06, att: 0.002, dec: 0.12 });
        break;
      case 'rip':       // battery torn out: crackle
        v.hiss(out, { t0: t, filter: 'highpass', f: 3000, q: 0.8, g: 0.3, att: 0.001, dec: 0.35, rate: 1.6 });
        v.tone(out, { t0: t, type: 'square', f0: 420, f1: 90, g: 0.06, att: 0.001, dec: 0.25 });
        break;
      case 'insert':    // battery seated: clunk and a rising tone
        v.tone(out, { t0: t, type: 'square', f0: 160, f1: 110, g: 0.08, att: 0.002, dec: 0.08 });
        v.tone(out, { t0: t + 0.1, type: 'sine', f0: 420, f1: 840, g: 0.07, att: 0.02, dec: 0.4 });
        break;
      default:
    }
  }

  /** Reactor hum and servo whine for the closest titans (`rows`: [{ row, id, pos, distance, self }]). */
  update(rows, listener, now) {
    this.listener = listener;
    const audio = this._engine();
    const pick = rows.slice().sort((a, b) => (b.self - a.self) || a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, TITAN_AUDIO.maxLoops);
    const keep = new Set(pick.map(entry => entry.id));
    for (const id of [...this.loops.keys()]) if (!audio || !keep.has(id)) this._stopLoop(id);
    // Weapon state of every titan in range (charge whine, barrel spin, own reloads, burst tails).
    const present = new Set(audio ? rows.map(entry => entry.id) : []);
    for (const id of [...this.weapon.keys()]) if (!present.has(id)) this._forgetWeapon(id);
    if (!audio) return;
    for (const entry of rows) this._weaponState(entry, now);
    this._burstTails(audio.ctx.currentTime);
    const { engine, ctx } = audio;
    for (const { row, id, pos, self } of pick) {
      let loop = this.loops.get(id);
      if (!loop || loop.self !== self) {
        if (loop) this._stopLoop(id);
        const gain = ctx.createGain(); gain.gain.value = 0.0001;
        const hum = [ctx.createOscillator(), ctx.createOscillator()];
        hum[0].type = 'sine'; hum[0].frequency.value = 52;
        hum[1].type = 'triangle'; hum[1].frequency.value = 78; hum[1].detune.value = 7;
        const humGain = ctx.createGain(); humGain.gain.value = 0.16;
        const whine = ctx.createOscillator(); whine.type = 'sawtooth'; whine.frequency.value = 300;
        const whineFilter = ctx.createBiquadFilter(); whineFilter.type = 'bandpass'; whineFilter.frequency.value = 900; whineFilter.Q.value = 4;
        const whineGain = ctx.createGain(); whineGain.gain.value = 0;
        for (const osc of hum) osc.connect(humGain);
        humGain.connect(gain);
        whine.connect(whineFilter).connect(whineGain).connect(gain);
        const panner = self ? null : this._panner(ctx, pos);
        if (panner) gain.connect(panner).connect(engine.bus); else gain.connect(engine.bus);
        for (const osc of [...hum, whine]) osc.start();
        loop = { self, gain, panner, hum, whine, whineGain, oscillators: [...hum, whine], nodes: [gain, humGain, whineFilter, whineGain, panner] };
        this.loops.set(id, loop);
      }
      const t = ctx.currentTime, titan = decodeTitanRow(row);
      const speed = Math.abs(finite(row.speed)), move = Math.min(1, speed / 8);
      const doomed = !!titan?.doomed, core = !!titan?.coreActive;
      loop.gain.gain.setTargetAtTime((self ? 0.22 : 0.3) * (titan?.phase === 7 ? 0.2 : 1), t, 0.2);
      loop.hum[0].frequency.setTargetAtTime((doomed ? 44 : 52) + (core ? 10 : 0), t, 0.3);
      loop.hum[1].frequency.setTargetAtTime((doomed ? 66 : 78) + move * 6 + (core ? 18 : 0), t, 0.3);
      loop.whine.frequency.setTargetAtTime(240 + move * 380, t, 0.15);
      loop.whineGain.gain.setTargetAtTime(0.012 + move * 0.05, t, 0.15);
      if (loop.panner) this._place(loop.panner, pos, ctx);
    }
  }

  _stopLoop(id) {
    const loop = this.loops.get(id);
    if (!loop) return;
    this.loops.delete(id);
    const ctx = this._ctx;
    try {
      if (ctx && ctx.state !== 'closed') loop.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08);
      for (const osc of loop.oscillators) osc.stop(ctx ? ctx.currentTime + 0.4 : 0);
    } catch { /* context gone */ }
    setTimeout(() => { for (const node of loop.nodes) try { node?.disconnect(); } catch { /* gone */ } }, 600);
  }

  dispose() {
    for (const id of [...this.loops.keys()]) this._stopLoop(id);
    for (const id of [...this.weapon.keys()]) this._forgetWeapon(id);
    this.oneShots.length = 0;
    this.weaponVoices.length = 0;
    this.rounds.length = 0;
    this.bursts.clear();
    this.budgets.clear();
  }
}
