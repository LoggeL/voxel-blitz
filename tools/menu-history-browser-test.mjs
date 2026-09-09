import assert from 'node:assert/strict';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const server = startServer({ failureContext: 'menu history browser test' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  const origin = `http://127.0.0.1:${port}`;
  const previousUrl = `${origin}/assets/ui/menu-type-scuffs.svg`;
  browser = await launchCdpSession(previousUrl);
  const page = browser.page;
  const url = `${origin}/?debug=1&headless=1&touch=1`;
  await page.send('Page.navigate', { url });
  await page.waitFor(`document.getElementById('play-btn')`);
  // A real input event makes same-document history eligible for browser UI Back.
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 });
  const initial = await page.send('Page.getNavigationHistory');
  const rootIndex = initial.currentIndex;
  const rootEntry = initial.entries[rootIndex].id;
  const click = async (id) => {
    const { x, y } = await page.evaluate(`(() => {
      const element = document.getElementById(${JSON.stringify(id)});
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const waitDepth = (depth) => page.waitFor(`history.state?.voxelBlitzMenu?.path.length === ${depth}`,
    { label: `menu history depth ${depth}` });
  const back = async () => {
    const { entries, currentIndex } = await page.send('Page.getNavigationHistory');
    assert.ok(currentIndex > 0, 'a previous browser history entry exists');
    await page.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id });
  };
  const escape = async () => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  };
  const checkRoot = async () => {
    await waitDepth(0);
    const state = await page.send('Page.getNavigationHistory');
    assert.equal(state.currentIndex, rootIndex, 'no empty steps remain behind the main menu');
  };

  await page.evaluate(`history.replaceState({ ...history.state, unrelated: 'keep' }, '')`);
  await click('browse-lobbies-btn');
  await waitDepth(1);
  await back();
  await page.waitFor(`!document.getElementById('lobby-browser').open && document.activeElement.id === 'browse-lobbies-btn'`);
  await checkRoot();
  assert.equal(await page.evaluate('history.state.unrelated'), 'keep');
  console.log('ok - browser Back closes Find a Lobby and restores focus without unloading');

  for (const dismiss of [() => click('lobby-browser-close'), escape]) {
    await click('browse-lobbies-btn');
    await waitDepth(1);
    await dismiss();
    await checkRoot();
  }
  // Open during an ordinary close, before asynchronous history traversal settles.
  await click('browse-lobbies-btn');
  await waitDepth(1);
  await page.evaluate(`document.getElementById('lobby-browser-close').click(); document.getElementById('browse-lobbies-btn').click()`);
  await page.waitFor(`document.getElementById('lobby-browser').open`);
  await waitDepth(1);
  await back();
  await page.waitFor(`!document.getElementById('lobby-browser').open`);
  await checkRoot();
  console.log('ok - close buttons, Escape and rapid reopening keep history synchronized');

  await click('browse-lobbies-btn');
  await waitDepth(1);
  await click('browser-create-lobby-btn');
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  await waitDepth(1);
  const code = await page.evaluate(`document.getElementById('lobby-code-val').textContent`);
  assert.equal(await page.evaluate(`new URL(location.href).searchParams.get('lobby')`), code);
  // Authority updates rewrite the invitation URL and must retain navigation state.
  await click('lobby-ready-btn');
  await page.waitFor(`document.getElementById('lobby-ready-btn').getAttribute('aria-pressed') === 'true'`);
  await click('lobby-qr-btn');
  await page.waitFor(`document.getElementById('lobby-qr-dialog')?.open`);
  await waitDepth(2);
  await back();
  await page.waitFor(`!document.getElementById('lobby-qr-dialog').open && document.activeElement.id === 'lobby-qr-btn'`);
  assert.equal(await page.evaluate(`document.getElementById('lobby').getAttribute('aria-hidden')`), 'false');
  await waitDepth(1);
  await back();
  await page.waitFor(`document.getElementById('menu').getAttribute('aria-hidden') === 'false' && !location.search.includes('lobby=')`);
  await checkRoot();
  await page.waitFor(`fetch('/api/lobbies').then(r => r.json()).then(data => !data.lobbies.some(room => room.code === ${JSON.stringify(code)}))`);
  console.log('ok - Back dismisses QR first, then leaves the lobby and releases its server room');

  const afterLeave = await page.send('Page.getNavigationHistory');
  await page.send('Page.navigateToHistoryEntry', { entryId: afterLeave.entries[rootIndex + 1].id });
  await checkRoot();
  assert.equal(await page.evaluate(`document.getElementById('menu').getAttribute('aria-hidden')`), 'false');
  assert.equal(await page.evaluate(`location.search.includes('lobby=')`), false);
  console.log('ok - Forward past a dismissed lobby cannot reconnect or restore an expired invite');

  await click('create-lobby-btn');
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  await click('lobby-qr-btn');
  await waitDepth(2);
  await page.send('Page.navigateToHistoryEntry', { entryId: rootEntry });
  await page.waitFor(`document.getElementById('menu').getAttribute('aria-hidden') === 'false'`);
  await checkRoot();
  console.log('ok - jumping back multiple entries closes the nested dialog and lobby together');

  await page.evaluate(`localStorage.setItem('vb-mode', 'chaos'); localStorage.setItem('vb-bots', '0'); localStorage.setItem('vb-map', 'depot')`);
  await click('create-lobby-btn');
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  await click('lobby-ready-btn');
  await page.waitFor(`!document.getElementById('lobby-start-btn').disabled`);
  await click('lobby-start-btn');
  await page.waitFor(`window.__vb?.stats.running && window.__vb.stats.alive`, { label: 'live Chaos Lab', timeoutMs: 60_000 });
  await waitDepth(0);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
  await page.waitFor(`document.getElementById('buy-menu')?.getAttribute('aria-hidden') === 'false'`);
  await waitDepth(1);
  await back();
  await page.waitFor(`document.getElementById('buy-menu').getAttribute('aria-hidden') === 'true' && document.getElementById('touch-controls').classList.contains('is-active')`);
  await checkRoot();
  console.log('ok - Back closes the armory and restores gameplay input');
  await click('touch-pause');
  await page.waitFor(`window.__vb.stats.settingsOpen`);
  await waitDepth(1);
  await back();
  await page.waitFor(`!window.__vb.stats.settingsOpen && document.getElementById('touch-controls')?.classList.contains('is-active')`);
  assert.equal(await page.evaluate('window.__vb.stats.running'), true);
  await checkRoot();
  await click('touch-pause');
  await waitDepth(1);
  await click('settings-leave-btn');
  await page.waitFor(`!window.__vb.stats.running && document.getElementById('menu').getAttribute('aria-hidden') === 'false'`);
  await checkRoot();
  console.log('ok - Back resumes gameplay, and Quit clears the pause history entry');

  await back();
  await page.waitFor(`location.href === ${JSON.stringify(previousUrl)}`);
  console.log('ok - Back at the main menu still reaches the previous website');
  assert.deepEqual(page.errors, []);
  console.log('MENU HISTORY BROWSER: OK');
} finally {
  await browser?.close();
  await stopServer(server);
}
