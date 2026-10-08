// Structural integrity microbenchmark (docs/structural-physics.md).
//   node tools/structure-bench.mjs [--map frontier] [--seconds 60] [--rockets 2] [--bullets 12]
// Simulates typical combat on built-up cells: rockets (ROCKET_RULES) and
// bullet block breaks at random structural voxels, with structural integrity
// on, and reports per-tick structure cost (support passes, collapses, chunk
// sweeps and the block listener) as p50/p95/max, plus the whole-tick delta
// against the same seeded run with structural integrity off. A demolition
// case (a 9x9x20 tower's base removed in one tick) shows the budget spreading.
import { GameEngine } from '../server/game.js';
import { destroyBlockDirect } from '../server/sim/combat.js';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { MODE_IDS, isModeMapCompatible } from '../shared/modes.js';
import { ROCKET_RULES } from '../shared/rocket-rules.js';
import { CONCRETE, STONE, AIR } from '../shared/world/blocks.js';
import { STRUCTURE_KIND } from '../shared/structure.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const maps = arg('map', 'foundry,frontier').split(',');
const seconds = Number(arg('seconds', 60));
const rocketsPerSecond = Number(arg('rockets', 2));
const bulletsPerSecond = Number(arg('bullets', 12));

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
};
const fmt = (ms) => `${(ms * 1000).toFixed(0)} us`;

function makeEngine(map, structural) {
  const mode = MODE_IDS.find(m => isModeMapCompatible(m, map));
  const engine = new GameEngine({ world: createMapState(map), mode, mapMeta: getMapMeta(map), structural });
  return engine;
}

/** Built-up targets: structural voxels with air next to them (where combat damage lands). */
function targetsOf(engine, count, seed) {
  const world = engine.world, { sx, sy, sz } = world.dimensions, out = [];
  let state = seed;
  const random = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let tries = 0; out.length < count && tries < 4e6; tries++) {
    const x = 1 + Math.floor(random() * (sx - 2)), y = 2 + Math.floor(random() * (sy - 3)), z = 1 + Math.floor(random() * (sz - 2));
    if (STRUCTURE_KIND[world.getBlock(x, y, z)] !== 2) continue;
    if (world.getBlock(x + 1, y, z) && world.getBlock(x - 1, y, z) && world.getBlock(x, y, z + 1) && world.getBlock(x, y, z - 1)) continue;
    out.push([x, y, z]);
  }
  return out;
}

function combat(map, structural) {
  const engine = makeEngine(map, structural), structure = engine.structure;
  const ticks = Math.round(seconds * 60), targets = targetsOf(engine, 4000, 99);
  let listenerMs = 0;
  if (structure.active) {
    const inner = structure.listener;
    structure.listener = (...args) => { const t = performance.now(); inner(...args); listenerMs += performance.now() - t; };
    engine.world.onBlockChange = structure.listener;
  }
  const stepStructure = structure.step.bind(structure);
  let stepMs = 0;
  structure.step = () => { const t = performance.now(); stepStructure(); stepMs += performance.now() - t; };
  let seed = 4242, next = 0;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const perTick = [], tickMs = [], units = [];
  let peakEvents = 0, fell = 0;
  for (let tick = 0; tick < ticks; tick++) {
    listenerMs = 0; stepMs = 0;
    const started = performance.now();
    if (random() < rocketsPerSecond / 60) {
      const [x, y, z] = targets[next++ % targets.length];
      engine.projectiles._destroyTerrain([x + 0.5, y + 0.5, z + 0.5], ROCKET_RULES, engine.contexts.projectiles, null);
    }
    if (random() < bulletsPerSecond / 60) {
      const [x, y, z] = targets[next++ % targets.length];
      destroyBlockDirect(x, y, z, null, engine.contexts.combat, null);
    }
    engine.step();
    tickMs.push(performance.now() - started);
    perTick.push(listenerMs + stepMs);
    units.push(structure.stats.units);
    const events = engine.tickEvents.length;
    if (events > peakEvents) peakEvents = events;
  }
  fell = structure.stats.collapses;
  return { engine, perTick, tickMs, units, fell, stats: structure.stats, memory: structure.memory() };
}

function demolition() {
  const engine = makeEngine('foundry', true), world = engine.world, structure = engine.structure;
  structure.beginBulk();
  for (let x = 20; x < 60; x++) for (let z = 20; z < 60; z++) for (let y = 1; y < 40; y++) world.setBlock(x, y, z, y <= 10 ? STONE : AIR);
  structure.reset();
  for (let x = 30; x <= 38; x++) for (let z = 30; z <= 38; z++) for (let y = 11; y <= 30; y++) {
    world.setBlock(x, y, z, CONCRETE); engine.pushBlockDelta(x, y, z, CONCRETE);
  }
  for (let i = 0; i < 5; i++) engine.step();
  const inner = structure.step.bind(structure), times = [];
  structure.step = () => { const t = performance.now(); inner(); times.push(performance.now() - t); };
  const t0 = performance.now();
  for (let x = 30; x <= 38; x++) for (let z = 30; z <= 38; z++) destroyBlockDirect(x, 11, z, null, engine.contexts.combat, null);
  const removeMs = performance.now() - t0;
  for (let i = 0; i < 120 && !structure.idle; i++) engine.step();
  return { removeMs, times, stats: structure.stats };
}

for (const map of maps) {
  const on = combat(map, true), off = combat(map, false);
  const delta = on.tickMs.map((ms, i) => ms - off.tickMs[i]);
  console.log(`\n${map}: ${seconds}s combat, ${rocketsPerSecond} rockets/s + ${bulletsPerSecond} block breaks/s on built-up cells`);
  console.log(`  structure time/tick  p50 ${fmt(percentile(on.perTick, 0.5))}  p95 ${fmt(percentile(on.perTick, 0.95))}  p99 ${fmt(percentile(on.perTick, 0.99))}  max ${fmt(Math.max(...on.perTick))}`);
  console.log(`  support units/tick   p95 ${percentile(on.units, 0.95)}  max ${Math.max(...on.units)}  (budget 1500)`);
  console.log(`  whole tick on/off    p50 ${fmt(percentile(on.tickMs, 0.5))} / ${fmt(percentile(off.tickMs, 0.5))}  p95 ${fmt(percentile(on.tickMs, 0.95))} / ${fmt(percentile(off.tickMs, 0.95))}  (delta p95 ${fmt(percentile(delta, 0.95))}, includes collapse block deltas)`);
  console.log(`  collapses ${on.stats.collapses}  crumbles ${on.stats.crumbles}  creaks ${on.stats.creaks}  rubble ${on.stats.rubble}  room support memory ${(on.memory.bytes / 1e6).toFixed(2)} MB (${on.memory.chunks} owned chunks)`);
  on.engine.stop(); off.engine.stop();
}
const demo = demolition();
console.log(`\ndemolition: 9x9x20 concrete tower, base removed in one tick (81 blocks, listener ${fmt(demo.removeMs)})`);
console.log(`  structure step per tick: ${demo.times.filter(t => t > 0.02).map(fmt).join(', ')}`);
console.log(`  peak units ${demo.stats.peakUnits}, collapses ${demo.stats.collapses}, crumbles ${demo.stats.crumbles}`);
