/**
 * Tank armour model (docs/conquest.md "Tank armour"): hit parts, plate slope,
 * penetration, ricochets and subsystem damage. Pure data plus the lookups the
 * authoritative damage path (server/sim/vehicle-damage.js), the projectile
 * flight (ricochets) and the HUD share.
 *
 * The gameplay collider stays one box; a hit on it is traced through five
 * detail boxes in the hull frame (forward -Z, +Y up, the ground at y = 0):
 * the two running gears, the upper hull (skirts, sponsons, glacis, deck), the
 * lower tub and the turret, which turns with `turretYaw` about its pivot.
 * The struck face gives the part and its outward normal; the glacis and the
 * turret cheeks carry their real slope, and the hull's pitch and roll come in
 * through the hull frame. The incidence angle sets the outcome of an AT round:
 * penetration (damage x part multiplier x penetration factor), no penetration
 * (a spall share) or, past the weapon's ricochet angle, a ricochet (nothing,
 * the round glances off). HE never ricochets but loses to thick, sloped plate.
 */
import { vehicleWorldToLocal, vehicleLocalDirection, vehicleLocalPoint } from './vehicle-defs.js';
import { ARMOR_MATRIX, ARMOR_EFFECTIVE_THRESHOLD } from './vehicle-armor.js';

/** Hit parts of the tank and the facing zone each one reports (vehicle_hit.zone). */
export const TANK_PARTS = Object.freeze({
  'turret-front': 'front', 'turret-side': 'side', 'turret-rear': 'rear', 'turret-top': 'top',
  'hull-front': 'front', 'hull-side': 'side', 'hull-rear': 'rear', 'hull-top': 'top', 'hull-bottom': 'bottom',
  engine: 'top', tracks: 'side',
});
export const TANK_PART_IDS = Object.freeze(Object.keys(TANK_PARTS));

/**
 * Per part: `ratio` is plate thickness over AT penetration at normal
 * incidence (the round penetrates fully while cos(angle) >= ratio; below
 * that the damage falls as cos / ratio), `at` the AT damage multiplier at
 * full penetration and `he` the HE multiplier on top of the heavy HE cell.
 * The front is thick and sloped, the flanks and the running gear medium, the
 * rear, the engine deck and the roofs thin.
 */
export const TANK_ARMOR = Object.freeze({
  'turret-front': Object.freeze({ ratio: 0.95, at: 0.85, he: 0.7 }),
  'turret-side':  Object.freeze({ ratio: 0.6,  at: 1.1, he: 1 }),
  'turret-rear':  Object.freeze({ ratio: 0.45, at: 1.6, he: 1.3 }),
  'turret-top':   Object.freeze({ ratio: 0.35, at: 1.3, he: 1.4 }),
  'hull-front':   Object.freeze({ ratio: 0.6,  at: 0.85, he: 0.7 }),
  'hull-side':    Object.freeze({ ratio: 0.55, at: 1,   he: 1 }),
  'hull-rear':    Object.freeze({ ratio: 0.4,  at: 1.7, he: 1.3 }),
  'hull-top':     Object.freeze({ ratio: 0.35, at: 1.2, he: 1.4 }),
  'hull-bottom':  Object.freeze({ ratio: 0.3,  at: 1.5, he: 1.4 }),
  engine:         Object.freeze({ ratio: 0.3,  at: 1.5, he: 1.4 }),
  tracks:         Object.freeze({ ratio: 0.5,  at: 0.95, he: 1 }),
});

/**
 * Outcome rules. `ricochetDeg` is the incidence (from the plate normal) at
 * and past which an AT round glances off, per weapon key (tank AP shell,
 * RX-8 HAVOC rocket) with `default` for any other AT round. Below
 * `noPenFactor` of penetration the round only spalls (`spall` of the part
 * damage, not effective). HE scales with `heBase + heSlope * cos(angle)`.
 */
export const TANK_ARMOR_RULES = Object.freeze({
  ricochetDeg: Object.freeze({ tankAP: 70, rocket: 75, default: 72 }),
  noPenFactor: 0.45, spall: 0.1,
  heBase: 0.6, heSlope: 0.4,
  // A ricochet leaves with this share of its speed.
  ricochetSpeed: Object.freeze({ tankAP: 0.55, rocket: 0.45, default: 0.5 }),
});

/**
 * Subsystems: dealt damage on their parts builds a pool (decaying by `decay`
 * HP/s); at `threshold` the subsystem breaks for `seconds` and the pool
 * empties. Broken tracks stop the hull (no drive, no pivot), a damaged engine
 * caps the drive at `drive`, a damaged turret ring slews at `slew`. A repair
 * clears them all.
 */
export const TANK_SUBSYSTEMS = Object.freeze({
  tracks: Object.freeze({ parts: Object.freeze(['tracks']), threshold: 200, seconds: 6, decay: 10 }),
  engine: Object.freeze({ parts: Object.freeze(['hull-rear', 'engine']), threshold: 250, seconds: 15, decay: 10, drive: 0.5 }),
  turret: Object.freeze({ parts: Object.freeze(['turret-front', 'turret-side', 'turret-rear', 'turret-top']), threshold: 340, seconds: 8, decay: 15, slew: 0.4 }),
});
export const TANK_SUBSYSTEM_IDS = Object.freeze(Object.keys(TANK_SUBSYSTEMS));
/** Parts where one AT hit of VEHICLE_DAMAGE_RULES.disableHitFraction disables the hull (engine, ammunition bustle, belly). */
export const TANK_DISABLE_PARTS = Object.freeze(['hull-rear', 'engine', 'turret-rear', 'hull-bottom']);
/** Subsystem of a hit part, else null. */
export const tankSubsystemOf = part => TANK_SUBSYSTEM_IDS.find(id => TANK_SUBSYSTEMS[id].parts.includes(part)) ?? null;

/** Turret pivot (hull frame z); turret boxes are given in the hull frame at zero offset. */
const TURRET_PIVOT_Z = -0.19;
const GLACIS = Object.freeze([0, 0.857, -0.514]), LOWER_PLATE = Object.freeze([0, 0.553, -0.833]);
const CHEEK = 0.7071;
/** Detail boxes in the hull frame ([lo], [hi]); the turret's in its own frame about the pivot. */
const BOXES = Object.freeze([
  Object.freeze({ id: 'tracks-left', lo: [-1.95, 0, -2.6], hi: [-1.0, 0.9, 2.6] }),
  Object.freeze({ id: 'tracks-right', lo: [1.0, 0, -2.6], hi: [1.95, 0.9, 2.6] }),
  Object.freeze({ id: 'tub', lo: [-1.0, 0.35, -2.6], hi: [1.0, 0.9, 2.6] }),
  Object.freeze({ id: 'hull', lo: [-1.95, 0.9, -2.6], hi: [1.95, 1.6, 2.6] }),
  // The turret in the hull frame at zero offset: cheeks to the bustle; the engine deck is aft of it.
  Object.freeze({ id: 'turret', lo: [-1.6, 1.6, -1.9], hi: [1.6, 2.65, 1.6], turret: true }),
]);
/** How far past the collider face a traced plate may lie and still be aimed at (m). */
const DEEP_FACE = 0.8;
/** Where the engine deck starts (hull frame z, aft of the turret ring). */
const ENGINE_DECK_Z = 0.5;

const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = v => { const l = Math.hypot(v[0], v[1], v[2]); return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null; };

/** Turret yaw relative to the hull (radians, + turns the gun left like world yaw). */
function turretOffset(vehicle) {
  const rel = finite(vehicle.turretYaw, finite(vehicle.yaw)) - finite(vehicle.yaw);
  return Math.atan2(Math.sin(rel), Math.cos(rel));
}
/** Hull-frame point or direction into the turret frame (about the pivot for points). */
function toTurret(p, rel, isDir = false) {
  const c = Math.cos(rel), s = Math.sin(rel), x = p[0], z = isDir ? p[2] : p[2] - TURRET_PIVOT_Z;
  return [x * c - z * s, p[1], x * s + z * c + (isDir ? 0 : TURRET_PIVOT_Z)];
}
function fromTurretDir(d, rel) {
  const c = Math.cos(rel), s = Math.sin(rel);
  return [d[0] * c + d[2] * s, d[1], -d[0] * s + d[2] * c];
}

/** Ray entry into an axis-aligned box: { t, axis, sign } of the entry face, else null. */
function enterBox(box, o, d, maxT) {
  let near = -Infinity, far = Infinity, axis = -1, sign = 0;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < box.lo[i] || o[i] > box.hi[i]) return null; continue; }
    const a = (box.lo[i] - o[i]) / d[i], b = (box.hi[i] - o[i]) / d[i];
    const t0 = Math.min(a, b), t1 = Math.max(a, b);
    if (t0 > near) { near = t0; axis = i; sign = a < b ? -1 : 1; }
    far = Math.min(far, t1);
    if (near > far) return null;
  }
  if (axis < 0 || near < 0 || near > maxT) return null;
  return { t: near, axis, sign };
}

/** Part and outward face normal (in the box's own frame) of a face of a detail box at a local point. */
function partOf(box, axis, sign, p) {
  const n = [0, 0, 0]; n[axis] = sign;
  if (box.turret) {
    if (axis === 1) return { part: sign > 0 ? 'turret-top' : 'turret-side', normal: n };
    if (axis === 0) return { part: 'turret-side', normal: n };
    if (sign > 0) return { part: 'turret-rear', normal: n };
    // Arrow-head cheeks either side of the mantlet sweep back 45 degrees.
    return { part: 'turret-front', normal: Math.abs(p[0]) <= 0.4 ? n : [Math.sign(p[0]) * CHEEK, 0, -CHEEK] };
  }
  if (box.id.startsWith('tracks')) {
    if (axis === 1 && sign < 0) return { part: 'hull-bottom', normal: n };
    return { part: 'tracks', normal: n };
  }
  if (axis === 1) {
    if (sign < 0) return { part: 'hull-bottom', normal: n };
    return { part: p[2] > ENGINE_DECK_Z ? 'engine' : 'hull-top', normal: n };
  }
  if (axis === 0) return { part: 'hull-side', normal: n };
  if (sign > 0) return { part: 'hull-rear', normal: n };
  return { part: 'hull-front', normal: box.id === 'tub' ? [...LOWER_PLATE] : [...GLACIS] };
}

/** Nearest detail box face to a hull-frame point (no direction: blasts, probes). */
function nearestFace(local, rel) {
  let best = null;
  for (const box of BOXES) {
    const p = box.turret ? toTurret(local, rel) : local;
    // Distance outside the box (0 inside), then the face the point is closest to.
    const clamped = p.map((v, i) => Math.max(box.lo[i], Math.min(box.hi[i], v)));
    const outside = Math.hypot(p[0] - clamped[0], p[1] - clamped[1], p[2] - clamped[2]);
    let axis = 0, sign = 1, score = -Infinity;
    for (let i = 0; i < 3; i++) {
      const half = (box.hi[i] - box.lo[i]) / 2, centre = (box.hi[i] + box.lo[i]) / 2;
      // Normalised coordinate: the face whose slab the point presses hardest on wins.
      const n = (p[i] - centre) / Math.max(1e-6, half);
      // Running gear and the tub are seen from the side and the ends, never from above.
      const weight = i === 1 && !box.turret && box.id !== 'hull' ? 0.5 : 1;
      if (Math.abs(n) * weight > score) { score = Math.abs(n) * weight; axis = i; sign = n >= 0 ? 1 : -1; }
    }
    if (!best || outside < best.outside - 1e-6) best = { box, axis, sign, point: p, outside };
  }
  const hit = partOf(best.box, best.axis, best.sign, best.point);
  return { ...hit, normal: best.box.turret ? fromTurretDir(hit.normal, rel) : hit.normal };
}

/**
 * Locate a hit on the tank. `point` is a world point on or near the hull (an
 * impact or a blast centre); `dir` the round's world direction, if any. With
 * a direction the ray is traced from 1.5 m back through the detail boxes;
 * the first face it enters is struck. Without one (or when the trace misses
 * the detail boxes inside the collider) the nearest face is taken and the
 * angle counts as square. Returns { part, facing, normal (world), cos, traced,
 * point (world: the struck plate, or `point` itself without a trace) }.
 */
export function locateTankHit(vehicle, point, dir = null) {
  if (!vehicle || !Array.isArray(point) || !point.every(Number.isFinite)) return null;
  const rel = turretOffset(vehicle);
  const local = vehicleWorldToLocal(vehicle, point);
  let localDir = null;
  if (Array.isArray(dir) && dir.every(Number.isFinite)) {
    const tip = vehicleWorldToLocal(vehicle, [point[0] + dir[0], point[1] + dir[1], point[2] + dir[2]]);
    localDir = unit([tip[0] - local[0], tip[1] - local[1], tip[2] - local[2]]);
  }
  let found = null;
  if (localDir) {
    const back = 1.5, origin = local.map((v, i) => v - localDir[i] * back);
    for (const box of BOXES) {
      const o = box.turret ? toTurret(origin, rel) : origin, d = box.turret ? toTurret(localDir, rel, true) : localDir;
      const entry = enterBox(box, o, d, back + 6);
      if (!entry || (found && entry.t >= found.t)) continue;
      const p = o.map((v, i) => v + d[i] * entry.t);
      const hit = partOf(box, entry.axis, entry.sign, p);
      found = { t: entry.t, part: hit.part, normal: box.turret ? fromTurretDir(hit.normal, rel) : hit.normal,
        local: origin.map((v, i) => v + localDir[i] * entry.t) };
    }
  }
  // A face far inside the collider (the round crossed open air beside the turret or over the
  // deck) is not a plate the shooter could see: it takes the hit square-on, never a ricochet.
  const traced = !!found && found.t <= 1.5 + DEEP_FACE;
  const hit = found ?? nearestFace(local, rel);
  const normalWorld = unit(vehicleLocalDirection(vehicle, ...hit.normal)) ?? [0, 1, 0];
  const cos = localDir ? Math.max(0, Math.min(1, -dot(localDir, hit.normal) / (Math.hypot(...hit.normal) || 1))) : 1;
  const struck = traced ? vehicleLocalPoint(vehicle, ...found.local) : [...point];
  return { part: hit.part, facing: TANK_PARTS[hit.part], normal: normalWorld, cos: traced ? cos : Math.max(cos, 0.5), traced, point: struck };
}

const ricochetCos = weapon => Math.cos((TANK_ARMOR_RULES.ricochetDeg[weapon] ?? TANK_ARMOR_RULES.ricochetDeg.default) * Math.PI / 180);

/**
 * Outcome of one hit on the tank: { part, facing, normal, cos, outcome
 * ('pen' | 'nopen' | 'rico'), multiplier, effective }. AT rounds with a
 * direction may ricochet (only on a traced face) or fail to penetrate; HE
 * scales with the part and the angle; every other class keeps the heavy cell
 * of the armour matrix (small arms and MG still do nothing).
 */
export function tankArmorHit(vehicle, point, { dir = null, cls = 'at', weapon = null } = {}) {
  const hit = locateTankHit(vehicle, point, dir);
  if (!hit) return null;
  const armor = TANK_ARMOR[hit.part], base = ARMOR_MATRIX[cls]?.heavy ?? 0;
  let outcome = 'pen', multiplier = base;
  if (cls === 'at') {
    if (dir && hit.traced && hit.cos <= ricochetCos(weapon)) { outcome = 'rico'; multiplier = 0; }
    else {
      const factor = Math.min(1, hit.cos / armor.ratio);
      if (factor < TANK_ARMOR_RULES.noPenFactor) { outcome = 'nopen'; multiplier = base * armor.at * TANK_ARMOR_RULES.spall; }
      else multiplier = base * armor.at * factor;
    }
  } else if (cls === 'he') {
    multiplier = base * armor.he * (TANK_ARMOR_RULES.heBase + TANK_ARMOR_RULES.heSlope * hit.cos);
  }
  const effective = outcome === 'pen' && multiplier >= ARMOR_EFFECTIVE_THRESHOLD;
  return { ...hit, outcome, multiplier, effective };
}

/** Reflect a world velocity off a world normal; the ricochet keeps `ricochetSpeed` of its speed. */
export function ricochetVelocity(velocity, normal, weapon = null) {
  const keep = TANK_ARMOR_RULES.ricochetSpeed[weapon] ?? TANK_ARMOR_RULES.ricochetSpeed.default;
  const along = dot(velocity, normal);
  return velocity.map((v, i) => (v - 2 * along * normal[i]) * keep);
}
