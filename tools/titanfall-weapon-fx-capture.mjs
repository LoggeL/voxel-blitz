#!/usr/bin/env node
/**
 * Muted CDP captures of the titan primaries firing (docs/titanfall.md §5.4 "Feel", §7.3): each titan's
 * primary through the capture page's pose=fire (server-shaped shoot events through VehicleFx and
 * titan-presentation with the pilot as the viewer), one frame after the last shot so the muzzle flash
 * still shows, in the cockpit and the chase view, next to an idle reference of the same view. Chromium runs with --mute-audio; the page creates no AudioContext. Holds one
 * of the three .titan-capture.lock slots unless --no-lock. A page error fails the run (exit 1).
 *
 *   node tools/titanfall-weapon-fx-capture.mjs [--out <dir>] [--shots ion,ion-split,scorch,northstar,northstar-tap,ronin,legion]
 *        [--views cockpit,chase] [--sizes desktop,landscape] [--no-lock]
 */
import { mkdir, writeFile } from 'node:fs/promises';
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
const outDir = path.resolve(root, arg('--out', 'docs/design/titanfall/captures/weapons'));

const SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1920, height: 1080, mobile: false }),
  landscape: Object.freeze({ width: 844, height: 390, mobile: true }),
  portrait: Object.freeze({ width: 390, height: 844, mobile: true }),
});
/** Shots: the titan and the pose=fire parameters (a burst for the per-round guns, the moment after the last round). */
const SHOTS = Object.freeze({
  ion: { type: 'titan_ion', shots: 4 },
  'ion-split': { type: 'titan_ion', shots: 1, split: true },
  'ion-doom': { type: 'titan_ion', shots: 1, confirm: 'doom', after: 0.35 },
  'ion-kill': { type: 'titan_ion', shots: 1, confirm: 'kill', after: 0.35 },
  scorch: { type: 'titan_scorch', shots: 1 },
  northstar: { type: 'titan_northstar', shots: 1, charge: 1 },
  'northstar-tap': { type: 'titan_northstar', shots: 1, charge: 0.3 },
  'northstar-charge': { type: 'titan_northstar', pose: 'idle', row: { mounts: [[0, -0.1, -1, 0, 0, 50]] } },
  'northstar-ready': { type: 'titan_northstar', pose: 'idle', row: { mounts: [[0, -0.1, -1, 0, 0, 100]] } },
  ronin: { type: 'titan_ronin', shots: 1 },
  legion: { type: 'titan_legion', shots: 10 },
  'legion-spin': { type: 'titan_legion', pose: 'idle', row: { mounts: [[0, -0.1, 100, 0, 0, 50]] } },
  'legion-ready': { type: 'titan_legion', pose: 'idle', row: { mounts: [[0, -0.1, 100, 0, 0, 100]] } },
});
const shots = list('--shots', Object.keys(SHOTS).join(',')).filter(s => SHOTS[s]);
const views = list('--views', 'cockpit,chase').filter(v => v === 'cockpit' || v === 'chase');
const sizes = list('--sizes', 'desktop,landscape').filter(s => SIZES[s]);

async function acquireSlot() {
  for (;;) {
  for (const suffix of ['', '2', '3']) {
    const dir = path.join(root, `.titan-capture.lock${suffix}`);
    try { mkdirSync(dir); } catch { continue; }
    const release = () => rmSync(dir, { recursive: true, force: true });
    process.once('exit', release);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { release(); process.exit(130); });
    return release;
  }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

async function main() {
  const release = process.argv.includes('--no-lock') ? () => {} : await acquireSlot();
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'titan weapon fx capture' });
  const report = { generated: new Date().toISOString(), shots: [], errors: [] };
  try {
    const port = await server.port;
    const session = await launchCdpSession(`http://127.0.0.1:${port}/vehicle-capture.html?type=titan_ion&manual=1`, { width: 1920, height: 1080 });
    try {
      const page = session.page;
      await page.waitFor('window.titanCapture?.ready === true', { timeoutMs: 60000, label: 'titan capture page' });
      await page.evaluate("document.getElementById('label')?.style.setProperty('display', 'none')");
      // Warm-up: link the cockpit and particle programs once.
      await page.evaluate(`window.titanCapture.render(${JSON.stringify({ type: 'titan_ion', team: 'alpha', view: 'cockpit', fov: 75, pose: 'fire', shots: 2, aimPitch: -0.1 })})`);
      for (const sizeId of sizes) {
        const size = SIZES[sizeId];
        await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
        for (const viewId of views) for (const shotId of shots) {
          const shot = SHOTS[shotId];
          for (const pose of shot.pose ? [shot.pose] : shotId.includes('-') ? ['fire'] : ['idle', 'fire']) {
            const params = { type: shot.type, team: 'alpha', view: viewId, fov: 75, pose, aimPitch: -0.1, core: 0.46,
              ...(shot.row ? { row: shot.row } : {}),
              ...(pose === 'fire' ? { shots: shot.shots, charge: shot.charge ?? 1, split: !!shot.split, confirm: shot.confirm ?? null, after: shot.after ?? 1 / 60 } : {}) };
            const stats = await page.evaluate(`window.titanCapture.render(${JSON.stringify(params)})`);
            const image = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
            const name = `${sizeId}-${viewId}-${shotId}-${pose}.png`;
            await writeFile(path.join(outDir, name), Buffer.from(image.data, 'base64'));
            report.shots.push({ size: sizeId, view: viewId, shot: shotId, pose, params, particles: stats?.particles ?? null,
              file: path.relative(root, path.join(outDir, name)) });
            console.log(`${sizeId.padEnd(9)} ${viewId.padEnd(7)} ${shotId.padEnd(13)} ${pose}`);
          }
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
  await writeFile(path.join(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) { console.error(report.errors.join('\n')); process.exit(1); }
  console.log(`${report.shots.length} shots -> ${path.relative(root, outDir)}`);
}

main().catch(error => { console.error(error); process.exit(1); });
