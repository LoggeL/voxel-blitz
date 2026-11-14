/**
 * Rocket artillery truck (Conquest, contract v9): the launcher seat's
 * fire-control rules. The hull is `artillery` (shared/vehicle-defs.js): a
 * driver, a launcher operator and a hatch gunner. The operator lays the pod
 * like the Support's mortar (input yaw = azimuth, input pitch = elevation, the
 * same high-arc math: shared/mortar-rules.js with these ballistics) and cycles
 * two stores on the one pod: six HE rockets or one cluster carrier. Both fly
 * the same arc, so the sight's range holds for either.
 *
 * `indirectFireRules(type, seatId)` answers "is this seat an indirect-fire
 * sight, and with which numbers" for the camera, the controller and the HUD
 * sight: the mortar's operator or the truck's launcher seat.
 */
import { VEHICLE_WEAPON_META } from './conquest-contract.js';
import { MORTAR_RULES, MORTAR_BALLISTICS } from './mortar-rules.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

const META = VEHICLE_WEAPON_META.artyRocket;

/**
 * Elevation 45 degrees (the longest range, ~400 m) to 80 degrees (the
 * shortest, ~135 m): the truck cannot hit what stands next to it. RMB snaps
 * onto the spotted enemy within `snapRadius` m of the aimed impact; the
 * sight's map shows `sightRange` m.
 */
export const ARTILLERY_RULES = freeze({
  type: 'artillery', weapon: 'artyRocket', weapons: ['artyRocket', 'artyCluster'], seat: 'launcher', mount: 'pod',
  minPitch: Math.PI / 4, maxPitch: 80 * Math.PI / 180, restPitch: 1.0,
  speed: META.speed, gravity: META.gravity,
  snapRadius: 60, sightRange: 430,
  // No fire into either HQ: an aimed impact within this many metres of an HQ circle is refused (artilleryTargetRefusal).
  hqPad: 25,
  title: 'ROCKET FIRE-CONTROL', icon: 'artillery', lookScale: 0.35,
});

const MORTAR_SIGHT = freeze({ ...MORTAR_RULES, weapons: [MORTAR_RULES.weapon], ...MORTAR_BALLISTICS,
  title: 'MORTAR FIRE-CONTROL', icon: 'mortar', lookScale: 0.5 });

/**
 * Why the pod may not fire at an aimed impact: `'hq'` inside either HQ's circle
 * plus `hqPad` (the spawn court, the motor pool and the helipads are never
 * shelled from across the map; the comeback call-in's rule), or null. `meta` is
 * mapMeta.conquest (bases).
 */
export function artilleryTargetRefusal(meta, x, z, rules = ARTILLERY_RULES) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  for (const base of Object.values(meta?.bases ?? {})) {
    if (Number.isFinite(base?.x) && Math.hypot(x - base.x, z - base.z) < (base.radius ?? 0) + rules.hqPad) return 'hq';
  }
  return null;
}

/** Flat-ground impact [x, z] of a pod pose { origin, dir } laid at `pitch` (the gate's and the sight's aimed impact). */
export function artilleryFlatImpact(origin, yaw, pitch, rules = ARTILLERY_RULES) {
  const range = rules.speed * rules.speed * Math.sin(2 * pitch) / rules.gravity;
  return [origin[0] - Math.sin(yaw) * range, origin[2] - Math.cos(yaw) * range];
}

/** Fire-control rules of an indirect-fire seat (the mortar's operator, the truck's launcher), or null. */
export function indirectFireRules(type, seatId = null) {
  for (const rules of [MORTAR_SIGHT, ARTILLERY_RULES]) {
    if (rules.type === type && (seatId == null || rules.seat === seatId)) return rules;
  }
  return null;
}
