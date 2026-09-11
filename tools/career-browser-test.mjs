import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'vb-career-browser-'));
const id = randomBytes(32).toString('hex');
// Fixture balance, created on disk by the test, never through a game endpoint.
await writeFile(path.join(directory, id + '.json'), JSON.stringify({
  xp: 150, credits: 150, kills: 15, matches: 0,
  owned: ['amber', 'rookie'], equipped: { theme: 'amber', title: 'rookie' },
}));
const server = startServer({ cwd: process.cwd(), env: { VB_DATA_DIR: directory } });
let browser;
try {
  const url = `http://127.0.0.1:${await server.port}/?debug=1&headless=1`;
  browser = await launchCdpSession(url);
  const page = browser.page;
  await page.send('Network.setCookie', { name: 'vb-career', value: id, url, httpOnly: true, sameSite: 'Strict' });
  await page.send('Page.reload');
  await page.waitFor(`!!document.getElementById('career-open')`, { label: 'career menu button' });
  assert.equal(await page.evaluate(`document.cookie.includes('vb-career')`), false, 'profile identity is not exposed to JS');
  await page.evaluate(`document.getElementById('career-open').click()`);
  await page.waitFor(`document.querySelector('.vb-career-stats').textContent.includes('150 CREDITS')`);
  assert.equal(await page.evaluate(`document.querySelector('[data-item="orchid"]').disabled`), true, 'level-gated item cannot be bought');
  await page.evaluate(`document.querySelector('[data-item="arctic"]').click()`);
  await page.waitFor(`document.querySelector('.vb-career-status').textContent === 'Arctic equipped'`);
  assert.equal(await page.evaluate(`document.querySelector('.vb-career-stats').textContent.includes('50 CREDITS')`), true);
  assert.equal(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--career-accent').trim()`), '#72e6ff');
  assert.equal(await page.evaluate(`document.querySelector('[data-item="arctic"]').disabled`), true, 'equipped item prevents duplicate purchase');
  await page.send('Page.reload');
  await page.waitFor(`document.getElementById('career-open') && getComputedStyle(document.documentElement).getPropertyValue('--career-accent').trim() === '#72e6ff'`);
  await page.evaluate(`document.getElementById('career-open').click()`);
  await page.waitFor(`document.getElementById('career-shop').open`);
  await mkdir('.artifacts/feedback', { recursive: true });
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await page.evaluate(`document.getElementById('career-shop').scrollWidth <= document.getElementById('career-shop').clientWidth`), true, `${width}px dialog has no horizontal overflow`);
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/feedback/career-${width}.png`, Buffer.from(screenshot.data, 'base64'));
  }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`!document.getElementById('career-shop').open`);
  assert.equal(await page.evaluate(`document.activeElement.id`), 'career-open', 'closing restores focus');
  await page.evaluate(`document.getElementById('play-btn').click()`);
  await page.waitFor(`window.__vb?.stats?.running`, { label: 'career user in live game', timeoutMs: 30000 });
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#crosshair .ch-arm')).backgroundColor`), 'rgb(114, 230, 255)', 'purchased reticle theme is visible during real gameplay');
  assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('career-badge')).display`), 'block');
  const errors = page.errors.filter(text => !/favicon|pointer.?lock/i.test(text));
  assert.deepEqual(errors, [], 'career flow produces no browser errors');
  console.log('Career browser: buy/equip, balance, locked items, reload persistence, desktop/mobile dialog, Escape focus and in-match cosmetics passed.');
} finally {
  await browser?.close(); await stopServer(server);
  await rm(directory, { recursive: true, force: true });
}
