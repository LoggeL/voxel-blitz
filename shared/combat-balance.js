// Applied once when an attack reaches an entity, before armor. Terrain damage
// and weapon handling stay independent of the time-to-kill tuning.
export const COMBAT_DAMAGE_SCALE = 0.8;
export function combatDamage(amount) {
  return Number.isFinite(amount) && amount > 0 ? amount * COMBAT_DAMAGE_SCALE : 0;
}
