// Muted CDP captures of public/vehicle-capture.html: every Conquest hull from
// fixed angles, team camouflage, damage states and the WEST/EAST pair at
// 150 m (whose hue separation the page measures and this tool asserts).
// Static page only: no live match, no audio (Chromium runs with --mute-audio).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureReadyBrowserPage } from './lib/browser-capture.mjs';
import { parseCaptureArgs, runCaptureFlow } from './lib/capture-flow.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { VEHICLE_TYPE_IDS } from '../shared/conquest-contract.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'docs', 'design', 'conquest', 'redesign', 'captures', 'vehicles');

/** The capture matrix: hero/side/rear/top per type and team, damage states, the range pair. */
export const VEHICLE_CAPTURE_SHOTS = Object.freeze(VEHICLE_TYPE_IDS.flatMap(type => [
  { type, team: 'alpha', angle: 'hero', state: 'intact', extra: { crew: '1' } },
  { type, team: 'bravo', angle: 'hero', state: 'intact', extra: { crew: '1' } },
  { type, team: 'alpha', angle: 'side', state: 'intact' },
  { type, team: 'bravo', angle: 'rear', state: 'intact' },
  { type, team: 'alpha', angle: 'top', state: 'intact' },
  { type, team: 'alpha', angle: 'hero', state: 'damaged' },
  { type, team: 'bravo', angle: 'hero', state: 'burning' },
  { type, team: 'alpha', angle: 'hero', state: 'wreck' },
  { type, team: 'alpha', angle: 'range', state: 'intact' },
]).map(shot => Object.freeze({ ...shot, name: `${shot.type}-${shot.angle}-${shot.state}-${shot.angle === 'range' ? 'pair' : shot.team}` })));

function parseArgs(argv) {
  const options = parseCaptureArgs(argv, {
    defaultOutDir: DEFAULT_OUT_DIR,
    selectors: { '--type': 'type', '--angle': 'angle', '--state': 'state', '--team': 'team' },
  });
  if (!argv.includes('--width')) options.width = 1440;
  if (!argv.includes('--height')) options.height = 1037;
  return options;
}

async function renderShot({ browser, baseUrl, outDir, dimensions, shot }) {
  const output = path.join(outDir, `${shot.name}.png`);
  const url = new URL('/vehicle-capture.html', baseUrl);
  for (const [key, value] of Object.entries({ type: shot.type, team: shot.team, angle: shot.angle, state: shot.state, ...shot.extra })) url.searchParams.set(key, value);
  const bytes = await captureReadyBrowserPage({
    browser, url: url.href, output, dimensions,
    readyMarkers: ['data-capture-ready="true"', `data-capture-type="${shot.type}"`, `data-capture-angle="${shot.angle}"`],
  });
  let hue = null;
  if (shot.angle === 'range') {
    // Re-read the measured hue markers from a second muted session.
    const session = await launchCdpSession(url.href, { browser, ...dimensions });
    try {
      await session.page.waitFor('document.documentElement.dataset.captureReady === "true"', { timeoutMs: 30000 });
      hue = await session.page.evaluate('({ west: +document.documentElement.dataset.hueWest, east: +document.documentElement.dataset.hueEast, separated: document.documentElement.dataset.hueSeparated === "true", pixels: document.documentElement.dataset.huePixels })');
    } finally { await session.close(); }
    if (!hue?.separated) throw new Error(`team hues not separated at 150 m for ${shot.type}: ${JSON.stringify(hue)}`);
  }
  return { ...shot, output, bytes, hue };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const shots = VEHICLE_CAPTURE_SHOTS.filter(shot => ['type', 'angle', 'state', 'team'].every(key => !options[key] || shot[key] === options[key]));
  if (options.list) { for (const shot of shots) console.log(shot.name); return; }
  if (!shots.length) throw new Error('no vehicle capture matches the selection');
  const rendered = await runCaptureFlow({
    options, projectRoot: PROJECT_ROOT, route: '/vehicle-capture.html', failureContext: 'vehicle capture',
    shots, captureShot: renderShot, formatShot: shot => shot.name,
  });
  for (const shot of rendered) if (shot.hue) console.log(`${shot.type} hue WEST ${shot.hue.west} deg vs EAST ${shot.hue.east} deg`);
  console.log(`rendered ${rendered.length} vehicle capture${rendered.length === 1 ? '' : 's'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
}
