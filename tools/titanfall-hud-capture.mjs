#!/usr/bin/env node
/**
 * Muted CDP captures of the static Titanfall HUD fixture page
 * (public/titanfall-hud-capture.html; docs/titanfall.md §8.1, WP6): every HUD
 * fixture at desktop 1920x1080 and phone portrait 390x844 (touch controls on),
 * optionally phone landscape 844x390. The page renders the fixtures through the
 * real stock HUD, TitanHud, TitanLoadout (live WebGL portraits of the titan
 * models, one context) and TouchControls. No server match, no audio (Chromium
 * runs with --mute-audio and the page never creates an AudioContext).
 *
 * Backdrops (--backdrop live, the default): first one Chromium session on
 * WP5's vehicle-capture.html?type=titan_* renders, at each exact viewport,
 * the ION cockpit view (behind the titan layout) and a LEGION on an open
 * field (behind the pilot layout); that browser closes before the HUD page
 * opens (never two WebGL processes). --backdrop map uses the static map
 * still instead.
 *
 * Every size is checked for overlap between the fixed HUD panels, the stock
 * kill feed and career badge, the visible touch buttons and the movement
 * stick; an overlap or a page error fails the run (exit 1).
 * Holds .titan-capture.lock (one WebGL capture at a time) unless --no-lock.
 *
 *   node tools/titanfall-hud-capture.mjs [--out <dir>] [--only id,id] [--sizes desktop,portrait,landscape]
 *        [--backdrop live|map] [--no-lock]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const outDir = path.resolve(root, arg('--out', 'docs/design/titanfall/captures/hud'));
const only = arg('--only') ? new Set(arg('--only').split(',').map(s => s.trim()).filter(Boolean)) : null;
const LOCK = path.join(root, '.titan-capture.lock');

export const TITANFALL_CAPTURE_SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1920, height: 1080, mobile: false, touch: false }),
  portrait: Object.freeze({ width: 390, height: 844, mobile: true, touch: true }),
  landscape: Object.freeze({ width: 844, height: 390, mobile: true, touch: true }),
  // A narrow keyboard/mouse window (phone-sized, no touch): the desktop HUD at its smallest.
  narrow: Object.freeze({ width: 390, height: 844, mobile: false, touch: false }),
});
const sizes = arg('--sizes', 'desktop,portrait').split(',').map(s => s.trim()).filter(s => TITANFALL_CAPTURE_SIZES[s]);
const backdropMode = arg('--backdrop', 'live');
/** Backdrop scenes per HUD layout (window.titanCapture.render params). */
export const BACKDROP_SCENES = Object.freeze({
  titan: Object.freeze({ type: 'titan_ion', team: 'alpha', view: 'cockpit', pose: 'idle' }),
  pilot: Object.freeze({ type: 'titan_legion', team: 'bravo', view: 'range', pose: 'idle' }),
});

/** Render every size's backdrops in one muted Chromium session; resolves { size: { titan, pilot } } as PNG data URLs. */
async function renderBackdrops(port) {
  const out = {};
  const session = await launchCdpSession(`http://127.0.0.1:${port}/vehicle-capture.html?type=titan_ion&manual=1`, { width: 1920, height: 1080 });
  try {
    const page = session.page;
    await page.waitFor('window.titanCapture?.ready === true', { timeoutMs: 60000, label: 'titan capture page' });
    await page.evaluate("document.getElementById('label')?.style.setProperty('display', 'none')");
    for (const sizeId of sizes) {
      const size = TITANFALL_CAPTURE_SIZES[sizeId];
      await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
      out[sizeId] = {};
      for (const [layout, params] of Object.entries(BACKDROP_SCENES)) {
        await page.evaluate(`window.titanCapture.render(${JSON.stringify(params)})`);
        const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
        out[sizeId][layout] = `data:image/png;base64,${shot.data}`;
      }
    }
    if (page.errors.length) throw new Error(`backdrop page errors:\n  ${page.errors.join('\n  ')}`);
  } finally {
    await session.close();
  }
  return out;
}

/** Designed nestings: the stock touch weapon-swap chip lives inside the ammo card (as in Conquest). */
const INTENDED = new Set(['ammo × touch:weapon']);

/** Pairs of HUD boxes that intersect (touch buttons among themselves are touch-controls' own contract). */
export function overlaps(boxes) {
  const named = [];
  for (const [key, value] of Object.entries(boxes)) {
    if (key === 'buttons' || key === 'viewport' || !value) continue;
    named.push([key, value]);
  }
  for (const button of boxes.buttons || []) named.push([`touch:${button.action}`, button.box]);
  const hits = [];
  const intersect = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const [na, a] = named[i], [nb, b] = named[j];
      if (na.startsWith('touch:') && nb.startsWith('touch:')) continue;
      if (INTENDED.has(`${na} × ${nb}`) || INTENDED.has(`${nb} × ${na}`)) continue;
      if (intersect(a, b)) hits.push(`${na} × ${nb}`);
    }
  }
  const view = boxes.viewport;
  if (view) for (const [name, b] of named) {
    if (b.left < -0.5 || b.top < -0.5 || b.right > view.width + 0.5 || b.bottom > view.height + 0.5) hits.push(`${name} × viewport`);
  }
  return hits;
}

function acquireLock() {
  try {
    const owner = readFileSync(path.join(LOCK, 'owner'), 'utf8').trim().split(/\s+/);
    if (Date.now() / 1000 - Number(owner[1]) > 900) rmSync(LOCK, { recursive: true, force: true });
  } catch { /* no lock or no owner */ }
  try { mkdirSync(LOCK); } catch { throw new Error(`${path.relative(root, LOCK)} is held: another WebGL capture runs`); }
  writeFileSync(path.join(LOCK, 'owner'), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
  const release = () => rmSync(LOCK, { recursive: true, force: true });
  process.once('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { release(); process.exit(130); });
  return release;
}

async function main() {
  const release = process.argv.includes('--no-lock') ? () => {} : acquireLock();
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'titanfall HUD capture' });
  let browser = null;
  const report = { generated: new Date().toISOString(), page: 'public/titanfall-hud-capture.html', sizes: {}, overlaps: [], errors: [], warnings: [] };
  try {
    const port = await server.port;
    const backdrops = backdropMode === 'live' ? await renderBackdrops(port) : null;
    report.backdrop = backdrops ? { mode: 'live', scenes: BACKDROP_SCENES } : { mode: 'map', still: 'public/assets/maps/frontier.jpg' };
    browser = await launchCdpSession(`http://127.0.0.1:${port}/titanfall-hud-capture.html`, { width: 1920, height: 1080 });
    const page = browser.page;
    await page.waitFor('window.__tf?.ready === true', { label: 'capture page ready' });
    const ids = (await page.evaluate('window.__tf.ids')).filter(id => !only || only.has(id));
    for (const sizeId of sizes) {
      const size = TITANFALL_CAPTURE_SIZES[sizeId];
      await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
      await page.send('Emulation.setTouchEmulationEnabled', size.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      report.sizes[sizeId] = [];
      for (const id of ids) {
        const info = await page.evaluate(`window.__tf.render(${JSON.stringify(id)}, { touch: ${size.touch} })`);
        if (backdrops) {
          const url = backdrops[sizeId][info.layout === 'titan' ? 'titan' : 'pilot'];
          await page.evaluate(`window.__tf.setBackdrop(${JSON.stringify(url)})`);
        }
        const hits = overlaps(await page.evaluate('window.__tf.boxes()'));
        if (hits.length) report.overlaps.push({ size: sizeId, id, hits });
        const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const file = path.join(outDir, `${sizeId}-${id}.png`);
        await writeFile(file, Buffer.from(shot.data, 'base64'));
        report.sizes[sizeId].push({ id, title: info.title, layout: info.layout, portraits: info.portraits, file: path.relative(root, file), overlaps: hits });
        console.log(`${sizeId.padEnd(9)} ${id.padEnd(14)} ${info.layout.padEnd(6)} ${hits.length ? `OVERLAP ${hits.join(', ')}` : 'ok'}${info.portraits != null ? ` portraits ${info.portraits}` : ''}`);
      }
    }
    // WP4's new weapons have no HUD picture yet: the stock ammo card's 404 for them is reported, not fatal.
    const missingArt = /\/assets\/weapons\/hud\/(chargerifle|archer|thunderbolt|kraber)\.png/;
    report.warnings = page.errors.filter(error => missingArt.test(error));
    report.errors = page.errors.filter(error => !missingArt.test(error));
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
    release();
  }
  await writeFile(path.join(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) console.error(`Browser errors:\n  ${report.errors.join('\n  ')}`);
  if (report.warnings?.length) console.warn(`Warnings (foreign assets):\n  ${[...new Set(report.warnings)].join('\n  ')}`);
  if (report.overlaps.length) console.error(`HUD overlaps: ${report.overlaps.map(o => `${o.size}/${o.id}: ${o.hits.join(', ')}`).join('; ')}`);
  const failed = report.errors.length > 0 || report.overlaps.length > 0;
  console.log(`${failed ? 'FAILED' : 'Captured'} ${Object.values(report.sizes).reduce((n, list) => n + list.length, 0)} titanfall HUD states into ${path.relative(root, outDir)}`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
