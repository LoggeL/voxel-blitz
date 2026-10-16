import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { WeaponActions, syncRocketAmmo } from '../public/js/guns/actions.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';
import { ROCKET_GATE_SWING, ROCKET_HINGE, ROCKET_SEAT } from '../public/js/guns/models/rocket.js';
import { AvatarWeaponModel } from '../public/js/avatar/avatar-weapon.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';
import { beginAvatarDeath, resetAvatarPose } from '../public/js/avatar/avatar.js';

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${label}: ${actual} != ${expected}`);
const cache = new MaterialCache();
const models = [];
function makeModel() {
  const model = buildGun('rocket', cache);
  models.push(model);
  const parts = model.extra.userData.rocketReload;
  assert.ok(parts?.gate && parts?.chambered && parts?.round,
    'buildGun(rocket) populates rocketReload contract groups');
  return model;
}

try {
  const model = makeModel();
  assert.equal(model.bolt.children.length, 0, 'rocket bolt excludes generic 5cm glow cap');
  const rocket = model.extra.userData.rocketReload;
  assert.ok(rocket.hinge.equals(ROCKET_HINGE), 'rocket hinge matches ROCKET_HINGE');
  assert.ok(rocket.seat.equals(ROCKET_SEAT), 'rocket seat matches ROCKET_SEAT');
  assert.equal(rocket.swing, ROCKET_GATE_SWING, 'rocket swing matches ROCKET_GATE_SWING');
  const roundBox = new THREE.Box3().setFromObject(rocket.round);
  near(roundBox.min.z, -0.245, 'procedural round nose tip at z = -0.245');
  near(roundBox.max.z, 0.15, 'procedural round tail nozzle at z = +0.150');

  const hand = model.root.getObjectByName('hand_l');
  const handHome = { position: hand.position.clone(), quaternion: hand.quaternion.clone(), visible: hand.visible };
  const clicks = [];
  const action = new WeaponActions({ onReloadClick: n => clicks.push(n) });
  const at = frac => action.update(frac, 0, model, model.T);

  syncRocketAmmo(rocket, 0);
  assert.equal(rocket.chambered.visible, false, 'empty authority removes the chambered warhead');
  assert.equal(rocket.round.visible, false, 'empty idle does not display a reload rocket');
  assert.equal(action.startReload(0, 1, 'magswap', model.T), true);

  at(0.32);
  assert.ok(rocket.gate.position.equals(rocket.hinge), 'breech gate remains on its left hinge');
  assert.ok(rocket.gate.rotation.y < -1.7, 'breech fully opens before a new rocket enters');
  assert.equal(rocket.round.visible, false);
  assert.equal(rocket.chambered.visible, false);

  at(0.45);
  assert.equal(rocket.round.visible, true, 'a full rocket round is carried into view');
  assert.equal(rocket.chambered.visible, false);
  assert.ok(rocket.round.position.x > 0.25, 'rocket arrives on the gate-free (+x) flank');
  assert.ok(hand.position.distanceTo(handHome.position) > 0.1, 'support hand carries the rocket');

  at(0.68);
  near(rocket.round.position.x, rocket.seat.x, 'rocket aligns with the bore x');
  near(rocket.round.position.y, rocket.seat.y, 'rocket aligns with the bore y');
  near(rocket.round.rotation.y, 0, 'rocket aligns with the bore axis');
  assert.ok(rocket.round.position.z - 0.245 > rocket.rearZ + 0.11, 'nose clears the breech mouth before insertion');
  const alignedZ = rocket.round.position.z;
  at(0.81);
  assert.ok(rocket.round.position.z < alignedZ - 0.5, 'rocket shoves forward along the bore axis');
  assert.equal(rocket.round.visible, true);
  assert.equal(rocket.chambered.visible, false);

  at(model.T.magTimeline.home);
  assert.ok(rocket.round.position.distanceTo(rocket.seat) < 1e-8, 'rocket reaches ROCKET_SEAT at timeline.home (0.84)');
  assert.equal(rocket.round.visible, false, 'incoming reload round hides once seated at 0.84');
  assert.equal(rocket.chambered.visible, true, 'seated warhead appears in the bore at 0.84 while gate closes');

  at(0.90);
  assert.ok(rocket.gate.rotation.y < -0.5 && rocket.gate.rotation.y > -1.7, 'gate swings shut over the seated warhead');
  assert.equal(rocket.chambered.visible, true);
  assert.equal(rocket.round.visible, false);

  at(model.T.magTimeline.clickAt);
  assert.deepEqual(clicks, [1, 2, 3], 'all three reload clicks fire on schedule');

  at(0.94);
  near(rocket.gate.rotation.y, 0, 'breech gate latches shut');
  near(model.bolt.rotation.x, 0, 'arming lever cocks home');
  assert.equal(rocket.chambered.visible, true);

  // If authoritative ammo becomes 1 before completion, completion keeps chambered visible;
  // if authoritative ammo stays 0 (unacknowledged/rejected), completion hides chambered!
  syncRocketAmmo(rocket, 1);
  at(1);
  assert.equal(action.reloading, false);
  assert.equal(rocket.reloading, false);
  assert.equal(rocket.seated, false);
  assert.equal(rocket.round.visible, false);
  assert.equal(rocket.chambered.visible, true, 'completed reload with authoritative ammo shows chambered warhead');
  assert.ok(hand.position.equals(handHome.position) && hand.quaternion.equals(handHome.quaternion));
  assert.equal(hand.visible, handHome.visible, 'support hand returns to its original visibility');
  action.dispose(model);

  // Sparse and dense updates cross each cue once, and completion without ammo authority stays empty.
  for (const samples of [Array.from({ length: 121 }, (_, i) => i / 120), [0.22, 0.85, 0.95, 1.01], [1.01]]) {
    const gun = makeModel();
    const parts = gun.extra.userData.rocketReload;
    const cues = [];
    const controller = new WeaponActions({ onReloadClick: n => cues.push(n) });
    syncRocketAmmo(parts, 0);
    controller.startReload(0, 1, 'magswap', gun.T);
    for (const sample of samples) controller.update(sample, 0, gun, gun.T);
    assert.deepEqual(cues, [1, 2, 3], 'dense and sparse updates cross each cue once');
    assert.equal(parts.chambered.visible, false, 'animation completion alone never grants a warhead without ammo authority');
    assert.equal(parts.round.visible, false);
    controller.dispose(gun);
  }

  for (const mag of [0, 1]) for (const fraction of [0.26, 0.51, 0.85, 0.96]) {
    const gun = makeModel();
    const parts = gun.extra.userData.rocketReload;
    const controller = new WeaponActions();
    const palm = gun.root.getObjectByName('hand_l');
    const home = palm.position.clone();
    syncRocketAmmo(parts, mag);
    controller.startReload(0, 1, 'magswap', gun.T);
    controller.update(fraction, 0, gun, gun.T);
    assert.equal(controller.cancelReload(gun), true);
    assert.equal(parts.chambered.visible, mag > 0, 'cancel uses the latest authoritative ammo, even after seating');
    assert.equal(parts.round.visible, false);
    assert.ok(parts.round.position.equals(parts.round.userData.homePosition));
    near(parts.gate.rotation.y, 0, 'cancel shuts the breech gate');
    assert.ok(parts.gate.position.equals(parts.hinge));
    assert.ok(palm.position.equals(home), 'cancel restores the support hand');
    controller.update(1.2, 0, gun, gun.T);
    assert.equal(parts.chambered.visible, mag > 0, 'cancelled actions cannot revive a round');
    controller.dispose(gun);
  }
} finally {
  disposeGunModels(models, cache);
}

// Public ViewmodelRig API, including lazy creation, firing, server reload seek, and weapon swap.
{
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 100));
  try {
    rig.setRocket({ mag: 0 });
    rig.setWeapon('rocket');
    const parts = rig._cur.extra.userData.rocketReload;
    assert.equal(parts.chambered.visible, false, 'authority set before lazy model creation is retained');
    rig.setRocket({ mag: 1 });
    assert.equal(parts.chambered.visible, true, 'ammo updates are reflected before the next render tick');
    for (let i = 0; i < 180; i++) rig.update(1 / 60);
    assert.equal(rig.fire(WEAPONS.rocket), true);
    assert.equal(parts.chambered.visible, false, 'an accepted launch immediately clears the chambered warhead');
    assert.equal(parts.authoritativeMag, 0);
    rig.reload(WEAPONS.rocket.reloadTime, 'magswap', null, WEAPONS.rocket.reloadTime * 0.70);
    assert.equal(parts.round.visible, true, 'server reload recovery seeks the rocket immediately');
    assert.ok(parts.gate.rotation.y < -1.7);
    rig.setWeapon('rifle');
    assert.equal(parts.round.visible, false, 'switch stows the in-flight prop');
    assert.equal(parts.chambered.visible, false, 'switch cannot turn an empty launcher into a loaded one');
    near(parts.gate.rotation.y, 0, 'switch closes the breech gate');
    rig.setRocket({ mag: 1 });
    rig.setWeapon('rocket');
    assert.equal(parts.chambered.visible, true, 'updates received while holstered survive redrawing');
    rig.setRocket({ mag: 0 });
    rig.reload(1, 'magswap', null, 0.90);
    assert.equal(parts.chambered.visible, true, 'seated phase shows chambered warhead during reload');
    rig.cancelReload();
    assert.equal(parts.chambered.visible, false, 'late rig cancellation restores empty authority');
  } finally {
    rig.dispose();
  }
}

// Portrait phone frustum check: the swung breech gate and incoming rocket round stay inside the horizontal frustum.
{
  const camera = new THREE.PerspectiveCamera(75, 390 / 844, 0.01, 100);
  const rig = new ViewmodelRig(camera);
  try {
    rig.setWeapon('rocket');
    rig.setRocket({ mag: 0 });
    for (let i = 0; i < 180; i++) rig.update(1 / 60);
    const muzzle = rig._cur.muzzleMarker.position.clone();
    const projected = new THREE.Vector3();
    for (const fraction of [0.35, 0.50, 0.68, 0.80, 0.88]) {
      rig.reload(WEAPONS.rocket.reloadTime, 'magswap', null, WEAPONS.rocket.reloadTime * fraction);
      rig.update(0.001); // update(0) is a no-op; one 1 ms frame composes the presented reload pose
      camera.updateMatrixWorld(true);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const targetGroup = fraction < 0.84
        ? rig._cur.extra.userData.rocketReload.round
        : rig._cur.extra.userData.rocketReload.chambered;
      targetGroup.traverseVisible(node => {
        if (!node.isMesh) return;
        const positions = node.geometry.attributes.position;
        for (let index = 0; index < positions.count; index++) {
          projected.fromBufferAttribute(positions, index).applyMatrix4(node.matrixWorld).project(camera);
          minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x);
          minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y);
        }
      });
      assert.ok(minX >= -1 && maxX <= 1 && minY >= -1 && maxY <= 1,
        `portrait ${fraction}: rocket round fits camera frustum (${minX}, ${maxX}, ${minY}, ${maxY})`);
      rig.cancelReload();
    }
    assert.ok(rig.content.scale.x < 0.73, 'portrait hip presentation scales down to make room for the breech');
    rig.ads(1);
    for (let i = 0; i < 180; i++) rig.update(1 / 60);
    near(rig.content.scale.x, 1, 'portrait ADS preserves full sight scale');
    const aim = rig.content.position.clone();
    camera.aspect = 16 / 9;
    camera.updateProjectionMatrix();
    rig.update(0);
    assert.ok(rig.content.position.distanceTo(aim) < 1e-8, 'ADS sight line is independent of aspect framing');
    assert.ok(rig._cur.muzzleMarker.position.equals(muzzle), 'framing leaves the local muzzle anchor unchanged');
  } finally {
    rig.dispose();
  }
}

// WeaponState integration: reload simulation, ammo/ADS sync, server rejection, swap and death reset.
{
  let now = 0;
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera());
  const state = new WeaponState({
    rig,
    now: () => now,
    audio: { draw() {}, fire() {}, reloadClick() {} },
    effects: { shoot() {} },
    feedback: { addExhaustion() {}, addRecoil() {} },
    setTimer: () => 0,
    clearTimer() {},
    random: () => 0.5,
    network: { isCurrentGeneration: () => true, isRunning: () => true },
  });
  try {
    state.resetToLoadout();
    assert.equal(state.forceWeapon(WEAPON_IDS.indexOf('rocket'), { now }), true);
    for (let i = 0; i < 180; i++) rig.update(1 / 60);
    now = 3000;
    state.syncRigAds();
    const parts = rig._cur.extra.userData.rocketReload;
    assert.equal(parts.chambered.visible, true);
    const context = { allowFire: true, alive: true };
    state.applyIntents({ fireTap: true }, now, context);
    assert.equal(state.tryFire(now, context), true);
    assert.equal(state.ammoOf('rocket').mag, 0);
    assert.equal(parts.chambered.visible, false, 'weapon-state shot updates the mesh in the accepting frame');
    assert.equal(state.startReload(now), true);
    const start = now;
    for (let frame = 1; frame <= Math.ceil(WEAPONS.rocket.reloadTime * 120) + 1; frame++) {
      now = start + frame * 1000 / 120;
      state.tickReload(now);
      state.syncRigAds();
      rig.update(1 / 120);
    }
    assert.equal(state.ammoOf('rocket').mag, 1);
    assert.equal(parts.round.visible, false);
    assert.equal(parts.chambered.visible, true, 'same-frame authority preserves the newly seated rocket');
    const mag = WEAPON_IDS.map(id => state.ammoOf(id).mag);
    const reserve = WEAPON_IDS.map(id => state.ammoOf(id).reserve);
    mag[WEAPON_IDS.indexOf('rocket')] = 0;
    state.adoptServerAmmo(mag, reserve);
    state.syncRigAds();
    rig.update(1 / 120);
    assert.equal(parts.chambered.visible, false, 'server correction removes a predicted completed round');

    const rejectReload = () => state.reconcileServer({
      mag, reserve, reloading: false, reloadAck: state.reloadId, weapon: WEAPON_IDS.indexOf('rocket'),
    }, now);
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
    advance(WEAPONS.rocket.reloadTime * 0.70);
    assert.equal(parts.round.visible, true);
    rejectReload();
    assert.equal(parts.round.visible, false, 'identified server rejection stows a moving rocket');
    assert.equal(parts.chambered.visible, false, 'rejected reload preserves empty authority');

    assert.equal(state.startReload(now), true);
    advance(WEAPONS.rocket.reloadTime * 0.70);
    assert.equal(state.forceWeapon(WEAPON_IDS.indexOf('rifle'), { now }), true);
    assert.equal(parts.round.visible, false, 'actual state-to-equip switch cancels the rocket before holstering');
    advance(1);
    assert.equal(rig._id, 'rifle');
    assert.equal(state.forceWeapon(WEAPON_IDS.indexOf('rocket'), { now }), true);
    advance(1.5);
    assert.equal(parts.chambered.visible, false, 'empty authority survives the complete holster and redraw');
    assert.equal(state.startReload(now), true);
    advance(WEAPONS.rocket.reloadTime * 0.70);
    state.deathReset();
    assert.equal(parts.round.visible, false, 'death reset stows the rocket mid-reload');
    assert.equal(parts.chambered.visible, false, 'death never completes an interrupted load');
    near(parts.gate.rotation.y, 0, 'death reset closes the breech');
  } finally {
    state.dispose();
    rig.dispose();
  }
}

// Remote AvatarWeaponModel & AvatarRoster reload and support-hand tracking for 'rocket'.
{
  const duration = WEAPONS.rocket.reloadTime;
  const mount = new AvatarWeaponModel();
  const update = (state = {}) => mount.update({ weapon: 'rocket', dt: 0, ...state });
  const settled = (parts, loaded, message) => {
    assert.equal(parts.round.visible, false, `${message}: no incoming rocket remains`);
    assert.equal(parts.chambered.visible, loaded, `${message}: authoritative chamber`);
    assert.equal(parts.reloading, false, `${message}: action is stopped`);
    near(parts.gate.rotation.y, 0, `${message}: gate y rotation`);
    near(parts.gate.rotation.x, 0, `${message}: gate x rotation is never pitched by generic cover logic`);
    assert.deepEqual(parts.gate.position.toArray(), parts.hinge.toArray());
  };

  try {
    update();
    let parts = mount._model.extra.userData.rocketReload;
    settled(parts, false, 'before the first ammunition snapshot');
    update({ mag: 1 });
    settled(parts, true, 'loaded snapshot');
    update({ mag: 0, firing: true });
    settled(parts, false, 'accepted launch empties the chamber');
    update({ mag: 0, firing: true });
    settled(parts, false, 'held firing never manufactures a rocket');
    update({ mag: 0, reloading: true });
    update({ mag: 0, reloading: true, dt: duration * 0.50 });
    assert.equal(parts.round.visible, true, 'the complete replacement rocket enters during remote reload');
    assert.equal(parts.chambered.visible, false);
    assert.ok(parts.gate.rotation.y < -1.5, 'the breech swings open for the incoming rocket');
    near(parts.gate.rotation.x, 0, 'rocket_rear_breech never pitches about X');
    assert.equal(mount._model.root.getObjectByName('hand_l').visible, false, 'the action cannot reveal a duplicate glove');
    assert.equal(mount._model.root.getObjectByName('hand_r').visible, false);
    assert.equal(mount.reloadT, 0, 'the authored support target replaces generic reload jitter');
    update({ mag: 0, reloading: true, dt: duration * 0.50 });
    settled(parts, false, 'animation completion cannot grant ammunition');
    update({ mag: 0, reloading: true, dt: duration * 0.50 });
    settled(parts, false, 'delayed authority flag cannot restart the reload');
    update({ mag: 1, reloading: true });
    settled(parts, true, 'authoritative refill can arrive before the flag clears');
    update({ mag: 1 });
    settled(parts, true, 'reload flag cleared');

    for (const interrupt of ['cancel', 'reset', 'death', 'switch']) {
      update({ mag: 0 });
      update({ mag: 0, reloading: true });
      update({ mag: 0, reloading: true, dt: duration * 0.50 });
      assert.equal(parts.round.visible, true, `${interrupt} starts from an active transfer`);
      if (interrupt === 'cancel') update({ mag: 0 });
      if (interrupt === 'reset') mount.resetPose();
      if (interrupt === 'death') mount.stopDeathEffects();
      if (interrupt === 'switch') mount.setWeapon('rifle');
      settled(parts, false, `${interrupt} cleans up the active action`);
      if (interrupt === 'reset' || interrupt === 'death') {
        update({ mag: 0, reloading: true, dt: duration * 0.50 });
        settled(parts, false, `${interrupt} does not replay a stale reload flag`);
      }
      if (interrupt === 'switch') {
        mount.setWeapon('rocket');
        parts = mount._model.extra.userData.rocketReload;
        settled(parts, false, 're-equipping keeps the last authoritative empty state');
      }
      update({ mag: 0 });
    }
  } finally {
    mount.dispose();
  }

  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      getContext: () => new Proxy({ measureText: () => ({ width: 60 }) }, {
        get: (target, key) => target[key] ?? (() => {}),
      }),
    }),
  };
  const roster = new AvatarRoster({ scene: new THREE.Scene(), getMyId: () => 'local' });
  try {
    const slot = WEAPON_IDS.indexOf('rocket');
    const remote = {
      id: 'rocket-remote', name: 'Havoc', x: 2, y: 1, z: -3, yaw: 0.8, pitch: 0.2,
      state: 'alive', weapon: slot, mag: WEAPON_IDS.map(() => 0), grounded: true,
    };
    const rows = new Map([[remote.id, remote]]);
    remote.mag[slot] = 1;
    roster.sync(rows, 0, 0);
    const av = roster._avatars.get(remote.id);
    const parts = av.weaponModel._model.extra.userData.rocketReload;
    assert.equal(parts.chambered.visible, true, 'roster passes ammunition from the equipped snapshot slot');
    remote.mag[slot] = 0;
    remote.firing = true;
    roster.sync(rows, 0, 0);
    settled(parts, false, 'roster launch');
    remote.firing = false;
    remote.reloading = true;
    roster.sync(rows, 0, 0);
    for (let frame = 0; frame < 90; frame++) roster.sync(rows, 1 / 60, frame * 1000 / 60);
    assert.equal(parts.round.visible, true, 'roster reload opens and loads the weapon');
    av.group.updateMatrixWorld(true);
    const support = av.weaponModel.handPose.support;
    const target = av.weaponModel.modelRoot.localToWorld(new THREE.Vector3(support.x, support.y, support.z));
    assert.ok(av.lHand.getWorldPosition(new THREE.Vector3()).distanceTo(target) < 1e-6,
      'the external avatar support hand follows the shared rocket-loading action');
    assert.equal(av.weaponModel.modelRoot.getObjectByName('hand_l').visible, false);
    beginAvatarDeath(av, 2000);
    settled(parts, false, 'real avatar death');
    resetAvatarPose(av);
    settled(parts, false, 'real avatar reset');
  } finally {
    roster.dispose();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

console.log('RX-8 HAVOC: syncRocketAmmo, reload choreography, cues, authority, portrait framing, and remote avatar reload passed.');
