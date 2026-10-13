#!/usr/bin/env node
/**
 * Muted CDP captures of the pilot wrist display (public/js/titanfall/pilot-wrist.js; docs/titanfall.md §8.7
 * "Wrist display"; references docs/design/titanfall/wrist/) through public/titanfall-wrist-capture.html:
 * the first-person viewmodel with the wrist device in every tactical state, over an Ashfall still, with
 * the stock HUD and TitanHud on top. Chromium runs with --mute-audio and the page creates no AudioContext.
 * Holds one of the three .titan-capture.lock slots (waits up to --wait seconds for a free one) unless
 * --no-lock. A page error fails the run (exit 1).
 *
 *   node tools/titanfall-wrist-capture.mjs [--out <dir>] [--states grapple-2,grapple-1,...] [--weapons rifle,smg,...]
 *        [--sizes desktop,portrait,landscape] [--fovs 75] [--ads 0,1] [--no-wrist] [--gun] [--backdrop <jpg>] [--crop] [--wait 600] [--no-lock]
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const list = (name, fallback) => arg(name, fallback).split(',').map(s => s.trim()).filter(Boolean);
const outDir = path.resolve(root, arg('--out', 'docs/design/titanfall/wrist/captures'));

export const WRIST_CAPTURE_SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1920, height: 1080, mobile: false, touch: false }),
  portrait: Object.freeze({ width: 390, height: 844, mobile: true, touch: true }),
  landscape: Object.freeze({ width: 844, height: 390, mobile: true, touch: true }),
});
const DEFAULT_STATES = 'grapple-2,grapple-1,grapple-0,grapple-reel,grapple-range,stim-active,cloak-cooldown';
const states = list('--states', DEFAULT_STATES);
const weapons = list('--weapons', 'rifle');
const sizes = list('--sizes', 'desktop,portrait,landscape').filter(s => WRIST_CAPTURE_SIZES[s]);
const fovs = list('--fovs', '75').map(Number).filter(Number.isFinite);
const adsList = list('--ads', '0').map(Number).filter(Number.isFinite);
const wristOn = !process.argv.includes('--no-wrist');
const crop = process.argv.includes('--crop');
// --gun: the on-gun counter (weapon-display.js) lives beside the wrist, as in a match (the integration shots).
const gunOn = process.argv.includes('--gun');
const backdrop = path.resolve(root, arg('--backdrop', 'docs/design/titanfall/map/captures/desktop-hab-alley.jpg'));
const waitSeconds = Number(arg('--wait', '600'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquireSlot() {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    for (const suffix of ['', '2', '3']) {
      const dir = path.join(root, `.titan-capture.lock${suffix}`);
      try { mkdirSync(dir); } catch { continue; }
      const release = () => rmSync(dir, { recursive: true, force: true });
      process.once('exit', release);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { release(); process.exit(130); });
      return release;
    }
    if (Date.now() > deadline) throw new Error('all three .titan-capture.lock slots are held');
    await sleep(5000);
  }
}

async function main() {
  const release = process.argv.includes('--no-lock') ? () => {} : await acquireSlot();
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'titanfall wrist capture' });
  const report = { generated: new Date().toISOString(), page: 'public/titanfall-wrist-capture.html', wrist: wristOn, shots: [], errors: [] };
  try {
    const port = await server.port;
    const session = await launchCdpSession(`http://127.0.0.1:${port}/titanfall-wrist-capture.html`, { width: 1920, height: 1080 });
    try {
      const page = session.page;
      await page.waitFor('window.__wrist?.ready === true', { timeoutMs: 120000, label: 'wrist capture page' });
      const still = await readFile(backdrop).catch(() => null);
      if (still) await page.evaluate(`window.__wrist.setBackdrop(${JSON.stringify(`data:image/jpeg;base64,${still.toString('base64')}`)})`);
      for (const sizeId of sizes) {
        const size = WRIST_CAPTURE_SIZES[sizeId];
        await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
        await page.send('Emulation.setTouchEmulationEnabled', size.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        for (const weapon of weapons) for (const fov of fovs) for (const ads of adsList) for (const state of states) {
          const params = { state, weapon, fov, ads, wrist: wristOn, touch: size.touch, gun: gunOn };
          const info = await page.evaluate(`window.__wrist.render(${JSON.stringify(params)})`);
          const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
          const tag = `${sizeId}-${weapon}${fovs.length > 1 || fov !== 75 ? `-fov${fov}` : ''}${ads ? '-ads' : ''}-${wristOn ? state : `baseline-${state}`}`;
          await writeFile(path.join(outDir, `${tag}.png`), Buffer.from(shot.data, 'base64'));
          const entry = { size: sizeId, weapon, fov, ads, state, file: path.relative(root, path.join(outDir, `${tag}.png`)), live: info.live, gunLive: info.gunLive, draws: info.draws, wrist: info.wrist };
          if (crop && wristOn) {
            const box = await page.evaluate('window.__wrist.wristBox()');
            if (box) {
              const pad = Math.round(Math.max(box.width, box.height) * 0.35);
              const clip = { x: Math.max(0, box.left - pad), y: Math.max(0, box.top - pad), scale: 1 };
              clip.width = Math.min(size.width - clip.x, box.width + pad * 2);
              clip.height = Math.min(size.height - clip.y, box.height + pad * 2);
              const zoom = await page.send('Page.captureScreenshot', { format: 'png', clip });
              await writeFile(path.join(outDir, `${tag}-crop.png`), Buffer.from(zoom.data, 'base64'));
              entry.box = box;
            }
          }
          report.shots.push(entry);
          console.log(`${sizeId.padEnd(9)} ${weapon.padEnd(11)} fov ${String(fov).padEnd(3)} ads ${ads} ${state.padEnd(15)} live ${info.live}${gunOn ? ` gun ${info.gunLive}` : ''} draws ${info.draws}`);
        }
      }
      report.errors.push(...(page.errors ?? []));
    } finally { await session.close(); }
  } catch (error) {
    report.errors.push(String(error?.stack ?? error));
  } finally {
    await stopServer(server);
    release();
  }
  await writeFile(path.join(outDir, wristOn ? 'capture-report.json' : 'baseline-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) { console.error(report.errors.join('\n')); process.exit(1); }
  console.log(`${report.shots.length} shots -> ${path.relative(root, outDir)}`);
}

main().catch(error => { console.error(error); process.exit(1); });
