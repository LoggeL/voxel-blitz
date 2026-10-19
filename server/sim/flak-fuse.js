/**
 * Radar proximity fuse of the mobile AA's 35 mm flak (VEHICLE_WEAPONS.flak35
 * `flak` { proximity, armDistance }). ProjectileSystem calls flakFuse after a
 * shell's flight step with the step's start point: once the shell has flown
 * `armDistance` m, it bursts at its closest approach to an airborne enemy
 * aircraft's hull boxes when that passes within `proximity` m. The burst carries
 * no direct hit: the splash (vehicles.explosion) falls off with the distance
 * from the burst to the nearest hull face, so a near miss hurts less than a
 * graze. Ground hulls, landed aircraft, friendly aircraft and infantry never
 * trigger it; those only take a contact hit or the end-of-life airburst.
 */
import { isAircraftType } from '../../shared/vehicle-defs.js';
import { nearestHullPoint, vehicleHullParts } from '../../shared/vehicle-collision.js';

/** Segment samples are at most this far apart (m), well under the fuse radius. */
const SAMPLE_STEP = 1;

/** Airborne enemy aircraft the fuse looks for. */
export function flakTargets(vehicles, team) {
  const out = [];
  for (const v of vehicles?.values?.() ?? []) {
    if (!(v.hp > 0) || v.grounded !== false || !isAircraftType(v.type)) continue;
    if (team != null && v.team === team) continue;
    out.push(v);
  }
  return out;
}

/**
 * The closest approach along `from`→`to` to one of `targets`' hull boxes,
 * when it lies within `proximity`: { vehicle, point, nearest, distance, t }
 * or null. A shell still closing on a hull at `to` (the nearest point is the
 * segment's end) is not fused yet: it bursts on a later step at its closest
 * approach, or hits the hull outright first.
 */
export function flakTrigger(from, to, targets, proximity) {
  const delta = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(...delta);
  const steps = Math.max(1, Math.ceil(length / SAMPLE_STEP));
  let best = null;
  for (const v of targets) {
    // Cheap reject: the hull's centre far off the whole segment.
    const reach = proximity + 12 + length;
    if (Math.hypot(v.x - to[0], v.y - to[1], v.z - to[2]) > reach) continue;
    const parts = vehicleHullParts(v);
    let closest = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, point = [from[0] + delta[0] * t, from[1] + delta[1] * t, from[2] + delta[2] * t];
      for (const part of parts) {
        const nearest = nearestHullPoint(part, point);
        const distance = Math.hypot(nearest[0] - point[0], nearest[1] - point[1], nearest[2] - point[2]);
        if (!closest || distance < closest.distance) closest = { vehicle: v, point, nearest, distance, t, i };
      }
    }
    if (!closest || closest.distance > proximity || closest.i === steps) continue;
    if (!best || closest.t < best.t) best = closest;
  }
  if (best) delete best.i;
  return best;
}

/**
 * Fuse check for one flak shell after its flight step. Returns true when the
 * shell burst (it is gone from the active set).
 */
export function flakFuse(system, projectile, from, ctx) {
  const flak = projectile.flak;
  if (!flak || !from || !system.active.has(projectile.id)) return false;
  const to = [projectile.x, projectile.y, projectile.z];
  const start = projectile.flakOrigin;
  if (start && Math.hypot(to[0] - start[0], to[1] - start[1], to[2] - start[2]) < flak.armDistance) return false;
  const targets = flakTargets(ctx.vehicles?.vehicles, projectile.flakTeam ?? null);
  if (!targets.length) return false;
  const hit = flakTrigger(from, to, targets, flak.proximity);
  if (!hit) return false;
  [projectile.x, projectile.y, projectile.z] = hit.point;
  projectile.flakBurst = { vehicleId: hit.vehicle.id, distance: hit.distance };
  system.explode(projectile, ctx);
  return true;
}
