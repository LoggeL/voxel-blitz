import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPONS } from '../shared/combatmath.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { WeaponActions } from '../public/js/guns/actions.js';
import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';

const swapIds = ['rifle', 'smg', 'lmg', 'minigun', 'longarc', 'lance', 'flamethrower'];
const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 100);
const rig = new ViewmodelRig(camera);
const frustum = new THREE.Frustum();
const projection = new THREE.Matrix4();
const bounds = new THREE.Box3();
const signatures = new Set();

function visibleInCamera(object) {
  camera.updateMatrixWorld(true);
  frustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  bounds.setFromObject(object);
  return frustum.intersectsBox(bounds);
}

function advanceTo(fraction, duration, start) {
  const target = start + fraction * duration;
  while (rig._now + 1e-8 < target) rig.update(Math.min(1 / 120, target - rig._now));
}

try {
  for (const fov of [75, 100]) for (const id of swapIds) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    rig.setWeapon(id);
    for (let i = 0; i < 100; i++) rig.update(1 / 60);
    const model = rig._cur;
    const hand = model.root.getObjectByName('hand_l');
    const handHome = hand.position.clone();
    const handNormallyVisible = hand.visible;
    const timeline = model.T.magTimeline;
    const exitEnd = timeline.start + Math.min(0.20, (timeline.home - timeline.start) * 0.34);
    const enterStart = timeline.home - 0.21;
    const duration = WEAPONS[id].reloadTime;
    const start = rig._now;
    rig.reload(duration, 'magswap');
    advanceTo(0.16, duration, start);
    signatures.add([rig.content.rotation.x, rig.content.rotation.y, rig.content.rotation.z].map(v => v.toFixed(2)).join('/'));
    advanceTo(exitEnd - 0.001, duration, start);
    assert.equal(model.mag.visible, true, `${id}: spent magazine is not hidden before it crosses the frame`);
    assert.equal(visibleInCamera(model.mag), false, `${id}: entire spent magazine clears the real camera frustum`);
    advanceTo((exitEnd + enterStart) / 2, duration, start);
    assert.equal(model.mag.visible, false, `${id}: empty hands visit the pouch out of view`);
    assert.equal(hand.visible, false, `${id}: support hand travels with the removed ammunition`);
    advanceTo(enterStart + 0.001, duration, start);
    assert.equal(model.mag.visible, true, `${id}: replacement begins a distinct entry`);
    assert.equal(visibleInCamera(model.mag), false, `${id}: new magazine starts below the frame edge`);
    advanceTo(timeline.home - 0.02, duration, start);
    assert.equal(visibleInCamera(model.mag), true, `${id}: fresh magazine is visible during final insertion`);
    advanceTo(1.01, duration, start);
    assert.equal(model.mag.visible, true);
    assert.equal(model.mag.position.length(), 0);
    assert.equal(hand.visible, handNormallyVisible);
    assert.ok(hand.position.distanceTo(handHome) < 1e-9, `${id}: support hand returns exactly to its grip`);
    rig.reload(duration, 'magswap');
    const cancelStart = rig._now;
    advanceTo((exitEnd + enterStart) / 2, duration, cancelStart);
    rig.cancelReload();
    assert.equal(model.mag.visible, true, `${id}: cancellation cannot leave a hidden ammo assembly`);
    assert.ok(hand.position.distanceTo(handHome) < 1e-9);
  }
  assert.equal(signatures.size, swapIds.length, 'each receiver/feed family has its own presentation');
} finally { rig.dispose(); }

const cache = new MaterialCache();
const models = [];
function modelFor(id) { const model = buildGun(id, cache); models.push(model); return model; }
try {
  const rocket = modelFor('rocket');
  const action = new WeaponActions();
  action.startReload(0, 1, 'magswap', rocket.T);
  const round = rocket.extra.userData.reloadRounds;
  const gate = rocket.extra.userData.rocketReload.gate;
  action.update(0.35, 0, rocket, rocket.T);
  assert.ok(Math.abs(gate.rotation.y) > 1.2, 'rocket has a fully open rear breech');
  action.update(0.50, 0, rocket, rocket.T);
  assert.equal(round.visible, true, 'a complete new rocket is drawn');
  action.update(0.68, 0, rocket, rocket.T);
  assert.ok(Math.abs(round.position.x) < 1e-9, 'new rocket aligns with the tube');
  assert.equal(round.position.y, rocket.T.muzzle[1]);
  const alignedZ = round.position.z;
  action.update(0.81, 0, rocket, rocket.T);
  assert.ok(round.position.z < alignedZ - 0.4, 'rocket is inserted forward along the bore axis');
  action.update(0.94, 0, rocket, rocket.T);
  assert.equal(round.visible, false, 'seated rocket is inside the tube');
  assert.ok(Math.abs(gate.rotation.y) < 1e-9, 'rear breech latches closed');
  action.cancelReload(rocket);
  assert.equal(round.visible, false);
  assert.equal(gate.rotation.y, 0);

  const shotgun = modelFor('shotgun');
  const stage = WEAPONS.shotgun.reloadStages;
  action.startReload(0, stage.start + 2 * stage.perRound + stage.end, 'tube', shotgun.T,
    { startSeconds: stage.start, perRoundSeconds: stage.perRound, rounds: 2 });
  const shell = shotgun.extra.userData.reloadRounds;
  action.update(stage.start + stage.perRound * 0.5, 0, shotgun, shotgun.T);
  assert.equal(shell.visible, true, 'tube reload visibly brings a shell to the loading port');
  const shellLowY = shell.position.y;
  action.update(stage.start + stage.perRound * 0.95, 0, shotgun, shotgun.T);
  assert.ok(shell.position.y > shellLowY + 0.2, 'shell reaches the gate before its seating sound');
  action.update(stage.start + stage.perRound * 2 + 0.001, 0, shotgun, shotgun.T);
  assert.equal(shell.visible, false, 'there is no extra shell after the authorized round count');
  action.cancelReload(shotgun);
  assert.equal(shell.visible, false);

  const sniper = modelFor('sniper');
  action.startReload(0, 1, 'magswap', sniper.T);
  action.update(0.5, 0, sniper, sniper.T);
  assert.ok(sniper.bolt.position.z > 0.15, 'sniper bolt stays open while loading rounds');
  assert.ok(sniper.extra.userData.cartridges.some(cartridge => cartridge.visible));
  action.cancelReload(sniper);
  assert.equal(sniper.bolt.position.length(), 0);
  assert.equal(action.startReload(0, 1, 'magswap', modelFor('knife').T), false, 'melee never receives a reload animation');
  action.dispose();
} finally { disposeGunModels(models, cache); }
console.log('Reload presentation: real frustum clearance, distinct replacement paths, support hands, shell seating, open sniper bolt, rear-loaded rocket and exact cancellation passed.');

// Recovery seeks the rig's seconds-based clock, and reload takes ownership of
// moving parts previously animated by a pump/bolt cycle.
{
  const recovered = new ViewmodelRig(camera);
  recovered.setWeapon('rifle');
  recovered.reload(2, 'magswap', null, 1);
  assert.equal(recovered._actions._reload.t0, recovered._now - 1);
  recovered.update(0.01);
  assert(recovered._actions._reload.lastFrac > 0.5);
  recovered.dispose();
  const actions = new WeaponActions();
  actions._cycle = { kind: 'pump' };
  actions._jerk = { t: 0 };
  actions.startReload(0, 2, 'magswap', { magTimeline: { type: 'mag' } });
  assert.equal(actions._cycle, null);
  assert.equal(actions._jerk, null);
  actions.dispose();
}
