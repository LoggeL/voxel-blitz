import path from 'node:path';
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

    await page.evaluate(`document.getElementById('create-lobby-btn').click()`);
    await page.waitFor(`document.getElementById('create-lobby-step')?.getAttribute('aria-hidden') === 'false' &&
      document.getElementById('map-preview-image')?.complete &&
      document.getElementById('map-preview-image')?.naturalWidth > 0`, {
      label: 'create-lobby detail step',
    });
    const createStep = await page.evaluate(`(() => ({
      modes: [...document.getElementById('game-mode-select').options].map((option) => option.value),
      maps: [...document.getElementById('map-select').options].map((option) => option.value),
      preview: document.getElementById('map-preview-image').dataset.map,
      previewAlt: document.getElementById('map-preview-image').alt,
      players: document.querySelectorAll('.vb-create-player').length,
      bots: document.getElementById('bot-count').options.length,
      focused: document.activeElement?.id,
    }))()`);
    requireCondition(createStep.modes.includes('gungame') && createStep.maps.length >= 2,
      'create-lobby detail step exposes current modes and compatible map choices');
    requireCondition(createStep.players === 8 && createStep.bots === 8 &&
      createStep.preview && /arena preview/i.test(createStep.previewAlt),
    'create-lobby detail step renders map preview, player list, and bot settings');
    requireCondition(createStep.focused === 'create-step-back',
      'multi-step menu moves keyboard focus into the detail step');

    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 840,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const fitsCompact = await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
    requireCondition(fitsCompact, 'create-lobby detail step avoids horizontal overflow at compact width');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: LIVE_WIDTH,
      height: LIVE_HEIGHT,
      deviceScaleFactor: 1,
      mobile: LIVE_WIDTH <= 720,
    });
    await page.evaluate(`document.getElementById('create-step-back').click()`);
    await page.waitFor(`document.getElementById('menu-primary-step')?.getAttribute('aria-hidden') === 'false'`, {
      label: 'create-lobby back navigation',
    });

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
    await page.evaluate(`(() => {
      const select = document.getElementById('game-mode-select');
      select.value = 'training';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    requireCondition(await page.evaluate(`document.getElementById('map-select').value === 'killhouse'`),
      'Training selects its compatible Killhouse map');
    await clickElement(page, 'create-step-back');
    await clickElement(page, 'training-btn');
    await page.waitFor(`!!document.getElementById('lobby-ready-btn') &&
      !document.getElementById('lobby')?.classList.contains('hidden')`, { label: 'Training waiting lobby' });
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
    await page.waitFor(`window.__vb.wheelOpen`, { label: 'held Q opens weapon wheel' });
    requireCondition(await page.evaluate(`(() => {
      const keys = [...document.querySelectorAll('#weapon-wheel .vb-wheel-key')];
      return keys.length === 10 && keys[9].textContent === '[0]';
    })()`), 'live weapon wheel shows ten slots with the correct zero key for the knife');
    if (process.env.BROWSER_SMOKE_SCREENSHOT) {
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 15_000);
      const output = path.resolve(PROJECT_ROOT, process.env.BROWSER_SMOKE_SCREENSHOT).replace(/\.png$/, '-wheel.png');
      await writeFile(output, Buffer.from(screenshot.data, 'base64'));
    }
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '0', code: 'Digit0' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '0', code: 'Digit0' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ' });
    await page.waitFor(`!window.__vb.wheelOpen && window.__vb.stats.weapon === 'knife'`, {
      label: 'weapon wheel knife selection',
    });
    requireCondition(true, 'wheel selection equips the knife and closes through the live controller');
    await pressEscape(page);
    await page.waitFor(`window.__vb.stats.settingsOpen`, { label: 'Training pause' });
    await clickElement(page, 'settings-leave-btn');
    await page.waitFor(`!window.__vb.stats.running && !document.getElementById('run-overlay')`, {
      label: 'Training teardown',
    });
    requireCondition(true, 'leaving Training disposes its overlay and returns to the menu');

    const appError = await page.evaluate(`document.documentElement.dataset.vbLastError || ''`);
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
