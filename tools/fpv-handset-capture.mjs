#!/usr/bin/env node
/**
 * Muted CDP captures of the FPV drone's launch and link-loss frames
 * (docs/design/conquest/fpv-handset/): the handset raise and lowering through
 * public/fpv-handset-capture.html (the real ViewmodelRig over a map still),
 * and the boot static, the live feed and SIGNAL LOST through the Conquest HUD
 * fixture page (`fpv` fixture, `boot` / `lost`). Chromium runs with
 * --mute-audio; neither page creates an AudioContext. A page error fails the
 * run (exit 1). Not part of any suite (it needs a local Chromium).
 *
 *   node tools/fpv-handset-capture.mjs [--out <dir>] [--sizes desktop,portrait]
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
const outDir = path.resolve(root, arg('--out', 'docs/design/conquest/fpv-handset/captures'));
const SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900, mobile: false, touch: false }),
  portrait: Object.freeze({ width: 390, height: 844, mobile: true, touch: true }),
});
const sizes = arg('--sizes', 'desktop').split(',').filter(s => SIZES[s]);
/** The sequence in order: handset frames (rig page) and feed frames (HUD page). */
const HANDSET = [['1-raise-150ms', 'raise', 150], ['2-raise-330ms', 'raise', 330], ['3-raise-440ms', 'raise', 440],
  ['7-lower-80ms', 'lower', 80], ['8-lower-240ms', 'lower', 240], ['9-redraw-200ms', 'idle', 200]];
const FEED = [['4-boot-static', { boot: 0.85 }], ['5-boot-resolving', { boot: 0.35 }], ['5b-feed', {}], ['6-signal-lost', { lost: true }]];

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', env: { PORT: process.env.PORT || '4941' }, failureContext: 'fpv handset capture' });
  const report = { generated: new Date().toISOString(), shots: [], errors: [] };
  try {
    const port = await server.port;
    const shoot = async (page, size, name) => {
      const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
      const file = path.join(outDir, `${name}.jpg`);
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      return path.relative(root, file);
    };
    const size0 = SIZES[sizes[0]];
    for (const [pageName, ready] of [['fpv-handset-capture.html', 'window.__handset?.ready === true'], ['conquest-hud-capture.html', 'window.__cq?.ready === true']]) {
      const session = await launchCdpSession(`http://127.0.0.1:${port}/${pageName}`, { width: size0.width, height: size0.height });
      try {
        const page = session.page;
        await page.waitFor(ready, { timeoutMs: 120000, label: pageName });
        for (const sizeId of sizes) {
          const size = SIZES[sizeId];
          await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
          await page.send('Emulation.setTouchEmulationEnabled', size.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
          if (pageName.startsWith('fpv')) {
            for (const [name, phase, ms] of HANDSET) {
              const info = await page.evaluate(`window.__handset.render(${JSON.stringify({ phase, ms })})`);
              report.shots.push({ size: sizeId, name, file: await shoot(page, size, `${sizeId}-${name}`), ...info });
              console.log(`${sizeId} ${name} handset ${info.handset?.toFixed?.(2)} ${info.phase}`);
            }
          } else {
            for (const [name, options] of FEED) {
              await page.evaluate(`window.__cq.render('fpv', ${JSON.stringify({ touch: size.touch, ...options })})`);
              report.shots.push({ size: sizeId, name, file: await shoot(page, size, `${sizeId}-${name}`) });
              console.log(`${sizeId} ${name}`);
            }
          }
        }
        report.errors.push(...(page.errors ?? []));
      } finally { await session.close(); }
    }
    // Third person: an operator flying his drone holds the handset (avatar-handset.js).
    for (const view of ['front', 'crouched-profile']) {
      const session = await launchCdpSession(`http://127.0.0.1:${port}/avatar-capture.html?weapon=rifle&view=${view}&fpv=1`, { width: 960, height: 720 });
      try {
        const page = session.page;
        await page.waitFor(`document.documentElement.dataset.captureReady === 'true'`, { timeoutMs: 120000, label: `avatar ${view}` });
        report.shots.push({ size: 'avatar', name: view, file: await shoot(page, { width: 960, height: 720 }, `third-person-${view}`) });
        console.log(`third person ${view}`);
        report.errors.push(...(page.errors ?? []));
      } finally { await session.close(); }
    }
  } catch (error) {
    report.errors.push(String(error?.stack ?? error));
  } finally {
    await stopServer(server);
  }
  await writeFile(path.join(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) { console.error(report.errors.join('\n')); process.exit(1); }
  console.log(`${report.shots.length} shots -> ${path.relative(root, outDir)}`);
}

main().catch(error => { console.error(error); process.exit(1); });
