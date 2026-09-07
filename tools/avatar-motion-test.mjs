import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { AvatarMotion } from '../public/js/avatar/avatar-motion.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';
import { makeAvatar, updateAvatarWeaponPose, updateAvatarStancePose, resetAvatarPose, disposeAvatar } from '../public/js/avatar/avatar.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { playerHitboxes, pointPlayerDistance } from '../shared/player-hitboxes.js';

const previousDocument = globalThis.document;
globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, {
  get: (object, key) => object[key] ?? (() => {}),
}) }) };
const motion = new AvatarMotion(0.4);
motion.update(1 / 60, { grounded: true });
assert.equal(motion.landing, 0, 'first snapshot has no invented landing');
for (let frame = 0; frame < 30; frame++) motion.update(1 / 60, { grounded: false, verticalSpeed: -8 });
assert.ok(motion.air > 0.99, 'falling eases into airborne pose');
motion.update(1 / 60, { grounded: true });
assert.ok(motion.landing > 0.7, 'actual air-to-ground transition absorbs a hard landing');
for (let frame = 0; frame < 120; frame++) motion.update(1 / 60, { grounded: true });
assert.ok(motion.landing < 1e-6 && motion.air < 1e-6, 'landing and foot tuck settle fully');
motion.reset();
assert.equal(motion.gearPitch, 0);
assert.equal(motion.seeded, false);

const responses = [30, 60, 144].map(rate => {
  const state = new AvatarMotion(0.4);
  for (let frame = 0; frame < rate / 2; frame++) {
    state.update(1 / rate, { lateralSpeed: 6, forwardSpeed: 6, turnSpeed: 5 });
  }
  return state;
});
assert.ok(Math.max(...responses.map(state => state.side)) - Math.min(...responses.map(state => state.side)) < 1e-10,
  'locomotion blend responds equally at 30, 60, and 144 Hz');
assert.ok(Math.max(...responses.map(state => state.gearRoll)) - Math.min(...responses.map(state => state.gearRoll)) < 0.002,
  'gear follow-through remains consistent across render rates');

let checkedFrames = 0, worstArmGap = 0;
try {
  const av = makeAvatar('motion-fixture', 'Motion');
  try {
    av.group.position.set(4, 2, -3);
    av.group.rotation.y = 0.8;
    const point = new THREE.Vector3();
    for (const id of ['rifle', 'sniper', 'knife']) for (const ads of [false, true]) for (const crouch of [false, true]) {
      const weapon = WEAPON_IDS.indexOf(id);
      const p = { x: 4, y: 2, z: -3, yaw: 0.8, weapon, ads, crouch, pitch: 0 };
      for (let frame = 0; frame < 120; frame++) {
        updateAvatarWeaponPose(av, { weapon, ads, crouching: crouch, dt: 1 / 60 });
        updateAvatarStancePose(av);
      }
      const samples = [];
      for (let frame = 0; frame < 180; frame++) {
        const grounded = frame < 30 || frame >= 90;
        const movement = { grounded, verticalSpeed: grounded ? 0 : frame < 60 ? 4 : -8,
          lateralSpeed: frame < 90 ? 5 : -5, turnSpeed: frame < 90 ? 4 : -4 };
        updateAvatarWeaponPose(av, { weapon, ads, crouching: crouch, movement, dt: 1 / 60 });
        updateAvatarStancePose(av);
        av.group.updateMatrixWorld(true);
        for (const [hand, anchor] of [[av.rHand, av.weaponModel.handPose.grip], [av.lHand, av.weaponModel.handPose.support]]) {
          if (!anchor) continue;
          const target = av.weaponModel.modelRoot.localToWorld(point.set(anchor.x, anchor.y, anchor.z));
          assert.ok(hand.getWorldPosition(new THREE.Vector3()).distanceTo(target) < 1e-6,
            'breathing, turns and landing keep the hands attached to their weapon');
        }
        for (const joint of [av.lArm, av.rArm, av.lElbow, av.rElbow, av.lHand, av.rHand]) {
          worstArmGap = Math.max(worstArmGap, pointPlayerDistance(joint.getWorldPosition(point).toArray(), p));
        }
        const head = playerHitboxes(p).find(box => box.zone === 'head');
        assert.ok(av.head.getWorldPosition(point).distanceTo(new THREE.Vector3(...head.center)) < 1e-8,
          'cosmetic motion never moves the authoritative head target');
        for (const leg of [av.lLeg, av.rLeg]) {
          leg.localToWorld(point.set(0, -0.65, 0));
          assert.ok(pointPlayerDistance(point.toArray(), p) < 0.01, 'airborne feet remain inside the standing leg envelope');
        }
        samples.push(av.torso.scale.z);
        checkedFrames++;
      }
      assert.ok(Math.max(...samples) - Math.min(...samples) > 0.006, 'idle breathing remains visible across the animation sequence');
    }
    assert.ok(worstArmGap < 0.025, `secondary movement stays inside existing arm margins: ${worstArmGap}`);
    resetAvatarPose(av);
    assert.deepEqual(av.torso.scale.toArray(), [1, 1, 1]);
    assert.equal(av.pack.rotation.x, 0);
    assert.equal(av.motion.landing, 0);
  } finally { disposeAvatar(av); }

  const scene = new THREE.Scene();
  const roster = new AvatarRoster({ scene });
  try {
    const remote = { id: 'remote-motion', name: 'Remote', x: 1, y: 2, z: 3, yaw: Math.PI - 0.01,
      pitch: 0, weapon: 0, state: 'alive', grounded: true, vaulting: false, moveSpeed: 0 };
    const remotes = new Map([[remote.id, remote]]);
    const sync = () => roster.sync(remotes, 1 / 60, 0);
    sync();
    const av = roster._avatars.get(remote.id);
    remote.yaw = -Math.PI + 0.01;
    sync();
    assert.ok(Math.abs(av.motion.turn) < 0.03, 'yaw wrap is a small direction change');
    remote.grounded = false;
    for (let frame = 0; frame < 20; frame++) { remote.y -= 0.08; sync(); }
    remote.grounded = true;
    remote.vaulting = true;
    for (let frame = 0; frame < 10; frame++) sync();
    assert.ok(av.motion.air > 0.95 && av.motion.landing === 0,
      'a level mantle finish does not impersonate a landing while vaulting');
    remote.vaulting = false;
    sync();
    assert.ok(av.motion.landing > 0, 'completing traversal recovers into the grounded pose');
    roster.respawn(remote.id, { x: 12, y: 4, z: 5 });
    Object.assign(remote, { x: 12, y: 4, z: 5 });
    sync();
    assert.equal(av.motion.landing, 0, 'respawn clears previous fall and landing motion');
    assert.equal(av.verticalSpeed, 0, 'respawn teleport is not measured as falling');
  } finally { roster.dispose(); }
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
console.log(`avatar motion tests passed: ${checkedFrames} movement frames, exact hand/head alignment, max arm gap ${worstArmGap.toFixed(4)}m, frame-rate parity and roster traversal/reset`);
