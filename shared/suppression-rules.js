// Ambient danger is brief and bounded; repeated misses habituate faster than
// they can replenish panic. Actual injuries use the separate damage rules.
export const SUPPRESSION_RULES = Object.freeze({
  nearMissRadius: 1.5,
  nearMissGain: 0.12,
  blastRadiusMult: 1.6,
  blastGain: 0.24,
  panicCap: 0.35,
  budget: 0.3,
  refillPerSecond: 0.025,
  intervalMs: 450,
});

export function applySuppression(victim, amount, now) {
  const r = SUPPRESSION_RULES;
  if (!(amount > 0) || !Number.isFinite(now)) return 0;
  const elapsed = victim.suppressionAt == null ? 0 : Math.max(0, now - victim.suppressionAt) / 1000;
  victim.suppressionBudget = Math.min(r.budget,
    (victim.suppressionBudget ?? r.budget) + elapsed * r.refillPerSecond);
  victim.suppressionAt = now;
  if (victim.suppressionGainAt != null && now - victim.suppressionGainAt < r.intervalMs) return 0;
  const gain = Math.max(0, Math.min(amount, victim.suppressionBudget, r.panicCap - (victim.panic || 0)));
  if (gain <= 0) return 0;
  victim.panic = (victim.panic || 0) + gain;
  victim.suppressionBudget -= gain;
  victim.suppressionGainAt = now;
  return gain;
}
