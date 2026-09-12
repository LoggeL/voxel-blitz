// Shared flight contract for server damage and client fire-stream visuals.
export const FLAME_RULES = Object.freeze({
  speed: 30, range: 32, cadence: 0.05, coneDeg: 16,
  radius: 0.12, radiusGrowth: 0.047, maxProjectiles: 512,
});

// One afterburn per victim. Sustained contact builds its duration, never its DPS.
export const FLAME_BURN = Object.freeze({
  duration: 3, minDuration: 0.75, buildupPerHit: 0.16,
  damagePerS: 8, panicFloor: 1,
});

/** Shared by authoritative burn damage and local condition prediction. */
export function flamePanicFloor(remaining) {
  // Even a graze disrupts aim. Duration controls how long it lasts, not panic.
  return remaining > 0 ? FLAME_BURN.panicFloor : 0;
}
