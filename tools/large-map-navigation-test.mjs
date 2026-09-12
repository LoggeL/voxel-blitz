import assert from 'node:assert/strict';
import { AIR, METAL, GROUND, createMapState } from '../shared/worlddata.js';
import { createStateApi } from '../shared/world/state.js';
import { boxCollides, solidBelow } from '../shared/player-movement.js';
import { groundNavigation, groundRoute, groundSegmentClear, navigationWaypoint } from '../server/bot-navigation.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { mulberry32 } from '../shared/noise.js';

function flatFixture() {
  const dimensions = { sx: 32, sy: 8, sz: 32 };
  const blocks = new Uint8Array(32 * 8 * 32), heights = new Int16Array(32 * 32);
  blocks.fill(METAL, 0, 32 * 32);
  return createStateApi(blocks, heights, null, 'fixture', { navigationFloor: 0 }, dimensions);
}

const fixture = flatFixture();
const from = { x: 8.5, y: 1.02, z: 10.5 }, to = { x: 12.5, y: 1.02, z: 10.5 };
assert.equal(groundSegmentClear(fixture, from, to), true, 'open-floor positive control');
const graph = groundNavigation(fixture), originalRevision = graph.revision;
fixture.setBlock(10, 5, 10, METAL);
assert.equal(fixture.navigationRevision, originalRevision, 'overhead decorations do not invalidate navigation');
for (let z = 0; z < 32; z++) for (let y = 1; y <= 2; y++) fixture.setBlock(10, y, z, METAL);
assert.equal(groundSegmentClear(fixture, from, to), false, 'body sweep rejects a thin wall between clear endpoints');
assert.deepEqual(groundRoute(fixture, from, to), [], 'disconnected endpoints cannot attach through a wall');
const brain = {};
assert.deepEqual(navigationWaypoint(fixture, from, to, brain, 0), from, 'unreachable routes hold position instead of steering through cover');
for (let z = 9; z <= 12; z++) for (let y = 1; y <= 2; y++) fixture.setBlock(10, y, z, AIR);
assert.equal(groundNavigation(fixture), graph, 'destruction updates the same bounded room graph');
assert.equal(groundSegmentClear(fixture, from, to), true, 'destroyed opening becomes walkable');
assert.ok(groundRoute(fixture, from, to).length > 0, 'new opening invalidates the cached disconnected route');
assert.deepEqual(navigationWaypoint(fixture, from, to, brain, 50), to, 'navigation updates before the two-second route deadline');
for (let z = 9; z <= 12; z++) fixture.setBlock(10, 0, z, AIR);
assert.equal(groundSegmentClear(fixture, from, to), false, 'removed floor is not a traversable edge');
assert.deepEqual(navigationWaypoint(fixture, from, to, brain, 100), from, 'floor destruction invalidates a previously usable cached edge');
fixture.setBlock(9, 1, 10, METAL);
assert.equal(groundSegmentClear(fixture, { x: 7.5, y: 1, z: 9.8 }, { x: 11.5, y: 1, z: 9.8 }), false,
  'a clear center ray cannot cut a corner through the player shoulder');
const beforePaint = fixture.navigationRevision;
fixture.setBlock(9, 1, 10, 2);
assert.equal(fixture.navigationRevision, beforePaint, 'solid-to-solid painting does not rebuild routes');
const beforeManyChanges = graph.revision;
for (let change = 0; change < 300; change++) fixture.setBlock(24, 1, 24, change % 2 ? AIR : METAL);
assert.equal(fixture.navigationChangesSince(beforeManyChanges), null, 'bounded mutation history requests a full rebuild when necessary');
assert.equal(groundNavigation(fixture).revision, fixture.navigationRevision, 'overflow rebuild catches up without retaining unbounded changes');

const steeringWorld = createMapState('harbor');
const steeringGame = new GameEngine({ world: steeringWorld, mode: 'tdm' });
const steeringBots = attachBots(steeringGame, 1);
const steered = steeringGame.entities.get('bot-0');
Object.assign(steered, { x: 18.5, y: GROUND + 1.02, z: 11.5, yaw: 0, pitch: 0 });
const steeringGoal = { x: 18.5, y: GROUND + 1.02, z: 19.5 };
steeringGame.mode.canFire = () => false;
steeringGame.mode.botGoal = () => ({ kind: 'defend', target: steeringGoal, interact: false });
steeringGame.step(50);
assert.equal(steered.input.keys.f, false, 'bot facing away from its route turns in place');
assert.equal(steered.input.keys.sprint, false, 'a wrong-facing bot cannot sprint around its waypoint');
for (let tick = 0; tick < 50; tick++) steeringGame.step(50);
assert.ok(steered.z > 13, 'after facing the waypoint the real movement pipeline advances along the route');
Object.assign(steered, { x: 18.5, y: GROUND + 1.02, z: 11.5, vx: 0, vy: 0, vz: 0 });
for (let y = GROUND + 1; y <= GROUND + 2; y++) {
  for (let x = 16; x <= 20; x++) for (const z of [9, 13]) steeringWorld.setBlock(x, y, z, METAL);
  for (let z = 9; z <= 13; z++) for (const x of [16, 20]) steeringWorld.setBlock(x, y, z, METAL);
}
steeringGame.step(50);
assert.equal(steered.input.keys.f, false, 'unreachable held waypoint has zero distance and does not send forward input');
assert.equal(steered.input.keys.sprint, false);
steeringBots.dispose(); steeringGame.stop();

const samples = {
  harbor: [
    [[44.5, 32.5], [44.5, 44.5]], [[31.5, 38.5], [57.5, 38.5]],
    [[12.5, 40.5], [12.5, 51.5]], [[84.5, 35.5], [84.5, 49.5]],
    [[72.5, 32.5], [72.5, 44.5]], [[62.5, 84.5], [62.5, 99.5]],
    [[35.5, 61.5], [35.5, 81.5]], [[74.5, 65.5], [74.5, 77.5]],
  ],
  canyon: [
    [[60.5, 27.5], [60.5, 54.5]], [[129.5, 27.5], [129.5, 54.5]],
    [[60.5, 89.5], [60.5, 116.5]], [[129.5, 89.5], [129.5, 116.5]],
    [[66.5, 62.5], [66.5, 81.5]], [[125.5, 62.5], [125.5, 81.5]],
    [[82.5, 64.5], [82.5, 77.5]], [[96.5, 64.5], [96.5, 77.5]], [[110.5, 64.5], [110.5, 77.5]],
    [[32.5, 38.5], [32.5, 56.5]], [[12.5, 43.5], [12.5, 55.5]],
  ],
};

const random = Math.random;
try {
  for (const map of ['harbor', 'canyon']) {
    const world = createMapState(map), solid = (x, y, z) => world.getBlock(x, y, z) !== AIR;
    const point = ([x, z]) => ({ x, y: GROUND + 1.02, z });
    const spawns = Object.values(world.meta.spawns.tdm).flat();
    assert.equal(spawns.length, 32);
    for (const team of Object.values(world.meta.spawns.tdm)) assert.equal(team.length, 16);
    for (const spawn of spawns) {
      assert.equal(boxCollides(solid, spawn.x, spawn.y, spawn.z), false);
      assert.equal(solidBelow(solid, spawn.x, spawn.y, spawn.z), true);
      for (const site of world.meta.sites) {
        const target = { x: (site.minX + site.maxX) / 2, y: site.y, z: (site.minZ + site.maxZ) / 2 };
        const route = groundRoute(world, spawn, target);
        assert.ok(route.length > 0, `${map} spawn connects to site ${site.id}`);
        let previous = spawn;
        for (const waypoint of route) {
          assert.equal(groundSegmentClear(world, previous, waypoint), true, `${map} route edge fits the player body and has floor`);
          previous = waypoint;
        }
        assert.deepEqual(route.at(-1), target, 'route reaches the requested site instead of a disconnected nearby cell');
      }
    }
    for (const [a, b] of samples[map]) assert.equal(groundSegmentClear(world, point(a), point(b)), true,
      `${map} authored passage ${a.join(',')} to ${b.join(',')} has continuous body clearance`);

    for (const site of world.meta.sites) {
      Math.random = mulberry32(12345);
      const game = new GameEngine({ world: createMapState(map), mode: 'tdm' });
      const target = { x: (site.minX + site.maxX) / 2, y: site.y, z: (site.minZ + site.maxZ) / 2 };
      game.addClient('human', 'Navigation control');
      const bots = attachBots(game, 31);
      game.mode.canFire = () => false;
      game.mode.botGoal = () => ({ kind: 'defend', target, interact: false });
      const arrived = new Set();
      for (let tick = 0; tick < 1200 && arrived.size < 31; tick++) {
        game.step(50);
        for (const brain of bots.brains) {
          const player = game.entities.get(brain.id);
          if (Math.hypot(player.x - target.x, player.z - target.z) <= 4.2) arrived.add(brain.id);
        }
      }
      assert.equal(arrived.size, 31, `${map} site ${site.id}: every bot reaches the objective with actual turning, collision and movement (${arrived.size}/31)`);
      bots.dispose(); game.stop();
    }
    const matchMetrics = [];
    for (const seed of [12345, 67890]) {
      Math.random = mulberry32(seed);
      let shots = 0, kills = 0;
      const game = new GameEngine({ world: createMapState(map), mode: 'tdm', broadcast(frame) {
        for (const event of frame.events) {
          if (event.kind === 'shoot') shots++;
          if (event.kind === 'kill') kills++;
        }
      } });
      game.now = 1000;
      game.addClient('human', 'Match control');
      const bots = attachBots(game, 31), engaged = new Set();
      for (let tick = 0; tick < 1200; tick++) {
        game.step(50);
        for (const brain of bots.brains) if (brain.state === 'fight' && brain.engagedMs >= 1000) engaged.add(brain.id);
      }
      assert.ok(shots >= 100, `${map} seed ${seed}: the 60-second TDM develops sustained fire (${shots})`);
      assert.ok(kills >= 5, `${map} seed ${seed}: the match advances through authoritative kills (${kills})`);
      assert.ok(engaged.size >= 20, `${map} seed ${seed}: most bots find a visible fight (${engaged.size}/31)`);
      matchMetrics.push({ seed, shots, kills, engaged: engaged.size });
      bots.dispose(); game.stop();
    }
    console.log(`${map}: 32 spawn clearances, 64 swept spawn-to-site routes, authored passages and both 31-bot objective arrivals passed.`);
    console.log(`${map}: real 20 Hz TDM, 32 players/31 bots, 60 seconds: ${JSON.stringify(matchMetrics)}`);
  }
} finally { Math.random = random; }
for (const map of ['foundry', 'dust2', 'solstice', 'caldera']) {
  const world = createMapState(map), target = { x: 20, y: 15, z: 20 };
  assert.equal(groundNavigation(world), null);
  assert.equal(navigationWaypoint(world, { x: 10, y: 15, z: 10 }, target, {}, 0), target,
    `${map}: original navigation remains outside the large-map ground graph`);
}
console.log('LARGE MAP NAVIGATION: ALL OK');
