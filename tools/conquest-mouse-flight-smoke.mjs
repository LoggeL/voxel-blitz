#!/usr/bin/env node
/**
 * Live mouse-flight check: the real client in a real Frontier Conquest match.
 *
 * Starts the game server, opens ONE muted headless CDP browser
 * (tools/lib/cdp-session.mjs, --mute-audio), creates a Conquest lobby on
 * Frontier, kills the player with an over-cooked frag, deploys into the HQ jet
 * from the deploy screen and flies it with mouse flight (the desktop default):
 * W throttle, then only mousemove events for the stick (an in-page "hand"
 * turns a wanted stick deflection into pointer motion each frame). It takes
 * off, climbs, bank-turns right and levels out, checking the authoritative
 * hull attitude from the snapshots. Screenshots and mouse-flight-report.json
 * land in --out.
 *
 *   node tools/conquest-mouse-flight-smoke.mjs [--out <dir>] [--bots 0] [--software]
 *
 * Not part of npm test (needs a local Chromium); run it through
 * .conquest-work/heavy.sh on a shared machine.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const OUT = path.resolve(ROOT, option('out', 'docs/design/conquest/redesign/captures/mouseflight'));
const BOTS = Number(option('bots', 0));
const SOFTWARE = argv.includes('--software');
const WIDTH = 1280, HEIGHT = 720;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const t0 = Date.now();
const report = { started: new Date().toISOString(), bots: BOTS, steps: [], samples: [], screenshots: [], exceptions: [], consoleErrors: [], checks: {} };
const step = (text, extra = {}) => {
  const entry = { at: +((Date.now() - t0) / 1000).toFixed(1), text, ...extra };
  report.steps.push(entry);
  console.log(`[${entry.at.toFixed(1)}s] ${text}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`);
};
function drain(page) {
  for (const { method, params } of page.events.splice(0)) {
    if (method === 'Runtime.exceptionThrown') report.exceptions.push(String(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text).slice(0, 800));
    if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'assert')) {
      report.consoleErrors.push(params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 600));
    }
  }
}
const KEYS = { w: ['w', 'KeyW', 87], g: ['g', 'KeyG', 71] };
const key = (page, name, type) => { const [k, code, vk] = KEYS[name]; return page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); };
async function clickId(page, id) {
  const point = await page.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)});
    el?.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el?.getBoundingClientRect();
    return r && r.width && r.height && !el.disabled ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
  if (!point) throw new Error(`#${id} is not clickable`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
}
const select = (page, id, value) => page.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)});
  el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
async function shot(page, name, note) {
  const capture = await page.send('Page.captureScreenshot', { format: 'png' }, 30_000);
  const file = path.join(OUT, `${name}.png`);
  await writeFile(file, Buffer.from(capture.data, 'base64'));
  report.screenshots.push({ name, file: path.relative(ROOT, file), note });
  step(`screenshot ${name}`, { note });
}
/** Light state read: alive, seat and the presented (snapshot) hull. */
const state = page => page.evaluate(`(() => { const s = window.__vb.stats; const v = s.vehicle;
  return { alive: s.alive, hp: s.hp, seat: s.vehicleSeat?.id ?? null, vehicle: v ? { id: v.id, type: v.type, x: v.x, y: v.y, z: v.z,
    yaw: v.yaw ?? 0, pitch: v.pitch ?? 0, roll: v.roll ?? 0, vy: v.vy ?? 0, speed: v.speed ?? Math.hypot(v.vx ?? 0, v.vy ?? 0, v.vz ?? 0),
    grounded: v.grounded !== false } : null }; })()`);
/** In-page hand: each animation frame turns window.__stick into pointer motion for mouse flight. */
const HAND = `(() => {
  window.__stick = { x: 0, y: 0 }; let fx = 0, fy = 0, last = performance.now();
  const sens = (() => { const v = parseFloat(localStorage.getItem('vb-sens-v2')); return v > 0 ? v : 0.003; })();
  const tick = now => { const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const px = window.__stick.x * 2 * dt / sens + fx, py = -window.__stick.y * 2 * dt / sens + fy;
    const mx = Math.round(px), my = Math.round(py); fx = px - mx; fy = py - my;
    if (mx || my) document.dispatchEvent(new MouseEvent('mousemove', { movementX: mx, movementY: my, bubbles: true }));
    requestAnimationFrame(tick); };
  requestAnimationFrame(tick); return sens; })()`;
const stick = (page, x, y) => page.evaluate(`window.__stick.x = ${clamp(x, -1, 1)}; window.__stick.y = ${clamp(y, -1, 1)};`);

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = startServer({ cwd: ROOT, failureContext: 'Conquest mouse-flight smoke', ringBuffer: 64_000 });
  let browser = null, exitCode = 0;
  try {
    const port = await server.port;
    await waitForHttp(port);
    browser = await launchCdpSession(`http://127.0.0.1:${port}/?debug=1&headless=1`, { width: WIDTH, height: HEIGHT,
      softwareRendering: SOFTWARE, extraArgs: SOFTWARE ? [] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
    const page = browser.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await page.waitFor(`!!window.__vb && document.getElementById('create-lobby-btn')?.disabled === false`, { timeoutMs: 180_000, label: 'menu ready' });
    report.checks.flightModeDefault = await page.evaluate(`localStorage.getItem('vb-flight-controls') || 'aim (default)'`);
    // This smoke flies the mouse stick (the hand below deflects a spring stick);
    // mouse aim is the default, so select the stick and reload the client.
    await page.evaluate(`localStorage.setItem('vb-flight-controls', 'mouse'); location.reload(); true`);
    await sleep(1500);
    await page.waitFor(`!!window.__vb && document.getElementById('create-lobby-btn')?.disabled === false`, { timeoutMs: 180_000, label: 'menu ready (mouse stick)' });
    step('menu ready', { flightMode: report.checks.flightModeDefault, flown: 'mouse' });
    await clickId(page, 'create-lobby-btn');
    await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`, { label: 'lobby open' });
    await select(page, 'game-mode-select', 'conquest');
    await select(page, 'map-select', 'frontier');
    await page.waitFor(`document.getElementById('map-select').value === 'frontier'`, { label: 'frontier selected' });
    await select(page, 'bot-count', String(BOTS));
    await sleep(800);
    await clickId(page, 'lobby-ready-btn');
    await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled === false`, { timeoutMs: 15_000, label: 'start enabled' });
    const joinAt = Date.now();
    await clickId(page, 'lobby-start-btn');
    await page.waitFor(`window.__vb.stats.running && window.__vb.stats.ringLen > 0`, { timeoutMs: 240_000, intervalMs: 500, label: 'match running' });
    step('match running', { seconds: +((Date.now() - joinAt) / 1000).toFixed(1) });
    drain(page);

    // Alive at HQ -> over-cooked frag -> deploy screen -> the HQ jet's pilot seat.
    await page.waitFor(`window.__vb.stats.alive || !!document.querySelector('.cq-deploy-button')?.offsetParent`, { timeoutMs: 60_000, label: 'alive or deploy' });
    await sleep(3000);
    for (let frag = 0; frag < 3 && (await state(page)).alive; frag++) {
      // Hold G past the 5 s fuse: the frag goes off in hand (a second one if the first leaves a sliver).
      await key(page, 'g', 'keyDown');
      await page.waitFor(`!window.__vb.stats.alive`, { timeoutMs: 8_000, intervalMs: 200, label: 'frag cook-off death' }).catch(() => {});
      await key(page, 'g', 'keyUp');
      step(`frag ${frag + 1}`, { hp: (await state(page)).hp });
      await sleep(1500);
    }
    if ((await state(page)).alive) throw new Error('still alive after cooking off the frags');
    await page.waitFor(`!!document.querySelector('.cq-deploy-button')?.offsetParent`, { timeoutMs: 30_000, label: 'deploy screen' });
    await sleep(1500);
    const labels = await page.evaluate(`[...document.querySelectorAll('.cq-spawn[data-kind="vehicle"]')].map(b => b.querySelector('b')?.textContent + (b.disabled ? ' (off)' : ''))`);
    step('vehicle spawns', { labels });
    const picked = await page.evaluate(`(() => { for (const row of document.querySelectorAll('.cq-spawn-row')) {
      const main = row.querySelector('.cq-spawn[data-kind="vehicle"][data-ok="true"]');
      if (!main || !/JET|FIGHTER|PLANE/i.test(main.querySelector('b')?.textContent || '')) continue;
      main.click(); return main.querySelector('b').textContent; } return null; })()`);
    if (!picked) throw new Error(`no free jet on the deploy screen (${labels.join(', ')})`);
    step('deploy choice', { picked });
    await sleep(500);
    await shot(page, '01-deploy-jet', `deploy screen with ${picked} selected`);
    const deployBy = Date.now() + 30_000;
    while (Date.now() < deployBy && !(await state(page)).alive) {
      await page.evaluate(`document.querySelector('.cq-deploy-button')?.click()`);
      await sleep(1000);
    }
    let s = await state(page);
    if (!s.alive || s.vehicle?.type !== 'plane' || s.seat == null) throw new Error(`not seated in the jet: ${JSON.stringify(s)}`);
    step('seated in the jet', { seat: s.seat, pos: [s.vehicle.x, s.vehicle.y, s.vehicle.z].map(Math.round), yaw: +s.vehicle.yaw.toFixed(2) });
    report.checks.sens = await page.evaluate(HAND);
    await sleep(2500);
    await shot(page, '02-jet-on-pad', 'mouse flight, before the takeoff roll');

    const sample = async (phase, extra = {}) => {
      s = await state(page);
      const v = s.vehicle;
      if (!s.alive || !v) throw new Error(`lost the jet during ${phase}: ${JSON.stringify(s)}`);
      report.samples.push({ t: +((Date.now() - t0) / 1000).toFixed(2), phase, y: +v.y.toFixed(1), speed: +(v.speed ?? 0).toFixed(1),
        yaw: +v.yaw.toFixed(3), pitch: +v.pitch.toFixed(3), roll: +v.roll.toFixed(3), vy: +(v.vy ?? 0).toFixed(2), grounded: !!v.grounded, ...extra });
      drain(page);
      return v;
    };
    // Samples where the hull rolls against a firm stick (only the server's
    // boundary autopilot does that): reported, and a sign the run left the interior.
    let opposedSamples = 0, lastX = 0, lastRoll = null;
    const fly = async (phase, seconds, control, until = () => false) => {
      const end = Date.now() + seconds * 1000;
      while (Date.now() < end) {
        const v = await sample(phase);
        if (lastRoll !== null && Math.abs(lastX) > 0.6 && (v.roll - lastRoll) * lastX > 0.02) opposedSamples++;
        lastRoll = v.roll;
        if (until(v)) break;
        const [x, y] = control(v);
        lastX = clamp(x, -1, 1);
        await stick(page, x, y);
        await sleep(70);
      }
      return sample(phase);
    };
    // Jet stick laws a pilot would use: Y toward a pitch (or flat path), X toward a bank.
    const pitchTo = target => v => (target - v.pitch) * 2.5;
    const rollTo = target => v => -(target - v.roll) * 1.5;

    const pad = s.vehicle, groundY = pad.y;
    await key(page, 'w', 'keyDown');
    step('throttle up (W held for the whole flight)');
    let v = await fly('takeoff-roll', 30, () => [0, 0], u => (u.speed ?? 0) >= 30);
    step('rotation speed', { speed: +(v.speed ?? 0).toFixed(1) });
    v = await fly('rotate-climb', 10, u => [rollTo(0)(u), pitchTo(0.25)(u)], u => !u.grounded && u.y > groundY + 25);
    await shot(page, '03-jet-climb', `climbing, +${(v.y - groundY).toFixed(0)} m, pitch ${v.pitch.toFixed(2)}`);
    step('climbed', { climb: +(v.y - groundY).toFixed(1), pitch: +v.pitch.toFixed(2) });
    // The west runway points north at the map edge: bank right onto an eastbound
    // course toward the middle before the flight-boundary autopilot would step in.
    const heading = v.yaw, east = -Math.PI / 2;
    let maxBank = 0, bankShot = false;
    v = await fly('bank-turn', 12, u => {
      maxBank = Math.max(maxBank, -u.roll);
      return [rollTo(-1)(u), pitchTo(0.15)(u)];
    }, u => wrap(u.yaw - east) < 0.3);
    if (!bankShot) { bankShot = true; await shot(page, '04-jet-bank', `right bank ${(-v.roll).toFixed(2)} rad, heading ${v.yaw.toFixed(2)}`); }
    const turned = wrap(heading - v.yaw);
    step('bank turn', { maxBank: +maxBank.toFixed(2), turned: +turned.toFixed(2) });
    v = await fly('level-out', 4, u => [rollTo(0)(u), clamp(-(u.vy ?? 0) * 0.06, -0.6, 0.6)]);
    await stick(page, 0, 0);
    await sleep(1500);
    v = await sample('released');
    await shot(page, '05-jet-level', `level: roll ${v.roll.toFixed(2)}, pitch ${v.pitch.toFixed(2)}, vy ${(v.vy ?? 0).toFixed(1)}, ${Math.round(v.speed)} m/s`);
    await key(page, 'w', 'keyUp');
    const climb = Math.max(...report.samples.map(row => row.y)) - groundY;
    Object.assign(report.checks, { climb: +climb.toFixed(1), maxBank: +maxBank.toFixed(2), turned: +turned.toFixed(2),
      endRoll: +v.roll.toFixed(3), endPitch: +v.pitch.toFixed(3), endVy: +(v.vy ?? 0).toFixed(2), endSpeed: +v.speed.toFixed(1),
      endPos: [v.x, v.y, v.z].map(Math.round), opposedSamples });
    const failures = [];
    if (!(climb > 25)) failures.push(`climb ${climb.toFixed(1)} m`);
    if (!(maxBank > 0.6)) failures.push(`bank ${maxBank.toFixed(2)}`);
    if (!(turned > 1)) failures.push(`turn ${turned.toFixed(2)} rad`);
    if (!(Math.abs(v.roll) < 0.15)) failures.push(`end roll ${v.roll.toFixed(2)}`);
    if (!(Math.abs(v.vy ?? 0) < 4)) failures.push(`end vy ${(v.vy ?? 0).toFixed(1)}`);
    // The boundary autopilot caps a jet at 48 m/s and banks against the stick.
    if (!(v.speed > 50)) failures.push(`end speed ${v.speed.toFixed(1)} (boundary autopilot?)`);
    report.checks.failures = failures;
    step(failures.length ? 'FLIGHT CHECK FAILED' : 'flight check passed', report.checks);
    if (failures.length) exitCode = 1;
  } catch (error) {
    exitCode = 1;
    report.fatal = String(error.stack || error);
    console.error(error);
    if (browser) { try { drain(browser.page); await shot(browser.page, 'zz-failure', 'state at failure'); } catch {} }
  } finally {
    if (browser) await browser.close();
    report.serverErrors = String(server.stderr || '').split('\n')
      .filter(line => line.trim() && !line.startsWith('[persistence] legacy JSON storage active')).slice(-40);
    await stopServer(server);
  }
  if (report.exceptions.length) { exitCode = 1; console.error('page exceptions:', report.exceptions.slice(0, 5)); }
  await writeFile(path.join(OUT, 'mouse-flight-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${path.relative(ROOT, path.join(OUT, 'mouse-flight-report.json'))}`);
  process.exitCode = exitCode;
}

await main();
