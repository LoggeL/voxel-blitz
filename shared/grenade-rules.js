/** Shared client/server contract for charge-to-distance grenade throws. */
export const GRENADE_PER_LIFE = 2;
export const GRENADE_CHARGE_MS = 1200;
export const GRENADE_FUSE_MS = 2300;
export const GRENADE_MIN_THROW_SPEED = 7;
export const GRENADE_MAX_THROW_SPEED = 16;
export const GRENADE_MIN_LIFT = 2.1;
export const GRENADE_MAX_LIFT = 3.5;

/** One integrator for authority, local prediction, and the throw preview. */
export const GRENADE_PHYSICS = Object.freeze({
  gravity: 18,
  bounce: 0.46,
  floorFriction: 0.82,
  wallDamping: 0.88,
  radius: 0.16,
});

export function clampGrenadeCharge(value) {
  const charge = Number(value);
  return Number.isFinite(charge) ? Math.max(0, Math.min(1, charge)) : 0;
}

export function grenadeThrowProfile(value) {
  const charge = clampGrenadeCharge(value);
  return Object.freeze({
    charge,
    speed: GRENADE_MIN_THROW_SPEED
      + (GRENADE_MAX_THROW_SPEED - GRENADE_MIN_THROW_SPEED) * charge,
    lift: GRENADE_MIN_LIFT + (GRENADE_MAX_LIFT - GRENADE_MIN_LIFT) * charge,
  });
}

/**
 * Launch state for a throw: release point in front of the eye plus a velocity that
 * inherits part of the thrower's body velocity. `dir` is the unit look vector.
 * Returns plain numbers so both the server entity and client prediction can copy them.
 */
export function grenadeLaunch({ x, y, z, eyeY, vx = 0, vy = 0, vz = 0, dir, charge }) {
  const profile = grenadeThrowProfile(charge);
  const d = dir || { x: 0, y: 0, z: -1 };
  return {
    charge: profile.charge,
    x: x + d.x * 0.48,
    y: eyeY - 0.12 + d.y * 0.38,
    z: z + d.z * 0.48,
    vx: d.x * profile.speed + vx * 0.35,
    vy: d.y * profile.speed + profile.lift + vy * 0.2,
    vz: d.z * profile.speed + vz * 0.35,
  };
}

function moveGrenadeAxis(grenade, axis, delta, isSolid) {
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-8) return false;
  const radius = GRENADE_PHYSICS.radius;
  const next = grenade[axis] + delta;
  const x = axis === 'x' ? next + Math.sign(delta) * radius : grenade.x;
  const y = axis === 'y' ? next + Math.sign(delta) * radius : grenade.y;
  const z = axis === 'z' ? next + Math.sign(delta) * radius : grenade.z;
  const blocked = isSolid(x, y, z) || (axis !== 'y' && isSolid(x, y + radius, z));
  if (!blocked) {
    grenade[axis] = next;
    return false;
  }
  grenade['v' + axis] *= -GRENADE_PHYSICS.bounce;
  if (axis !== 'y') grenade['v' + axis] *= GRENADE_PHYSICS.wallDamping;
  return true;
}

/**
 * Advance one grenade `{x,y,z,vx,vy,vz}` by `dt` seconds against `isSolid(x,y,z)` in
 * world coordinates. Mutates and returns the grenade; `hitFloor` reports a floor bounce.
 */
export function stepGrenade(grenade, dt, isSolid) {
  const step = Math.max(0, Number(dt) || 0);
  grenade.vy -= GRENADE_PHYSICS.gravity * step;
  moveGrenadeAxis(grenade, 'x', grenade.vx * step, isSolid);
  moveGrenadeAxis(grenade, 'z', grenade.vz * step, isSolid);
  const hitFloor = moveGrenadeAxis(grenade, 'y', grenade.vy * step, isSolid);
  if (hitFloor && grenade.vy > 0) {
    grenade.vx *= GRENADE_PHYSICS.floorFriction;
    grenade.vz *= GRENADE_PHYSICS.floorFriction;
  }
  grenade.hitFloor = hitFloor;
  return grenade;
}

/**
 * Predicted flight path from a launch state until the fuse burns out. Returns
 * `{points:[[x,y,z],...], landing:[x,y,z], rests:boolean}`; `rests` is true when the
 * grenade has effectively stopped before detonating (a settled, readable landing spot).
 */
export function predictGrenadePath(launch, isSolid, {
  fuseMs = GRENADE_FUSE_MS,
  stepSeconds = 1 / 40,
  maxPoints = 96,
} = {}) {
  const grenade = { x: launch.x, y: launch.y, z: launch.z, vx: launch.vx, vy: launch.vy, vz: launch.vz };
  const points = [[grenade.x, grenade.y, grenade.z]];
  const steps = Math.max(1, Math.ceil((fuseMs / 1000) / stepSeconds));
  const stride = Math.max(1, Math.ceil(steps / (maxPoints - 1)));
  for (let i = 1; i <= steps; i++) {
    stepGrenade(grenade, stepSeconds, isSolid);
    if (i % stride === 0 || i === steps) points.push([grenade.x, grenade.y, grenade.z]);
  }
  const speed = Math.hypot(grenade.vx, grenade.vy, grenade.vz);
  return { points, landing: [grenade.x, grenade.y, grenade.z], rests: speed < 1.5 };
}
