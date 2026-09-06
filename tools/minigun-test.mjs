import assert from 'node:assert/strict';
import { MINIGUN, createMinigunState, stepMinigun, heatMinigun, minigunDamageMult } from '../shared/minigun.js';
import { resolveWeaponIntent } from '../server/sim/combat.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';

const thermal = createMinigunState();
assert.equal(stepMinigun(thermal, 0.69, true), false);
assert.equal(stepMinigun(thermal, 0.02, true), true);
assert.equal(minigunDamageMult(thermal), 1);
for (let i = 0; i < Math.ceil(MINIGUN.sweetHeat / MINIGUN.heatPerShot); i++) heatMinigun(thermal);
assert.equal(minigunDamageMult(thermal), 1.65);
while (!thermal.overheated) heatMinigun(thermal);
assert.equal(stepMinigun(thermal, 3, true), false);
assert.ok(thermal.overheated);
stepMinigun(thermal, 0.6, true);
assert.equal(thermal.overheated, false);
assert.equal(thermal.spin, 0, 'unlock still requires spin-up');
assert.ok(thermal.heat <= 0.3);
const coarse = { heat: 0.8, spin: 0, overheated: false };
const fine = { ...coarse };
stepMinigun(coarse, 0.8, true);
for (let i = 0; i < 80; i++) stepMinigun(fine, 0.01, true);
assert.ok(Math.abs(coarse.heat - fine.heat) < 1e-10, 'warm-up cooling is frame-rate independent');
assert.ok(Math.abs(coarse.heat - 0.66) < 1e-10);

const slot = WEAPON_IDS.indexOf('minigun');
const p = { id: 'thermal-test', def: WEAPONS.minigun, weapon: slot,
  mag: WEAPON_IDS.map(id => WEAPONS[id].magSize), reserve: WEAPON_IDS.map(id => WEAPONS[id].spareMags),
  input: { wantFire: true }, cooldown: 0, deployT: 0, shotSeq: 0,
  x: 0, eyeY: 2, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0,
  adsT: 0, panic: 0, pain: 0, exhaustion: 0, bloom: 0 };
const events = [];
const ctx = { canFire: () => true, canUseWeapon: () => true, canDamage: () => true,
  getBlock: () => 0, solidAt: () => false, entities: new Map(), blockHp: new Map(),
  pushEvent: e => events.push(e), now: 0 };
const tick = () => { p.cooldown = Math.max(0, p.cooldown - 1/60); resolveWeaponIntent(p, 1/60, ctx); };
for (let i = 0; i < 40; i++) tick();
assert.equal(p.shotSeq, 0, 'server enforces wind-up');
for (let i = 0; i < 400 && !p.minigun.overheated; i++) tick();
assert.ok(p.minigun.overheated);
const stopped = p.shotSeq;
for (let i = 0; i < 180; i++) tick();
assert.equal(p.shotSeq, stopped, 'held trigger cannot bypass cooling lock');
for (let i = 0; i < 90; i++) tick();
assert.ok(p.shotSeq > stopped, 'held trigger resumes only after cooling and a fresh spin-up');
p.input.wantFire = false;
for (let i = 0; i < 120; i++) tick();
assert.equal(p.minigun.overheated, false);
assert.ok(p.minigun.heat < 0.1);

let now = 0;
const state = new WeaponState({
  rig: { setWeapon() {}, fire: () => true, reload() {}, pumpAnim() {}, boltAnim() {}, ads() {} },
  audio: { draw() {}, fire() {}, reloadClick() {} }, effects: { shoot() {} },
  network: { isCurrentGeneration: () => true, isRunning: () => true },
  feedback: { addExhaustion() {}, addRecoil() {} }, now: () => now,
  setTimer: () => 0, clearTimer() {}, random: () => 0.5,
});
state.resetToLoadout(); state.forceWeapon(slot);
now = state._deployUntil;
state.applyIntents({ fireHeld: true }, now, { allowFire: true });
assert.equal(state.tryFire(now), false);
assert.equal(state.tryFire(now += 690), false);
assert.equal(state.tryFire(now += 20), true);
state._minigun.heat = 0.95;
state.forceWeapon(0, { now });
assert.equal(state._minigun.heat, 0.95, 'holstering retains heat');
state.reconcileServer({ minigun: { heat: 0.95, spin: 1, overheated: false } }, now);
assert.equal(state._minigun.spin, 0, 'a delayed snapshot cannot restore holstered rotor speed');
state.forceWeapon(slot, { now });
state.reconcileServer({ minigun: { heat: 0.95, spin: 1, overheated: false } }, now);
assert.equal(state._minigun.spin, 0, 'a delayed snapshot cannot bypass a fresh draw');
now = state._deployUntil;
state._ammo.minigun.mag = 0;
state.applyIntents({ fireHeld: true }, now, { allowFire: true });
assert.equal(state.tryFire(now), false);
assert.equal(state._reloadState?.weapon, 'minigun', 'empty minigun reloads even with a stopped rotor');
state.respawn({ now });
assert.equal(state._minigun.heat, 0, 'fresh life clears thermal state');
state.reconcileServer({ minigun: { heat: 1, spin: 0, overheated: true } });
assert.equal(state._minigun.overheated, true, 'authority corrects prediction');
state.dispose();
console.log('Minigun: wind-up, heat bonus, overheat lock, held-trigger cooldown, holster persistence, respawn and reconciliation passed.');

const THREE = await import('../public/js/vendor/three.module.js');
const { ViewmodelRig } = await import('../public/js/guns/viewmodel.js');
const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.01, 100));
rig.setWeapon('minigun');
const rotor = rig._cur.body.getObjectByName('minigun_rotor');
assert.ok(rotor);
rig.setMinigun({ spin: 0.5, heat: 0.8 });
rig.update(1/60, { grounded: true });
assert.ok(rotor.rotation.z > 0);
const warmBarrel = rotor.children.find(o => o.material?.userData.thermal);
assert.ok(warmBarrel.material.emissiveIntensity > 1);
const angle = rotor.rotation.z;
rig.setMinigun({ spin: 0, heat: 0 });
rig.update(1/60, { grounded: true });
assert.equal(rotor.rotation.z, angle);
assert.equal(warmBarrel.material.emissiveIntensity, 0);
rig.dispose();
console.log('Minigun model: rotor motion, stop, heat glow and cooling passed.');
