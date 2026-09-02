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
    const rect = document.getElementById(${JSON.stringify(id)})?.getBoundingClientRect();
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
      move: !!document.getElementById('touch-move-zone'),
      look: !!document.getElementById('touch-look-zone'),
      coarseClass: document.documentElement.classList.contains('vb-touch-mode'),
    }))()`);
    requireCondition(touchControls.active && touchControls.buttons === 10 &&
      touchControls.move && touchControls.look && touchControls.coarseClass,
    'mobile live play exposes movement, aim, fire, and auxiliary touch controls');

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
      });
      const output = path.resolve(PROJECT_ROOT, process.env.BROWSER_SMOKE_SCREENSHOT);
      await writeFile(output, Buffer.from(screenshot.data, 'base64'));
      console.log(`mobile screenshot: ${output}`);
    }

    await pressEscape(page);
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

    const appError = await page.evaluate(`document.documentElement.dataset.vbLastError || ''`);
    requireCondition(!appError && page.errors.length === 0,
      'full browser flow completes without runtime or resource errors');
    console.log('BROWSER FLOW SMOKE: OK');
  } finally {
    await browser?.close();
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
