import assert from 'node:assert/strict';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { PlayerEntity } from '../server/sim/player.js';
import { resolveWeaponIntent } from '../server/sim/combat.js';
import { updateTimers } from '../server/sim/movement.js';

function client() {
  let now = 0;
  const calls = [];
  const state = new WeaponState({
    rig: { setWeapon() {}, fire: () => true, reload: () => calls.push(now),
      cancelReload() {}, pumpAnim() {}, boltAnim() {}, ads() {} },
    audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
    network: { isCurrentGeneration: () => true, isRunning: () => true },
    feedback: { addExhaustion() {}, addRecoil() {} },
    now: () => now, setTimer: () => 0, clearTimer() {}, random: () => 0.5,
  });
  state.resetToLoadout();
  return { state, calls, at: (value) => { now = value; } };
}

const context = { canUseWeapon: () => true, canFire: () => true };

// Match the live frame order: authority snapshot, reload/fire prediction, then
// reload=true while the local animation is active. A rejected edge used to be
// lost forever, with each false snapshot resetting the bar every 400ms.
for (const blocker of ['deploy', 'vault']) {
  const { state, calls, at } = client();
  const authority = new PlayerEntity('reload-regression', 'Test', { x: 4, y: 2, z: 4 }, false);
  authority.mag[0] = 0;
  authority.deployT = blocker === 'deploy' ? 0.8 : 0;
  authority.vault = blocker === 'vault' ? {} : null;
  state.adoptServerAmmo(authority.mag, authority.reserve);
  state.startReload(0);
  let previousProgress = 0;
  let progressResets = 0;
  for (let now = 20; now <= 5000; now += 20) {
    at(now);
    if (now >= 800) authority.vault = null;
    authority.input = { reload: state.isReloading, wantFire: false, keys: { sprint: true } };
    updateTimers(authority, 0.02);
    resolveWeaponIntent(authority, 0.02, context);
    state.reconcileServer({ mag: authority.mag, reserve: authority.reserve,
      weapon: 0, reloading: authority.reloading, alive: true }, now);
    state.applyIntents({}, now, { allowFire: true, alive: true });
    state.tickReload(now);
    state.tryFire(now);
    const progress = state.readModel(now).reloading01;
    if (progress !== null) {
      if (progress < previousProgress) progressResets++;
      previousProgress = progress;
    }
  }
  console.log(`Reload ${blocker} reproducer: ${calls.length} animation starts, ${progressResets} progress resets, authority magazine ${authority.mag[0]}.`);
  assert.equal(calls.length, 1, `${blocker}: a temporarily blocked server request must not restart presentation`);
  assert.equal(progressResets, 0, `${blocker}: reload progress must stay monotonic`);
  assert.equal(authority.mag[0], WEAPONS.rifle.magSize, `${blocker}: authority eventually accepts and completes the same request`);
  assert.equal(state.ammoOf('rifle').mag, authority.mag[0]);
  assert.equal(state.isReloading, false);
  state.dispose();
}

{
  const { state, calls, at } = client();
  state._ammo.rifle.mag = 0;
  state.startReload(0);
  for (const now of [100, 450, 700]) {
    at(now);
    state.reconcileServer({ reloading: false, weapon: 0, alive: true }, now);
    assert.equal(state.isReloading, true, 'latency beyond 400ms cannot reject an unseen request');
    assert.equal(state.readModel(now).reloading01, now / (WEAPONS.rifle.reloadTime * 1000));
    assert.equal(state.startReload(now), false, 'repeated reload input cannot reset the same animation');
  }
  state.reconcileServer({ reloading: true, weapon: 0, alive: true }, 750);
  state.reconcileServer({ reloading: false, weapon: 0, alive: true }, 800);
  assert.equal(state.isReloading, false, 'an acknowledged authoritative cancellation still stops promptly');
  assert.equal(calls.length, 1);
  state.dispose();
}

{
  const authority = new PlayerEntity('reload-edge', 'Test', { x: 4, y: 2, z: 4 }, false);
  authority.deployT = 0;
  authority.mag[0] = 10;
  authority.input = { reload: true, wantFire: false };
  resolveWeaponIntent(authority, 0.02, context);
  updateTimers(authority, 10);
  authority.mag[0]--;
  resolveWeaponIntent(authority, 0.02, context);
  assert.equal(authority.reloading, false, 'an accepted held request cannot reload again after completion and a shot');
}

{
  const { state, calls, at } = client();
  state._ammo.rifle.mag = 0;
  state.startReload(0);
  state.reconcileServer({ reloading: true, weapon: WEAPON_IDS.indexOf('shotgun'), alive: true }, 100);
  state.reconcileServer({ reloading: false, weapon: 0, alive: true }, 500);
  assert.equal(state.isReloading, true, 'a snapshot for another equipped weapon cannot acknowledge this reload');
  at(WEAPONS.rifle.reloadTime * 1000);
  state.tickReload(WEAPONS.rifle.reloadTime * 1000);
  state.reconcileServer({ reloading: true, weapon: 0, alive: true }, 2200);
  assert.equal(calls.length, 1, 'late in-progress acknowledgment cannot replay the completed animation');
  state.dispose();
}

console.log('Reload state: deferred authority acceptance, monotonic prediction, latency, input repetition, cancellation and late acknowledgment passed.');
