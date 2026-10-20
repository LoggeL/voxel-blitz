// Redrock Dam breach (docs/conquest.md "Redrock Dam breach") on the real
// Redrock Canyon world: the two gallery charges (plant, the 40 s fuse, a
// defuse that stops it), the siren with the crest closed and the bots' flee
// zones, the breach (crest gap, gallery flood, crush credited to the
// planter), the 45 s drain and the canyon flood with the wave front, the
// wash ford closed, flag C still deployable, the joiner's map-cache patch,
// bot tasks, the HUD read model and a rematch.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { AIR, MC_WATER, isSolidBlock } from '../shared/world/blocks.js';
import { DAM_EVENT, DAM_TUNING } from '../shared/map-events/dam.js';
import { MAP_EVENT_DEFS, mapEventsFor } from '../shared/conquest-map-events.js';
import { DamController } from '../server/modes/conquest/map-events/dam.js';
import { damPlan } from '../server/modes/conquest/map-events/dam-plan.js';
import { hazardEscape } from '../server/bot-map-events.js';
import { closedCrossings } from '../server/bot-bridge.js';
import { encodeMapFrame } from '../shared/world/serialize.js';
import { mapEventBanner } from '../public/js/ui/conquest/map-events.js';
import { DAM_PRESENTER, damMapState } from '../public/js/ui/conquest/map-events/dam.js';
import { TICK_MS, eventFixture, mapEventWireBytes } from './lib/map-event-fixtures.mjs';

assert(MAP_EVENT_DEFS.includes(DAM_EVENT) && mapEventsFor('redrock').includes(DAM_EVENT) && !mapEventsFor('frontier').includes(DAM_EVENT),
  'registered, Redrock only');

const F = eventFixture({ map: 'redrock', defs: [DAM_EVENT], controllers: { dam: DamController } });
const { game, policy, system, world } = F;
const [W, E] = DAM_TUNING.charges;
const a = F.player('a', 'alpha'), b = F.player('b', 'bravo'), crest = F.player('crest', 'bravo'), tunnel = F.player('tunnel', 'bravo');
F.run(TICK_MS * 2);
const dam = system.instance('dam');
assert(dam && dam.phase === 'idle');
const use = (p, key) => game.mode.conquestIntent(p, { type: 'support', support: 'use', targetId: key });
const key = id => `dam:${DAM_EVENT.points.findIndex(p => p.id === id)}`;
const hold = (p, id, ms = 5400) => { for (let t = 0; t < ms; t += 200) { use(p, key(id)); F.run(200); } };
const at = (p, c) => F.place(p, c.x, c.z, c.y);
assert.deepEqual(F.snap.match.conquest.evp.map(r => r[2]), [3, 3], 'both plant spots open to both sides, no defuse spot yet');
{
  const C = policy.flags.find(f => f.id === 'C'), owner = C.owner;
  C.owner = 'bravo';
  const view = system.view();
  assert.deepEqual(view.tasks.alpha.map(t => t.id), ['dam:use:plant-west', 'dam:use:plant-east'], 'the enemy holds C: alpha bots go plant');
  assert.equal(view.tasks.bravo.length, 0, 'the holders of C do not blow their own crest');
  C.owner = owner;
}
{
  // Breakthrough: only the attackers plant, and only while C's sector is the active one.
  const BT = eventFixture({ map: 'redrock', variant: 'breakthrough', defs: [DAM_EVENT], controllers: { dam: DamController } });
  BT.run(TICK_MS * 2);
  assert(BT.system.instance('dam') && !BT.snap.match.conquest.evp, 'sector 1: no plant spot');
  BT.policy.bt.sector = 1;
  BT.run(TICK_MS * 2);
  assert.deepEqual(BT.snap.match.conquest.evp.map(r => r[2]), [1, 1], 'sector 2 (C): the attackers (WEST) may plant');
}

// ---------------------------------------------------------------- charges
at(a, W); hold(a, 'plant-west');
assert.deepEqual([dam.phase, dam.team, dam.endsAt], ['armed', 'alpha', null], 'one charge: armed, no fuse yet');
assert.equal(F.kinds().at(-1).reason, 'one');
at(b, E); hold(b, 'plant-east');
assert.equal(dam.controller.charges[1], null, 'the rival side cannot plant the second charge');
at(a, E); hold(a, 'plant-east');
assert.equal(F.kinds().at(-1).reason, 'fuse');
assert(Math.abs(dam.leftMs - DAM_TUNING.fuseMs) < 1000, 'both charges: the 40 s fuse runs');
assert.deepEqual(F.decoded().events[0].extra, [3, 0, 0], 'ev extra: both charges set');
const tasksB = system.view().tasks.bravo.map(t => t.id), tasksA = system.view().tasks.alpha.map(t => t.id);
assert(tasksB.includes('dam:use:defuse-west') && tasksB.includes('dam:use:defuse-east') && tasksB.includes('dam:escort'), `bravo bots defuse (${tasksB})`);
assert(tasksA.includes('dam:guard'), 'alpha bots guard the gallery');
at(b, E); hold(b, 'defuse-east');
assert.deepEqual([dam.phase, dam.endsAt, F.kinds().at(-1).reason], ['armed', null, 'defused'], 'a defuse stops the fuse');
assert(F.kinds('score').some(e => e.id === 'b' && e.reason === 'map_event' && e.pts === 200), 'a defuse pays 200');
at(a, E); hold(a, 'plant-east');
assert(Number.isFinite(dam.endsAt), 'planted again: the fuse runs from the start');
assert(mapEventWireBytes(F.snap.match.conquest) <= 60, `ev + evp stay small (${mapEventWireBytes(F.snap.match.conquest)} B)`);

// ---------------------------------------------------------------- siren
F.place(a, 330, 420); F.place(b, 334, 420);
F.runUntil(() => dam.phase === 'warning', DAM_TUNING.fuseMs + 1000);
assert.equal(dam.phase, 'warning');
assert(closedCrossings(game).has('redrock-dam'), 'the crest closes for bot drivers at the siren');
F.place(tunnel, 384, 383.5, 24);
assert(hazardEscape(game, tunnel, 'bravo'), 'a bot in the gallery runs out');
const crestY = 34.02;
F.place(crest, 384.5, 384.5, crestY);
assert(hazardEscape(game, crest, 'bravo'), 'a bot on the crest gap runs off it');
assert(hazardEscape(game, { x: 380, y: 21.5, z: 450 }, 'bravo'), 'and off the canyon floor');

// ---------------------------------------------------------------- breach and flood
const plan = damPlan(world, DAM_TUNING);
F.runUntil(() => dam.phase === 'active', 11000);
assert.equal(dam.phase, 'active');
F.place(crest, 384.5, 384.5, crestY); F.place(tunnel, 384, 383.5, 24);
let peak = 0, ticks = 0, blockCells = 0;
const t0 = performance.now();
while (dam.phase !== 'done' && ticks * TICK_MS < 60000) {
  const s = performance.now(); game.step(TICK_MS); peak = Math.max(peak, performance.now() - s); ticks++;
  blockCells += F.snap.blocks?.length ?? 0;
  if (crest.state === 'alive' && ticks < 30) F.place(crest, 384.5, 384.5, crest.y);
  if (tunnel.state === 'alive' && ticks < 200) F.place(tunnel, 384, 383.5, 24);
}
assert(Math.abs(ticks * TICK_MS - DAM_TUNING.drain.ms) < 3000, `the flood runs its 45 s (${(ticks * TICK_MS / 1000).toFixed(1)} s)`);
const wall = performance.now() - t0;
assert.equal(dam.phase, 'done', 'the breach ends once the flood is applied and the wave is out');
const kills = F.kinds('kill');
assert(kills.some(k => k.victim === 'tunnel' && k.w === 'damFlood' && k.killer === 'a'), 'the flooded gallery kills, credited to the planter');
assert(crest.state !== 'alive' || crest.hp < 100, 'the crest under a body gives way');
assert.equal(world.getBlock(384, 33, 384), AIR, 'the crest middle is gone');
assert.equal(world.getBlock(384, 21, 384), world.templateBlock(384, 21, 384), 'the sill stays');
assert(isSolidBlock(world.getBlock(360, 33, 384)) && isSolidBlock(world.getBlock(408, 33, 384)), 'the abutments stand');
let wet = 0, dry = 0;
for (let i = 0; i < plan.flood.cells.length; i += 4) {
  const v = world.getBlock(plan.flood.cells[i], plan.flood.cells[i + 1], plan.flood.cells[i + 2]);
  if (plan.flood.cells[i + 3] === AIR) dry += v === AIR; else wet += v === MC_WATER;
}
assert.equal(dry, plan.counts.drained, 'every reservoir cell above the sill drained');
assert.equal(wet, plan.counts.canyon, 'the canyon flooded 2 m higher');
assert(world.templateBlock(377, 24, 370) === MC_WATER && world.getBlock(377, 24, 370) === AIR, 'the intake tower foot stands dry');
assert(closedCrossings(game).has('wash-ford'), 'the wash ford closes under 3 m of water');
assert.deepEqual(F.decoded().events[0].extra?.slice(1, 2), [100], 'ev: drained');
// Flag C: every spawn cell on the abutments still standable and dry, the zone still reachable at crest level.
const standable = s => isSolidBlock(world.getBlock(Math.floor(s.x), Math.floor(s.y) - 1, Math.floor(s.z)))
  && [0, 1].every(dy => { const v = world.getBlock(Math.floor(s.x), Math.floor(s.y) + dy, Math.floor(s.z)); return !isSolidBlock(v) && v !== MC_WATER; });
assert.equal(F.meta.conquest.flags.find(f => f.id === 'C').spawns.filter(standable).length, 12, 'flag C keeps its 12 spawn cells');
assert(isSolidBlock(world.getBlock(368, 33, 384)) && isSolidBlock(world.getBlock(400, 33, 384)), 'both abutments stay inside the capture zone');

// Joiner: the map-cache patch of every changed cell.
const cells = world.divergentCells ? [...world.divergentCells] : null;
const frame = world.mapFrame?.({ cached: true });
const patch = frame?.byteLength ?? (cells ? cells.length * 5 : 0);
const deflated = frame ? deflateSync(frame).length : 0;
console.log(`dam breach: ${plan.counts.total} cells (${plan.counts.breach} breach, ${plan.counts.drained} drained over ${plan.counts.drainedColumns} columns, `
  + `${plan.counts.canyon} canyon), plan ${plan.buildMs.toFixed(0)} ms once per template; ${ticks} ticks, peak tick ${peak.toFixed(2)} ms, `
  + `avg ${(wall / ticks).toFixed(2)} ms, edit step max ${system.edits.stats.maxTickMs.toFixed(2)} ms, ${(blockCells / ticks).toFixed(1)} block deltas a tick; `
  + `joiner reference frame ${(patch / 1024).toFixed(0)} KB, ${(deflated / 1024).toFixed(0)} KB deflated`);
assert(deflated < 200 * 1024, 'a joiner\'s patch stays under 200 KB deflated');

// ---------------------------------------------------------------- HUD
{
  const ev = F.decoded().events[0];
  const banner = mapEventBanner({ kind: 'map_event', event: 'dam', phase: 'warning', team: 'alpha', endsAt: 11000 }, { nowMs: 1000, selfTeam: 'bravo' });
  assert.equal(banner.title, 'REDROCK DAM · BREACH IMMINENT');
  assert.equal(banner.countdown.label, 'BREACH IN');
  const state = damMapState(ev);
  assert.deepEqual([state.breached, state.drain, state.front], [true, 1, 0]);
  assert.equal(typeof DAM_PRESENTER.paintMap, 'function');
}

// ---------------------------------------------------------------- rematch
policy.reset();
F.run(TICK_MS * 2);
assert(isSolidBlock(world.getBlock(384, 33, 384)) && world.getBlock(372, 26, 360) === world.templateBlock(372, 26, 360), 'restoreWorld rebuilds the dam and refills the lake');
assert(system.instance('dam').phase === 'idle' && !closedCrossings(game).size, 'idle again, every crossing open');
console.log('dam breach: charges, fuse and defuse, siren and flee zones, breach, drain and canyon flood, crossings, joiner patch, HUD, rematch passed');
