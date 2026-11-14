/**
 * Burst fuse of a cluster carrier (the rocket truck's VEHICLE_WEAPONS.artyCluster
 * `cluster` { height, count, weapon, spread, sink }). ProjectileSystem calls
 * clusterFuse after the carrier's flight step: on the way down, once ground
 * lies within `height` m under it, the carrier bursts (an explode event with no
 * blast of its own) and throws `count` bomblets (`weapon`, ordinary vehicle
 * projectiles of the same owner) outward on a sunflower pattern at up to
 * `spread` m/s, sinking at `sink` m/s. The bomblets keep the share of the
 * carrier's ground speed that carries the pattern's centre onto the carrier's
 * own impact point, and share one salvo id, so they never set each other off
 * in the air. A carrier that hits a wall, a hull or a body first never bursts:
 * it explodes as one warhead.
 */
import { evProjectileExplode } from '../protocol/events.js';
import { VEHICLE_WEAPONS } from '../../shared/vehicle-defs.js';
import { MAX_ACTIVE_PROJECTILES } from './projectiles.js';

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Airburst radius reported with the burst event (presentation only). */
const BURST_RADIUS = 4;

/** Seconds a bomblet released at `sink` m/s needs to fall `height` m under `gravity`. */
export function bombletFallSeconds(height, sink, gravity) {
  if (!(gravity > 0)) return sink > 0 ? height / sink : 0;
  return (-sink + Math.sqrt(sink * sink + 2 * gravity * height)) / gravity;
}

/**
 * Release velocities of the bomblets for a carrier moving at `velocity`
 * ([vx, vy, vz], vy < 0) `height` m over the ground. Deterministic.
 */
export function bombletVelocities(velocity, height, cluster, gravity) {
  const fall = bombletFallSeconds(height, cluster.sink, gravity);
  // Where the carrier would have landed (straight-line descent), reached in the bomblets' fall time.
  const carry = fall > 0 && velocity[1] < 0 ? height / -velocity[1] / fall : 0;
  const out = [];
  for (let i = 0; i < cluster.count; i++) {
    const r = Math.sqrt((i + 0.5) / cluster.count) * cluster.spread, a = i * GOLDEN;
    out.push([velocity[0] * carry + Math.cos(a) * r, -cluster.sink, velocity[2] * carry + Math.sin(a) * r]);
  }
  return out;
}

/** Fuse check for one carrier after its flight step. Returns true when it burst (it is gone from the active set). */
export function clusterFuse(system, projectile, ctx) {
  const cluster = projectile.cluster;
  if (!cluster || !system.active.has(projectile.id) || !(projectile.vy < 0)) return false;
  const ground = projectile.raycast(projectile.x, projectile.y, projectile.z, 0, -1, 0, cluster.height);
  if (!ground) return false;
  // No room for every bomblet (the active projectile cap): the carrier flies on and goes off as one warhead.
  if (system.active.size - 1 + cluster.count > MAX_ACTIVE_PROJECTILES) return false;
  const origin = [projectile.x, projectile.y, projectile.z];
  const height = Number.isFinite(ground.t) ? ground.t : cluster.height;
  const owner = projectile.owner || ctx.entities.get(projectile.ownerId) || null;
  system.active.delete(projectile.id);
  const burst = evProjectileExplode(owner?.id ?? projectile.ownerId, projectile.id, projectile.eventType || projectile.type, origin, BURST_RADIUS);
  burst.vehicleWeapon = projectile.vehicleWeapon;
  burst.burst = 1;
  ctx.pushEvent(burst);
  if (!owner || (typeof ctx.canAffectWorld === 'function' && !ctx.canAffectWorld())) return true;
  const gravity = VEHICLE_WEAPONS[cluster.weapon]?.gravity ?? projectile.gravity;
  for (const velocity of bombletVelocities([projectile.vx, projectile.vy, projectile.vz], height, cluster, gravity)) {
    const speed = Math.hypot(...velocity);
    system.launchVehicleProjectile(owner, { weapon: cluster.weapon, origin, dir: velocity.map(n => n / speed), velocity,
      vehicleId: projectile.vehicleId, salvo: `cluster:${projectile.id}` }, ctx);
  }
  return true;
}
