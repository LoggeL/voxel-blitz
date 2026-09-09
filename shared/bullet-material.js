import { BLOCK_HARDNESS } from './world/blocks.js';

export const BULLET_RULES = Object.freeze({ maxContacts: 48, maxRicochets: 2, epsilon: 0.001 });

export function bulletPower(def, charge = 1) {
  const power = Math.max(0, Number(def.penetration) || 0);
  // A tapped rail can punch soft cover; full charge can tunnel through masonry.
  return power * (def.mode === 'charge' ? 0.08 + 0.92 * Math.max(0, Math.min(1, charge)) ** 2 : 1);
}

/** One deterministic material contact. Energy only decreases, even on a breaking hit. */
export function bulletMaterialImpact({ type, power, damage, hp, incidence = 1, thickness = 1, bounces = 0 }) {
  const hardness = BLOCK_HARDNESS[type];
  if (!Number.isFinite(hardness) || !(hardness > 0) || !(power > 0) || !(damage > 0)) {
    return { damage: 0, power: 0, damageScale: 0, action: 'stop' };
  }
  const angle = Math.max(0, Math.min(1, incidence));
  const resistance = hardness * Math.max(0.2, thickness) / Math.max(0.35, angle);
  // Shallow strikes glance off hard surfaces when the normal component cannot bite.
  const ricochet = hardness >= 50 && angle > 0 && angle < 0.3 &&
    power * angle < hardness && bounces < BULLET_RULES.maxRicochets;
  const blockDamage = damage * Math.max(0.04, Math.min(2.5, power / resistance)) * (ricochet ? 0.2 : 1);
  const destroyed = blockDamage >= hp;
  if (ricochet && !destroyed) {
    const remaining = Math.max(0, power * 0.55 - hardness * 0.08);
    return { damage: blockDamage, power: remaining, damageScale: remaining / power * 0.7,
      action: remaining > 1 ? 'ricochet' : 'stop' };
  }
  // Fracturing an already weakened block costs only the work needed to break it.
  const cost = destroyed ? resistance * Math.max(0.1, Math.min(1, hp / blockDamage)) : resistance;
  const remaining = Math.max(0, power - cost);
  return { damage: blockDamage, power: remaining,
    damageScale: remaining / power * 0.9,
    action: remaining > 1 ? 'penetrate' : 'stop' };
}

/** Absolute ray distance to the far face, including oblique paths and corner hits. */
export function voxelExitDistance(origin, direction, hit) {
  let exit = Infinity;
  for (const [index, axis] of ['x', 'y', 'z'].entries()) {
    const d = direction[axis];
    if (d > 0) exit = Math.min(exit, (hit[axis] + 1 - origin[index]) / d);
    else if (d < 0) exit = Math.min(exit, (hit[axis] - origin[index]) / d);
  }
  return Number.isFinite(exit) ? Math.max(hit.t, exit) : hit.t;
}
