#!/usr/bin/env node
/**
 * Muted CDP captures of the tank driver's seat views through the static
 * vehicle capture page (public/vehicle-capture.html: real VehicleView,
 * VehicleCamera and the live reticle code with ?hud=1) at desktop 1440x900,
 * phone portrait 390x844 and phone landscape 844x390. No live match, no
 * game server, no audio (Chromium runs with --mute-audio).
 *
 *   node tools/conquest-tank-driver-capture.mjs [--out <dir>] [--views cockpit,driver] [--sizes desktop,portrait,landscape]
 *
 * Shots: the gun turned `aim` rad from the hull (default -0.6, 34° right, so
 * the turret visibly turns away from the driver's periscope) and the tank
 * driving at 6.4 m/s (23 km/h). Not part of conquest:test (it needs a local Chromium).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const outDir = path.resolve(root, arg('--out', 'docs/design/conquest/tank-hud/driver-view/captures'));
const SIZES = Object.freeze({
  desktop: { width: 1440, height: 900, mobile: false, touch: false },
  portrait: { width: 390, height: 844, mobile: true, touch: true },
  landscape: { width: 844, height: 390, mobile: true, touch: true },
});
const views = arg('--views', 'cockpit,driver').split(',').map(s => s.trim()).filter(Boolean);
const sizes = arg('--sizes', 'desktop,portrait,landscape').split(',').map(s => s.trim()).filter(s => SIZES[s]);
const aim = arg('--aim', '-0.6');

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'tank driver capture' });
  let browser = null;
  const report = { generated: new Date().toISOString(), shots: [], errors: [] };
  try {
    const port = await server.port;
    const base = `http://127.0.0.1:${port}/vehicle-capture.html`;
    browser = await launchCdpSession('about:blank', { width: 1440, height: 1037 });
    const page = browser.page;
    for (const sizeId of sizes) {
      const size = SIZES[sizeId];
      await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
      for (const view of views) {
        const params = new URLSearchParams({ type: 'tank', team: 'alpha', angle: 'hero', state: 'intact', seat: 'driver', view, hud: '1',
          aim, aimPitch: '0.02', speed: '6.4', rowSpeed: '6.4', crew: '1', ...(size.touch ? { touch: '1' } : {}) });
        await page.send('Page.navigate', { url: `${base}?${params}` });
        await new Promise(resolve => setTimeout(resolve, 300));
        await page.waitFor('document.documentElement.dataset.captureReady === "true"', { timeoutMs: 60000, label: `${sizeId} ${view}` });
        const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const file = path.join(outDir, `${sizeId}-${view}.png`);
        await writeFile(file, Buffer.from(shot.data, 'base64'));
        const kind = await page.evaluate('document.documentElement.dataset.reticleKind || ""');
        report.shots.push({ size: sizeId, view, kind, file: path.relative(root, file) });
        console.log(`${sizeId.padEnd(9)} ${view.padEnd(8)} ${kind}`);
      }
    }
    report.errors = [...page.errors];
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
  }
  if (report.errors.length) console.error(`Browser errors:\n  ${report.errors.join('\n  ')}`);
  process.exitCode = report.errors.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
