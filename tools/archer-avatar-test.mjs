import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { AvatarWeaponModel } from '../public/js/avatar/avatar-weapon.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';
import { beginAvatarDeath, resetAvatarPose } from '../public/js/avatar/avatar.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const duration = WEAPONS.archer.reloadTime;
const mount = new AvatarWeaponModel();
const update = (state = {}) => mount.update({ weapon: 'archer', dt: 0, ...state });
const settled = (parts, loaded, message) => {
  assert.equal(parts.round.visible, false, `${message}: no incoming rocket remains`);
  assert.equal(parts.chambered.visible, loaded, `${message}: authoritative chamber`);
  assert.equal(parts.reloading, false, `${message}: action is stopped`);
  near(parts.gate.rotation.z, 0);
  assert.deepEqual(parts.gate.position.toArray(), parts.hinge.toArray());
};

try {
  update();
  let parts = mount._model.extra.userData.archer;
  settled(parts, false, 'before the first ammunition snapshot');
  update({ mag: 1 });
  settled(parts, true, 'loaded snapshot');
  update({ mag: 0, firing: true });
  settled(parts, false, 'accepted launch empties the chamber');
  update({ mag: 0, firing: true });
  settled(parts, false, 'held firing never manufactures a rocket');
  update({ mag: 0, reloading: true });
  update({ mag: 0, reloading: true, dt: duration * 0.45 });
  assert.equal(parts.round.visible, true, 'the complete replacement rocket enters during remote reload');
  assert.equal(parts.chambered.visible, false);
  assert.ok(Math.abs(parts.gate.rotation.z) > 1.5, 'the breech opens for the incoming rocket');
  assert.equal(mount._model.root.getObjectByName('hand_l').visible, false, 'the action cannot reveal a duplicate glove');
  assert.equal(mount._model.root.getObjectByName('hand_r').visible, false);
  assert.equal(mount.reloadT, 0, 'the authored support target replaces generic reload jitter');
  update({ mag: 0, reloading: true, dt: duration * 0.55 });
  settled(parts, false, 'animation completion cannot grant ammunition');
  update({ mag: 0, reloading: true, dt: duration * 0.5 });
  settled(parts, false, 'delayed authority flag cannot restart the reload');
  update({ mag: 1, reloading: true });
  settled(parts, true, 'authoritative refill can arrive before the flag clears');
  update({ mag: 1 });
  settled(parts, true, 'reload flag cleared');

  for (const interrupt of ['cancel', 'reset', 'death', 'switch']) {
    update({ mag: 0 });
    update({ mag: 0, reloading: true });
    update({ mag: 0, reloading: true, dt: duration * 0.5 });
    assert.equal(parts.round.visible, true, `${interrupt} starts from an active transfer`);
    if (interrupt === 'cancel') update({ mag: 0 });
    if (interrupt === 'reset') mount.resetPose();
    if (interrupt === 'death') mount.stopDeathEffects();
    if (interrupt === 'switch') mount.setWeapon('rifle');
    settled(parts, false, `${interrupt} cleans up the active action`);
    if (interrupt === 'reset' || interrupt === 'death') {
      update({ mag: 0, reloading: true, dt: duration * 0.5 });
      settled(parts, false, `${interrupt} does not replay a stale reload flag`);
    }
    if (interrupt === 'switch') {
      mount.setWeapon('archer');
      parts = mount._model.extra.userData.archer;
      settled(parts, false, 're-equipping keeps the last authoritative empty state');
    }
    update({ mag: 0 });
  }

  update({ mag: 0, reloading: true });
  update({ mag: 1, reloading: true, dt: duration * 0.5 });
  assert.equal(parts.chambered.visible, false, 'an authority correction does not create two missiles in transit');
  assert.equal(parts.round.visible, true);
  update({ mag: 1 });
  settled(parts, true, 'cancellation restores corrected authority');
  update({ mag: 0 });
  settled(parts, false, 'a later correction removes the chambered rocket');
} finally {
  mount.dispose();
}

// Exercise real snapshot forwarding and the external avatar support-hand solver.
const previousDocument = globalThis.document;
globalThis.document = { createElement: () => ({ getContext: () => new Proxy({
  measureText: () => ({ width: 60 }),
}, { get: (target, key) => target[key] ?? (() => {}) }) }) };
const roster = new AvatarRoster({ scene: new THREE.Scene(), getMyId: () => 'local' });
try {
  const slot = WEAPON_IDS.indexOf('archer');
  const remote = { id: 'archer-remote', name: 'Archer', x: 2, y: 1, z: -3, yaw: 0.8, pitch: 0.2,
    state: 'alive', weapon: slot, mag: WEAPON_IDS.map(() => 0), grounded: true };
  const rows = new Map([[remote.id, remote]]);
  remote.mag[slot] = 1;
  roster.sync(rows, 0, 0);
  const av = roster._avatars.get(remote.id);
  const parts = av.weaponModel._model.extra.userData.archer;
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
console.log('ok - AT-12 remote authoritative chamber, full rocket reload, shared hand target, delayed flag and lifecycle cleanup');
