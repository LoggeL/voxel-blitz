import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ThunderboltAnimation, THUNDERBOLT_INDEX_SECONDS, THUNDERBOLT_CONTACT_SECONDS } from '../public/js/guns/thunderbolt-animation.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${message}: ${actual} != ${expected}`);
const visible = (parts) => parts.rounds.filter(round => round.visible).length;
function fixture() {
  const parts = { rotor: new THREE.Group(), rounds: Array.from({ length: 4 }, () => new THREE.Group()),
    energy: new THREE.Group(), arcs: new THREE.Group(), pulseMaterial: { emissiveIntensity: 0.8 } };
  const contacts = [];
  return { parts, contacts, animation: new ThunderboltAnimation(parts, (step) => contacts.push(step)) };
}
function step(animation, duration, fps) {
  let elapsed = 0;
  while (elapsed < duration - 1e-9) {
    const dt = Math.min(1 / fps, duration - elapsed);
    animation.update(dt); elapsed += dt;
  }
}

const poses = [];
for (const fps of [30, 60, 120]) {
  const { parts, contacts, animation } = fixture();
  const row = [];
  assert.equal(visible(parts), 4);
  for (let mag = 4; mag > 0; mag--) {
    assert.equal(animation.fire(), true);
    assert.equal(visible(parts), mag, 'the firing animation does not spend authoritative ammunition');
    animation.setState({ mag: mag - 1 });
    assert.equal(visible(parts), mag - 1, 'the accepted decrement removes precisely one orb');
    assert.equal(parts.arcs.visible, true, 'electric discharge accompanies each accepted shot');
    step(animation, THUNDERBOLT_INDEX_SECONDS / 2, fps);
    const turn = parts.rotor.rotation.z;
    assert.ok(turn > (4 - mag) * Math.PI / 2 && turn < (5 - mag) * Math.PI / 2,
      'halfway through the cycle the drum is still moving');
    row.push(turn);
    for (let repeat = 0; repeat < 3; repeat++) animation.setState({ mag: mag - 1 });
    step(animation, THUNDERBOLT_INDEX_SECONDS / 2, fps);
    near(parts.rotor.rotation.z, (5 - mag) * Math.PI / 2, 'exactly one quarter turn per shot');
    assert.deepEqual(contacts.slice((4 - mag) * 3), [1, 2, 3], 'three contacts per shot without duplicate rifle cues');
    assert.ok(parts.rotor.rotation.z >= 0 && parts.rotor.rotation.z <= Math.PI * 2,
      'drum orientation remains bounded');
  }
  assert.equal(visible(parts), 0);
  assert.equal(parts.energy.visible, false, 'an empty launcher has no loaded accelerator orb');
  assert.equal(parts.arcs.visible, false, 'discharge ends with the cycle');
  assert.equal(animation.fire(), false, 'an empty model does not start a spurious cycle');
  poses.push(row);
}
for (const row of poses.slice(1)) row.forEach((pose, index) => near(pose, poses[0][index], 'frame-rate independent indexing'));

{
  const { animation, contacts } = fixture();
  animation.fire(); animation.setState({ mag: 3 });
  let previous = 0;
  for (let index = 0; index < THUNDERBOLT_CONTACT_SECONDS.length; index++) {
    const at = THUNDERBOLT_CONTACT_SECONDS[index];
    animation.update(at - previous - 0.0001);
    assert.equal(contacts.length, index, 'contacts do not fire before their mechanism boundary');
    animation.update(0.0001);
    assert.equal(contacts.length, index + 1, 'contact lands on its mechanism boundary');
    previous = at;
  }
  animation.update(1); animation.setState({ mag: 3 });
  assert.deepEqual(contacts, [1, 2, 3], 'finished shots and repeated snapshots cannot replay contacts');
}

{
  const { parts, animation, contacts } = fixture();
  animation.fire(); animation.setState({ mag: 3 }); animation.update(0.15);
  animation.setState({ mag: 4 });
  assert.equal(visible(parts), 4, 'rejected prediction restores the orb');
  near(parts.rotor.rotation.z, 0, 'rejected prediction restores the original chamber');
  assert.equal(parts.arcs.visible, false, 'rejected prediction stops the discharge');
  animation.update(1);
  assert.deepEqual(contacts, [1], 'rollback cancels outstanding index and lock contacts');
  near(parts.rotor.rotation.z, 0, 'old shot completion cannot overwrite a correction');
  animation.setState({ mag: 2 });
  assert.equal(visible(parts), 2);
  near(parts.rotor.rotation.z, Math.PI, 'a missed snapshot synchronizes the loaded chambers');
  animation.setState({ mag: 0, reloading: true });
  assert.equal(animation.shot, null, 'discarding ammunition at reload start is not a shot');
  animation.update(0.15);
  assert.ok(parts.rotor.rotation.z < Math.PI && parts.rotor.rotation.z > 0,
    'the empty carrier returns home smoothly');
  animation.update(8);
  assert.equal(visible(parts), 0, 'elapsed reload presentation cannot refill the drum');
  near(parts.rotor.rotation.z, 0, 'the empty drum reaches its loading alignment');
  animation.cancelReload();
  assert.equal(visible(parts), 0, 'cancelled reload retains the actual empty count');
  animation.setState({ mag: 4, reloading: false });
  assert.equal(visible(parts), 4, 'only the ammunition state installs four replacements');
  near(parts.rotor.rotation.z, 0, 'replacement starts at its first chamber');
  animation.setState({ mag: 1 }); animation.reset({ mag: 1 });
  assert.equal(visible(parts), 1, 'drawing again preserves partial depletion');
  near(parts.rotor.rotation.z, Math.PI * 1.5, 'drawing again restores the matching chamber');
}

function setup() {
  let now = 0;
  const contacts = [];
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 100));
  rig.onBoltClack = (step) => contacts.push(step);
  const state = new WeaponState({ rig,
    audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
    feedback: { addExhaustion() {}, addRecoil() {} },
    network: { isCurrentGeneration: () => true, isRunning: () => true },
    now: () => now, setTimer: () => 0, clearTimer() {}, random: () => 0.5 });
  state.resetToLoadout();
  assert.equal(state.forceWeapon(WEAPON_IDS.indexOf('thunderbolt'), {
    mode: 'titanfall', owned: ['rifle', 'thunderbolt'], now }), true);
  const advance = (seconds, fps = 120) => {
    let elapsed = 0;
    while (elapsed < seconds - 1e-9) {
      const dt = Math.min(1 / fps, seconds - elapsed);
      now += dt * 1000; elapsed += dt;
      state.tickReload(now); state.syncRigAds(); rig.update(dt);
    }
  };
  advance(2);
  const parts = rig._cur.extra.userData.thunderbolt;
  assert.ok(parts.rotor && parts.rounds.length === 4, 'the production model exposes its four-round mechanism');
  const fire = () => {
    state.applyIntents({ fireTap: true }, now, { allowFire: true, alive: true });
    return state.tryFire(now, { allowFire: true, alive: true });
  };
  const snapshot = (mag) => {
    const mags = WEAPON_IDS.map(() => NaN), reserves = WEAPON_IDS.map(() => NaN);
    mags[WEAPON_IDS.indexOf('thunderbolt')] = mag;
    reserves[WEAPON_IDS.indexOf('thunderbolt')] = 3;
    state.adoptServerAmmo(mags, reserves); state.syncRigAds();
  };
  return { rig, state, parts, contacts, advance, fire, snapshot, get now() { return now; },
    dispose() { state.dispose(); rig.dispose(); } };
}

{
  const s = setup();
  try {
    s.parts.rotor.updateMatrix();
    const feedStation = s.parts.rounds[0].position.clone().applyMatrix4(s.parts.rotor.matrix);
    for (let mag = 3; mag >= 0; mag--) {
      s.parts.rotor.updateMatrix();
      const nextOrb = s.parts.rounds[3 - mag].position.clone().applyMatrix4(s.parts.rotor.matrix);
      near(nextOrb.distanceTo(feedStation), 0,
        'each next loaded orb occupies the same physical feed station after the preceding quarter turn');
      assert.equal(s.fire(), true);
      assert.equal(s.state.ammoOf('thunderbolt').mag, mag);
      assert.equal(visible(s.parts), mag, 'production state immediately feeds the accepted shot to the model');
      s.advance(1.21);
      assert.deepEqual(s.contacts.slice((3 - mag) * 3), [1, 2, 3], 'real rig uses only the three TB-4 cycle contacts');
      near(s.parts.rotor.rotation.z, (4 - mag) * Math.PI / 2, 'production rig retains each indexed chamber');
    }
    assert.equal(s.state.startReload(s.now), true);
    s.advance(WEAPONS.thunderbolt.reloadTime * 0.9);
    assert.equal(visible(s.parts), 0, 'seating the drum before completion does not display usable orbs');
    s.advance(WEAPONS.thunderbolt.reloadTime * 0.1 + 0.02);
    assert.equal(visible(s.parts), 4, 'real reload completion restores the four rounds');
    near(s.parts.rotor.rotation.z, 0, 'completed replacement resets chamber alignment');
  } finally { s.dispose(); }
}
{
  const s = setup();
  try {
    assert.equal(s.fire(), true); s.advance(0.15);
    s.snapshot(4);
    near(s.parts.rotor.rotation.z, 0, 'authoritative rollback cancels a real rig shot');
    assert.equal(visible(s.parts), 4);
    s.snapshot(2); s.advance(1.1);
    assert.equal(s.state.startReload(s.now), true); s.advance(0.4);
    s.state.cancelReload();
    assert.equal(visible(s.parts), 0, 'cancelled real reload stays empty');
    s.snapshot(2);
    s.rig.setWeapon('rifle'); s.rig.setWeapon('thunderbolt');
    assert.equal(visible(s.parts), 2, 'switching back does not refill a partially spent drum');
    near(s.parts.rotor.rotation.z, Math.PI, 'switching clears transient motion but preserves the current chamber');
    assert.equal(s.parts.animation.reloading, false);
  } finally { s.dispose(); }
}
{
  const s = setup();
  try {
    s.snapshot(0);
    assert.equal(s.state.startReload(s.now), true);
    s.state.reconcileServer({ weapon: WEAPON_IDS.indexOf('thunderbolt'), alive: true,
      reloading: true, reloadAck: s.state.reloadId }, s.now);
    s.advance(WEAPONS.thunderbolt.reloadTime + 0.2);
    assert.equal(visible(s.parts), 0, 'an acknowledged reload waits for the authoritative refill after the visual timer ends');
    assert.equal(s.state.ammoOf('thunderbolt').mag, 0);
    s.snapshot(4);
    s.state.reconcileServer({ weapon: WEAPON_IDS.indexOf('thunderbolt'), alive: true,
      reloading: false, reloadAck: s.state.reloadId }, s.now);
    assert.equal(visible(s.parts), 4, 'the completed server reload supplies the replacement orbs');
  } finally { s.dispose(); }
}

console.log('THUNDERBOLT: four-round consumption, quarter-turn indexing, 30/60/120 fps, authority correction, reload completion/cancellation and redraw passed.');
