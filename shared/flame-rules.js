// Shared flight contract for server damage and client fire-stream visuals.
export const FLAME_RULES = Object.freeze({
  speed: 30, range: 28, cadence: 0.05, coneDeg: 12,
  radius: 0.12, radiusGrowth: 0.035, maxProjectiles: 512,
});

// One afterburn per victim. Sustained contact builds its duration, never its DPS.
export const FLAME_BURN = Object.freeze({
  duration: 3, minDuration: 0.75, buildupPerHit: 0.16,
  damagePerS: 8, panicFloor: 0.95, panicMin: 0.3,
});

/** Shared by authoritative burn damage and local condition prediction. */
export function flamePanicFloor(remaining) {
  if (!(remaining > 0)) return 0;
  const intensity = Math.min(1, remaining / FLAME_BURN.duration);
  return FLAME_BURN.panicMin + (FLAME_BURN.panicFloor - FLAME_BURN.panicMin) * intensity;
}
