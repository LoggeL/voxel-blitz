// Conquest Breakthrough (docs/conquest.md, Breakthrough): sector progression,
// locked flags, ticket pool and refills, overtime, the front and its fall-back
// grace, deploy options (the moved HQs, forward flags, no tickets), the hull
// list per side, rematch, the lobby variant and the snapshot contract.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { makeLobbyState } from '../server/protocol/welcome.js';
import {
  BREAKTHROUGH_RULES, CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS, CONQUEST_RULES, CONQUEST_VARIANTS, decodeConquestPlayer,
  normalizeConquestVariant,
} from '../shared/conquest-contract.js';
import { decodeConquestMatch, deployOptions, deployViewFromSnapshot } from '../shared/conquest.js';
import {
  breakthroughFront, breakthroughHqFlags, breakthroughSpawnFlag, breakthroughVehicleSpawns, decodeBreakthrough, encodeBreakthrough,
  outsideFront, sectorRole,
} from '../shared/breakthrough.js';
import { BreakthroughPolicy } from '../server/modes/conquest/breakthrough.js';
import { getMapMeta } from '../shared/worlddata.js';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

const SX = 200, SY = 32, SZ = 160;
const spot = (x, z) => ({ x: x + 0.5, y: 2, z: z + 0.5 });
const ring = (x, z) => Array.from({ length: 12 }, (_, i) => spot(x + Math.round(Math.cos(i * Math.PI / 6) * 6), z + Math.round(Math.sin(i * Math.PI / 6) * 6)));
const flagRow = (id, x, z, home) => ({ id, name: `Flag ${id}`, ...spot(x, z), radius: 10, home, spawns: ring(x, z) });

function fixture({ variant = 'breakthrough', vehicles = [] } = {}) {
  const hq = (team, x) => ({ id: team, name: `${team} HQ`, ...spot(x, 80), radius: 12,
    spawns: [spot(x, 74), spot(x, 77), spot(x, 80), spot(x, 83), spot(x, 86)] });
  const bases = { alpha: hq('alpha', 8), bravo: hq('bravo', SX - 9) };
  const mapMeta = { id: 'frontier', dimensions: { sx: SX, sy: SY, sz: SZ },
    spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
    conquest: { version: 2, bases, combatArea: { minX: 2, maxX: SX - 2, minZ: 2, maxZ: SZ - 2 }, vehicleSpawns: vehicles,
      flags: [flagRow('A', 50, 40, 'alpha'), flagRow('B', 50, 120, 'alpha'), flagRow('C', 100, 80, null),
        flagRow('D', 150, 40, 'bravo'), flagRow('E', 150, 120, 'bravo')] } };
  const solid = (x, y, z) => x < 0 || z < 0 || x >= SX || z >= SZ || y < 2;
  const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock: (x, y, z) => (solid(x, y, z) ? 1 : 0),
    findSpawns: () => [spot(20, 20)], setBlock: () => {} };
  const events = [];
  const game = new GameEngine({ mode: 'conquest', conquestVariant: variant, mapMeta, world,
    broadcast: snap => { events.push(...snap.events); game.lastSnapshot = snap; } });
  return { game, events, policy: game.mode.policy, mapMeta };
}
const run = (game, ms) => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
const place = (p, x, z) => Object.assign(p, { x: x + 0.5, y: 2, z: z + 0.5, vx: 0, vy: 0, vz: 0 });
const human = (game, id) => { game.addClient(id, id); return game.entities.get(id); };
const flagOf = (policy, id) => policy.flags.find(f => f.id === id);
const kinds = (events, kind) => events.filter(e => e.kind === kind);
const intent = (game, p, spawn, kit = 'assault') => game.mode.conquestIntent(p, { type: 'deploy', spawn, kit, variant: 0 });
const spawnsOf = options => options.filter(o => o.kind !== 'squad').map(o => `${o.spawn}${o.ok ? '' : `!${o.reason}`}${o.forward ? '*' : ''}`).sort();
/** Run until `test()` or `ms` elapsed; returns the elapsed ms. */
const runUntil = (game, test, ms) => { let t = 0; while (t < ms && !test()) { game.step(TICK_MS); t += TICK_MS; } return t; };
/** A team of `n` fixture humans, balanced: returns {alpha:[...], bravo:[...]}. */
function roster(game, n) {
  const teams = { alpha: [], bravo: [] };
  for (let i = 0; i < n; i++) { const p = human(game, `p${i + 1}`); teams[p.team].push(p); }
  return teams;
}
const park = (team, players) => players.forEach((p, i) => place(p, team === 'alpha' ? 6 : SX - 7, 74 + i * 2));

// --- contract, wire form and pure rules ----------------------------------------------
{
  eq(CONQUEST_CONTRACT_VERSION, 6, 'contract v6 adds the Breakthrough variant');
  eq(CONQUEST_VARIANTS, ['conquest', 'breakthrough']);
  eq([normalizeConquestVariant('breakthrough'), normalizeConquestVariant('rush'), normalizeConquestVariant(undefined)], ['breakthrough', 'conquest', 'conquest']);
  ok(CONQUEST_EVENT_KINDS.indexOf('sector_captured') === CONQUEST_EVENT_KINDS.indexOf('bridge') + 1
    && CONQUEST_EVENT_KINDS.indexOf('sector_overtime') === CONQUEST_EVENT_KINDS.indexOf('sector_captured') + 1, 'the sector events are appended after the bridge');
  const wire = encodeBreakthrough({ attackers: 'alpha', sector: 1, sectors: [['A', 'B'], ['C'], ['D', 'E']], graceEndsAt: 1234.6, overtime: false });
  eq(wire, ['alpha', 1, 'AB.C.DE', 1235, 0]);
  const bt = decodeBreakthrough(wire);
  eq([bt.attackers, bt.defenders, bt.sector, bt.sectors, bt.graceEndsAt, bt.overtime, bt.done], ['alpha', 'bravo', 1, [['A', 'B'], ['C'], ['D', 'E']], 1235, false, false]);
  eq(['A', 'B', 'C', 'D', 'E', 'Z'].map(id => sectorRole(bt, id)), ['captured', 'captured', 'active', 'locked', 'locked', null]);
  eq([decodeBreakthrough(null), decodeBreakthrough(['gamma', 0, 'A', 0, 0])], [null, null], 'no (valid) bt field: plain Conquest');
  eq([breakthroughSpawnFlag(bt, 'A', 'alpha'), breakthroughSpawnFlag(bt, 'C', 'alpha'), breakthroughSpawnFlag(bt, 'D', 'alpha')],
    [{ allowed: true, forward: true }, { allowed: true, forward: false }, { allowed: false, forward: false }], 'attackers: last taken sector (forward) and the active one');
  eq(['A', 'C', 'D'].map(id => breakthroughSpawnFlag(bt, id, 'bravo').allowed), [false, true, true], 'defenders: the active sector and every locked one');
  eq([breakthroughHqFlags(bt, 'alpha'), breakthroughHqFlags(bt, 'bravo'), breakthroughHqFlags({ ...bt, sector: 0 }, 'alpha'),
    breakthroughHqFlags({ ...bt, sector: 2 }, 'bravo')], [['A', 'B'], ['D', 'E'], null, null], 'the HQs move with the front');
}

// --- round start: defenders hold every flag, the HQs stand forward ------------------
{
  const { game, policy, mapMeta } = fixture();
  ok(policy instanceof BreakthroughPolicy, 'conquestVariant breakthrough builds the Breakthrough policy');
  eq([game.mode.mode, game.mode.variant], ['conquest', 'breakthrough'], 'the mode id stays conquest');
  eq(policy.sectors, [['A', 'B'], ['C'], ['D', 'E']], 'the Frontier sector table');
  eq(policy.flags.map(f => [f.id, f.owner, f.control]), [['A', 'bravo', -1], ['B', 'bravo', -1], ['C', 'bravo', -1], ['D', 'bravo', -1], ['E', 'bravo', -1]]);
  eq(policy.tickets, { alpha: BREAKTHROUGH_RULES.tickets, bravo: 0 }, 'only the attackers have tickets');
  const { alpha, bravo } = roster(game, 10);
  const on = (p, id) => flagOf(policy, id).spawns.some(c => Math.hypot(c.x - p.x, c.z - p.z) < 0.01);
  const startFlags = bravo.map(p => (on(p, 'A') ? 'A' : on(p, 'B') ? 'B' : '?'));
  ok(!startFlags.includes('?') && startFlags.includes('A') && startFlags.includes('B'),
    `defenders start dug in on the active sector, both flags manned (${startFlags.join('')})`);
  // Later deploys: the defenders' HQ is the sector behind the active one (C).
  game.killPlayer(bravo[0], alpha[0], 'rifle', false);
  ok(intent(game, bravo[0], 'hq'), 'defender HQ deploy');
  run(game, CONQUEST_RULES.respawnMs + 200);
  ok(on(bravo[0], 'C'), 'a defender HQ deploy lands at C');
  ok(alpha.every(p => mapMeta.conquest.bases.alpha.spawns.some(c => Math.hypot(c.x - p.x, c.z - p.z) < 0.01)), 'attackers start at their HQ');
  run(game, TICK_MS);
  const match = game.lastSnapshot.match;
  eq(match.conquest.bt, ['alpha', 0, 'AB.C.DE', 0, 0], 'match.conquest.bt');
  const bytes = JSON.stringify(match.conquest).length;
  ok(bytes <= 440, `match.conquest stays in the 440 B budget, wx included (${bytes} B)`);
  eq(match.conquest.bleed, undefined, "no bleed field on the Breakthrough wire");
  const decoded = decodeConquestMatch(match.conquest, mapMeta.conquest);
  eq([decoded.breakthrough.sector, decoded.tickets], [0, { alpha: BREAKTHROUGH_RULES.tickets, bravo: 0 }]);
  // A plain Conquest fixture publishes no bt field and keeps its own rules.
  const plain = fixture({ variant: 'conquest' });
  plain.game.step(TICK_MS);
  eq([plain.game.mode.variant, plain.game.lastSnapshot.match.conquest.bt, plain.policy.tickets.bravo], ['conquest', undefined, CONQUEST_RULES.tickets]);
}

// --- locked flags, sector capture, refill, fall-back grace and the front --------------
{
  const { game, events, policy } = fixture();
  const { alpha, bravo } = roster(game, 8);
  park('alpha', alpha); park('bravo', bravo);
  // Squad orders (contract v6) name active flags only; a standing order drops once its flag locks.
  const orderSquad = policy.squads.squadOf(alpha[0].id);
  const orderLeader = game.entities.get(policy.squads.leaderOf('alpha', orderSquad));
  ok(!policy.squadOrders.issue(orderLeader, 'C'), 'no squad order on a locked flag');
  ok(policy.squadOrders.issue(orderLeader, 'B'), 'a squad order on an active flag');
  eq(policy.squadOrders.flagFor('alpha', orderSquad), 'B');
  // Locked: four attackers on C (sector 2) move nothing.
  alpha.forEach((p, i) => place(p, 98 + i, 80));
  run(game, 3000);
  eq([flagOf(policy, 'C').owner, flagOf(policy, 'C').control, flagOf(policy, 'C').state], ['bravo', -1, 'idle'], 'a locked flag cannot change hands');
  eq(flagOf(policy, 'C').alpha, 4, 'its presence still publishes');
  eq(policy.restrictedMsFor(alpha[0]), 0, 'C lies short of the attackers\' lead line (x 115.5)');
  place(alpha[0], 120, 80);
  run(game, TICK_MS * 2);
  ok(policy.restrictedMsFor(alpha[0]) > 0, 'past the lead line an attacker runs the out-of-bounds timer');
  // Attacker deaths cost tickets, defender deaths cost nothing.
  park('alpha', alpha);
  run(game, TICK_MS);
  game.killPlayer(alpha[3], bravo[0], 'rifle', false);
  game.killPlayer(bravo[3], alpha[0], 'rifle', false);
  eq(policy.tickets, { alpha: BREAKTHROUGH_RULES.tickets - 1, bravo: 0 });
  eq(game.mode.phase, 'live', 'defenders at 0 tickets never lose');
  // Take A, then B.
  alpha.slice(0, 3).forEach((p, i) => place(p, 49 + i, 40));
  const tookA = runUntil(game, () => flagOf(policy, 'A').owner === 'alpha', 30000);
  ok(flagOf(policy, 'A').owner === 'alpha', `A captured (${tookA} ms)`);
  eq(policy.btView().sector, 0, 'one flag of two does not advance the sector');
  alpha.slice(0, 3).forEach((p, i) => place(p, 49 + i, 120));
  runUntil(game, () => policy.btView().sector === 1, 30000);
  const captured = kinds(events, 'sector_captured');
  eq(captured.length, 1, 'one sector_captured');
  eq([captured[0].sector, captured[0].next, captured[0].team, captured[0].flags], [0, 1, 'alpha', ['A', 'B']]);
  eq([captured[0].refill, captured[0].tickets], [1, BREAKTHROUGH_RULES.tickets], 'the refill tops the pool up, capped at its start');
  ok(captured[0].graceEndsAt - game.now > BREAKTHROUGH_RULES.fallbackGraceMs - 1000, 'the fall-back grace runs');
  eq(['A', 'B', 'C', 'D', 'E'].map(id => sectorRole(policy.btView(), id)), ['captured', 'captured', 'active', 'locked', 'locked']);
  run(game, TICK_MS);
  eq(policy.squadOrders.flagFor('alpha', orderSquad), null, 'the order on B drops when its sector locks');
  ok(kinds(events, 'squad_order').some(e => e.squad === orderSquad && e.flag === null), 'the drop is announced');
  eq(game.lastSnapshot.match.conquest.bt[1], 1);
  ok(game.lastSnapshot.match.conquest.bt[3] > game.now, 'bt[3] carries the grace end');
  // A lost sector cannot be retaken: four defenders on A.
  bravo.forEach((p, i) => place(p, 49 + i, 40));
  run(game, 4000);
  eq([flagOf(policy, 'A').owner, flagOf(policy, 'A').control], ['alpha', 1], 'captured flags lock for the attackers');
  // Grace: no timer yet; after it the out-of-bounds timer runs and kills.
  eq(policy.restrictedMsFor(bravo[0]), 0, 'no out-of-bounds timer during the fall-back grace');
  run(game, BREAKTHROUGH_RULES.fallbackGraceMs);
  ok(policy.restrictedMsFor(bravo[0]) > 0, 'after the grace a defender behind the line runs the timer');
  // One defender falls back past the line (x 75) in time.
  place(bravo[1], 80, 80);
  run(game, CONQUEST_RULES.outOfBoundsMs + 200);
  eq([bravo[0].state, bravo[1].state], ['dead', 'alive'], 'the defender who stayed dies, the one who fell back lives');
  ok(kinds(events, 'kill').some(e => e.victim === bravo[0].id && e.w === 'restricted'), 'killed by the restricted timer');
  // Ticket refill re-arms ticket_low; sector 2 (C) next.
  eq(policy.front.rear, 67, 'rear line halfway between B (42) and C (92) along the axis');
  eq(policy.front.lead, 117 + BREAKTHROUGH_RULES.attackerLeadM, 'lead line between C and D/E plus attackerLeadM');
}

// --- deploy options: moved HQs, forward flags, client parity ------------------------
{
  const { game, policy, mapMeta } = fixture();
  const { alpha, bravo } = roster(game, 4);
  park('alpha', alpha); park('bravo', bravo);
  run(game, TICK_MS);
  eq(spawnsOf(policy.deploy.options(alpha[0])), ['hq'], 'attackers at sector 1: HQ only');
  const defenderStart = policy.deploy.options(bravo[0]);
  eq(spawnsOf(defenderStart), ['flag:A', 'flag:B', 'flag:C', 'flag:D', 'flag:E', 'hq*'], 'defenders: every flag, HQ moved (*) to C');
  eq([defenderStart[0].x, defenderStart[0].z, defenderStart[0].flags], [100.5, 80.5, ['C']]);
  // Sector 1 taken: the attackers' HQ moves onto A/B and A/B are forward spawns.
  for (const id of ['A', 'B']) Object.assign(flagOf(policy, id), { owner: 'alpha', control: 1 });
  run(game, TICK_MS);
  eq(policy.btView().sector, 1);
  const attack = policy.deploy.options(alpha[0]);
  eq(spawnsOf(attack), ['flag:A*', 'flag:B*', 'hq*'], 'attackers: forward A/B and the HQ on them');
  eq([attack[0].x, attack[0].z], [50.5, 80.5], 'the moved HQ sits between A and B');
  eq(spawnsOf(policy.deploy.options(bravo[0])), ['flag:C', 'flag:D', 'flag:E', 'hq*'], 'defenders: C, D, E and the HQ on D/E');
  // The client lists exactly what the server offers.
  const decoded = decodeConquestMatch(game.lastSnapshot.match.conquest, mapMeta.conquest);
  const view = deployViewFromSnapshot(decoded, game.lastSnapshot.players, game.lastSnapshot.vehicles, decodeConquestPlayer);
  for (const p of [alpha[0], bravo[0]]) {
    const client = deployOptions(view, { id: p.id, team: p.team, squad: policy.squadIdFor(p) }).filter(o => o.kind !== 'squad');
    eq(spawnsOf(client), spawnsOf(policy.deploy.options(p).filter(o => o.kind !== 'squad')), `client parity for ${p.team}`);
  }
  // An HQ deploy lands on a forward flag cell with HQ spawn protection.
  game.killPlayer(alpha[0], bravo[0], 'rifle', false);
  ok(intent(game, alpha[0], 'hq'), 'HQ deploy accepted');
  run(game, CONQUEST_RULES.respawnMs + 200);
  const cells = ['A', 'B'].flatMap(id => flagOf(policy, id).spawns);
  ok(alpha[0].state === 'alive' && cells.some(c => Math.hypot(c.x - alpha[0].x, c.z - alpha[0].z) < 0.01), 'spawned on an A/B cell');
  ok(alpha[0].spawnProtectedUntil > game.now, 'with HQ spawn protection');
  // A defender cannot choose a lost flag.
  game.killPlayer(bravo[0], alpha[1], 'rifle', false);
  eq(intent(game, bravo[0], 'flag:A'), false, 'a lost flag is no defender spawn');
}

// --- out of tickets: overtime, no deploys, defenders win --------------------------------
{
  const { game, events, policy } = fixture();
  const { alpha, bravo } = roster(game, 4);
  park('alpha', alpha); park('bravo', bravo);
  run(game, TICK_MS);
  // Pool at 1, one attacker neutralizing A: the last death starts the overtime.
  policy.ledger.tickets.alpha = 1;
  place(alpha[0], 50, 40);
  run(game, 1000);
  eq(flagOf(policy, 'A').state, 'neutralizing');
  game.killPlayer(alpha[1], bravo[0], 'rifle', false);
  eq(policy.tickets.alpha, 0);
  run(game, TICK_MS);
  eq(game.mode.phase, 'live', 'overtime while an attacker still takes an active flag');
  eq(kinds(events, 'sector_overtime').length, 1, 'sector_overtime');
  run(game, TICK_MS);
  eq(game.lastSnapshot.match.conquest.bt[4], 1, 'bt[4] overtime');
  // Nobody of the attackers deploys any more.
  eq(intent(game, alpha[1], 'hq'), false, 'deploys are refused');
  run(game, TICK_MS);
  ok(events.some(e => e.kind === 'deploy_refused' && e.id === alpha[1].id && e.reason === 'tickets'), 'refused as tickets');
  run(game, CONQUEST_RULES.respawnMs + CONQUEST_RULES.deployTimeoutMs + 500);
  eq(alpha[1].state, 'dead', 'the deploy timeout does not spawn an attacker without tickets either');
  // The pusher leaves the flag: the defenders win.
  place(alpha[0], 20, 80);
  run(game, 500);
  eq([game.mode.phase, game.mode.matchWinner], ['post', 'bravo'], 'defenders win once the overtime push ends');
  const end = kinds(events, 'match_end').at(-1);
  eq([end.variant, end.attackers, end.sector, end.sectors], ['breakthrough', 'alpha', 0, 3]);
  // Out of tickets with nobody on an active flag ends at once; so does the time limit.
  const quick = fixture();
  const q = roster(quick.game, 2);
  park('alpha', q.alpha); park('bravo', q.bravo);
  quick.policy.ledger.tickets.alpha = 1;
  quick.game.killPlayer(q.alpha[0], q.bravo[0], 'rifle', false);
  eq([quick.game.mode.phase, quick.game.mode.matchWinner], ['post', 'bravo'], 'no push: the last ticket ends the round');
  const timed = fixture();
  roster(timed.game, 2);
  timed.policy.ledger.endsAt = timed.game.now + 100;
  run(timed.game, 300);
  eq([timed.game.mode.phase, timed.game.mode.matchWinner], ['post', 'bravo'], 'the time limit goes to the defenders');
}

// --- overtime edge cases: the last pusher dies, a revive refunds a ticket ----------------
{
  // The only pusher dies with the last ticket: no overtime (its presence is counted now, not last tick).
  const { game, events, policy } = fixture();
  const { alpha, bravo } = roster(game, 4);
  park('alpha', alpha); park('bravo', bravo);
  run(game, TICK_MS);
  policy.ledger.tickets.alpha = 1;
  place(alpha[0], 50, 40);
  run(game, 1000);
  eq(flagOf(policy, 'A').state, 'neutralizing');
  game.killPlayer(alpha[0], bravo[0], 'rifle', false);
  run(game, TICK_MS * 2);
  eq([kinds(events, 'sector_overtime').length, game.mode.phase, game.mode.matchWinner], [0, 'post', 'bravo'],
    'the last pusher dying with the last ticket ends the round without an overtime');
}
{
  // A revive refund during the overtime puts the round back to normal: leaving the flag no longer loses it.
  const { game, policy } = fixture();
  const { alpha, bravo } = roster(game, 4);
  park('alpha', alpha); park('bravo', bravo);
  run(game, TICK_MS);
  policy.ledger.tickets.alpha = 1;
  place(alpha[0], 50, 40);
  run(game, 1000);
  game.killPlayer(alpha[1], bravo[0], 'rifle', false);
  run(game, TICK_MS * 2);
  eq([policy.btView().overtime, policy.tickets.alpha], [true, 0], 'overtime');
  ok(policy.refundTicket('alpha'), 'a revive refunds a ticket');
  run(game, TICK_MS * 2);
  eq([policy.btView().overtime, game.lastSnapshot.match.conquest.bt[4]], [false, 0], 'a refund ends the overtime');
  place(alpha[0], 20, 80);
  run(game, 500);
  eq(game.mode.phase, 'live', 'with a ticket in the pool, leaving the flag does not lose the round');
}

// --- a defender joining mid-round never spawns on an active flag the attackers took --------
{
  const { game, policy } = fixture();
  roster(game, 2);
  Object.assign(flagOf(policy, 'A'), { owner: 'alpha', control: 1 });
  run(game, TICK_MS);
  eq(policy.btView().sector, 0, 'A alone does not advance the sector');
  const on = (p, id) => flagOf(policy, id).spawns.some(c => Math.hypot(c.x - p.x, c.z - p.z) < 0.01);
  const landed = [];
  for (let i = 0; i < 12; i++) {
    const p = human(game, `late${i}`);
    if (p.team === 'bravo') landed.push(on(p, 'A') ? 'A' : on(p, 'B') ? 'B' : '?');
  }
  ok(landed.length > 0 && landed.every(id => id === 'B'), `late defenders spawn on the active flag they still hold (${landed.join('')})`);
  // Both active flags taken mid-round (not yet advanced, e.g. inside one tick): the moved HQ (C) takes over.
  Object.assign(flagOf(policy, 'B'), { owner: 'alpha', control: 1 });
  policy._startSpawn = true;
  const pool = policy.hqPool(game.entities.get([...game.entities.keys()].find(id => policy.teamFor(id) === 'bravo')));
  policy._startSpawn = false;
  ok(pool.every(c => flagOf(policy, 'C').spawns.includes(c)), 'no defender-held active flag: the defenders\' moved HQ');
}

// --- breaking through the last sector, rematch -------------------------------------------
{
  const { game, events, policy } = fixture();
  const { alpha, bravo } = roster(game, 4);
  park('alpha', alpha); park('bravo', bravo);
  for (const id of ['A', 'B']) Object.assign(flagOf(policy, id), { owner: 'alpha', control: 1 });
  run(game, TICK_MS);
  Object.assign(flagOf(policy, 'C'), { owner: 'alpha', control: 1 });
  run(game, TICK_MS);
  eq(policy.btView().sector, 2, 'C alone is sector 2');
  eq(policy.front.lead, null, 'no lead line in front of the last sector');
  Object.assign(flagOf(policy, 'D'), { owner: 'alpha', control: 1 });
  run(game, TICK_MS);
  eq(game.mode.phase, 'live');
  // E by capture: the last sector falls and the attackers win.
  alpha.forEach((p, i) => place(p, 149 + i, 120));
  runUntil(game, () => game.mode.phase === 'post', 30000);
  eq([game.mode.phase, game.mode.matchWinner], ['post', 'alpha'], 'the attackers broke through');
  const last = kinds(events, 'sector_captured').at(-1);
  eq([last.sector, last.next, last.refill], [2, -1, 0]);
  // Rematch: everything back to sector 1, defenders on every flag, pool full.
  policy.reset();
  eq([policy.btView().sector, policy.flags.every(f => f.owner === 'bravo'), policy.tickets], [0, true, { alpha: BREAKTHROUGH_RULES.tickets, bravo: 0 }]);
}

// --- the refill arithmetic and ticket_low re-arming ---------------------------------------
{
  const { game, events, policy } = fixture();
  const { alpha, bravo } = roster(game, 2);
  park('alpha', alpha); park('bravo', bravo);
  run(game, TICK_MS);
  const low = Math.floor(BREAKTHROUGH_RULES.tickets * CONQUEST_RULES.ticketLowFractions[0]);
  policy.ledger.tickets.alpha = low + 1;
  game.killPlayer(alpha[0], bravo[0], 'rifle', false);
  eq(kinds(game.tickEvents, 'ticket_low').map(e => e.tickets), [low], 'ticket_low at 25 %');
  for (const id of ['A', 'B']) Object.assign(flagOf(policy, id), { owner: 'alpha', control: 1 });
  run(game, TICK_MS);
  const refill = kinds(events, 'sector_captured')[0];
  const added = Math.min(BREAKTHROUGH_RULES.refillPerSector, BREAKTHROUGH_RULES.tickets - low);
  eq([refill.refill, refill.tickets], [added, low + added], 'the refill, capped at the starting pool');
  ok(!policy.ledger.lowFired.alpha.has(CONQUEST_RULES.ticketLowFractions[0]), 'climbing back above 25 % re-arms its call');
}

// --- hulls per side (real Frontier spawns) and the Frontier front ------------------------
{
  const { FRONTIER_LAYOUT } = await import('../shared/world/frontier-layout.js');
  const meta = FRONTIER_LAYOUT.conquest;
  const list = breakthroughVehicleSpawns(meta.vehicleSpawns);
  const count = (team, type) => list.filter(s => s.team === team && s.type === type).length;
  eq([count('alpha', 'tank'), count('bravo', 'tank')], [2, 1], 'attackers field two tanks, the defenders the Iron Bridge tank');
  eq([count('alpha', 'jeep_at'), count('bravo', 'jeep_at')], [1, 2], 'the defenders\' HQ tank bay fields an AT jeep');
  ok(list.filter(s => s.flag).every(s => s.team === 'bravo'), 'every flag pad starts with the defenders');
  const extra = list.find(s => s.id === 'alpha-tank-2'), tank = meta.vehicleSpawns.find(s => s.id === 'alpha-tank');
  eq([extra.x, extra.z - tank.z, extra.y, extra.exitRoute.length], [tank.x, 20, tank.y, tank.exitRoute.length], 'the second tank parks 20 m south of the first');
  const bravoAttack = breakthroughVehicleSpawns(meta.vehicleSpawns, { ...BREAKTHROUGH_RULES, attackers: 'bravo' });
  eq(bravoAttack.find(s => s.id === 'bravo-tank-2').z, meta.vehicleSpawns.find(s => s.id === 'bravo-tank').z - 20, 'mirrored for an EAST attack');
  // No two ground hulls share a pad (the mobile AA's bay sits 9 m south of the HQ tank), on either battlefield.
  for (const mapId of ['frontier', 'redrock']) {
    const spawns = breakthroughVehicleSpawns(getMapMeta(mapId).conquest.vehicleSpawns);
    const ground = spawns.filter(s => ['jeep', 'jeep_at', 'tank', 'aa'].includes(s.type) && !s.flag);
    for (const a of ground) for (const b of ground) {
      if (a !== b) ok(Math.hypot(a.x - b.x, a.z - b.z) >= 8, `${mapId}: ${a.id} and ${b.id} park apart`);
    }
  }
  const bt = decodeBreakthrough(encodeBreakthrough({ attackers: 'alpha', sector: 1, sectors: BREAKTHROUGH_RULES.sectors.frontier }));
  const front = breakthroughFront(bt, meta.flags, meta.bases);
  eq(front.lines.map(Math.round), [256, 368], 'Frontier sector lines (metres from the West HQ): A/B | C | D/E');
  ok(outsideFront(front, { x: 300, z: 384 }, 'bravo', 'alpha') && !outsideFront(front, { x: 360, z: 384 }, 'bravo', 'alpha'),
    'defenders behind x 328 stand in lost ground');
  ok(!outsideFront(front, { x: 470, z: 300 }, 'alpha', 'alpha') && outsideFront(front, { x: 490, z: 300 }, 'alpha', 'alpha'),
    'attackers may push 40 m past the C | D/E line (x 480)');
}

// --- lobby: the host picks the variant ---------------------------------------------------
{
  const { LobbyManager } = await import('../server/lobby.js');
  const messages = [];
  const manager = new LobbyManager({ sendJson: (meta, msg) => messages.push({ id: meta.id, ...msg }), sendFrame: () => {}, closeClient: () => {} });
  try {
    const host = { id: 'host', clientContract: CONQUEST_CONTRACT_VERSION, careerLevel: 1 };
    eq(await manager.create(host, 'Host', 0, 'conquest', 'frontier'), true);
    eq([host.room.conquestVariant, host.room.engine.mode.variant], ['conquest', 'conquest']);
    eq(manager.configure(host, { gameMode: 'conquest', map: 'frontier', bots: 0, conquestVariant: 'rush' }), false, 'unknown variant refused');
    eq(manager.configure(host, { gameMode: 'conquest', map: 'frontier', bots: 0, conquestVariant: 'breakthrough' }), true);
    eq([host.room.conquestVariant, host.room.engine.mode.variant], ['breakthrough', 'breakthrough'], 'the room rebuilt its engine with Breakthrough');
    ok(host.room.engine.mode.policy instanceof BreakthroughPolicy);
    const state = messages.filter(m => m.t === 'lobbyState').at(-1);
    eq(state.conquestVariant, 'breakthrough', 'lobbyState publishes the variant');
    eq(manager.configure(host, { gameMode: 'conquest', map: 'frontier', bots: 0 }), true, 'a configure without the field keeps it');
    eq(host.room.engine.mode.variant, 'breakthrough');
    eq(makeLobbyState({ gameMode: 'tdm', map: 'foundry', conquestVariant: 'breakthrough' }).conquestVariant, undefined, 'only Conquest lobbies carry it');
  } finally { manager.stop(); }
}

console.log(`Conquest Breakthrough: ${checks} checks passed (contract and wire, round start, locked flags, sector capture and refill, `
  + 'fall-back grace and front, deploy options and client parity, overtime and tickets, break-through and rematch, hulls per side, lobby).');
