import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { configuredWeapon } from '../shared/weapon-attachments.js';
import { bastionWeaponDef } from '../shared/bastion.js';
import { chaosWeaponDef } from '../shared/chaos.js';

const noop = () => {};
const state = new WeaponState({
  rig: { setWeapon: noop, fire: () => true, reload: noop, pumpAnim: noop, boltAnim: noop, ads: noop },
  audio: { draw: noop, reloadClick: noop, fire: noop }, effects: { shoot: noop },
  network: { isCurrentGeneration: () => true, isRunning: () => true },
  feedback: { addExhaustion: noop, addRecoil: noop }, now: () => 0, setTimer: () => 0, clearTimer: noop,
});
const baseline = () => bastionWeaponDef({ bastionUpgrades: state._mode === 'bastion' ? state._bastionUpgrades : null },
  chaosWeaponDef({ chaosUpgrades: state._mode === 'chaos' ? state._chaosUpgrades : null }, configuredWeapon(WEAPON_IDS[state.slot], state.weaponLoadout)));
const reconcile = (value) => state.reconcileServer({ alive: true, ...value }, 0);

try {
  state.resetToLoadout();
  for (const id of WEAPON_IDS) {
    const slot = WEAPON_IDS.indexOf(id);
    state.forceWeapon(slot, { now: 0 });
    for (const mode of ['fun', 'chaos', 'bastion']) {
      for (const level of [0, 1, 2, 3]) {
        reconcile({ weapon: slot, mode, chaosUpgrades: { [id]: level }, bastionUpgrades: { reload: level > 0 } });
        assert.deepEqual(state.def, baseline(), `${id}/${mode}/${level}: cache retains canonical gameplay definition`);
        const def = state.def;
        for (let i = 0; i < 20; i++) assert.equal(state.def, def, 'same effective configuration returns one definition');
        reconcile({ weapon: slot, mode, chaosUpgrades: { [id]: level }, bastionUpgrades: { reload: level > 0 } });
        assert.equal(state.def, def, 'equal snapshot values retain the definition despite new object identities');
      }
    }
  }

  state.forceWeapon(WEAPON_IDS.indexOf('rifle'), { now: 0 });
  reconcile({ mode: 'fun' });
  for (const selection of [
    { optic: 'scope4', grip: 'vertical', counter: 'standard' },
    { optic: 'scope4', grip: 'vertical', counter: 'stattrak' },
    { optic: 'reflex', grip: 'angled', counter: 'stattrak' },
    { optic: 'standard', grip: 'standard', counter: 'standard' },
  ]) {
    state.setLoadout({ rifle: selection });
    assert.deepEqual(state.def, baseline(), 'loadout changes take effect immediately');
    const def = state.def;
    reconcile({ weapon: 0, attachments: { ...selection } });
    assert.equal(state.def, def, 'equivalent authoritative attachments retain the cache');
    const model = state.readModel(0);
    assert.equal(model.zoom, def.zoom);
    assert.equal(model.wid, def.id);
    assert.equal(model.mag, state.ammoOf(def.id).mag);
  }

  state.forceWeapon(WEAPON_IDS.indexOf('glaive'), { now: 0 });
  reconcile({ mode: 'chaos', chaosUpgrades: { glaive: 1 } });
  const shorter = state.def;
  state._chaosUpgrades.glaive = 3;
  assert.deepEqual(state.def, baseline(), 'in-place upgrade changes invalidate the cache');
  assert.notEqual(state.def, shorter);
  assert.equal(state.readModel(0).glaive.magSize, state.def.magSize, 'HUD uses the upgraded magazine capacity');
  reconcile({ mode: 'fun', chaosUpgrades: { glaive: 3 } });
  assert.equal(state.def, configuredWeapon('glaive', state.weaponLoadout), 'mode changes remove inactive upgrades');

  state.forceWeapon(WEAPON_IDS.indexOf('shotgun'), { now: 0 });
  reconcile({ mode: 'bastion', bastionUpgrades: { reload: true } });
  assert.ok(state.def.reloadTime < WEAPONS.shotgun.reloadTime);
  state.menuReset();
  state.respawn({ mode: 'bastion', weapon: WEAPON_IDS.indexOf('shotgun'), now: 0 });
  assert.equal(state.def.reloadTime, WEAPONS.shotgun.reloadTime, 'a new session cannot inherit a previous Bastion reload purchase');

  if (process.argv.includes('--bench')) {
    state.forceWeapon(WEAPON_IDS.indexOf('shotgun'), { now: 0 });
    reconcile({ mode: 'bastion', bastionUpgrades: { reload: true } });
    const iterations = 200000;
    let checksum = 0;
    for (let i = 0; i < 20000; i++) { checksum += state.def.reloadTime; checksum += baseline().reloadTime; }
    const run = (get) => {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) checksum += get().reloadTime;
      return performance.now() - start;
    };
    const uncachedMs = run(baseline), cachedMs = run(() => state.def);
    console.log(JSON.stringify({ iterations, uncachedMs, cachedMs, checksum, note: 'Node microbenchmark, not a browser FPS estimate' }));
  }
} finally {
  state.dispose();
}

console.log('ok - weapon definition cache matches canonical attachments/upgrades, snapshots, in-place changes, HUD capacity and fresh-session reload state');
