import { WEAPON_IDS } from './combatmath.js';

export const AVATAR_CAPTURE_VIEWS = Object.freeze(['front', 'profile', 'firing']);

export const AVATAR_CAPTURE_SHOTS = Object.freeze(WEAPON_IDS.flatMap((weapon) =>
  AVATAR_CAPTURE_VIEWS.map((view) => Object.freeze({ weapon, view }))));

export function findAvatarCaptureShot(weapon, view) {
  return AVATAR_CAPTURE_SHOTS.find((entry) =>
    entry.weapon === weapon && entry.view === view) || null;
}
