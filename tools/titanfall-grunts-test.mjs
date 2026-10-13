// Titanfall attrition minions (docs/titanfall.md §10, §11.1; WP8). Headless, seeded:
//  - waves: squads of 4 at each team's side, the per-team cap of 12, a reset clears them;
//  - bodies: grunt 100 hp / spectre 200 hp, team, kind, weapon owned, real combat bodies;
//  - scoring: a pilot kill of a grunt is 1 point and of a spectre 2 (team score and personal
//    score), pilot K/D unchanged, +0.02 titan meter, a kill event for the feed; a minion
//    killing a minion scores for its team; no points after the match ended;
//  - killable by everything: pilot hitscan through resolveWeaponIntent, a titan primary
//    through mounts.fire, a titan blast (blastAt), the walker leg crush and the titanfall
//    drop crush; the auto-titan picks a minion as a target;
//  - minions fight: a grunt hits a pilot standing in the open within 40 m; a cloaked pilot
//    beyond reveal range is ignored;
//  - wire: match.titanfall.npc rows (9-tuples) and no minion in the player rows, avg row bytes;
//  - a 16-bot frontier match with grunts at the cap: no NaN, no errors, minions advance on
//    the midfield, few watchdog removals, and the tick cost stays within budget;
//  - canyon and harbor waves with 6 bots: squads route off their drop point (≤ 10 % watchdog
//    removals), finite poses, pilot kills equal pilot-on-pilot kill events;
//  - other modes: no grunt system, engine.npcs untouched (bastion NPC rows still ship).
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { getMapMeta, createMapState } from '../shared/world/templates.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { AIR, STONE } from '../shared/world/blocks.js';
import { TITAN_RULES, titanFrame } from '../shared/vehicle-handling/titan.js';
import { vehicleDef } from '../shared/vehicle-defs.js';
import { aimAngles } from '../server/sim/player.js';
import { attachBots } from '../server/bots.js';
import { titanCockpitEye } from '../server/sim/titanfall/titan-mounts.js';
import { GRUNT_RULES, decodeGruntRow } from '../server/sim/titanfall/grunts.js';
import { blastAt } from '../server/sim/titanfall/titan-abilities.js';
import { TITANFALL_STATE_KEYS } from './lib/protocol-contract.mjs';
import { decodeNpcRow } from '../public/js/titanfall/npc-view.js';

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const notes = [];

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const realRandom = Math.random;
Math.random = seeded(0x6a17);

const TICKS_PER_S = 1000 / TICK_MS;
const ticks = seconds => Math.round(seconds * TICKS_PER_S);
const DROP_TICKS = Math.ceil((TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs) / TICK_MS) + 2;

/* ---------------------------------------------------------------- arena (harbor, flattened) */
const G = 10;
const ARENA = { minX: 30, maxX: 160, minZ: 52, maxZ: 92 };

function flatten(engine, rect, level = G) {
  const world = engine.world, sy = world.dimensions.sy;
  for (let x = rect.minX; x < rect.maxX; x++) for (let z = rect.minZ; z < rect.maxZ; z++) {
    for (let y = 0; y < sy; y++) world.setBlock(x, y, z, y < level ? STONE : AIR);
  }
  engine.blockRevision++;
}

/** A titanfall engine on harbor with exactly `roster`, the flattened arena, and automatic waves off. */
function arena(roster = [['a1', 'alpha'], ['a2', 'alpha'], ['b1', 'bravo'], ['b2', 'bravo']]) {
  const f = { events: [], last: null };
  f.engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('harbor'), world: createMapState('harbor'),
    broadcast: s => { f.last = s; for (const e of s.events ?? []) f.events.push(e); } });
  f.policy = f.engine.mode.policy;
  f.grunts = f.policy.grunts;
  f.grunts.enabled = false;
  f.titans = f.engine.vehicles.titans;
  f.vehicles = f.engine.vehicles;
  for (const [id, team] of roster) {
    f.engine.addClient(id, id.toUpperCase());
    f.policy.setLobbyTeam(id, team);
    f.policy.deployNow?.(id);
  }
  flatten(f.engine, ARENA);
  f.step = (n = 1, each = null) => { for (let i = 0; i < n; i++) { each?.(i); f.engine.step(TICK_MS); } };
  f.step(2);
  f.p = id => f.engine.entities.get(id);
  f.kinds = kind => f.events.filter(e => e.kind === kind);
  f.npc = (kind, team, x, z, { hold = true } = {}) => {
    const p = f.grunts.spawn(kind, team, { x, y: G + 0.02, z });
    p.tfNpc.hold = hold;
    return p;
  };
  return f;
}
function place(p, x, z, yaw = 0, pitch = 0, y = G) {
  Object.assign(p, { x, y, z, vx: 0, vy: 0, vz: 0, grounded: true, yaw, pitch, spawnProtectedUntil: 0, spawnProtected: false });
  p.input = { ...(p.input || {}), keys: {}, yaw, pitch };
  p.hist = [];
}
function park(f, p) {
  if (p.state === 'alive') f.engine.killPlayer(p, null, 'world', false);
  p.respawnAt = Infinity;
}
function aimAt(p, point, fire = false) {
  const a = aimAngles([p.x, p.eyeY, p.z], point);
  p.input = { ...(p.input || {}), keys: {}, yaw: a.yaw, pitch: a.pitch, wantFire: fire };
  p.yaw = a.yaw; p.pitch = a.pitch;
}
function landAt(f, p, x, z, from = 18) {
  place(p, x, z + from, 0);
  aimAt(p, [x, G + 0.01, z]);
  f.policy.setTitanMeter(p, 1);
  const result = f.titans.call(p, null);
  assert.ok(result.ok, `call for ${p.id} at ${x},${z}: ${result.reason}`);
  f.step(DROP_TICKS + 62);
  const v = f.vehicles.vehicles.get(result.vehicleId);
  assert.ok(v && !v.dropping && v.hp > 0, 'titan landed');
  return v;
}
function embark(f, p, v) {
  place(p, v.x, v.z + titanFrame(v).hl + 1.2, v.yaw);
  const entered = f.vehicles.action(p, { type: 'enter', vehicleId: v.id });
  f.step(ticks(TITAN_RULES.embark.animMs / 1000) + 2);
  return entered;
}
const lastKill = (f, victim) => f.kinds('kill').filter(e => e.victim === victim).at(-1) ?? null;

/* ================================================================ bodies, scoring, feed, meter */
{
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, a2); park(f, b2);
  place(a1, 60, 70); place(b1, 140, 70);
  const g = f.npc('grunt', 'bravo', 80, 70), s = f.npc('spectre', 'bravo', 82, 70), mate = f.npc('grunt', 'alpha', 70, 74);
  eq([g.hp, g.maxHp, s.hp, s.maxHp], [100, 100, 200, 200], 'grunt 100 hp, spectre 200 hp');
  eq([g.team, s.team, g.npcRole, s.npcRole, g.owned, s.owned], ['bravo', 'bravo', 'grunt', 'spectre', ['rifle'], ['smg']], 'team, kind and owned weapon');
  ok(f.engine.npcs.get(g.id) === g && f.engine.combatants.get(g.id) === g && !f.engine.entities.has(g.id), 'a minion is a combatant, not a player');
  ok(f.policy.isEnemy(a1, g) && !f.policy.isEnemy(mate, a1) && f.policy.canDamage(a1, g) && !f.policy.canDamage(mate, a1), 'teams: enemies and allies');
  ok(g.def.damage[0] < 20 && g.def.rpm === GRUNT_RULES.kinds.grunt.def.rpm, 'minion weapon def is the tuned one');
  f.policy.setTitanMeter(a1, 0.5);
  const kills0 = a1.kills, score0 = a1.score, team0 = f.policy.scores.alpha;
  g.takeDamage(500, false, a1, 'rifle');
  f.engine.killPlayer(g, a1, 'rifle', false);
  eq(f.policy.scores.alpha - team0, 1, 'grunt kill: +1 to the team');
  eq(a1.score - score0, 1, 'grunt kill: +1 personal score');
  eq(a1.kills, kills0, 'grunt kill: pilot kills unchanged (minions are tracked apart)');
  eq(a1.tfMinionKills, 1, 'minion kill counted');
  ok(Math.abs(f.policy.titanMeter(a1) - 0.52) < 1e-9, `meter +0.02 per minion kill (${f.policy.titanMeter(a1)})`);
  s.takeDamage(500, false, a1, 'rifle');
  f.engine.killPlayer(s, a1, 'rifle', false);
  eq(f.policy.scores.alpha - team0, 3, 'spectre kill: +2 to the team');
  eq(a1.score - score0, 3, 'spectre kill: +2 personal score');
  f.step(1);
  const feed = f.kinds('kill').filter(e => e.killer === 'a1').map(e => e.victim);
  ok(feed.includes(g.id) && feed.includes(s.id), 'kill events (feed) for both minions');
  // Wire: the dying rows go out flagged dead, then the bodies leave.
  const dead = f.last.match.titanfall.npc.map(decodeGruntRow).filter(r => r.dead).map(r => r.id).sort();
  eq(dead, [g.id, s.id].sort(), 'dead minions ride the wire flagged dead');
  f.step(ticks(GRUNT_RULES.corpseMs / 1000) + 2);
  ok(!f.engine.npcs.has(g.id) && !f.engine.npcs.has(s.id), 'dead minions are removed after corpseMs');
  // A minion killing a minion scores for its team.
  const g2 = f.npc('grunt', 'bravo', 90, 70);
  const before = f.policy.scores.alpha;
  g2.takeDamage(500, false, mate, 'rifle');
  f.engine.killPlayer(g2, mate, 'rifle', false);
  eq(f.policy.scores.alpha - before, 1, 'minion kills minion: +1 to its team');
  // A pilot killed by a minion: the stock pilot points (5) to the minion's team.
  const bravo0 = f.policy.scores.bravo, g3 = f.npc('grunt', 'bravo', 92, 70);
  a1.takeDamage(500, false, g3, 'rifle');
  f.engine.killPlayer(a1, g3, 'rifle', false);
  eq(f.policy.scores.bravo - bravo0, f.policy.rules.points.pilot, 'minion kills a pilot: pilot points to its team');
  f.step(2);
  // Wire keys and row layout; no minion in the player rows.
  eq(Object.keys(f.last.match.titanfall).sort().join(), TITANFALL_STATE_KEYS, 'match.titanfall keys');
  ok(f.last.players.every(row => !String(row.id).startsWith('tfg')), 'no minion in the player rows');
  const rows = f.last.match.titanfall.npc;
  ok(rows.length >= 2 && rows.every(r => Array.isArray(r) && r.length === 9), 'npc rows are 9-tuples');
  const row = decodeGruntRow(rows.find(r => r[0] === mate.tfNpc.serial));
  eq([row.id, row.kind, row.team, row.hp], [mate.id, 'grunt', 'alpha', 100], 'row: id, kind, team, hp100');
  ok(Math.abs(row.x - mate.x) <= 0.05 && Math.abs(row.z - mate.z) <= 0.05, 'row: position to 0.1 m');
  eq(rows.map(decodeNpcRow), rows.map(decodeGruntRow), 'client decodeNpcRow matches the server decoder');
  // After the match: no points.
  f.policy._finishMatch('alpha');
  const g4 = f.npc('grunt', 'bravo', 94, 70), post = f.policy.scores.alpha;
  g4.takeDamage(500, false, mate, 'rifle');
  f.engine.killPlayer(g4, mate, 'rifle', false);
  eq(f.policy.scores.alpha, post, 'no minion points after the match ended');
  f.engine.stop();
}

/* ================================================================ killable by pilot fire, titan weapons, blast, crush */
{
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, b1); park(f, b2);
  // Pilot hitscan through the stock weapon path.
  place(a1, 60, 70); place(a2, 60, 88);
  const g = f.npc('grunt', 'bravo', 60, 58);
  let hits = 0;
  for (let i = 0; i < ticks(4) && g.state === 'alive'; i++) {
    aimAt(a1, [g.x, g.y + 1.2, g.z], i % 8 < 5);
    f.step(1);
  }
  hits = f.kinds('hit').filter(e => e.attacker === 'a1' && e.victim === g.id).length;
  ok(hits > 0, `pilot fire hits a grunt (${hits} hits, weapon ${a1.def?.id})`);
  ok(g.state === 'dead' && lastKill(f, g.id)?.killer === 'a1', 'pilot fire kills a grunt');
  // Titan blast (thermite / cluster / core damage path).
  const v = (() => { place(a1, 100, 72); return landAt(f, a1, 100.5, 72.5); })();
  const sB = f.npc('spectre', 'bravo', 120, 60);
  blastAt(f.titans, v, a1, [sB.x, sB.y + 0.5, sB.z], { radius: 3, hull: 0, infantry: 400, key: 'titan_t203', cls: 'titan' });
  f.step(1);
  ok(sB.state === 'dead' && lastKill(f, sB.id)?.killer === 'a1', 'a titan blast kills a spectre (credited to the pilot)');
  // Titan primary through mounts.fire.
  ok(embark(f, a1, v), 'pilot embarks');
  const gT = f.npc('spectre', 'bravo', v.x, v.z - 22);
  const seat = vehicleDef(v).seats[0], mount = seat.mounts[0], weapon = vehicleDef(v).seats[0].weapons?.[0] ?? null;
  for (let i = 0; i < ticks(10) && gT.state === 'alive'; i++) {
    const a = aimAngles(titanCockpitEye(v), [gT.x, gT.y + 1.0, gT.z]);
    a1.input = { ...(a1.input || {}), keys: {}, vehicleThrottle: 0, vehicleSteer: 0, yaw: a.yaw, pitch: a.pitch, titanHold: 0, wantFire: i % 20 < 12 };
    f.step(1);
  }
  ok(gT.state === 'dead', `a titan primary kills a spectre (mount ${mount}${weapon ? `, ${weapon}` : ''})`);
  eq(lastKill(f, gT.id)?.killer, 'a1', 'titan weapon kill credited to the pilot');
  // Leg crush: a walking titan through a grunt.
  const gC = f.npc('grunt', 'bravo', v.x + 0.8, v.z - 6);
  for (let i = 0; i < ticks(3) && gC.state === 'alive'; i++) {
    a1.input = { ...(a1.input || {}), keys: {}, vehicleThrottle: 1, vehicleSteer: 0, yaw: v.yaw, pitch: 0, wantFire: false };
    f.step(1);
  }
  eq(gC.state, 'dead', 'a walking titan crushes a grunt');
  eq(lastKill(f, gC.id)?.w, TITAN_RULES.crush.key, 'crush key titan_crush');
  eq(lastKill(f, gC.id)?.killer, 'a1', 'crush credited to the pilot');
  // Parked titan: an ally grunt beside it is not crushed, a parked hull crushes no one.
  const ally = f.npc('grunt', 'alpha', v.x + 3.5, v.z);
  f.step(30, () => { a1.input = { ...(a1.input || {}), keys: {}, vehicleThrottle: 0, vehicleSteer: 0, yaw: v.yaw, pitch: 0 }; });
  eq(ally.state, 'alive', 'allies are never crushed');
  f.engine.stop();
}
{
  // Titanfall drop crush.
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, a2); park(f, b1); park(f, b2);
  const g = f.npc('grunt', 'bravo', 80.5, 72.5);
  place(a1, 80.5, 90.5);
  aimAt(a1, [80.5, G + 0.01, 72.5]);
  f.policy.setTitanMeter(a1, 1);
  const call = f.titans.call(a1, null);
  ok(call.ok, `drop called onto a grunt (${call.reason})`);
  f.step(DROP_TICKS + 4);
  eq(g.state, 'dead', 'a landing titan crushes the grunt under it');
  eq(lastKill(f, g.id)?.killer, 'a1', 'drop crush credited to the caller');
  ok(f.engine.combatants.get(g.id)?.tfNpc?.removeAt > 0 || !f.engine.npcs.has(g.id), 'crushed grunt handled as a minion death');
  f.engine.stop();
}
{
  // Auto-titan picks a minion.
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, a2); park(f, b1); park(f, b2);
  const v = landAt(f, a1, 70.5, 72.5);
  place(a1, 40, 88);
  const g = f.npc('grunt', 'bravo', v.x, v.z - 20);
  const key = f.titans.autoTarget(v, a1, f.engine.now);
  eq(key, `p:${g.id}`, 'auto-titan targets a visible enemy grunt');
  ok(f.titans.autoResolve(v, key)?.body === g, 'auto-titan resolves the grunt body');
  const kills0 = a1.kills | 0, minion0 = a1.tfMinionKills | 0;
  f.step(ticks(6));
  ok(g.state === 'dead', 'auto-titan kills the grunt');
  eq([a1.kills | 0, (a1.tfMinionKills | 0) - minion0], [kills0, 1], 'an auto-titan minion kill stays out of the owner\'s K/D and counts as a minion kill');
  // Owner dead: the stand-in attacker still never raises the owner's kills.
  f.engine.killPlayer(a1, null, 'world', false);
  const g2 = f.npc('grunt', 'bravo', v.x + 4, v.z - 18);
  const kills1 = a1.kills | 0;
  f.step(ticks(6));
  ok(g2.state === 'dead', 'auto-titan of a dead owner kills a grunt');
  eq(a1.kills | 0, kills1, 'stand-in minion kill leaves the dead owner\'s kills alone');
  // Hurt by the stand-in (no position of its own): the minion turns toward the hull, never NaN.
  const s = f.npc('spectre', 'bravo', v.x - 6, v.z - 30, { hold: false });
  s.takeDamage(20, false, f.titans.standInFor(v, a1));
  f.step(ticks(1.5));
  ok([s.yaw, s.pitch].every(Number.isFinite), `stand-in damage keeps the minion's aim finite (yaw ${s.yaw})`);
  ok(!s.tfNpc.aimPoint || s.tfNpc.aimPoint.every(Number.isFinite), 'stand-in damage leaves a finite aim point');
  ok(f.grunts.wire().every(row => row.every(Number.isFinite)), 'wire rows stay finite after stand-in damage');
  f.engine.stop();
}
{
  // Kills outside the live phase still leave pilot K/D alone.
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, a2); park(f, b1); park(f, b2);
  const g = f.npc('grunt', 'bravo', 60, 72);
  const kills0 = a1.kills | 0;
  f.policy._finishMatch('alpha');
  ok(f.policy.phase !== 'live', `match no longer live (${f.policy.phase})`);
  g.takeDamage(500, false, a1, 'rifle');
  f.engine.killPlayer(g, a1, 'rifle', false);
  eq(a1.kills | 0, kills0, 'a minion kill after the match ended does not raise pilot kills');
  f.engine.stop();
}

/* ================================================================ minions fight: hits on an exposed pilot, cloak */
{
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, a2); park(f, b2); park(f, b1);
  place(a1, 60, 64);
  const g = f.npc('grunt', 'bravo', 60, 84, { hold: false });
  let hit = null;
  for (let i = 0; i < ticks(8) && !hit; i++) {
    a1.input = { keys: {}, yaw: 0, pitch: 0, wantFire: false };
    a1.hp = 100;
    f.step(1);
    hit = f.kinds('hit').find(e => e.attacker === g.id && e.victim === 'a1') ?? null;
  }
  ok(hit, 'a grunt spots and hits an exposed pilot 20 m away');
  ok(hit && hit.dmg <= GRUNT_RULES.kinds.grunt.def.damage[0] * GRUNT_RULES.kinds.grunt.def.headMult + 0.01, `grunt hits are weak (${hit?.dmg})`);
  // Cloaked pilot beyond the reveal range is not acquired.
  const s = f.npc('spectre', 'bravo', 60, 90, { hold: false });
  g.tfNpc.hold = true;
  place(a1, 60, 64);
  a1.pilotTac = { ...(a1.pilotTac || {}), cloakUntil: f.engine.now + 60000 };
  a1.revealUntil = 0;
  const from = f.events.length;
  f.step(ticks(3), () => { a1.input = { keys: {}, yaw: 0, pitch: 0 }; a1.hp = 100; a1.pilotTac.cloakUntil = f.engine.now + 60000; a1.revealUntil = 0; });
  ok(!f.events.slice(from).some(e => e.kind === 'shoot' && e.id === s.id), 'a cloaked pilot 26 m away draws no minion fire');
  f.engine.stop();
}

/* ================================================================ waves, cap, reset */
{
  const f = arena();
  f.grunts.enabled = true;
  f.grunts.reset();
  f.step(ticks(GRUNT_RULES.firstWaveMs / 1000) + ticks(2));
  eq([f.grunts.alive('alpha'), f.grunts.alive('bravo')], [GRUNT_RULES.squadSize, GRUNT_RULES.squadSize], 'first wave: one squad of 4 per team');
  let max = { alpha: 0, bravo: 0 };
  for (let i = 0; i < 6; i++) {
    for (const team of ['alpha', 'bravo']) f.grunts.nextWave[team] = 0;
    f.step(2);
    for (const team of ['alpha', 'bravo']) max[team] = Math.max(max[team], f.grunts.alive(team));
  }
  eq([max.alpha, max.bravo], [GRUNT_RULES.capPerTeam, GRUNT_RULES.capPerTeam], 'waves fill to the cap of 12 per team and never past it');
  const kinds = new Set([...f.grunts.list()].map(p => p.npcRole));
  ok([...kinds].every(k => k === 'grunt' || k === 'spectre'), `squad kinds (${[...kinds].join(',')})`);
  f.policy.reset();
  eq(f.grunts.alive(), 0, 'a match reset clears every minion');
  f.engine.stop();
}

/* ================================================================ 16-bot frontier match at the cap: health and tick cost */
function frontierRun(withGrunts, seconds, seed) {
  Math.random = seeded(seed);
  const st = { nan: 0, shots: 0, hitsOnPilots: 0, minionDeaths: 0, water: 0, ticks: [], max: 0, bytes: 0, rowsMax: 0, start: null, mid: null };
  let engine = null;
  engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('frontier'), world: createMapState('frontier'),
    broadcast: s => {
      const rows = s.match?.titanfall?.npc ?? [];
      st.rowsMax = Math.max(st.rowsMax, rows.length);
      if (rows.length) st.bytes = Math.max(st.bytes, JSON.stringify(rows).length / rows.length);
      for (const e of s.events ?? []) {
        if (e.kind === 'shoot' && String(e.id).startsWith('tfg')) st.shots++;
        if (e.kind === 'hit' && String(e.attacker).startsWith('tfg') && !String(e.victim).startsWith('tfg')) st.hitsOnPilots++;
        if (e.kind === 'kill' && String(e.victim).startsWith('tfg')) { st.minionDeaths++; if (e.w === 'water') st.water++; }
      }
    } });
  try {
    attachBots(engine, 16, { personalitySeed: seed });
    const g = engine.mode.policy.grunts;
    g.enabled = withGrunts;
    if (withGrunts) for (let i = 0; i < 3; i++) for (const team of ['alpha', 'bravo']) g.spawnSquad(team);
    const lanes = withGrunts ? g._layout() : null;
    const midDist = () => {
      const list = [...g.list()].filter(p => p.state === 'alive');
      return list.length ? list.reduce((a, p) => a + Math.hypot(p.x - lanes.mid.x, p.z - lanes.mid.z), 0) / list.length : 0;
    };
    if (withGrunts) st.start = midDist();
    for (let i = 0; i < seconds * TICKS_PER_S; i++) {
      const a = performance.now();
      engine.step(TICK_MS);
      const d = performance.now() - a;
      if (i > 30) { st.ticks.push(d); st.max = Math.max(st.max, d); }
      for (const p of engine.combatants.values()) if (![p.x, p.y, p.z].every(Number.isFinite)) st.nan++;
      if (withGrunts && i === ticks(Math.min(25, seconds - 2))) st.mid = midDist();
    }
    st.errors = g.errors;
    st.lastError = g.lastError;
    st.stats = { ...g.stats };
    st.avg = st.ticks.reduce((a, b) => a + b, 0) / st.ticks.length;
    st.sorted = [...st.ticks].sort((a, b) => a - b);
    st.p95 = st.sorted[Math.floor(st.sorted.length * 0.95)];
    return st;
  } finally {
    engine.stop();
  }
}
{
  const SECONDS = Math.max(20, Number(process.env.TITANFALL_GRUNT_SIM_SECONDS) || 45);
  const off = frontierRun(false, SECONDS, 0x51);
  const on = frontierRun(true, SECONDS, 0x51);
  notes.push(`frontier 16 bots ${SECONDS} s: tick avg ${off.avg.toFixed(3)} ms → ${on.avg.toFixed(3)} ms with grunts (p95 ${off.p95.toFixed(2)} → ${on.p95.toFixed(2)}, max ${on.max.toFixed(1)}); `
    + `minions spawned ${on.stats.spawned}, deaths ${on.minionDeaths} (water ${on.water}), crushed ${on.stats.crushed}, removed ${on.stats.removed}; `
    + `minion shots ${on.shots}, hits on pilots ${on.hitsOnPilots}; npc row ${on.bytes.toFixed(1)} B avg, ${on.rowsMax} rows max; `
    + `mean distance to midfield ${on.start?.toFixed(1)} m → ${on.mid?.toFixed(1)} m after ${Math.min(25, SECONDS - 2)} s`);
  eq(on.errors, 0, `no errors in the minion tick${on.lastError ? `: ${on.lastError.stack}` : ''}`);
  eq(on.nan, 0, 'no NaN positions');
  ok(on.rowsMax <= GRUNT_RULES.capPerTeam * 2, `never more than ${GRUNT_RULES.capPerTeam * 2} npc rows (${on.rowsMax})`);
  ok(on.bytes <= 40, `npc row ≤ 40 B on the wire (${on.bytes.toFixed(1)} B)`);
  ok(on.mid < on.start - 15, `minions advance on the midfield (${on.start.toFixed(1)} → ${on.mid.toFixed(1)} m)`);
  ok(on.stats.removed <= Math.max(2, on.stats.spawned * 0.15), `few watchdog removals (${on.stats.removed} of ${on.stats.spawned})`);
  ok(on.water <= Math.max(1, on.minionDeaths * 0.2), `few minions drown (${on.water} of ${on.minionDeaths})`);
  ok(on.shots > 0, `minions fight (${on.shots} shots)`);
  // Budget: 24 minions add well under a millisecond per tick here (60 Hz tick = 16.7 ms).
  ok(on.avg - off.avg < 1.5, `minion tick overhead ${(on.avg - off.avg).toFixed(3)} ms < 1.5 ms`);
  ok(on.p95 < 8, `p95 tick with 16 bots + 24 minions ${on.p95.toFixed(2)} ms < 8 ms`);
}

/* ================================================================ canyon / harbor waves: squads leave their drop point */
function wavesRun(map, seconds, seed) {
  Math.random = seeded(seed);
  const st = { pilotKills: new Map(), nan: 0 };
  const engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta(map), world: createMapState(map),
    broadcast: s => {
      for (const e of s.events ?? []) {
        if (e.kind === 'kill' && e.killer && e.killer !== e.victim && !String(e.victim).startsWith('tfg') && !String(e.killer).startsWith('tfg'))
          st.pilotKills.set(e.killer, (st.pilotKills.get(e.killer) ?? 0) + 1);
      }
    } });
  try {
    attachBots(engine, 6, { personalitySeed: seed });
    const g = engine.mode.policy.grunts;
    for (let i = 0; i < seconds * TICKS_PER_S; i++) {
      engine.step(TICK_MS);
      if (i % 30 === 0) for (const p of g.list()) if (p.state === 'alive' && ![p.x, p.y, p.z, p.yaw, p.pitch].every(Number.isFinite)) st.nan++;
    }
    st.stats = { ...g.stats };
    st.errors = g.errors;
    st.lastError = g.lastError;
    st.kd = [...engine.entities.values()].filter(p => (p.kills | 0) !== (st.pilotKills.get(p.id) ?? 0)).map(p => `${p.id}:${p.kills}/${st.pilotKills.get(p.id) ?? 0}`);
    return st;
  } finally {
    engine.stop();
  }
}
for (const map of ['canyon', 'harbor']) {
  const SECONDS = Math.max(40, Number(process.env.TITANFALL_GRUNT_WAVE_SECONDS) || 90);
  const run = wavesRun(map, SECONDS, 0x2b);
  notes.push(`${map} 6 bots ${SECONDS} s: minions spawned ${run.stats.spawned}, killed ${run.stats.killed}, removed by the watchdog ${run.stats.removed}`);
  eq(run.errors, 0, `${map}: no errors in the minion tick${run.lastError ? `: ${run.lastError.stack}` : ''}`);
  eq(run.nan, 0, `${map}: no non-finite minion pose`);
  ok(run.stats.spawned >= 16, `${map}: waves spawn (${run.stats.spawned})`);
  ok(run.stats.removed <= Math.max(2, run.stats.spawned * 0.1), `${map}: squads route off their drop point (${run.stats.removed} of ${run.stats.spawned} removed)`);
  eq(run.kd, [], `${map}: pilot kills equal pilot-on-pilot kill events (minion kills stay apart)`);
}

/* ================================================================ other modes: untouched */
{
  for (const [mode, map] of [['tdm', 'harbor'], ['conquest', 'frontier']]) {
    const engine = new GameEngine({ mode, mapMeta: getMapMeta(map), world: createMapState(map), broadcast: () => {} });
    try {
      attachBots(engine, 4, { personalitySeed: 9 });
      for (let i = 0; i < ticks(GRUNT_RULES.firstWaveMs / 1000 + 2); i++) engine.step(TICK_MS);
      eq(engine.mode.policy.grunts, undefined, `${mode}: no grunt system`);
      eq(engine.npcs.size, 0, `${mode}: engine.npcs stays empty`);
    } finally { engine.stop(); }
  }
  // Bastion keeps its NPC player rows (the minion filter is titanfall-only).
  let last = null;
  const engine = new GameEngine({ mode: 'bastion', mapMeta: getMapMeta('reactor'), broadcast: s => { last = s; } });
  try {
    engine.addClient('h1', 'H1');
    for (let at = 0; at < 120000 && engine.npcs.size === 0; at += 50) engine.step(50);
    engine.step(TICK_MS);
    ok(engine.npcs.size > 0, `bastion spawned NPCs (${engine.npcs.size})`);
    eq(last.players.filter(r => r.npcRole).length, [...engine.npcs.values()].length, 'bastion NPCs still ship as player rows');
    eq(engine.mode.policy.grunts, undefined, 'bastion: no grunt system');
  } finally { engine.stop(); }
}

Math.random = realRandom;
console.log(notes.map(line => `  ${line}`).join('\n'));
console.log(`Titanfall grunts: ${checks} checks passed (bodies, scoring 1/2 + meter + feed, wire rows, killable by pilot fire/titan primary/blast/leg crush/drop crush, auto-titan target and K/D, stand-in hurt aim, minion fire and cloak, waves and cap, reset, 16-bot frontier health and tick cost, canyon/harbor squads routing off their drop point, other modes untouched).`);
