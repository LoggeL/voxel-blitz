import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { WEAPONS } from '../shared/combatmath.js';
import { weaponSwapProfile } from '../shared/weapon-swap.js';
import { switchWeapon, canFire } from '../server/sim/combat.js';

const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.01, 100));
const advance = (seconds) => { for (let i = 0; i < Math.ceil(seconds * 120); i++) rig.update(1 / 120, { grounded: true }); };
rig.setWeapon('rifle'); advance(1);
rig.equipWeapon('revolver'); advance(0.18);
assert.equal(rig._id, 'rifle', 'outgoing weapon stays visible while stowing');
assert.ok(rig._deployOffset().y < -0.3);
assert.equal(rig.fire(), false);
rig.equipWeapon('sniper'); advance(0.19);
assert.equal(rig._id, 'sniper', 'scroll retargets the hidden swap without flashing intermediate weapons');
assert.equal(rig.fire(), false);
advance(weaponSwapProfile(WEAPONS.sniper).draw + 0.03);
assert.ok(rig._depT >= 1);
assert.equal(rig._deployOffset().y, 0);
assert.equal(rig.fire(), true);
rig.dispose();

{
  // The state's def names the incoming gun the moment a swap starts (and stays on the gun
  // during a quick-melee knife); the shown model must keep dressing from its own loadout.
  let clock = 0;
  const shown = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.01, 100));
  const weapon = new WeaponState({ rig: shown, now: () => clock,
    audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
    feedback: { addExhaustion() {}, addRecoil() {} },
    network: { isCurrentGeneration: () => true, isRunning: () => true }, setTimer: () => 0, clearTimer() {},
  });
  weapon.resetToLoadout();
  weapon.setLoadout({ smg: { optic: 'reflex' }, knife: { counter: 'stattrak' } });
  shown.setMastery({ knife: { kills: 3, headshots: 0 } });
  shown.setWeapon('rifle');
  const step = (seconds) => { for (let i = 0; i < Math.ceil(seconds * 120); i++) {
    clock += 1000 / 120;
    shown.update(1 / 120, { grounded: true, weaponDef: weapon.def, weaponLoadout: weapon.weaponLoadout });
  } };
  step(0.5);
  const rifle = shown._models.rifle;
  assert.equal(rifle.attachmentKey, 'standard/standard');
  assert.equal(weapon.forceWeapon(1, { now: clock }), true);
  const { holster, draw } = weaponSwapProfile(WEAPONS.smg);
  step(holster * 0.9);
  assert.equal(shown._id, 'rifle');
  assert.equal(rifle.attachmentKey, 'standard/standard', 'the holstering rifle never grows the SMG optic');
  step(holster * 0.1 + draw + 0.05);
  assert.equal(shown._id, 'smg');
  assert.equal(shown._models.smg.attachmentKey, 'reflex/standard');
  assert.equal(shown.quickMelee(), true);
  step(1 / 120);
  assert.equal(shown._id, 'knife');
  assert.equal(shown._models.knife.stattrakKey, 'stattrak/3', 'the quick-melee knife shows its own counter');
  shown.dispose(); weapon.dispose();
}

let now = 0;
const state = new WeaponState({
  rig: { root: { visible: false }, setWeapon() {}, reload() {}, pumpAnim() {}, boltAnim() {}, ads() {}, equipWeapon() {}, fire: () => true },
  audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
  feedback: { addExhaustion() {}, addRecoil() {} },
  network: { isCurrentGeneration: () => true, isRunning: () => true }, now: () => now, setTimer: () => 0, clearTimer() {}, random: () => 0.5,
});
state.resetToLoadout(); state.forceWeapon(5, { now });
const total = weaponSwapProfile(WEAPONS.revolver).total;
state.applyIntents({ fireTap: true, wantAds: true }, now, { allowFire: true, alive: true });
state.settleFrame(0.1); assert.equal(state.adsT, 0);
assert.equal(state.tryFire(total * 1000 - 1), false);
assert.equal(state._deployUntil, total * 1000);
const player = { weapon: 0, def: WEAPONS.revolver, cooldown: 0, mag: Array(10).fill(5) };
switchWeapon(player, 5);
assert.equal(player.deployT, total, 'server and client lock the identical whole swap');
assert.equal(canFire(player, true, { canFire: () => true }), false);
player.deployT = 0;
assert.equal(canFire(player, true, { canFire: () => true }), true);
console.log('Weapon swap: stow, hidden retarget, draw, fire gating, scope gating and shared server timing passed.');
