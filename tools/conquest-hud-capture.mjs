#!/usr/bin/env node
/**
 * Muted CDP captures of the static Conquest HUD fixture page
 * (public/conquest-hud-capture.html): every HUD state at desktop 1440x900
 * (browser window 1440x1037, viewport pinned by device-metrics override),
 * phone portrait 390x844 and phone landscape 844x390 with touch controls.
 *
 * The page renders snapshot-shaped fixtures through the real ConquestHud,
 * HUD (kill feed, scoreboard, result) and TouchControls. No live match, no
 * game server, no audio (the browser runs with --mute-audio and the page
 * never creates an AudioContext).
 *
 * Every size is checked for overlap between the fixed HUD panels (top bar,
 * banner, capture ring, ticker, minimap, vehicle card, interact prompt, lock
 * and restricted warnings, HP / ammo / grenade cards, kill feed), the
 * edge-clamped flag markers and every visible touch button; any overlap fails
 * the run (exit 1).
 *
 *   node tools/conquest-hud-capture.mjs [--out <dir>] [--only id,id] [--sizes desktop,portrait,landscape]
 *
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
const outDir = path.resolve(root, arg('--out', 'docs/design/conquest/redesign/hud/captures'));
const only = arg('--only') ? new Set(arg('--only').split(',').map(s => s.trim()).filter(Boolean)) : null;

export const CAPTURE_SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900, mobile: false, touch: false }),
  portrait: Object.freeze({ width: 390, height: 844, mobile: true, touch: true }),
  landscape: Object.freeze({ width: 844, height: 390, mobile: true, touch: true }),
});
const sizes = (arg('--sizes', 'desktop,portrait,landscape')).split(',').map(s => s.trim()).filter(s => CAPTURE_SIZES[s]);

/** #hud panels the held scoreboard and the result screen intentionally cover (they sit above them in #hud). */
const COVERED_BY_OVERLAY = new Set(['healthbar', 'ammo', 'grenades', 'killfeed', 'reload-hint']);
const OVERLAYS = new Set(['scoreboard', 'result']);
/** Designed nestings: the touch weapon-swap chip lives inside the ammo card's reserved right edge. */
const INTENDED = new Set(['ammo × touch:weapon']);

/**
 * Pairs of HUD boxes that must never intersect: every named panel, each
 * edge-clamped flag marker (with its distance label) and every touch button.
 * Touch buttons among themselves are touch-controls' own contract; the board
 * and result screen may cover the #hud cards below them. Edge markers must
 * also stay fully on screen when the viewport is known.
 */
export function overlaps(boxes) {
  const named = [];
  for (const [key, value] of Object.entries(boxes)) {
    if (key === 'buttons' || key === 'flags' || key === 'viewport' || !value) continue;
    named.push([key, value]);
  }
  for (const flag of boxes.flags || []) named.push([`flag:${flag.id}`, flag.box]);
  for (const button of boxes.buttons || []) named.push([`touch:${button.action}`, button.box]);
  const hits = [];
  const intersect = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const [na, a] = named[i], [nb, b] = named[j];
      if (na.startsWith('touch:') && nb.startsWith('touch:')) continue;
      if ((OVERLAYS.has(na) && COVERED_BY_OVERLAY.has(nb)) || (OVERLAYS.has(nb) && COVERED_BY_OVERLAY.has(na))) continue;
      if (INTENDED.has(`${na} × ${nb}`) || INTENDED.has(`${nb} × ${na}`)) continue;
      if (intersect(a, b)) hits.push(`${na} × ${nb}`);
    }
  }
  const view = boxes.viewport;
  if (view) {
    for (const flag of boxes.flags || []) {
      const b = flag.box;
      if (b.left < -0.5 || b.top < -0.5 || b.right > view.width + 0.5 || b.bottom > view.height + 0.5) hits.push(`flag:${flag.id} × viewport`);
    }
  }
  return hits;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'conquest HUD capture' });
  let browser = null;
  const report = { generated: new Date().toISOString(), page: 'public/conquest-hud-capture.html', sizes: {}, overlaps: [], errors: [] };
  try {
    const port = await server.port;
    const url = `http://127.0.0.1:${port}/conquest-hud-capture.html`;
    browser = await launchCdpSession(url, { width: 1440, height: 1037 });
    const page = browser.page;
    await page.waitFor('window.__cq?.ready === true', { label: 'capture page ready' });
    const ids = (await page.evaluate('window.__cq.ids')).filter(id => !only || only.has(id));
    for (const sizeId of sizes) {
      const size = CAPTURE_SIZES[sizeId];
      await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
      // CDP rejects maxTouchPoints 0: only pass it when enabling touch.
      await page.send('Emulation.setTouchEmulationEnabled', size.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      report.sizes[sizeId] = [];
      for (const id of ids) {
        const info = await page.evaluate(`window.__cq.render(${JSON.stringify(id)}, { touch: ${size.touch} })`);
        const boxes = await page.evaluate('window.__cq.boxes()');
        const hits = overlaps(boxes);
        if (hits.length) report.overlaps.push({ size: sizeId, id, hits });
        const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const file = path.join(outDir, `${sizeId}-${id}.png`);
        await writeFile(file, Buffer.from(shot.data, 'base64'));
        report.sizes[sizeId].push({ id, title: info.title, file: path.relative(root, file), seated: info.seated, overlaps: hits });
        console.log(`${sizeId.padEnd(9)} ${id.padEnd(16)} ${hits.length ? `OVERLAP ${hits.join(', ')}` : 'ok'}`);
      }
    }
    report.errors = [...page.errors];
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
  }
  await writeFile(path.join(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) console.error(`Browser errors:\n  ${report.errors.join('\n  ')}`);
  if (report.overlaps.length) console.error(`HUD overlaps: ${report.overlaps.map(o => `${o.size}/${o.id}: ${o.hits.join(', ')}`).join('; ')}`);
  const failed = report.errors.length > 0 || report.overlaps.length > 0;
  console.log(`${failed ? 'FAILED' : 'Captured'} ${Object.values(report.sizes).reduce((n, list) => n + list.length, 0)} Conquest HUD states into ${path.relative(root, outDir)}`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
