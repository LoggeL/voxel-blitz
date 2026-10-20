// Kestrel Halt grain elevator topple (docs/conquest.md "Kestrel Halt grain
// elevator") on the real Frontier world with the registered definition and
// controller: the geometry pinned against the generator, plant and defuse,
// blast integrity to the warning, bots fleeing the fall line, the topple
// through the structural system (chunks thrown east), the crush credited to
// the final blow with the `elevator` kill key (its team spared), the rubble
// pile across the a-c road (one voxel on the road, a walkable ridge), the
// surface graph over it, the joiner's map-cache deltas, the rematch, the bot
// tasks, and the HUD / FX hooks on fakes. Prints the peak tick.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { isSolidBlock } from '../shared/world/blocks.js';
import { mapEventsFor } from '../shared/conquest-map-events.js';
import {
  ELEVATOR_EVENT, KESTREL_ELEVATOR as T, elevatorStanding, elevatorTowerCells,
} from '../shared/map-events/elevator.js';
import { MAP_EVENT_DEFS } from '../shared/map-events/registry.js';
import { ElevatorController } from '../server/modes/conquest/map-events/elevator.js';
import { MAP_EVENT_CONTROLLERS } from '../server/modes/conquest/map-events/registry.js';
import { SurfaceNav, TerrainWatch } from '../server/bot-surface-nav.js';
import { hazardEscape } from '../server/bot-map-events.js';
import { mapEventBanner } from '../public/js/ui/conquest/map-events.js';
import { ELEVATOR_PRESENTER } from '../public/js/ui/conquest/map-events/elevator.js';
import { ELEVATOR_FX } from '../public/js/fx/map-events/elevator.js';
import { TICK_MS, eventFixture } from './lib/map-event-fixtures.mjs';

// ---------------------------------------------------------------- registry and geometry
assert(MAP_EVENT_DEFS.includes(ELEVATOR_EVENT) && MAP_EVENT_CONTROLLERS.elevator === ElevatorController, 'registered in both slots');
assert(mapEventsFor('frontier').includes(ELEVATOR_EVENT) && !mapEventsFor('redrock').includes(ELEVATOR_EVENT), 'Frontier only');
assert.equal(ELEVATOR_EVENT.breakthrough, true);

const defs = [ELEVATOR_EVENT];
const F = eventFixture({ defs, controllers: { elevator: ElevatorController } });
const { game, policy, system, world } = F;
const get = (x, y, z) => world.getBlock(x, y, z);
const towerBlocks = elevatorTowerCells(get).length / 4;
assert(towerBlocks > 700 && elevatorStanding(get), `the generator's elevator stands in the event's box (${towerBlocks} blocks)`);
assert(isSolidBlock(get(T.box.x0, T.foundationY, T.box.z0)) && !isSolidBlock(get(279, T.box.y0, 334)), 'foundation under, the bay open');
const ev = system.instance('elevator');
assert(ev && ev.controller.active, 'the controller found the tower');

const a = F.player('a', 'alpha'), b = F.player('b', 'bravo'), b2 = F.player('b2', 'bravo');
F.run(TICK_MS * 2);
assert.equal(game.mode.phase, 'live');
const bay = { x: 279.5, z: 334.5 };
F.place(a, bay.x, bay.z, 30.02); F.place(b, bay.x + 0.6, bay.z, 30.02);
assert.deepEqual(F.snap.match.conquest.evp, [[0, 0, 3]], 'the plant point rides evp for both sides');

// ---------------------------------------------------------------- bots: who plants, who defuses
const tasks = team => system.view().tasks[team].map(t => t.id);
assert.equal(policy.flags.find(f => f.id === 'A').owner, 'alpha');
assert.deepEqual([tasks('alpha'), tasks('bravo')], [[], ['elevator:use:plant']], 'EAST (not holding A) plants');

// ---------------------------------------------------------------- plant, defuse
const use = (p, key) => game.mode.conquestIntent(p, { type: 'support', support: 'use', targetId: key });
const hold = (p, ms, key) => { for (let t = 0; t < ms; t += 200) { use(p, key); F.run(200); } };
hold(a, 5400, 'elevator:0');
assert.equal(ev.phase, 'armed', 'a 5 s hold plants the charge');
assert.equal(ev.team, 'alpha');
assert.deepEqual(F.decoded().points.map(p => [p.id, p.teams.join()]), [['defuse', 'bravo']], 'only the rival may defuse');
assert(tasks('bravo').includes('elevator:use:defuse') && tasks('alpha').includes('elevator:guard'), 'bots defuse and guard');
hold(b, 4400, 'elevator:1');
assert.equal(ev.phase, 'idle', 'the defuse calls it off');
assert(F.kinds().some(e => e.phase === 'idle' && e.reason === 'defused' && e.by === 'b'));
assert(!system.points.get(ev, 'plant').enabled, 'the bay is closed to a new plant for a while');

// ---------------------------------------------------------------- blasts to the warning
const fallLine = { x: 296, z: 334.5 };
F.place(a, fallLine.x, fallLine.z); F.place(b2, fallLine.x, fallLine.z - 1.5);
const blast = () => game.mode.onBlast([279.5, 30.5, 331.2], { key: 'rocket', radius: 3, ownerId: 'b' });
for (let i = 0; i < 4; i++) blast();
F.run(TICK_MS);
assert(F.kinds().some(e => e.note === 'damaged'), 'half integrity sends the damaged note');
for (let i = 0; i < 3; i++) blast();
assert.equal(ev.phase, 'warning', '7 rockets bring the base to 0');
assert.deepEqual([ev.team, ev.by], ['bravo', 'b']);
F.run(TICK_MS);
assert.equal(F.decoded().events[0]?.phase, 'warning', 'joiners read the warning from `ev`');
const flee = hazardEscape(game, a, 'alpha');
assert(flee && Math.abs(flee.point.z - fallLine.z) > 4, 'a bot in the fall line runs out of it sideways');
assert.equal(elevatorStanding(get), true, 'it still stands through the creak');

// ---------------------------------------------------------------- the topple
const column = (x, z) => { let n = 0; for (let y = 24; y < 60; y++) if (isSolidBlock(get(x, y, z))) n++; return n; };
const baseline = new Map();
for (let x = 283; x <= 310; x++) for (let z = 328; z <= 341; z++) baseline.set(`${x},${z}`, column(x, z));
const nav = new SurfaceNav(world, F.meta.navigation);
nav.build();
const watch = new TerrainWatch(game);
const collapses = [];
const changedBefore = game.changedBlocks.size;
let peak = 0;
const t0 = game.now;
while (game.now - t0 < 4000 + 6000) {
  const s = performance.now();
  game.step(TICK_MS);
  peak = Math.max(peak, performance.now() - s);
  for (const e of F.snap.events ?? []) if (e.kind === 'collapse') collapses.push(e);
}
assert.equal(ev.phase, 'done');
assert(!elevatorStanding(get) && elevatorTowerCells(get).length / 4 < towerBlocks * 0.1, 'the tower is gone');
const thrown = collapses.filter(c => c.v[0] > 5);
assert(thrown.length >= 4, `chunks are thrown east (${thrown.length} of ${collapses.length})`);
assert.equal(a.state, 'dead', 'the crush line kills an enemy in it');
const kill = F.events.find(e => e.kind === 'kill' && e.victim === 'a');
assert(kill?.killer === 'b' && ['elevator', 'collapse'].includes(kill.w), `credited to the final blow (${kill?.killer} ${kill?.w})`);
assert.equal(b2.state, 'alive', 'the trigger team is spared');
// Rubble: a ridge beside the stump, one voxel on the road, a walkable way over it.
const pile = (x, z) => column(x, z) - baseline.get(`${x},${z}`);
assert(pile(285, 334) >= 3 && pile(290, 334) >= 2, `the bin lies as a ridge (${pile(285, 334)}, ${pile(290, 334)} high)`);
const road = [304, 305, 306, 307, 308].flatMap(x => [332, 333, 334, 335, 336].map(z => pile(x, z)));
assert(road.some(n => n > 0) && road.every(n => n <= 1), `roof sheets on the a-c road, one voxel high (${road})`);
nav.applyChanges(watch.poll());
const over = nav.route(nav.snap({ x: 288.5, y: 30, z: 327.5 }, 2), nav.snap({ x: 288.5, y: 30, z: 341.5 }, 2));
assert(over.reached && over.length < 40, `infantry cross the pile (${over.length.toFixed(0)} m)`);
assert(game.changedBlocks.size - changedBefore >= towerBlocks, 'every fallen block is a map-cache delta for joiners');
assert.deepEqual(F.snap.match.conquest.ev, [[0, 4, 100, 1]], 'done row: the trigger team');
console.log(`elevator: ${towerBlocks} blocks, ${collapses.length} chunks (${thrown.length} thrown east), `
  + `${ev.controller.rubbleJob?.applied ?? 0} rubble cells laid, kill by ${kill.w}, peak tick ${peak.toFixed(2)} ms`);

// ---------------------------------------------------------------- rematch
policy.reset();
F.run(TICK_MS * 2);
assert(elevatorStanding(get) && elevatorTowerCells(get).length / 4 === towerBlocks, 'restoreWorld rebuilds the elevator');
const again = system.instance('elevator');
assert(again.phase === 'idle' && again.controller.active && system.points.get(again, 'plant').enabled, 'the event starts over');
assert.equal(system.targets.get(again, 'base').destroyed, false);

// ---------------------------------------------------------------- client
{
  const def = ELEVATOR_EVENT;
  const warn = mapEventBanner({ kind: 'map_event', event: 'elevator', phase: 'warning', team: 'bravo', endsAt: 5000 }, { nowMs: 1000, selfTeam: 'alpha', defs });
  assert.equal(warn.title, 'KESTREL ELEVATOR · GIVING WAY');
  assert.deepEqual([warn.tone, warn.icon, warn.countdown.label], ['hazard', 'event-elevator', 'TOPPLES IN']);
  const hurt = mapEventBanner({ kind: 'map_event', event: 'elevator', phase: 'idle', note: 'damaged', data: { integrity: 43 } }, { nowMs: 0, selfTeam: 'alpha', defs });
  assert.equal(hurt.detail, 'SUPPORTS AT 43 %');
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (k in _ ? _[k] : (...args) => { calls.push(k); }), set: (o, k, v) => { o[k] = v; return true; } });
  ELEVATOR_PRESENTER.paintMap(ctx, { phase: 'warning', leftMs: 2000 }, { nowMs: 0, px: 2 });
  assert(calls.includes('stroke') && calls.includes('clip'), 'the fall line paints with hazard stripes');
  const kit = { sounds: [], puffs: 0, emitters: [], shake() {}, puff() { this.puffs++; }, emitter(key) { this.emitters.push(key); },
    sound: { creak: (p, o) => kit.sounds.push(['creak', o.material]), impact: (p, o) => kit.sounds.push(['impact', o.material]) } };
  ELEVATOR_FX.onEvent({ kind: 'map_event', event: 'elevator', phase: 'warning' }, kit);
  for (let i = 0; i < 20; i++) ELEVATOR_FX.update(0.1, kit);
  ELEVATOR_FX.onEvent({ kind: 'map_event', event: 'elevator', phase: 'active' }, kit);
  for (let i = 0; i < 30; i++) ELEVATOR_FX.update(0.1, kit);
  assert(kit.sounds.some(s => s[0] === 'creak' && s[1] === 'wood') && kit.sounds.some(s => s[0] === 'impact'), 'timber groans, then the landing');
  assert(kit.puffs > 20 && kit.emitters.includes('elevator:cloud'), 'a dust cloud along the fall line');
  ELEVATOR_FX.clear(kit);
  void def;
}
console.log('conquest map event elevator: geometry, plant and defuse, blasts, flee, topple, crush, rubble and nav, rematch, HUD and FX passed');
process.exit(0);
