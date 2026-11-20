// One real Fun match per viewport. Fire and reload through the normal input path,
// then check the server's own snapshots for both pins, the travelling seam and ammo.
// Run with node tools/selvedge-live-smoke.mjs [desktop|phone].
// BASE_URL exercises an existing deployment in a newly created, zero-bot lobby.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EYE_HEIGHT, WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { createMapState, isSolidBlock } from '../shared/worlddata.js';
import { raycastVoxels } from '../shared/raycast.js';
import { MOUSE_SENSITIVITY } from '../public/js/input-settings.js';
import { clickById, screenshotTo } from './lib/browser-helpers.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, '.artifacts', process.env.BASE_URL ? 'selvedge-deployed' : 'selvedge-live');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const slot = WEAPON_IDS.indexOf('selvedge');
const profiles = { desktop: { width: 1280, height: 720 }, phone: { width: 844, height: 390 } };
const selected = process.argv[2] ? [process.argv[2]] : Object.keys(profiles);
const row = `window.__vb.stats.players.find(p => p.id === window.__vb.stats.localId)`;
const map = createMapState('depot');
const solid = (x, y, z) => isSolidBlock(map.getBlock(x, y, z));
const wrapAngle = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

// Pick two visible faces present in the shipped map from this particular spawn.
// Prefer long, nearly level spans with both ends visible in the second sight picture.
function pickFaces({ feet, yaw }) {
  const eye = [feet.x, feet.y + EYE_HEIGHT, feet.z];
  const faces = [];
  for (let turn = -Math.PI; turn <= Math.PI; turn += 0.14) {
    const heading = yaw + turn;
    for (const pitch of [0.045, -0.03, -0.09, -0.145, -0.21, -0.29]) {
      const dir = [-Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), -Math.cos(heading) * Math.cos(pitch)];
      const hit = raycastVoxels(solid, ...eye, ...dir, 38);
      if (!hit || hit.t < 5) continue;
      const normal = [hit.nx, hit.ny, hit.nz];
      const pos = eye.map((v, i) => v + dir[i] * hit.t + normal[i] * 0.1);
      faces.push({ pos, yaw: heading, pitch, normal });
    }
  }
  let best;
  for (const a of faces) for (const b of faces) {
    const delta = b.pos.map((v, i) => v - a.pos[i]);
    const span = Math.hypot(...delta);
    const angle = wrapAngle(a.yaw - b.yaw);
    if (span < 5 || span > 14 || angle < 0.18 || angle > 0.6) continue;
    if (raycastVoxels(solid, ...a.pos, ...delta, span)) continue;
    const score = Math.abs(10 - span) + 18 * Math.abs(a.pitch - b.pitch)
      + Math.abs(wrapAngle(yaw - a.yaw)) * 0.4 + (a.normal[1] || b.normal[1] ? 1 : 0);
    if (!best || score < best.score) best = { a, b, span, score };
  }
  assert.ok(best, 'this spawn has a visible pair of surfaces');
  return best;
}

async function aim(page, target) {
  for (let step = 0; step < 8; step++) {
    const { yaw, pitch } = await page.evaluate('({ yaw: __vb.stats.yaw, pitch: __vb.stats.pitch })');
    const dx = wrapAngle(yaw - target.yaw), dy = pitch - target.pitch;
    if (Math.hypot(dx, dy) < 0.009) {
      await page.waitFor(`Math.hypot(__vb.stats.gunLag.yaw, __vb.stats.gunLag.pitch) < 0.004`, { label: 'instrument settled at selected surface' });
      return;
    }
    // Relative look through Input's regular mousemove listener in headless mode.
    await page.evaluate(`document.dispatchEvent(new MouseEvent('mousemove', { bubbles:true,
      movementX:${Math.round(dx / MOUSE_SENSITIVITY.default)}, movementY:${Math.round(dy / MOUSE_SENSITIVITY.default)} }))`);
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  throw new Error('look input did not reach requested surface');
}

function observe(page, report) {
  for (const { method, params } of page.events.splice(0)) {
    if (method === 'Network.webSocketFrameReceived' && params.response.opcode === 1) {
      const data = JSON.parse(params.response.payloadData);
      for (const ev of data.events || []) {
        if (ev.id === report.id && (ev.kind === 'stitch' || (ev.kind === 'shoot' && ev.w === 'selvedge'))) report.events.push(ev);
      }
    } else if (method === 'Network.responseReceived' && params.response.status >= 400) {
      report.errors.push(`${params.response.status} ${params.response.url}`);
    } else if (method === 'Runtime.consoleAPICalled' && ['assert', 'error'].includes(params.type)) {
      report.errors.push(params.args.map(arg => arg.value ?? arg.description).join(' '));
    }
  }
}

async function waitEvent(page, report, phase, offset) {
  const deadline = Date.now() + 5000;
  do {
    observe(page, report);
    const event = report.events.slice(offset).find(ev => ev.kind === 'stitch' && ev.phase === phase);
    if (event) return event;
    await sleep(25);
  } while (Date.now() < deadline);
  throw new Error(`authority did not confirm ${phase}: ${JSON.stringify(report.events.slice(offset))}`);
}

async function key(page, key, code) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
    await sleep(60);
  }
}

async function touch(page, action) {
  const point = await page.evaluate(`(() => { const r = document.getElementById('touch-${action}').getBoundingClientRect();
    return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await sleep(70);
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function startMatch(page) {
  await page.waitFor(`window.__vb && document.getElementById('create-lobby-btn')?.disabled === false`, { timeoutMs: 120000 });
  await clickById(page, 'create-lobby-btn');
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  for (const [id, value] of [['game-mode-select','fun'], ['map-select','depot'], ['bot-count','0']]) {
    await page.evaluate(`(() => { const s = document.getElementById('${id}'); s.value='${value}';
      s.dispatchEvent(new Event('change', { bubbles:true })); })()`);
    await page.waitFor(`document.getElementById('${id}').value === '${value}'`);
  }
  await clickById(page, 'lobby-ready-btn');
  await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled === false`);
  await clickById(page, 'lobby-start-btn');
  await page.waitFor(`window.__vb.stats.running && window.__vb.stats.alive && window.__vb.stats.grounded &&
    window.__vb.stats.weapon === 'selvedge' && ${row}?.weapon === ${slot} && !${row}.deploying && !${row}.spawnProtected`, { timeoutMs: 120000, label: 'live Selvedge loadout' });
}

async function run(base, profile) {
  const { width, height } = profiles[profile];
  const mobile = profile === 'phone';
  const dir = path.join(out, profile);
  await mkdir(dir, { recursive: true });
  const args = process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : [];
  const browser = await launchCdpSession('about:blank', { width, height, extraArgs: args });
  const { page } = browser;
  const report = { profile, width, height, events: [], errors: [] };
  const capture = filename => screenshotTo(page, dir, `${filename}.png`);
  const button = (type, name) => page.send('Input.dispatchMouseEvent', { type, x: width / 2, y: height / 2, button: name,
    buttons: type === 'mousePressed' ? (name === 'left' ? 1 : 2) : 0, clickCount: 1 });
  const fire = async () => {
    if (mobile) return touch(page, 'fire');
    await button('mousePressed', 'left'); await sleep(65); await button('mouseReleased', 'left');
  };
  try {
    await page.send('Network.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile, deviceScaleFactor: 1 });
    if (mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const url = new URL('/?debug=1&headless=1&weapon=selvedge', base);
    if (mobile) url.searchParams.set('touch', '1');
    await page.send('Page.navigate', { url: url.href });
    await startMatch(page);
    report.id = await page.evaluate('__vb.stats.localId');
    if (!mobile) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width / 2, y: height / 2 });
      await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    }
    report.faces = pickFaces(await page.evaluate('({ feet:__vb.stats.feet, yaw:__vb.stats.yaw })'));
    report.startAmmo = await page.evaluate(`${row}.mag[${slot}]`);
    assert.equal(report.startAmmo, WEAPONS.selvedge.magSize);
    await aim(page, report.faces.a);
    await page.waitFor(`document.querySelector('.vb-charge-label')?.textContent === 'PIN FIRST SURFACE'`);
    await capture('01-held');
    await fire();
    const pin = await waitEvent(page, report, 'pin', 0);
    assert.equal(pin.a.length, 3);
    await page.waitFor(`document.querySelector('.vb-charge-label')?.textContent.startsWith('PIN SECOND SURFACE')`, { label: 'confirmed pin reaches the HUD' });
    await capture('02-pinned');
    await aim(page, report.faces.b);
    await sleep(200);
    const offset = report.events.length;
    await fire();
    const sew = await waitEvent(page, report, 'sew', offset);
    assert.deepEqual(sew.a, pin.a);
    assert.ok(sew.ms > 0 && Math.hypot(...sew.b.map((n, i) => n - sew.a[i])) > 2);
    await page.waitFor(`document.querySelector('.vb-charge-label')?.textContent === 'PIN FIRST SURFACE'`, { label: 'completed pair frees the next anchor' });
    await sleep(Math.min(150, sew.ms * 0.25));
    await capture('03-seam');
    await page.waitFor(`${row}.mag[${slot}] === ${report.startAmmo - 2}`, { label: 'two pulls consumed' });
    if (mobile) await touch(page, 'ads'); else await button('mousePressed', 'right');
    await page.waitFor('__vb.stats.adsT > 0.9', { label: 'sights aligned' });
    await capture('04-sights');
    if (mobile) await touch(page, 'ads'); else await button('mouseReleased', 'right');
    if (mobile) await touch(page, 'reload'); else await key(page, 'r', 'KeyR');
    await page.waitFor(`${row}.reloading`, { label: 'server accepted cassette change' });
    await sleep(WEAPONS.selvedge.tacTime * 380);
    await capture('05-cassette');
    await page.waitFor(`${row}.mag[${slot}] === ${report.startAmmo} && !${row}.reloading`, { label: 'full cassette seated' });
    if (mobile) await touch(page, 'weapon'); else await key(page, '1', 'Digit1');
    await page.waitFor(`__vb.stats.weapon !== 'selvedge' && ${row}.weapon !== ${slot}`, { label: 'weapon switched' });
    observe(page, report);
    report.errors.push(...page.errors, ...await page.evaluate('__vb.stats.shaderErrors'));
    assert.deepEqual(report.errors, [], 'browser and shader diagnostics');
    report.ok = true;
    console.log(`${profile} passed: ${report.startAmmo} pulls, ${Math.round(sew.ms)} ms seam, sights, cassette and switch; ${dir}`);
  } catch (error) {
    observe(page, report);
    report.failure = String(error.stack || error);
    report.diagnostics = await page.evaluate(`(() => {const s=window.__vb?.stats; return s && {localId:s.localId, alive:s.alive,running:s.running,weapon:s.weapon, feet:s.feet, ads:s.adsT, device:s.device, centre:document.elementFromPoint(innerWidth/2,innerHeight/2)?.outerHTML.slice(0,200), snapshot:${row}, shaderErrors:s.shaderErrors};})()`).catch(() => null);
    report.errors.push(...page.errors);
    await capture('failure').catch(() => {});
    throw error;
  } finally {
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await browser.close();
  }
}

assert.ok(selected.every(name => profiles[name]), 'choose desktop or phone');
assert.ok(slot >= 0, 'Selvedge is present in the roster');
const server = process.env.BASE_URL ? null : startServer({ cwd: root, failureContext: 'Selvedge live smoke' });
try {
  let base = process.env.BASE_URL;
  if (server) {
    const port = await server.port;
    await waitForHttp(port);
    base = `http://127.0.0.1:${port}`;
  }
  for (const profile of selected) await run(base, profile);
} finally { if (server) await stopServer(server); }
