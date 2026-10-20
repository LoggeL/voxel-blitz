// Supply airdrop (docs/conquest.md "Map events" > "Supply airdrop") on the real battlefields:
//  - registered on both maps and in Breakthrough; the KR-50 KRABER is a real weapon no kit carries;
//  - the seeded schedule (first drop 165-195 s, then 240-360 s apart) and a seeded landing cell on open
//    ground between fronting flags (dry, open sky, outside HQs and flag zones, a bot surface walk node);
//  - warning -> active -> claimed: the crate point on `evp`, the `ev` row with anchor height and heading
//    for joiners, the byte budget, a hold an enemy hit breaks, the claim score, the KRABER with 4 + 1 mags
//    and a kit refill, Support resupply leaves it alone, a spent one leaves the owned list;
//  - an unclaimed crate expires after 90 s; a rematch resets everything;
//  - bots of both teams go for it and one claims it (and raises the weapon); HUD banner, map paint, pose.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { KITS } from '../shared/conquest-contract.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { applyResupply } from '../shared/conquest-kits.js';
import { MAP_EVENT_DEFS, MAP_EVENT_RULES, decodeMapEvents, mapEventsFor } from '../shared/conquest-map-events.js';
import { AIRDROP_EVENT, AIRDROP_TUNING as T, airdropClock, airdropPose, airdropSpot } from '../shared/map-events/airdrop.js';
import { AirdropController } from '../server/modes/conquest/map-events/airdrop.js';
import { MapEventSystem } from '../server/modes/conquest/map-events/system.js';
import { surfaceNavigation } from '../server/bot-surface-nav.js';
import { attachBots } from '../server/bots.js';
import { mapEventBanner } from '../public/js/ui/conquest/map-events.js';
import { AIRDROP_PRESENTER, airdropRounds } from '../public/js/ui/conquest/map-events/airdrop.js';
import { TICK_MS, conquestBaseBytes, eventFixture, mapEventWireBytes } from './lib/map-event-fixtures.mjs';
import { CONQUEST_MATCH_BUDGET_BYTES } from './lib/protocol-contract.mjs';

const defs = [AIRDROP_EVENT], controllers = { airdrop: AirdropController };
const KRABER = WEAPON_IDS.indexOf('kraber');

// ---------------------------------------------------------------- definition
assert(MAP_EVENT_DEFS.includes(AIRDROP_EVENT), 'registered');
for (const map of ['frontier', 'redrock']) assert(mapEventsFor(map).some(d => d.id === 'airdrop'), `on ${map}`);
assert(KRABER >= 0 && WEAPONS.kraber.damage[0] >= 100, 'the reward is a real one-shot weapon');
assert(!Object.values(KITS).some(k => k.primaries.includes('kraber') || k.gadgets.includes('kraber')), 'no kit carries it');
assert.equal(airdropRounds(), 8, '4 in the magazine + 1 spare magazine');
const bt = new MapEventSystem({ mapMeta: { id: 'frontier' }, variant: 'breakthrough', now: 0 }, { defs, controllers });
bt.reset();
assert(bt.instance('airdrop'), 'runs in Breakthrough');

/** Every rule of `openCell` checked again from the world: the spot is valid open ground. */
function checkSpot(F, spot, label) {
  const meta = F.meta.conquest, nav = surfaceNavigation(F.world);
  assert(spot && Number.isFinite(spot.y), `${label}: a spot`);
  for (const base of Object.values(meta.bases)) assert(Math.hypot(spot.x - base.x, spot.z - base.z) > base.radius, `${label}: outside the HQ`);
  for (const f of meta.flags) assert(Math.hypot(spot.x - f.x, spot.z - f.z) > f.radius, `${label}: outside flag ${f.id}`);
  const fx = Math.floor(spot.x), fz = Math.floor(spot.z), gy = Math.round(spot.y - 0.02);
  for (let y = gy; y < 80; y++) assert.equal(F.world.getBlock(fx, y, fz), 0, `${label}: open sky above (${y})`);
  const node = nav.nodeAt(spot, 1);
  assert(node >= 0 && (nav.flags[node] & 1) && !(nav.flags[node] & 2), `${label}: a dry walk node of the surface graph`);
  const A = nav.nodeAt(meta.flags.find(f => f.id === spot.flags[0]));
  assert.equal(nav.component[node], nav.component[A], `${label}: reachable from flag ${spot.flags[0]}`);
}

// ---------------------------------------------------------------- schedule and spot (both maps, seeded)
for (const map of ['frontier', 'redrock']) {
  const F = eventFixture({ map, defs, controllers });
  F.player('x', 'alpha'); F.run(TICK_MS);
  const c = F.system.instance('airdrop').controller;
  const first = c.nextAt - F.game.now;
  assert(first >= T.firstMs[0] - 100 && first <= T.firstMs[1], `${map}: first drop ${(first / 1000).toFixed(0)} s in`);
  c.reseed(77); const s1 = c.pickSpot(); c.reseed(77); const s2 = c.pickSpot();
  assert.deepEqual(s1, s2, `${map}: the same seed picks the same cell`);
  for (let seed = 1; seed <= 6; seed++) { c.reseed(seed); checkSpot(F, c.pickSpot(), `${map} seed ${seed}`); }
}

// ---------------------------------------------------------------- one drop, end to end (Frontier)
const F = eventFixture({ defs, controllers });
const { game, policy, system } = F;
const a = F.player('a', 'alpha'), b = F.player('b', 'bravo');
F.run(TICK_MS * 2);
const ev = system.instance('airdrop'), c = ev.controller;
c.reseed(3);
assert(!F.snap.match.conquest.ev, 'nothing rides before the first drop');
c.nextAt = game.now;
let t0 = performance.now(); game.step(TICK_MS); const dropTickMs = performance.now() - t0;
assert.equal(ev.phase, 'warning', 'the transport runs in');
const spot = c.spot;
checkSpot(F, spot, 'drop');
const warnEv = F.kinds().find(e => e.event === 'airdrop' && e.phase === 'warning');
assert.deepEqual(warnEv.pos, [Math.round(spot.x), Math.round(spot.y), Math.round(spot.z)], 'the announcement carries the landing cell');
const next = c.nextAt - game.now;
assert(next >= T.intervalMs[0] - 100 && next <= T.intervalMs[1], `next drop in ${(next / 1000).toFixed(0)} s`);
F.run(TICK_MS);
// Joiner view: the row alone gives the landing cell (with its height), the heading and the clock.
const row = F.snap.match.conquest.ev[0];
const joined = decodeMapEvents(F.snap.match.conquest.ev, F.snap.match.conquest.evp, 'frontier', defs).events[0];
assert.deepEqual([joined.anchor.x, joined.anchor.y, joined.anchor.z], [Math.round(spot.x), Math.round(spot.y), Math.round(spot.z)], 'anchor x, y, z on `ev`');
{ const back = airdropSpot(joined.anchor); assert.ok(Math.abs(back.x - spot.x) < 1e-6 && Math.abs(back.z - spot.z) < 1e-6 && Math.abs(back.y - spot.y) <= 0.5, `client spot from the wire ${JSON.stringify(back)} vs ${JSON.stringify(spot)}`); }
assert(Array.isArray(row[5]) && row[5][0] === c.heading, 'heading extra');
const clock = airdropClock(joined);
assert(clock >= 0 && clock < 300, `phase clock ${clock} ms`);
assert(!F.snap.match.conquest.evp, 'no claim point while it sinks');
// Bots of both teams are sent to the landing cell while it sinks.
for (const team of ['alpha', 'bravo']) assert.equal(c.botTasks(team)[0]?.id, 'landing', `${team} gets the landing task`);
F.runUntil(() => ev.phase === 'active', T.approachMs + T.descentMs + 200);
assert.equal(ev.phase, 'active', 'the crate is down');
const decoded = F.decoded();
const pt = decoded.points.find(p => p.event === 'airdrop');
assert(pt && pt.teams.length === 2 && Math.abs(pt.x - spot.x) < 0.11, 'the crate point on `evp` for both teams');
const wireBytes = mapEventWireBytes(F.snap.match.conquest);
assert(wireBytes <= MAP_EVENT_RULES.wire.budgetBytes, `ev + evp ${wireBytes} B within ${MAP_EVENT_RULES.wire.budgetBytes} B`);
assert(conquestBaseBytes(F.snap.match.conquest) <= CONQUEST_MATCH_BUDGET_BYTES, 'the base match.conquest keeps its budget');
const tasks = c.botTasks('alpha').map(t => t.id);
assert(tasks.includes('use:crate') && tasks.includes('escort'), `claim and escort tasks (${tasks})`);
// The claim: an enemy hit breaks the hold, a full 3 s wins it.
const use = p => game.mode.conquestIntent(p, { type: 'support', support: 'use', targetId: `airdrop:${pt.index}` });
const hold = (p, ms) => { for (let t = 0; t < ms; t += 200) { use(p); F.run(200); } };
F.place(a, spot.x + 0.6, spot.z, spot.y); F.place(b, spot.x + 30, spot.z);
const mag0 = a.mag.slice(), grenades0 = a.grenades.slice();
a.mag[mag0.findIndex(n => n > 0)] = 0; a.grenades.fill(0);
hold(a, 1400);
assert(system.points.get(ev, 'crate').progress > 0.3, 'the hold runs');
a.takeDamage(5, false, b, 'rifle'); F.run(TICK_MS);
assert.equal(system.points.get(ev, 'crate').progress, 0, 'an enemy hit breaks it');
F.events.length = 0;
hold(a, T.claimMs + 400);
assert.equal(ev.phase, 'cooldown', 'claimed');
const claimed = F.kinds().find(e => e.reason === 'claimed');
assert.deepEqual([claimed.team, claimed.by], ['alpha', 'a'], 'the claim names team and player');
assert(F.events.some(e => e.kind === 'score' && e.id === 'a' && e.reason === 'map_event' && e.pts === 100), 'the `use` award (100)');
assert.equal(a.owned[0], 'kraber', 'the power weapon heads the owned list (key 3)');
assert.deepEqual([a.mag[KRABER], a.reserve[KRABER]], [T.weapon.mag, T.weapon.reserve]);
assert(policy.canUseWeapon(a, KRABER) && !policy.canUseWeapon(b, KRABER), 'only the claimer may raise it');
assert(a.mag.every((n, i) => n >= mag0[i]) && a.grenades.every((n, i) => n >= grenades0[i]), 'and a full kit refill');
assert(!system.points.get(ev, 'crate') && !ev.anchor, 'the crate is gone');
applyResupply(a, policy.roles.kitOf(a), 0, 0, { gadgetRound: true });
assert.deepEqual([a.mag[KRABER], a.reserve[KRABER]], [T.weapon.mag, T.weapon.reserve], 'Support resupply never refills it');
const banner = mapEventBanner({ kind: 'map_event', ...claimed }, { selfTeam: 'alpha', selfId: 'a', defs });
assert.equal(banner.title, 'SUPPLY DROP · KR-50 KRABER ARMED', 'the claimer\'s banner');
assert.equal(mapEventBanner({ kind: 'map_event', ...claimed }, { selfTeam: 'bravo', selfId: 'b', defs }).detail, 'THE ENEMY HAS THE KRABER');
F.run(1200);
assert.equal(ev.phase, 'idle', 'idle again after the cooldown');
assert(!F.snap.match.conquest.ev && !F.snap.match.conquest.evp, 'nothing rides between drops');
a.mag[KRABER] = 0; a.reserve[KRABER] = 0; F.run(TICK_MS);
assert(!a.owned.includes('kraber'), 'a spent KRABER leaves the owned list');

// ---------------------------------------------------------------- expiry, then rematch
c.nextAt = game.now; F.run(TICK_MS);
assert.equal(ev.phase, 'warning', 'the second drop');
F.runUntil(() => ev.phase === 'cooldown', T.approachMs + T.descentMs + T.activeMs + 500);
assert.equal(F.kinds().filter(e => e.event === 'airdrop').at(-1).reason, 'expired', 'an unclaimed crate expires after 90 s');
F.run(1200); c.nextAt = game.now; F.run(TICK_MS * 2);
assert.equal(ev.phase, 'warning');
policy.reset(); F.run(TICK_MS * 2);
const ev2 = system.instance('airdrop');
assert(ev2.phase === 'idle' && !ev2.anchor && ev2.controller.holders.size === 0 && !F.snap.match.conquest.evp, 'a rematch resets the drop');

// ---------------------------------------------------------------- client: pose and map paint
{
  const s = { x: 100, y: 20, z: 100 };
  const p0 = airdropPose(s, 0, 0), p1 = airdropPose(s, 0, T.approachMs + T.descentMs / 2), p2 = airdropPose(s, 0, T.approachMs + T.descentMs);
  assert(p0.crate.state === 'carried' && Math.hypot(p0.plane.x - s.x, p0.plane.z - s.z) > 350, 'the transport starts 400 m out');
  assert(p1.crate.state === 'falling' && p1.crate.y > s.y && p1.crate.y < s.y + T.releaseM, 'the crate sinks under its canopy');
  assert.deepEqual([p2.crate.state, p2.crate.y], ['landed', s.y], 'and lands on the cell');
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (typeof k === 'string' && !['globalAlpha', 'strokeStyle', 'fillStyle', 'lineWidth'].includes(k) ? (...args) => calls.push(k) : undefined), set: () => true });
  AIRDROP_PRESENTER.paintMap(ctx, joined, { nowMs: 0, px: 1 });
  assert(calls.includes('lineTo') && calls.includes('arc'), 'the flight line and the landing ring');
}

// ---------------------------------------------------------------- bots go for it (Frontier, 8 bots)
{
  const B = eventFixture({ defs, controllers });
  const bots = attachBots(B.game, 8);
  B.run(TICK_MS * 4);
  const be = B.system.instance('airdrop'), bc = be.controller;
  bc.reseed(5); bc.nextAt = B.game.now; B.run(TICK_MS);
  const s = bc.spot;
  const team = id => B.policy.teamFor(B.game.entities.get(id));
  // Two bots of each team 30-45 m out, the rest where the commander has them.
  const near = { alpha: 0, bravo: 0 };
  for (const br of bots.brains) {
    const p = B.game.entities.get(br.id), t = team(br.id);
    if (!p || p.state !== 'alive' || near[t] >= 2) continue;
    const ang = (near[t] + (t === 'alpha' ? 0 : 2)) * Math.PI / 2;
    B.place(p, s.x + Math.cos(ang) * (30 + 8 * near[t]), s.z + Math.sin(ang) * (30 + 8 * near[t]));
    near[t]++;
  }
  const sent = { alpha: false, bravo: false };
  let peakMs = 0;
  const t1 = performance.now();
  let ran = 0;
  while (ran < T.approachMs + T.descentMs + 45000 && (be.phase === 'warning' || be.phase === 'active')) {
    const t0 = performance.now(); B.game.step(TICK_MS); peakMs = Math.max(peakMs, performance.now() - t0);
    ran += TICK_MS;
    for (const [t, ts] of bots.commander.teams) if ([...(ts.eventAssign?.values?.() ?? [])].some(id => id.startsWith('airdrop:'))) sent[t] = true;
  }
  const wall = performance.now() - t1;
  assert(sent.alpha && sent.bravo, 'the commander books bots of both teams');
  const claim = B.kinds().find(e => e.event === 'airdrop' && e.reason === 'claimed');
  assert(claim, `a bot claims the crate (${be.phase} after ${(ran / 1000).toFixed(0)} s)`);
  const holder = B.game.entities.get(claim.by);
  assert(holder.bot && holder.owned[0] === 'kraber' && (holder.weapon === KRABER || holder.state !== 'alive'), 'and raises the KRABER');
  console.log(`airdrop bots: ${claim.team} bot ${claim.by} claimed ${((ran - T.approachMs - T.descentMs) / 1000).toFixed(1)} s after landing; `
    + `drop tick ${dropTickMs.toFixed(2)} ms (spot pick ${c.stats.pickMs.toFixed(2)} ms), peak 8-bot tick ${peakMs.toFixed(2)} ms, wire ${wireBytes} B, bot run ${(wall / 1000).toFixed(1)} s wall`);
  bots.dispose();
}

console.log('conquest map event airdrop: definition, schedule, open-ground spot on both maps, warning/active/claim, KRABER grant and refill, expiry, rematch, bots, HUD passed');
process.exit(0);
