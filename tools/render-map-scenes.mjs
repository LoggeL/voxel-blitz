import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_CAPTURE_SHOTS } from '../shared/map-capture-shots.js';
import { captureBrowserPage } from './lib/browser-capture.mjs';
import { parseCaptureArgs, runCaptureFlow } from './lib/capture-flow.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, '.artifacts', 'map-renders');

function parseArgs(argv) {
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

async function renderShot({ browser, profileDir, baseUrl, outDir, dimensions, shot }) {
  const output = path.join(outDir, `${shot.map}-${shot.id}.png`);
  const url = new URL('/capture.html', baseUrl);
  url.searchParams.set('map', shot.map);
  url.searchParams.set('shot', shot.id);
  const readyMarkers = [
    'data-capture-ready="true"',
    `data-capture-map="${shot.map}"`,
    `data-capture-shot="${shot.id}"`,
  ];
  const bytes = await captureBrowserPage({
    browser,
    profileDir,
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
    profilePrefix: 'voxel-blitz-map-capture-',
    failureContext: 'map capture',
    shots,
    captureShot: renderShot,
    formatShot: (entry) => `${entry.map}/${entry.id}`,
  });
  console.log(`rendered ${rendered.length} scene${rendered.length === 1 ? '' : 's'}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
