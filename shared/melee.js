import { combatDamage } from './combat-balance.js';
import { BASTION_ENEMIES } from './bastion.js';
// IRON PICK attack rules (weapon id `knife`), modelled on the Minecraft Java
// melee hit: a falling (non-sprinting) attacker lands a critical hit, every hit
// shoves the victim a little and a sprinting attacker shoves hard instead. Pure and shared, so the
// server authority, the TTK simulation and tests read one rule set.

export const MELEE_HIT_KINDS = Object.freeze(['strong', 'crit', 'knockback', 'backstab']);

export const MELEE_RULES = Object.freeze({
  // Falling crit: x1.5 like Minecraft. It never stacks with the backstab.
  critMult: 1.5,
  // Knockback is an impulse along the swing yaw. `keep` is the share of the
  // victim's own horizontal velocity that survives (Minecraft halves it); the
  // hop only lifts a grounded victim, an airborne one keeps its vertical speed.
  // With this engine's air accel 3/s and gravity 24 the base shove carries a
  // standing victim ~1.05 m, the sprint hit ~2.6 m (Minecraft: ~1 vs ~3 blocks).
  knockback: Object.freeze({
    keep: 0.5,
    base: Object.freeze({ speed: 4.5, lift: 4.0 }),
    sprint: Object.freeze({ speed: 9.5, lift: 6.0 }),
  }),
  // Big Bastion bodies brace: resistance grows with model scale, vehicles and
  // objectives never move (Minecraft's knockback-resistance attribute).
  resistPerScale: 1.5,
  maxResist: 0.8,
});

/**
 * Minecraft crit test: airborne and falling, not sprinting (Java's
 * `!isSprinting()` gate: a sprint hit is a knockback hit, never a crit), not
 * swimming, climbing, vaulting or riding.
 */
export function meleeCritEligible(p, { ladder = false } = {}) {
  return !!p && !p.grounded && Number.isFinite(p.vy) && p.vy < 0 && !p.sprint
    && !p.swimming && !p.vault && !p.slide && !ladder && !(p.proneT > 0);
}

/**
 * Classify one accepted swing that reached `victim`. Precedence of the reported
 * kind: backstab > crit > knockback > strong. Crit and sprint knockback are
 * mutually exclusive (a sprinter never crits); damage multipliers do not stack
 * (backstab wins); the knockback tier depends only on the attacker's sprint.
 */
export function meleeHitProfile(def, attacker, { backstab = false, ladder = false } = {}) {
  const melee = def.melee;
  const crit = meleeCritEligible(attacker, { ladder });
  const sprint = !!attacker?.sprint;
  const kind = backstab ? 'backstab' : crit ? 'crit' : sprint ? 'knockback' : 'strong';
  const mult = backstab ? melee.backstabMult : crit ? (melee.critMult ?? MELEE_RULES.critMult) : 1;
  const push = sprint ? MELEE_RULES.knockback.sprint : MELEE_RULES.knockback.base;
  return { kind, crit, sprint, backstab, mult, knockback: push };
}

/** Post-balance damage of one swing (before armor), rounded like the wire event. */
export function meleeDamage(def, mult = 1) {
  return combatDamage(Math.round(def.damage[0] * mult * 10) / 10);
}

/** 0 = full shove, 1 = immovable. */
export function knockbackResistance(victim) {
  if (!victim || victim.objective) return 1;
  const role = victim.npcRole && BASTION_ENEMIES[victim.npcRole];
  if (role?.vehicle) return 1;
  const scale = role?.scale ?? victim.bodyScale ?? 1;
  return Math.max(0, Math.min(MELEE_RULES.maxResist, (scale - 1) * MELEE_RULES.resistPerScale));
}

/**
 * Shove a living victim along the swing yaw (yaw 0 faces -Z) through the same
 * impulse contract blasts and chaos hits use, so the victim's client reconciles
 * the launch. Returns the applied horizontal speed (0 when resisted).
 */
export function applyMeleeKnockback(victim, yaw, push) {
  if (!victim || victim.state !== 'alive' || !push) return 0;
  const scale = 1 - knockbackResistance(victim);
  if (!(scale > 0)) return 0;
  const speed = push.speed * scale;
  const keep = MELEE_RULES.knockback.keep;
  victim.vx = (Number.isFinite(victim.vx) ? victim.vx : 0) * keep - Math.sin(yaw) * speed;
  victim.vz = (Number.isFinite(victim.vz) ? victim.vz : 0) * keep - Math.cos(yaw) * speed;
  if (victim.grounded) victim.vy = push.lift * scale;
  victim.impulseSeq = (victim.impulseSeq || 0) + 1;
  victim.grounded = false;
  victim.coyote = 0;
  victim.vault = null;
  victim.jumpGroundY = null;
  return speed;
}
