#!/usr/bin/env node
/**
 * Muted CDP captures of the titanfall pilot weapons in first person with their on-gun displays
 * (public/js/guns/weapon-display.js; docs/titanfall.md §8 On-gun displays; references in
 * docs/design/titanfall/weapon-displays/) through public/titanfall-weapon-capture.html: the real
 * ViewmodelRig over a map still under the stock and titanfall pilot HUD. Chromium runs with
 * --mute-audio; the page creates no AudioContext. Holds one of the three .titan-capture.lock
 * slots unless --no-lock. A page error fails the run (exit 1).
 *
 *   node tools/titanfall-weapon-display-capture.mjs [--out <dir>] [--weapons rifle,kraber] [--sizes desktop,landscape,portrait]
 *        [--states full,low,reload,extra] [--fov 75] [--ads 0|1] [--no-display] [--png] [--no-lock]
 *
 * Shots are JPEG (quality 86, about a tenth of the PNG size) unless --png.
 *
 * The `extra` state expands to each weapon's own readouts: charge, charged and vent (CR-6), lock and locked
 * (ARCHER), cycle (KRABER bolt, THUNDERBOLT arc, M-DOCK pump), staged (M-DOCK tube reload), otherwise empty.
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
const outDir = path.resolve(root, arg('--out', 'docs/design/titanfall/weapon-displays/captures'));

export const WEAPON_CAPTURE_SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1920, height: 1080, mobile: false }),
  landscape: Object.freeze({ width: 844, height: 390, mobile: true }),
  portrait: Object.freeze({ width: 390, height: 844, mobile: true }),
});
export const PILOT_WEAPONS = Object.freeze(['rifle', 'smg', 'shotgun', 'lmg', 'kraber', 'revolver', 'chargerifle', 'archer', 'thunderbolt', 'mgl']);
const EXTRA = Object.freeze({ chargerifle: ['charge', 'charged', 'cycle'], archer: ['lock', 'locked'], kraber: ['cycle'], thunderbolt: ['cycle'],
  shotgun: ['cycle', 'staged'] });
const weapons = list('--weapons', PILOT_WEAPONS.join(','));
const sizes = list('--sizes', 'desktop,landscape,portrait').filter(s => WEAPON_CAPTURE_SIZES[s]);
const states = list('--states', 'full,low,reload,extra');
const fov = Number(arg('--fov', '75'));
const ads = Number(arg('--ads', '0'));
const display = !process.argv.includes('--no-display');
const png = process.argv.includes('--png');

function acquireSlot() {
  for (const suffix of ['', '2', '3']) {
    const dir = path.join(root, `.titan-capture.lock${suffix}`);
    try { mkdirSync(dir); } catch { continue; }
    const release = () => rmSync(dir, { recursive: true, force: true });
    process.once('exit', release);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { release(); process.exit(130); });
    return release;
  }
  throw new Error('all three .titan-capture.lock slots are held');
}

async function main() {
  const release = process.argv.includes('--no-lock') ? () => {} : acquireSlot();
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'titanfall weapon display capture' });
  const report = { generated: new Date().toISOString(), fov, ads, display, shots: [], errors: [] };
  try {
    const port = await server.port;
    const session = await launchCdpSession(`http://127.0.0.1:${port}/titanfall-weapon-capture.html`, { width: 1920, height: 1080 });
    try {
      const page = session.page;
      await page.waitFor('window.__tfw?.ready === true', { timeoutMs: 90000, label: 'titanfall weapon capture page' });
      for (const sizeId of sizes) {
        const size = WEAPON_CAPTURE_SIZES[sizeId];
        await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
        for (const weapon of weapons) for (const state of states.flatMap(id => (id === 'extra' ? EXTRA[weapon] ?? ['empty'] : [id]))) {
          const params = { weapon, state, fov, ads, touch: size.mobile, display };
          const result = await page.evaluate(`window.__tfw.render(${JSON.stringify(params)})`);
          const shot = await page.send('Page.captureScreenshot', { format: png ? 'png' : 'jpeg', ...(png ? {} : { quality: 86 }),
            clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
          const name = `${sizeId}-${weapon}-${state}${ads ? '-ads' : ''}${fov !== 75 ? `-fov${fov}` : ''}.${png ? 'png' : 'jpg'}`;
          await writeFile(path.join(outDir, name), Buffer.from(shot.data, 'base64'));
          report.shots.push({ size: sizeId, weapon, state, live: result?.live ?? null, file: path.relative(root, path.join(outDir, name)) });
          console.log(`${sizeId.padEnd(9)} ${weapon.padEnd(12)} ${state.padEnd(7)} live=${result?.live}`);
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
