import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { makeAvatar, updateAvatarWeaponPose, updateAvatarStancePose, setAvatarTeam, resetAvatarPose, disposeAvatar, TEAM_AVATAR_COLORS } from '../public/js/avatar/avatar.js';
import { ENEMY_LOOKS, updateBastionAvatar } from '../public/js/avatar/bastion-avatar.js';
import { BASTION_ENEMIES } from '../shared/bastion.js';

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
        for (const crouching of [false, true]) for (const swimming of [false, true]) {
          for (let frame = 0; frame < 30; frame++) {
            updateAvatarWeaponPose(av, { weapon, pitch, ads, crouching, swimming, speed: swimming ? 2.6 : 0,
              stride: swimming ? 0.45 : 0, firing: frame % 3 === 0, dt: 1 / 60 });
            updateAvatarStancePose(av, { stride: swimming ? 0.45 : 0 });
            av.group.updateMatrixWorld(true);
            for (const [hand, anchor] of [[av.rHand, av.weaponModel.handPose.grip], [av.lHand, av.weaponModel.handPose.support]]) {
              if (!anchor) continue;
              const expected = av.weaponModel.modelRoot.localToWorld(new THREE.Vector3(anchor.x, anchor.y, anchor.z));
              const error = hand.getWorldPosition(new THREE.Vector3()).distanceTo(expected);
              assert.ok(error < 1e-6, `${id}/${weapon}/${pitch}/${ads}/${crouching}/${swimming} hand error ${error}`);
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
// Bastion enemy silhouettes: every infantry look keeps the hand IK exact at its
// own body scale (the roster scales the whole rig by `bodyScale`).
let rolePoses = 0;
for (const [role, look] of Object.entries(ENEMY_LOOKS)) {
  if (BASTION_ENEMIES[role]?.vehicle) continue;
  const av = makeAvatar(`npc-${role}`, role.toUpperCase(), 'bravo');
  updateBastionAvatar(av, { npcRole: role, npcAttack: 'advance', npcScale: look.scale });
  const scale = av.bodyScale || 1;
  assert.equal(scale, look.scale ?? BASTION_ENEMIES[role]?.scale ?? 1, `${role} carries its look scale`);
  av.group.scale.setScalar(scale);
  av.group.position.set(-4, 1, 9);
  av.group.rotation.y = -0.8;
  const weapon = WEAPON_IDS.indexOf(BASTION_ENEMIES[role]?.weapon ?? 'rifle');
  for (const pitch of [-1.3, 0, 1.3]) for (const ads of [false, true]) for (const crouching of [false, true]) {
    for (let frame = 0; frame < 30; frame++) {
      updateAvatarWeaponPose(av, { weapon, pitch, ads, crouching, swimming: false, speed: 0, stride: 0, firing: frame % 3 === 0, dt: 1 / 60 });
      updateAvatarStancePose(av, { stride: 0 });
      av.group.updateMatrixWorld(true);
      for (const [hand, anchor] of [[av.rHand, av.weaponModel.handPose.grip], [av.lHand, av.weaponModel.handPose.support]]) {
        if (!anchor) continue;
        const expected = av.weaponModel.modelRoot.localToWorld(new THREE.Vector3(anchor.x, anchor.y, anchor.z));
        const error = hand.getWorldPosition(new THREE.Vector3()).distanceTo(expected);
        assert.ok(error < 1e-6, `${role}@${scale}/${WEAPON_IDS[weapon]}/${pitch}/${ads}/${crouching} hand error ${error}`);
      }
    }
    rolePoses++;
  }
  disposeAvatar(av);
}
assert.ok(rolePoses > 0, 'ENEMY_LOOKS lists at least one infantry role');

// The name tag pill is 224 px wide; a 24-character name must condense inside it.
{
  const drawn = [];
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => new Proxy({
    strokeText: (...args) => drawn.push(args), fillText: (...args) => drawn.push(args),
  }, { get: (object, key) => object[key] ?? (() => {}) }) }) };
  const av = makeAvatar('long-name', 'WWWWWWWWWWWWWWWWWWWWWWWW', 'alpha');
  globalThis.document = previous;
  assert.equal(drawn.length, 2, 'the tag strokes and fills the name once');
  assert.ok(drawn.every(([, , , maxWidth]) => maxWidth > 0 && maxWidth + 3 <= 224),
    'long names get a max width that keeps the text and its stroke inside the tag pill');
  disposeAvatar(av);
}
console.log(`avatar pose tests passed: ${poses} poses, every transition frame, translated and rotated avatars, ${rolePoses} scaled enemy-role poses`);
