// Aldric Quarry rockslide (docs/conquest.md "Map events: Aldric Quarry rockslide") on the real
// Frontier world: the site props, the 4 s plunger hold for either side (once per round), the
// warning's hazard zones and the bots' flight from them, the commander's trigger and contest
// tasks, the slide itself (charges, face fall, deposit front, crush credited to the trigger,
// grade), the new talus route and the buried haul ramp, the peak tick cost, and the rematch.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { AIR, isSolidBlock } from '../shared/world/blocks.js';
import { MAP_EVENT_DEFS, MAP_EVENT_RULES, mapEventsFor } from '../shared/conquest-map-events.js';
import { QUARRY_EVENT, QUARRY_SITE, QUARRY_SLIDE, quarryProfileY } from '../shared/map-events/quarry.js';
import { QuarryController } from '../server/modes/conquest/map-events/quarry.js';
import { SurfaceNav } from '../server/bot-surface-nav.js';
import { hazardEscape, planMapEventTasks } from '../server/bot-map-events.js';
import { mapEventBanner } from '../public/js/ui/conquest/map-events.js';
import { MapEventFx } from '../public/js/fx/map-event-fx.js';
import { TICK_MS, conquestBaseBytes, eventFixture, groundY, mapEventWireBytes } from './lib/map-event-fixtures.mjs';
import { CONQUEST_MATCH_BUDGET_BYTES } from './lib/protocol-contract.mjs';

assert(MAP_EVENT_DEFS.includes(QUARRY_EVENT) && mapEventsFor('frontier').includes(QUARRY_EVENT) && !mapEventsFor('redrock').includes(QUARRY_EVENT),
  'registered for Frontier only');

const F = eventFixture({ defs: [QUARRY_EVENT], controllers: { quarry: QuarryController } });
const { game, policy, system, world } = F;
const solid = (x, y, z) => isSolidBlock(world.getBlock(x, y, z));
for (const [x, y, z] of QUARRY_SITE.charges) assert.equal(world.getBlock(x, y, z), 9, `charge box at ${x},${y},${z}`);
assert(solid(QUARRY_SITE.plunger.x, QUARRY_SITE.plunger.y, QUARRY_SITE.plunger.z), 'the detonator stands in the hut');
const navOf = () => new SurfaceNav(world, F.meta.navigation).build();
const floor = { x: 256.5, y: groundY(world, 256.5, 601.5), z: 601.5 }, rim = { x: 255.5, y: groundY(world, 255.5, 572.5), z: 572.5 };
const before = navOf().route(floor, rim);

const a = F.player('a', 'alpha'), b = F.player('b', 'bravo'), b2 = F.player('b2', 'bravo'), b3 = F.player('b3', 'bravo'), c = F.player('c', 'bravo');
F.run(TICK_MS * 2);
const ev = system.instance('quarry');
const plunger = QUARRY_EVENT.points[0];
F.place(a, plunger.x, plunger.z, plunger.y);
F.place(b, 270.5, 590.5); F.place(b2, 256.5, 594.5); F.place(b3, 266.5, 584.5); F.place(c, 286.5, 610.5);
assert.equal(game.mode.phase, 'live');
assert.deepEqual(F.snap.match.conquest.evp, [[0, 0, 3]], 'the plunger rides `evp` for both sides');

// ---------------------------------------------------------------- bots: the commander's trigger
{
  a.bot = true;
  const commander = { game, teamBrains: () => [{ id: 'a' }], kitOf: () => 'assault' };
  const ts = { team: 'alpha', squads: new Map(), crews: new Map(), hitches: new Map(), memberSquad: new Map() };
  policy._view = null;
  planMapEventTasks(commander, ts, game.now);
  assert.equal(ts.eventAssign.get('a'), 'quarry:use:plunger', 'three enemies under the face: a bot goes for the plunger');
  F.place(b3, 286.5, 612.5); policy._view = null;
  planMapEventTasks(commander, ts, game.now);
  assert.equal(ts.eventAssign.size, 0, 'two enemies are not worth the slide');
  F.place(b3, 266.5, 584.5);
  a.bot = false;
}

// ---------------------------------------------------------------- the hold and the warning
const use = (p) => game.mode.conquestIntent(p, { type: 'support', support: 'use', targetId: 'quarry:0' });
const hold = (p, ms) => { for (let t = 0; t < ms; t += 200) { use(p); F.run(200); } };
hold(a, 2000);
assert.equal(ev.phase, 'idle', 'half a hold does nothing');
{
  // An enemy holding the plunger draws bravo bots to break it.
  c.bot = true;
  const commander = { game, teamBrains: () => [{ id: 'c' }], kitOf: () => 'assault' };
  const ts = { team: 'bravo', squads: new Map(), crews: new Map(), hitches: new Map(), memberSquad: new Map() };
  policy._view = null;
  planMapEventTasks(commander, ts, game.now);
  assert.equal(ts.eventAssign.get('c'), 'quarry:contest', 'an enemy on the plunger draws a contest task');
  c.bot = false;
}
hold(a, 2200);
assert.equal(ev.phase, 'warning', 'a 4 s hold sets it off');
assert.deepEqual([ev.team, ev.by], ['alpha', 'a']);
F.run(TICK_MS);
assert(!F.snap.match.conquest.evp, 'the plunger is spent (once per round)');
assert.equal(use(a), false);
const row = F.snap.match.conquest.ev[0];
assert.deepEqual(row.slice(0, 4), [0, 2, 0, 0], 'ev row: warning, set off by WEST');
assert(row[4] >= 48 && row[4] <= 50, '5 s warning');
assert(mapEventWireBytes(F.snap.match.conquest) <= MAP_EVENT_RULES.wire.budgetBytes && conquestBaseBytes(F.snap.match.conquest) <= CONQUEST_MATCH_BUDGET_BYTES);
policy._view = null;
const flee = hazardEscape(game, b, 'bravo');
assert(flee && flee.point.z > 598, `a bot on the ramp runs out of the slide zone during the warning (to z ${flee?.point.z.toFixed(1)})`);
const warn = mapEventBanner(F.kinds().find(e => e.phase === 'warning'), { nowMs: game.now, selfTeam: 'bravo' });
assert.deepEqual([warn.title, warn.detail, warn.countdown.label], ['ALDRIC QUARRY · ROCKSLIDE IMMINENT', 'ENEMY BLAST · GET OUT OF THE PIT', 'BLAST IN']);

// ---------------------------------------------------------------- the slide
let peak = 0;
const t0 = game.now;
while (ev.phase !== 'done' && game.now - t0 < 20000) {
  const s = performance.now();
  game.step(TICK_MS);
  peak = Math.max(peak, performance.now() - s);
}
F.run(3000);  // the last staged cells and structural chunks settle
assert.equal(ev.phase, 'done');
const kills = F.kinds('kill').filter(k => k.w === 'quarrySlide');
assert.deepEqual(kills.map(k => k.victim).sort(), ['b', 'b2', 'b3'], 'the slide kills the three under the face');
assert(kills.every(k => k.killer === 'a'), 'credited to the trigger with the ROCKSLIDE key');
assert.equal(c.state, 'alive', 'the south floor is safe');
assert.deepEqual(F.kinds().filter(e => e.note === 'blast').length, QUARRY_SITE.charges.length, 'one blast per charge');
for (const [x, y, z] of QUARRY_SITE.charges) assert.notEqual(world.getBlock(x, y, z), 9, 'the charges are gone');
assert.deepEqual(F.snap.match.conquest.ev, [[0, 4, 100, 0]], 'a finished slide rides as done');
// The haul ramp is buried under the choke (no 1-2 block climb onto it from the floor).
for (const x of [266, 269, 272]) assert(solid(x, 29, 589) && solid(x, 30, 590), `ramp at x ${x} buried`);
const chokeFace = groundY(world, 270.5, 595.5, 34);
assert(chokeFace < 26 && groundY(world, 270.5, 593.5, 40) >= 31, 'the choke stands 6 m over the floor');
// The talus: a 1-block-step slope from the floor to the rim along its whole length.
for (const x of [254, 259, 261]) {
  let prev = null;
  for (let z = QUARRY_SLIDE.profile.z0; z <= QUARRY_SLIDE.talus.z1; z++) {
    const top = Math.round(groundY(world, x + 0.5, z + 0.5, quarryProfileY(z) + 4) - 1.02);
    if (z >= QUARRY_SLIDE.talus.z0) assert.equal(top, Math.max(quarryProfileY(z), top >= 28 && z <= 587 ? 28 : 0), `talus ${x},${z} on its profile`);
    if (prev != null) assert(Math.abs(top - prev) <= 1, `talus step ${x},${z}: ${prev} -> ${top}`);
    prev = top;
  }
}
const after = navOf().route(floor, rim);
console.log(`floor -> north rim: ${before.reached ? `${before.length.toFixed(0)} m` : 'no route'} before, ${after.length.toFixed(0)} m after; `
  + `staged edit step max ${system.edits.stats.maxTickMs.toFixed(2)} ms, peak whole tick ${peak.toFixed(1)} ms, ${system.edits.stats.cells} cells`);
assert(after.reached && after.length < 40 && (!before.reached || before.length > after.length + 20), 'the talus is the short way out of the pit to the rim');

// ---------------------------------------------------------------- client FX: siren, blasts, dust
{
  const calls = [];
  const audio = { bastionCue: (kind) => calls.push(kind), explosion: () => calls.push('blast'), structureCreak: () => calls.push('creak'),
    structureImpact: () => calls.push('impact') };
  const emitters = [];
  const fx = new MapEventFx({ audio, fx: { emit: () => 1, addEmitter: spec => (emitters.push(spec), spec), removeEmitter: () => true },
    cameraShake: { add() {} }, getCamera: () => ({ position: { x: 262, y: 30, z: 600 } }) });
  fx.mapId = 'frontier';
  for (const e of F.kinds().filter(k => k.event === 'quarry')) fx.handleEvent(e);
  fx.handleEvent({ kind: 'map_event', event: 'quarry', phase: 'warning', team: 'alpha' });
  fx.update(1.2, {});
  assert(calls.includes('bastion_alarm') && calls.filter(c => c === 'blast').length === QUARRY_SITE.charges.length && calls.includes('creak'),
    `siren, one blast voice per charge, the face's creak (${calls.join(',')})`);
  assert(emitters.some(e => e.kind === 'dust'), 'the dust wall rolls down the face');
}

// ---------------------------------------------------------------- rematch
policy.reset();
F.run(TICK_MS * 2);
const again = system.instance('quarry');
assert(again.phase === 'idle' && !F.snap.match.conquest.ev && F.snap.match.conquest.evp?.length === 1, 'a rematch re-arms the plunger');
for (const [x, y, z] of QUARRY_SITE.charges) assert.equal(world.getBlock(x, y, z), 9, 'and restores the charges');
assert.equal(world.getBlock(269, 29, 589), AIR, 'and the ramp');
console.log('conquest quarry rockslide: site, plunger, warning, bots, slide, crush credit, talus, ramp, rematch passed');
process.exit(0);
