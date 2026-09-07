import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../.artifacts/dust2-browser/', import.meta.url);
const server = startServer({ cwd: root, failureContext: 'Dust 2 browser test' });
let browser;

async function click(page, id) {
  const point = await page.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el?.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 && !el.disabled
      ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`);
  assert.ok(point, `${id} is visible and enabled`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
}

async function select(page, id, value) {
  await page.evaluate(`(() => {
    const select = document.getElementById(${JSON.stringify(id)});
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function capture(page, name) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' }, 15_000);
  await writeFile(new URL(name, output), Buffer.from(shot.data, 'base64'));
}

try {
  await mkdir(output, { recursive: true });
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/?debug=1&headless=1`);
  const page = browser.page;
  await page.waitFor(`document.getElementById('create-lobby-btn') && window.__vb`);
  await click(page, 'create-lobby-btn');
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  await select(page, 'map-select', 'dust2');
  await page.waitFor(`document.getElementById('lobby-map-val')?.textContent.includes('DUST 2') &&
    document.getElementById('lobby-map-preview')?.complete &&
    document.getElementById('lobby-map-preview')?.naturalWidth > 0 &&
    document.getElementById('lobby-map-preview')?.src.endsWith('/dust2.webp')`,
  { label: 'Dust 2 lobby name and actual map thumbnail' });
  const modeLabels = await page.evaluate(`import('/js/ui/hud-support.js').then(m => m.MODE_LABELS)`);
  for (const mode of ['chaos', 'snd', 'gungame', 'fun', 'tdm']) {
    await select(page, 'game-mode-select', mode);
    await page.waitFor(`document.getElementById('game-mode-select').value === ${JSON.stringify(mode)} &&
      document.getElementById('lobby-mode-val').textContent === ${JSON.stringify(modeLabels[mode])} &&
      document.getElementById('map-select').value === 'dust2' &&
      document.getElementById('lobby-map-val').textContent.includes('DUST 2')`);
  }
  await capture(page, 'lobby-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
  });
  assert.ok(await page.evaluate(`document.getElementById('lobby').scrollWidth <= innerWidth`),
    'Dust 2 lobby stays within a phone viewport');
  await capture(page, 'lobby-mobile.png');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  await select(page, 'bot-count', '2');
  await click(page, 'lobby-ready-btn');
  await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled === false`);
  await click(page, 'lobby-start-btn');
  await page.waitFor(`window.__vb.stats.running && window.__vb.stats.ringLen > 0 &&
    window.__vb.stats.avatars >= 2 && document.getElementById('match-map-chip')?.textContent === 'DUST 2'`,
  { timeoutMs: 30_000, label: 'Dust 2 live match with bots' });
  const before = await page.evaluate('window.__vb.stats');
  assert.ok(before.alive && before.lastSnapAgeMs < 1000, 'player has a live server spawn');
  assert.ok(before.feet.x >= 7.5 && before.feet.x <= 120.5 &&
    before.feet.z >= 7.5 && before.feet.z <= 88.5, 'live spawn stays inside Dust 2');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
  try {
    await page.waitFor(`Math.hypot(window.__vb.stats.feet.x - ${before.feet.x},
      window.__vb.stats.feet.z - ${before.feet.z}) > 1`,
    { timeoutMs: 5000, label: 'actual movement out of Dust 2 spawn' });
  } finally {
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
  }
  await capture(page, 'live-match.png');
  assert.ok(await page.evaluate('window.__vb.stats.lastSnapAgeMs < 1000'),
    'server snapshots continue after movement');
  assert.deepEqual(page.errors, [], 'browser has no runtime or resource errors');
  console.log('Dust 2 browser: selection, thumbnail, combat modes, mobile layout and live movement with bots verified.');
} finally {
  await browser?.close();
  await stopServer(server);
}
