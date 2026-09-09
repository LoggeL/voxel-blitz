import { raycastVoxels } from './raycast.js';
import { rayPlayerHitboxes } from './player-hitboxes.js';

// The inventory/network id remains `limpet` so existing loadouts keep their slot.
export const CLAYMORE_RULES = Object.freeze({
  placementRange: 2.2,
  armMs: 900,
  laserRange: 5,
  surfaceOffset: 0.09,
  laserRadius: 0.025,
  maxPerOwner: 4,
});

/** First visible voxel face in arm's reach. Floors, ceilings and embedded eyes fail. */
export function placeClaymore({ x, eyeY, z, dir }, solidAt) {
  const length = dir && Math.hypot(dir.x, dir.y, dir.z);
  if (![x, eyeY, z, length].every(Number.isFinite) || !(length > 0) || !solidAt) return null;
  const d = [dir.x / length, dir.y / length, dir.z / length];
  const hit = raycastVoxels(solidAt, x, eyeY, z, ...d, CLAYMORE_RULES.placementRange);
  if (!hit || hit.ny !== 0 || Math.abs(hit.nx) + Math.abs(hit.nz) !== 1 || hit.t < 0.15) return null;
  const n = [hit.nx, 0, hit.nz];
  const origin = [x, eyeY, z].map((v, i) => v + d[i] * hit.t + n[i] * CLAYMORE_RULES.surfaceOffset);
  // Keep the housing on the supporting face when aiming at a voxel edge.
  origin[1] = Math.max(hit.y + 0.16, Math.min(hit.y + 0.84, origin[1]));
  const tangent = hit.nx ? 2 : 0;
  const cell = hit.nx ? hit.z : hit.x;
  origin[tangent] = Math.max(cell + 0.24, Math.min(cell + 0.76, origin[tangent]));
  return { type: 'limpet', x: origin[0], y: origin[1], z: origin[2],
    vx: 0, vy: 0, vz: 0, charge: 0, n, mount: [hit.x, hit.y, hit.z] };
}

export function claymoreProfile(level = 0) {
  return { laserRange: CLAYMORE_RULES.laserRange + (level >= 1 ? 2 : 0),
    armMs: level >= 2 ? 450 : CLAYMORE_RULES.armMs };
}

/** The visible beam and the trigger use the same terrain-clipped segment. */
export function claymoreBeam(mine, solidAt) {
  const origin = [mine.x, mine.y, mine.z];
  const range = mine.laserRange ?? CLAYMORE_RULES.laserRange;
  const hit = raycastVoxels(solidAt, ...origin, ...mine.n, range);
  const length = hit ? Math.max(0, hit.t) : range;
  return { origin, end: origin.map((v, i) => v + mine.n[i] * length), length };
}

/** Sweep movement between authority ticks, so a sprint cannot skip a thin laser. */
export function crossesClaymore(beam, player, previous = null) {
  if (beam.length <= 0) return false;
  const direction = { x: beam.end[0] - beam.origin[0], y: beam.end[1] - beam.origin[1],
    z: beam.end[2] - beam.origin[2] };
  const travel = previous ? Math.hypot(player.x - previous.x, player.y - previous.y, player.z - previous.z) : 0;
  // Respawns/teleports do not trace a lethal path across the map.
  const steps = travel > 0 && travel <= 4 ? Math.ceil(travel / 0.1) : 1;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const pose = steps === 1 ? player : { ...player,
      x: previous.x + (player.x - previous.x) * t,
      y: previous.y + (player.y - previous.y) * t,
      z: previous.z + (player.z - previous.z) * t };
    if (pose.x < Math.min(beam.origin[0], beam.end[0]) - 2 || pose.x > Math.max(beam.origin[0], beam.end[0]) + 2
      || pose.y < beam.origin[1] - 3 || pose.y > beam.origin[1] + 1
      || pose.z < Math.min(beam.origin[2], beam.end[2]) - 2 || pose.z > Math.max(beam.origin[2], beam.end[2]) + 2) continue;
    if (rayPlayerHitboxes(beam.origin, direction, pose, 1, { radius: CLAYMORE_RULES.laserRadius })) return true;
  }
  return false;
}
