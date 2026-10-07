// Global Conquest action gate (spec §9): a headless Frontier match with 16 bots
// (GameEngine + attachBots, no sockets, no browser) must produce constant,
// readable Battlefield pressure. Every position is read from mapMeta; every
// number comes from authoritative events, entities and the mode's ledger.
//
//   node tools/conquest-action-test.mjs                 # P0 fixture + 180 s gate (normal bots)
//   node tools/conquest-action-test.mjs --seconds 90 --report out.json --no-gate
//   node tools/conquest-action-test.mjs --difficulty easy --trace --dump-stuck   # diagnostics
//
// Run it through .conquest-work/heavy.sh on a shared machine: ~10 800 ticks.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { CONQUEST_RULES } from '../shared/conquest-contract.js';
import { raycastVoxels } from '../shared/raycast.js';
import { mulberry32 } from '../shared/noise.js';
import { FLUID_BLOCKS } from '../shared/world/blocks.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const SECONDS = Number(option('seconds', 180));
const BOTS = Number(option('bots', 16));
const REPORT = option('report', null);
const GATE = !args.includes('--no-gate');
// Deterministic by default: Math.random (spread, spawn picks) is seeded and the
// engine clock starts at a fixed epoch, so a run is reproducible bit for bit
// and a behaviour regression shows up as a changed report. --seed n explores.
const SEED = Number(option('seed', 1));
const EPOCH = 1_800_000_000_000;
Math.random = mulberry32(SEED);
/** Build an engine whose clock starts at the fixed epoch (GameEngine reads Date.now once). */
const atEpoch = build => { const real = Date.now; Date.now = () => EPOCH; try { return build(); } finally { Date.now = real; } };
const SKIP_P0 = args.includes('--skip-p0');
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const median = list => { if (!list.length) return NaN; const s = list.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const quantile = (list, q) => { if (!list.length) return NaN; const s = list.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

const meta = getMapMeta('frontier');
assert.equal(meta.conquest?.version, 2, 'Frontier v2 metadata (mapMeta.conquest.version 2)');
const world = createMapState('frontier');

// ---------------------------------------------------------------------------
// P0 fixture: a bot standing in a capture zone fires at a visible enemy and
// keeps counting for the flag (bots.js no longer freezes the trigger while it
// captures).
// ---------------------------------------------------------------------------
if (!SKIP_P0) {
  const events = [];
  const game = atEpoch(() => new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: snap => events.push(...snap.events) }));
  // Infantry only: with no hulls the single bot is never assigned a crew seat.
  game.vehicles.vehicles.clear();
  const bots = attachBots(game, 1);
  const bot = game.entities.get(bots.brains[0].id);
  game.addClient('p0-target', 'TARGET');
  const target = game.entities.get('p0-target');
  const policy = game.mode.policy;
  policy.setLobbyTeam?.(bot, 'alpha');
  policy.setLobbyTeam?.(target, 'bravo');
  const flagC = meta.conquest.flags.find(f => f.id === 'C');
  // Bot on a spawn cell inside the zone, the enemy on another of the flag's
  // spawn cells 12-35 m away with a clear eye-to-chest line.
  // The enemy stands toward the nearest bravo flag: the axis a holding bot watches.
  const enemyFlag = meta.conquest.flags.filter(f => f.home === 'bravo').sort((a, b) => flat(a, flagC) - flat(b, flagC))[0];
  const axis = Math.atan2(-(enemyFlag.x - flagC.x), -(enemyFlag.z - flagC.z));
  const off = (a, b) => Math.abs(Math.atan2(Math.sin(Math.atan2(-(b.x - a.x), -(b.z - a.z)) - axis), Math.cos(Math.atan2(-(b.x - a.x), -(b.z - a.z)) - axis)));
  const inside = flagC.spawns.filter(s => flat(s, flagC) <= flagC.radius - 2);
  let pair = null;
  for (const a of inside) for (const b of flagC.spawns) {
    const d = flat(a, b);
    if (a === b || d < 12 || d > 35) continue;
    const dir = [b.x - a.x, b.y + 1.1 - (a.y + 1.6), b.z - a.z], len = Math.hypot(...dir);
    if (raycastVoxels(game.solidAt, a.x, a.y + 1.6, a.z, dir[0] / len, dir[1] / len, dir[2] / len, len)) continue;
    if (!pair || off(a, b) < off(pair[0], pair[1])) pair = [a, b];
  }
  assert(pair, 'P0: flag C offers a spawn pair with a clear line of sight');
  const [spot, far] = pair;
  for (let i = 0; i < 3; i++) game.step(TICK_MS);
  Object.assign(bot, { x: spot.x, y: spot.y, z: spot.z, vx: 0, vy: 0, vz: 0, spawnProtectedUntil: 0 });
  Object.assign(target, { x: far.x, y: far.y, z: far.z, vx: 0, vy: 0, vz: 0, spawnProtectedUntil: 0, hp: 100000 });
  bot.yaw = Math.atan2(-(far.x - bot.x), -(far.z - bot.z));
  let inZoneTicks = 0, ticks = 0;
  for (let t = 0; t < 6000; t += TICK_MS) {
    target.hp = Math.max(target.hp, 1000);
    game.step(TICK_MS);
    ticks++;
    if (bot.state === 'alive' && flat(bot, flagC) <= flagC.radius) inZoneTicks++;
    if (args.includes('--debug') && ticks % 15 === 0) {
      const br = bots.brains[0];
      console.log(`P0 t=${(ticks * TICK_MS / 1000).toFixed(2)} bot=(${bot.x.toFixed(1)},${bot.y.toFixed(1)},${bot.z.toFixed(1)}) yaw=${bot.yaw.toFixed(2)} state=${br.state} enemy=${br.enemyId} notice=${br.noticeProgress.toFixed(2)} goal=${br.goalKind} target=(${target.x.toFixed(1)},${target.z.toFixed(1)}) ${target.state}`);
    }
  }
  const shots = events.filter(e => e.kind === 'shoot' && e.id === bot.id).length;
  assert(shots > 0, `P0: a bot inside capture zone C fires at a visible enemy (shots ${shots})`);
  assert(inZoneTicks / ticks > 0.8, `P0: the bot keeps holding the zone while it fights (${(inZoneTicks / ticks).toFixed(2)})`);
  console.log(`P0 fixture: ${shots} shots from inside zone C, in-zone ${(100 * inZoneTicks / ticks).toFixed(0)} %`);
  bots.dispose();
  game.stop?.();
}

// ---------------------------------------------------------------------------
// Full match (re-seeded, so it does not depend on whether the P0 fixture ran).
// ---------------------------------------------------------------------------
Math.random = mulberry32(SEED);
const events = [];
let snapshotBytes = 0, snapshotSamples = 0, tickIndex = 0;
const game = atEpoch(() => new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: snap => {
  for (const e of snap.events ?? []) events.push({ ...e, at: game.now });
  if (tickIndex % 10 === 0) { snapshotBytes += JSON.stringify(snap).length; snapshotSamples++; }
} }));
const startedAt = game.now;
// The gate runs the 'normal' profile, the middle of the three lobby choices
// (the lobby's own default for a fresh bot slot is 'easy'); --difficulty
// easy|normal|hard runs the same gate at another profile.
const DIFFICULTY = option('difficulty', 'normal');
const bots = attachBots(game, BOTS, { difficulties: new Map(Array.from({ length: BOTS }, (_, i) => [`bot-${i}`, DIFFICULTY])) });
const policy = game.mode.policy;
// Bot CPU: time spent inside the BotManager tick hook (commander, crews, brains).
const botTickMs = [];
{
  const tick = bots.tick.bind(bots);
  bots.tick = dtMs => { const t0 = performance.now(); tick(dtMs); botTickMs.push(performance.now() - t0); };
}
const teamOf = p => game.mode.teamFor?.(p) ?? p.team;
const tickMs = [];
const sampleEvery = Math.round(1000 / TICK_MS);
let aliveSamples = 0, seatedSamples = 0, footSamples = 0, stuckSamples = 0;
const stuckAt = {};
const seatedBefore = new Map();
const footVictims = [];
const seatedBy = {}, goalKinds = {}, footEnemyDistances = [], environmentDeaths = [];
let fightSamples = 0, infantryHits = 0, infantryDamage = 0;
const shotRanges = [];
const footEnemyDistance = p => { let d = Infinity; for (const o of game.entities.values()) if (o.state === 'alive' && o !== p && teamOf(o) !== teamOf(p)) d = Math.min(d, Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z)); return d; };
const history = new Map();
const respawnDistances = [];
const respawnKinds = { hq: 0, forward: 0 };
const hqs = meta.conquest.bases;
const totalTicks = Math.round(SECONDS * 1000 / TICK_MS);
const wall = performance.now();
let seenEvents = 0;
for (tickIndex = 0; tickIndex < totalTicks; tickIndex++) {
  for (const p of game.entities.values()) seatedBefore.set(p.id, p.state === 'alive' && !!p.vehicleId);
  const t0 = performance.now();
  game.step(TICK_MS);
  tickMs.push(performance.now() - t0);
  // Respawn-to-enemy distance from the authoritative respawn events.
  for (; seenEvents < events.length; seenEvents++) {
    const e = events[seenEvents];
    if (e.kind === 'kill' && game.entities.has(e.killer) && e.killer !== e.victim && seatedBefore.get(e.victim) === false
      && teamOf(game.entities.get(e.killer)) !== teamOf(game.entities.get(e.victim))) footVictims.push(e);
    if (e.kind === 'kill' && (e.w === 'water' || e.w === 'world' || e.w === 'fall')) {
      const v = game.entities.get(e.victim);
      if (v) environmentDeaths.push({ id: e.victim, w: e.w, x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z), t: Math.round((game.now - startedAt) / 1000) });
    }
    if (e.kind === 'hit' && e.attacker) {
      const a = game.entities.get(e.attacker);
      if (a && !a.vehicleId) { infantryHits++; infantryDamage += e.dmg || 0; }
    }
    if (e.kind === 'shoot' && !e.vehicleWeapon) {
      const a = game.entities.get(e.id), d = a ? footEnemyDistance(a) : NaN;
      if (Number.isFinite(d)) shotRanges.push(d);
    }
    if (e.kind !== 'respawn') continue;
    const p = game.entities.get(e.id);
    if (!p) continue;
    const team = teamOf(p);
    let nearest = Infinity;
    for (const o of game.entities.values()) {
      if (o.state !== 'alive' || o === p || teamOf(o) === team || o.npcRole) continue;
      nearest = Math.min(nearest, flat(o, e));
    }
    if (Number.isFinite(nearest)) respawnDistances.push(nearest);
    const base = hqs[team];
    if (base && flat(e, base) <= (base.radius ?? 56)) respawnKinds.hq++; else respawnKinds.forward++;
  }
  if (tickIndex % sampleEvery) continue;
  if (args.includes('--trace') && (tickIndex / sampleEvery) % 10 === 0) {
    const view = policy.conquestView();
    const line = view.flags.map(f => `${f.id}:${(f.owner ?? '-')[0]}${f.state[0]}${f.atk}/${f.def}`).join(' ');
    const where = bots.brains.map(br => {
      const p = game.entities.get(br.id);
      if (!p || p.state !== 'alive') return 'x';
      if (p.vehicleId) return 'v';
      const g = game.mode.botGoal(p);
      return `${(teamOf(p) ?? '?')[0]}${(g.role ?? g.stance)?.[0] ?? g.kind[0]}${br.state[0]}${Math.round(flat(p, g.point ?? g.target ?? p))}`;
    }).join(' ');
    console.log(`t=${Math.round(tickIndex * TICK_MS / 1000)} ${line} tickets ${view.tickets.alpha}/${view.tickets.bravo} kills ${events.filter(e => e.kind === 'kill').length} | ${where}`);
  }
  for (const br of bots.brains) {
    const p = game.entities.get(br.id);
    if (!p || p.state !== 'alive') { history.delete(br.id); continue; }
    aliveSamples++;
    if (p.vehicleId) {
      seatedSamples++; history.delete(br.id);
      const hull = game.vehicles.vehicles.get(p.vehicleId);
      const key = `${hull?.type ?? '?'}:${p.vehicleSeatId ?? '?'}`;
      seatedBy[key] = (seatedBy[key] ?? 0) + 1;
      continue;
    }
    footSamples++;
    if (br.state === 'fight') fightSamples++;
    let nearestEnemy = Infinity;
    for (const o of game.entities.values()) if (o.state === 'alive' && teamOf(o) !== teamOf(p)) nearestEnemy = Math.min(nearestEnemy, flat(o, p));
    footEnemyDistances.push(nearestEnemy);
    goalKinds[br.goalKind ?? '?'] = (goalKinds[br.goalKind ?? '?'] ?? 0) + 1;
    const list = history.get(br.id) ?? [];
    list.push({ x: p.x, z: p.z, moving: !!br.intendsMove });
    if (list.length > 3) list.shift();
    history.set(br.id, list);
    // Wedged: it wanted to move for two seconds and stayed within half a metre.
    if (list.length === 3 && list.every(s => s.moving) && flat(list[0], list[2]) < 0.5) {
      stuckSamples++;
      const key = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} ${br.goalKind}/${br.motion}`;
      stuckAt[key] = (stuckAt[key] ?? 0) + 1;
    }
  }
}
const wallMs = performance.now() - wall;

const at = e => (e.at - startedAt) / 1000;
const kills = events.filter(e => e.kind === 'kill');
// Infantry kills: enemy kills of soldiers on foot (not crew dying in a seat or
// with a hull); kills made with infantry weapons are reported alongside.
const infantryKills = footVictims;
const infantryWeaponKills = kills.filter(e => WEAPON_IDS.includes(e.w));
const captures = events.filter(e => e.kind === 'flag_captured');
const transitions = events.filter(e => e.kind === 'flag_captured' || e.kind === 'flag_neutralized');
const vehicleShots = events.filter(e => e.kind === 'shoot' && e.vehicleWeapon);
const vehicleWeaponKeys = [...new Set(vehicleShots.map(e => e.vehicleWeapon))];
const vehicleHits = events.filter(e => e.kind === 'vehicle_hit');
const destroyed = events.filter(e => e.kind === 'vehicle_destroyed');
const tickets = policy.conquestView?.().tickets ?? policy.tickets ?? {};
const maxTickets = CONQUEST_RULES.tickets;
const ticketLoss = Math.max(maxTickets - (tickets.alpha ?? maxTickets), maxTickets - (tickets.bravo ?? maxTickets));
const report = {
  seconds: SECONDS, bots: BOTS, difficulty: DIFFICULTY, seed: SEED, wallMs: Math.round(wallMs),
  firstKillS: kills.length ? +at(kills[0]).toFixed(1) : null,
  firstCaptureS: captures.length ? +at(captures[0]).toFixed(1) : null,
  kills: kills.length, infantryKills: infantryKills.length, infantryWeaponKills: infantryWeaponKills.length,
  vehicleShots: vehicleShots.length, vehicleWeaponKeys,
  vehicleHits: vehicleHits.length, vehiclesDestroyed: destroyed.length,
  flagTransitions: transitions.length,
  flags: (policy.conquestView?.().flags ?? []).map(f => `${f.id}:${f.owner ?? '-'}`).join(' '),
  respawns: respawnDistances.length, respawnKinds,
  medianRespawnEnemyM: +median(respawnDistances).toFixed(1),
  seatedFraction: +(seatedSamples / Math.max(1, aliveSamples)).toFixed(3),
  stuckFraction: +(stuckSamples / Math.max(1, footSamples)).toFixed(3),
  tickets, ticketLoss,
  botMsPerTick: +(botTickMs.reduce((a, b) => a + b, 0) / Math.max(1, botTickMs.length)).toFixed(3),
  botP95Ms: +quantile(botTickMs, 0.95).toFixed(2),
  tickP50Ms: +quantile(tickMs, 0.5).toFixed(2), tickP95Ms: +quantile(tickMs, 0.95).toFixed(2),
  tickMaxMs: +Math.max(...tickMs).toFixed(1),
  avgSnapshotKB: +(snapshotBytes / Math.max(1, snapshotSamples) / 1024).toFixed(1),
  killsByWeapon: kills.reduce((m, e) => (m[e.w] = (m[e.w] ?? 0) + 1, m), {}),
  infantryShots: events.filter(e => e.kind === 'shoot' && !e.vehicleWeapon).length,
  infantryHits, infantryDamage: Math.round(infantryDamage), medianShotRangeM: +median(shotRanges).toFixed(1),
  stuckAt: Object.fromEntries(Object.entries(stuckAt).sort((a, b) => b[1] - a[1]).slice(0, 12)),
  seatedBy, goalKinds, environmentDeaths,
  footFightFraction: +(fightSamples / Math.max(1, footSamples)).toFixed(3),
  footMedianEnemyM: +median(footEnemyDistances).toFixed(1),
  events: Object.fromEntries(['spot', 'revive', 'vehicle_repaired', 'vehicle_disabled', 'countermeasure', 'deploy_refused', 'score']
    .map(kind => [kind, events.filter(e => e.kind === kind).length])),
};
console.log(JSON.stringify(report, null, 2));
if (args.includes('--dump-stuck')) {
  // Voxel columns around the worst stuck spot (diagnostics for navigation work).
  const top = Object.keys(stuckAt).sort((a, b) => stuckAt[b] - stuckAt[a])[0];
  if (top) {
    const [x0, y0, z0] = top.split(' ')[0].split(',').map(Number);
    console.log(`stuck spot ${top}: columns y${y0 - 5}..y${y0 + 8} ('#' solid, '~' water)`);
    for (let z = z0 - 3; z <= z0 + 3; z++) {
      let line = `z${z} `;
      for (let x = x0 - 3; x <= x0 + 3; x++) {
        let col = '';
        for (let y = y0 - 5; y <= y0 + 8; y++) { const b = game.world.getBlock(x, y, z); col += b === 0 ? '.' : FLUID_BLOCKS.has(b) ? '~' : '#'; }
        line += `${x}:${col} `;
      }
      console.log(line);
    }
    for (const v of game.vehicles.vehicles.values()) if (Math.hypot(v.x - x0, v.z - z0) < 12) console.log(`hull near: ${v.id} ${v.type} hp ${Math.round(v.hp)} at ${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`);
    const stuckBot = bots.brains.find(br => { const p = game.entities.get(br.id); return p && Math.round(p.x) === x0 && Math.round(p.z) === z0; });
    if (stuckBot) console.log('bot there now:', stuckBot.id, JSON.stringify(stuckBot.surfaceRoute?.points?.slice(0, 4)));
  }
}
if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 2));
bots.dispose();
game.stop?.();

if (GATE) {
  const failures = [];
  const gate = (ok, text) => { if (!ok) failures.push(text); };
  gate(report.firstKillS !== null && report.firstKillS <= 35, `first kill <= 35 s (${report.firstKillS})`);
  gate(report.firstCaptureS !== null && report.firstCaptureS <= 60, `first flag_captured <= 60 s (${report.firstCaptureS})`);
  gate(report.infantryKills >= 25, `infantry kills >= 25 (${report.infantryKills})`);
  gate(report.vehicleShots >= 40 && vehicleWeaponKeys.length >= 4, `vehicle-weapon shoot >= 40 across >= 4 keys (${report.vehicleShots}, ${vehicleWeaponKeys.join(',')})`);
  gate(report.vehicleHits >= 10, `vehicle_hit >= 10 (${report.vehicleHits})`);
  gate(report.vehiclesDestroyed >= 1, `vehicle_destroyed >= 1 (${report.vehiclesDestroyed})`);
  gate(report.flagTransitions >= 3, `>= 3 flag transitions (${report.flagTransitions})`);
  gate(report.medianRespawnEnemyM <= 170, `median respawn-to-enemy <= 170 m (${report.medianRespawnEnemyM})`);
  gate(report.seatedFraction >= 0.15 && report.seatedFraction <= 0.4, `seated time 15-40 % (${report.seatedFraction})`);
  gate(report.stuckFraction < 0.05, `stuck < 5 % (${report.stuckFraction})`);
  gate(report.ticketLoss >= 40, `one team down >= 40 tickets (${report.ticketLoss})`);
  gate(report.tickP95Ms <= 10, `tick p95 <= 10 ms (${report.tickP95Ms})`);
  gate(report.botMsPerTick <= 1.2, `bot CPU <= 1.2 ms/tick at ${BOTS} bots (${report.botMsPerTick})`);
  gate(report.avgSnapshotKB <= 27, `average snapshot <= 27 KB (${report.avgSnapshotKB})`);
  if (failures.length) {
    console.error(`conquest action gate: ${failures.length} failed\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  console.log('conquest action gate: all §9 gates passed');
}
