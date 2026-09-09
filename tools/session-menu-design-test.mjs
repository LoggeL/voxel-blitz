import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';
const server = startServer({ cwd: process.cwd(), failureContext: 'session menu design' });
let browser;
try {
  const port = await server.port; await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/?debug=1&headless=1`, { width: 1536, height: 1024 });
  const page = browser.page;
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 1024, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`!!document.getElementById('create-lobby-btn')`);
  await page.evaluate(`document.getElementById('create-lobby-btn').click()`);
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  await mkdir('.artifacts', { recursive: true });
  const capture = async name => {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  await page.waitFor(`document.getElementById('lobby-map-preview').complete`);
  await capture('waiting-lobby-redesign');
  for (const width of [1280, 800, 390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.ok(await page.evaluate(`document.getElementById('lobby').scrollWidth <= innerWidth`));
    if (width === 390) await capture('waiting-lobby-mobile');
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 1024, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`document.getElementById('lobby-ready-btn').click()`);
  await page.waitFor(`!document.getElementById('lobby-start-btn').disabled`);
  await page.evaluate(`document.getElementById('lobby-start-btn').click()`);
  await page.waitFor(`window.__vb?.stats.running`, { timeoutMs: 30000 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`window.__vb.stats.settingsOpen`);
  await capture('ingame-menu-redesign');
  for (const [tab, visible, hidden] of [['display','showPing','sens-slider'],['debug','showHitboxes','showPing'],['controls','sens-slider','showHitboxes']]) {
    await page.evaluate(`document.getElementById('settings-tab-${tab}').click()`);
    assert.ok(await page.evaluate(`document.getElementById('settings-${visible}').getClientRects().length > 0 && document.getElementById('settings-${hidden}').getClientRects().length === 0`), tab);
  }
  await page.evaluate(`document.getElementById('settings-tab-controls').focus()`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
  assert.equal(await page.evaluate(`document.activeElement.id`), 'settings-tab-display');
  await page.evaluate(`document.getElementById('settings-tab-controls').click()`);
  for (const width of [1280,800,390,320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.ok(await page.evaluate(`document.getElementById('settings-overlay').scrollWidth <= innerWidth`));
    if (width === 390) await capture('ingame-menu-mobile');
  }
  await page.evaluate(`document.getElementById('settings-resume-btn').click()`);
  await page.waitFor(`!window.__vb.stats.settingsOpen`);
  console.log('SESSION MENU DESIGN: OK (host setup, ready/start, tabs, keyboard navigation, responsive layout, resume)');
} finally { await browser?.close(); await stopServer(server); }
