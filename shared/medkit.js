import { BANDAGE_RULES } from './supply.js';

export const MEDKIT_SECONDS = 4;

/** The classic kit: one per life, a full heal after MEDKIT_SECONDS standing still. */
export const MEDKIT_RULES = Object.freeze({ count: 1, hp: 100, seconds: MEDKIT_SECONDS, bandage: false });
/** Conquest and Breakthrough: BANDAGE_RULES.count bandages, +BANDAGE_RULES.hp each (shared/supply.js). */
export const CONQUEST_MEDKIT_RULES = Object.freeze({ ...BANDAGE_RULES, bandage: true });

/**
 * The kit rule of a mode, shared by the server sim, the snapshot and the
 * client prediction/HUD. Breakthrough is a Conquest variant (mode 'conquest').
 */
export function medkitRulesFor(mode) {
  return mode === 'conquest' ? CONQUEST_MEDKIT_RULES : MEDKIT_RULES;
}

/** Kits left on a medkit object, clamped to the rule's count. */
export function medkitRemaining(kit, rules = MEDKIT_RULES) {
  const n = Math.trunc(Number(kit?.remaining) || 0);
  return Math.max(0, Math.min(rules?.count ?? 1, n));
}

/** Both input spellings are accepted so prediction and authority use one rule. */
export function medkitMovement(keys = {}) {
  return !!(keys.f || keys.b || keys.l || keys.r || keys.forward || keys.back ||
    keys.left || keys.right || keys.jump || keys.sprint || keys.crouch || keys.prone);
}

export function medkitCombat(input = {}, weapon) {
  return !!(input.wantFire || input.wantAds || input.quickMelee || input.reload ||
    input.throwGrenade || input.grenadeHandling || input.keys?.interact ||
    (Number.isInteger(input.switchTo) && input.switchTo !== weapon));
}
