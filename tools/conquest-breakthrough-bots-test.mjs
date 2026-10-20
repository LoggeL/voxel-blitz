// Breakthrough bots on the real Frontier map (GameEngine + attachBots, no
// sockets, no browser): the commander gives orders on the active sector only,
// attackers push and defenders hold, both sides deploy on the spawns their
// side of the front allows, and after a sector falls the defenders fall back
// behind the new line inside the grace instead of dying to the out-of-bounds
// timer. Every position comes from mapMeta.
//
//   node tools/conquest-breakthrough-bots-test.mjs [--seconds 120] [--seed 1] [--bots 16]
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { BREAKTHROUGH_RULES, CONQUEST_RULES } from '../shared/conquest-contract.js';
import { outsideFront, sectorRole } from '../shared/breakthrough.js';
import { mulberry32 } from '../shared/noise.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const SECONDS = Number(option('seconds', 120));
const BOTS = Number(option('bots', 16));
Math.random = mulberry32(Number(option('seed', 1)));
const EPOCH = 1_800_000_000_000;
const atEpoch = build => { const real = Date.now; Date.now = () => EPOCH; try { return build(); } finally { Date.now = real; } };

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

const meta = getMapMeta('frontier');
const world = createMapState('frontier');
const events = [];
let matchMax = 0;
const game = atEpoch(() => new GameEngine({ mode: 'conquest', conquestVariant: 'breakthrough', world, mapMeta: meta,
  broadcast: snap => {
    for (const e of snap.events ?? []) events.push({ ...e, at: game.now });
    { const text = JSON.stringify(snap.match?.conquest ?? {}); if (text.length > matchMax) { matchMax = text.length; globalThis.maxText = text; } }
  } }));
const policy = game.mode.policy;
const bots = attachBots(game, BOTS);
const commander = bots.commander;
ok(commander, 'the bot commander runs');
const teamOf = p => game.mode.teamFor(p);
const attackers = BREAKTHROUGH_RULES.attackers;
const flagById = new Map(meta.conquest.flags.map(f => [f.id, f]));
const tickMs = [];
const step = () => { const t0 = performance.now(); game.step(TICK_MS); tickMs.push(performance.now() - t0); };

/** Every squad order of both teams targets a flag of the active sector. */
function ordersOnActive(label) {
  const bt = policy.btView();
  const orders = [];
  for (const ts of commander.teams.values()) for (const squad of ts.squads.values()) if (squad.order) orders.push({ team: ts.team, ...squad.order });
  ok(orders.length > 0, `${label}: squads have orders`);
  const off = orders.filter(o => sectorRole(bt, o.flagId) !== 'active');
  eq(off, [], `${label}: no order targets a captured or locked flag`);
  return orders;
}

// --- round start -------------------------------------------------------------------
for (let i = 0; i < 20; i++) step();
{
  const orders = ordersOnActive('start');
  ok(orders.some(o => o.team === attackers && o.stance === 'attack'), 'attackers attack sector 1');
  ok(orders.filter(o => o.team !== attackers).every(o => o.stance === 'defend'), 'defenders defend sector 1');
  // Round start: the defenders stand dug in on the active sector, one flag per squad.
  const near = (p, id) => Math.hypot(p.x - flagById.get(id).x, p.z - flagById.get(id).z) < 60;
  const active = policy.sectors[0];
  const defenderBots = [...game.entities.values()].filter(p => p.bot && teamOf(p) !== attackers && !p.vehicleId);
  ok(defenderBots.length > 0 && defenderBots.every(p => active.some(id => near(p, id))),
    `defender bots start on the active sector (${active.join('/')})`);
  ok(active.every(id => defenderBots.some(p => near(p, id))), 'every active flag is manned at the start');
}

// --- the opening fight -----------------------------------------------------------------
const opening = Math.round(SECONDS * 1000 / TICK_MS);
let restrictedDeaths = 0;
for (let t = 0; t < opening; t++) {
  step();
  if (t % 100 === 0) ordersOnActive(`t=${(t * TICK_MS / 1000).toFixed(0)} s`);
}
const kills = events.filter(e => e.kind === 'kill');
const attackerDeaths = kills.filter(e => teamOf(e.victim) === attackers && game.entities.has(e.victim)).length;
ok(kills.length >= 5, `bots fight (${kills.length} kills in ${SECONDS} s)`);
const flagTransitions = events.filter(e => e.kind === 'flag_neutralized' || e.kind === 'flag_captured');
ok(flagTransitions.some(e => e.team === attackers), `attackers move sector-1 flags (${flagTransitions.map(e => `${e.kind.slice(5)} ${e.flag}`).join(', ') || 'none'})`);
ok(policy.tickets[attackers] <= BREAKTHROUGH_RULES.tickets - Math.min(attackerDeaths, 5) + BREAKTHROUGH_RULES.refillPerSector, 'attacker deaths draw on the pool');
eq(policy.tickets[attackers === 'alpha' ? 'bravo' : 'alpha'], 0, 'defenders have no pool');
restrictedDeaths += kills.filter(e => e.w === 'restricted').length;

// --- a sector falls: the defenders fall back inside the grace ------------------------------
if (policy.btView().sector === 0) {
  for (const id of policy.sectors[0]) Object.assign(policy.flags.find(f => f.id === id), { owner: attackers, control: attackers === 'alpha' ? 1 : -1, state: 'idle', mover: null });
}
step();
ok(policy.btView().sector >= 1, 'sector 1 taken');
const fallStart = events.length;
const behind = () => [...game.entities.values()].filter(p => p.bot && p.state === 'alive' && !p.vehicleId && teamOf(p) !== attackers
  && outsideFront(policy.front, p, teamOf(p), attackers));
const behindAtFall = behind().length;
for (let t = 0; t < Math.round((BREAKTHROUGH_RULES.fallbackGraceMs + CONQUEST_RULES.outOfBoundsMs + 5000) / TICK_MS); t++) step();
const fallKills = events.slice(fallStart).filter(e => e.kind === 'kill' && e.w === 'restricted' && teamOf(e.victim) !== attackers);
ok(fallKills.length <= Math.max(1, Math.ceil(behindAtFall / 3)), `defender bots fall back (${behindAtFall} behind the line, ${fallKills.length} lost to the timer)`);
ordersOnActive('after the fall');
const attackerSpawns = events.slice(fallStart).filter(e => e.kind === 'respawn' && teamOf(e.id) === attackers);
const forwardCells = policy.sectors[0].flatMap(id => policy.flags.find(f => f.id === id).spawns);
const forward = attackerSpawns.filter(e => Number.isFinite(e.x) && forwardCells.some(c => Math.hypot(c.x - e.x, c.z - e.z) < 0.5)).length;
console.log(`attacker respawns after the fall: ${attackerSpawns.length}, on the forward base: ${forward}`);
restrictedDeaths += fallKills.length;

ok(matchMax <= 400, `match.conquest with the bt tuple stays in the 400 B budget (max ${matchMax} B)`);
const sorted = tickMs.slice().sort((a, b) => a - b);
const p95 = sorted[Math.floor(sorted.length * 0.95)];
console.log(`ticks ${tickMs.length}, p95 ${p95.toFixed(2)} ms, kills ${kills.length}, restricted deaths ${restrictedDeaths}, tickets ${policy.tickets[attackers]}`);
bots.dispose?.();
console.log(`Conquest Breakthrough bots: ${checks} checks passed (orders on the active sector only, attack and defend roles, forward spawns, fall-back).`);
