// Fixed mode, team, map, Gun Game progression, and Search and Destroy economy contract.
// Browser and authoritative server share it directly; its only import is the
// dependency-free Conquest contract, whose rules MODE_RULES.conquest mirrors.
import { CONQUEST_RULES } from './conquest-contract.js';

export const DUEL_KILL_LIMITS = Object.freeze([5, 10, 15, 20, 30]);
export const DEFAULT_DUEL_KILL_LIMIT = 5;

export const MODE_IDS = Object.freeze(['fun', 'ttt', 'duel', 'chaos', 'tdm', 'snd', 'gungame', 'bastion', 'training', 'conquest', 'titanfall']);
export const DUEL_WEAPONS = Object.freeze(['rifle', 'shotgun', 'sniper', 'revolver', 'knife']);
export const TEAM_IDS = Object.freeze(['alpha', 'bravo']);
export const MAP_IDS = Object.freeze(['foundry', 'depot', 'citadel', 'solstice', 'caldera', 'nuketown', 'dust2', 'reactor', 'killhouse', 'harbor', 'canyon', 'minecraft_b5', 'waterworld', 'causeway', 'bikini_bottom', 'ashfall', 'frontier']);

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
  'mgl',
  'longarc',
  'glaive',
  'bubble',
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
  glaive: 3000,
  bubble: 2200,
  mgl: 3900,
});

export const MODE_RULES = Object.freeze({
  conquest: Object.freeze({ teams: true, friendlyFire: false, ...CONQUEST_RULES }),
  ttt: Object.freeze({ teams: false, friendlyFire: true, respawnMs: Infinity, prepMs: 60000, liveMs: 300000 }),
  bastion: Object.freeze({ teams: true, friendlyFire: false, respawnMs: Infinity }),
  fun: Object.freeze({
    teams: false,
    friendlyFire: true,
    respawnMs: 1500,
  }),
  duel: Object.freeze({ teams: false, friendlyFire: true, respawnMs: 1500, killLimit: DEFAULT_DUEL_KILL_LIMIT }),
  chaos: Object.freeze({ teams: false, friendlyFire: true, respawnMs: 1500 }),
  tdm: Object.freeze({
    teams: true,
    friendlyFire: false,
    respawnMs: 3000,
    scoreLimit: 40,
  }),
  gungame: Object.freeze({
    teams: false,
    friendlyFire: true,
    respawnMs: 1500,
    weaponOrder: GUN_GAME_WEAPON_ORDER,
  }),
  snd: Object.freeze({
    teams: true,
    friendlyFire: false,
    prepMs: 10000,
    liveMs: 90000,
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
  // Titanfall Attrition (docs/titanfall.md §2.1). No fall damage: the policy has no fallDamage.
  titanfall: Object.freeze({
    label: 'TITANFALL', title: 'ATTRITION', teams: true, friendlyFire: false,
    // scoreLimit is the 8 v 8 value; a match plays to titanfallScoreLimit(largest team) (bot soak:
    // the leading team reaches it after ~8.5 min at every team size).
    respawnMs: 4000, scoreLimit: 750, timeLimitMs: 12 * 60_000, allowDraw: true,
    scoreScale: Object.freeze({ base: 100, perPilot: 80, step: 25, min: 175 }),
    vehicles: 'titans', points: Object.freeze({ pilot: 5, titan: 10, grunt: 1, spectre: 2 }),
  }),
});

/**
 * Titanfall score limit for the larger team's pilot count (humans and bots, not grunts):
 * base + perPilot per pilot, rounded to `step`, between `min` and the rules' 8 v 8 scoreLimit.
 */
export function titanfallScoreLimit(teamSize, rules = MODE_RULES.titanfall) {
  const scale = rules?.scoreScale, max = rules?.scoreLimit ?? 750;
  if (!scale) return max;
  const n = Math.max(1, Math.floor(Number.isFinite(teamSize) ? teamSize : 8));
  const raw = Math.round((scale.base + scale.perPilot * n) / scale.step) * scale.step;
  return Math.max(scale.min, Math.min(max, raw));
}

const COMBAT_MODE_IDS = Object.freeze(['fun', 'ttt', 'duel', 'chaos', 'tdm', 'snd', 'gungame']);
const NO_BOMB_SITE_MODE_IDS = Object.freeze(['fun', 'ttt', 'duel', 'chaos', 'tdm', 'gungame']);

export const MAP_MODE_COMPATIBILITY = Object.freeze({
  frontier: Object.freeze(['conquest', 'titanfall']),
  reactor: Object.freeze(['bastion']),
  foundry: COMBAT_MODE_IDS,
  harbor: Object.freeze([...COMBAT_MODE_IDS, 'titanfall']),
  canyon: Object.freeze([...COMBAT_MODE_IDS, 'titanfall']),
  depot: NO_BOMB_SITE_MODE_IDS,
  citadel: COMBAT_MODE_IDS,
  solstice: COMBAT_MODE_IDS,
  caldera: COMBAT_MODE_IDS,
  nuketown: COMBAT_MODE_IDS,
  dust2: COMBAT_MODE_IDS,
  killhouse: Object.freeze(['training']),
  // ttt_minecraft_b5 replica: TTT's home map, plus every non-S&D combat mode.
  minecraft_b5: NO_BOMB_SITE_MODE_IDS,
  // ttt_waterworld replica: an indoor pool complex with no bomb sites.
  waterworld: NO_BOMB_SITE_MODE_IDS,
  // Causeway: the second linear Bastion map.
  causeway: Object.freeze(['bastion']),
  // Bikini Bottom: Krusty Krab (A) vs Chum Bucket (B), every combat mode.
  bikini_bottom: COMBAT_MODE_IDS,
  // Ashfall: the dedicated Titanfall Attrition arena (docs/titanfall.md §14).
  ashfall: Object.freeze(['titanfall']),
});

export function isModeId(value) {
  return MODE_IDS.includes(value);
}

/** True when the mode assigns persistent alpha/bravo teams. */
export function isTeamMode(value) {
  return MODE_RULES[value]?.teams === true;
}

/** Modes whose server-sent `owned` list is the authoritative weapon inventory. */
export const OWNED_LOADOUT_MODES = Object.freeze(['ttt', 'bastion', 'snd', 'gungame', 'duel', 'conquest', 'titanfall']);

export function usesOwnedLoadout(mode) {
  return OWNED_LOADOUT_MODES.includes(mode);
}

/** Titanfall Attrition (docs/titanfall.md): every titanfall-only branch gates on this. */
export const isTitanfall = mode => mode === 'titanfall';
/** Modes whose VehicleSystem runs hulls (Conquest pads, Titanfall titans). */
export const modeHasVehicles = mode => mode === 'conquest' || mode === 'titanfall';
/** Bot brain widening (docs/titanfall.md §9): vehicle and kit branches, never flags. */
export const isCombinedArms = modeHasVehicles;

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

/** Bastion breaks between waves: supply, building and objective repair are open. */
export const BASTION_BREAK_PHASES = Object.freeze(['prep', 'supply']);

/**
 * Whether the mode's shop is open in `phase`: traitor shop live, S&D armory in
 * prep, Chaos Lab live, Bastion supply during breaks. Liveness is the caller's.
 */
export function buyWindowOpen(modeId, phase, tttRole = null) {
  return (modeId === 'ttt' && phase === 'live' && tttRole === 'traitor')
    || (modeId === 'snd' && phase === 'prep')
    || (modeId === 'chaos' && phase === 'live')
    || (modeId === 'bastion' && BASTION_BREAK_PHASES.includes(phase));
}
