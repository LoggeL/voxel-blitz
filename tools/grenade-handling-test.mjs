import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { PlayerEntity } from '../server/sim/player.js';
import { GameEngine } from '../server/game.js';
import { resolveWeaponIntent } from '../server/sim/combat.js';
import { stepMovement } from '../server/sim/movement.js';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { WEAPON_IDS } from '../shared/combatmath.js';

function fixture(weaponId) {
  let now = 0, release = null, slot = null;
  const wires = [], shots = [], localThrows = [];
  const camera = new THREE.PerspectiveCamera(75, 2, 0.01, 100);
  const rig = new ViewmodelRig(camera);
  const input = new Proxy({
    grenadeHeld: false, wantFireHeld: false, wantAdsHeld: false, keys: {},
    getKeys() { return this.keys; }, consumeDelta: () => ({ dx: 0, dy: 0 }),
    consumeGrenadeThrow: () => { const next = release; release = null; return next; },
    consumeWeaponSlot: () => { const next = slot; slot = null; return next; },
    setGameplayEnabled() {},
  }, { get: (target, key) => target[key] ?? (() => false) });
  const physics = { pos: { x: 4, y: 2, z: 4 }, vel: { x: 0, y: 0, z: 0 }, grounded: true,
    step: () => false, eyeY: () => 3.62, setMapMeta() {} };
  const player = new LocalPlayer({ input, physics, sendHz: 60 });
  player.setGameplayInputEnabled(true);
  const state = new WeaponState({ rig, now: () => now,
    audio: { draw() {}, fire() {}, reloadClick() {}, weaponCharge() {} },
    effects: { shoot: event => shots.push(event) },
    feedback: { addExhaustion() {}, addRecoil() {} },
    setTimer: () => 0, clearTimer() {},
    network: { isCurrentGeneration: () => true, isRunning: () => true },
  });
  state.resetToLoadout();
  state.forceWeapon(WEAPON_IDS.indexOf(weaponId), { now });
  rig.setWeapon(weaponId);
  for (let i = 0; i < 240; i++) rig.update(1 / 120, { grounded: true });
  now = 2000;
  const net = new NetClient();
  net.ws = { readyState: 1, send: json => wires.push(JSON.parse(json)) };
  function frame(elapsedMs = 1000 / 60) {
    now += elapsedMs;
    const dt = 1 / 60;
    player.update(dt, now, {
      weapon: state, movementAllowed: true, fireAllowed: true,
      weaponHandlingAllowed: () => !(input.grenadeHeld || rig.grenadeActive),
      onWeaponIntents: intents => state.applyIntents(intents, now, { allowFire: true, alive: true }),
      beforeSend: () => state.tryFire(now, { allowFire: true, alive: true,
        grenadeHandling: player.grenadeHandling }),
      sendInput: payload => net.sendInput(payload),
      getNetworkWeaponState: () => ({ slot: state.slot, reloading: state.isReloading }),
    });
    state.settleFrame(dt);
    rig.grenadeCharge(0.5, 0, null, input.grenadeHeld);
    const thrown = player.consumeLocalGrenadeThrow();
    if (thrown) { localThrows.push(thrown); rig.grenadeThrow(thrown.charge, thrown.type); }
    player.updateCamera(dt, camera, state.def, state.adsT, 75);
    rig.update(dt, { grounded: true });
  }
  return { input, player, state, rig, wires, shots, localThrows, frame,
    release: () => { input.grenadeHeld = false; release = { charge: 0.5, cookMs: 0, type: 0 }; },
    select: value => { slot = value; },
    dispose() { state.dispose(); rig.dispose(); player.dispose(); },
  };
}

{
  const run = fixture('lance');
  try {
    run.input.wantFireHeld = true;
    run.frame();
    assert.notEqual(run.state._chargeStart, null, 'fixture has a live capacitor charge');
    run.input.grenadeHeld = true;
    run.frame(400);
    assert.equal(run.state._chargeStart, null, 'taking the grenade cancels the capacitor without release');
    assert.equal(run.state.ammoOf('lance').mag, 1);
    assert.equal(run.shots.length, 0, 'first held frame cannot fire before grenade presentation starts');
    assert.equal(run.wires.at(-1).grenadeHandling, true);
    run.release(); run.frame();
    assert.equal(run.localThrows.length, 1, 'the charge cancellation preserves the real grenade release');
    assert.equal(run.wires.at(-1).throwGrenade, true);
    assert.equal(run.wires.at(-1).wantFire, false);
    for (let i = 0; i < 40; i++) run.frame();
    assert.notEqual(run.state._chargeStart, null, 'a still-held trigger begins a fresh charge after recovery');
    assert.equal(run.shots.length, 0, 'recovery does not replay the interrupted charge');
  } finally { run.dispose(); }
}

{
  const run = fixture('sniper');
  try {
    run.input.wantAdsHeld = true;
    for (let i = 0; i < 30; i++) run.frame();
    assert.ok(run.state.scopeActive && run.player.scopeActive && !run.rig.root.visible);
    run.input.grenadeHeld = true;
    run.frame();
    assert.equal(run.state.scopeActive, false, 'weapon scope exits on the first grenade frame');
    assert.equal(run.player.scopeActive, false, 'camera/body scope exits on that same frame');
    assert.equal(run.rig.root.visible, true, 'the scope can no longer hide grenade hands');
    assert.ok(run.state.adsT > 0.7, 'scope exit retains smooth camera zoom recovery');
    assert.equal(run.wires.at(-1).wantAds, false);
  } finally { run.dispose(); }
}

{
  const run = fixture('rifle');
  try {
    run.input.wantFireHeld = true;
    run.input.keys.reload = true;
    run.select(WEAPON_IDS.indexOf('sniper'));
    run.release(); // A complete G tap arrives before any charging render frame.
    run.frame();
    assert.equal(run.shots.length, 0, 'a queued quick throw blocks a same-frame gunshot');
    assert.equal(run.state.def.id, 'rifle', 'quick throw also blocks weapon selection');
    assert.equal(run.state.isReloading, false);
    assert.equal(run.state.startReload(5000), false, 'timer-driven reload cannot start while hands are occupied');
    assert.equal(run.localThrows.length, 1);
    for (let i = 0; i < 20; i++) run.frame();
    assert.equal(run.shots.length, 0, 'throw and recovery keep the firearm suppressed');
    run.input.keys.reload = false;
    for (let i = 0; i < 40; i++) run.frame();
    assert.ok(run.shots.length > 0, 'the held trigger resumes once the gun is back');
    assert.equal(run.wires.at(-1).grenadeHandling, undefined, 'normal legacy-shaped inputs resume');
  } finally { run.dispose(); }
}

function authority(weaponId) {
  const owner = new PlayerEntity('owner', 'Owner', { x: 4, y: 2, z: 4 });
  owner.weapon = WEAPON_IDS.indexOf(weaponId);
  owner.deployT = 0;
  const events = [];
  const host = { entities: new Map([[owner.id, owner]]) };
  const ctx = { entities: host.entities, now: 0, canFire: () => true, canUseWeapon: () => true,
    canDamage: () => false, solidAt: () => false, getBlock: () => 0,
    pushEvent: event => events.push(event), computeConeDeg: () => 0 };
  return { owner, events, ctx, input: msg => GameEngine.prototype.applyInput.call(host, owner.id, msg) };
}

{
  const run = authority('lance');
  run.input({ wantFire: true });
  resolveWeaponIntent(run.owner, 0.2, run.ctx);
  assert.equal(run.owner.charging, true);
  run.input({ grenadeHandling: true, wantFire: true, wantAds: true, reload: true, weapon: 0 });
  assert.equal(run.owner.input.wantFire, false);
  assert.equal(run.owner.input.wantAds, false);
  assert.equal(run.owner.input.reload, false);
  assert.equal(run.owner.input.switchTo, undefined);
  // Network input can coalesce before the fixed simulation tick.
  run.input({ grenadeHandling: false, wantFire: false, wantAds: true });
  stepMovement(run.owner, 0.05, { ...run.ctx, movementLocked: true, onFall() {} });
  assert.equal(run.owner.ads, false, 'queued grenade handling also suppresses authority ADS');
  resolveWeaponIntent(run.owner, 0.2, run.ctx);
  assert.equal(run.owner.charging, false);
  assert.equal(run.owner.mag[run.owner.weapon], 1);
  assert.equal(run.events.filter(event => event.kind === 'shoot').length, 0,
    'coalesced input cannot turn a grenade interruption into a charged shot');
}

{
  const run = authority('rifle');
  // Legacy callers need no new field: a real throw itself also occupies hands.
  run.input({ wantFire: true, throwGrenade: true, grenadeType: 0 });
  const projectiles = new ProjectileSystem();
  projectiles.step(0, { ...run.ctx, canThrow: () => true });
  resolveWeaponIntent(run.owner, 0.05, run.ctx);
  assert.equal(run.events.filter(event => event.kind === 'projectileLaunch').length, 1);
  assert.equal(run.events.filter(event => event.kind === 'shoot').length, 0,
    'authority accepts the grenade and rejects simultaneous gunfire');
  run.input({ wantFire: true });
  resolveWeaponIntent(run.owner, 0.05, run.ctx);
  assert.equal(run.events.filter(event => event.kind === 'shoot').length, 1,
    'legacy inputs still fire once the interruption ends');
}

console.log('Grenade handling: first-frame charge cancellation, quick taps, throw recovery, reload/selection gates, immediate scope visibility, server coalescing and legacy inputs passed.');
