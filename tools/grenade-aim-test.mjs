import assert from 'node:assert/strict';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { GameEngine } from '../server/game.js';
import { PlayerEntity } from '../server/sim/player.js';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { WEAPONS } from '../shared/combatmath.js';
import { grenadeLaunch } from '../shared/grenade-rules.js';
import { fwdFromAngles } from '../public/js/util/look.js';

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-10, `${message}: ${a} vs ${b}`);
const launchKeys = ['x', 'y', 'z', 'vx', 'vy', 'vz'];

function client(sendHz = 60) {
  let release = null;
  let look = { dx: 0, dy: 0 };
  const input = new Proxy({
    consumeDelta: () => { const next = look; look = { dx: 0, dy: 0 }; return next; },
    consumeGrenadeThrow: () => { const next = release; release = null; return next; },
    getKeys: () => ({}), setGameplayEnabled() {}, wantAdsHeld: false, wantFireHeld: true,
  }, { get: (target, key) => target[key] ?? (() => false) });
  const physics = {
    pos: { x: 4, y: 1, z: 4 }, vel: { x: 0, y: 0, z: 0 }, grounded: true,
    _crouching: false, step: () => false, eyeY: () => 2.62, setMapMeta() {},
  };
  const player = new LocalPlayer({ input, physics, sendHz, aimSway: {
    readModel: { yaw: 0, pitch: 0 }, reset: () => ({ yaw: 0, pitch: 0 }),
    update: () => ({ yaw: 0, pitch: 0 }),
  } });
  player.setGameplayInputEnabled(true);
  const net = new NetClient();
  const wires = [];
  net.ws = { readyState: 1, send: json => wires.push(JSON.parse(json)) };
  return {
    player, wires, net,
    release: type => { release = { charge: 0.5, cookMs: 0, type }; },
    look: (dx, dy) => { look = { dx, dy }; },
    frame: (now, beforeSend = () => {}) => player.update(1 / 60, now, {
      weapon: { def: WEAPONS.rifle, slot: 0, adsT: 0, isReloading: false },
      movementAllowed: true, fireAllowed: true, beforeSend,
      sendInput: payload => net.sendInput(payload),
    }),
  };
}

function serverLaunch(wire, laterInput = null) {
  const authority = new PlayerEntity('throw', 'Test', { x: 4, y: 1, z: 4 }, false);
  authority.deployT = 0;
  authority.yaw = wire.yaw; authority.pitch = wire.pitch;
  const host = { entities: new Map([['throw', authority]]) };
  GameEngine.prototype.applyInput.call(host, 'throw', wire);
  if (laterInput) {
    GameEngine.prototype.applyInput.call(host, 'throw', laterInput);
    authority.yaw = authority.input.yaw;
    authority.pitch = authority.input.pitch;
  }
  const system = new ProjectileSystem();
  const events = [];
  system.step(0, { entities: host.entities, now: 0, canThrow: () => true,
    canDamage: () => false, getBlock: () => 0, pushEvent: event => events.push(event) });
  assert.equal(events.filter(event => event.kind === 'projectileLaunch').length, 1);
  assert.equal(authority.grenadeEdgeQueued, false);
  return [...system.active.values()][0];
}

for (const [typeIndex, type] of ['frag', 'limpet', 'pulse'].entries()) {
  const run = client();
  run.release(typeIndex);
  let releaseAim;
  run.frame(0, () => {
    releaseAim = { yaw: run.player.shotYaw, pitch: run.player.shotPitch };
    run.player.addRecoil(0.05, 0.01, 3.4, WEAPONS.rifle.recoil, 0);
  });
  const thrown = run.player.consumeLocalGrenadeThrow();
  const wire = run.wires.at(-1);
  assert.deepEqual(thrown.grenadeAim, releaseAim, `${type}: prediction captures pre-shot release aim`);
  assert.deepEqual(wire.grenadeAim, releaseAim, `${type}: wire retains the same release aim`);
  assert.ok(run.player.shotPitch > releaseAim.pitch + 0.03, 'fixture advances recoil after release');
  close(wire.pitch, releaseAim.pitch, 'Separate grenade aim preserves the simultaneous gunshot');
  const predicted = run.player.grenadeLaunchState(thrown.charge, type, thrown.grenadeAim);
  const authoritative = serverLaunch(wire);
  for (const key of launchKeys) close(predicted[key], authoritative[key], `${type}: simultaneous shot/throw ${key}`);
  run.player.dispose();
}

{
  const run = client(20);
  run.release(0);
  run.frame(0);
  assert.equal(run.wires.length, 0, 'release can occur before the next network send');
  const thrown = run.player.consumeLocalGrenadeThrow();
  const predicted = run.player.grenadeLaunchState(thrown.charge, 'frag', thrown.grenadeAim);
  run.look(-0.7, -0.3);
  run.frame(1000 / 60);
  run.frame(2000 / 60, () => run.player.addRecoil(0.05, 0.01, 3.4, WEAPONS.rifle.recoil, 2000 / 60));
  const wire = run.wires.at(-1);
  assert.equal(run.wires.length, 1);
  assert.ok(Math.abs(wire.yaw - thrown.grenadeAim.yaw) > 0.1, 'fixture moves gun aim before sending');
  assert.deepEqual(wire.grenadeAim, thrown.grenadeAim, 'later gunshot does not replace pending release aim');
  const authoritative = serverLaunch(wire, { yaw: -1.1, pitch: 0.8, throwGrenade: false });
  for (const key of launchKeys) close(predicted[key], authoritative[key], `delayed send and later server input ${key}`);
  assert.equal(run.player.grenadeThrowLatched, null, 'successful send consumes the throw once');
  assert.equal(run.player.consumeLocalGrenadeThrow(), null, 'prediction emits the throw once');
  run.player.dispose();
}

for (const grenadeAim of [undefined, null, { yaw: 'bad', pitch: 0.5 }, { yaw: 0.5, pitch: Infinity }]) {
  const wire = { yaw: 0.42, pitch: -0.23, throwGrenade: true, grenadeCharge: 0.5, grenadeType: 0, grenadeAim };
  const result = serverLaunch(wire, { yaw: -0.7, pitch: 0.6 });
  const expected = grenadeLaunch({ x: 4, y: 1, z: 4, eyeY: 2.62, vx: 0, vy: 0, vz: 0,
    dir: fwdFromAngles(wire.yaw, wire.pitch), charge: 0.5, type: 'frag' });
  for (const key of launchKeys) close(result[key], expected[key], `legacy or invalid aim falls back to release input ${key}`);
}

{
  const run = client();
  run.net.ws.readyState = 0;
  run.release(0);
  run.frame(0);
  const thrown = run.player.consumeLocalGrenadeThrow();
  assert.equal(run.wires.length, 0, 'failed send leaves the release pending');
  run.look(-0.8, 0.2);
  run.net.ws.readyState = 1;
  run.frame(1000 / 60);
  assert.deepEqual(run.wires.at(-1).grenadeAim, thrown.grenadeAim, 'retry preserves captured aim');
  assert.equal(run.player.consumeLocalGrenadeThrow(), null, 'retry cannot replay prediction');
  run.player.dispose();
}

for (const reset of [player => player.setGameplayInputEnabled(false),
  player => player.respawn({ x: 5, y: 1, z: 5 })]) {
  const run = client(20);
  run.release(0);
  run.frame(0);
  reset(run.player);
  assert.equal(run.player.grenadeThrowLatched, null, 'lifecycle change cancels unsent release');
  assert.equal(run.player.consumeLocalGrenadeThrow(), null, 'lifecycle change cancels pending prediction');
  run.player.dispose();
}

{
  const authority = new PlayerEntity('clamp', 'Test', { x: 4, y: 1, z: 4 }, false);
  GameEngine.prototype.applyInput.call({ entities: new Map([['clamp', authority]]) }, 'clamp', {
    throwGrenade: true, yaw: 0, pitch: 0, grenadeAim: { yaw: Math.PI * 4 + 0.4, pitch: 5 },
  });
  close(authority.grenadeAimQueued.yaw, 0.4, 'authority wraps captured yaw');
  close(authority.grenadeAimQueued.pitch, 89 * Math.PI / 180, 'authority clamps captured pitch');
}

console.log('Grenade aim: simultaneous firing, all grenade types, delayed/failed sends, later server input, lifecycle cancellation, legacy fallback and sanitization passed.');
