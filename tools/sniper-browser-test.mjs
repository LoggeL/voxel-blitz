import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const server = startServer();
let browser;
try {
  const port = await server.port;
  browser = await launchCdpSession(`http://127.0.0.1:${port}/js/ui/hud-support.js`);
  const { page } = browser;
  const result = await page.evaluate(`(async () => {
    document.head.innerHTML = '<base href="/">';
    document.body.innerHTML = '<link rel="stylesheet" href="/style.css"><div id="hud"></div>';
    await new Promise(resolve => document.querySelector('link').onload = resolve);
    const { GameplayHud } = await import('/js/ui/gameplay-hud.js');
    const hud = new GameplayHud(); hud.buildHUD();
    hud.setState({ wid: 'sniper', alive: true, adsT01: 1, scopeActive: true,
      holdingBreath: true, breath01: 0.6, canHoldBreath: true, scopeZoom: 2.5 });
    const meter = document.getElementById('breath-meter');
    const visible = element => {
      for (let node = element; node; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (css.display === 'none' || css.visibility === 'hidden' || css.opacity === '0') return false;
      }
      return true;
    };
    const holdingVisible = visible(meter);
    const scoped = visible(document.getElementById('sniper-scope'));
    const crosshairHidden = !visible(document.getElementById('crosshair'));
    hud.setState({ scopeActive: false });
    const immediateExit = !visible(document.getElementById('sniper-scope'));
    hud.setState({ scopeActive: true });
    const { createVoices } = await import('/js/audio/primitives.js');
    const { renderBreath } = await import('/js/audio/breath.js');
    const levels = [];
    for (const event of ['inhale', 'exhale', 'gasp']) {
      const ctx = new OfflineAudioContext(1, 48000, 48000);
      const noiseBuffer = ctx.createBuffer(1, 48000, 48000);
      const noise = noiseBuffer.getChannelData(0);
      for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
      renderBreath(ctx.destination, createVoices({ ctx, noiseBuffer }), event);
      const buffer = await ctx.startRendering();
      const data = buffer.getChannelData(0);
      let peak = 0, energy = 0, tail = 0;
      for (let i = 0; i < data.length; i++) {
        peak = Math.max(peak, Math.abs(data[i])); energy += data[i] * data[i];
        if (i > 43200) tail += data[i] * data[i];
      }
      levels.push({ event, peak, rms: Math.sqrt(energy / data.length), tail });
    }
    return { holdingVisible, scoped, crosshairHidden, immediateExit, levels };
  })()`);
  for (const key of ['holdingVisible', 'scoped', 'crosshairHidden', 'immediateExit']) assert.equal(result[key], true, key);
  for (const level of result.levels) {
    assert.ok(level.rms > 0.001 && level.peak < 1, `${level.event} is audible without clipping`);
    assert.ok(level.tail < 1e-8, `${level.event} ends cleanly`);
  }
  await mkdir('.artifacts/sniper', { recursive: true });
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('.artifacts/sniper/scope-breath.png', Buffer.from(shot.data, 'base64'));
  assert.deepEqual(page.errors, []);
  console.log('Sniper browser: visible ADS breath meter, immediate scope exit and all three rendered breath cues passed.', result.levels);
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
