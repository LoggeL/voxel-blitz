import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'vb-armory-browser-'));
const guest = randomBytes(32).toString('hex');
await writeFile(path.join(directory, `${guest}.json`), JSON.stringify({ xp: 1100, credits: 825, kills: 64, matches: 12,
  owned: ['amber', 'rookie', 'arctic'], equipped: { theme: 'arctic', title: 'rookie' } }));
const server = startServer({ cwd: process.cwd(), env: { VB_DATA_DIR: directory } });
let browser;
try {
  const url = `http://127.0.0.1:${await server.port}/?debug=1&headless=1`;
  browser = await launchCdpSession(url);
  const page = browser.page;
  await page.send('Network.setCookie', { name: 'vb-career', value: guest, url, httpOnly: true, sameSite: 'Strict' });
  await page.send('Page.reload');
  await page.waitFor(`document.getElementById('career-menu-preview')?.textContent.includes('825 CREDITS')`);
  await mkdir('.artifacts/armory', { recursive: true });
  const screenshot = async name => {
    const result = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/armory/${name}.png`, Buffer.from(result.data, 'base64'));
  };
  for (const [width, height] of [[1440, 900], [1280, 720], [390, 844]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`document.getElementById('menu').scrollTop = 0`);
    await page.waitFor(`Array.from(document.images).every(img => img.complete)`);
    const bounds = await page.evaluate(`(() => {
      const menu = document.getElementById('menu');
      return { overflow: menu.scrollWidth > menu.clientWidth,
        actions: ['play-btn','browse-lobbies-btn','create-lobby-btn','create-duel-btn','training-btn','account-open','career-open'].map(id => {
          const rect = document.getElementById(id).getBoundingClientRect(); return { id, x: rect.x, y: rect.y, bottom: rect.bottom, width: rect.width };
        }) };
    })()`);
    assert.equal(bounds.overflow, false, `${width}px main menu has no horizontal overflow`);
    if (width >= 760) for (const action of bounds.actions) {
      assert.ok(action.y >= 0 && action.bottom <= height, `${width}px ${action.id} stays inside the viewport: ${JSON.stringify(action)}`);
    }
    if (width === 390) assert.equal(await page.evaluate(`(() => {const r = document.getElementById('account-mobile-open').getBoundingClientRect(); return r.y > 0 && r.bottom < innerHeight;})()`), true, 'mobile registration CTA is visible in the initial viewport');
    await page.evaluate(`document.activeElement?.blur()`);
    await screenshot(`main-${width}x${height}`);
    if (width === 390) {
      await page.evaluate(`document.getElementById('account-open').scrollIntoView({block:'center'})`);
      await screenshot('main-account-390x844');
    }
    await page.evaluate(`document.getElementById('career-open').click()`);
    await page.waitFor(`document.getElementById('career-shop').open && document.querySelectorAll('[data-cosmetic]').length === 8`);
    await page.evaluate(`document.getElementById('career-shop').scrollTop = 0`);
    assert.equal(await page.evaluate(`document.getElementById('career-shop').scrollWidth <= document.getElementById('career-shop').clientWidth`), true, `${width}px career fits`);
    await page.evaluate(`document.activeElement?.blur()`);
    await screenshot(`career-${width}x${height}`);
    await page.evaluate(`document.querySelector('.vb-career-journey').scrollIntoView({block:'end'})`);
    assert.equal(await page.evaluate(`(() => {const r = document.querySelector('.vb-career-journey').getBoundingClientRect(); const d = document.getElementById('career-shop').getBoundingClientRect(); return r.top >= d.top && r.bottom <= d.bottom;})()`), true, `${width}px level journey is reachable by scrolling`);
    assert.equal(await page.evaluate(`(() => {const r=document.getElementById('career-close').getBoundingClientRect(); return r.y > 0 && r.bottom < innerHeight;})()`), true, 'career Back remains visible while scrolling');
    await screenshot(`career-journey-${width}x${height}`);
    if (width === 390) {
      await page.evaluate(`document.querySelector('.vb-career-grid').scrollIntoView({block:'start'})`);
      await screenshot('career-catalog-390x844');
    }
    await page.evaluate(`document.getElementById('career-close').click()`);
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`document.getElementById('career-menu-preview').click()`);
  await page.waitFor(`document.getElementById('career-shop').open`);
  for (const [kind, count] of [['theme', 4], ['title', 4], ['all', 8]]) {
    await page.evaluate(`document.querySelector('[data-filter="${kind}"]').click()`);
    assert.equal(await page.evaluate(`document.querySelectorAll('[data-cosmetic]').length`), count);
    assert.equal(await page.evaluate(`document.querySelector('[data-filter="${kind}"]').getAttribute('aria-pressed')`), 'true');
  }
  await page.evaluate(`document.querySelector('[data-item="vanguard"]').click()`);
  await page.waitFor(`document.querySelector('.vb-career-status').textContent === 'Vanguard equipped'`);
  assert.equal(await page.evaluate(`document.querySelector('.vb-career-stats').textContent.includes('475 CREDITS')`), true);
  assert.equal(await page.evaluate(`document.getElementById('career-menu-preview').textContent.includes('Vanguard')`), true, 'menu preview reflects actual equipped callsign');
  assert.equal(await page.evaluate(`document.querySelector('.vb-career-title-name').textContent.includes('Vanguard')`), true);
  await page.evaluate(`document.getElementById('career-shop').scrollTop=0`);
  await screenshot('career-equipped-1440x900');
  await page.evaluate(`document.getElementById('career-close').click();document.getElementById('account-open').click()`);
  assert.equal(await page.evaluate(`document.getElementById('account-tab-register').getAttribute('aria-pressed')`), 'true', 'prominent account CTA opens registration');
  await screenshot('account-register-1440x900');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await screenshot('account-register-390x844');
  await page.evaluate(`(() => { const f = document.getElementById('account-form'); f.elements.username.value='ArmoryPilot'; f.elements.password.value='armory browser password'; f.elements.confirmPassword.value='armory browser password'; f.requestSubmit(); })()`);
  await page.waitFor(`document.getElementById('account-recovery-code') && document.getElementById('account-dialog').getAttribute('aria-busy') === 'false'`, {timeoutMs:20000});
  await page.evaluate(`document.getElementById('account-code-done').click();document.getElementById('account-close').click()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`document.getElementById('career-menu-preview').textContent.includes('475 CREDITS') && document.getElementById('account-status').textContent.includes('ArmoryPilot')`);
  await page.evaluate(`document.getElementById('menu').scrollTop=0;document.activeElement?.blur()`);
  await screenshot('main-signed-in-1440x900');
  await page.evaluate(`document.getElementById('career-open').click()`);
  await page.waitFor(`document.querySelector('.vb-career-player').textContent === 'ArmoryPilot'`);
  await page.evaluate(`document.getElementById('career-shop').scrollTop=0;document.activeElement?.blur()`);
  await screenshot('career-signed-in-1440x900');
  await page.evaluate(`document.getElementById('career-close').click();document.getElementById('account-nav-open').click();document.getElementById('account-logout').click()`);
  await page.waitFor(`!document.getElementById('name-input').readOnly && !document.getElementById('account-logout')`);
  await page.evaluate(`document.getElementById('account-guest').click();document.getElementById('account-nav-open').click()`);
  assert.equal(await page.evaluate(`document.getElementById('account-tab-login').getAttribute('aria-pressed')`), 'true', 'top navigation opens login');
  await page.evaluate(`document.getElementById('account-guest').click();document.getElementById('menu-continue-guest').click()`);
  await page.waitFor(`window.__vb?.stats?.running`, { timeoutMs: 30000, label: 'guest shortcut starts Quick Play' });
  assert.deepEqual(page.errors.filter(error => !/favicon|pointer.?lock/i.test(error)), []);
  console.log('Armory browser: 1440/1280/390 layouts, real profile, filters, callsign purchase/equip, register/login CTAs and guest Quick Play passed.');
} finally {
  await browser?.close(); await stopServer(server); await rm(directory, { recursive: true, force: true });
}
