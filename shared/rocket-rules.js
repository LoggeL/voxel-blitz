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
  splashDamage: 96,
  damageRadius: 4.8,
  selfDamage: 0.55,
  /** Rocket jumps: the owner is launched harder than bystanders. */
  knockback: 11,
  selfKnockback: 15.5,
  terrainRadius: 3.1,
  terrainPower: 145,
  maxDestroyedBlocks: 80,
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
 */
export function stepRocket(rocket, dt, raycast) {
  const step = Math.max(0, Number(dt) || 0);
  rocket.vy -= ROCKET_RULES.gravity * step;
  const dx = rocket.vx * step;
  const dy = rocket.vy * step;
  const dz = rocket.vz * step;
  const length = Math.hypot(dx, dy, dz);
  rocket.hit = null;
  if (length < 1e-6) return rocket;
  const hit = raycast(rocket.x, rocket.y, rocket.z, dx / length, dy / length, dz / length,
    length + ROCKET_RULES.radius);
  if (hit) {
    const t = Math.max(0, hit.t - ROCKET_RULES.radius * 0.5);
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
