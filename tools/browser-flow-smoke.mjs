import path from 'node:path';
import jsQR from 'jsqr';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_WIDTH = Math.max(320, Number(process.env.BROWSER_SMOKE_WIDTH) || 1280);
const LIVE_HEIGHT = Math.max(320, Number(process.env.BROWSER_SMOKE_HEIGHT) || 720);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

async function clickElement(page, id) {
  const point = await page.evaluate(`(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = element?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : null;
  })()`);
  if (!point) throw new Error(`cannot click missing or hidden #${id}`);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
  });
}

async function pressEscape(page) {
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
}

async function main() {
  const server = startServer({
    cwd: PROJECT_ROOT,
    failureContext: 'browser flow smoke',
  });
  let browser = null;
  try {
    const port = await server.port;
    await waitForHttp(port);
    const url = `http://127.0.0.1:${port}/?debug=1&headless=1&touch=1`;
    browser = await launchCdpSession(url);
    const page = browser.page;
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__testSockets = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) { super(...args); window.__testSockets.push(this); }
      };
    ` });
    await page.send('Page.reload');

    await page.waitFor(`document.readyState === 'complete' &&
      !!document.getElementById('play-btn') &&
      !document.getElementById('menu')?.classList.contains('hidden')`, {
      label: 'main menu readiness',
    });
    const menu = await page.evaluate(`(() => ({
      quick: document.getElementById('play-btn')?.textContent.trim(),
      hint: document.getElementById('play-btn')?.parentNode?.querySelector('.vb-action-hint')?.textContent.trim(),
      create: document.getElementById('create-lobby-btn')?.textContent.trim(),
      join: document.getElementById('join-lobby-btn')?.textContent.trim(),
    }))()`);
    requireCondition(menu.quick === 'QUICK PLAY' && menu.create === 'CREATE LOBBY' && menu.join === 'JOIN',
      'browser renders the complete first menu step');
    requireCondition(/AUTO ARENA/.test(menu.hint),
      'Quick Play truthfully advertises automatic arena rotation');

    await clickElement(page, 'menu-music-toggle');
    requireCondition(await page.evaluate(`localStorage.getItem('vb-menu-music') === '0' &&
      document.getElementById('menu-music-toggle').getAttribute('aria-pressed') === 'false'`),
    'menu music can be disabled independently and persists its preference');
    await page.send('Page.reload');
    await page.waitFor(`document.getElementById('menu-music-toggle')?.getAttribute('aria-pressed') === 'false'`,
      { label: 'muted music after reload' });
    await clickElement(page, 'menu-music-toggle');
    requireCondition(await page.evaluate(`localStorage.getItem('vb-menu-music') === '1' &&
      document.getElementById('menu-music-toggle').getAttribute('aria-pressed') === 'true'`),
    'menu music can be re-enabled from a user gesture');
    requireCondition(await page.evaluate(`(async () => {
      const { DEFAULT_MENU_TRACK } = await import('/js/audio/music.js');
      const ctx = new AudioContext();
      try {
        const response = await fetch(DEFAULT_MENU_TRACK);
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        return buffer.duration > 63 && buffer.duration < 65 && buffer.numberOfChannels === 2;
      } finally { await ctx.close(); }
    })()`), 'new industrial menu track loads and decodes as a 64-second stereo loop');

    await page.send('Emulation.setDeviceMetricsOverride', {
      width: LIVE_WIDTH, height: LIVE_HEIGHT, deviceScaleFactor: 1, mobile: false,
    });
    await page.waitFor(`document.querySelector('.vb-training-image')?.complete &&
      document.querySelector('.vb-training-image')?.naturalWidth > 0`, { label: 'Killhouse menu preview' });
    requireCondition(await page.evaluate(`document.getElementById('menu').scrollWidth <= innerWidth`),
      'redesigned main menu has no horizontal overflow at the requested viewport');
    if (process.env.BROWSER_SMOKE_SCREENSHOT) {
      await page.evaluate(`document.getElementById('menu').scrollTop = 0`);
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 15_000);
      const output = path.resolve(PROJECT_ROOT, process.env.BROWSER_SMOKE_SCREENSHOT).replace(/\.png$/, '-menu.png');
      await writeFile(output, Buffer.from(screenshot.data, 'base64'));
    }

    await clickElement(page, 'browse-lobbies-btn');
    await page.waitFor(`document.querySelector('.vb-browser-status')?.textContent.includes('No lobbies yet')`,
      { label: 'empty lobby browser' });
    await pressEscape(page);
    requireCondition(await page.evaluate(`!document.getElementById('lobby-browser').open`),
      'Escape closes the lobby browser');
    await page.evaluate(`new Promise((resolve, reject) => {
      const ws = window.__directoryHost = new WebSocket('ws://' + location.host);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'create', name: 'DirectoryHost', bots: 0, password: 'test room' }));
      ws.onmessage = (event) => {
        if (typeof event.data === 'string' && JSON.parse(event.data).t === 'lobbyState') resolve(true);
      };
      ws.onerror = reject;
    })`);
    await clickElement(page, 'browse-lobbies-btn');
    await page.waitFor(`document.querySelector('.vb-browser-room input')`, { label: 'protected directory entry' });
    requireCondition(await page.evaluate(`document.querySelector('.vb-browser-room').textContent.includes('DirectoryHost')
      && document.querySelector('.vb-browser-room').textContent.includes('Password required')
      && document.getElementById('lobby-browser').scrollWidth <= document.getElementById('lobby-browser').clientWidth`),
      'directory shows protected rooms without horizontal overflow');
    await page.evaluate(`(() => {
      document.querySelector('.vb-browser-room input').value = 'wrong';
      document.querySelector('.vb-browser-room').requestSubmit();
    })()`);
    await page.waitFor(`document.getElementById('join-status')?.textContent.includes('Incorrect lobby password')`,
      { label: 'wrong lobby password feedback' });
    await clickElement(page, 'browse-lobbies-btn');
    await page.waitFor(`document.querySelector('.vb-browser-room input')`, { label: 'password retry' });
    await page.evaluate(`(() => {
      document.querySelector('.vb-browser-room input').value = 'test room';
      document.querySelector('.vb-browser-room').requestSubmit();
    })()`);
    await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`,
      { label: 'direct join from directory' });
    requireCondition(true, 'correct password joins a directory room without entering a code');
    await clickElement(page, 'lobby-leave-btn');
    await page.waitFor(`document.getElementById('menu')?.getAttribute('aria-hidden') === 'false'`, { label: 'leave directory lobby' });
    await page.evaluate(`window.__directoryHost.close()`);
    await page.evaluate(`document.getElementById('create-password-input').value = 'host password'`);

    await clickElement(page, 'create-lobby-btn');
    await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false' &&
      document.getElementById('lobby-map-preview')?.naturalWidth > 0`, { label: 'immediate waiting lobby' });
    requireCondition(await page.evaluate(`new URL(location.href).searchParams.get('lobby') ===
      document.getElementById('lobby-code-val').textContent &&
      document.getElementById('lobby-invite-input').value.includes('?lobby=')`),
      'Create immediately exposes an active code in the URL and invitation');
    await page.evaluate(`(() => {
      const select = document.getElementById('game-mode-select');
      select.value = 'tdm'; select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.waitFor(`document.getElementById('lobby-mode-val').textContent.includes('TEAM')`,
      { label: 'authoritative mode edit' });
    await page.evaluate(`(() => {
      const select = document.getElementById('map-select');
      select.value = 'depot'; select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.waitFor(`document.getElementById('lobby-map-val').textContent.includes('DEPOT')`,
      { label: 'authoritative map edit' });
    requireCondition(await page.evaluate(`document.getElementById('lobby').scrollWidth <= innerWidth`),
      'editable lobby fits the requested viewport');
    if (process.env.BROWSER_SMOKE_SCREENSHOT) {
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(path.resolve(PROJECT_ROOT, process.env.BROWSER_SMOKE_SCREENSHOT).replace(/\.png$/, '-lobby.png'),
        Buffer.from(screenshot.data, 'base64'));
    }
    await clickElement(page, 'lobby-qr-btn');
    await page.waitFor(`document.getElementById('lobby-qr-dialog')?.open`, { label: 'large invitation QR dialog' });
    const qrPixels = await page.evaluate(`(() => {
      const canvas = document.getElementById('lobby-qr-canvas');
      return { width: canvas.width, height: canvas.height,
        pixels: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data),
        url: document.getElementById('lobby-invite-input').value };
    })()`);
    const decoded = jsQR(new Uint8ClampedArray(qrPixels.pixels), qrPixels.width, qrPixels.height);
    requireCondition(decoded?.data === qrPixels.url, 'rendered QR independently decodes to the exact lobby invitation URL');
    requireCondition(await page.evaluate(`(() => {
      const r = document.getElementById('lobby-qr-dialog').getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    })()`), 'large QR dialog stays within the viewport');
    if (process.env.BROWSER_SMOKE_SCREENSHOT) {
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(path.resolve(PROJECT_ROOT, process.env.BROWSER_SMOKE_SCREENSHOT).replace(/\.png$/, '-qr.png'),
        Buffer.from(screenshot.data, 'base64'));
    }
    await pressEscape(page);
    requireCondition(await page.evaluate(`!document.getElementById('lobby-qr-dialog').open &&
      document.getElementById('lobby').getAttribute('aria-hidden') === 'false' &&
      document.activeElement.id === 'lobby-qr-btn'`), 'Escape closes only the QR dialog and restores button focus');
    const reconnectCode = await page.evaluate(`document.getElementById('lobby-code-val').textContent`);
    await page.evaluate(`new Promise((resolve, reject) => {
      window.__interruptedSocket = window.__testSockets.at(-1);
      const peer = window.__recoveryPeer = new WebSocket(location.origin.replace(/^http/, 'ws'));
      peer.onopen = () => peer.send(JSON.stringify({t: 'join', name: 'RecoveryWitness',
        lobby: new URL(location.href).searchParams.get('lobby'), password: 'host password'}));
      peer.onmessage = (event) => {
        if (typeof event.data === 'string' && JSON.parse(event.data).t === 'lobbyState') resolve(true);
      };
      peer.onerror = reject;
    })`);
    await page.evaluate(`window.__interruptedSocket.close(1000, 'simulated transport interruption')`);
    await page.waitFor(`document.getElementById('join-status')?.textContent.includes('Reconnecting')`,
      { label: 'automatic reconnect feedback' });
    await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false' &&
      document.getElementById('lobby-code-val').textContent === ${JSON.stringify(reconnectCode)}`,
      { label: 'automatic waiting lobby recovery' });
    requireCondition(true, 'lost connection automatically returns to the same configured lobby');
    await page.evaluate(`window.__recoveryPeer.close()`);
    await clickElement(page, 'lobby-leave-btn');
    await page.waitFor(`document.getElementById('menu')?.getAttribute('aria-hidden') === 'false'`,
      { label: 'leave immediate lobby' });

    await page.evaluate(`(() => {
      const name = document.getElementById('name-input');
      name.value = 'BrowserQA';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await clickElement(page, 'play-btn');
    await page.waitFor(`window.__vb?.stats?.running === true &&
      window.__vb.stats.ringLen > 0 && window.__vb.stats.avatars >= 5`, {
      timeoutMs: 30_000,
      label: 'Quick Play live handoff',
    });
    const live = await page.evaluate(`window.__vb.stats`);
    requireCondition(live.alive && live.running && live.avatars >= 5,
      'Quick Play reaches live play with at least five replacement-capable bots');
    requireCondition(live.lastSnapAgeMs < 1_000 && live.ping >= 0,
      'browser receives fresh authoritative snapshots');
    requireCondition(live.shader?.enabled === true && live.shader.frames > 0 &&
      live.shader.fallbacks === 0 && live.shader.bufferWidth > 0 && live.shader.bufferHeight > 0,
    'combat post-process compiles and renders through its bounded target');

    const touchControls = await page.evaluate(`(() => ({
      active: document.getElementById('touch-controls')?.classList.contains('is-active'),
      buttons: document.querySelectorAll('#touch-controls .vb-touch-button').length,
      visible: document.querySelectorAll('#touch-controls .vb-touch-button:not(.is-hidden)').length,
      fire: !!document.querySelector('#touch-controls .vb-touch-fire:not(.is-hidden)'),
      weapon: !!document.querySelector('#touch-controls .vb-touch-weapon:not(.is-hidden)'),
      move: !!document.getElementById('touch-move-zone'),
      look: !!document.getElementById('touch-look-zone'),
      coarseClass: document.documentElement.classList.contains('vb-touch-mode'),
    }))()`);
    requireCondition(touchControls.active && touchControls.buttons === 8 &&
      touchControls.visible >= 5 && touchControls.visible <= 6 && touchControls.fire && touchControls.weapon &&
      touchControls.move && touchControls.look && touchControls.coarseClass,
    'mobile live play exposes only core touch actions during arena play');

    const mobileLayout = await page.evaluate(`(async () => {
      const { TouchControls } = await import('/js/engine/touch-controls.js');
      const fixture = new TouchControls();
      fixture.mount();
      fixture.setContext({ alive: true, canFire: true, canReload: true, weaponCount: 2, canInteract: true });
      fixture.setEnabled(true);
      const errors = [];
      try {
        for (const size of ['small', 'medium', 'large']) {
          for (const hand of ['right', 'left']) {
            fixture.setOptions({ size, hand });
            const targets = [...fixture.root.querySelectorAll('.vb-touch-button:not(.is-hidden)')]
              .map((el) => ({ id: el.id, rect: el.getBoundingClientRect() }));
            for (let i = 0; i < targets.length; i++) {
              const { id, rect: r } = targets[i];
              if (r.width < 44 || r.height < 44 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) {
                errors.push(size + '/' + hand + ': clipped or undersized ' + id);
              }
              for (const { id: other, rect: b } of targets.slice(i + 1)) {
                if (r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) {
                  errors.push(size + '/' + hand + ': ' + id + ' overlaps ' + other);
                }
              }
            }
          }
        }
      } finally { fixture.dispose(); }
      // The fixture shares this global capability class with the live controls.
      document.documentElement.classList.add('vb-touch-mode');
      return errors;
    })()`);
    requireCondition(mobileLayout.length === 0,
      'all mobile sizes and hands have separate, in-bounds targets of at least 44px: ' + mobileLayout.join('; '));

    const matchLayout = await page.evaluate(`(async () => {
      const { MatchHud } = await import('/js/ui/match-hud.js');
      const root = document.createElement('div');
      root.style.cssText = 'position:fixed;inset:0;pointer-events:none';
      document.body.appendChild(root);
      const fixture = new MatchHud();
      fixture.build(root);
      const errors = [];
      try {
        for (const mode of ['fun', 'training', 'tdm', 'snd', 'gungame']) {
          fixture.setMatchState({ mode, phase: 'live', round: 13, phaseEndsAt: Date.now() + 90000,
            scores: { alpha: 12, bravo: 11 }, attackers: 'alpha',
            bomb: { state: 'planted', site: 'B', explodeAt: Date.now() + 30000 } },
            { id: 'qa', team: 'alpha', state: 'alive', score: 4 }, [], Date.now());
          const header = fixture.dom.header;
          const r = header.getBoundingClientRect();
          if (header.scrollWidth > header.clientWidth + 1 || r.left < 0 || r.right > innerWidth || r.bottom > 64) {
            errors.push(mode + ': header overlaps health/ammo or clips (' + r.width + ' x ' + r.height + ')');
          }
        }
      } finally { fixture.dispose(); root.remove(); }
      return errors;
    })()`);
    requireCondition(matchLayout.length === 0, 'mobile headers fit above health and ammo in every mode: ' + matchLayout.join('; '));

    const mobileInput = await page.evaluate(`(async () => {
      const pointer = (type, target, init) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1, ...init,
      }));
      const look = document.getElementById('touch-look-zone');
      const controls = document.getElementById('touch-controls');
      const waitUntilControllable = async () => {
        for (let i = 0; i < 120; i += 1) {
          if (window.__vb.stats.alive && controls.classList.contains('is-active')) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return false;
      };
      await waitUntilControllable();
      const lookRect = look.getBoundingClientRect();
      pointer('pointerdown', look, { pointerId: 71, clientX: lookRect.left + 80, clientY: lookRect.top + 80 });
      const lookEngaged = look.classList.contains('is-engaged');
      pointer('pointermove', look, { pointerId: 71, clientX: lookRect.left + 118, clientY: lookRect.top + 62 });
      pointer('pointerup', look, { pointerId: 71, clientX: lookRect.left + 118, clientY: lookRect.top + 62 });
      const lookReleased = !look.classList.contains('is-engaged');

      const move = document.getElementById('touch-move-zone');
      const base = move.querySelector('.vb-touch-stick-base').getBoundingClientRect();
      const cx = base.left + base.width / 2;
      const cy = base.top + base.height / 2;
      pointer('pointerdown', move, { pointerId: 72, clientX: cx, clientY: cy });
      pointer('pointermove', move, { pointerId: 72, clientX: cx, clientY: cy - 52 });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const knob = move.querySelector('.vb-touch-stick-knob').style.transform;
      pointer('pointerup', move, { pointerId: 72, clientX: cx, clientY: cy - 52 });

      await waitUntilControllable();
      const fire = document.getElementById('touch-fire');
      pointer('pointerdown', fire, { pointerId: 73, clientX: 0, clientY: 0 });
      const fireHeld = fire.getAttribute('aria-pressed') === 'true';
      pointer('pointerup', fire, { pointerId: 73, clientX: 0, clientY: 0 });
      return {
        lookEngaged,
        lookReleased,
        knob,
        fireHeld,
        fireReleased: fire.getAttribute('aria-pressed') === 'false',
        aliveAfter: window.__vb.stats.alive,
        controlsActiveAfter: document.getElementById('touch-controls')?.classList.contains('is-active'),
      };
    })()`);
    requireCondition(mobileInput.lookEngaged && mobileInput.lookReleased &&
      mobileInput.knob !== 'translate(0px, 0px)' &&
      mobileInput.fireHeld && mobileInput.fireReleased,
    `mobile pointer lifecycles route look, persistent joystick, and fire hold/release ${JSON.stringify(mobileInput)}`);

    if (process.env.BROWSER_SMOKE_SCREENSHOT) {
      const screenshot = await page.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      }, 15_000);
      const output = path.resolve(PROJECT_ROOT, process.env.BROWSER_SMOKE_SCREENSHOT);
      await writeFile(output, Buffer.from(screenshot.data, 'base64'));
      console.log(`mobile screenshot: ${output}`);
    }

    await clickElement(page, 'touch-pause');
    await page.waitFor(`window.__vb.stats.settingsOpen === true &&
      document.getElementById('settings-overlay')?.getAttribute('aria-hidden') === 'false' &&
      document.activeElement?.id === 'settings-resume-btn'`, {
      label: 'pause menu opening',
    });
    const pause = await page.evaluate(`(() => ({
      resume: document.getElementById('settings-resume-btn')?.textContent.trim(),
      leave: document.getElementById('settings-leave-btn')?.textContent.trim(),
    }))()`);
    requireCondition(pause.resume === 'RESUME' && pause.leave === 'QUIT TO MAIN MENU',
      'pause menu exposes Resume and an honest match exit');

    await clickElement(page, 'settings-resume-btn');
    await page.waitFor(`window.__vb.stats.settingsOpen === false`, {
      label: 'pause resume',
    });
    requireCondition(true, 'Resume returns the browser to live play');

    await pressEscape(page);
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 250))`);
    if (!await page.evaluate(`window.__vb.stats.settingsOpen`)) await pressEscape(page);
    await page.waitFor(`window.__vb.stats.settingsOpen === true`, {
      label: 'pause menu reopening',
    });
    await clickElement(page, 'settings-leave-btn');
    await page.waitFor(`window.__vb.stats.running === false &&
      !document.getElementById('menu')?.classList.contains('hidden') &&
      document.getElementById('menu')?.getAttribute('aria-hidden') === 'false'`, {
      label: 'quit to main menu',
    });
    requireCondition(true, 'Quit tears down live resources and returns to the main menu');

    await clickElement(page, 'create-lobby-btn');
    await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`,
      { label: 'new lobby after live match' });
    await page.evaluate(`(() => {
      const select = document.getElementById('game-mode-select');
      select.value = 'training'; select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.waitFor(`document.getElementById('map-select').value === 'killhouse' &&
      document.getElementById('bot-count').disabled`, { label: 'authoritative Training configuration' });
    await clickElement(page, 'lobby-ready-btn');
    await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled === false`, {
      label: 'Training ready gate',
    });
    await clickElement(page, 'lobby-start-btn');
    await page.waitFor(`window.__vb.stats.running && window.__vb.stats.avatars === 17 &&
      document.getElementById('run-overlay') &&
      !document.getElementById('run-overlay').classList.contains('hidden')`, {
      label: 'Training live handoff', timeoutMs: 30_000,
    });
    requireCondition(true, 'Training starts with exactly 17 targets and its run overlay after a previous match');
    await page.evaluate(`new Promise((resolve, reject) => {
      window.__interruptedSocket = window.__testSockets.at(-1);
      const peer = window.__recoveryPeer = new WebSocket(location.origin.replace(/^http/, 'ws'));
      peer.onopen = () => peer.send(JSON.stringify({t: 'join', name: 'LiveWitness',
        lobby: new URL(location.href).searchParams.get('lobby'), password: 'host password'}));
      peer.onmessage = (event) => {
        if (typeof event.data === 'string' && JSON.parse(event.data).t === 'lobbyState') resolve(true);
      };
      peer.onerror = reject;
    })`);
    await page.evaluate(`window.__interruptedSocket.close(1000, 'simulated live interruption')`);
    await page.waitFor(`document.getElementById('join-status')?.textContent.includes('Reconnecting')`,
      { label: 'live reconnect feedback' });
    await page.waitFor(`window.__vb.stats.running && window.__vb.stats.lastSnapAgeMs < 1000`,
      { label: 'live match automatic recovery', timeoutMs: 30000 });
    await page.evaluate(`window.__recoveryPeer.close()`);
    requireCondition(true, 'a lost live connection automatically rejoins the running match');
    const initialWeapon = await page.evaluate('window.__vb.stats.weapon');
    const ammoPoint = await page.evaluate(`(() => {
      const r = document.getElementById('ammo').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...ammoPoint, id: 1 }] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitFor('window.__vb.stats.weapon !== ' + JSON.stringify(initialWeapon), { label: 'ammo-panel weapon swap' });
    requireCondition(await page.evaluate('!window.__vb.wheelOpen'), 'tapping the ammo panel swaps weapons without opening a wheel');
    if (process.env.BROWSER_SMOKE_SCREENSHOT) {
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 15_000);
      const output = path.resolve(PROJECT_ROOT, process.env.BROWSER_SMOKE_SCREENSHOT).replace(/\.png$/, '-training.png');
      await writeFile(output, Buffer.from(screenshot.data, 'base64'));
    }
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ' });
    await page.waitFor(`window.__vb.wheelOpen`, { label: 'Q opens weapon wheel while held' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ' });
    await page.evaluate('new Promise(resolve => setTimeout(resolve, 300))');
    requireCondition(await page.evaluate('!window.__vb.wheelOpen'), 'Q release closes the weapon wheel');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ' });
    await page.waitFor('window.__vb.wheelOpen', { label: 'held Q reopens wheel for selection' });
    requireCondition(await page.evaluate(`(() => {
      const keys = [...document.querySelectorAll('#weapon-wheel .vb-wheel-key')];
      return keys.length === ${WEAPON_IDS.length} && keys[9].textContent === '[0]';
    })()`), 'live weapon wheel shows the full roster with the correct zero key for the knife');
    const wheelPick = await page.evaluate(`(() => {
      const rect = document.querySelectorAll('#weapon-wheel .vb-wheel-slot')[9].getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...wheelPick });
    await page.waitFor(`document.querySelectorAll('#weapon-wheel .vb-wheel-slot')[9].classList.contains('is-hl')`, {
      label: 'mouse hover highlights the knife without clicking',
    });
    requireCondition(await page.evaluate(`window.__vb.wheelOpen && window.__vb.stats.weapon !== 'knife'`),
      'hover previews the weapon without equipping it');
    if (process.env.BROWSER_SMOKE_SCREENSHOT) {
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 15_000);
      const output = path.resolve(PROJECT_ROOT, process.env.BROWSER_SMOKE_SCREENSHOT).replace(/\.png$/, '-wheel.png');
      await writeFile(output, Buffer.from(screenshot.data, 'base64'));
    }
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ' });
    await page.waitFor(`!window.__vb.wheelOpen && window.__vb.stats.weapon === 'knife'`, {
      label: 'weapon wheel knife selection',
    });
    requireCondition(true, 'wheel selection equips the knife and closes through the live controller');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ' });
    await page.waitFor('window.__vb.wheelOpen', { label: 'flamethrower wheel selection' });
    const flamePick = await page.evaluate(`(() => {
      const rect = document.querySelectorAll('#weapon-wheel .vb-wheel-slot')[${WEAPON_IDS.indexOf('flamethrower')}].getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...flamePick });
    await page.waitFor(`document.querySelectorAll('#weapon-wheel .vb-wheel-slot')[${WEAPON_IDS.indexOf('flamethrower')}].classList.contains('is-hl')`,
      { label: 'flamethrower highlighted' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ' });
    await page.waitFor(`!window.__vb.wheelOpen && window.__vb.stats.weapon === 'flamethrower'`,
      { label: 'flamethrower equipped' });
    const stream = await page.evaluate(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const fire = document.getElementById('touch-fire');
      const dispatch = type => fire.dispatchEvent(new PointerEvent(type,
        { bubbles: true, pointerId: 81, pointerType: 'touch', clientX: 0, clientY: 0 }));
      const before = window.__vb.stats.flameStream.fuel;
      dispatch('pointerdown');
      const samples = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        samples.push(window.__vb.stats.flameStream);
      }
      dispatch('pointerup');
      await new Promise(resolve => setTimeout(resolve, 100));
      const released = !window.__vb.stats.flameStream.active;
      await new Promise(resolve => setTimeout(resolve, 750));
      return { before, samples, released, drained: window.__vb.stats.flameStream.particles === 0 };
    })()`);
    console.log('live flame stream samples:', JSON.stringify(stream));
    requireCondition(stream.samples.slice(2).every(s => s.active && s.particles > 0)
      && stream.before - stream.samples.at(-1).fuel >= 15 && stream.released && stream.drained,
      'live held flamethrower consumes fuel continuously, keeps its jet visible, stops on release and drains particles');

    // Observe real server ticks alongside the visible HUD. Inputs still enter
    // through the live wheel/touch controls; no weapon state is injected.
    await page.evaluate(`(() => {
      window.__heavyAuthority = null;
      window.__heavyWatchers = [];
      for (const socket of window.__testSockets.filter(socket => socket.readyState === WebSocket.OPEN)) {
        const observe = event => {
          if (typeof event.data !== 'string') return;
          const tick = JSON.parse(event.data);
          if (tick.t !== 'tick') return;
          const self = tick.players?.find(row => row.id === window.__vb.stats.localId);
          if (self) window.__heavyAuthority = {
            weapon: self.weapon, mag: self.mag[${WEAPON_IDS.indexOf('minigun')}],
            spin: self.minigun?.spin, heat: self.minigun?.heat,
            overheated: self.minigun?.overheated, ads: self.ads, firing: self.firing,
          };
        };
        socket.addEventListener('message', observe);
        window.__heavyWatchers.push({ socket, observe });
      }
      window.__heavyRead = () => ({
        authority: window.__heavyAuthority,
        ammo: Number(document.getElementById('ammocount').textContent),
        label: document.querySelector('#charge-meter .vb-charge-label').textContent,
        adsT: window.__vb.stats.adsT,
      });
      window.__heavyPointer = (action, type, pointerId) =>
        document.getElementById('touch-' + action).dispatchEvent(new PointerEvent(type,
          { bubbles: true, pointerId, pointerType: 'touch', clientX: 0, clientY: 0 }));
    })()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ' });
    await page.waitFor('window.__vb.wheelOpen', { label: 'minigun wheel selection' });
    const minigunPick = await page.evaluate(`(() => {
      const rect = document.querySelectorAll('#weapon-wheel .vb-wheel-slot')[${WEAPON_IDS.indexOf('minigun')}].getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...minigunPick });
    await page.waitFor(`document.querySelectorAll('#weapon-wheel .vb-wheel-slot')[${WEAPON_IDS.indexOf('minigun')}].classList.contains('is-hl')`,
      { label: 'minigun highlighted' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ' });
    await page.waitFor(`!window.__vb.wheelOpen && window.__vb.stats.weapon === 'minigun' &&
      window.__heavyAuthority?.weapon === ${WEAPON_IDS.indexOf('minigun')} &&
      window.__heavyRead().ammo === window.__heavyAuthority.mag`, { label: 'minigun authority and HUD equipped' });
    const minigunBefore = await page.evaluate('window.__heavyRead()');
    await page.evaluate(`window.__heavyPointer('ads', 'pointerdown', 82)`);
    await page.waitFor(`window.__heavyAuthority?.spin === 1 && window.__heavyAuthority.ads &&
      window.__heavyRead().label.includes('ROTOR READY')`, { label: 'ADS-only minigun reaches firing speed', timeoutMs: 5000 });
    const minigunPrimed = await page.evaluate('window.__heavyRead()');
    requireCondition(minigunPrimed.authority.mag === minigunBefore.authority.mag
      && minigunPrimed.ammo === minigunBefore.ammo && minigunPrimed.authority.heat === 0
      && !minigunPrimed.authority.firing && minigunPrimed.adsT > 0.9,
    'live ADS-only minigun reaches rotor ready without ammunition use, heat or authoritative shots');
    await page.evaluate(`window.__heavyPointer('fire', 'pointerdown', 83)`);
    await page.waitFor(`window.__heavyAuthority?.mag <= ${minigunPrimed.authority.mag - 16} &&
      window.__heavyAuthority.heat > 0.15 && window.__heavyRead().ammo < ${minigunPrimed.ammo}`,
      { label: 'pre-spun minigun fires live rounds', timeoutMs: 5000 });
    const minigunFiring = await page.evaluate('window.__heavyRead()');
    await page.evaluate(`window.__heavyPointer('fire', 'pointerup', 83)`);
    await page.waitFor(`!window.__heavyAuthority?.firing && window.__heavyRead().label.includes('ROTOR READY') &&
      window.__heavyRead().ammo === window.__heavyAuthority.mag`, { label: 'minigun trigger released while ADS remains held', timeoutMs: 3000 });
    const minigunPause = await page.evaluate('window.__heavyRead()');
    await page.waitFor(`window.__heavyAuthority?.heat < ${minigunPause.authority.heat - 0.04}`,
      { label: 'ADS-held minigun cools between bursts', timeoutMs: 3000 });
    const minigunCooled = await page.evaluate('window.__heavyRead()');
    requireCondition(minigunFiring.authority.mag < minigunPrimed.authority.mag
      && minigunFiring.authority.heat > 0.15 && minigunCooled.authority.spin === 1
      && minigunCooled.authority.ads && !minigunCooled.authority.firing
      && minigunCooled.authority.mag === minigunPause.authority.mag
      && minigunCooled.ammo === minigunPause.ammo && minigunCooled.label.includes('ROTOR READY'),
    'live trigger uses minigun ammunition and heat, then ADS preserves a ready rotor while cooling without firing');
    await page.evaluate(`window.__heavyPointer('ads', 'pointerup', 82)`);
    await page.waitFor(`window.__heavyAuthority?.spin === 0 && !window.__heavyAuthority.ads &&
      window.__heavyRead().label.includes('AIM TO PRE-SPIN')`, { label: 'released minigun coasts to a complete stop', timeoutMs: 5000 });
    const minigunReleased = await page.evaluate('window.__heavyRead()');
    requireCondition(!minigunReleased.authority.firing && minigunReleased.authority.mag === minigunCooled.authority.mag,
      'releasing ADS stops the minigun rotor without spending further ammunition');
    console.log('live minigun lifecycle:', JSON.stringify({
      before: minigunBefore, primed: minigunPrimed, firing: minigunFiring,
      pause: minigunPause, cooled: minigunCooled, released: minigunReleased,
    }));
    await page.evaluate(`(() => {
      for (const { socket, observe } of window.__heavyWatchers) socket.removeEventListener('message', observe);
      delete window.__heavyWatchers; delete window.__heavyAuthority;
      delete window.__heavyRead; delete window.__heavyPointer;
    })()`);

    await pressEscape(page);
    await page.waitFor(`window.__vb.stats.settingsOpen`, { label: 'Training pause' });
    requireCondition(await page.evaluate(`(() => {
      for (const key of ['showPing', 'showFps', 'showNetwork', 'showHitboxes', 'showWireframes']) {
        const select = document.getElementById('settings-' + key);
        if (!select) return false;
        select.value = '1';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (localStorage.getItem('vb-display-' + key) !== '1') return false;
      }
      return true;
    })()`), 'all display and debug settings are available and persisted');
    await page.waitFor(`getComputedStyle(document.getElementById('net-meter')).display !== 'none'`, {
      label: 'enabled telemetry visible on touch layout',
    });
    await clickElement(page, 'settings-leave-btn');
    await page.waitFor(`!window.__vb.stats.running && !document.getElementById('run-overlay')`, {
      label: 'Training teardown',
    });
    requireCondition(true, 'leaving Training disposes its overlay and returns to the menu');

    const appError = await page.evaluate(`document.documentElement.dataset.vbLastError || ''`);
    if (appError || page.errors.length) {
      console.error('browser runtime/resource diagnostics:', JSON.stringify({
        appError,
        errors: page.errors,
        logEntries: page.events
          .filter((event) => event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error')
          .map((event) => event.params.entry),
      }));
    }
    requireCondition(!appError && page.errors.length === 0,
      'full browser flow completes without runtime or resource errors');
    console.log('BROWSER FLOW SMOKE: OK');
  } catch (error) {
    if (browser) {
      try {
        const capture = await browser.page.send('Page.captureScreenshot', { format: 'png' }, 15_000);
        await writeFile(path.join(PROJECT_ROOT, '.artifacts/browser-flow-failure.png'), Buffer.from(capture.data, 'base64'));
        console.error('browser failure state:', await browser.page.evaluate(`JSON.stringify({
          stats: window.__vb?.stats,
          leave: document.getElementById('settings-leave-btn')?.getBoundingClientRect().toJSON(),
        })`));
      } catch { /* Preserve the original browser failure if diagnostics cannot run. */ }
    }
    throw error;
  } finally {
    await browser?.close();
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
