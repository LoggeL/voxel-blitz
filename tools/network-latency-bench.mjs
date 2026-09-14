// Network latency benchmark against a real server: N headless members in one
// live room with bots, 60 Hz inputs and a 200 ms JSON ping cadence. Reports
// client-measured RTT percentiles, room tick timing, process load, JSON bytes
// per tick and the bytes that actually crossed the socket.
//
//   node tools/network-latency-bench.mjs
//   HUMANS=16 BOTS=16 MODE=tdm MAP=dust2 DURATION_MS=10000 node tools/network-latency-bench.mjs
//   NO_DEFLATE=1 node tools/network-latency-bench.mjs   # members refuse compression
//
// Loopback RTTs here include the bench process's own asynchronous inflate of
// each tick; browsers decompress in their network process instead.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';

import { startServer, stopServer } from './lib/server-process.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HUMANS = Math.max(1, Number(process.env.HUMANS) || 8);
const BOTS = Math.max(0, Number(process.env.BOTS) || 8);
const MODE = process.env.MODE || 'fun';
const MAP = process.env.MAP || 'foundry';
const DURATION_MS = Math.max(2000, Number(process.env.DURATION_MS) || 12_000);
const COMPRESS = !process.env.NO_DEFLATE;
const PING_INTERVAL_MS = 200;
const INPUT_HZ = 60;

function connect(port, firstFrame) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { perMessageDeflate: COMPRESS });
    const client = { ws, welcome: null, rtts: [], payloadBytes: 0, ticks: 0, diagnostics: null, seq: 0, pending: new Map() };
    ws.on('open', () => ws.send(JSON.stringify(firstFrame)));
    ws.on('error', reject);
    ws.on('message', (data, isBinary) => {
      client.payloadBytes += data.length;
      if (isBinary) return;
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.t === 'welcome') { client.welcome = msg; resolvePromise(client); }
      else if (msg.t === 'tick') client.ticks++;
      else if (msg.t === 'pong') {
        const sentAt = client.pending.get(msg.nonce);
        if (sentAt !== undefined) { client.rtts.push(performance.now() - sentAt); client.pending.delete(msg.nonce); }
        if (msg.diagnostics) client.diagnostics = msg.diagnostics;
      } else if (msg.t === 'error') reject(new Error(msg.msg));
    });
  });
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);
}

function inputFrame(client, seconds) {
  const yaw = seconds % (Math.PI * 2) - Math.PI;
  return {
    t: 'input', seq: ++client.seq,
    keys: { f: true, b: false, l: Math.sin(seconds) > 0, r: false, jump: Math.random() < 0.02,
      sprint: true, crouch: false, prone: false, interact: false },
    yaw, pitch: 0, viewYaw: yaw, weapon: 0, wantFire: Math.sin(seconds * 3) > 0.5, wantAds: false,
    scopeZoom: 0, reload: false, reloadId: 0, medkitId: 0, cancelMedkit: false, viewAge: 100,
  };
}

const server = startServer({ cwd: ROOT, failureContext: 'network latency bench', ringBuffer: 4_000 });
try {
  const port = await server.port;
  const host = await connect(port, { t: 'create', name: 'host', bots: BOTS, gameMode: MODE, map: MAP });
  const clients = [host];
  for (let i = 1; i < HUMANS; i++) {
    clients.push(await connect(port, { t: 'join', name: 'p' + i, lobby: host.welcome.lobby.code }));
  }
  for (const client of clients) client.ws.send(JSON.stringify({ t: 'ready', value: true }));
  await new Promise((r) => setTimeout(r, 300));
  host.ws.send(JSON.stringify({ t: 'start' }));
  await new Promise((r) => setTimeout(r, 1500));

  const startedAt = performance.now();
  for (const client of clients) {
    client.payloadBytes = 0;
    client.ticks = 0;
    client.wireStart = client.ws._socket.bytesRead;
  }
  const timers = [];
  for (const client of clients) {
    let nonce = 0;
    timers.push(setInterval(() => {
      client.pending.set(++nonce, performance.now());
      client.ws.send(JSON.stringify({ t: 'ping', nonce, diagnostics: true }));
    }, PING_INTERVAL_MS));
    timers.push(setInterval(() => {
      client.ws.send(JSON.stringify(inputFrame(client, performance.now() / 1000)));
    }, 1000 / INPUT_HZ));
  }
  await new Promise((r) => setTimeout(r, DURATION_MS));
  for (const timer of timers) clearInterval(timer);

  const seconds = (performance.now() - startedAt) / 1000;
  const rtts = clients.flatMap((client) => client.rtts);
  const ticks = Math.max(1, host.ticks);
  const perClient = (total) => Math.round(total / clients.length / ticks);
  console.log(JSON.stringify({
    humans: HUMANS, bots: BOTS, mode: MODE, map: MAP, compression: COMPRESS, seconds: +seconds.toFixed(1),
    rttMs: { samples: rtts.length, p50: percentile(rtts, 0.5), p90: percentile(rtts, 0.9), p99: percentile(rtts, 0.99) },
    serverRttMs: host.diagnostics?.serverRttMs ?? null,
    tick: host.diagnostics?.tick ?? null,
    process: host.diagnostics?.process ?? null,
    ticksPerSecond: +(host.ticks / seconds).toFixed(1),
    jsonBytesPerTickPerMember: perClient(clients.reduce((sum, client) => sum + client.payloadBytes, 0)),
    wireBytesPerTickPerMember: perClient(clients.reduce((sum, client) => sum + client.ws._socket.bytesRead - client.wireStart, 0)),
  }, null, 2));
  for (const client of clients) client.ws.close();
} finally {
  await stopServer(server);
}
