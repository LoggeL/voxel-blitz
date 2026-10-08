// Muted CDP captures of public/structure-capture.html: a scripted structural
// collapse (creak shake and grit, falling chunks with dust trails, the impact
// cloud and debris, the crumbling lintel, settled rubble) through the live
// client pieces, at fixed presented times. Static page only: no live match,
// no audio (Chromium runs with --mute-audio). Not part of npm test.
//
//   node tools/structure-capture.mjs [--shot <name>] [--out-dir dir] [--list]
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCaptureArgs, runCaptureFlow } from './lib/capture-flow.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'docs', 'design', 'structure', 'captures');

/** Presented ms after the creak; the roof lands at ~450 + 707 ms, the platform at ~450 + 577 ms. */
export const STRUCTURE_CAPTURE_SHOTS = Object.freeze([
  { name: '00-intact', t: -200 },
  { name: '01-creak', t: 380, view: 'close' },
  { name: '02-falling', t: 820 },
  { name: '03-falling-close', t: 980, view: 'close' },
  { name: '04-impact', t: 1240 },
  { name: '04b-dust', t: 1520 },
  { name: '05-settled', t: 3600 },
  { name: '06-impact-low', t: 1240, quality: 'low' },
  { name: '07-impact-top', t: 1300, view: 'top' },
].map(Object.freeze));

async function renderShot({ browser, baseUrl, outDir, dimensions, shot }) {
  const url = new URL('/structure-capture.html', baseUrl);
  url.searchParams.set('t', String(shot.t));
  if (shot.view) url.searchParams.set('view', shot.view);
  if (shot.quality) url.searchParams.set('quality', shot.quality);
  const output = path.join(outDir, `${shot.name}.png`);
  const session = await launchCdpSession(url.href, { browser, ...dimensions });
  try {
    await session.page.waitFor('document.documentElement.dataset.captureReady === "true"', { timeoutMs: 60000, label: 'structure capture ready' });
    if (session.page.errors.length) throw new Error(session.page.errors.join('\n'));
    const state = await session.page.evaluate('JSON.stringify({ counts: __vbStructure.counts, stats: __vbStructure.stats, maxHidden: __vbStructure.maxHidden, hidden: __vbStructure.hidden, simulateMs: Math.round(__vbStructure.simulateMs), tier: __vbStructure.graphics })');
    const shotData = await session.page.send('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(shotData.data, 'base64');
    if (bytes.length < 10000) throw new Error(`invalid screenshot output: ${output}`);
    await writeFile(output, bytes);
    const parsed = JSON.parse(state);
    if (shot.t > 2500 && (parsed.hidden !== 0 || parsed.counts.heldCells !== 0 || parsed.counts.chunks !== 0)) {
      throw new Error(`${shot.name}: collapse left state behind ${state}`);
    }
    return { ...shot, output, bytes: bytes.length, state: parsed };
  } finally { await session.close(); }
}

async function main() {
  const options = parseCaptureArgs(process.argv.slice(2), { defaultOutDir: DEFAULT_OUT_DIR, selectors: { '--shot': 'shot' } });
  if (!process.argv.includes('--width')) options.width = 1280;
  if (!process.argv.includes('--height')) options.height = 720;
  const shots = STRUCTURE_CAPTURE_SHOTS.filter(shot => !options.shot || shot.name === options.shot);
  if (options.list) { for (const shot of shots) console.log(shot.name); return; }
  if (!shots.length) throw new Error('no structure capture matches the selection');
  const rendered = await runCaptureFlow({
    options, projectRoot: PROJECT_ROOT, route: '/structure-capture.html', failureContext: 'structure capture',
    shots, captureShot: renderShot, formatShot: shot => shot.name,
  });
  for (const shot of rendered) console.log(`${shot.name}: ${JSON.stringify(shot.state)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
}
