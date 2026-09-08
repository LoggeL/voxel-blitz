/** Shared footprint and presentation bounds for authoritative ground fire. */
export const MOLOTOV_FIRE = Object.freeze({
  radius: 3.2,
  durationMs: 7500,
  damagePerSecond: 30,
  selfDamage: 0.72,
  maxFields: 32,
  // Retain the complete 4.2 m Chaos footprint, including its outer voxel sites.
  maxCells: 64,
  cellRadius: 0.72,
  height: 1.1,
  damageInterval: 0.25,
});

const CHAOS_FIRE_PROFILES = Object.freeze([
  MOLOTOV_FIRE,
  Object.freeze({ ...MOLOTOV_FIRE, radius: 4.2 }),
  Object.freeze({ ...MOLOTOV_FIRE, radius: 4.2, durationMs: 10000 }),
  Object.freeze({ ...MOLOTOV_FIRE, radius: 4.2, durationMs: 10000, damagePerSecond: 40 }),
]);

/** Cumulative Chaos tuning captured when the authoritative bottle is thrown. */
export function molotovFireProfile(level = 0) {
  const tier = Number.isFinite(level) ? Math.max(0, Math.min(3, Math.trunc(level))) : 0;
  return CHAOS_FIRE_PROFILES[tier];
}
