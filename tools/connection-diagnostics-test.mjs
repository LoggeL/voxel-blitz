import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { ConnectionDiagnostics, connectionFindings, formatConnectionReport, summarize } from '../public/js/engine/connection-diagnostics.js';
import { TickTiming } from '../server/diagnostics.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { ConnectionSettings } from '../public/js/ui/connection-settings.js';
import { startServer, stopServer } from './lib/server-process.mjs';

class FakeNet {
  constructor() { this.listeners = new Map(); this.ws = { bufferedAmount: 0 }; this.networkStats = { jitterMs: 4, bufferMs: 80 }; }
  isOpen() { return true; }
  setDiagnosticsEnabled(value) { this.enabled = value; }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }
  emit(event, data) { for (const fn of [...(this.listeners.get(event) || [])]) fn(data); }
}

function fixture() {
  let now = 100;
  let timer;
  let cleared = false;
  const net = new FakeNet();
  const check = new ConnectionDiagnostics({ now: () => now,
    date: () => new Date('2026-09-09T12:00:00Z'),
    setTimer: (fn) => { timer = fn; return 7; }, clearTimer: (id) => { assert.equal(id, 7); cleared = true; },
  });
  return { net, check, at(value) { now = value; }, tick() { timer(); }, get cleared() { return cleared; } };
}

assert.equal(summarize([null, undefined, NaN]), null);
assert.equal(summarize([0, 2, 40]).min, 0);
assert.equal(summarize([10, 50]).median, 30);
{
  const f = fixture();
  assert.equal(f.check.start(null), false);
  assert.equal(f.check.start(f.net, { host: 'game.example', room: 'TEST' }), true);
  assert.equal(f.check.start(f.net), false, 'one recording at a time');
  for (let i = 0; i < 39; i++) {
    const sent = 1600 + i * 1500;
    f.at(sent);
    f.net.emit('diagnosticProbe', { nonce: i, atMs: sent });
    f.at(sent + 42);
    f.net.emit('latency', { nonce: i, atMs: sent + 42, server: {
      version: 'test', serverRttMs: 20, serverPingSequence: i + 1, serverPingAgeMs: 100,
      tick: { p95Ms: 3, maxMs: 5, intervalMaxMs: 51 },
      process: { eventLoopP95Ms: 21, eventLoopMaxMs: 25, cpuPercent: 8 }, queuedBytes: 0,
    } });
    f.check.frame(sent + 42);
    f.check.frame(sent + 58);
    f.check.lastFrameAt = null; // Independent frame pairs; no synthetic gap between samples.
  }
  f.at(59_600);
  f.net.emit('diagnosticProbe', { nonce: 40, atMs: 59_600 });
  f.at(60_100);
  f.tick();
  const r = f.check.report;
  assert.equal(r.reason, 'complete');
  assert.equal(r.durationMs, 60_000);
  assert.equal(r.metrics.browserRtt.median, 42);
  assert.equal(r.metrics.serverRtt.count, 39);
  assert.equal(r.metrics.frameMs.max, 16);
  assert.equal(r.probes.pendingAtFinish, 1, 'a final in-flight reply is not called missing');
  assert.equal(r.probes.unansweredOver5s, 0);
  assert.equal(f.net.enabled, false);
  assert.equal(f.cleared, true);
  assert.equal([...f.net.listeners.values()].reduce((n, s) => n + s.size, 0), 0);
  assert.match(formatConnectionReport(r), /Server version: test/);
  assert.match(formatConnectionReport(r), /not a packet-loss percentage/);

  // Clipboard permissions vary by browser. Keep a selectable report on failure.
  const view = new ConnectionSettings();
  let focused = false;
  let selected = false;
  view.check.report = r;
  view.details = { open: false };
  view.reportText = { focus() { focused = true; }, select() { selected = true; } };
  view.copyStatus = { textContent: '' };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      clipboard: { writeText: async () => { throw new Error('permission denied'); } },
    } });
    await view.copy();
    assert.equal(view.details.open && focused && selected, true);
    assert.match(view.copyStatus.textContent, /manually/);
    let copied = null;
    globalThis.navigator.clipboard.writeText = async (text) => { copied = text; };
    await view.copy();
    assert.equal(copied, formatConnectionReport(r));
    assert.equal(view.copyStatus.textContent, 'Report copied.');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    view.dispose(); // Also covers disposing a view that was never mounted.
  }
}
{
  const f = fixture();
  f.check.start(f.net);
  f.at(200); f.net.emit('diagnosticProbe', { nonce: 1, atMs: 200 });
  f.at(6200); f.net.emit('latency', { nonce: 1, atMs: 6200, server: null });
  f.net.emit('latency', { nonce: 1, atMs: 6201, server: null });
  f.at(6400); f.net.emit('diagnosticProbe', { nonce: 2, atMs: 6400 });
  f.check.frame(6400, true); f.check.frame(7400, true);
  f.at(12_000); f.net.emit('close');
  const r = f.check.report;
  assert.equal(r.reason, 'disconnected');
  assert.equal(r.metrics.browserRtt.max, 6000, 'raw RTT is not capped to the HUD limit');
  assert.equal(r.probes.received, 1, 'duplicate reply ignored');
  assert.equal(r.probes.repliesOver5s, 1);
  assert.equal(r.probes.unansweredOver5s, 1);
  assert.equal(r.metrics.serverRtt, null, 'older servers stay unavailable');
  assert.equal(r.metrics.serverTickP95, null);
  assert.equal(r.metrics.frameMs.max, 1000, 'actual frame stalls survive the game delta cap');
  assert.equal(r.metrics.playFrameMs, null, 'settings-only frames are labelled separately');
  assert.ok(r.findings.some((s) => s.includes('unavailable')));
  f.at(13_000); assert.equal(f.check.start(f.net), true);
  f.check.finish();
  assert.equal(f.check.report.probes.sent, 0, 'restart drops previous samples');
}
{
  const f = fixture();
  f.check.start(f.net);
  f.check.frame(150);
  f.at(200); f.check.visibility(true);
  f.check.frame(500);
  f.at(1200); f.check.visibility(false);
  f.check.frame(1250); f.check.frame(1270);
  f.at(1300); f.check.finish();
  assert.equal(f.check.report.hiddenMs, 1000);
  assert.equal(f.check.report.metrics.frameMs.max, 20, 'background gap excluded');
  f.at(2000); f.check.start(f.net, {}, true);
  f.at(77_000); f.tick();
  assert.equal(f.check.report.hiddenMs, 60_000, 'throttled timer cannot extend the window');
  assert.equal(f.check.report.durationMs, 60_000);
}
{
  const f = fixture();
  f.check.start(f.net);
  for (let i = 0; i < 4; i++) {
    const sent = 2000 + 1000 * i;
    f.at(sent); f.net.emit('diagnosticProbe', { nonce: i, atMs: sent });
    f.at(sent + 20); f.net.emit('latency', { nonce: i, atMs: sent + 20,
      server: { serverRttMs: 10, serverPingSequence: 1, serverPingAgeMs: i === 3 ? 4000 : 100 },
    });
  }
  f.check.finish();
  assert.equal(f.check.report.metrics.serverRtt.count, 1, 'duplicate and stale server samples ignored');
}
{
  const f = fixture();
  f.net.welcome = { tickRate: 20 };
  f.net.networkStats = { jitterMs: 50, bufferMs: 180 };
  f.check.start(f.net);
  // Regular server steps delivered in pairs: 100 ms pause, then a burst.
  for (let i = 0; i < 80; i++) {
    const at = 200 + Math.floor(i / 2) * 100;
    f.at(at);
    f.net.emit('tick', { recvLocalMs: at, serverNow: 10_000 + i * 50 });
    if (i % 4 === 0) {
      f.net.emit('diagnosticProbe', { nonce: i, atMs: at });
      f.net.emit('latency', { nonce: i, atMs: at + 40 });
    }
  }
  f.at(4200);
  const report = f.check.finish();
  assert.equal(report.snapshotTiming.samples.length, 80);
  assert.equal(report.snapshotTiming.samples[0].arrivalGapMs, null);
  assert.equal(report.snapshotTiming.samples[0].serverAtMs, 10_000);
  assert.equal(report.metrics.snapshotServerStep.median, 50);
  assert.equal(report.metrics.snapshotArrivalGap.p95, 100);
  assert.equal(report.metrics.snapshotArrivalGap.min, 0, 'same-turn deliveries remain visible');
  assert.ok(report.metrics.snapshotCompressedPercent > 50);
  assert.equal(report.metrics.bufferNearMaxPercent, 100);
  assert.ok(report.findings.some((s) => s.includes('180 ms limit')));
  assert.ok(report.findings.some((s) => s.includes('bursts')));
  assert.ok(!report.findings.some((s) => s.includes('advertised snapshot interval')));
  assert.match(formatConnectionReport(report), /Snapshot server-clock step/);
  assert.match(formatConnectionReport(report), /"arrivalGapMs": 0/);
  const slow = structuredClone(report);
  slow.metrics.snapshotServerStep.median = 100;
  assert.ok(connectionFindings(slow).some((s) => s.includes('advertised snapshot interval')));
  const old = structuredClone(report);
  delete old.snapshotTiming;
  delete old.metrics.bufferNearMaxPercent;
  assert.ok(connectionFindings(old).some((s) => s.includes('180 ms limit')), 'old high-buffer reports also receive a finding');
  f.at(5000); f.check.start(f.net);
  assert.equal(f.check.snapshots.length, 0, 'new checks reset snapshot history');
  f.net.emit('tick', { recvLocalMs: 5100, serverNow: null });
  f.net.emit('tick', { recvLocalMs: 5150, serverNow: 50 });
  assert.equal(f.check.snapshots[1].serverStepMs, null, 'missing server timestamps stay missing');
  f.at(5200); f.check.visibility(true);
  f.at(5300); f.check.visibility(false);
  f.net.emit('tick', { recvLocalMs: 5400, serverNow: 100 });
  assert.equal(f.check.snapshots[2].foregroundInterval, false, 'visibility changes between packets exclude the interval');
  for (let i = 0; i < 3000; i++) f.net.emit('tick', { recvLocalMs: 5500 + i, serverNow: 150 + i * 50 });
  f.at(8500); f.check.finish();
  assert.equal(f.check.report.snapshotTiming.samples.length, 2400);
  assert.equal(f.check.report.snapshotTiming.dropped, 603, 'recording has a hard memory bound');
}
{
  const ticks = new TickTiming();
  ticks.record(100, 125, 160);
  for (let i = 1; i < 20; i++) ticks.record(100 + i * 50, 2, 50);
  assert.equal(ticks.read(1100).maxMs, 125, 'a later normal tick does not hide a spike');
  assert.equal(ticks.read(1100).intervalMaxMs, 160);
  assert.equal(ticks.read(4000), null, 'inactive rooms do not report stale timings');
}

// Real browser protocol adapter against the real server, not an HTTP stand-in.
const server = startServer();
const originalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = WebSocket;
const net = new NetClient();
const check = new ConnectionDiagnostics();
try {
  const port = await server.port;
  await net.connect(`ws://127.0.0.1:${port}`, 'Diagnostics QA', { mode: 'quick', bots: 0 });
  assert.equal(check.start(net, { host: '127.0.0.1', room: net.welcome.lobby.code }), true);
  await delay(4750);
  const report = check.finish('stopped');
  assert.ok(report.probes.received >= 2);
  assert.ok(report.metrics.serverRtt?.count >= 1);
  assert.ok(report.metrics.serverTickP95?.count >= 2);
  assert.ok(report.metrics.serverEventLoopP95?.count >= 2);
  assert.equal(report.serverVersion, '0.1.0');
  assert.equal(report.metrics.clientQueuedBytes.min, 0);
  assert.ok(report.snapshotTiming.samples.length > 50);
  assert.equal(report.snapshotTiming.expectedIntervalMs, 50);
  assert.equal(report.metrics.snapshotServerStep.median, 50);
  const normal = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no regular pong after diagnostics stopped')), 2500);
    const off = net.on('latency', (s) => { clearTimeout(timer); off(); resolve(s); });
  });
  assert.equal(normal.server, null, 'extra telemetry stops with the check');
  assert.equal(check.start(net), true);
  net.close();
  assert.equal(check.report.reason, 'disconnected', 'a real NetClient close saves a partial report');
  assert.equal(check.running, false);
  console.log('Connection diagnostics: lifecycle, raw timing, missing data, visibility, expiry and live WebSocket checks passed.');
} finally {
  check.dispose();
  net.close();
  globalThis.WebSocket = originalWebSocket;
  await stopServer(server);
}
