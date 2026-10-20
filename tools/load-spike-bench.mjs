// Load-spike bench (docs/conquest.md, Server load): the synchronous blocks a
// room puts on the server's one event loop, where every room, socket and
// player ping waits for them. In-process (LobbyManager with fake transport
// callbacks, no sockets, no browser), per scenario:
//
//  - room start: lobby create + start with the host and N bots, `--repeat`
//    times on fresh rooms (median and max): wall ms, the spawn picks in it and
//    the sight rays they cast;
//  - first tick and steady ticks: the room stepped for `--seconds` (tick
//    p50/p95/p99/max, and the bot hook's p95/max).
//
// The boot warm-ups the server runs before and after listening go first
// (server/boot-warmup.js; on an older tree the old Frontier warm-up), so the
// numbers are a running server's; `--cold` skips them.
//
//   node tools/load-spike-bench.mjs                       # all scenarios
//   node tools/load-spike-bench.mjs --only conquest --seconds 60 --repeat 5
//   taskpolicy -b node tools/load-spike-bench.mjs         # macOS efficiency cores: a slow-host stand-in
//   node tools/load-spike-bench.mjs --json out.json
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { LobbyManager } from '../server/lobby.js';
import { SpawnSelector } from '../server/sim/spawn.js';
import { CONQUEST_CONTRACT_VERSION } from '../shared/conquest-contract.js';
import { TITANFALL_CONTRACT_VERSION } from '../shared/titan-contract.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const SECONDS = Number(option('seconds', 30));
const REPEAT = Math.max(1, Number(option('repeat', 3)));
const ONLY = option('only', null)?.split(',');
const JSON_OUT = option('json', null);
const COLD = args.includes('--cold');

const SCENARIOS = [
  { id: 'conquest', mode: 'conquest', map: 'frontier', bots: 15 },
  { id: 'tdm', mode: 'tdm', map: 'harbor', bots: 31 },
  { id: 'fun', mode: 'fun', map: 'canyon', bots: 15 },
].filter(s => !ONLY || ONLY.includes(s.id));

const quantile = (list, q) => {
  if (!list.length) return null;
  const s = list.slice().sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2);
};

async function warmUp() {
  const started = performance.now();
  try {
    const warm = await import('../server/boot-warmup.js');
    warm.prepareFrontier({ structural: true });
    await warm.warmGroundGrids(undefined, { sliceMs: 1000 });
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    // A tree from before server/boot-warmup.js: its server/index.js warm-up.
    const { createMapState, getMapMeta } = await import('../shared/worlddata.js');
    const { surfaceNavigation } = await import('../server/bot-navigation.js');
    const { roadGraph } = await import('../server/bot-vehicle-driving.js');
    const { prepareStructureTemplate } = await import('../server/sim/structure.js');
    const world = createMapState('frontier');
    world.serializeWorld(); world.mapFrame(); surfaceNavigation(world);
    roadGraph({ mapMeta: getMapMeta('frontier') }); prepareStructureTemplate(world);
  }
  return performance.now() - started;
}

// Spawn picks and the sight rays they cast, counted on the shared prototype.
const counters = { picks: 0, rays: 0, pickMs: 0 };
{
  const los = SpawnSelector.prototype.enemyHasSpawnLos;
  SpawnSelector.prototype.enemyHasSpawnLos = function (...a) { counters.rays++; return los.apply(this, a); };
  const pick = SpawnSelector.prototype.pick;
  SpawnSelector.prototype.pick = function (...a) {
    const t = performance.now();
    try { return pick.apply(this, a); } finally { counters.picks++; counters.pickMs += performance.now() - t; }
  };
}

const lobby = new LobbyManager({ sendJson: () => true, sendFrame: () => true, closeClient: () => {} });
let hostSeq = 0;
async function startRoom({ mode, map, bots }) {
  const host = { id: `bench-host-${++hostSeq}`, mapCache: [], contract: CONQUEST_CONTRACT_VERSION, titanfall: TITANFALL_CONTRACT_VERSION };
  await lobby.create(host, 'Host', bots, mode, map);
  const room = host.room;
  if (!room) throw new Error(`could not create ${mode}/${map}`);
  room.members.get(host.id).ready = true;
  Object.assign(counters, { picks: 0, rays: 0, pickMs: 0 });
  const started = performance.now();
  if (lobby.start(host) !== true) throw new Error(`could not start ${mode}/${map}`);
  const startMs = performance.now() - started;
  room.engine.stop();
  return { host, room, startMs, picks: counters.picks, rays: counters.rays, pickMs: counters.pickMs };
}

function stepRoom(room, seconds) {
  const engine = room.engine, ticks = [], hooks = [];
  let hookMs = 0;
  const wrapped = engine.tickHooks.map(hook => (dt) => { const t = performance.now(); try { return hook(dt); } finally { hookMs += performance.now() - t; } });
  engine.tickHooks.splice(0, engine.tickHooks.length, ...wrapped);
  const count = Math.round(seconds * 1000 / engine.intervalMs);
  for (let i = 0; i < count; i++) {
    hookMs = 0;
    const t = performance.now();
    engine.step(engine.intervalMs);
    ticks.push(performance.now() - t); hooks.push(hookMs);
  }
  return { ticks, hooks };
}

const warmMs = COLD ? 0 : await warmUp();
const report = { seconds: SECONDS, repeat: REPEAT, cold: COLD, warmMs: Math.round(warmMs), scenarios: [] };
for (const scenario of SCENARIOS) {
  const starts = [];
  let last = null;
  for (let r = 0; r < REPEAT; r++) {
    if (last) lobby.leave(last.host, { reconnectable: false });
    last = await startRoom(scenario);
    starts.push(last);
  }
  const { ticks, hooks } = stepRoom(last.room, SECONDS);
  lobby.leave(last.host, { reconnectable: false });
  const row = {
    ...scenario,
    startMs: { median: quantile(starts.map(s => s.startMs), 0.5), max: quantile(starts.map(s => s.startMs), 1) },
    spawnPicks: starts[0].picks,
    spawnPickMs: quantile(starts.map(s => s.pickMs), 0.5),
    spawnRays: quantile(starts.map(s => s.rays), 0.5),
    firstTickMs: +ticks[0].toFixed(2),
    tick: { p50: quantile(ticks.slice(1), 0.5), p95: quantile(ticks.slice(1), 0.95), p99: quantile(ticks.slice(1), 0.99), max: quantile(ticks.slice(1), 1) },
    bots: { p95: quantile(hooks.slice(1), 0.95), max: quantile(hooks.slice(1), 1) },
  };
  report.scenarios.push(row);
  console.log(`${scenario.mode}/${scenario.map} ${scenario.bots} bots: start ${row.startMs.median} ms (max ${row.startMs.max}),`
    + ` ${row.spawnPicks} spawn picks ${row.spawnPickMs} ms / ${row.spawnRays} rays, first tick ${row.firstTickMs} ms,`
    + ` ticks p50 ${row.tick.p50} p95 ${row.tick.p95} p99 ${row.tick.p99} max ${row.tick.max} ms, bots p95 ${row.bots.p95} max ${row.bots.max} ms`);
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
lobby.stop?.();
process.exit(0);
