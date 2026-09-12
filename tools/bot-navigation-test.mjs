import assert from 'node:assert/strict';
import { createMapState, GROUND, AIR, METAL } from '../shared/worlddata.js';
import { createStateApi } from '../shared/world/state.js';
import { boxCollides, solidBelow } from '../shared/player-movement.js';
import { mulberry32 } from '../shared/noise.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { groundRoute, groundSegmentClear, navigationWaypoint } from '../server/bot-navigation.js';
import { canHopObstacle } from '../server/bot-locomotion.js';

const point = ([x, z]) => ({ x, y: GROUND + 1.02, z });
const random = Math.random;
Math.random = mulberry32(12345);
try {
  // Real Depot container approaches that previously produced 32/33/44 hops
  // in 30 seconds without arriving. Exercise input, turning and server physics.
  for (const [a, b] of [
    [[26.5, 24.5], [40.5, 16.5]],
    [[28.5, 16.5], [40.5, 24.5]],
    [[25.5, 20.5], [48.5, 20.5]],
  ]) {
    const world = createMapState('depot'), game = new GameEngine({ world, mode: 'tdm' });
    game.now = 1000;
    const bots = attachBots(game, 1), p = game.entities.get('bot-0'), target = point(b);
    try {
      Object.assign(p, point(a), { yaw: Math.atan2(a[0] - b[0], a[1] - b[1]) });
      assert.equal(boxCollides((x, y, z) => world.getBlock(x, y, z) !== AIR, p.x, p.y, p.z), false);
      assert.equal(groundSegmentClear(world, p, target), false, 'container blocks the direct path');
      game.mode.canFire = () => false;
      game.mode.botGoal = () => ({ kind: 'recoverBomb', target, interact: false });
      let arrived = false, jumps = 0;
      for (let tick = 0; tick < 400; tick++) {
        game.step(50);
        if (p.input.keys.jump) jumps++;
        if (Math.hypot(p.x - target.x, p.z - target.z) <= 0.9) { arrived = true; break; }
      }
      assert.ok(arrived, `Depot ${a} -> ${b}: bot walks around the container within 20 seconds`);
      assert.equal(jumps, 0, 'ground navigation does not jump against container walls');
    } finally { bots.dispose(); game.stop(); }
  }

  const depot = createMapState('depot'), solid = (x, y, z) => depot.getBlock(x, y, z) !== AIR;
  const spawns = [...depot.meta.spawns.fun, ...Object.values(depot.meta.spawns.tdm).flat()];
  for (const spawn of spawns) {
    assert.equal(spawn.y, GROUND + 1.02, 'Depot spawns use the courtyard, including underneath loading-bay roofs');
    assert.equal(boxCollides(solid, spawn.x, spawn.y, spawn.z), false);
    assert.equal(solidBelow(solid, spawn.x, spawn.y, spawn.z), true);
    for (const target of spawns) {
      const route = groundRoute(depot, spawn, target);
      assert.ok(route.length, 'every authored Depot spawn connects to every other spawn');
      let previous = spawn;
      for (const waypoint of route) {
        assert.ok(groundSegmentClear(depot, previous, waypoint), 'each route fits the full player body');
        previous = waypoint;
      }
    }
  }

  for (const destination of [[30.5, 41.5], [13.5, 33.5], [114.5, 77.5], [70.5, 48.5]]) {
    const game = new GameEngine({ world: createMapState('depot'), mode: 'tdm' });
    game.now = 1000;
    game.addClient('human', 'Navigation control');
    const bots = attachBots(game, 7), target = point(destination), arrived = new Set();
    try {
      game.mode.canFire = () => false;
      game.mode.botGoal = () => ({ kind: 'recoverBomb', target, interact: false });
      for (let tick = 0; tick < 1200 && arrived.size < 7; tick++) {
        game.step(50);
        for (const br of bots.brains) {
          const p = game.entities.get(br.id);
          if (Math.hypot(p.x - target.x, p.z - target.z) <= 0.9) arrived.add(br.id);
          assert.equal(p.input.keys.jump, false);
        }
      }
      assert.equal(arrived.size, 7, `Depot ${destination}: all seven bots reach the destination (${arrived.size}/7)`);
    } finally { bots.dispose(); game.stop(); }
  }

  for (const mode of ['fun', 'tdm']) for (const seed of [12345, 67890]) {
    Math.random = mulberry32(seed);
    let shots = 0, kills = 0;
    const game = new GameEngine({ world: createMapState('depot'), mode, broadcast(frame) {
      for (const event of frame.events) {
        if (event.kind === 'shoot') shots++;
        if (event.kind === 'kill') kills++;
      }
    } });
    game.now = 1000;
    game.addClient('human', 'Match control');
    const bots = attachBots(game, 7), stalled = new Map();
    try {
      for (let tick = 0; tick < 1200; tick++) {
        const previous = new Map(bots.brains.map(br => {
          const p = game.entities.get(br.id);
          return [br.id, { x: p.x, z: p.z, lives: p.lives }];
        }));
        game.step(50);
        for (const br of bots.brains) {
          const p = game.entities.get(br.id), before = previous.get(br.id);
          const blocked = br.intendsMove && p.state === 'alive' && p.lives === before.lives
            && Math.hypot(p.x - before.x, p.z - before.z) < 0.005;
          stalled.set(br.id, blocked ? (stalled.get(br.id) || 0) + 1 : 0);
          assert.ok(stalled.get(br.id) < 40, `${mode}/${seed}/${br.id}: no two-second wall stall during combat`);
          assert.equal(p.input.keys.jump, false, 'combat cannot reintroduce ground-route jump loops');
        }
      }
      assert.ok(shots >= 50 && kills >= 3, `${mode}/${seed}: bots reach fights and advance the live match (${shots} shots, ${kills} kills)`);
    } finally { bots.dispose(); game.stop(); }
  }

  // Artificial vertical motion isolates the watchdog from navigation fixes.
  const game = new GameEngine({ world: createMapState('depot'), mode: 'tdm' });
  const bots = attachBots(game, 1), br = bots.brains[0], p = game.entities.get(br.id);
  try {
    br.intendsMove = true;
    for (let tick = 0; tick <= 24; tick++) {
      p.y = GROUND + 1 + (tick % 2 ? 1.2 : 0);
      bots.watchStuck(br, p, 1000 + tick * 50);
    }
    assert.ok(br.detourUntil > 2200, 'jumping in place triggers a replan within the stuck window');
    assert.ok(br.jumpCdUntil > 2200, 'a failed hop is cooled down, not immediately retried');
    br.stuckSince = 0; br.detourUntil = 0; br.watchX = p.x; br.watchZ = p.z;
    for (let tick = 0; tick < 30; tick++) {
      p.x += 0.1;
      bots.watchStuck(br, p, 3000 + tick * 50);
    }
    assert.equal(br.detourUntil, 0, 'walking progress does not trigger a detour');
    br.intendsMove = false;
    bots.watchStuck(br, p, 6000);
    assert.equal(br.stuckSince, 0, 'holding position is not a stuck bot');
  } finally { bots.dispose(); game.stop(); }

  // A changed doorway/floor must invalidate a route on Depot itself.
  const from = point([8.5, 48.5]), target = point([12.5, 48.5]), brain = {};
  assert.deepEqual(navigationWaypoint(depot, from, target, brain, 0), target);
  const revision = depot.navigationRevision;
  for (let y = GROUND + 1; y <= GROUND + 2; y++) depot.setBlock(10, y, 48, METAL);
  const detour = navigationWaypoint(depot, from, target, brain, 50);
  assert.ok(depot.navigationRevision > revision);
  assert.notDeepEqual(detour, target, 'new cover reroutes before the cache deadline');
  assert.ok(groundSegmentClear(depot, from, detour));
  for (let y = GROUND + 1; y <= GROUND + 2; y++) depot.setBlock(10, y, 48, AIR);
  assert.deepEqual(navigationWaypoint(depot, from, target, brain, 100), target);
  depot.setBlock(10, GROUND, 48, AIR);
  assert.equal(groundSegmentClear(depot, from, target), false, 'destroyed ground cannot become a route across a hole');

  // Positive controls use the real bot/physics pipeline with legacy navigation.
  // One-block jumps and two-block vaults must still traverse reachable cover.
  for (const height of [1, 2]) {
    const world = createMapState('depot');
    world.meta = { ...world.meta, navigationFloor: undefined };
    for (let y = GROUND + 1; y <= GROUND + height; y++) world.setBlock(10, y, 48, METAL);
    const game = new GameEngine({ world, mode: 'tdm' });
    game.now = 1000;
    const bots = attachBots(game, 1), p = game.entities.get('bot-0'), target = point([14.5, 48.5]);
    try {
      Object.assign(p, point([8.5, 48.5]), { yaw: -Math.PI / 2 });
      game.mode.canFire = () => false;
      game.mode.botGoal = () => ({ kind: 'recoverBomb', target, interact: false });
      let jumps = 0, arrived = false;
      for (let tick = 0; tick < 60; tick++) {
        game.step(50);
        jumps += Number(p.input.keys.jump);
        if (Math.hypot(p.x - target.x, p.z - target.z) < 0.9) { arrived = true; break; }
      }
      assert.ok(arrived, `${height}-block obstacle: actual movement crosses reachable cover`);
      assert.equal(jumps, 1, 'one successful jump or vault is enough');
    } finally { bots.dispose(); game.stop(); }
  }
} finally { Math.random = random; }

function fixture(height, ceiling = false) {
  const dimensions = { sx: 32, sy: 24, sz: 32 };
  const world = createStateApi(new Uint8Array(32 * 24 * 32), new Int16Array(32 * 32), null, 'fixture', null, dimensions);
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) world.setBlock(x, GROUND, z, METAL);
  for (let y = GROUND + 1; y <= GROUND + height; y++) world.setBlock(10, y, 10, METAL);
  if (ceiling) for (let x = 8; x <= 11; x++) world.setBlock(x, GROUND + 3, 10, METAL);
  return (x, y, z) => world.getBlock(x, y, z) !== AIR;
}
const walker = point([9.5, 10.5]), forward = { yaw: -Math.PI / 2, keys: { f: true } };
assert.equal(canHopObstacle(fixture(0), walker, forward), false, 'open ground needs no jump');
assert.equal(canHopObstacle(fixture(1), walker, forward), true, 'a supported one-block obstacle remains jumpable');
assert.equal(canHopObstacle(fixture(2), walker, forward), true, 'a reachable two-block ledge uses the shared vault check');
assert.equal(canHopObstacle(fixture(4), walker, forward), false, 'tall walls do not trigger futile jumps');
assert.equal(canHopObstacle(fixture(1, true), walker, forward), false, 'low ceilings block a jump');
assert.equal(canHopObstacle(fixture(1), walker, { ...forward, keys: {} }), false, 'turning in place cannot trigger a hop');
assert.equal(canHopObstacle(fixture(1), walker, { yaw: 0, keys: { r: true } }), true, 'sideways movement probes the actual strafe direction');
assert.equal(canHopObstacle(fixture(4), walker, { yaw: 0, keys: { r: true } }), false);
console.log('BOT NAVIGATION: Depot container repros, 576 spawn routes, 28 live arrivals, four 60-second matches, terrain invalidation, horizontal stuck recovery and jump clearance passed.');
