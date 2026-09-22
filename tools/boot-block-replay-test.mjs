import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NetClient } from '../public/js/engine/netclient.js';
import { applySnapshotBlocks } from '../public/js/combat/feedback.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import {
  AIR, STONE, createMapState, deserializeWorld, getBlock, getMapDimensions, getMapMeta, setBlock,
} from '../shared/worlddata.js';

// Use the exact Game tick/boot methods without starting its browser constructor.
const mainSource = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
const classStart = mainSource.indexOf('class Game {');
const classEnd = mainSource.indexOf('\nconst debugParams =', classStart);
assert(classStart >= 0 && classEnd > classStart, 'composition root class can be isolated from browser startup');

let decoded = false;
const Game = new Function('applySnapshotBlocks', 'deserializeWorld', 'getBlock', 'getMapMeta',
  `return (${mainSource.slice(classStart, classEnd)});`)(
  applySnapshotBlocks,
  (bytes) => { decoded = true; deserializeWorld(bytes); },
  getBlock,
  getMapMeta,
);
globalThis.requestAnimationFrame ??= (callback) => setTimeout(callback, 0);

const MAP = 'foundry';
const { sx: SX, sz: SZ } = getMapDimensions(MAP);
const indexOf = (x, y, z) => x + SX * (z + SZ * y);

// Server world as it stands at welcome time; its bytes are the map frame.
const server = createMapState(MAP);
const mapBytes = server.serializeWorld();
const solid = [];
for (let y = 1; solid.length < 90; y++) {
  for (let z = 0; z < SZ && solid.length < 90; z++) {
    for (let x = 0; x < SX && solid.length < 90; x++) {
      if (server.getBlock(x, y, z) !== AIR) solid.push({ x, y, z });
    }
  }
}

// Late join into a busy arena: far more than the 32-tick ring of destruction
// arrives while the runtime loads, so the ring alone cannot restore it.
{
  const net = new NetClient();
  net.welcome = { map: MAP };
  net.isOpen = () => !decoded;
  const game = Object.create(Game.prototype);
  let disconnects = 0;
  let queued = 0;
  Object.assign(game, {
    mapMeta: null,
    _pendingAuthoritativeSnapshots: [],
    _bootBlockDeltas: null,
    session: { phase: 'booting', baseFov: 75, handleDisconnect: () => { disconnects++; } },
    player: { setMapMeta() {}, setBaseFov() {}, respawn() {} },
    hud: { setMapMeta() {} },
    queueAuthoritativeSnapshot() { queued++; },
  });
  game._world = Object.freeze({
    get meta() { return game.mapMeta; },
    getBlock,
    setBlock,
    applyDeltas() {},
  });
  let releaseRuntime;
  game.ensureRuntime = () => new Promise((resolve) => { releaseRuntime = resolve; });
  net.on('tick', (snapshot) => game.handleTick(snapshot, 'booting'));

  const boot = game.bootLive({
    net, welcome: { map: MAP, spawn: { x: 0, y: 0, z: 0 } }, mapBytes, mapMeta: getMapMeta(MAP),
    isActive: () => true, showStatus() {}, showProgress() {}, complete() {},
  });
  let tick = 0;
  const send = (deltas) => net._onTick(JSON.parse(JSON.stringify(
    makeSnapshot([], deltas, [], 1000 + tick++ * 16))));
  for (const { x, y, z } of solid) {
    server.setBlock(x, y, z, AIR);
    send([{ i: indexOf(x, y, z), v: AIR }]);
  }
  // A block rebuilt later must end rebuilt: buffered deltas replay in order.
  const rebuilt = solid[0];
  server.setBlock(rebuilt.x, rebuilt.y, rebuilt.z, STONE);
  send([{ i: indexOf(rebuilt.x, rebuilt.y, rebuilt.z), v: STONE }]);
  for (let i = 0; i < 40; i++) send([]);
  assert.equal(net.latestSnapshots.length, 32, 'the net ring keeps only the newest ticks');

  releaseRuntime(game);
  await boot;
  assert(decoded, 'bootLive decoded the welcome map bytes');
  assert.equal(disconnects, 1, 'fixture stops the boot right after the terrain replay');
  assert.equal(game._bootBlockDeltas, null, 'the boot buffer is released after replay');
  assert.equal(queued, 131 + net.latestSnapshots.length, 'booting ticks and the ring are still queued for authority');
  for (const { x, y, z } of solid) {
    assert.equal(getBlock(x, y, z), server.getBlock(x, y, z), `block ${x},${y},${z} matches the server`);
  }
  assert.equal(getBlock(rebuilt.x, rebuilt.y, rebuilt.z), STONE);

  // Once decoded, deltas apply straight into the world again.
  const next = solid[1];
  game.handleTick({ blocks: [{ i: indexOf(next.x, next.y, next.z), v: STONE }] }, 'live');
  assert.equal(getBlock(next.x, next.y, next.z), STONE, 'live deltas are not buffered');
  net.close();
}

console.log('boot block replay test passed');
