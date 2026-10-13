/**
 * Titan meter (docs/titanfall.md §5.2 Meter). WP0 ships a working basic body;
 * WP2 owns the tuning. The meter (0..1) lives in the policy's per-player state
 * and fills only while the pilot owns no titan: not while one is dropping,
 * alive or doomed, and not while its wreck stands (§1 step 8). Sources:
 * passive 0.9 %/s (policy.beforeTick), pilot kill (policy.onPlayerDeath),
 * titan kill (policy.onVehicleEvent), titan damage (titan-damage.js) and pilot
 * damage (TitanSystem's chained beforeDamage hook).
 */
import { TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';

/** True while the pilot's titan (or its wreck) exists: the meter holds. */
function holding(policy, player) {
  const titans = policy.titans;
  if (!titans) return false;
  return typeof titans.holdsTitan === 'function' ? titans.holdsTitan(player.id) : !!titans.ownedBy(player.id);
}

const GAIN = Object.freeze({
  pilotKill: () => TITAN_RULES.meter.pilotKill,
  titanKill: () => TITAN_RULES.meter.titanKill,
  pilotDamage: hp => TITAN_RULES.meter.pilotDamagePerHp * hp,
  titanDamage: hp => TITAN_RULES.meter.titanDamagePerHp * hp,
});

/** Passive fill for one living pilot without a titan. */
export function meterStep(policy, player, dt) {
  if (!policy || !player || player.state !== 'alive' || !(dt > 0)) return;
  if (holding(policy, player)) return;
  policy.setTitanMeter(player, policy.titanMeter(player) + TITAN_RULES.meter.passive * dt);
}

/** Credit `kind` ('pilotKill' | 'titanKill' | 'pilotDamage' | 'titanDamage') to a pilot. */
export function meterCredit(policy, player, kind, amount = 1) {
  const gain = GAIN[kind];
  if (!policy || typeof policy.titanMeter !== 'function' || !player || !gain) return;
  if (holding(policy, player)) return;
  const add = gain(Number.isFinite(amount) ? amount : 0);
  if (add > 0) policy.setTitanMeter(player, policy.titanMeter(player) + add);
}

/** Meter after a titan call, a team switch or a match reset. */
export function meterReset(policy, player) {
  if (policy && typeof policy.setTitanMeter === 'function' && player) policy.setTitanMeter(player, 0);
}
