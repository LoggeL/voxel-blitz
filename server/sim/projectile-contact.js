import { pointPlayerDistance, rayPlayerHitboxes } from '../../shared/player-hitboxes.js';

/** First body touched by a swept projectile, independent of entity insertion order. */
export function sweepPlayers(from, to, radius, entities, canHit) {
  const direction = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const origin = [from.x, from.y, from.z];
  const reach = 3 + radius;
  const minX = Math.min(from.x, to.x) - reach, maxX = Math.max(from.x, to.x) + reach;
  const minY = Math.min(from.y, to.y) - reach, maxY = Math.max(from.y, to.y) + reach;
  const minZ = Math.min(from.z, to.z) - reach, maxZ = Math.max(from.z, to.z) + reach;
  let nearest = null;
  for (const victim of entities.values()) {
    if (!canHit(victim)) continue;
    // Conservative envelope around the feet covers every animated combat pose.
    // Reject distant segments before building and intersecting eleven body boxes.
    if (victim.x < minX || victim.x > maxX
      || victim.y < minY || victim.y > maxY
      || victim.z < minZ || victim.z > maxZ) continue;
    const hit = rayPlayerHitboxes(origin, direction, victim, 1, { radius });
    if (!hit || (nearest && hit.t >= nearest.t)) continue;
    const { t, zone } = hit;
    nearest = {
      victim, t, zone,
      x: from.x + direction.x * t,
      y: from.y + direction.y * t,
      z: from.z + direction.z * t,
    };
  }
  return nearest;
}

/** Sphere contact against the same body zones used by hitscan and bolts. */
export function touchesPlayer(point, radius, victim) {
  // Proximity bubbles ask this for every living player on every tick. Reject
  // distant bodies before constructing their articulated boxes. The 3 m feet
  // envelope is conservative across poses; scaled bodies scale it as well.
  // Static objectives use their explicit box, whose centre is above the feet.
  const scale = Number.isFinite(victim.bodyScale) && victim.bodyScale > 0 ? victim.bodyScale : 1;
  const box = victim.combatBox;
  // Leave tangencies to the exact test despite floating-point reassociation.
  const reach = radius + 1e-9;
  const x = (box ? box[0] : 3 * scale) + reach;
  const y = (box ? box[1] : 3 * scale) + reach;
  const z = (box ? box[2] : 3 * scale) + reach;
  if (Math.abs(point.x - victim.x) > x
    || Math.abs(point.y - (victim.y + (box ? box[1] : 0))) > y
    || Math.abs(point.z - victim.z) > z) return false;
  return pointPlayerDistance([point.x, point.y, point.z], victim) <= radius;
}
