// Transport contract: tick snapshots are serialized once per room and reach
// every member byte-for-byte identical apart from the member's own player row,
// the only one that keeps the owner-only fields (OWNER_ONLY_FIELDS), whether or
// not that member negotiated permessage-deflate. Compressing members must receive a small fraction of the
// JSON payload on the wire, because consecutive snapshots share one deflate
// context; members without compression receive plain frames unchanged.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';

import { startServer, stopServer } from './lib/server-process.mjs';
import { OWNER_ONLY_FIELDS } from '../server/protocol/snapshot.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TICKS_MEASURED = 40;
const TICKS_WARMUP = 10;
const FRAME_TIMEOUT_MS = 10_000;

function connect(port, firstFrame, { compress }) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { perMessageDeflate: compress });
    const client = { ws, welcome: null, ticks: [], wireStart: 0, payloadBytes: 0, waiters: [] };
    const timer = setTimeout(() => reject(new Error('welcome timeout')), FRAME_TIMEOUT_MS);
    ws.on('open', () => ws.send(JSON.stringify(firstFrame)));
    ws.on('error', reject);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString('utf8');
      const msg = JSON.parse(text);
      if (msg.t === 'welcome') {
        clearTimeout(timer);
        client.welcome = msg;
        resolvePromise(client);
        return;
      }
      if (msg.t === 'error') reject(new Error(msg.msg));
      if (msg.t !== 'tick') return;
      if (client.ticks.length === TICKS_WARMUP) client.wireStart = ws._socket.bytesRead;
      if (client.ticks.length >= TICKS_WARMUP && client.ticks.length < TICKS_MEASURED) {
        client.payloadBytes += Buffer.byteLength(text);
      }
      if (client.ticks.length === TICKS_MEASURED) client.wireEnd = ws._socket.bytesRead;
      client.ticks.push({ now: msg.now, text });
      for (const waiter of client.waiters.splice(0)) waiter();
    });
  });
}

function waitForTicks(client, count) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`only ${client.ticks.length} ticks arrived`)), FRAME_TIMEOUT_MS);
    const check = () => {
      if (client.ticks.length > count) { clearTimeout(timer); resolvePromise(); }
      else client.waiters.push(check);
    };
    check();
  });
}

const server = startServer({ cwd: ROOT, failureContext: 'network transport' });
try {
  const port = await server.port;
  const host = await connect(port, { t: 'create', name: 'deflate', bots: 6, gameMode: 'fun', map: 'foundry' }, { compress: true });
  const plain = await connect(port, { t: 'join', name: 'plain', lobby: host.welcome.lobby.code }, { compress: false });
  assert.match(host.ws.extensions, /permessage-deflate/, 'compressing member negotiates permessage-deflate');
  assert.equal(plain.ws.extensions, '', 'member refusing compression gets plain frames');

  host.ws.send(JSON.stringify({ t: 'ready', value: true }));
  plain.ws.send(JSON.stringify({ t: 'ready', value: true }));
  await new Promise((r) => setTimeout(r, 200));
  host.ws.send(JSON.stringify({ t: 'start' }));
  await Promise.all([waitForTicks(host, TICKS_MEASURED), waitForTicks(plain, TICKS_MEASURED)]);

  const hostWire = host.wireEnd - host.wireStart;
  const plainWire = plain.wireEnd - plain.wireStart;
  assert.ok(host.payloadBytes > 0 && plain.payloadBytes > 0, 'both members received tick payloads');
  assert.ok(hostWire < host.payloadBytes * 0.25,
    `compressed ticks stay well under a quarter of the JSON size (${hostWire} of ${host.payloadBytes} bytes)`);
  assert.ok(plainWire >= plain.payloadBytes && plainWire <= plain.payloadBytes * 1.05 + 4096,
    `plain ticks arrive uncompressed (${plainWire} wire bytes for ${plain.payloadBytes} payload bytes)`);

  const plainByNow = new Map(plain.ticks.map((tick) => [tick.now, tick.text]));
  const shared = host.ticks.filter((tick) => plainByNow.has(tick.now));
  assert.ok(shared.length >= 20, `members share at least 20 snapshots (${shared.length})`);
  const hostId = host.welcome.id, plainId = plain.welcome.id;
  const strip = row => Object.fromEntries(Object.entries(row).filter(([key]) => !OWNER_ONLY_FIELDS.has(key)));
  // The shared text: the recipient's own row loses its owner-only fields like every other row.
  const sharedText = (text, selfId) => {
    const tick = JSON.parse(text);
    return JSON.stringify({ ...tick, players: tick.players.map(row => row.id === selfId ? strip(row) : row) });
  };
  for (const tick of shared) {
    const hostTick = JSON.parse(tick.text), plainTick = JSON.parse(plainByNow.get(tick.now));
    assert.equal(sharedText(tick.text, hostId), sharedText(plainByNow.get(tick.now), plainId),
      `snapshot ${tick.now} is identical for every member apart from its own row`);
    for (const [view, selfId] of [[hostTick, hostId], [plainTick, plainId]]) {
      for (const row of view.players) {
        const owner = [...OWNER_ONLY_FIELDS].filter(key => Object.hasOwn(row, key));
        assert.equal(owner.length, row.id === selfId ? OWNER_ONLY_FIELDS.size : 0,
          `snapshot ${tick.now}: owner-only fields ride only the recipient's own row (${row.id})`);
      }
    }
  }
  const nows = host.ticks.map((tick) => tick.now);
  assert.ok(nows.every((now, index) => index === 0 || now > nows[index - 1]), 'snapshots stay strictly ordered');

  console.log(`ok - transport: ${shared.length} identical snapshots, compressed ${hostWire}/${host.payloadBytes} bytes, plain ${plainWire}/${plain.payloadBytes} bytes`);
  host.ws.close();
  plain.ws.close();
} finally {
  await stopServer(server);
}
