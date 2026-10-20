// Hollin Fuel Depot explosion (docs/conquest.md "Hollin Fuel Depot") on the real
// Frontier world: the tank geometry against the template, integrity (rockets
// strongly, the mounted HMG through combat.fireMountedRay weakly, rifles not),
// the chain reaction, blast credit and falloff, the staged craters, burning
// ground, the smoke column blocking sight lines, the `ev` row, bot shoot tasks
// and avoidance, Breakthrough and the rematch reset.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { AIR, CONCRETE, PALE, SCORCHED_EARTH } from '../shared/world/blocks.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { VEHICLE_WEAPONS } from '../shared/vehicle-defs.js';
import { MAP_EVENT_DEFS, decodeMapEvents, mapEventsFor } from '../shared/conquest-map-events.js';
import { DEPOT_EVENT, cylinderChord } from '../shared/map-events/depot.js';
import { DepotController } from '../server/modes/conquest/map-events/depot.js';
import { MAP_EVENT_CONTROLLERS } from '../server/modes/conquest/map-events/registry.js';
import { MapEventSystem } from '../server/modes/conquest/map-events/system.js';
import { fireMountedRay } from '../server/sim/combat.js';
import { avoidZonesFor, hazardEscape, mapEventShoot, planMapEventTasks } from '../server/bot-map-events.js';
import { mapEventBanner, paintMapEvents } from '../public/js/ui/conquest/map-events.js';
import { MapEventFx } from '../public/js/fx/map-event-fx.js';
import { TICK_MS, eventFixture, mapEventWireBytes } from './lib/map-event-fixtures.mjs';

const T = DEPOT_EVENT.tuning;
assert(MAP_EVENT_DEFS.includes(DEPOT_EVENT) && MAP_EVENT_CONTROLLERS.depot === DepotController, 'registered in both slots');
assert(mapEventsFor('frontier').includes(DEPOT_EVENT) && !mapEventsFor('redrock').includes(DEPOT_EVENT), 'Frontier only');

const F = eventFixture({ defs: [DEPOT_EVENT], controllers: { depot: DepotController } });
const { game, policy, system, world } = F;
// The tanks as generated: a concrete plinth at y0, the pale body from y0 + 1 to y0 + 6.
for (const t of T.tanks) {
  const x = Math.floor(t.x), z = Math.floor(t.z);
  assert.equal(world.getBlock(x, t.y0, z), CONCRETE, `${t.id} plinth at y ${t.y0}`);
  for (let y = t.y0 + 1; y <= t.y0 + 6; y++) assert.equal(world.getBlock(x, y, z), PALE, `${t.id} body at y ${y}`);
}
const [W, E, S] = T.tanks;
const a = F.player('a', 'alpha'), a2 = F.player('a2', 'alpha'), b = F.player('b', 'bravo'), b2 = F.player('b2', 'bravo'), b3 = F.player('b3', 'bravo');
F.run(TICK_MS * 2);
const ev = system.instance('depot');
assert(ev && ev.phase === 'idle' && !F.snap.match.conquest.ev, 'an intact depot rides no `ev` row');
const centre = t => [t.x, t.y0 + 4, t.z];
const blast = (key, t = W, by = 'a') => system.onBlast(centre(t), { key, radius: 3, ownerId: by });

// ---------------------------------------------------------------- integrity
blast('rifle'); blast('molotov');
assert.equal(system.targets.share(system.targets.get(ev, W.id)), 1, 'rifles and molotovs do nothing');
// A real mounted HMG round on the tank wall (combat.fireMountedRay -> onBlast as a radius-0 hit).
F.place(a, W.x - 30, W.z - 0.5);
const origin = [W.x - 12, W.y0 + 4, W.z], dir = [1, 0, 0];
for (let i = 0; i < 20; i++) fireMountedRay(a, origin, dir, VEHICLE_WEAPONS.hmg, game.contexts.combat, { vehicleId: null });
const hmgShare = system.targets.share(system.targets.get(ev, W.id));
assert(Math.abs(hmgShare - (1 - 20 * 1.5 / 300)) < 1e-6, `20 HMG hits take 10 % (${hmgShare})`);
blast('rocket');
F.run(TICK_MS);
assert.equal(ev.phase, 'idle');
const row = F.decoded().events[0];
assert.deepEqual(row.extra, [57, 100, 100], 'each tank\'s integrity rides the extras');
assert.equal(Math.round(row.progress * 100), 43, 'the gauge is the worst tank\'s lost share');
assert(mapEventWireBytes(F.snap.match.conquest) <= 36, `a damaged depot rides ${mapEventWireBytes(F.snap.match.conquest)} B`);

// ---------------------------------------------------------------- bots: shoot when enemies crowd the farm
F.place(b, W.x - 9, W.z + 3); F.place(b2, W.x - 3, W.z - 6); F.place(b3, E.x + 6, E.z - 6); F.place(a2, S.x, S.z + 6);
policy._view = null;
const tasks = system.view().tasks;
const shoot = tasks.alpha.find(t => t.kind === 'shoot');
assert(shoot && shoot.point.x === W.x && !tasks.bravo.length, 'alpha posts a shoot task on the weakest tank, bravo none');
const ts = { team: 'alpha', squads: new Map(), crews: new Map(), hitches: new Map(), memberSquad: new Map() };
a.bot = true;
planMapEventTasks({ game, teamBrains: () => [{ id: 'a' }], kitOf: () => 'engineer' }, ts, game.now);
assert.equal(ts.eventAssign.size, 0, 'a shoot task never books a walk');
{
  const slot = WEAPON_IDS.indexOf('rocket');
  F.place(a, W.x - 60, W.z);
  a.mag[slot] = 1; a.reserve[slot] = 4;
  const br = { aim: { steer: (_k, _from, to) => to } };
  const inp = { keys: {}, yaw: a.yaw, pitch: a.pitch, wantFire: false, switchTo: undefined };
  assert(mapEventShoot(game, br, a, inp, game.now, 1 / 60, [slot], 9, 9, 'alpha'), 'an Engineer in range takes it');
  assert.equal(inp.switchTo, slot, 'and raises the RX-8');
  a.weapon = slot; a.triggerPrev = false;
  const inp2 = { keys: {}, yaw: a.yaw, pitch: a.pitch, wantFire: false, switchTo: undefined };
  mapEventShoot(game, br, a, inp2, game.now, 1 / 60, [slot], 9, 9, 'alpha');
  assert(inp2.wantFire && inp2.pitch > 0, 'then fires with the rocket\'s drop held over');
  a.bot = false;
}

// ---------------------------------------------------------------- trigger and chain
F.place(a, W.x - 30, W.z - 0.5);
blast('rocket');
assert.equal(ev.phase, 'idle', '23 % left after HMG fire and two rockets');
const hpB = b.hp, hpA2 = a2.hp;
const t0 = performance.now();
blast('rocket');
const triggerMs = performance.now() - t0;
assert.equal(ev.phase, 'warning', 'the first failure sets the chain off');
assert.deepEqual([ev.team, ev.by], ['alpha', 'a']);
assert.equal(F.events.filter(e => e.kind === 'score' && e.id === 'a' && e.reason === 'map_event').length, 0, 'the score rides the next tick');
assert(b.hp < hpB - 40 && b.hp > 0, `9 m off: heavy damage (${hpB} -> ${b.hp})`);
assert.equal(b2.state, 'dead', '3 m off: dead');
assert.equal(a2.hp, hpA2, 'the trigger\'s teammate is spared');
policy._view = null;
assert(avoidZonesFor(game, 'bravo').some(z => z.id === 'depot-chain'), 'bots run out of the blast radius');
let maxTickMs = 0;
const step = () => { const s = performance.now(); game.step(TICK_MS); maxTickMs = Math.max(maxTickMs, performance.now() - s); };
for (let t = 0; t < 1600; t += TICK_MS) step();
const notes = () => F.kinds().filter(e => e.note === 'burst').map(e => e.data.tank);
assert.deepEqual(notes(), [0, 1], 'the nearest tank goes 1.5 s later');
for (let t = 0; t < 1500; t += TICK_MS) step();
assert.equal(ev.phase, 'active');
assert.deepEqual(notes(), [0, 1, 2], 'the last at the active start');
assert(F.events.some(e => e.kind === 'score' && e.id === 'a' && e.reason === 'map_event'), 'MAP EVENT score for the last blow');
F.run(3000);
assert(F.events.some(e => e.kind === 'kill' && e.victim === 'b2' && e.killer === 'a' && e.w === 'depotBlast'), 'the kill credits the trigger as FUEL DEPOT');

// ---------------------------------------------------------------- craters, fire, column
for (const t of T.tanks) {
  const x = Math.floor(t.x), z = Math.floor(t.z);
  assert.equal(world.getBlock(x, t.y0 + 3, z), AIR, `${t.id} is gone`);
  assert.equal(world.getBlock(x, t.y0 - T.crater.depth, z), SCORCHED_EARTH, `${t.id} leaves a scorched bowl`);
}
assert.equal(system.edits.jobs.length, 0, 'every staged cell applied');
const fireAt = { x: E.x + 2, z: E.z };
F.place(b3, fireAt.x, fireAt.z);
const hp0 = b3.hp;
F.run(1000);
assert(hp0 - b3.hp >= 25 && hp0 - b3.hp <= 35, `burning ground ~30 hp a second (${hp0 - b3.hp})`);
assert(hazardEscape(game, b3, 'bravo'), 'and a bot inside runs out');
assert(!hazardEscape(game, Object.assign({}, b3, { x: 560, z: 380 }), 'bravo'), 'outside: no escape goal');
const smoke = game.projectiles.smoke;
const across = [[T.column.radius ? 470 : 0, 45, 425], [560, 45, 425]], past = [[470, 45, 400], [560, 45, 400]];
assert(smoke.blocksSight(...across, game.now), 'the column blocks a sight line through it');
assert(!smoke.blocksSight(...past, game.now), 'one passing 25 m north is clear');
assert(cylinderChord(512, 425, 9, 0, 140, [470, 45, 425], [560, 45, 425]) > 17.9, 'chord through the full column');
const bytes = mapEventWireBytes(F.snap.match.conquest);
const st = system.edits.stats;
console.log(`depot: trigger blast ${triggerMs.toFixed(2)} ms, peak tick through the chain ${maxTickMs.toFixed(2)} ms, `
  + `${st.cells} staged cells over ${st.ticks} ticks (edit step max ${st.maxTickMs.toFixed(2)} ms), ev ${bytes} B active`);
assert(bytes <= 40, `the active row stays small (${bytes} B)`);
const banner = mapEventBanner({ kind: 'map_event', event: 'depot', phase: 'warning', team: 'alpha', endsAt: 3000 }, { nowMs: 0, selfTeam: 'bravo' });
assert.deepEqual([banner.title, banner.detail], ['HOLLIN FUEL DEPOT · CHAIN REACTION', 'GET OUT OF THE DEPOT']);
F.run(T.fire.ms - 3000);
assert.equal(system.hazards.of(ev).length, 0, 'the fire burns out a minute after the active start');
assert(smoke.blocksSight(...across, game.now), 'the column still stands');
F.run(DEPOT_EVENT.durations.activeMs - T.fire.ms + 500);
assert.equal(ev.phase, 'done');
assert(!smoke.blocksSight(...across, game.now), 'gone with the active phase');
assert.deepEqual(F.decoded().events.map(e => e.phase), ['done']);

// ---------------------------------------------------------------- client: effects and map paint from the row alone
{
  const emitters = new Set(), emitted = [], sounds = [];
  const field = { emit: kind => { emitted.push(kind); return 1; }, addEmitter: spec => { const h = { ...spec }; emitters.add(h); return h; },
    removeEmitter: h => emitters.delete(h) };
  const fx = new MapEventFx({ defs: [DEPOT_EVENT], fx: field, audio: { explosion: (_p, type) => sounds.push(type), structureImpact: () => {}, structureCreak: () => {} },
    cameraShake: { add: () => {} }, getCamera: () => ({ position: { x: 480, y: 40, z: 425 } }) });
  fx.mapId = 'frontier';
  assert(fx.handleEvent({ kind: 'map_event', event: 'depot', phase: 'warning', note: 'burst', data: { tank: 1 }, pos: [512, 31, 425] }));
  assert(emitted.includes('fire') && emitted.includes('debris') && sounds[0] === 'bomb', 'a burst is a fireball with the bomb take');
  // A joiner's first row in the active phase (10 s in): fire on the three tanks and the canopy, the column.
  fx.update(1 / 60, { match: { conquest: { ev: [[0, 3, 0, 0, 1700]] } }, mapId: 'frontier' });
  assert.equal(emitters.size, 4 * 2 + 5, 'four fires with their smoke and five column levels');
  fx.update(1 / 60, { match: { conquest: { ev: [[0, 3, 0, 0, 1100]] } }, mapId: 'frontier' });
  assert.equal(emitters.size, 5, 'the fire is out after a minute; the column stands');
  fx.update(1 / 60, { match: { conquest: { ev: [[0, 4]] } }, mapId: 'frontier' });
  assert.equal(emitters.size, 0, 'and goes with the active phase');
  const calls = [];
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'setLineDash' || typeof k !== 'string' ? () => {} : (...args) => calls.push(k)), set: () => true });
  paintMapEvents(ctx, decodeMapEvents([[0, 3, 0, 0, 1700]], null, 'frontier', [DEPOT_EVENT]), { nowMs: 0, px: 1, presenters: undefined });
  assert.equal(calls.filter(k => k === 'arc').length, 5, 'the map paints the column and four burning discs');
}

// ---------------------------------------------------------------- rematch and Breakthrough
policy.reset();
F.run(TICK_MS * 2);
assert.equal(world.getBlock(Math.floor(W.x), W.y0 + 3, Math.floor(W.z)), PALE, 'the rematch restores the tanks');
assert(system.instance('depot').phase === 'idle' && !F.snap.match.conquest.ev && smoke.occluders.size === 0, 'idle, no row, no column');
assert.equal(system.targets.share(system.targets.get(system.instance('depot'), W.id)), 1, 'whole again');
const bt = new MapEventSystem({ mapMeta: { id: 'frontier' }, variant: 'breakthrough', now: 0 });
bt.reset();
assert(bt.instance('depot'), 'Breakthrough keeps the depot');
console.log('conquest map event depot: geometry, integrity, bots, chain, blast credit, craters, fire, column, wire, rematch passed');
process.exit(0);
