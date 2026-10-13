#!/usr/bin/env node
/**
 * Muted CDP captures of the titan cockpits (public/js/titanfall/titan-cockpit.js; docs/titanfall.md
 * §7.2, notes docs/design/titanfall/cockpit/notes.md): every titan × size × settings FOV × state
 * through the titan capture page's cockpit view (vehicle-capture.html?type=titan_*, the real
 * VehicleView, VehicleCamera and cockpit), then the stock titan HUD fixture page
 * (titanfall-hud-capture.html) over a cockpit backdrop at each size. The two pages run one after
 * the other (never two WebGL processes). Chromium runs with --mute-audio; neither page creates an
 * AudioContext.
 *
 * Also checks that no cockpit MFD (projected through the cockpit's own frustum, the same at every
 * FOV) overlaps a fixed DOM HUD panel of the titan layout at that size; an overlap or a page error
 * fails the run (exit 1). Holds one of the three .titan-capture.lock slots unless --no-lock.
 *
 *   node tools/titanfall-cockpit-capture.mjs [--out <dir>] [--titans ion,scorch,...] [--sizes desktop,ultrawide,portrait,landscape]
 *        [--fovs 65,100] [--states idle,doom,core] [--hud ion] [--no-hud] [--no-lock]
 *
 * --diegetic: the diegetic cockpit HUD (titan-cockpit-hud.js). Each shot stages a HUD state
 * (public/js/capture/titan-cockpit-hud-capture.js: idle, firing, doom, core, cooldown, rodeo, feed) whose
 * titan row the capture page renders, so console MFDs, pods, brow display and glass show one state; the
 * composites then show the live page's DOM over it in cockpit view (body[data-titanfall-cockpit]: only the
 * touch buttons remain). Default out docs/design/titanfall/cockpit/diegetic/captures, sizes include small (1280×720).
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
const diegetic = process.argv.includes('--diegetic');
const outDir = path.resolve(root, arg('--out', diegetic ? 'docs/design/titanfall/cockpit/diegetic/captures' : 'docs/design/titanfall/cockpit/captures'));
/** Diegetic HUD states (titan-cockpit-hud-capture.js COCKPIT_HUD_STATES). */
const DIEGETIC_STATES = Object.freeze(['idle', 'firing', 'doom', 'core', 'cooldown', 'rodeo', 'feed']);

export const COCKPIT_CAPTURE_SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1920, height: 1080, mobile: false, touch: false }),
  small: Object.freeze({ width: 1280, height: 720, mobile: false, touch: false }),
  ultrawide: Object.freeze({ width: 2560, height: 1080, mobile: false, touch: false }),
  portrait: Object.freeze({ width: 390, height: 844, mobile: true, touch: true }),
  landscape: Object.freeze({ width: 844, height: 390, mobile: true, touch: true }),
});
/** Capture states: titan capture page params. */
export const COCKPIT_STATES = Object.freeze({
  idle: Object.freeze({ pose: 'idle', core: 0.46 }),
  doom: Object.freeze({ pose: 'doom', core: 0.3 }),
  core: Object.freeze({ pose: 'idle', core: 1 }),
  hurt: Object.freeze({ pose: 'idle', core: 0.2, hp: 0.3, lock: 3 }),
});
const titans = list('--titans', 'ion,scorch,northstar,ronin,legion').map(t => (t.startsWith('titan_') ? t : `titan_${t}`));
const sizes = list('--sizes', diegetic ? 'desktop,ultrawide,small,portrait,landscape' : 'desktop,ultrawide,portrait,landscape').filter(s => COCKPIT_CAPTURE_SIZES[s]);
const fovs = list('--fovs', '65,100').map(Number).filter(Number.isFinite);
const states = diegetic ? list('--states', DIEGETIC_STATES.join(',')).filter(s => DIEGETIC_STATES.includes(s))
  : list('--states', 'idle,doom,core').filter(s => COCKPIT_STATES[s]);
const hudTitans = process.argv.includes('--no-hud') ? [] : list('--hud', 'ion').map(t => (t.startsWith('titan_') ? t : `titan_${t}`));

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

/** Projected MFD rects (px) of a titan cockpit at a viewport size (FOV independent: the cockpit's own frustum). */
async function screenRects(type, width, height) {
  const { titanCockpitCabin, cockpitFrustum, TITAN_COCKPIT } = await import('../public/js/titanfall/titan-cockpit.js');
  if (width / height < TITAN_COCKPIT.screensMinAspect) return [];   // the MFDs are dark on phone portrait
  const cabin = titanCockpitCabin(type);
  try {
    const { tanH, tanV } = cockpitFrustum(width / height);
    const pos = cabin.geometries.screens.attributes.position, rects = [];
    for (let quad = 0; quad < pos.count / 6; quad++) {
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      for (let k = 0; k < 6; k++) {
        const i = quad * 6 + k, z = -pos.getZ(i);
        const x = (pos.getX(i) / z / tanH + 1) / 2 * width, y = (1 - pos.getY(i) / z / tanV) / 2 * height;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      if (right > 0 && left < width && bottom > 0 && top < height) rects.push({ left, right, top, bottom });
    }
    return rects;
  } finally { cabin.release(); }
}

const intersect = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

async function main() {
  const release = process.argv.includes('--no-lock') ? () => {} : acquireSlot();
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'titan cockpit capture' });
  const report = { generated: new Date().toISOString(), shots: [], hud: [], overlaps: [], errors: [] };
  const backdrops = {};
  try {
    const port = await server.port;
    // 1. Cockpit shots (one WebGL session).
    {
      const session = await launchCdpSession(`http://127.0.0.1:${port}/vehicle-capture.html?type=titan_ion&manual=1`, { width: 1920, height: 1080 });
      try {
        const page = session.page;
        await page.waitFor('window.titanCapture?.ready === true', { timeoutMs: 60000, label: 'titan capture page' });
        await page.evaluate("document.getElementById('label')?.style.setProperty('display', 'none')");
        for (const sizeId of sizes) {
          const size = COCKPIT_CAPTURE_SIZES[sizeId];
          await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
          for (const type of titans) for (const stateId of states) for (const fov of fovs) {
            let params = { type, team: 'alpha', view: 'cockpit', fov, ...COCKPIT_STATES[stateId] };
            if (diegetic) {
              // Stage the HUD state (model, stock pieces) in the page; the capture renders its titan row.
              const staged = await page.evaluate(`import('/js/capture/titan-cockpit-hud-capture.js').then(m => {
                const s = m.stage(${JSON.stringify(stateId)}, ${JSON.stringify(type)}, { touch: ${size.touch} });
                return { pose: s.pose, core: s.core, hp: s.hp, lock: s.lock, row: s.row, titan: s.model.titan, top: s.model.top, rider: s.model.rider };
              })`);
              params = { type, team: 'alpha', view: 'cockpit', fov, pose: staged.pose, core: staged.core, hp: staged.hp, lock: staged.lock, row: staged.row };
              report.models ??= {};
              report.models[`${type}:${stateId}:${size.touch ? 'touch' : 'keys'}`] ??= { titan: staged.titan, top: staged.top, rider: staged.rider };
            }
            await page.evaluate(`window.titanCapture.render(${JSON.stringify(params)})`);
            const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
            const name = `${sizeId}-${type.slice(6)}-${stateId}-fov${fov}.png`;
            await writeFile(path.join(outDir, name), Buffer.from(shot.data, 'base64'));
            report.shots.push({ size: sizeId, type, state: stateId, fov, file: path.relative(root, path.join(outDir, name)) });
            if (hudTitans.includes(type) && (diegetic ? fov === fovs[0] : (stateId === 'idle' || stateId === 'doom') && fov === 75)) {
              backdrops[`${sizeId}:${type}:${stateId}`] = `data:image/png;base64,${shot.data}`;
            }
            console.log(`${sizeId.padEnd(9)} ${type.padEnd(15)} ${stateId.padEnd(5)} fov ${fov}`);
          }
          // HUD backdrops at the default FOV (75).
          if (!diegetic) for (const type of hudTitans) for (const stateId of ['idle', 'doom']) {
            const key = `${sizeId}:${type}:${stateId}`;
            if (backdrops[key]) continue;
            await page.evaluate(`window.titanCapture.render(${JSON.stringify({ type, team: 'alpha', view: 'cockpit', fov: 75, ...COCKPIT_STATES[stateId] })})`);
            const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
            backdrops[key] = `data:image/png;base64,${shot.data}`;
          }
        }
        report.errors.push(...page.errors);
      } finally { await session.close(); }
    }
    // 2. The stock titan HUD over the cockpit backdrops, with the MFD × DOM panel overlap check.
    if (hudTitans.length) {
      const session = await launchCdpSession(`http://127.0.0.1:${port}/titanfall-hud-capture.html`, { width: 1920, height: 1080 });
      try {
        const page = session.page;
        await page.waitFor('window.__tf?.ready === true', { label: 'HUD capture page' });
        for (const sizeId of sizes) {
          const size = COCKPIT_CAPTURE_SIZES[sizeId];
          await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
          await page.send('Emulation.setTouchEmulationEnabled', size.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
          const pairs = diegetic ? states.map(stateId => [stateId, stateId === 'doom' ? 'titan-doomed' : 'titan']) : [['idle', 'titan'], ['doom', 'titan-doomed']];
          for (const type of hudTitans) for (const [stateId, fixture] of pairs) {
            await page.evaluate(`window.__tf.render(${JSON.stringify(fixture)}, { touch: ${size.touch} })`);
            // Diegetic: the live page in cockpit view (titan-ui sets this while the cockpit HUD draws).
            if (diegetic) await page.evaluate("document.body.dataset.titanfallCockpit = ''");
            await page.evaluate(`window.__tf.setBackdrop(${JSON.stringify(backdrops[`${sizeId}:${type}:${stateId}`])})`);
            const boxes = await page.evaluate('window.__tf.boxes()');
            const panels = Object.entries(boxes).filter(([key, value]) => value && key !== 'buttons' && key !== 'viewport' && key !== 'stick');
            if (size.touch) for (const button of boxes.buttons || []) panels.push([`touch:${button.action}`, button.box]);
            const rects = await screenRects(type, size.width, size.height);
            const hits = [];
            rects.forEach((rect, i) => { for (const [name, box] of panels) if (intersect(rect, box)) hits.push(`mfd${i} × ${name}`); });
            const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            const name = `${sizeId}-${diegetic ? 'composite' : 'hud'}-${type.slice(6)}-${stateId}.png`;
            await writeFile(path.join(outDir, name), Buffer.from(shot.data, 'base64'));
            report.hud.push({ size: sizeId, type, state: stateId, file: path.relative(root, path.join(outDir, name)), mfds: rects.length, overlaps: hits });
            // Touch buttons sit over everything on phones; only fixed panels fail the run.
            const fatal = hits.filter(hit => !hit.includes('touch:'));
            if (fatal.length) report.overlaps.push({ size: sizeId, type, state: stateId, hits: fatal });
            console.log(`${sizeId.padEnd(9)} HUD ${type.padEnd(15)} ${stateId.padEnd(5)} ${hits.length ? `MFD overlaps ${hits.join(', ')}` : 'ok'}`);
          }
        }
        const missingArt = /\/assets\/weapons\/hud\//;
        report.errors.push(...page.errors.filter(error => !missingArt.test(error)));
      } finally { await session.close(); }
    }
  } finally {
    await stopServer(server);
    release();
  }
  await writeFile(path.join(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) console.error(`Browser errors:\n  ${report.errors.join('\n  ')}`);
  if (report.overlaps.length) console.error(`MFD × HUD overlaps: ${report.overlaps.map(o => `${o.size}/${o.type}/${o.state}: ${o.hits.join(', ')}`).join('; ')}`);
  const failed = report.errors.length > 0 || report.overlaps.length > 0;
  console.log(`${failed ? 'FAILED' : 'Captured'} ${report.shots.length} cockpit shots and ${report.hud.length} HUD composites into ${path.relative(root, outDir)}`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
