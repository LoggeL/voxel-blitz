import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { BreathHold } from '../public/js/player/breath-hold.js';
import { AimSway } from '../public/js/player/aim-sway.js';
import { isScopeActive, nextScopeZoom } from '../public/js/guns/scope-state.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { projectAimReticle } from '../public/js/ui/aim-reticle.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';

for (const hz of [30, 60, 144]) {
  const breath = new BreathHold();
  const events = [];
  for (let frame = 0; frame < hz * 4; frame++) {
    const state = breath.update(1 / hz, { eligible: true, pressed: true });
    if (state.breathEvent) events.push(state.breathEvent);
  }
  assert.deepEqual(events, ['inhale', 'gasp'], 'Holding Shift cannot restart after exhaustion');
  assert.equal(breath.reserve, 0);
  for (let frame = 0; frame < hz * 3; frame++) breath.update(1 / hz);
  assert.equal(breath.reserve, 1);
  assert.equal(breath.update(1 / hz, { eligible: true, pressed: true }).breathEvent, 'inhale');
  const left = breath.reserve;
  assert.equal(breath.update(1 / hz).breathEvent, 'exhale');
  assert.equal(breath.reserve, left, 'A quick release cannot refill breath');
  assert.equal(breath.update(1 / hz).breathEvent, null, 'Release sound is emitted once');
}
for (const options of [{ ads: 0 }, { grounded: false }, { stationary: false }, { alive: false }, { handlingAllowed: false }]) {
  const sway = new AimSway();
  const result = sway.update(1 / 60, { ads: 1, stationary: true, grounded: true, shift: true, ...options });
  assert.equal(result.holdingBreath, false, 'Ineligible actions cannot consume breath');
  assert.equal(result.breathRemaining01, 1);
}
assert.equal(nextScopeZoom(WEAPONS.sniper), 2.5, 'First zoom press works before camera initialization');
assert.equal(nextScopeZoom(WEAPONS.sniper, 2.5), 5);
assert.equal(nextScopeZoom(WEAPONS.rifle, 5), 0);
for (const gate of ['vaulting', 'grenadeHandling', 'reloading', 'deploying']) {
  assert.equal(isScopeActive({ weapon: 'sniper', ads: 1, [gate]: true }), false);
}

let now = 2000;
const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 500);
const rig = new ViewmodelRig(camera);
const weapon = new WeaponState({ rig, now: () => now,
  audio: { draw() {}, fire() {}, reloadClick() {}, weaponCharge() {} },
  effects: { shoot() {} }, feedback: { addExhaustion() {}, addRecoil() {} },
  setTimer: () => 0, clearTimer() {},
  network: { isCurrentGeneration: () => true, isRunning: () => true },
});
const input = new Proxy({ setGameplayEnabled() {} }, { get: (object, key) => object[key] ?? (() => false) });
const physics = { pos: { x: 0, y: 2, z: 0 }, vel: { x: 0, y: 0, z: 0 }, step: () => false, eyeY: () => 3.62, setMapMeta() {} };
const player = new LocalPlayer({ input, physics });
try {
  weapon.resetToLoadout();
  weapon.forceWeapon(WEAPON_IDS.indexOf('sniper'), { now });
  rig.setWeapon('sniper');
  for (let i = 0; i < 240; i++) rig.update(1 / 120);
  now += 2000;
  const context = { allowFire: true, alive: true };
  weapon.applyIntents({ wantAds: true }, now, context);
  for (let i = 0; i < 60; i++) weapon.settleFrame(1 / 60);
  assert.equal(weapon.scopeActive, true);
  // Residual carry motion during scope entry must still land on the fixed reticle.
  player._weaponAim.readModel.yaw = 0.02;
  player._weaponAim.readModel.pitch = -0.01;
  for (const pitch of [-1, 0, 1]) {
    player.view.pitch = pitch;
    player.updateCamera(1 / 60, camera, weapon.def, 0.73, 75, weapon.scopeActive);
    const point = projectAimReticle(camera, player.shotYaw, player.shotPitch);
    assert.ok(Math.abs(point.x - 0.5) < 1e-6 && Math.abs(point.y - 0.5) < 1e-6);
  }
  weapon.applyIntents({ wantAds: true, fireTap: true }, now, context);
  assert.equal(weapon.tryFire(now, context), true);
  assert.equal(weapon.ammoOf('sniper').mag, 4);
  now += 100;
  weapon.applyIntents({ wantAds: true, fireTap: true }, now, context);
  assert.equal(weapon.tryFire(now, context), false, 'Bolt cycle gates rapid clicks');
  assert.equal(weapon.startReload(now), true);
  weapon.settleFrame(1 / 144);
  assert.equal(weapon.scopeActive, false, 'Reload exposes hands on its first frame');
  assert.equal(weapon.readModel().scopeActive, false, 'HUD consumes the same scope decision');
  assert.equal(rig.root.visible, true);
} finally { weapon.dispose(); rig.dispose(); player.dispose(); }
console.log('Sniper: breath lifecycle at 30/60/144 Hz, eligibility, zoom, scope gates, reticle alignment, bolt cadence and reload passed.');
