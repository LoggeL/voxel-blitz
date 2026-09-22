import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WEAPON_CAPTURE_SHOTS,
  WEAPON_CAPTURE_STATES,
} from '../shared/weapon-capture-shots.js';
import { captureReadyBrowserPage } from './lib/browser-capture.mjs';
import { parseCaptureArgs, runCaptureFlow } from './lib/capture-flow.mjs';
import { writeCaptureReport } from './lib/capture-report.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, '.artifacts', 'weapon-renders');

function parseArgs(argv) {
  return parseCaptureArgs(argv, {
    defaultOutDir: DEFAULT_OUT_DIR,
    selectors: { '--weapon': 'weapon', '--state': 'state' },
    validate: (options) => {
      if (options.state && !WEAPON_CAPTURE_STATES.includes(options.state)) {
        throw new Error(`unknown weapon capture state: ${options.state}`);
      }
    },
  });
}

function selectedShots(options) {
  const matches = WEAPON_CAPTURE_SHOTS.filter((entry) =>
    (!options.weapon || entry.weapon === options.weapon)
      && (!options.state || entry.state === options.state));
  if (!matches.length) {
    throw new Error(`unknown weapon capture selection: ${options.weapon || '*'}/${options.state || '*'}`);
  }
  return matches;
}

async function renderShot({ browser, baseUrl, outDir, dimensions, shot }) {
  const output = path.join(outDir, `${shot.weapon}-${shot.state}.png`);
  const url = new URL('/weapon-capture.html', baseUrl);
  url.searchParams.set('weapon', shot.weapon);
  url.searchParams.set('state', shot.state);
  const bytes = await captureReadyBrowserPage({
    browser,
    url: url.href,
    output,
    dimensions,
    readyMarkers: [
      'data-capture-ready="true"',
      `data-capture-weapon="${shot.weapon}"`,
      `data-capture-state="${shot.state}"`,
    ],
  });
  return { ...shot, output, bytes };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const entry of WEAPON_CAPTURE_SHOTS) console.log(`${entry.weapon}/${entry.state}`);
    return;
  }

  const shots = selectedShots(options);
  const rendered = await runCaptureFlow({
    options,
    projectRoot: PROJECT_ROOT,
    route: '/weapon-capture.html',
    failureContext: 'weapon capture',
    shots,
    captureShot: renderShot,
    formatShot: (entry) => `${entry.weapon}/${entry.state}`,
  });
  const rows = rendered.map(({ weapon, state, output, bytes }) => ({
    weapon,
    state,
    file: path.basename(output),
    bytes,
  }));
  const reportPath = await writeCaptureReport({
    outDir: options.outDir,
    title: 'VOXEL BLITZ Weapon Render Matrix',
    rows,
    primaryKey: 'weapon',
    secondaryKey: 'state',
  });
  console.log(`rendered ${rendered.length} weapon scene${rendered.length === 1 ? '' : 's'}`);
  console.log(`report -> ${reportPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
