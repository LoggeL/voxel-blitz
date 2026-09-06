import { WEAPON_IDS } from './combatmath.js';

export const WEAPON_CAPTURE_STATES = Object.freeze(['swap-stow', 'swap-draw', 'swap-ready', 'held', 'vaulting', 'scoped', 'firing', 'charge-low', 'charge-high', 'reload-open', 'reload-eject', 'reload-load']);

export const WEAPON_CAPTURE_SHOTS = Object.freeze(WEAPON_IDS.flatMap((weapon) =>
  WEAPON_CAPTURE_STATES.filter((state) => (!state.startsWith('charge-') || weapon === 'lance') && (!state.startsWith('reload-') || weapon === 'revolver')).map((state) => Object.freeze({ weapon, state }))));

export function findWeaponCaptureShot(weapon, state) {
  return WEAPON_CAPTURE_SHOTS.find((entry) =>
    entry.weapon === weapon && entry.state === state) || null;
}
