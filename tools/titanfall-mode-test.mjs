// Titanfall mode (docs/titanfall.md §1, §1.1, §3, §11.1, §11.2): lobby
// creation on all three maps, play-area spawns, wire keys only in titanfall,
// the self-only `tfs` frame and the once-per-tick stringify, attrition
// scoring, match end, respawn, capacity and bay cap, spawn avoidance and the
// spawn drop refusal, OOB kill, the §1.1 lifecycle table, structural conquest
// invariants and an in-process A/B conquest digest. Node only, no audio.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { GameEngine } from '../server/game.js';
import { LobbyManager } from '../server/lobby.js';
import { getMapMeta, createMapState } from '../shared/world/templates.js';
import { isSolidBlock } from '../shared/worlddata.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { VEHICLE_TYPE_IDS, VEHICLE_WEAPON_META, isDeployableType } from '../shared/conquest-contract.js';
import { VEHICLE_DEFS, VEHICLE_RULES, VEHICLE_HANDLING, VEHICLE_MASS, VEHICLE_WEAPONS } from '../shared/vehicle-defs.js';
import { VEHICLE_COLLIDERS } from '../shared/vehicle-collision.js';
import {
  TITAN_TYPE_IDS, TITANFALL_CONTRACT_VERSION, TITAN_PHASE, packTitanLoadout, decodeTitanfallPlayer, decodeTitanRow,
  decodeTitanfallSelf, isTitanType, TITAN_LOADOUT_DEFAULT_PACKED,
} from '../shared/titan-contract.js';
import { DEPLOY_RULES } from '../server/modes/titanfall.js';
import { titanfallScoreLimit, MODE_RULES } from '../shared/modes.js';
import { KILLCAM } from '../shared/killcam-rules.js';
import {
  TITANFALL_PLAYER_EXTRA_KEYS, TITANFALL_TF_LENGTH, TITANFALL_TFS_LENGTH, TITANFALL_SELF_KEYS, TITANFALL_STATE_KEYS,
  TITANFALL_MATCH_BUDGET_BYTES, TITAN_ROW_EXTRA_KEYS,
} from './lib/protocol-contract.mjs';
import { PLAY_AREA_RULES } from '../server/sim/titanfall/play-area.js';
import { TITAN_RULES } from '../shared/vehicle-handling/titan.js';

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

/** mulberry32: the seeded Math.random behind every engine in this test. */
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
const realNow = Date.now;
Math.random = seeded(0x7174);

/** A bare engine whose broadcasts are collected (events flattened). */
function makeEngine(mode, map) {
  const out = { last: null, events: [] };
  out.engine = new GameEngine({ mode, mapMeta: getMapMeta(map), world: createMapState(map),
    broadcast: s => { out.last = s; for (const e of s.events ?? []) out.events.push(e); } });
  out.step = (n = 1) => { for (let i = 0; i < n; i++) out.engine.step(TICK_MS); };
  out.policy = out.engine.mode.policy;
  out.titans = out.engine.vehicles.titans;
  out.kinds = kind => out.events.filter(e => e.kind === kind);
  return out;
}
const otherTeam = team => team === 'alpha' ? 'bravo' : 'alpha';
const groundY = (world, x, z) => {
  let y = world.dimensions.sy - 1;
  while (y > 0 && !isSolidBlock(world.getBlock(Math.floor(x), y, Math.floor(z)))) y--;
  return y + 1;
};

/** Call `p`'s titan with a full meter, sweeping the aim until the server accepts. */
function callTitan(f, p) {
  f.policy.setTitanMeter(p, 1);
  for (let k = 0; k < 24; k++) for (const pitch of [-0.5, -0.35, -0.25, -0.18, -0.7]) {
    p.input = { ...(p.input || {}), keys: {}, yaw: k * Math.PI / 12, pitch };
    const result = f.titans.call(p, null);
    if (result.ok) return f.engine.vehicles.vehicles.get(result.vehicleId);
    if (result.reason === 'bay' || result.reason === 'owned') return null;
  }
  return null;
}
function landedTitan(f, p) {
  const v = callTitan(f, p);
  assert.ok(v, `titan call for ${p.id}`);
  f.step(Math.ceil((TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs) / TICK_MS) + 70);
  assert.ok(!v.dropping && v.hp > 0, 'titan landed');
  return v;
}
function embark(f, p, v) {
  Object.assign(p, { x: v.x, y: v.y, z: v.z - 2.6, vx: 0, vy: 0, vz: 0 });
  return f.engine.vehicles.action(p, { type: 'enter', vehicleId: v.id });
}
/** Humans wait on the loadout screen until DEPLOY (§3.4): deploy `ids` and run one tick. */
function deployHumans(engine, ids, packed = TITAN_LOADOUT_DEFAULT_PACKED) {
  for (const id of ids) assert.ok(engine.titanfallIntent(id, { type: 'deploy', value: packed }), `deploy ${id}`);
  engine.step(TICK_MS);
}
/** Two pilots per team on a fresh titanfall engine. */
function teamEngine(map = 'harbor') {
  const f = makeEngine('titanfall', map);
  for (const [id, team] of [['a1', 'alpha'], ['a2', 'alpha'], ['b1', 'bravo'], ['b2', 'bravo']]) {
    f.engine.addClient(id, id.toUpperCase());
    f.policy.setLobbyTeam(id, team);
  }
  deployHumans(f.engine, ['a1', 'a2', 'b1', 'b2']);
  f.step(2);
  f.p = id => f.engine.entities.get(id);
  return f;
}

/* ------------------------------------------------------------------ lobby on all three maps */
{
  const sent = [];
  let stringifies = 0;
  const cache = new WeakMap();
  // Mirrors server/index.js sendJson: a tick object is stringified once and cached for every member.
  const sendJson = (meta, obj) => {
    let payload = cache.get(obj);
    if (payload === undefined) {
      const t0 = performance.now();
      payload = JSON.stringify(obj);
      stringifies++;
      if (obj.t === 'tick') { cache.set(obj, payload); sent.stringifyMs = (sent.stringifyMs ?? 0) + performance.now() - t0; }
    }
    sent.push({ id: meta.id, obj, bytes: payload.length });
    return true;
  };
  const manager = new LobbyManager({ sendJson, sendFrame: () => true, closeClient() {} });
  try {
    for (const map of ['harbor', 'canyon', 'frontier', 'ashfall']) {
      sent.length = 0;
      const host = { id: `host-${map}`, clientTitanfall: TITANFALL_CONTRACT_VERSION };
      const guest = { id: `guest-${map}`, clientTitanfall: TITANFALL_CONTRACT_VERSION };
      const stale = { id: `stale-${map}`, clientTitanfall: 0 };
      ok(await manager.create(host, 'Host', 31, 'titanfall', map), `${map}: lobby created`);
      const room = host.room;
      eq(manager._stateFor(room).members.length, 16, `${map}: capacity 16 with bots`);
      ok(await manager.join(guest, 'Guest', room.code), `${map}: current client joins`);
      eq(await manager.join(stale, 'Stale', room.code), false, `${map}: stale titanfall client refused`);
      ok(manager.titanfall(host, { type: 'loadout', value: packTitanLoadout({ primary: 'smg', at: 'mgl', tactical: 'stim', titan: 'titan_ronin' }) }),
        `${map}: loadout intent before the match`);
      manager.ready(host, true); manager.ready(guest, true);
      ok(manager.start(host), `${map}: started`);
      const engine = room.engine;
      engine.stop();
      // §3.4 deploy: the humans start on the loadout screen, unspawned, until DEPLOY; bots spawn at once.
      for (const member of [host, guest]) {
        const e = engine.entities.get(member.id), policy = engine.mode.policy;
        const tf = decodeTitanfallPlayer({ tf: [0, null, 0, policy.titanfallFields(e, policy._state(e)).flags] });
        ok(e.state === 'dead' && tf?.deploy && tf.staged && !tf.deployQueued, `${map}: ${member.id} held for DEPLOY at match start`);
      }
      ok([...engine.entities.values()].filter(e => e.bot).every(e => e.state === 'alive'), `${map}: bots spawn without deploy`);
      ok(manager.titanfall(host, { type: 'deploy', value: packTitanLoadout({ primary: 'smg', at: 'mgl', tactical: 'stim', titan: 'titan_ronin' }) }), `${map}: host deploys`);
      ok(manager.titanfall(guest, { type: 'deploy', value: TITAN_LOADOUT_DEFAULT_PACKED }), `${map}: guest deploys`);
      engine.step(TICK_MS);
      const hostEntity = engine.entities.get(host.id);
      ok(hostEntity.state === 'alive' && engine.entities.get(guest.id).state === 'alive', `${map}: both humans spawned after DEPLOY`);
      ok(hostEntity.owned.includes('smg') && hostEntity.owned.includes('mgl') && hostEntity.pilotTac?.kind === 'stim',
        `${map}: the first life runs the deployed pick (${hostEntity.owned}, ${hostEntity.pilotTac?.kind})`);
      eq(engine.mode.mode, 'titanfall', `${map}: mode`);
      eq(engine.vehicles.combatProfile, 'titanfall', `${map}: titanfall vehicle profile`);
      eq(engine.entities.size, 16, `${map}: 16 combatants`);
      eq(engine.vehicles.vehicles.size, 0, `${map}: no pre-placed vehicles`);
      eq(engine.mode.policy.viewFor, undefined, `${map}: no per-recipient tick view`);
      const policy = engine.mode.policy;
      if (map === 'frontier') {
        const { minX, maxX, minZ, maxZ } = PLAY_AREA_RULES.frontier;
        ok(policy.playArea.frontier && policy.playArea.spawns.alpha.length === 16 && policy.playArea.spawns.bravo.length === 16, 'frontier play-area spawns');
        for (const team of ['alpha', 'bravo']) eq(policy.teamSpawnPool(team), policy.playArea.spawns[team], `frontier ${team} pool is the play area's`);
        for (const e of engine.entities.values()) ok(e.x >= minX && e.x <= maxX && e.z >= minZ && e.z <= maxZ, `frontier spawn ${e.id} inside the play area`);
      } else {
        ok(!policy.playArea.frontier && policy.teamSpawnPool('alpha') === getMapMeta(map).spawns.tdm.alpha, `${map}: tdm spawns`);
      }
      // Ten live ticks through the real broadcast path.
      sent.length = 0;
      stringifies = 0;
      sent.stringifyMs = 0;
      let selfMs = 0;
      const realSelf = policy.selfFrame.bind(policy);
      policy.selfFrame = (id, tick) => { const t0 = performance.now(); const r = realSelf(id, tick); selfMs += performance.now() - t0; return r; };
      for (let i = 0; i < 10; i++) engine.step(TICK_MS);
      delete policy.selfFrame;
      const ticks = sent.filter(s => s.obj.t === 'tick');
      const frames = sent.filter(s => s.obj.t === 'tfs');
      const tickObjects = new Set(ticks.map(s => s.obj));
      eq(tickObjects.size, 10, `${map}: ten ticks`);
      eq(ticks.length, 20, `${map}: every tick to both members`);
      eq(stringifies - frames.length, 10, `${map}: each tick stringified once`);
      eq(frames.length, 20, `${map}: one tfs per member per tick`);
      ok(frames.every(s => s.id === host.id || s.id === guest.id), `${map}: tfs only to members`);
      for (let i = 0; i < sent.length; i++) {
        if (sent[i].obj.t !== 'tfs') continue;
        const before = sent[i - 1];
        ok(before?.obj.t === 'tick' && before.id === sent[i].id, `${map}: tfs follows the member's tick`);
        eq(sent[i].obj.s, before.obj.now, `${map}: tfs.s is the tick's now`);
        eq(Object.keys(sent[i].obj).sort().join(), TITANFALL_SELF_KEYS, `${map}: tfs keys`);
        eq(sent[i].obj.d.length, TITANFALL_TFS_LENGTH, `${map}: tfs length`);
        ok(decodeTitanfallSelf(sent[i].obj) !== null, `${map}: tfs decodes`);
      }
      // The last tick's frames are exactly each member's own selfFrame (nothing moved since).
      for (const s of frames.slice(-2)) eq(s.obj, policy.selfFrame(s.id, ticks.at(-1).obj), `${map}: ${s.id} gets its own frame`);
      eq(new Set(frames.slice(-2).map(s => s.id)).size, 2, `${map}: one frame per member`);
      const lastTick = ticks.at(-1).obj;
      for (const row of lastTick.players) ok(Array.isArray(row.tf) && row.tf.length === TITANFALL_TF_LENGTH, `${map}: ${row.id} tf row`);
      eq(decodeTitanfallPlayer(lastTick.players.find(r => r.id === host.id)).loadout.titan, 'titan_ronin', `${map}: loadout reaches tf`);
      const state = JSON.stringify(lastTick.match.titanfall);
      eq(Object.keys(lastTick.match.titanfall).sort().join(), TITANFALL_STATE_KEYS, `${map}: match.titanfall keys`);
      ok(state.length <= TITANFALL_MATCH_BUDGET_BYTES, `${map}: match.titanfall ${state.length} B`);
      const tfsBytes = frames.reduce((a, s) => a + s.bytes, 0) / frames.length;
      console.log(`  ${map}: tick ${ticks.at(-1).bytes} B, stringify ${(sent.stringifyMs / 10).toFixed(3)} ms/tick, tfs ${tfsBytes.toFixed(0)} B, selfFrame ${(selfMs / 10).toFixed(3)} ms/tick (2 members, 14 bots)`);
      manager.leave(guest);
      manager.leave(host);
    }
  } finally { manager.stop(); }
}

/* ------------------------------------------------------------------ wire keys only in titanfall */
{
  for (const [mode, map] of [['tdm', 'harbor'], ['conquest', 'frontier'], ['fun', 'canyon']]) {
    const f = makeEngine(mode, map);
    f.engine.addClient('x1', 'X1'); f.engine.addClient('x2', 'X2');
    f.step(3);
    ok(f.last.players.every(row => !(TITANFALL_PLAYER_EXTRA_KEYS in row) && !('titanfall' in row)), `${mode}: no tf rows`);
    ok(!('titanfall' in f.last.match), `${mode}: no match.titanfall`);
    ok(f.last.vehicles.every(row => TITAN_ROW_EXTRA_KEYS.split(',').every(key => !(key in row))), `${mode}: no titan row keys`);
    eq(f.policy.selfFrame, undefined, `${mode}: no selfFrame`);
    eq(f.engine.vehicles.titans, null, `${mode}: no titan system`);
    if (mode === 'conquest') eq(f.engine.vehicles.combatProfile, 'conquest', 'conquest combat profile');
    else eq(f.engine.vehicles.combatProfile, null, `${mode}: no vehicle profile`);
    ok(!('fallDamage' in f.policy) || mode === 'conquest', `${mode}: fall damage only in conquest`);
    f.engine.stop();
  }
  const f = teamEngine();
  ok(f.engine.mode.airborneRules() === false, 'titanfall: no airborne rules (no fall damage, no chute)');
  ok(f.last.players.every(row => row.tf.length === TITANFALL_TF_LENGTH), 'titanfall: tf on every row');
  f.engine.stop();
}

/* ------------------------------------------------------------------ scoring, respawn, match end */
{
  const f = teamEngine();
  // Exact pilot/titan scores: no minion waves (minion-on-minion kills score for their team too;
  // the grunt suite covers minion scoring).
  f.policy.grunts.enabled = false;
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  // Pilot kill: 5 to the killer's team; a team kill scores nothing.
  f.engine.killPlayer(b1, a1, 'rifle', false);
  eq(f.policy.scores.alpha, 5, 'pilot kill 5');
  // A human killed by a pilot waits for the killcam replay (4.8 s); the mode delay itself is 4 s.
  const RESPAWN = Math.max(MODE_RULES.titanfall.respawnMs, KILLCAM.respawnMs);
  eq(MODE_RULES.titanfall.respawnMs, 4000, 'mode respawn 4 s');
  eq(b1.respawnAt - f.engine.now, RESPAWN, 'respawn after the killcam replay (4.8 s)');
  ok(decodeTitanfallPlayer(f.last.players.find(r => r.id === 'b1')) !== null, 'b1 row');
  f.step(1);
  const deadTf = decodeTitanfallPlayer(f.last.players.find(r => r.id === 'b1'));
  ok(deadTf.deploy && !deadTf.staged && !deadTf.deployQueued, 'a dead human waits for DEPLOY (tf deploy flag, not staged)');
  f.step(Math.floor(RESPAWN / TICK_MS) - 3);
  eq(b1.state, 'dead', 'still dead before the respawn time');
  f.step(4);
  eq(b1.state, 'dead', 'no respawn after the respawn time without DEPLOY');
  ok(f.engine.titanfallIntent('b1', { type: 'deploy', value: packTitanLoadout({ primary: 'kraber', at: 'thunderbolt', tactical: 'cloak', titan: 'titan_legion' }) }), 'DEPLOY after the timer');
  f.step(1);
  eq(b1.state, 'alive', 'respawned on DEPLOY');
  ok(b1.owned.includes('kraber') && b1.owned.includes('thunderbolt') && b1.pilotTac?.kind === 'cloak', `respawn runs the deployed pick (${b1.owned})`);
  f.step(1);
  eq(decodeTitanfallPlayer(f.last.players.find(r => r.id === 'b1')).flags & 448, 0, 'deploy flags clear once alive');
  // DEPLOY pressed early is queued: the spawn waits for the 4 s timer.
  f.engine.killPlayer(b1, a1, 'rifle', false);
  ok(f.engine.titanfallIntent('b1', { type: 'deploy', value: TITAN_LOADOUT_DEFAULT_PACKED }), 'early DEPLOY accepted');
  f.step(1);
  ok(decodeTitanfallPlayer(f.last.players.find(r => r.id === 'b1')).deployQueued, 'tf deployQueued');
  f.step(Math.floor(RESPAWN / TICK_MS) - 3);
  eq(b1.state, 'dead', 'queued DEPLOY waits for the respawn timer');
  f.step(4);
  eq(b1.state, 'alive', 'queued DEPLOY spawns once the timer ran out');
  // Idle on the loadout screen: the server deploys after DEPLOY_RULES.timeoutMs past the respawn time.
  f.engine.killPlayer(b1, a1, 'rifle', false);
  f.step(Math.floor((RESPAWN + DEPLOY_RULES.timeoutMs) / TICK_MS) - 2);
  eq(b1.state, 'dead', 'idle: still on the loadout screen before the timeout');
  f.step(4);
  eq(b1.state, 'alive', 'idle: auto-deployed after the timeout');
  f.policy.scores.alpha = 5;
  f.engine.killPlayer(a2, a1, 'rifle', false);
  eq(f.policy.scores.alpha, 5, 'team kill scores nothing');
  f.step(Math.ceil((a2.respawnAt - f.engine.now) / TICK_MS) + 2);
  deployHumans(f.engine, ['a2']);
  // Titan: doomed by b1, finished by b2: 10 once, to the doomer (b1).
  const v = landedTitan(f, a1);
  f.engine.vehicles.damage(v.id, 1e6, b1, { cls: 'at' });
  ok(v.doomed && v.hp > 0, 'doomed');
  eq(f.policy.scores.bravo, 0, 'no points on doom');
  f.engine.vehicles.damage(v.id, 1e6, b2, { cls: 'at' });
  ok(!(v.hp > 0), 'destroyed');
  f.step(2);
  eq(f.policy.scores.bravo, 10, 'titan 10 to the doomer team');
  const destroyed = f.kinds('vehicle_destroyed').filter(e => e.vehicleId === v.id);
  eq(destroyed.length, 1, 'one destruction event');
  eq(destroyed[0].attacker, 'b1', 'credited to the doomer');
  eq(decodeTitanfallPlayer(f.last.players.find(r => r.id === 'b1')).titanKills, 1, 'tf titanKills');
  f.engine.vehicles.damage(v.id, 1e6, b2, { cls: 'at' });
  f.step(60);
  eq(f.policy.scores.bravo, 10, 'titan points once');
  // Score limit: scaled to the larger team (here 2 v 2: 100 + 2 x 80 = 260 -> 250), on the wire too.
  const limit = f.policy.scoreLimit();
  eq(limit, titanfallScoreLimit(2), 'score limit scales with the team size');
  eq(f.policy.matchSnapshot().titanfall.scoreLimit, limit, 'match.titanfall carries the scaled limit');
  // Clamped at the limit: limit - 3 + 5 ends at the limit, not 2 over.
  f.policy.scores.alpha = limit - 3;
  f.engine.killPlayer(b2, a1, 'rifle', false);
  eq(f.policy.scores.alpha, limit, 'score clamped at the limit');
  eq(f.policy.phase, 'post', 'score limit ends the match');
  eq(f.policy.scoreLimit(), limit, 'the limit holds after the match');
  // The scale itself (bot soak: the leader reaches it after ~8.5 min at every size).
  eq([1, 2, 3, 4, 6, 8].map(n => titanfallScoreLimit(n)).join(), '175,250,350,425,575,750', 'score limits 1 v 1 .. 8 v 8');
  eq(titanfallScoreLimit(0), 175, 'an empty team plays to the minimum');
  eq(titanfallScoreLimit(12), MODE_RULES.titanfall.scoreLimit, 'capped at the 8 v 8 limit');
  eq(f.policy.matchWinner, 'alpha', 'alpha wins');
  // Result rows carry the frozen `tf` row: the TITANS column reads tf[7] (playtest: always 0).
  const resultRow = id => f.engine.mode.matchSnapshot().results.find(r => r.id === id);
  eq(decodeTitanfallPlayer(resultRow('b1'))?.titanKills, 1, 'result row tf titanKills for the titan killer');
  eq(decodeTitanfallPlayer(resultRow('a1'))?.titanKills, 0, 'result row tf titanKills 0 for the rest');
  for (const state of f.policy._players.values()) state.titanKills = 0;
  eq(decodeTitanfallPlayer(resultRow('b1'))?.titanKills, 1, 'result titan kills frozen at match end');
  f.engine.stop();
  // Time limit: higher score wins, a tie is a draw.
  for (const [alpha, bravo, winner] of [[10, 5, 'alpha'], [5, 15, 'bravo'], [20, 20, null]]) {
    const g = teamEngine();
    g.policy.scores.alpha = alpha; g.policy.scores.bravo = bravo;
    eq(g.policy.endsAt - g.engine.now <= 12 * 60_000 && g.policy.endsAt - g.engine.now > 11 * 60_000, true, 'twelve minute limit');
    g.policy.endsAt = g.engine.now + TICK_MS;
    g.step(2);
    eq(g.policy.phase, 'post', `time limit ends ${alpha}:${bravo}`);
    eq(g.policy.matchWinner, winner, `time limit winner ${winner}`);
    g.engine.stop();
  }
}

/* ------------------------------------------------------------------ bay slots held for humans (playtest) */
{
  const f = teamEngine();
  const [a1, a2] = ['a1', 'a2'].map(f.p);
  a2.bot = true;
  eq(f.titans.humanReserve('alpha'), 1, 'a human without a titan holds one bay slot');
  f.policy.setTitanMeter(a2, 1);
  eq(f.titans.call(a2, null).reason, 'bay', 'a bot is refused the slot held for a human');
  ok(callTitan(f, a1), 'the human gets the slot');
  eq(f.titans.humanReserve('alpha'), 0, 'no reserve once the human owns a titan');
  f.engine.stop();
}

/* ------------------------------------------------------------------ bay cap, drop refusals, spawn avoidance */
{
  const f = teamEngine();
  const [a1, a2, b1] = ['a1', 'a2', 'b1'].map(f.p);
  eq(f.titans.bayCap('alpha'), 1, 'bay cap ceil(2 / 2)');
  ok(callTitan(f, a1), 'first alpha titan');
  f.policy.setTitanMeter(a2, 1);
  eq(f.titans.call(a2, null).reason, 'bay', 'bay full for the second alpha pilot');
  eq(f.titans.call(a1, null).reason, 'owned', 'one titan per pilot');
  f.policy.setTitanMeter(b1, 0.5);
  eq(f.titans.call(b1, null).reason, 'meter', 'meter not full');
  // 30 m around an enemy spawn point.
  const spawn = f.policy.teamSpawnPool('alpha')[0];
  f.policy.setTitanMeter(b1, 1);
  Object.assign(b1, { x: spawn.x, y: spawn.y, z: spawn.z, vx: 0, vy: 0, vz: 0 });
  const reasons = new Set();
  for (let k = 0; k < 8; k++) {
    b1.input = { ...(b1.input || {}), keys: {}, yaw: k * Math.PI / 4, pitch: -1.2 };
    reasons.add(f.titans.call(b1, null).reason);
  }
  ok(reasons.has('spawn') && !reasons.has(undefined), `drop near an enemy spawn refused: ${[...reasons]}`);
  f.step(1);
  ok(f.kinds('titanfall_refused').some(e => e.reason === 'spawn' && e.owner === 'b1'), 'spawn refusal event');
  eq(f.policy.titanMeter(b1), 1, 'a refusal keeps the meter full');
  // Spawn avoidance: an enemy titan near the alpha pool keeps alpha spawns 35 m (pool points) away.
  const pool = f.policy.teamSpawnPool('alpha');
  const hazard = f.titans.spawnDrop(b1, pool[0].x, pool[0].y, pool[0].z, 'titan_ion', 0);
  ok(hazard, 'hazard titan');
  const near = pool.filter(s => Math.hypot(s.x - hazard.x, s.z - hazard.z) < PLAY_AREA_RULES.spawnAvoid);
  ok(near.length >= 1 && near.length < pool.length, 'pool has near and clear points');
  for (let i = 0; i < 40; i++) {
    const chosen = f.policy.chooseSpawn(a2);
    // Selection expands clear points by up to 9 m per axis (SpawnSelector.expand).
    ok(Math.hypot(chosen.x - hazard.x, chosen.z - hazard.z) >= PLAY_AREA_RULES.spawnAvoid - 13, `spawn ${i} avoids the enemy titan`);
  }
  f.engine.stop();
}

/* ------------------------------------------------------------------ out of bounds (frontier play area) */
{
  const f = makeEngine('titanfall', 'frontier');
  f.engine.addClient('o1', 'O1'); f.engine.addClient('o2', 'O2');
  deployHumans(f.engine, ['o1', 'o2']);
  f.step(2);
  const p = f.engine.entities.get('o1');
  const x = PLAY_AREA_RULES.frontier.minX - 20.5, z = 384.5;
  Object.assign(p, { x, y: groundY(f.engine.world, x, z), z, vx: 0, vy: 0, vz: 0 });
  f.step(2);
  eq(f.kinds('oob_warning').filter(e => e.id === 'o1').length, 1, 'OOB warning once');
  ok(decodeTitanfallPlayer(f.last.players.find(r => r.id === 'o1')).oob, 'tf OOB flag');
  f.step(Math.floor(PLAY_AREA_RULES.oobMs / TICK_MS) - 6);
  eq(p.state, 'alive', 'alive before the OOB timer');
  f.step(8);
  eq(p.state, 'dead', 'OOB kill after 3 s');
  // A titan call aimed outside the play area is refused, and a drop landing outside is refunded.
  const q = f.engine.entities.get('o2');
  f.policy.setTitanMeter(q, 1);
  const outside = f.titans.spawnDrop(q, x, groundY(f.engine.world, x, z), z, 'titan_ion', 0);
  f.policy.setTitanMeter(q, 0);
  f.step(Math.ceil((TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs) / TICK_MS) + 2);
  ok(!f.engine.vehicles.vehicles.has(outside.id), 'an out-of-bounds landing is removed');
  eq(f.policy.titanMeter(q), 1, 'and the meter refunded');
  f.engine.stop();
}

/* ------------------------------------------------------------------ §1.1 lifecycle table */
{
  // Owner disconnects: titan removed, no score.
  let f = teamEngine();
  let v = landedTitan(f, f.p('a1'));
  f.engine.removeClient('a1');
  f.step(2);
  ok(!f.engine.vehicles.vehicles.has(v.id), 'disconnect removes the titan');
  eq(f.kinds('vehicle_destroyed').length, 0, 'disconnect: no destruction credit');
  eq([f.policy.scores.alpha, f.policy.scores.bravo], [0, 0], 'disconnect: no score');
  f.engine.stop();
  // Owner switches team: same, plus meter 0.
  f = teamEngine();
  v = landedTitan(f, f.p('b1'));
  f.policy.setTitanMeter(f.p('b1'), 0.6);
  ok(f.policy.setLobbyTeam('b1', 'alpha'), 'team switch');
  ok(!f.engine.vehicles.vehicles.has(v.id) && f.policy.titanMeter(f.p('b1')) === 0, 'team switch removes the titan and zeroes the meter');
  eq(f.kinds('vehicle_destroyed').length, 0, 'team switch: no destruction credit');
  f.engine.stop();
  // Match reset: titans and meters cleared.
  f = teamEngine();
  v = landedTitan(f, f.p('a1'));
  f.policy.setTitanMeter(f.p('b1'), 0.7);
  f.policy.reset();
  ok([...f.engine.vehicles.vehicles.values()].every(h => !isTitanType(h.type)), 'reset clears titans');
  ok(['a1', 'a2', 'b1', 'b2'].every(id => f.policy.titanMeter(f.p(id)) === 0), 'reset zeroes every meter');
  f.engine.stop();
  // Rider dies or leaves: both sides of the rodeo link are cleared.
  f = teamEngine();
  v = landedTitan(f, f.p('a1'));
  const rider = f.p('b1');
  rider.rodeoVehicleId = v.id; v.riderId = 'b1';
  f.engine.killPlayer(rider, f.p('a2'), 'rifle', false);
  ok(rider.rodeoVehicleId === null && v.riderId === null, 'rider death releases the rodeo');
  const leaver = f.p('b2');
  leaver.rodeoVehicleId = v.id; v.riderId = 'b2';
  f.engine.removeClient('b2');
  ok(v.riderId === null, 'rider leave releases the rodeo');
  // Owner dies while the titan is alive: it stays, as an auto-titan.
  f.engine.killPlayer(f.p('a1'), f.p('b1'), 'rifle', false);
  f.step(2);
  ok(v.hp > 0 && f.engine.vehicles.vehicles.has(v.id), 'titan survives its owner');
  eq(decodeTitanRow(f.last.vehicles.find(r => r.id === v.id)).phase, TITAN_PHASE.auto, 'auto-titan phase');
  f.step(Math.ceil((f.p('a1').respawnAt - f.engine.now) / TICK_MS) + 2);
  deployHumans(f.engine, ['a1']);
  ok(f.p('a1').state === 'alive', 'owner redeployed');
  eq(f.titans.ownedBy('a1'), v, 'owner keeps the titan across respawn');
  f.engine.stop();
  // Titan destroyed during embark: released at the exit spot, alive, no crew death.
  f = teamEngine();
  const owner = f.p('a1');
  v = landedTitan(f, owner);
  ok(embark(f, owner, v) && owner.embarkUntil > f.engine.now, 'embarking');
  f.engine.vehicles.damage(v.id, 1e6, f.p('b1'), { cls: 'at' });
  f.engine.vehicles.damage(v.id, 1e6, f.p('b1'), { cls: 'at' });
  ok(!(v.hp > 0), 'destroyed during embark');
  ok(owner.state === 'alive' && !owner.vehicleId && owner.embarkUntil === 0, 'pilot released unharmed');
  f.step(1);
  ok(!f.events.some(e => e.kind === 'kill' && e.victim === 'a1'), 'no crew death');
  f.engine.stop();
}

/* ------------------------------------------------------------------ structural conquest invariants */
{
  eq(Object.keys(VEHICLE_DEFS).slice(0, VEHICLE_TYPE_IDS.length), [...VEHICLE_TYPE_IDS], 'conquest defs first');
  for (const registry of [VEHICLE_RULES, VEHICLE_HANDLING, VEHICLE_MASS]) {
    eq(Object.keys(registry).filter(type => !isTitanType(type) && !isDeployableType(type)).sort(), [...VEHICLE_TYPE_IDS].sort(),
      'derived registry: conquest keys plus titans and deployables only');
  }
  ok([...VEHICLE_TYPE_IDS, ...TITAN_TYPE_IDS].every(type => VEHICLE_COLLIDERS[type]), 'colliders cover conquest and titans');
  for (const type of VEHICLE_TYPE_IDS) {
    const def = VEHICLE_DEFS[type];
    eq(VEHICLE_RULES[type], def.rules, `${type} rules`);
    eq(VEHICLE_HANDLING[type], def.handling, `${type} handling`);
    ok(!JSON.stringify(def).includes('titan'), `${type} def carries no titan data`);
  }
  eq(Object.keys(VEHICLE_WEAPONS).filter(key => Object.hasOwn(VEHICLE_WEAPON_META, key)), Object.keys(VEHICLE_WEAPON_META)
    .filter(key => Object.hasOwn(VEHICLE_WEAPONS, key)), 'conquest weapon order unchanged');
  ok(TITAN_TYPE_IDS.every(type => VEHICLE_DEFS[type].handling === 'walker'), 'titans are walkers');
}

/* ------------------------------------------------------------------ in-process A/B conquest digest */
{
  const strip = (key, value) => (key === 'mag' || key === 'reserve') ? undefined : value;
  const run = (mode, map, ticks) => {
    Math.random = seeded(1234);
    Date.now = () => 1_700_000_000_000;
    // The Conquest weather draws its match seed from the CSPRNG (server/modes/conquest/weather.js),
    // so pin that too: both runs must see the same timeline (wind, strikes) on the wire.
    const cryptoRandom = seeded(5678);
    globalThis.crypto.getRandomValues = cells => { for (let i = 0; i < cells.length; i++) cells[i] = Math.floor(cryptoRandom() * 2 ** 32); return cells; };
    const hash = createHash('sha256');
    const rowBytes = [];
    const engine = new GameEngine({ mode, mapMeta: getMapMeta(map), world: createMapState(map), broadcast: s => {
      hash.update(JSON.stringify(s, strip));
      for (const row of s.vehicles ?? []) rowBytes.push(JSON.stringify(row).length);
    } });
    try {
      for (let i = 0; i < 4; i++) engine.addClient(`p${i}`, `P${i}`);
      const ids = [...engine.entities.keys()];
      for (let t = 0; t < ticks; t++) {
        for (const [k, id] of ids.entries()) {
          const p = engine.entities.get(id);
          engine.applyInput(id, { seq: t + 1, keys: { f: t % 120 < 80, l: (t + k * 30) % 90 < 20, jump: t % 70 === k, sprint: t % 200 < 100 },
            yaw: (t * 0.01 + k) % (2 * Math.PI) - Math.PI, pitch: -0.05, fire: t % 45 < 6, weapon: p?.weapon,
            vehicleThrottle: t % 100 < 60 ? 1 : 0, vehicleSteer: (k % 2) * 0.5 });
          if (t === 100 + k * 10) {
            const hull = [...engine.vehicles.vehicles.values()].find(h => h.team === engine.mode.teamFor(p) && h.hp > 0 && !h.occupantId);
            if (hull) {
              Object.assign(p, { x: hull.x + 3, y: hull.y + 0.5, z: hull.z });
              engine.applyInput(id, { seq: t + 1, keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'enter', vehicleId: hull.id } });
            }
          }
        }
        engine.step(TICK_MS);
      }
    } finally {
      engine.stop();
      Math.random = realRandom;
      Date.now = realNow;
      delete globalThis.crypto.getRandomValues;
    }
    return { hash: hash.digest('hex'), rowBytes: rowBytes.reduce((a, b) => a + b, 0) };
  };
  const before = run('conquest', 'frontier', 480);
  const titanfall = run('titanfall', 'harbor', 240);
  const after = run('conquest', 'frontier', 480);
  ok(titanfall.hash !== before.hash, 'the titanfall match differs');
  eq(after.hash, before.hash, 'conquest digest unchanged after a titanfall match (A/B)');
  eq(after.rowBytes, before.rowBytes, 'conquest vehicle row bytes unchanged (A/B)');
  console.log(`  conquest A/B digest ${before.hash.slice(0, 16)} (${before.rowBytes} B of vehicle rows)`);
}

/* ---------------------------------------------------------- frontier bots stay in the play area */
{
  const { attachBots } = await import('../server/bots.js');
  const { surfaceNavigation } = await import('../server/bot-navigation.js');
  Math.random = seeded(0x7174);
  const kills = {};
  const engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('frontier'), world: createMapState('frontier'),
    broadcast: s => { for (const e of s.events) if (e.kind === 'kill') kills[e.w] = (kills[e.w] ?? 0) + 1; } });
  try {
    const policy = engine.mode.policy, b = policy.botBounds();
    eq(b, { ...PLAY_AREA_RULES.frontier }, 'frontier botBounds = play rectangle');
    // Every seeded spawn sits in the open navigation region (no walled pocket that traps a bot).
    const nav = surfaceNavigation(engine.world);
    const labels = new Set([...policy.playArea.spawns.alpha, ...policy.playArea.spawns.bravo].map(s => nav.component[nav.nodeAt(s)]));
    ok(labels.size === 1 && !labels.has(undefined) && !labels.has(-1), `frontier spawns share one navigation region (${[...labels]})`);
    attachBots(engine, 12, { personalitySeed: 3 });
    let outside = 0;
    for (let i = 0; i < 60 * 60; i++) {
      engine.step(TICK_MS);
      if (i % 30) continue;
      for (const p of engine.entities.values()) {
        if (p.state === 'alive' && (p.x < b.minX || p.x > b.maxX || p.z < b.minZ || p.z > b.maxZ)) outside++;
      }
    }
    ok(!kills.restricted && outside === 0, `frontier bots stay inside the play area (restricted ${kills.restricted ?? 0}, outside samples ${outside})`);
  } finally {
    engine.stop();
    Math.random = realRandom;
  }
  const harbor = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('harbor'), world: createMapState('harbor'), broadcast: () => {} });
  ok(harbor.mode.policy.botBounds() === null, 'harbor: no bot bounds (whole map)');
  harbor.stop();
}

/* ---------------------------------------------------------- a normal eject stays under the OOB ceiling */
{
  const events = [];
  const engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('harbor'), world: createMapState('harbor'),
    broadcast: s => { for (const e of s.events) events.push(e); } });
  try {
    engine.addClient('e1', 'Ejector'); engine.addClient('e2', 'Enemy');
    deployHumans(engine, ['e1', 'e2']);
    const p = engine.entities.get('e1'), enemy = engine.entities.get('e2'), policy = engine.mode.policy, titans = engine.vehicles.titans;
    policy.setTitanMeter(p, 1);
    let v = null;
    for (let k = 0; k < 24 && !v; k++) for (const pitch of [-0.5, -0.35, -0.25, -0.18, -0.7]) {
      p.input = { keys: {}, yaw: k * Math.PI / 12, pitch };
      const r = titans.call(p);
      if (r.ok) { v = engine.vehicles.vehicles.get(r.vehicleId); break; }
    }
    ok(v, 'eject: titan called');
    for (let i = 0; i < 300; i++) engine.step(TICK_MS);
    Object.assign(p, { x: v.x, y: v.y, z: v.z - 2.6 });
    engine.vehicles.action(p, { type: 'enter', vehicleId: v.id });
    for (let i = 0; i < 100; i++) engine.step(TICK_MS);
    titans.applyDamage(v, 1e5, 'at', enemy, { point: [v.x, v.y + 2, v.z] });
    engine.step(TICK_MS);
    events.length = 0;
    engine.titanfallIntent('e1', { type: 'eject', value: null });
    const ceiling = policy.playArea.sy + PLAY_AREA_RULES.ceilingPad;
    let apex = -Infinity;
    for (let i = 0; i < 300 && p.state === 'alive'; i++) { engine.step(TICK_MS); apex = Math.max(apex, p.y); }
    ok(apex > ceiling - 3 && apex <= ceiling, `eject apex ${apex.toFixed(2)} just under the ceiling ${ceiling}`);
    ok(!events.some(e => e.kind === 'oob_warning') && p.state === 'alive', 'a normal eject never warns OOB');
  } finally {
    engine.stop();
  }
}

Math.random = realRandom;
/* ------------------------------------------------------------------ fresh-life loadout (playability pass) */
{
  // A pick that reaches the server after the first spawn applies at once while the life is fresh,
  // else it waits for the next deploy (state.loadout is set either way).
  const f = makeEngine('titanfall', 'harbor');
  f.engine.addClient('x1', 'X1');
  deployHumans(f.engine, ['x1']);
  f.step(3);
  const p = f.engine.entities.get('x1');
  ok(p?.state === 'alive', 'fresh-life: spawned');
  ok(f.engine.titanfallIntent('x1', { type: 'loadout', value: packTitanLoadout({ primary: 'shotgun', at: 'archer', tactical: 'cloak', titan: 'titan_northstar' }) }),
    'fresh-life: loadout intent accepted');
  ok(p.owned.includes('shotgun') && !p.owned.includes('rifle'), `fresh-life: the pick applies to the spawn-spot life (${p.owned})`);
  {
    // A thrown frag ends the fresh life: re-sending the pick never refills grenades (or the tactical).
    const frags = p.grenades[0];
    f.engine.applyInput('x1', { seq: 9001, keys: {}, yaw: p.yaw, pitch: 0.4, throwGrenade: true, grenadeType: 0, grenadeCharge: 1 });
    f.step(1);
    f.engine.applyInput('x1', { seq: 9002, keys: {}, yaw: p.yaw, pitch: 0.4 });
    f.step(10);
    ok(p.grenades[0] === frags - 1 && p.shotSeq === p.tfLife.shotSeq, `fresh-life: frag thrown without a shot (${frags} -> ${p.grenades[0]})`);
    f.engine.titanfallIntent('x1', { type: 'loadout', value: packTitanLoadout({ primary: 'smg', at: 'archer', tactical: 'stim', titan: 'titan_ion' }) });
    ok(p.grenades[0] === frags - 1 && p.owned.includes('shotgun'), 'fresh-life: a pick after a throw keeps the kit (no grenade refill)');
  }
  p.x += 3;
  ok(f.engine.titanfallIntent('x1', { type: 'loadout', value: packTitanLoadout({ primary: 'lmg', at: 'archer', tactical: 'cloak', titan: 'titan_northstar' }) }),
    'fresh-life: second loadout intent accepted');
  ok(p.owned.includes('shotgun') && !p.owned.includes('lmg'), 'fresh-life: a life that left its spawn spot keeps its kit');
  f.engine.stop();
}

/* ------------------------------------------------------------------ deploy before spawn (§3.4 deploy) */
{
  const { attachBots } = await import('../server/bots.js');
  Math.random = seeded(0xdeb1);
  const f = makeEngine('titanfall', 'harbor');
  const bots = attachBots(f.engine, 6, { personalitySeed: 5 });
  try {
    f.step(20);
    ok([...f.engine.entities.values()].every(e => e.bot && e.state === 'alive'), 'deploy: bots spawn on their own');
    // Mid-match join: unspawned (no die/kill/respawn event, no death counted) until DEPLOY, however long.
    f.events.length = 0;
    f.engine.addClient('j1', 'Joiner');
    const j = f.engine.entities.get('j1');
    f.step(Math.ceil(10_000 / TICK_MS));
    const row = () => f.last.players.find(r => r.id === 'j1');
    ok(j.state === 'dead' && row().state === 'dead', 'mid-match join: not spawned without DEPLOY');
    const staged = decodeTitanfallPlayer(row());
    ok(staged.deploy && staged.staged && !staged.deployQueued, 'mid-match join: tf deploy + staged');
    ok(!f.events.some(e => (e.kind === 'die' || e.kind === 'respawn') && e.id === 'j1') && !f.events.some(e => e.kind === 'kill' && e.victim === 'j1'),
      'mid-match join: no death or respawn event');
    eq(j.deaths, 0, 'mid-match join: no death counted');
    const pick = packTitanLoadout({ primary: 'shotgun', at: 'archer', tactical: 'grapple', titan: 'titan_scorch' });
    ok(f.engine.titanfallIntent('j1', { type: 'deploy', value: pick }), 'mid-match join: DEPLOY accepted');
    f.step(1);
    ok(j.state === 'alive' && j.hp === 100, 'mid-match join: spawned on DEPLOY');
    ok(j.owned.includes('shotgun') && j.owned.includes('archer') && j.pilotTac?.kind === 'grapple', `mid-match join: first life runs the pick (${j.owned})`);
    eq(f.policy.titanTypeFor(j), 'titan_scorch', 'mid-match join: titan pick stored');
    ok(f.events.some(e => e.kind === 'respawn' && e.id === 'j1') && j.spawnProtected, 'mid-match join: a protected respawn');
    // Staged idle join: the timeout clock starts with the first input (map load), then auto-deploys.
    f.engine.addClient('j2', 'Idle');
    f.step(Math.floor(DEPLOY_RULES.timeoutMs / TICK_MS) + 30);
    eq(f.engine.entities.get('j2').state, 'dead', 'idle join: still loading (no input) is held past the timeout');
    f.engine.applyInput('j2', { seq: 1, keys: {}, yaw: 0, pitch: 0 });
    f.step(Math.floor(DEPLOY_RULES.timeoutMs / TICK_MS) - 2);
    eq(f.engine.entities.get('j2').state, 'dead', 'idle join: unspawned before the timeout');
    f.step(4);
    eq(f.engine.entities.get('j2').state, 'alive', 'idle join: auto-deployed after the timeout');
    // Bot takeover: the human gets the loadout screen, the bot body leaves the field, its titan stays.
    const victim = f.engine.entities.get(bots.brains.at(-1).id);
    if (victim.state !== 'alive') { f.engine.respawnPlayer(victim); f.policy.onPlayerRespawn(victim); }
    const titan = landedTitan(f, victim);
    ok(victim.state === 'alive', 'takeover: the bot is alive');
    const before = f.engine.entities.size;
    ok(bots.takeover('h1', 'Taker'), 'takeover');
    const h = f.engine.entities.get('h1');
    ok(h && !h.bot && h.state === 'dead' && f.engine.entities.size === before, 'takeover: human held for DEPLOY');
    ok(f.titans.ownedBy('h1') === titan && titan.hp > 0, 'takeover: the titan stays and is handed over');
    ok(!f.events.some(e => e.kind === 'kill' && e.victim === 'h1'), 'takeover: no kill event');
    f.step(Math.ceil(5000 / TICK_MS));
    eq(h.state, 'dead', 'takeover: no spawn without DEPLOY');
    deployHumans(f.engine, ['h1']);
    eq(h.state, 'alive', 'takeover: spawned on DEPLOY');
    // Rematch: humans go back to the loadout screen, bots respawn at once.
    f.policy.reset();
    ok(['j1', 'j2', 'h1'].every(id => f.engine.entities.get(id).state === 'dead'), 'rematch: humans held for DEPLOY');
    ok([...f.engine.entities.values()].filter(e => e.bot).every(e => e.state === 'alive'), 'rematch: bots alive');
    deployHumans(f.engine, ['j1', 'j2', 'h1']);
    ok(['j1', 'j2', 'h1'].every(id => f.engine.entities.get(id).state === 'alive'), 'rematch: deployed');
    // Bots never wait for DEPLOY.
    const bot = [...f.engine.entities.values()].find(e => e.bot && e.state === 'alive');
    f.engine.killPlayer(bot, null, 'world', false);
    f.step(Math.ceil(4000 / TICK_MS) + 2);
    eq(bot.state, 'alive', 'bots respawn on the plain timer');
  } finally { bots.dispose?.(); f.engine.stop(); Math.random = realRandom; }
  // Other modes are untouched: a joining human spawns at once and respawns on the timer.
  for (const [mode, map] of [['tdm', 'harbor'], ['fun', 'canyon']]) {
    const g = makeEngine(mode, map);
    g.engine.addClient('m1', 'M1'); g.engine.addClient('m2', 'M2');
    const m1 = g.engine.entities.get('m1');
    eq(m1.state, 'alive', `${mode}: spawned on join`);
    ok(g.engine.titanfallIntent('m1', { type: 'deploy', value: 0 }) === false, `${mode}: no deploy intent`);
    g.engine.killPlayer(m1, g.engine.entities.get('m2'), 'rifle', false);
    g.step(Math.ceil((m1.respawnAt - g.engine.now) / TICK_MS) + 2);
    eq(m1.state, 'alive', `${mode}: timed respawn without deploy`);
    g.engine.stop();
  }
}

console.log(`Titanfall mode: ${checks} checks passed (lobby on harbor/canyon/frontier, play-area spawns, tf/tfs only in titanfall, one stringify per tick, attrition scoring, score/time limit and draw, 4 s respawn, deploy before spawn, capacity and bay cap, spawn refusal and avoidance, OOB, §1.1 lifecycle, conquest invariants and A/B digest).`);
