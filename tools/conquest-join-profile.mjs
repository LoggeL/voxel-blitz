#!/usr/bin/env node
/**
 * Conquest join profile: how long a player waits from clicking JOIN on an
 * invite to a playable first frame on Frontier, broken down by stage.
 *
 * Starts the game server on a free port, hosts a live Conquest match on
 * Frontier from a headless protocol client (15 bots), then opens ONE muted
 * headless CDP browser on the invite URL and joins it --runs times. The first
 * join runs on an empty profile (cold: no map cache); every later join reloads
 * the page in the same profile (warm: HTTP cache and map cache filled). Each
 * join reports the client's User Timing marks (`vb:join:*`, see main.js,
 * pregame.js and worldview.js), the map frame size, the main-thread long
 * tasks and the first seconds of play: the slowest frames and when the
 * streamed spawn area (chunk load queue) was complete.
 *
 *   node tools/conquest-join-profile.mjs [--runs 3] [--bots 15] [--json] [--software] [--cpu]
 *       [--out <report.json>] [--shots <dir>] [--play-ms 6000]
 *
 * --cpu adds the busiest functions per stage (CDP sampling profiler); --shots
 * saves the first live frame and the view after --play-ms for each join.
 *
 * Over-internet transfer is estimated from the frame bytes after the server's
 * permessage-deflate settings (level 1, 32 KiB window). Not part of npm test
 * (needs a local Chromium); run it through .conquest-work/heavy.sh on a shared
 * machine.
 */
import { CONQUEST_CONTRACT_VERSION } from '../shared/conquest-contract.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const RUNS = Math.max(1, Number(option('runs', 3)));
const BOTS = Number(option('bots', 15));
const SOFTWARE = argv.includes('--software');
const JSON_OUT = argv.includes('--json');
const OUT = option('out', null);
const PLAY_MS = Number(option('play-ms', 6000));
const CPU_PROFILE = argv.includes('--cpu');
const SHOTS = option('shots', null);
async function shot(page, name) {
  if (!SHOTS) return null;
  const capture = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30_000);
  const file = path.resolve(ROOT, SHOTS, `${name}.png`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(capture.data, 'base64'));
  return path.relative(ROOT, file);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Host a live Conquest room on Frontier; resolves with its code and the socket. */
async function hostMatch(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
  const frames = { text: [], binary: [] };
  ws.on('message', (data, isBinary) => {
    if (isBinary) { frames.binary.push(data.byteLength); return; }
    const msg = JSON.parse(String(data));
    if (msg.t !== 'tick') frames.text.push(msg);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ t: 'create', name: 'Host', bots: BOTS, gameMode: 'conquest', map: 'frontier', contract: CONQUEST_CONTRACT_VERSION }));
  const waitText = async (predicate, label) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const hit = frames.text.find(predicate);
      if (hit) return hit;
      await sleep(25);
    }
    throw new Error(`host: ${label} timed out`);
  };
  const welcome = await waitText(m => m.t === 'welcome', 'welcome');
  ws.send(JSON.stringify({ t: 'ready', value: true }));
  ws.send(JSON.stringify({ t: 'start' }));
  await waitText(m => m.t === 'lobbyState' && m.phase === 'live', 'live phase');
  return { ws, code: welcome.lobby.code, hostMapBytes: welcome.mapBytes };
}

/** Stage marks in the order they happened (light bakes alongside the spawn mesh). */
const byTime = (marks) => Object.keys(marks).filter(k => marks[k] != null).sort((a, b) => marks[a] - marks[b]);

async function joinOnce(page, url, label) {
  await page.evaluate('window.__vbStaleDocument = true; true');
  await page.send('Page.navigate', { url });
  await page.waitFor(`!window.__vbStaleDocument && document.readyState === 'complete' && !!window.__vb`,
    { timeoutMs: 60_000, label: 'page loaded' });
  await page.evaluate(`(() => {
    window.__joinProbe = { long: [], frames: [] };
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__joinProbe.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask' }); } catch {}
    const ws = window.WebSocket;
    if (!ws.__probed) {
      window.WebSocket = class extends ws {
        constructor(...args) { super(...args);
          this.addEventListener('message', e => { if (typeof e.data !== 'string') (window.__joinProbe.binary ??= []).push([Math.round(performance.now()), e.data.byteLength ?? e.data.size]); });
        }
      };
      window.WebSocket.__probed = true;
    }
    return true;
  })()`);
  await page.waitFor(`document.getElementById('join-lobby-btn')?.disabled === false`,
    { timeoutMs: 180_000, label: 'join button ready (menu assets loaded)' });
  // A player reads the menu for a few seconds: let the background Frontier
  // metadata worker finish as it would (it starts 1.5 s after the menu).
  await page.waitFor(`['primed', 'failed'].includes(window.__vbMapCache?.stats.frontierMetadata)`,
    { timeoutMs: 10_000, label: 'frontier metadata prewarm' }).catch(() => {});
  const point = await page.evaluate(`(() => { const r = document.getElementById('join-lobby-btn').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (CPU_PROFILE) {
    await page.send('Profiler.enable');
    await page.send('Profiler.setSamplingInterval', { interval: 250 });
    await page.send('Profiler.start');
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  await page.waitFor(`window.__vb.stats.running === true`, { timeoutMs: 240_000, intervalMs: 50, label: `${label}: match running` });
  let cpu = null;
  if (CPU_PROFILE) {
    const { profile } = await page.send('Profiler.stop', {}, 60_000);
    await page.send('Profiler.disable');
    cpu = await summarizeProfile(page, profile);
  }
  // First seconds of play: frame times and when the streamed spawn area completes.
  await page.evaluate(`(() => { const p = window.__joinProbe; let last = performance.now();
    p.playStart = last; p.areaDoneAt = null;
    const tick = (t) => { p.frames.push(Math.round((t - last) * 10) / 10); last = t;
      const c = window.__vb.stats.chunks;
      if (p.areaDoneAt === null && c && !c.pendingLoads && !c.queued) p.areaDoneAt = Math.round(t);
      if (t - p.playStart < ${PLAY_MS}) requestAnimationFrame(tick); };
    requestAnimationFrame(tick); return true; })()`);
  const shots = [await shot(page, `${label}-first-frame`)];
  await sleep(PLAY_MS + 300);
  shots.push(await shot(page, `${label}-after-${PLAY_MS}ms`));
  return page.evaluate(`(() => {
    const marks = {};
    for (const m of performance.getEntriesByType('mark')) if (m.name.startsWith('vb:join:')) marks[m.name.slice(8)] = Math.round(m.startTime);
    const p = window.__joinProbe;
    const start = marks.start ?? 0;
    const rel = Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, v - start]));
    const frames = p.frames.slice(1);
    const sorted = frames.slice().sort((a, b) => b - a);
    const longs = p.long.filter(([at]) => at >= start);
    const s = window.__vb.stats;
    return { marks: rel, mapFrameBytes: (p.binary || [])[0]?.[1] ?? null,
      longTasks: { count: longs.length, totalMs: longs.reduce((n, [, d]) => n + d, 0), maxMs: longs.reduce((n, [, d]) => Math.max(n, d), 0),
        beforeRunning: longs.filter(([at]) => at < (marks.running ?? Infinity)).reduce((n, [, d]) => n + d, 0) },
      play: { frames: frames.length, worstMs: sorted.slice(0, 5), over50: frames.filter(f => f > 50).length,
        areaCompleteMs: p.areaDoneAt === null ? null : Math.round(p.areaDoneAt - marks.running), chunks: s.chunks },
      lightBake: s.lightBake, mapCache: window.__vbMapCache?.stats ?? null };
  })()`).then(result => ({ ...result, ...(cpu ? { cpu } : {}), shots: shots.filter(Boolean) }));
}

/** Self time per function (top 25) per join stage window, from a CDP CPU profile. */
async function summarizeProfile(page, profile) {
  const marks = await page.evaluate(`Object.fromEntries(performance.getEntriesByType('mark')
    .filter(m => m.name.startsWith('vb:join:')).map(m => [m.name.slice(8), m.startTime]))`);
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const name = (n) => {
    const f = n.callFrame;
    return `${f.functionName || '(anon)'} ${f.url ? `${f.url.split('/').slice(-1)[0]}:${f.lineNumber + 1}` : ''}`.trim();
  };
  const windows = byTime(marks).map((k, i, list) => ({ from: k, to: list[i + 1], at: marks[k], end: marks[list[i + 1]] ?? Infinity, self: new Map(), total: 0 }));
  // Samples are aligned on the profile start, which precedes the JOIN click by
  // one CDP round trip: stage windows are accurate to a few milliseconds.
  let t = profile.startTime;
  const startPerf = marks.start ?? 0;
  const firstTs = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i];
    const at = startPerf + (t - firstTs) / 1000;
    const w = windows.find(w => at >= w.at && at < w.end);
    if (!w) continue;
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    const n = nodes.get(profile.samples[i]);
    const key = name(n);
    if (key.startsWith('(idle)') || key.startsWith('(program)')) continue;
    w.self.set(key, (w.self.get(key) || 0) + dt);
    w.total += dt;
  }
  return windows.filter(w => w.to).map(w => ({ stage: `${w.from}→${w.to}`, busyMs: Math.round(w.total),
    top: [...w.self].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${Math.round(v)} ${k}`) }));
}

function stageTable(marks) {
  const order = byTime(marks);
  const rows = [];
  for (let i = 1; i < order.length; i++) rows.push([`${order[i - 1]}→${order[i]}`, marks[order[i]] - marks[order[i - 1]]]);
  return rows;
}

/** Transfer estimate for a frame of `bytes` deflated bytes: slow start from 10 MSS, then line rate. */
function transferEstimate(bytes, { mbps, rttMs }) {
  let sent = 0, cwnd = 10 * 1460, rtts = 0;
  const perRttCap = mbps * 125 * rttMs; // bytes the line carries in one RTT
  while (sent < bytes && cwnd < perRttCap) { sent += cwnd; cwnd *= 2; rtts++; }
  const rest = Math.max(0, bytes - sent);
  return Math.round(rtts * rttMs + rest / (mbps * 125) + rttMs / 2);
}

async function main() {
  const server = startServer({ cwd: ROOT, failureContext: 'join profile', ringBuffer: 32_000, portTimeout: 30_000 });
  let browser = null, host = null;
  const report = { started: new Date().toISOString(), bots: BOTS, runs: [] };
  try {
    const port = await server.port;
    await waitForHttp(port);
    host = await hostMatch(port);
    report.hostMapBytes = host.hostMapBytes;
    const url = `http://127.0.0.1:${port}/?debug=1&headless=1&lobby=${host.code}`;
    browser = await launchCdpSession(url, {
      width: 1280, height: 720, softwareRendering: SOFTWARE,
      extraArgs: SOFTWARE ? [] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
    });
    for (let run = 0; run < RUNS; run++) {
      const label = run === 0 ? 'cold' : `warm${run}`;
      const result = await joinOnce(browser.page, url, label);
      report.runs.push({ label, ...result });
      if (!JSON_OUT) {
        const m = result.marks;
        console.log(`[${label}] click→running ${m.running} ms · map frame ${result.mapFrameBytes} B · long tasks ${result.longTasks.count} (${result.longTasks.totalMs} ms, max ${result.longTasks.maxMs})`);
        console.log(`  ${stageTable(m).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
        console.log(`  play ${PLAY_MS} ms: ${result.play.frames} frames, worst ${result.play.worstMs.join('/')} ms, ${result.play.over50} >50 ms, spawn area complete ${result.play.areaCompleteMs} ms after running`);
        if (result.mapCache) console.log(`  map cache ${JSON.stringify(result.mapCache)}`);
        if (result.lightBake) console.log(`  light bake ${JSON.stringify(result.lightBake)}`);
        for (const w of result.cpu || []) console.log(`  cpu ${w.stage} busy ${w.busyMs} ms: ${w.top.slice(0, 8).join(' | ')}`);
      }
    }
    // Wire estimate for the full-map frame (what a cold join downloads).
    const { createMapState } = await import('../shared/worlddata.js');
    const full = createMapState('frontier').serializeWorld();
    const deflated = zlib.deflateRawSync(full, { level: 1, memLevel: 8, windowBits: 15 }).byteLength;
    report.wire = { fullFrameBytes: full.byteLength, deflatedBytes: deflated,
      estimates: [{ mbps: 16, rttMs: 40 }, { mbps: 50, rttMs: 25 }, { mbps: 250, rttMs: 15 }]
        .map(link => ({ ...link, ms: transferEstimate(deflated, link) })) };
    for (const run of report.runs) {
      run.wireBytes = run.mapFrameBytes == null ? null
        : run.mapFrameBytes === full.byteLength ? deflated
          : run.mapFrameBytes < 4096 ? run.mapFrameBytes : null;
    }
    if (!JSON_OUT) {
      console.log(`wire: full frame ${full.byteLength} B → ${deflated} B deflated; ${report.wire.estimates.map(e => `${e.mbps} Mbit/s ${e.rttMs} ms RTT ≈ ${e.ms} ms`).join(' · ')}`);
    } else console.log(JSON.stringify(report, null, 1));
    if (OUT) {
      await mkdir(path.dirname(path.resolve(ROOT, OUT)), { recursive: true });
      await writeFile(path.resolve(ROOT, OUT), JSON.stringify(report, null, 1));
    }
    const errors = browser.page.errors.filter(e => !/favicon/i.test(e));
    if (errors.length) { console.error('browser errors:', errors.slice(0, 10).join(' | ')); process.exitCode = 1; }
  } finally {
    try { host?.ws.close(); } catch {}
    await browser?.close();
    await stopServer(server);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
