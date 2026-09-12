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
  await set('#map-select', 'harbor');
  await page.waitFor(`document.getElementById('lobby-map-capacity').textContent.includes('32')`);
  await set('#bot-count', '31');
  await page.waitFor(`document.querySelectorAll('#lobby .vb-team-select').length === 32`);
  assert.match(await page.evaluate(`document.getElementById('lobby-ready-count').textContent`), /32\/32.*ALPHA 16 : 16 BRAVO/);
  assert.equal(await page.evaluate(`[...document.querySelectorAll('#lobby .vb-team-select')].every(select => [...select.options].filter(option => option.disabled).length === 1)`), true);
  // All presentations use the same rows. Overview fits all 32 on a desktop.
  await page.evaluate(`document.getElementById('lobby-view-overview').click()`);
  await page.waitFor(`document.querySelector('.vb-roster-card').dataset.view === 'overview'`);
  assert.equal(await page.evaluate(`(() => { const list = document.getElementById('lobby-roster'); return list.scrollHeight <= list.clientHeight + 1 })()`), true);
  await page.evaluate(`document.getElementById('lobby-view-teams').click()`);
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.vb-roster-team')].map(team => team.querySelectorAll('.vb-roster-item').length)`), [16,16]);
  for (const [filter, expected] of [['humans',1], ['bots',31], ['waiting',1], ['all',32]]) {
    await page.evaluate(`[...document.querySelectorAll('.vb-roster-filters button')].find(button => button.textContent.toLowerCase().startsWith('${filter}')).click()`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#lobby-roster .vb-roster-item').length`), expected);
  }
  await page.evaluate(`(() => { const search = document.querySelector('.vb-roster-search'); search.value = 'TACTICAL BOT 31'; search.dispatchEvent(new Event('input')); })()`);
  assert.equal(await page.evaluate(`document.querySelectorAll('#lobby-roster .vb-roster-item').length`), 1);
  await set('[aria-label="Difficulty for TACTICAL BOT 31"]', 'hard');
  await page.waitFor(`window.__rosterFrames.filter(frame => frame.t === 'lobbyState').at(-1).members.find(row => row.id === 'bot-30').difficulty === 'hard'`);
  await page.evaluate(`(() => { const search = document.querySelector('.vb-roster-search'); search.value = ''; search.dispatchEvent(new Event('input')); })()`);
  await page.evaluate(`document.getElementById('lobby-view-overview').click()`);
  await page.evaluate(`document.querySelector('[aria-label="Details for TACTICAL BOT 31"]').click()`);
  assert.equal(await page.evaluate(`document.activeElement.dataset.memberId`), 'bot-30');
  assert.equal(await page.evaluate(`document.querySelector('.vb-roster-card').dataset.view`), 'list');
  // The old image remains decoded and opaque during a real 650 ms blend.
  await page.waitFor(`document.querySelector('.vb-lobby-backdrop').dataset.loading === 'false'`);
  await page.evaluate(`window.__mapBlendSamples = []; window.__sampleMapBlend = setInterval(() => {
    const root = document.querySelector('.vb-lobby-backdrop');
    const base = root.querySelector('.vb-crossfade-base');
    const incoming = root.querySelector('.vb-crossfade-incoming');
    window.__mapBlendSamples.push({ source: base.getAttribute('src'), valid: base.complete && base.naturalWidth > 0,
      opacity: incoming ? Number(getComputedStyle(incoming).opacity) : null });
  }, 20)`);
  await set('#map-select', 'canyon');
  await page.waitFor(`document.querySelector('.vb-lobby-backdrop').dataset.image === '/assets/maps/canyon.png' && document.querySelector('.vb-lobby-backdrop').dataset.loading === 'false'`);
  const blend = await page.evaluate(`(() => { clearInterval(window.__sampleMapBlend); return window.__mapBlendSamples })()`);
  assert.ok(blend.some(sample => sample.opacity > 0 && sample.opacity < 1), 'map transition has intermediate blend frames');
  assert.ok(blend.every(sample => sample.valid), 'base image remains decoded throughout transition');
  await set('#map-select', 'foundry');
  await set('#map-select', 'depot');
  await set('#map-select', 'harbor');
  await page.waitFor(`document.querySelector('.vb-lobby-backdrop').dataset.image === '/assets/maps/harbor.png' && document.querySelector('.vb-lobby-backdrop').dataset.loading === 'false'`);
  assert.equal(await page.evaluate(`document.querySelector('.vb-lobby-backdrop').children.length`), 1, 'rapid changes clean up overlays');
  assert.equal(await page.evaluate(`window.__rosterFrames.filter(frame => frame.t === 'lobbyState').at(-1).bots`), 7, 'small map trims bots and a larger map does not silently add them back');
  await set('#bot-count', '31');
  await page.waitFor(`document.querySelectorAll('#lobby .vb-team-select').length === 32`);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await set('#map-select', 'canyon');
  await page.waitFor(`document.querySelector('.vb-lobby-backdrop').dataset.image === '/assets/maps/canyon.png'`);
  assert.equal(await page.evaluate(`document.querySelectorAll('.vb-crossfade-incoming').length`), 0, 'reduced motion swaps decoded images without animation');
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  await mkdir('docs/design/lobby-roster', { recursive: true });
  const capture = async name => {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`docs/design/lobby-roster/${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  for (const view of ['overview', 'teams', 'list']) {
    await page.evaluate(`document.getElementById('lobby-view-${view}').click(); document.getElementById('lobby').scrollTop = 0; document.getElementById('lobby-roster').scrollTop = 0`);
    await capture(`${view}-desktop`);
  }
  for (const [width, height] of [[1440, 1000], [800, 900], [390, 844], [320, 740]]) {
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
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  for (const view of ['overview', 'teams', 'list']) {
    await page.evaluate(`document.getElementById('lobby-view-${view}').click(); document.getElementById('lobby-roster').scrollTop = 0; document.querySelector('.vb-roster-card').scrollIntoView({block:'start'})`);
    await capture(`${view}-mobile`);
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
  console.log('Large lobby browser passed: overview/list/teams, search/filters, bot difficulty, decoded crossfade/rapid maps,  actual host bot selectors, 2 vs 6, map persistence, 31 bots, responsive roster and 16 vs 16 launch.');
} finally {
  await browser?.close();
  await stopServer(server);
}
