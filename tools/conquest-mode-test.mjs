// Conquest v2 authority: capture math, presence, flag events, tickets and
// bleed, time limit, bounds, squads, snapshot fields and the protocol parsers.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { ConquestPolicy } from '../server/modes/conquest.js';
import { TicketLedger } from '../server/modes/conquest/tickets.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { parseConquestIntent, parseVehicleAction, TICK_MS } from '../server/protocol/admission.js';
import { MODE_RULES, isModeMapCompatible, mapForMode, usesOwnedLoadout } from '../shared/modes.js';
import { lobbyCapacity, hasLobbyTeams } from '../shared/lobby-limits.js';
import {
  CONQUEST_RULES, KIT_IDS, decodeConquestPlayer, decodeConquestStats, REMOVED_EVENT_KINDS,
} from '../shared/conquest-contract.js';
import {
  advanceControl, buildCapturePresence, capturePresence, captureRateMultiplier, decodeConquestMatch,
  encodeConquestFlag, flagPresence,
} from '../shared/conquest.js';

// --- contract mirror ---------------------------------------------------------
for (const [key, value] of Object.entries(CONQUEST_RULES)) assert.deepEqual(MODE_RULES.conquest[key], value, `MODE_RULES.conquest.${key} mirrors the contract`);
for (const legacy of ['captureRadius', 'captureMs', 'bleedIntervalMs']) assert(!(legacy in MODE_RULES.conquest), `${legacy} is gone`);
assert.equal(MODE_RULES.conquest.teams, true);
assert.equal(usesOwnedLoadout('conquest'), true, 'kit inventories are authoritative');
assert.equal(lobbyCapacity('conquest', 'frontier'), 16);
assert.equal(hasLobbyTeams('conquest'), true);
assert.equal(isModeMapCompatible('conquest', 'foundry'), false);
assert.equal(mapForMode('conquest', 'foundry'), 'frontier');

// --- capture math (pure) -----------------------------------------------------
const R = CONQUEST_RULES;
/** Ticks until a neutral flag is owned by alpha with `a` vs `b` bodies inside. */
function captureMs(a, b, from = 0, owner = null) {
  const flag = { control: from, owner, state: 'idle' };
  let t = 0;
  while (flag.owner !== 'alpha' && t < 120000) { advanceControl(flag, { alpha: a, bravo: b }, TICK_MS, R); t += TICK_MS; }
  return t;
}
const base = captureMs(1, 0);
assert(Math.abs(base - R.captureHalfMs) <= TICK_MS, `1v0 captures a neutral flag in captureHalfMs (${base})`);
const ratio = (a, b) => base / captureMs(a, b);
assert(Math.abs(ratio(2, 0) - 1.5) <= 0.03, '2v0 (net 2) moves 1.5x');
assert(Math.abs(ratio(3, 1) - 1.5) <= 0.03, '3v1 is net 2: min(1 + 0.5(net-1), 2.5) = 1.5x');
assert(Math.abs(ratio(3, 0) - 2.0) <= 0.04, '3v0 (net 3) is 2x as fast as 1v0');
assert(Math.abs(ratio(4, 0) - 2.5) <= 0.05, '4v0 reaches the 2.5x cap');
assert(Math.abs(ratio(8, 0) - 2.5) <= 0.05, 'the rate never exceeds maxRateMult');
assert(Math.abs(ratio(3, 2) - 1.0) <= 0.02, '3v2 moves at the 1-net rate');
assert.equal(captureRateMultiplier(0), 0);
{
  const flag = { control: 0.4, owner: null, state: 'capturing', mover: 'alpha' };
  const events = [];
  for (let t = 0; t < 10000; t += TICK_MS) events.push(...advanceControl(flag, { alpha: 2, bravo: 2 }, TICK_MS, R));
  assert.equal(flag.control, 0.4, '2v2 holds control');
  assert.equal(flag.state, 'contested');
  assert.deepEqual(events, [{ kind: 'state', state: 'contested', team: null }], 'one state event for the contest');
}
{
  const owned = { control: 0.5, owner: 'alpha', state: 'idle' };
  for (let t = 0; t < 2000 - 1e-6; t += TICK_MS) advanceControl(owned, { alpha: 0, bravo: 0 }, TICK_MS, R);
  assert(Math.abs(owned.control - 0.6) < 1e-6, `an empty owned zone decays toward its owner at decayPerSec (${owned.control})`);
  assert.equal(owned.state, 'restoring');
  assert.equal(owned.mover, 'alpha');
  const neutral = { control: -0.3, owner: null, state: 'idle' };
  for (let t = 0; t < 2000 - 1e-6; t += TICK_MS) advanceControl(neutral, { alpha: 0, bravo: 0 }, TICK_MS, R);
  assert(Math.abs(neutral.control + 0.2) < 1e-6, 'an unowned zone decays toward 0');
  for (let t = 0; t < 10000; t += TICK_MS) advanceControl(neutral, { alpha: 0, bravo: 0 }, TICK_MS, R);
  assert.equal(neutral.control, 0);
  assert.equal(neutral.state, 'idle');
}
{
  const flag = { control: -1, owner: 'bravo', state: 'idle' };
  const events = [];
  let t = 0, neutralizedAt = null;
  while (flag.owner !== 'alpha' && t < 60000) {
    for (const ev of advanceControl(flag, { alpha: 1, bravo: 0 }, TICK_MS, R)) {
      events.push(ev);
      if (ev.kind === 'neutralized') neutralizedAt = t + TICK_MS;
    }
    t += TICK_MS;
  }
  assert(Math.abs(t - 16000) <= 100, `enemy-owned at 1v0: neutralized then captured in 16 s (${t})`);
  assert(Math.abs(neutralizedAt - 8000) <= 100, 'neutralized at the half-way point');
  assert.deepEqual(events.map(e => e.kind), ['state', 'neutralized', 'state', 'captured', 'state']);
  assert.deepEqual(events.filter(e => e.kind === 'neutralized'), [{ kind: 'neutralized', team: 'alpha', prev: 'bravo' }]);
  assert.deepEqual(events.filter(e => e.kind === 'state').map(e => [e.state, e.team]),
    [['neutralizing', 'alpha'], ['capturing', 'alpha'], ['idle', null]]);
}

// --- presence ----------------------------------------------------------------
{
  const hulls = { heli: { type: 'helicopter', grounded: false }, parked: { type: 'transport', grounded: true }, tank: { type: 'tank' } };
  const bodies = [
    { id: 'foot', team: 'alpha', state: 'alive', x: 0, y: 2, z: 0 },
    { id: 'pilot', team: 'alpha', state: 'alive', x: 0, y: 3, z: 0, vehicleId: 'heli' },
    { id: 'parked', team: 'alpha', state: 'alive', x: 0, y: 3, z: 0, vehicleId: 'parked' },
    { id: 'tanker', team: 'bravo', state: 'alive', x: 1, y: 3, z: 0, vehicleId: 'tank' },
    { id: 'down', team: 'bravo', state: 'dead', x: 0, y: 2, z: 0 },
    { id: 'npc', team: 'bravo', state: 'alive', x: 0, y: 2, z: 0, npcRole: 'zombie' },
    { id: 'high', team: 'bravo', state: 'alive', x: 0, y: 11, z: 0 },
    { id: 'far', team: 'bravo', state: 'alive', x: 30, y: 2, z: 0 },
  ];
  const presence = buildCapturePresence(bodies, { teamFor: p => p.team, vehicleFor: id => hulls[id] });
  assert.deepEqual(presence.map(p => p.id), ['foot', 'parked', 'tanker', 'high', 'far'], 'airborne aircraft crew, the dead and NPCs never count');
  const counts = flagPresence({ x: 0, y: 2, z: 0, radius: 20 }, presence, R);
  assert.deepEqual([counts.alpha, counts.bravo], [2, 1], 'presenceDy and the radius bound the zone');
  assert.deepEqual(capturePresence({ x: 0, y: 2, z: 0 }, [{ state: 'alive', team: 'alpha', x: 0, y: 37, z: 0 }], p => p.team, 24), { alpha: 0, bravo: 0 });
}

// --- engine fixture ------------------------------------------------------------
const SX = 160, SY = 32, SZ = 160;
const spot = (x, z) => ({ x: x + 0.5, y: 2, z: z + 0.5 });
const ring = (x, z) => Array.from({ length: 12 }, (_, i) => spot(x + Math.round(Math.cos(i * Math.PI / 6) * 6), z + Math.round(Math.sin(i * Math.PI / 6) * 6)));
const flagRow = (id, x, z, home) => ({ id, name: `Flag ${id}`, site: id.toLowerCase(), ...spot(x, z), radius: 10, home, spawns: ring(x, z) });
function fixture({ flags = null, combatArea = { minX: 2, maxX: 158, minZ: 2, maxZ: 158 } } = {}) {
  const hq = (team, x) => ({ id: team, name: `${team} HQ`, ...spot(x, 80), radius: 12, spawns: [spot(x, 76), spot(x, 80), spot(x, 84), spot(x + (x < 80 ? 3 : -3), 80)] });
  const bases = { alpha: hq('alpha', 8), bravo: hq('bravo', 151) };
  const mapMeta = { id: 'frontier', dimensions: { sx: SX, sy: SY, sz: SZ },
    spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
    conquest: { version: 2, flags: flags ?? [flagRow('A', 40, 40, 'alpha'), flagRow('B', 40, 120, 'alpha'), flagRow('C', 80, 80, null),
      flagRow('D', 120, 40, 'bravo'), flagRow('E', 120, 120, 'bravo')], bases, combatArea, vehicleSpawns: [] } };
  const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock: (x, y, z) => (x < 0 || z < 0 || x >= SX || z >= SZ || y < 2 ? 1 : 0),
    findSpawns: () => [spot(20, 20)], setBlock: () => {} };
  const events = [];
  const game = new GameEngine({ mode: 'conquest', mapMeta, world, broadcast: snap => { events.push(...snap.events); game.lastSnapshot = snap; } });
  const pads = [];
  game.vehicles.setPadOwner = (flagId, team) => pads.push([flagId, team]);
  return { game, events, pads, policy: game.mode.policy };
}
const run = (game, ms) => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
const place = (p, x, z) => Object.assign(p, { x: x + 0.5, y: 2, z: z + 0.5, vx: 0, vy: 0, vz: 0 });
function addPlayers(game, n, prefix = 'p') {
  const out = [];
  for (let i = 0; i < n; i++) { const id = `${prefix}${i}_x${i}k`; game.addClient(id, `P${i}`); out.push(game.entities.get(id)); }
  return out;
}
const park = (players, team) => players.filter(p => p.team === team).forEach((p, i) => place(p, team === 'alpha' ? 6 : 153, 70 + i));

// --- flag events, pads and ownership -------------------------------------------
{
  const { game, events, pads, policy } = fixture();
  const players = addPlayers(game, 4);
  assert.deepEqual(policy.flags.map(f => [f.id, f.owner, f.control]),
    [['A', 'alpha', 1], ['B', 'alpha', 1], ['C', null, 0], ['D', 'bravo', -1], ['E', 'bravo', -1]], 'home flags start owned, C neutral');
  park(players, 'alpha'); park(players, 'bravo');
  const [alpha] = players.filter(p => p.team === 'alpha');
  const [bravo] = players.filter(p => p.team === 'bravo');
  place(alpha, 80, 80);
  run(game, 8200);
  assert.equal(policy.flags[2].owner, 'alpha', 'one body captures C in 8 s');
  place(alpha, 6, 70);
  place(bravo, 40, 40);
  run(game, 16200);
  assert.equal(policy.flags[0].owner, 'bravo', 'bravo neutralizes and captures A in 16 s');
  const flagEvents = events.filter(e => e.kind.startsWith('flag_'));
  assert.equal(flagEvents.filter(e => e.kind === 'flag_captured').length, 2, 'exactly one flag_captured per capture');
  assert.equal(flagEvents.filter(e => e.kind === 'flag_neutralized').length, 1, 'exactly one flag_neutralized per neutralization');
  assert.deepEqual(flagEvents.filter(e => e.kind !== 'flag_state').map(e => [e.kind, e.flag, e.team, e.prev ?? null]),
    [['flag_captured', 'C', 'alpha', null], ['flag_neutralized', 'A', 'bravo', 'alpha'], ['flag_captured', 'A', 'bravo', null]]);
  assert.deepEqual(flagEvents.filter(e => e.kind === 'flag_state').map(e => `${e.flag}:${e.state}:${e.team}`),
    ['C:capturing:alpha', 'C:idle:null', 'A:neutralizing:bravo', 'A:capturing:bravo', 'A:idle:null']);
  for (const kind of REMOVED_EVENT_KINDS) assert.equal(events.filter(e => e.kind === kind).length, 0, `no legacy ${kind}`);
  assert.deepEqual(pads.slice(-3), [['C', 'alpha'], ['A', null], ['A', 'bravo']], 'flag pads follow capture and neutralize');
  const scores = events.filter(e => e.kind === 'score');
  assert(scores.some(e => e.id === alpha.id && e.reason === 'capture' && e.pts === 250));
  assert(scores.some(e => e.id === bravo.id && e.reason === 'neutralize' && e.pts === 150));
  assert(scores.some(e => e.id === bravo.id && e.reason === 'capture' && e.pts === 250));
}

// --- tickets: bleed, deaths, refund, ticket_low --------------------------------
{
  const { game, events, policy } = fixture();
  const players = addPlayers(game, 2);
  park(players, 'alpha'); park(players, 'bravo');
  const start = { ...policy.tickets };
  run(game, 6000);
  assert.deepEqual(policy.tickets, start, '2 v 2 flags (C neutral): nobody bleeds');
  assert.deepEqual(game.lastSnapshot.match.conquest.bleed, { alpha: 0, bravo: 0 });
  const setOwner = (id, owner) => Object.assign(policy.flags.find(f => f.id === id), { owner, control: owner === 'alpha' ? 1 : owner === 'bravo' ? -1 : 0, state: 'idle', mover: null });
  for (const [held, rate] of [[['A', 'B', 'C'], 3000], [['A', 'B', 'C', 'D'], 2000], [['A', 'B', 'C', 'D', 'E'], 1000]]) {
    for (const f of policy.flags) setOwner(f.id, held.includes(f.id) ? 'alpha' : 'bravo');
    run(game, TICK_MS);
    const before = policy.tickets.bravo;
    run(game, rate * 6);
    assert.equal(before - policy.tickets.bravo, 6, `${held.length} flags bleed 1 ticket per ${rate} ms`);
    assert.equal(policy.tickets.alpha, start.alpha, 'the majority team never bleeds');
    assert.deepEqual(game.lastSnapshot.match.conquest.bleed, { alpha: 0, bravo: rate }, 'bleed is published for the losing team');
  }
  for (const f of policy.flags) setOwner(f.id, f.home);
  run(game, TICK_MS);
  const alpha = players.find(p => p.team === 'alpha'), bravo = players.find(p => p.team === 'bravo');
  const t0 = policy.tickets.alpha;
  game.killPlayer(alpha, bravo, 'rifle', false);
  assert.equal(policy.tickets.alpha, t0 - 1, 'a death costs one ticket');
  assert.equal(policy.refundTicket('alpha'), true);
  assert.equal(policy.tickets.alpha, t0, 'a revive refund restores the ticket');
  policy.ledger.tickets.bravo = 76;
  for (let i = 0; i < 50; i++) policy.ledger.charge('bravo', 1).forEach(row => policy._emit('ticket_low', row));
  run(game, TICK_MS);
  const lows = events.filter(e => e.kind === 'ticket_low');
  assert.deepEqual(lows.map(e => [e.team, e.tickets]), [['bravo', 75], ['bravo', 30]], 'ticket_low fires once each at 25 % and 10 %');
  policy.ledger.tickets.bravo = 1;
  game.killPlayer(bravo, alpha, 'rifle', false);
  assert.equal(policy.phase, 'post');
  assert.equal(policy.matchWinner, 'alpha', 'a team at 0 tickets loses');
  run(game, TICK_MS);
  const ended = events.filter(e => e.kind === 'match_end').at(-1);
  assert.deepEqual(ended.scores, { alpha: policy.tickets.alpha, bravo: 0 });
  const graph = game.lastSnapshot.match.conquest.ticketGraph;
  assert(Array.isArray(graph) && graph.length >= 2 && graph.at(-1)[2] === 0, 'results carry the ticket graph after the match');
}

// --- time limit and tie-breaks ------------------------------------------------
{
  const outcome = (alphaTickets, bravoTickets, alphaFlags) => {
    const { game, policy } = fixture();
    addPlayers(game, 2);
    run(game, TICK_MS);
    policy.ledger.tickets.alpha = alphaTickets;
    policy.ledger.tickets.bravo = bravoTickets;
    for (const f of policy.flags) Object.assign(f, { owner: null, control: 0 });
    alphaFlags.forEach((owner, i) => Object.assign(policy.flags[i], { owner, control: owner === 'alpha' ? 1 : owner ? -1 : 0 }));
    policy.ledger.endsAt = game.now + 2 * TICK_MS;
    run(game, 3 * TICK_MS);
    assert.equal(policy.phase, 'post', 'the time limit ends the match');
    return policy.matchWinner;
  };
  assert.equal(outcome(120, 80, []), 'alpha', 'more tickets wins at the time limit');
  assert.equal(outcome(50, 90, ['alpha', 'alpha']), 'bravo', 'tickets decide before flags');
  assert.equal(outcome(70, 70, ['bravo', 'bravo', 'alpha']), 'bravo', 'equal tickets: more flags held wins');
  assert.equal(outcome(70, 70, ['alpha', 'bravo']), null, 'equal tickets and flags: a draw');
  const { policy } = fixture();
  assert.equal(policy.matchSnapshot().conquest.endsAt - policy.now, CONQUEST_RULES.timeLimitMs, 'endsAt is the 20-minute deadline');
}
{
  const ledger = new TicketLedger(CONQUEST_RULES);
  ledger.reset(0);
  for (let t = 1000; t <= CONQUEST_RULES.timeLimitMs; t += 1000) ledger.step(t, 1000, { alpha: 3, bravo: 2 });
  ledger.finish(CONQUEST_RULES.timeLimitMs);
  assert(ledger.graph.length <= 130, `ticket graph is capped at 130 points (${ledger.graph.length})`);
  assert.deepEqual(ledger.graph.slice(0, 3).map(r => r[0]), [0, 10000, 20000], 'sampled every 10 s');
  assert.equal(ledger.graph.at(-1)[0], CONQUEST_RULES.timeLimitMs);
  assert.equal(ledger.graph.at(-1)[2], 0, 'bravo bled out over 20 min of 3-flag bleed (300 x 3 s = 15 min)');
}

// --- HQ restriction and out of bounds -------------------------------------------
{
  const { game, events, policy } = fixture();
  const players = addPlayers(game, 2);
  park(players, 'alpha'); park(players, 'bravo');
  const alpha = players.find(p => p.team === 'alpha');
  place(alpha, 151, 80);
  run(game, 1000);
  const row = () => decodeConquestPlayer(game.lastSnapshot.players.find(p => p.id === alpha.id));
  assert(row().restrictedMs > 8800 && row().restrictedMs <= 9100, `an enemy in an HQ runs the 10 s timer (${row().restrictedMs})`);
  place(alpha, 100, 80);
  run(game, 200);
  assert.equal(row().restrictedMs, 0, 'leaving the zone clears the timer');
  place(alpha, 1, 80);
  run(game, 9900);
  assert.equal(alpha.state, 'alive');
  run(game, 200);
  assert.equal(alpha.state, 'dead', 'out of bounds for 10 s kills');
  assert(events.some(e => e.kind === 'kill' && e.victim === alpha.id && e.w === 'restricted'), 'the kill feed names the restricted death');
  assert.equal(policy.tickets.alpha, CONQUEST_RULES.tickets - 1);
}

// --- squads, snapshot rows and budgets -----------------------------------------
{
  const { game, policy } = fixture();
  const players = addPlayers(game, 16);
  assert.deepEqual([...game.entities.values()].filter(p => p.team === 'alpha').length, 8, 'teams balance 8/8');
  run(game, TICK_MS);
  const snap = game.lastSnapshot;
  const conquest = snap.match.conquest;
  assert.deepEqual(Object.keys(conquest).sort(), ['bleed', 'endsAt', 'flags', 'maxTickets', 'squads', 'tickets', 'v']);
  assert.equal(conquest.v, 2);
  assert.deepEqual(snap.match.scores, conquest.tickets, 'match.scores stays the ticket count');
  for (const tuple of conquest.flags) {
    assert.equal(tuple.length, 6);
    assert(Number.isInteger(tuple[1]) && Math.abs(tuple[1]) <= 100, 'control100 is an integer');
  }
  const bytes = Buffer.byteLength(JSON.stringify(conquest));
  assert(bytes <= 400, `match.conquest is ${bytes} B (budget 400)`);
  {
    // A busy tick: three flags in play with full zones, bleed running and an 8-digit clock.
    const saved = policy.flags.map(f => ({ ...f }));
    const endsAt = policy.ledger.endsAt;
    Object.assign(policy.flags[1], { control: 0.43, state: 'neutralizing', alpha: 2, bravo: 4 });
    Object.assign(policy.flags[2], { control: -0.57, owner: null, state: 'capturing', alpha: 1, bravo: 3 });
    Object.assign(policy.flags[3], { state: 'contested', alpha: 2, bravo: 2 });
    policy.ledger.endsAt = 87654321;
    policy.ledger.bleed.bravo = 3000;
    const busy = Buffer.byteLength(JSON.stringify(policy.matchSnapshot().conquest));
    assert(busy <= 400, `a busy-tick match.conquest is ${busy} B (budget 400)`);
    policy.flags.forEach((f, i) => Object.assign(f, saved[i]));
    policy.ledger.endsAt = endsAt;
    policy.ledger.bleed.bravo = 0;
  }
  assert.deepEqual(conquest.squads.map(([team, id]) => `${team}${id}`), ['alpha1', 'alpha2', 'bravo1', 'bravo2'], 'two squads of four per team');
  for (const [team, squadId, leader] of conquest.squads) {
    const members = snap.players.filter(p => p.team === team && decodeConquestPlayer(p).squad === squadId);
    assert.equal(members.length, 4);
    assert(members.some(p => p.id === leader), 'the leader is a member');
  }
  for (const row of snap.players) {
    const cq = decodeConquestPlayer(row);
    assert.equal(cq.kit, KIT_IDS[0], 'default kit is assault');
    assert(cq.squad > 0);
    assert.deepEqual(decodeConquestStats(row), { objective: 0, vehicles: 0, revives: 0, captures: 0 });
  }
  const decoded = decodeConquestMatch(conquest, policy.mapMeta.conquest);
  assert.deepEqual(decoded.flags.map(f => [f.id, f.name, f.x, f.owner, f.state]),
    policy.flags.map(f => [f.id, f.name, f.x, f.owner, f.state]), 'decodeConquestMatch merges the map statics');
  // Round trip of every cq/cqs slot through the snapshot encoder.
  const probe = { ...players[0], conquest: { kit: 'recon', squad: 3, down: true, spotted: 1e15, restrictedMs: 4321, actionProgress: 0.456, stats: [350, 2, 4, 1] }, lockProgress: 0.734 };
  const row = makeSnapshot([probe], [], [], 1000, undefined).players[0];
  assert.deepEqual(decodeConquestPlayer(row), { kit: 'recon', squad: 3, down: true, spotted: true, restrictedMs: 4400, lockProgress: 0.73, actionProgress: 0.46, chute: 0 });
  assert.equal(row.cq.length, 7, 'a body without a canopy keeps seven cq entries');
  // The parachute state (shared/parachute.js) rides as an optional 8th entry.
  const chuted = makeSnapshot([{ ...probe, chute: 2 }], [], [], 1000, undefined).players[0];
  assert.equal(chuted.cq.length, 8); assert.equal(decodeConquestPlayer(chuted).chute, 2, 'cq[7] carries the ejection seat / canopy state');
  assert.deepEqual(decodeConquestStats(row), { objective: 350, vehicles: 2, revives: 4, captures: 1 });
  const plain = makeSnapshot([{ ...players[0], conquest: undefined }], [], [], 1000, undefined).players[0];
  assert(!('cq' in plain) && !('cqs' in plain), 'non-Conquest rows carry no cq/cqs');
  // Squad balance survives leaves and joins.
  for (const p of players.slice(0, 5)) game.removeClient(p.id);
  for (const team of ['alpha', 'bravo']) {
    const sizes = policy.squads.sizes(team);
    assert(Math.max(...sizes) - Math.min(...sizes) <= 1 && sizes.every(n => n <= 4), `${team} squads stay balanced after leaves: ${sizes}`);
  }
  addPlayers(game, 3, 'late');
  for (const team of ['alpha', 'bravo']) {
    const sizes = policy.squads.sizes(team);
    assert(Math.max(...sizes) - Math.min(...sizes) <= 1 && sizes.every(n => n <= 4), `${team} squads stay balanced after joins: ${sizes}`);
  }
}

// --- policy without an engine (context only) ------------------------------------
{
  let now = 0;
  const entities = new Map();
  const policy = new ConquestPolicy({ rules: MODE_RULES.conquest, now: () => now, entities, emit: () => {},
    chooseSpawn: pool => pool[0], respawn: (p, s) => Object.assign(p, s, { state: 'alive' }),
    mapMeta: { id: 'frontier', conquest: { flags: [{ id: 'A', x: 30, y: 11, z: 30, radius: 24 }], bases: {} },
      spawns: { conquest: { alpha: [{ x: 0, y: 11, z: 0 }], bravo: [{ x: 100, y: 11, z: 100 }] } } } });
  const p = { id: 'solo', weapon: 0, grenades: [], state: 'alive' };
  entities.set(p.id, p);
  policy.onPlayerAdd(p);
  Object.assign(p, { x: 30, y: 11, z: 30 });
  now = 9000; policy.tick();
  assert.equal(policy.flags[0].owner, 'alpha', 'context-only policies still capture');
  assert.equal(policy.killScoreDelta(), 0, 'kill points come from the ledger only');
}

// --- protocol parsers --------------------------------------------------------------
assert.deepEqual(parseConquestIntent({ t: 'conquest', deploy: { spawn: 'flag:C', kit: 'engineer', variant: 1 } }), { type: 'deploy', spawn: 'flag:C', kit: 'engineer', variant: 1, gadget: 0 },
  'no gadget field: the engineer keeps the AT launcher (backward compatible)');
assert.deepEqual(parseConquestIntent({ t: 'conquest', deploy: { spawn: 'flag:C', kit: 'engineer', variant: 0, gadget: 1 } }), { type: 'deploy', spawn: 'flag:C', kit: 'engineer', variant: 0, gadget: 1 },
  'the engineer may deploy with the STINGER');
assert.equal(parseConquestIntent({ t: 'conquest', deploy: { spawn: 'hq', kit: 'assault', gadget: 0 } }).gadget, 0);
assert.deepEqual(parseConquestIntent({ t: 'conquest', deploy: { spawn: 'vehicle:alpha-tank:commander', kit: 'recon', variant: 0 } }).spawn, 'vehicle:alpha-tank:commander');
assert.deepEqual(parseConquestIntent({ t: 'conquest', deploy: { spawn: 'squad:p3_abc123' } }), { type: 'deploy', spawn: 'squad:p3_abc123', kit: 'assault', variant: 0, gadget: 0 });
assert.deepEqual(parseConquestIntent({ t: 'conquest', spot: 1 }), { type: 'spot' });
assert.deepEqual(parseConquestIntent({ t: 'conquest', redeploy: 1 }), { type: 'redeploy' }, 'the in-game menu RESPAWN intent');
assert.deepEqual(parseConquestIntent({ t: 'conquest', support: { type: 'repair', targetId: 'alpha-tank' } }), { type: 'support', support: 'repair', targetId: 'alpha-tank' });
for (const bad of [
  { t: 'conquest', deploy: { spawn: 'flag:F' } }, { t: 'conquest', deploy: { spawn: 'flag:a' } },
  { t: 'conquest', deploy: { spawn: 'hq', kit: 'medic' } }, { t: 'conquest', deploy: { spawn: 'hq', variant: 2 } },
  { t: 'conquest', deploy: { spawn: 'hq', extra: 1 } }, { t: 'conquest', deploy: { spawn: 'squad:' } },
  { t: 'conquest', deploy: { spawn: 'hq', kit: 'engineer', gadget: 2 } }, { t: 'conquest', deploy: { spawn: 'hq', kit: 'engineer', gadget: '1' } },
  { t: 'conquest', deploy: { spawn: 'hq', kit: 'assault', gadget: 1 } }, { t: 'conquest', deploy: { spawn: 'hq', gadget: 1 } },
  { t: 'conquest', deploy: { spawn: `squad:${'x'.repeat(65)}` } }, { t: 'conquest', deploy: { spawn: 'vehicle:a:b:c' } },
  { t: 'conquest', deploy: { spawn: 'hq ' } }, { t: 'conquest', spot: 2 }, { t: 'conquest', spot: 1, deploy: { spawn: 'hq' } },
  { t: 'conquest', support: { type: 'heal', targetId: 'x' } }, { t: 'conquest', support: { type: 'revive', targetId: 'x'.repeat(65) } },
  { t: 'conquest', support: { type: 'revive' } }, { t: 'input', spot: 1 }, { t: 'conquest' }, null, [],
  { t: 'conquest', redeploy: 0 }, { t: 'conquest', redeploy: { now: 1 } }, { t: 'conquest', redeploy: 1, spot: 1 },
]) assert.equal(parseConquestIntent(bad), null, `rejects ${JSON.stringify(bad)}`);
assert.deepEqual(parseVehicleAction({ type: 'enter', vehicleId: 'alpha-tank' }), { type: 'enter', vehicleId: 'alpha-tank' });
assert.deepEqual(parseVehicleAction({ type: 'enter', vehicleId: 'alpha-tank', seatId: 'commander' }), { type: 'enter', vehicleId: 'alpha-tank', seatId: 'commander' });
assert.deepEqual(parseVehicleAction({ type: 'exit' }), { type: 'exit' });
assert.deepEqual(parseVehicleAction({ type: 'seat', seatId: 'gunner' }), { type: 'seat', seatId: 'gunner' });
assert.deepEqual(parseVehicleAction({ type: 'cm' }), { type: 'cm' });
assert.deepEqual(parseVehicleAction({ type: 'weapon', index: 0 }), { type: 'weapon', index: 0 });
assert.deepEqual(parseVehicleAction({ type: 'weapon', index: 3 }), { type: 'weapon', index: 3 });
for (const bad of [{ type: 'weapon', index: 4 }, { type: 'weapon', index: -1 }, { type: 'weapon', index: 1.5 }, { type: 'seat' },
  { type: 'seat', seatId: '' }, { type: 'cm', x: 1 }, { type: 'exit', vehicleId: 'a' }, { type: 'enter' }, { type: 'enter', vehicleId: 'x'.repeat(65) },
  { type: 'enter', vehicleId: 'a', seatId: 'x'.repeat(33) }, { type: 'fire' }, { type: 'repair', vehicleId: 'a' }, 'enter', null])
  assert.equal(parseVehicleAction(bad), null, `rejects vehicle action ${JSON.stringify(bad)}`);
assert.deepEqual(encodeConquestFlag({ id: 'C', control: -0.257, owner: null, state: 'capturing', alpha: 1, bravo: 3 }), ['C', -26, null, 'capturing', 1, 3],
  'unowned flags publish the side control leans toward as def');
// A bravo lean below wire precision rounds to -0 (JSON sends 0): encoder and
// decoder must agree on the side, or the zone counts arrive swapped.
for (const control of [-0.003, -0.00417, 0.003, 0]) {
  const wire = JSON.parse(JSON.stringify({ flags: [encodeConquestFlag({ id: 'C', control, owner: null, state: 'capturing', alpha: 0, bravo: 3 })] }));
  const [row] = decodeConquestMatch(wire).flags;
  assert.deepEqual([row.alpha, row.bravo], [0, 3], `control ${control} keeps alpha/bravo counts through the wire`);
}

console.log('Conquest v2 authority: capture math (1v0 8 s, net scaling, 2.5x cap, contest, decay, 16 s flip), presence (airborne/down/NPC excluded), one flag_* event per transition with pads, majority bleed 3/2/1 s, death cost and refund, ticket_low 25/10 %, zero-ticket and time-limit wins with tie-breaks, ticket graph, HQ/OOB restriction deaths, balanced squads, cq/cqs round trip, 400 B match budget and strict parsers passed.');
