import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WeaponActions, syncSkipjackAmmo } from '../public/js/guns/actions.js';
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
  const rounds = Array.from({ length: 3 }, (_, i) => {
    const round = new THREE.Group();
    round.userData.homePosition = new THREE.Vector3();
    round.userData.homeCenter = new THREE.Vector3(-0.119, 0.083 - i * 0.063, -0.187);
    return round;
  });
  for (const round of rounds) cassette.add(round);
  const feed = new THREE.Group();
  body.add(feed);
  extra.userData.skipjack = { cassette, rounds, feed, roundPitch: 0.063,
    chamberAnchor: new THREE.Vector3(0, 0.075, -0.385), reload: null };
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

function visible(skipjack) { return skipjack.rounds.filter((round) => round.visible).length; }

function fedShots(fps) {
  const gun = model();
  const skipjack = gun.extra.userData.skipjack;
  const actions = new WeaponActions();
  const samples = [];
  syncSkipjackAmmo(skipjack, 3);
  assert.equal(visible(skipjack), 2, 'loaded three leaves two exterior rounds');
  close(skipjack.rounds[1].position.y, 0.063, 'first exterior round rests in top slot');
  for (const mag of [3, 2, 1]) {
    const fromReserve = mag - 1;
    const source = skipjack.rounds[3 - fromReserve];
    let lastVisible = null;
    assert.equal(actions.beginSkipjackShot(gun, mag), fromReserve > 0);
    syncSkipjackAmmo(skipjack, mag - 1);
    assert.equal(visible(skipjack), fromReserve,
      'authoritative decrement before the 14 ms jerk keeps the traveling shell');
    assert.equal(actions.startJerk('mgl', gun, T.boltTravel, 0.05), true);
    for (let frame = 1; frame <= Math.round((60 / T.rof) * fps); frame++) {
      actions.update(frame / fps, 1 / fps, gun, T);
      if (fromReserve > 0 && source.visible) lastVisible = source.position.clone();
      if (frame === fps / 10 && fromReserve > 0) {
        assert.equal(source.visible, true, 'source shell remains visible while traveling');
        assert.ok(source.position.y > source.userData.homePosition.y,
          'source shell visibly lifts out of the top cassette slot');
        assert.ok(source.position.x > source.userData.homePosition.x + 0.005,
          'source shell also slides laterally toward the chamber');
        if (mag === 3) assert.ok(skipjack.rounds[2].position.y > 0.063,
          'lower shell rises while the top shell is in transit');
        samples.push([source.position.x, source.position.y, source.position.z]);
      }
    }
    assert.equal(visible(skipjack), Math.max(0, mag - 2),
      `accepted ${mag}->${mag - 1} shot leaves authoritative mag minus one outside`);
    if (lastVisible) {
      const center = source.userData.homeCenter;
      const anchor = skipjack.chamberAnchor;
      close(center.x + lastVisible.x, anchor.x, 'last visible shell x seats inside receiver');
      close(center.y + lastVisible.y, anchor.y, 'last visible shell y meets bore axis');
      close(center.z + lastVisible.z, anchor.z, 'last visible shell z meets rotary feed');
    }
    assert.equal(skipjack.shot, null, 'shot transfer clears before next trigger');
    if (mag === 3) close(skipjack.rounds[2].position.y, 0.126,
      'last exterior shell rises into top slot');
  }
  actions.dispose(gun);
  return samples;
}

const fedSample = fedShots(30);
for (const fps of [60, 120]) {
  const actual = fedShots(fps);
  for (let shot = 0; shot < actual.length; shot++) {
    for (let axis = 0; axis < 3; axis++) close(actual[shot][axis], fedSample[shot][axis],
      `${fps} fps shell ${shot + 1} axis ${axis} at 100 ms`);
  }
}

// A rejected or corrected shot cannot keep an old shell in the receiver.
{
  const gun = model();
  const skipjack = gun.extra.userData.skipjack;
  const actions = new WeaponActions();
  syncSkipjackAmmo(skipjack, 3);
  actions.beginSkipjackShot(gun, 3);
  actions.startJerk('mgl', gun, T.boltTravel, 0.05);
  syncSkipjackAmmo(skipjack, 2);
  actions.update(0.1, 0.1, gun, T);
  syncSkipjackAmmo(skipjack, 0);
  assert.equal(skipjack.shot, null, 'divergent authority cancels the transfer');
  assert.equal(visible(skipjack), 0);
  actions.update(0.2, 0.1, gun, T);
  assert.equal(visible(skipjack), 0, 'later animation frames cannot revive an invalid round');
  actions.dispose(gun);
}

// Chaos can load four total rounds, but the physical cassette has three slots.
// The unseen fourth round chambers without removing one of those three shells.
{
  const gun = model();
  const skipjack = gun.extra.userData.skipjack;
  const actions = new WeaponActions();
  syncSkipjackAmmo(skipjack, 0);
  skipjack.reload = { shown: 0, fresh: 3, chambered: false, fullLoad: 4 };
  actions.startReload(0, 1, 'mag', T);
  actions.update(0.95, 0.05, gun, T);
  assert.equal(visible(skipjack), 3, 'four-round upgrade keeps three exterior shells during charging');
  syncSkipjackAmmo(skipjack, 4);
  actions.update(1, 0.05, gun, T);
  assert.equal(visible(skipjack), 3, 'upgraded reload completes without a shell popping back');
  actions.dispose(gun);
}

{
  const gun = model();
  const skipjack = gun.extra.userData.skipjack;
  const actions = new WeaponActions();
  syncSkipjackAmmo(skipjack, 3);
  actions.beginSkipjackShot(gun, 3);
  syncSkipjackAmmo(skipjack, 2);
  actions.startJerk('mgl', gun, T.boltTravel, 0.05);
  actions.update(0.10, 0.10, gun, T);
  actions.reset(gun);
  assert.equal(visible(skipjack), 1, 'weapon swap restores the latest authoritative reserve');
  close(skipjack.rounds[2].position.y, 0.126, 'reset restores the last shell to its top slot');
  assert.equal(skipjack.shot, null, 'swap leaves no pending feed');
}

for (const chambered of [false, true]) {
  const gun = model();
  const skipjack = gun.extra.userData.skipjack;
  const clicks = [];
  const actions = new WeaponActions({ onReloadClick: (click) => clicks.push(click) });
  syncSkipjackAmmo(skipjack, chambered ? 1 : 0);
  skipjack.reload = { shown: visible(skipjack), fresh: chambered ? 2 : 3, chambered };
  assert.equal(actions.startReload(0, 1, 'mag', T), true);
  for (const now of [0.05, 0.31, 0.49, 0.62, 0.78, 0.83, 0.87, 0.91, 0.94]) {
    actions.update(now, 0.05, gun, T);
    assert.ok(Number.isFinite(gun.extra.userData.skipjack.cassette.rotation.y));
    assert.ok(Number.isFinite(gun.root.getObjectByName('hand_l').position.x));
    if (!chambered && now === 0.62) assert.equal(visible(skipjack), 3,
      'empty reload visibly installs three shells before chambering');
    if (!chambered && now === 0.87) {
      assert.ok(skipjack.rounds[0].position.y > 0,
        'the top shell lifts before sliding into the chamber');
      assert.ok(skipjack.rounds[0].position.z < 0,
        'the top shell leaves its home path toward the receiver');
      assert.ok(skipjack.rounds[0].position.x > 0,
        'the top shell slides inward as the charging pawl moves');
    }
    if (!chambered && now === 0.91) {
      const source = skipjack.rounds[0];
      const center = source.userData.homeCenter;
      const anchor = skipjack.chamberAnchor;
      assert.equal(source.visible, true, 'chambered shell remains present at its bore endpoint');
      close(center.x + source.position.x, anchor.x, 'reload shell reaches receiver x');
      close(center.y + source.position.y, anchor.y, 'reload shell reaches bore axis');
      close(center.z + source.position.z, anchor.z, 'reload shell reaches rotary feed');
    }
    if (!chambered && now === 0.94) assert.equal(visible(skipjack), 2,
      'the top shell enters the receiver while two remain on the flank');
  }
  assert.deepEqual(clicks, chambered ? [1, 2] : [1, 2, 3],
    'reload contact callbacks fire once even with large frame steps');
  assert.equal(actions.cancelReload(gun), true);
  const cassette = gun.extra.userData.skipjack.cassette;
  assert.ok(cassette.position.equals(cassette.userData.homePosition));
  close(cassette.rotation.y, 0, 'cancelled cassette closes');
  close(gun.bolt.position.z, 0, 'cancelled charging pawl returns');
  close(gun.bolt.rotation.x, 0, 'cancelled charging pawl un-tilts');
  assert.equal(visible(skipjack), 0,
    'cancelled reload restores the authoritative pre-swap reserve');
  actions.dispose(gun);
}

{
  const gun = model();
  const skipjack = gun.extra.userData.skipjack;
  const actions = new WeaponActions();
  syncSkipjackAmmo(skipjack, 0);
  skipjack.reload = { shown: 0, fresh: 3, chambered: false };
  actions.startReload(0, 1, 'mag', T);
  for (const now of [0.63, 0.87, 0.95]) actions.update(now, 0.02, gun, T);
  syncSkipjackAmmo(skipjack, 3);
  actions.update(1, 0.05, gun, T);
  assert.equal(actions.reloading, false);
  assert.equal(visible(skipjack), 2, 'completed empty reload leaves two outside and one chambered');
  close(skipjack.rounds[1].position.y, 0.063, 'completed reload slots rise to the top');
  assert.equal(skipjack.rounds[0].visible, false, 'chambered round leaves the side cassette');
  actions.dispose(gun);
}

console.log('SKIPJACK animation: 30/60/120 fps pose, full-rate chamber indexing, reload contacts and cancellation passed.');
