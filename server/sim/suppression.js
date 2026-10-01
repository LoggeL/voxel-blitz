import { stanceEye } from '../../shared/player-stance.js';
import { leanEyeOffset } from '../../shared/player-lean.js';
import { PHYSICS } from '../../shared/player-movement.js';
import { SUPPRESSION_RULES, applySuppression } from '../../shared/suppression-rules.js';
import { raycastVoxels } from '../../shared/raycast.js';

// Use the actual stance eye height, including transitions. A fixed standing
// target can otherwise invent a visible point above crouch/prone cover. A
// peek lean carries the eye out past the corner it is leaning around.
function dangerTarget(victim, target) {
  target[0] = victim.x;
  target[1] = victim.y + stanceEye(PHYSICS.eye, victim.crouch, victim.proneT);
  target[2] = victim.z;
  if (victim.leanT) {
    const lean = leanEyeOffset(victim.leanT, victim.yaw || 0, victim.crouch ? 1 : 0);
    target[0] += lean.x;
    target[1] += lean.y;
    target[2] += lean.z;
  }
  return target;
}

function eligible(owner, victim, ctx) {
  return owner && victim !== owner && victim.id !== owner.id && victim.state === 'alive'
    && !(victim.spawnProtectedUntil > ctx.now) && ctx.canDamage(owner, victim);
}

function visible(origin, target, ctx) {
  const dx = target[0] - origin[0], dy = target[1] - origin[1], dz = target[2] - origin[2];
  const distance = Math.hypot(dx, dy, dz);
  return distance < 0.001 || !raycastVoxels(
    ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z)), origin[0], origin[1], origin[2], dx, dy, dz, distance);
}

// Called before each contacted voxel is mutated. The finite resolved segment
// and a lateral LOS check prevent a near miss on the other side of cover.
// One map spans all pellets and reflections, so only the closest miss counts.
export function collectNearMisses(owner, origin, end, ctx, candidates = new Map()) {
  const dx = end[0] - origin[0], dy = end[1] - origin[1], dz = end[2] - origin[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-10) return candidates;
  // These points never escape the query. Reuse them across bodies and pellets
  // instead of allocating several temporary vectors for every nearby player.
  const target = [0, 0, 0], point = [0, 0, 0];
  for (const victim of ctx.entities.values()) {
    if (!eligible(owner, victim, ctx)) continue;
    dangerTarget(victim, target);
    const t = Math.max(0, Math.min(1, ((target[0] - origin[0]) * dx
      + (target[1] - origin[1]) * dy + (target[2] - origin[2]) * dz) / len2));
    point[0] = origin[0] + dx * t;
    point[1] = origin[1] + dy * t;
    point[2] = origin[2] + dz * t;
    const distance = Math.hypot(target[0] - point[0], target[1] - point[1], target[2] - point[2]);
    if (distance >= SUPPRESSION_RULES.nearMissRadius) continue;
    const gain = SUPPRESSION_RULES.nearMissGain * (1 - distance / SUPPRESSION_RULES.nearMissRadius);
    // A weaker pellet cannot change the accumulated closest miss, even when
    // earlier pellets have just opened a hole in the cover.
    if (gain <= (candidates.get(victim) || 0) || !visible(point, target, ctx)) continue;
    candidates.set(victim, gain);
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
  const target = [0, 0, 0];
  for (const victim of ctx.entities.values()) {
    if (!eligible(owner, victim, ctx) || hitVictims?.has(victim)) continue;
    dangerTarget(victim, target);
    const distance = Math.hypot(target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]);
    if (distance >= reach || !visible(origin, target, ctx)) continue;
    applySuppression(victim, SUPPRESSION_RULES.blastGain * (1 - distance / reach), ctx.now);
  }
}
