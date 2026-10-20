// Comeback call-in (docs/conquest.md "Comeback call-in"): earning on a
// sustained deficit, the squad-leader designation and its refusals, the
// telegraph -> strike -> cooldown cycle with real projectiles and the kill
// key, the `ev` wire row, the bots' own call, the Breakthrough rule and the
// rematch reset. One live Frontier engine with only this event registered.
import assert from 'node:assert/strict';
import { MAP_EVENT_RULES, mapEventWireBytes } from '../shared/conquest-map-events.js';
import {
  COMEBACK_EVENT, COMEBACK_TUNING, comebackBreakthroughTeams, comebackCallKey, comebackStrikePlan, comebackTrailingTeam, parseComebackCall,
} from '../shared/map-events/comeback.js';
import { ComebackController } from '../server/modes/conquest/map-events/comeback.js';
import { eventFixture } from './lib/map-event-fixtures.mjs';

const T = COMEBACK_TUNING;

// Pure rules.
assert.equal(comebackTrailingTeam({ alpha: 200, bravo: 300 }, 300), 'alpha', '100 behind of 300 earns');
assert.equal(comebackTrailingTeam({ alpha: 260, bravo: 300 }, 300), null, '40 behind does not');
assert.deepEqual(comebackBreakthroughTeams({ attackers: 'alpha', defenders: 'bravo', tickets: 50, max: 200, sector: 0, sectors: 3 }), ['alpha']);
assert.deepEqual(comebackBreakthroughTeams({ attackers: 'alpha', defenders: 'bravo', tickets: 50, max: 200, sector: 0, sectors: 3, overtime: true }), []);
assert.deepEqual(comebackBreakthroughTeams({ attackers: 'alpha', defenders: 'bravo', tickets: 150, max: 200, sector: 2, sectors: 3 }), ['bravo'],
  'defenders earn once the attackers reach the last sector');
assert.deepEqual(parseComebackCall(comebackCallKey('bomber', 300.4, 410).slice('comeback:'.length)), { kind: 'bomber', x: 300, z: 410 });
const line = comebackStrikePlan({ kind: 'bomber', target: { x: 400, z: 400 }, headingDeg: 90 });
assert.equal(line.drops.length, T.bomber.bombs);
assert.ok(Math.abs(line.drops.at(-1).x - line.drops[0].x - (T.bomber.bombs - 1) * T.bomber.spacing) < 1e-6, 'bombs walk east along the heading');
const barrage = comebackStrikePlan({ kind: 'artillery', target: { x: 400, z: 400 }, seed: 7 });
assert.deepEqual(barrage, comebackStrikePlan({ kind: 'artillery', target: { x: 400, z: 400 }, seed: 7 }), 'the barrage is seeded');
assert.ok(barrage.drops.every(d => Math.hypot(d.x - 400, d.z - 400) <= T.artillery.radius + 1e-6));

// A live engine.
const F = eventFixture({ defs: [COMEBACK_EVENT], controllers: { comeback: ComebackController } });
const { game, policy, system } = F;
const a = F.player('a', 'alpha'), a2 = F.player('a2', 'alpha'), b = F.player('b', 'bravo');
F.run(100);
const C = F.meta.conquest.flags.find(f => f.id === 'C');
const D = F.meta.conquest.flags.find(f => f.id === 'D');
const hqA = F.meta.conquest.bases.alpha;
const ev = system.instance('comeback');
const use = (who, kind, x, z) => game.mode.conquestIntent(who, { type: 'support', support: 'use', targetId: comebackCallKey(kind, x, z) });
const row = () => F.snap.match.conquest.ev?.[0] ?? null;
assert.equal(policy.squads.map().get('a')?.leaderId, 'a', 'the first joiner leads the squad');
assert.notEqual(policy.squads.map().get('a2')?.leaderId, 'a2');

// Earning: 20 s at 100 tickets behind arms it for the trailing side.
F.place(a, D.x - 150, D.z); F.place(a2, D.x - 152, D.z + 4); F.place(b, D.x + 2, D.z + 1);
policy.ledger.tickets.alpha = 200;
F.run(T.earn.sustainMs - 1000);
assert.equal(ev.phase, 'idle', 'not before the sustain window');
F.run(1500);
assert.equal(ev.phase, 'armed'); assert.equal(ev.team, 'alpha');
assert.deepEqual(row(), [0, 1, 0, 0], 'READY rides as a bare armed row');

// Refusals: the other side, a non-leader, the own HQ, outside the combat area.
assert.equal(use(b, 'bomber', D.x, D.z), false, 'wrong side');
assert.equal(use(a2, 'bomber', D.x, D.z), false, 'not a squad leader');
assert.equal(use(a, 'bomber', hqA.x, hqA.z), false, 'the HQ is off limits');
assert.equal(use(a, 'bomber', 2, 2), false, 'outside the combat area');
assert.equal(ev.phase, 'armed');

// Designation: the telegraph with the target anchor and [kind, heading].
assert.equal(use(a, 'bomber', D.x, D.z), true);
assert.equal(ev.phase, 'warning');
F.run(100);
const r = row();
assert.equal(r[1], 2); assert.equal(r[3], 0, 'team alpha');
assert.equal(r[5][0], 1, 'kind bomber'); assert.ok(r[5][1] >= 0 && r[5][1] < 360);
assert.deepEqual(r.slice(6), [Math.round(D.x), Math.round(D.z)], 'runtime anchor = target');
assert.ok(mapEventWireBytes(F.snap.match.conquest) <= MAP_EVENT_RULES.wire.budgetBytes);
assert.ok(F.decoded().events[0].anchor, 'the HUD decodes the target');
assert.equal(use(a, 'artillery', D.x, D.z), false, 'one designation');

// Strike: real bombs, the kill under callinBomb credited to the designator, then cooldown.
let peak = 0;
const t0 = performance.now();
for (let t = 100; t < COMEBACK_EVENT.durations.warningMs + line.activeMs + 500; t += 50) {
  const s = performance.now(); game.step(50); peak = Math.max(peak, performance.now() - s);
}
const kill = F.kinds('kill').find(k => k.victim === 'b');
assert.ok(kill, 'the bomber run kills the enemy on the target');
assert.equal(kill.killer, 'a'); assert.equal(kill.weapon ?? kill.w ?? kill.weaponKey, 'callinBomb');
assert.equal(ev.phase, 'cooldown');
assert.ok(!row() || row()[1] === 5, 'cooldown row');
assert.equal(row()?.[5], undefined, 'no anchor after the strike');
console.log(`  strike peak tick ${peak.toFixed(2)} ms (${(performance.now() - t0).toFixed(0)} ms wall)`);
F.run(COMEBACK_EVENT.repeat.cooldownMs + 200);
assert.equal(ev.phase, 'idle');

// Each side once: alpha does not earn it again; a trailing bravo does, and its bot leader calls it.
policy.ledger.tickets.alpha = 200; policy.ledger.tickets.bravo = 300;
F.run(T.earn.sustainMs + 1000);
assert.equal(ev.phase, 'idle', 'alpha used its call-in');
b.bot = true;
F.place(b, C.x + 120, C.z); F.place(a, C.x, C.z); F.place(a2, C.x + 3, C.z - 2);
const flagC = policy.flags.find(f => f.id === 'C');
Object.assign(flagC, { owner: 'alpha', control: 1, state: 'idle' });
policy.ledger.tickets.alpha = 300; policy.ledger.tickets.bravo = 200;
F.runUntil(() => ev.phase === 'armed', T.earn.sustainMs + 1500);
assert.equal(ev.phase, 'armed'); assert.equal(ev.team, 'bravo');
F.runUntil(() => ev.phase === 'warning', T.designate.botDelayMs + 2500);
assert.equal(ev.phase, 'warning', 'the bot leader designates after its delay');
const call = F.kinds('map_event').at(-1);
assert.equal(call.by, 'b'); assert.equal(call.data.kind, 'artillery', 'infantry on the flag: the barrage');
assert.ok(Math.hypot(ev.anchor.x - C.x, ev.anchor.z - C.z) < 6, 'aimed at the crowd on C');
assert.ok(system.hazards.of(ev).some(h => h.avoid && h.dps === 0), 'avoid-only hazard over the strike');

// Rematch: the event, its per-side memory and the strike start over.
policy.reset();
F.run(100);
const fresh = system.instance('comeback');
assert.equal(fresh.phase, 'idle');
assert.equal(fresh.controller.used.size, 0); assert.equal(fresh.controller.strike, null);
assert.equal(system.hazards.zones.length, 0);
assert.ok(F.kinds('projectileLaunch').length > 0);
assert.ok(!F.snap.match.conquest.ev, 'no `ev` after the rematch');
console.log('conquest-map-event-comeback-test: ok');
