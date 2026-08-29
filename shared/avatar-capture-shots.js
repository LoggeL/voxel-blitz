import { WEAPON_IDS } from './combatmath.js';

const VIEW_POSES = Object.freeze({
  front: Object.freeze({ firing: false, ads: false, crouching: false, pose: 'hip-standing' }),
  profile: Object.freeze({ firing: false, ads: false, crouching: false, pose: 'hip-standing' }),
  firing: Object.freeze({ firing: true, ads: false, crouching: false, pose: 'hip-standing' }),
  'ads-profile': Object.freeze({ firing: false, ads: true, crouching: false, pose: 'ads-standing' }),
  'crouched-profile': Object.freeze({ firing: false, ads: false, crouching: true, pose: 'hip-crouched' }),
  spectator: Object.freeze({ firing: false, ads: true, crouching: false, pose: 'ads-standing' }),
});

export const AVATAR_CAPTURE_VIEWS = Object.freeze(Object.keys(VIEW_POSES));

const WEAPON_VIEWS = AVATAR_CAPTURE_VIEWS.filter((view) => view !== 'spectator');

export const AVATAR_CAPTURE_SHOTS = Object.freeze([
  ...WEAPON_IDS.flatMap((weapon) => WEAPON_VIEWS.map((view) =>
    Object.freeze({ weapon, view, ...VIEW_POSES[view] }))),
  Object.freeze({ weapon: 'sniper', view: 'spectator', ...VIEW_POSES.spectator }),
]);

export function findAvatarCaptureShot(weapon, view) {
  return AVATAR_CAPTURE_SHOTS.find((entry) =>
    entry.weapon === weapon && entry.view === view) || null;
}
