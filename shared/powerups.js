// Pickup balance and presentation shared by the authoritative sim and client.
export const POWERUP_RULES = Object.freeze({
  modes: Object.freeze(['fun', 'tdm', 'chaos']),
  maxArmor: 100,
  armorAmount: 50,
  maxHealth: 100,
  healthAmount: 35,
  firstSpawnMs: 12000,
  spawnMinMs: 18000,
  spawnMaxMs: 28000,
  maxActive: 3,
  lifetimeMs: 30000,
  collectRadius: 1.3,
  collectHeight: 0.75,
  minimumSeparation: 12,
});

export const POWERUP_TYPES = Object.freeze({
  cash: Object.freeze({ label: 'Cash', color: 0x8be66d,
    description: '+300 credits for Chaos upgrades.' }),
  armor: Object.freeze({ label: 'Armor', color: 0x55baff,
    description: '+50 Armor, up to 100. Armor absorbs incoming damage.' }),
  health: Object.freeze({ label: 'Medkit', color: 0x65e3a4,
    description: '+35 health, up to 100.' }),
  ammo: Object.freeze({ label: 'Ammo', color: 0xffc765,
    description: 'Restores spare magazines for your weapons.' }),
});

export const CHAOS_CASH_RULES = Object.freeze({
  ...POWERUP_RULES,
  modes: Object.freeze(['chaos']),
  amount: 300,
  firstSpawnMs: 0,
  spawnMinMs: 15000,
  spawnMaxMs: 25000,
  lifetimeMs: 90000,
});

export const MAX_WORLD_PICKUPS = POWERUP_RULES.maxActive + CHAOS_CASH_RULES.maxActive;
