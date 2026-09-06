import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AVATAR_CAPTURE_SHOTS,
  AVATAR_CAPTURE_VIEWS,
} from '../shared/avatar-capture-shots.js';
import { captureBrowserPage } from './lib/browser-capture.mjs';
import { parseCaptureArgs, runCaptureFlow } from './lib/capture-flow.mjs';
import { writeCaptureReport } from './lib/capture-report.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, '.artifacts', 'avatar-renders');

function parseArgs(argv) {
  return parseCaptureArgs(argv, {
    defaultOutDir: DEFAULT_OUT_DIR,
    selectors: { '--weapon': 'weapon', '--view': 'view', '--avatar': 'avatar', '--team': 'team' },
    validate: (options) => {
      if (options.view && !AVATAR_CAPTURE_VIEWS.includes(options.view)) {
        throw new Error(`unknown avatar capture view: ${options.view}`);
      }
    },
  });
}

function selectedShots(options) {
  const matches = AVATAR_CAPTURE_SHOTS.filter((entry) =>
    (!options.weapon || entry.weapon === options.weapon)
      && (!options.view || entry.view === options.view));
  if (!matches.length) {
    throw new Error(`unknown avatar capture selection: ${options.weapon || '*'}/${options.view || '*'}`);
  }
  return matches.map(shot => ({ ...shot, avatar: options.avatar, team: options.team }));
}

async function renderShot({ browser, profileDir, baseUrl, outDir, dimensions, shot }) {
  const output = path.join(outDir, `${shot.weapon}-${shot.view}.png`);
  const url = new URL('/avatar-capture.html', baseUrl);
  url.searchParams.set('weapon', shot.weapon);
  url.searchParams.set('view', shot.view);
  if (shot.avatar) url.searchParams.set('avatar', shot.avatar);
  if (shot.team) url.searchParams.set('team', shot.team);
  const bytes = await captureBrowserPage({
    browser,
    profileDir,
    url: url.href,
    output,
    dimensions,
    readyMarkers: [
      'data-capture-ready="true"',
      `data-capture-weapon="${shot.weapon}"`,
      `data-capture-view="${shot.view}"`,
      `data-capture-pose="${shot.pose}"`,
    ],
  });
  return { ...shot, output, bytes };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const entry of AVATAR_CAPTURE_SHOTS) console.log(`${entry.weapon}/${entry.view}`);
    return;
  }

  const rendered = await runCaptureFlow({
    options,
    projectRoot: PROJECT_ROOT,
    route: '/avatar-capture.html',
    profilePrefix: 'voxel-blitz-avatar-capture-',
    failureContext: 'avatar capture',
    shots: selectedShots(options),
    captureShot: renderShot,
    formatShot: (entry) => `${entry.weapon}/${entry.view}`,
  });
  const rows = rendered.map(({ weapon, view, output, bytes }) => ({
    weapon,
    view,
    file: path.basename(output),
    bytes,
  }));
  const reportPath = await writeCaptureReport({
    outDir: options.outDir,
    title: 'VOXEL BLITZ Third-person Weapon Matrix',
    rows,
    primaryKey: 'weapon',
    secondaryKey: 'view',
  });
  console.log(`rendered ${rendered.length} avatar scene${rendered.length === 1 ? '' : 's'}`);
  console.log(`report -> ${reportPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
