/**
 * Titan abilities (docs/titanfall.md §5.5, WP3): data over primitives. Rows
 * come from TITAN_ABILITIES / TITAN_COMMON_ABILITIES (titan-contract.js);
 * ABILITY_TUNING holds the numbers the §5.5 table leaves open. Primitives:
 *
 *   shot        hitscan from the row anchor (Laser Shot, Power Shot) or a router
 *               projectile (Cluster Missile, titan-projectiles.js)
 *   frontGuard  'vortex' (catch ≤ maxCaught, throw back on release), 'thermal'
 *               (block + burn in front), 'gunShield' (hp block), 'block' (Sword
 *               Block: tfMove.damageTakenMul, front only through guardTitanDamage)
 *   deployable  tripwire (3 mines on a line), incendiary trap (thermite ignites
 *               it: MolotovFireSystem.ignite with a profile override), tether
 *               (root + damage), electric smoke (killRiders, pilots, locks)
 *   groundLine  firewall (burning path), arc wave (slow), flame core (fan of 3,
 *               per-target cap): segments advance along the ground
 *   dash        Phase Dash: a blink swept against voxels with placeWalker,
 *               shortened off hull overlaps, phased (immune, locks broken)
 *   hover       VTOL hover and Flight Core (tfMove.hoverVy; core adds rockets)
 *   toggle      Legion Mode Switch (the mount's weapon select)
 *   coreBuff    Laser Core beam, Sword Core, Smart Core
 *
 * plus titan melee (doomed-titan execution from the front) and the core meter
 * (`core += dealt / 4000 + dt / 180`, nothing while a core runs). Abilities
 * write only `v.tfMove` and `v.tfAbility` (of the user, and slow/root on a
 * target); stepTitanWalk (WP2) reads tfMove. The row bits WP5's
 * titan-ability-fx.js reads come from tfAbility.coreUntil (core),
 * activeUntil.defensive (defensive), tfMove.hoverVy (hover), tfMove.phasedUntil
 * (phased) and smokeUntil (smoke) through TitanSystem.rowExtras; mount field 6
 * (charge100) comes from titan-mounts.js. Activations also emit an additive
 * `titan_ability` event ({ vehicleId, ability, ... }) for presentation.
 *
 * Damage helpers (hurtHull, hurtPilot, titanRay, blastAt) are shared with
 * titan-mounts.js and titan-projectiles.js: they credit the core meter, and the
 * sphere guards intercept titan rays and projectiles in front of a hull
 * (guardRay). guardTitanDamage is the applyTitanDamage hook (titan-damage.js)
 * for every other source (pilot weapons) and makes Sword Block front-only.
 * Times are engine milliseconds.
 */
import { TITAN_ABILITIES, TITAN_ABILITY_SLOTS, TITAN_COMMON_ABILITIES, TITAN_WEAPON_META, isTitanType } from '../../../shared/titan-contract.js';
import { createTitanMove, titanFrame, placeWalker, TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';
import { vehicleDef, mountPose, vehicleLocalPoint, vehicleWorldToLocal, vehicleDirection, seatWeaponList } from '../../../shared/vehicle-defs.js';
import { armorMultiplier } from '../../../shared/vehicle-armor.js';
import { combatDamage } from '../../../shared/combat-balance.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { PHYSICS } from '../../../shared/player-movement.js';
import { fireMountedRay } from '../combat.js';
import { occupantShielded, occupantDamageScale } from '../vehicle-damage.js';
import { evHit, evVehicleShoot } from '../../protocol/events.js';
import { isPerceivable } from './perception.js';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

/** Numbers the §5.5 table leaves open (metres, seconds, damage as dealt to a titan unless noted). */
export const ABILITY_TUNING = deepFreeze({
  energy: { max: 1000, regen: 120, delay: 1 },                 // ION energy pool (Tripwire, Laser Shot, split shots)
  core: { damagePerCharge: 4000, passiveSeconds: 180 },
  pulse: 0.25,                                                 // pilot damage-over-time pulse
  vortex: { throwRays: 12, throwSpreadDeg: 3, infantryCap: 60, minHold: 0.3, range: 200 },
  thermal: { ahead: 3, radius: 3.6, halfWidth: 3.5, pilotDps: 120 },
  gunShield: { ahead: 1.4, radius: 2.0 },
  swordBlock: { frontDot: 0.2, unheldSeconds: 1.5 },
  tripwire: { ahead: 10, lifeMs: 30000, beamWidth: 1.2, pilotRadius: 2, blastRadius: 6, infantryDamage: 120, infantryRadius: 4 },
  incendiary: { ahead: 12, lifeMs: 45000, igniteRadius: 4, pilotDps: 40, maxCells: 64 },   // MOLOTOV_FIRE.maxCells: the snapshot cap
  tether: { ahead: 14, lifeMs: 30000, triggerRadius: 4, maxActive: 2, flashSeconds: 0.3 },
  flightCore: { speed: 80, splash: 2.5, infantryDamage: 50, spreadDeg: 1.5 },
  cluster: { speed: 70, gravity: 3, radius: 4, infantryDamage: 40, infantryRadius: 3.5, scatter: 2.5 },
  laserShot: { range: 300 },
  laserCore: { pulse: 0.1 },
  powerShot: { closeRays: 9, closeSpreadDeg: 4, closeRange: 80, closeInfantry: 60, longRange: 300, longPierce: 3, longInfantry: 150 },
  arcWave: { speed: 45, width: 1.8, infantryDamage: 100 },
  firewall: { speed: 30, width: 1.6 },
  flameCore: { speed: 30, width: 3, fan: 0.26, infantryDamage: 300, showSeconds: 1.5 },
  line: { sample: 1, rise: 2.2, fall: 4, height: 3 },
  phase: { step: 0.25 },
  smoke: { armSeconds: 0.5, lockEvery: 0.5 },
  melee: { coneDeg: 50, frontExecuteDot: 0.5 },
  swordCoreInfantry: 350,
  modeSwitchSeconds: 0.6,
});

/** `titanHold` input bits (§3.6). */
export const TITAN_HOLD_BITS = Object.freeze({ sprint: 1, defensive: 2, ads: 4, reload: 8, melee: 16, core: 32 });
const HOLD = TITAN_HOLD_BITS;
const SLOT_OF = Object.freeze({ def: 'defensive', tac: 'tactical', ord: 'ordnance', core: 'core' });
const GUARD_KIND = Object.freeze({ titan_ion: 'vortex', titan_scorch: 'thermal', titan_ronin: 'block', titan_legion: 'gunShield' });
const SPHERE_GUARDS = new Set(['vortex', 'thermal', 'gunShield']);
const GUARD_EXEMPT = new Set(['rodeo', 'collision', 'titanfall', 'fire']);
const CORE_KIND = Object.freeze({ titan_ion: 'laserCore', titan_scorch: 'flameCore', titan_northstar: 'flightCore',
  titan_ronin: 'swordCore', titan_legion: 'smartCore' });
/** Cores during which the primary cannot fire. */
const CORE_BLOCKS_PRIMARY = new Set(['laserCore', 'flightCore', 'swordCore']);

// ---- small helpers ------------------------------------------------------------------

const nowOf = titans => finite(titans?.now);
const rowOf = (v, slot) => TITAN_ABILITIES[v?.type]?.[slot] ?? null;
const add3 = (a, d, t) => [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const round2 = n => Math.round(n * 100) / 100;
/** World aim of the titan's primary mount (the pilot's aim, the auto-titan's target). */
export function titanAim(v) {
  const state = v?.mounts?.[0];
  return { yaw: finite(state?.yaw, finite(v?.yaw)), pitch: finite(state?.pitch) };
}
export function titanAimDir(v) { const aim = titanAim(v); return vehicleDirection(aim.yaw, aim.pitch); }
/**
 * Horizontal look of a titan for ground lines and placements: the pilot's crosshair yaw (the mount
 * converges on the crosshair from the right arm, so its yaw is skewed at short range), else the
 * mount's (the auto-titan's target).
 */
export function titanLookYaw(titans, v) {
  const yaw = pilotOf(titans, v)?.input?.yaw;
  return Number.isFinite(yaw) ? yaw : titanAim(v).yaw;
}
/**
 * Direction from `origin` (an ability anchor) to the point the primary is aimed
 * at: the mount's own aim ray from its muzzle to its first voxel, hull or pilot
 * (≤ `range`), so shots from the chest or shoulder converge on the gun's aim.
 */
export function anchorAim(titans, v, origin, range = 300) {
  const f = titanFrame(v), dir = titanAimDir(v), eye = primaryPose(v)?.origin ?? vehicleLocalPoint(v, 0, f.eye, -f.hl * 0.55);
  let reach = range;
  const voxel = raycastVoxels((x, y, z) => titans.vehicles.solid(x, y, z, true), ...eye, ...dir, range);
  if (voxel) reach = Math.min(reach, voxel.t);
  const hull = titans.vehicles.rayHit(eye, dir, reach, v.id);
  if (hull) reach = Math.min(reach, hull.distance);
  // Pilots on foot under the crosshair (an upright 0.45 m cylinder each).
  const flat = dir[0] * dir[0] + dir[2] * dir[2];
  if (flat > 1e-9) for (const body of titans.engine.entities.values()) {
    if (body.state !== 'alive' || body.vehicleId) continue;
    const t = ((body.x - eye[0]) * dir[0] + (body.z - eye[2]) * dir[2]) / flat;
    if (!(t > 0 && t < reach)) continue;
    const y = eye[1] + dir[1] * t;
    if (Math.hypot(eye[0] + dir[0] * t - body.x, eye[2] + dir[2] * t - body.z) <= 0.45 && y >= body.y && y <= body.y + PHYSICS.height) reach = t;
  }
  const point = add3(eye, dir, Math.max(4, reach)), d = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]], len = Math.hypot(...d);
  return len > 1e-6 ? d.map(n => n / len) : dir;
}
function anchorWorld(v, anchor) { return vehicleLocalPoint(v, anchor[0], anchor[1], anchor[2]); }
function primaryPose(v) {
  const seat = vehicleDef(v)?.seats?.[0], mountId = seat?.mounts?.[0];
  return seat && mountId ? mountPose(v, seat.id, mountId) : null;
}
function hullCenter(v) { return [v.x, v.y + titanFrame(v).height * 0.55, v.z]; }
function pilotOf(titans, v) { const p = titans.vehicles.seatOccupant(v, 'driver'); return p && p.state === 'alive' ? p : null; }
/** Whom a titan's ability damage is credited to: its pilot, else the owner (or the owner's stand-in). */
export function titanAttacker(titans, v) { return pilotOf(titans, v) ?? titans.attackerFor(v); }
function emitAbility(titans, v, ability, fields = {}) { titans.emit('titan_ability', { vehicleId: v.id, ability, ...fields }); }
function hostile(titans, attacker, body) {
  return !!attacker && !!body && String(attacker.id) !== String(body.id) && titans.vehicles.teamOf(attacker) !== titans.vehicles.teamOf(body);
}
function* enemyTitans(titans, team, except = null) {
  for (const t of titans.titans()) if (t !== except && t.hp > 0 && !t.dropping && t.team !== team) yield t;
}
function* enemyPilots(titans, attacker) {
  // combatants: attrition minions (engine.npcs, WP8) burn, zap and get cut too.
  for (const body of (titans.engine.combatants ?? titans.engine.entities).values()) if (body.state === 'alive' && !body.vehicleId && hostile(titans, attacker, body)) yield body;
}
function clearLine(titans, from, to) {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], len = Math.hypot(...d);
  return len < 0.05 || !raycastVoxels((x, y, z) => titans.vehicles.solid(x, y, z, true), ...from, d[0] / len, d[1] / len, d[2] / len, len - 0.05);
}
/**
 * Standing surface in the column (x, z) near height `y`: the first solid voxel
 * from `y + rise` down to `y - fall`, which must have air above it (a wall taller
 * than the rise blocks: null), as the y of its top face.
 */
export function surfaceNear(titans, x, z, y, rise, fall) {
  const solid = (yy) => titans.vehicles.solid(x, yy + 0.5, z);
  for (let by = Math.floor(y + rise); by >= Math.floor(y - fall); by--) {
    if (!solid(by)) continue;
    return solid(by + 1) || by + 1 > y + rise + 1e-6 ? null : by + 1;
  }
  return null;
}
/**
 * Ground point `ahead` metres along the aim from the hull (column probe around the feet), or null.
 * The point needs a clear voxel line from the hull's chest: behind a wall the placement walks
 * back along the aim in 1 m steps to the farthest clear spot (no deployables through walls).
 */
function groundAhead(titans, v, ahead, side = 0) {
  const yaw = titanLookYaw(titans, v), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const chest = [v.x, v.y + finite(titanFrame(v)?.height, 7) * 0.6, v.z];
  for (let d = ahead; d >= 1; d -= 1) {
    const x = v.x + fx * d + fz * -side, z = v.z + fz * d - fx * -side;
    const y = surfaceNear(titans, x, z, v.y, 3, 6);
    if (y != null && clearLine(titans, chest, [x, y + 0.5, z])) return [x, y, z];
  }
  return null;
}

// ---- damage, core credit -------------------------------------------------------------

/** Sum of the damage `id` has dealt to titans (their damageLog), for before/after credit. */
export function titanDamageMark(titans, id) {
  if (id == null || !titans) return 0;
  let sum = 0;
  for (const t of titans.titans()) sum += finite(t.damageLog?.get(String(id))?.dmg);
  return sum;
}
/** Hull damage through VehicleSystem.damage; returns what the attacker dealt (after armour, guards and shields). */
export function hurtHull(titans, attacker, target, amount, cls, { point = null, origin = null } = {}) {
  if (!target || !(target.hp > 0) || target.dropping || !(amount > 0)) return 0;
  const id = attacker?.id == null ? null : String(attacker.id);
  const before = id ? finite(target.damageLog?.get(id)?.dmg) : 0;
  titans.vehicles.damage(target.id, amount, attacker, { cls, point, origin });
  return id ? Math.max(0, finite(target.damageLog?.get(id)?.dmg) - before) : 0;
}
/** One enemy pilot hit (kill key `key`); returns the health damage dealt. */
export function hurtPilot(titans, attacker, body, amount, key, point = null) {
  const engine = titans.engine;
  if (!body || body.state !== 'alive' || !(amount > 0) || occupantShielded(body) || !hostile(titans, attacker, body)) return 0;
  if (finite(body.spawnProtectedUntil) > nowOf(titans) || engine.mode?.canDamage?.(attacker, body) === false) return 0;
  const damage = combatDamage(amount * occupantDamageScale(body));
  const lethal = body.takeDamage(damage, false, attacker, key);
  engine.tickEvents?.push(evHit(attacker.id, body.id, damage, false, point ?? [body.x, body.y + 0.9, body.z], body.lastDamage));
  const dealt = finite(body.lastDamage?.healthDamage);
  if (lethal) engine.killPlayer?.(body, attacker, key, false);
  return dealt;
}
/** Core meter credit for damage a titan dealt (nothing while its core runs). */
export function creditCore(titans, v, dealt) {
  const ab = v?.tfAbility;
  if (!ab || !(dealt > 0) || ab.coreUntil > nowOf(titans) || !(v.hp > 0)) return;
  ab.core = Math.min(1, finite(ab.core) + dealt / ABILITY_TUNING.core.damagePerCharge);
  coreReady(titans, v, ab);
}
function coreReady(titans, v, ab) {
  if (ab.core >= 1 && !ab.coreReadySent) { ab.coreReadySent = true; titans.emit('core_ready', { vehicleId: v.id }); }
}

/**
 * Blast at `point`: hulls through VehicleSystem.explosion (linear falloff from the
 * nearest hull part, voxel line of sight), enemy pilots with a falloff and a clear
 * line. Credits the core of `source` (a titan hull or null). Returns damage dealt.
 */
export function blastAt(titans, source, attacker, point, { radius, hull = 0, infantry = 0, infantryRadius = radius, key, cls = 'titan', ignoreId = null, ignoreBody = null }) {
  if (!attacker || !Array.isArray(point)) return 0;
  const id = String(attacker.id), mark = titanDamageMark(titans, id);
  if (hull > 0) titans.vehicles.explosion(point, radius, hull, attacker, { cls, ignoreId });
  let dealt = Math.max(0, titanDamageMark(titans, id) - mark);
  if (infantry > 0) {
    for (const body of enemyPilots(titans, attacker)) {
      const at = [body.x, body.y + 0.9, body.z], d = dist3(at, point);
      if (body === ignoreBody || d >= infantryRadius || !clearLine(titans, point, at)) continue;
      dealt += hurtPilot(titans, attacker, body, infantry * (1 - d / infantryRadius), key, at);
    }
  }
  if (source) creditCore(titans, source, dealt);
  return dealt;
}

// ---- guards (frontGuard) ------------------------------------------------------------

function activeGuard(v, now) { const g = v?.tfAbility?.guard; return g && g.until > now ? g : null; }
function guardFull(v, guard) { return guard.kind === 'vortex' && guard.weight >= (rowOf(v, 'defensive')?.maxCaught ?? 40); }
/** [cx, cy, cz, r] of a sphere guard in world space. */
export function guardSphere(v, guard) {
  const f = titanFrame(v), T = ABILITY_TUNING;
  if (guard.kind === 'vortex') {
    const row = rowOf(v, 'defensive'), cockpit = vehicleLocalPoint(v, 0, f.eye, -f.hl * 0.55);
    return [...add3(cockpit, titanAimDir(v), row.forward), row.radius];
  }
  if (guard.kind === 'thermal') return [...vehicleLocalPoint(v, 0, f.height * 0.45, -T.thermal.ahead), T.thermal.radius];
  if (guard.kind === 'gunShield') {
    const origin = primaryPose(v)?.origin ?? vehicleLocalPoint(v, 0, f.height * 0.6, -f.hl);
    return [...add3(origin, titanAimDir(v), T.gunShield.ahead), T.gunShield.radius];
  }
  return null;
}
/** Entry distance of a ray into a sphere (null when it misses, starts inside, or enters beyond maxT). */
function raySphere(o, d, s, maxT) {
  const ox = o[0] - s[0], oy = o[1] - s[1], oz = o[2] - s[2], c = ox * ox + oy * oy + oz * oz - s[3] * s[3];
  if (c <= 0) return null;
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  if (b >= 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= maxT ? t : null;
}
/**
 * Where a shot from `o` along unit `d` meets the guard sphere `s` of hull `v` (≤ maxT), or null.
 * A shot that starts inside the sphere (a muzzle at point-blank range) meets it at once when it
 * heads toward the guarded hull; one heading away from the hull passes.
 */
export function guardEntry(v, o, d, s, maxT) {
  const inside = (o[0] - s[0]) ** 2 + (o[1] - s[1]) ** 2 + (o[2] - s[2]) ** 2 <= s[3] * s[3];
  if (!inside) return raySphere(o, d, s, maxT);
  const c = hullCenter(v);
  return d[0] * (c[0] - o[0]) + d[1] * (c[1] - o[1]) + d[2] * (c[2] - o[2]) > 0 ? 0 : null;
}
/** Nearest enemy sphere guard (vortex, thermal shield, gun shield) a ray of `team` meets within maxT: { t, v, guard } or null. */
export function guardRay(titans, team, origin, dir, maxT, ignoreId = null) {
  if (!titans) return null;
  const now = nowOf(titans);
  let best = null;
  for (const t of titans.titans()) {
    if (t.id === ignoreId || !(t.hp > 0) || t.dropping || t.team === team) continue;
    const guard = activeGuard(t, now);
    if (!guard || !SPHERE_GUARDS.has(guard.kind) || guardFull(t, guard)) continue;
    const sphere = guardSphere(t, guard), hit = sphere ? guardEntry(t, origin, dir, sphere, best ? best.t : maxT) : null;
    if (hit !== null) best = { t: hit, v: t, guard };
  }
  return best;
}
/**
 * A shot meets a guard with `titanSide` damage (what it would deal a titan's front).
 * Vortex: caught (until maxCaught weight); thermal: blocked; gun shield: absorbed by
 * its hp (the last hit is absorbed whole). True when the shot is stopped.
 */
export function catchGuard(titans, v, guard, titanSide, weight = 1) {
  if (!guard || !(titanSide > 0)) return false;
  if (guard.kind === 'vortex') {
    if (guardFull(v, guard)) return false;
    guard.weight += weight;
    guard.caught.push(titanSide);
    return true;
  }
  if (guard.kind === 'thermal') return true;
  if (guard.kind === 'gunShield') {
    guard.hp -= titanSide;
    if (guard.hp <= 0) guard.until = nowOf(titans);
    return true;
  }
  return false;
}
function eyeOf(body) { return body && [body.x, body.y, body.z].every(Number.isFinite) ? [body.x, body.y + 1.6, body.z] : null; }
function titanSource(titans, by) {
  return by?.standIn === true || (!!by?.vehicleId && isTitanType(titans.vehicles.vehicles.get(by.vehicleId)?.type));
}
function fromFront(v, point) {
  if (!Array.isArray(point)) return false;
  const [lx, , lz] = vehicleWorldToLocal(v, point), len = Math.hypot(lx, lz);
  return len > 1e-6 && -lz / len > ABILITY_TUNING.swordBlock.frontDot;
}

/**
 * applyTitanDamage hook (titan-damage.js, before armour): returns the raw amount
 * that reaches the hull. Sword Block: tfMove.damageTakenMul reduces every hit, so
 * hits not from the front get the reduction back. Sphere guards stop pilot and
 * other non-titan shots whose path (shooter eye or blast centre → impact) crosses
 * them; titan weapons were already checked on their path (guardRay).
 */
export function guardTitanDamage(titans, v, amount, cls, by, hit = {}) {
  const ab = v?.tfAbility;
  if (!ab || !(amount > 0)) return amount;
  const guard = activeGuard(v, nowOf(titans));
  const blast = Array.isArray(hit?.origin), from = blast ? hit.origin : eyeOf(by);
  // Sword Block: undo exactly the block factor tfMove.damageTakenMul carries (ab.blockMul, synced
  // when the block goes up or down), then apply it again only for a front hit. A block that timed
  // out between ticks (the stale factor is still in tfMove) is undone for every direction.
  const baked = finite(ab.blockMul, 1) > 0 ? finite(ab.blockMul, 1) : 1;
  const want = guard?.kind === 'block' && fromFront(v, from ?? hit?.point) ? rowOf(v, 'defensive').damageTakenMul : 1;
  if (want !== baked) amount = amount * want / baked;
  if (!guard || guard.kind === 'block') return amount;
  if (GUARD_EXEMPT.has(cls) || !SPHERE_GUARDS.has(guard.kind) || titanSource(titans, by) || guardFull(v, guard) || !from) return amount;
  const sphere = guardSphere(v, guard);
  if (!sphere) return amount;
  const to = Array.isArray(hit?.point) ? hit.point : hullCenter(v);
  let crosses;
  if (blast && dist3(from, sphere) <= sphere[3]) crosses = true;   // a blast centre on the guard
  else {
    // A shooter inside the sphere is caught too when the shot heads into the hull (guardEntry, as for titan rays).
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], len = Math.hypot(...d);
    crosses = len > 1e-6 && guardEntry(v, from, d.map(n => n / len), sphere, len) !== null;
  }
  if (!crosses) return amount;
  const weight = cls === 'at' || cls === 'explosive' ? finite(rowOf(v, 'defensive')?.rocketWeight, 1) : 1;
  return catchGuard(titans, v, guard, amount * armorMultiplier(cls, 'titan', 'front'), weight) ? 0 : amount;
}

// ---- hitscan -------------------------------------------------------------------------

/**
 * A titan hitscan (mount weapon or ability): enemy sphere guards first, then
 * fireMountedRay (voxels, hulls, pilots; `weapon.infantryDamage` for pilots).
 * `pierce` > 1 carries on past each hull or body hit. Credits the core of `v`.
 * Returns { result (first segment: end, hit, victimId, vehicleId), dealt, guarded }.
 */
export function titanRay(titans, v, attacker, origin, dir, weapon, { pierce = 1 } = {}) {
  const ctx = titans.vehicles.combatContext(), id = attacker?.id == null ? null : String(attacker.id);
  const team = v?.team ?? titans.vehicles.teamOf(attacker);
  let from = origin, left = finite(weapon.range, 300), ignore = v?.id ?? null, first = null, dealt = 0, guarded = null;
  for (let n = 0; n < Math.max(1, pierce) && left > 0.3; n++) {
    const guard = guardRay(titans, team, from, dir, left, v?.id ?? null);
    const reach = guard ? guard.t : left;
    const mark = titanDamageMark(titans, id);
    const result = fireMountedRay(attacker, from, dir, reach === weapon.range ? weapon : { ...weapon, range: reach }, ctx, { vehicleId: ignore });
    if (result.victimId != null) dealt += finite(titans.engine.entities.get(result.victimId)?.lastDamage?.healthDamage);
    dealt += Math.max(0, titanDamageMark(titans, id) - mark);
    first ??= result;
    if (result.victimId == null && result.vehicleId == null) {
      if (guard && !result.hit) {
        const end = add3(from, dir, guard.t);
        result.end = end;
        if (catchGuard(titans, guard.v, guard.guard, weapon.damage * armorMultiplier(weapon.cls ?? 'titan', 'titan', 'front'))) guarded = guard.v.id;
      }
      break;
    }
    const travelled = dist3(from, result.end), skip = result.vehicleId != null ? 0.05 : 0.6;
    left -= travelled + skip;
    from = add3(result.end, dir, skip);
    if (result.vehicleId != null) ignore = result.vehicleId;
  }
  creditCore(titans, v, dealt);
  return { result: first ?? { end: add3(origin, dir, left) }, dealt, guarded };
}

// ---- primary gating (titan-mounts.js) ------------------------------------------------

/** True while an ability holds the primary: vortex or sword block up, laser/flight/sword core, phased. */
export function primaryBlocked(v, now) {
  const ab = v?.tfAbility;
  if (!ab) return false;
  const guard = activeGuard(v, now);
  if (guard && (guard.kind === 'vortex' || guard.kind === 'block')) return true;
  if (ab.coreUntil > now && CORE_BLOCKS_PRIMARY.has(ab.coreKind)) return true;
  return finite(v.tfMove?.phasedUntil) > now;
}
export function smartCoreActive(v, now) { return v?.tfAbility?.coreKind === 'smartCore' && v.tfAbility.coreUntil > now; }
/** Primary damage multiplier from buffs (Smart Core). */
export function primaryDamageMul(v, now) { return smartCoreActive(v, now) ? rowOf(v, 'core').damageMul : 1; }
/** ION energy (0..max) and spending (tripwire, laser shot, split shots). */
export function titanEnergy(v) { return finite(v?.tfAbility?.energy); }
export function spendEnergy(titans, v, amount) {
  const ab = v?.tfAbility;
  if (!ab || !(finite(ab.energy) >= amount)) return false;
  ab.energy -= amount;
  ab.energyAt = nowOf(titans);
  return true;
}
/**
 * Smart Core auto-aim: the direction to the perceivable enemy titan or pilot
 * nearest the aim inside the core cone (clear voxel line), else `dir`.
 */
export function smartCoreAim(titans, v, origin, dir) {
  const now = nowOf(titans), half = rowOf(v, 'core').cone / 2, attacker = titanAttacker(titans, v), observer = { x: origin[0], y: origin[1], z: origin[2] };
  let best = null, bestAngle = half;
  const consider = point => {
    const d = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]], len = Math.hypot(...d);
    if (len < 1 || len > 200) return;
    const angle = Math.acos(clamp((d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]) / len, -1, 1));
    if (angle > bestAngle || !clearLine(titans, origin, point)) return;
    best = d.map(n => n / len); bestAngle = angle;
  };
  for (const t of enemyTitans(titans, v.team, v)) consider(hullCenter(t));
  if (attacker) for (const body of enemyPilots(titans, attacker)) if (isPerceivable(observer, body, now)) consider([body.x, body.y + 1.1, body.z]);
  return best ?? dir;
}

// ---- state ---------------------------------------------------------------------------

const hashSeed = text => { let h = 2166136261; for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h || 1; };
/** Deterministic per-titan random in [0, 1). */
function rand(ab) {
  ab.rng = (Math.imul(ab.rng >>> 0 || 1, 1664525) + 1013904223) >>> 0;
  return (ab.rng >>> 8) / 16777216;
}

/** Fresh ability state for a landed titan. */
export function resetTitanAbilities(titans, v) {
  v.tfMove = createTitanMove();
  const slots = value => Object.fromEntries(TITAN_ABILITY_SLOTS.map(slot => [slot, value]));
  const charges = slots(0), rechargeAt = slots(0);
  for (const slot of TITAN_ABILITY_SLOTS) charges[slot] = Math.max(1, finite(rowOf(v, slot)?.charges, 1));
  v.tfAbility = { readyAt: slots(0), core: 0, coreUntil: 0, smoke: TITAN_COMMON_ABILITIES.smoke.charges, activeUntil: slots(0),
    coreKind: CORE_KIND[v.type] ?? null, coreReadySent: false, charges, rechargeAt,
    energy: v.type === 'titan_ion' ? ABILITY_TUNING.energy.max : 0, energyAt: 0,
    hold: 0, guard: null, blockMul: 1, hoverUntil: 0, slowUntil: 0, rootUntil: 0, meleeReadyAt: 0,
    smokeUntil: 0, smokeArmAt: 0, smokePulseAt: 0, smokeLockAt: 0, burnAt: 0, beamAt: 0, rocketAt: 0, rocketsLeft: 0,
    coreHits: null, lines: [], deployables: [], rng: hashSeed(v.id) };
  return v.tfAbility;
}

/** The TITAN_ABILITIES row behind an intent verb, or null. */
export function abilityFor(type, verb) { return TITAN_ABILITIES[type]?.[SLOT_OF[verb]] ?? null; }

/**
 * The intent verbs 'def' | 'tac' | 'ord' | 'core' | 'smoke' | 'melee' | 'mode'
 * ('mode' is LEGION's Mode Switch). `p` is the pilot (or the auto-titan's
 * attacker for 'smoke'). True when the ability went off.
 */
export function useTitanAbility(titans, v, p, verb) {
  const ab = v?.tfAbility, now = nowOf(titans);
  if (!ab || !(v.hp > 0) || v.dropping || v.landedUntil > now || (p && p.embarkUntil > now)) return false;
  switch (verb) {
    case 'smoke': return useSmoke(titans, v);
    case 'melee': return titanMelee(titans, v, p ?? titanAttacker(titans, v));
    case 'mode': return v.type === 'titan_legion' && useSlot(titans, v, p, 'tactical');
    case 'core': return useCore(titans, v);
    case 'def': case 'tac': case 'ord': return useSlot(titans, v, p, SLOT_OF[verb]);
    default: return false;
  }
}

function useSlot(titans, v, p, slot) {
  const ab = v.tfAbility, row = rowOf(v, slot), now = nowOf(titans);
  if (!row || finite(v.tfMove?.phasedUntil) > now) return false;
  if (row.energy) { if (!(ab.energy >= row.energy)) return false; }
  else if (row.charges > 1) { if (!(ab.charges[slot] >= 1)) return false; }
  else if (ab.readyAt[slot] > now || ab.activeUntil[slot] > now) return false;
  const attacker = p ?? titanAttacker(titans, v);
  const done = PRIMITIVES[row.primitive]?.(titans, v, attacker, row, slot) === true;
  if (!done) return false;
  if (row.energy) spendEnergy(titans, v, row.energy);
  else if (row.charges > 1) {
    ab.charges[slot]--;
    if (!(ab.rechargeAt[slot] > now)) ab.rechargeAt[slot] = now + row.cooldown * 1000;
  } else if (!(ab.readyAt[slot] === Infinity)) ab.readyAt[slot] = Math.max(ab.readyAt[slot], now + row.cooldown * 1000);
  return true;
}

// ---- primitives ------------------------------------------------------------------------

const PRIMITIVES = Object.freeze({
  frontGuard: startGuard,
  deployable: placeDeployable,
  shot: abilityShot,
  groundLine: (titans, v, attacker, row) => {
    const yaw = titanLookYaw(titans, v);
    startLine(titans, v, row.key, yaw, row.key === 'firewall' ? ABILITY_TUNING.firewall : ABILITY_TUNING.arcWave, row);
    return true;
  },
  dash: phaseDash,
  hover: (titans, v, attacker, row, slot) => startHover(titans, v, row.seconds, slot),
  toggle: modeSwitch,
});

/** frontGuard: Vortex (catch), Thermal Shield (block + burn), Gun Shield (hp), Sword Block (reduce while held). */
function startGuard(titans, v, attacker, row) {
  const ab = v.tfAbility, now = nowOf(titans), kind = GUARD_KIND[v.type];
  if (!kind || activeGuard(v, now)) return false;
  const held = !!((pilotOf(titans, v)?.input?.titanHold | 0) & HOLD.defensive);
  const seconds = kind === 'block' ? (held ? Infinity : ABILITY_TUNING.swordBlock.unheldSeconds) : row.seconds;
  ab.guard = { kind, startedAt: now, until: now + seconds * 1000, sawHold: held, hp: finite(row.hp), caught: [], weight: 0 };
  ab.activeUntil.defensive = ab.guard.until;
  ab.readyAt.defensive = Infinity;   // the cooldown starts when the guard drops
  syncMove(titans, v, now);          // a Sword Block reduces from this hit on, not from the next tick
  emitAbility(titans, v, kind, { until: Number.isFinite(ab.guard.until) ? ab.guard.until : null });
  return true;
}
function endGuard(titans, v) {
  const ab = v.tfAbility, guard = ab.guard, now = nowOf(titans), row = rowOf(v, 'defensive');
  if (!guard) return;
  ab.guard = null;
  ab.activeUntil.defensive = Math.min(ab.activeUntil.defensive, now);
  ab.readyAt.defensive = now + finite(row?.cooldown) * 1000;
  syncMove(titans, v, now);
  if (guard.kind === 'vortex' && guard.caught.length && v.hp > 0) vortexThrow(titans, v, guard);
}
/** Vortex release: everything caught goes back along the aim at its titan-side damage. */
function vortexThrow(titans, v, guard) {
  const T = ABILITY_TUNING.vortex, attacker = titanAttacker(titans, v);
  if (!attacker) return;
  const total = guard.caught.reduce((sum, n) => sum + n, 0), rays = Math.min(T.throwRays, guard.caught.length);
  // Out of the sphere along the gun's aim, then converging on the crosshair point (the mount's aim point).
  const sphere = guardSphere(v, guard), origin = add3(sphere, titanAimDir(v), sphere[3] + 0.2), aim = anchorAim(titans, v, origin, T.range);
  const ab = v.tfAbility, cone = T.throwSpreadDeg * Math.PI / 180, results = [];
  for (let i = 0; i < rays; i++) {
    const dir = spreadDir(aim, cone, rand(ab), rand(ab));
    const damage = total / rays;
    results.push(titanRay(titans, v, attacker, origin, dir, { key: 'splitter', damage, infantryDamage: Math.min(damage, T.infantryCap), cls: 'titan', range: T.range, headMult: 1 }).result);
  }
  emitAbility(titans, v, 'vortexThrow', { caught: guard.caught.length, damage: Math.round(total) });
  pushAbilityShoot(titans, v, attacker, origin, aim, 'vortexThrow', results, 'splitter');
}
/** A unit direction inside `cone` (radians) around `dir`, from two uniform numbers. */
export function spreadDir(dir, cone, u, w) {
  if (!(cone > 0)) return dir;
  const a = u * Math.PI * 2, r = Math.sqrt(w) * Math.tan(cone);
  const up = Math.abs(dir[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  let s = [dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]];
  const sl = Math.hypot(...s); s = s.map(n => n / sl);
  const t = [dir[1] * s[2] - dir[2] * s[1], dir[2] * s[0] - dir[0] * s[2], dir[0] * s[1] - dir[1] * s[0]];
  const out = dir.map((n, i) => n + (s[i] * Math.cos(a) + t[i] * Math.sin(a)) * r), l = Math.hypot(...out);
  return out.map(n => n / l);
}

/** A deployable's id, unique per titan (the client matches trigger and end events by it). */
function deployId(v) { const ab = v.tfAbility; ab.deploySeq = (ab.deploySeq | 0) + 1; return `${v.id}:${ab.deploySeq}`; }
/**
 * deployable: Tripwire (3 mines), Incendiary Trap, Tether. Each placement event carries `id`
 * and `until`; a mine line or tether that goes off emits its trigger event, an incendiary trap
 * `trapIgnite`, and every deployable that leaves (spent, expired, replaced) `deployableEnd` { id, deployable }.
 */
function placeDeployable(titans, v, attacker, row) {
  const ab = v.tfAbility, now = nowOf(titans), T = ABILITY_TUNING;
  if (v.type === 'titan_ion') {
    const mines = [-1, 0, 1].map(k => groundAhead(titans, v, T.tripwire.ahead, k * row.length / 2)).filter(Boolean);
    if (mines.length < 2) return false;
    const item = { id: deployId(v), kind: 'tripwire', mines, until: now + T.tripwire.lifeMs };
    ab.deployables.push(item);
    emitAbility(titans, v, 'tripwire', { id: item.id, mines: mines.map(m => m.map(round2)), until: item.until });
    return true;
  }
  if (v.type === 'titan_scorch') {
    const at = groundAhead(titans, v, T.incendiary.ahead) ?? groundAhead(titans, v, T.incendiary.ahead / 2);
    if (!at) return false;
    const item = { id: deployId(v), kind: 'incendiary', at, until: now + T.incendiary.lifeMs, team: v.team };
    ab.deployables.push(item);
    emitAbility(titans, v, 'incendiaryTrap', { id: item.id, x: round2(at[0]), y: round2(at[1]), z: round2(at[2]), until: item.until });
    return true;
  }
  if (v.type === 'titan_northstar') {
    const at = groundAhead(titans, v, T.tether.ahead) ?? groundAhead(titans, v, T.tether.ahead / 2);
    if (!at) return false;
    const live = ab.deployables.filter(d => d.kind === 'tether');
    if (live.length >= T.tether.maxActive) {
      ab.deployables.splice(ab.deployables.indexOf(live[0]), 1);
      emitAbility(titans, v, 'deployableEnd', { id: live[0].id, deployable: 'tether' });
    }
    const item = { id: deployId(v), kind: 'tether', at, until: now + T.tether.lifeMs };
    ab.deployables.push(item);
    ab.activeUntil.defensive = now + T.tether.flashSeconds * 1000;   // the launch flash (defensive bit)
    emitAbility(titans, v, 'tether', { id: item.id, x: round2(at[0]), y: round2(at[1]), z: round2(at[2]), until: item.until });
    return true;
  }
  return false;
}

/** shot: Laser Shot, Cluster Missile, Power Shot from the row anchor along the aim. */
function abilityShot(titans, v, attacker, row) {
  const T = ABILITY_TUNING, origin = anchorWorld(v, row.anchor), aim = anchorAim(titans, v, origin);
  if (!attacker) return false;
  if (v.type === 'titan_ion') {
    const { result } = titanRay(titans, v, attacker, origin, aim, { key: row.key, damage: row.damage, infantryDamage: row.infantryDamage,
      cls: row.cls, range: T.laserShot.range, headMult: 1 });
    abilityShootEvent(titans, v, attacker, origin, aim, 'laserShot', [result], 'railgun');
    return true;
  }
  if (v.type === 'titan_northstar') {
    const projectile = titans.engine.projectiles?.titanfall?.launch('titan:cluster',
      { owner: attacker, origin, dir: aim, vehicleId: v.id, titanId: v.id }, titans.vehicles.projectileContext());
    if (!projectile) return false;
    emitAbility(titans, v, 'cluster');
    return true;
  }
  if (v.type === 'titan_legion') {
    const P = T.powerShot, long = titans.vehicles.mounts.selected(v, 'driver')?.weapon === 'predatorLong', ab = v.tfAbility;
    if (long) {
      const { result } = titanRay(titans, v, attacker, origin, aim, { key: row.key, damage: row.damageLong, infantryDamage: P.longInfantry,
        cls: row.cls, range: P.longRange, headMult: 1 }, { pierce: P.longPierce });
      abilityShootEvent(titans, v, attacker, origin, aim, 'powerShot', [result], 'railgun');
    } else {
      const cone = P.closeSpreadDeg * Math.PI / 180, results = [];
      for (let i = 0; i < P.closeRays; i++) {
        results.push(titanRay(titans, v, attacker, origin, i === 0 ? aim : spreadDir(aim, cone, rand(ab), rand(ab)), { key: row.key,
          damage: row.damageClose / P.closeRays, infantryDamage: P.closeInfantry, cls: row.cls, range: P.closeRange, headMult: 1 }).result);
      }
      abilityShootEvent(titans, v, attacker, origin, aim, 'powerShot', results, 'predatorClose');
    }
    return true;
  }
  return false;
}
/**
 * A hitscan ability shot: the `titan_ability` event (o, end) plus a stock vehicle shoot event
 * (`ability` set, a path per ray from the anchor, `vehicleWeapon` the titan weapon whose look
 * stands in) so vehicle-fx draws the tracers and impacts until presentation draws its own.
 */
function abilityShootEvent(titans, v, attacker, origin, dir, ability, results, look) {
  const first = results.find(r => Array.isArray(r?.end)) ?? null;
  emitAbility(titans, v, ability, { o: origin.map(round2), end: first ? first.end.map(round2) : null });
  pushAbilityShoot(titans, v, attacker, origin, dir, ability, results, look);
}
function pushAbilityShoot(titans, v, attacker, origin, dir, ability, results, look) {
  const first = results.find(r => Array.isArray(r?.end)) ?? null;
  const seat = vehicleDef(v)?.seats?.[0], mount = seat?.mounts?.[0];
  if (!mount || !attacker || !first) return;
  const event = evVehicleShoot(attacker.id, origin, dir, TITAN_WEAPON_META[look]?.presentation ?? look,
    { vehicleId: v.id, mount, vehicleWeapon: look, tracer: true, end: first.end, hit: first.hit ?? null });
  event.ability = ability;
  event.paths = results.filter(r => Array.isArray(r?.end)).map(r => {
    const segment = { o: event.o, end: r.end.map(round2) };
    if (r.hit) segment.hit = { x: r.hit.x | 0, y: r.hit.y | 0, z: r.hit.z | 0, nx: r.hit.nx | 0, ny: r.hit.ny | 0, nz: r.hit.nz | 0 };
    return [segment];
  });
  titans.engine.tickEvents?.push(event);
}

/** Phase Dash: blink along the wish (forward if none), swept against voxels, shortened off hull overlaps. */
function phaseDash(titans, v, attacker, row) {
  const now = nowOf(titans), input = pilotOf(titans, v)?.input ?? {}, x0 = v.x, z0 = v.z;
  let fwd = clamp(finite(input.vehicleThrottle), -1, 1), side = clamp(finite(input.vehicleSteer), -1, 1);
  if (!fwd && !side) fwd = 1;
  const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
  let dx = -sy * fwd + cy * side, dz = -cy * fwd - sy * side;
  const len = Math.hypot(dx, dz); dx /= len; dz /= len;
  const probe = { type: v.type, x: v.x, y: v.y, z: v.z, yaw: v.yaw }, samples = [], step = ABILITY_TUNING.phase.step;
  for (let d = step; d <= row.blink + 1e-9; d += step) {
    const x = v.x + dx * d, z = v.z + dz * d, support = placeWalker(probe, x, z, titans.world);
    if (support === null) break;            // a voxel wall (or a step above maxStep): the blink stops here
    probe.x = x; probe.z = z;
    if (Number.isFinite(support)) probe.y = support;
    samples.push({ x, y: probe.y, z });
  }
  let end = null;
  for (let i = samples.length - 1; i >= 0 && !end; i--) {
    const s = samples[i];
    if (!titans.hullBlocked({ type: v.type, x: s.x, y: s.y, z: s.z, yaw: v.yaw }, v)) end = s;
  }
  if (!end) return false;
  v.x = end.x; v.y = end.y; v.z = end.z;
  v.vx = 0; v.vz = 0; v.speed = 0; v.dashT = 0; v.walkRest = undefined;
  v.tfMove.phasedUntil = now + row.phasedSeconds * 1000;
  v.tfAbility.activeUntil.ordnance = v.tfMove.phasedUntil;
  syncMove(titans, v, now);
  titans.vehicles.locks?.breakLocks?.(v);
  emitAbility(titans, v, 'phaseDash', { x: round2(end.x), y: round2(end.y), z: round2(end.z), blink: round2(Math.hypot(end.x - x0, end.z - z0)) });
  return true;
}

/**
 * hover: VTOL (and Flight Core) hold their height (§5.5 `hoverVy` 0, which the client
 * predictor mirrors from the hover bit) at the row's `speedMul`.
 */
function startHover(titans, v, seconds, slot) {
  const ab = v.tfAbility, now = nowOf(titans);
  if (ab.hoverUntil > now) return false;
  ab.hoverUntil = now + seconds * 1000;
  ab.activeUntil[slot] = ab.hoverUntil;
  syncMove(titans, v, now);
  emitAbility(titans, v, slot === 'core' ? 'flightCore' : 'hover', { until: ab.hoverUntil });
  return true;
}

/**
 * toggle: LEGION Mode Switch between predatorClose and predatorLong. It sets the seat selection
 * itself: VehicleMounts.select on a titan routes back here (titan-mounts.js selectTitanWeapon).
 */
function modeSwitch(titans, v, attacker, row) {
  const mounts = titans.vehicles.mounts, list = seatWeaponList(v.type, 'driver');
  if (list.length < 2) return false;
  const next = (mounts.selectedIndex(v, 'driver') + 1) % list.length;
  const state = mounts.state(v, list[next].mount);
  if (!state) return false;
  (v.sel ??= {}).driver = next;
  state.weapon = list[next].weapon;
  state.cooldown = Math.max(state.cooldown, ABILITY_TUNING.modeSwitchSeconds);
  emitAbility(titans, v, 'modeSwitch', { weapon: list[next].weapon });
  return true;
}

// ---- core ------------------------------------------------------------------------------

function useCore(titans, v) {
  const ab = v.tfAbility, now = nowOf(titans), row = rowOf(v, 'core'), kind = ab.coreKind;
  if (!row || !(ab.core >= 1) || ab.coreUntil > now) return false;
  const T = ABILITY_TUNING;
  let seconds = finite(row.seconds);
  if (kind === 'flameCore') {
    seconds = T.flameCore.showSeconds;
    ab.coreHits = new Map();
    const yaw = titanLookYaw(titans, v);
    for (let line = 0; line < row.lines; line++) startLine(titans, v, 'flameCore', yaw + (line - (row.lines - 1) / 2) * T.flameCore.fan, T.flameCore, row);
  } else if (kind === 'flightCore') {
    ab.hoverUntil = 0;
    startHover(titans, v, row.seconds, 'core');
    ab.rocketsLeft = row.rockets; ab.rocketAt = now;
  } else if (kind === 'laserCore') ab.beamAt = now;
  ab.core = 0;
  ab.coreReadySent = false;
  ab.coreUntil = now + seconds * 1000;
  ab.activeUntil.core = ab.coreUntil;
  syncMove(titans, v, now);
  titans.emit('core_start', { vehicleId: v.id });
  return true;
}

function stepCore(titans, v, ab, now, dt) {
  const row = rowOf(v, 'core'), T = ABILITY_TUNING;
  if (ab.coreUntil > now) {
    const attacker = titanAttacker(titans, v);
    if (ab.coreKind === 'laserCore' && attacker) {
      while (ab.beamAt <= now && ab.beamAt < ab.coreUntil) {
        ab.beamAt += T.laserCore.pulse * 1000;
        const origin = anchorWorld(v, row.anchor);
        titanRay(titans, v, attacker, origin, anchorAim(titans, v, origin, row.range), { key: row.key, damage: row.dps * T.laserCore.pulse,
          infantryDamage: row.infantryDps * T.laserCore.pulse, cls: row.cls, range: row.range, headMult: 1 });
      }
    } else if (ab.coreKind === 'flightCore' && attacker) {
      while (ab.rocketsLeft > 0 && ab.rocketAt <= now) {
        ab.rocketAt += row.interval * 1000;
        ab.rocketsLeft--;
        const side = ab.rocketsLeft % 2 ? 1 : -1, anchor = [row.anchor[0] * side, row.anchor[1], row.anchor[2]];
        const origin = anchorWorld(v, anchor), dir = spreadDir(anchorAim(titans, v, origin), T.flightCore.spreadDeg * Math.PI / 180, rand(ab), rand(ab));
        titans.engine.projectiles?.titanfall?.launch('titan:flightRocket', { owner: attacker, origin, dir, vehicleId: v.id, titanId: v.id },
          titans.vehicles.projectileContext());
      }
    }
  } else if (ab.coreUntil > 0) {
    ab.coreUntil = 0;
    ab.coreHits = null;
    ab.rocketsLeft = 0;
    titans.emit('core_end', { vehicleId: v.id });
  }
  if (!(ab.coreUntil > now)) {
    ab.core = Math.min(1, finite(ab.core) + dt / T.core.passiveSeconds);
    coreReady(titans, v, ab);
  }
}

// ---- electric smoke, melee -------------------------------------------------------------

function useSmoke(titans, v) {
  const ab = v.tfAbility, now = nowOf(titans), row = TITAN_COMMON_ABILITIES.smoke;
  if (!(ab.smoke >= 1) || ab.smokeUntil > now) return false;
  ab.smoke--;
  ab.smokeUntil = now + row.seconds * 1000;
  ab.smokeArmAt = now + ABILITY_TUNING.smoke.armSeconds * 1000;
  ab.smokePulseAt = ab.smokeArmAt;
  ab.smokeLockAt = now;
  titans.vehicles.locks?.breakLocks?.(v);
  emitAbility(titans, v, 'smoke', { until: ab.smokeUntil });
  return true;
}
function stepSmoke(titans, v, ab, now, dt) {
  if (!(ab.smokeUntil > now) || now < ab.smokeArmAt) return;
  const row = TITAN_COMMON_ABILITIES.smoke, T = ABILITY_TUNING;
  titans.killRiders(v, row.riderDps, dt);
  if (now >= ab.smokeLockAt) { ab.smokeLockAt = now + T.smoke.lockEvery * 1000; titans.vehicles.locks?.breakLocks?.(v); }
  if (now < ab.smokePulseAt) return;
  ab.smokePulseAt = now + T.pulse * 1000;
  const attacker = titanAttacker(titans, v);
  if (!attacker) return;
  for (const body of enemyPilots(titans, attacker)) {
    if (body.rodeoVehicleId === v.id || Math.hypot(body.x - v.x, body.z - v.z) > row.radius || Math.abs(body.y - v.y) > titanFrame(v).height) continue;
    creditCore(titans, v, hurtPilot(titans, attacker, body, row.pilotDps * T.pulse, row.key));
  }
}

/**
 * Titan melee (§5.4): the nearest enemy titan in a cone in front takes 200 (Sword
 * Core 350, cls titan); a doomed titan hit from its front is executed (destroyed,
 * credited to the attacker). Enemy pilots in the cone take the infantry damage.
 */
export function titanMelee(titans, v, attacker) {
  const ab = v.tfAbility, now = nowOf(titans), row = TITAN_COMMON_ABILITIES.melee, T = ABILITY_TUNING;
  if (!attacker || ab.meleeReadyAt > now || finite(v.tfMove?.phasedUntil) > now) return false;
  ab.meleeReadyAt = now + row.cooldown * 1000;
  const sword = ab.coreKind === 'swordCore' && ab.coreUntil > now, core = rowOf(v, 'core');
  const damage = sword ? core.meleeDamage : row.damage, infantry = sword ? T.swordCoreInfantry : row.infantryDamage;
  const f = titanFrame(v), fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw), cos = Math.cos(T.melee.coneDeg * Math.PI / 180);
  let target = null, best = Infinity;
  for (const t of enemyTitans(titans, v.team, v)) {
    const dx = t.x - v.x, dz = t.z - v.z, d = Math.hypot(dx, dz), reach = row.range + f.hl + titanFrame(t).hl + 0.3;
    if (d > reach || d < 1e-6 || (dx * fx + dz * fz) / d < cos || Math.abs(t.y - v.y) > 3 || d >= best) continue;
    target = t; best = d;
  }
  let dealt = 0, executed = false;
  if (target) {
    const local = vehicleWorldToLocal(target, [v.x, target.y + 1, v.z]), len = Math.hypot(local[0], local[2]);
    if (target.doomed && len > 1e-6 && -local[2] / len > T.melee.frontExecuteDot) {
      target.doomedBy = attacker;
      titans.destroyDoomed(target);
      executed = true;
      emitAbility(titans, v, 'execution', { target: target.id });
    } else {
      dealt += hurtHull(titans, attacker, target, damage, row.cls, { point: hullCenter(target), origin: hullCenter(v) });
    }
  }
  for (const body of enemyPilots(titans, attacker)) {
    const dx = body.x - v.x, dz = body.z - v.z, d = Math.hypot(dx, dz);
    if (d > row.range + f.hl + PHYSICS.halfW || d < 1e-6 || (dx * fx + dz * fz) / d < cos || body.y > v.y + f.height || body.y + PHYSICS.height < v.y - 1) continue;
    dealt += hurtPilot(titans, attacker, body, infantry, row.key);
  }
  creditCore(titans, v, dealt);
  const pose = primaryPose(v), seat = vehicleDef(v).seats[0];
  if (pose) titans.engine.tickEvents?.push(evVehicleShoot(attacker.id, pose.origin, [fx, 0, fz], 'titanMelee',
    { vehicleId: v.id, mount: seat.mounts[0], vehicleWeapon: 'titanMelee' }));
  emitAbility(titans, v, 'melee', { target: target?.id ?? null, executed });
  return true;
}

// ---- ground lines ----------------------------------------------------------------------

/** groundLine: segments advancing along the ground from the row anchor along `yaw`. */
function startLine(titans, v, kind, yaw, rules, row) {
  const ab = v.tfAbility, now = nowOf(titans), start = anchorWorld(v, row.anchor);
  const y = surfaceNear(titans, start[0], start[2], v.y, 1.5, 4) ?? v.y;
  const line = { kind, x: start[0], y, z: start[2], dx: -Math.sin(yaw), dz: -Math.cos(yaw), travelled: 0, length: finite(row.length, 30),
    speed: rules.speed, width: rules.width, points: [[start[0], y, start[2]]], fresh: 1, stopped: false,
    until: now + (kind === 'firewall' ? row.seconds * 1000 : (finite(row.length, 30) / rules.speed + 0.2) * 1000), hits: new Map(), row };
  ab.lines.push(line);
  emitAbility(titans, v, kind, { x: round2(start[0]), y: round2(y), z: round2(start[2]), yaw: round2(yaw), length: line.length, until: line.until });
  return line;
}
function stepLines(titans, v, ab, now, dt) {
  if (!ab.lines.length) return;
  const attacker = titanAttacker(titans, v), T = ABILITY_TUNING, keep = [];
  for (const line of ab.lines) {
    const before = line.points.length;
    if (!line.stopped) {
      let budget = line.speed * dt;
      while (budget > 1e-9 && !line.stopped) {
        const step = Math.min(T.line.sample, budget, line.length - line.travelled);
        if (!(step > 1e-9)) { line.stopped = true; break; }
        const nx = line.x + line.dx * step, nz = line.z + line.dz * step;
        const ny = surfaceNear(titans, nx, nz, line.y, T.line.rise, T.line.fall);
        if (ny == null) { line.stopped = true; break; }
        line.x = nx; line.y = ny; line.z = nz; line.travelled += step; budget -= step;
        line.points.push([nx, ny, nz]);
        if (line.travelled >= line.length - 1e-6) line.stopped = true;
      }
    }
    line.fresh = line.points.length - before;
    if (attacker) lineDamage(titans, v, attacker, line, now, line.kind === 'firewall' ? 0 : Math.max(0, before - 1));
    if (line.until > now) keep.push(line);
  }
  ab.lines = keep;
}
/** Targets touching the line from point `from` on (the moving head) or, for the firewall, the whole burning path. */
function lineDamage(titans, v, attacker, line, now, from) {
  const T = ABILITY_TUNING, row = line.row, pts = line.points;
  const touches = (x, y, z, reach, below, above) => {
    for (let i = from; i < pts.length; i++) {
      const p = pts[i];
      if (Math.hypot(p[0] - x, p[2] - z) <= reach && y >= p[1] - below && y <= p[1] + above) return p;
    }
    return null;
  };
  if (line.kind === 'firewall' || line.kind === 'flameCore') for (let i = Math.max(0, from); i < pts.length; i++) igniteTraps(titans, pts[i], line.width + 1);
  for (const t of enemyTitans(titans, v.team, v)) {
    const p = touches(t.x, t.y, t.z, line.width + titanFrame(t).hw * 0.8, 2.5, 2);
    if (!p) continue;
    const last = line.hits.get(t.id);
    if (line.kind === 'firewall') {
      if (last !== undefined && now - last < 500) continue;
      line.hits.set(t.id, now);
      creditCore(titans, v, hurtHull(titans, attacker, t, row.dps * 0.5, row.cls, { point: [t.x, p[1] + 0.5, t.z], origin: p }));
    } else if (last === undefined) {
      line.hits.set(t.id, now);
      if (line.kind === 'arcWave') {
        creditCore(titans, v, hurtHull(titans, attacker, t, row.damage, row.cls, { point: [t.x, p[1] + 1, t.z], origin: p }));
        if (t.tfAbility) { t.tfAbility.slowUntil = Math.max(t.tfAbility.slowUntil, now + row.slowSeconds * 1000); syncMove(titans, t, now); }
      } else {
        const ab = v.tfAbility, got = finite(ab.coreHits?.get(t.id)), amount = Math.min(row.damage / row.lines, row.perTarget - got);
        if (amount > 0) {
          ab.coreHits?.set(t.id, got + amount);
          hurtHull(titans, attacker, t, amount, row.cls, { point: [t.x, p[1] + 1, t.z], origin: p });
        }
      }
    }
  }
  for (const body of enemyPilots(titans, attacker)) {
    const p = touches(body.x, body.y, body.z, line.width + PHYSICS.halfW, 1, T.line.height);
    if (!p) continue;
    const key = `p:${body.id}`, last = line.hits.get(key);
    if (line.kind === 'firewall') {
      if (last !== undefined && now - last < 500) continue;
      line.hits.set(key, now);
      creditCore(titans, v, hurtPilot(titans, attacker, body, row.pilotDps * 0.5, row.key));
    } else if (last === undefined) {
      line.hits.set(key, now);
      creditCore(titans, v, hurtPilot(titans, attacker, body, line.kind === 'arcWave' ? T.arcWave.infantryDamage : T.flameCore.infantryDamage, row.key));
    }
  }
}

// ---- deployables -----------------------------------------------------------------------

/** Ignite every unlit incendiary trap within `radius` of `point` (thermite, firewall, flame core, thermal shield). */
export function igniteTraps(titans, point, radius) {
  if (!titans || !Array.isArray(point)) return 0;
  let lit = 0;
  for (const t of titans.titans()) {
    const ab = t.tfAbility;
    if (!ab?.deployables?.length) continue;
    for (const trap of ab.deployables) {
      if (trap.kind !== 'incendiary' || trap.lit || dist3(trap.at, point) > radius + ABILITY_TUNING.incendiary.igniteRadius) continue;
      trap.lit = true; lit++;
      const row = rowOf(t, 'tactical'), attacker = titanAttacker(titans, t), T = ABILITY_TUNING.incendiary;
      const ctx = titans.vehicles.projectileContext(), fire = titans.engine.projectiles?.fire;
      trap.until = 0;
      if (ctx && fire && attacker) {
        fire.ignite({ id: `trap-${t.id}-${titans.now}-${lit}`, x: trap.at[0], y: trap.at[1] + 0.3, z: trap.at[2], ownerId: String(attacker.id), owner: attacker, chaosLevel: 0 },
          ctx, { radius: row.radius, durationMs: row.seconds * 1000, damagePerSecond: T.pilotDps, hullDamagePerSecond: row.dps, key: row.key, maxCells: T.maxCells,
            onHullDamage: (hull, dealt) => creditCore(titans, titans.vehicles.vehicles.get(t.id) ?? null, dealt) });
      }
      emitAbility(titans, t, 'trapIgnite', { id: trap.id, x: round2(trap.at[0]), y: round2(trap.at[1]), z: round2(trap.at[2]) });
    }
  }
  return lit;
}
function segmentDistance2D(px, pz, a, b) {
  const ex = b[0] - a[0], ez = b[2] - a[2], len2 = ex * ex + ez * ez;
  const k = len2 > 1e-9 ? clamp(((px - a[0]) * ex + (pz - a[2]) * ez) / len2, 0, 1) : 0;
  return Math.hypot(px - (a[0] + ex * k), pz - (a[2] + ez * k));
}
function stepDeployables(titans, v, ab, now) {
  if (!ab.deployables.length) return;
  const attacker = titanAttacker(titans, v), T = ABILITY_TUNING, keep = [];
  for (const item of ab.deployables) {
    if (!(item.until > now)) { emitAbility(titans, v, 'deployableEnd', { id: item.id, deployable: item.kind }); continue; }
    if (!attacker) { keep.push(item); continue; }
    if (item.kind === 'tripwire') {
      let triggered = false;
      for (const t of enemyTitans(titans, v.team, v)) {
        for (let i = 0; i + 1 < item.mines.length && !triggered; i++) {
          if (segmentDistance2D(t.x, t.z, item.mines[i], item.mines[i + 1]) <= titanFrame(t).hw + T.tripwire.beamWidth
            && Math.abs(t.y - item.mines[i][1]) < 3) triggered = true;
        }
      }
      if (!triggered) for (const body of enemyPilots(titans, attacker)) {
        if (item.mines.some(m => Math.hypot(body.x - m[0], body.z - m[2]) <= T.tripwire.pilotRadius && Math.abs(body.y - m[1]) < 2)) { triggered = true; break; }
      }
      if (triggered) {
        const row = rowOf(v, 'tactical');
        for (const m of item.mines) blastAt(titans, v, attacker, [m[0], m[1] + 0.6, m[2]], { radius: T.tripwire.blastRadius, hull: row.damage,
          infantry: T.tripwire.infantryDamage, infantryRadius: T.tripwire.infantryRadius, key: row.key, cls: row.cls });
        emitAbility(titans, v, 'tripwireTrigger', { id: item.id, mines: item.mines.map(m => m.map(round2)) });
        emitAbility(titans, v, 'deployableEnd', { id: item.id, deployable: item.kind });
        continue;
      }
    } else if (item.kind === 'tether') {
      const row = rowOf(v, 'defensive');
      let caught = null;
      for (const t of enemyTitans(titans, v.team, v)) {
        if (Math.hypot(t.x - item.at[0], t.z - item.at[2]) <= T.tether.triggerRadius && Math.abs(t.y - item.at[1]) < 3) { caught = t; break; }
      }
      if (caught) {
        if (caught.tfAbility) { caught.tfAbility.rootUntil = Math.max(caught.tfAbility.rootUntil, now + row.rootSeconds * 1000); syncMove(titans, caught, now); }
        creditCore(titans, v, hurtHull(titans, attacker, caught, row.damage, row.cls, { point: [caught.x, caught.y + 1, caught.z], origin: item.at }));
        emitAbility(titans, v, 'tetherTrigger', { id: item.id, target: caught.id, until: now + row.rootSeconds * 1000 });
        emitAbility(titans, v, 'deployableEnd', { id: item.id, deployable: item.kind });
        continue;
      }
    }
    keep.push(item);
  }
  ab.deployables = keep;
}

/** Thermal Shield burn: enemies in the box in front of the hull, pulsed (fire for titans, ×0.6 by armour). */
function stepThermal(titans, v, ab, guard, now) {
  if (now < ab.burnAt) return;
  const T = ABILITY_TUNING, row = rowOf(v, 'defensive'), attacker = titanAttacker(titans, v), f = titanFrame(v);
  ab.burnAt = now + T.pulse * 1000;
  if (!attacker) return;
  const inFront = (x, y, z, pad) => {
    const [lx, ly, lz] = vehicleWorldToLocal(v, [x, y, z]);
    return lz <= -f.hl * 0.5 && lz >= -(f.hl + row.range + pad) && Math.abs(lx) <= T.thermal.halfWidth + pad && ly > -2 && ly < f.height;
  };
  for (const t of enemyTitans(titans, v.team, v)) {
    if (inFront(t.x, t.y + 1, t.z, titanFrame(t).hl)) creditCore(titans, v, hurtHull(titans, attacker, t, row.dps * T.pulse, row.cls, { origin: hullCenter(v) }));
  }
  for (const body of enemyPilots(titans, attacker)) {
    if (inFront(body.x, body.y + 0.9, body.z, PHYSICS.halfW)) creditCore(titans, v, hurtPilot(titans, attacker, body, T.thermal.pilotDps * T.pulse, row.key));
  }
  igniteTraps(titans, vehicleLocalPoint(v, 0, 0, -(f.hl + row.range * 0.6)), row.range);
}

// ---- per tick --------------------------------------------------------------------------

/** Per-tick upkeep: held bits, energy, core, guards, hover, smoke, lines, deployables, then tfMove. */
export function stepTitanAbilities(titans, v, dt) {
  const ab = v?.tfAbility;
  if (!ab || !(dt > 0)) return;
  const now = nowOf(titans), pilot = pilotOf(titans, v), T = ABILITY_TUNING;
  // titanHold only says what is held (the press is the `ability` intent, §3.6): bit 2 keeps a Vortex
  // or Sword Block up and its release drops it.
  const hold = pilot && !(pilot.embarkUntil > now) ? (pilot.input?.titanHold | 0) : 0;
  ab.hold = hold;
  if (!(v.hp > 0)) return;
  // ION energy: regen after a short delay.
  if (v.type === 'titan_ion' && now - ab.energyAt >= T.energy.delay * 1000) ab.energy = Math.min(T.energy.max, ab.energy + T.energy.regen * dt);
  // Charged slots (tether) refill one charge per cooldown.
  for (const slot of TITAN_ABILITY_SLOTS) {
    const row = rowOf(v, slot);
    if (!(row?.charges > 1) || ab.charges[slot] >= row.charges || !(ab.rechargeAt[slot] <= now)) continue;
    ab.charges[slot]++;
    ab.rechargeAt[slot] = ab.charges[slot] < row.charges ? now + row.cooldown * 1000 : 0;
  }
  stepCore(titans, v, ab, now, dt);
  // Guards: time out, release on the hold edge, gun shield broken, thermal burn.
  const guard = ab.guard;
  if (guard) {
    if (hold & HOLD.defensive) {
      guard.sawHold = true;
      if (guard.kind === 'block') guard.until = Infinity;   // Sword Block lasts while held, even when the bit trails the press
    }
    // Only the held guards (Vortex, Sword Block) drop on release; Thermal Shield and Gun Shield run their row seconds.
    const heldGuard = guard.kind === 'vortex' || guard.kind === 'block';
    const released = heldGuard && guard.sawHold && !(hold & HOLD.defensive) && now - guard.startedAt >= T.vortex.minHold * 1000;
    if (!(guard.until > now) || released || (guard.kind === 'gunShield' && guard.hp <= 0)) endGuard(titans, v);
    else {
      ab.activeUntil.defensive = guard.until;
      if (guard.kind === 'thermal') stepThermal(titans, v, ab, guard, now);
    }
  }
  if (ab.hoverUntil > 0 && !(ab.hoverUntil > now)) ab.hoverUntil = 0;
  stepSmoke(titans, v, ab, now, dt);
  stepLines(titans, v, ab, now, dt);
  stepDeployables(titans, v, ab, now);
  syncMove(titans, v, now);
}

/**
 * Movement block (§5.5) from the ability state: stepTitanWalk reads it on the next substeps
 * and applyTitanDamage reads damageTakenMul. Run every tick and whenever a guard or hover
 * starts or ends between ticks; ab.blockMul is the Sword Block factor damageTakenMul carries.
 */
function syncMove(titans, v, now) {
  const ab = v.tfAbility, mv = v.tfMove ?? (v.tfMove = createTitanMove()), active = activeGuard(v, now);
  const hovering = ab.hoverUntil > now, swordCore = ab.coreKind === 'swordCore' && ab.coreUntil > now;
  mv.hoverVy = hovering ? 0 : null;
  mv.speedMul = (hovering ? rowOf(v, 'tactical')?.speedMul ?? 0.5 : 1) * (ab.slowUntil > now ? rowOf({ type: 'titan_ronin' }, 'tactical').speedMul : 1);
  mv.rooted = ab.rootUntil > now;
  mv.pipRefill = swordCore;
  let taken = swordCore ? rowOf(v, 'core').damageTakenMul : 1;
  ab.blockMul = active?.kind === 'block' ? rowOf(v, 'defensive').damageTakenMul : 1;
  taken *= ab.blockMul;
  if (finite(mv.phasedUntil) > now) taken = 0;
  mv.damageTakenMul = taken;
}

/** Readiness 0..1 per slot for the `ab` row: { def, tac, ord, smoke }. */
export function abilityReadiness(titans, v, now) {
  const ab = v?.tfAbility;
  if (!ab) return { def: 0, tac: 0, ord: 0, smoke: 0 };
  const ready = slot => {
    const row = rowOf(v, slot);
    if (!row) return 0;
    if (row.energy) return clamp(finite(ab.energy) / row.energy, 0, 1);
    if (row.charges > 1) return ab.charges[slot] >= 1 ? 1 : clamp(1 - (ab.rechargeAt[slot] - now) / (row.cooldown * 1000), 0, 0.99);
    if (ab.activeUntil[slot] > now && slot === 'defensive' && ab.guard) return 0;
    const left = ab.readyAt[slot] - now;
    if (!(left > 0)) return 1;
    return Number.isFinite(left) && row.cooldown > 0 ? clamp(1 - left / (row.cooldown * 1000), 0, 0.99) : 0;
  };
  return { def: ready('defensive'), tac: ready('tactical'), ord: ready('ordnance'), smoke: finite(ab.smoke) };
}
