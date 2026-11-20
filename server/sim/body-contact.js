import { combatHitboxes } from '../../shared/player-hitboxes.js';
import { raycastVoxels } from '../../shared/raycast.js';

// Expanding the hit volume can reach past cover. Return a point on the actual
// body that lies within the field and is visible from its damage source.
export function visibleBodyContact(center, victim, radius, origin, solidAt) {
  for (const box of combatHitboxes(victim)) {
    const offset = center.map((v, i) => v - box.center[i]);
    const local = box.basis.map(axis => axis.reduce((sum, v, i) => sum + v * offset[i], 0));
    const clamped = local.map((v, i) => Math.max(-box.half[i], Math.min(box.half[i], v)));
    const point = box.center.map((v, i) => v + clamped.reduce((sum, n, j) => sum + n * box.basis[j][i], 0));
    if (Math.hypot(...point.map((v, i) => v - center[i])) > radius + 1e-6) continue;
    const delta = point.map((v, i) => v - origin[i]);
    if (!raycastVoxels(solidAt, ...origin, ...delta, Math.hypot(...delta))) return point;
  }
  return null;
}
