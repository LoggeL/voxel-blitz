import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { makeAvatar, updateAvatarWeaponPose, updateAvatarStancePose, resetAvatarPose, disposeAvatar } from '../public/js/avatar/avatar.js';

globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, {
  get: (object, key) => object[key] ?? (() => {}),
}) }) };
const av = makeAvatar('stance-animation', 'Stance');
const world = object => object.getWorldPosition(new THREE.Vector3());
const pose = (proneT, crouching = false, swing = 0, stride = 0) => {
  updateAvatarWeaponPose(av, { weapon: 'rifle', proneT, crouching, swing, stride, blend: 1 });
  updateAvatarStancePose(av, { swing, stride });
  av.group.updateMatrixWorld(true);
};
try {
  for (const crouching of [false, true]) {
    let previous;
    for (let frame = 0; frame <= 160; frame++) {
      pose(frame <= 80 ? frame / 80 : (160 - frame) / 80, crouching);
      const points = [];
      for (const leg of [av.lLeg, av.rLeg]) {
        const { thigh, knee, boot } = leg.userData.joints;
        const hip = world(thigh), joint = world(knee), ankle = world(boot);
        assert.ok(Math.abs(hip.distanceTo(joint) - 0.325) < 1e-8, 'thigh keeps its full length');
        assert.ok(Math.abs(joint.distanceTo(ankle) - 0.325) < 1e-8, 'shin keeps its full length');
        assert.ok(ankle.y >= 0.06, 'ankles stay above the floor throughout stance changes');
        points.push(joint, ankle);
      }
      if (previous) points.forEach((point, i) => assert.ok(point.distanceTo(previous[i]) < 0.045,
        'lowering, rising and reversing do not pop the joints'));
      previous = points;
    }
  }
  pose(0, true);
  assert.ok(av.lLeg.userData.joints.knee.rotation.x < -1, 'crouch has a visibly bent knee');
  const boot = world(av.lLeg.userData.joints.boot);
  assert.ok(Math.abs(boot.z) < 1e-8, 'crouched feet remain planted beneath the hips');
  pose(1, false, 0.16, 0.2);
  const left = world(av.lLeg.userData.joints.knee);
  const right = world(av.rLeg.userData.joints.knee);
  assert.ok(left.y > right.y + 0.08, 'one crawling knee recovers above the other');
  pose(1, false, -0.16, 0.2);
  assert.ok(world(av.rLeg.userData.joints.knee).y > world(av.lLeg.userData.joints.knee).y + 0.08,
    'crawl alternates the recovering knee');
  pose(1, false, 1, 0);
  assert.equal(av.lLeg.userData.joints.knee.rotation.x, av.rLeg.userData.joints.knee.rotation.x,
    'stopping the crawl settles both legs');
  resetAvatarPose(av);
  for (const leg of [av.lLeg, av.rLeg]) {
    assert.ok(Math.abs(leg.userData.joints.knee.rotation.x) < 1e-10);
    assert.equal(leg.userData.joints.skeleton.scale.y, 1);
  }

  // Swimming: a timed blend into a leaning stroke or an upright tread, the
  // weapon carried low, and everything finite through a whole cycle.
  const swim = ({ swimming, speed = 0, crouching = false, proneT = 0, ads = false, dt = 1 / 60 }) => {
    const stride = Math.min(1, speed / 5.8);
    updateAvatarWeaponPose(av, { weapon: 'rifle', swimming, speed, stride, crouching, proneT, ads, dt, blend: 1 });
    updateAvatarStancePose(av, { stride, blend: 1 });
    av.group.updateMatrixWorld(true);
  };
  const finite = () => {
    for (const part of [av.head, av.torso, av.hips, av.lLeg, av.rLeg, av.lArm, av.rArm, av.weaponModel.root]) {
      assert.ok([...part.position.toArray(), ...part.rotation.toArray().slice(0, 3), ...part.scale.toArray()]
        .every(Number.isFinite), 'swim pose stays finite');
    }
    assert.ok(Number.isFinite(av.swimBob) && Number.isFinite(av.swimHeadTilt));
  };
  swim({ swimming: false });
  const dryMountY = av.weaponModel.root.position.y, dryTorso = av.torso.rotation.x;
  swim({ swimming: true, speed: 2.6 });
  assert.ok(av.swimPose > 0.05 && av.swimPose < 0.2, `entering water eases in over frames, not instantly (${av.swimPose})`);
  let previous = av.swimPose;
  for (let frame = 0; frame < 30; frame++) {
    swim({ swimming: true, speed: 2.6 });
    assert.ok(av.swimPose >= previous, 'the swim blend is monotonic');
    previous = av.swimPose;
    finite();
  }
  assert.ok(av.swimPose > 0.9, 'half a second settles the swim pose');
  for (let frame = 0; frame < 60; frame++) swim({ swimming: true, speed: 2.6 });
  assert.ok(av.torso.rotation.x < dryTorso - 0.2, 'a moving swimmer leans forward');
  assert.ok(av.lLeg.rotation.x < -0.08 && av.rLeg.rotation.x < -0.08, 'both legs trail behind the swimmer');
  assert.ok(av.swimHeadTilt < -0.15, 'the head lifts its chin out of the water');
  assert.ok(av.weaponModel.root.position.y < dryMountY - 0.025, 'the weapon is carried low while swimming');
  assert.ok(av.weaponModel.root.rotation.x < -0.04 && av.weaponModel.root.rotation.z > 0.03,
    'the carried weapon dips its muzzle and cants outward');
  const kicks = [];
  for (let frame = 0; frame < 120; frame++) {
    swim({ swimming: true, speed: 2.6 });
    kicks.push(av.lLeg.rotation.x - av.rLeg.rotation.x);
    finite();
  }
  assert.ok(Math.max(...kicks) > 0.08 && Math.min(...kicks) < -0.08, 'the flutter kick alternates the legs');
  for (const [hand, anchor] of [[av.rHand, av.weaponModel.handPose.grip], [av.lHand, av.weaponModel.handPose.support]]) {
    const expected = av.weaponModel.modelRoot.localToWorld(new THREE.Vector3(anchor.x, anchor.y, anchor.z));
    assert.ok(world(hand).distanceTo(expected) < 1e-6, 'both hands stay on the carried weapon');
  }
  swim({ swimming: true, speed: 2.6, ads: true });
  for (let frame = 0; frame < 90; frame++) swim({ swimming: true, speed: 2.6, ads: true });
  assert.ok(av.weaponModel.root.position.y > dryMountY + 0.1, 'aiming lifts the weapon back to the sight line in water');
  // Treading: upright, quiet legs, a gentle bob.
  for (let frame = 0; frame < 120; frame++) swim({ swimming: true, speed: 0 });
  const treadLean = av.torso.rotation.x;
  assert.ok(treadLean < dryTorso - 0.03 && treadLean > dryTorso - 0.15, `treading is nearly upright (${treadLean})`);
  assert.ok(Math.abs(av.lLeg.rotation.x) < 0.05 && Math.abs(av.rLeg.rotation.x) < 0.05, 'treading legs hang quietly');
  const bobs = [];
  for (let frame = 0; frame < 180; frame++) { swim({ swimming: true, speed: 0 }); bobs.push(av.swimBob); finite(); }
  assert.ok(Math.max(...bobs) > 0.008 && Math.min(...bobs) < -0.008 && Math.max(...bobs) < 0.02, 'treading bobs gently');
  // Crouch (the dive input) and prone keep their hitbox-backed stances.
  for (let frame = 0; frame < 120; frame++) swim({ swimming: true, speed: 2.6, crouching: true });
  assert.ok(Math.abs(av.swimLean) < 0.03 && av.lLeg.rotation.x > -0.03, 'a crouched (diving) swimmer shows the crouch, not the lean');
  for (let frame = 0; frame < 120; frame++) swim({ swimming: true, speed: 1, proneT: 1 });
  assert.ok(Math.abs(av.swimLean) < 1e-6 && Math.abs(av.torso.rotation.x + Math.PI / 2) < 1e-6, 'prone wins over the swim lean');
  // Leaving the water eases back to the dry stance and reset clears it.
  for (let frame = 0; frame < 120; frame++) swim({ swimming: true, speed: 0 });
  swim({ swimming: false });
  assert.ok(av.swimPose > 0.8 && av.swimPose < 1, 'leaving the water blends out over frames');
  for (let frame = 0; frame < 120; frame++) swim({ swimming: false });
  // The carried weapon still breathes by up to 4 mm around its settled mount.
  assert.ok(av.swimPose < 0.01 && Math.abs(av.torso.rotation.x - dryTorso) < 0.02 &&
    Math.abs(av.weaponModel.root.position.y - dryMountY) < 0.01, 'the dry stance and carry return');
  swim({ swimming: true, speed: 2.6 });
  resetAvatarPose(av);
  assert.equal(av.swimPose, 0);
  assert.equal(av.swimPhase, 0);
  assert.equal(av.swimBob, 0);
  assert.equal(av.hips.rotation.x, 0);
} finally {
  disposeAvatar(av);
  delete globalThis.document;
}
console.log('stance animation passed: rigid limbs, planted crouch, continuous transitions, alternating crawl, swim blend/stroke/tread/carry and reset');
