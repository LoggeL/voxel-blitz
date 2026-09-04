import { isTrainingDummyId } from '../../../shared/modes.js';

/** Strongest visible enemy in the aim cone, for pad/touch look slowdown. */
export function aimAssistStrength({ players, self, mode, eye, forward, isVisible }) {
  let best = 0;
  for (const row of players) {
    if (row.local || row.id === self?.id || row.state !== 'alive') continue;
    if (self?.team && row.team === self.team) continue;
    if (mode === 'training' && !isTrainingDummyId(row.id)) continue;
    const point = [row.x, row.y + 1.1, row.z];
    const dx = point[0] - eye.x, dy = point[1] - eye.y, dz = point[2] - eye.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.5 || distance > 45) continue;
    const cosine = (dx * forward.x + dy * forward.y + dz * forward.z) / distance;
    const window = (3.2 + Math.min(2.4, distance * 0.05)) * Math.PI / 180;
    const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
    if (angle > window) continue;
    const strength = 1 - angle / window;
    // Reject covered candidates before ranking so they cannot mask a visible one.
    if (strength > best && isVisible(point, row)) best = strength;
  }
  return best;
}
