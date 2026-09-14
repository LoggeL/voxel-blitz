import { WEAPON_IDS } from './combatmath.js';

const VIEW_POSES = Object.freeze({
  front: Object.freeze({ firing: false, ads: false, crouching: false, pose: 'hip-standing' }),
  profile: Object.freeze({ firing: false, ads: false, crouching: false, pose: 'hip-standing' }),
  firing: Object.freeze({ firing: true, ads: false, crouching: false, pose: 'hip-standing' }),
  'ads-profile': Object.freeze({ firing: false, ads: true, crouching: false, pose: 'ads-standing' }),
  'crouched-profile': Object.freeze({ firing: false, ads: false, crouching: true, pose: 'hip-crouched' }),
  'prone-profile': Object.freeze({ firing: false, ads: false, crouching: false, proneT: 1, pose: 'hip-prone' }),
  // Floating swimmer mid-stroke at full swim speed, and the treading idle.
  'swim-profile': Object.freeze({ firing: false, ads: false, crouching: false, swimming: true, moveSpeed: 2.6, pose: 'hip-swimming' }),
  'swim-tread': Object.freeze({ firing: false, ads: false, crouching: false, swimming: true, moveSpeed: 0, pose: 'hip-treading' }),
  spectator: Object.freeze({ firing: false, ads: true, crouching: false, pose: 'ads-standing' }),
});

export const AVATAR_CAPTURE_VIEWS = Object.freeze(Object.keys(VIEW_POSES));

const WEAPON_VIEWS = AVATAR_CAPTURE_VIEWS.filter((view) => view !== 'spectator' && view !== 'swim-tread');

export const AVATAR_CAPTURE_SHOTS = Object.freeze([
  ...WEAPON_IDS.flatMap((weapon) => WEAPON_VIEWS.map((view) =>
    Object.freeze({ weapon, view, ...VIEW_POSES[view] }))),
  Object.freeze({ weapon: 'sniper', view: 'spectator', ...VIEW_POSES.spectator }),
  Object.freeze({ weapon: 'rifle', view: 'swim-tread', ...VIEW_POSES['swim-tread'] }),
]);

export function findAvatarCaptureShot(weapon, view) {
  return AVATAR_CAPTURE_SHOTS.find((entry) =>
    entry.weapon === weapon && entry.view === view) || null;
}
