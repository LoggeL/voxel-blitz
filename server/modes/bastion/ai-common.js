import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { wrapAngle } from '../../sim/player.js';

// Helpers shared by Bastion infantry, vehicles, structures and the policy.
export const turn = (a, b, rate) => a + Math.max(-rate, Math.min(rate, wrapAngle(b - a)));
export const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const slot = id => WEAPON_IDS.indexOf(id);

/** Windup tell: announces the charge once and reports whether it has elapsed. */
export function chargeReady(policy, p, profile, now) {
  const ai = p.ai;
  if (!ai.windup) { ai.windup = now; policy.emit('bastion_charge', { id: p.id, pos: [p.x, p.eyeY, p.z] }); }
  p.npcAttack = 'charging';
  return now - ai.windup >= profile.windupMs;
}

/**
 * Gun burst cycle: optional spin-up tell, then fire until the burst's shot or
 * time budget is spent, then cool down. True while the trigger should be held.
 */
export function burstFire(policy, p, profile, now) {
  const ai = p.ai;
  if (!ai.burstStart) {
    if (profile.windupMs) {
      if (!chargeReady(policy, p, profile, now)) return false;
      ai.windup = 0;
    }
    ai.burstStart = now; ai.burstShots = p.shotSeq;
  }
  const burstMs = Math.max(2000, profile.shots * 60000 / profile.rpm + 300);
  if (p.shotSeq - ai.burstShots >= profile.shots || now - ai.burstStart >= burstMs) {
    ai.pauseUntil = now + profile.pauseMs; ai.burstStart = 0; p.npcAttack = 'cooldown';
    return false;
  }
  p.npcAttack = 'firing';
  return true;
}
