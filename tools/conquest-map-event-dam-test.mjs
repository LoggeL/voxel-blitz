// Redrock Dam breach (docs/conquest.md "Redrock Dam breach") on the real
// Redrock Canyon world: the flood field (deterministic, server and client
// builds bit-equal), the charges (one arms 35 s, the second cuts to 12 s,
// defuse), the spillway pool (four bombs), the bots' crossing-denial value,
// the breach and the flood (water carries and batters infantry, credited to
// the breacher; a jeep rides it, a tank stalls), settled-tile commits only,
// and the gameplay result: crest and wash ford closed for good, the canyon
// >= 2 m deep (tanks flooded), no lake-bed crossing, the north river kept,
// A-E road metres, flag C split onto two abutments; HUD read model, rematch.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';
import { AIR, MC_WATER, STONE, isSolidBlock } from '../shared/world/blocks.js';
import { WADE_RULES } from '../shared/vehicle-defs.js';
import { DAM_EVENT, DAM_TUNING } from '../shared/map-events/dam.js';
import { MAP_EVENT_DEFS, mapEventsFor } from '../shared/conquest-map-events.js';
import { FLOOD_KIND, LOCAL_FLOOD, buildDamFlood, createBoreField } from '../shared/world/flood-field.js';
import { createMapState } from '../shared/worlddata.js';
import { DamController } from '../server/modes/conquest/map-events/dam.js';
import { damPlan } from '../server/modes/conquest/map-events/dam-plan.js';
import { crossingDenialLocal, roadCost } from '../server/modes/conquest/map-events/dam-bots.js';
import { roadGraph } from '../server/bot-vehicle-driving.js';
import { closedCrossings } from '../server/bot-bridge.js';
import { hazardEscape } from '../server/bot-map-events.js';
import { DAM_PRESENTER, damMapState } from '../public/js/ui/conquest/map-events/dam.js';
import { TICK_MS, eventFixture, mapEventWireBytes } from './lib/map-event-fixtures.mjs';

assert(MAP_EVENT_DEFS.includes(DAM_EVENT) && mapEventsFor('redrock').includes(DAM_EVENT) && !mapEventsFor('frontier').includes(DAM_EVENT),
  'registered, Redrock only');

// ---------------------------------------------------------------- the field
const F = eventFixture({ map: 'redrock', defs: [DAM_EVENT], controllers: { dam: DamController } });
const { game, policy, system, world } = F;
const plan = damPlan(world, DAM_TUNING);
const field = plan.field, run = field.run;
{
  // A client builds it from its own (pristine) world: the same tables, bit for bit.
  const client = createMapState('redrock');
  const t0 = performance.now();
  const mine = buildDamFlood((x, y, z) => client.getBlock(x, y, z), DAM_TUNING.flood);
  const ms = performance.now() - t0;
  assert.equal(mine.hash(), field.hash(), 'server and client field tables are bit-equal');
  console.log(`flood field: built in ${field.buildMs.toFixed(0)} ms (client path ${ms.toFixed(0)} ms), ${run.steps} solver steps, hash ${field.hash()}, `
    + `${(run.eta.byteLength * 2 / 1024).toFixed(0)} KB of tables`);
}
const row = z => field.row(z), floorFeet = 21;   // the canyon floor's top voxel is y20
const fmt = z => `z${z} ${run.arrival[row(z)].toFixed(1)} s, peak ${(run.peak[row(z)] - floorFeet).toFixed(1)} m`;
assert(run.arrival[row(500)] > 10 && run.arrival[row(500)] < 20 && run.arrival[row(640)] < 45, `the wave reaches the trestle and the wash ford (${fmt(500)}, ${fmt(640)})`);
assert(run.peak[row(400)] - floorFeet > 4.5 && run.peak[row(400)] - floorFeet < 7, `about 5 m at the dam foot (${fmt(400)})`);
assert(run.peak[row(500)] < 31, 'the crest passes under the trestle deck (y32)');
for (let z = 404; z <= 767; z += 2) assert(field.rowLevel(z, Infinity) - floorFeet >= 2, `the canyon settles >= 2 m over its floor (z${z})`);
const lakeThalweg = [];
for (let z = DAM_TUNING.flood.lake.z0; z <= DAM_TUNING.flood.lake.z1; z++) {
  let deepest = Infinity;
  for (let x = 150; x <= 618; x++) if (field.kindAt(x, z) === FLOOD_KIND.lake) deepest = Math.min(deepest, field.floorAt(x, z));
  lakeThalweg.push(field.lakeFinal(z) - deepest);
}
const lakeMin = Math.min(...lakeThalweg);
assert(lakeMin > WADE_RULES.depth.tank, `no lake-bed crossing: the drained basin's channel stays ${lakeMin.toFixed(2)} m deep (tank wades ${WADE_RULES.depth.tank})`);
assert(Math.abs(field.lakeLevel(30) - (24 + 0.75)) < 1e-9, 'the basin falls 75 % of its 3 m in 30 s');
// The bore the ford sluices will use: a front at 5 m/s that lifts a reach by about a metre and decays.
{
  const bore = createBoreField({ box: { x0: 370, x1: 410, z0: 250, z1: 370 }, axis: 'z', dir: 1, base: 23, speed: 5, crest: 1, decayM: 60, endS: 60 });
  assert(bore.arrival(390, 300) === 10 && bore.level(390, 300, 9) === 23 && bore.level(390, 260, 6) > 23.3 && bore.wet(390, 22, 260, 6) === true && bore.wet(390, 23, 300, 6) === false, 'bore field');
}

// ---------------------------------------------------------------- charges
const [W, E] = DAM_TUNING.charges;
const a = F.player('a', 'alpha'), b = F.player('b', 'bravo');
F.run(TICK_MS * 2);
const dam = system.instance('dam');
assert(dam && dam.phase === 'idle');
const use = (p, key) => game.mode.conquestIntent(p, { type: 'support', support: 'use', targetId: key });
const key = id => `dam:${DAM_EVENT.points.findIndex(p => p.id === id)}`;
const hold = (p, id, ms = 5400) => { for (let t = 0; t < ms; t += 200) { use(p, key(id)); F.run(200); } };
const at = (p, c) => F.place(p, c.x, c.z, c.y);
const damScore = id => F.kinds('score').filter(e => e.id === id && e.reason === 'map_event').reduce((n, e) => n + e.pts, 0);
at(a, W); hold(a, 'plant-west', 4400);
assert.deepEqual([dam.phase, dam.team, F.kinds().at(-1).reason], ['armed', 'alpha', 'one'], 'one charge arms the event');
assert(Math.abs(dam.leftMs - (DAM_TUNING.fuse.oneMs - 400)) < 600, `one charge: a 35 s fuse (${dam.leftMs} ms left)`);
at(b, W); hold(b, 'defuse-west');
assert.equal(dam.phase, 'idle', 'the last charge defused calls it off');
assert.equal(damScore('b'), 200, 'a defuse pays 200');
at(a, W); hold(a, 'plant-west', 4400);
at(a, E); hold(a, 'plant-east', 4400);
assert.equal(F.kinds().at(-1).reason, 'fuse');
assert(dam.leftMs <= DAM_TUNING.fuse.bothMs, `the second charge cuts the fuse to 12 s (${dam.leftMs} ms)`);
assert.equal(damScore('a'), 0, 'G3: planting pays nothing until the charges go off');
assert.deepEqual(F.decoded().events[0].extra, [3], 'ev extra: both charges set');

// ---------------------------------------------------------------- bots: the crossing denial
{
  const tank = game.vehicles.vehicles.get('bravo-tank');
  const home = { x: tank.x, y: tank.y, z: tank.z };
  // An EAST tank on the crest heading for WEST's flags: closing the crest and the wash ford costs it the detour.
  Object.assign(tank, { x: 400.5, y: 35.02, z: 384.5 });
  const v = crossingDenialLocal(game, 'alpha', ['redrock-dam', 'wash-ford']);
  assert(v > DAM_TUNING.bots.value.plant, `an enemy tank working the crest makes the breach worth ${v.toFixed(0)} m to WEST`);
  assert(crossingDenialLocal(game, 'bravo', ['redrock-dam', 'wash-ford']) < DAM_TUNING.bots.value.defuse, 'and costs EAST as much: its bots defuse');
  Object.assign(tank, home);
}

// ---------------------------------------------------------------- siren and breach
const victim = F.player('victim', 'bravo'), mate = F.player('mate', 'alpha');
F.runUntil(() => dam.phase === 'warning', DAM_TUNING.fuse.bothMs + 1000);
assert(closedCrossings(game).has('redrock-dam'), 'the crest closes for bot drivers at the siren');
assert(hazardEscape(game, { x: 380, y: 21.5, z: 420 }, 'bravo'), 'bots leave the canyon floor ahead of the water');
F.runUntil(() => dam.phase === 'active', 11000);
assert.equal(dam.phase, 'active');
F.run(TICK_MS);
assert.equal(damScore('a'), 300, 'G3: the breach pays the planter who armed it the final blow (300)');
// A WEST body and an EAST body on the canyon floor ahead of the wave; a WEST jeep and an EAST tank down there too.
F.place(victim, 382, 452); F.place(mate, 386, 455);
const jeep = game.vehicles.vehicles.get('alpha-jeep'), tank = game.vehicles.vehicles.get('bravo-tank');
Object.assign(jeep, { x: 380.5, z: 440.5, y: 21, yaw: 0, speed: 0 });
Object.assign(tank, { x: 384.5, z: 560.5, y: 21, yaw: 0, speed: 0 });
const start = { victim: victim.z, jeep: jeep.z };
// A block the round built in the canyon since the template (the trestle's berm): the commits keep it.
const berm = plan.commits.find(j => j.cells[3] === MC_WATER).cells;
world.setBlock(berm[0], berm[1], berm[2], STONE);
let peak = 0, ticks = 0, deltas = 0, deltaPeakS = 0, deltasFirst20 = 0, bucket = 0, bucketT = 0, maxDepthTank = 0, floodedTank = false, victimDied = false, victimZ = victim.z, mateHurt = false, jeepWrecked = false, jeepZ = jeep.z, tankWrecked = false;
const t0 = performance.now();
while (dam.phase !== 'done' && ticks * TICK_MS < 200000) {
  const s = performance.now(); game.step(TICK_MS); peak = Math.max(peak, performance.now() - s); ticks++;
  const n = F.snap.blocks?.length ?? 0;
  deltas += n; bucket += n;
  if (ticks * TICK_MS < 20000 && ticks * TICK_MS > 4000) deltasFirst20 += n;
  if (ticks * TICK_MS - bucketT >= 1000) { deltaPeakS = Math.max(deltaPeakS, bucket); bucket = 0; bucketT = ticks * TICK_MS; }
  if (victim.state !== 'alive') victimDied = true; else if (!victimDied) victimZ = Math.max(victimZ, victim.z);
  if (mate.state !== 'alive' || mate.hp < 100) mateHurt = true;
  if (!(jeep.hp > 0)) jeepWrecked = true; else if (!jeepWrecked) jeepZ = Math.max(jeepZ, jeep.z);
  if (!(tank.hp > 0)) tankWrecked = true;
  if (!tankWrecked) { maxDepthTank = Math.max(maxDepthTank, game.vehicles.waterDepth(tank)); floodedTank ||= game.vehicles.flooded(tank); }
}
const wall = performance.now() - t0;
assert.equal(dam.phase, 'done', 'the breach ends once the field has settled and every commit is applied');
const kills = F.kinds('kill');
const carried = victimZ - start.victim;
assert(carried > 20, `the wave takes the EAST body downstream (${carried.toFixed(0)} m${victimDied ? ', then kills it' : ''})`);
assert(!victimDied || kills.some(k => k.victim === 'victim' && k.w === 'damFlood' && k.killer === 'a'), 'a flood kill is credited to the breacher');
assert(mateHurt, 'the water spares nobody: the breacher\'s teammate is hurt too');
assert(!kills.some(k => k.victim === 'mate' && k.killer === 'a'), 'but a teammate killed by it is no team kill');
assert(jeepZ - start.jeep > 15, `the jeep is carried downstream (${(jeepZ - start.jeep).toFixed(0)} m${jeepWrecked ? ', then wrecked' : ''})`);
assert(floodedTank && maxDepthTank > WADE_RULES.depth.tank, `the tank in the canyon stalls (${maxDepthTank.toFixed(2)} m over its floor)`);
// Settled voxels: the canyon 2 m higher, the basin at the sill, the north river and its ford untouched.
assert.equal(world.getBlock(384, 33, 384), AIR, 'the crest middle is gone');
assert(isSolidBlock(world.getBlock(384, DAM_TUNING.breach.y0 - 1, 384)), 'the raised sill stays');
let wet = 0, dry = 0, cells = 0;
for (const job of plan.commits) for (let i = 0; i < job.cells.length; i += 4) {
  cells++;
  const v = world.getBlock(job.cells[i], job.cells[i + 1], job.cells[i + 2]);
  if (job.cells[i + 3] === AIR) dry += v === AIR; else wet += v === MC_WATER;
}
assert.equal(dry, plan.counts.drained, 'every basin cell above the sill drained');
assert.equal(wet, plan.counts.canyon - 1, 'the canyon\'s new water stands');
assert.equal(world.getBlock(berm[0], berm[1], berm[2]), STONE, 'around a block the round built there (the trestle\'s berm)');
// Joiner: the map-cache patch of every changed cell.
const frame = world.mapFrame?.({ cached: true });
const joinerKB = frame ? deflateSync(frame).length / 1024 : 0;
assert(joinerKB < 200, `a joiner's patch stays under 200 KB deflated (${joinerKB.toFixed(0)} KB)`);
assert.equal(world.getBlock(380, 22, 560), MC_WATER, 'canyon floor water y21-22 (top of the floor y20)');
assert.equal(world.getBlock(384, 26, 190), MC_WATER, 'the north river keeps its level (no drain beyond the basin)');
assert.equal(world.getBlock(384, 23, 330), MC_WATER, 'the basin keeps its water up to the sill');
const tankWade = (x, z) => game.vehicles.waterDepth({ x, z, y: field.floorAt(x, z), type: 'tank' });
assert(tankWade(380, 560) > WADE_RULES.depth.tank && tankWade(384, 640) > WADE_RULES.depth.tank, 'canyon floor and wash ford flood every hull for the round');
assert(closedCrossings(game).has('wash-ford') && closedCrossings(game).has('redrock-dam'), 'crest and wash ford closed for bot drivers');
// Route metres: A to E (the paved axis), with the crest and the wash ford shut.
const graph = roadGraph(game), flag = id => policy.flags.find(f => f.id === id);
const AE = roadCost(graph, flag('A'), [flag('E')]), AEshut = roadCost(graph, flag('A'), [flag('E')], new Set(['redrock-dam', 'wash-ford']));
const BD = roadCost(graph, flag('B'), [flag('D')]), BDshut = roadCost(graph, flag('B'), [flag('D')], new Set(['redrock-dam', 'wash-ford']));
assert(AEshut - AE > 100 && BDshut - BD > 100, 'the breach costs A-E and B-D over 100 m of road');
// Flag C: two abutments, at least five spawn cells each, all standable and dry.
const C = F.meta.conquest.flags.find(f => f.id === 'C');
const standable = s => isSolidBlock(world.getBlock(Math.floor(s.x), Math.floor(s.y) - 1, Math.floor(s.z)))
  && [0, 1].every(dy => { const v = world.getBlock(Math.floor(s.x), Math.floor(s.y) + dy, Math.floor(s.z)); return !isSolidBlock(v) && v !== MC_WATER; });
const west = C.spawns.filter(s => s.x < 374 && standable(s)).length, east = C.spawns.filter(s => s.x > 394 && standable(s)).length;
assert(west >= 5 && east >= 5, `flag C spawns ${west}/${east} on the abutments`);
console.log(`dam breach: ${fmt(400)}, ${fmt(500)}, ${fmt(640)}, ${fmt(766)}; canyon final ${(field.rowLevel(766, Infinity) - floorFeet).toFixed(2)}-${(field.rowLevel(404, Infinity) - floorFeet).toFixed(2)} m `
  + `over the floor; basin channel >= ${lakeMin.toFixed(2)} m; tank ${maxDepthTank.toFixed(2)} m deep, flooded; body carried ${carried.toFixed(0)} m, jeep ${(jeepZ - start.jeep).toFixed(0)} m${jeepWrecked ? ' (wrecked)' : ''}; `
  + `A-E ${AE.toFixed(0)} -> ${AEshut.toFixed(0)} m (+${(AEshut - AE).toFixed(0)}), B-D +${(BDshut - BD).toFixed(0)} m; C spawns ${west}/${east}; joiner patch ${(frame?.byteLength / 1024).toFixed(0)} KB (${joinerKB.toFixed(0)} KB deflated)`);
console.log(`dam breach: ${ticks} ticks (${(ticks * TICK_MS / 1000).toFixed(0)} s), peak tick ${peak.toFixed(2)} ms, avg ${(wall / ticks).toFixed(2)} ms; `
  + `${plan.counts.jobs} tile commits, ${cells} cells (${plan.counts.drained} drained, ${plan.counts.canyon} canyon), block deltas ${deltas} in all, `
  + `${deltasFirst20} from 4-20 s, peak ${deltaPeakS} a second; plan ${plan.buildMs.toFixed(0)} ms once per template`);

// ---------------------------------------------------------------- HUD and wire
{
  const ev = F.decoded().events[0];
  assert.deepEqual([damMapState(ev).breached, damMapState(ev).phase], [true, 'done']);
  assert.equal(typeof DAM_PRESENTER.paintMap, 'function');
  // The HUD reads the same field the world FX builds (LOCAL_FLOOD): the basin's level and the front at sinceDs.
  const live = { id: 'dam', phase: 'active', extra: [3, 100] };
  const guess = damMapState(live);
  LOCAL_FLOOD.add('dam', field, 0);
  const read = damMapState(live);
  assert(Math.abs(read.drain - (27 - field.lakeLevel(10)) / 3) < 1e-9 && read.front === field.front(10) && Math.abs(guess.front - read.front) < 30,
    `HUD: drain ${read.drain.toFixed(2)}, front z${read.front} at 10 s (estimate without the field z${guess.front})`);
  const banner = DAM_PRESENTER.banner({ kind: 'map_event', event: 'dam', phase: 'active' }, { nowMs: 1000 }, { title: 'REDROCK DAM · DAM BREACHED', holdMs: 3000 });
  assert(banner.countdown.label === 'FLOOD AT TRESTLE' && Math.abs(banner.countdown.until - 1000 - run.arrival[row(500)] * 1000) < 1 && /TRESTLE/.test(banner.detail),
    'the breach banner counts the wave to the trestle, the last southern crossing');
  LOCAL_FLOOD.clear();
  assert(mapEventWireBytes(F.snap.match.conquest) <= 60, `ev stays small (${mapEventWireBytes(F.snap.match.conquest)} B)`);
}

// ---------------------------------------------------------------- the spillway path, rematch
policy.reset();
F.run(TICK_MS * 2);
assert(isSolidBlock(world.getBlock(384, 33, 384)) && world.getBlock(372, 26, 360) === world.templateBlock(372, 26, 360), 'restoreWorld rebuilds the dam and refills the lake');
assert(system.instance('dam').phase === 'idle' && !closedCrossings(game).size && !world.flood.active, 'idle again, every crossing open, no field');
{
  const box = DAM_TUNING.spillway.boxes[0], hit = [(box.x0 + box.x1 + 1) / 2, 28, box.z1 + 1];
  const pilot = F.player('pilot', 'bravo');
  for (let i = 0; i < 3; i++) policy.onBlast(hit, { key: 'jetBomb', radius: 6, ownerId: 'b' });
  assert.equal(system.instance('dam').phase, 'idle', 'three bombs wear the spillway down');
  policy.onBlast(hit, { key: 'jetBomb', radius: 6, ownerId: 'pilot' });
  const d = system.instance('dam');
  F.run(TICK_MS);
  assert.deepEqual([d.phase, F.kinds().at(-1).reason, d.team], ['warning', 'spillway', 'bravo'], 'the fourth breaks it: the spillway fails');
  F.runUntil(() => d.phase === 'active', 5000);
  F.run(TICK_MS);
  assert.equal(damScore('pilot'), 300, 'the final blow on the spillway pays 300');
  assert(damScore('b') - 200 > 100, 'the other bombs earn their assist');
}
console.log('dam breach: field, charges and fuse, spillway pool, crossing denial, flood physics, settled commits, crossings, route metres, C spawns, HUD, rematch passed');
process.exit(0);
