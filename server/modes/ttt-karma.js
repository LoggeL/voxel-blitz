// TTT Classic default rules: Facepunch/garrysmod, terrortown/gamemode/karma.lua.
// Session memory only, matching ttt_karma_persist=0. Never keyed by display name.
export const TTT_KARMA = Object.freeze({
  starting: 1000, max: 1000, ratio: 0.001, killPenalty: 15,
  roundIncrement: 5, cleanBonus: 30, traitorKillBonus: 40,
  traitorDamageRatio: 0.0003, kickLevel: 450, banMinutes: 60,
});
const remembered = new Map();
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export function karmaDamageFactor(karma) {
  const k = karma - 1000;
  return karma >= 1000 ? 1 : clamp(1 + 0.0007 * k - 0.000002 * k * k, 0.1, 1);
}
function initial(live = TTT_KARMA.starting) {
  return { live, base: live, factor: karmaDamageFactor(live), clean: true, suicide: false };
}
export function karmaBanRemaining(identity) {
  return Math.max(0, (remembered.get(identity)?.bannedUntil || 0) - Date.now());
}
export class TttKarma {
  constructor(policy) { this.policy = policy; }
  attach(player) {
    player.tttKarma = initial();
    player.beforeDamage = (amount, attacker, weapon) => this.hurt(attacker, player, amount, weapon);
  }
  bind(player, identity, kick) {
    player.karmaIdentity = identity;
    player.karmaKick = kick;
    if (identity) player.tttKarma = initial(remembered.get(identity)?.live);
  }
  remember(player) {
    if (!player?.karmaIdentity || player.karmaKicked) return;
    const old = remembered.get(player.karmaIdentity);
    remembered.set(player.karmaIdentity, {live:player.tttKarma.live, bannedUntil:old?.bannedUntil || 0});
  }
  reward(player, amount) {
    // Default max equals starting karma, so the original excess-karma decay is 1.
    player.tttKarma.live = Math.min(TTT_KARMA.max, player.tttKarma.live + amount);
    this.remember(player);
  }
  change(attacker, victim, amount, weapon) {
    const a = this.policy.roles.get(String(attacker.id));
    const v = this.policy.roles.get(String(victim.id));
    if (!a || !v) return;
    if (a === v) {
      if (a === 'traitor' && weapon === 'c4') return; // Original C4: Avoidable=true.
      attacker.tttKarma.live = Math.max(0, attacker.tttKarma.live -
        victim.tttKarma.live * clamp(amount * TTT_KARMA.ratio, 0, 1));
      attacker.tttKarma.clean = false;
      this.remember(attacker);
    } else if (a === 'innocent' && v === 'traitor') {
      this.reward(attacker, TTT_KARMA.max * clamp(amount * TTT_KARMA.traitorDamageRatio, 0, 1));
    }
  }
  hurt(attacker, victim, damage, weapon) {
    if (damage < 1 || this.policy.phase !== 'live' || !attacker?.tttKarma || attacker === victim ||
        !this.policy.roles.has(String(attacker.id)) || !this.policy.roles.has(String(victim.id))) return damage;
    // TTT exempts slash/knife damage and self damage from the damage factor.
    const scaled = damage * (weapon === 'knife' ? 1 : attacker.tttKarma.factor);
    this.change(attacker, victim, Math.min(victim.hp, scaled), weapon);
    return scaled;
  }
  killed(attacker, victim, weapon) {
    if (this.policy.phase !== 'live') return;
    victim.tttKarma.suicide = !attacker || attacker === victim;
    if (!attacker?.tttKarma || attacker === victim) return;
    const same = this.policy.roles.get(String(attacker.id)) === this.policy.roles.get(String(victim.id));
    this.change(attacker, victim, same ? TTT_KARMA.killPenalty : TTT_KARMA.traitorKillBonus, weapon);
  }
  begin(players) {
    for (const player of players) {
      const k = player.tttKarma;
      k.factor = karmaDamageFactor(k.base);
      k.clean = true;
      k.suicide = false;
    }
  }
  end() {
    for (const player of this.policy._entities.values()) {
      const k = player.tttKarma;
      if (this.policy.participants.has(String(player.id)) && !k.suicide) this.reward(player, TTT_KARMA.roundIncrement + (k.clean ? TTT_KARMA.cleanBonus : 0));
      k.base = k.live;
      this.remember(player);
      if (k.base <= TTT_KARMA.kickLevel && !player.bot) {
        player.karmaKicked = true;
        if (player.karmaIdentity) remembered.set(player.karmaIdentity,
          {live:TTT_KARMA.starting, bannedUntil:Date.now() + TTT_KARMA.banMinutes * 60000});
        // Do not remove entities while the authoritative round is being finalized.
        queueMicrotask(() => player.karmaKick?.());
      }
    }
  }
}
