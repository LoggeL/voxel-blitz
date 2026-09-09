import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { PlayerEntity } from '../server/sim/player.js';
import { GameEngine } from '../server/game.js';
import { evHit } from '../server/protocol/events.js';
import { WEAPONS } from '../shared/combatmath.js';

const close = (actual, expected, message, epsilon = 1e-10) => assert.ok(
  Math.abs(actual - expected) < epsilon, `${message}: ${actual} vs ${expected}`);
const spawn = { x: 4, y: 1, z: 4, index: 0 };
const impact = { attacker: 'attacker', vx: 4, vy: 2, vz: 4 };

function player() {
  const input = new Proxy({
    consumeDelta: () => ({ dx: 0, dy: 0 }), getKeys: () => ({}),
    setGameplayEnabled() {}, wantAdsHeld: true, wantFireHeld: true,
  }, { get: (target, key) => target[key] ?? (() => false) });
  const physics = {
    pos: { x: 4, y: 1, z: 4 }, vel: { x: 0, y: 0, z: 0 },
    grounded: true, _crouching: false, step: () => false,
    eyeY: () => 2.62, setMapMeta() {},
  };
  const stillAim = Object.freeze({ yaw: 0, pitch: 0 });
  return new LocalPlayer({ input, physics, aimSway: {
    readModel: stillAim, reset: () => stillAim, update: () => stillAim,
  } });
}

function sample(event, pain = 0) {
  const local = player();
  local.pain = pain;
  const feedback = local.applyHit({ ...impact, ...event });
  const result = { ...feedback, yaw: local.view.yaw, pitch: local.view.pitch };
  local.dispose();
  return result;
}

for (const event of [{ dmg: 0 }, { dmg: 30, healthDamage: 0 }, { dmg: 80, healthDamage: -4 }]) {
  const hit = sample(event, 1);
  close(hit.yaw, 0, 'Zero health damage cannot turn the aim even while already injured');
  close(hit.pitch, 0, 'A fully absorbed impact has no vertical aim punch');
  assert.equal(hit.healthDamage, 0, 'Health damage is nonnegative');
}

const hits = [1, 5, 10, 20, 40, 55].map((damage) => sample({ dmg: damage, healthDamage: damage }));
for (let i = 1; i < hits.length; i++) {
  assert.ok(hits[i].pitch > hits[i - 1].pitch, 'More health damage causes more punch');
  close(hits[i].pitch / hits[i].healthDamage, hits[0].pitch,
    'Sub-cap damage scales proportionally without a minimum hit impulse');
  close(Math.abs(hits[i].yaw) / hits[i].healthDamage, Math.abs(hits[0].yaw),
    'Horizontal punch uses the same proportional damage scaling');
}
const oldBodyPitch = (damage) => (0.45 + Math.min(1, damage / 55) * 1.5) * 0.052;
assert.ok(hits[2].pitch < oldBodyPitch(10) * 0.45,
  'A small hit is substantially gentler than the previous fixed-baseline punch');
assert.ok(hits.at(-1).pitch < oldBodyPitch(55) * 0.82,
  'The maximum body punch is also reduced by about one fifth');

const calm = sample({ dmg: 20, healthDamage: 20 });
for (const event of [{ dmg: 20, healthDamage: 20 }, { dmg: 70, healthDamage: 20, hs: true }]) {
  const injured = sample(event, 1);
  close(injured.yaw, calm.yaw, 'Existing pain and hit location cannot amplify equal health damage');
  close(injured.pitch, calm.pitch, 'Headshots use their dealt damage without a second multiplier');
}
for (const damage of [55, 100, 1e9]) {
  const capped = sample({ dmg: damage, healthDamage: damage });
  close(capped.pitch, hits.at(-1).pitch, 'Extreme damage cannot exceed the punch cap');
  close(capped.yaw, hits.at(-1).yaw, 'Extreme damage cannot exceed the lateral punch cap');
}

for (const healthDamage of [undefined, null, '0', NaN, Infinity, -Infinity]) {
  const legacy = sample({ dmg: 20, healthDamage });
  close(legacy.pitch, calm.pitch, 'Missing or malformed health metadata falls back to legacy damage');
  assert.equal(legacy.healthDamage, 20);
}
for (const dmg of [undefined, null, -1, NaN, Infinity, -Infinity, 'invalid']) {
  const invalid = sample({ dmg });
  close(invalid.pitch, 0, 'Malformed legacy damage cannot introduce aim punch');
  close(invalid.yaw, 0, 'Malformed legacy damage cannot poison the view');
  assert.ok(Number.isFinite(invalid.healthDamage));
}

// Armor retains a brief impact cue but prevents the stronger injury sting.
const absorbed = sample({ dmg: 20, healthDamage: 0 });
assert.equal(absorbed.damage, 20);
assert.equal(absorbed.severity, calm.severity);
assert.ok(absorbed.painImpulse > 0 && absorbed.painImpulse < calm.painImpulse);

// Exercise the real authoritative damage metadata and the following outgoing
// shot. The crosshair/camera and server must retain the same resulting direction.
for (const armor of [0, 25, 50]) {
  const authority = new PlayerEntity('victim', 'Victim', spawn, false);
  authority.armor = armor;
  authority.takeDamage(40, true);
  const event = JSON.parse(JSON.stringify(evHit('attacker', authority.id, 40, true,
    [4, 2, 4], authority.lastDamage)));
  const local = player();
  local.setGameplayInputEnabled(true);
  const hit = local.applyHit(event);
  assert.equal(hit.healthDamage, 100 - authority.hp,
    'The client receives the exact health lost after server armor absorption');
  const expected = sample({ dmg: 40, healthDamage: Math.max(0, 40 - armor) });
  close(local.view.pitch, expected.pitch, 'The actual event uses post-armor punch');

  const net = new NetClient();
  let wire, predicted;
  net.ws = { readyState: 1, send: (json) => { wire = JSON.parse(json); } };
  local.update(1 / 60, 1000, {
    weapon: { def: WEAPONS.rifle, slot: 0, adsT: 1, isReloading: false },
    fireAllowed: true,
    beforeSend() { predicted = { yaw: local.shotYaw, pitch: local.shotPitch }; },
    sendInput: (payload) => net.sendInput(payload),
  });
  assert.ok(wire.wantFire, 'The next shot is included in the outgoing input');
  close(wire.yaw, predicted.yaw, 'Outgoing yaw equals the punched local shot direction');
  close(wire.pitch, predicted.pitch, 'Outgoing pitch equals the punched local shot direction');
  close(wire.pitch, expected.pitch, 'No separate hidden camera-only punch is applied');
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 400);
  local.updateCamera(1 / 60, camera, WEAPONS.rifle, 1);
  close(camera.rotation.x, wire.pitch, 'The camera presents the next authoritative shot pitch');
  close(camera.rotation.y, wire.yaw, 'The camera presents the next authoritative shot yaw');
  GameEngine.prototype.applyInput.call({ entities: new Map([[authority.id, authority]]) }, authority.id, wire);
  close(authority.input.yaw, wire.yaw, 'Server input retains the punched yaw');
  close(authority.input.pitch, wire.pitch, 'Server input retains the punched pitch');
  local.dispose();
}

const dead = player();
dead._alive = false;
assert.equal(dead.applyHit({ ...impact, dmg: 50, healthDamage: 50 }), null);
assert.deepEqual(dead.view, { yaw: 0, pitch: 0 }, 'A later hit cannot punch an already dead player');
dead.dispose();

console.log('Aim punch: proportional health damage, armor, reduced cap, injury/headshot independence, malformed/legacy events and camera/prediction/server parity passed.');
