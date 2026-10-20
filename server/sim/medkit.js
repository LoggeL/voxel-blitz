import { MEDKIT_RULES, medkitMovement, medkitCombat, medkitRemaining } from '../../shared/medkit.js';

/** The player's kit rule (the engine sets it from the mode; see medkitRulesFor). */
export function medkitRulesOf(player) {
  return player?.medkitRules ?? MEDKIT_RULES;
}

export function interruptMedkit(player) {
  const kit = player.medkit;
  if (!kit) return;
  kit.active = false;
  kit.elapsed = 0;
  kit.interrupted = true;
}

/** Run after all damage for the tick, so a last-moment hit still cancels healing. */
export function updateMedkit(player, dt, allowed) {
  const kit = player.medkit;
  if (!kit) return;
  const request = player.medkitRequest || 0;
  player.medkitRequest = 0;
  const starting = request > kit.ack;
  if (starting) kit.ack = request;
  const input = player.input || {};
  const rules = medkitRulesOf(player);
  const blocked = !allowed || player.state !== 'alive' || medkitRemaining(kit, rules) < 1 ||
    player.hp >= 100 || !player.grounded || player.vault || player.proneT > 0 ||
    Math.hypot(player.vx, player.vz) > 0.18 || Math.abs(player.vy) > 0.1 ||
    player.reloading || player.firing || player.quickMeleeT > 0 || player.deployT > 0 ||
    player.burning > 0 || player.molotovBurning > 0 || kit.interrupted ||
    input.cancelMedkit || medkitMovement(input.keys) || medkitCombat(input, player.weapon);
  kit.interrupted = false;
  if (blocked) {
    kit.active = false;
    kit.elapsed = 0;
    return;
  }
  if (starting && !kit.active) {
    kit.active = true;
    kit.elapsed = 0;
    player.ads = false;
    player.adsT = 0;
    player.charging = false;
    player.chargeT = player.charge = 0;
    return;
  }
  if (!kit.active) return;
  kit.elapsed += Math.max(0, dt);
  if (kit.elapsed + 1e-9 < rules.seconds) return;
  // The classic kit heals in full; a Conquest bandage adds rules.hp (cap 100).
  player.hp = Math.min(100, (Number.isFinite(player.hp) ? player.hp : 0) + rules.hp);
  player.pain = 0;
  kit.remaining = medkitRemaining(kit, rules) - 1;
  kit.active = false;
  kit.elapsed = 0;
}
