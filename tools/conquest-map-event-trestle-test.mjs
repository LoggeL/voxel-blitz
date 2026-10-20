// Canyon Trestle collapse (docs/conquest.md "Map events" -> "Canyon Trestle
// collapse"): on Redrock six AT mines at the bent feet bring the trestle
// down (damaged at half, the groan with the crossing closed, the fall with
// the `trestle` crush, payDestroyed), the gameplay effect in road metres
// (B-E alone and with the dam crest closed), the rubble berm as a dry
// infantry crossing of the river, the generalised span helpers of
// bot-bridge.js, NO SOUTHERN CROSSING, the HUD and FX hooks, the wire, the
// rematch, then the commander's demolish task and a bot rocketing the bents.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { FLUID_BLOCKS, METAL, PLANK, RUST, isSolidBlock } from '../shared/world/blocks.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { mapEventsFor, MAP_EVENT_RULES } from '../shared/conquest-map-events.js';
import { TRESTLE_EVENT } from '../shared/map-events/trestle.js';
import { fixtureMapEvent } from '../shared/map-events/fixture.js';
import { MapEventController } from '../server/modes/conquest/map-events/controller.js';
import { TrestleController } from '../server/modes/conquest/map-events/trestle.js';
import { attachBots } from '../server/bots.js';
import { crossingDenialValue, roadMetres } from '../server/bot-map-events.js';
import { avoidSpan, closedCrossings, crossesClosedSpan, spanEscape } from '../server/bot-bridge.js';
import { mapEventBanner } from '../public/js/ui/conquest/map-events.js';
import { MAP_EVENT_PRESENTERS } from '../public/js/ui/conquest/map-events/registry.js';
import { MAP_EVENT_FX } from '../public/js/fx/map-events/registry.js';
import { TICK_MS, eventFixture, groundY, mapEventWireBytes } from './lib/map-event-fixtures.mjs';

const t0 = performance.now();
const redrockIds = mapEventsFor('redrock').map(d => d.id);
assert.equal(redrockIds.at(-1), 'trestle', 'Redrock wire order: the trestle sorts last');

// A stand-in for the dam: closes the crest when told (the `cut` banner).
let crestClosed = false;
class CrestStub extends MapEventController { closedCrossings() { return crestClosed ? ['redrock-dam'] : null; } }
const STUB = fixtureMapEvent({ id: 'crest-stub', maps: ['redrock'], anchor: { x: 100, y: 40, z: 100 }, big: false });
const defs = [TRESTLE_EVENT, STUB];
const F = eventFixture({ map: 'redrock', defs, controllers: { trestle: TrestleController, 'crest-stub': CrestStub } });
const { game, policy, system, world } = F;
const [a, b, c] = [F.player('a', 'alpha'), F.player('b', 'alpha'), F.player('c', 'bravo')];
F.run(TICK_MS * 2);
const event = system.instance('trestle'), target = event.controller.target('supports');
assert(event.controller.levolution.active && target.enabled && target.integrity === 900, 'the trestle stands: a pool of 900 over the bents');
for (const s of TRESTLE_EVENT.targets[0].boxes) {
  const x = (s.x0 + s.x1) / 2, column = y => [496, 503].some(z => [RUST, METAL].includes(world.getBlock(x, y, z)));
  assert(column(s.y0) && !column(s.y0 - 1) && world.getBlock(x, s.y1 - 1, 500) === PLANK, `${s.id} spans its columns from the foot to the deck`);
}

// Gameplay: the vehicle crossing. B-E alone over the dam crest; with the crest closed too, B and E lose their tank link.
const flag = id => game.mapMeta.conquest.flags.find(f => f.id === id), hq = game.mapMeta.conquest.bases;
const openBE = roadMetres(game, flag('B'), flag('E'), []);
const trestleBE = roadMetres(game, flag('B'), flag('E'), ['trestle']) - openBE;
const bothBE = roadMetres(game, flag('B'), flag('E'), ['trestle', 'redrock-dam']) - openBE;
const bothHQ = roadMetres(game, hq.alpha, flag('E'), ['trestle', 'redrock-dam']) - roadMetres(game, hq.alpha, flag('E'), []);
assert(trestleBE > 150 && bothBE > 700 && bothHQ > 350, `closing the trestle: B-E +${trestleBE.toFixed(0)} m, with the dam +${bothBE.toFixed(0)}, HQ-W to E +${bothHQ.toFixed(0)}`);

// The infantry crossing of the canyon floor under the deck (row z497, x369-397, wall to wall): the river is swum before the fall.
const walk = (z = 497) => {
  let prev = null, wet = 0, step = 0;
  for (let x = 369; x <= 397; x++) {
    let y = 26;
    while (y > 0 && !isSolidBlock(world.getBlock(x, y, z))) y--;
    if (FLUID_BLOCKS.has(world.getBlock(x, y + 1, z))) wet++;
    if (prev != null) step = Math.max(step, Math.abs(y - prev));
    prev = y;
  }
  return { wet, step };
};
assert(walk().wet >= 10, `before: ${walk().wet} m of river to swim under the trestle`);

// Six AT mines on the floor at the feet of three bents (150 each): the 6th is the final blow.
const mineAt = x => [x + 1.5, groundY(world, x + 1.5, 496.5, 26) - 0.96, 496.5];
const mine = (x, by) => policy.onBlast(mineAt(x), { key: 'atmine', radius: 5.5, ownerId: by });
mine(373, 'b'); mine(373, 'b'); mine(391, 'b');
F.run(TICK_MS);
assert.equal(event.phase, 'armed', 'three mines: half the pool, damaged');
const armed = F.kinds().find(e => e.event === 'trestle' && e.phase === 'armed');
assert.equal(mapEventBanner(armed, { defs })?.detail, 'SUPPORTS AT 50 %', 'the HUD banners the supports left');
const sounds = [], kit = { defs, audio: { structureCreak: () => sounds.push('creak'), structureImpact: () => sounds.push('impact') } };
assert(MAP_EVENT_FX.trestle.onEvent(armed, kit) && sounds.includes('creak'), 'the FX hook groans');
mine(391, 'a'); mine(397, 'a'); mine(397, 'a');
F.run(TICK_MS);
assert.equal(event.phase, 'warning', 'six mines: the groan');
assert(closedCrossings(game).has('trestle'), 'the crossing closes for bot drivers from the groan on');
assert.equal(roadMetres(game, flag('B'), flag('E')) - openBE, trestleBE, 'bot drivers route B-E over the dam');
const row = F.decoded().events.find(e => e.id === 'trestle');
assert.deepEqual([row.phase, row.progress], ['warning', 1], 'ev: warning, the pool gone');
assert(mapEventWireBytes(F.snap.match.conquest) <= MAP_EVENT_RULES.wire.budgetBytes, 'ev stays in its budget');
assert.equal(MAP_EVENT_PRESENTERS.trestle.marker({ name: 'x' }, row).name, 'TRESTLE · COLLAPSING');
// Bots keep off the failing span: an objective on the deck moves to the head on their side, a bot on it runs.
const deck = { x: 384.5, y: 33.02, z: 499.5 };
assert(avoidSpan(game, deck, { x: 300, z: 500 }).x < 362 && avoidSpan(game, deck, { x: 470, z: 500 }).x > 406, 'a deck objective becomes the near head');
assert(spanEscape(game, { x: 390, y: 33.02, z: 500 })?.x > 406 && spanEscape(game, { x: 384, y: 21, z: 498 }) == null, 'a bot on the deck runs, the floor under it is not the deck');
assert(crossesClosedSpan(game, { x: 340, z: 500 }, { x: 430, z: 500 }), 'a straight drive over the gap is refused');

// The fall: a body on the deck is crushed as `trestle`, the final blow pays 300, the assist its share.
F.runUntil(() => event.phase === 'active', 5000);
F.place(c, 390.5, 499.5, 33.02);
c.hp = 30;
const fallen = F.kinds().find(e => e.event === 'trestle' && e.note === 'fallen');
assert(fallen?.data?.blocks > 1000, `the deck and bents come down (${fallen?.data?.blocks} blocks)`);
const pts = id => F.kinds('score').filter(e => e.id === id && e.reason === 'map_event').reduce((n, e) => n + e.pts, 0);
assert.equal(pts('a'), 300, 'the final blow pays 300');
assert.equal(pts('b'), 100, 'the assist pays its half share');
let maxTick = 0;
for (let t = 0; t < 4000; t += TICK_MS) { const s = performance.now(); game.step(TICK_MS); maxTick = Math.max(maxTick, performance.now() - s); }
const kill = F.kinds('kill').find(k => k.victim === 'c');
assert(kill?.w === 'trestle' && kill.killer === 'a', `the crush kills as TRESTLE, credited to the final blow (${kill?.w})`);
assert(!isSolidBlock(world.getBlock(384, 32, 500)) && !isSolidBlock(world.getBlock(373, 26, 496)), 'the deck and the bents are gone');
assert(isSolidBlock(world.getBlock(360, 32, 500)) && isSolidBlock(world.getBlock(370, 31, 504)), 'the rim stubs and the road fill stay');
assert.equal(event.controller.bermJob?.done, true, 'the wreck has settled into the berm');
const after = walk(), ridge = walk(500);
assert(after.wet === 0 && after.step <= 1, `after: the berm row is dry and walkable (wet ${after.wet}, step ${after.step})`);
assert(ridge.wet === 0, 'the ridge row closes the river too');
F.run(3000);
assert(event.phase === 'done' && closedCrossings(game).has('trestle'), 'down for the round, the crossing stays closed');
assert.equal(mapEventBanner({ kind: 'map_event', event: 'trestle', phase: 'done' }, { defs }), null, 'done banners nothing');
const bermCells = event.controller.bermJob.applied;

// Rematch: the trestle stands again; this time the crest is already closed when it falls: NO SOUTHERN CROSSING.
policy.reset();
F.run(TICK_MS * 2);
const again = system.instance('trestle');
assert(again.phase === 'idle' && isSolidBlock(world.getBlock(384, 32, 500)) && !closedCrossings(game).has('trestle') && walk().wet >= 10, 'the rematch rebuilds it');
crestClosed = true;
system.targets.damage(again.controller.target('supports'), 900, 'a');
F.runUntil(() => again.phase === "active", 5000);
const fall = F.kinds().filter(e => e.event === 'trestle' && e.phase === 'active' && !e.note).at(-1);
assert.equal(mapEventBanner(fall, { defs })?.detail, 'NO SOUTHERN CROSSING', 'with the dam crest gone the fall banners no southern crossing');
crestClosed = false;
MAP_EVENT_FX.trestle.clear(kit);

// Bots: EAST cornered at D wants the trestle down (its tanks keep E's road, WEST loses B-E), WEST holds the heads;
// a bot on foot with an RX-8 east of the canyon rockets the bents.
{
  const G = eventFixture({ map: 'redrock', defs: [TRESTLE_EVENT], controllers: { trestle: TrestleController } });
  const bots = attachBots(G.game, 2);
  G.run(TICK_MS * 2);
  for (const f of G.policy.capture.flags) {
    const own = f.id === 'D' ? 'bravo' : 'alpha';
    Object.assign(f, { owner: own, control: own === 'alpha' ? -1 : 1, state: 'idle', mover: null });
  }
  G.game.now += 20000;
  const value = crossingDenialValue(G.game, 'bravo', { close: 'trestle' });
  assert(value > 100, `cornered EAST gains by the trestle down (+${value} m)`);
  const brains = bots.brains.map(br => G.game.entities.get(String(br.id)));
  const bot = brains.find(p => G.game.mode.teamFor(p) === 'bravo'), other = brains.find(p => p !== bot);
  G.place(other, 80, 384);
  for (const v of G.game.vehicles.vehicles.values()) if (v.team === 'bravo') Object.assign(v, { hp: 0, respawnIn: 1e9 });
  G.place(bot, 440, 500);
  const slot = WEAPON_IDS.indexOf('rocket');
  bot.owned = [...new Set([...(bot.owned ?? []), 'rocket'])]; bot.mag[slot] = 1; bot.reserve[slot] = 4;
  const lev = G.system.instance('trestle').controller.levolution;
  G.runUntil(() => { if (bot.vehicleId) G.game.vehicles.release(bot); return lev.damage > 0; }, 20000);
  const tasks = team => (bots.commander.teams.get(team).structureTasks ?? []).map(t => t.id);
  assert(tasks('bravo').includes('demolish:trestle'), `EAST posts the demolish task (${tasks('bravo')})`);
  assert(tasks('alpha').some(id => id.startsWith('hold:trestle')), `WEST holds the heads (${tasks('alpha')})`);
  assert(lev.damage > 50 && lev.by === String(bot.id), `the bot rockets the bents (${lev.damage.toFixed(0)} of 900)`);
  console.log(`trestle: B-E +${trestleBE.toFixed(0)} m (+${bothBE.toFixed(0)} with the dam), HQ-W to E +${bothHQ.toFixed(0)}; fall ${fallen.data.blocks} blocks, `
    + `berm ${bermCells} cells, max tick ${maxTick.toFixed(1)} ms; EAST at D +${value} m, RX-8 ${lev.damage.toFixed(0)}`);
  bots.dispose();
}

console.log(`conquest trestle: ok (${(performance.now() - t0).toFixed(0)} ms)`);
