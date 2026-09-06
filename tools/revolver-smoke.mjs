import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';
import { WeaponActions } from '../public/js/guns/actions.js';

const cache = new MaterialCache();
const model = buildGun('revolver', cache);
const clicks = [];
assert.equal(model.T.ejectOnFire, false, 'cases stay in the revolver until reload');
const actions = new WeaponActions({ onReloadClick: (id) => clicks.push(id) });
const parts = model.extra.userData.revolver;
const center = () => { model.root.updateMatrixWorld(true); return parts.cylinder.getWorldPosition(new THREE.Vector3()); };
const home = center();
for (let i = 0; i < 6; i++) {
  actions.startJerk('revolver', model, 0.025, 0.075);
  for (let frame = 0; frame < 12; frame++) actions.update(0, 0.01, model, model.T);
  assert(center().distanceTo(home) < 1e-10, 'firing must not orbit the cylinder center');
  assert.equal(parts.hammer.rotation.x, 0, 'hammer returns to its pin stop');
  assert.equal(model.bolt.position.z, 0, 'revolver has no reciprocating slide');
}
assert(Math.abs(parts.cylinder.rotation.z - Math.PI * 2) < 1e-10, 'six shots index six chambers');
actions.startReload(0, 1, 'cylinder', model.T);
for (const frac of [0.26, 0.40, 0.55, 0.67, 0.70]) {
  actions.update(frac, 0, model, model.T);
  assert.equal(parts.crane.rotation.z, Math.PI / 2, 'crane holds fully open during extraction and insertion');
  assert(Math.abs(center().x + 0.058) < 1e-10, 'crane follows bore-parallel hinge');
  if (frac === 0.40) assert(parts.cases.position.z > 0.1, 'spent cases move out the back');
  if (frac === 0.55) assert.equal(parts.cases.visible, false, 'empty chambers before insertion');
  if (frac === 0.55 || frac === 0.67) {
    const loader = model.extra.userData.reloadRounds;
    assert.equal(loader.position.x, -0.058, 'loader aligns with swung-out cylinder');
    assert.equal(loader.position.y, -0.052, 'loader travels axially without sideways drift');
    assert.equal(loader.rotation.z, parts.crane.rotation.z + parts.cylinder.rotation.z,
      'six loader rounds line up with the six open chambers');
  }
}
actions.update(1, 0, model, model.T);
assert.deepEqual(clicks, [1, 2, 3]);
assert(center().distanceTo(home) < 1e-10);
assert.equal(model.extra.userData.reloadRounds.visible, false);
actions.startReload(2, 1, 'cylinder', model.T);
actions.update(2.4, 0, model, model.T);
actions.cancelReload(model);
assert(center().distanceTo(home) < 1e-10, 'cancel restores crane and cylinder');
assert.equal(parts.cases.position.length(), 0);
actions.startReload(3, 1, 'cylinder', model.T);
actions.update(3.72, 0, model, model.T);
actions.cancelReload(model);
assert(model.extra.userData.reloadRounds.children.every((child) => child.visible), 'cancel restores loader rounds');
assert.equal(model.extra.userData.reloadRounds.rotation.z, 0, 'cancel resets loader orientation');
actions.dispose(model);
disposeGunModels([model], cache);
console.log('revolver: firing axis, hammer, extraction, axial loader, latch and cancellation passed');
