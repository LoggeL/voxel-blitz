export const MEDKIT_SECONDS = 4;

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
