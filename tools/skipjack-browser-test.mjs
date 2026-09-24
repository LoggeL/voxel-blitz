import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'vb-skipjack-'));
const output = path.resolve('docs/design/blender/skipjack/review/browser');
await mkdir(output, { recursive: true });
const server = startServer({ cwd: process.cwd(), env: { VB_DATA_DIR: directory, VB_PERSISTENCE: 'file' } });
let browser;
try {
  const base = `http://127.0.0.1:${await server.port}`;
  browser = await launchCdpSession(`${base}/weapon-capture.html?weapon=mgl&state=held&ammo=3`,
    { width: 1280, height: 720 });
  const page = browser.page;
  for (const [name, width, height, ammo, state] of [
    ['desktop-3-total', 1280, 720, 3, 'held'],
    ['desktop-4-total', 1280, 720, 4, 'held'],
    ['desktop-2-after-shot', 1280, 720, 2, 'firing'],
    ['desktop-ads', 1280, 720, 3, 'scoped'],
    ['desktop-reload-open', 1280, 720, 3, 'reload-open'],
    ['desktop-reload-seated', 1280, 720, 3, 'reload-load'],
    ['desktop-reload-charge', 1280, 720, 3, 'reload-charge'],
    ['mobile-3-total', 390, 844, 3, 'held'],
  ]) {
    await page.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    await page.send('Page.navigate',
      { url: `${base}/weapon-capture.html?weapon=mgl&state=${state}&ammo=${ammo}` });
    await page.waitFor(`document.documentElement.dataset.captureReady === 'true'`,
      { timeoutMs: 20000, label: name });
    const capture = await page.evaluate('window.__vbWeaponCapture');
    assert.equal(capture.weapon, 'mgl');
    assert.equal(capture.ammo, ammo);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
  }
  console.log(`SKIPJACK browser captures passed: ${output}`);
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(directory, { recursive: true, force: true });
}
