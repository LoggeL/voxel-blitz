/**
 * Titanfall perception (docs/titanfall.md §4.1). One helper for bots, auto-titans,
 * Smart Core and the Archer lock: a cloaked pilot is perceivable only within
 * revealRange (bots then aim with closeAimErrorMul × their error) or anywhere
 * for revealMs after firing, dealing or taking damage (pilot-tacticals.js).
 *
 * Cloak state lives on the body: `p.pilotTac.cloakUntil` (pilot tactical, ms) and
 * `p.ejectCloakUntil` (doomed-titan eject, ms). `p.revealUntil` (ms) is set by
 * noteExposure when a cloaked pilot fires, deals or takes damage.
 */
import { PILOT_RULES } from '../../../shared/pilot-movement.js';

export const PERCEPTION_RULES = Object.freeze({ revealRange: PILOT_RULES.cloak.revealRange,
  revealMs: PILOT_RULES.cloak.revealSeconds * 1000, closeAimErrorMul: 3 });

/** True while `target` is cloaked (pilot tactical or eject cloak). */
export function isCloaked(target, now) {
  if (!target || typeof target !== 'object') return false;
  return (target.pilotTac?.cloakUntil ?? 0) > now || (target.ejectCloakUntil ?? 0) > now;
}

/** True unless the target is cloaked, beyond revealRange and not recently exposed. Hulls are always perceivable. */
export function isPerceivable(observer, target, now) {
  if (!target || typeof target !== 'object') return false;
  if (!isCloaked(target, now)) return true;
  if ((target.revealUntil ?? 0) > now) return true;
  if (!observer || ![observer.x, observer.z, target.x, target.z].every(Number.isFinite)) return false;
  const dy = Number.isFinite(observer.y) && Number.isFinite(target.y) ? observer.y - target.y : 0;
  return Math.hypot(observer.x - target.x, dy, observer.z - target.z) <= PERCEPTION_RULES.revealRange;
}

/** A cloaked pilot fired, dealt or took damage: perceivable anywhere for revealMs. */
export function noteExposure(target, now) {
  if (!target || typeof target !== 'object' || !Number.isFinite(now)) return;
  target.revealUntil = Math.max(target.revealUntil ?? 0, now + PERCEPTION_RULES.revealMs);
}

/**
 * Aim-error multiplier an observer applies to `target`: 1 for a visible
 * target, closeAimErrorMul for a cloaked pilot seen only through proximity,
 * 0 when the target is not perceivable at all (do not engage).
 */
export function perceptionAimMul(observer, target, now) {
  if (!isPerceivable(observer, target, now)) return 0;
  if (!isCloaked(target, now) || (target.revealUntil ?? 0) > now) return 1;
  return PERCEPTION_RULES.closeAimErrorMul;
}
