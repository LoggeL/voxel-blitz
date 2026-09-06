import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { makeAvatar, updateAvatarWeaponPose, updateAvatarStancePose, setAvatarTeam, resetAvatarPose, disposeAvatar, TEAM_AVATAR_COLORS } from '../public/js/avatar/avatar.js';

// Avatar labels use canvas; geometry and all pose transforms remain real Three.js.
globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, {
  get: (object, key) => object[key] ?? (() => {}),
}) }) };
let poses = 0;
for (const id of ['operator-0', 'operator-1', 'operator-2']) {
  const av = makeAvatar(id, id, 'alpha');
  av.group.position.set(8, 2, -13);
  av.group.rotation.y = 1.37;
  for (const weapon of WEAPON_IDS) {
    for (const pitch of [-1.3, 0, 1.3]) {
      for (const ads of [false, true]) {
        for (const crouching of [false, true]) {
          for (let frame = 0; frame < 30; frame++) {
            updateAvatarWeaponPose(av, { weapon, pitch, ads, crouching, firing: frame % 3 === 0, dt: 1 / 60 });
            updateAvatarStancePose(av);
            av.group.updateMatrixWorld(true);
            for (const [hand, anchor] of [[av.rHand, av.weaponModel.handPose.grip], [av.lHand, av.weaponModel.handPose.support]]) {
              if (!anchor) continue;
              const expected = av.weaponModel.modelRoot.localToWorld(new THREE.Vector3(anchor.x, anchor.y, anchor.z));
              const error = hand.getWorldPosition(new THREE.Vector3()).distanceTo(expected);
              assert.ok(error < 1e-6, `${id}/${weapon}/${pitch}/${ads}/${crouching} hand error ${error}`);
            }
          }
          poses++;
        }
      }
    }
  }
  setAvatarTeam(av, 'bravo');
  assert.equal(av.suitMaterial.color.getHex(), TEAM_AVATAR_COLORS.bravo.suit);
  resetAvatarPose(av);
  assert.equal(av.alive, true);
  disposeAvatar(av);
}
console.log(`avatar pose tests passed: ${poses} poses, every transition frame, translated and rotated avatars`);
