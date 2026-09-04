import { PLAYER_HALF } from '../../shared/combatmath.js';
import { rayAABB } from './combat.js';

/** First body touched by a swept projectile, independent of entity insertion order. */
export function sweepPlayers(from, to, radius, entities, canHit) {
  const direction = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const origin = [from.x, from.y, from.z];
  let nearest = null;
  for (const victim of entities.values()) {
    if (!canHit(victim)) continue;
    // Expand the player's collision box by the projectile's radius. The ray's
    // parameter is a fraction of this segment, so t in [0,1] is in flight.
    const t = rayAABB(origin, direction,
      victim.x - PLAYER_HALF.x - radius, victim.y - radius, victim.z - PLAYER_HALF.x - radius,
      victim.x + PLAYER_HALF.x + radius, victim.y + PLAYER_HALF.h * 2 + radius,
      victim.z + PLAYER_HALF.x + radius);
    if (t === null || t > 1 || (nearest && t >= nearest.t)) continue;
    nearest = {
      victim, t,
      x: from.x + direction.x * t,
      y: from.y + direction.y * t,
      z: from.z + direction.z * t,
    };
  }
  return nearest;
}
