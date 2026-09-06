import { rayPlayerHitboxes } from '../../shared/player-hitboxes.js';

/** First body touched by a swept projectile, independent of entity insertion order. */
export function sweepPlayers(from, to, radius, entities, canHit) {
  const direction = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const origin = [from.x, from.y, from.z];
  let nearest = null;
  for (const victim of entities.values()) {
    if (!canHit(victim)) continue;
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
