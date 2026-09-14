import { WEAPON_IDS } from './combatmath.js';

export const WEAPON_CAPTURE_STATES = Object.freeze(['pickaxe-lift', 'pickaxe-impact', 'mining-low', 'mining-high', 'swap-stow', 'swap-draw', 'swap-ready', 'held', 'vaulting', 'scoped', 'firing', 'charge-low', 'charge-high', 'reload-open', 'reload-eject', 'reload-load', 'reload-charge']);

// Reload stills exist for the two feed systems with visible mechanism work: the
// revolver's swing-out cylinder and the belt-fed LMG (cover, box, belt lead and
// charging handle); 'reload-charge' is the belt gun's final handle rack.
const RELOAD_CAPTURE_WEAPONS = Object.freeze({ revolver: ['reload-open', 'reload-eject', 'reload-load'], lmg: ['reload-open', 'reload-eject', 'reload-load', 'reload-charge'] });

export const WEAPON_CAPTURE_SHOTS = Object.freeze(WEAPON_IDS.flatMap((weapon) =>
  WEAPON_CAPTURE_STATES.filter((state) => ((!state.startsWith('pickaxe-') && !state.startsWith('mining-')) || weapon === 'knife') && (!state.startsWith('charge-') || weapon === 'lance') && (!state.startsWith('reload-') || RELOAD_CAPTURE_WEAPONS[weapon]?.includes(state))).map((state) => Object.freeze({ weapon, state }))));

export function findWeaponCaptureShot(weapon, state) {
  return WEAPON_CAPTURE_SHOTS.find((entry) =>
    entry.weapon === weapon && entry.state === state) || null;
}
