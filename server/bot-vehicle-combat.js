// Conquest combat perception and gunnery for bots.
//
// One threat picker covers infantry, exposed seated crew (the same
// occupantShielded rule the damage model uses) and occupied enemy hulls. Each
// candidate is scored by its danger, distance, whether it is shooting this bot
// and how well the bot's weapons actually hurt it (the armour class x damage
// class matrix). Mounted gunnery drives any seat that owns mounts: the tank
// driver's main gun and coax, the commander RWS, the jeep pintle, door guns and
// the chin gun. All of it is input-only: VehicleSystem keeps turret slew,
// ammunition, heat and damage authoritative.

import { AimSteering } from './bot-aim.js';
import { observeBotTarget, recognitionThreshold } from './bot-perception.js';
import { botDifficulty } from '../shared/bot-difficulty.js';
import { BOT_PERSONALITIES, DEFAULT_BOT_PERSONALITY } from '../shared/bot-personality.js';
import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import { VEHICLE_RULES, vehicleDirection, vehicleMuzzlePose } from '../shared/vehicles.js';
import { vehicleSeatOccupantId, vehicleSeats, vehicleWeaponSeatId } from '../shared/vehicle-seats.js';
import { VEHICLE_WEAPON_META, seatWeaponList, vehicleMountOrder } from '../shared/conquest-contract.js';
import { ROCKET_RULES } from '../shared/rocket-rules.js';
import { raycastVoxels } from '../shared/raycast.js';
import { cancelCharge } from './sim/combat.js';
import { armorMultiplier as sharedArmorMultiplier, infantryDamageClass } from '../shared/vehicle-armor.js';
import { VEHICLE_DEFS, LOCK_RULES } from '../shared/vehicle-defs.js';

const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const HALF_FOV = 55 * Math.PI / 180;
const TRACK_FOV = 65 * Math.PI / 180;
const HALF_VERTICAL_FOV = 50 * Math.PI / 180;
const RANGED_PRIORITY = ['rocket', 'lance', 'sniper', 'lmg', 'rifle', 'minigun', 'revolver', 'smg', 'shotgun'];
/** The STINGER only answers airborne aircraft inside its lock range (it cannot fire unlocked). */
export const STINGER_ENGAGE_RANGE = LOCK_RULES.stinger.range * 0.92;
const stingerTarget = (target, distance) => target?.armor === 'air' && target.vehicle?.grounded !== true
  && distance <= STINGER_ENGAGE_RANGE;
const sightOrigin = p => [p.eyeX ?? p.x, p.eyeY, p.eyeZ ?? p.z];
const delta = (a, b) => b.map((n, i) => n - a[i]);
const clearRay = (solidAt, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return !raycastVoxels(solidAt, a[0], a[1], a[2], dx, dy, dz, Math.hypot(dx, dy, dz));
};

/** Tank 360 degree check radius and the wider check of open gunner seats. */
export const TANK_OMNI_RANGE = 40;
export const GUNNER_OMNI_RANGE = 30;
/** A hull this effective or less is a danger to avoid, not a target to shoot. */
export const MIN_ARMOR_EFFECT = 0.15;
const HULL_THREAT = Object.freeze({ tank: 2.2, helicopter: 1.9, transport: 1.25, jeep: 1.4, plane: 0.9 });
const ARMOR_BY_TYPE = Object.freeze({ jeep: 'light', tank: 'heavy', helicopter: 'air', transport: 'air', plane: 'air' });

/** Armour class of a hull type from the shared registry (spec 5.1). */
export function vehicleArmorClass(type) {
  return VEHICLE_DEFS[type]?.armor ?? ARMOR_BY_TYPE[type] ?? 'light';
}

/** Damage multiplier of a damage class against an armour class (1 = full), from
 * the authoritative matrix in shared/vehicle-armor.js. Heavy armour is judged
 * on the side plate: bots flank, and the front plate is the worst case. */
export function armorMultiplier(cls, armor, zone = 'side') {
  return sharedArmorMultiplier(cls, armor, zone);
}

/** The damage class a held infantry weapon delivers to hulls. */
export function weaponDamageClass(id) {
  const def = WEAPONS[id];
  if (!def) return 'small';
  return infantryDamageClass({ ...def, id });
}

export const vehicleHullRules = type => VEHICLE_RULES[type] ?? VEHICLE_RULES.helicopter;

/** Live occupants of a hull, by seat. */
export function hullCrew(game, v) {
  const crew = [];
  // vehicleOccupiedSeats without its per-seat copies (this runs per bot and hull every tick).
  for (const seat of vehicleSeats(v)) {
    const occupantId = vehicleSeatOccupantId(v, seat.id);
    if (occupantId == null) continue;
    const p = game.entities.get(occupantId);
    if (p?.state === 'alive' && p.vehicleId === v.id) crew.push(p);
  }
  if (!crew.length && v.occupantId != null) {
    const p = game.entities.get(v.occupantId);
    if (p?.state === 'alive' && p.vehicleId === v.id) crew.push(p);
  }
  return crew;
}

/** A seated body is a target only where the damage model says it is exposed. */
export function seatedExposed(game, p) {
  if (!p?.vehicleId) return true;
  const shielded = game.vehicles?.occupantShielded;
  return typeof shielded === 'function' ? shielded.call(game.vehicles, p) === false : false;
}

/** Hull observation uses actual vehicle volume; seated bodies are never targets here. */
export function observeBotVehicle(observer, vehicle, solidAt, smoke, now, tracking = false, difficulty, options = null) {
  const def = vehicleHullRules(vehicle.type);
  if (!def || !(vehicle.hp > 0)) return null;
  const profile = botDifficulty(difficulty), origin = sightOrigin(observer);
  const center = [vehicle.x, vehicle.y + def.height * 0.5, vehicle.z];
  const [dx, dy, dz] = delta(origin, center), flat = Math.hypot(dx, dz), distance = Math.hypot(dx, dy, dz);
  if (distance > (options?.sightRange ?? profile.sightRange) + (tracking ? 12 : 0)) return null;
  const halfFov = tracking ? TRACK_FOV : HALF_FOV;
  const rawOffAxis = Math.abs(wrap(Math.atan2(-dx, -dz) - observer.yaw));
  const omni = distance <= (options?.omniRange ?? 0);
  if (flat > 0.01 && rawOffAxis > halfFov && !omni) return null;
  const offAxis = Math.min(rawOffAxis, halfFov);
  const r = def.radius * 0.65;
  const samples = [center, [center[0] - r, center[1], center[2]], [center[0] + r, center[1], center[2]],
    [center[0], vehicle.y + def.height * 0.8, center[2]], [center[0], vehicle.y + def.height * 0.25, center[2]]];
  let exposure = 0, aimPoint = null;
  for (const point of samples) {
    const [x, y, z] = delta(origin, point);
    if ((!omni && Math.abs(Math.atan2(y, Math.hypot(x, z)) - observer.pitch) > HALF_VERTICAL_FOV)
        || smoke?.blocksSight(origin, point, now) || !clearRay(solidAt, origin, point)) continue;
    exposure += 0.2;
    aimPoint ||= point;
  }
  if (!aimPoint) return null;
  const visibleArea = 2 * def.radius * def.height * exposure;
  const angularArea = visibleArea / Math.max(4, distance * distance);
  const detectionRate = Math.max(0.08, Math.min(5, 4 * Math.sqrt(angularArea / 0.001)))
    * (1 - 0.55 * (offAxis / halfFov) ** 2) * profile.recognition;
  return { aimPoint, exposure, distance, visibleArea, angularArea, detectionRate,
    reactionMs: profile.reactionMs, recognitionMs: profile.reactionMs + 1000 / detectionRate };
}

export function hullTarget(vehicle, occupant) {
  const def = vehicleHullRules(vehicle.type), direction = vehicleDirection(vehicle.yaw);
  const aircraft = vehicle.type === 'helicopter' || vehicle.type === 'plane' || vehicle.type === 'transport';
  return { id: `vehicle:${vehicle.id}`, kind: 'hull', vehicleId: vehicle.id, vehicle, type: vehicle.type,
    armor: vehicleArmorClass(vehicle.type), x: vehicle.x, y: vehicle.y, z: vehicle.z, eyeY: vehicle.y + def.height * 0.5,
    vx: aircraft && Number.isFinite(vehicle.vx) ? vehicle.vx : direction[0] * (vehicle.speed || 0),
    vy: aircraft && Number.isFinite(vehicle.vy) ? vehicle.vy : 0,
    vz: aircraft && Number.isFinite(vehicle.vz) ? vehicle.vz : direction[2] * (vehicle.speed || 0),
    state: 'alive', team: vehicle.team, lives: occupant.lives, occupantId: occupant.id };
}

const teamOf = (game, p) => game.mode.teamFor?.(p) ?? p.team;

/** Hostile, occupied, damageable hulls (the occupant decides hostility). */
function hostileHulls(game, p, ignoreId = null) {
  const out = [];
  for (const v of game.vehicles?.vehicles.values() ?? []) {
    if (!(v.hp > 0) || v.id === ignoreId || v.id === p.vehicleId) continue;
    if (v.team != null && teamOf(game, p) === v.team) continue;
    const crew = hullCrew(game, v).filter(o => game.mode.isEnemy(p, o));
    if (!crew.length || game.mode.canDamage?.(p, v) === false) continue;
    out.push({ v, occupant: crew[0] });
  }
  return out;
}

/**
 * Unified threat picker. `effectFor(target)` returns how well the shooter can
 * hurt the target (0..1); hulls below MIN_ARMOR_EFFECT are reported in
 * `danger` instead of being engaged. A held target only needs to pass the
 * sight checks again; a full sweep runs when `scan` is true. `exclude(id)`
 * skips targets the caller cannot engage right now (a mount's blacklist), so
 * the next-best visible target is returned instead.
 */
export function pickBotThreat(game, p, br, {
  observer = p, effectFor = () => 1, omniRange = 0, sightRange, scan = true, now = game.now,
  ignoreVehicleId = null, includeInfantry = true, includeHulls = true, exclude = null, airSightRange = null,
} = {}) {
  const options = { omniRange, sightRange };
  // An AA-armed bot watches the sky farther out (airborne aircraft only).
  const airOptions = airSightRange ? { omniRange, sightRange: Math.max(airSightRange, sightRange ?? 0) } : options;
  const smoke = game.projectiles?.smoke;
  const heldId = br.enemyId;
  const shooterId = br.damageFrom && now - br.damageFrom.at < 3000 ? br.damageFrom.id : null;
  let best = null, danger = null;
  const consider = (target, sighting, kind) => {
    const eff = effectFor(target, sighting.distance);
    const base = kind === 'hull' ? HULL_THREAT[target.type] ?? 1.3 : kind === 'crew' ? 1.15 : 1;
    const shooting = shooterId && (shooterId === target.id || shooterId === target.occupantId) ? 2 : 1;
    const held = target.id === heldId ? 1.6 : 1;
    const raw = base * shooting / (1 + sighting.distance / 35);
    if (kind === 'hull' && eff < MIN_ARMOR_EFFECT) {
      if (!danger || raw > danger.score) danger = { target, sighting, kind, score: raw };
      return;
    }
    const score = raw * Math.max(eff, 0.05) * held;
    if (!best || score > best.score) best = { target, sighting, kind, eff, score };
  };
  const tracked = id => id === heldId && br.noticeProgress >= 1;
  const sweepAll = scan;
  if (includeInfantry) {
    for (const o of game.entities.values()) {
      if (o === p || o.state !== 'alive' || !game.mode.isEnemy(p, o)) continue;
      if ((!sweepAll && o.id !== heldId) || exclude?.(o.id)) continue;
      const seated = !!o.vehicleId;
      if (seated && !seatedExposed(game, o)) continue;
      if (game.mode.canDamage?.(p, o) === false) continue;
      const sighting = observeBotTarget(observer, o, game.solidAt, smoke, now, tracked(o.id), br.difficulty, options);
      if (sighting) consider(o, sighting, seated ? 'crew' : 'infantry');
    }
  }
  if (includeHulls) {
    for (const { v, occupant } of hostileHulls(game, p, ignoreVehicleId)) {
      const id = `vehicle:${v.id}`;
      if ((!sweepAll && id !== heldId) || exclude?.(id)) continue;
      const air = airOptions !== options && !v.grounded && (v.type === 'helicopter' || v.type === 'transport' || v.type === 'plane');
      const sighting = observeBotVehicle(observer, v, game.solidAt, smoke, now, tracked(id), br.difficulty, air ? airOptions : options);
      if (sighting) consider(hullTarget(v, occupant), sighting, 'hull');
    }
  }
  return best ? { ...best, danger } : danger ? { target: null, sighting: null, kind: null, eff: 0, score: 0, danger } : null;
}

/** Legacy-shaped helper kept for aircraft and tests: the most relevant visible hostile hull. */
export function pickConquestVehicleTarget(game, p, br, { tank = null, sightRange, omniRange = 0 } = {}) {
  if (game.mode.mode !== 'conquest' || p.state !== 'alive') return null;
  const state = br.vehicleCombat;
  const observer = tank ? { x: tank.x, z: tank.z, eyeY: tank.y + vehicleHullRules(tank.type).gunPivotHeight,
    yaw: tank.turretYaw, pitch: tank.turretPitch } : p;
  let best = null;
  for (const { v, occupant } of hostileHulls(game, p)) {
    if (v.occupantId == null) continue;
    const target = hullTarget(v, occupant);
    const held = state?.id === target.id && state.progress >= 1;
    const sighting = observeBotVehicle(observer, v, game.solidAt, game.projectiles.smoke, game.now, held, br.difficulty, { sightRange, omniRange });
    if (!sighting) continue;
    if (held) return { target, sighting };
    if (!best || sighting.distance < best.sighting.distance) best = { target, sighting };
  }
  return best;
}

/** Owned, loaded direct guns are preferable to an empty launcher or melee. */
export function vehicleCombatWeapon(p, ownedSlots, distance) {
  const allowed = new Set(ownedSlots.filter(slot => !Array.isArray(p.owned) || p.owned.includes(WEAPON_IDS[slot])));
  const practical = slot => {
    const id = WEAPON_IDS[slot], def = WEAPONS[id];
    return def && def.mode !== 'melee' && (!def.projectile || def.projectile === 'rocket')
      && id !== 'flamethrower' && (def.projectile !== 'rocket' || (distance >= 10 && distance < 145));
  };
  const priority = RANGED_PRIORITY.map(id => WEAPON_IDS.indexOf(id)).filter(slot => allowed.has(slot) && practical(slot));
  return priority.find(slot => p.mag[slot] > 0) ?? priority.find(slot => p.reserve[slot] > 0) ?? null;
}

/**
 * Weapons an infantry bot can bring to bear at this range: [{slot, cls}].
 * `target` (a hull target, or just its armour class) gates the STINGER to
 * airborne aircraft in lock range.
 */
function usableSlots(p, ownedSlots, distance, target = null) {
  const out = [];
  for (const slot of ownedSlots) {
    const id = WEAPON_IDS[slot], def = WEAPONS[id];
    if (!def || def.mode === 'melee' || id === 'flamethrower') continue;
    if (Array.isArray(p.owned) && !p.owned.includes(id)) continue;
    if (!(p.mag[slot] > 0 || p.reserve[slot] > 0)) continue;
    if (def.projectile === 'rocket' && (distance < 10 || distance > 145)) continue;
    if (def.projectile === 'stinger' && !stingerTarget(target, distance)) continue;
    if (def.projectile && def.projectile !== 'rocket' && def.projectile !== 'mgl' && def.projectile !== 'stinger') continue;
    out.push({ slot, id, cls: weaponDamageClass(id), loaded: p.mag[slot] > 0 });
  }
  return out;
}

/** Best armour effect any owned weapon has against a hull target (or an armour class) at this range. */
export function infantryArmorEffect(p, ownedSlots, armorOrTarget, distance) {
  const target = typeof armorOrTarget === 'object' && armorOrTarget ? armorOrTarget : { armor: armorOrTarget };
  let best = 0;
  for (const { cls } of usableSlots(p, ownedSlots, distance, target)) best = Math.max(best, armorMultiplier(cls, target.armor));
  return best;
}

/** Slot to fight `target` with: the most armour-effective loaded weapon for hulls. */
export function bestWeaponFor(p, ownedSlots, target, distance) {
  if (target?.kind !== 'hull') return null;
  let best = null;
  for (const option of usableSlots(p, ownedSlots, distance, target)) {
    const eff = armorMultiplier(option.cls, target.armor) * (option.loaded ? 1 : 0.85)
      * (option.slot === p.weapon ? 1.05 : 1);
    if (!best || eff > best.eff) best = { ...option, eff };
  }
  return best && best.eff >= MIN_ARMOR_EFFECT ? best.slot : null;
}

/** Flight time of a constant-speed projectile to a moving target. */
export function interceptTime(origin, point, target, speed = ROCKET_RULES.speed, maxSeconds = ROCKET_RULES.lifetimeMs / 1000) {
  const r = delta(origin, point), v = [target.vx || 0, target.vy || 0, target.vz || 0];
  const a = v.reduce((sum, n) => sum + n * n, 0) - speed ** 2;
  const b = 2 * r.reduce((sum, n, i) => sum + n * v[i], 0), c = r.reduce((sum, n) => sum + n * n, 0);
  const discriminant = b * b - 4 * a * c;
  if (Math.abs(a) < 1e-8 || discriminant < 0) return Math.sqrt(c) / speed;
  const times = [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)].filter(t => t > 0);
  return Math.min(maxSeconds, ...times);
}

/** Lead and drop compensated aim for a projectile weapon. */
export function ballisticAim(origin, aimPoint, target, { speed, gravity = 0, maxSeconds = 6, leadSkill = 1 }) {
  const flightTime = speed > 0 ? interceptTime(origin, aimPoint, target, speed, maxSeconds) : 0;
  const point = aimPoint.map((n, i) => n + (i === 0 ? target.vx || 0 : i === 1 ? target.vy || 0 : target.vz || 0) * flightTime * leadSkill);
  const flat = Math.hypot(point[0] - origin[0], point[2] - origin[2]);
  const yaw = Math.atan2(-(point[0] - origin[0]), -(point[2] - origin[2]));
  const pitch = Math.atan2(point[1] - origin[1] + gravity * flightTime ** 2 * 0.5, flat);
  return { yaw, pitch, point, flightTime, flat, distance: Math.hypot(...delta(origin, point)) };
}

function rayBox(origin, dir, lo, hi, max) {
  let near = 0, far = max;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-9) { if (origin[i] < lo[i] || origin[i] > hi[i]) return null; }
    else { const a = (lo[i] - origin[i]) / dir[i], b = (hi[i] - origin[i]) / dir[i]; near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b)); }
  }
  return near <= far ? near : null;
}

/** Friendly bodies and other hulls between shooter and target hold the trigger. */
export function blockedByOtherEntity(game, p, target, origin, dir, distance) {
  const ownHull = p.vehicleId;
  for (const v of game.vehicles?.vehicles.values() ?? []) {
    if (v.id === ownHull || v.id === target.vehicleId || v.hp <= 0) continue;
    const def = vehicleHullRules(v.type), r = def.radius;
    if (rayBox(origin, dir, [v.x - r, v.y, v.z - r], [v.x + r, v.y + def.height, v.z + r], distance) !== null) return true;
  }
  for (const o of game.entities.values()) {
    if (o === p || o.state !== 'alive' || o.id === target.id || game.mode.isEnemy(p, o)) continue;
    if (ownHull && o.vehicleId === ownHull) continue;
    if (rayBox(origin, dir, [o.x - 0.45, o.y, o.z - 0.45], [o.x + 0.45, o.eyeY + 0.2, o.z + 0.45], distance) !== null) return true;
  }
  return false;
}

/**
 * The boxes blockedByOtherEntity tests, limited to those overlapping a region
 * [lo, hi]: a segment inside the region can only meet those, so an arc checks
 * its segments against a short list instead of every hull and body.
 */
function blockerBoxesWithin(game, p, target, lo, hi) {
  const ownHull = p.vehicleId, boxes = [];
  const overlaps = (a, b) => a[0] <= hi[0] && b[0] >= lo[0] && a[1] <= hi[1] && b[1] >= lo[1] && a[2] <= hi[2] && b[2] >= lo[2];
  for (const v of game.vehicles?.vehicles.values() ?? []) {
    if (v.id === ownHull || v.id === target.vehicleId || v.hp <= 0) continue;
    const def = vehicleHullRules(v.type), r = def.radius;
    const a = [v.x - r, v.y, v.z - r], b = [v.x + r, v.y + def.height, v.z + r];
    if (overlaps(a, b)) boxes.push(a, b);
  }
  for (const o of game.entities.values()) {
    if (o === p || o.state !== 'alive' || o.id === target.id || game.mode.isEnemy(p, o)) continue;
    if (ownHull && o.vehicleId === ownHull) continue;
    const a = [o.x - 0.45, o.y, o.z - 0.45], b = [o.x + 0.45, o.eyeY + 0.2, o.z + 0.45];
    if (overlaps(a, b)) boxes.push(a, b);
  }
  return boxes;
}

/** Sample the projectile's gravity arc so an arc never authorizes wall fire. */
export function clearFlight(game, p, target, origin, dir, distance, { speed = ROCKET_RULES.speed, gravity = ROCKET_RULES.gravity, explosive = true } = {}) {
  if (!explosive || !(speed > 0)) return !raycastVoxels(game.solidAt, ...origin, ...dir, distance)
    && !game.projectiles?.smoke?.blocksSight(origin, origin.map((n, i) => n + dir[i] * distance), game.now)
    && !blockedByOtherEntity(game, p, target, origin, dir, distance);
  const seconds = distance / speed;
  // Every sampled segment lies inside the arc's bounding box (x and z are
  // linear in t, y peaks at the apex): only boxes overlapping it can block.
  const at = t => origin.map((n, i) => n + dir[i] * speed * t - (i === 1 ? gravity * t * t * 0.5 : 0));
  const apex = gravity > 0 ? dir[1] * speed / gravity : -1;
  const ends = [origin, at(seconds), ...(apex > 0 && apex < seconds ? [at(apex)] : [])];
  const lo = [0, 1, 2].map(i => Math.min(...ends.map(e => e[i])) - 1), hi = [0, 1, 2].map(i => Math.max(...ends.map(e => e[i])) + 1);
  const blockers = blockerBoxesWithin(game, p, target, lo, hi);
  let previous = origin;
  for (let t = Math.min(0.035, seconds); t <= seconds + 1e-8; t = Math.min(seconds, t + 0.035)) {
    const point = origin.map((n, i) => n + dir[i] * speed * t - (i === 1 ? gravity * t * t * 0.5 : 0));
    const d = delta(previous, point), length = Math.hypot(...d);
    if (!clearRay(game.solidAt, previous, point) || game.projectiles.smoke?.blocksSight(previous, point, game.now)) return false;
    if (blockers.length) {
      const unit = d.map(n => n / (length || 1));
      for (let i = 0; i < blockers.length; i += 2) if (rayBox(previous, unit, blockers[i], blockers[i + 1], length) !== null) return false;
    }
    previous = point;
    if (t === seconds) break;
  }
  return true;
}

// ----------------------------------------------------------------------------
// Mounted gunnery
// ----------------------------------------------------------------------------

/** True once VehicleSystem runs the per-seat mount model (WP2). */
export const mountSystem = game => typeof game.vehicles?.mountPose === 'function';

/** Weapons this seat operates: contract topology under the mount model, else the legacy weapon seat. */
export function seatWeapons(game, v, seatId) {
  if (mountSystem(game)) return seatWeaponList(v.type, seatId);
  if (vehicleWeaponSeatId(v) !== seatId) return [];
  if (v.type === 'tank') return [{ mount: 'main', weapon: 'tank' }];
  return [];
}

function readMount(v, seatId, mountId, index) {
  const key = `${seatId}:${mountId}`;
  const store = v.mountState ?? v.mountStates ?? v.mounts;
  const entry = Array.isArray(store) ? (store.find?.(m => m && !Array.isArray(m) && (m.id === key || m.key === key)) ?? store[index])
    : store?.[key] ?? store?.[mountId];
  if (!entry) return null;
  if (Array.isArray(entry)) return { heat: (entry[3] ?? 0) / 100, overheated: (entry[3] ?? 0) >= 100, ammo: entry[2] };
  return { heat: entry.heat ?? 0, overheated: !!entry.overheated, ammo: entry.ammo, cooldown: entry.cooldown ?? 0, reloadT: entry.reloadT ?? 0 };
}

/** How suitable a mounted weapon is against a target at a range (0..1). */
function mountedSuitability(meta, target, distance) {
  if (!meta) return 0;
  const eff = target.kind === 'hull' ? armorMultiplier(meta.cls, target.armor) : 1;
  let range = 1;
  if (meta.kind === 'hitscan') range = distance <= (meta.cls === 'autocannon' ? 350 : 140) ? 1 : 0;
  else if (meta.kind === 'missile') range = target.kind === 'hull' && target.armor === 'air' ? 1 : 0;
  else if (meta.speed > 0) range = distance <= meta.speed * 2.2 ? 1 : 0.3;
  // Versus soft targets the machine guns are the right tool up close; the
  // main gun's splash keeps value at range and against groups.
  if (target.kind !== 'hull') {
    if (meta.kind === 'hitscan') range *= distance <= 90 ? 1.25 : 0.8;
    else if (meta.cls === 'at') range *= 0.55;
  }
  return eff * range;
}

function mountedObserver(game, v, seatId, mountId, p) {
  const pose = game.vehicles.mountPose(v, seatId, mountId);
  if (!pose?.origin || !pose.dir) return { pose: null, observer: p };
  const [dx, dy, dz] = pose.dir;
  return { pose, observer: { x: pose.origin[0], eyeY: pose.origin[1], z: pose.origin[2],
    yaw: Math.atan2(-dx, -dz), pitch: Math.asin(Math.max(-1, Math.min(1, dy))) } };
}

/**
 * Drive one occupied weapon seat: pick the threat, select the mount weapon
 * that hurts it, lead and drop-compensate, and pull the trigger only when the
 * authoritative barrel actually points there. With no threat the guns slew
 * along the threat axis with a sweep. Returns the engagement or null.
 */
export function applyMountedCombat(game, br, p, v, seatId, now, dtS, inp, { threatAxis = null, aircraft = false, sightRange } = {}) {
  if (game.mode.mode !== 'conquest' || !mountSystem(game)) return null;
  const weapons = seatWeaponList(v.type, seatId);
  if (!weapons.length || !game.mode.canFire(p) || p.state !== 'alive') return null;
  let state = br.mounted;
  if (!state || state.vehicleId !== v.id || state.seatId !== seatId || state.lives !== p.lives) {
    state = br.mounted = { vehicleId: v.id, seatId, lives: p.lives, aim: new AimSteering(), targetId: null,
      progress: 0, evidence: 0, elapsed: 0, threshold: 1, burstEnd: 0, pauseUntil: 0, inBurst: false,
      selAt: 0, requestedSel: null, cooling: false, trackSince: 0, blacklist: new Map() };
  }
  const omniRange = v.type === 'tank' && seatId === 'driver' ? TANK_OMNI_RANGE : GUNNER_OMNI_RANGE;
  const primary = weapons[0].mount;
  const { observer } = mountedObserver(game, v, seatId, primary, p);
  const effectFor = target => target.kind === 'hull'
    ? Math.max(...weapons.map(w => armorMultiplier(VEHICLE_WEAPON_META[w.weapon]?.cls, target.armor))) : 1;
  const heldBr = { enemyId: state.targetId, noticeProgress: state.progress, difficulty: br.difficulty, damageFrom: br.damageFrom };
  // Targets the mount just failed to bring to bear are skipped inside the
  // picker, so the next-best visible threat is engaged meanwhile.
  const blacklisted = id => (state.blacklist.get(id) ?? 0) > now;
  const observed = pickBotThreat(game, p, heldBr, { observer, effectFor, omniRange, ignoreVehicleId: v.id,
    sightRange, scan: (br.index + (game.tickCounter ?? Math.floor(now / 50))) % 2 === 0 || !state.targetId, now,
    exclude: state.blacklist.size ? blacklisted : null });
  const profile = botDifficulty(br.difficulty);
  const pers = BOT_PERSONALITIES[br.personality] ?? BOT_PERSONALITIES[DEFAULT_BOT_PERSONALITY];
  if (!observed?.target) {
    state.targetId = null; state.progress = 0; state.evidence = 0; state.elapsed = 0; state.inBurst = false;
    inp.wantFire = false;
    const base = threatAxis ?? observer.yaw;
    const sweep = Math.sin(now / 1300 + br.index) * 0.7;
    inp.yaw = wrap(base + sweep);
    inp.pitch = aircraft ? -0.12 : 0.02;
    return { target: null, danger: observed?.danger ?? null };
  }
  const { target, sighting } = observed;
  if (state.targetId !== target.id) {
    state.targetId = target.id; state.progress = 0; state.evidence = 0; state.elapsed = 0;
    state.threshold = recognitionThreshold(br.rng()); state.trackSince = now; state.inBurst = false; state.lastError = Infinity;
  }
  const previous = state.elapsed;
  state.elapsed += dtS * 1000;
  const reaction = sighting.reactionMs * (br.reactionScale ?? pers.reaction);
  state.evidence += Math.max(0, Math.max(0, state.elapsed - reaction) - Math.max(0, previous - reaction)) / 1000 * sighting.detectionRate;
  state.progress = Math.min(1, state.evidence / Math.max(1e-9, state.threshold));

  // Weapon selection for this target.
  let choice = 0, bestScore = -1;
  weapons.forEach((w, index) => {
    const score = mountedSuitability(VEHICLE_WEAPON_META[w.weapon], target, sighting.distance) + (index === (v.sel?.[seatId] ?? state.requestedSel ?? 0) ? 0.02 : 0);
    if (score > bestScore) { bestScore = score; choice = index; }
  });
  const selected = Number.isInteger(v.sel?.[seatId]) ? v.sel[seatId] : (state.requestedSel ?? 0);
  if (choice !== selected && now >= state.selAt && !inp.vehicleAction) {
    inp.vehicleAction = { type: 'weapon', index: choice };
    state.selAt = now + 450; state.requestedSel = choice;
  }
  const active = weapons[Math.min(weapons.length - 1, Math.max(0, selected))];
  const meta = VEHICLE_WEAPON_META[active.weapon];
  const { pose } = mountedObserver(game, v, seatId, active.mount, p);
  const origin = pose?.origin ?? [observer.x, observer.eyeY, observer.z];
  const skill = br.skill ?? 0.5;
  const aim = ballisticAim(origin, sighting.aimPoint, target, { speed: meta?.speed ?? 0, gravity: meta?.gravity ?? 0,
    maxSeconds: 6, leadSkill: 0.8 + 0.2 * skill });
  const sigma = (0.9 - 0.6 * skill) * profile.aimError * pers.aimError * Math.PI / 180;
  const wander = state.aim.wander(dtS, sigma, 0.6, br.rng);
  inp.yaw = wrap(aim.yaw + wander.yaw);
  inp.pitch = Math.max(-1.4, Math.min(1.4, aim.pitch + wander.pitch));
  inp.wantFire = false;
  if (state.progress < 1 || bestScore <= 0.05) return { target, sighting, recognized: state.progress >= 1 };
  const dir = pose?.dir ?? vehicleDirection(inp.yaw, inp.pitch);
  const want = vehicleDirection(aim.yaw, aim.pitch);
  const error = Math.acos(Math.max(-1, Math.min(1, dir[0] * want[0] + dir[1] * want[1] + dir[2] * want[2])));
  const tolerance = Math.max(0.012, Math.min(0.06, 1.4 / Math.max(1, aim.distance)));
  // A slewing mount that keeps closing the error is still on its way round
  // (a tank turret needs ~3 s for 180 degrees); only a stalled one gives up.
  if (error < tolerance || error < (state.lastError ?? Infinity) - 0.01) state.trackSince = now;
  state.lastError = error;
  if (error > 0.35 && now - state.trackSince > 1500) {
    // The mount cannot reach this target (arc limit or blocked slew): drop it briefly.
    for (const [id, until] of state.blacklist) if (until <= now) state.blacklist.delete(id);
    state.blacklist.set(target.id, now + 2500); state.targetId = null; state.lastError = Infinity;
    return { target, sighting, recognized: true };
  }
  const mount = readMount(v, seatId, active.mount, vehicleMountOrder(v.type).indexOf(`${seatId}:${active.mount}`));
  if (mount?.overheated || (mount?.heat ?? 0) > 0.82) state.cooling = true;
  if (state.cooling && (mount?.heat ?? 0) < 0.3 && !mount?.overheated) state.cooling = false;
  const hitscan = meta?.kind === 'hitscan';
  const lineClear = clearFlight(game, p, target, origin, dir, aim.distance,
    { speed: meta?.speed ?? 0, gravity: meta?.gravity ?? 0, explosive: !hitscan });
  if (error >= tolerance || !lineClear || state.cooling) { state.inBurst = false; return { target, sighting, recognized: true }; }
  if (!hitscan) { inp.wantFire = true; return { target, sighting, recognized: true, fired: true }; }
  if (now >= state.pauseUntil) {
    if (!state.inBurst) { state.burstEnd = now + 900 + br.rng() * 900; state.inBurst = true; }
    if (now < state.burstEnd) inp.wantFire = true;
    else { state.inBurst = false; state.pauseUntil = now + 350 + profile.burstPauseMs; }
  }
  return { target, sighting, recognized: true, fired: inp.wantFire };
}

// ----------------------------------------------------------------------------
// Legacy single-gun tank (pre mount model): turret yaw/pitch is the gun.
// ----------------------------------------------------------------------------

function legacyTankTarget(game, p, br, tank) {
  const hull = pickConquestVehicleTarget(game, p, br, { tank, omniRange: TANK_OMNI_RANGE });
  if (hull) return hull;
  const observer = { x: tank.x, z: tank.z, eyeY: tank.y + VEHICLE_RULES.tank.gunPivotHeight,
    yaw: tank.turretYaw, pitch: tank.turretPitch };
  let best = null;
  for (const target of game.entities.values()) {
    if (target.state !== 'alive' || target.vehicleId || !game.mode.isEnemy(p, target)
        || game.mode.canDamage?.(p, target) === false) continue;
    const sighting = observeBotTarget(observer, target, game.solidAt, game.projectiles.smoke, game.now,
      br.vehicleCombat?.id === target.id && br.vehicleCombat.progress >= 1, br.difficulty, { omniRange: TANK_OMNI_RANGE });
    if (sighting && (!best || sighting.distance < best.sighting.distance)) best = { target, sighting };
  }
  return best;
}

/** Input-only adapter for a tank gun seat. Under the mount model it delegates
 * to applyMountedCombat; the legacy single gun keeps its RX-8 ballistics. With
 * no target the turret slews along `threatAxis` with a sweep. Infantry hull
 * engagement lives in the unified picker of the infantry brain. */
export function applyConquestVehicleCombat(game, br, p, now, dtS, inp, ownedSlots, { tank = null, threatAxis = null } = {}) {
  if (game.mode.mode !== 'conquest' || !tank) return null;
  if (mountSystem(game)) return applyMountedCombat(game, br, p, tank, p.vehicleSeatId ?? 'driver', now, dtS, inp, { threatAxis });
  const observed = game.mode.canFire(p) && p.state === 'alive' ? legacyTankTarget(game, p, br, tank) : null;
  if (!observed) {
    br.vehicleCombat = null;
    inp.wantFire = false;
    if (Number.isFinite(threatAxis)) { inp.yaw = wrap(threatAxis + Math.sin(now / 1300 + (br.index ?? 0)) * 0.7); inp.pitch = 0.02; }
    return null;
  }
  const { target, sighting } = observed;
  const profile = botDifficulty(br.difficulty), pers = BOT_PERSONALITIES[br.personality] ?? BOT_PERSONALITIES[DEFAULT_BOT_PERSONALITY];
  let state = br.vehicleCombat;
  if (!state || state.id !== target.id || state.lives !== target.lives || state.occupantId !== target.occupantId
      || state.observerLives !== p.lives || state.driverHull !== tank.id) {
    state = br.vehicleCombat = { id: target.id, lives: target.lives, occupantId: target.occupantId,
      observerLives: p.lives, driverHull: tank.id, elapsed: 0, evidence: 0, threshold: recognitionThreshold(br.rng()), progress: 0,
      aim: new AimSteering(), engagedMs: 0 };
  }
  inp.wantFire = false; inp.wantAds = false; inp.reload = false; inp.switchTo = undefined;
  const previous = state.elapsed;
  state.elapsed += dtS * 1000;
  const reaction = sighting.reactionMs * (br.reactionScale ?? pers.reaction);
  state.evidence += Math.max(0, Math.max(0, state.elapsed - reaction) - Math.max(0, previous - reaction)) / 1000 * sighting.detectionRate;
  state.progress = Math.min(1, state.evidence / Math.max(1e-9, state.threshold));
  if (state.progress < 1) return { target, sighting, recognized: false };
  state.engagedMs += dtS * 1000;
  const origin = vehicleMuzzlePose(tank).origin;
  const skill = br.skill ?? 0.5;
  const aim = ballisticAim(origin, sighting.aimPoint, target, { speed: ROCKET_RULES.speed, gravity: ROCKET_RULES.gravity,
    maxSeconds: ROCKET_RULES.lifetimeMs / 1000, leadSkill: 0.85 + 0.15 * skill });
  const pitchT = aim.pitch + Math.atan2(0.16, Math.max(1, aim.flat));
  const rules = VEHICLE_RULES.tank;
  const reachable = pitchT >= rules.turretMinPitch && pitchT <= rules.turretMaxPitch;
  const sigma = (1.1 - 0.7 * skill) * profile.aimError * pers.aimError * Math.PI / 180;
  const wander = state.aim.wander(dtS, sigma, 0.6, br.rng);
  inp.yaw = wrap(state.aim.steer('yaw', tank.turretYaw, wrap(aim.yaw + wander.yaw), profile.turnRate, dtS));
  inp.pitch = state.aim.steer('pitch', tank.turretPitch, pitchT + wander.pitch, Math.min(4, profile.turnRate), dtS);
  const aligned = Math.abs(wrap(tank.turretYaw - aim.yaw)) < 0.035 && Math.abs(tank.turretPitch - pitchT) < 0.035;
  const dir = vehicleDirection(tank.turretYaw, tank.turretPitch);
  const barrelClear = clearRay(game.solidAt, [tank.x, tank.y + rules.gunPivotHeight, tank.z], origin);
  const canShoot = reachable && aligned && barrelClear && aim.distance < 145
    && !game.projectiles.smoke.blocksSight(origin, aim.point, now) && clearFlight(game, p, target, origin, dir, aim.distance);
  if (canShoot) inp.wantFire = true;
  else if (p.charging) cancelCharge(p);
  return { target, sighting, recognized: true };
}

