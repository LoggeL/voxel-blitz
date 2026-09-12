import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const server = startServer({ failureContext: 'music volume browser test' });
const evidence = [];
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  const origin = `http://127.0.0.1:${port}`;
  browser = await launchCdpSession(`${origin}/js/audio/music.js`, {
    autoplayPolicy: 'user-gesture-required', width: 1366, height: 900,
  });
  const page = browser.page;
  await page.evaluate(`localStorage.setItem('vb-menu-music', '0'); localStorage.removeItem('vb-music-volume');
    localStorage.setItem('vb-mode', 'ffa'); localStorage.setItem('vb-map', 'depot'); localStorage.setItem('vb-bots', '0');`);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const probe = window.__musicProbe = { sources: [], edges: new Map(), disconnected: new Set() };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(destination, ...args) {
      probe.edges.set(this, destination);
      probe.disconnected.delete(this);
      return connect.call(this, destination, ...args);
    };
    const disconnect = AudioNode.prototype.disconnect;
    AudioNode.prototype.disconnect = function(...args) {
      probe.disconnected.add(this);
      return disconnect.apply(this, args);
    };
    const create = BaseAudioContext.prototype.createBufferSource;
    BaseAudioContext.prototype.createBufferSource = function(...args) {
      const source = create.apply(this, args);
      const record = { source, ended: false, started: false };
      const start = source.start;
      source.start = function(...values) { record.started = true; return start.apply(this, values); };
      source.addEventListener('ended', () => { record.ended = true; });
      probe.sources.push(record);
      return source;
    };
    probe.snapshot = () => {
      const loops = probe.sources.filter(({ source }) => source.loop &&
        probe.edges.get(probe.edges.get(source)) instanceof DynamicsCompressorNode);
      const last = loops.at(-1);
      return { created: loops.length,
        active: loops.filter(record => record.started && !record.ended && !probe.disconnected.has(record.source)).length,
        gain: last ? probe.edges.get(last.source).gain.value : null,
        context: last?.source.context.state || null };
    };
  })();` });
  await page.send('Page.navigate', { url: `${origin}/?debug=1&headless=1&touch=1` });
  await page.waitFor(`document.querySelector('#menu [data-music-volume]') && document.getElementById('account-open') && document.getElementById('career-open')`);
  assert.equal(await page.evaluate(`document.querySelector('#menu [data-music-volume]').value`), '0');
  assert.equal(await page.evaluate(`localStorage.getItem('vb-music-volume')`), '0');
  assert.equal(await page.evaluate(`__musicProbe.snapshot().created`), 0, 'legacy mute starts no source');

  const point = selector => page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, width: rect.width, visible: rect.width > 0 && rect.height > 0,
      reachable: hit === element || element.contains(hit), disabled: element.disabled === true };
  })()`);
  const click = async selector => {
    const rect = await point(selector);
    assert.ok(rect.visible && rect.reachable && !rect.disabled, `real pointer can reach ${selector}`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const key = async (key, code, number) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: number });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: number });
  };
  const adjust = async (scope, keyName = 'End') => {
    const selector = `${scope} [data-music-volume]`;
    await click(selector);
    // A native pointer click sets a genuine intermediate percentage.
    const middle = Number(await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`));
    assert.ok(middle >= 45 && middle <= 55, `${scope} supports intermediate volume via pointer`);
    if (scope !== '#settings-overlay') {
      await page.waitFor(`__musicProbe.snapshot().active === 1 && Math.abs(__musicProbe.snapshot().gain - ${middle * 0.0016}) < 0.00001`,
        { label: `${scope} actual intermediate music gain` });
    }
    await key(keyName, keyName, keyName === 'Home' ? 36 : 35);
    const expected = keyName === 'Home' ? '0' : '100';
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), expected);
    assert.equal(await page.evaluate(`localStorage.getItem('vb-music-volume')`), expected);
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('[data-music-volume]')).every(input => input.value === ${JSON.stringify(expected)})`), true,
      'every mounted music control shares the new value');
    if (scope !== '#settings-overlay') {
      await page.waitFor(`Math.abs(__musicProbe.snapshot().gain - ${Number(expected) * 0.0016}) < 0.00001`,
        { label: `${scope} actual final music gain` });
    }
    return expected;
  };
  const capture = async (name, scope) => {
    const snapshot = await page.evaluate(`__musicProbe.snapshot()`);
    const rect = await point(`${scope} [data-music-volume]`);
    assert.ok(rect.visible && rect.reachable && !rect.disabled);
    evidence.push({ screen: name, ...snapshot });
    await mkdir('.artifacts/music-volume', { recursive: true });
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/music-volume/${name}.png`, Buffer.from(shot.data, 'base64'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    const mobile = await point(`${scope} [data-music-volume]`);
    assert.ok(mobile.visible && mobile.reachable && !mobile.disabled, `${name} music is reachable at 390px`);
    await adjust(scope);
    const mobileShot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/music-volume/${name}-390.png`, Buffer.from(mobileShot.data, 'base64'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  };

  await adjust('#menu');
  await page.waitFor(`__musicProbe.snapshot().active === 1 && __musicProbe.snapshot().context === 'running' && Math.abs(__musicProbe.snapshot().gain - 0.16) < 0.00001`,
    { label: 'real WebAudio menu gain at full music volume' });
  await capture('main-menu', '#menu');
  await page.evaluate(`import('/js/audio/sfx.js').then(({ sfx }) => sfx.setMasterVolume(0))`);
  assert.ok(Math.abs(await page.evaluate(`__musicProbe.snapshot().gain`) - 0.16) < 0.00001,
    'sound effect mute leaves music gain intact');
  await adjust('#menu', 'Home');
  await page.waitFor(`__musicProbe.snapshot().gain === 0`, { label: 'actual silent music gain' });
  await adjust('#menu');

  await click('#browse-lobbies-btn');
  await page.waitFor(`document.getElementById('lobby-browser').open`);
  await adjust('#lobby-browser');
  await capture('lobby-browser', '#lobby-browser');
  await click('#lobby-browser-close');
  await page.waitFor(`!document.getElementById('lobby-browser').open`);

  await click('#account-open');
  await page.waitFor(`document.getElementById('account-dialog').open`);
  await adjust('#account-dialog');
  await click('#account-tab-register');
  await adjust('#account-dialog');
  await capture('account', '#account-dialog');
  await click('#account-close');
  await click('#career-open');
  await page.waitFor(`document.getElementById('career-shop').open`);
  await adjust('#career-shop');
  await capture('career-shop', '#career-shop');
  await click('#career-close');
  await click('#create-lobby-btn');
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  await adjust('#lobby');
  await capture('waiting-lobby', '#lobby');
  assert.equal(await page.evaluate(`__musicProbe.snapshot().created`), 1, 'all menu transitions retain the same music source');
  await click('#lobby-ready-btn');
  await page.waitFor(`!document.getElementById('lobby-start-btn').disabled`);
  await click('#lobby-start-btn');
  await page.waitFor(`window.__vb?.stats.running && window.__vb.stats.alive`, { timeoutMs: 60000, label: 'live match' });
  await page.waitFor(`__musicProbe.snapshot().active === 0`, { label: 'music ends on live admission' });
  await click('#touch-pause');
  await page.waitFor(`window.__vb.stats.settingsOpen`);
  await adjust('#settings-overlay');
  assert.equal(await page.evaluate(`__musicProbe.snapshot().active`), 0, 'pause volume changes do not start music during live play');
  for (const tab of ['keyboard', 'display', 'debug', 'connection']) {
    await click(`#settings-tab-${tab}`);
    const rect = await point('#settings-overlay [data-music-volume]');
    assert.ok(rect.visible && rect.reachable, `music remains operable in ${tab} settings`);
  }
  await capture('pause-settings', '#settings-overlay');
  await click('#settings-leave-btn');
  await page.waitFor(`!window.__vb.stats.running && document.getElementById('menu').getAttribute('aria-hidden') === 'false'`);
  await page.waitFor(`__musicProbe.snapshot().active === 1`);
  await adjust('#menu', 'Home');
  await page.send('Page.reload');
  await page.waitFor(`document.querySelector('#menu [data-music-volume]')?.value === '0'`);
  assert.equal(await page.evaluate(`__musicProbe.snapshot().created`), 0, 'reload preserves silence without starting audio');
  await adjust('#menu');
  await page.waitFor(`__musicProbe.snapshot().active === 1`);
  await page.send('Page.reload');
  await page.waitFor(`document.querySelector('#menu [data-music-volume]')?.value === '100'`);
  await click('#menu [data-music-volume]');
  await page.waitFor(`__musicProbe.snapshot().active === 1 && __musicProbe.snapshot().context === 'running'`);
  await writeFile('.artifacts/music-volume/results.json', JSON.stringify(evidence, null, 2));
  assert.deepEqual(page.errors, []);
  console.log('Music browser: six screens, real pointer and keyboard changes, actual gain, SFX independence, one source, live pause, autoplay recovery and reload persistence passed.');
} finally {
  await browser?.close();
  await stopServer(server);
}
