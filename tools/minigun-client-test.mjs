import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { WEAPON_IDS } from '../shared/combatmath.js';

function setup() {
  let now = 0, clacks = 0;
  const shots = [], motor = [];
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.01, 100));
  rig.onBoltClack = () => clacks++;
  const state = new WeaponState({ rig,
    audio: { draw() {}, reloadClick() {}, fire() {}, minigunMotor: (...args) => motor.push(args) },
    effects: { shoot: () => shots.push(now) }, feedback: { addExhaustion() {}, addRecoil() {} },
    network: { isCurrentGeneration: () => true, isRunning: () => true },
    now: () => now, setTimer: () => 0, clearTimer() {}, random: () => 0.5 });
  state.resetToLoadout(); state.forceWeapon(WEAPON_IDS.indexOf('minigun'));
  for (let i = 0; i < 240; i++) rig.update(1 / 120);
  now = 2000;
  const context = { allowFire: true, alive: true };
  const frame = (at, fireHeld = false, wantAds = true, extra = {}) => {
    const dt = (at - now) / 1000; now = at;
    state.applyIntents({ fireHeld, wantAds, ...extra }, now, context);
    const fired = state.tryFire(now, context);
    state.syncRigAds(); rig.update(dt);
    return fired;
  };
  return { state, rig, shots, motor, context, frame, get clacks() { return clacks; },
    dispose() { state.dispose(); rig.dispose(); } };
}

for (const fps of [30, 60, 144]) {
  const s = setup();
  try {
    for (let i = 0; i <= fps; i++) s.frame(2000 + i * 1000 / fps);
    assert.equal(s.shots.length, 0, 'ADS alone never predicts a shot');
    assert.equal(s.state.ammoOf('minigun').mag, 300);
    assert.equal(s.state.readModel().minigunPrimed, true);
    assert.equal(s.state.readModel().heat01, 0);
    for (let i = 0; i < fps * 2; i++) s.frame(3100 + i * 1000 / fps, true);
    assert.equal(s.shots.length, 40, `${fps}fps keeps 1200RPM through the actual rig`);
    assert.equal(s.shots[0], 3100, 'primed rotor fires on first trigger frame');
    assert.equal(s.clacks, 0, 'rotating barrels do not rack a rifle bolt');
    assert.ok(s.motor.some(([spin,, active]) => spin === 1 && active));
    const heat = s.state.readModel().heat01;
    s.frame(5200, false);
    assert.equal(s.state.readModel().spin01, 1, 'ADS maintains rotor speed through a pause');
    assert.ok(s.state.readModel().heat01 < heat);
    s.frame(5300, true);
    assert.equal(s.shots.at(-1), 5300, 'cooled pre-spin resumes immediately');
    s.frame(10000, true);
    assert.equal(s.shots.length, 42, 'stall emits at most one shot, never a catch-up burst');
  } finally { s.dispose(); }
}

for (const stop of ['reload', 'death', 'switch', 'authority', 'menu', 'dispose']) {
  const s = setup();
  try {
    s.frame(2000); s.frame(2800); s.frame(2900, true);
    if (stop === 'reload') s.frame(3000, false, true, { reload: true });
    if (stop === 'death') s.state.deathReset();
    if (stop === 'switch') s.state.forceWeapon(0, { now: 3000 });
    if (stop === 'authority') { s.context.allowFire = false; s.frame(3000); }
    if (stop === 'menu') s.state.menuReset();
    if (stop === 'dispose') s.state.dispose();
    assert.equal(s.motor.at(-1)[2], false, `${stop} silences motor immediately`);
  } finally { s.dispose(); }
}
{
  const s = setup();
  try {
    s.frame(2000); s.frame(2800);
    assert.equal(s.frame(2900, false, true, { fireTap: true }), true, 'ready rotor accepts a complete short tap');
    s.frame(3000, false, true);
    assert.equal(s.shots.length, 1, 'tap never latches into autofire');
    s.rig.reload(2, 'magswap');
    assert.equal(s.rig.fire(), false, 'rotary presentation still excludes reload actions');
  } finally { s.dispose(); }
}
console.log('Minigun client: pre-spin, first-frame trigger, 30/60/144fps cadence, rotor pause cooling, no bolt clacks, stall and audio lifecycle passed.');
