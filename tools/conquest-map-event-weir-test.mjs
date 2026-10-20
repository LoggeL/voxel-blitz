// Frontier sluice weir (docs/conquest.md "Sluice weir") on the real Frontier
// world with the weir's own controller:
//  - the structure (gate leaves, pass, walkway, wheel) and the definition;
//  - bots open it for enemy armour at a ford or their own boat, not with their own armour in one;
//  - hold-to-use -> horn -> surge: both fords at 3 m, gates up, bot drivers route off the fords;
//  - the depth rule: a jeep fords the authored metre, jeeps and tanks stall in the flood,
//    a boat crosses a flooded ford at full speed (and fordShallow reads it deep);
//  - the recession restores every voxel and shuts the gates; cooldown, cap of 3 (Breakthrough),
//    rematch mid-flood; the HUD flood patches and the FX hook.
import assert from 'node:assert/strict';
import { AIR, MC_WATER, RUST, CONCRETE } from '../shared/world/blocks.js';
import { WEIR, WEIR_EVENT } from '../shared/map-events/weir.js';
import { MAP_EVENT_DEFS, defineMapEvent, mapEventsFor } from '../shared/conquest-map-events.js';
import { WADE_RULES } from '../shared/vehicle-defs.js';
import { BOAT_RULES } from '../shared/vehicle-handling/boat.js';
import { WeirController, weirFloodCells } from '../server/modes/conquest/map-events/weir.js';
import { MapEventSystem } from '../server/modes/conquest/map-events/system.js';
import { eventClosedCrossings, planMapEventTasks } from '../server/bot-map-events.js';
import { vehicleRoute } from '../server/bot-vehicle-driving.js';
import { fordShallow } from '../server/bot-boat-driving.js';
import { WEIR_PRESENTER, weirFloodPatches } from '../public/js/ui/conquest/map-events/weir.js';
import { MAP_EVENT_PRESENTERS } from '../public/js/ui/conquest/map-events/registry.js';
import { MAP_EVENT_FX } from '../public/js/fx/map-events/registry.js';
import { MapEventFx } from '../public/js/fx/map-event-fx.js';
import { ICON_PATHS } from '../public/js/ui/conquest/icons.js';
import { TICK_MS, eventFixture, groundY, mapEventWireBytes } from './lib/map-event-fixtures.mjs';

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** Top of the highest water voxel over the first solid at or below y 30, minus that solid's top (m of water). */
function depthAt(world, x, z) {
  let face = null;
  for (let y = 30; y > 0; y--) {
    const b = world.getBlock(x, y, z);
    if (b === MC_WATER) { face ??= y + 1; continue; }
    if (b !== AIR) return face == null ? 0 : face - (y + 1);
  }
  return 0;
}

// ---------------------------------------------------------------- definition and structure
assert(MAP_EVENT_DEFS.includes(WEIR_EVENT), 'the weir fills its registry slot');
assert.ok(mapEventsFor('frontier').some(d => d.id === 'weir'), 'the weir is registered on Frontier');
assert.equal(mapEventsFor('atlastest').length, 0, 'Frontier only');
assert.deepEqual([WEIR_EVENT.kind, WEIR_EVENT.repeat.max, WEIR_EVENT.repeat.cooldownMs, WEIR_EVENT.durations.warningMs, WEIR_EVENT.durations.activeMs],
  ['levolution', 3, 240000, 6000, 120000]);
assert.equal(MAP_EVENT_PRESENTERS.weir, WEIR_PRESENTER);
assert(MAP_EVENT_FX.weir && ICON_PATHS['event-weir'], 'FX hook and the wheel glyph');

const F = eventFixture({ defs: [WEIR_EVENT], controllers: { weir: WeirController } });
const { game, policy, system, world, meta } = F;
const fordN = meta.conquest.crossings.find(c => c.id === 'ford-north'), fordS = meta.conquest.crossings.find(c => c.id === 'ford-south');
const bay = WEIR.bays[0];
const shutCell = [bay.x0 + 1, WEIR_EVENT.tuning.riverFace - 1, WEIR.gateZ];
assert.equal(world.getBlock(...shutCell), RUST, 'the shut west leaf');
assert.equal(world.getBlock(bay.x0 + 1, WEIR.openY[0], WEIR.gateZ), AIR, 'the gantry hangs empty');
assert.equal(world.getBlock(388, 20, WEIR.gateZ), MC_WATER, 'the pass is open water (the boat lane)');
for (let y = 22; y < WEIR.deckY; y++) assert.equal(world.getBlock(388, y, WEIR.walk.z0), AIR, 'clear under the walkway');
assert.equal(world.getBlock(388, WEIR.deckY, WEIR.walk.z0), CONCRETE, 'the walkway deck');
assert.notEqual(world.getBlock(WEIR.wheel.x, WEIR.wheel.y, WEIR.wheel.z), AIR, 'the wheel hub');
const wheel = WEIR_EVENT.points[0];
assert(Math.abs(groundY(world, wheel.x, wheel.z) - wheel.y) < 0.05, 'the wheel point stands on the platform');
assert.equal(depthAt(world, Math.floor(fordN.x), Math.floor(fordN.z)), 1, 'ford-north: the authored metre');
assert.equal(depthAt(world, Math.floor(fordS.x), Math.floor(fordS.z)), 1, 'ford-south: the authored metre');
assert(fordShallow(world, fordN) && fordShallow(world, fordS), 'a boat scrapes the dry-season fords');
const before = new Map();
const floodPlan = weirFloodCells(world, WEIR_EVENT.tuning);
for (let i = 0; i < floodPlan.length; i += 3) before.set(`${floodPlan[i]},${floodPlan[i + 1]},${floodPlan[i + 2]}`, AIR);
for (let i = 0; i < floodPlan.length; i += 3) {
  const [x, y, z] = [floodPlan[i], floodPlan[i + 1], floodPlan[i + 2]];
  assert(y >= 22 && y < WEIR_EVENT.tuning.coreFace, 'flood cells rise from the river face');
  assert(world.getBlock(x, y - 1, z) === MC_WATER || before.has(`${x},${y - 1},${z}`), 'over water only, never onto a bank');
}
console.log(`weir: ${floodPlan.length / 3} flood cells over both fords`);

const a = F.player('a', 'alpha'), b = F.player('b', 'bravo'), a2 = F.player('a2', 'alpha');
F.run(TICK_MS * 2);
assert.equal(game.mode.phase, 'live');
const ev = system.instance('weir');
assert(ev && ev.phase === 'idle' && ev.controller instanceof WeirController);
const vehicles = game.vehicles;
const hull = (type, team) => [...vehicles.vehicles.values()].find(v => v.type === type && v.team === team);

/** Drive a crewed hull for `ms` with fixed controls; returns its path length. */
function drive(p, v, ms, { throttle = 1, steer = 0 } = {}) {
  const x0 = v.x, z0 = v.z;
  p.input = { ...(p.input ?? {}), keys: {}, vehicleThrottle: throttle, vehicleSteer: steer, vehicleBrake: 0, vehicleLift: 0 };
  F.run(ms);
  return Math.hypot(v.x - x0, v.z - z0);
}
function seat(p, v, x, z, yaw, y = null) {
  if (p.vehicleId) vehicles.exit(p);
  Object.assign(v, { x, z, yaw, speed: 0, yawRate: 0, vx: 0, vy: 0, vz: 0 });
  v.y = y ?? (groundY(world, x, z) ?? v.y);
  F.place(p, x, z, v.y);
  assert(vehicles.enter(p, v.id, 'driver') !== false, `${p.id} drives ${v.id}`);
}
const EAST = -Math.PI / 2, SOUTH = Math.PI;

/** A crewed boat sent down ford-north at 14 m/s, full throttle, from a water face: its lowest speed over the ford. */
function boatCross(face) {
  const boat = hull('boat', 'bravo');
  seat(b, boat, 392.5, fordN.z - 3.5, SOUTH, face - BOAT_RULES.draft);
  boat.speed = 14;
  b.input = { keys: {}, vehicleThrottle: 1, vehicleSteer: 0, vehicleBrake: 0 };
  let slow = Infinity;
  for (let t = 0; t < 1000; t += 50) { F.run(50); slow = Math.min(slow, boat.speed); }
  vehicles.exit(b);
  // Out of the way of the next hull: moored upstream of the weir.
  Object.assign(boat, { x: 389.5, z: 232.5, y: WEIR_EVENT.tuning.riverFace - BOAT_RULES.draft, speed: 0 });
  return slow;
}

// ---------------------------------------------------------------- the authored ford passes a jeep, scrapes a boat
{
  const slow = boatCross(WEIR_EVENT.tuning.riverFace);
  assert(slow < BOAT_RULES.shallowSpeed + 1, `a boat drags over the authored ford (min ${slow.toFixed(1)} m/s)`);
  const jeep = hull('jeep', 'alpha');
  seat(a, jeep, 372.5, fordN.z + 0.5, EAST);
  drive(a, jeep, 6000);
  assert(jeep.x > 404 && !jeep.flooded, `a jeep fords the authored metre (x ${jeep.x.toFixed(1)})`);
  vehicles.exit(a);
}

// ---------------------------------------------------------------- bots: when to open it
const brains = [{ id: 'a' }, { id: 'a2' }];
const commander = { game, teamBrains: () => brains, kitOf: () => 'assault' };
const plan = () => {
  const ts = { team: 'alpha', squads: new Map(), crews: new Map(), hitches: new Map(), memberSquad: new Map() };
  policy._view = null;
  planMapEventTasks(commander, ts, game.now);
  return ts;
};
{
  a.bot = true; a2.bot = true;
  F.place(a, wheel.x + 30, wheel.z - 20); F.place(a2, wheel.x - 25, wheel.z - 30);
  assert.equal(plan().eventAssign.size, 0, 'no task without a threat');
  const tank = hull('tank', 'bravo');
  seat(b, tank, 420.5, fordN.z + 0.5, -EAST);
  const ts = plan();
  assert.equal([...ts.eventAssign.values()].filter(id => id === 'weir:use:wheel').length, 1, 'enemy armour at a ford: one bot turns the wheel');
  const own = hull('tank', 'alpha');
  const ownSpot = { x: 368.5, z: fordN.z + 4.5 };
  Object.assign(own, { x: ownSpot.x, z: ownSpot.z, y: groundY(world, ownSpot.x, ownSpot.z) });
  F.place(F.player('a3', 'alpha'), ownSpot.x, ownSpot.z); vehicles.enter(game.entities.get('a3'), own.id, 'driver');
  assert.equal(plan().eventAssign.size, 0, 'not with its own armour in reach of a ford');
  vehicles.exit(game.entities.get('a3'));
  vehicles.exit(b);
  const boat = hull('boat', 'alpha');
  seat(game.entities.get('a3'), boat, 389.5, 240.5, SOUTH, WEIR_EVENT.tuning.riverFace - BOAT_RULES.draft);
  assert.equal([...plan().eventAssign.values()].filter(id => id === 'weir:use:wheel').length, 1, 'its own boat on the reach: open the fords for it');
  vehicles.exit(game.entities.get('a3'));
  a.bot = false; a2.bot = false;
}

const probe = { id: 'probe', type: 'jeep', team: 'bravo', x: 330.5, z: 268.5, y: groundY(world, 330.5, 268.5), yaw: 0, spawn: null };
const probeGoal = { x: 450, y: 25, z: 272 };
policy._view = null;
assert(vehicleRoute(game, probe, probeGoal).some(p => flat(p, fordN) < 12), 'at normal water the road runs over ford-north');

// ---------------------------------------------------------------- hold the wheel: horn, surge
const use = p => game.mode.conquestIntent(p, { type: 'support', support: 'use', targetId: 'weir:0' });
F.place(a, wheel.x, wheel.z, wheel.y);
F.events.length = 0;
for (let t = 0; t < 5400 && ev.phase === 'idle'; t += 200) { use(a); F.run(200); }
assert.equal(ev.phase, 'warning', 'a 5 s hold opens the sluice');
assert.equal(ev.team, 'alpha');
assert(F.kinds().some(e => e.event === 'weir' && e.phase === 'warning'), 'the horn event');
assert.deepEqual([...eventClosedCrossings(game)].sort(), ['ford-north', 'ford-south'], 'bot drivers keep off both fords from the horn');
assert(!F.snap.match.conquest.evp?.length, 'the wheel is spent while the gates run');
{
  // A road route across the river no longer runs over ford-north.
  const route = vehicleRoute(game, probe, probeGoal);
  assert(!route.some(p => flat(p, fordN) < 12), 'the route avoids the flooded ford');
}
F.runUntil(() => ev.phase === 'active', 7000);
assert.equal(ev.phase, 'active');
const c = ev.controller;
const changed0 = game.changedBlocks.size;
let ticks = 0;
while (c.stage === 'rising' && ticks < 5000) { game.step(TICK_MS); ticks++; }
assert.equal(c.stage, 'high', 'the surge finishes');
assert(game.changedBlocks.size - changed0 >= c.total - 2 * WEIR_EVENT.tuning.surgeCellsPerTick, `${game.changedBlocks.size - changed0} of ${c.total}: ` + 'every surge cell is a map-cache delta (a joiner loads the flood)');
const stats = system.edits.stats;
console.log(`weir: surge ${c.total} cells in ${ticks} ticks (${(ticks * TICK_MS / 1000).toFixed(1)} s), edit step max ${stats.maxTickMs.toFixed(3)} ms`);
assert(ticks * TICK_MS < 8000, 'the fords flood within seconds of the horn');
assert(stats.maxTickMs < 2, 'the edit step stays far below a long tick');
for (const f of [fordN, fordS]) assert.equal(depthAt(world, Math.floor(f.x), Math.floor(f.z)), 3, `${f.id}: 3 m of water`);
assert.equal(world.getBlock(...shutCell), MC_WATER, 'the west leaf is up: the bay runs');
assert.equal(world.getBlock(bay.x0 + 1, WEIR.openY[0], WEIR.gateZ), RUST, 'and hangs in its gantry');
assert(!fordShallow(world, fordN) && !fordShallow(world, fordS), 'a flooded ford reads deep');
const row = F.decoded().events.find(e => e.id === 'weir');
assert.deepEqual([row.phase, row.progress], ['active', 1], 'the flood gauge on the wire');
assert(mapEventWireBytes(F.snap.match.conquest) <= 200, 'within the event wire budget');
const patches = weirFloodPatches(row);
assert.deepEqual(patches.map(p => p.id), ['ford-north', 'ford-south']);
assert(patches.every(p => p.strength === 1), 'the HUD paints both fords at full strength');
assert.equal(weirFloodPatches({ progress: 0 }).length, 0, 'and nothing at normal water');

// ---------------------------------------------------------------- the depth rule in the flood
{
  for (const type of ['jeep', 'tank']) {
    const v = hull(type, 'bravo');
    seat(b, v, 386.5, fordN.z + 0.5, EAST);
    const moved = drive(b, v, 3000);
    assert(v.flooded && moved < 3.5 && Math.abs(v.speed) <= WADE_RULES.crawl + 1e-6, `a ${type} stalls in 3 m of water (moved ${moved.toFixed(2)} m)`);
    vehicles.exit(b);
  }
  const boat = hull('boat', 'bravo');
  const slow = boatCross(WEIR_EVENT.tuning.coreFace);
  assert(slow > 12, `a boat crosses the flooded ford at full speed (min ${slow.toFixed(1)} m/s)`);
}

// ---------------------------------------------------------------- recession, cooldown
F.runUntil(() => ev.phase === 'cooldown', 121000);
assert.equal(ev.phase, 'cooldown', 'two minutes of high water');
policy._view = null;
assert(c.stage === 'falling' && eventClosedCrossings(game).size === 2, 'the fords stay closed while they drain');
F.runUntil(() => c.stage === 'low', 10000);
assert.equal(c.stage, 'low', 'the water recedes');
policy._view = null;
assert.equal(eventClosedCrossings(game).size, 0, 'the fords reopen to bot drivers');
for (const f of [fordN, fordS]) assert.equal(depthAt(world, Math.floor(f.x), Math.floor(f.z)), 1, `${f.id}: back to the authored metre`);
for (const key of before.keys()) assert.equal(world.getBlock(...key.split(',').map(Number)), AIR, 'every flood cell drains');
assert.equal(world.getBlock(...shutCell), RUST, 'the gates shut');
assert.equal(world.getBlock(bay.x0 + 1, WEIR.openY[0], WEIR.gateZ), AIR);
assert.equal(F.decoded().events.find(e => e.id === 'weir')?.progress ?? 0, 0);
assert(!F.snap.match.conquest.evp?.length, 'no wheel through the cooldown');

// ---------------------------------------------------------------- rematch mid-flood
ev.endsAt = system.now;
F.runUntil(() => ev.phase === 'idle', 250000);
assert.equal(ev.phase, 'idle', 'the cooldown ends');
assert(F.snap.match.conquest.evp?.length, 'the wheel turns again');
assert(ev.trigger({ team: 'bravo' }));
F.runUntil(() => c.stage === 'high', 15000);
assert.equal(depthAt(world, Math.floor(fordN.x), Math.floor(fordN.z)), 3);
policy.reset();
F.run(TICK_MS * 2);
assert.equal(depthAt(world, Math.floor(fordN.x), Math.floor(fordN.z)), 1, 'a rematch restores the river');
assert.equal(world.getBlock(...shutCell), RUST, 'and the gates');
assert.deepEqual([system.instance('weir').phase, system.instance('weir').controller.stage, system.edits.jobs.length], ['idle', 'low', 0]);

// ---------------------------------------------------------------- Breakthrough, the cap of three
{
  const QUICK = defineMapEvent({ ...WEIR_EVENT, durations: { warningMs: 1000, activeMs: 6000 }, repeat: { cooldownMs: 6000, max: 3 } });
  const bt = new MapEventSystem({ mapMeta: { id: 'frontier' }, variant: 'breakthrough', now: 0 }, { defs: [WEIR_EVENT] });
  bt.reset();
  assert.ok(bt.instances.some(i => i.id === 'weir'), 'the weir runs in Breakthrough');
  const G = eventFixture({ variant: 'breakthrough', defs: [QUICK], controllers: { weir: WeirController } });
  G.player('x', 'alpha');
  G.run(TICK_MS * 2);
  const e = G.system.instance('weir');
  const fires = [];
  for (let n = 0; n < 4; n++) {
    G.runUntil(() => e.phase === 'idle' || e.phase === 'done', 20000);
    if (e.phase === 'done') break;
    assert(e.trigger({ team: 'alpha' }), `flood ${n + 1}`);
    fires.push(n);
    G.runUntil(() => e.phase === 'cooldown' || e.phase === 'done', 20000);
    G.runUntil(() => e.controller.stage === 'low', 10000);
    assert.equal(depthAt(G.world, Math.floor(fordN.x), Math.floor(fordN.z)), 1, 'each flood drains');
  }
  assert.deepEqual([fires.length, e.phase], [3, 'done'], 'three floods a match');
  assert(!e.trigger({ team: 'alpha' }), 'a spent sluice stays shut');
}
// ---------------------------------------------------------------- FX hook (presentation only)
{
  const calls = [];
  const audio = { structureCreak: (pos, o) => calls.push(['creak', o.material]), structureImpact: () => calls.push(['impact']), vehicleWadeSplash: () => calls.push(['splash']) };
  const fx = { emit: kind => { calls.push(['puff', kind]); return 1; }, addEmitter: spec => ({ spec }), removeEmitter: () => true };
  const kit = new MapEventFx({ audio, fx, cameraShake: { add: () => {} }, getCamera: () => ({ position: { x: 388, y: 30, z: 270 } }) });
  kit.mapId = 'frontier';
  assert.equal(kit.handleEvent({ kind: 'map_event', event: 'weir', phase: 'warning' }), true);
  assert.equal(calls.filter(c => c[0] === 'creak' && c[1] === 'metal').length, WEIR.bays.length, 'the winches creak at both bays');
  assert.equal(kit.handleEvent({ kind: 'map_event', event: 'weir', phase: 'active' }), true, 'the weir replaces the generic strike');
  assert(calls.some(c => c[0] === 'puff' && c[1] === 'water') && calls.some(c => c[0] === 'splash'));
  assert.equal(kit.emitters.size, WEIR.bays.length, 'spill spray at both bays while the surge rises');
  MAP_EVENT_FX.weir.sync({ id: 'weir', phase: 'active', progress: 1 }, kit);
  assert.equal(kit.emitters.size, 0, 'and none at high water');
  MAP_EVENT_FX.weir.sync({ id: 'weir', phase: 'active', progress: 0.4 }, kit);
  assert.equal(kit.emitters.size, WEIR.bays.length, 'a joiner mid-surge gets the spray from the snapshot');
  kit.handleEvent({ kind: 'map_event', event: 'weir', phase: 'cooldown' });
  assert.equal(kit.emitters.size, 0, 'the spray stops as the water recedes');
}
console.log('conquest-map-event-weir-test: ok');
