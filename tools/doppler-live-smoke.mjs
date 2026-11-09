#!/usr/bin/env node
/**
 * Live SP-2 DOPPLER smoke: the real client holding the rifle in a real match.
 *
 *   node tools/doppler-live-smoke.mjs [--out <dir>] [--mode tdm] [--map killhouse]
 *
 * One muted headless CDP browser (tools/lib/cdp-session.mjs, --mute-audio) boots the
 * client with ?debug=1&weapon=doppler, starts a small lobby with bots, fires held
 * doublets, aims, reloads and switches weapons. Any uncaught exception, console error
 * or HTTP error fails the run. Not part of npm test (needs a local Chromium).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const OUT = path.resolve(ROOT, option('out', '.artifacts/doppler-live'));
const MODE = option('mode', 'tdm');
const MAP = option('map', 'killhouse');
const WIDTH = 1280, HEIGHT = 720;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { exceptions: [], consoleErrors: [], httpErrors: [], steps: [], samples: {} };

function drain(page) {
  for (const { method, params } of page.events.splice(0)) {
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      report.exceptions.push(`${d?.exception?.description || d?.text || 'exception'}`.slice(0, 1200));
    } else if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'assert')) {
      report.consoleErrors.push(params.args.map(a => a.value !== undefined ? String(a.value) : a.description || a.type).join(' ').slice(0, 600));
    } else if (method === 'Log.entryAdded' && params.entry.level === 'error') {
      report.consoleErrors.push(`${params.entry.source}: ${params.entry.text} ${params.entry.url || ''}`.slice(0, 600));
    } else if (method === 'Network.responseReceived' && params.response.status >= 400) {
      report.httpErrors.push(`${params.response.status} ${params.response.url}`);
    }
  }
}
async function clickId(page, id) {
  const point = await page.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)});
    el?.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el?.getBoundingClientRect();
    return r && r.width && r.height && !el.disabled ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
  if (!point) throw new Error(`#${id} is not clickable`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}
const select = (page, id, value) => page.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)});
  el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const mouse = (page, type, button) => page.send('Input.dispatchMouseEvent', { type, x: WIDTH / 2, y: HEIGHT / 2, button,
  buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: 1 });
const key = (page, type, k, code, vk) => page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const state = page => page.evaluate(`(() => { const s = window.__vb.stats; return { running: s.running, alive: s.alive, weapon: s.weapon,
  ammo: (document.getElementById('ammo')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60), drawCalls: s.drawCalls, hp: s.hp }; })()`);
async function shot(page, name) {
  const capture = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30_000);
  await writeFile(path.join(OUT, `${name}.png`), Buffer.from(capture.data, 'base64'));
  report.steps.push(`screenshot ${name}`);
}

await mkdir(OUT, { recursive: true });
const server = startServer({ cwd: ROOT, failureContext: 'DOPPLER live smoke', ringBuffer: 64_000 });
let browser = null;
let exitCode = 0;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/?debug=1&headless=1&weapon=doppler`, {
    width: WIDTH, height: HEIGHT, extraArgs: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = browser.page;
  await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`!!window.__vb && document.getElementById('create-lobby-btn')?.disabled === false`, { timeoutMs: 180_000, label: 'menu ready' });
  drain(page);
  await clickId(page, 'create-lobby-btn');
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`, { label: 'lobby open' });
  await select(page, 'game-mode-select', MODE);
  await select(page, 'map-select', MAP);
  await select(page, 'bot-count', '3');
  await sleep(800);
  await clickId(page, 'lobby-ready-btn');
  await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled === false`, { timeoutMs: 15_000, label: 'start enabled' });
  await clickId(page, 'lobby-start-btn');
  await page.waitFor(`window.__vb.stats.running && window.__vb.stats.alive`, { timeoutMs: 240_000, intervalMs: 500, label: 'match running' });
  await sleep(1800);
  let s = await state(page);
  report.samples.start = s;
  if (s.weapon !== 'doppler') throw new Error(`expected the SP-2 DOPPLER in hand, got ${s.weapon}`);
  await shot(page, '01-held');

  // Held trigger: doublets at the pull cadence.
  await mouse(page, 'mousePressed', 'left');
  await sleep(120);
  await shot(page, '02-firing');
  await sleep(1100);
  await mouse(page, 'mouseReleased', 'left');
  await sleep(300);
  s = await state(page);
  report.samples.afterFire = s;
  await shot(page, '03-after-fire');

  // Aim down the prism sight and fire one doublet.
  await mouse(page, 'mousePressed', 'right');
  await sleep(700);
  await shot(page, '04-ads');
  await mouse(page, 'mousePressed', 'left'); await sleep(60); await mouse(page, 'mouseReleased', 'left');
  await sleep(250);
  await mouse(page, 'mouseReleased', 'right');
  await sleep(400);

  // Reload: the canted smoke magazine leaves, the full one arrives.
  await key(page, 'keyDown', 'r', 'KeyR', 82); await sleep(80); await key(page, 'keyUp', 'r', 'KeyR', 82);
  await sleep(900);
  await shot(page, '05-reload');
  await sleep(2400);
  s = await state(page);
  report.samples.afterReload = s;

  // Away and back through the wheel order (scroll), so the rig rebuilds nothing twice.
  await key(page, 'keyDown', '1', 'Digit1', 49); await sleep(60); await key(page, 'keyUp', '1', 'Digit1', 49);
  await sleep(900);
  report.samples.switched = await state(page);
  await sleep(600);
  drain(page);
  if (report.exceptions.length || report.consoleErrors.length || report.httpErrors.length) exitCode = 1;
} catch (error) {
  report.failure = String(error?.stack || error);
  exitCode = 1;
  if (browser) { drain(browser.page); await shot(browser.page, 'zz-failure').catch(() => {}); }
} finally {
  await browser?.close();
  await stopServer(server);
}
await writeFile(path.join(OUT, 'doppler-live-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: exitCode === 0, ...report.samples, exceptions: report.exceptions.length,
  consoleErrors: report.consoleErrors.slice(0, 5), httpErrors: report.httpErrors.slice(0, 5), failure: report.failure?.slice(0, 600) }, null, 1));
process.exit(exitCode);
