// Muted CDP captures of the attrition minions (docs/titanfall.md §10; WP8): GRUNTS and
// SPECTRES of both teams beside a pilot and a titan for scale, through the real
// client path (public/js/capture/grunt-capture.js drives public/js/titanfall/npc-view.js).
// One headless Chromium session (--mute-audio) renders every shot; the page is
// static (no match, no audio, no network) and served from memory here, so no
// public HTML file is touched.
//
//   node tools/titanfall-grunts-capture.mjs [--shot hero,lineup,closeup,squad,death] [--out-dir dir]
//        [--width 1600] [--height 1000] [--mobile] [--no-lock]
//
// Holds /Users/.../voxel-blitz/.titan-capture.lock (one WebGL capture at a time,
// docs/titanfall.md §12.4) unless --no-lock says the caller already holds it.
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticHandler } from '../server/static.js';
import { launchCdpSession } from './lib/cdp-session.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'docs', 'design', 'titanfall', 'captures');
const LOCK = path.join(PROJECT_ROOT, '.titan-capture.lock');
export const GRUNT_CAPTURE_SHOTS = Object.freeze(['hero', 'lineup', 'closeup', 'squad', 'death']);

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VOXEL BLITZ Minion Capture</title>
<style>html,body,#capture{width:100%;height:100%;margin:0;overflow:hidden;background:#a9c4dc}#capture{display:block}
#label{position:fixed;left:12px;bottom:10px;font:600 12px/1.3 system-ui,sans-serif;color:#10202c;background:rgba(255,255,255,.6);padding:4px 8px;border-radius:3px;letter-spacing:.04em}</style>
</head><body><canvas id="capture" aria-label="minion capture"></canvas><div id="label"></div>
<script type="module" src="./js/capture/grunt-capture.js"></script></body></html>`;

function parseArgs(argv) {
  const options = { shots: [], outDir: DEFAULT_OUT_DIR, width: 1600, height: 1000, lock: true, mobile: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--shot') options.shots.push(...value().split(','));
    else if (arg === '--out-dir') options.outDir = path.resolve(value());
    else if (arg === '--width') options.width = Number(value());
    else if (arg === '--height') options.height = Number(value());
    else if (arg === '--mobile') options.mobile = true;
    else if (arg === '--no-lock') options.lock = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.shots.length) options.shots = [...GRUNT_CAPTURE_SHOTS];
  for (const shot of options.shots) if (!GRUNT_CAPTURE_SHOTS.includes(shot)) throw new Error(`unknown shot ${shot}`);
  return options;
}

async function acquireLock() {
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(path.join(LOCK, 'owner'), `${process.pid} ${Math.floor(Date.now() / 1000)} titanfall-grunts-capture\n`);
      const release = () => { try { rmSync(LOCK, { recursive: true, force: true }); } catch {} };
      process.once('exit', release);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { release(); process.exit(130); });
      return release;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Math.floor(Date.now() / 1000) - Number(readFileSync(path.join(LOCK, 'owner'), 'utf8').split(' ')[1]); } catch {}
      if (age > 900) { rmSync(LOCK, { recursive: true, force: true }); continue; }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/grunt-capture.html') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(PAGE);
        return;
      }
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
  const width = options.mobile ? 720 : options.width, height = options.mobile ? 1280 : options.height;
  const release = options.lock ? await acquireLock() : () => {};
  const { server, base } = await startServer();
  await mkdir(options.outDir, { recursive: true });
  let session = null;
  try {
    session = await launchCdpSession(`${base}/grunt-capture.html`, { width, height });
    const page = session.page;
    await page.waitFor('window.gruntCapture?.ready === true', { timeoutMs: 60000, label: 'grunt capture page' });
    for (const shot of options.shots) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const result = await page.evaluate(`window.gruntCapture.render(${JSON.stringify({ shot })})`);
      if (page.errors.length) throw new Error(page.errors.join('\n'));
      const data = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
      const name = `grunts-${shot}${options.mobile ? '-mobile' : ''}.png`;
      const output = path.join(options.outDir, name);
      const bytes = Buffer.from(data.data, 'base64');
      if (bytes.length < 10_000) throw new Error(`invalid screenshot output: ${output}`);
      await writeFile(output, bytes);
      console.log(`${name} -> ${path.relative(PROJECT_ROOT, output)} (${bytes.length} bytes; ${result?.label ?? ''})`);
    }
  } finally {
    await session?.close?.();
    await new Promise(resolve => server.close(resolve));
    release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || error.message || error); process.exitCode = 1; });
}
