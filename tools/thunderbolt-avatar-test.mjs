import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { AvatarWeaponModel } from '../public/js/avatar/avatar-weapon.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';
import { THUNDERBOLT_INDEX_SECONDS } from '../public/js/guns/thunderbolt-animation.js';

const visible = (parts) => parts.rounds.filter(round => round.visible).length;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const mount = new AvatarWeaponModel();
const update = (state = {}) => mount.update({ weapon: 'thunderbolt', dt: 0, ...state });
update();
let parts = mount._model.extra.userData.thunderbolt;
assert.equal(visible(parts), 0, 'no initial snapshot must not invent loaded ammunition');
update({ mag: 4 });
assert.equal(visible(parts), 4);
assert.equal(parts.arcs.visible, false, 'initial authority does not replay an old shot');

for (let mag = 3; mag >= 0; mag--) {
  update({ mag, firing: true });
  assert.equal(visible(parts), mag, 'the remote drum displays the authoritative remaining orbs');
  assert.equal(parts.arcs.visible, true, 'one accepted decrement releases the electrical pulse');
  const shot = parts.animation.shot;
  update({ mag, firing: true, dt: THUNDERBOLT_INDEX_SECONDS / 2 });
  assert.equal(parts.animation.shot, shot, 'a held firing flag cannot restart the mechanism');
  assert.ok(parts.rotor.rotation.z > (3 - mag) * Math.PI / 2 && parts.rotor.rotation.z < (4 - mag) * Math.PI / 2);
  update({ mag, firing: true, dt: THUNDERBOLT_INDEX_SECONDS / 2 });
  near(parts.rotor.rotation.z, (4 - mag) * Math.PI / 2);
  assert.equal(parts.arcs.visible, false);
  update({ mag, firing: true, dt: 0.1 });
  assert.equal(parts.animation.shot, null, 'repeated snapshots cannot fire another orb');
}

update({ mag: 0, reloading: true, dt: 8 });
assert.equal(visible(parts), 0, 'time spent reloading never manufactures remote ammunition');
update({ mag: 0, reloading: false });
assert.equal(visible(parts), 0, 'cancelled reload remains empty');
update({ mag: 4 });
assert.equal(visible(parts), 4, 'authoritative reload completion refills the drum');
assert.equal(parts.animation.shot, null);
update({ mag: 2, firing: true });
assert.equal(visible(parts), 2, 'a skipped snapshot synchronizes the actual count');
assert.equal(parts.animation.shot, null, 'a count correction is not an invented shot');
near(parts.rotor.rotation.z, Math.PI);
mount.resetPose();
assert.equal(visible(parts), 2, 'pose resets preserve the spent chambers');
mount.setWeapon('rifle');
mount.setWeapon('thunderbolt');
parts = mount._model.extra.userData.thunderbolt;
assert.equal(visible(parts), 2, 're-equipping preserves the last known ammunition until the next snapshot');
update({ mag: 1, firing: true });
assert.equal(parts.arcs.visible, true);
mount.stopDeathEffects();
assert.equal(parts.arcs.visible, false, 'death cannot leave a frozen electrical discharge');
assert.equal(visible(parts), 1);
mount.dispose();

// Exercise the real roster-to-pose path with the same mag[] shape as snapshots.
const previousDocument = globalThis.document;
globalThis.document = { createElement: () => ({ getContext: () => new Proxy({
  measureText: () => ({ width: 60 }),
}, { get: (target, key) => target[key] ?? (() => {}) }) }) };
const roster = new AvatarRoster({ scene: new THREE.Scene(), getMyId: () => 'local' });
try {
  const slot = WEAPON_IDS.indexOf('thunderbolt');
  const remote = { id: 'remote', name: 'Remote', x: 0, y: 1, z: 0, yaw: 0, pitch: 0,
    state: 'alive', weapon: slot, mag: WEAPON_IDS.map(() => 0), grounded: true };
  const rows = new Map([[remote.id, remote]]);
  remote.mag[slot] = 3;
  roster.sync(rows, 1 / 60, 0);
  const remoteParts = roster._avatars.get(remote.id).weaponModel._model.extra.userData.thunderbolt;
  assert.equal(visible(remoteParts), 3, 'roster forwards the equipped slot rather than another weapon or capacity');
  remote.mag[slot] = 2;
  remote.firing = true;
  roster.sync(rows, 1 / 60, 17);
  assert.equal(visible(remoteParts), 2);
  assert.equal(remoteParts.arcs.visible, true, 'the authoritative firing row reaches the third-person mechanism');
} finally {
  roster.dispose();
  globalThis.document = previousDocument;
}
console.log('ok - TB-4 remote ammunition, drum indexing, reload cancellation, equip persistence, death cleanup and snapshot forwarding');
