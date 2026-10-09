// Structural integrity: support rules per material, collapses, falling chunks,
// crush damage and kill credit, rubble, budgets, determinism, the incremental
// field against a from-scratch rebuild, placement refusal, late-join frames
// and the protocol contract, ground material as building material and
// load-time pins that release when their structure is cut off
// (docs/structural-physics.md).
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { destroyBlockDirect } from '../server/sim/combat.js';
import { SupportField, PIN, pack } from '../server/sim/structure-field.js';
import { GROUND_RULES } from '../server/sim/structure-ground.js';
import { TerrainWatch } from '../server/bot-surface-nav.js';
import { createMapState } from '../shared/worlddata.js';
import { decodeMapFrame } from '../shared/world/serialize.js';
import {
  AIR, STONE, SAND, DIRT, BEDROCK, WOOD, PLANK, CONCRETE, BRICK, GLASS, ACCENT, BARRICADE, GROUND, SX, SZ,
} from '../shared/world/blocks.js';
import {
  STRUCTURE_RULES, STRUCTURE_EVENT_KINDS, STRUCTURE_KIND, COLLAPSE_WEAPON, structureSpan,
  structureEventCells, collapseOffset, collapsePoint,
} from '../shared/structure.js';
import { canPlaceStructure } from '../shared/bastion-build.js';
import { BASTION_BREAK_PHASES } from '../shared/modes.js';
import { STRUCTURE_EVENT_KEYS } from './lib/protocol-contract.mjs';

let passed = 0;
const ok = (value, message) => { assert.ok(value, message); passed++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); passed++; };

const FLOOR = 10;
/**
 * A foundry engine with a flat stone floor (y <= 10) and open air over x, z
 * in [12, 116) x [12, 84). `prebuild(set)` adds blocks before the field is
 * built (they count as map geometry: ground material there is labelled).
 */
function scene({ structural = true, rules = null, mode = undefined, prebuild = null } = {}) {
  const events = [];
  const engine = new GameEngine({ world: createMapState('foundry'), structural, ...(mode ? { mode } : {}),
    broadcast: (s) => events.push(...s.events) });
  const world = engine.world, structure = engine.structure;
  if (rules) structure.rules = { ...STRUCTURE_RULES, ...rules };
  structure.beginBulk();
  for (let x = 12; x < 116; x++) for (let z = 12; z < 84; z++) for (let y = 1; y < 40; y++) {
    world.setBlock(x, y, z, y <= FLOOR ? STONE : AIR);
  }
  prebuild?.((x, y, z, type) => world.setBlock(x, y, z, type));
  structure.reset();
  const set = (x, y, z, type) => { world.setBlock(x, y, z, type); engine.pushBlockDelta(x, y, z, type); };
  const box = (x0, y0, z0, x1, y1, z1, type) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) set(x, y, z, type);
  };
  const destroy = (x, y, z, cause = null) => destroyBlockDirect(x, y, z, null, engine.contexts.combat, cause);
  const run = (ticks) => { for (let i = 0; i < ticks; i++) engine.step(); };
  const settle = () => {
    run(1);
    for (let i = 0; i < 2000 && !structure.idle; i++) engine.step();
    ok(structure.idle, 'structure settles');
    run(1);
  };
  const kinds = (kind) => events.filter(e => e.kind === kind);
  // Kill credit is server-side only (the wire names nobody): record each creak cluster's cause.
  const credit = new Map(), doom = structure.doom.bind(structure);
  structure.doom = (keys, cause, origin, options) => { doom(keys, cause, origin, options); credit.set('k' + structure.doomSerial, cause); };
  const creditOf = (event) => credit.get(event.kind === 'collapse' ? event.k : event.id);
  return { engine, world, structure, set, box, destroy, run, settle, events, kinds, creditOf };
}

/** Assert the incremental field equals a from-scratch build with the same pins. */
function assertFieldMatches(s, label) {
  const { world, structure } = s;
  const rebuilt = SupportField.build(world.dimensions, (x, y, z) => world.getBlock(x, y, z),
    { pins: structure.field.pinKeys(), demoted: structure.field.demoted });
  const { sx, sy, sz } = world.dimensions;
  let mismatches = 0, first = null;
  for (let y = 1; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    if (structure.field.kindAt(x, y, z) !== 2) continue;
    const a = structure.field.read(x, y, z), b = rebuilt.read(x, y, z);
    if (a !== b) { mismatches++; first ??= { x, y, z, incremental: a, rebuilt: b }; }
  }
  eq(mismatches, 0, `${label}: incremental support equals a rebuild ${JSON.stringify(first)}`);
}

// 1. Overhang limits per material: a beam from a ground pillar keeps `span` blocks.
for (const type of [WOOD, PLANK, BRICK, CONCRETE, ACCENT]) {
  const s = scene();
  const span = structureSpan(type);
  s.box(20, 11, 20, 20, 14, 20, CONCRETE);
  for (let x = 20; x <= 20 + span + 3; x++) s.set(x, 15, 20, type);
  s.settle();
  const kept = [];
  for (let x = 21; x <= 20 + span + 3; x++) if (s.world.getBlock(x, 15, 20) === type) kept.push(x);
  eq(kept.length, span, `material ${type}: a beam keeps exactly its ${span}-block overhang`);
  ok(s.kinds('creak').length >= 1 && s.kinds('collapse').length >= 1, `material ${type}: the overhang beyond its span creaks and falls`);
}
eq([WOOD, PLANK, BRICK, CONCRETE, ACCENT, GLASS].map(structureSpan), [4, 4, 6, 10, 3, 0], 'material spans: wood/planks 4, brick 6, concrete 10, siding 3, glass 0');

// 2. A roof on four pillars stands; without pillars it falls as one chunk.
{
  const s = scene();
  for (const [x, z] of [[30, 30], [34, 30], [30, 34], [34, 34]]) s.box(x, 11, z, x, 14, z, WOOD);
  s.box(30, 15, 30, 34, 15, 34, PLANK);
  s.settle();
  eq(s.kinds('collapse').length, 0, 'a 5x5 plank roof on four corner pillars stands (centre 4 steps from a pillar)');
  for (const [x, z] of [[30, 30], [34, 30], [30, 34]]) s.destroy(x, 11, z);
  s.settle();
  eq(s.world.getBlock(33, 15, 33), PLANK, 'the last corner pillar still holds the roof within reach');
  eq(s.world.getBlock(30, 15, 30), AIR, 'the far corner, 8 steps from the last pillar, falls');
  s.destroy(34, 11, 34);
  s.settle();
  let roof = 0;
  for (let x = 30; x <= 34; x++) for (let z = 30; z <= 34; z++) if (s.world.getBlock(x, 15, z) === PLANK) roof++;
  eq(roof, 0, 'pulling the last pillar drops the whole roof');
  ok(s.kinds('collapseLand').some(e => e.r > 0), 'a landed roof leaves rubble');
  assertFieldMatches(s, 'roof');
}

// 3. A concrete bridge loses its middle when the pier is shot away.
function bridge(s) {
  s.box(20, 11, 40, 20, 14, 40, CONCRETE);
  s.box(44, 11, 40, 44, 14, 40, CONCRETE);
  s.box(32, 11, 40, 32, 14, 40, CONCRETE);
  for (let x = 20; x <= 44; x++) s.set(x, 15, 40, CONCRETE);
  s.settle();
}
{
  const s = scene();
  bridge(s);
  eq(s.kinds('collapse').length, 0, 'a 24-block concrete deck on two abutments and a pier stands');
  for (let y = 11; y <= 14; y++) s.destroy(32, y, 40, 'sapper');
  s.settle();
  const fallen = [];
  for (let x = 20; x <= 44; x++) if (s.world.getBlock(x, 15, 40) !== CONCRETE) fallen.push(x);
  eq(fallen, [31, 32, 33], 'without the pier the deck beyond 10 blocks of either abutment falls');
  ok(s.kinds('collapse').every(e => s.creditOf(e) === 'sapper'), 'the collapse is credited to whoever destroyed the pier');
  assertFieldMatches(s, 'bridge');
}

// 4. Determinism: the same destruction yields the same events.
{
  const runOnce = () => {
    const s = scene();
    bridge(s);
    for (let y = 11; y <= 14; y++) s.destroy(32, y, 40, 'sapper');
    s.settle();
    return JSON.stringify(s.events.filter(e => STRUCTURE_EVENT_KINDS.includes(e.kind)).map(({ at, ...rest }) => rest));
  };
  eq(runOnce(), runOnce(), 'collapse events are deterministic');
}

// 5. Chain reaction: a falling concrete slab smashes a plank floor below it.
{
  const s = scene();
  s.box(50, 11, 50, 50, 22, 50, CONCRETE);                  // tower holding the slab
  s.box(51, 23, 48, 55, 23, 52, CONCRETE);                  // slab cantilevered from the tower
  s.set(50, 23, 50, CONCRETE);
  for (const [x, z] of [[51, 47], [56, 47], [51, 53], [56, 53]]) s.box(x, 11, z, x, 13, z, WOOD);
  s.box(51, 14, 47, 56, 14, 53, PLANK);                     // a plank floor under the slab
  s.settle();
  eq(s.kinds('collapse').length, 0, 'slab and plank floor stand');
  for (let y = 11; y <= 22; y++) s.destroy(50, y, 50, 'demo');
  s.settle();
  let planks = 0;
  for (let x = 51; x <= 56; x++) for (let z = 47; z <= 53; z++) if (s.world.getBlock(x, 14, z) === PLANK) planks++;
  ok(planks < 42, `the slab smashes through the plank floor (${planks}/42 planks left)`);
  ok(s.kinds('collapse').length >= 2, 'the broken floor collapses in turn (chain reaction)');
  assertFieldMatches(s, 'chain');
}

// 6. Budget: a big tower's support pass spreads over ticks; huge clusters split and crumble.
{
  const s = scene();
  s.box(60, 11, 60, 68, 30, 68, CONCRETE);
  s.settle();
  s.events.length = 0;
  for (let x = 60; x <= 68; x++) for (let z = 60; z <= 68; z++) s.destroy(x, 11, z, 'demo');
  const units = [];
  for (let i = 0; i < 40 && !s.structure.idle; i++) { s.engine.step(); units.push(s.structure.stats.units); }
  ok(units.every(u => u <= STRUCTURE_RULES.tickBudget), `support work stays within the tick budget (peak ${Math.max(...units)})`);
  ok(units.filter(u => u > 0).length >= 2, `a 1620-block invalidation spreads over ${units.filter(u => u > 0).length} ticks`);
  s.settle();
  const collapses = s.kinds('collapse');
  ok(collapses.length >= 2 && collapses.length <= STRUCTURE_RULES.maxChunksPerCluster, `the tower falls as ${collapses.length} capped chunks`);
  ok(collapses.every(e => e.n <= STRUCTURE_RULES.maxChunkCells), 'every chunk respects the chunk cell cap');
  const removed = collapses.reduce((n, e) => n + e.n, 0) + s.kinds('crumble').reduce((n, e) => n + e.n, 0);
  eq(removed, 9 * 9 * 19, 'every unsupported tower block either falls or crumbles');
  assertFieldMatches(s, 'tower');
}

// 7. Fuzz: random structures and removals keep the incremental field exact.
{
  const s = scene();
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const types = [WOOD, PLANK, BRICK, CONCRETE, GLASS, ACCENT];
  for (let i = 0; i < 60; i++) {
    const x = 20 + Math.floor(random() * 80), z = 20 + Math.floor(random() * 56), h = 2 + Math.floor(random() * 8);
    const type = types[Math.floor(random() * types.length)];
    s.box(x, 11, z, x, 10 + h, z, CONCRETE);
    const along = random() < 0.5, length = 2 + Math.floor(random() * 12);
    for (let k = 0; k < length; k++) s.set(along ? x + k : x, 11 + h, along ? z : z + k, type);
  }
  s.settle();
  assertFieldMatches(s, 'fuzz build');
  for (let round = 0; round < 6; round++) {
    for (let k = 0; k < 40; k++) {
      const x = 20 + Math.floor(random() * 92), y = 11 + Math.floor(random() * 10), z = 20 + Math.floor(random() * 60);
      if (s.world.getBlock(x, y, z) !== AIR) s.destroy(x, y, z, 'fuzz');
      else if (random() < 0.3) s.set(x, y, z, types[Math.floor(random() * types.length)]);
    }
    s.settle();
    assertFieldMatches(s, `fuzz round ${round}`);
  }
}

// 8. Crush damage and kill credit through the ordinary kill path.
{
  const s = scene();
  s.engine.addClient('killer', 'Killer');
  s.engine.addClient('victim', 'Victim');
  const killer = s.engine.entities.get('killer');
  const victim = s.engine.entities.get('victim');
  Object.assign(killer, { x: 20.5, y: 11, z: 70.5 });
  Object.assign(victim, { x: 38.5, y: 11, z: 38.5, spawnProtected: false, spawnProtectedUntil: 0, hp: 100, armor: 0 });
  s.box(40, 11, 40, 40, 14, 40, CONCRETE);
  s.box(37, 15, 37, 43, 15, 43, CONCRETE);
  s.settle();
  eq(victim.state, 'alive', 'standing under a supported slab is safe');
  for (let y = 11; y <= 14; y++) s.destroy(40, y, 40, 'killer');
  for (let i = 0; i < 80; i++) { Object.assign(victim, { x: 38.5, z: 38.5, vx: 0, vz: 0 }); s.engine.step(); }
  const kill = s.kinds('kill').find(e => e.victim === 'victim');
  ok(kill, 'the falling slab kills the player under it');
  eq([kill.killer, kill.w], ['killer', COLLAPSE_WEAPON], 'the kill is credited to the player who destroyed the support, weapon "collapse"');
  eq(killer.kills, 1, 'the killer scores the kill');
  ok(s.kinds('hit').some(e => e.victim === 'victim' && e.attacker === 'killer'), 'a hit event reports the crush');
}

// 9. Unknown cause: an environmental crush with no kill credit; rubble never fills a body.
{
  const s = scene({ rules: { rubble: { ...STRUCTURE_RULES.rubble, fraction: 1 } } });
  s.engine.addClient('p', 'P');
  const p = s.engine.entities.get('p');
  Object.assign(p, { x: 72.5, y: 11, z: 30.5, spawnProtected: false, spawnProtectedUntil: 0, hp: 100, armor: 0 });
  s.box(68, 11, 30, 68, 13, 30, WOOD);
  for (let x = 68; x <= 72; x++) s.set(x, 14, 30, WOOD);
  for (let x = 70; x <= 75; x++) s.set(x, 15, 30, PLANK);
  s.box(76, 11, 30, 76, 14, 30, WOOD);
  s.set(76, 15, 30, PLANK);
  s.settle();
  for (let y = 11; y <= 13; y++) s.destroy(68, y, 30);
  for (let y = 11; y <= 14; y++) s.destroy(76, y, 30);
  for (let i = 0; i < 80; i++) { Object.assign(p, { x: 72.5, z: 30.5, vx: 0, vz: 0 }); s.engine.step(); }
  ok(s.kinds('collapseLand').length >= 1, 'the beam lands');
  ok(s.kinds('hit').some(e => e.victim === 'p' && e.attacker === ''), 'an unattributed collapse hurts as the world');
  if (p.state === 'alive') {
    for (let y = Math.floor(p.y); y <= Math.floor(p.y + 1.85); y++) eq(s.world.getBlock(72, y, 30), AIR, `no rubble inside the surviving player (y ${y})`);
  }
  ok(s.kinds('collapseLand').some(e => e.r > 0), 'rubble settles beside the player');
}

// 10. Explosions attribute their owner; vehicles under a chunk take collision damage.
{
  const s = scene();
  s.box(40, 11, 60, 40, 14, 60, BRICK);
  s.box(37, 15, 57, 43, 15, 63, BRICK);
  s.settle();
  const hulls = [];
  // A minimal hull registry: the structure system only reads `vehicles` and calls `damage`.
  s.engine.vehicles = new Proxy({ vehicles: new Map([['jeep-1', { id: 'jeep-1', type: 'jeep', hp: 400, x: 38.5, y: 11, z: 58.5, yaw: 0 }]]),
    damage: (id, amount, attacker, opts) => { hulls.push({ id, amount, attacker, cls: opts.cls }); return true; },
    snapshot: () => [] }, { get: (target, key) => (key in target ? target[key] : () => null) });
  s.engine.addClient('gren', 'Gren');
  s.engine.projectiles._destroyTerrain([40.5, 12.5, 60.5], { terrainRadius: 2.6, terrainPower: 400, maxDestroyedBlocks: 40 },
    s.engine.contexts.projectiles, 'gren');
  s.settle();
  ok(s.kinds('collapse').some(e => s.creditOf(e) === 'gren'), 'a blast that takes out the pillar credits its owner');
  ok(hulls.some(h => h.id === 'jeep-1' && h.cls === 'collision' && h.amount > 0), 'a hull under the falling slab takes collision damage');
}

// 11. Glass rests only on the block below; a sill shot away drops the pane.
{
  const s = scene();
  s.box(80, 11, 50, 84, 12, 50, BRICK);
  s.box(81, 13, 50, 83, 14, 50, GLASS);
  s.box(80, 13, 50, 80, 14, 50, BRICK);
  s.box(84, 13, 50, 84, 14, 50, BRICK);
  s.settle();
  eq(s.kinds('collapse').length, 0, 'a framed window on a sill stands');
  s.destroy(82, 12, 50, 'shooter');
  s.settle();
  eq([s.world.getBlock(82, 13, 50), s.world.getBlock(82, 14, 50)], [AIR, AIR], 'the pane above the broken sill falls');
  eq(s.world.getBlock(81, 13, 50), GLASS, 'neighbouring panes on intact sill blocks stay');
}

// 12. Placement: the support check refuses floating blocks (bastion `unsupported`).
{
  const s = scene();
  ok(s.engine.structure.canSupport([{ x: 30, y: 11, z: 30 }, { x: 30, y: 12, z: 30 }], BARRICADE), 'blocks on the floor are supported');
  ok(!s.engine.structure.canSupport([{ x: 30, y: 25, z: 30 }], BARRICADE), 'a floating block is not');
  const layout = { stages: [{ buildZone: { minX: 0, maxX: 127, minZ: 0, maxZ: 95 }, objective: { x: 0, z: 0, half: [0, 0, 0] } }],
    bounds: { minX: 0, maxX: 127, minZ: 0, maxZ: 95 } };
  const verdict = (supported) => canPlaceStructure({ getBlock: (x, y) => (y < GROUND + 1 ? STONE : AIR), layout, stageIndex: 0,
    kind: 'sandbag', cell: { x: 60, y: GROUND + 1, z: 60 }, facing: 0, player: { state: 'alive', x: 60.5, y: GROUND + 1, z: 62.5 },
    phase: BASTION_BREAK_PHASES[0], budget: null, credits: 999, structures: [], occupied: () => false, supported });
  eq(verdict(() => false).reason, 'unsupported', 'the shared predicate refuses an unsupported placement');
  eq(verdict(() => true).ok, true, 'and accepts a supported one');
  eq(verdict(undefined).ok, true, 'clients without the support field skip the check');
}

// 12b. Scripted geometry (training gates through the mode's block port) never collapses.
{
  const s = scene();
  s.box(90, 11, 70, 90, 14, 70, BRICK);
  s.box(90, 11, 78, 90, 14, 78, BRICK);
  s.box(90, 11, 71, 90, 14, 77, CONCRETE);             // a closed gate
  s.box(90, 15, 70, 90, 15, 78, ACCENT);               // a siding lintel resting on it
  s.settle();
  s.engine.structure.authored(() => { for (let y = 11; y <= 14; y++) for (let z = 71; z <= 77; z++) s.set(90, y, z, AIR); });
  s.settle();
  eq(s.kinds('collapse').length, 0, 'opening a scripted gate pins the lintel above it instead of dropping it');
  eq(s.world.getBlock(90, 15, 74), ACCENT, 'the lintel stays in place');
  s.destroy(90, 15, 73, 'shooter');
  s.settle();
  eq(s.world.getBlock(90, 15, 74), ACCENT, 'pinned lintel blocks stay anchors after nearby damage');
  assertFieldMatches(s, 'authored');
}

// 13. Disabled rooms keep the old rules.
{
  const s = scene({ structural: false });
  s.box(20, 11, 20, 20, 14, 20, CONCRETE);
  for (let x = 21; x <= 35; x++) s.set(x, 15, 20, WOOD);
  s.settle();
  eq(s.world.getBlock(35, 15, 20), WOOD, 'structural: false leaves floating blocks alone');
  eq(s.kinds('creak').length + s.kinds('collapse').length, 0, 'and emits no structure events');
  ok(!s.engine.structure.active, 'the system is inert');
}

// 14. Late join: the V3 map frame after a collapse carries the final voxels (removals and rubble).
{
  const s = scene();
  bridge(s);
  for (let y = 11; y <= 14; y++) s.destroy(32, y, 40, 'sapper');
  s.settle();
  const decoded = decodeMapFrame(s.world.mapFrame());
  let diff = 0;
  for (let x = 12; x < 116; x++) for (let z = 12; z < 84; z++) for (let y = 1; y < 40; y++) {
    if (decoded.blocks[((y * SZ) + z) * SX + x] !== s.world.getBlock(x, y, z)) diff++;
  }
  eq(diff, 0, 'a late joiner\'s map frame matches the live world after a collapse');
}

// 15. Bot terrain watch: a voxel changed twice (rubble into a crater) stays incremental.
{
  const s = scene();
  const watch = new TerrainWatch(s.engine);
  s.set(30, 11, 30, WOOD);
  s.set(30, 11, 30, AIR);
  s.set(30, 11, 30, BRICK);
  const columns = watch.poll();
  ok(columns instanceof Set && columns.has(30 + 30 * SX), 'the terrain watch locates re-changed voxels from the block journal');
}

// 16. Wire format: event keys, the shared decoder and closed-form motion.
{
  const s = scene();
  bridge(s);
  for (let y = 11; y <= 14; y++) s.destroy(32, y, 40, 'sapper');
  s.settle();
  for (const kind of STRUCTURE_EVENT_KINDS) {
    const event = s.events.find(e => e.kind === kind);
    if (!event) continue;
    eq(Object.keys(event).sort().join(','), STRUCTURE_EVENT_KEYS[kind], `${kind} event keys match the contract`);
  }
  const collapse = s.kinds('collapse')[0];
  const cells = structureEventCells(collapse);
  eq(cells.length, collapse.n, 'the decoder returns every listed block');
  ok(cells.every(c => c.type === CONCRETE && c.y === 15), 'decoded cells are the deck blocks');
  const end = collapseOffset(collapse, collapse.land);
  const land = s.kinds('collapseLand').find(e => e.id === collapse.id);
  ok(Math.abs(collapse.p[1] + end[1] - land.y) < 0.02, 'closed-form motion ends at the reported landing point');
  const start = collapsePoint(collapse, [cells[0].x + 0.5, cells[0].y + 0.5, cells[0].z + 0.5], 0);
  ok(Math.abs(start[1] - (cells[0].y + 0.5)) < 1e-9, 'motion starts at the static block');
  const creak = s.kinds('creak')[0];
  ok(creak.fall === STRUCTURE_RULES.creakMs && collapse.at - creak.at >= STRUCTURE_RULES.creakMs, 'the creak warns creakMs before the fall');
  ok(JSON.stringify(collapse).length < 2000, 'a small collapse event stays compact');
  const wire = JSON.stringify(s.events.filter(e => STRUCTURE_EVENT_KINDS.includes(e.kind)));
  ok(!wire.includes('sapper'), 'structure events never name who brought the structure down (TTT)');
}

// 17. Credit per removal: one support pass mixing removals by several players
// credits each cluster to the removal it depended on, not to the pass's last.
{
  const s = scene();
  s.box(40, 11, 40, 40, 14, 40, CONCRETE);
  s.box(37, 15, 37, 43, 15, 43, CONCRETE);
  s.box(90, 11, 70, 90, 12, 70, BRICK);
  s.settle();
  for (let y = 11; y <= 14; y++) s.destroy(40, y, 40, 'alice');
  s.destroy(90, 12, 70, 'bob');                       // unrelated, same tick, removed last
  s.settle();
  ok(s.kinds('collapse').length >= 1, 'the slab falls');
  ok(s.kinds('collapse').every(e => s.creditOf(e) === 'alice'), 'a same-tick unrelated removal does not steal the credit');
  assertFieldMatches(s, 'same-tick credit');
}
{
  const s = scene();
  s.box(60, 11, 60, 68, 30, 68, CONCRETE);            // its support pass spans several ticks
  s.box(30, 11, 30, 30, 14, 30, CONCRETE);
  s.box(28, 15, 28, 32, 15, 32, CONCRETE);
  s.box(100, 11, 70, 100, 12, 70, BRICK);
  s.settle();
  for (let x = 60; x <= 68; x++) for (let z = 60; z <= 68; z++) s.destroy(x, 11, z, 'alice');
  s.engine.step();
  for (let y = 11; y <= 14; y++) s.destroy(30, y, 30, 'carol');
  s.engine.step();
  s.destroy(100, 12, 70, 'bob');
  s.settle();
  const creaks = s.kinds('creak'), tower = creaks.find(e => e.n > 1000), slab = creaks.find(e => e.n === 25);
  ok(tower && slab, 'the tower and the slab each creak');
  eq([s.creditOf(tower), s.creditOf(slab)], ['alice', 'carol'], 'removals joining a running pass keep their own credit');
  ok(s.kinds('collapse').filter(e => e.k === tower.id).every(e => s.creditOf(e) === 'alice'), 'every tower chunk credits alice');
  assertFieldMatches(s, 'multi-tick credit');
}

// 18. Scripted edits pin only what they alone unsupported: a training gate
// opening in the same tick as a player's demolition does not freeze it.
{
  const s = scene();
  s.box(90, 11, 70, 90, 14, 70, BRICK);
  s.box(90, 11, 78, 90, 14, 78, BRICK);
  s.box(90, 11, 71, 90, 14, 77, CONCRETE);
  s.box(90, 15, 70, 90, 15, 78, ACCENT);
  s.box(40, 11, 40, 40, 14, 40, CONCRETE);
  s.box(37, 15, 37, 43, 15, 43, CONCRETE);
  s.settle();
  const pins = s.structure.field.pins;
  for (let y = 11; y <= 14; y++) s.destroy(40, y, 40, 'alice');
  s.engine.structure.authored(() => { for (let y = 11; y <= 14; y++) for (let z = 71; z <= 77; z++) s.set(90, y, z, AIR); });
  s.settle();
  eq(s.world.getBlock(40, 15, 40), AIR, 'the demolished slab still falls');
  ok(s.kinds('collapse').length >= 1 && s.kinds('collapse').every(e => s.creditOf(e) === 'alice'), 'credited to the demolisher');
  eq(s.world.getBlock(90, 15, 74), ACCENT, 'the lintel over the scripted gate is pinned');
  ok(s.structure.field.pins > pins && s.structure.field.pins - pins <= 9, 'only the lintel is pinned');
  assertFieldMatches(s, 'authored + demolition');
}

// 19. No friendly crush: a team-mate's collapse spares you and your team's hulls
// (no world-damage fallback); it still kills enemies, and your own kills you.
{
  const s = scene({ mode: 'tdm' });
  const e = s.engine;
  e.addClient('a', 'A'); e.addClient('b', 'B'); e.addClient('c', 'C');
  if (e.mode.teamFor('b') !== e.mode.teamFor('a')) e.mode.setLobbyTeam('b', e.mode.teamFor('a'));
  if (e.mode.teamFor('c') === e.mode.teamFor('a')) e.mode.setLobbyTeam('c', e.mode.teamFor('a') === 'alpha' ? 'bravo' : 'alpha');
  for (let i = 0; i < 4000 && e.mode.phase !== 'live'; i++) e.step();
  const [a, b, c] = ['a', 'b', 'c'].map(id => e.entities.get(id));
  eq(e.mode.phase, 'live', 'tdm goes live');
  ok(e.mode.canDamage(a, b) === false && e.mode.canDamage(a, c) !== false, 'a and b are team-mates, c an enemy');
  const hulls = [];
  e.vehicles = new Proxy({ vehicles: new Map([['jeep-1', { id: 'jeep-1', type: 'jeep', team: e.mode.teamFor('a'), hp: 400, x: 61.5, y: 11, z: 41.5, yaw: 0 }]]),
    damage: (id, amount, attacker) => { // like the hull model: refuse the hull's own team
      const refused = !!attacker && e.mode.teamFor(attacker.id) === e.mode.teamFor('a');
      hulls.push({ id, amount, attacker: attacker?.id ?? null, refused }); return !refused; },
    snapshot: () => [] }, { get: (target, key) => (key in target ? target[key] : () => null) });
  const slab = (x) => { s.box(x, 11, 40, x, 14, 40, CONCRETE); s.box(x - 3, 15, 37, x + 3, 15, 43, CONCRETE); };
  slab(40); slab(62); slab(84);
  s.settle();
  const pin = (p, x) => Object.assign(p, { x, y: 11, z: 38.5, vx: 0, vz: 0, spawnProtected: false, spawnProtectedUntil: 0, hp: 100, armor: 0 });
  pin(b, 38.5); pin(c, 82.5); pin(a, 20.5);
  for (const x of [40, 62, 84]) for (let y = 11; y <= 14; y++) s.destroy(x, y, 40, 'a');
  for (let i = 0; i < 80; i++) { pin(b, 38.5); pin(c, 82.5); s.engine.step(); }
  eq([b.state, b.hp], ['alive', 100], 'a team-mate under your collapse takes no damage');
  ok(!s.kinds('hit').some(h => h.victim === 'b'), 'and no hit is reported for them');
  ok(s.kinds('kill').some(k => k.victim === 'c' && k.killer === 'a'), 'an enemy under it is killed and credited');
  ok(hulls.length >= 1 && hulls.every(h => h.attacker === 'a'), 'a friendly hull is only offered the credited hit');
  eq(hulls.filter(h => h.attacker === null).length, 0, 'a refused hull hit is not retried as world damage');
  // Your own collapse still kills you.
  Object.assign(a, { state: 'alive', hp: 100, armor: 0 });
  s.box(100, 11, 60, 100, 14, 60, CONCRETE); s.box(97, 15, 57, 103, 15, 63, CONCRETE);
  s.settle();
  for (let y = 11; y <= 14; y++) s.destroy(100, y, 60, 'a');
  for (let i = 0; i < 80 && a.state === 'alive'; i++) { Object.assign(a, { x: 98.5, y: 11, z: 58.5, vx: 0, vz: 0, spawnProtected: false, spawnProtectedUntil: 0 }); s.engine.step(); }
  ok(s.kinds('kill').some(k => k.victim === 'a' && k.w === COLLAPSE_WEAPON), 'your own collapse kills you');
}

// 20. A mass support loss creaks over several ticks: at most maxCreaksPerTick
// events and maxCreakCellsPerTick listed blocks per tick; each cluster still
// falls creakMs after its own creak.
{
  const s = scene();
  const slabs = [];
  for (let a = 0; a < 8; a++) for (let b = 0; b < 5; b++) {
    const x = 16 + a * 12, z = 16 + b * 13;
    s.box(x, 11, z, x, 13, z, WOOD);
    s.box(x - 2, 14, z - 2, x + 2, 14, z + 2, PLANK);
    slabs.push([x, z]);
  }
  s.settle();
  s.events.length = 0;
  for (const [x, z] of slabs) for (let y = 11; y <= 13; y++) s.destroy(x, y, z, 'bomber');
  s.settle();
  const creaks = s.kinds('creak'), perTick = new Map();
  for (const e of creaks) {
    const row = perTick.get(e.at) ?? { events: 0, cells: 0 };
    row.events++; row.cells += e.b.length / 4;
    perTick.set(e.at, row);
  }
  eq(creaks.length, slabs.length, 'every slab creaks once');
  ok(perTick.size > 1, `the creaks spread over ${perTick.size} ticks`);
  ok([...perTick.values()].every(row => row.events <= STRUCTURE_RULES.maxCreaksPerTick && row.cells <= STRUCTURE_RULES.maxCreakCellsPerTick),
    'no tick exceeds the creak caps');
  const creakAt = new Map(creaks.map(e => [e.id, e.at]));
  ok(s.kinds('collapse').every(e => e.at - creakAt.get(e.k) >= STRUCTURE_RULES.creakMs), 'each cluster falls creakMs after its own creak');
  ok(slabs.every(([x, z]) => s.world.getBlock(x, 14, z) === AIR), 'every slab fell');
  ok(s.kinds('collapse').every(e => s.creditOf(e) === 'bomber'), 'queued clusters keep their credit');
  assertFieldMatches(s, 'creak cap');
}

// 21. Ground material as building material (structure-ground.js): a stone
// tower and a sand wall on the stone floor are structural masonry and fall
// when cut; wide terrain stays ground; a large floating island stays ground,
// a small floating stone block is pinned at load (authored, it stays); bedrock
// is never demoted.
{
  const box = (set, x0, y0, z0, x1, y1, z1, type) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) set(x, y, z, type);
  };
  const s = scene({
    prebuild: (set) => {
      // A hollow 5x5 stone tower (y 11-20) with a stone roof.
      box(set, 20, 11, 20, 24, 20, 24, STONE);
      box(set, 21, 11, 21, 23, 19, 23, AIR);
      // A 1-thick, 12-long sand wall, 4 high.
      box(set, 30, 11, 20, 41, 14, 20, SAND);
      // A wide dirt hill (16x16, 4 high).
      box(set, 50, 11, 20, 65, 14, 35, DIRT);
      // A floating stone island of minComponent cells, and a small floating stone cube.
      box(set, 20, 26, 40, 35, 33, 55, STONE);
      box(set, 60, 30, 50, 62, 32, 52, STONE);
      // A thin bedrock pillar.
      box(set, 80, 11, 40, 80, 20, 40, BEDROCK);
    },
  });
  const field = s.structure.field, kind = (x, y, z) => field.kindAt(x, y, z);
  eq(GROUND_RULES.minComponent, 16 * 16 * 8, 'the floating test island is exactly minComponent cells');
  eq([kind(20, 15, 20), kind(22, 20, 22), kind(35, 12, 20)], [2, 2, 2], 'the stone tower, its roof and the sand wall are structural');
  eq([kind(57, 14, 27), kind(50, 11, 20), kind(30, 10, 20), kind(27, 30, 47), kind(80, 15, 40)], [1, 1, 1, 1, 1],
    'the hill (also its corner), the floor, the floating island and bedrock stay ground');
  eq(kind(61, 31, 51), 2, 'a small floating stone cube is building material');
  eq(field.read(60, 30, 50), PIN, 'it is pinned at load');
  ok(!field.props?.has(pack(60, 30, 50)), 'as authored floating geometry (not a prop)');
  eq(s.kinds('collapse').length, 0, 'nothing collapses at load');
  for (let x = 20; x <= 24; x++) for (let z = 20; z <= 24; z++) if (x === 20 || x === 24 || z === 20 || z === 24) s.destroy(x, 11, z, 'sapper');
  for (let x = 30; x <= 41; x++) s.destroy(x, 11, 20, 'sapper');
  s.destroy(62, 32, 52);
  s.settle();
  let tower = 0, wall = 0, cube = 0;
  for (let x = 20; x <= 24; x++) for (let y = 12; y <= 20; y++) for (let z = 20; z <= 24; z++) if (s.world.getBlock(x, y, z) === STONE) tower++;
  for (let x = 30; x <= 41; x++) for (let y = 12; y <= 14; y++) if (s.world.getBlock(x, y, 20) === SAND) wall++;
  for (let x = 60; x <= 62; x++) for (let y = 30; y <= 32; y++) for (let z = 50; z <= 52; z++) if (s.world.getBlock(x, y, z) === STONE) cube++;
  eq([tower, wall], [0, 0], 'cutting their base brings the stone tower and the sand wall down');
  eq(cube, 26, 'damage to the authored floating cube keeps the rest of it (a floating-at-load pin is never released)');
  ok(s.kinds('collapse').every(e => s.creditOf(e) === 'sapper' || s.creditOf(e) === null), 'collapses are credited to the cause');
  ok(s.kinds('collapseLand').filter(e => e.r > 0).length === 0, 'ground material leaves no rubble (it would land as ground)');
  // Placed after load, ground material is ground (an anchor) outside the
  // demoted cells and building material inside them.
  s.set(70, 15, 60, STONE);
  s.set(20, 11, 20, STONE);
  eq([kind(70, 15, 60), kind(20, 11, 20)], [1, 2], 'later ground blocks: anchors, except on demoted cells');
  s.settle();
  assertFieldMatches(s, 'ground material');
}

// 22. Prop pins: a pin on a structure that stood on the ground at load holds
// it only while the structure still reaches the ground. A 9x9 plank deck on
// a stone floor ring: its centre is pinned at load (beyond the plank span);
// cutting the posts drops the whole deck instead of leaving the pinned
// middle floating.
{
  const s = scene({
    prebuild: (set) => {
      for (const [x, z] of [[30, 30], [38, 30], [30, 38], [38, 38]]) for (let y = 11; y <= 14; y++) set(x, y, z, WOOD);
      for (let x = 30; x <= 38; x++) for (let z = 30; z <= 38; z++) set(x, 15, z, PLANK);
    },
  });
  const field = s.structure.field;
  eq(s.kinds('collapse').length, 0, 'the deck stands at load');
  const deckPins = field.pinKeys().filter(key => (key >> 20) === 15);
  ok(deckPins.length > 0 && deckPins.every(key => field.props?.has(key)), `its middle is held by ${deckPins.length} prop pin(s)`);
  s.destroy(31, 15, 31, 'sapper');
  s.settle();
  eq(s.world.getBlock(34, 15, 34), PLANK, 'damage while the deck still stands keeps the prop');
  eq(s.structure.stats.released, 0, 'no prop is released while the deck reaches the ground');
  for (const [x, z] of [[30, 30], [38, 30], [30, 38], [38, 38]]) s.destroy(x, 12, z, 'sapper');
  s.settle();
  let deck = 0;
  for (let x = 30; x <= 38; x++) for (let z = 30; z <= 38; z++) if (s.world.getBlock(x, 15, z) === PLANK) deck++;
  eq(deck, 0, 'cut off from the ground, the whole deck falls (the prop pin is released)');
  ok(s.structure.stats.released >= 1, 'the prop pin was released');
  ok(s.kinds('collapse').every(e => s.creditOf(e) === 'sapper'), 'the fall is credited to whoever cut the posts');
  assertFieldMatches(s, 'prop pins');
}

// 23. Load: a structure that stands only on the layer just cut is weighed.
// A hollow 7x7 brick tower (24-block ring, 16 high, roof slab) loses one
// side of its ring at y 12 and stands (the support rules carry the wall over
// the hole); cutting two more sides leaves one wall under it, its centre of
// mass is outside that footprint, and the whole tower topples toward it.
{
  const s = scene({
    prebuild: (set) => {
      for (let y = 11; y <= 26; y++) for (let x = 40; x <= 46; x++) for (let z = 40; z <= 46; z++) {
        if (x === 40 || x === 46 || z === 40 || z === 46) set(x, y, z, BRICK);
      }
      for (let x = 40; x <= 46; x++) for (let z = 40; z <= 46; z++) set(x, 27, z, BRICK);
    },
  });
  const above = () => { let n = 0; for (let y = 14; y <= 27; y++) for (let x = 40; x <= 46; x++) for (let z = 40; z <= 46; z++) if (s.world.getBlock(x, y, z) === BRICK) n++; return n; };
  const standing = above();
  for (let z = 40; z <= 46; z++) s.destroy(40, 12, z, 'sapper');
  s.settle();
  eq(above(), standing, 'one side cut: the tower stands on the other three');
  eq(s.structure.stats.overloads ?? 0, 0, 'nothing is overloaded');
  for (let x = 41; x <= 46; x++) { s.destroy(x, 12, 40, 'sapper'); s.destroy(x, 12, 46, 'sapper'); }
  s.settle();
  eq(above(), 0, 'three sides cut: the tower above the cut falls');
  eq(s.structure.stats.overloads, 1, 'one structure failed its load check');
  // The far wall's middle (beyond the brick span from the last wall) falls on its own first.
  const falls = s.kinds('collapse'), tower = falls.filter(e => e.n > 200);
  ok(tower.length > 0 && tower.every(e => e.v[0] < 0 && e.w[2] > 0), 'the tower topples toward its centre of mass (-x): drift and lean');
  ok(s.kinds('crumble').some(e => e.n === 5), 'the last wall gives way under it (5 blocks crumble)');
  ok(falls.every(e => s.creditOf(e) === 'sapper'), 'the fall is credited to whoever cut it');
  assertFieldMatches(s, 'load');
}

// 24. Load: a tall brick column on a narrow neck is crushed once the neck is
// thinned below what it carries (mass over STRUCTURE_LOAD of what is left).
{
  const s = scene({
    prebuild: (set) => {
      for (let y = 11; y <= 30; y++) for (let x = 60; x <= 64; x++) for (let z = 60; z <= 64; z++) set(x, y, z, BRICK);
    },
  });
  const above = () => { let n = 0; for (let y = 14; y <= 30; y++) for (let x = 60; x <= 64; x++) for (let z = 60; z <= 64; z++) if (s.world.getBlock(x, y, z) === BRICK) n++; return n; };
  // 25 x 18 = 450 bricks above y 12 (STRUCTURE_LOAD 80 each): 6 bricks (480) carry it, 4 (320) do not.
  // (This scene is built on top of the map template, so only cuts in one pass count.)
  const keep = new Set(['61,62', '62,62', '63,62', '62,61', '62,63', '61,61']);
  for (let x = 60; x <= 64; x++) for (let z = 60; z <= 64; z++) if (!keep.has(`${x},${z}`)) s.destroy(x, 12, z, 'sapper');
  s.settle();
  eq(above(), 425, 'a 6-brick neck carries the column (450 <= 480)');
  s.destroy(61, 12, 61, 'sapper'); s.destroy(63, 12, 62, 'sapper');
  s.settle();
  eq(above(), 0, 'a 4-brick neck does not: the column is crushed and falls');
  ok(s.kinds('collapse').every(e => s.creditOf(e) === 'sapper'), 'credited to the sapper');
}

console.log(`structure-test: ${passed} checks passed`);
