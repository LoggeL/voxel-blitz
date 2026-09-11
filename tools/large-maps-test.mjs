import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as THREE from '../public/js/vendor/three.module.js';
import { AIR, WOOD, GROUND, createMapState, deserializeWorld, getBlock, generateWorld } from '../shared/worlddata.js';
import { LARGE_DIMENSIONS } from '../shared/world/dimensions.js';
import { boxCollides, solidBelow } from '../shared/player-movement.js';
import { groundRoute, groundNavigation } from '../server/bot-navigation.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { makeWelcome } from '../server/protocol/welcome.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { applySnapshotBlocks } from '../public/js/combat/feedback.js';
import { ChunkStore } from '../public/js/engine/chunks.js';

const expectedLegacy = createMapState('foundry').serializeWorld();
for (const id of ['harbor', 'canyon']) {
  const world = createMapState(id);
  const { sx, sy, sz } = world.dimensions;
  assert.deepEqual(world.dimensions, LARGE_DIMENSIONS);
  assert.equal(sx * sz / (128 * 96), 2.25);
  const bytes = world.serializeWorld();
  assert.equal(bytes.length, 6 + sx * sy * sz);
  assert.deepEqual([...bytes.slice(0, 6)], [86, 66, 1, 192, 144, 40]);
  assert.deepEqual(createMapState(id, bytes).serializeWorld(), bytes);
  assert.throws(() => createMapState('foundry', bytes), /dim mismatch/);
  assert.throws(() => createMapState(id, expectedLegacy), /dim mismatch/);
  deserializeWorld(bytes);
  assert.equal(getBlock(172, GROUND, 132), world.getBlock(172, GROUND, 132), 'client singleton includes expanded area');
  assert.equal(getBlock(172, GROUND + 1, 132), AIR);
  const solid = (x, y, z) => world.getBlock(x, y, z) !== AIR;
  const pools = [world.meta.spawns.tdm.alpha, world.meta.spawns.tdm.bravo];
  for (const pool of pools) {
    assert.equal(pool.length, 16);
    assert.equal(new Set(pool.map(p => `${p.x},${p.y},${p.z}`)).size, 16);
    for (const spawn of pool) {
      assert.equal(boxCollides(solid, spawn.x, spawn.y, spawn.z), false);
      assert.equal(solidBelow(solid, spawn.x, spawn.y, spawn.z), true);
      for (const other of pool) if (other !== spawn) assert.ok(Math.hypot(spawn.x - other.x, spawn.z - other.z) >= 4);
      for (const site of world.meta.sites) {
        const target = { x: (site.minX + site.maxX) / 2, y: site.y, z: (site.minZ + site.maxZ) / 2 };
        const path = groundRoute(world, spawn, target);
        assert.ok(path.length > 0, `${id}: every spawn reaches both objective sites`);
        for (const waypoint of path) assert.equal(boxCollides(solid, waypoint.x, waypoint.y, waypoint.z), false);
        const last = path.at(-1);
        assert.ok(last.x >= site.minX && last.x <= site.maxX && last.z >= site.minZ && last.z <= site.maxZ);
      }
    }
  }
  const graph = groundNavigation(world);
  assert.ok(graph.walk.length <= 7000, 'navigation memory is bounded');

  // Exercise mutations, late joins, incremental client state, and restoration
  // outside BOTH legacy coordinate limits, where a fixed-stride bug hides.
  const point = { x: 172, y: GROUND + 1, z: 132 };
  let lastSnapshot;
  const engine = new GameEngine({ world, mode: 'tdm', broadcast: frame => { lastSnapshot = frame; } });
  const clientWorld = createMapState(id);
  world.setBlock(point.x, point.y, point.z, WOOD);
  engine.pushBlockDelta(point.x, point.y, point.z, WOOD);
  engine.pushBlockDamage(point.x, point.y, point.z, WOOD, 0.5);
  const index = (point.y * sz + point.z) * sx + point.x;
  assert.equal(engine.tickBlocks[0].i, index);
  applySnapshotBlocks({ blocks: engine.tickBlocks }, clientWorld);
  assert.equal(clientWorld.getBlock(point.x, point.y, point.z), WOOD);
  const welcome = makeWelcome({ map: id, gameMode: 'tdm', mapBytes: bytes.length,
    blockDamage: [...engine.blockDamage.values()] });
  const net = new NetClient();
  net._onText(JSON.stringify(welcome));
  assert.equal(net.getBlockDamage(point.x, point.y, point.z), 0.5);
  engine.step(50);
  assert.equal(lastSnapshot.blockDamage[0].x, point.x);
  net._onTick(lastSnapshot);
  assert.equal(net.getBlockDamage(point.x, point.y, point.z), 0.5);
  net._onTick({ now: engine.now + 50, blocks: [{ i: index, v: AIR }] });
  assert.equal(net.getBlockDamage(point.x, point.y, point.z), 0);
  engine.restoreWorld();
  assert.equal(world.getBlock(point.x, point.y, point.z), AIR);

  // Blast and fire must operate beyond the former 128x96 world envelope.
  world.setBlock(point.x, point.y, point.z, WOOD);
  engine.projectiles._destroyTerrain([172.5, 16.5, 132.5],
    { terrainRadius: 3, terrainPower: 1000, maxDestroyedBlocks: 10 }, engine.contexts.projectiles);
  assert.equal(world.getBlock(point.x, point.y, point.z), AIR);
  const field = engine.projectiles.fire.ignite({ id: 'large-fire', ownerId: 'test',
    x: 172.5, y: 15.04, z: 132.5 }, engine.contexts.projectiles);
  assert.ok(field, 'molotov can ignite outside old bounds');

  const atlas = { texture: () => null, faceTile: () => 0, tileRect: () => [0, 0, 1, 1] };
  const chunks = new ChunkStore(new THREE.Scene(), atlas, world.getBlock, () => 0, world.dimensions);
  chunks.rebuildChunk(11, 8);
  assert.ok(chunks.chunks.has('11,8'), 'outermost chunk is rendered');
  chunks.applyBlockDelta(191, GROUND, 143, AIR);
  assert.equal(chunks.stats.queued, 1, 'far edge mutation queues its chunk');
  chunks.update(); chunks.dispose();

  const live = new GameEngine({ world: createMapState(id), mode: 'tdm' });
  live.addClient('human', 'Human');
  const bots = attachBots(live, 31);
  assert.equal(live.entities.size, 32);
  const initial = new Map([...live.entities].map(([key, p]) => [key, [p.x, p.z]]));
  const begin = performance.now();
  for (let tick = 0; tick < 120; tick++) live.step(50);
  const elapsed = performance.now() - begin;
  const moved = [...live.entities].filter(([key, p]) => key !== 'human'
    && Math.hypot(p.x - initial.get(key)[0], p.z - initial.get(key)[1]) > 3).length;
  assert.ok(moved >= 24, `${id}: most bots leave their spawn using actual movement (${moved}/31)`);
  for (const p of live.entities.values()) assert.ok([p.x, p.y, p.z].every(Number.isFinite));
  bots.dispose(); live.stop(); engine.stop();
  console.log(`${id}: 64 spawn-to-site routes, far-edge network/destruction/fire/mesh and 32-player simulation passed (${elapsed.toFixed(0)}ms / 120 ticks).`);
}
generateWorld();
assert.deepEqual(createMapState('foundry').serializeWorld(), expectedLegacy, 'legacy geometry is unchanged');
