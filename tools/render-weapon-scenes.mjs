import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WEAPON_CAPTURE_SHOTS,
  WEAPON_CAPTURE_STATES,
} from '../shared/weapon-capture-shots.js';
import { captureBrowserPage } from './lib/browser-capture.mjs';
import { parseCaptureArgs, runCaptureFlow } from './lib/capture-flow.mjs';

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

async function renderShot({ browser, profileDir, baseUrl, outDir, dimensions, shot }) {
  const output = path.join(outDir, `${shot.weapon}-${shot.state}.png`);
  const url = new URL('/weapon-capture.html', baseUrl);
  url.searchParams.set('weapon', shot.weapon);
  url.searchParams.set('state', shot.state);
  const bytes = await captureBrowserPage({
    browser,
    profileDir,
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

async function writeReport(outDir, rendered) {
  const rows = rendered.map(({ weapon, state, output, bytes }) => ({
    weapon,
    state,
    file: path.basename(output),
    bytes,
  }));
  const cards = rows.map(({ weapon, state, file, bytes }) => `
    <figure>
      <img src="./${file}" alt="${weapon} ${state}">
      <figcaption><strong>${weapon}</strong><span>${state}</span><small>${bytes} bytes</small></figcaption>
    </figure>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>VOXEL BLITZ Weapon Render Matrix</title><style>
body{margin:0;padding:24px;background:#111923;color:#e8f0f8;font:14px system-ui,sans-serif}
h1{margin:0 0 20px;font-size:22px}.grid{display:grid;grid-template-columns:repeat(3,minmax(260px,1fr));gap:16px}
figure{margin:0;background:#1b2733;border:1px solid #34495b;border-radius:8px;overflow:hidden}
img{display:block;width:100%;height:auto}figcaption{display:flex;gap:10px;align-items:baseline;padding:10px 12px;text-transform:uppercase}
figcaption span{color:#ff9f32}small{margin-left:auto;color:#8496a7;text-transform:none}@media(max-width:900px){.grid{grid-template-columns:1fr}}
</style></head><body><h1>VOXEL BLITZ Weapon Render Matrix</h1><main class="grid">${cards}
</main></body></html>`;
  const reportPath = path.join(outDir, 'index.html');
  await Promise.all([
    writeFile(reportPath, html),
    writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(rows, null, 2)}\n`),
  ]);
  return reportPath;
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
    profilePrefix: 'voxel-blitz-weapon-capture-',
    failureContext: 'weapon capture',
    shots,
    captureShot: renderShot,
    formatShot: (entry) => `${entry.weapon}/${entry.state}`,
  });
  const reportPath = await writeReport(options.outDir, rendered);
  console.log(`rendered ${rendered.length} weapon scene${rendered.length === 1 ? '' : 's'}`);
  console.log(`report -> ${reportPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
