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

// Loose shotgun shells survive interrupted reloads and partial reserves.
for (const reserve of [1, 3, 42]) {
  const slot = WEAPON_IDS.indexOf('shotgun');
  const authority = new PlayerEntity('shells', 'Test', { x: 4, y: 2, z: 4 }, false);
  authority.weapon = slot;
  authority.deployT = 0;
  authority.mag[slot] = 2;
  authority.reserve[slot] = reserve;
  authority.input = { reload: true, wantFire: false };
  resolveWeaponIntent(authority, 0.01, context);
  updateTimers(authority, WEAPONS.shotgun.reloadStages.start);
  assert.equal(authority.reserve[slot], reserve, 'starting a reload does not spend shells');
  updateTimers(authority, WEAPONS.shotgun.reloadStages.perRound);
  assert.equal(authority.mag[slot], 3);
  assert.equal(authority.reserve[slot], reserve - 1);
  authority.input = { reload: false, wantFire: false, switchTo: 0 };
  resolveWeaponIntent(authority, 0.01, context);
  assert.equal(authority.reserve[slot], reserve - 1, 'switching preserves all uninserted shells');

  const { state } = client();
  state.forceWeapon(slot, { now: 0 });
  state._ammo.shotgun = { mag: 2, reserve };
  state.startReload(2000);
  state.tickReload(2000 + WEAPONS.shotgun.reloadStages.start * 1000);
  assert.equal(state.ammoOf('shotgun').reserve, reserve);
  state.tickReload(10000);
  assert.deepEqual(state.ammoOf('shotgun'), { mag: 2 + Math.min(5, reserve), reserve: Math.max(0, reserve - 5) });
  state.dispose();
}
console.log('Shotgun shells: per-shell consumption, interruption conservation and limited reserve passed.');

// Exercise numbered requests with snapshots slower than rendering. Deploy can
// outlast the entire predicted animation without losing the pending request.
for (const id of WEAPON_IDS.filter(id => WEAPONS[id].mode !== 'melee')) {
  for (const delay of [0, 5000]) {
    const slot = WEAPON_IDS.indexOf(id);
    const { state, calls, at } = client();
    const authority = new PlayerEntity('wire-reload', 'Test', { x: 4, y: 2, z: 4 }, false);
    authority.weapon = slot;
    authority.mag[slot] = 0;
    authority.deployT = delay / 1000;
    state.forceWeapon(slot, { now: -10000 });
    state.adoptServerAmmo(authority.mag, authority.reserve);
    assert.equal(state.startReload(0), true);
    let accepted = false;
    for (let now = 20; now < 12000; now += 20) {
      at(now);
      authority.input = { reload: state.reloadRequested, reloadId: state.reloadId, wantFire: false };
      updateTimers(authority, 0.02);
      resolveWeaponIntent(authority, 0.02, context);
      accepted ||= authority.reloadAck === state.reloadId;
      if (now % 200 === 0) state.reconcileServer({
        weapon: slot, alive: true, mag: authority.mag, reserve: authority.reserve,
        reloading: authority.reloading, reloadAck: authority.reloadAck,
        reloadState: authority.reloadState,
      }, now);
      state.tickReload(now);
    }
    assert.equal(accepted, true, `${id}: request survives delayed acceptance`);
    assert.equal(authority.mag[slot], WEAPONS[id].magSize);
    assert.deepEqual(state.ammoOf(id), { mag: authority.mag[slot], reserve: authority.reserve[slot] });
    assert.equal(state.reloadRequested, false);
    assert.equal(calls.length, 1, `${id}: delayed snapshots do not replay animation`);
    state.dispose();
  }
}

{
  const { state } = client();
  state._ammo.rifle.mag = 4;
  state.startReload(0);
  state.tickReload(10000);
  assert.equal(state.reloadRequested, true, 'completed prediction keeps requesting until acknowledged');
  state.reconcileServer({ weapon: 0, reloading: false, reloadAck: 0 }, 10001);
  assert.equal(state.reloadRequested, true, 'pre-request idle snapshot cannot release completion lock');
  state.reconcileServer({ weapon: 0, reloading: false, reloadAck: state.reloadId }, 10002);
  assert.equal(state.reloadRequested, false, 'explicit rejection/completion releases request');
  state._ammo.rifle.mag = 4;
  state.startReload(11000);
  state.deathReset();
  state.reconcileServer({ weapon: 0, reloading: true, reloadAck: state.reloadId, alive: false }, 11001);
  assert.equal(state.reloadRequested, false, 'death cannot resurrect an acknowledged reload');
  state.dispose();
}

// Whole-frame catchup has the same ammunition result as small server ticks.
for (const reserve of [1, 3, 42]) {
  const make = () => {
    const p = new PlayerEntity('catchup', 'Test', { x: 4, y: 2, z: 4 }, false);
    p.weapon = WEAPON_IDS.indexOf('shotgun'); p.deployT = 0;
    p.mag[p.weapon] = 0; p.reserve[p.weapon] = reserve;
    p.input = { reload: true, reloadId: 1 };
    resolveWeaponIntent(p, 0.02, context);
    return p;
  };
  const large = make(), small = make();
  updateTimers(large, 10);
  for (let i = 0; i < 500; i++) updateTimers(small, 0.02);
  assert.deepEqual(large.mag, small.mag);
  assert.deepEqual(large.reserve, small.reserve);
  assert.equal(large.reloading, false);
}

{
  const { state } = client();
  const slot = WEAPON_IDS.indexOf('shotgun');
  state.forceWeapon(slot, { now: -10000 });
  state._ammo.shotgun = { mag: 0, reserve: 3 };
  state.startReload(0);
  const mag = WEAPON_IDS.map(id => state.ammoOf(id).mag);
  const reserve = WEAPON_IDS.map(id => state.ammoOf(id).reserve);
  state.tickReload(800);
  assert.equal(state.ammoOf('shotgun').mag, 1);
  state.reconcileServer({ weapon: slot, reloading: false, reloadAck: 0, mag, reserve }, 900);
  state.tickReload(1200);
  assert.deepEqual(state.ammoOf('shotgun'), { mag: 2, reserve: 1 }, 'stale ammo cannot erase an insertion from the isolated simulation');
  state.dispose();
}
console.log('Reload protocol: every firearm, delayed acceptance beyond animation, stale snapshots, terminal acknowledgment, death and coarse-tick parity passed.');

{
  const { state, calls } = client();
  state._ammo.rifle.mag = 0;
  state.startReload(0);
  state.cancelReload();
  state.reconcileServer({ weapon: 0, reloading: true, reloadAck: state.reloadId }, 100);
  assert.equal(state.isReloading, false, 'in-flight acknowledgment cannot resurrect cancelled presentation');
  assert.equal(calls.length, 1);
  state.dispose();
}

{
  const { state } = client();
  state.forceWeapon(1, { now: 0 });
  state._ammo.smg.mag = 4;
  state.applyIntents({ reload: true }, 10, { alive: true, allowFire: true });
  state.tickReload(2000);
  assert.equal(state.isReloading, true, 'manual reload during draw starts when deployment completes');
  state.dispose();
}
