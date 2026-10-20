// Conquest map event framework (docs/conquest.md "Map events") on the real
// Frontier world with the framework fixture (shared/map-events/fixture.js):
//  - contract v7: the `map_event` kind, score reason and career XP, the `use` support intent;
//  - the phase machine (warning -> active -> done, a repeat's cooldown and caps), the director
//    queueing a second big event, Breakthrough awareness;
//  - the `ev` / `evp` wire round trip and its byte budget beside the 440 B base;
//  - a hold-to-use point (progress on `evp` and cq[6], one user, reset on leaving and damage),
//    an integrity target, a crush and a fire zone credited to the trigger with the event's kill key;
//  - a 30 000-cell staged voxel edit under the tick budget (block deltas, the bots' terrain watch),
//    reset by a rematch; bot tasks and hazard escape; HUD banner, prompt, audio cues and FX.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS, SCORE_CATEGORIES, SCORE_POINTS } from '../shared/conquest-contract.js';
import { CAREER_REWARDS } from '../shared/career.js';
import { decodeConquestPlayer } from '../shared/conquest-contract.js';
import { AIR, MC_WATER } from '../shared/world/blocks.js';
import { getMapMeta } from '../shared/worlddata.js';
import { parseConquestIntent } from '../server/protocol/admission.js';
import { TerrainWatch } from '../server/bot-surface-nav.js';
import {
  MAP_EVENT_RULES, decodeMapEvents, defineMapEvent, encodeMapEventPoint, encodeMapEventRow, integrityBlastDamage, mapEventsFor,
} from '../shared/conquest-map-events.js';
import { IRON_BRIDGE, IRON_BRIDGE_RULES, bridgeBlastDamage } from '../shared/conquest-bridge.js';
import { MapEventSystem, mapEventsOptionFromEnv } from '../server/modes/conquest/map-events/system.js';
import { planBoxEdit } from '../server/modes/conquest/map-events/staged-edits.js';
import { TASK_RANGE, hazardEscape, mapEventGoal, planMapEventTasks } from '../server/bot-map-events.js';
import { mapEventBanner } from '../public/js/ui/conquest/map-events.js';
import { interactModel } from '../public/js/ui/conquest-hud-state.js';
import { mapEventAudio } from '../public/js/audio/objective-cues.js';
import { MapEventFx } from '../public/js/fx/map-event-fx.js';
import { RecordingController, TICK_MS, conquestBaseBytes, eventFixture, fixtureMapEvent, groundY, mapEventWireBytes } from './lib/map-event-fixtures.mjs';
import { CONQUEST_MATCH_BUDGET_BYTES } from './lib/protocol-contract.mjs';

// ---------------------------------------------------------------- contract
assert.equal(CONQUEST_CONTRACT_VERSION, 8, 'map events are contract v7');
assert.deepEqual(CONQUEST_EVENT_KINDS.slice(CONQUEST_EVENT_KINDS.indexOf('map_event'), CONQUEST_EVENT_KINDS.indexOf('map_event') + 2), ['map_event', 'fpv'], 'the map_event kind is appended, the FPV drone after it');
assert.equal(SCORE_POINTS.map_event, 200);
assert(SCORE_CATEGORIES.objective.includes('map_event') && CAREER_REWARDS.conquestObjective.major.includes('map_event'), 'objective points, major career XP');
assert.deepEqual(parseConquestIntent({ t: 'conquest', support: { type: 'use', targetId: 'dam:0' } }), { type: 'support', support: 'use', targetId: 'dam:0' });
assert.throws(() => defineMapEvent({ id: 'Bad Id', maps: ['frontier'], kind: 'levolution' }), /must match/);

// ---------------------------------------------------------------- fixture world
const B = getMapMeta('frontier').conquest.flags.find(f => f.id === 'B');
const at = B.spawns[0], other = B.spawns[6];
const DEF = fixtureMapEvent({ anchor: { x: at.x, y: at.y, z: at.z } });
const TWIN = fixtureMapEvent({ id: 'twin', anchor: { x: other.x, y: other.y, z: other.z }, breakthrough: false });
const REPEAT = fixtureMapEvent({ id: 'zz-repeat', anchor: { x: other.x, y: other.y, z: other.z }, big: false, repeat: { cooldownMs: 2000, max: 2 } });
const defs = [DEF, TWIN, REPEAT];
const F = eventFixture({ defs, controllers: { fixture: RecordingController } });
const { game, policy, system } = F;
const a = F.player('a', 'alpha'), b = F.player('b', 'bravo'), a2 = F.player('a2', 'alpha');
F.run(TICK_MS * 2);
F.place(a, at.x, at.z, at.y); F.place(b, other.x, other.z, other.y); F.place(a2, other.x, other.z, other.y);
assert.equal(game.mode.phase, 'live');
assert.deepEqual(mapEventsFor('frontier', defs).map(d => d.id), ['fixture', 'twin', 'zz-repeat'], 'wire order: sorted ids');
const ev = system.instance('fixture'), twin = system.instance('twin'), rep = system.instance('zz-repeat');
assert(ev && twin && rep && ev.phase === 'idle');
assert.deepEqual(ev.controller.calls[0], ['reset']);
assert(!F.snap.match.conquest.ev, 'idle events add no `ev` row');
assert.deepEqual(F.snap.match.conquest.evp, [[0, 0, 3], [1, 0, 3], [2, 0, 3]], 'an enabled point rides `evp` with its team mask only');

// ---------------------------------------------------------------- hold-to-use
const use = (p, key = 'fixture:0') => game.mode.conquestIntent(p, { type: 'support', support: 'use', targetId: key });
const hold = (p, ms, key) => { for (let t = 0; t < ms; t += 200) { use(p, key); F.run(200); } };
hold(a, 1500);
const mid = system.points.get(ev, 'charge');
assert(mid.progress > 0.4 && mid.progress < 0.6, `half a 3 s hold (${mid.progress.toFixed(2)})`);
const ring = decodeConquestPlayer(F.snap.players.find(p => p.id === 'a')).actionProgress;
assert(Math.abs(ring - mid.progress) < 0.05, `the holder sees it on cq[6] (${ring})`);
assert.equal(use(F.place(b, at.x + 0.5, at.z), 'fixture:0'), false, 'one user at a time');
assert.equal(F.decoded().points.find(p => p.event === 'fixture').userTeam, 'alpha', 'evp names the side holding it');
F.place(a, at.x + 5, at.z, at.y); F.run(200);
assert.equal(mid.user, null, 'walking out of reach drops the hold');
F.place(a, at.x, at.z, at.y);
hold(a, 600); a.takeDamage(5, false, b, 'rifle'); F.run(TICK_MS);
assert.equal(mid.progress, 0, 'damage drops the hold');
hold(a, 3400);
assert.equal(ev.phase, 'armed', 'a completed hold reaches onUse (the fixture arms)');
assert.equal(ev.team, 'alpha');
F.run(TICK_MS);
const mapScore = id => F.kinds('score').filter(e => e.id === id && e.reason === 'map_event').reduce((n, e) => n + e.pts, 0);
assert.equal(mapScore('a'), 0, 'G3: a plant pays nothing by itself');
hold(b, 3400);
assert.equal(ev.phase, 'idle', 'the rival team defuses');
F.run(TICK_MS);
assert.equal(mapScore('b'), 200, 'G3: a defuse pays 200');
const defused = F.kinds().filter(e => e.event === 'fixture').at(-1);
assert.equal(defused.reason, 'defused');
assert.equal(mapEventBanner({ kind: 'map_event', ...defused }, { defs }).title, 'TEST PYLON · CHARGES DEFUSED', 'reason-keyed banner text');

// ---------------------------------------------------------------- phases, director, wire
F.events.length = 0;
assert(ev.trigger({ team: 'alpha', by: 'a' }), 'the event fires');
assert.equal(ev.phase, 'warning');
assert(twin.trigger({ team: 'bravo', by: 'b' }), 'a second big event is accepted');
assert.equal(twin.phase, 'armed', 'and queued');
assert.equal(twin.queued, true);
F.run(TICK_MS);
const warn = F.kinds().find(e => e.phase === 'warning');
assert(warn && warn.event === 'fixture' && warn.team === 'alpha' && warn.by === 'a' && Number.isFinite(warn.endsAt) && warn.pos.length === 3, 'one map_event per phase change (on the next broadcast)');
const wire = F.snap.match.conquest;
const row = wire.ev.find(r => r[0] === 0);
assert.deepEqual(row.slice(0, 4), [0, 2, 0, 0], '[index, phase warning, progress, team alpha, ...]');
assert(row[4] > 55 && row[4] <= 60, 'leftDs counts down the warning');
assert.deepEqual(row[5], [100], 'the controller extra rides as ev[5]');
const decoded = F.decoded();
assert.equal(decoded.events.find(e => e.id === 'twin').phase, 'armed');
assert(mapEventWireBytes(wire) <= MAP_EVENT_RULES.wire.budgetBytes, `ev + evp ${mapEventWireBytes(wire)} B within ${MAP_EVENT_RULES.wire.budgetBytes} B`);
assert(conquestBaseBytes(wire) <= CONQUEST_MATCH_BUDGET_BYTES, 'the base match.conquest keeps its budget');
// Codec: trimmed rows, extras, moved anchors and runtime points.
assert.deepEqual(encodeMapEventRow(3, { phase: 'done', progress: 0, team: null, leftMs: null }), [3, 4]);
const moved = encodeMapEventRow(1, { phase: 'active', progress: 0.5, team: 'bravo', leftMs: 1234, anchor: { x: 100.4, z: 200.6 } });
assert.deepEqual(moved, [1, 3, 50, 1, 12, 0, 100, 201]);
assert.deepEqual(encodeMapEventPoint(0, 2, { teams: new Set(['bravo']), progress: 0.25, userTeam: 'bravo', dynamic: true, x: 1.04, y: 2, z: 3 }), [0, 2, 2, 25, 1, 1, 2, 3]);
const rt = decodeMapEvents([moved], [[1, 0, 2, 40, 1]], 'frontier', defs);
assert.deepEqual([rt.events[0].id, rt.events[0].anchor.x, rt.events[0].leftMs, rt.points[0].teams, rt.points[0].progress], ['twin', 100, 1200, ['bravo'], 0.4]);
// Through the warning and the peak: the queued event waits for the first one's window plus the gap.
const window = system.director.list().find(w => w.id === 'fixture');
F.runUntil(() => twin.phase === 'warning', 30000);
assert.equal(ev.phase, 'done', 'warning 6 s -> active 4 s -> done');
assert(game.now >= window.end + MAP_EVENT_RULES.director.gapMs - TICK_MS, 'the second warning starts after the first peak plus the gap');
assert.equal(ev.trigger(), false, 'a once-per-round event never fires again');
// A repeating small event: cooldown, idle again, then its cap.
assert(rep.trigger({ team: 'bravo' }) && rep.phase === 'warning', 'small events never queue');
F.runUntil(() => rep.phase === 'cooldown', 12000);
F.runUntil(() => rep.phase === 'idle', 3000);
assert(rep.trigger() && F.runUntil(() => rep.phase === 'done', 12000) < 12000, 'the second fire ends done (max 2)');
// Breakthrough: an event with `breakthrough: false` does not run there.
const bt = new MapEventSystem({ mapMeta: { id: 'frontier' }, variant: 'breakthrough', now: 0 }, { defs });
bt.reset();
assert.deepEqual(bt.instances.map(i => i.id), ['fixture', 'zz-repeat']);
// VB_CONQUEST_EVENTS=fixture: the live fixture at the map's C flag with its server controller.
const live = new MapEventSystem({ mapMeta: getMapMeta('redrock'), variant: 'conquest', now: 0 }, { defs: mapEventsOptionFromEnv('fixture') });
live.reset();
assert.deepEqual([live.instances.map(i => i.id), live.instance('fixture').def.flag, live.instance('fixture').controller.constructor.name], [['fixture'], 'C', 'FixtureController']);

// ---------------------------------------------------------------- integrity, hazards, kill credit
for (let i = 0; i < 3; i++) game.mode.onBlast([at.x, at.y + 1, at.z], { key: 'rocket', radius: 3, ownerId: 'b' });
const pylon = system.targets.get(ev, 'pylon');
assert.equal(pylon.destroyed, true, 'three rockets drop a 300 pool');
assert.equal(pylon.by, 'b');
assert.deepEqual(ev.controller.calls.filter(c => c[0] === 'target').map(c => c[2]), [0.667, 0.333, 0], 'onTarget per blow');
// G3 results only: the final blow 300, every other contributor its share of the pool (up to 200), a detonated plant 50.
{
  const pool = { integrity: 1000, contrib: new Map([['b', 400], ['a', 500], ['a2', 100]]) };
  F.events.length = 0;
  assert.deepEqual(system.payDestroyed(pool, 'b'), { b: 300, a: 100, a2: 20 }, 'final blow 300, assists by share');
  assert.deepEqual(system.payDetonation(['a', 'a2'], 'a'), { a: 300, a2: 50 }, 'the detonation 300, the other planter 50');
  assert.equal(system.award('a', 'use'), 0, 'no use / hold payout');
  F.run(TICK_MS);
}
// The Iron Bridge keeps its numbers on the shared helper.
const pier = [IRON_BRIDGE.x - 0.5, IRON_BRIDGE.waterY + 1, IRON_BRIDGE.z - 2.5];
assert.deepEqual(bridgeBlastDamage(pier, 'rocket', 3), integrityBlastDamage(pier, 'rocket', 3, IRON_BRIDGE_RULES, IRON_BRIDGE.supports));
assert.equal(bridgeBlastDamage(pier, 'rocket', 3).damage, 100);
// Crush: lethal to the rival, a teammate of the trigger spared; credited with the event's kill key.
F.place(a, other.x + 1, other.z); F.place(b, other.x, other.z); F.place(a2, other.x - 1, other.z);
F.events.length = 0;
system.hazards.add(ev, { kind: 'crush', shape: 'circle', x: other.x, z: other.z, r: 4, by: 'a2' });
F.run(TICK_MS * 2);
const kill = F.kinds('kill').find(k => k.victim === 'b');
assert.equal(b.state, 'dead', 'the crush kills the rival');
assert.equal(a.state, 'alive', 'the trigger\'s teammate is spared');
assert.deepEqual([kill?.killer, kill?.w], ['a2', 'fixtureBlast'], 'credited to the trigger with the event\'s kill key');
// Fire: damage per second; bots inside flee to the edge.
F.place(a, other.x, other.z);
const zone = system.hazards.add(ev, { kind: 'fire', shape: 'circle', x: other.x, z: other.z, r: 6, dps: 10 });
F.run(1000);
assert(a.hp <= 91 && a.hp >= 88, `burning ground takes ~10 hp a second (${a.hp})`);
const flee = hazardEscape(game, a, 'alpha');
assert(flee && Math.hypot(flee.point.x - other.x, flee.point.z - other.z) >= 6 + MAP_EVENT_RULES.hazards.fleeMargin - 0.01, 'the escape goal leaves the zone');
system.hazards.remove(zone);

// ---------------------------------------------------------------- bot tasks
{
  const brains = [{ id: 'a' }, { id: 'a2' }];
  a.bot = true; a2.bot = true; F.place(a2, at.x + 3, at.z); F.place(a, at.x + 40, at.z);
  const commander = { game, teamBrains: () => brains, kitOf: () => 'assault' };
  const ts = { team: 'alpha', squads: new Map(), crews: new Map(), hitches: new Map(), memberSquad: new Map() };
  policy._view = null;
  planMapEventTasks(commander, ts, game.now);
  assert.equal(ts.eventAssign.get('a2'), 'fixture:use:charge', 'the nearest free bot takes the use task');
  const goal = mapEventGoal(commander, a2, ts);
  assert.deepEqual(goal.support, { type: 'support', support: 'use', targetId: 'fixture:0' }, 'and holds `use` through the bots\' support plumbing');
  // The 120 m booking radius: a bot farther out is never booked, even for a task asking more.
  F.place(a2, at.x + TASK_RANGE + 5, at.z);
  planMapEventTasks(commander, ts, game.now);
  assert.equal(TASK_RANGE, 120);
  assert.equal(ts.eventAssign.size, 1, 'only the bot within 120 m is booked');
  assert.equal(ts.eventAssign.get('a'), 'fixture:use:charge', 'the near one (40 m) takes it');
  a.bot = false; a2.bot = false;
}

// ---------------------------------------------------------------- staged voxel edits
{
  const box = { x0: Math.floor(B.x) - 25, x1: Math.floor(B.x) + 24, y0: 66, y1: 77, z0: Math.floor(B.z) - 25, z1: Math.floor(B.z) + 24 };
  const cells = planBoxEdit(F.world, box, { from: block => block === AIR, to: MC_WATER });
  const n = cells.length / 4;
  assert(n >= 29000, `a ${n}-cell edit`);
  const watch = new TerrainWatch(game);
  const changedBefore = game.changedBlocks.size;
  let done = false, blockBytes = 0, blockCells = 0, ticks = 0;
  const job = system.edits.enqueue({ cells, by: 'a', onDone: () => { done = true; } });
  const t0 = performance.now();
  while (!done && ticks < 2000) {
    game.step(TICK_MS); ticks++;
    const blocks = F.snap.blocks ?? [];
    if (blocks.length) { blockBytes += JSON.stringify(blocks).length; blockCells += blocks.length; }
    if (ticks === 1) assert(watch.poll()?.size > 0, 'the bots\' terrain watch sees the touched columns');
  }
  const wallMs = performance.now() - t0;
  assert(done && job.applied === n, 'every cell applied');
  assert.equal(ticks, Math.ceil(n / MAP_EVENT_RULES.edits.cellsPerTick), 'at the per-tick cell budget');
  assert(game.changedBlocks.size - changedBefore >= n, 'every cell is a map-cache delta for joiners');
  const stats = system.edits.stats;
  console.log(`staged edit: ${n} cells in ${ticks} ticks, edit step max ${stats.maxTickMs.toFixed(3)} ms, `
    + `${(blockBytes / blockCells).toFixed(1)} B JSON per cell in the tick, whole tick avg ${(wallMs / ticks).toFixed(2)} ms`);
  assert(stats.maxTickMs < 2, 'the edit step stays far below a long tick');
  // Rematch: the world, the events and the queue start over.
  system.edits.enqueue({ cells: planBoxEdit(F.world, { ...box, y0: 60, y1: 60 }, { from: block => block === AIR, to: MC_WATER }) });
  policy.reset();
  F.run(TICK_MS * 2);
  assert.equal(F.world.getBlock(box.x0, 70, box.z0), AIR, 'restoreWorld undid the edit');
  assert.equal(system.edits.jobs.length, 0, 'no queued job survives');
  assert(system.instances.every(i => i.phase === 'idle' && i.fires === 0), 'every event idle again');
  assert(!F.snap.match.conquest.ev, 'no `ev` after the rematch');
  assert.equal(system.targets.get(system.instance('fixture'), 'pylon').destroyed, false, 'targets whole again');
}

// ---------------------------------------------------------------- client
{
  const now = 1000;
  const banner = mapEventBanner({ kind: 'map_event', event: 'fixture', phase: 'warning', team: 'bravo', endsAt: now + 6000 },
    { nowMs: now, selfTeam: 'alpha', defs, where: () => '240 M NE' });
  assert.equal(banner.title, 'TEST PYLON · COLLAPSE IMMINENT');
  assert.equal(banner.detail, 'GET OUT OF THE BLAST ZONE', 'the enemy-side detail');
  assert.deepEqual([banner.tone, banner.icon, banner.countdown.label], ['hazard', 'charge', 'COLLAPSE IN']);
  assert.deepEqual(mapEventAudio({ kind: 'map_event', event: 'fixture', phase: 'warning', team: 'bravo' }, 'alpha', defs), { stinger: 'ticket_low', cue: 'under_attack_C' });
  assert.deepEqual(mapEventAudio({ kind: 'map_event', event: 'fixture', phase: 'warning', team: 'alpha' }, 'alpha', defs), { stinger: 'ticket_low', cue: 'winning' });
  const points = decodeMapEvents(null, [[0, 0, 3]], 'frontier', defs).points;
  const self = { id: 'me', team: 'alpha', state: 'alive', hp: 100, x: at.x + 1, y: at.y, z: at.z, cq: [0, 1, 0, 0, 0, 0, 0] };
  const prompt = interactModel({ self, players: [self], mapEvents: { points } });
  assert.deepEqual([prompt.type, prompt.label, prompt.targetId, prompt.hold], ['use', 'PLANT CHARGE', 'fixture:0', true]);
  let trauma = 0;
  const fx = new MapEventFx({ defs, hooks: {}, cameraShake: { add: t => { trauma += t; } }, getCamera: () => ({ position: { x: at.x + 20, y: at.y, z: at.z } }) });
  fx.mapId = 'frontier';
  assert(fx.handleEvent({ kind: 'map_event', event: 'fixture', phase: 'active', pos: [at.x, at.y, at.z] }) && trauma > 0.2, 'the generic strike shakes a camera 20 m off');
  assert.equal(groundY(F.world, at.x, at.z) > 0, true);
}

console.log('conquest map events: contract v7, phases and director, wire and budget, hold, integrity, hazards, bots, staged edits, rematch, HUD passed');
process.exit(0);
