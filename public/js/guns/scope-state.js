import { SNIPER_SCOPE_ADS_THRESHOLD } from '../../../shared/combatmath.js';

/** Scope visibility is independent of the smooth ADS/FOV recovery. */
export function isScopeActive({ weapon, ads = 0, alive = true, vaulting = false,
  grenadeHandling = false, reloading = false, deploying = false } = {}) {
  return weapon === 'sniper' && alive && !vaulting && !grenadeHandling &&
    !reloading && !deploying && ads >= SNIPER_SCOPE_ADS_THRESHOLD;
}

export function nextScopeZoom(def, current = 0) {
  const full = Number(def?.zoom) || 0;
  if (def?.id !== 'sniper' || full <= 1) return 0;
  return !current || Math.abs(current - full) < 1e-6 ? Math.max(1.5, full / 2) : full;
}
