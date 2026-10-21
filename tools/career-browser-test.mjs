import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'vb-career-browser-'));
const id = randomBytes(32).toString('hex');
const reticleId = randomBytes(32).toString('hex');
// Fixture balances, created on disk by the test, never through a game endpoint.
await writeFile(path.join(directory, id + '.json'), JSON.stringify({
  xp: 150, credits: 150, kills: 15, matches: 0,
  owned: ['amber', 'rookie'], equipped: { theme: 'amber', title: 'rookie' },
}));
// Level 3 opens the dot reticle; the arctic theme rides along into the match.
await writeFile(path.join(directory, reticleId + '.json'), JSON.stringify({
  xp: 400, kills: 20, matches: 1,
  owned: ['amber', 'rookie', 'arctic'], equipped: { theme: 'arctic', title: 'rookie' },
}));
const server = startServer({ cwd: process.cwd(), env: { VB_DATA_DIR: directory } });
let browser;
try {
  const url = `http://127.0.0.1:${await server.port}/?debug=1&headless=1`;
  browser = await launchCdpSession(url);
  const page = browser.page;
  const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const accent = `getComputedStyle(document.documentElement).getPropertyValue('--career-accent').trim()`;
  await page.send('Network.setCookie', { name: 'vb-career', value: id, url, httpOnly: true, sameSite: 'Strict' });
  await page.send('Page.reload');
  await page.waitFor(`!!document.getElementById('career-open')`, { label: 'career menu button' });
  assert.equal(await page.evaluate(`document.cookie.includes('vb-career')`), false, 'profile identity is not exposed to JS');
  assert.equal(await page.evaluate(`document.getElementById('career-open').textContent.includes('ARMORY')`), true);
  await click('#career-open');
  await page.waitFor(`document.querySelector('.vb-career-stats').textContent.includes('LEVEL 2')`);
  await click('#armory-tab-progress');
  await page.waitFor(`!!document.querySelector('#progression-tree [data-node="orchid"]')`);
  assert.equal(await page.evaluate(`document.querySelector('[data-node="orchid"]').closest('.vb-tree-item').dataset.state`), 'next', 'a level-gated node shows as still to come');
  await click('#progression-tree [data-tree-node="orchid"]');
  await page.waitFor(`document.getElementById('armory-inspector').dataset.featuredItem === 'orchid'`);
  assert.equal(await page.evaluate(`!document.querySelector('[data-item="orchid"]')`), true, 'a locked node offers no action control at all');
  assert.equal(await page.evaluate(`document.getElementById('armory-action').disabled`), true);
  assert.match(await page.evaluate(`document.getElementById('armory-action').textContent`), /LEVEL 3/);
  await click('#progression-tree [data-tree-node="arctic"]');
  await page.waitFor(`document.getElementById('armory-action').dataset.item === 'arctic' && !document.getElementById('armory-action').disabled`);
  await click('#armory-action');
  await page.waitFor(`document.querySelector('.vb-career-status').textContent === 'Arctic equipped'`);
  assert.equal(await page.evaluate(`document.querySelector('.vb-career-stats').textContent.includes('LEVEL 2')`), true);
  assert.equal(await page.evaluate(accent), '#72e6ff');
  assert.equal(await page.evaluate(`document.querySelector('[data-item="arctic"]').disabled`), true, 'an equipped node cannot be equipped again');
  await page.send('Page.reload');
  await page.waitFor(`document.getElementById('career-open') && ${accent} === '#72e6ff'`);
  await click('#career-open');
  await page.waitFor(`document.getElementById('career-shop').open`);
  await mkdir('.artifacts/feedback', { recursive: true });
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await page.evaluate(`document.getElementById('career-shop').scrollWidth <= document.getElementById('career-shop').clientWidth`), true, `${width}px dialog has no horizontal overflow`);
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/feedback/career-${width}.png`, Buffer.from(screenshot.data, 'base64'));
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`!document.getElementById('career-shop').open`);
  assert.equal(await page.evaluate(`document.activeElement.id`), 'career-open', 'closing restores focus');

  // Reticle: the menu applies careerView.equipped, a match follows the self snapshot row.
  await page.send('Network.setCookie', { name: 'vb-career', value: reticleId, url, httpOnly: true, sameSite: 'Strict' });
  await page.send('Page.reload');
  await page.waitFor(`document.getElementById('career-open') && ${accent} === '#72e6ff'`);
  assert.equal(await page.evaluate(`document.documentElement.dataset.reticle ?? null`), null, 'standard reticle leaves the root bare');
  await click('#career-open');
  await page.waitFor(`document.querySelector('.vb-career-stats')?.textContent.includes('LEVEL 3') && document.querySelector('[data-slot="reticle"]')`);
  await click('[data-slot="reticle"]');
  await page.waitFor(`document.querySelector('[data-option="reticle-dot"]')?.dataset.state === 'owned'`);
  await click('[data-option="reticle-dot"]');
  await page.waitFor(`document.getElementById('armory-status').textContent === 'Dot reticle equipped' || document.querySelector('[data-option="reticle-dot"]').dataset.state === 'equipped'`, { label: 'dot reticle equipped' });
  assert.equal(await page.evaluate(`document.documentElement.dataset.reticle`), 'dot', 'equipping reticle-dot sets :root[data-reticle=dot]');
  await click('#career-close');
  // Drop the menu value so only the authoritative snapshot can restore it.
  await page.evaluate(`delete document.documentElement.dataset.reticle`);
  await page.evaluate(`document.getElementById('play-btn').click()`);
  await page.waitFor(`window.__vb?.stats?.running`, { label: 'career user in live game', timeoutMs: 30000 });
  await page.waitFor(`document.documentElement.dataset.reticle === 'dot'`, { label: 'reticle follows the self snapshot row' });
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#crosshair .ch-arm')).backgroundColor`), 'rgb(114, 230, 255)', 'equipped theme is visible during real gameplay');
  assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('career-badge')).display`), 'block');
  assert.match(await page.evaluate(`document.getElementById('career-badge').textContent`), /^LV 3 · Rookie$/);
  const errors = page.errors.filter(text => !/favicon|pointer.?lock/i.test(text));
  assert.deepEqual(errors, [], 'career flow produces no browser errors');
  console.log('Career browser: next/locked tree nodes, inspector equip, accent and reload persistence, desktop/mobile dialog, Escape focus, menu and snapshot reticle, in-match accent and badge passed.');
} finally {
  await browser?.close(); await stopServer(server);
  await rm(directory, { recursive: true, force: true });
}
