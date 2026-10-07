// Conquest scale gate on the real Frontier map with 16 bots and the full fleet
// (spec §3.3 budgets, F4): average vehicle row <= 260 B, whole tick <= 27 KB,
// tick p95 <= 10 ms, match.conquest <= 400 B. Every coordinate comes from
// mapMeta, never from constants.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { raycastVoxels } from '../shared/raycast.js';
import { KillcamTerrain } from '../public/js/player/killcam-terrain.js';

const BUDGET = Object.freeze({ rowBytes: 260, tickBytes: 27 * 1024, tickP95Ms: 10, matchConquestBytes: 400 });
const seconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.slice(10)) || 120;

const importedMemory = process.memoryUsage(), start = performance.now(), world = createMapState('frontier');
const generationMs = performance.now() - start, bytes = world.serializeWorld();
const meta = getMapMeta('frontier'), { sx, sy, sz } = meta.dimensions;
assert.strictEqual(world.meta, meta, 'the world and the engine share one mapMeta');
const worldMemory = process.memoryUsage();
let snapshot = null;
const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: s => { snapshot = s; } });
assert.equal(game.vehicles.vehicles.size, meta.conquest.vehicleSpawns.length, 'every fleet spawn is a hull');
const bots = attachBots(game, 16), positions = new Map([...game.entities].map(([id, p]) => [id, { x: p.x, z: p.z }]));

const ticks = Math.round(seconds * 1000 / TICK_MS), durations = [];
let tickBytes = 0, rowBytes = 0, rows = 0, matchBytes = 0, matchMax = 0, tickMax = 0;
const wallStart = performance.now();
for (let n = 0; n < ticks; n++) {
  const t = performance.now();
  game.step(TICK_MS);
  durations.push(performance.now() - t);
  // Wire sizes are measured outside the timed tick.
  const size = JSON.stringify(snapshot).length;
  tickBytes += size; tickMax = Math.max(tickMax, size);
  for (const row of snapshot.vehicles) { rowBytes += JSON.stringify(row).length; rows++; }
  const conquest = JSON.stringify(snapshot.match?.conquest ?? {}).length;
  matchBytes += conquest; matchMax = Math.max(matchMax, conquest);
}
const simulationMs = performance.now() - wallStart;

const moved = [...game.entities].map(([id, p]) => ({ id, travel: Math.round(Math.hypot(p.x - positions.get(id).x, p.z - positions.get(id).z)),
  x: Math.round(p.x), z: Math.round(p.z), state: p.state, seat: p.vehicleSeatId ?? null }));
const flags = game.mode.matchSnapshot().conquest.flags;
durations.sort((a, b) => a - b);
const report = {
  map: meta.id, dimensions: meta.dimensions, seconds, bots: 16, hulls: game.vehicles.vehicles.size,
  generationMs: Math.round(generationMs), payloadBytes: bytes.byteLength, decodedBytes: sx * sy * sz, simulationMs: Math.round(simulationMs),
  p50TickMs: +durations[Math.floor(ticks * 0.5)].toFixed(2), p95TickMs: +durations[Math.floor(ticks * 0.95)].toFixed(2), maxTickMs: +durations.at(-1).toFixed(2),
  avgTickBytes: Math.round(tickBytes / ticks), maxTickBytes: tickMax, avgVehicleRowBytes: +(rowBytes / Math.max(1, rows)).toFixed(1),
  avgMatchConquestBytes: Math.round(matchBytes / ticks), maxMatchConquestBytes: matchMax,
  importedMemory, worldMemory, memory: process.memoryUsage(),
  flags, moved,
};
console.log(JSON.stringify(report, null, 2));

assert(report.avgVehicleRowBytes <= BUDGET.rowBytes, `average vehicle row ${report.avgVehicleRowBytes} B > ${BUDGET.rowBytes}`);
assert(report.avgTickBytes <= BUDGET.tickBytes, `average tick ${report.avgTickBytes} B > ${BUDGET.tickBytes}`);
assert(report.p95TickMs <= BUDGET.tickP95Ms, `tick p95 ${report.p95TickMs} ms > ${BUDGET.tickP95Ms}`);
assert(report.maxMatchConquestBytes <= BUDGET.matchConquestBytes, `match.conquest ${report.maxMatchConquestBytes} B > ${BUDGET.matchConquestBytes}`);
assert(moved.filter(p => p.travel > 100).length >= 8, 'at least eight bots progress over 100 voxels');
assert(flags.some(f => Array.isArray(f) ? f[2] : f.owner), 'bots hold at least one objective');

// Large-world block deltas, rays and killcam terrain use the real dimensions.
const x = sx - 20, y = sy - 6, z = sz - 20;
assert.equal(world.getBlock(x, y, z), 0, 'the probe cell is open sky');
world.setBlock(x, y, z, 3); game.pushBlockDelta(x, y, z, 3);
assert.equal(game.tickBlocks.at(-1).i, (y * sz + z) * sx + x);
assert.equal(raycastVoxels((a, b, c) => world.getBlock(a, b, c), x - 1.5, y + 0.5, z + 0.5, 1, 0, 0, 5)?.x, x);
const late = world.serializeWorld(), terrain = new KillcamTerrain(late);
assert.equal(terrain.getBlock(x, y, z), 3);
const killcam = new KillcamTerrain(bytes); killcam.record({ blocks: game.tickBlocks, serverNow: game.now });
assert.equal(killcam.getBlock(x, y, z), 3);
const before = [...game.entities.values()][0]; game.forceRespawn(before);
assert(before.x > 0 && before.x < sx && before.z > 0 && before.z < sz, 'respawn inside the large world');

bots.dispose(); game.stop();
console.log(`Conquest scale: ${report.hulls} hulls, 16 bots, ${seconds} s; row ${report.avgVehicleRowBytes} B, tick ${report.avgTickBytes} B, p95 ${report.p95TickMs} ms, match.conquest max ${report.maxMatchConquestBytes} B passed`);
