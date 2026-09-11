export const DUEL_KILL_LIMITS = Object.freeze([5, 10, 15, 20, 30]);
export const DEFAULT_DUEL_KILL_LIMIT = 5;
// Fixed mode, team, map, Gun Game progression, and Search and Destroy economy contract.
// This module is dependency-free so the browser and authoritative server share it directly.

export const MODE_IDS = Object.freeze(['fun', 'duel', 'chaos', 'tdm', 'snd', 'gungame', 'bastion', 'training']);
export const DUEL_WEAPONS = Object.freeze(['rifle', 'shotgun', 'sniper', 'revolver', 'knife']);
export const TEAM_IDS = Object.freeze(['alpha', 'bravo']);
export const MAP_IDS = Object.freeze(['foundry', 'depot', 'citadel', 'solstice', 'caldera', 'nuketown', 'dust2', 'reactor', 'killhouse', 'harbor', 'canyon']);

export const DEFAULT_MODE_ID = MODE_IDS[0];
export const DEFAULT_TEAM_ID = TEAM_IDS[0];
export const DEFAULT_MAP_ID = MAP_IDS[0];
export const DEFAULT_WEAPON_ID = 'revolver';
export const GUN_GAME_WEAPON_ORDER = Object.freeze([
  'rifle',
  'smg',
  'shotgun',
  'sniper',
  'lmg',
  'flamethrower',
  'rocket',
  'longarc',
  'lance',
  'revolver',
  'minigun',
  'knife',
]);

export const START_CREDITS = 800;
export const KILL_CREDITS = 300;
export const PLANT_CREDITS = 300;
export const ROUND_WIN_CREDITS = 3250;
export const MAX_CREDITS = 16000;
export const LOSS_CREDIT_LADDER = Object.freeze([1400, 1900, 2400, 2900, 3400]);

export const WEAPON_PRICES = Object.freeze({
  revolver: 0,
  knife: 500,
  smg: 1250,
  shotgun: 1800,
  rifle: 2700,
  longarc: 3500,
  lance: 3800,
  lmg: 4000,
  minigun: 4800,
  rocket: 4300,
  flamethrower: 2400,
  sniper: 4750,
});

export const MODE_RULES = Object.freeze({
  bastion: Object.freeze({ teams: true, friendlyFire: false, respawnMs: Infinity }),
  fun: Object.freeze({
    teams: false,
    friendlyFire: true,
    respawnMs: 1500,
  }),
  duel: Object.freeze({ teams: false, friendlyFire: true, respawnMs: 1500, killLimit: DEFAULT_DUEL_KILL_LIMIT, postMs: 8000 }),
  chaos: Object.freeze({ teams: false, friendlyFire: true, respawnMs: 1500 }),
  tdm: Object.freeze({
    teams: true,
    friendlyFire: false,
    respawnMs: 3000,
    scoreLimit: 40,
    postMs: 5000,
  }),
  gungame: Object.freeze({
    teams: false,
    friendlyFire: true,
    respawnMs: 1500,
    postMs: 5000,
    weaponOrder: GUN_GAME_WEAPON_ORDER,
  }),
  snd: Object.freeze({
    teams: true,
    friendlyFire: false,
    prepMs: 10000,
    liveMs: 90000,
    postMs: 5000,
    roundsPerHalf: 6,
    roundWins: 7,
    pickupRadius: 1.4,
    plantMs: 3000,
    defuseRadius: 2,
    defuseMs: 5000,
    fuseMs: 40000,
    startCredits: START_CREDITS,
    killCredits: KILL_CREDITS,
    plantCredits: PLANT_CREDITS,
    roundWinCredits: ROUND_WIN_CREDITS,
    lossCredits: LOSS_CREDIT_LADDER,
    maxCredits: MAX_CREDITS,
  }),
  training: Object.freeze({
    teams: false,
    friendlyFire: false,
    respawnMs: 1500,
  }),
});

const COMBAT_MODE_IDS = Object.freeze(['fun', 'duel', 'chaos', 'tdm', 'snd', 'gungame']);
const DEPOT_MODE_IDS = Object.freeze(['fun', 'duel', 'chaos', 'tdm', 'gungame']);

export const MAP_MODE_COMPATIBILITY = Object.freeze({
  reactor: Object.freeze(['bastion']),
  foundry: COMBAT_MODE_IDS,
  harbor: COMBAT_MODE_IDS,
  canyon: COMBAT_MODE_IDS,
  depot: DEPOT_MODE_IDS,
  citadel: COMBAT_MODE_IDS,
  solstice: COMBAT_MODE_IDS,
  caldera: COMBAT_MODE_IDS,
  nuketown: COMBAT_MODE_IDS,
  dust2: COMBAT_MODE_IDS,
  killhouse: Object.freeze(['training']),
});

export function isModeId(value) {
  return MODE_IDS.includes(value);
}

/** True when the mode assigns persistent alpha/bravo teams. */
export function isTeamMode(value) {
  return MODE_RULES[value]?.teams === true;
}

/** Training target identity is stable across authority and presentation. */
export function isTrainingDummyId(value) {
  return typeof value === 'string' && value.startsWith('dummy-');
}

export function normalizeModeId(value, fallback = DEFAULT_MODE_ID) {
  if (isModeId(value)) return value;
  return isModeId(fallback) ? fallback : DEFAULT_MODE_ID;
}

export function isTeamId(value) {
  return value === 'alpha' || value === 'bravo';
}

export function normalizeTeamId(value, fallback = DEFAULT_TEAM_ID) {
  if (isTeamId(value)) return value;
  return isTeamId(fallback) ? fallback : DEFAULT_TEAM_ID;
}

export function isMapId(value) {
  return MAP_IDS.includes(value);
}

export function normalizeMapId(value, fallback = DEFAULT_MAP_ID) {
  if (isMapId(value)) return value;
  return isMapId(fallback) ? fallback : DEFAULT_MAP_ID;
}

export function isWeaponId(value) {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(WEAPON_PRICES, value);
}

export function normalizeWeaponId(value, fallback = DEFAULT_WEAPON_ID) {
  if (isWeaponId(value)) return value;
  return isWeaponId(fallback) ? fallback : DEFAULT_WEAPON_ID;
}

export function isModeMapCompatible(modeId, mapId) {
  return isModeId(modeId)
    && isMapId(mapId)
    && MAP_MODE_COMPATIBILITY[mapId].includes(modeId);
}

/** Keep a compatible selection, otherwise choose the mode's first playable map. */
export function mapForMode(modeId, preferredMap) {
  if (isModeMapCompatible(modeId, preferredMap)) return preferredMap;
  return MAP_IDS.find((mapId) => isModeMapCompatible(modeId, mapId)) ?? null;
}
