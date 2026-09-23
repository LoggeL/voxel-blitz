import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_CAPTURE_SHOTS } from '../shared/map-capture-shots.js';
import { captureReadyBrowserPage } from './lib/browser-capture.mjs';
import { parseCaptureArgs, runCaptureFlow } from './lib/capture-flow.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, '.artifacts', 'map-renders');

// --quality low|medium|high|ultra forwards ?quality= to capture.html (default high);
// --avatars forwards ?avatars=1 (capture avatars placed in view).
const QUALITIES = new Set(['low', 'medium', 'high', 'ultra']);

function parseArgs(argv) {
  let quality = null;
  let avatars = false;
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--avatars') { avatars = true; continue; }
    if (argv[index] !== '--quality') { rest.push(argv[index]); continue; }
    quality = argv[++index];
    if (!QUALITIES.has(quality)) throw new Error(`invalid --quality: ${quality}`);
  }
  return { ...parseCaptureArgsFor(rest), quality, avatars };
}

function parseCaptureArgsFor(argv) {
  return parseCaptureArgs(argv, {
    defaultOutDir: DEFAULT_OUT_DIR,
    selectors: { '--map': 'map', '--shot': 'shot' },
    validate: (options) => {
      if (options.shot && !options.map) throw new Error('--shot requires --map');
    },
  });
}

function selectedShots(options) {
  if (options.all || !options.map) return MAP_CAPTURE_SHOTS;
  const matches = MAP_CAPTURE_SHOTS.filter((entry) =>
    entry.map === options.map && (!options.shot || entry.id === options.shot));
  if (!matches.length) throw new Error(`unknown capture selection: ${options.map}/${options.shot || '*'}`);
  return matches;
}

async function renderShot({ browser, baseUrl, outDir, dimensions, shot }, { quality, avatars }) {
  const suffix = `${avatars ? '-avatars' : ''}${quality ? `-${quality}` : ''}`;
  const output = path.join(outDir, `${shot.map}-${shot.id}${suffix}.png`);
  const url = new URL('/capture.html', baseUrl);
  url.searchParams.set('map', shot.map);
  url.searchParams.set('shot', shot.id);
  if (quality) url.searchParams.set('quality', quality);
  if (avatars) url.searchParams.set('avatars', '1');
  const readyMarkers = [
    'data-capture-ready="true"',
    `data-capture-map="${shot.map}"`,
    `data-capture-shot="${shot.id}"`,
  ];
  const bytes = await captureReadyBrowserPage({
    browser,
    url: url.href,
    output,
    dimensions,
    readyMarkers,
  });
  return { ...shot, output, bytes };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const entry of MAP_CAPTURE_SHOTS) console.log(`${entry.map}/${entry.id}`);
    return;
  }

  const shots = selectedShots(options);
  const rendered = await runCaptureFlow({
    options,
    projectRoot: PROJECT_ROOT,
    route: '/capture.html',
    failureContext: 'map capture',
    shots,
    captureShot: (context) => renderShot(context, options),
    formatShot: (entry) => `${entry.map}/${entry.id}`,
  });
  console.log(`rendered ${rendered.length} scene${rendered.length === 1 ? '' : 's'}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
