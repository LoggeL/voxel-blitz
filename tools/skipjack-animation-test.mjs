import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WeaponActions } from '../public/js/guns/actions.js';
import { timerFor } from '../public/js/guns/defs.js';

const T = timerFor('mgl');
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`);

function model() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const mag = new THREE.Group();
  const bolt = new THREE.Group();
  const triggerGroup = new THREE.Group();
  const extra = new THREE.Group();
  const hand = new THREE.Group();
  hand.name = 'hand_l';
  body.add(hand);
  root.add(body, mag, bolt, triggerGroup, extra);
  const cassette = new THREE.Group();
  cassette.userData.homePosition = new THREE.Vector3(-0.142, 0.020, -0.306);
  cassette.position.copy(cassette.userData.homePosition);
  mag.add(cassette);
  const rounds = Array.from({ length: 3 }, () => new THREE.Group());
  for (const round of rounds) cassette.add(round);
  const feed = new THREE.Group();
  body.add(feed);
  extra.userData.skipjack = { cassette, rounds, feed,
    reload: { shown: 2, fresh: 2, chambered: false } };
  extra.userData.cartridges = [];
  return { root, body, mag, bolt, triggerGroup, extra, T };
}

function fireAtRate(fps) {
  const gun = model();
  const actions = new WeaponActions();
  const interval = 60 / T.rof;
  let recoilAtTenth;
  for (let shot = 0; shot < 4; shot++) {
    assert.equal(actions.startJerk('mgl', gun, T.boltTravel, 0.05), true);
    for (let frame = 1; frame <= Math.round(interval * fps); frame++) {
      actions.update(frame / fps, 1 / fps, gun, T);
      if (shot === 0 && frame === fps / 10) {
        recoilAtTenth = [gun.bolt.position.z, gun.extra.userData.skipjack.feed.rotation.z];
      }
    }
    close(gun.bolt.position.z, 0, 'pawl returns before next shot');
    close(gun.triggerGroup.rotation.x, 0, 'trigger returns before next shot');
    close(gun.extra.userData.skipjack.feed.rotation.z,
      (shot + 1) * Math.PI / 3, 'feed indexes one chamber per shot');
  }
  actions.reset(gun);
  close(gun.extra.userData.skipjack.feed.rotation.z, 0, 'weapon swap resets feed pose');
  actions.dispose(gun);
  return recoilAtTenth;
}

const sample = fireAtRate(30);
for (const fps of [60, 120]) {
  const actual = fireAtRate(fps);
  close(actual[0], sample[0], `${fps} fps pawl pose at 100 ms`);
  close(actual[1], sample[1], `${fps} fps feed pose at 100 ms`);
}

for (const chambered of [false, true]) {
  const gun = model();
  const clicks = [];
  const actions = new WeaponActions({ onReloadClick: (click) => clicks.push(click) });
  gun.extra.userData.skipjack.reload.chambered = chambered;
  assert.equal(actions.startReload(0, 1, 'mag', T), true);
  for (const now of [0.05, 0.31, 0.49, 0.62, 0.78, 0.83, 0.94]) {
    actions.update(now, 0.05, gun, T);
    assert.ok(Number.isFinite(gun.extra.userData.skipjack.cassette.rotation.y));
    assert.ok(Number.isFinite(gun.root.getObjectByName('hand_l').position.x));
  }
  assert.deepEqual(clicks, chambered ? [1, 2] : [1, 2, 3],
    'reload contact callbacks fire once even with large frame steps');
  assert.equal(actions.cancelReload(gun), true);
  const cassette = gun.extra.userData.skipjack.cassette;
  assert.ok(cassette.position.equals(cassette.userData.homePosition));
  close(cassette.rotation.y, 0, 'cancelled cassette closes');
  close(gun.bolt.position.z, 0, 'cancelled charging pawl returns');
  close(gun.bolt.rotation.x, 0, 'cancelled charging pawl un-tilts');
  actions.dispose(gun);
}

console.log('SKIPJACK animation: 30/60/120 fps pose, full-rate chamber indexing, reload contacts and cancellation passed.');
