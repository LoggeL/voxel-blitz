import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { WeaponActions, syncArcherAmmo } from '../public/js/guns/actions.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${label}: ${actual} != ${expected}`);
const cache = new MaterialCache();
const models = [];
function makeModel() {
  const model = buildGun('archer', cache);
  models.push(model);
  assert.ok(model.extra.userData.archer.round, 'the real ARCHER exports its loading rocket');
  return model;
}

try {
  const model = makeModel();
  const archer = model.extra.userData.archer;
  const hand = model.root.getObjectByName('hand_l');
  const handHome = { position: hand.position.clone(), quaternion: hand.quaternion.clone(), visible: hand.visible };
  const clicks = [];
  const action = new WeaponActions({ onReloadClick: n => clicks.push(n) });
  const at = frac => action.update(frac, 0, model, model.T);
  syncArcherAmmo(archer, 0);
  assert.equal(archer.chambered.visible, false, 'empty authority removes the chambered missile');
  assert.equal(archer.round.visible, false, 'empty idle does not display a spare rocket');
  assert.equal(action.startReload(0, 1, 'magswap', model.T), true);
  at(0.33);
  assert.ok(archer.gate.position.equals(archer.hinge), 'top shell remains on its right hinge');
  assert.ok(archer.gate.rotation.z < -1.89, 'breech fully opens before a new rocket enters');
  assert.equal(archer.round.visible, false);
  at(0.49);
  assert.equal(archer.round.visible, true, 'a full rocket is carried into view');
  assert.ok(archer.round.position.x < -0.15 && archer.round.position.y > archer.axisY + 0.20,
    'rocket arrives from above-left on the side opposite the open lid');
  assert.ok(hand.position.distanceTo(handHome.position) > 0.1, 'support hand carries the missile');
  near(archer.round.rotation.y, 1.0, 'incoming rocket presents its full profile instead of its exhaust');
  at(0.62);
  assert.ok(archer.round.rotation.y > 0.3 && archer.round.rotation.y < 0.6,
    'the complete rocket remains readable while turning toward the bore');
  at(0.68);
  near(archer.round.position.x, archer.seat.x, 'rocket aligns above the trough');
  near(archer.round.rotation.y, 0, 'missile aligns with the bore');
  near(archer.round.position.y, archer.axisY + 0.21, 'missile clears the trough before lowering');
  at(0.75);
  near(archer.round.position.y, archer.axisY, 'rocket lowers into the loading trough');
  near(archer.round.position.z, archer.seat.z + 0.10, 'round has a distinct forward seating stroke');
  at(model.T.magTimeline.home);
  assert.ok(archer.round.position.distanceTo(archer.seat) < 1e-8, 'rocket seats at the unchanged second cue');
  assert.equal(archer.round.visible, true, 'seating never erases the new rocket');
  assert.equal(archer.chambered.visible, false, 'the action never creates authoritative ammunition');
  at(0.89);
  assert.ok(archer.gate.rotation.z > -1.8 && archer.gate.rotation.z < -0.1,
    'the lid closes after the rocket seats');
  syncArcherAmmo(archer, 1);
  assert.equal(archer.round.visible, true, 'an early ammo update cannot interrupt the seating prop');
  assert.equal(archer.chambered.visible, false, 'a live reload never draws two rockets');
  at(model.T.magTimeline.clickAt);
  near(archer.gate.rotation.z, 0, 'lid latches at the unchanged third cue');
  assert.deepEqual(clicks, [1, 2, 3]);
  at(0.99);
  assert.equal(action.reloading, true, 'cosmetic seating does not shorten reload time');
  at(1);
  assert.equal(action.reloading, false);
  assert.equal(archer.round.visible, false);
  assert.equal(archer.chambered.visible, true, 'completed reload shows the authoritative chamber');
  assert.ok(hand.position.equals(handHome.position) && hand.quaternion.equals(handHome.quaternion));
  assert.equal(hand.visible, handHome.visible, 'support hand returns to its original visibility');
  action.dispose(model);

  // The same contacts must survive frame skips without duplicates, and a failed
  // reload must remain empty even after the lid has visibly closed.
  for (const samples of [Array.from({ length: 121 }, (_, i) => i / 120), [0.17, 0.95, 1.01], [1.01]]) {
    const gun = makeModel();
    const parts = gun.extra.userData.archer;
    const cues = [];
    const controller = new WeaponActions({ onReloadClick: n => cues.push(n) });
    syncArcherAmmo(parts, 0);
    controller.startReload(0, 1, 'magswap', gun.T);
    for (const sample of samples) controller.update(sample, 0, gun, gun.T);
    assert.deepEqual(cues, [1, 2, 3], 'dense and sparse updates cross each cue once');
    assert.equal(parts.chambered.visible, false, 'animation completion alone never grants a rocket');
    assert.equal(parts.round.visible, false);
    controller.dispose(gun);
  }
  for (const mag of [0, 1]) for (const fraction of [0.26, 0.51, 0.85, 0.96]) {
    const gun = makeModel();
    const parts = gun.extra.userData.archer;
    const controller = new WeaponActions();
    const palm = gun.root.getObjectByName('hand_l');
    const home = palm.position.clone();
    syncArcherAmmo(parts, mag);
    controller.startReload(0, 1, 'magswap', gun.T);
    controller.update(fraction, 0, gun, gun.T);
    assert.equal(controller.cancelReload(gun), true);
    assert.equal(parts.chambered.visible, mag > 0, 'cancel uses the latest ammo, even after seating');
    assert.equal(parts.round.visible, false);
    assert.ok(parts.round.position.equals(parts.seat));
    near(parts.gate.rotation.z, 0, 'cancel shuts the top shell');
    assert.ok(parts.gate.position.equals(parts.hinge));
    assert.ok(palm.position.equals(home), 'cancel restores the support hand');
    controller.update(1.2, 0, gun, gun.T);
    assert.equal(parts.chambered.visible, mag > 0, 'cancelled actions cannot revive a round');
    controller.dispose(gun);
  }
} finally { disposeGunModels(models, cache); }

// Test the public rig API with real geometry, including restored server progress.
{
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 100));
  try {
    rig.setArcher({ mag: 0 });
    rig.setWeapon('archer');
    const parts = rig._cur.extra.userData.archer;
    assert.equal(parts.chambered.visible, false, 'authority set before lazy model creation is retained');
    rig.setArcher({ mag: 1 });
    assert.equal(parts.chambered.visible, true, 'ammo updates are reflected before the next render tick');
    for (let i = 0; i < 180; i++) rig.update(1 / 60);
    assert.equal(rig.fire(WEAPONS.archer), true);
    assert.equal(parts.chambered.visible, false, 'an accepted launch immediately clears the loaded missile');
    assert.equal(parts.authoritativeMag, 0);
    rig.reload(WEAPONS.archer.reloadTime, 'magswap', null, WEAPONS.archer.reloadTime * 0.70);
    assert.equal(parts.round.visible, true, 'server reload recovery seeks the rocket immediately');
    assert.ok(parts.gate.rotation.z < -1.89);
    assert.ok(parts.round.position.y > parts.axisY && parts.round.position.y < parts.axisY + 0.21);
    rig.setWeapon('rifle');
    assert.equal(parts.round.visible, false, 'switch stows the in-flight prop');
    assert.equal(parts.chambered.visible, false, 'switch cannot turn an empty launcher into a loaded one');
    near(parts.gate.rotation.z, 0, 'switch closes the shell');
    rig.setArcher({ mag: 1 });
    rig.setWeapon('archer');
    assert.equal(parts.chambered.visible, true, 'updates received while holstered survive redrawing');
    rig.setArcher({ mag: 0 });
    rig.reload(1, 'magswap', null, 0.95);
    rig.cancelReload();
    assert.equal(parts.chambered.visible, false, 'late rig cancellation never grants ammunition');
    rig.setArcher({ mag: 1 });
    rig.setArcher({ mag: 0 });
    rig.update(1 / 60);
    assert.equal(parts.chambered.visible, false, 'a corrected empty snapshot survives later poses');
  } finally { rig.dispose(); }
}

// A portrait camera must see the whole missile during its presentation, while
// aiming keeps the same model scale and sight line as the desktop camera.
{
  const camera = new THREE.PerspectiveCamera(75, 390 / 844, 0.01, 100);
  const rig = new ViewmodelRig(camera);
  try {
    rig.setWeapon('archer');
    rig.setArcher({ mag: 0 });
    for (let i = 0; i < 180; i++) rig.update(1 / 60);
    const muzzle = rig._cur.muzzleMarker.position.clone();
    const projected = new THREE.Vector3();
    for (const fraction of [0.45, 0.62, 0.75, 0.84]) {
      rig.reload(WEAPONS.archer.reloadTime, 'magswap', null, WEAPONS.archer.reloadTime * fraction);
      rig.update(0);
      camera.updateMatrixWorld(true);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      rig._cur.extra.userData.archer.round.traverseVisible(node => {
        if (!node.isMesh) return;
        const positions = node.geometry.attributes.position;
        for (let index = 0; index < positions.count; index++) {
          projected.fromBufferAttribute(positions, index).applyMatrix4(node.matrixWorld).project(camera);
          minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x);
          minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y);
        }
      });
      assert.ok(minX >= -1 && maxX <= 1 && minY >= -1 && maxY <= 1,
        `portrait ${fraction}: entire loading rocket fits the camera (${minX}, ${maxX}, ${minY}, ${maxY})`);
      rig.cancelReload();
    }
    assert.ok(rig.content.scale.x < 0.73, 'portrait hip presentation makes room for the breech');
    rig.ads(1);
    for (let i = 0; i < 180; i++) rig.update(1 / 60);
    near(rig.content.scale.x, 1, 'portrait ADS preserves full sight scale');
    const aim = rig.content.position.clone();
    camera.aspect = 16 / 9;
    camera.updateProjectionMatrix();
    rig.update(0);
    assert.ok(rig.content.position.distanceTo(aim) < 1e-8, 'ADS sight line is independent of aspect framing');
    assert.ok(rig._cur.muzzleMarker.position.equals(muzzle), 'framing leaves the local muzzle anchor unchanged');
  } finally { rig.dispose(); }
}

// Match runtime order: reload simulation, ammo/ADS sync, then the render rig.
{
  let now = 0;
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera());
  const state = new WeaponState({ rig, now: () => now,
    audio: { draw() {}, fire() {}, reloadClick() {} }, effects: { shoot() {} },
    feedback: { addExhaustion() {}, addRecoil() {} },
    setTimer: () => 0, clearTimer() {}, random: () => 0.5,
    network: { isCurrentGeneration: () => true, isRunning: () => true } });
  try {
    state.resetToLoadout();
    assert.equal(state.forceWeapon(WEAPON_IDS.indexOf('archer'),
      { now, mode: 'titanfall', owned: ['rifle', 'revolver', 'archer', 'knife'] }), true);
    for (let i = 0; i < 180; i++) rig.update(1 / 60);
    now = 3000;
    state.syncRigAds();
    const parts = rig._cur.extra.userData.archer;
    assert.equal(parts.chambered.visible, true);
    const context = { allowFire: true, alive: true };
    state.applyIntents({ fireTap: true }, now, context);
    assert.equal(state.tryFire(now, context), true);
    assert.equal(state.ammoOf('archer').mag, 0);
    assert.equal(parts.chambered.visible, false, 'weapon-state shot updates the mesh in the accepting frame');
    assert.equal(state.startReload(now), true);
    const start = now;
    for (let frame = 1; frame <= Math.ceil(WEAPONS.archer.reloadTime * 120) + 1; frame++) {
      now = start + frame * 1000 / 120;
      state.tickReload(now);
      state.syncRigAds();
      rig.update(1 / 120);
    }
    assert.equal(state.ammoOf('archer').mag, 1);
    assert.equal(parts.round.visible, false);
    assert.equal(parts.chambered.visible, true, 'same-frame authority preserves the newly seated rocket');
    const mag = WEAPON_IDS.map(id => state.ammoOf(id).mag);
    const reserve = WEAPON_IDS.map(id => state.ammoOf(id).reserve);
    mag[WEAPON_IDS.indexOf('archer')] = 0;
    state.adoptServerAmmo(mag, reserve);
    state.syncRigAds();
    rig.update(1 / 120);
    assert.equal(parts.chambered.visible, false, 'server correction removes a predicted completed round');

    const rejectReload = () => state.reconcileServer({ mag, reserve, reloading: false,
      reloadAck: state.reloadId, weapon: WEAPON_IDS.indexOf('archer') }, now);
    const advance = seconds => {
      const frames = Math.ceil(seconds * 120);
      for (let frame = 0; frame < frames; frame++) {
        now += seconds * 1000 / frames;
        state.tickReload(now);
        state.syncRigAds();
        rig.update(seconds / frames);
      }
    };
    rejectReload();
    assert.equal(state.startReload(now), true);
    advance(WEAPONS.archer.reloadTime * 0.70);
    assert.equal(parts.round.visible, true);
    rejectReload();
    assert.equal(parts.round.visible, false, 'identified server rejection stows a moving rocket');
    assert.equal(parts.chambered.visible, false, 'rejected reload preserves empty authority');

    assert.equal(state.startReload(now), true);
    advance(WEAPONS.archer.reloadTime * 0.70);
    assert.equal(state.forceWeapon(WEAPON_IDS.indexOf('rifle'), { now }), true);
    assert.equal(parts.round.visible, false, 'actual state-to-equip switch cancels the rocket before holstering');
    advance(1);
    assert.equal(rig._id, 'rifle');
    assert.equal(state.forceWeapon(WEAPON_IDS.indexOf('archer'), { now }), true);
    advance(1.5);
    assert.equal(parts.chambered.visible, false, 'empty authority survives the complete holster and redraw');
    assert.equal(state.startReload(now), true);
    advance(WEAPONS.archer.reloadTime * 0.70);
    state.deathReset();
    assert.equal(parts.round.visible, false, 'death reset stows the rocket mid-reload');
    assert.equal(parts.chambered.visible, false, 'death never completes an interrupted load');
    near(parts.gate.rotation.z, 0, 'death reset closes the breech');
  } finally { state.dispose(); rig.dispose(); }
}

console.log('ARCHER: real rocket loading path, authority, sparse/dense cues, seek, shot, cancellation and switching passed.');
