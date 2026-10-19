#!/usr/bin/env node
/**
 * Muted CDP captures of the patrol boat through the static vehicle capture
 * page (public/vehicle-capture.html: real VehicleView, VehicleFx, VehicleCamera
 * and the live reticle code with ?hud=1) at desktop 1440x900, phone portrait
 * 390x844 and phone landscape 844x390: the boat under way (wake and bow spray),
 * the driver's chase and helm views and the bow gunner's sight. No live
 * match, no game server, no audio (Chromium runs with --mute-audio).
 *
 *   node tools/conquest-boat-capture.mjs [--out <dir>] [--sizes desktop,portrait,landscape] [--shots wake,chase,helm,gunner]
 *
 * Compare against docs/design/conquest/boat/variant-a-riverine-reference.jpg.
 * Not part of conquest:test (it needs a local Chromium).
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
const outDir = path.resolve(root, arg('--out', 'docs/design/conquest/boat/captures'));
const SIZES = Object.freeze({
  desktop: { width: 1440, height: 900, mobile: false, touch: false },
  portrait: { width: 390, height: 844, mobile: true, touch: true },
  landscape: { width: 844, height: 390, mobile: true, touch: true },
});
/** Shot parameters for vehicle-capture.html (16 m/s: on the plane, wake and spray running). */
const SHOTS = Object.freeze({
  wake: { angle: 'hero', speed: '16', rowSpeed: '16', crew: '1' },
  chase: { seat: 'driver', view: 'chase', hud: '1', speed: '16', rowSpeed: '16', crew: '1', aim: '0.3' },
  helm: { seat: 'driver', view: 'cockpit', hud: '1', speed: '9', rowSpeed: '9', crew: '1' },
  gunner: { seat: 'gunner', view: 'cockpit', hud: '1', crew: '1', aim: '0.4', aimPitch: '0.03' },
});
const sizes = arg('--sizes', 'desktop,portrait,landscape').split(',').map(s => s.trim()).filter(s => SIZES[s]);
const shots = arg('--shots', Object.keys(SHOTS).join(',')).split(',').map(s => s.trim()).filter(s => SHOTS[s]);

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'boat capture' });
  let browser = null;
  const errors = [];
  try {
    const port = await server.port;
    const base = `http://127.0.0.1:${port}/vehicle-capture.html`;
    browser = await launchCdpSession('about:blank', { width: 1440, height: 1037 });
    const page = browser.page;
    for (const sizeId of sizes) {
      const size = SIZES[sizeId];
      await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
      for (const shot of shots) {
        const params = new URLSearchParams({ type: 'boat', team: 'alpha', angle: 'hero', state: 'intact', ...SHOTS[shot], ...(size.touch ? { touch: '1' } : {}) });
        await page.send('Page.navigate', { url: `${base}?${params}` });
        await new Promise(resolve => setTimeout(resolve, 300));
        await page.waitFor('document.documentElement.dataset.captureReady === "true"', { timeoutMs: 60000, label: `${sizeId} ${shot}` });
        const image = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const file = path.join(outDir, `${sizeId}-${shot}.png`);
        await writeFile(file, Buffer.from(image.data, 'base64'));
        const kind = await page.evaluate('document.documentElement.dataset.reticleKind || ""');
        console.log(`${sizeId.padEnd(9)} ${shot.padEnd(7)} ${kind} -> ${path.relative(root, file)}`);
      }
    }
    errors.push(...page.errors);
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
  }
  if (errors.length) console.error(`Browser errors:\n  ${errors.join('\n  ')}`);
  process.exitCode = errors.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
