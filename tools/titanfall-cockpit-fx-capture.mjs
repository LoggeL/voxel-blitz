#!/usr/bin/env node
/**
 * Muted CDP captures of the titan cockpit damage and transit dressing (public/js/titanfall/titan-cockpit-fx.js;
 * docs/titanfall.md §7.2; references docs/design/titanfall/cockpit/damage/ and docs/design/titanfall/transit/)
 * through the titan capture page's cockpit view: hull stages and the embark boot / exit beats (held with
 * titan-transit.js pinTransit). Chromium runs with --mute-audio; the page creates no AudioContext. Holds one
 * of the three .titan-capture.lock slots unless --no-lock. A page error fails the run (exit 1).
 *
 *   node tools/titanfall-cockpit-fx-capture.mjs [--out <dir>] [--titans ion,legion,northstar] [--sizes desktop,landscape,portrait]
 *        [--states hull75,hull55,hull35,hull15,doom,boot-dark,boot-open,boot-glass,exit] [--no-lock]
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
const outDir = path.resolve(root, arg('--out', 'docs/design/titanfall/cockpit/damage/captures'));

export const FX_CAPTURE_SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1920, height: 1080, mobile: false }),
  landscape: Object.freeze({ width: 844, height: 390, mobile: true }),
  portrait: Object.freeze({ width: 390, height: 844, mobile: true }),
});
/** States: capture page params (hp, pose) and an optional held transit. */
export const FX_STATES = Object.freeze({
  hull75: { hp: 0.75 }, hull55: { hp: 0.55 }, hull35: { hp: 0.35 }, hull15: { hp: 0.15 }, doom: { pose: 'doom' },
  'boot-dark': { transit: { mode: 'embark', t: 0.97 } },
  'boot-open': { transit: { mode: 'embark', t: 1.2 } },
  'boot-glass': { transit: { mode: 'embark', t: 1.42 } },
  exit: { transit: { mode: 'exit', t: 0.1 } },
});
const titans = list('--titans', 'ion,legion,northstar').map(t => (t.startsWith('titan_') ? t : `titan_${t}`));
const sizes = list('--sizes', 'desktop,landscape,portrait').filter(s => FX_CAPTURE_SIZES[s]);
const states = list('--states', Object.keys(FX_STATES).join(',')).filter(s => FX_STATES[s]);

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
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'titan cockpit fx capture' });
  const report = { generated: new Date().toISOString(), shots: [], errors: [] };
  try {
    const port = await server.port;
    const session = await launchCdpSession(`http://127.0.0.1:${port}/vehicle-capture.html?type=titan_ion&manual=1`, { width: 1920, height: 1080 });
    try {
      const page = session.page;
      await page.waitFor('window.titanCapture?.ready === true', { timeoutMs: 60000, label: 'titan capture page' });
      await page.evaluate("document.getElementById('label')?.style.setProperty('display', 'none')");
      // Warm-up: link every cockpit program once (SwiftShader compiles can eat the settle time of the first shot).
      await page.evaluate(`window.titanCapture.render(${JSON.stringify({ type: titans[0], team: 'alpha', view: 'cockpit', fov: 75, pose: 'idle', hp: 0.1, settle: 1.5 })})`);
      for (const sizeId of sizes) {
        const size = FX_CAPTURE_SIZES[sizeId];
        await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
        for (const type of titans) for (const stateId of states) {
          const state = FX_STATES[stateId];
          const team = 'alpha';
          await page.evaluate(`import('/js/titanfall/titan-transit.js').then(m => m.pinTransit(${JSON.stringify(state.transit ? `titan-${team}` : null)}, ${JSON.stringify(state.transit ?? null)}))`);
          const params = { type, team, view: 'cockpit', fov: 75, pose: state.pose ?? 'idle', core: 0.46, hp: state.hp ?? 1, settle: 0.8 };
          await page.evaluate(`window.titanCapture.render(${JSON.stringify(params)})`);
          const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
          const name = `${sizeId}-${type.slice(6)}-${stateId}.png`;
          await writeFile(path.join(outDir, name), Buffer.from(shot.data, 'base64'));
          report.shots.push({ size: sizeId, type, state: stateId, file: path.relative(root, path.join(outDir, name)) });
          console.log(`${sizeId.padEnd(9)} ${type.padEnd(15)} ${stateId}`);
        }
      }
      await page.evaluate("import('/js/titanfall/titan-transit.js').then(m => m.pinTransit(null))");
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
