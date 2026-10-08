#!/usr/bin/env node
/**
 * Live Conquest smoke: the real client in a real Frontier match.
 *
 * Starts the game server on a free port, opens the client in ONE muted
 * headless CDP browser (tools/lib/cdp-session.mjs, --mute-audio), creates a
 * Conquest lobby on Frontier with 15 bots, starts it and plays roughly
 * --seconds of match time with simulated keyboard/mouse input: spawn at HQ,
 * walk to a friendly jeep, enter it, drive toward the nearest home flag,
 * leave it, throw a frag at the player's feet and go through the deploy
 * screen after the death. Every uncaught exception, console error/warning,
 * failed request, HTTP >= 400, WebGL message and server stderr line is
 * collected. Screenshots and live-smoke-report.json land in --out.
 *
 *   node tools/conquest-live-smoke.mjs [--seconds 120] [--out <dir>] [--software] [--width 1280 --height 720]
 *
 * Uses the hardware GPU through ANGLE/Metal by default (--software for SwiftShader).
 * Exits 1 on any runtime error. Not part of npm test (needs a local Chromium);
 * run it through .conquest-work/heavy.sh on a shared machine.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';
import { getMapMeta } from '../shared/worlddata.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const SECONDS = Number(option('seconds', 120));
const OUT = path.resolve(ROOT, option('out', 'docs/design/conquest/redesign/captures/live'));
const WIDTH = Number(option('width', 1280));
const HEIGHT = Number(option('height', 720));
const SOFTWARE = argv.includes('--software');
const BOTS = Number(option('bots', 15));
const NETWORK = argv.includes('--network');
// --views: while driving, also capture the ACTION and FIRST PERSON camera views (V), then return to the chase.
const VIEWS = argv.includes('--views');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** Yaw that faces `to` from `from` (forward is (-sin yaw, -cos yaw)). */
const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
const meta = getMapMeta('frontier').conquest;

const report = {
  started: new Date().toISOString(), seconds: SECONDS, bots: BOTS, viewport: `${WIDTH}x${HEIGHT}`,
  renderer: null, timings: {}, steps: [], timeline: [], screenshots: [], samples: [],
  exceptions: [], consoleErrors: [], consoleWarnings: [], webgl: [], failedRequests: [], httpErrors: [],
  serverErrors: [], fps: null,
};
const step = (text, extra = {}) => {
  const entry = { ...extra, at: +((Date.now() - t0) / 1000).toFixed(1), text };
  report.steps.push(entry);
  console.log(`[${entry.at.toFixed(1)}s] ${text}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`);
};
const t0 = Date.now();

// ---------------------------------------------------------------------------
// CDP event collection
// ---------------------------------------------------------------------------
const requests = new Map();
const consoleLog = [];
const KEEP = 400;
const push = (list, value) => { if (list.length < KEEP) list.push(value); };
function describeArgs(args = []) {
  return args.map(a => a.value !== undefined ? String(a.value) : a.description || a.type).join(' ').slice(0, 600);
}
function drain(page) {
  const events = page.events.splice(0);
  for (const { method, params } of events) {
    switch (method) {
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails;
        push(report.exceptions, `${d?.exception?.description || d?.text || 'exception'}`.slice(0, 1200));
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const text = describeArgs(params.args);
        if (/webgl|GL_|shader/i.test(text) && params.type !== 'log' && params.type !== 'debug' && params.type !== 'info') push(report.webgl, `${params.type}: ${text}`);
        if (params.type === 'error' || params.type === 'assert') push(report.consoleErrors, text);
        else if (params.type === 'warning') push(report.consoleWarnings, text);
        else { consoleLog.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${params.type}: ${text.slice(0, 300)}`); if (consoleLog.length > 200) consoleLog.shift(); }
        break;
      }
      case 'Log.entryAdded': {
        const e = params.entry;
        const text = `${e.source}: ${e.text}${e.url ? ` (${e.url})` : ''}`.slice(0, 600);
        if (/webgl|GL_|GPU/i.test(e.text) || e.source === 'rendering') push(report.webgl, `${e.level} ${text}`);
        if (e.level === 'error' && e.source === 'network') push(report.failedRequests, text);
        else if (e.level === 'error') push(report.consoleErrors, text);
        else if (e.level === 'warning') push(report.consoleWarnings, text);
        break;
      }
      case 'Network.requestWillBeSent':
        requests.set(params.requestId, params.request.url);
        break;
      case 'Network.responseReceived':
        if (params.response.status >= 400) push(report.httpErrors, `${params.response.status} ${params.response.url}`);
        requests.delete(params.requestId);
        break;
      case 'Network.loadingFailed': {
        const url = requests.get(params.requestId) || '?';
        requests.delete(params.requestId);
        // Aborted prefetches/teardown are not failures of the page.
        if (params.canceled || params.errorText === 'net::ERR_ABORTED') break;
        push(report.failedRequests, `${params.errorText} ${url}`);
        break;
      }
      case 'Network.loadingFinished':
        requests.delete(params.requestId);
        break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------
const KEYS = {
  w: ['w', 'KeyW', 87], a: ['a', 'KeyA', 65], s: ['s', 'KeyS', 83], d: ['d', 'KeyD', 68],
  t: ['t', 'KeyT', 84], g: ['g', 'KeyG', 71], m: ['m', 'KeyM', 77], shift: ['Shift', 'ShiftLeft', 16],
  space: [' ', 'Space', 32], enter: ['Enter', 'Enter', 13], tab: ['Tab', 'Tab', 9], y: ['y', 'KeyY', 89], v: ['v', 'KeyV', 86],
};
async function key(page, name, type) {
  const [k, code, vk] = KEYS[name];
  await page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
const down = (page, name) => key(page, name, 'keyDown');
const up = (page, name) => key(page, name, 'keyUp');
async function tap(page, name, holdMs = 80) { await down(page, name); await sleep(holdMs); await up(page, name); }
async function releaseAll(page) { for (const name of ['w', 'a', 's', 'd', 'shift', 'space']) await up(page, name).catch(() => {}); }
/** Synthetic look delta; the ?headless=1 input fallback reads movementX/Y without pointer lock. */
const look = (page, dx, dy = 0) => page.evaluate(`document.dispatchEvent(new MouseEvent('mousemove', { movementX: ${Math.round(dx)}, movementY: ${Math.round(dy)}, bubbles: true }))`);
const stats = async page => {
  const s = await page.evaluate(`(() => { const s = window.__vb.stats;
    s.menuVisible = !document.getElementById('menu')?.classList.contains('hidden');
    s.hudVisible = document.getElementById('hud')?.classList.contains('hidden') === false;
    s.probe = { ...window.__probe }; window.__probe.maxLag = 0; return s; })()`);
  const now = Date.now();
  if (now - lastTimeline > 2000) {
    lastTimeline = now;
    report.timeline.push({ t: +((now - t0) / 1000).toFixed(1), running: s.running, alive: s.alive, menu: s.menuVisible, hud: s.hudVisible,
      feet: s.feet && [s.feet.x, s.feet.y, s.feet.z].map(v => +v.toFixed(1)), yaw: +s.yaw.toFixed(2), seat: s.vehicleSeat?.id ?? null,
      ring: s.ringLen, snapAge: s.lastSnapAgeMs, avatars: s.avatars, fr: s.frameRate, probe: s.probe });
  }
  if (inMatch && (s.menuVisible || !s.running)) {
    const closes = await page.evaluate('JSON.stringify(window.__wsCloses || [])').catch(() => '?');
    const status = await page.evaluate(`document.querySelector('#menu .vb-join-state, #join-state, .vb-menu-status')?.textContent || ''`).catch(() => '');
    throw new Error(`left the live match (menu ${s.menuVisible}, running ${s.running}); socket closes ${closes}; status ${status}`);
  }
  return s;
};
let lastTimeline = 0, inMatch = false;

async function clickId(page, id) {
  const point = await page.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el?.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el?.getBoundingClientRect();
    return r && r.width && r.height && !el.disabled ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`);
  if (!point) throw new Error(`#${id} is not clickable`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}
async function select(page, id, value) {
  await page.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}
async function shot(page, name, note = '') {
  const capture = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30_000);
  const file = path.join(OUT, `${name}.png`);
  await writeFile(file, Buffer.from(capture.data, 'base64'));
  const s = await stats(page).catch(() => null);
  report.screenshots.push({ name, file: path.relative(ROOT, file), note,
    feet: s?.feet && { x: +s.feet.x.toFixed(1), y: +s.feet.y.toFixed(1), z: +s.feet.z.toFixed(1) },
    vehicle: s?.vehicleSeat ? `${s.vehicle?.type}:${s.vehicleSeat.id}` : null, alive: s?.alive });
  step(`screenshot ${name}${note ? ` (${note})` : ''}`);
}

// ---------------------------------------------------------------------------
// Live helpers
// ---------------------------------------------------------------------------
let lookScale = null; // radians of yaw per +1 movementX (sign included)
async function calibrateLook(page) {
  const before = (await stats(page)).yaw;
  await look(page, 100);
  await sleep(400);
  const after = (await stats(page)).yaw;
  const delta = wrap(after - before);
  lookScale = Math.abs(delta) > 1e-4 ? delta / 100 : -0.0022;
  await look(page, -100);
  await sleep(200);
  step('look calibrated', { radPerPx: +lookScale.toFixed(5) });
}
async function face(page, target) {
  for (let i = 0; i < 4; i++) {
    const s = await stats(page);
    if (!s.feet) return;
    const err = wrap(yawTo(s.feet, target) - s.yaw);
    if (Math.abs(err) < 0.06) return;
    await look(page, err / lookScale);
    await sleep(120);
  }
}
async function setPitch(page, pitch) {
  for (let i = 0; i < 4; i++) {
    const s = await stats(page);
    const err = pitch - s.pitch;
    if (Math.abs(err) < 0.05) return;
    // movementY > 0 looks down (pitch decreases) unless the player inverted Y.
    await look(page, 0, -err / Math.abs(lookScale));
    await sleep(120);
  }
}
async function myTeam(page) {
  const s = await stats(page);
  return s.players.find(p => String(p.id) === String(s.localId))?.team ?? null;
}

let deployShots = 0;
/**
 * If the deploy screen is up: screenshot it (first two times), optionally pick
 * a jeep/tank driver seat from the spawn list, then press DEPLOY until alive.
 * Returns false when the screen is not open, else the chosen spawn label.
 */
async function handleDeploy(page, label, { vehicleDriver = false } = {}) {
  const open = await page.evaluate(`(() => { const b = document.querySelector('.cq-deploy-button');
    return !!b && b.offsetParent !== null; })()`);
  if (!open) return false;
  step(`deploy screen open (${label})`);
  await sleep(1500);
  if (deployShots < 2) await shot(page, `deploy-screen${deployShots ? `-${deployShots + 1}` : ''}`, label);
  deployShots++;
  let choice = 'default';
  if (vehicleDriver) {
    // Real UI path: the DRIVER chip of a free jeep (else tank) in the spawn list.
    choice = await page.evaluate(`(() => {
      for (const type of ['JEEP', 'TANK']) {
        for (const row of document.querySelectorAll('.cq-spawn-row')) {
          const main = row.querySelector('.cq-spawn[data-kind="vehicle"][data-ok="true"]');
          if (!main || !main.querySelector('b')?.textContent.toUpperCase().includes(type)) continue;
          const chip = [...row.querySelectorAll('.cq-spawn-seat')].find(c => c.textContent.trim() === 'DRIVER');
          if (chip) { chip.click(); return main.querySelector('b').textContent + ' / DRIVER'; }
        }
      }
      return 'no free vehicle driver seat';
    })()`);
    step('deploy choice', { choice });
    await sleep(600);
    if (deployShots < 3 && choice.includes('DRIVER')) { await shot(page, 'deploy-screen-vehicle', choice); deployShots++; }
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const s = await stats(page);
    if (s.alive) {
      step('deployed', { feet: s.feet && [s.feet.x, s.feet.z].map(Math.round), seat: s.vehicleSeat?.id ?? null,
        vehicle: s.vehicle ? `${s.vehicle.type}:${s.vehicle.id}` : null });
      return choice;
    }
    const refused = await page.evaluate(`document.querySelector('.cq-deploy-status')?.textContent || ''`);
    if (/refus|unavailable|busy/i.test(refused)) step('deploy status', { status: refused });
    await page.evaluate(`document.querySelector('.cq-deploy-button')?.click()`);
    drain(page);
    await sleep(1000);
  }
  step('deploy did not complete within 30 s');
  return choice;
}

/** Hold W and steer the seated hull toward `target` until within `stopAt` m or the budget runs out. */
async function drive(page, target, budgetMs, { stopAt = 12, shotName = null } = {}) {
  let s = await stats(page);
  if (!s.vehicleSeat?.canDrive) return s;
  const start = Date.now();
  let steerSign = 0, lastSteer = null, shotTaken = false, stuckSince = Date.now(), lastPos = s.feet;
  step(`driving ${s.vehicle?.type} toward ${target.id ?? 'target'}`, { distance: +flat(s.feet, target).toFixed(0) });
  await down(page, 'w');
  try {
    while (Date.now() - start < budgetMs) {
      s = await stats(page);
      if (!s.alive || !s.vehicleSeat || !s.vehicle) break;
      if (flat(s.vehicle, target) < stopAt) break;
      const err = wrap(yawTo(s.vehicle, target) - s.vehicle.yaw);
      // Learn which key turns the hull toward the target from the first correction.
      const wantKey = Math.abs(err) < 0.12 ? null : (err > 0) === (steerSign >= 0) ? 'a' : 'd';
      if (wantKey !== lastSteer) {
        if (lastSteer) await up(page, lastSteer);
        if (wantKey) await down(page, wantKey);
        lastSteer = wantKey;
      }
      if (!steerSign && lastSteer) {
        const yaw0 = s.vehicle.yaw;
        await sleep(600);
        const turned = wrap(((await stats(page)).vehicle?.yaw ?? yaw0) - yaw0);
        if (Math.abs(turned) > 0.01) steerSign = (lastSteer === 'a') === (turned > 0) ? 1 : -1;
      }
      if (shotName && !shotTaken && Date.now() - start > 7000) {
        shotTaken = true;
        await shot(page, shotName, `${s.vehicle.type} driver, ${Math.round(s.vehicle.speed ?? 0)} m/s, ${flat(s.vehicle, target).toFixed(0)} m to ${target.id}`);
        if (VIEWS) {
          // V cycles CHASE -> ACTION -> FIRST PERSON -> CHASE for the jeep driver.
          for (const view of ['action', 'cockpit']) {
            await tap(page, 'v');
            await sleep(900);
            await shot(page, `${shotName}-${view}`, `${s.vehicle.type} driver, ${view} view`);
          }
          await tap(page, 'v');
        }
      }
      if (flat(s.feet, lastPos) > 1.5) { lastPos = s.feet; stuckSince = Date.now(); }
      else if (Date.now() - stuckSince > 3500) {
        step('vehicle stuck, reversing', { pos: [s.vehicle.x, s.vehicle.z].map(Math.round) });
        if (lastSteer) await up(page, lastSteer);
        await up(page, 'w'); await down(page, 's'); await down(page, 'd'); await sleep(1500);
        await up(page, 's'); await up(page, 'd'); await down(page, 'w');
        lastSteer = null; stuckSince = Date.now();
      }
      drain(page);
      await sleep(200);
    }
  } finally { if (lastSteer) await up(page, lastSteer); await releaseAll(page); }
  s = await stats(page);
  step('drive ended', { distance: s.feet ? +flat(s.feet, target).toFixed(0) : null, alive: s.alive, seated: !!s.vehicleSeat });
  return s;
}

/** Sprint toward `target` on foot (hopping over steps, sidestepping when stuck) until within `stopAt` m. */
async function walk(page, target, budgetMs, stopAt = 6) {
  const start = Date.now();
  let s = await stats(page), stuckSince = Date.now(), lastPos = s.feet, side = 'd';
  await down(page, 'w'); await down(page, 'shift');
  try {
    while (Date.now() - start < budgetMs) {
      s = await stats(page);
      if (!s.alive || s.vehicleSeat || !s.feet) break;
      if (flat(s.feet, target) < stopAt) break;
      await face(page, target);
      if (flat(s.feet, lastPos) > 1.2) { lastPos = s.feet; stuckSince = Date.now(); }
      else if (Date.now() - stuckSince > 2500) {
        await tap(page, 'space', 80);
        await down(page, side); await sleep(900); await up(page, side);
        side = side === 'd' ? 'a' : 'd';
        stuckSince = Date.now();
      }
      drain(page);
      await sleep(200);
    }
  } finally { await releaseAll(page); }
  return stats(page);
}

/** Nearest friendly jeep/tank with a free seat within 150 m, free driver seats first. */
function pickVehicle(s, team) {
  let best = null;
  for (const v of s.vehicles) {
    if (!['jeep', 'tank'].includes(v.type) || v.team !== team || !(v.hp > 0) || !s.feet) continue;
    const taken = Object.keys(v.seatOccupants || {});
    const seats = v.type === 'jeep' ? 4 : 2;
    if (taken.length >= seats) continue;
    const d = flat(s.feet, v);
    if (d > 150) continue;
    const driverFree = !taken.includes('driver');
    const score = d + (driverFree ? 0 : 60);
    if (!best || score < best.score) best = { v, d, driverFree, score };
  }
  return best;
}

async function sampleLoop(page, ms, every = 1000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    drain(page);
    await sleep(Math.min(every, until - Date.now()));
  }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(OUT, { recursive: true });
  // Drop this tool's own captures from an earlier run so the folder shows one run.
  for (const name of await readdir(OUT)) {
    if (/^(\d\d-.*|deploy-screen.*|zz-failure)\.png$/.test(name)) await rm(path.join(OUT, name));
  }
  const server = startServer({ cwd: ROOT, failureContext: 'Conquest live smoke', ringBuffer: 64_000 });
  let browser = null;
  let exitCode = 0;
  try {
    const port = await server.port;
    await waitForHttp(port);
    browser = await launchCdpSession(`http://127.0.0.1:${port}/?debug=1&headless=1`, {
      width: WIDTH, height: HEIGHT, softwareRendering: SOFTWARE,
      // Headless Chromium falls back to SwiftShader without these, which renders
      // Frontier at ~2 fps; the page then drains the 60 Hz snapshot socket too
      // slowly and the server's heartbeat drops it (code 1006) within a minute.
      extraArgs: SOFTWARE ? [] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
    });
    const page = browser.page;
    // Network domain only on request: it mirrors every WebSocket frame payload
    // over CDP (~1 MB/s of snapshots), which backs up the page's socket and
    // makes the server drop the client for backpressure. Failed resources
    // still surface as Log 'network' entries without it.
    if (NETWORK) await page.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    // Record every socket close (code, reason, clean) so a dropped match names its cause.
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__wsCloses = [];
      window.__probe = { msgs: 0, bytes: 0, longMs: 0, longCount: 0, maxLag: 0 };
      try { new PerformanceObserver(l => { for (const e of l.getEntries()) { window.__probe.longMs += e.duration; window.__probe.longCount++; } }).observe({ type: 'longtask' }); } catch {}
      { let last = performance.now(); setInterval(() => { const now = performance.now(); window.__probe.maxLag = Math.max(window.__probe.maxLag, now - last - 100); last = now; }, 100); }
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('close', e => window.__wsCloses.push({ at: Math.round(performance.now()), code: e.code, reason: e.reason, clean: e.wasClean }));
          this.addEventListener('message', e => { const p = window.__probe; p.msgs++; p.bytes += e.data?.byteLength ?? e.data?.length ?? 0; });
        }
      };
    ` });
    await page.send('Page.reload');
    await page.waitFor(`document.readyState === 'complete'`, { label: 'reloaded with socket probe' });
    await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    report.renderer = await page.evaluate(`(() => { const g = document.createElement('canvas').getContext('webgl2');
      const e = g?.getExtension('WEBGL_debug_renderer_info'); return g ? (e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) : 'no webgl2'; })()`);
    step('browser up', { renderer: report.renderer });

    const menuStart = Date.now();
    await page.waitFor(`!!window.__vb && document.getElementById('create-lobby-btn')?.disabled === false`,
      { timeoutMs: 180_000, label: 'menu play actions ready' });
    report.timings.menuReadyS = +((Date.now() - menuStart) / 1000).toFixed(1);
    step('menu ready', { seconds: report.timings.menuReadyS });
    drain(page);

    await clickId(page, 'create-lobby-btn');
    await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`, { label: 'lobby open' });
    await select(page, 'game-mode-select', 'conquest');
    await page.waitFor(`document.getElementById('game-mode-select').value === 'conquest'`, { label: 'conquest mode selected' });
    await select(page, 'map-select', 'frontier');
    await page.waitFor(`document.getElementById('map-select').value === 'frontier'`, { label: 'frontier selected' });
    await select(page, 'bot-count', String(BOTS));
    await page.waitFor(`document.getElementById('bot-count').value === ${JSON.stringify(String(BOTS))}`,
      { timeoutMs: 10_000, label: `${BOTS} bots selected` });
    await sleep(800);
    await page.evaluate(`(() => { for (const el of [document.getElementById('lobby'), document.scrollingElement]) if (el) el.scrollTop = 0; })()`);
    await shot(page, '00-lobby', 'Conquest lobby on Frontier with bots');
    await clickId(page, 'lobby-ready-btn');
    await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled === false`, { timeoutMs: 15_000, label: 'start enabled' });
    await page.evaluate(`window.__liveFrames = []; (() => { let last = performance.now();
      const tick = t => { window.__liveFrames.push(t - last); last = t; if (window.__liveFrames.length > 20000) window.__liveFrames.splice(0, 10000); requestAnimationFrame(tick); };
      requestAnimationFrame(tick); })()`);
    const joinStart = Date.now();
    await clickId(page, 'lobby-start-btn');
    step('match start clicked');
    await sleep(1500);
    await shot(page, '01-loading', 'loading screen after start').catch(() => {});
    await page.waitFor(`window.__vb.stats.running && window.__vb.stats.ringLen > 0`,
      { timeoutMs: 240_000, intervalMs: 500, label: 'live Conquest match running' });
    report.timings.joinToRunningS = +((Date.now() - joinStart) / 1000).toFixed(1);
    step('match running', { seconds: report.timings.joinToRunningS });
    inMatch = true;
    drain(page);

    // Alive at HQ (or through a deploy screen if the round opens with one).
    const aliveDeadline = Date.now() + 60_000;
    while (Date.now() < aliveDeadline) {
      if ((await stats(page)).alive) break;
      await handleDeploy(page, 'round start');
      await sleep(500);
    }
    const matchStart = Date.now();
    const matchElapsed = () => (Date.now() - matchStart) / 1000;
    // Let the chunk queue settle a little, then record chunk stats.
    await sampleLoop(page, 4000);
    let s = await stats(page);
    report.timings.chunksAtSpawn = s.chunks;
    const team = await myTeam(page);
    step('spawned', { team, feet: s.feet && [s.feet.x, s.feet.y, s.feet.z].map(v => +v.toFixed(1)), avatars: s.avatars,
      vehicles: s.vehicles.length, chunks: s.chunks });
    await shot(page, '02-hq-spawn', `${team} HQ spawn`);
    await calibrateLook(page);
    {
      const a = (await stats(page)).feet;
      await down(page, 'w'); await sleep(1200); await up(page, 'w');
      await sleep(300);
      const b = (await stats(page)).feet;
      report.timings.walkProbeM = +flat(a, b).toFixed(2);
      step('walk probe (W 1.2 s)', { moved: report.timings.walkProbeM,
        focus: await page.evaluate('document.hasFocus()'), active: await page.evaluate('document.activeElement?.tagName + "#" + (document.activeElement?.id || "")') });
    }

    // ---- walk to a friendly ground vehicle and enter it -----------------------
    // Bots crew the HQ hulls quickly: prefer a free driver seat, else ride along.
    let target = pickVehicle(s, team);
    if (target) {
      step('walking to vehicle', { id: target.v.id, type: target.v.type, distance: +target.d.toFixed(1), driverFree: target.driverFree });
      const walkDeadline = Date.now() + 20_000;
      await down(page, 'w');
      await down(page, 'shift');
      try {
        while (Date.now() < walkDeadline && target) {
          s = await stats(page);
          if (!s.alive || s.vehicleSeat) break;
          const next = pickVehicle(s, team);
          if (next && next.v.id !== target.v.id) { target = next; step('switching vehicle', { id: target.v.id, driverFree: target.driverFree }); }
          const row = s.vehicles.find(v => v.id === target?.v.id);
          if (!row) break;
          if (flat(s.feet, row) < 3.4) {
            await tap(page, 't', 90);
            await sleep(700);
            if ((await stats(page)).vehicleSeat) break;
          }
          await face(page, row);
          drain(page);
          await sleep(200);
        }
      } finally { await up(page, 'shift'); await up(page, 'w'); }
      s = await stats(page);
      step(s.vehicleSeat ? 'entered vehicle on foot' : 'could not reach a vehicle on foot', { seat: s.vehicleSeat, vehicle: s.vehicle && `${s.vehicle.type}:${s.vehicle.id}` });
      if (s.vehicleSeat) { await sleep(800); await shot(page, '03-vehicle-entered', `${s.vehicle?.type} ${s.vehicleSeat.id} seat (walked up, T)`); }
    }
    const homeFlags = meta.flags.filter(f => f.home === team);
    const flagC = meta.flags.find(f => f.id === 'C');
    const homeFlag = (homeFlags.length ? homeFlags : meta.flags).slice().sort((a, b) => flat(a, s.feet) - flat(b, s.feet))[0];
    let drove = false;
    if (s.vehicleSeat?.canDrive) {
      s = await drive(page, homeFlag, 45_000, { stopAt: homeFlag.radius * 0.7, shotName: '04-vehicle-driving' });
      drove = true;
    } else if (s.vehicleSeat) {
      await sleep(6000);
      await shot(page, '04-vehicle-riding', `${s.vehicleSeat.id} seat, bot driver`);
      await sleep(8000);
      await tap(page, 't', 90); await sleep(900);
    }

    // ---- on foot to the nearest home flag ------------------------------------
    s = await stats(page);
    if (s.vehicleSeat) { await tap(page, 't', 90); await sleep(1000); s = await stats(page); step(s.vehicleSeat ? 'exit failed' : 'left the vehicle'); }
    if (s.alive && flat(s.feet, homeFlag) > homeFlag.radius) {
      step(`walking to flag ${homeFlag.id}`, { distance: +flat(s.feet, homeFlag).toFixed(0) });
      s = await walk(page, homeFlag, 30_000, homeFlag.radius * 0.6);
    }
    if (s.alive) {
      await face(page, homeFlag);
      await sleep(600);
      await shot(page, '05-near-flag', `flag ${homeFlag.id}, ${flat(s.feet, homeFlag).toFixed(0)} m, on foot`);
      await tap(page, 'm', 80);
      await sleep(900);
      await shot(page, '07-big-map', 'M full map');
      await tap(page, 'm', 80);
      await sleep(300);
    }

    // ---- explosion: an over-cooked frag (detonates in hand) -> death -> deploy screen
    s = await stats(page);
    let fxShots = 0;
    for (let frag = 0; frag < 2 && s.alive && !s.vehicleSeat; frag++, s = await stats(page)) {
      await setPitch(page, -0.25);
      const hp0 = s.hp;
      await down(page, 'g');
      const pulledAt = Date.now();
      step('cooking a frag past its fuse', { grenades: s.throwable?.counts });
      let released = false, seen = false, timed = frag > 0;
      while (Date.now() - pulledAt < 9000 && !seen) {
        if (!released && Date.now() - pulledAt > 5400) { released = true; await up(page, 'g'); }
        // The 5 s fuse runs from the pin pull: catch the fireball itself once.
        if (!timed && Date.now() - pulledAt >= 4950) { timed = true; await shot(page, '08-explosion-fireball', 'frag 1 at its fuse time'); continue; }
        const ev = await page.evaluate(`(() => { const s = window.__vb.stats; return { alive: s.alive, hp: s.hp }; })()`);
        if (ev.hp < hp0 - 1 || !ev.alive) {
          await shot(page, `08-explosion${fxShots ? `-${fxShots + 1}` : ''}`, `frag ${frag + 1}: hp ${Math.round(ev.hp)}${ev.alive ? '' : ', killed by own frag'}`);
          fxShots++; seen = true;
          await sleep(1200);
        } else await sleep(40);
      }
      if (!released) await up(page, 'g');
      if (!seen) step('no frag damage observed within 9 s');
    }
    // Dead (frag or bots): deploy straight into a jeep/tank driver seat and drive to C.
    for (let i = 0; i < 30 && !(await stats(page)).alive; i++) {
      if (await handleDeploy(page, 'after death', { vehicleDriver: !drove })) break;
      await sleep(700);
    }
    s = await stats(page);
    if (s.alive && s.vehicleSeat && !drove) {
      await sleep(1500);
      await shot(page, '03-vehicle-deployed', `deployed into ${s.vehicle?.type} ${s.vehicleSeat.id} seat`);
      if (s.vehicleSeat.canDrive) {
        s = await drive(page, flagC, 45_000, { stopAt: flagC.radius + 10, shotName: '04-vehicle-driving' });
        drove = true;
        if (s.alive && s.vehicleSeat) {
          await shot(page, '06-vehicle-at-flag', `seated near flag C, ${flat(s.feet, flagC).toFixed(0)} m`);
          await tap(page, 't', 90); await sleep(1200);
          s = await stats(page);
          if (s.alive && !s.vehicleSeat) { await face(page, flagC); await sleep(500); await shot(page, '06-flag-on-foot', `dismounted near flag C, ${flat(s.feet, flagC).toFixed(0)} m`); }
        }
      }
    }

    // ---- remaining match time: fight near the flag, deploy after each death ----
    while (matchElapsed() < SECONDS) {
      drain(page);
      s = await stats(page);
      if (!s.alive) {
        await sleep(1200);
        if (!(await handleDeploy(page, 'after death'))) await sleep(800);
        continue;
      }
      // Hold W toward flag C briefly, fire a burst, sample.
      await face(page, meta.flags.find(f => f.id === 'C'));
      await down(page, 'w'); await sleep(1500); await up(page, 'w');
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: WIDTH / 2, y: HEIGHT / 2, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(400);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: WIDTH / 2, y: HEIGHT / 2, button: 'left', buttons: 0, clickCount: 1 });
      const sample = await page.evaluate(`(() => { const s = window.__vb.stats; return { alive: s.alive, hp: s.hp, avatars: s.avatars,
        vehicles: s.vehicles.length, drawCalls: s.drawCalls, chunks: s.chunks, lastSnapAgeMs: s.lastSnapAgeMs, ping: s.ping }; })()`);
      report.samples.push({ t: +matchElapsed().toFixed(1), ...sample });
    }
    await releaseAll(page);
    s = await stats(page);
    if (s.alive) await shot(page, '09-late-match', `t=${matchElapsed().toFixed(0)} s`);
    // Scoreboard (Tab held).
    await down(page, 'tab'); await sleep(700);
    await shot(page, '10-scoreboard', 'Tab scoreboard');
    await up(page, 'tab');

    // ---- frame timing --------------------------------------------------------
    const frames = await page.evaluate('window.__liveFrames.slice(-6000)');
    const sorted = frames.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length) {
      const q = p => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
      report.fps = { frames: sorted.length, p50Ms: q(0.5), p95Ms: q(0.95), maxMs: +sorted.at(-1).toFixed(1),
        fpsP50: +(1000 / q(0.5)).toFixed(1), over50ms: sorted.filter(x => x > 50).length };
    }
    // The game's own FrameRateController view, sampled every ~2 s in the timeline.
    const gameFps = report.timeline.map(t => t.fr?.renderedFps).filter(Number.isFinite).sort((a, b) => a - b);
    if (gameFps.length) report.gameFps = { samples: gameFps.length, min: +gameFps[0].toFixed(1),
      p10: +gameFps[Math.floor(gameFps.length * 0.1)].toFixed(1), median: +gameFps[Math.floor(gameFps.length / 2)].toFixed(1) };
    report.final = await page.evaluate(`(() => { const s = window.__vb.stats; return { alive: s.alive, avatars: s.avatars,
      vehicles: s.vehicles.map(v => v.type + '/' + v.team + (v.hp > 0 ? '' : '/wreck')), chunks: s.chunks, drawCalls: s.drawCalls,
      geometries: s.geometries, textures: s.textures, shaderErrors: s.shaderErrors, ping: s.ping, lastSnapAgeMs: s.lastSnapAgeMs,
      lastError: document.documentElement.dataset.vbLastError || null,
      hud: { conquest: !document.querySelector('.vb-conquest-hud')?.hidden,
        top: document.querySelector('.cq-top')?.innerText.replace(/\\s+/g, ' ').slice(0, 200) || null } }; })()`);
    drain(page);
    inMatch = false;
    step('match phase done', { fps: report.fps, gameFps: report.gameFps });
  } catch (error) {
    exitCode = 1;
    report.fatal = String(error.stack || error);
    console.error(error);
    if (browser) { try { drain(browser.page); await shot(browser.page, 'zz-failure', 'state at failure'); } catch {} }
  } finally {
    if (browser) await browser.close();
    report.consoleLog = consoleLog;
    // The file-persistence notice is expected in a throwaway test data dir.
    report.serverErrors = String(server.stderr || '').split('\n')
      .filter(line => line.trim() && !line.startsWith('[persistence] legacy JSON storage active')).slice(-80);
    report.serverStdoutTail = String(server.stdout || '').split('\n').filter(line => line.trim()).slice(-30);
    await stopServer(server);
  }
  const failures = [
    ...report.exceptions.map(e => `exception: ${e}`),
    ...report.consoleErrors.map(e => `console error: ${e}`),
    ...report.failedRequests.map(e => `failed request: ${e}`),
    ...report.httpErrors.map(e => `http: ${e}`),
    ...report.serverErrors.map(e => `server stderr: ${e}`),
  ];
  report.failures = failures.length;
  await writeFile(path.join(OUT, 'live-smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`warnings: ${report.consoleWarnings.length}, webgl: ${report.webgl.length}`);
  for (const w of [...new Set(report.consoleWarnings)].slice(0, 20)) console.log(`  warn: ${w.slice(0, 300)}`);
  for (const w of [...new Set(report.webgl)].slice(0, 20)) console.log(`  webgl: ${w.slice(0, 300)}`);
  if (failures.length) {
    console.error(`conquest live smoke: ${failures.length} runtime problem(s)`);
    for (const f of [...new Set(failures)].slice(0, 40)) console.error(`  - ${f.slice(0, 600)}`);
  }
  console.log(`report: ${path.relative(ROOT, path.join(OUT, 'live-smoke-report.json'))}`);
  process.exitCode = exitCode || (failures.length ? 1 : 0);
}

await main();
