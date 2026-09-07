import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { LobbyManager } from '../server/lobby.js';
import { damageBlock, resolveWeaponIntent } from '../server/sim/combat.js';
import { makeWelcome } from '../server/protocol/welcome.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { WEAPONS } from '../shared/combatmath.js';
import { AIR, PLANK, STONE, SX, SZ, BLOCK_HP, MINING_HITS } from '../shared/world/blocks.js';

const coords = { x: 10, y: 10, z: 10 };
const key = '10,10,10';
const blockIndex = ((coords.y * SZ) + coords.z) * SX + coords.x;
const worldBlocks = new Map([[key, PLANK]]);
const frames = [];
const game = new GameEngine({ broadcast: (snapshot) => frames.push(snapshot) });
game.world = {
  getBlock: (x, y, z) => worldBlocks.get(`${x},${y},${z}`) || AIR,
  setBlock: (x, y, z, value) => worldBlocks.set(`${x},${y},${z}`, value),
};
const ctx = game.contexts.combat;
const net = new NetClient();

// A bullet leaves material-specific HP and one owned damage delta. Reading the
// tick sees the new damage before the existing snapshot listener runs.
damageBlock(10, 10, 10, PLANK, 6, ctx);
assert.equal(game.blockHp.get(key), BLOCK_HP[PLANK] - 6);
assert.ok(Math.abs(game.blockDamage.get(key).progress - 0.2) < 1e-9);
game.step();
assert.equal(frames[0].blockDamage.length, 1);
assert.equal(game.tickBlockDamage.size, 0);
let observedProgress = null;
let liveDamageEffects = 0;
net.on('tick', () => { observedProgress = net.getBlockDamage(10, 10, 10); });
net.on('blockDamage', () => { liveDamageEffects++; });
net._onTick(frames[0]);
assert.ok(Math.abs(observedProgress - 0.2) < 1e-9);
assert.ok(Object.isFrozen(net.blockDamage.get(key)));
assert.equal(liveDamageEffects, 0, 'state reception does not duplicate effect dispatch');
net.interpolate(net.latestSnapshots.at(-1).now + 1, 0);
net.interpolate(net.latestSnapshots.at(-1).now + 2, 0);
assert.equal(liveDamageEffects, 1, 'the accepted hit drains exactly once for effects');
game.step();
assert.equal(frames[1].blockDamage.length, 0, 'unchanged damage is not rebroadcast');
net._onTick(frames[1]);
assert.equal(net.getBlockDamage(10, 10, 10), observedProgress, 'damage persists between ticks');

// Welcome state is owned, seeds a late join immediately, and causes no old hit
// effects. Joining must not require replaying old events.
const welcome = makeWelcome({ id: 'late', blockDamage: Array.from(game.blockDamage.values()) });
const late = new NetClient();
let damageEffects = 0;
late.on('blockDamage', () => { damageEffects++; });
late._onText(JSON.stringify(welcome));
assert.equal(late.getBlockDamage(10, 10, 10), net.getBlockDamage(10, 10, 10));
assert.equal(damageEffects, 0);
welcome.blockDamage[0].progress = 0.99;
assert.notEqual(game.blockDamage.get(key).progress, 0.99);

// Several hits coalesce to the newest damage state, with distinct event ranges
// retained for presentation. Mining and bullet HP keep their independent costs.
damageBlock(10, 10, 10, PLANK, 6, ctx);
damageBlock(10, 10, 10, PLANK, 3, ctx);
assert.equal(game.tickBlockDamage.size, 1);
assert.equal(game.tickBlockDamage.get(key).progress, 0.5);
assert.deepEqual(game.tickEvents.filter(e => e.kind === 'blockDamage')
  .map(e => [e.previousProgress, e.progress].map(value => Math.round(value * 100))),
  [[20, 40], [40, 50]]);
const miner = { id: 'miner', x: 10.5, z: 12.5, eyeY: 10.5, yaw: 0, pitch: 0,
  def: WEAPONS.knife, weapon: 9, cooldown: 0, deployT: 0, input: { wantFire: true },
  shotSeq: 0, state: 'alive', mag: [], reserve: [] };
resolveWeaponIntent(miner, 0.5, ctx);
assert.equal(game.blockMining.get(key), 1);
assert.equal(game.blockHp.get(key), 15, 'mining does not change bullet HP');
assert.equal(game.blockDamage.get(key).progress, 0.5, 'a lower independent damage fraction cannot heal visual damage');

// Destruction and same-type repairs clear all server damage channels. A later
// hit begins at fresh HP; state and geometry can be rebuilt from this delta.
game.pushBlockDelta(10, 10, 10, PLANK);
assert.equal(game.blockHp.has(key), false);
assert.equal(game.blockMining.has(key), false);
assert.equal(game.blockDamage.has(key), false);
game.step();
net._onTick(frames.at(-1));
assert.equal(net.blockDamage.has(key), false);
assert.deepEqual(frames.at(-1).blockDamage, [{ ...coords, v: PLANK, progress: 0 }]);
damageBlock(10, 10, 10, PLANK, 6, ctx);
assert.equal(game.blockHp.get(key), 24);
damageBlock(10, 10, 10, PLANK, 100, ctx);
game.step();
net._onTick(frames.at(-1));
assert.equal(worldBlocks.get(key), AIR);
assert.equal(net.getBlockDamage(10, 10, 10), 0);
assert.equal(game.blockDamage.size, 0);

// A replacement's block delta also clears damage without a separate damage row.
late._onTick(makeSnapshot([], [{ i: blockIndex, v: AIR }], [], game.now));
assert.equal(late.blockDamage.size, 0);
late._applyBlockDamage([{ ...coords, v: STONE, progress: 1 / MINING_HITS[STONE] }]);
late._resetSessionState(false);
assert.equal(late.blockDamage.size, 0, 'a reconnect cannot retain former-room damage');
late._applyBlockDamage([{ ...coords, v: STONE, progress: 0.5 }]);
late.latestLobbyState = { phase: 'waiting' };
late.id = 'late';
late._onText(JSON.stringify({ t: 'lobbyConfig', id: 'late', mapBytes: 1, blockDamage: [] }));
late._onTickData(new Uint8Array([0]));
assert.equal(late.blockDamage.size, 0, 'map replacement clears damage before onMap');
late.close();
net.close();
game.stop();

// Exercise the actual admission and arena replacement paths, including which
// player receives each complete state frame.
const sent = [];
const lobby = new LobbyManager({
  sendJson: (meta, frame) => { sent.push({ id: meta.id, frame }); return true; },
  sendFrame: () => true,
  closeClient: () => {},
});
try {
  const host = { id: 'host' };
  assert.equal(await lobby.create(host, 'Host', 0, 'fun', 'foundry'), true);
  const room = host.room;
  room.engine.world.setBlock(10, 10, 10, PLANK);
  damageBlock(10, 10, 10, PLANK, 6, room.engine.contexts.combat);
  const peer = { id: 'peer' };
  assert.equal(await lobby.join(peer, 'Peer', room.code), true);
  const joined = sent.find(({ id, frame }) => id === 'peer' && frame.t === 'welcome').frame;
  assert.deepEqual(joined.blockDamage, Array.from(room.engine.blockDamage.values()));
  assert.equal(joined.blockDamage.length, 1, 'late admission includes prior partial damage');
  assert.equal(lobby.configure(host, { gameMode: 'fun', map: 'depot', bots: 0 }), true);
  assert.equal(room.engine.blockDamage.size, 0);
  assert.equal(room.engine.blockMining.size, 0);
  assert.equal(room.engine.blockHp.size, 0);
  const replacements = sent.filter(({ frame }) => frame.t === 'lobbyConfig');
  assert.equal(replacements.length, 2);
  assert.ok(replacements.every(({ frame }) => frame.blockDamage.length === 0));
} finally {
  lobby.stop();
}
console.log('Block damage sync: persistent HP, shared mining, late admission, delta ownership, repairs, destruction and arena/session resets passed.');
