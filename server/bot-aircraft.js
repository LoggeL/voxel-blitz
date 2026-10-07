// Aircraft crews for Conquest bots: attack helicopter, transport helicopter
// and jet. Assignments come from the commander (bot-commander.js); this module
// flies with the same signed control inputs humans send. VehicleSystem keeps
// every motion, mount, lock and countermeasure authoritative.
//
//  - Attack helicopter: climb out, then circle-strafe 60-90 m around the
//    focus flag, swinging the nose onto targets for rocket passes; the gunner
//    bot works the chin gun. Below 50 % HP it breaks off to its pad, lands and
//    waits for regeneration before it goes again.
//  - Transport: carries a squad to a landing zone by its staging point, drops
//    it, lifts off and flies home (no land-and-exit at the target). Door
//    gunners engage infantry inside their arcs while the squad rides.
//  - Jet: attack runs instead of a loiter: roll in from an initial point 300 m
//    out, dive toward the target down to 60 m above ground firing the cannon,
//    then extend and climb back out. Air targets get the AA missile once the
//    lock completes.
//  - Reflexes: lk >= 2 releases flares after the difficulty's reaction time.
//  - Sight from the canopy reaches 250 m on every difficulty.

import { VEHICLE_RULES, vehicleDirection, vehicleMuzzlePose } from '../shared/vehicles.js';
import { vehicleSeatOccupantId, vehicleSeats } from '../shared/vehicle-seats.js';
import { VEHICLE_WEAPON_META, seatWeaponList } from '../shared/conquest-contract.js';
import { botVehicleSeat, botVehicleDriver, botPassengerInput, boardingGoal, countermeasureReady, maxHullHp } from './bot-vehicle-driving.js';
import { observeBotTarget, recognitionThreshold } from './bot-perception.js';
import { observeBotVehicle, hullTarget, hullCrew, seatedExposed, mountSystem, seatWeapons } from './bot-vehicle-combat.js';
import { AimSteering } from './bot-aim.js';
import { botDifficulty, BOT_AIRCRAFT_SIGHT_RANGE } from '../shared/bot-difficulty.js';
import { ROCKET_RULES } from '../shared/rocket-rules.js';
import { AIRCRAFT_PROJECTILE_WEAPONS } from '../shared/weapon-aircraft-projectiles.js';
import { raycastVoxels } from '../shared/raycast.js';

const AIRCRAFT = new Set(['helicopter', 'transport', 'plane']);
const ROTOR = new Set(['helicopter', 'transport']);
const aircraft = v => AIRCRAFT.has(v?.type);
const flatDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
const bearing = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z));
const horizontalSpeed = v => Math.hypot(v.vx || 0, v.vz || 0);
const rulesOf = v => VEHICLE_RULES[v.type] ?? VEHICLE_RULES.helicopter;
const bodyOrigin = v => [v.x, v.y + (rulesOf(v).gunPivotHeight ?? 1), v.z];
const clearRay = (game, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return !raycastVoxels(game.solidAt, a[0], a[1], a[2], dx, dy, dz, Math.hypot(dx, dy, dz))
    && !game.projectiles.smoke.blocksSight(a, b, game.now);
};
export const HELI_ORBIT = Object.freeze({ min: 60, max: 90, radius: 75, height: 34 });
export const HELI_BREAK_HP = 0.5;
export const HELI_RESUME_HP = 0.58;
// Roll-in up to 300 m (as far as the flight boundary box allows, at least
// 90 m), cruise 75 m AGL, pull out at 45 m AGL: on the 768 map the boundary
// box at these speeds leaves ~260 m from the centre to its edge.
export const JET_RUN = Object.freeze({ rollIn: 300, minRollIn: 90, pullUpAgl: 45, cruiseAgl: 75, extend: 330 });
const RUN_SIDES = [0.7, -0.7, 0.35, -0.35];
const JET_SPEED = Object.freeze({ climb: 32, ingress: 32, turnin: 28, dive: 36, extend: 32 });

function rayBox(origin, dir, lo, hi, max) {
  let near = 0, far = max;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-9) { if (origin[i] < lo[i] || origin[i] > hi[i]) return false; }
    else { const a = (lo[i] - origin[i]) / dir[i], b = (hi[i] - origin[i]) / dir[i]; near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b)); }
  }
  return near <= far;
}

/** Clear the actual projectile arc, including allied infantry and intervening
 * hulls. Knowing a visible target never permits fire through a friendly body. */
function clearAircraftShot(game, p, v, target, origin, dir, distance, speed, gravity) {
  const seconds = distance / speed;
  const at = t => origin.map((n, i) => n + dir[i] * speed * t - (i === 1 ? gravity * t * t / 2 : 0));
  // Every sampled segment lies inside the arc's bounding box (x and z are
  // linear in t, y peaks at the apex): only boxes overlapping it can block.
  const apex = gravity > 0 ? dir[1] * speed / gravity : -1;
  const ends = [origin, at(seconds), ...(apex > 0 && apex < seconds ? [at(apex)] : [])];
  const lo = [0, 1, 2].map(i => Math.min(...ends.map(e => e[i])) - 1), hi = [0, 1, 2].map(i => Math.max(...ends.map(e => e[i])) + 1);
  const overlaps = (a, b) => a[0] <= hi[0] && b[0] >= lo[0] && a[1] <= hi[1] && b[1] >= lo[1] && a[2] <= hi[2] && b[2] >= lo[2];
  const boxes = [];
  for (const hull of game.vehicles.vehicles.values()) {
    if (hull === v || hull.id === target.vehicleId || hull.hp <= 0) continue;
    const def = rulesOf(hull), r = def.radius;
    const a = [hull.x - r, hull.y, hull.z - r], b = [hull.x + r, hull.y + def.height, hull.z + r];
    if (overlaps(a, b)) boxes.push(a, b);
  }
  for (const other of game.entities.values()) {
    if (other === p || other.id === target.id || other.state !== 'alive' || other.vehicleId || game.mode.isEnemy(p, other)) continue;
    const a = [other.x - 0.45, other.y, other.z - 0.45], b = [other.x + 0.45, other.eyeY + 0.2, other.z + 0.45];
    if (overlaps(a, b)) boxes.push(a, b);
  }
  let from = origin;
  for (let t = Math.min(0.035, seconds); t <= seconds + 1e-8; t = Math.min(seconds, t + 0.035)) {
    const to = origin.map((n, i) => n + dir[i] * speed * t - (i === 1 ? gravity * t * t / 2 : 0));
    if (!clearRay(game, from, to)) return false;
    if (boxes.length) {
      const delta = to.map((n, i) => n - from[i]), length = Math.hypot(...delta), unit = delta.map(n => n / (length || 1));
      for (let i = 0; i < boxes.length; i += 2) if (rayBox(from, unit, boxes[i], boxes[i + 1], length)) return false;
    }
    from = to; if (t === seconds) break;
  }
  return true;
}

/**
 * Visible targets for a pilot's fixed guns: hulls (air first for missiles)
 * then infantry and exposed crew. With `heldId` only that target is checked
 * (the sweep's long sight lines run every other tick, like infantry scans);
 * a held target out of sight falls back to the full sweep at once.
 */
function observeAircraftTarget(game, br, p, v, { airOnly = false, heldId = null } = {}) {
  const observer = { x: v.x, z: v.z, eyeY: bodyOrigin(v)[1], yaw: v.yaw, pitch: v.pitch || 0 };
  const options = { sightRange: BOT_AIRCRAFT_SIGHT_RANGE };
  const hullSighting = hull => {
    if (hull === v || hull.hp <= 0 || (hull.team && hull.team === (game.mode.teamFor?.(p) ?? p.team))) return null;
    if (airOnly && !aircraft(hull)) return null;
    const crew = hullCrew(game, hull).filter(o => game.mode.isEnemy(p, o));
    if (!crew.length || game.mode.canDamage?.(p, hull) === false) return null;
    const sighting = observeBotVehicle(observer, hull, game.solidAt, game.projectiles.smoke, game.now, false, br.difficulty, options);
    return sighting ? { target: hullTarget(hull, crew[0]), sighting, score: sighting.distance * (aircraft(hull) && v.type === 'plane' ? 0.5 : 1) } : null;
  };
  const bodySighting = target => {
    if (target.state !== 'alive' || !game.mode.isEnemy(p, target) || game.mode.canDamage?.(p, target) === false) return null;
    if (target.vehicleId && !seatedExposed(game, target)) return null;
    const sighting = observeBotTarget(observer, target, game.solidAt, game.projectiles.smoke, game.now, false, br.difficulty, options);
    return sighting ? { target, sighting, score: sighting.distance } : null;
  };
  if (heldId) {
    const hullId = heldId.startsWith('vehicle:') ? heldId.slice(8) : null;
    const hull = hullId !== null ? game.vehicles.vehicles.get(hullId) : null;
    const body = hullId === null && !airOnly ? game.entities.get(heldId) : null;
    const held = hull ? hullSighting(hull) : body ? bodySighting(body) : null;
    if (held) return held;
  }
  let best = null;
  for (const hull of game.vehicles.vehicles.values()) {
    const seen = hullSighting(hull);
    if (seen && (!best || seen.score < best.score)) best = seen;
  }
  if (best || airOnly) return best;
  for (const target of game.entities.values()) {
    const seen = bodySighting(target);
    if (seen && (!best || seen.score < best.score)) best = seen;
  }
  return best;
}

/** The pilot's selected fixed weapon and its ballistics. */
function pilotWeapon(game, v, seatId = 'driver') {
  if (mountSystem(game)) {
    const list = seatWeaponList(v.type, seatId);
    const index = Math.max(0, Math.min(list.length - 1, v.sel?.[seatId] | 0));
    const entry = list[index];
    if (!entry) return null;
    const meta = VEHICLE_WEAPON_META[entry.weapon];
    return { key: entry.weapon, mount: entry.mount, index, list, speed: meta.speed > 0 ? meta.speed : 2000, gravity: meta.gravity ?? 0,
      origin: game.vehicles.mountPose(v, seatId, entry.mount)?.origin ?? vehicleMuzzlePose(v).origin, kind: meta.kind,
      range: entry.weapon === 'planeCannon' ? 340 : entry.weapon === 'aaMissile' ? 350 : BOT_AIRCRAFT_SIGHT_RANGE };
  }
  const legacy = AIRCRAFT_PROJECTILE_WEAPONS?.[v.type === 'helicopter' ? 'helicopterRocket' : 'planeCannon'];
  return legacy ? { key: legacy.id, speed: legacy.speed, gravity: legacy.gravity ?? ROCKET_RULES.gravity, origin: vehicleMuzzlePose(v).origin,
    range: BOT_AIRCRAFT_SIGHT_RANGE, index: 0, list: [] } : null;
}

/** Recognition and aim from current visual evidence. The flight controller can
 * point the aircraft at this aim; fixed guns fire only once the authoritative
 * attitude has reached it. */
export function aircraftCombatIntent(game, br, p, v, state, now, dt, { airOnly = false } = {}) {
  // Air-to-air and air-to-ground recognition accumulate separately: a jet
  // checking the sky every tick must not wipe its ground target's evidence.
  const slot = airOnly ? 'airCombat' : 'combat';
  // Full sweeps alternate with checks of the held target only.
  const sweep = state[`${slot}Sweep`] = !state[`${slot}Sweep`];
  const heldId = !sweep && state[slot] ? state[slot].id : null;
  const observed = game.mode.canFire(p) ? observeAircraftTarget(game, br, p, v, { airOnly, heldId }) : null;
  if (!observed) { state[slot] = null; return null; }
  const { target, sighting } = observed;
  let combat = state[slot];
  if (!combat || combat.id !== target.id || combat.lives !== target.lives || combat.occupantId !== target.occupantId) {
    combat = state[slot] = { id: target.id, lives: target.lives, occupantId: target.occupantId,
      elapsed: 0, evidence: 0, threshold: recognitionThreshold(br.rng()), progress: 0, aim: new AimSteering() };
  }
  const previous = combat.elapsed, reaction = sighting.reactionMs * (br.reactionScale ?? 1);
  combat.elapsed += dt * 1000;
  combat.evidence += (Math.max(0, combat.elapsed - reaction) - Math.max(0, previous - reaction)) / 1000 * sighting.detectionRate;
  combat.progress = Math.min(1, combat.evidence / Math.max(1e-9, combat.threshold));
  if (combat.progress < 1) return null;
  const weapon = pilotWeapon(game, v);
  if (!weapon) return null;
  const origin = weapon.origin;
  const flightTime = sighting.distance / weapon.speed, skill = br.skill ?? 0.5;
  const point = sighting.aimPoint.map((n, i) => n + (i === 0 ? target.vx || 0 : i === 1 ? target.vy || 0 : target.vz || 0) * flightTime * (0.85 + skill * 0.15));
  const dx = point[0] - origin[0], dy = point[1] - origin[1], dz = point[2] - origin[2], flat = Math.hypot(dx, dz);
  const yaw = bearing({ x: origin[0], z: origin[2] }, { x: point[0], z: point[2] });
  const pitch = Math.atan2(dy + weapon.gravity * flightTime * flightTime / 2, flat);
  const profile = botDifficulty(br.difficulty), def = rulesOf(v);
  const wander = combat.aim.wander(dt, (1.1 - 0.7 * skill) * profile.aimError * Math.PI / 180, 0.6, br.rng);
  const reachable = pitch >= (def.minPitch ?? (ROTOR.has(v.type) ? -0.45 : -0.55)) && pitch <= (def.maxPitch ?? 0.4);
  // Guns are walked onto the target in a burst (a few metres of spray is a
  // strafing run); rockets and missiles need the tight alignment.
  const tolerance = weapon.kind === 'hitscan'
    ? clamp(Math.atan2(4 + 2 * skill, Math.max(1, sighting.distance)), 0.035, 0.07)
    : 0.025 + skill * 0.015;
  const aligned = Math.abs(wrap(v.yaw - yaw)) < tolerance && Math.abs((v.pitch || 0) - pitch) < tolerance;
  const distance = Math.hypot(dx, dy, dz), dir = vehicleDirection(v.yaw, v.pitch || 0);
  const lockReady = weapon.key !== 'aaMissile' || (Number.isFinite(p.lockProgress) && p.lockProgress >= (p.lockProgress > 1 ? 99 : 0.99));
  const ready = reachable && aligned && lockReady && distance <= weapon.range;
  const muzzleClear = ready && clearRay(game, bodyOrigin(v), origin);
  // A gun burst is cleared along the sight line to the target (the spray
  // walks onto it); a rocket or missile along the actual barrel.
  const lineDir = weapon.kind === 'hitscan' ? [dx / (distance || 1), dy / (distance || 1), dz / (distance || 1)] : dir;
  const fire = muzzleClear && clearAircraftShot(game, p, v, target, origin, lineDir, distance, weapon.speed, weapon.gravity);
  combat.check = { reachable, aligned, lockReady, inRange: distance <= weapon.range, muzzleClear, fire,
    yawError: wrap(v.yaw - yaw), pitchError: (v.pitch || 0) - pitch };
  return { yaw: wrap(yaw + wander.yaw), pitch: pitch + wander.pitch, target, point, distance, fire, reachable, weapon };
}

/** Pilots fly; gunners and passengers sit in. Assignments come from the commander. */
export class ConquestAircraftDriving {
  constructor(game, manager = null) {
    this.game = game; this.manager = manager;
    this.drivers = new Map(); this.boarding = new Map(); this.reflex = new Map();
  }
  get commander() { return this.manager?.commander ?? null; }
  release(id) { this.drivers.delete(id); this.boarding.delete(id); this.reflex.delete(id); }
  clear() { this.drivers.clear(); this.boarding.clear(); this.reflex.clear(); }
  active() { return this.game.mode.mode === 'conquest' && this.game.mode.phase === 'live' && !!this.game.vehicles; }

  update(brains, now) {
    if (!this.active()) { this.clear(); return; }
    const ids = new Set(brains.map(br => br.id));
    for (const id of [...this.drivers.keys(), ...this.boarding.keys()]) {
      const p = this.game.entities.get(id);
      if (!ids.has(id) || p?.state !== 'alive') this.release(id);
    }
  }

  groundHeight(point) {
    const world = this.game.world;
    const x = Math.floor(point.x), z = Math.floor(point.z);
    let height = world.heightAt?.(x, z);
    // heightAt is the pristine top; prefer the live column under craters.
    if (Number.isFinite(height)) {
      while (height > 0 && !this.game.solidAt(x, height, z) && !this.game.fluidAt(x, height, z)) height--;
      return height + 1;
    }
    return (this.game.mapMeta.groundLevel ?? 10) + 1;
  }

  /** A clear touchdown spot near `goal` for a rotor hull, distinct from other planned landings. */
  landingPoint(v, goal) {
    const planned = [...this.drivers.values()].filter(state => state.vehicle !== v && ROTOR.has(state.vehicle.type)
      && state.vehicle.hp > 0 && state.landing).map(state => state.landing);
    for (const [dx, dz] of [[0, 0], [18, 0], [-18, 0], [0, 18], [0, -18], [14, 14], [-14, -14], [14, -14], [-14, 14], [28, 0], [-28, 0], [0, 28], [0, -28]]) {
      const point = { x: goal.x + dx, z: goal.z + dz }, y = this.groundHeight(point);
      if (planned.some(other => flatDistance(point, other) < 17.5)) continue;
      if (this.game.fluidAt(Math.floor(point.x), y - 1, Math.floor(point.z))) continue;
      if (this.game.vehicles.clearHull(v, point.x, y + 0.02, point.z)) return { ...point, y: y + 0.02 };
    }
    return { x: goal.x, y: this.groundHeight(goal) + 0.02, z: goal.z };
  }

  countermeasure(br, v, now, inp) {
    if ((v.lk | 0) < 2) { this.reflex.delete(br.id); return; }
    let due = this.reflex.get(br.id);
    if (due == null) { due = now + botDifficulty(br.difficulty).countermeasureMs; this.reflex.set(br.id, due); }
    if (now >= due && !inp.vehicleAction && countermeasureReady(v, now)) {
      inp.vehicleAction = { type: 'cm' };
      this.reflex.set(br.id, now + 4000);
    }
  }

  think(br, p, goal, now, dt, inp) {
    if (!this.active()) return null;
    const v = this.game.vehicles.vehicles.get(p.vehicleId);
    const seat = aircraft(v) ? botVehicleSeat(p, v) : null;
    const assignment = this.commander?.crewFor(p.id) ?? null;
    if (seat) {
      const mine = assignment?.vehicleId === v.id ? assignment : null;
      if (seat.drives && !mine && v.grounded && horizontalSpeed(v) < 0.8 && v.type !== 'transport') {
        // Landed without a crew order (the commander gave the slot away): get out.
        botPassengerInput(inp);
        inp.vehicleAction = { type: 'exit' };
        this.release(br.id);
      } else if (seat.drives) {
        this.fly(br, p, v, mine, goal, now, dt, inp);
        this.countermeasure(br, v, now, inp);
      } else {
        botPassengerInput(inp);
        const trip = [...this.drivers.values()].find(state => state.vehicle === v);
        const landed = v.grounded && horizontalSpeed(v) < 0.8 && Math.abs(v.vy || 0) < 0.4;
        // Riders get out at a drop or once a landed hull has no pilot; a gunner
        // with a crew order stays on its gun until the commander says otherwise.
        const gunnerSeat = seatWeapons(this.game, v, seat.id).length > 0;
        const drop = trip?.phase === 'drop' || (landed && (!mine || (!gunnerSeat && !botVehicleDriver(v))));
        if (landed && drop) { inp.vehicleAction = { type: 'exit' }; this.release(br.id); this.commander?.leaveTransit(v.id, p.id); }
      }
      br.intendsMove = false;
      const weapon = !seat.drives && seatWeapons(this.game, v, seat.id).length > 0 && !inp.vehicleAction;
      return { vehicle: v, seatId: seat.id, weapon };
    }
    if (!assignment) return null;
    const hull = this.game.vehicles.vehicles.get(assignment.vehicleId);
    if (!aircraft(hull) || hull.hp <= 0 || p.vehicleId) return null;
    // Only board a grounded aircraft.
    if (hull.grounded === false) return null;
    let state = this.boarding.get(br.id);
    if (!state || state.vehicleId !== hull.id) { state = { vehicleId: hull.id, type: hull.type, since: now }; this.boarding.set(br.id, state); }
    return { board: boardingGoal(this.game, p, hull, assignment.seatId) };
  }

  fly(br, p, v, assignment, goal, now, dt, inp) {
    let state = this.drivers.get(br.id);
    if (!state || state.vehicle !== v || state.lives !== p.lives) {
      state = { vehicle: v, lives: p.lives, phase: 'takeoff', startedAt: now, phaseAt: now, landing: null, combat: null,
        orbitSign: br.index % 2 ? 1 : -1, orbitAngle: null, runs: 0 };
      this.drivers.set(br.id, state);
    }
    inp.vehicleThrottle = 0; inp.vehicleSteer = 0; inp.vehicleBrake = 0; inp.vehicleLift = 0;
    inp.yaw = v.yaw; inp.pitch = 0; inp.wantFire = false;
    if (v.type === 'plane') return this.jet(br, p, v, state, assignment, now, dt, inp);
    if (v.type === 'transport' || assignment?.role === 'transit') return this.transport(br, p, v, state, assignment, now, dt, inp);
    return this.attackHelicopter(br, p, v, state, assignment, goal, now, dt, inp);
  }

  /** Rotor flight toward a point at an altitude: velocity-vector control through cyclic tilt. */
  rotorTo(v, destination, altitude, inp, { maxSpeed = 24, approach = 4.4, holdYaw = null } = {}) {
    const def = rulesOf(v);
    const distance = flatDistance(v, destination), speed = horizontalSpeed(v);
    inp.vehicleLift = clamp((altitude - v.y) * 0.2 - (v.vy || 0) * 0.25, -1, 1);
    inp.yaw = holdYaw ?? (distance > 0.8 ? bearing(v, destination) : v.yaw);
    const desiredSpeed = Math.min(maxSpeed, distance * 0.65, Math.sqrt(approach * Math.max(0, distance - 0.25)));
    const desiredX = distance > 1e-6 ? (destination.x - v.x) / distance * desiredSpeed : 0;
    const desiredZ = distance > 1e-6 ? (destination.z - v.z) / distance * desiredSpeed : 0;
    const drag = def.drag + speed * def.airDrag;
    let ax = (desiredX - (v.vx || 0)) * 0.8 + (v.vx || 0) * drag;
    let az = (desiredZ - (v.vz || 0)) * 0.8 + (v.vz || 0) * drag;
    const acceleration = Math.hypot(ax, az), limit = maxSpeed <= 5 && v.y < altitude + 4 ? 2.2 : 4.5;
    if (acceleration > limit) { ax *= limit / acceleration; az *= limit / acceleration; }
    // Cyclic in the hull frame: pitch forward, bank sideways (side-slip is allowed).
    const yaw = inp.yaw;
    const forward = -Math.sin(v.yaw) * ax - Math.cos(v.yaw) * az, side = Math.cos(v.yaw) * ax - Math.sin(v.yaw) * az;
    inp.pitch = clamp(Math.atan2(-forward, def.gravity), def.minPitch, def.maxPitch);
    const bank = clamp(Math.atan2(-side * Math.cos(inp.pitch), def.gravity), -def.maxBank, def.maxBank);
    inp.vehicleSteer = -bank / def.maxBank;
    inp.yaw = yaw;
    return distance;
  }

  /** Touch down at a point; true once settled on the ground. */
  rotorLand(v, landing, inp) {
    this.rotorTo(v, landing, landing.y, inp, { maxSpeed: 5 });
    if (v.grounded && horizontalSpeed(v) < 0.4 && Math.abs(v.vy || 0) < 0.4) { inp.vehicleLift = 0; return true; }
    return false;
  }

  attackHelicopter(br, p, v, state, assignment, goal, now, dt, inp) {
    const hp = v.hp / maxHullHp(v);
    const center = assignment?.flag ?? goal?.target ?? v.spawn;
    const home = v.spawn ?? v;
    if (hp < HELI_BREAK_HP && state.phase !== 'breakoff' && state.phase !== 'land' && state.phase !== 'rest') {
      state.phase = 'breakoff'; state.phaseAt = now; state.landing = this.landingPoint(v, home);
    }
    const ground = this.groundHeight(v);
    if (state.phase === 'takeoff') {
      if (v.y >= this.groundHeight(v) + 22) { state.phase = 'orbit'; state.phaseAt = now; }
      inp.vehicleLift = 1; inp.yaw = center ? bearing(v, center) : v.yaw; inp.pitch = 0;
      return;
    }
    if (state.phase === 'breakoff' || state.phase === 'land') {
      const landing = state.landing ?? this.landingPoint(v, home);
      const distance = flatDistance(v, landing);
      if (state.phase === 'breakoff') {
        this.rotorTo(v, landing, Math.max(landing.y + 30, ground + 20), inp);
        if (distance < 5 && horizontalSpeed(v) < 1.2) { state.phase = 'land'; state.phaseAt = now; }
      } else if (this.rotorLand(v, landing, inp)) { state.phase = 'rest'; state.phaseAt = now; }
      return;
    }
    if (state.phase === 'rest') {
      inp.vehicleLift = 0;
      if (hp >= HELI_RESUME_HP || now - state.phaseAt > 30000) { state.phase = 'takeoff'; state.phaseAt = now; }
      return;
    }
    if (!center) return;
    // Circle-strafe: a point on the 60-90 m ring ahead of the hull, nose toward the centre.
    const radius = HELI_ORBIT.radius + Math.sin(now / 4000 + br.index) * 12;
    const angle = Math.atan2(v.z - center.z, v.x - center.x);
    const distance = flatDistance(v, center);
    const lead = distance > HELI_ORBIT.max + 30 ? 0 : 0.35 * state.orbitSign;
    const point = { x: center.x + Math.cos(angle + lead) * radius, z: center.z + Math.sin(angle + lead) * radius };
    const altitude = Math.min((rulesOf(v).ceiling ?? 180) - 5, this.groundHeight(point) + HELI_ORBIT.height);
    const nose = distance < HELI_ORBIT.max + 40 ? bearing(v, center) : null;
    this.rotorTo(v, point, Math.max(altitude, ground + 18), inp, { maxSpeed: 16, holdYaw: nose });
    const combat = aircraftCombatIntent(this.game, br, p, v, state, now, dt);
    if (combat?.reachable && now >= (state.nextPassAt ?? 0)) state.passUntil ??= now + 1600;
    if (state.passUntil && now < state.passUntil && combat?.reachable && combat.distance < 220) {
      inp.yaw = combat.yaw; inp.pitch = clamp(combat.pitch, rulesOf(v).minPitch, rulesOf(v).maxPitch);
      inp.wantFire = combat.fire;
    } else if (state.passUntil) { state.passUntil = null; state.nextPassAt = now + 1400; }
  }

  transport(br, p, v, state, assignment, now, dt, inp) {
    const transit = assignment?.transit ?? null;
    const destination = transit?.destination ?? assignment?.destination ?? null;
    const home = v.spawn ?? v;
    const ground = this.groundHeight(v);
    if (state.phase === 'takeoff' && transit && !transit.departAt) {
      const waiting = [...transit.seats].some(([id, seatId]) => {
        const rider = this.game.entities.get(id);
        return rider?.state === 'alive' && vehicleSeatOccupantId(v, seatId) !== id;
      });
      transit.boardingSince ??= now;
      if (waiting && now - transit.boardingSince < 12000) { inp.vehicleLift = 0; return; }
      this.commander?.markTransit(v.id, { departAt: now });
    }
    if (state.phase === 'takeoff') {
      state.landing = destination ? this.landingPoint(v, destination) : this.landingPoint(v, home);
      state.leg = destination ? 'out' : 'home';
      if (v.y >= ground + 18) { state.phase = 'travel'; state.phaseAt = now; }
      inp.vehicleLift = 1; inp.yaw = bearing(v, state.landing);
      return;
    }
    const landing = state.landing ?? this.landingPoint(v, home);
    const cruise = Math.min((rulesOf(v).ceiling ?? 180) - 5, Math.max(this.groundHeight(landing), ground) + 32);
    const late = transit?.departAt && now - transit.departAt > 40000 && state.leg === 'out';
    if (late && state.phase === 'travel') { state.landing = this.landingPoint(v, v); }
    if (state.phase === 'travel') {
      const distance = this.rotorTo(v, state.landing, cruise, inp);
      if (distance < 5 && horizontalSpeed(v) < 1.2) { state.phase = 'land'; state.phaseAt = now; }
      return;
    }
    if (state.phase === 'land') {
      if (this.rotorLand(v, state.landing, inp)) {
        state.phase = state.leg === 'out' ? 'drop' : 'parked'; state.phaseAt = now;
      }
      return;
    }
    if (state.phase === 'drop') {
      inp.vehicleLift = 0;
      const aboard = vehicleSeats(v).some(seat => !seat.drives && vehicleSeatOccupantId(v, seat.id) != null
        && transit?.seats.has(vehicleSeatOccupantId(v, seat.id)));
      if (!aboard || now - state.phaseAt > 6000) {
        this.commander?.markTransit(v.id, { done: true });
        state.phase = 'takeoff'; state.phaseAt = now; state.leg = 'home';
        state.landing = this.landingPoint(v, home);
        state.liftOff = true;
      }
      return;
    }
    if (state.phase === 'parked') {
      inp.vehicleLift = 0;
      if (v.grounded && horizontalSpeed(v) < 0.6) { inp.vehicleAction = { type: 'exit' }; this.release(br.id); }
    }
  }

  jet(br, p, v, state, assignment, now, dt, inp) {
    const def = rulesOf(v), ground = this.groundHeight(v);
    if (v.grounded && state.phase === 'takeoff') {
      inp.vehicleThrottle = 1; inp.yaw = v.spawn?.yaw ?? v.yaw; inp.pitch = 0.13; this.planeAxes(v, inp); return;
    }
    if (state.phase === 'takeoff') { state.phase = 'climb'; state.phaseAt = now; }
    // Speed, not power: the flight boundary box shrinks with the turn radius,
    // so the jet works at a tight-turning 28-36 m/s (stall 20).
    const targetSpeed = JET_SPEED[state.phase] ?? JET_SPEED.ingress, airspeed = horizontalSpeed(v);
    inp.vehicleThrottle = state.phase === 'climb' && airspeed < targetSpeed ? 1
      : airspeed < targetSpeed - 1.5 ? 1 : airspeed > targetSpeed + 1.5 ? -1 : 0;
    if (state.phase === 'climb') {
      inp.yaw = v.spawn?.yaw ?? v.yaw;
      inp.pitch = clamp((ground + JET_RUN.cruiseAgl - v.y) * 0.009, 0.08, 0.23);
      if (v.y >= ground + 22 && horizontalSpeed(v) >= JET_SPEED.climb - 3) { state.phase = 'ingress'; state.phaseAt = now; }
      // Runways sit outside the boundary box: turn in before the climb-out
      // track would hand the jet to the safety pilot.
      if (v.y >= ground + 8) this.boundaryGuard(v, this.jetBox(v), inp);
      this.planeAxes(v, inp); return;
    }
    const focus = assignment?.flag ?? this.commander?.focusFlag(this.commander.teams.get(this.game.mode.teamFor?.(p) ?? p.team)) ?? v.spawn;
    const own = this.commander?.view?.bases?.[this.game.mode.teamFor?.(p) ?? p.team] ?? v.spawn ?? focus;
    // Air threats first: the AA missile once locked, else the cannon.
    const air = aircraftCombatIntent(this.game, br, p, v, state, now, dt, { airOnly: true });
    if (air && air.distance < 360) this.selectPilotWeapon(v, 'aaMissile', inp, state, now);
    else if (state.phase === 'dive') this.selectPilotWeapon(v, 'planeCannon', inp, state, now);
    // The VehicleSystem flight boundary hands a jet to its safety pilot when
    // its 2 s track leaves a speed-dependent interior box; every run point is
    // kept inside that box so the bot never triggers the handoff.
    const box = this.jetBox(v);
    const inBox = point => point.x >= box.minX && point.x <= box.maxX && point.z >= box.minZ && point.z <= box.maxZ;
    let target = focus;
    // Racetrack attack pattern sized to the boundary box: turn in toward the
    // target from as far out as the box allows (up to the 300 m roll-in),
    // dive when the nose is on it, extend past it toward the far side of the
    // box, swing round and come back the other way.
    if (state.phase === 'ingress' || state.phase === 'turnin') {
      target = focus;
      const distance = flatDistance(v, focus);
      const error = Math.abs(wrap(bearing(v, focus) - v.yaw));
      if (state.phase === 'ingress' && distance <= JET_RUN.rollIn) { state.phase = 'turnin'; state.phaseAt = now; }
      if (state.phase === 'turnin') {
        if (error < 0.22 && distance > JET_RUN.minRollIn) { state.phase = 'dive'; state.phaseAt = now; }
        else if (now - state.phaseAt > 15000) { state.phase = 'extend'; state.phaseAt = now; state.extendYaw = v.yaw; }
      }
    } else if (state.phase === 'extend') {
      const away = state.extendYaw ?? v.yaw;
      target = this.clampToBox({ x: v.x - Math.sin(away) * 200, z: v.z - Math.cos(away) * 200 }, box);
      // Start the turn back while a quarter turn plus the boundary's 2 s lookahead still fits.
      const lead = 2.4 + 1.1 * box.radius / Math.max(20, horizontalSpeed(v));
      const ahead = { x: v.x + (v.vx || 0) * lead, z: v.z + (v.vz || 0) * lead };
      const far = flatDistance(v, focus) > JET_RUN.extend || !inBox(ahead) || now - state.phaseAt > 9000;
      if (far && v.y > ground + JET_RUN.cruiseAgl - 25) { state.phase = 'turnin'; state.phaseAt = now; state.runs++; }
    }
    inp.yaw = bearing(v, target);
    const speed = Math.max(def.stallSpeed, horizontalSpeed(v));
    const altitude = state.phase === 'dive' ? ground + JET_RUN.pullUpAgl + 10 : ground + JET_RUN.cruiseAgl;
    const desiredClimb = clamp((altitude - v.y) * 0.65, state.phase === 'dive' ? -14 : -6, 10);
    const bank = clamp(Math.atan2(wrap(inp.yaw - v.yaw) * 0.9 * speed, def.gravity), -1, 1);
    const load = 1 / Math.max(0.45, Math.cos(bank));
    const angleOfAttack = ((def.takeoffSpeed / speed) ** 2 * load - def.liftIncidence) / def.liftSlope;
    inp.pitch = clamp((v.pitch || 0) + (angleOfAttack - (v.angleOfAttack || 0)) / Math.max(0.45, Math.cos(v.roll || 0))
      + (desiredClimb - (v.vy || 0)) * 0.05, -0.3, 0.3);
    if (state.phase === 'dive') {
      const combat = air ?? aircraftCombatIntent(this.game, br, p, v, state, now, dt);
      if (combat?.reachable && combat.distance > 70) {
        inp.yaw = combat.yaw; inp.pitch = Math.max(-0.4, combat.pitch); inp.wantFire = combat.fire;
      }
      const agl = v.y - this.groundHeight(v);
      if (agl < JET_RUN.pullUpAgl || flatDistance(v, focus) < 60 || now - state.phaseAt > 14000) {
        state.phase = 'extend'; state.phaseAt = now; state.extendYaw = v.yaw;
      }
    } else if (air?.fire && air.weapon?.key === 'aaMissile') {
      inp.yaw = air.yaw; inp.pitch = Math.max(-0.3, air.pitch); inp.wantFire = true;
    }
    // Pull out before a nose-down pass can reach the terrain.
    if (v.y < ground + 28 && state.phase !== 'dive') { inp.pitch = 0.3; inp.wantFire = false; }
    if (v.y < ground + JET_RUN.pullUpAgl - 15) { inp.pitch = 0.3; inp.wantFire = false; }
    // Turn inward before the track reaches the boundary box edge.
    if (this.boundaryGuard(v, box, inp) && state.phase !== 'dive') {
      // (A dive points inward at its target anyway; it ends by its own rules.)
      inp.pitch = Math.max(0.08, inp.pitch); inp.wantFire = false;
    }
    this.planeAxes(v, inp);
  }

  /**
   * True (and the yaw set toward the map centre) while the jet's track points
   * outward past the boundary box: the condition VehicleSystem's flight
   * boundary reacts to, checked with extra lookahead so the bot turns first.
   */
  boundaryGuard(v, box, inp) {
    const vx = v.vx || 0, vz = v.vz || 0;
    const look = 2.2 + 1.1 * box.radius / Math.max(20, Math.hypot(vx, vz));
    const fx = v.x + vx * look, fz = v.z + vz * look;
    const outward = (fx < box.minX && vx < -0.1) || (fx > box.maxX && vx > 0.1) || (fz < box.minZ && vz < -0.1) || (fz > box.maxZ && vz > 0.1);
    if (!outward) return false;
    const { sx, sz } = this.game.world.dimensions;
    inp.yaw = bearing(v, { x: sx / 2, z: sz / 2 });
    return true;
  }

  /** Interior box the flight boundary leaves a jet at its current speed (mirrors VehicleSystem). */
  jetBox(v) {
    const def = rulesOf(v), { sx, sz } = this.game.world.dimensions;
    const speed = Math.max(def.takeoffSpeed ?? 24, horizontalSpeed(v));
    const rate = Math.min(def.turn, def.gravity * Math.tan(Math.min(def.maxBank, 1.05)) / speed);
    const radius = speed / Math.max(0.1, rate);
    const margin = Math.min(Math.min(sx, sz) * 0.43, Math.max(110, radius + speed * 1.2 + 20)) + 12;
    return { minX: margin, maxX: sx - margin, minZ: margin, maxZ: sz - margin, radius };
  }

  clampToBox(point, box) {
    if (box.minX > box.maxX || box.minZ > box.maxZ) return { x: (box.minX + box.maxX) / 2, z: (box.minZ + box.maxZ) / 2 };
    return { x: clamp(point.x, box.minX, box.maxX), z: clamp(point.z, box.minZ, box.maxZ) };
  }

  selectPilotWeapon(v, key, inp, state, now) {
    if (!mountSystem(this.game) || inp.vehicleAction || now < (state.selectAt ?? 0)) return;
    const list = seatWeaponList(v.type, 'driver');
    const index = list.findIndex(entry => entry.weapon === key);
    if (index < 0 || (v.sel?.driver | 0) === index) return;
    inp.vehicleAction = { type: 'weapon', index };
    state.selectAt = now + 500;
  }

  planeAxes(v, inp) {
    const def = rulesOf(v), error = wrap(inp.yaw - v.yaw), speed = Math.max(def.takeoffSpeed, horizontalSpeed(v));
    const bank = v.grounded ? 0 : clamp(Math.atan2(error * 0.9 * speed, def.gravity), -1, 1);
    const pitchRate = clamp((inp.pitch - (v.pitch || 0)) * 3 - (v.pitchRate || 0) * 0.45, -def.pitchRate, def.pitchRate);
    const rollRate = clamp((bank - (v.roll || 0)) * 3 - (v.rollRate || 0) * 0.4, -def.bankRate, def.bankRate);
    inp.vehiclePitchControl = pitchRate / def.pitchRate;
    inp.vehicleRollControl = -rollRate / def.bankRate;
    inp.vehicleYawControl = v.grounded ? clamp(-error * 2, -1, 1) : 0;
  }
}


