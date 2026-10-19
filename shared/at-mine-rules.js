import { raycastVoxels } from './raycast.js';

/**
 * Conquest anti-vehicle mine (the Engineer's AT MINE, pouch type `atmine`).
 * Pure placement and hitbox rules shared by the authority
 * (server/sim/projectiles.js) and the client presentation; the hull trigger
 * (vehicle frames) lives in shared/at-mine-trigger.js, off the boot path. Balance lives here
 * and in GRENADE_TYPES.atmine (the infantry blast); docs/conquest.md "AT mines".
 *
 * - Placed, never thrown: on the floor face under the crosshair within
 *   `placementRange`, else dropped onto the floor `dropReach` ahead.
 * - Arms after `armMs`; a live mine detonates only under a live enemy ground
 *   hull (wheeled or tracked handling). Infantry, aircraft, wrecks and friendly
 *   hulls never set it off.
 * - The belly charge deals `hullDamage` of class `hullCls` from below (the
 *   tank's `hull-bottom` plate, AT x1.5: 600 of 1000 HP and disabled; a jeep
 *   dies), on top of the GRENADE_TYPES.atmine splash.
 * - At most `maxPerOwner` live mines per player: a new one removes the oldest.
 *   Mines outlive their owner's death and vanish when the owner leaves.
 */
export const AT_MINE_RULES = Object.freeze({
  /** Aimed placement reach, eye to floor face (m). */
  placementRange: 3,
  /** Looking ahead (no floor under the crosshair): drop point distance ahead of the eye (m). */
  dropReach: 1.2,
  /** How far below the drop point a floor may lie (m). */
  dropDepth: 2.6,
  /** Disc centre above the floor face (half the 0.12 m body). */
  surfaceOffset: 0.06,
  armMs: 1500,
  maxPerOwner: 3,
  /** Belly charge on the hull above the mine. */
  hullDamage: 400,
  hullCls: 'at',
  /** Footprint slack around the hull collider, and the hull-local height band that counts as "over it" (m). */
  footprintMargin: 0.15,
  triggerBelow: -0.8,
  triggerAbove: 1.2,
  /** Shot/collision box half extents (x, y, z) of the 0.48 x 0.12 m disc. */
  half: Object.freeze([0.24, 0.07, 0.24]),
});

/** Hull handling that sets off an AT mine: ground hulls, never aircraft or walkers. */
export const AT_MINE_TRIGGER_HANDLING = Object.freeze(['wheeled', 'tracked']);

function onFloor(solidAt, hit, x, z) {
  // Below-world counts as a floor for the ray; never for a mine (its mount must be a real voxel).
  if (!hit || hit.ny !== 1 || hit.y < 0) return null;
  // The disc needs open air above its voxel.
  if (solidAt(hit.x, hit.y + 1, hit.z)) return null;
  const px = Math.max(hit.x + 0.26, Math.min(hit.x + 0.74, x));
  const pz = Math.max(hit.z + 0.26, Math.min(hit.z + 0.74, z));
  return { type: 'atmine', x: px, y: hit.y + 1 + AT_MINE_RULES.surfaceOffset, z: pz,
    vx: 0, vy: 0, vz: 0, charge: 0, n: [0, 1, 0], mount: [hit.x, hit.y, hit.z] };
}

/**
 * Placement of an AT mine from the eye along `dir`: the floor face under the
 * crosshair in reach, else the floor below a point `dropReach` ahead (the eye
 * must see that point). Null when there is no floor to lay it on.
 */
export function placeAtMine({ x, eyeY, z, dir }, solidAt) {
  const length = dir && Math.hypot(dir.x, dir.y, dir.z);
  if (![x, eyeY, z, length].every(Number.isFinite) || !(length > 0) || !solidAt) return null;
  const d = [dir.x / length, dir.y / length, dir.z / length];
  const aimed = raycastVoxels(solidAt, x, eyeY, z, ...d, AT_MINE_RULES.placementRange);
  if (aimed && aimed.ny === 1 && aimed.t >= 0.3) {
    return onFloor(solidAt, aimed, x + d[0] * aimed.t, z + d[2] * aimed.t);
  }
  const flat = Math.hypot(d[0], d[2]);
  if (flat < 0.2) return null;
  const ax = x + d[0] / flat * AT_MINE_RULES.dropReach;
  const az = z + d[2] / flat * AT_MINE_RULES.dropReach;
  const ay = eyeY - 0.4;
  const reach = Math.hypot(ax - x, ay - eyeY, az - z);
  if (raycastVoxels(solidAt, x, eyeY, z, ax - x, ay - eyeY, az - z, reach)) return null;
  return onFloor(solidAt, raycastVoxels(solidAt, ax, ay, az, 0, -1, 0, AT_MINE_RULES.dropDepth), ax, az);
}

/** Ray entry distance into the mine's disc box, or null (slab test; `radius` pads the box). */
export function rayAtMine(mine, origin, direction, limit, minT = 0, radius = 0) {
  let near = minT, far = limit;
  for (const [i, axis] of ['x', 'y', 'z'].entries()) {
    const extent = AT_MINE_RULES.half[i] + radius, delta = mine[axis] - origin[i], d = direction[axis];
    if (Math.abs(d) < 1e-10) {
      if (Math.abs(delta) > extent) return null;
      continue;
    }
    const a = (delta - extent) / d, b = (delta + extent) / d;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return near < limit ? near : null;
}
