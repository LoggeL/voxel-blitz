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
} finally {
  disposeAvatar(av);
  delete globalThis.document;
}
console.log('stance animation passed: rigid limbs, planted crouch, continuous transitions, alternating crawl and reset');
