import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { NetClient } from '../public/js/engine/netclient.js';
import { ConnectionDiagnostics } from '../public/js/engine/connection-diagnostics.js';

// Both clients receive the same room's snapshots, at the same time, on this host.
// Use an SSH forward for --direct; no public origin port or DNS change is needed.
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
if (!options.get('--public') || !options.get('--direct')) {
  console.error('Usage: node tools/connection-route-check.mjs --public wss://GAME_HOST --direct ws://127.0.0.1:TUNNEL_PORT [--output .artifacts/connection-routes.json]');
  process.exit(1);
}
for (const name of ['--public', '--direct']) {
  const url = new URL(options.get(name));
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error(`${name} needs a WebSocket URL without credentials`);
}
const output = options.get('--output') || '.artifacts/connection-routes.json';
const originalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = WebSocket;
const publicNet = new NetClient();
const directNet = new NetClient();
const checks = [];
const timeout = setTimeout(() => {
  console.error('Route comparison timed out.');
  publicNet.close(); directNet.close();
  process.exitCode = 1;
}, 85_000);

async function until(predicate, message, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await delay(20);
  }
}
function record(net, url, route) {
  return new Promise((resolve, reject) => {
    const check = new ConnectionDiagnostics({ onChange: () => {
      if (check.report) resolve(check.report);
    } });
    checks.push(check);
    if (!check.start(net, { host: new URL(url).host, room: net.welcome.lobby.code,
      mode: net.welcome.gameMode, map: net.welcome.map, route,
      browser: `Node.js ${process.version} protocol probe (no rendering or gameplay frames)` })) {
      reject(new Error(`${route} disconnected before recording`));
    }
  });
}
try {
  const password = randomBytes(16).toString('hex');
  const directUrl = options.get('--direct');
  const publicUrl = options.get('--public');
  await directNet.connect(directUrl, 'Direct route check', { mode: 'create', bots: 0, gameMode: 'fun', map: 'foundry', password });
  await publicNet.connect(publicUrl, 'Public route check', { mode: 'join', lobby: directNet.welcome.lobby.code, password });
  directNet.setReady(true); publicNet.setReady(true);
  await until(() => directNet.latestLobbyState?.members.length === 2 && directNet.latestLobbyState.members.every((m) => m.ready), 'Both clients did not become ready');
  directNet.requestStart();
  await until(() => directNet.latestSnapshots.length >= 20 && publicNet.latestSnapshots.length >= 20, 'Both routes did not receive snapshots');
  console.log('Recording both routes for 60 seconds in the same private room.');
  const [direct, publicRoute] = await Promise.all([
    record(directNet, directUrl, 'Direct via SSH tunnel'),
    record(publicNet, publicUrl, 'Public host'),
  ]);
  const result = {
    measuredAt: new Date().toISOString(),
    method: 'Simultaneous Node.js WebSocket clients in one temporary password-protected room; 60 seconds after at least 20 warmup snapshots per route. The direct route includes the SSH tunnel. This separates routes but does not measure browser rendering or isolate any individual proxy hop.',
    direct, public: publicRoute,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  for (const [label, report] of [['direct', direct], ['public', publicRoute]]) {
    console.log(JSON.stringify({ route: label, reason: report.reason, probes: report.probes,
      rtt: report.metrics.browserRtt, arrival: report.metrics.snapshotArrivalGap,
      serverStep: report.metrics.snapshotServerStep, compressedPercent: report.metrics.snapshotCompressedPercent,
      buffer: report.metrics.interpolationBuffer, serverTick: report.metrics.serverTickMax }));
  }
  console.log(`Saved ${output}`);
  if ([direct, publicRoute].some((report) => report.reason !== 'complete')) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  for (const check of checks) check.dispose();
  publicNet.close(); directNet.close();
  globalThis.WebSocket = originalWebSocket;
}
