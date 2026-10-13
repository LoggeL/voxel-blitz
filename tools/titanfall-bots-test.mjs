// Titanfall bots (docs/titanfall.md §9, §11.1; WP7). Seeded, headless 8v8 bot
// matches on harbor, canyon, frontier and ashfall through the real engine and BotManager:
//  - titans get called (≥ 2 drops), embarked, fight (titan weapons deal damage),
//    get doomed, and pilots eject;
//  - pilots deal AT damage to titans;
//  - no exceptions in the bot tick, no NaN positions, no bot stalled > 20 s;
//  - no piloted titan boxed in: one with no target for 30 s that stays within
//    4 m of where the window started (back-and-forth inside it included);
//  - frontier: no `restricted` (out-of-bounds) deaths and no bot or titan
//    outside botBounds() (a pilot that respawned there in the last 3 s, the
//    out-of-bounds timer, is counted apart: the spawn expansion can place a
//    point just past the edge, and the bot walks back in);
//  - the score climbs and the match ends (score limit or time) with a result;
//  - across the runs at least half the piloted titans that get doomed
//    are ejected from (§9: 0.7-0.9 at doom start); a doom that ends before the
//    slowest bot eject reaction (an execution, or a hull doomed mid-embark,
//    which the doom guard does not cover) gives no chance to eject and is not
//    counted;
//  - attrition minions (§10, on as in every match): bots kill minions, pilots
//    and titans both (minion kills by bots are counted per run);
//  - rodeo (scripted, per map): a normal bot that chose to rodeo a parked
//    enemy titan 12-16 m off mounts it within 10 s, from behind it and from
//    in front of it (the run goes round the hull); in the matches mounts are
//    too rare for a per-seed assertion (~0.6 per short run) and are printed;
//  - ashfall rodeo perches (§14): a bot sent to a perch walks up its stair and,
//    once on the deck, leaps onto an enemy titan parked on the ring road below;
//    in the match at least one bot stands on a perch deck;
//  - ashfall battery caches (§14): a quiet bot near a stocked cache, with a
//    friendly titan short of shield, fetches the cached battery and inserts it;
//  - a drop point needs a way out: harbor's roofed gantry cells (a hull fits
//    down through the 6-8 m gap and never gets out) are refused.
// TITANFALL_BOT_SIM_SECONDS sets the harbor run (default 90; 180 in
// titanfall:bots:long); canyon, frontier and ashfall run 3/4 of it. Every pilot starts
// with a seeded part of a titan meter so titans drop inside a short run (the
// passive fill alone takes ~110 s). TITANFALL_BOT_SEED shifts every run's seed
// (default 0) to sample other matches.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { getMapMeta, createMapState } from '../shared/world/templates.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { attachBots } from '../server/bots.js';
import { isTitanType } from '../shared/titan-contract.js';
import { TitanfallBots } from '../server/bot-titanfall.js';
import { placeWalker } from '../shared/vehicle-handling/titan.js';

const SECONDS = Math.max(30, Number(process.env.TITANFALL_BOT_SIM_SECONDS) || 90);
const TICKS_PER_S = Math.round(1000 / TICK_MS);
const STALL_MS = 20000;
const TITAN_STUCK_MS = 30000, TITAN_STUCK_M = 4;
const SPAWN_GRACE_MS = 3000;
const AT_WEAPONS = new Set(['chargerifle', 'archer', 'thunderbolt', 'mgl', 'kraber']);
// Slowest bot eject reaction (bot-titanfall.js EJECT_REACTION_MS.easy + EJECT_REACTION_JITTER_MS).
const EJECT_REACTION_MAX_MS = 1300;
const SEED_OFFSET = Math.trunc(Number(process.env.TITANFALL_BOT_SEED) || 0);

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log(`  ok ${msg}`); };

function seeded(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const realRandom = Math.random, realNow = Date.now;

/** One seeded 8v8 bot match; returns the counters the assertions read. */
function runMatch(map, seconds, seed) {
  Math.random = seeded(seed);
  let clock = 1_700_000_000_000;
  Date.now = () => clock;
  const stats = { drops: 0, refused: 0, embarks: 0, dooms: 0, pilotedDooms: 0, ejects: 0, destroyed: 0, rodeoMounts: 0, rips: 0, inserts: 0,
    abilities: {}, kills: {}, restricted: 0, pilotAtDamage: 0, pilotAtHits: 0, titanDamage: 0, titanKillsOfPilots: 0,
    nan: 0, outside: 0, spawnOutside: 0, stalls: [], titanStuck: [], errors: [], scores: null, phase: null, winner: undefined,
    ejectChances: 0, shortDooms: 0, minionDeaths: 0, minionKillsPilot: 0, minionKillsTitan: 0, perchers: new Set() };
  let engine = null;
  const respawnAt = new Map();
  // Piloted dooms: vehicleId -> doom start. Ended by an eject (a chance taken) or the hull's end.
  const doomAt = new Map();
  const doomEnded = (vehicleId, ejected) => {
    const at = doomAt.get(vehicleId);
    if (at === undefined) return;
    doomAt.delete(vehicleId);
    if (ejected || (engine?.now ?? at) - at >= EJECT_REACTION_MAX_MS) stats.ejectChances++;
    else stats.shortDooms++;
  };
  const onEvent = e => {
    switch (e.kind) {
      case 'respawn': respawnAt.set(String(e.id), engine?.now ?? 0); break;
      case 'titanfall_drop': stats.drops++; break;
      case 'titanfall_refused': stats.refused++; break;
      case 'titan_embark': stats.embarks++; break;
      case 'titan_doomed': {
        stats.dooms++;
        for (const p of engine?.entities.values() ?? []) if (p.vehicleId === e.vehicleId) { stats.pilotedDooms++; doomAt.set(e.vehicleId, engine.now); break; }
        break;
      }
      case 'titan_eject': stats.ejects++; doomEnded(e.vehicleId, true); break;
      case 'rodeo_mount': stats.rodeoMounts++; break;
      case 'rodeo_rip': stats.rips++; break;
      case 'rodeo_insert': stats.inserts++; break;
      case 'titan_ability': stats.abilities[e.ability] = (stats.abilities[e.ability] ?? 0) + 1; break;
      case 'vehicle_destroyed': if (isTitanType(e.vehicleType)) { stats.destroyed++; doomEnded(e.vehicleId, false); } break;
      case 'kill': {
        stats.kills[e.w] = (stats.kills[e.w] ?? 0) + 1;
        if (e.w === 'restricted') stats.restricted++;
        if (engine?.npcs.get(String(e.victim))?.tfNpc) {
          stats.minionDeaths++;
          const killer = engine.entities.get(String(e.killer));
          if (killer?.vehicleId) stats.minionKillsTitan++;
          else if (killer) stats.minionKillsPilot++;
        }
        break;
      }
      case 'vehicle_hit': {
        const attacker = engine?.entities.get(String(e.attacker));
        const hull = engine?.vehicles.vehicles.get(e.vehicleId);
        if (!attacker || !hull || !isTitanType(hull.type)) break;
        if (attacker.vehicleId) stats.titanDamage += e.dmg;
        else if (AT_WEAPONS.has(attacker.def?.id) || e.cls === 'at' || e.cls === 'rodeo') { stats.pilotAtDamage += e.dmg; stats.pilotAtHits++; }
        break;
      }
      default: break;
    }
  };
  engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta(map), world: createMapState(map),
    broadcast: s => { for (const e of s.events ?? []) onEvent(e); } });
  try {
    // Normal and hard bots rodeo; easy ones never do (§9).
    const difficulties = new Map(Array.from({ length: 16 }, (_, i) => [`bot-${i}`, ['easy', 'normal', 'hard', 'normal'][i % 4]]));
    const manager = attachBots(engine, 16, { personalitySeed: seed, difficulties });
    const tick = manager.tick.bind(manager);
    manager.tick = dt => { try { tick(dt); } catch (error) { stats.errors.push(error); } };
    const policy = engine.mode.policy, bounds = policy.botBounds();
    const rng = seeded(seed ^ 0x51ed);
    for (const p of engine.entities.values()) policy.setTitanMeter(p, 0.35 + rng() * 0.45);
    // The time limit lands inside the run, so the match ends with a result either way.
    policy.endsAt = engine.now + (seconds - 2) * 1000;
    const watch = new Map(), titanWatch = new Map();
    const brains = new Map(manager.brains.map(br => [br.id, br]));
    for (let i = 0; i < seconds * TICKS_PER_S; i++) {
      engine.step(TICK_MS);
      clock += TICK_MS;
      if (policy.phase !== 'live') break;
      for (const p of engine.entities.values()) {
        if (![p.x, p.y, p.z].every(Number.isFinite)) stats.nan++;
      }
      for (const v of engine.vehicles.vehicles.values()) {
        if (![v.x, v.y, v.z, v.yaw].every(Number.isFinite)) stats.nan++;
      }
      if (i % 30) continue;
      const now = engine.now;
      const climbs = engine.world.meta?.climbs ?? [];
      for (const p of engine.entities.values()) {
        if (p.state === 'alive' && !p.vehicleId && climbs.some(c => { const d = c.points[c.points.length - 1];
          return Math.hypot(p.x - d.x, p.z - d.z) < 2 && Math.abs(p.y - d.y) < 1.2; })) stats.perchers.add(String(p.id));
      }
      for (const p of engine.entities.values()) {
        const hull = p.vehicleId ? engine.vehicles.vehicles.get(p.vehicleId) : null;
        const at = hull ?? p;
        if (bounds && p.state === 'alive' && (at.x < bounds.minX || at.x > bounds.maxX || at.z < bounds.minZ || at.z > bounds.maxZ)) {
          if (!hull && now - (respawnAt.get(String(p.id)) ?? -Infinity) < SPAWN_GRACE_MS) stats.spawnOutside++;
          else stats.outside++;
        }
        // A piloted titan with no target: its whole 30 s window within 4 m of the start is boxed in.
        if (hull && isTitanType(hull.type) && !(hull.landedUntil > now) && !hull.doomed) {
          let tw = titanWatch.get(p.id);
          const engaged = brains.get(p.id)?.mounted?.targetId != null;
          if (!tw || tw.vehicleId !== hull.id || engaged || Math.hypot(hull.x - tw.x, hull.z - tw.z) > TITAN_STUCK_M) {
            titanWatch.set(p.id, { vehicleId: hull.id, x: hull.x, z: hull.z, since: now });
          } else if (now - tw.since > TITAN_STUCK_MS && !tw.reported) {
            tw.reported = true;
            stats.titanStuck.push(`${p.id} ${hull.type} at ${hull.x.toFixed(1)},${hull.y.toFixed(1)},${hull.z.toFixed(1)}`);
          }
        } else titanWatch.delete(p.id);
        let w = watch.get(p.id);
        if (p.state !== 'alive' || !w || w.lives !== p.lives || Math.hypot(at.x - w.x, at.z - w.z) > 2) {
          watch.set(p.id, { x: at.x, z: at.z, since: now, lives: p.lives });
          continue;
        }
        if (now - w.since > STALL_MS && !w.reported) {
          w.reported = true;
          stats.stalls.push(`${p.id} ${hull ? hull.type : 'pilot'} at ${at.x.toFixed(1)},${at.y.toFixed(1)},${at.z.toFixed(1)}`);
        }
      }
    }
    for (const vehicleId of [...doomAt.keys()]) doomEnded(vehicleId, false);
    stats.scores = { ...policy.scores };
    stats.phase = policy.phase;
    stats.winner = policy.matchWinner;
    return stats;
  } finally {
    engine.stop();
    Math.random = realRandom;
    Date.now = realNow;
  }
}

const summary = (map, s, wall) => console.log(`${map}: drops ${s.drops} (refused ${s.refused}), embarks ${s.embarks}, dooms ${s.dooms}, `
  + `ejects ${s.ejects}, destroyed ${s.destroyed}, rodeo ${s.rodeoMounts}/${s.rips}/${s.inserts}, pilot AT dmg ${Math.round(s.pilotAtDamage)} `
  + `(${s.pilotAtHits} hits), titan dmg ${Math.round(s.titanDamage)}, minions killed ${s.minionDeaths} (by bot pilots ${s.minionKillsPilot}, `
  + `bot titans ${s.minionKillsTitan}), abilities ${JSON.stringify(s.abilities)}, scores ${JSON.stringify(s.scores)} `
  + `${s.phase}${s.winner !== undefined ? ` winner ${s.winner}` : ''}, kills ${JSON.stringify(s.kills)} [${wall.toFixed(1)} s]`);

// Drop points with no way out (harbor seeds 11/12: a titan boxed in for 170+ s) are refused.
{
  const engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('harbor'), world: createMapState('harbor'), broadcast: () => {} });
  try {
    const bots = new TitanfallBots(engine);
    for (const [x, y, z] of [[165.89, 15, 15.34], [156.88, 15, 14.87]]) {
      ok(bots.openGround(x, y, z) && !bots.wayOut(x, y, z, 'titan_scorch'), `harbor: roofed gantry cell ${x},${z} has open sky but no way out`);
    }
    ok(bots.wayOut(80, 15, 100, 'titan_scorch'), 'harbor: an open yard spot has a way out');
  } finally { engine.stop(); }
}

/**
 * Two bots (one normal pilot per team) on `map`; a parked enemy titan with no
 * live owner (it neither moves nor fires) lands 12-16 m from the alpha pilot,
 * facing away from or toward it. Returns ms from landing to the mount, or null.
 */
function rodeoScenario(map, facing) {
  Math.random = seeded(0x40de0);
  let clock = 1_700_000_000_000;
  Date.now = () => clock;
  let engine = null, mountedAt = null, pilotId = null;
  engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta(map), world: createMapState(map),
    broadcast: s => { for (const e of s.events ?? []) if (e.kind === 'rodeo_mount' && e.id === pilotId && mountedAt == null) mountedAt = engine.now; } });
  try {
    const manager = attachBots(engine, 2, { personalitySeed: 7, difficulties: new Map([['bot-0', 'normal'], ['bot-1', 'normal']]) });
    const policy = engine.mode.policy, step = () => { engine.step(TICK_MS); clock += TICK_MS; };
    for (let i = 0; i < 600 && policy.phase !== 'live'; i++) step();
    policy.endsAt = engine.now + 120000;
    for (let i = 0; i < 30; i++) step();
    const pilot = [...engine.entities.values()].find(p => p.state === 'alive' && p.team === 'alpha');
    if (!pilot) return null;
    pilotId = pilot.id;
    for (const p of engine.entities.values()) policy.setTitanMeter(p, 0);
    const titans = engine.vehicles.titans, bots = manager.titanfall, world = titans.world;
    let spot = null;
    for (let k = 0; k < 16 && !spot; k++) {
      for (const d of [14, 12, 16]) {
        const a = k * Math.PI / 8, x = pilot.x - Math.sin(a) * d, z = pilot.z - Math.cos(a) * d;
        const probe = { type: 'titan_ion', x, y: pilot.y, z, yaw: 0 };
        if (!bots.openGround(x, pilot.y, z) || !Number.isFinite(placeWalker(probe, x, z, world)) || !bots.wayOut(x, pilot.y, z, 'titan_ion')) continue;
        spot = { x, y: pilot.y, z };
        break;
      }
    }
    if (!spot) return null;
    // Hull forward is local -Z: `away` points it from the pilot (the pilot starts behind it).
    const away = Math.atan2(-(spot.x - pilot.x), -(spot.z - pilot.z));
    const v = titans.spawnDrop({ id: 'scripted-owner', team: 'bravo' }, spot.x, spot.y, spot.z, 'titan_ion', facing === 'away' ? away : away + Math.PI);
    const landed = v.landsAt + 2000, from = { x: pilot.x, y: pilot.y, z: pilot.z };
    while (engine.now < landed) step();
    // The pilot roams while the titan falls: put it back where the spot was measured from.
    Object.assign(pilot, { x: from.x, y: from.y, z: from.z, vx: 0, vy: 0, vz: 0 });
    // The bot rolled for this titan already (§9 "sometimes"): this checks the run, not the roll.
    bots.stateFor(manager.brains.find(br => br.id === pilot.id)).rolls.set(v.id, true);
    const start = engine.now;
    while (engine.now - start < 10000 && mountedAt == null && pilot.state === 'alive') step();
    return mountedAt == null ? null : mountedAt - start;
  } finally {
    engine.stop();
    Math.random = realRandom;
    Date.now = realNow;
  }
}
for (const map of ['harbor', 'canyon', 'frontier', 'ashfall']) {
  for (const facing of ['away', 'toward']) {
    const ms = rodeoScenario(map, facing);
    ok(ms != null, `${map}: a pilot rodeos a parked titan facing ${facing === 'away' ? 'away from' : 'toward'} it (${ms == null ? 'no mount' : `${(ms / 1000).toFixed(1)} s`})`);
  }
}

/**
 * Ashfall rodeo perch (§14): one normal alpha pilot sent to the ring-road perch
 * from the street walks up its stair; then a parked bravo titan lands on the
 * ring road below and the perched pilot leaps onto it. Returns
 * { climbMs, mountMs } (null where it failed).
 */
function perchScenario() {
  Math.random = seeded(0x9e4c4);
  let clock = 1_700_000_000_000;
  Date.now = () => clock;
  let engine = null, mountedAt = null, pilotId = null;
  engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('ashfall'), world: createMapState('ashfall'),
    broadcast: s => { for (const e of s.events ?? []) if (e.kind === 'rodeo_mount' && e.id === pilotId && mountedAt == null) mountedAt = engine.now; } });
  const result = { climbMs: null, mountMs: null };
  try {
    const manager = attachBots(engine, 2, { personalitySeed: 7, difficulties: new Map([['bot-0', 'normal'], ['bot-1', 'normal']]) });
    const policy = engine.mode.policy, step = () => { engine.step(TICK_MS); clock += TICK_MS; };
    for (let i = 0; i < 600 && policy.phase !== 'live'; i++) step();
    policy.endsAt = engine.now + 120000;
    for (let i = 0; i < 30; i++) step();
    const pilot = [...engine.entities.values()].find(p => p.state === 'alive' && p.team === 'alpha');
    const foe = [...engine.entities.values()].find(p => p.team === 'bravo');
    if (!pilot) return result;
    pilotId = pilot.id;
    for (const p of engine.entities.values()) policy.setTitanMeter(p, 0);
    // The bravo pilot is kept across the map: this checks the climb and the leap, not a duel.
    const away = () => { if (foe && Math.hypot(foe.x - pilot.x, foe.z - pilot.z) < 80) Object.assign(foe, { x: 200, y: 15, z: 88, vx: 0, vz: 0 }); };
    const climb = engine.world.meta.climbs.find(c => c.id === 'ring-road'), deck = climb.points[climb.points.length - 1];
    Object.assign(pilot, { x: 50.5, y: 15, z: 99.5, vx: 0, vy: 0, vz: 0, vault: null, slide: null, jumpGroundY: null, coyote: 0, grounded: false });
    const bots = manager.titanfall, br = manager.brains.find(b => b.id === pilot.id);
    bots.assignPerch(br, 'ring-road', engine.now);
    const start = engine.now;
    while (engine.now - start < 25000 && pilot.state === 'alive') {
      step(); away();
      if (Math.hypot(pilot.x - deck.x, pilot.z - deck.z) < 1.6 && Math.abs(pilot.y - deck.y) < 1.2) { result.climbMs = engine.now - start; break; }
    }
    if (result.climbMs == null) return result;
    const v = engine.vehicles.titans.spawnDrop({ id: 'scripted-owner', team: 'bravo' }, 39.5, 15, 104, 'titan_ion', 0);
    while (engine.now < v.landsAt + 6000 && mountedAt == null && pilot.state === 'alive') { step(); away(); }
    result.mountMs = mountedAt == null ? null : mountedAt - v.landsAt;
    return result;
  } finally {
    engine.stop();
    Math.random = realRandom;
    Date.now = realNow;
  }
}
{
  const { climbMs, mountMs } = perchScenario();
  ok(climbMs != null && climbMs < 25000, `ashfall: a bot sent to the ring-road perch walks up its stair (${climbMs == null ? 'never' : `${(climbMs / 1000).toFixed(1)} s`})`);
  ok(mountMs != null, `ashfall: a perched bot leaps onto an enemy titan below (${mountMs == null ? 'no mount' : `${(mountMs / 1000).toFixed(1)} s after it landed`})`);
}

/**
 * Ashfall battery cache (§14): one normal alpha pilot on the cross street beside the
 * Hab annex cache, a friendly alpha titan with an empty shield parked up the street.
 * Returns { pickupMs, insertMs } (null where it failed).
 */
function cacheScenario() {
  Math.random = seeded(0xca5e);
  let clock = 1_700_000_000_000;
  Date.now = () => clock;
  let engine = null, pickedAt = null, insertedAt = null, pilotId = null;
  engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('ashfall'), world: createMapState('ashfall'),
    broadcast: s => {
      for (const e of s.events ?? []) {
        if (e.kind === 'battery_pickup' && e.id === pilotId && pickedAt == null) pickedAt = engine.now;
        if (e.kind === 'rodeo_insert' && e.id === pilotId && insertedAt == null) insertedAt = engine.now;
      }
    } });
  const result = { pickupMs: null, insertMs: null };
  try {
    const manager = attachBots(engine, 2, { personalitySeed: 11, difficulties: new Map([['bot-0', 'normal'], ['bot-1', 'normal']]) });
    const policy = engine.mode.policy, step = () => { engine.step(TICK_MS); clock += TICK_MS; };
    for (let i = 0; i < 600 && policy.phase !== 'live'; i++) step();
    policy.endsAt = engine.now + 120000;
    for (let i = 0; i < 30; i++) step();
    const pilot = [...engine.entities.values()].find(p => p.state === 'alive' && p.team === 'alpha');
    const foe = [...engine.entities.values()].find(p => p.team === 'bravo');
    if (!pilot) return result;
    pilotId = pilot.id;
    for (const p of engine.entities.values()) policy.setTitanMeter(p, 0);
    const away = () => { if (foe && Math.hypot(foe.x - pilot.x, foe.z - pilot.z) < 80) Object.assign(foe, { x: 200, y: 15, z: 88, vx: 0, vz: 0 }); };
    const titans = engine.vehicles.titans;
    const v = titans.spawnDrop({ id: 'scripted-owner', team: 'alpha' }, 75.5, 15, 40.5, 'titan_ion', 0);
    while (engine.now < v.landsAt + 500) { step(); away(); }
    v.shield = 0;
    Object.assign(pilot, { x: 75.5, y: 15, z: 61.5, vx: 0, vy: 0, vz: 0, vault: null, slide: null, jumpGroundY: null, coyote: 0, grounded: false });
    const start = engine.now;
    while (engine.now - start < 40000 && insertedAt == null && pilot.state === 'alive') { step(); away(); }
    result.pickupMs = pickedAt == null ? null : pickedAt - start;
    result.insertMs = insertedAt == null ? null : insertedAt - start;
    return result;
  } finally {
    engine.stop();
    Math.random = realRandom;
    Date.now = realNow;
  }
}
{
  const { pickupMs, insertMs } = cacheScenario();
  ok(pickupMs != null && pickupMs < 20000, `ashfall: a quiet bot fetches the Hab annex cache battery for a friendly titan (${pickupMs == null ? 'never' : `${(pickupMs / 1000).toFixed(1)} s`})`);
  ok(insertMs != null, `ashfall: the bot carries the cached battery to the titan and inserts it (${insertMs == null ? 'no insert' : `${(insertMs / 1000).toFixed(1)} s`})`);
}

const runs = [
  { map: 'harbor', seconds: SECONDS, seed: 0x7174 + SEED_OFFSET * 3 },
  { map: 'canyon', seconds: Math.round(SECONDS * 0.75), seed: 0x7175 + SEED_OFFSET * 3 },
  { map: 'frontier', seconds: Math.round(SECONDS * 0.75), seed: 0x7176 + SEED_OFFSET * 3 },
  { map: 'ashfall', seconds: Math.round(SECONDS * 0.75), seed: 0x7177 + SEED_OFFSET * 3 },
];
const all = [];
for (const run of runs) {
  const t0 = performance.now();
  const s = runMatch(run.map, run.seconds, run.seed);
  summary(run.map, s, (performance.now() - t0) / 1000);
  all.push({ ...run, s });
  ok(s.errors.length === 0, `${run.map}: no exception in the bot tick${s.errors.length ? ` (${s.errors[0]?.stack})` : ''}`);
  ok(s.nan === 0, `${run.map}: no NaN body or hull position`);
  ok(s.stalls.length === 0, `${run.map}: no bot stalled > 20 s${s.stalls.length ? ` (${s.stalls.join('; ')})` : ''}`);
  ok(s.titanStuck.length === 0, `${run.map}: no piloted titan boxed in > 30 s${s.titanStuck.length ? ` (${s.titanStuck.join('; ')})` : ''}`);
  ok(s.drops >= 2, `${run.map}: titans dropped (${s.drops})`);
  ok(s.embarks >= 1, `${run.map}: bots embarked (${s.embarks})`);
  ok(s.titanDamage > 0, `${run.map}: piloted titans dealt damage to titans (${Math.round(s.titanDamage)})`);
  ok(s.pilotAtDamage > 0, `${run.map}: pilots dealt AT damage to titans (${Math.round(s.pilotAtDamage)}, ${s.pilotAtHits} hits)`);
  ok(s.scores.alpha + s.scores.bravo > 0, `${run.map}: the score climbs (${s.scores.alpha}:${s.scores.bravo})`);
  ok(s.phase === 'post' && (s.winner === null || s.winner === 'alpha' || s.winner === 'bravo'),
    `${run.map}: the match ends with a result (${s.phase}, winner ${s.winner})`);
  if (run.map === 'ashfall') ok(s.perchers.size >= 1, `ashfall: bots climb to the rodeo perches (${s.perchers.size} pilots stood on a perch deck)`);
  if (run.map === 'frontier') {
    ok(s.restricted === 0, `frontier: no restricted (out-of-bounds) deaths (${s.restricted})`);
    ok(s.outside === 0, `frontier: no bot or titan outside botBounds (${s.outside} samples; ${s.spawnOutside} right after a respawn)`);
  }
}
const total = key => all.reduce((sum, run) => sum + run.s[key], 0);
ok(total('dooms') >= 1, `titans get doomed (${total('dooms')})`);
ok(total('ejects') >= Math.ceil(total('ejectChances') / 2) && (total('ejectChances') === 0 || total('ejects') >= 1),
  `doomed bots eject (${total('ejects')} of ${total('ejectChances')} piloted dooms with time to eject; `
  + `${total('shortDooms')} ended inside ${EJECT_REACTION_MAX_MS} ms; ${total('pilotedDooms')} piloted dooms)`);
ok(total('minionKillsPilot') + total('minionKillsTitan') >= 1,
  `bots kill attrition minions (${total('minionKillsPilot')} as pilots, ${total('minionKillsTitan')} in titans, of ${total('minionDeaths')} minion deaths)`);
console.log(`rodeo in the matches: ${total('rodeoMounts')} mounts, ${total('rips')} rips, ${total('inserts')} inserts`);
console.log(`titanfall-bots-test: ${checks} checks passed`);
