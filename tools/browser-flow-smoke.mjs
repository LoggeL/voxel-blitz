import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    const url = `http://127.0.0.1:${port}/?debug=1&headless=1`;
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
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
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
