// Conquest ribbons, medals and the result debrief (docs/conquest.md "Ribbons and medals"):
// the contract tables, every ribbon through the real score ledger at its threshold,
// the once-per-life spree, ribbon points and score categories, medals at match end,
// the v6 results rows (cqr, cqm, cqp, cxp), takeover and rematch, career XP for
// ribbons and medals, and the toast and debrief read models on a fake DOM.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import {
  CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS, MEDALS, MEDAL_IDS, RIBBONS, RIBBON_IDS, SCORE_CATEGORIES, SCORE_CATEGORY_IDS, SCORE_LABELS,
  SCORE_POINTS, decodeConquestResult, scoreCategory,
} from '../shared/conquest-contract.js';
import { CAREER_REWARDS, careerLevel, careerLevelXp } from '../shared/career.js';
import { RibbonTracker } from '../server/modes/conquest/ribbons.js';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

// ------------------------------------------------------------- contract --
{
  eq(CONQUEST_CONTRACT_VERSION, 6, 'ribbons and medals are contract v6');
  eq(RIBBON_IDS, ['spree', 'medic', 'anti_vehicle', 'conquest', 'resupply', 'repair', 'intel', 'defender'], 'ribbon wire order');
  eq(MEDAL_IDS, ['valor', 'lifesaver', 'tank_hunter', 'conqueror', 'quartermaster', 'mechanic', 'pathfinder', 'guardian', 'service'], 'medal wire order');
  ok(CONQUEST_EVENT_KINDS.includes('ribbon') && CONQUEST_EVENT_KINDS.includes('medal'), 'ribbon and medal are Conquest events');
  ok(CONQUEST_EVENT_KINDS.indexOf('ribbon') > CONQUEST_EVENT_KINDS.indexOf('mortar') && CONQUEST_EVENT_KINDS.indexOf('mortar') > CONQUEST_EVENT_KINDS.indexOf('ejection'), 'new events are appended after the earlier v6 kinds');
  eq([SCORE_POINTS.ribbon, SCORE_LABELS.ribbon], [50, 'RIBBON']);
  for (const [id, rule] of Object.entries(RIBBONS)) {
    ok(rule.count >= 2 && ['life', 'match'].includes(rule.scope), `${id}: threshold and scope`);
    for (const reason of rule.reasons) ok(Number.isFinite(SCORE_POINTS[reason]) && reason !== 'ribbon', `${id} counts the score reason ${reason}`);
  }
  for (const [id, medal] of Object.entries(MEDALS)) ok(medal.ribbon === null || RIBBONS[medal.ribbon], `${id} names a ribbon`);
  // Every score reason belongs to exactly one category, so the categories sum to the score.
  const listed = Object.values(SCORE_CATEGORIES).flat();
  eq([...listed].sort(), Object.keys(SCORE_POINTS).sort(), 'every SCORE_POINTS reason has exactly one category');
  eq(SCORE_CATEGORY_IDS, ['combat', 'objective', 'vehicles', 'support', 'ribbons']);
  eq([scoreCategory('revive'), scoreCategory('vehicle_crew'), scoreCategory('not_a_reason')], ['support', 'vehicles', 'combat']);
  eq(CAREER_REWARDS.conquestRibbon.xp, 20); eq(CAREER_REWARDS.conquestMedal.xp, 50);
  eq([careerLevelXp(1), careerLevelXp(5), careerLevelXp(6)], [0, 1600, 2500], 'level floors invert careerLevel');
  for (const level of [1, 2, 6, 9]) eq(careerLevel(careerLevelXp(level)), level);
  eq(decodeConquestResult({}), { ribbons: Object.fromEntries(RIBBON_IDS.map(id => [id, 0])), medals: [],
    categories: Object.fromEntries(SCORE_CATEGORY_IDS.map(id => [id, 0])), career: null }, 'a row without extras decodes empty');
  eq(decodeConquestResult({ cqr: [2, 1], cqm: [0, 8, 99], cqp: [500, 250], cxp: [3240, 640] }).medals, ['valor', 'service'], 'unknown medal indices are dropped');
}

// ---------------------------------------------------- tracker (pure) --
{
  const paid = [];
  const tracker = new RibbonTracker({ ribbon: (id, ribbon, count) => paid.push([id, ribbon, count]) });
  for (let i = 0; i < 9; i++) tracker.onAward('p', 'kill');
  eq(paid, [['p', 'spree', 1]], 'nine kills in one life pay one spree');
  tracker.onDeath('p');
  for (let i = 0; i < 3; i++) tracker.onAward('p', 'kill');
  eq(paid.length, 1, 'three kills after a death are no spree');
  tracker.onAward('p', 'kill');
  eq(paid.at(-1), ['p', 'spree', 2], 'the fourth kill of the new life is the second spree');
  for (let i = 0; i < 15; i++) tracker.onAward('p', 'revive');
  eq(paid.filter(r => r[1] === 'medic').map(r => r[2]), [1, 2, 3], 'match ribbons repeat at every multiple (5, 10, 15)');
  tracker.onDeath('p');
  for (let i = 0; i < 5; i++) tracker.onAward('p', 'revive');
  eq(paid.filter(r => r[1] === 'medic').length, 4, 'a death does not reset match ribbons');
  tracker.onAward('p', 'heal'); tracker.onAward('p', 'ribbon');
  eq(paid.length, 6, 'reasons no ribbon counts pay nothing');
  eq(tracker.ribbonRow('p'), [2, 4, 0, 0, 0, 0, 0, 0]);
  eq(tracker.medalRow('p'), [], 'no medals before the match ends');
  eq(tracker.finish(['p', 'q']), [['p', 'valor'], ['p', 'lifesaver'], ['p', 'service']], 'medals from the ribbon counts, MEDAL_IDS order');
  eq(tracker.medalRow('p').map(i => MEDAL_IDS[i]), ['valor', 'lifesaver', 'service']);
  tracker.rename('p', 'h');
  eq([tracker.ribbonRow('h')[1], tracker.ribbonRow('p')[1]], [4, 0], 'a takeover carries the ribbons');
}

// ----------------------------------------------------- live engine --
const SX = 200, SY = 32, SZ = 160;
const spot = (x, z) => ({ x: x + 0.5, y: 2, z: z + 0.5 });
const ring = (x, z) => Array.from({ length: 12 }, (_, i) => spot(x + Math.round(Math.cos(i * Math.PI / 6) * 6), z + Math.round(Math.sin(i * Math.PI / 6) * 6)));
const flagRow = (id, x, z, home) => ({ id, name: id, ...spot(x, z), radius: 10, home, spawns: ring(x, z) });
function fixture() {
  const hq = (team, x) => ({ id: team, name: team, ...spot(x, 80), radius: 12, spawns: [spot(x, 74), spot(x, 77), spot(x, 80), spot(x, 83), spot(x, 86)] });
  const bases = { alpha: hq('alpha', 8), bravo: hq('bravo', SX - 9) };
  const mapMeta = { id: 'frontier', dimensions: { sx: SX, sy: SY, sz: SZ }, spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
    conquest: { version: 2, bases, combatArea: { minX: 2, maxX: SX - 2, minZ: 2, maxZ: SZ - 2 }, vehicleSpawns: [],
      flags: [flagRow('A', 50, 40, 'alpha'), flagRow('B', 50, 120, 'alpha'), flagRow('C', 100, 80, null), flagRow('D', 150, 40, 'bravo'), flagRow('E', 150, 120, 'bravo')] } };
  const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock: (x, y, z) => (x < 0 || z < 0 || x >= SX || z >= SZ || y < 2 ? 1 : 0),
    findSpawns: () => [spot(20, 20)], setBlock: () => {} };
  const log = [];
  const game = new GameEngine({ mode: 'conquest', mapMeta, world, broadcast: snap => { log.push(...snap.events); game.lastSnapshot = snap; } });
  return { game, log, policy: game.mode.policy };
}
const run = (game, ms) => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
const place = (p, x, z) => Object.assign(p, { x: x + 0.5, y: 2, z: z + 0.5, vx: 0, vy: 0, vz: 0 });

const { game, log, policy } = fixture();
const ids = ['h1', 'b1', 'a2', 'b2', 'a3', 'b3'];
for (const id of ids) game.addClient(id, id);
const [h1, a2, a3] = ['h1', 'a2', 'a3'].map(id => game.entities.get(id));
const bravo = ids.map(id => game.entities.get(id)).filter(p => p.team === 'bravo');
ok(h1.team === 'alpha' && a2.team === 'alpha' && bravo.length === 3, 'balanced teams');
for (const p of [h1, a2, a3]) place(p, 6, 72 + Math.random() * 10);
bravo.forEach((p, i) => place(p, SX - 6, 72 + i * 3));
run(game, TICK_MS);
const ribbons = (id, ribbon) => log.filter(e => e.kind === 'ribbon' && e.id === id && (!ribbon || e.ribbon === ribbon));
const respawn = victim => { if (victim.state === 'dead') { game.respawnPlayer(victim, spot(SX - 6, 90)); game.mode.onPlayerRespawn(victim); } };
const killOne = (killer, i) => {
  const victim = bravo[i % bravo.length];
  respawn(victim); place(victim, 120, 140);
  game.killPlayer(victim, killer, 'rifle', false);
  run(game, TICK_MS);
};

// SPREE: four enemy kills in one life, through the real kill payout.
for (let i = 0; i < 3; i++) killOne(h1, i);
eq(ribbons('h1').length, 0, 'three kills: no ribbon yet');
killOne(h1, 3);
const spree = ribbons('h1', 'spree');
eq(spree.map(e => [e.count, e.pts]), [[1, SCORE_POINTS.ribbon]], 'the fourth kill earns the SPREE RIBBON with its points');
ok(log.some(e => e.kind === 'score' && e.id === 'h1' && e.reason === 'ribbon' && e.pts === SCORE_POINTS.ribbon), 'the ribbon is a score award');
for (let i = 4; i < 7; i++) killOne(h1, i);
eq(ribbons('h1', 'spree').length, 1, 'once per life');
// The human dies: the next four kills are a new spree.
game.killPlayer(h1, bravo[0], 'rifle', false);
run(game, TICK_MS);
respawn(h1); place(h1, 6, 80); run(game, TICK_MS);
for (let i = 0; i < 4; i++) killOne(h1, i);
eq(ribbons('h1', 'spree').map(e => e.count), [1, 2], 'a new life, a second spree');

// Every other ribbon at exactly its threshold, through policy.award (the roles package's path).
for (const id of RIBBON_IDS.filter(r => r !== 'spree')) {
  const rule = RIBBONS[id];
  for (let i = 0; i < rule.count - 1; i++) policy.award(a3.id, rule.reasons[0]);
  eq(ribbons(a3.id, id).length, 0, `${id}: nothing below ${rule.count}`);
  policy.award(a3.id, rule.reasons[0]);
  run(game, TICK_MS);
  eq(ribbons(a3.id, id).map(e => e.count), [1], `${id}: ${rule.detail}`);
}
// A second MEDIC RIBBON for the a3 medal.
for (let i = 0; i < RIBBONS.medic.count; i++) policy.award(a3.id, 'revive');
run(game, TICK_MS);
eq(ribbons(a3.id, 'medic').map(e => e.count), [1, 2]);

// Score categories sum to the score; ribbons are their own category.
const results = () => game.lastSnapshot.match.results ?? [];
for (const p of [h1, a3]) {
  const row = policy.resultExtras(p.id);
  eq(row.cqp.reduce((a, b) => a + b, 0), p.score, `${p.id}: categories sum to the score`);
  eq(row.cqp[SCORE_CATEGORY_IDS.indexOf('ribbons')], ribbons(p.id).length * SCORE_POINTS.ribbon, `${p.id}: ribbon points`);
}
eq(policy.resultExtras(a3.id).cqr, [0, 2, 1, 1, 1, 1, 1, 1], 'a3 ribbon row');

// Career progress for the human (lobby stamp, then the career service), never for bots.
ok(policy.setCareerProgress(h1, { xp: 3000 }), 'admission stamp');
ok(policy.setCareerProgress(h1, { xp: 2900, gained: 120 }), 'a stale lower total never lowers the XP');
eq(policy.resultExtras(h1.id).cxp, [3000, 120]);
ok(!policy.setCareerProgress(a2, { xp: 'x' }), 'non-finite XP is ignored');

// Match end: medals before the rows freeze, one event per medal.
policy.ledger.tickets.bravo = 1;
respawn(bravo[0]); place(bravo[0], 120, 140);
game.killPlayer(bravo[0], a2, 'rifle', false);
run(game, TICK_MS);
eq(policy.phase, 'post', 'the match ended');
const medals = log.filter(e => e.kind === 'medal');
eq(medals.filter(e => e.id === 'h1').map(e => e.medal), ['valor'], 'two sprees earn the VALOR MEDAL');
eq(medals.filter(e => e.id === a3.id).map(e => e.medal), ['lifesaver', 'service'], 'two medic ribbons and eight ribbons in all');
ok(medals.every(e => MEDAL_IDS.includes(e.medal)), 'medal ids are contract ids');
eq(policy.award(a3.id, 'revive'), 0, 'no awards after the match');
const before = log.length;
run(game, TICK_MS * 4);
eq(log.slice(before).filter(e => e.kind === 'ribbon' || e.kind === 'medal').length, 0, 'medals are decided once');
const hRow = results().find(r => r.id === 'h1');
const aRow = results().find(r => r.id === a3.id);
eq(decodeConquestResult(hRow).ribbons.spree, 2);
eq(decodeConquestResult(hRow).medals, ['valor']);
eq(decodeConquestResult(aRow).medals, ['lifesaver', 'service']);
eq(decodeConquestResult(hRow).career, { xp: 3000, gained: 120 }, 'results carry the career pair');
ok(!('cxp' in aRow), 'bots have no career row');
// Post-match XP (match, victory, medals) still reaches the frozen row.
policy.setCareerProgress(h1, { xp: 3270, gained: 390 });
run(game, TICK_MS);
eq(decodeConquestResult(results().find(r => r.id === 'h1')).career, { xp: 3270, gained: 390 }, 'the career pair stays live after the freeze');
// The career pair is private: each recipient's tick (server/lobby.js viewFor) keeps only their own `cxp`.
{
  const tick = { t: 'tick', match: { ...game.lastSnapshot.match, results: [...results(), { id: 'h9', name: 'Other', team: 'bravo', score: 0, cxp: [900, 40] }] } };
  const own = policy.viewFor('h1', tick), other = policy.viewFor('h9', tick), bot = policy.viewFor(a3.id, tick), guest = policy.viewFor('spectator', tick);
  const cxpOf = (view, id) => view.match.results.find(r => r.id === id)?.cxp;
  eq([cxpOf(own, 'h1'), cxpOf(own, 'h9')], [[3270, 390], undefined], 'h1 sees its own career pair only');
  eq([cxpOf(other, 'h1'), cxpOf(other, 'h9')], [undefined, [900, 40]], 'and h9 only its own');
  ok(bot === guest && bot.match.results.every(r => !('cxp' in r)), 'everyone without a career row shares one stripped tick');
  eq(cxpOf(tick, 'h9'), [900, 40], 'the authoritative tick (career rewards) is untouched');
  eq(own.match.results.map(r => r.id), tick.match.results.map(r => r.id), 'every row stays, in order');
  eq(policy.viewFor('h1', { t: 'tick', match: { phase: 'live' } }), null, 'no results: the tick goes out as it is');
}

// Rematch: ribbons, medals and the match XP start over.
const vote = game.lastSnapshot.match.continuation;
for (const id of ['h1', 'a2', 'a3', 'b1', 'b2', 'b3'].slice(0, vote.required)) game.mode.approveContinuation(id, vote.id);
run(game, 5200);
eq(policy.phase, 'live', 'rematch');
eq(policy.resultExtras(h1.id).cqr, RIBBON_IDS.map(() => 0), 'ribbons reset');
eq(policy.resultExtras(h1.id).cqm, [], 'medals reset');
eq(policy.resultExtras(h1.id).cxp, [3270, 0], 'the career total stays, the match gain resets');

// Takeover: a human taking a bot's place keeps that body's ribbons.
policy.award(a2.id, 'revive');
for (let i = 1; i < RIBBONS.medic.count; i++) policy.award(a2.id, 'revive');
ok(policy.onPlayerTakeover(a2, 'h2'), 'takeover');
eq(policy.resultExtras('h2').cqr[1], 1, 'ribbons follow the takeover');

// ----------------------------------------------------- career service --
{
  const { CareerService } = await import('../server/career.js');
  const directory = path.join(root, '.conquest-work', 'wip', 'ribbons', `career-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const service = new CareerService({ directory });
  try {
    const profileId = randomBytes(32).toString('hex');
    const entity = { id: 'p1', bot: false, team: 'alpha', input: null };
    const progress = [];
    const engine = { entities: new Map([['p1', entity]]), mode: { policy: { setCareerLevel: () => {}, setCareerProgress: (e, p) => progress.push(p) } } };
    const client = { id: 'p1', profileId, room: { engine }, careerLevel: 1 };
    const tick = (now, phase, events) => service.observe(client, { t: 'tick', now, match: { mode: 'conquest', phase, winner: phase === 'post' ? 'bravo' : undefined },
      players: [{ id: 'p1', team: 'alpha', state: 'alive' }], events });
    tick(1000, 'live', []);
    tick(1100, 'live', [{ kind: 'score', id: 'p1', pts: 50, reason: 'ribbon' }, { kind: 'score', id: 'other', pts: 50, reason: 'ribbon' }]);
    eq(service.profile(profileId).xp, CAREER_REWARDS.conquestRibbon.xp, 'a ribbon pays conquestRibbon XP');
    eq(progress.at(-1), { xp: CAREER_REWARDS.conquestRibbon.xp, gained: CAREER_REWARDS.conquestRibbon.xp }, 'the progress reaches the policy');
    tick(1200, 'post', [{ kind: 'medal', id: 'p1', medal: 'valor' }, { kind: 'medal', id: 'p1', medal: 'service' }, { kind: 'medal', id: 'other', medal: 'valor' }]);
    const xp = service.profile(profileId).xp;
    eq(xp, CAREER_REWARDS.conquestRibbon.xp + 2 * CAREER_REWARDS.conquestMedal.xp, 'two own medals pay conquestMedal XP each');
    eq(progress.at(-1), { xp, gained: xp }, 'the match gain counts the medals');
    eq(client.careerXp, xp, 'the client keeps the total for the next stamp');
    tick(1300, 'live', []);
    tick(1400, 'live', [{ kind: 'score', id: 'p1', pts: 50, reason: 'ribbon' }]);
    eq(progress.at(-1), { xp: xp + CAREER_REWARDS.conquestRibbon.xp, gained: CAREER_REWARDS.conquestRibbon.xp }, 'a rematch starts a new match gain');
    // Ribbon scores and medals pay career XP in Conquest only.
    const tdmProfile = randomBytes(32).toString('hex');
    const tdmClient = { id: 'p1', profileId: tdmProfile, room: { engine }, careerLevel: 1 };
    service.observe(tdmClient, { t: 'tick', now: 1000, match: { mode: 'tdm', phase: 'live' }, players: [{ id: 'p1', team: 'alpha', state: 'alive' }],
      events: [{ kind: 'score', id: 'p1', pts: 50, reason: 'ribbon' }, { kind: 'medal', id: 'p1', medal: 'valor' }] });
    eq(service.profile(tdmProfile).xp, 0, 'no ribbon or medal XP outside Conquest');
  } finally {
    service.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

// ------------------------------- career service, PostgreSQL-like async saves --
{
  // Saves that resolve late (after a newer save, or after the rematch reset the
  // tally) update the career total but never overwrite the newer match gain.
  const { CareerService } = await import('../server/career.js');
  let total = 0;
  const pending = [];
  const store = {
    pending: Promise.resolve(),
    applyProgress: (id, changes) => new Promise(resolve => pending.push(() => {
      total += changes.xp || 0;
      resolve({ xp: total, kills: 0, matches: 0, owned: [], equipped: {}, mastery: {} });
    })),
  };
  const service = new CareerService({ directory: path.join(root, '.conquest-work', 'wip', 'ribbons', 'unused'), store });
  const entity = { id: 'p1', bot: false, team: 'alpha', input: null };
  const progress = [];
  const engine = { entities: new Map([['p1', entity]]), mode: { policy: { setCareerLevel: () => {}, setCareerProgress: (e, p) => progress.push(p) } } };
  const client = { id: 'p1', profileId: 'account:async', room: { engine }, careerLevel: 1 };
  const tick = (now, phase, events) => service.observe(client, { t: 'tick', now, match: { mode: 'conquest', phase, winner: phase === 'post' ? 'bravo' : undefined },
    players: [{ id: 'p1', team: 'alpha', state: 'alive' }], events });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  tick(1000, 'live', []);
  tick(1100, 'live', [{ kind: 'score', id: 'p1', pts: 50, reason: 'ribbon' }]);
  tick(1200, 'live', [{ kind: 'score', id: 'p1', pts: 50, reason: 'ribbon' }]);
  pending[1](); await settle();
  pending[0](); await settle();
  eq(progress.map(p => p.gained), [2 * CAREER_REWARDS.conquestRibbon.xp, undefined], 'an older save resolving last keeps the newer match gain');
  tick(1300, 'post', [{ kind: 'medal', id: 'p1', medal: 'valor' }]);
  tick(1400, 'live', []);
  pending[2](); await settle();
  eq(progress.at(-1).gained, undefined, 'a post-match save resolving after the rematch leaves the new match gain alone');
  eq(progress.at(-1).xp, 2 * CAREER_REWARDS.conquestRibbon.xp + CAREER_REWARDS.conquestMedal.xp, 'but still updates the career total');
  tick(1500, 'live', [{ kind: 'score', id: 'p1', pts: 50, reason: 'ribbon' }]);
  pending[3](); await settle();
  eq(progress.at(-1).gained, CAREER_REWARDS.conquestRibbon.xp, 'the new match tally pushes again');
  service.dispose();
}

// ------------------------------------------- toast and debrief (fake DOM) --
{
  const { document } = installFakeDom({ width: 1440, height: 900 });
  const { ribbonToastEntry, scheduleRibbonToast, RibbonToast, RIBBON_TOAST_MS, RIBBON_ART, MEDAL_ART, ribbonGradient } = await import('../public/js/ui/conquest/ribbons.js');
  const { conquestTeamMvps, conquestTopSquad, conquestPersonalSummary, careerProgressModel, ConquestDebrief } = await import('../public/js/ui/conquest/debrief.js');
  const { stingerForEvent, OBJECTIVE_SAMPLE_CUES } = await import('../public/js/audio/objective-cues.js');
  eq(Object.keys(RIBBON_ART).sort(), [...RIBBON_IDS].sort(), 'art for every ribbon');
  eq(Object.keys(MEDAL_ART).sort(), [...MEDAL_IDS].sort(), 'art for every medal');
  ok(ribbonGradient('medic').startsWith('linear-gradient(90deg'), 'striped gradient');
  const ev = { kind: 'ribbon', id: 'me', ribbon: 'medic', count: 2, pts: 50 };
  eq(ribbonToastEntry(ev, 'me'), { key: 'medic:2', ribbon: 'medic', eyebrow: 'RIBBON EARNED', label: 'MEDIC RIBBON', detail: '5 REVIVES', count: 2, pts: 50 });
  eq(ribbonToastEntry({ kind: 'medal', id: 'me', medal: 'lifesaver' }, 'me'), { key: 'medal:lifesaver', ribbon: 'medic', medal: 'lifesaver', eyebrow: 'MEDAL AWARDED',
    label: 'LIFESAVER MEDAL', detail: '2× MEDIC RIBBON', count: 1, pts: 0 }, 'a medal queues a MEDAL AWARDED toast');
  eq(ribbonToastEntry({ kind: 'medal', id: 'me', medal: 'service' }, 'me').detail, '5 RIBBONS');
  eq([ribbonToastEntry(ev, 'other'), ribbonToastEntry({ ...ev, ribbon: 'nope' }, 'me'), ribbonToastEntry({ kind: 'score' }, 'me')], [null, null, null]);
  let q = scheduleRibbonToast({ current: null, queue: [] }, ribbonToastEntry(ev, 'me'), 0);
  q = scheduleRibbonToast(q, ribbonToastEntry(ev, 'me'), 10);
  q = scheduleRibbonToast(q, ribbonToastEntry({ ...ev, ribbon: 'spree', count: 1 }, 'me'), 20);
  eq([q.current.key, q.queue.map(e => e.key)], ['medic:2', ['spree:1']], 'a repeat is dropped, others queue');
  q = scheduleRibbonToast(q, null, RIBBON_TOAST_MS + 1);
  eq([q.current.key, q.queue.length], ['spree:1', 0], 'the queue advances after the hold');
  eq(scheduleRibbonToast(q, null, 3 * RIBBON_TOAST_MS).current, null, 'and empties');
  eq([stingerForEvent(ev, 'alpha', 'me'), stingerForEvent(ev, 'alpha', 'other')], ['ribbon', null], 'own ribbons play the ribbon stinger');
  eq(OBJECTIVE_SAMPLE_CUES.ribbon, 'cq.flag.start', 'reusing the capture-start take');

  const parent = document.createElement('div');
  const toast = new RibbonToast(parent);
  toast.push(ribbonToastEntry(ev, 'me'), 0);
  eq([toast.root.hidden, toast.title.textContent, toast.detail.textContent, toast.pts.textContent, toast.count.textContent], [false, 'MEDIC RIBBON', '5 REVIVES', '+50', '×2']);
  ok(toast.slot.querySelector('.cq-ribbon-bar')?.style.getPropertyValue('--ribbon').includes('gradient'), 'the toast shows the striped bar');
  toast.update(RIBBON_TOAST_MS + 1);
  ok(toast.root.hidden, 'the toast hides after its hold');

  const rows = [
    { id: 'me', name: 'You', team: 'alpha', squad: 1, score: 940, cqr: [1, 0, 0, 1, 0, 0, 0, 0], cqm: [], cqp: [390, 400, 0, 50, 100], cxp: [3240, 640] },
    { id: 'k', name: 'Kestrel', team: 'alpha', squad: 1, score: 860 },
    { id: 'v', name: 'Vale', team: 'alpha', squad: 2, score: 1120 },
    { id: 'r', name: 'Rourke', team: 'bravo', squad: 1, score: 1290 },
    { id: 's', name: 'Sato', team: 'bravo', squad: 1, score: 610 },
    { id: 'n', name: 'Npc', team: 'bravo', squad: 1, score: 5000, npcRole: 'grunt' },
  ];
  eq(conquestTeamMvps(rows).map(m => [m.team, m.name, m.score]), [['alpha', 'Vale', 1120], ['bravo', 'Rourke', 1290]], 'top score per team, NPCs ignored');
  const top = conquestTopSquad(rows);
  eq([top.team, top.name, top.score, top.members.map(m => m.name)], ['bravo', 'ALPHA SQUAD', 1900, ['Rourke', 'Sato']], 'the best squad over both teams (squad ids are per team)');
  eq(conquestTopSquad([]), null);
  const summary = conquestPersonalSummary(rows[0]);
  eq(summary.categories.map(c => [c.id, c.pts]), [['combat', 390], ['objective', 400], ['vehicles', 0], ['support', 50], ['ribbons', 100]]);
  eq(summary.categories[1].share, 1, 'bars scale to the largest category');
  eq(summary.ribbons.filter(r => r.count).map(r => r.id), ['spree', 'conquest']);
  eq(summary.career.level, 6); eq([summary.career.levelUp, summary.career.levelStart, summary.career.nextLevel], [false, 2500, 3600]);
  ok(Math.abs(summary.career.from - 100 / 1100) < 1e-9 && Math.abs(summary.career.to - 740 / 1100) < 1e-9, 'bar from the XP before to the XP after');
  const up = careerProgressModel({ xp: 2620, gained: 760 });
  eq([up.startLevel, up.level, up.levelUp, up.from], [5, 6, true, 0], 'a level-up fills from the new floor');
  eq(careerProgressModel(null), null);
  eq(careerProgressModel({ xp: 100, gained: 900 }).before, 0, 'the gain never exceeds the total');

  const debrief = new ConquestDebrief(document.createElement('div'));
  debrief.update(rows, 'me', 'alpha');
  eq(debrief.root.hidden, false);
  eq(debrief.mvpCards.querySelectorAll('.vb-debrief-mvp-card').map(c => c.dataset.rel), ['own', 'enemy']);
  eq(debrief.bars.querySelectorAll('.vb-debrief-bar').length, SCORE_CATEGORY_IDS.length);
  eq(debrief.ribbons.querySelectorAll('.vb-debrief-ribbon').map(c => c.dataset.earned), ['true', 'false', 'false', 'true', 'false', 'false', 'false', 'false']);
  ok(debrief.medals.textContent.includes('NO MEDALS'), 'the empty medal line');
  ok(debrief.career.textContent.includes('+640 XP · 3,240 / 3,600 XP'), `career line (${debrief.career.textContent})`);
  debrief.update([{ ...rows[0], cqm: [0, 8], cxp: undefined }, ...rows.slice(1)], 'me', 'alpha');
  eq(debrief.medals.querySelectorAll('.cq-medal').map(m => m.dataset.medal), ['valor', 'service']);
  eq(debrief.career.dataset.state, 'guest', 'no career row: a guest');
  debrief.update(rows, 'spectator', 'alpha');
  eq([debrief.you.hidden, debrief.awards.hidden, debrief.mvp.hidden], [true, true, false], 'without an own row only the MVP panel shows');
  debrief.update([], 'me', 'alpha');
  ok(debrief.root.hidden, 'no rows, no debrief');
}

console.log(`Conquest ribbons: ${checks} checks passed (contract v6 tables, every ribbon at its threshold through the ledger, once-per-life spree, ribbon points and score categories, medals at match end, results cqr/cqm/cqp/cxp, rematch and takeover, career XP for ribbons and medals, toast and debrief read models).`);
