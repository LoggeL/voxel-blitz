import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { PlayerEntity } from '../server/sim/player.js';
import { stepMovement } from '../server/sim/movement.js';
import { VAULT_SECONDS } from '../shared/player-movement.js';
import { makeFirstPersonBody, updateFirstPersonBody, resetFirstPersonBody, disposeFirstPersonBody } from '../public/js/player/first-person-body.js';

const settle = (rig, seconds, ctx, hz = 60) => {
  for (let i = 0; i < Math.round(seconds * hz); i++) rig.update(1 / hz, ctx);
};
const sampleSprint = hz => {
  const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 100);
  const rig = new ViewmodelRig(camera);
  try {
    rig.setWeapon('rifle');
    settle(rig, 2, {}, hz);
    const baseline = rig.content.position.clone();
    rig.update(1 / hz, { speed: 6.2, grounded: true, isSprinting: true });
    assert.ok(rig.content.position.y > baseline.y - 0.04, 'sprint carry eases in instead of snapping down');
    settle(rig, 1 - 1 / hz, { speed: 6.2, grounded: true, isSprinting: true }, hz);
    const gait = rig.posG.position.clone();
    assert.ok(rig.content.position.y < baseline.y - 0.06, 'sprinting lowers the carried weapon');
    rig.ads(1);
    settle(rig, 2, { speed: 6.2, grounded: true, isSprinting: true }, hz);
    assert.ok(Math.abs(rig.content.rotation.y) < 0.002, 'ADS removes the sprint carry yaw');
    rig.ads(0);
    settle(rig, 2, {}, hz);
    assert.ok(rig.content.position.distanceTo(baseline) < 0.001, 'stopping restores the ready pose');
    assert.equal(camera.rotation.x, 0);
    assert.equal(camera.rotation.y, 0);
    assert.equal(camera.rotation.z, 0, 'movement animations leave camera aim untouched');
    return gait;
  } finally { rig.dispose(); }
};
const at30 = sampleSprint(30), at60 = sampleSprint(60), at120 = sampleSprint(120);
assert.ok(at30.distanceTo(at120) < 0.012 && at60.distanceTo(at120) < 0.006,
  'gait advances at comparable speed at 30, 60, and 120 Hz');

{
  const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 100);
  const rig = new ViewmodelRig(camera);
  rig.setWeapon('rifle');
  settle(rig, 2, {});
  const restY = rig.content.position.y;
  let highHand = -Infinity, lowHand = Infinity;
  for (let frame = 1; frame <= 29; frame++) {
    const progress = Math.min(1, frame / 60 / VAULT_SECONDS);
    rig.update(1 / 60, { vaulting: true, grounded: false, vaultProgress: progress });
    const handY = rig._vaultHands.hands[0].position.y;
    if (progress < 0.5) highHand = Math.max(highHand, handY);
    if (progress > 0.8) lowHand = Math.min(lowHand, handY);
  }
  assert.ok(highHand > -0.12 && lowHand < highHand - 0.2,
    'vault hands reach forward then press down during the pull-up');
  assert.ok(rig.content.position.y < restY - 0.5, 'weapon clears the climbing hands');
  settle(rig, 1, { grounded: true });
  assert.equal(rig._vaultHands.root.visible, false, 'hands leave the screen after the climb');
  assert.ok(Math.abs(rig.content.position.y - restY) < 0.001, 'weapon returns after the climb');
  rig.update(1 / 60, { vaulting: true, grounded: false, vaultProgress: 0.1 });
  settle(rig, 1, { grounded: true });
  assert.equal(rig._vaultHands.root.visible, false, 'aborted early grab also recovers');
  const resources = new Set();
  rig._vaultHands.root.traverse(node => {
    if (node.geometry) resources.add(node.geometry);
    if (node.material) resources.add(node.material);
  });
  let disposed = 0;
  for (const resource of resources) resource.addEventListener('dispose', () => disposed++);
  rig.dispose(); rig.dispose();
  assert.equal(disposed, resources.size, 'shared hand resources are disposed exactly once');
  assert.equal(camera.children.length, 0);
}

{
  const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 100);
  const rig = new ViewmodelRig(camera);
  const body = makeFirstPersonBody();
  const player = new LocalPlayer({ body, input: {
    consumeDelta: () => ({ dx: 0, dy: 0 }), getKeys: () => ({}), setGameplayEnabled() {},
  } });
  const weapon = new WeaponState({ rig,
    audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
    network: { isCurrentGeneration: () => true, isRunning: () => true },
    feedback: { addExhaustion() {}, addRecoil() {} }, now: () => 2000,
  });
  try {
    weapon.resetToLoadout();
    weapon.forceWeapon(WEAPON_IDS.indexOf('sniper'), { now: 0 });
    weapon.applyIntents({ wantAds: true }, 2000, { alive: true });
    player.wantAds = true;
    const frame = vaulting => {
      player.physics.vault = vaulting ? { elapsed: VAULT_SECONDS * 0.35 } : null;
      weapon.settleFrame(1 / 60, { vaulting });
      player.updateCamera(1 / 60, camera, WEAPONS.sniper, weapon.adsT, 75);
      rig.update(1 / 60, { vaulting, vaultProgress: 0.35 });
      weapon.syncRigAds();
    };
    for (let i = 0; i < 120; i++) frame(false);
    const scopedFov = camera.fov;
    assert.ok(weapon.scopeActive && player.scopeActive && !rig.root.visible,
      'sniper starts fully scoped with the gun and body hidden');
    frame(true);
    assert.ok(!weapon.scopeActive && !player.scopeActive && rig.root.visible && body.group.visible,
      'starting a vault immediately removes both scope readbacks and reveals hands/body');
    assert.ok(weapon.adsT > 0 && weapon.adsT < 1 && camera.fov > scopedFov && camera.fov < 75,
      'vaulting eases out of scoped zoom instead of snapping the field of view');
    for (let i = 0; i < 28; i++) frame(true);
    assert.ok(weapon.wantAds && rig._vaultHands.root.visible && !weapon.scopeActive,
      'holding ADS throughout the climb keeps the hands visible and remembers the input');
    for (let i = 0; i < 120; i++) frame(false);
    assert.ok(weapon.scopeActive && player.scopeActive && !rig.root.visible
      && Math.abs(camera.fov - scopedFov) < 0.01,
    'held ADS resumes its previous sniper zoom after the climb');

    const cliff = (x, y, z) => y < 10 || (x >= 20 && x < 23 && y < 13);
    const server = new PlayerEntity('vault-ads', 'vault-ads', { x: 19.5, y: 11.2, z: 24.5 }, false);
    server.weapon = WEAPON_IDS.indexOf('sniper');
    server.deployT = 0;
    server.adsT = 1;
    server.input = { yaw: -Math.PI / 2, pitch: 0, wantAds: true, keys: { jump: true } };
    let caught = false, lastAds = 1;
    for (let i = 0; i < 10; i++) {
      stepMovement(server, 1 / 20, { solidAt: cliff, now: i * 50, onFall() {} });
      caught ||= !!server.vault;
      assert.ok(!server.ads && server.adsT <= lastAds && (i > 0 || server.adsT < 1),
        'authority eases ADS down during the entire pull-up, including its first and last ticks');
      lastAds = server.adsT;
      if (caught && !server.vault) break;
    }
    assert.ok(caught && !server.vault && server.y === 13);
    stepMovement(server, 1 / 20, { solidAt: cliff, now: 550, onFall() {} });
    assert.ok(server.ads && server.adsT > lastAds, 'authority resumes held ADS after the climb');
  } finally { weapon.dispose(); player.dispose(); rig.dispose(); disposeFirstPersonBody(body); }
}

{
  const body = makeFirstPersonBody();
  const pos = { x: 0, y: 2, z: 0 };
  const step = (motion, speed = 0, crouch = false, frames = 1) => {
    for (let i = 0; i < frames; i++) updateFirstPersonBody(body, 1 / 60, pos, 0, speed,
      crouch, true, 0, 1, false, 0, motion);
  };
  try {
    step({ grounded: true });
    step({ grounded: false, verticalVelocity: 5 }, 5, false, 20);
    assert.ok(body.left.leg.rotation.x < -0.3 && body.left.knee.rotation.x > 0.6,
      'airborne legs tuck instead of continuing the running cycle');
    step({ grounded: false, verticalVelocity: -9 }, 0, false, 10);
    step({ grounded: true });
    const landingY = body.hips.position.y;
    step({ grounded: true }, 0, false, 90);
    assert.ok(landingY < body.hips.position.y - 0.06, 'landing compresses and recovers the body');
    step({ grounded: true }, 0, true);
    assert.ok(body.crouch > 0 && body.crouch < 0.5, 'crouch enters smoothly');
    resetFirstPersonBody(body);
    step({ grounded: true, forwardSpeed: 0, lateralSpeed: 5 }, 5, false, 25);
    assert.ok(Math.abs(body.left.leg.rotation.z) > 0.1 && Math.abs(body.left.leg.rotation.x) < 0.02,
      'strafing steps sideways instead of playing a forward run');
    resetFirstPersonBody(body);
    assert.equal(body.air, 0);
    assert.equal(body.land, 0);
    assert.equal(body.wasGrounded, null, 'respawn clears airborne and landing history');
  } finally { disposeFirstPersonBody(body); }
}
console.log('Movement animations passed: frame rates, sprint/ADS, scoped vault recovery, vault choreography and disposal, directional legs, landing, reset.');
