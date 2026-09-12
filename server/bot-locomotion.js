import { PHYSICS, boxCollides, solidBelow, findVault } from '../shared/player-movement.js';

/** Check the movement direction, obstacle height and full standing body.
 * A knee-height hit alone also detects walls far beyond jump/vault reach. */
export function canHopObstacle(solidAt, p, input) {
  const forward = Number(!!input.keys.f) - Number(!!input.keys.b);
  const side = Number(!!input.keys.r) - Number(!!input.keys.l);
  const length = Math.hypot(forward, side);
  if (!length) return false;
  const sin = Math.sin(input.yaw), cos = Math.cos(input.yaw);
  const dx = (-sin * forward + cos * side) / length;
  const dz = (-cos * forward - sin * side) / length;
  const ahead = { x: p.x + dx * 0.95, y: p.y, z: p.z + dz * 0.95 };
  if (!boxCollides(solidAt, ahead.x, ahead.y, ahead.z)) return false;
  if (forward > 0 && findVault(solidAt, p, { x: dx, z: dz }, p.y, input.yaw)) return true;

  // Normal jumps clear one voxel. Check headroom through the apex and
  // supported space on top, including both shoulders along the approach.
  const top = Math.floor(p.y + 0.1) + 1;
  const apex = p.y + PHYSICS.jump ** 2 / (2 * PHYSICS.gravity);
  if (top > apex || !solidBelow(solidAt, ahead.x, top, ahead.z)) return false;
  for (let y = p.y; y <= apex; y += 0.1) {
    if (boxCollides(solidAt, p.x, y, p.z)) return false;
  }
  for (let step = 0; step <= 10; step++) {
    const t = step / 10, x = p.x + (ahead.x - p.x) * t, z = p.z + (ahead.z - p.z) * t;
    if (boxCollides(solidAt, x, apex, z) || boxCollides(solidAt, x, top, z)) return false;
  }
  return true;
}
