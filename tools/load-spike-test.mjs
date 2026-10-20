// Load-spike fixes (docs/conquest.md, Server load): every shortcut must give
// exactly the old answer. Each optimised path is checked against a verbatim
// copy of the code it replaced:
//  - spawn pick: bounded sight-line search, cached candidates and the per-
//    revision sight-line memo against the old full scan (synthetic worlds,
//    seeded jitter, moving bodies, terrain edits, NaN bodies);
//  - solidBelow without per-call arrays;
//  - the ground grid's pristine copy and sliced warm-up against a full sweep,
//    groundRoute's reused BFS scratch and closest() memo against the old route;
//  - Frontier's boot cover sets against a cold build, and a Conquest room
//    taking them without sampling;
//  - the boot tick warm-up room: a seeded Conquest room plays the same after
//    it, and it leaves no room ticking;
//  - the ray budget of a room start (TDM Harbor 31 bots, Conquest Frontier 16);
//  - diagnostics: long-tick log and the event-loop / GC window fields.
import assert from 'node:assert/strict';
import { SpawnSelector } from '../server/sim/spawn.js';
import { solidBelow, PHYSICS } from '../shared/player-movement.js';
import { mulberry32 } from '../shared/noise.js';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { STONE } from '../shared/world/blocks.js';
import { groundNavigation, groundNavigationSteps, groundRoute, groundSegmentClear } from '../server/bot-navigation.js';
import { CoverIndex } from '../server/bot-cover.js';
import { prepareFrontier, warmConquestRoom, warmGroundGrids, groundGridMaps, runSliced } from '../server/boot-warmup.js';
import { GameEngine, afterRoomTick } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { ServerDiagnostics, TickTiming } from '../server/diagnostics.js';
import { TICK_PHASES } from '../server/game.js';
import { coalesceTick } from '../server/protocol/tick-backlog.js';

const realRandom = Math.random;

// ---------------------------------------------------------------------------
// 1. Spawn pick: the old full scan, verbatim (server/sim/spawn.js before the fix).
// ---------------------------------------------------------------------------
const spawnPointKey = point => `${point.x},${point.y},${point.z}`;
class ReferenceSelector extends SpawnSelector {
  pick(pool, player = null, excludeIndex = -1, { variety = false } = {}) {
    const { sx: SX, sy: SY, sz: SZ } = this.dimensions;
    let candidates = [];
    for (let i = 0; i < pool.length; i++) {
      const source = pool[i];
      if (!source || ![source.x, source.y, source.z].every(Number.isFinite)) continue;
      const index = Number.isFinite(source.index) ? Math.trunc(source.index) : i;
      if (!this.walkable(source)) continue;
      candidates.push({ x: source.x, y: source.y, z: source.z, index });
    }
    if (!candidates.length) {
      for (let z = 4; z < SZ - 4; z += 8) for (let x = 4; x < SX - 4; x += 8) {
        for (let y = 1; y < SY - 2; y++) {
          const point = { x: x + 0.5, y, z: z + 0.5, index: candidates.length };
          if (!this.walkable(point)) continue;
          candidates.push(point);
          if (!this.hazardous(point)) break;
        }
      }
      if (!candidates.length) throw new Error('World has no walkable spawn surface');
    }
    const dry = candidates.filter((candidate) => !this.hazardous(candidate));
    if (dry.length) candidates = dry;
    const hasPriorPoint = player && [player.lastSpawnX, player.lastSpawnY, player.lastSpawnZ].every(Number.isFinite);
    const isPriorSpawn = (candidate) => hasPriorPoint
      ? candidate.x === player.lastSpawnX && candidate.y === player.lastSpawnY && candidate.z === player.lastSpawnZ
      : candidate.index === excludeIndex;
    const canExcludePrior = candidates.length > 1 && candidates.some((candidate) => !isPriorSpawn(candidate));
    const enemies = [];
    for (const entity of this.entities.values()) {
      if (entity === player || entity.state !== 'alive') continue;
      if (player && !this.isEnemy(player, entity)) continue;
      enemies.push(entity);
    }
    let best = null, bestScore = -Infinity, bestSafety = -Infinity;
    for (const candidate of candidates) {
      if (!variety && canExcludePrior && isPriorSpawn(candidate)) continue;
      let nearest = Math.hypot(SX, SZ);
      let visibleEnemies = 0;
      for (const enemy of enemies) {
        nearest = Math.min(nearest, Math.hypot(candidate.x - enemy.x, candidate.y - enemy.y, candidate.z - enemy.z));
        if (this.enemyHasSpawnLos(enemy, candidate)) visibleEnemies++;
      }
      const usedAt = this.spawnUseTimes.get(spawnPointKey(candidate));
      const age = Number.isFinite(usedAt) ? Math.max(0, this.now - usedAt) : 8000;
      const recentPenalty = age < 8000 ? 24 * (1 - age / 8000) : 0;
      const occupied = [...this.entities.values()].some((entity) => entity !== player
        && entity.state === 'alive' && Math.hypot(candidate.x - entity.x, candidate.y - entity.y, candidate.z - entity.z) < 2.5);
      const safety = occupied ? -1 : !variety ? 0 : nearest >= 12 && visibleEnemies === 0 ? 2 : nearest >= 8 ? 1 : 0;
      const score = nearest - visibleEnemies * 36 - recentPenalty - (variety && isPriorSpawn(candidate) ? 12 : 0) + (variety ? Math.random() * 6 : 0);
      if (safety > bestSafety || (safety === bestSafety && score > bestScore)) { bestSafety = safety; best = candidate; bestScore = score; }
    }
    const chosen = best || candidates[0];
    this.spawnUseTimes.set(spawnPointKey(chosen), this.now);
    if (this.spawnUseTimes.size > 256) {
      let oldestKey = null, oldestAt = Infinity;
      for (const [key, usedAt] of this.spawnUseTimes) if (usedAt < oldestAt) { oldestKey = key; oldestAt = usedAt; }
      if (oldestKey !== null) this.spawnUseTimes.delete(oldestKey);
    }
    return { ...chosen };
  }
}

function syntheticArena(seed) {
  const rng = mulberry32(seed);
  const dims = { sx: 40 + Math.floor(rng() * 40), sy: 14, sz: 40 + Math.floor(rng() * 40) };
  const cells = new Uint8Array(dims.sx * dims.sy * dims.sz);
  const at = (x, y, z) => (y * dims.sz + z) * dims.sx + x;
  const inside = (x, y, z) => x >= 0 && z >= 0 && y >= 0 && x < dims.sx && z < dims.sz && y < dims.sy;
  for (let z = 0; z < dims.sz; z++) for (let x = 0; x < dims.sx; x++) { cells[at(x, 0, z)] = 1; cells[at(x, 1, z)] = 1; }
  // Pillars and walls (solid 1), shallow pools (fluid 2) at floor level.
  for (let k = 0; k < 40; k++) {
    const x = Math.floor(rng() * dims.sx), z = Math.floor(rng() * dims.sz), h = 2 + Math.floor(rng() * 6);
    const long = rng() < 0.4, len = long ? 3 + Math.floor(rng() * 10) : 1, alongX = rng() < 0.5;
    for (let i = 0; i < len; i++) for (let y = 2; y < 2 + h; y++) {
      const px = alongX ? x + i : x, pz = alongX ? z : z + i;
      if (inside(px, y, pz)) cells[at(px, y, pz)] = 1;
    }
  }
  for (let k = 0; k < 6; k++) {
    const x = Math.floor(rng() * dims.sx), z = Math.floor(rng() * dims.sz);
    if (inside(x, 1, z)) cells[at(x, 1, z)] = 2;
  }
  const world = { dims, rev: 0,
    solidAt: (x, y, z) => { x |= 0; y |= 0; z |= 0; if (!inside(x, y, z)) return y < 0; return cells[at(x, y, z)] === 1; },
    fluidAt: (x, y, z) => { x |= 0; y |= 0; z |= 0; return inside(x, y, z) && cells[at(x, y, z)] === 2; },
    toggle(x, y, z) { if (inside(x, y, z)) { cells[at(x, y, z)] = cells[at(x, y, z)] ? 0 : 1; world.rev++; } },
  };
  return { world, rng };
}

let spawnPicks = 0;
for (let seed = 1; seed <= 40; seed++) {
  const { world, rng } = syntheticArena(seed);
  const entities = new Map();
  const ffa = seed % 3 === 0;
  for (let i = 0; i < 6 + Math.floor(rng() * 26); i++) {
    const e = { id: `e${i}`, team: ffa ? null : i % 2 ? 'alpha' : 'bravo', state: rng() < 0.85 ? 'alive' : 'dead',
      x: 1 + rng() * (world.dims.sx - 2), y: 2 + (rng() < 0.15 ? rng() * 4 : 0), z: 1 + rng() * (world.dims.sz - 2) };
    if (rng() < 0.3) e.eyeY = e.y + 1.2;
    entities.set(e.id, e);
  }
  if (seed % 7 === 0) entities.get('e0').x = NaN;    // a broken body: the scan keeps its old order semantics
  const pools = [0, 1, 2].map(() => Array.from({ length: 3 + Math.floor(rng() * 60) },
    (_, index) => ({ x: Math.floor(1 + rng() * (world.dims.sx - 2)) + 0.5, y: 2, z: Math.floor(1 + rng() * (world.dims.sz - 2)) + 0.5,
      ...(rng() < 0.5 ? { index } : {}) })));
  const options = { entities, isEnemy: (a, b) => !a.team || a.team !== b.team, solidAt: world.solidAt, fluidAt: world.fluidAt,
    now: 1000, dimensions: world.dims };
  const reference = new ReferenceSelector(options);
  const fast = new SpawnSelector({ ...options, revision: () => world.rev });
  // A world without mutationCount: no memo may outlive a voxel edit.
  const unversioned = new SpawnSelector({ ...options, revision: () => undefined });
  let now = 1000;
  for (let step = 0; step < 60; step++) {
    if (rng() < 0.6) now += Math.floor(rng() * 3000);
    reference.setNow(now); fast.setNow(now); unversioned.setNow(now);
    if (rng() < 0.1) world.toggle(Math.floor(rng() * world.dims.sx), 2 + Math.floor(rng() * 3), Math.floor(rng() * world.dims.sz));
    const ids = [...entities.keys()];
    const player = rng() < 0.15 ? null : entities.get(ids[Math.floor(rng() * ids.length)]);
    const pool = pools[Math.floor(rng() * pools.length)];
    const variety = rng() < 0.5, exclude = Math.floor(rng() * 4) - 1;
    const draw = 1 + Math.floor(rng() * 1e6);
    Math.random = mulberry32(draw);
    const expected = reference.pick(pool, player, exclude, { variety });
    const afterExpected = Math.random();
    Math.random = mulberry32(draw);
    const actual = fast.pick(pool, player, exclude, { variety });
    const afterActual = Math.random();
    Math.random = mulberry32(draw);
    const plain = unversioned.pick(pool, player, exclude, { variety });
    Math.random = realRandom;
    assert.deepEqual(actual, expected, `seed ${seed} step ${step}: same spawn as the full scan`);
    assert.deepEqual(plain, expected, `seed ${seed} step ${step}: same spawn without a voxel revision`);
    assert.equal(afterActual, afterExpected, `seed ${seed} step ${step}: the jitter draws Math.random as often`);
    spawnPicks++;
    // The picked body moves there (a room start fills the arena pick by pick).
    if (player && rng() < 0.8) Object.assign(player, { x: actual.x, y: actual.y, z: actual.z, state: 'alive',
      lastSpawnX: actual.x, lastSpawnY: actual.y, lastSpawnZ: actual.z });
  }
}
console.log(`spawn pick: ${spawnPicks} picks equal to the full scan (variety, prior spawn, edits, NaN bodies)`);

// ---------------------------------------------------------------------------
// 2. solidBelow: the old corner loop, verbatim.
// ---------------------------------------------------------------------------
{
  const referenceSolidBelow = (solidAt, px, py, pz, halfW = PHYSICS.halfW) => {
    const yy = py - 0.06;
    if (Math.floor(yy) < 0) return true;
    const xs = [px - halfW + 1e-4, px + halfW - 1e-4], zs = [pz - halfW + 1e-4, pz + halfW - 1e-4];
    const cellY = Math.floor(yy);
    for (const cx of xs) for (const cz of zs) if (solidAt(Math.floor(cx), cellY, Math.floor(cz))) return true;
    return false;
  };
  const { world, rng } = syntheticArena(99);
  for (let i = 0; i < 20000; i++) {
    const p = [rng() * world.dims.sx, rng() * 8 - 0.5, rng() * world.dims.sz], halfW = rng() < 0.2 ? rng() : undefined;
    const order = [], probe = (x, y, z) => { order.push(`${x},${y},${z}`); return world.solidAt(x, y, z); };
    const orderRef = [], probeRef = (x, y, z) => { orderRef.push(`${x},${y},${z}`); return world.solidAt(x, y, z); };
    assert.equal(solidBelow(probe, ...p, halfW), referenceSolidBelow(probeRef, ...p, halfW));
    assert.deepEqual(order, orderRef, 'same probes in the same order');
  }
  console.log('solidBelow: 20000 probes equal to the old corner loop');
}

// ---------------------------------------------------------------------------
// 3. Ground grid: pristine copy, sliced warm-up, reused BFS scratch, closest() memo.
// ---------------------------------------------------------------------------
{
  // The old closest() and groundRoute(), verbatim, over the live grid.
  const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const pointAt = (graph, node) => ({ x: (node % graph.width) * graph.cell + 0.5, y: graph.floor + 0.02, z: Math.floor(node / graph.width) * graph.cell + 0.5 });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const referenceClosest = (graph, point, loose = false) => {
    const x = Math.round((point.x - 0.5) / graph.cell), z = Math.round((point.z - 0.5) / graph.cell);
    const candidates = [];
    for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) {
      const nx = x + dx, nz = z + dz, node = nz * graph.width + nx;
      if (nx >= 0 && nx < graph.width && nz >= 0 && nz < graph.depth && graph.walk[node]) candidates.push({ node, distance: distance(point, pointAt(graph, node)) });
    }
    candidates.sort((a, b) => a.distance - b.distance || a.node - b.node);
    const clear = candidates.find(candidate => groundSegmentClear(graph.world, point, pointAt(graph, candidate.node)))?.node;
    return clear ?? (loose ? candidates[0]?.node ?? -1 : -1);
  };
  const referenceRoute = (world, from, to) => {
    const graph = groundNavigation(world);
    if (distance(from, to) <= 48 && groundSegmentClear(world, from, to)) return [{ x: to.x, y: graph.floor + 0.02, z: to.z }];
    const start = referenceClosest(graph, from), end = referenceClosest(graph, to, Array.isArray(world.meta?.climbs));
    if (start < 0 || end < 0) return [];
    const parent = new Int32Array(graph.walk.length).fill(-1), queue = new Int32Array(parent.length);
    let read = 0, write = 1;
    queue[0] = start; parent[start] = start;
    while (read < write && parent[end] < 0) {
      const current = queue[read++];
      DIRECTIONS.forEach(([dx, dz], direction) => {
        if (!(graph.edges[current] & (1 << direction))) return;
        const next = current + dz * graph.width + dx;
        if (parent[next] >= 0) return;
        parent[next] = current; queue[write++] = next;
      });
    }
    if (parent[end] < 0) return [];
    const route = [{ x: to.x, y: graph.floor + 0.02, z: to.z }];
    for (let node = end; ; node = parent[node]) { route.push(pointAt(graph, node)); if (node === start) break; }
    return route.reverse();
  };

  assert.deepEqual(groundGridMaps().sort(), ['ashfall', 'canyon', 'depot', 'harbor', 'waterworld'], 'the flat-floor maps');
  // Sliced warm-up of Depot fills the pristine cache; a later pristine world copies it.
  const timings = await warmGroundGrids(['depot', 'frontier', 'foundry'], { sliceMs: 1 });
  assert.equal(timings.length, 3);
  assert.ok(timings[0].slices > 2 && !timings[0].error, `Depot's grid was swept in slices (${timings[0].slices})`);
  assert.ok(timings.slice(1).every(row => !row.error), 'maps without a flat floor finish at once');
  // The boot log counts built grids: only Depot's (the trailing empty step charges no task).
  assert.deepEqual(timings.map(row => row.built), [true, false, false], 'only flat-floor maps count as built');
  assert.deepEqual(timings.slice(1).map(row => row.slices), [1, 1], 'a map without a flat floor takes one slice');
  const warmed = createMapState('depot');
  let yields = 0; const steps = groundNavigationSteps(warmed);
  while (!steps.next().done) yields++;
  assert.equal(yields, 0, 'a warmed map takes the cached grid without sweeping');
  for (const id of ['depot', 'harbor']) {
    const pristine = groundNavigation(createMapState(id));       // harbor: builds and caches; depot: copies
    const copy = groundNavigation(createMapState(id));
    // A world that differs from its template (one voxel far above the floor) sweeps from scratch.
    const swept = createMapState(id);
    swept.setBlock(1, swept.dimensions.sy - 1, 1, STONE);
    const full = groundNavigation(swept);
    assert.ok(!swept.matchesTemplate());
    assert.deepEqual(copy.walk, full.walk, `${id}: copied walk cells equal a full sweep`);
    assert.deepEqual(copy.edges, full.edges, `${id}: copied edges equal a full sweep`);
    assert.deepEqual(pristine.walk, full.walk);
  }
  // Routes: random endpoints, repeated starts (the roam search), then terrain edits.
  const world = createMapState('harbor');
  const graph = groundNavigation(world), rng = mulberry32(5);
  const meta = getMapMeta('harbor'), floor = meta.navigationFloor + 1;
  const spot = () => ({ x: Math.floor(4 + rng() * (world.dimensions.sx - 8)) + 0.5, y: floor + 0.02, z: Math.floor(4 + rng() * (world.dimensions.sz - 8)) + 0.5 });
  let routes = 0, reached = 0;
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 40; i++) {
      const from = spot();
      for (let k = 0; k < 6; k++) {
        const to = spot();
        const expected = referenceRoute(world, from, to), actual = groundRoute(world, from, to);
        assert.deepEqual(actual, expected, `round ${round}: same route ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
        routes++; if (actual.length) reached++;
      }
    }
    // Wall off and dig floor cells: the memo and the grid follow the voxels.
    for (let k = 0; k < 30; k++) {
      const x = Math.floor(rng() * world.dimensions.sx), z = Math.floor(rng() * world.dimensions.sz);
      world.setBlock(x, floor + (k % 2), z, k % 3 ? STONE : 0);
    }
  }
  assert.ok(reached > routes * 0.3 && reached < routes, `routes both found and refused (${reached}/${routes})`);
  assert.equal(groundNavigation(world), graph, 'one grid per world');
  console.log(`ground grid: pristine copy and slices equal a full sweep; ${routes} routes equal the old search (${reached} reached)`);
}

// ---------------------------------------------------------------------------
// 4. Frontier boot warm-up: cover sets equal a cold build; a room samples none.
// ---------------------------------------------------------------------------
{
  const meta = getMapMeta('frontier');
  const timing = prepareFrontier({ structural: false });
  assert.ok(timing.cover >= 0 && timing.field === null);
  const cold = new CoverIndex({ world: createMapState('frontier'), mapMeta: meta });
  const warm = new CoverIndex({ world: createMapState('frontier'), mapMeta: meta });
  for (const flag of meta.conquest.flags) {
    const steps = cold.buildSteps(flag);
    let next = steps.next();
    while (!next.done) next = steps.next();
    const { buildMs: _cold, ...fresh } = next.value;
    const cached = warm.pristineSet(flag);
    assert.ok(cached, `flag ${flag.id}: the boot warm-up cached its sets`);
    const { buildMs: _warm, ...copy } = cached;
    assert.deepEqual(copy, fresh, `flag ${flag.id}: cached sets equal a cold build`);
  }
  let sampled = 0;
  const buildSteps = CoverIndex.prototype.buildSteps;
  CoverIndex.prototype.buildSteps = function (...a) { sampled++; return buildSteps.apply(this, a); };
  const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta });
  const bots = attachBots(game, 4);
  CoverIndex.prototype.buildSteps = buildSteps;
  assert.equal(sampled, 0, 'the first Conquest room clones the boot sets instead of sampling ~1000 points per flag');
  bots.dispose();
  console.log('Frontier warm-up: cover sets equal a cold build, the first room samples none');
}

// ---------------------------------------------------------------------------
// 4b. Boot tick warm-up: a throwaway room changes no later room's play.
// ---------------------------------------------------------------------------
{
  // Weather off: its seed is drawn from the CSPRNG, not the seeded Math.random.
  const weather = process.env.VB_CONQUEST_WEATHER;
  process.env.VB_CONQUEST_WEATHER = 'off';
  const realNow = Date.now;
  const replay = () => {
    Math.random = mulberry32(5);
    Date.now = () => 1_800_000_000_000;
    const frames = [];
    const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: getMapMeta('frontier'),
      broadcast: (msg) => frames.push(JSON.stringify(msg, (key, value) => ArrayBuffer.isView(value) ? Array.from(value) : value)) });
    const bots = attachBots(game, 15);
    for (let i = 0; i < 300; i++) game.step(game.intervalMs);
    const bodies = [...game.combatants.values()].map(e => [e.id, e.x, e.y, e.z, e.hp, e.state]);
    bots.dispose(); game.stop();
    Date.now = realNow; Math.random = realRandom;
    return { frames, bodies };
  };
  const before = replay();
  const { total, first } = warmConquestRoom('frontier');
  const after = replay();
  if (weather === undefined) delete process.env.VB_CONQUEST_WEATHER; else process.env.VB_CONQUEST_WEATHER = weather;
  assert.equal(after.frames.length, before.frames.length);
  for (let i = 0; i < before.frames.length; i++) assert.equal(after.frames[i], before.frames[i], `snapshot ${i} equal after the warm-up room`);
  assert.deepEqual(after.bodies, before.bodies, 'bodies equal after the warm-up room');
  // It never started its clock: an after-tick task still runs at once.
  let ran = false;
  afterRoomTick(() => { ran = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(ran, 'no room counts as ticking after the warm-up room');
  console.log(`Conquest tick warm-up: ${Math.round(total)} ms (first tick ${first.toFixed(1)} ms), 300 seeded ticks equal before and after it`);
}

// ---------------------------------------------------------------------------
// 5. Ray budget of a room start (engine path, seeded).
// ---------------------------------------------------------------------------
{
  const los = SpawnSelector.prototype.enemyHasSpawnLos;
  let rays = 0;
  SpawnSelector.prototype.enemyHasSpawnLos = function (...a) { rays++; return los.apply(this, a); };
  const budget = (mode, map, count) => {
    Math.random = mulberry32(11);
    const game = new GameEngine({ mode, world: createMapState(map), mapMeta: getMapMeta(map) });
    rays = 0;
    const bots = attachBots(game, count, { personalitySeed: 3 });
    const cast = rays;
    bots.dispose();
    Math.random = realRandom;
    return cast;
  };
  const tdm = budget('tdm', 'harbor', 31), conquest = budget('conquest', 'frontier', 16);
  SpawnSelector.prototype.enemyHasSpawnLos = los;
  // The full scan cast ~110 000 (TDM Harbor, 62 picks) and ~2 100 (Conquest Frontier) rays here.
  assert.ok(tdm < 15000, `TDM Harbor 31-bot start casts few sight rays (${tdm})`);
  assert.ok(conquest < 1000, `Conquest Frontier 16-bot start casts few sight rays (${conquest})`);
  console.log(`room start sight rays: TDM Harbor 31 bots ${tdm}, Conquest Frontier 16 bots ${conquest}`);
}

// ---------------------------------------------------------------------------
// 6. Diagnostics: long-tick log, window fields.
// ---------------------------------------------------------------------------
{
  const lines = [];
  const timing = new TickTiming({ describe: () => 'conquest/frontier, 16 bodies', budgetMs: () => 10, log: line => lines.push(line) });
  timing.record(0, 5, 16); timing.record(16, 30, 16); timing.record(400, 40, 16); timing.record(1100, 26, 16); timing.record(1200, 24.9, 16);
  assert.equal(timing.longTicks, 3, 'ticks of 25 ms and more count as long');
  assert.equal(lines.length, 2, 'one long-tick line per room per second');
  assert.match(lines[0], /long tick 30\.0 ms \(conquest\/frontier, 16 bodies, 1 so far\)/);
  assert.equal(timing.read(1200).longTicks, 3);
  const budget60 = new TickTiming({ describe: () => 'x', budgetMs: () => 1000 / 60, log: line => lines.push(line) });
  budget60.record(0, 30, 16);
  assert.equal(budget60.longTicks, 0, 'at 60 Hz the bar is twice the budget (33.3 ms)');
  assert.equal(new TickTiming().read(0), null);
  const plain = new TickTiming(); plain.record(0, 500, 16);
  assert.equal(plain.longTicks, 0, 'a timing without a room label never logs');

  // A room's long-tick line names the step's slow phases.
  const room = new GameEngine({ mode: 'tdm', world: createMapState('depot'), mapMeta: getMapMeta('depot') });
  room.step();
  assert.equal(room.tickPhases.length, TICK_PHASES.length);
  assert.ok([...room.tickPhases].every(ms => Number.isFinite(ms) && ms >= 0), 'every phase of a step is timed');
  const roomLines = [];
  room.tickTiming.log = line => roomLines.push(line);
  room.tickPhases.fill(0); room.tickPhases[TICK_PHASES.indexOf('bots')] = 30; room.tickPhases[TICK_PHASES.indexOf('snapshot')] = 5.25;
  room.tickTiming.record(0, 30, 16);
  assert.equal(roomLines.length, 0, 'at the 60 Hz tick 30 ms is under twice the budget');
  room.tickTiming.record(10, 40, 16);
  assert.match(roomLines[0], /^\[voxel-blitz\] long tick 40\.0 ms \(tdm\/depot, 0 bodies, \d+ rooms; bots 30\.0, snapshot 5\.3 ms, 1 so far\)$/);

  // Backpressure counters: a held tick is skipped, the next send merges it.
  const client = { ticksInFlight: 3 };
  assert.equal(coalesceTick(client, { t: 'tick', blocks: [], events: [] }), null);
  client.ticksInFlight = 0;
  assert.ok(coalesceTick(client, { t: 'tick', blocks: [], events: [] }));
  coalesceTick(client, { t: 'tick', blocks: [], events: [] });
  assert.deepEqual([client.skippedTicks, client.mergedSends], [1, 1], 'one skipped tick, one merged send');

  const diagnostics = new ServerDiagnostics();
  const garbage = []; for (let i = 0; i < 2e5; i++) garbage.push({ i, s: `x${i}` });
  garbage.length = 0;
  await new Promise(resolve => setTimeout(resolve, 1150));
  const read = diagnostics.read({ ws: { bufferedAmount: 7 }, skippedTicks: 4, mergedSends: 2 });
  diagnostics.dispose();
  assert.ok(read.process, 'a one-second window was measured');
  assert.ok(read.process.eventLoopUtilization >= 0 && read.process.eventLoopUtilization <= 1, 'event-loop utilization 0..1');
  assert.ok(read.process.gc && Number.isFinite(read.process.gc.count) && Number.isFinite(read.process.gc.maxMs), 'GC window');
  assert.ok(Number.isFinite(read.process.eventLoopMaxMs));
  assert.equal(read.skippedTicks, 4);
  assert.equal(read.mergedSends, 2);
  assert.equal(read.queuedBytes, 7);
  console.log(`diagnostics: long ticks, ELU ${read.process.eventLoopUtilization}, GC ${read.process.gc.count} pauses, loop max ${read.process.eventLoopMaxMs} ms`);
}

// runSliced keeps going after a failing task and reports it.
{
  const timings = await runSliced([['bad', () => { throw new Error('boom'); }], ['ok', function* () { yield; yield; }]], { sliceMs: 0 });
  assert.equal(timings[0].error, 'boom');
  assert.ok(!timings[1].error && timings[1].slices >= 1);
}

console.log('load-spike test passed');
process.exit(0);
