/**
 * SB-1 SUDSBLASTER: one charge-interpolated flight and blast contract shared by the
 * authoritative simulation, the local prediction, remote presentation, bots, the HUD
 * rise ladder and the TTK simulator. Original design; see docs/weapon-design/bubble.md.
 *
 * Flight: velocity relaxes exponentially toward (0, +rise, 0) at rate `drag`. The step
 * is the exact solution for any dt, so server ticks, client frames and closed forms agree.
 */
const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

export const BUBBLE_RULES = Object.freeze({
  /** Tap endpoint (charge 0): the Soap Shot. 3 direct hits kill (3 x 33.6). */
  small: Object.freeze({
    speed: 24, drag: 1.2, rise: 3.0, radius: 0.24, lifetimeMs: 2200,
    directDamage: 16, splashDamage: 26, damageRadius: 2.2, damageFalloffExponent: 1.0,
    knockback: 3.5, selfKnockback: 2.0, knockbackRadius: 2.8, concussMs: 500,
  }),
  /** Full-hold endpoint (charge 1): the Big Bubble. Control, shove, movement. */
  big: Object.freeze({
    speed: 13, drag: 1.0, rise: 1.4, radius: 0.60, lifetimeMs: 4200,
    directDamage: 20, splashDamage: 50, damageRadius: 4.2, damageFalloffExponent: 0.9,
    knockback: 13, selfKnockback: 8, knockbackRadius: 4.6, concussMs: 1800,
  }),
  /** mix = charge01^2: short taps stay on the small endpoint. */
  chargeCurve: 2,
  knockbackFalloff: 0.65,
  selfDamage: 0,
  muzzleForward: 0.55,
  muzzleDrop: 0.16,
  /** Horizontal body half-width used by the closed-form contact distance. */
  bodyHalfWidth: 0.32,
  /** Live non-child bubbles per owner; the oldest airbursts when exceeded. */
  maxPerOwner: 16,
  /** Must equal MOVEMENT_RULES.concussedSpeedMult (shared/player-movement.js). */
  soakSpeedMult: 0.6,
  /** Chaos 1 "Double bubble": free twin per trigger pull, alternating side. */
  twin: Object.freeze({ yawRad: 0.14 }),
  /** Chaos 2 "Clingfilm": wall/ceiling contact sticks as a proximity mine. */
  cling: Object.freeze({ ms: 5000, perOwner: 8, reachSmall: 1.4, reachBig: 2.2 }),
  /** Chaos 3 "Foam party": every non-child pop scatters mini bubbles. */
  foam: Object.freeze({
    count: 5, speed: 6, up: 1.5, drag: 1.2, rise: 3.0, radius: 0.18, lifetimeMs: 900, stepMs: 60,
    directDamage: 5, splashDamage: 9, damageRadius: 2.0, damageFalloffExponent: 1.0,
    knockback: 2.5, selfKnockback: 0, knockbackRadius: 2.4, concussMs: 500,
  }),
  color: '#9fe9ff',
});

const LERPED = Object.freeze(['speed', 'drag', 'rise', 'radius', 'lifetimeMs', 'directDamage',
  'splashDamage', 'damageRadius', 'damageFalloffExponent', 'knockback', 'selfKnockback',
  'knockbackRadius', 'concussMs']);

export function bubbleMix(charge01 = 0) {
  return clamp01(charge01) ** BUBBLE_RULES.chargeCurve;
}

/** Flight + blast profile for a charge in [0, 1]. `child` returns the Foam-party mini. */
export function bubbleProfile(charge01 = 0, child = false) {
  if (child) {
    const f = BUBBLE_RULES.foam;
    return { mix: 0, speed: f.speed, drag: f.drag, rise: f.rise, radius: f.radius,
      lifetimeMs: f.lifetimeMs, directDamage: f.directDamage, splashDamage: f.splashDamage,
      damageRadius: f.damageRadius, damageFalloffExponent: f.damageFalloffExponent,
      knockback: f.knockback, selfKnockback: f.selfKnockback, knockbackRadius: f.knockbackRadius,
      concussMs: f.concussMs };
  }
  const mix = bubbleMix(charge01);
  const { small, big } = BUBBLE_RULES;
  const out = { mix };
  for (const key of LERPED) out[key] = small[key] + (big[key] - small[key]) * mix;
  return out;
}

/** Generic-explode blast rules for one profile (terrain-safe, never hurts its owner). */
export function bubbleBlastRules(profile) {
  return {
    id: 'bubble', name: 'SB-1 SUDSBLASTER', fuseMs: profile.lifetimeMs,
    damage: profile.splashDamage, directDamage: profile.directDamage,
    damageRadius: profile.damageRadius, damageFalloffExponent: profile.damageFalloffExponent,
    selfDamage: BUBBLE_RULES.selfDamage, knockback: profile.knockback,
    selfKnockback: profile.selfKnockback, knockbackRadius: profile.knockbackRadius,
    knockbackFalloff: BUBBLE_RULES.knockbackFalloff,
    terrainRadius: 0, terrainPower: 0, maxDestroyedBlocks: 0,
    concussMs: profile.concussMs, concussPanic: 0,
  };
}

/**
 * Launch state leaving the wand ring. `raycast` (optional, the shared DDA) clamps the
 * spawn in front of a wall hugged at point blank; `blocked` then asks for an immediate pop.
 */
export function bubbleLaunch({ x, y, z, dir, charge01 = 0, child = false, raycast = null }) {
  const d = dir || { x: 0, y: 0, z: -1 };
  const p = bubbleProfile(charge01, child);
  const oy = y - BUBBLE_RULES.muzzleDrop;
  let reach = BUBBLE_RULES.muzzleForward;
  let blocked = false;
  if (raycast) {
    const hit = raycast(x, oy, z, d.x, d.y, d.z, reach + p.radius);
    if (hit) { reach = Math.max(0, hit.t - p.radius); blocked = true; }
  }
  return {
    type: 'bubble',
    x: x + d.x * reach, y: oy + d.y * reach, z: z + d.z * reach,
    vx: d.x * p.speed, vy: d.y * p.speed, vz: d.z * p.speed,
    drag: p.drag, rise: p.rise, radius: p.radius, lifetimeMs: p.lifetimeMs,
    charge: clamp01(charge01), child: !!child, blocked,
  };
}

/**
 * Advance one bubble `{x,y,z,vx,vy,vz,drag,rise,radius}` by `dt` seconds (exact solution),
 * then sweep the moved segment. The first solid voxel stops it one radius short and
 * reports `hit` `{x,y,z,nx,ny,nz,t}` (voxel cell + face normal from the shared DDA).
 */
export function stepBubble(b, dt, raycast) {
  const step = Math.max(0, Number(dt) || 0);
  const k = b.drag;
  const e = Math.exp(-k * step);
  const g = k > 0 ? (1 - e) / k : step;
  const dx = b.vx * g;
  const dz = b.vz * g;
  const dy = b.rise * step + (b.vy - b.rise) * g;
  b.vx *= e;
  b.vz *= e;
  b.vy = b.rise + (b.vy - b.rise) * e;
  b.hit = null;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return b;
  const hit = raycast(b.x, b.y, b.z, dx / length, dy / length, dz / length, length + b.radius);
  if (hit) {
    const t = Math.min(length, Math.max(0, hit.t - b.radius));
    b.x += (dx / length) * t;
    b.y += (dy / length) * t;
    b.z += (dz / length) * t;
    b.hit = { x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz, t };
    return b;
  }
  b.x += dx;
  b.y += dy;
  b.z += dz;
  return b;
}

/**
 * Closed form for a level launch at a body `distance` metres away (eye to body axis):
 * flight time to contact and the rise above the launch point. Null when out of reach.
 */
export function bubbleFlight(profile, distance, launchVy = 0) {
  const s = distance - BUBBLE_RULES.muzzleForward - profile.radius - BUBBLE_RULES.bodyHalfWidth;
  if (s <= 0) return { t: 0, rise: 0 };
  const u = 1 - (s * profile.drag) / profile.speed;
  if (u <= 0) return null;
  const t = -Math.log(u) / profile.drag;
  if (t * 1000 > profile.lifetimeMs) return null;
  const rise = profile.rise * t + (launchVy - profile.rise) * (1 - Math.exp(-profile.drag * t)) / profile.drag;
  return { t, rise };
}

/** HUD rise ladder / bot aim: radians to aim BELOW the target so the bubble arrives on it. */
export function bubbleAimDrop(profile, distance) {
  const f = bubbleFlight(profile, distance);
  return f ? Math.atan2(f.rise - BUBBLE_RULES.muzzleDrop, distance) : null;
}

/** Horizontal reach of a level shot before the lifetime pop. */
export function bubbleMaxRange(profile) {
  return profile.speed / profile.drag * (1 - Math.exp(-profile.drag * profile.lifetimeMs / 1000));
}
