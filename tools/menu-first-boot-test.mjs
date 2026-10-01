// Proves the menu is interactive before the heavy assets finish. Every Blender
// file and weapon sample is parked at the network layer (CDP Fetch) while the
// menu is used; the background scheduler reports what is pending; the match
// entries stay gated behind the load bar until the match set lands, then quick
// play goes live. Usage: node tools/menu-first-boot-test.mjs
import assert from 'node:assert/strict';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = startServer({ failureContext: 'menu-first boot test' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  const origin = `http://127.0.0.1:${port}`;
  // Start on a neutral same-origin document so interception is armed before the game loads.
  browser = await launchCdpSession(`${origin}/assets/ui/menu-type-scuffs.svg`);
  const { page } = browser;
  const held = new Map();
  const collectHeld = () => {
    for (const event of page.events) {
      if (event.method !== 'Fetch.requestPaused') continue;
      const { requestId, request } = event.params;
      if (!held.has(requestId)) held.set(requestId, request.url);
    }
    return held.size;
  };
  await page.send('Fetch.enable', { patterns: [
    { urlPattern: '*/assets/blender/*', requestStage: 'Request' },
    { urlPattern: '*/assets/audio/weapons/*', requestStage: 'Request' },
  ] });
  await page.send('Page.navigate', { url: `${origin}/?headless=1&lobby=abcde` });
  await page.waitFor(`window.__vbBoot?.readyMs > 0 && !document.getElementById('loading-screen').open && !!document.getElementById('play-btn')`,
    { timeoutMs: 60_000, label: 'interactive menu' });
  const readyMs = await page.evaluate('window.__vbBoot.readyMs');

  // The model library is loading in the background and its first request is parked.
  await page.waitFor(`window.__vbAssets.status.tasks.models === 'active'`, { label: 'model library loading in the background' });
  for (let attempt = 0; attempt < 200 && collectHeld() === 0; attempt++) await sleep(50);
  assert.ok(held.size > 0, 'Blender requests are held at the network layer');
  const pending = JSON.parse(await page.evaluate('JSON.stringify(window.__vbAssets.status)'));
  assert.equal(pending.idle, false);
  assert.equal(pending.tasks.models, 'active');
  assert.notEqual(pending.tasks.runtime, 'done');
  assert.notEqual(pending.tasks.audio, 'done');

  // The menu is interactive while those assets are pending: match entries are
  // gated behind the frosted load bar with real scheduler progress, while the
  // armory, career and settings entries are already part of the first paint.
  assert.equal(await page.evaluate(`document.getElementById('play-btn').disabled`), true, 'quick play waits for the match asset set');
  assert.equal(await page.evaluate(`document.getElementById('create-lobby-btn').disabled`), true, 'lobby creation waits for the match asset set');
  assert.equal(await page.evaluate(`document.getElementById('browse-lobbies-btn').disabled`), false, 'read-only lobby browsing is available while match assets load');
  await page.waitFor(`document.getElementById('lobby-browser').open && document.getElementById('join-code-input').value === 'ABCDE'`);
  assert.equal(await page.evaluate(`document.activeElement.id`), 'join-code-input', 'the loading-time invitation focuses its normalized code');
  await page.evaluate(`document.getElementById('lobby-browser-close').click()`);
  await page.waitFor(`document.activeElement.id === 'browse-lobbies-btn'`, { label: 'loading-time invitation returns focus to the browse button' });
  await page.evaluate(`(() => {
    window.__originalDirectoryFetch = window.fetch;
    window.fetch = (url, options) => url === '/api/lobbies'
      ? Promise.resolve({ ok: true, json: async () => ({ lobbies: [
        { code: 'FGHIJ', host: 'Open room', gameMode: 'tdm', map: 'foundry', players: 1, capacity: 8, phase: 'waiting', passwordRequired: false },
        { code: 'KLMNO', host: 'Full room', gameMode: 'duel', map: 'depot', players: 2, capacity: 2, phase: 'waiting', passwordRequired: false }
      ] }) }) : window.__originalDirectoryFetch(url, options);
    document.getElementById('browse-lobbies-btn').click();
  })()`);
  await page.waitFor(`document.querySelectorAll('.vb-browser-room').length === 2`);
  assert.equal(await page.evaluate(`[...document.querySelectorAll('.vb-browser-room button')].every(button => button.disabled)`), true,
    'directory row admission is gated while match assets load');
  await page.evaluate(`document.querySelector('.vb-browser-room').requestSubmit()`);
  assert.equal(await page.evaluate(`document.getElementById('lobby-browser').open && document.getElementById('menu').getAttribute('aria-hidden') === 'false'`), true,
    'directory form submission cannot bypass the loading-time admission gate');
  await page.evaluate(`window.fetch = window.__originalDirectoryFetch; delete window.__originalDirectoryFetch; document.getElementById('lobby-browser-refresh').click()`);
  await page.waitFor(`!!document.querySelector('.vb-browser-empty')`);
  assert.equal(await page.evaluate(`document.getElementById('join-lobby-btn').disabled && document.getElementById('browser-create-lobby-btn').disabled && document.querySelector('.vb-browser-empty button').disabled`), true,
    'code, sidebar and empty-directory admission wait for match assets');
  await page.evaluate(`document.getElementById('join-code-input').form.requestSubmit()`);
  assert.equal(await page.evaluate(`document.getElementById('lobby-browser').open && document.getElementById('lobby-browser-join-status').textContent === 'PREPARING THE ARENA. PLEASE WAIT.' && document.getElementById('menu').getAttribute('aria-hidden') === 'false'`), true,
    'keyboard submission cannot bypass the loading-time admission gate');
  const gate = await page.evaluate(`(() => { const bar = document.getElementById('menu-load-bar'); const progress = bar?.querySelector('progress'); return { hidden: bar?.hidden, value: progress?.value, max: progress?.max, label: bar?.textContent }; })()`);
  assert.equal(gate.hidden, false, 'the load bar is visible while play is gated');
  assert.ok(gate.value >= 0 && gate.value < gate.max, `load bar carries real progress (${gate.value} / ${gate.max})`);
  assert.match(gate.label, /LOADING/);
  assert.ok(await page.evaluate(`!!document.getElementById('workshop-open') && !!document.getElementById('career-open')`),
    'armory and career entries are part of the first menu');
  assert.equal(await page.evaluate(`document.getElementById('workshop-open').disabled`), false, 'the armory entry responds while assets load');
  const indicator = await page.evaluate(`(() => { const el = document.getElementById('asset-status'); return { hidden: el.hidden, text: el.textContent }; })()`);
  assert.equal(indicator.hidden, false, 'the menu shows the background progress line');
  assert.match(indicator.text, /PREPARING ASSETS\d+ \/ \d+/);

  // Release everything; the boot continues into live play with the assets present.
  for (let round = 0; round < 3; round++) {
    collectHeld();
    for (const [requestId, url] of held) {
      if (url === null) continue;
      await page.send('Fetch.continueRequest', { requestId }).catch(() => {});
      held.set(requestId, null);
    }
    await sleep(100);
  }
  await page.send('Fetch.disable');
  // The gate lifts as soon as the match set (models, runtime, audio) is done,
  // then quick play reaches live play with every template present.
  await page.waitFor(`document.getElementById('play-btn').disabled === false && document.getElementById('menu-load-bar').hidden === true`,
    { timeoutMs: 120_000, label: 'play gate lifts once the match assets are ready' });
  await page.waitFor('window.__vbAssets.idle === true', { timeoutMs: 120_000, label: 'background assets idle' });
  assert.equal(await page.evaluate(`!document.getElementById('join-lobby-btn').disabled && !document.getElementById('browser-create-lobby-btn').disabled && !document.querySelector('.vb-browser-empty button').disabled`), true,
    'directory admission becomes available once the match set is ready');
  assert.equal(await page.evaluate(`document.getElementById('lobby-browser-join-status').textContent`), '', 'loading-time guidance clears when admission becomes available');
  await page.evaluate(`document.getElementById('lobby-browser-close').click()`);
  await page.evaluate(`document.getElementById('play-btn').click()`);
  await page.waitFor('window.__vb.stats.running === true', { timeoutMs: 120_000, label: 'live match' });
  assert.equal(await page.evaluate(`document.getElementById('asset-status').hidden`), true, 'the indicator leaves with the menu');
  const errors = page.errors.filter((error) => /ReferenceError|TypeError|SyntaxError|Failed to load resource/.test(error));
  assert.deepEqual(errors, [], 'no browser errors');
  console.log(`ok - menu interactive after ${readyMs} ms with ${held.size} heavy requests held behind the play gate; quick play went live once they landed`);
} finally {
  await browser?.close();
  await stopServer(server);
}
