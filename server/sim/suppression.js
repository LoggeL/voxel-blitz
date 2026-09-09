import { stanceEye } from '../../shared/player-stance.js';
import { PHYSICS } from '../../shared/player-movement.js';
import { SUPPRESSION_RULES, applySuppression } from '../../shared/suppression-rules.js';
import { raycastVoxels } from '../../shared/raycast.js';

// Use the actual stance eye height, including transitions. A fixed standing
// target can otherwise invent a visible point above crouch/prone cover.
function dangerTarget(victim) {
  return [victim.x, victim.y + stanceEye(PHYSICS.eye, victim.crouch, victim.proneT), victim.z];
}

function eligible(owner, victim, ctx) {
  return owner && victim !== owner && victim.id !== owner.id && victim.state === 'alive'
    && !(victim.spawnProtectedUntil > ctx.now) && ctx.canDamage(owner, victim);
}

function visible(origin, target, ctx) {
  const d = target.map((v, i) => v - origin[i]);
  const distance = Math.hypot(...d);
  return distance < 0.001 || !raycastVoxels(
    ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z)), ...origin, ...d, distance);
}

// Called before each contacted voxel is mutated. The finite resolved segment
// and a lateral LOS check prevent a near miss on the other side of cover.
// One map spans all pellets and reflections, so only the closest miss counts.
export function collectNearMisses(owner, origin, end, ctx, candidates = new Map()) {
  const d = end.map((v, i) => v - origin[i]);
  const len2 = d.reduce((sum, v) => sum + v * v, 0);
  if (len2 < 1e-10) return candidates;
  for (const victim of ctx.entities.values()) {
    if (!eligible(owner, victim, ctx)) continue;
    const target = dangerTarget(victim);
    const t = Math.max(0, Math.min(1, target.reduce((sum, v, i) => sum + (v - origin[i]) * d[i], 0) / len2));
    const point = origin.map((v, i) => v + d[i] * t);
    const distance = Math.hypot(...target.map((v, i) => v - point[i]));
    if (distance >= SUPPRESSION_RULES.nearMissRadius || !visible(point, target, ctx)) continue;
    const gain = SUPPRESSION_RULES.nearMissGain * (1 - distance / SUPPRESSION_RULES.nearMissRadius);
    candidates.set(victim, Math.max(candidates.get(victim) || 0, gain));
  }
  return candidates;
}

export function applyNearMisses(candidates, hitVictims, ctx) {
  for (const [victim, gain] of candidates) {
    if (victim.state === 'alive' && !hitVictims?.has(victim)) applySuppression(victim, gain, ctx.now);
  }
}

export function suppressExplosion(owner, origin, radius, hitVictims, ctx) {
  const reach = radius * SUPPRESSION_RULES.blastRadiusMult;
  if (!(reach > 0)) return;
  for (const victim of ctx.entities.values()) {
    if (!eligible(owner, victim, ctx) || hitVictims?.has(victim)) continue;
    const target = dangerTarget(victim);
    const distance = Math.hypot(...target.map((v, i) => v - origin[i]));
    if (distance >= reach || !visible(origin, target, ctx)) continue;
    applySuppression(victim, SUPPRESSION_RULES.blastGain * (1 - distance / reach), ctx.now);
  }
}
