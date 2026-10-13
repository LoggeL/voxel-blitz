// Muted CDP captures of the titanfall drop (docs/design/titanfall/captures/models.md "Titanfall
// drop") through public/titanfall-drop-capture.html (public/js/capture/titanfall-drop-capture.js):
// filmstrips of fall → impact → dust over ~4 s from a pilot at 15 m and 40 m, the caller, a
// LEGION cockpit 21 m away and a wide shot, plus full-size key frames. One headless Chromium
// session renders every shot via window.dropCapture.render; no match, no audio (--mute-audio,
// and the page never opens an audio context).
//
//   node tools/titanfall-drop-capture.mjs [--shot name,...] [--frame view@seconds[@bare] ...] [--type titan_ion] [--out-dir dir] [--prefix name] [--list]
//
// The caller holds a capture slot (.titan-capture.lock*): this tool takes no lock of its own.
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticHandler } from '../server/static.js';
import { launchCdpSession } from './lib/cdp-session.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'docs', 'design', 'titanfall', 'captures', 'titanfall-drop');
const STRIP = '-2.6,-1.6,-0.9,-0.45,-0.15,0.03,0.12,0.35,0.8,1.5,2.5,4.0';

export const DROP_CAPTURE_SHOTS = Object.freeze([
  { name: 'strip-pilot15', view: 'pilot15', cells: STRIP },
  { name: 'strip-pilot40', view: 'pilot40', cells: STRIP },
  { name: 'strip-caller', view: 'caller', cells: STRIP },
  { name: 'strip-cockpit', view: 'cockpit', cells: STRIP },
  { name: 'strip-wide', view: 'wide', cells: STRIP },
  { name: 'strip-skyward', view: 'skyward', cells: STRIP },
  { name: 'fall-wide', view: 'wide', at: -1.1 },
  { name: 'fall-caller', view: 'caller', at: -0.5 },
  { name: 'burn-pilot15', view: 'pilot15', at: -0.2 },
  { name: 'impact-pilot15', view: 'pilot15', at: 0.1 },
  { name: 'shockwave-pilot40', view: 'pilot40', at: 0.4 },
  { name: 'impact-cockpit', view: 'cockpit', at: 0.12 },
  { name: 'dust-caller', view: 'caller', at: 1.5 },
  { name: 'settle-top', view: 'top', at: 2.5 },
  { name: 'impact-mobile', view: 'pilot15', at: 0.12, width: 720, height: 1280 },
  { name: 'strip-landing-pose', view: 'side', cells: '-0.1,-0.05,-0.02,0.0,0.02,0.05,0.08,0.12,0.2,0.35,0.8,1.6', bare: true },
].map(Object.freeze));

function parseArgs(argv) {
  const options = { shots: [], frames: [], type: 'titan_ion', outDir: DEFAULT_OUT_DIR, prefix: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--shot') options.shots.push(...value().split(','));
    else if (arg === '--type') options.type = value();
    else if (arg === '--out-dir') options.outDir = path.resolve(value());
    else if (arg === '--prefix') options.prefix = value();
    else if (arg === '--list') options.list = true;
    else if (arg === '--frame') {
      // Ad-hoc review frame: view@seconds[@bare], e.g. side@0.35@bare.
      const [view, at, bare] = value().split('@');
      options.frames.push({ name: `frame-${view}-${at}${bare ? '-bare' : ''}`, view, at: Number(at), bare: bare === 'bare' });
    }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      if (await staticHandler(request, response)) return;
      response.writeHead(404); response.end('not found');
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error?.message || error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = options.frames.length && !options.shots.length ? options.frames
    : [...DROP_CAPTURE_SHOTS.filter(shot => !options.shots.length || options.shots.includes(shot.name)), ...options.frames];
  const fileName = shot => `${options.prefix ? `${options.prefix}-` : ''}${shot.name}.png`;
  if (options.list) { for (const shot of plan) console.log(fileName(shot)); return; }
  if (!plan.length) throw new Error('no drop capture matches the selection');
  const { server, base } = await startServer();
  await mkdir(options.outDir, { recursive: true });
  let session = null;
  try {
    session = await launchCdpSession(`${base}/titanfall-drop-capture.html?manual=1`, { width: 2560, height: 1280 });
    const page = session.page;
    await page.waitFor('window.dropCapture?.ready === true', { timeoutMs: 90000, label: 'drop capture page' });
    for (const shot of plan) {
      const params = { view: shot.view, type: options.type };
      if (shot.cells) Object.assign(params, { cells: shot.cells, cols: 4, cellW: 640, cellH: 400 });
      else params.at = shot.at;
      if (shot.bare) params.bare = true;
      let width = shot.width || 1600, height = shot.height || 1000;
      if (shot.cells) { width = 2560; height = 1200; }
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const result = await page.evaluate(`window.dropCapture.render(${JSON.stringify(params)})`);
      if (page.errors.length) throw new Error(page.errors.join('\n'));
      const data = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
      const output = path.join(options.outDir, fileName(shot));
      const bytes = Buffer.from(data.data, 'base64');
      if (bytes.length < 10_000) throw new Error(`invalid screenshot output: ${output}`);
      await writeFile(output, bytes);
      const brief = (result?.shots || []).map(s => `${s.t}:${s.impacted ? 'I' : `${Math.round(s.lift)}m`}/fov${s.fov.toFixed(1)}/tr${s.trauma.toFixed(2)}/ch${s.chunks}`).join(' ');
      console.log(`${fileName(shot)} -> ${path.relative(PROJECT_ROOT, output)} (${bytes.length} bytes) ${brief}`);
    }
  } finally {
    await session?.close?.();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || error.message || error); process.exitCode = 1; });
}
