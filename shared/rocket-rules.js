/**
 * Shared client/server contract for the RX-8 HAVOC rocket: one launch formula and one
 * flight integrator so the local prediction, the remote presentation, and the
 * authoritative simulation all fly the identical projectile.
 */
export const ROCKET_RULES = Object.freeze({
  speed: 42,
  gravity: 2.4,
  radius: 0.18,
  /** Self-destruct after this long in flight (map edge or open sky). */
  lifetimeMs: 4000,
  /** Direct body hit: flat damage before the splash is added. */
  directDamage: 100,
  splashDamage: 130,
  damageRadius: 7.5,
  /** Mild power curve: (1 - distance / radius)^exponent, zero at the edge. */
  damageFalloffExponent: 1.15,
  selfDamage: 0.55,
  /** Rocket jumps: the owner is launched harder than bystanders. */
  knockback: 34,
  selfKnockback: 44,
  /** Pressure keeps its own reach so splash tuning does not alter rocket jumps. */
  knockbackRadius: 4.8,
  knockbackFalloff: 0.65,
  terrainRadius: 4.4,
  terrainPower: 210,
  maxDestroyedBlocks: 180,
  color: '#ff9f1c',
});

/**
 * Launch state for a rocket leaving the tube: a muzzle point just ahead of and below the
 * eye plus a straight velocity along the (already spread-sampled) unit `dir`.
 */
export function rocketLaunch({ x, y, z, dir }) {
  const d = dir || { x: 0, y: 0, z: -1 };
  return {
    type: 'rocket',
    x: x + d.x * 0.55,
    y: y - 0.16 + d.y * 0.55,
    z: z + d.z * 0.55,
    vx: d.x * ROCKET_RULES.speed,
    vy: d.y * ROCKET_RULES.speed,
    vz: d.z * ROCKET_RULES.speed,
  };
}

/**
 * Advance one rocket `{x,y,z,vx,vy,vz}` by `dt` seconds. Rockets never bounce: the first
 * solid voxel along the swept segment stops them and reports `hit` `{x,y,z,t}` in world
 * coordinates (the point just before the contact). `raycast` is the shared DDA.
 * Vehicle shells and missiles carry their own `gravity` (VEHICLE_WEAPON_META.gravity,
 * also published as `g` on their projectileLaunch event); the RX-8 uses the default.
 */
export function stepRocket(rocket, dt, raycast) {
  const step = Math.max(0, Number(dt) || 0);
  rocket.vy -= (Number.isFinite(rocket.gravity) ? rocket.gravity : ROCKET_RULES.gravity) * step;
  const dx = rocket.vx * step;
  const dy = rocket.vy * step;
  const dz = rocket.vz * step;
  const length = Math.hypot(dx, dy, dz);
  rocket.hit = null;
  if (length < 1e-6) return rocket;
  const hit = raycast(rocket.x, rocket.y, rocket.z, dx / length, dy / length, dz / length,
    length + ROCKET_RULES.radius);
  if (hit) {
    const t = Math.min(length, Math.max(0, hit.t - ROCKET_RULES.radius * 0.5));
    rocket.x += (dx / length) * t;
    rocket.y += (dy / length) * t;
    rocket.z += (dz / length) * t;
    rocket.hit = { x: hit.x, y: hit.y, z: hit.z, t };
    return rocket;
  }
  rocket.x += dx;
  rocket.y += dy;
  rocket.z += dz;
  return rocket;
}

/* ------------------------------------------------------------ launcher sight */

/** Muzzle offset of `rocketLaunch`: ahead along the aim and below the eye (m). */
const LAUNCH_FORWARD = 0.55;
const LAUNCH_DROP = 0.16;
/** Authoritative flight step: the server flies a rocket once per 60 Hz tick. */
export const ROCKET_FLIGHT_STEP_S = 1 / 60;

/**
 * RX-8 factory sight: the drop ladder ranges (only those the rocket reaches are
 * drawn), the rangefinder's reach, its refresh cadence and its memory.
 */
export const ROCKET_SIGHT = Object.freeze({
  ranges: Object.freeze([50, 100, 150, 200]),
  rangefinderMaxM: 300,
  sampleMs: 100,
  /** A held-over aim often looks past the target: the last return stays up (marked held) this long. */
  memoryMs: 3000,
});

/**
 * Height (m) of the rocket relative to the eye's level line when it has flown
 * `rangeM` metres horizontally after leaving the tube at `pitch` radians above
 * level, and the flight time. Matches `rocketLaunch` + `stepRocket` (the
 * semi-implicit step adds g·t·dt/2 of drop over the analytic parabola).
 */
export function rocketHeightAt(pitch, rangeM, { speed = ROCKET_RULES.speed, gravity = ROCKET_RULES.gravity,
  step = ROCKET_FLIGHT_STEP_S } = {}) {
  const c = Math.cos(pitch), s = Math.sin(pitch);
  const t = (rangeM - LAUNCH_FORWARD * c) / (speed * c);
  const y = -LAUNCH_DROP + LAUNCH_FORWARD * s + speed * s * t - 0.5 * gravity * t * (t + step);
  return { y, t };
}

/**
 * Sight elevation (radians above the line of sight) that puts the rocket on a
 * target `rangeM` metres away on a level line, or null when the rocket burns
 * out (lifetimeMs) first. Bisection over the monotonic low-angle branch.
 */
export function rocketElevation(rangeM, options = {}) {
  if (!(rangeM > LAUNCH_FORWARD)) return 0;
  let lo = -0.2, hi = 0.6;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (rocketHeightAt(mid, rangeM, options).y < 0) lo = mid; else hi = mid;
  }
  const pitch = (lo + hi) / 2;
  const { t } = rocketHeightAt(pitch, rangeM, options);
  return t <= (options.lifetimeMs ?? ROCKET_RULES.lifetimeMs) / 1000 ? pitch : null;
}

/** Farthest level-line range (m) the rocket reaches before its self-destruct. */
export function rocketReachM(options = {}) {
  let lo = 1, hi = 1000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (rocketElevation(mid, options) == null) hi = mid; else lo = mid;
  }
  return lo;
}

/**
 * Holdover marks for the launcher sight: `mil` is the screen offset below the
 * aim point in milliradians (1000·tan(elevation), so the marks scale with the
 * same --scope-mil as every first-focal-plane reticle) and `dropM` the fall
 * below the sight line a centre hold would leave at that range.
 */
export function rocketSightMarks(ranges = ROCKET_SIGHT.ranges, options = {}) {
  const marks = [];
  for (const range of ranges) {
    const pitch = rocketElevation(range, options);
    if (pitch == null) continue;
    marks.push({ range, mil: 1000 * Math.tan(pitch), dropM: -rocketHeightAt(0, range, options).y,
      flightS: rocketHeightAt(pitch, range, options).t });
  }
  return marks;
}
