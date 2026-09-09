import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const server = startServer({ cwd: process.cwd(), failureContext: 'lobby browser UI' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/?headless=1`, { width: 1672, height: 941 });
  const page = browser.page;
  await page.waitFor(`!!document.getElementById('browse-lobbies-btn')`);
  await mkdir('.artifacts', { recursive: true });
  const capture = async (name) => {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1672, height: 941, deviceScaleFactor: 1, mobile: false });
  await capture('main-menu-redesign');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 1024, deviceScaleFactor: 1, mobile: false });
  // Deterministic directory fixtures exercise all filters without relying on public players.
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__directoryFail = false;
    window.fetch = (url, options) => url === '/api/lobbies'
      ? Promise.resolve({ ok: !window.__directoryFail, json: async () => ({ lobbies: [
        { code: 'ABCDE', host: 'Alex', gameMode: 'tdm', map: 'foundry', players: 3, capacity: 8, phase: 'waiting', passwordRequired: false },
        { code: 'FGHIJ', host: 'Sam', gameMode: 'gungame', map: 'depot', players: 5, capacity: 8, phase: 'live', passwordRequired: true },
        { code: 'KLMNO', host: 'Jordan', gameMode: 'duel', map: 'depot', players: 2, capacity: 2, phase: 'live', passwordRequired: false }
      ] }) }) : originalFetch(url, options);
    document.getElementById('browse-lobbies-btn').click();
  })()`);
  await page.waitFor(`document.querySelectorAll('.vb-browser-room').length === 3`);
  await page.waitFor(`[...document.querySelectorAll('.vb-browser-map')].every(img => img.complete && img.naturalWidth > 0)`);
  const count = () => page.evaluate(`document.querySelectorAll('.vb-browser-room').length`);
  const set = (id, value, prop = 'value') => page.evaluate(`(() => { const input = document.getElementById('${id}'); input.${prop} = ${JSON.stringify(value)}; input.dispatchEvent(new Event('${prop === 'value' && id === 'lobby-search-input' ? 'input' : 'change'}')); })()`);
  assert.equal(await page.evaluate(`document.activeElement.id`), 'lobby-search-input');
  assert.equal(await page.evaluate(`document.getElementById('lobby-browser').getBoundingClientRect().width === innerWidth`), true);
  await capture('lobby-search-populated');
  await set('lobby-search-input', 'alex'); assert.equal(await count(), 1);
  await set('lobby-search-input', 'fghij'); assert.equal(await count(), 1);
  await set('lobby-search-input', 'depot'); assert.equal(await count(), 2);
  await set('lobby-mode-filter', 'duel'); assert.equal(await count(), 1);
  assert.equal(await page.evaluate(`document.querySelector('.vb-browser-room button').disabled`), true);
  await set('lobby-available-filter', true, 'checked'); assert.equal(await count(), 0);
  await page.evaluate(`document.querySelector('.vb-browser-empty button').click()`); assert.equal(await count(), 3);
  for (const [width, height] of [[1440, 900], [800, 600], [390, 844], [320, 640]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await page.evaluate(`document.getElementById('lobby-browser').scrollWidth <= innerWidth`), true, `directory fits ${width}`);
    if (width === 390) await capture('lobby-search-mobile');
    await page.evaluate(`document.getElementById('lobby-browser').close()`);
    await page.waitFor(`document.activeElement.id === 'browse-lobbies-btn'`);
    assert.equal(await page.evaluate(`document.getElementById('menu').scrollWidth <= innerWidth`), true, `main menu fits ${width}`);
    if (width === 390) await capture('main-menu-mobile');
    await page.evaluate(`document.getElementById('browse-lobbies-btn').click()`);
    await page.waitFor(`document.querySelectorAll('.vb-browser-room').length === 3`);
  }
  await page.evaluate(`window.__directoryFail = true; document.getElementById('lobby-browser-refresh').click()`);
  await page.waitFor(`document.querySelector('.vb-browser-status').textContent.includes('Could not load')`);
  assert.equal(await page.evaluate(`document.getElementById('lobby-browser-refresh').disabled`), false);
  await page.evaluate(`window.__directoryFail = false; document.getElementById('lobby-browser-refresh').click()`);
  await page.waitFor(`document.querySelectorAll('.vb-browser-room').length === 3`);
  await page.evaluate(`document.getElementById('browser-create-lobby-btn').click()`);
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  console.log('LOBBY BROWSER UI: OK (search, modes, capacity, clear, refresh recovery, focus, responsive layouts, create lobby)');
} finally {
  await browser?.close();
  await stopServer(server);
}
