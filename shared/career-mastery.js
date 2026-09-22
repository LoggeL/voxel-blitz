import { WEAPON_IDS } from './combatmath.js';

/** Weapon mastery. Human kills count 1; bot and Bastion NPC kills count a
 * quarter, capped per weapon per match by the server. `row.kills` stays
 * human-only so StatTrak and the welcome `mastery` payload never change. */
export const MASTERY_TIERS = Object.freeze([
  Object.freeze({ id: 'initiated', name: 'INITIATED', numeral: 'I', score: 50, color: '#c98a4b' }),
  Object.freeze({ id: 'specialist', name: 'SPECIALIST', numeral: 'II', score: 250, color: '#c8d2dc' }),
  Object.freeze({ id: 'elite', name: 'ELITE', numeral: 'III', score: 1000, color: '#ffd23f' }),
  Object.freeze({ id: 'master', name: 'MASTER', numeral: 'IV', score: 2500, color: '#b98cff' }),
]);
export const BOT_MASTERY_DIVISOR = 4;
export const BOT_MASTERY_CAP_PER_MATCH = 40;
export const COMBAT_SCORE_BOT_DIVISOR = 4;
export const MASTERY_BADGES = Object.freeze({ rifle: 'RAPTOR', smg: 'HORNET', shotgun: 'M-DOCK', sniper: 'LONGSHOT', lmg: 'BASTION',
  revolver: 'IRONCLAD', longarc: 'LONGARC', rocket: 'HAVOC', lance: 'VOLTLANCE', knife: 'PICK',
  minigun: 'FURNACE', flamethrower: 'FIRESTORM', glaive: 'RIPTIDE' });

const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
export const masteryTier = id => MASTERY_TIERS.find(tier => tier.id === id) || null;

/** Never below `row.kills`, so every legacy kill gate stays monotonic. */
export const masteryScore = row => count(row?.kills) + Math.floor(count(row?.botKills) / BOT_MASTERY_DIVISOR);
/** Never below `pvpKills`: `kills` includes bot kills, `pvpKills` only humans. */
export const combatScore = profile => count(profile?.pvpKills)
  + Math.floor(Math.max(0, count(profile?.kills) - count(profile?.pvpKills)) / COMBAT_SCORE_BOT_DIVISOR);
/** -1 below INITIATED, otherwise the index of the highest tier reached. */
export function masteryTierIndex(score) {
  let at = -1;
  MASTERY_TIERS.forEach((tier, index) => { if (score >= tier.score) at = index; });
  return at;
}
export function arsenalCount(profile, tierId) {
  const tier = masteryTier(tierId);
  if (!tier) return 0;
  return WEAPON_IDS.filter(weapon => masteryScore(profile?.mastery?.[weapon]) >= tier.score).length;
}
const fraction = divisor => ({ 2: '½', 3: '⅓', 4: '¼' })[divisor] || `1/${divisor}`;
/** Player-facing rule copy, generated so it can never drift from the constants. */
export const MASTERY_RULES_TEXT = `Human kills count 1. Bot and Bastion kills count ${fraction(BOT_MASTERY_DIVISOR)}, `
  + `up to ${BOT_MASTERY_CAP_PER_MATCH} per weapon per match. Training, team kills and self-kills do not count.`;
