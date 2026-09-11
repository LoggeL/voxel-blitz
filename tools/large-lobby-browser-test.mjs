import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const server = startServer({ cwd: process.cwd(), failureContext: 'large lobby browser' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/js/ui/hud-support.js`, { width: 1440, height: 1000 });
  const page = browser.page;
  await page.evaluate(`localStorage.setItem('vb-mode', 'tdm'); localStorage.setItem('vb-map', 'foundry'); localStorage.setItem('vb-bots', '7')`);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const NativeWebSocket = window.WebSocket;
    window.__rosterFrames = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          const frame = JSON.parse(event.data);
          if (frame.t === 'lobbyState' || frame.t === 'tick') window.__rosterFrames.push(frame);
        });
      }
    };` });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/?headless=1` });
  await page.waitFor(`!!document.getElementById('create-lobby-btn')`);
  await page.evaluate(`document.getElementById('create-lobby-btn').click()`);
  await page.waitFor(`document.querySelectorAll('#lobby .vb-team-select').length === 8`);
  const set = async (selector, value) => {
    await page.evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      control.value = ${JSON.stringify(value)};
      control.dispatchEvent(new Event('change'));
    })()`);
  };
  await set('[aria-label="Team for TACTICAL BOT 1"]', 'alpha');
  for (let i = 2; i <= 7; i++) {
    await set(`[aria-label="Team for TACTICAL BOT ${i}"]`, 'bravo');
  }
  await page.waitFor(`document.getElementById('lobby-ready-count').textContent.includes('ALPHA 2 : 6 BRAVO')`);
  const chosen = await page.evaluate(`window.__rosterFrames.filter(frame => frame.t === 'lobbyState').at(-1).members.map(row => [row.id,row.team])`);
  await set('#map-select', 'citadel');
  await page.waitFor(`window.__rosterFrames.filter(frame => frame.t === 'lobbyState').at(-1)?.map === 'citadel'`);
  const preserved = await page.evaluate(`window.__rosterFrames.filter(frame => frame.t === 'lobbyState').at(-1).members.map(row => [row.id,row.team])`);
  assert.deepEqual(preserved, chosen);
  await set('#bot-count', '31');
  await page.waitFor(`document.querySelectorAll('#lobby .vb-team-select').length === 32`);
  assert.match(await page.evaluate(`document.getElementById('lobby-ready-count').textContent`), /32\/32.*ALPHA 16 : 16 BRAVO/);
  assert.equal(await page.evaluate(`[...document.querySelectorAll('#lobby .vb-team-select')].every(select => [...select.options].filter(option => option.disabled).length === 1)`), true);
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await page.evaluate(`document.getElementById('lobby').scrollWidth <= innerWidth`), true, `32-player lobby fits ${width}px`);
    assert.equal(await page.evaluate(`(() => {
      const list = document.getElementById('lobby-roster');
      list.scrollTop = list.scrollHeight;
      const last = list.lastElementChild.getBoundingClientRect();
      const box = list.getBoundingClientRect();
      return list.scrollTop > 0 && last.bottom <= box.bottom + 1;
    })()`), true, `last bot remains reachable at ${width}px`);
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await mkdir('.artifacts/feedback', { recursive: true });
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('.artifacts/feedback/large-lobby-32.png', Buffer.from(shot.data, 'base64'));
  await page.evaluate(`document.getElementById('lobby-ready-btn').click()`);
  await page.waitFor(`!document.getElementById('lobby-start-btn').disabled`);
  await page.evaluate(`document.getElementById('lobby-start-btn').click()`);
  await page.waitFor(`window.__rosterFrames.some(frame => frame.t === 'tick' && frame.players.length === 32)`);
  assert.deepEqual(await page.evaluate(`window.__rosterFrames.find(frame => frame.t === 'tick').players.reduce((counts,row) => {counts[row.team]++; return counts}, {alpha:0,bravo:0})`), { alpha: 16, bravo: 16 });
  console.log('Large lobby browser passed: actual host bot selectors, 2 vs 6, map persistence, 31 bots, responsive roster and 16 vs 16 launch.');
} finally {
  await browser?.close();
  await stopServer(server);
}
