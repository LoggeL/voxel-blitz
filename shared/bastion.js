// Bastion's public balance and purchase contract. No world or engine dependencies.
export const BASTION_RULES = Object.freeze({
  prepMs: 25000, supplyMs: 20000, regroupMs: 30000, minimumPrepMs: 8000,
  postMs: 15000, returnMs: 5000, startCredits: 400, stageBonus: 250,
  spawnIntervalMs: 3000, warningMs: 5000, groupSize: 3, vehicleIntervalMs: 9000,
  repairMs: 4000, repairRadius: 3, repairHp: 200, repairPrice: 150, repairLimit: 2,
  extractGraceMs: 30000, buildRadius: 6, breachStallMs: 4000,
  build: Object.freeze({ barricadeVoxels: 48, turrets: 2, crates: 1 }),   // per stage
});
// Column order of every wave row = queue round-robin order = size order for
// infantry, then vehicles.
export const BASTION_ROLES = Object.freeze(['runner', 'breacher', 'heavy', 'brute', 'juggernaut', 'buggy', 'apc', 'walker']);
// Infantry `speed` multiplies the 4.4 m/s walk; vehicle `speed` is absolute m/s.
export const BASTION_ENEMIES = Object.freeze({
  runner: Object.freeze({ name: 'RUNNER', weapon: 'smg', hp: 80, armor: 0,
    speed: 1.1, damage: 6, rpm: 540, shots: 3, pauseMs: 1000, objectiveHit: 10, scale: 0.92,
    breachDamage: 60, breachMs: 500, rusher: true, tier: 1,
    look: Object.freeze({ suit: 0xd69b3e, dark: 0x252c36 }) }),
  breacher: Object.freeze({ name: 'BREACHER', weapon: 'rocket', hp: 120, armor: 0,
    speed: 0.8, damage: 70, rpm: 10, shots: 1, pauseMs: 6000, windupMs: 1800, objectiveHit: 80, scale: 1.0,
    breachDamage: 0, breachMs: 0, rocket: true, tier: 2,
    look: Object.freeze({ suit: 0xf26743, dark: 0x252c36 }) }),
  heavy: Object.freeze({ name: 'HEAVY', weapon: 'lmg', hp: 220, armor: 100,
    speed: 0.65, damage: 8, rpm: 240, shots: 8, pauseMs: 3000, objectiveHit: 5, scale: 1.15,
    breachDamage: 120, breachMs: 700, tier: 3,
    look: Object.freeze({ suit: 0x9d73cc, dark: 0x252c36 }) }),
  brute: Object.freeze({ name: 'BRUTE', weapon: 'shotgun', hp: 420, armor: 150,
    speed: 0.9, damage: 5, rpm: 60, shots: 2, pauseMs: 2500, objectiveHit: 25, scale: 1.3,
    breachDamage: 160, breachMs: 600, rusher: true, slamRange: 2.6, slamDamage: 40, slamKnock: 14, slamMs: 1200, tier: 4,
    look: Object.freeze({ suit: 0x6f8f3a, dark: 0x1f2a1c }) }),
  juggernaut: Object.freeze({ name: 'JUGGERNAUT', weapon: 'lmg', hp: 900, armor: 300,
    speed: 0.5, damage: 7, rpm: 480, shots: 20, pauseMs: 3500, windupMs: 900, objectiveHit: 6, scale: 1.4,
    breachDamage: 240, breachMs: 800, noPanic: true, rearMult: 1.6, tier: 5,
    look: Object.freeze({ suit: 0x8a2f2f, dark: 0x141414 }) }),
  buggy: Object.freeze({ name: 'BUGGY', weapon: 'smg', hp: 600, armor: 0,
    speed: 7.5, damage: 7, rpm: 600, shots: 6, pauseMs: 1500, objectiveHit: 4, scale: 1,
    vehicle: true, combatBox: Object.freeze([1.1, 0.7, 1.1]), turnRate: 2.4, standoff: 5,
    ramDamage: 150, ramPlayerDamage: 25, ramKnock: 12, smallArms: 0.7, rearMult: 1.5, tier: 'vehicle',
    look: Object.freeze({ suit: 0xc9a24a, dark: 0x2a2a2a }) }),
  apc: Object.freeze({ name: 'APC', weapon: 'rocket', hp: 1800, armor: 0,
    speed: 3.2, damage: 60, rpm: 10, shots: 2, pauseMs: 6000, windupMs: 1500, objectiveHit: 60, scale: 1,
    vehicle: true, rocket: true, combatBox: Object.freeze([1.4, 0.95, 1.4]), turnRate: 1.2, standoff: 7,
    ramDamage: 320, ramPlayerDamage: 40, ramKnock: 12, smallArms: 0.35, rearMult: 1.5,
    drop: Object.freeze({ role: 'runner', count: 4 }), tier: 'vehicle',
    look: Object.freeze({ suit: 0x5a6a5a, dark: 0x1e2420 }) }),
  walker: Object.freeze({ name: 'WALKER', weapon: 'lmg', hp: 3200, armor: 0,
    speed: 2.0, damage: 9, rpm: 500, shots: 30, pauseMs: 3000, windupMs: 1200, objectiveHit: 12, scale: 1,
    vehicle: true, combatBox: Object.freeze([1.6, 2.2, 1.6]), turnRate: 1.0, standoff: 9,
    ramDamage: 400, ramPlayerDamage: 80, ramKnock: 24, smallArms: 0.5, rearMult: 2.0,
    mortar: Object.freeze({ everyMs: 8000, damage: 60, radius: 5, fuseMs: 2000 }), tier: 'vehicle',
    look: Object.freeze({ suit: 0x5b3f6b, dark: 0x1a1420 }) }),
});
// Weapon keys (as passed to takeDamage) that ignore a vehicle's small-arms factor.
export const BASTION_PIERCING = Object.freeze(['rocket', 'frag', 'limpet', 'pulse', 'molotov', 'flamethrower', 'longarc', 'lance', 'sniper']);
export const BASTION_SHOP = Object.freeze({
  armor: Object.freeze({ name: 'TEAM ARMOR', price: 200, description: '+50 armor for every defender. Once per break.' }),
  reserve: Object.freeze({ name: 'AMMO RESERVE', price: 400, description: '+1 spare magazine each resupply. Entire team, entire run.' }),
  reload: Object.freeze({ name: 'FAST RELOAD', price: 600, description: '15% faster reloads. Entire team, entire run.' }),
});
// Single source for the build catalog keys; shared/bastion-build.js imports it.
export const STRUCTURE_KINDS = Object.freeze(['sandbag', 'wall', 'turret', 'crate']);

export const BASTION_WAVES = Object.freeze({   // columns = BASTION_ROLES order
  //             runner breacher heavy brute jugg buggy apc walker
  probe:        Object.freeze([ 8, 0, 0, 0, 0,  0, 0, 0]),   // 8
  push:         Object.freeze([10, 1, 0, 0, 0,  0, 0, 0]),   // 11
  assault:      Object.freeze([10, 2, 1, 0, 0,  1, 0, 0]),   // 14  first buggy
  siege:        Object.freeze([10, 2, 1, 1, 0,  1, 0, 0]),   // 15  first brute
  armor:        Object.freeze([12, 2, 2, 1, 0,  1, 1, 0]),   // 19  first apc
  onslaught:    Object.freeze([12, 3, 2, 2, 1,  1, 1, 0]),   // 22  first juggernaut
  breakthrough: Object.freeze([12, 3, 2, 2, 1,  2, 1, 1]),   // 24  first walker
  lastStand:    Object.freeze([14, 4, 3, 3, 2,  2, 2, 1]),   // 31  extraction loop row
});
export const BASTION_FACTORS = Object.freeze([1, 1.6, 2.1, 2.6]);          // infantry columns
export const BASTION_VEHICLE_FACTORS = Object.freeze([1, 1, 2, 2]);        // vehicle columns
export const BASTION_CAPS = Object.freeze([6, 9, 10, 10]);                 // alive enemies incl. vehicles
export const BASTION_VEHICLE_CAPS = Object.freeze([1, 1, 2, 2]);           // alive vehicles

export function bastionWave(rowId, players) {
  const count = Math.max(1, Math.min(4, players | 0));
  const row = BASTION_WAVES[rowId] ?? BASTION_WAVES.probe;
  const counts = row.map((n, i) => Math.round(n * (BASTION_ENEMIES[BASTION_ROLES[i]].vehicle
    ? BASTION_VEHICLE_FACTORS[count - 1] : BASTION_FACTORS[count - 1])));
  return { row: rowId, counts, total: counts.reduce((s, n) => s + n, 0), cap: BASTION_CAPS[count - 1],
    vehicleCap: BASTION_VEHICLE_CAPS[count - 1], specialCap: Math.ceil(count / 2) };
}

export function bastionReward(wave) { return 300 + 50 * wave; }

// `match.bastion.core` is the current stage objective (alias kept by the policy).
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

/** Epochs reject stale clicks; per-player request IDs make retries idempotent.
 *  `build:<kind>:<x>:<y>:<z>:<facing>` carries the placement cell (max 88 chars). */
const PURCHASE_RE = /^bastion:([a-z0-9-]{1,48}):([1-9][0-9]{0,3}):([1-9][0-9]{0,8}):(ready|armor|reserve|reload|loadout|throwable|build)(?::([a-z]+))?(?::(\d{1,3}):(\d{1,2}):(\d{1,3}):([0-3]))?$/;
export function parseBastionPurchase(value) {
  if (typeof value !== 'string' || value.length > 120) return null;
  const m = PURCHASE_RE.exec(value); if (!m) return null;
  const [, run, prep, request, action, item, x, y, z, facing] = m;
  if ((['loadout', 'throwable', 'build'].includes(action)) !== !!item) return null;
  if ((action === 'build') !== (x !== undefined)) return null;
  if (action === 'build' && !STRUCTURE_KINDS.includes(item)) return null;
  return { run, prep: Number(prep), request: Number(request), action, item: item || null,
    cell: x === undefined ? null : { x: Number(x), y: Number(y), z: Number(z) },
    facing: facing === undefined ? null : Number(facing) };
}

export function bastionPurchaseId(state, request, action, item = null, cell = null, facing = 0) {
  return `bastion:${state.run}:${state.prep}:${request}:${action}${item ? `:${item}` : ''}${cell ? `:${cell.x}:${cell.y}:${cell.z}:${facing & 3}` : ''}`;
}
