import assert from 'node:assert/strict';
import { PlayerEntity } from '../server/sim/player.js';
import { updateCondition } from '../server/sim/movement.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { PLAYER_KEYS } from './lib/protocol-contract.mjs';

const spawn = { x: 40, y: 20, z: 40, index: 0 };
const server = new PlayerEntity('self', 'Self', spawn, false);
Object.assign(server, { panic: 1, grounded: true, ads: true, adsT: 1,
  deployT: 0, vx: 0, vz: 0, input: { keys: { sprint: true } } });
const local = new LocalPlayer({ input: { setGameplayEnabled() {}, consumeDelta() { return { x: 0, y: 0 }; }, getKeys() { return {}; } } });
const row = () => makeSnapshot([server], [], [], 1000).players[0];
for (let tick = 0; tick < 60; tick++) updateCondition(server, 0.05);
const exhausted = row();
assert.equal(Object.keys(exhausted).sort().join(','), PLAYER_KEYS);
assert.equal(exhausted.breathReserve, 0);
assert.equal(exhausted.breathExhausted, true);
local.reconcile(exhausted, 1);
assert.equal(local.aimSway.breath.reserve, 0, 'authority replaces an optimistic local reserve');
assert.equal(local.aimSway.breath.update(0.05, { eligible: true, pressed: true }).holdingBreath,
  false, 'reconciliation cannot restart an exhausted steady action');

server.input.keys.sprint = false;
for (let tick = 0; tick < 30; tick++) updateCondition(server, 0.05);
const recovered = row();
assert.ok(recovered.breathReserve >= 0.35);
assert.equal(recovered.breathExhausted, false);
assert.equal(recovered.breathReleasedFor, 1, 'wire release age is bounded after the recovery threshold');
local.reconcile(recovered, 2);
local.reconcile(exhausted, 1);
assert.equal(local.aimSway.breath.reserve, recovered.breathReserve, 'stale snapshots cannot consume recovered reserve');
assert.equal(local.aimSway.breath.update(0.05, { eligible: true, pressed: true }).holdingBreath, true);

server.applySpawn(spawn);
assert.equal(row().breathReserve, 1);
assert.equal(row().breathExhausted, false);
Object.assign(server.breath, { reserve: Infinity, releasedFor: NaN, exhausted: false });
const safe = row();
assert.equal(safe.breathReserve, 1);
assert.equal(safe.breathReleasedFor, 0);
console.log('ok - authoritative breath exhaustion, recovery, stale snapshots, respawn and wire normalization');
