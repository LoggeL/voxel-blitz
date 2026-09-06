import * as THREE from '../../public/js/vendor/three.module.js';
import { WEAPON_IDS } from '../../shared/combatmath.js';
import { pointPlayerDistance } from '../../shared/player-hitboxes.js';
import { makeAvatar, updateAvatarWeaponPose, updateAvatarStancePose, disposeAvatar } from '../../public/js/avatar/avatar.js';

// Check against real model transforms, so changes to mounts/rig proportions
// cannot silently leave the authoritative arm zones behind.
export function runPlayerHitboxPoseContracts(ok) {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, {
    get: (object, key) => object[key] ?? (() => {}),
  }) }) };
  let avatar;
  try {
    avatar = makeAvatar('operator-0', 'Hitbox fixture');
    const point = new THREE.Vector3();
    let worst = 0, poses = 0;
    for (let weapon = 0; weapon < WEAPON_IDS.length; weapon++) {
      for (const pitch of [-1.3, 0, 1.3]) for (const ads of [false, true]) for (const crouch of [false, true]) {
        const p = { x: 4, y: 2, z: -3, yaw: 0.8, pitch, weapon, ads, crouch };
        avatar.group.position.set(p.x, p.y, p.z); avatar.group.rotation.y = p.yaw;
        for (let i = 0; i < 90; i++) {
          updateAvatarWeaponPose(avatar, { weapon, pitch, ads, crouching: crouch, dt: 1 / 30, blend: 1 });
          updateAvatarStancePose(avatar);
        }
        avatar.group.updateMatrixWorld(true);
        for (const joint of [avatar.lArm, avatar.rArm, avatar.lElbow, avatar.rElbow, avatar.lHand, avatar.rHand]) {
          joint.getWorldPosition(point);
          worst = Math.max(worst, pointPlayerDistance(point.toArray(), p));
        }
        poses++;
      }
    }
    ok(worst < 0.025, `combat arm zones cover shoulder, elbow and hand anchors across ${poses} actual weapon poses (max gap ${worst.toFixed(4)}m)`);
  } finally {
    if (avatar) disposeAvatar(avatar);
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}
