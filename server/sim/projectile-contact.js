import { rayPlayerHitboxes } from '../../shared/player-hitboxes.js';

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
