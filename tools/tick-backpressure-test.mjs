// Tick backpressure contract (server/protocol/tick-backlog.js): a client whose
// earlier snapshots are still in flight skips ticks, and the skipped ticks'
// deltas (voxel replacements, block damage rows, events) ride along with the
// next snapshot it is sent. Part 1 drives the coalescer with a fake slow socket
// and proves the client ends with exactly the state and event stream of a
// client that received every tick. Part 2 stalls a real uncompressed client
// until the real coalescer holds four seconds of simulation: it must not be
// dropped at the 4 MB queue limit, and must resume fresh snapshots at once.
// Kernel TCP buffer sizes differ, so elapsed wall time alone proves no pressure.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { mulberry32 } from '../shared/noise.js';
import { MAX_TICKS_IN_FLIGHT, coalesceTick, holdTickDeltas, mergeHeldDeltas, tickSent, tickSettled } from '../server/protocol/tick-backlog.js';
import { startServer, stopServer } from './lib/server-process.mjs';

// --------------------------------------------------------------------------
// Part 1: fake slow socket, no delta lost.
// --------------------------------------------------------------------------
{
  const rng = mulberry32(7);
  const pick = n => Math.floor(rng() * n);
  const ticks = [];
  // Voxel i is (i % 4, i / 16, (i / 4) % 4). Like GameEngine.pushBlockDelta,
  // replacing a damaged voxel also emits its zero-progress damage row.
  const coords = i => ({ x: i % 4, y: Math.floor(i / 16), z: Math.floor(i / 4) % 4 });
  const damaged = new Set();
  for (let n = 0; n < 2000; n++) {
    const blockDamage = [];
    const blocks = Array.from({ length: pick(3) }, () => ({ i: pick(48), v: pick(3) }));
    for (const { i, v } of blocks) if (damaged.delete(i)) blockDamage.push({ ...coords(i), v, progress: 0 });
    for (let k = pick(3); k > 0; k--) {
      const i = pick(48), progress = rng() < 0.3 ? 0 : rng();
      blockDamage.push({ ...coords(i), v: 1 + pick(2), progress });
      if (progress > 0) damaged.add(i); else damaged.delete(i);
    }
    const events = Array.from({ length: pick(3) }, (_, k) => ({ kind: 'shoot', id: `p${pick(4)}`, n, k }));
    ticks.push({ t: 'tick', now: n * 16.667, players: [{ id: 'p0', x: n }], blocks, blockDamage, events });
  }
  // The client model mirrors NetClient._onTick: replacements clear damage on
  // their voxel, then damage rows apply (zero progress or air clears).
  const apply = (state, snap) => {
    for (const { i, v } of snap.blocks) { state.blocks.set(i, v); const c = coords(i); state.damage.delete(`${c.x},${c.y},${c.z}`); }
    for (const row of snap.blockDamage) {
      const key = `${row.x},${row.y},${row.z}`;
      if (row.progress <= 0 || row.v === 0) state.damage.delete(key); else state.damage.set(key, row.progress);
    }
    state.events.push(...snap.events);
    state.now = snap.now;
    state.x = snap.players[0].x;
  };
  const fresh = () => ({ blocks: new Map(), damage: new Map(), events: [], now: null, x: null });
  const expected = fresh();
  for (const tick of ticks) apply(expected, tick);

  const client = {};
  const received = fresh();
  const inFlight = [];
  let sent = 0, skipped = 0, stalledFor = 0;
  for (const tick of ticks) {
    // The socket drains erratically: sometimes not at all for a long while.
    if (stalledFor > 0) stalledFor--;
    else if (rng() < 0.02) stalledFor = 20 + pick(200);
    else while (inFlight.length && rng() < 0.7) { inFlight.shift(); tickSettled(client); }
    const out = coalesceTick(client, tick);
    if (!out) { skipped++; continue; }
    assert((client.ticksInFlight ?? 0) < MAX_TICKS_IN_FLIGHT, 'never more than the in-flight cap queued');
    tickSent(client); inFlight.push(out); sent++;
    apply(received, JSON.parse(JSON.stringify(out)));
  }
  // The stream may end with deltas held: the next tick (any state) carries them.
  while (inFlight.length) { inFlight.shift(); tickSettled(client); }
  const last = { ...ticks.at(-1), blocks: [], blockDamage: [], events: [] };
  apply(expected, last);
  apply(received, coalesceTick(client, last));
  assert(skipped > 100 && sent > 100, `the fake socket both lagged and drained (${sent} sent, ${skipped} held)`);
  assert.deepEqual([...received.blocks].sort((a, b) => a[0] - b[0]), [...expected.blocks].sort((a, b) => a[0] - b[0]), 'voxel replacements match');
  assert.deepEqual([...received.damage].sort(), [...expected.damage].sort(), 'block damage matches');
  assert.deepEqual(received.events, expected.events, 'every event arrives once, in order');
  assert.equal(received.now, expected.now, 'state fields are the newest');
  // A merged snapshot keeps the newest state and the full delta order.
  const held = holdTickDeltas(null, ticks[0]);
  const merged = mergeHeldDeltas(held, ticks[1]);
  assert.equal(merged.now, ticks[1].now);
  assert.deepEqual(merged.events, [...ticks[0].events, ...ticks[1].events]);
  assert.deepEqual(merged.blocks, [...ticks[0].blocks, ...ticks[1].blocks]);
  console.log(`fake slow socket: ${sent} snapshots sent, ${skipped} ticks held and merged, state and ${expected.events.length} events identical`);
}

// --------------------------------------------------------------------------
// Part 2: a real client stops reading until observed backpressure, then recovers.
// --------------------------------------------------------------------------
const MIN_STALL_MS = 8000;
const HELD_SIMULATION_MS = 4000;
const RECOVERY_MS = 3000;
const server = startServer({ entry: 'tools/lib/tick-backpressure-fixture.mjs', ipc: true });
let ws;
let phase = 'join', closed = null, socketError = null, ticks = 0, lastNow = 0;
let resumeAt = null, pausedAt = null, pressure = null, pong = null;
const after = [];
const messageCounts = {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeout, label) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (closed !== null) throw new Error(`${label}: socket closed with ${closed}`);
    if (socketError) throw socketError;
    if (performance.now() >= deadline) throw new Error(`${label}: timeout in phase ${phase}`);
    await Promise.race([sleep(20), server.unexpectedExit]);
  }
}
try {
  const port = await server.port;
  ws = new WebSocket(`ws://127.0.0.1:${port}/`, { perMessageDeflate: false });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: 'Stall', bots: 12, gameMode: 'fun', map: 'foundry' })));
  ws.on('close', code => { closed = code; });
  ws.on('error', error => { socketError = error; });
  ws.on('message', (data, binary) => {
    if (binary) return;
    const msg = JSON.parse(data.toString());
    messageCounts[msg.t] = (messageCounts[msg.t] ?? 0) + 1;
    if (msg.t === 'welcome' && phase === 'join') {
      phase = 'start';
      ws.send(JSON.stringify({ t: 'ready', value: true }));
      ws.send(JSON.stringify({ t: 'start' }));
    }
    if (msg.t === 'pong' && msg.nonce === 1 && msg.diagnostics) pong = msg.diagnostics;
    if (msg.t !== 'tick') return;
    ticks++;
    if (phase === 'resumed') after.push({ now: msg.now, at: performance.now() });
    lastNow = msg.now;
  });
  await waitFor(() => ticks > 30, 10_000, 'initial snapshots');
  phase = 'stall';
  pausedAt = performance.now();
  // Use the WebSocket API: a receiver drain may undo a raw _socket.pause().
  ws.pause();
  const pressureDeadline = pausedAt + 25_000;
  do {
    await Promise.race([sleep(100), server.unexpectedExit]);
    pressure = await server.request('transport');
    assert.equal(closed, null, `the stalled client stays connected (closed with ${closed})`);
    assert(pressure.ticksInFlight <= MAX_TICKS_IN_FLIGHT, 'real transport obeys the in-flight cap');
    assert(performance.now() < pressureDeadline,
      `paused client reaches backpressure: ${JSON.stringify(pressure)}`);
    // This measures actual held simulation time, not an assumed tick rate or
    // kernel send-buffer capacity. The 4 s skipped-state contract stays intact.
  } while (performance.now() - pausedAt < MIN_STALL_MS || pressure.heldTicks * pressure.tickMs < HELD_SIMULATION_MS);
  assert(pressure.skippedTicks >= pressure.heldTicks, 'real snapshots were coalesced while paused');
  resumeAt = performance.now();
  phase = 'resumed';
  ws.resume();
  // Send this independently of the next snapshot and require its response:
  // an absent pong must never count as a measured empty send queue.
  ws.send(JSON.stringify({ t: 'ping', nonce: 1, diagnostics: true }));
  await Promise.race([sleep(RECOVERY_MS), server.unexpectedExit]);
  await waitFor(() => pong !== null, 300, 'recovery diagnostic pong');
  assert.equal(closed, null, `the stalled client stays connected (closed with ${closed})`);
  const firstFresh = after.find(row => row.now >= pressure.now);
  assert(firstFresh && firstFresh.at - resumeAt < 1000,
    `current state resumes within 1 s (${firstFresh ? Math.round(firstFresh.at - resumeAt) : 'no fresh snapshot'} ms)`);
  const live = after.filter(row => row.at - resumeAt > 1000 && row.at - resumeAt <= RECOVERY_MS);
  assert(live.length > 60, `fresh snapshots stream after the stall (${live.length} in the last 2 s)`);
  const gaps = after.slice(1).map((row, i) => row.now - after[i].now);
  assert(Math.max(...gaps) >= HELD_SIMULATION_MS, 'the stall is skipped over, not replayed tick by tick');
  const recovered = await server.request('transport');
  assert(pong.queuedBytes < 512 * 1024, `the measured send queue is small after recovery (${pong.queuedBytes} B)`);
  assert(recovered.queuedBytes < 512 * 1024, `the send queue stays small after recovery (${recovered.queuedBytes} B)`);
  console.log(`stalled client: connected after a ${Math.round(resumeAt - pausedAt)} ms stall, ${pressure.heldTicks} ticks coalesced, ${after.length} ticks after resume, last server time ${lastNow}, queue ${recovered.queuedBytes} B`);
} catch (error) {
  console.error('backpressure diagnostics:', JSON.stringify({ phase, closed, ticks, lastNow, messageCounts,
    pausedAt, resumeAt, after: after.length, first: after[0], last: after.at(-1), pressure, pong,
    websocketPaused: ws?.isPaused, socketPaused: ws?._socket?.isPaused(), readableLength: ws?._socket?.readableLength }));
  console.error(server.stdout, server.stderr);
  throw error;
} finally {
  ws?.terminate();
  await stopServer(server);
}
console.log('tick backpressure tests passed');
