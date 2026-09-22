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
  await page.send('Page.navigate', { url: `${origin}/?headless=1` });
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
  // ARMORY and settings entries are already part of the first paint.
  assert.equal(await page.evaluate(`document.getElementById('play-btn').disabled`), true, 'quick play waits for the match asset set');
  assert.equal(await page.evaluate(`document.getElementById('create-lobby-btn').disabled`), true, 'lobby creation waits for the match asset set');
  const gate = await page.evaluate(`(() => { const bar = document.getElementById('menu-load-bar'); const progress = bar?.querySelector('progress'); return { hidden: bar?.hidden, value: progress?.value, max: progress?.max, label: bar?.textContent }; })()`);
  assert.equal(gate.hidden, false, 'the load bar is visible while play is gated');
  assert.ok(gate.value >= 0 && gate.value < gate.max, `load bar carries real progress (${gate.value} / ${gate.max})`);
  assert.match(gate.label, /LOADING/);
  assert.ok(await page.evaluate(`!!document.getElementById('career-open') && !document.getElementById('workshop-open')`),
    'the single ARMORY entry is part of the first menu');
  assert.equal(await page.evaluate(`document.getElementById('career-open').disabled`), false, 'the armory entry responds while assets load');
  assert.match(await page.evaluate(`document.getElementById('career-open').textContent`), /ARMORY/);
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
