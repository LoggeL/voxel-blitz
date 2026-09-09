// Bastion's public balance and purchase contract. No world or engine dependencies.
export const BASTION_RULES = Object.freeze({
  coreHp: 1000, prepMs: 25000, supplyMs: 20000, minimumPrepMs: 8000,
  postMs: 15000, returnMs: 5000, startCredits: 400,
  spawnIntervalMs: 3000, warningMs: 5000, groupSize: 3,
  repairMs: 4000, repairRadius: 3, repairHp: 200, repairPrice: 150, repairLimit: 2,
});
export const BASTION_WAVES = Object.freeze([
  [8, 0, 0], [10, 1, 0], [12, 2, 0], [12, 2, 1],
  [14, 3, 1], [16, 3, 2], [18, 4, 2], [20, 4, 3],
].map(Object.freeze));
export const BASTION_ROLES = Object.freeze(['runner', 'breacher', 'heavy']);
export const BASTION_ENEMIES = Object.freeze({
  runner: Object.freeze({ name: 'RUNNER', weapon: 'smg', hp: 80, armor: 0,
    speed: 1.1, damage: 6, rpm: 540, shots: 3, pauseMs: 1000, coreDamage: 10 }),
  breacher: Object.freeze({ name: 'BREACHER', weapon: 'rocket', hp: 120, armor: 0,
    speed: 0.8, damage: 70, rpm: 10, shots: 1, pauseMs: 6000, windupMs: 1800, coreDamage: 80 }),
  heavy: Object.freeze({ name: 'HEAVY', weapon: 'lmg', hp: 220, armor: 100,
    speed: 0.65, damage: 8, rpm: 240, shots: 8, pauseMs: 3000, coreDamage: 5 }),
});
export const BASTION_SHOP = Object.freeze({
  armor: Object.freeze({ name: 'TEAM ARMOR', price: 200, description: '+50 armor for every defender. Once per break.' }),
  reserve: Object.freeze({ name: 'AMMO RESERVE', price: 400, description: '+1 spare magazine each resupply. Entire team, entire run.' }),
  reload: Object.freeze({ name: 'FAST RELOAD', price: 600, description: '15% faster reloads. Entire team, entire run.' }),
});
export const BASTION_FACTORS = Object.freeze([1, 1.6, 2.1, 2.6]);
export const BASTION_CAPS = Object.freeze([5, 8, 8, 8]);

export function bastionWave(wave, players) {
  const count = Math.max(1, Math.min(4, players | 0));
  const base = BASTION_WAVES[Math.max(0, Math.min(7, (wave | 0) - 1))];
  const counts = base.map(n => Math.round(n * BASTION_FACTORS[count - 1]));
  return { counts, total: counts.reduce((sum, n) => sum + n, 0), cap: BASTION_CAPS[count - 1],
    specialCap: Math.ceil(count / 2),
    lanes: wave <= 2 ? 1 : Math.min(wave <= 4 ? 2 : 3, count === 3 ? 2 : count) };
}

export function bastionReward(wave) { return 300 + 50 * wave; }

export function bastionRepairAvailable(match, player) {
  const core = match?.bastion?.core;
  return match?.mode === 'bastion' && ['prep','supply'].includes(match.phase)
    && player?.state === 'alive' && core?.hp < core?.maxHp
    && Math.hypot(player.x-core.x,player.y-core.y,player.z-core.z) <= BASTION_RULES.repairRadius;
}

// Keep recoil, appearance and projectile flight identical to the existing weapon.
// Only NPC damage/cadence and the purchased human reload timing differ in this mode.
export function bastionWeaponDef(player, base) {
  const enemy = BASTION_ENEMIES[player?.npcRole];
  if (enemy) return { ...base, damage: [enemy.damage, enemy.damage, 80], headMult: 1,
    rpm: enemy.rpm, bloomPerShot: 0.2, spreadDeg: { ...base.spreadDeg, hip: Math.max(1.6, base.spreadDeg.hip) } };
  if (!player?.bastionUpgrades?.reload) return base;
  return { ...base, reloadTime: base.reloadTime * 0.85, tacTime: base.tacTime * 0.85,
    ...(base.reloadStages ? { reloadStages: Object.fromEntries(
      Object.entries(base.reloadStages).map(([key, seconds]) => [key, seconds * 0.85])) } : {}) };
}

/** Epochs reject stale clicks; per-player request IDs make retries idempotent. */
export function parseBastionPurchase(value) {
  if (typeof value !== 'string' || value.length > 120) return null;
  const match = /^bastion:([a-z0-9-]{1,48}):([1-9][0-9]{0,3}):([1-9][0-9]{0,8}):(ready|armor|reserve|reload|loadout|throwable)(?::([a-z]+))?$/.exec(value);
  if (!match) return null;
  const [, run, prep, request, action, item] = match;
  if ((action === 'loadout' || action === 'throwable') !== !!item) return null;
  return { run, prep: Number(prep), request: Number(request), action, item: item || null };
}

export function bastionPurchaseId(state, request, action, item = null) {
  return `bastion:${state.run}:${state.prep}:${request}:${action}${item ? `:${item}` : ''}`;
}
