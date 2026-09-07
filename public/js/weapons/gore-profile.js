const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** Keep the impact position while a death event supplies authoritative damage. */
export function withGoreDamage(impact, damage) {
  if (!damage || !Number.isFinite(damage.overkill)) return impact;
  return { ...impact, overkill: Math.max(0, damage.overkill),
    ...(Number.isFinite(damage.healthDamage) ? { healthDamage: Math.max(0, damage.healthDamage) } : {}) };
}

/** Presentation depends on server-reported excess health damage, never raw
 * pre-armor damage. Missing legacy metadata uses a restrained lethal impact. */
export function goreProfile(event = {}, { lethal = false } = {}) {
  const headshot = !!event.hs;
  const overkill = lethal && Number.isFinite(event.overkill) ? Math.max(0, event.overkill) : 0;
  const intensity = Math.pow(clamp01(overkill / 200), 0.7);
  const healthDamage = Number.isFinite(event.healthDamage) ? Math.max(0, event.healthDamage) : null;
  const wound = healthDamage === null ? 1 : clamp01(healthDamage / 40);
  const head = headshot ? 1.15 : 1;
  const blood = lethal ? 1 : wound;
  return {
    overkill, intensity,
    mistCount: Math.round((lethal ? (24 + 64 * intensity) * head : (headshot ? 32 : 20) * blood)),
    dropletCount: Math.round((lethal ? (36 + 124 * intensity) * head : (headshot ? 48 : 30) * blood)),
    chunkCount: lethal ? Math.round((3 + 39 * intensity) * head) : 0,
    width: lethal ? 4.8 + 8.7 * intensity : headshot ? 6.8 : 4.2,
    mistLife: lethal ? 0.43 + 0.25 * intensity : headshot ? 0.68 : 0.42,
    mistSize: lethal ? 0.105 + 0.105 * intensity : headshot ? 0.14 : 0.095,
    dropletSize: lethal ? 0.028 + 0.030 * intensity : headshot ? 0.038 : 0.028,
    stainSize: lethal ? 0.13 + 0.23 * intensity : (headshot ? 0.24 : 0.15) * blood,
    chunkScale: 0.48 + 0.52 * intensity,
    chunkSpeed: 0.45 + 0.55 * intensity,
    veilCount: lethal ? Math.round(2 + 4 * intensity) : Math.round((headshot ? 5 : 3) * blood),
    veilSize: lethal ? 0.032 + 0.016 * intensity : 0.035,
  };
}
