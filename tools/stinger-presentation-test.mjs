import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';
import { WeaponActions } from '../public/js/guns/actions.js';
import { StingerPresentation } from '../public/js/guns/stinger-presentation.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${label}: ${actual} != ${expected}`);
const cache = new MaterialCache();
const models = [];
const controllers = [];
const duration = WEAPONS.stinger.reloadTime;
function model() {
  const gun = buildGun('stinger', cache);
  models.push(gun);
  return gun;
}
function actions(gun) {
  const cues = [];
  const controller = new WeaponActions({ onReloadClick: (step) => cues.push(step) });
  controllers.push({ controller, gun });
  return { controller, cues };
}
function transform(object) {
  return [...object.position.toArray(), ...object.quaternion.toArray()];
}
function assertTransform(object, original, label) {
  transform(object).forEach((value, index) => close(value, original[index], `${label} [${index}]`));
}
function descendsFrom(object, ancestor) {
  for (let node = object; node; node = node.parent) if (node === ancestor) return true;
  return false;
}
const lit = (stinger) => stinger.lamps.filter((lamp) => lamp.material.emissiveIntensity > 0.1).length;
const isZero = (rotation) => Math.abs(rotation.x) + Math.abs(rotation.y) + Math.abs(rotation.z) < 1e-8;
const finitePose = (gun, motion) => {
  const stinger = gun.extra.userData.stinger;
  const values = [...Object.values(motion), ...transform(gun.mag), ...stinger.clamps.flatMap(transform)];
  assert.ok(values.every(Number.isFinite), 'all tube-swap transforms remain finite');
};

try {
  const gun = model();
  const stinger = gun.extra.userData.stinger;
  assert.equal(stinger.canister, gun.mag, 'the reload group is the entire launch canister');
  const bounds = new THREE.Box3().setFromObject(stinger.canister);
  assert.ok(bounds.max.z - bounds.min.z > 1, 'the removable assembly spans the full launch tube');
  assert.ok(descendsFrom(stinger.frontCover, gun.mag), 'the front cover leaves with the spent tube');
  const glowMeshes = [];
  gun.root.traverse((object) => {
    if (object.isMesh && object.material?.uniforms === gun.uni) glowMeshes.push(object);
  });
  assert.deepEqual(glowMeshes.map((mesh) => mesh.geometry.type), ['CylinderGeometry'],
    'assembly adds only the heat sleeve, without a floating generic bolt cap');
  const heatSleeve = glowMeshes[0];
  assert.ok(descendsFrom(heatSleeve, gun.mag), 'the heat sleeve belongs to the removable canister');
  const heatHome = heatSleeve.getWorldPosition(new THREE.Vector3());
  assert.equal(stinger.clamps.length, 2, 'two mechanical clamps secure the replaceable tube');
  assert.ok(stinger.clamps.every((clamp) => !descendsFrom(clamp, gun.mag)),
    'clamps stay with the fixed gripstock');
  assert.equal(stinger.lamps.length, 5);
  const indicatorMaterials = [...stinger.lamps, stinger.statusLamp].map((lamp) => lamp.material);
  assert.equal(new Set(indicatorMaterials).size, indicatorMaterials.length,
    'progress and status lamps have independently controlled materials');

  const other = model().extra.userData.stinger;
  assert.ok(other.lamps.every((lamp) => !indicatorMaterials.includes(lamp.material)),
    'another gun cannot inherit this gun\'s lock state through the material cache');

  const presentation = new StingerPresentation(gun);
  const state = (mag, lockProgress, reloading = false) => {
    presentation.setState(Object.freeze({ mag, lockProgress, reloading }));
    presentation.update(1 / 60, { reloading });
  };
  state(1, 0);
  assert.equal(lit(stinger), 0, 'loaded idle does not invent lock progress');
  assert.equal(stinger.frontCover.visible, true, 'loaded tube has an intact cover');
  state(1, 0.5);
  assert.ok(lit(stinger) > 0 && lit(stinger) < 5, 'partial authority shows partial progress');
  state(1, 1);
  assert.equal(lit(stinger), 5, 'authoritative full lock illuminates the entire bank');
  const readyColor = stinger.statusLamp.material.emissive.getHex();
  state(1, 0);
  assert.equal(lit(stinger), 0, 'losing a lock clears stale ready progress on the next frame');
  state(1, 1, true);
  assert.equal(lit(stinger), 0, 'reload suppresses ready feedback even if an old lock is supplied');
  state(1, 1);
  presentation.update(1 / 60, { reloading: true });
  assert.equal(lit(stinger), 0, 'an active animation suppresses ready feedback before its state snapshot arrives');
  for (const lockProgress of [null, undefined, NaN, Infinity]) {
    state(1, lockProgress);
    assert.equal(lit(stinger), 0, 'missing or invalid lock progress never lights a ready indicator');
  }
  state(0, 1);
  assert.equal(lit(stinger), 0, 'empty ammunition overrides a stale complete lock');
  assert.equal(stinger.frontCover.visible, false, 'spent tube reveals its open mouth');
  assert.notEqual(stinger.statusLamp.material.emissive.getHex(), readyColor,
    'empty and launch-ready states have different status colors');
  presentation.fire();
  for (let frame = 0; frame < 120; frame++) presentation.update(1 / 60);
  assert.equal(stinger.frontCover.visible, false, 'launch effects cannot restore an empty tube cover');
  assert.equal(lit(stinger), 0, 'launch settling cannot manufacture ammo or a lock');
  state(1, 0);
  assert.equal(stinger.frontCover.visible, true, 'an authoritative ammo correction restores the loaded cover');
  assert.equal(lit(other), 0, 'local presentation leaves the second gun idle');

  const receiver = gun.body.getObjectByName('stinger_gripstock') || stinger.seeker;
  assert.ok(receiver, 'a fixed gripstock or seeker assembly is available');
  assert.ok(!descendsFrom(receiver, gun.mag), 'receiver stays outside the tube swap group');
  const receiverHome = transform(receiver);
  const hand = gun.root.getObjectByName('hand_l');
  const handHome = transform(hand);
  const handVisible = hand.visible;
  const { controller, cues } = actions(gun);
  assert.equal(controller.startReload(0, duration, 'magswap', gun.T), true);
  const sample = (fraction) => {
    const motion = controller.update(fraction * duration, 0, gun, gun.T);
    finitePose(gun, motion);
    assertTransform(receiver, receiverHome, 'gripstock remains fixed during the tube swap');
    return motion;
  };
  sample(0.19);
  assert.ok(stinger.clamps.every((clamp) => !isZero(clamp.rotation)),
    'both clamps open before the tube leaves its seat');
  close(gun.mag.position.length(), 0, 'canister remains seated until release');
  sample(0.27);
  assert.ok(gun.mag.position.y > 0.05, 'released tube lifts clear of the cradle');
  assert.ok(heatSleeve.getWorldPosition(new THREE.Vector3()).distanceTo(heatHome) > 0.1,
    'the heat sleeve travels with the released tube instead of remaining on the empty bore axis');
  sample(0.4);
  assert.ok(gun.mag.position.length() > 0.5, 'the complete spent tube sweeps away from the receiver');
  sample(0.5);
  assert.equal(gun.mag.visible, false, 'spent tube fully leaves before a replacement appears');
  assert.equal(hand.visible, false, 'support hand follows the spent tube out of view');
  sample(0.62);
  assert.equal(gun.mag.visible, true, 'fresh canister begins a separate insertion path');
  assert.ok(gun.mag.position.length() > 0.1, 'replacement is visibly away from its seated position');
  sample(0.82);
  close(gun.mag.position.length(), 0, 'full canister seats on the canonical contact');
  assert.ok(stinger.clamps.every((clamp) => !isZero(clamp.rotation)),
    'clamps stay open until the tube is seated');
  sample(0.91);
  assert.ok(stinger.clamps.every((clamp) => isZero(clamp.rotation)), 'both clamps latch after seating');
  assert.deepEqual(cues, [1, 2, 3], 'release, tube contact and arming cues fire once');
  assert.equal(controller.reloading, true, 'presentation keeps the gameplay reload duration');
  const complete = sample(1);
  assert.equal(controller.reloading, false);
  assert.ok(Object.values(complete).every((value) => value === 0), 'completed reload leaves no receiver motion');
  assert.equal(gun.mag.visible, true);
  close(gun.mag.position.length(), 0, 'completed canister is home');
  assert.ok(isZero(gun.mag.rotation));
  assertTransform(hand, handHome, 'support hand returns to its grip');
  assert.equal(hand.visible, handVisible);

  // Cancel at each mechanically different phase, including the invisible gap.
  state(0, 0);
  for (const fraction of [0.15, 0.27, 0.4, 0.5, 0.62, 0.78, 0.87, 0.94]) {
    controller.startReload(0, duration, 'magswap', gun.T);
    sample(fraction);
    assert.equal(controller.cancelReload(gun), true);
    assert.equal(gun.mag.visible, true, `cancel at ${fraction}: canister is visible`);
    close(gun.mag.position.length(), 0, `cancel at ${fraction}: canister is home`);
    assert.ok(isZero(gun.mag.rotation), `cancel at ${fraction}: canister rotation clears`);
    assert.ok(stinger.clamps.every((clamp) => isZero(clamp.rotation)), `cancel at ${fraction}: clamps close`);
    assert.ok(isZero(stinger.latch.rotation), `cancel at ${fraction}: latch returns`);
    assertTransform(hand, handHome, `cancel at ${fraction}: hand returns`);
    assert.equal(hand.visible, handVisible);
    assert.equal(stinger.frontCover.visible, false, `cancel at ${fraction}: empty tube stays spent`);
    assertTransform(receiver, receiverHome, `cancel at ${fraction}: gripstock stays fixed`);
  }

  controller.startReload(0, duration, 'magswap', gun.T);
  sample(0.62);
  presentation.update(1 / 60, { reloading: true });
  assert.equal(stinger.frontCover.visible, true, 'replacement tube carries its fresh cover during insertion');
  assert.equal(lit(stinger), 0, 'a visible replacement does not grant ammo before authority commits it');
  sample(1);
  assert.equal(stinger.frontCover.visible, false, 'finishing animation cannot fabricate an authoritative round');
  state(1, 0);
  assert.equal(stinger.frontCover.visible, true, 'confirmed reload restores the seated fresh cover');

  // Equal elapsed times must yield equal movement even when frames skip contacts.
  function atFrameRate(fps) {
    const run = model();
    const { controller: action, cues: contacts } = actions(run);
    action.startReload(0, duration, 'magswap', run.T);
    let now = 0;
    const poses = [];
    for (const fraction of [0.15, 0.27, 0.4, 0.5, 0.62, 0.78, 0.87, 0.94, 1]) {
      const end = fraction * duration;
      let motion;
      while (now + 1e-10 < end) {
        const dt = Math.min(1 / fps, end - now);
        now += dt;
        motion = action.update(now, dt, run, run.T);
        finitePose(run, motion);
      }
      poses.push([...Object.values(motion), ...transform(run.mag),
        ...run.extra.userData.stinger.clamps.flatMap(transform), Number(run.mag.visible)]);
    }
    assert.deepEqual(contacts, [1, 2, 3], `${fps} fps retains all contacts exactly once`);
    assert.equal(action.reloading, false);
    return poses;
  }
  const reference = atFrameRate(30);
  for (const fps of [60, 120]) {
    atFrameRate(fps).forEach((pose, sampleIndex) => pose.forEach((value, index) =>
      close(value, reference[sampleIndex][index], `${fps} fps sample ${sampleIndex} component ${index}`)));
  }

  function seekerAtFrameRate(fps) {
    const run = model();
    const parts = run.extra.userData.stinger;
    const seeker = new StingerPresentation(run);
    seeker.setState({ mag: 1, lockProgress: 0.4, reloading: false });
    const poses = [];
    for (const phase of ['search', 'locked', 'launch', 'settle']) {
      if (phase === 'locked') seeker.setState({ mag: 1, lockProgress: 1, reloading: false });
      if (phase === 'launch') seeker.fire();
      for (let frame = 0; frame < fps / 10; frame++) seeker.update(1 / fps);
      poses.push([...transform(parts.seeker), ...parts.lamps.map((lamp) => lamp.material.emissiveIntensity),
        parts.statusLamp.material.emissiveIntensity, Number(parts.frontCover.visible)]);
      if (phase === 'locked') {
        assert.ok(isZero(parts.seeker.rotation), 'confirmed lock centres the seeker');
        assert.equal(lit(parts), 5);
      }
      if (phase === 'launch') {
        assert.equal(lit(parts), 0, 'launch immediately clears acquisition feedback');
        assert.equal(parts.frontCover.visible, false);
      }
    }
    return poses;
  }
  const seekerReference = seekerAtFrameRate(30);
  for (const fps of [60, 120]) {
    seekerAtFrameRate(fps).forEach((pose, sampleIndex) => pose.forEach((value, index) =>
      close(value, seekerReference[sampleIndex][index], `${fps} fps seeker ${sampleIndex} component ${index}`)));
  }

  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 100));
  try {
    rig.setWeapon('stinger');
    rig.setStinger({ mag: 0, lockProgress: 0, reloading: false });
    const reloadStarted = rig._now;
    rig.reload(duration, 'magswap');
    while (rig._now + 1e-10 < reloadStarted + duration * 0.5) {
      rig.update(Math.min(1 / 60, reloadStarted + duration * 0.5 - rig._now));
    }
    const previous = rig._cur;
    assert.equal(previous.mag.visible, false, 'rig reaches the removed-tube phase');
    rig.setWeapon('rifle');
    assert.equal(previous.mag.visible, true, 'weapon swap restores the hidden canister');
    close(previous.mag.position.length(), 0, 'weapon swap homes the canister');
    assert.ok(previous.extra.userData.stinger.clamps.every((clamp) => isZero(clamp.rotation)),
      'weapon swap closes the retained gun\'s clamps');
    rig.setStinger({ mag: 0, lockProgress: 1, reloading: false });
    rig.setWeapon('stinger');
    rig.update(1 / 60);
    assert.equal(lit(previous.extra.userData.stinger), 0, 're-equipping empty cannot replay a cached ready lock');
    assert.equal(previous.extra.userData.stinger.frontCover.visible, false,
      're-equipping uses authoritative empty ammunition');
    rig.setStinger({ mag: 1, lockProgress: 1, reloading: false });
    rig.update(1 / 60);
    assert.equal(lit(previous.extra.userData.stinger), 5, 'rig wires the current full lock to the on-gun lamps');
  } finally { rig.dispose(); }

  // Exercise the real client gate and frame-state forwarding. Only its external
  // effects are adapters; on-gun indicators use the production presentation.
  {
    const clientGun = model();
    const parts = clientGun.extra.userData.stinger;
    const display = new StingerPresentation(clientGun);
    let now = 0, launches = 0, forwarded;
    const client = new WeaponState({
      rig: {
        setWeapon() {}, fire: () => { launches++; display.fire(); return true; },
        reload() {}, cancelReload() {}, pumpAnim() {}, boltAnim() {}, ads() {},
        setStinger(value) { forwarded = { ...value }; display.setState(value); },
      },
      audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
      network: { isCurrentGeneration: () => true, isRunning: () => true },
      feedback: { addExhaustion() {}, addRecoil() {} },
      now: () => now, setTimer: () => 0, clearTimer() {}, random: () => 0.5,
    });
    const slot = WEAPON_IDS.indexOf('stinger');
    const context = (lockProgress) => ({ allowFire: true, alive: true, lockProgress });
    const intent = (tap = true) => client.applyIntents({ fireTap: tap, wantAds: true }, now,
      { allowFire: true, alive: true });
    try {
      assert.equal(client._lockReady, false, 'constructor starts without a cached lock');
      client.resetToLoadout();
      assert.equal(client.forceWeapon(slot, { mode: 'conquest', owned: ['rifle', 'stinger'], now }), true);
      now = 2000;
      intent();
      const loaded = client.ammoOf('stinger');
      assert.equal(client.tryFire(now, context(0.6)), false, 'partial frame lock blocks launch');
      assert.equal(forwarded.lockProgress, 0.6, 'frame progress reaches rig.setStinger unchanged');
      assert.equal(lit(parts), 3, 'frame progress reaches the actual indicator bank in the same call');
      assert.equal(client.tryFire(now, context(0)), false, 'no frame lock blocks launch');
      assert.deepEqual(client.ammoOf('stinger'), loaded, 'rejected locks consume no magazine or reserve ammo');
      assert.equal(launches, 0, 'rejected locks never invoke the launch presentation');
      assert.equal(client.tryFire(now, context(1)), true, 'full frame lock accepts a loaded launch');
      assert.equal(launches, 1);
      assert.deepEqual(client.ammoOf('stinger'), { mag: 0, reserve: loaded.reserve });
      assert.deepEqual(forwarded, { mag: 0, lockProgress: 0, reloading: false },
        'accepted launch forwards empty ammunition and clears lock in the same call');
      assert.equal(lit(parts), 0);
      assert.equal(parts.frontCover.visible, false);
      assert.equal(client.tryFire(now + 1, context(1)), false, 'stale full lock cannot release another round');
      assert.equal(launches, 1);
      assert.equal(client.ammoOf('stinger').mag, 0);

      now = 4000;
      assert.equal(client.startReload(now), true);
      assert.equal(forwarded.reloading, true, 'starting reload reaches the rig immediately');
      assert.equal(forwarded.lockProgress, 0);
      assert.equal(lit(parts), 0);
      // Even a loaded ammo snapshot cannot bypass an active reload.
      const mags = WEAPON_IDS.map((id) => client.ammoOf(id).mag);
      const reserve = WEAPON_IDS.map((id) => client.ammoOf(id).reserve);
      mags[slot] = 1;
      client.adoptServerAmmo(mags, reserve);
      const duringReload = client.ammoOf('stinger');
      assert.equal(client.tryFire(now, context(1)), false);
      assert.deepEqual(client.ammoOf('stinger'), duringReload, 'rejected reload fire consumes no ammo');
      assert.equal(forwarded.lockProgress, 0, 'reload overrides a full frame lock even after refill');
      assert.equal(lit(parts), 0);
      client.cancelReload();
      intent(false);
      client.tryFire(now, context(0.4));
      assert.equal(forwarded.lockProgress, 0.4, 'fresh frame context restores acquisition after refill');
      client.tryFire(now, context(1));
      assert.equal(lit(parts), 5);
      assert.equal(client.forceWeapon(WEAPON_IDS.indexOf('rifle'), { now }), true);
      assert.equal(forwarded.lockProgress, 0, 'switching clears the outgoing lock in the same call');
      assert.equal(lit(parts), 0);
      assert.equal(launches, 1, 'idle acquisition and switching cannot trigger another shot');
      client.menuReset();
      assert.equal(client._lockProgress, 0);
      assert.equal(client._lockReady, false, 'menu reset discards the cached launch gate');
    } finally { client.dispose(); }
  }
} finally {
  for (const { controller, gun } of controllers) controller.dispose(gun);
  disposeGunModels(models, cache);
}
console.log('STINGER: full launch-tube swap, fixed gripstock, authoritative lock/ammo, WeaponState launch gate, phase cancellation, rig swap and 30/60/120 fps presentation passed.');
