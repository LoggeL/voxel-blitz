import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = startServer({ cwd: root, failureContext: 'weapon wheel browser test' });
let browser;

async function desktopBrowser() {
  // The normal screenshot helper prefers Playwright's headless-shell binary;
  // native pointer lock requires a full Chromium browser instead.
  const candidates = process.env.WEAPON_WHEEL_BROWSER ? [process.env.WEAPON_WHEEL_BROWSER] : [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
  ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('Native pointer-lock test needs a desktop Chromium browser; set WEAPON_WHEEL_BROWSER to its executable.');
}

async function key(page, type, code = 'KeyQ', repeat = false) {
  const name = code === 'Escape' ? 'Escape' : code.slice(3).toLowerCase();
  await page.send('Input.dispatchKeyEvent', {
    type, code, key: name, autoRepeat: repeat,
    windowsVirtualKeyCode: code === 'Escape' ? 27 : name.toUpperCase().charCodeAt(0),
  });
}

async function frames(page) {
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function startMatch(page, url) {
  await page.send('Page.navigate', { url });
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete' &&
    window.__vb && !window.__vb.stats.running &&
    document.getElementById('menu')?.getAttribute('aria-hidden') === 'false'`, {
    label: 'new document and main menu are ready',
  });
  await page.evaluate(`document.getElementById('create-lobby-btn').click()`);
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  for (const [id, value] of [['game-mode-select', 'fun'], ['map-select', 'depot'], ['bot-count', '0']]) {
    await page.evaluate(`(() => {
      const select = document.getElementById(${JSON.stringify(id)});
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.waitFor(`document.getElementById(${JSON.stringify(id)}).value === ${JSON.stringify(value)}`);
  }
  await page.evaluate(`document.getElementById('lobby-ready-btn').click()`);
  await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled === false`);
  await page.evaluate(`document.getElementById('lobby-start-btn').click()`);
  await page.waitFor(`window.__vb.stats.running && window.__vb.stats.alive &&
    window.__vb.stats.ringLen > 0 && !window.__vb.stats.settingsOpen`, {
    timeoutMs: 30_000, label: 'live Fun match with no bots',
  });
}

async function openWheel(page) {
  await key(page, 'keyDown');
  await page.waitFor(`window.__vb.wheelOpen &&
    document.querySelectorAll('#weapon-wheel .vb-wheel-slot').length === ${WEAPON_IDS.length}`, {
    label: 'held Q opens the complete weapon wheel',
  });
}

async function geometry(page, slot) {
  return page.evaluate(`(() => {
    const ring = document.querySelector('#weapon-wheel .vb-wheel-ring').getBoundingClientRect();
    const card = document.querySelectorAll('#weapon-wheel .vb-wheel-slot')[${slot}].getBoundingClientRect();
    return {
      center: { x: ring.left + ring.width / 2, y: ring.top + ring.height / 2 },
      radius: ring.width / 2,
      card: { x: card.left + card.width / 2, y: card.top + card.height / 2 },
    };
  })()`);
}

async function expectSelection(page, id, label) {
  await page.waitFor(`!window.__vb.wheelOpen && window.__vb.stats.weapon === ${JSON.stringify(id)}`, { label });
  console.log(`ok - ${label}`);
}

async function mouse(page, point) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
}

try {
  const port = await server.port;
  await waitForHttp(port);
  const url = `http://127.0.0.1:${port}/?debug=1&headless=1`;
  browser = await launchCdpSession(url + '&touch=1');
  let { page } = browser;
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await startMatch(page, url + '&touch=1');
  assert.equal(await page.evaluate('document.pointerLockElement === null'), true,
    'unlocked session uses the rendered pointer target');

  const before = await page.evaluate('window.__vb.stats.weapon');
  await openWheel(page);
  await key(page, 'keyDown', 'KeyQ', true);
  await key(page, 'keyDown', 'KeyW');
  await key(page, 'keyUp', 'KeyW');
  await frames(page);
  assert.equal(await page.evaluate('window.__vb.wheelOpen'), true,
    'Q repeat and an ordinary movement key do not cancel the wheel');
  console.log('ok - Q repeat and movement keys keep the wheel open');

  const knifeSlot = WEAPON_IDS.indexOf('knife');
  let wheel = await geometry(page, knifeSlot);
  await mouse(page, wheel.card);
  await page.waitFor(`document.querySelectorAll('#weapon-wheel .vb-wheel-slot')[${knifeSlot}].classList.contains('is-hl')`, {
    label: 'actual knife card is highlighted by pointer hover',
  });
  assert.equal(await page.evaluate('window.__vb.stats.weapon'), before,
    'hovering a card previews without equipping before Q release');
  assert.equal(await page.evaluate('window.__vb.wheelOpen'), true);
  if (process.env.WEAPON_WHEEL_SCREENSHOT) {
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' }, 15_000);
    await writeFile(process.env.WEAPON_WHEEL_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await key(page, 'keyUp');
  await expectSelection(page, 'knife', 'Q release equips the visibly highlighted card');

  await openWheel(page);
  wheel = await geometry(page, WEAPON_IDS.indexOf('sniper'));
  await mouse(page, { x: wheel.center.x + wheel.radius * 1.55, y: wheel.center.y });
  await expectSelection(page, 'sniper', 'outward radial mouse movement equips before Q release');
  for (let i = 0; i < 3; i++) await key(page, 'keyDown', 'KeyQ', true);
  await frames(page);
  assert.equal(await page.evaluate('window.__vb.wheelOpen'), false,
    'a continued Q hold does not reopen after radial selection');
  await key(page, 'keyUp');
  await frames(page);
  assert.equal(await page.evaluate('window.__vb.stats.weapon'), 'sniper');
  console.log('ok - radial selection stays closed until the held Q is released');

  await openWheel(page);
  wheel = await geometry(page, knifeSlot);
  await mouse(page, wheel.center);
  await key(page, 'keyUp');
  await expectSelection(page, 'sniper', 'releasing Q in the center keeps the current weapon');
  await openWheel(page);
  await key(page, 'keyDown', 'Escape');
  await key(page, 'keyUp', 'Escape');
  await key(page, 'keyUp');
  await expectSelection(page, 'sniper', 'Escape cancels selection without changing the weapon');
  assert.equal(await page.evaluate('window.__vb.stats.settingsOpen'), false,
    'wheel Escape does not also open the pause menu');
  await openWheel(page);
  wheel = await geometry(page, knifeSlot);
  await mouse(page, wheel.card);
  await page.waitFor(`document.querySelectorAll('#weapon-wheel .vb-wheel-slot')[${knifeSlot}].classList.contains('is-hl')`);
  await page.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ', key: 'q', bubbles: true }));
    document.getElementById('weapon-wheel').dispatchEvent(new PointerEvent('pointermove', {
      pointerType: 'mouse', clientX: ${wheel.center.x + wheel.radius * 1.55},
      clientY: ${wheel.center.y}, bubbles: true,
    }));
  })()`);
  await expectSelection(page, 'knife', 'unlocked pointer movement after Q release preserves the released card');

  await browser.close();
  // Chromium headless rejects native pointer lock, so this phase uses a
  // disposable desktop window and still drives every action through CDP.
  browser = await launchCdpSession(url, { browser: await desktopBrowser(), headless: false });
  page = browser.page;
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await startMatch(page, url);
  await page.send('Page.bringToFront');
  const center = await page.evaluate('({ x: innerWidth / 2, y: innerHeight / 2 })');
  await mouse(page, center);
  await frames(page);
  await page.evaluate(`document.getElementById('game').requestPointerLock()`);
  await page.waitFor(`document.pointerLockElement === document.getElementById('game')`, {
    label: 'real desktop pointer lock',
  });
  await mouse(page, center);
  await frames(page);
  const aim = await page.evaluate('({ yaw: window.__vb.stats.yaw, pitch: window.__vb.stats.pitch })');
  await openWheel(page);
  wheel = await geometry(page, knifeSlot);
  await mouse(page, { x: center.x - wheel.radius, y: center.y });
  await page.waitFor(`document.querySelectorAll('#weapon-wheel .vb-wheel-slot')[${knifeSlot}].classList.contains('is-hl')`, {
    label: 'locked movement highlights the knife at its visible radius',
  });
  assert.equal(await page.evaluate('window.__vb.wheelOpen'), true,
    'locked movement to the card waits for release');
  await key(page, 'keyUp');
  await expectSelection(page, 'knife', 'locked pointer hover and Q release equip the knife');
  const aimAfter = await page.evaluate('({ yaw: window.__vb.stats.yaw, pitch: window.__vb.stats.pitch })');
  assert.deepEqual(aimAfter, aim, 'steering the locked wheel does not turn the player view');

  await openWheel(page);
  await mouse(page, { x: center.x + wheel.radius * 0.55, y: center.y });
  await expectSelection(page, 'sniper', 'one fast locked radial motion keeps its full distance and equips');
  await key(page, 'keyDown', 'KeyQ', true);
  await frames(page);
  assert.equal(await page.evaluate('window.__vb.wheelOpen'), false);
  await key(page, 'keyUp');

  // One task delivers all three events before the next animation frame. The
  // queued mouse delta and release must survive opening on that later frame.
  await page.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q', bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: ${-wheel.radius}, movementY: 0, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ', key: 'q', bubbles: true }));
  })()`);
  await expectSelection(page, 'knife', 'a Q press, move and release in one frame equips the intended weapon');
  await page.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q', bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: ${wheel.radius}, movementY: 0, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ', key: 'q', bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: ${-wheel.radius * 3}, movementY: 0, bubbles: true }));
  })()`);
  await expectSelection(page, 'sniper', 'movement after Q release cannot overwrite the released selection');
  assert.equal(await page.evaluate(`document.pointerLockElement === document.getElementById('game')`), true);
  assert.deepEqual(page.errors, [], 'no browser runtime or resource errors');
  console.log('Weapon wheel browser: unlocked and locked hover/release, radial selection, Q repeat, cancel, dead zone and fast input verified.');
} catch (error) {
  if (browser) {
    console.error('Weapon wheel failure state:', await browser.page.evaluate(`({
      stats: window.__vb?.stats, wheelOpen: window.__vb?.wheelOpen,
      pointerLocked: !!document.pointerLockElement,
      highlight: [...document.querySelectorAll('#weapon-wheel .vb-wheel-slot')].findIndex(slot => slot.classList.contains('is-hl')),
      errors: document.querySelector('#error-overlay')?.textContent,
    })`).catch(() => null));
  }
  throw error;
} finally {
  await browser?.close();
  await stopServer(server);
}
