/** Shared swap lock: stow the old weapon before drawing the selected one. */
export function weaponSwapProfile(def) {
  const holster = 0.36;
  const draw = Math.max(0.6, (def?.deployTime || 0.4) * 1.25);
  return { holster, draw, total: holster + draw };
}
