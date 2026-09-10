import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { GameEngine } from '../server/game.js';
import { Input } from '../public/js/engine/input.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { MedkitState } from '../public/js/player/medkit-state.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { MEDKIT_SECONDS } from '../shared/medkit.js';
import { PLAYER_KEYS } from './lib/protocol-contract.mjs';

const engine = new GameEngine();
engine.addClient('self', 'Medic');
const p = engine.entities.get('self');
const spawn = { x: p.x, y: p.y, z: p.z, index: p.lastSpawnIndex };
let request = 0;
const step = (count = 1) => { for (let i = 0; i < count; i++) engine.step(50); };
function fresh() {
  p.applySpawn(spawn);
  p.input = null;
  step(30);
  assert.equal(p.grounded, true);
  p.hp = 35;
}
function begin() {
  engine.applyInput(p.id, { medkitId: ++request, weapon: p.weapon });
  step();
  assert.equal(p.medkit.active, true, 'fresh request begins healing while stationary');
}
fresh();
begin();
step(MEDKIT_SECONDS * 20 - 1);
assert.equal(p.hp, 35, 'no healing before the full four seconds');
assert.equal(p.medkit.remaining, 1);
step();
assert.equal(p.hp, 100);
assert.equal(p.pain, 0);
assert.equal(p.medkit.remaining, 0);
p.hp = 40;
engine.applyInput(p.id, { medkitId: ++request });
step(100);
assert.equal(p.hp, 40, 'used kit cannot heal again');

for (const [name, interrupt] of [
  ['movement', () => engine.applyInput(p.id, { keys: { f: true } })],
  ['jump', () => engine.applyInput(p.id, { keys: { jump: true } })],
  ['crouch', () => engine.applyInput(p.id, { keys: { crouch: true } })],
  ['prone', () => engine.applyInput(p.id, { keys: { prone: true } })],
  ['gun shot', () => engine.applyInput(p.id, { wantFire: true })],
  ['ADS', () => engine.applyInput(p.id, { wantAds: true })],
  ['reload', () => engine.applyInput(p.id, { reload: true })],
  ['quick melee', () => engine.applyInput(p.id, { quickMelee: true })],
  ['grenade', () => engine.applyInput(p.id, { grenadeHandling: true })],
  ['switch weapon', () => engine.applyInput(p.id, { weapon: (p.weapon + 1) % 6 })],
  ['interact', () => engine.applyInput(p.id, { keys: { interact: true } })],
  ['menu/cancel', () => engine.applyInput(p.id, { cancelMedkit: true })],
  ['damage', () => p.takeDamage(1)],
  ['armor impact', () => { p.armor = 50; p.takeDamage(1); }],
  ['death', () => engine.killPlayer(p, null, 'world', false)],
]) {
  fresh(); begin(); step(79);
  interrupt(); step();
  assert.equal(p.medkit.active, false, `${name} cancels even on the final tick`);
  assert.equal(p.medkit.remaining, 1, `${name} preserves the kit`);
  assert.ok(p.hp < 100, `${name} does not complete a heal`);
}

fresh(); begin(); step(20);
engine.applyInput(p.id, { keys: { f: true } });
engine.applyInput(p.id, { keys: {} });
step();
assert.equal(p.medkit.active, false, 'movement edges between ticks still cancel');
engine.applyInput(p.id, { medkitId: request }); step();
assert.equal(p.medkit.active, false, 'replaying an acknowledged request never restarts');
begin(); step(10);
engine.mode.policy.phase = 'post'; step();
assert.equal(p.medkit.active, false, 'round end cancels');
engine.mode.policy.phase = 'live';
fresh();
p.hp = 100;
engine.applyInput(p.id, { medkitId: ++request }); step();
assert.equal(p.medkit.active, false);
assert.equal(p.medkit.remaining, 1, 'full health does not waste a kit');
for (const medkitId of [-1, 1.5, Infinity, '123', Number.MAX_SAFE_INTEGER + 1]) {
  engine.applyInput(p.id, { medkitId }); step();
  assert.equal(p.medkit.ack, request, 'malformed requests cannot poison the acknowledgement');
}
const row = makeSnapshot([p], [], [], engine.now).players[0];
assert.equal(Object.keys(row).sort().join(','), PLAYER_KEYS);
assert.deepEqual(row.medkit, { remaining: 1, active: false, progress: 0, ack: request });

// Prediction must keep requests across failed sends and ignore older server state.
const state = new MedkitState();
state.begin(); state.reconcile({ remaining: 1, active: false, progress: 0, ack: 0 });
assert.equal(state.active, true);
state.reconcile({ remaining: 1, active: true, progress: 0.25, ack: 1 });
assert.equal(state.pendingId, 0);
state.cancel(); state.reconcile({ remaining: 1, active: true, progress: 0.3, ack: 1 });
assert.equal(state.active, false, 'old progress cannot resurrect a canceled animation');
state.begin(); state.reconcile({ remaining: 1, active: true, progress: 0, ack: 2 });
assert.equal(state.active, true, 'a fresh request can start after an interruption');

const input = new Input({}); input.fallback = true;
const press = repeat => input._onKeyDown({ code: 'KeyJ', repeat, preventDefault() {} });
press(false); input.getKeys(); assert.equal(input.consumeMedkit(), true);
assert.equal(input.consumeMedkit(), false);
press(true); assert.equal(input.consumeMedkit(), false);
press(false); input.setWeaponWheelOpen(true); input.setWeaponWheelOpen(false);
assert.equal(input.consumeMedkit(), false, 'wheel clears queued healing');
press(false); input.clearTransient(); assert.equal(input.consumeMedkit(), false);

const camera = new THREE.PerspectiveCamera();
const rig = new ViewmodelRig(camera); rig.setWeapon('rifle');
let now = 2000, connected = false;
const wire = [];
const weapon = new WeaponState({ rig, now: () => now,
  audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
  feedback: { addExhaustion() {}, addRecoil() {} },
  network: { isRunning: () => true, isCurrentGeneration: () => true },
  setTimer: () => 0, clearTimer() {},
});
const local = new LocalPlayer({ input, physics: {
  pos: { x: p.x, y: p.y, z: p.z }, vel: { x: 0, y: 0, z: 0 }, grounded: true,
  step: () => false, eyeY: () => 1.62, setMapMeta() {},
} });
local.setGameplayInputEnabled(true); local._hp = 40;
const net = { _seq: 0, _timing: { interpolationDelayMs: 100, rttMs: 0 },
  isOpen: () => connected, ws: { send: value => wire.push(JSON.parse(value)) } };
const frame = () => local.update(1 / 60, now, { weapon, fireAllowed: true, movementAllowed: true,
  onWeaponIntents: intents => weapon.applyIntents(intents, now, { allowFire: true, alive: true }),
  beforeSend: () => weapon.tryFire(now, { allowFire: true, alive: true, grenadeHandling: local.medkit.active }),
  sendInput: payload => NetClient.prototype.sendInput.call(net, payload),
});
press(false); frame();
assert.equal(local.medkit.active, true);
assert.equal(wire.length, 0);
connected = true; now += 20; frame();
assert.equal(wire.at(-1).medkitId, 1, 'pending heal survives failed socket send');
assert.equal(wire.at(-1).wantFire, false);
fresh(); engine.applyInput(p.id, wire.at(-1));
// This engine has already seen larger IDs. New life keeps the replay watermark.
step(); assert.equal(p.medkit.active, false);
const authority = new GameEngine(); authority.addClient('fresh', 'Fresh');
const freshPlayer = authority.entities.get('fresh');
for (let i = 0; i < 30; i++) authority.step(50);
freshPlayer.hp = 40;
authority.applyInput('fresh', wire.at(-1)); authority.step(50);
assert.equal(freshPlayer.medkit.active, true, 'keyboard -> local prediction -> real wire -> server');
for (let i = 0; i < 45; i++) rig.update(1 / 60, { medkitActive: true, medkitProgress: 0.5 });
assert.equal(rig._medkitHands.root.visible, true);
assert.equal(rig.content.visible, false, 'bandaging replaces the gun model');
input._fireTapQueued = true; now += 20; frame();
assert.equal(local.medkit.active, false, 'even a released click cancels healing');
assert.equal(wire.at(-1).cancelMedkit, true);
press(false); now += 1000; frame();
local.setGameplayInputEnabled(false); frame();
assert.equal(local.medkit.active, false);
assert.equal(wire.at(-1).cancelMedkit, true, 'pause cancels the server action');
for (let i = 0; i < 45; i++) rig.update(1 / 60, { medkitActive: false });
assert.equal(rig._medkitHands.root.visible, false);
assert.equal(rig.content.visible, true);
local.dispose(); input.dispose(); weapon.dispose(); rig.dispose();
authority.stop(); engine.stop();
console.log('Medkit passed: timed authority, all interruptions, inventory, replay guards, keyboard/wire/prediction and hands.');
