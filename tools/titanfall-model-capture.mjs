// Muted CDP captures of the titan models (docs/titanfall.md §7.4; WP5) through
// public/vehicle-capture.html?type=titan_* (public/js/capture/titan-capture.js).
// One headless Chromium session renders every shot via window.titanCapture.render,
// so a full set costs one WebGL context. Static page only: no match, no audio
// (Chromium runs with --mute-audio).
//
//   node tools/titanfall-model-capture.mjs [--type titan_ion] [--team alpha|bravo] [--shot name]
//        [--out-dir dir] [--width 1600] [--height 1000] [--prefix name] [--list] [--no-lock]
//        [--overlay public/path=local/file ...]   serve a local file in place of one public file
//        [--eval <js expression>]                 print the expression's JSON after each shot (debugging)
//        [--param key=value ...]                  extra page params for every shot (swatch=1, env=0, yaw=0.4)
//        [--abilities [--shot ion-vortex,...] [--at 1.2]]  the ability shots (titan-ability-capture.js,
//                                                 alpha only unless --team; out: captures/abilities/)
//
// Holds /Users/.../voxel-blitz/.titan-capture.lock (one WebGL capture at a time,
// §12.4) unless --no-lock says the caller already holds it.
import http from 'node:http';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticHandler } from '../server/static.js';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { TITAN_TYPE_IDS } from '../shared/titan-contract.js';
import { TITAN_ABILITY_SHOTS } from '../public/js/capture/titan-ability-capture.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'docs', 'design', 'titanfall', 'captures');
const LOCK = path.join(PROJECT_ROOT, '.titan-capture.lock');

/**
 * The shot list per titan: turnaround sheet, single views, poses, walk and embark strips and
 * the cockpit (desktop and phone portrait). `once` shots render one image per team for the run
 * (the lineup shows all five titans with a pilot for scale).
 */
export const TITAN_CAPTURE_SHOTS = Object.freeze([
  { name: 'sheet', view: 'sheet', pose: 'idle', width: 2640, height: 900 },
  { name: 'hero', view: 'hero', pose: 'idle' },
  { name: 'front', view: 'front', pose: 'idle' },
  { name: 'side', view: 'side', pose: 'idle' },
  { name: 'right', view: 'right', pose: 'idle' },
  { name: 'back', view: 'back', pose: 'idle' },
  { name: 'threequarter', view: 'threequarter', pose: 'idle' },
  { name: 'face', view: 'face', pose: 'idle' },
  // Strips: 9 m wide orthographic cells (2 rows of 4), so a full stride fits each cell.
  { name: 'walk-strip', view: 'strip', pose: 'walk', frames: 8, width: 2800, height: 1430 },
  { name: 'walk-hero', view: 'hero', pose: 'walk', phase: 0.3 },
  { name: 'sprint-hero', view: 'hero', pose: 'sprint', phase: 0.6 },
  { name: 'dash', view: 'hero', pose: 'dash' },
  { name: 'guard', view: 'hero', pose: 'guard' },
  { name: 'core', view: 'hero', pose: 'core' },
  { name: 'embark', view: 'hero', pose: 'embark' },
  { name: 'landing', view: 'hero', pose: 'landing' },
  { name: 'doom', view: 'hero', pose: 'doom' },
  { name: 'doom-strip', view: 'strip', pose: 'doom', frames: 4, width: 2400, height: 800 },
  { name: 'hover', view: 'hero', pose: 'hover', only: ['titan_northstar'] },
  { name: 'hover-back', view: 'rear', pose: 'hover', only: ['titan_northstar'] },
  { name: 'wreck', view: 'hero', pose: 'wreck' },
  { name: 'aim-up', view: 'hero', pose: 'idle', aim: 0.3, aimPitch: 0.5 },
  { name: 'range', view: 'range', pose: 'idle' },
  { name: 'cockpit', view: 'cockpit', pose: 'idle' },
  { name: 'cockpit-mobile', view: 'cockpit', pose: 'idle', width: 720, height: 1280 },
  { name: 'embark-strip', view: 'strip', pose: 'embark', frames: 6, width: 2400, height: 800 },
  { name: 'lineup', view: 'lineup', pose: 'idle', width: 2400, height: 960, once: true },
].map(Object.freeze));

function parseArgs(argv) {
  const options = { types: [], teams: [], shots: [], outDir: DEFAULT_OUT_DIR, width: 1600, height: 1000, prefix: null,
    list: false, lock: true, overlays: [], browser: null, evals: [], params: {}, abilities: false, at: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--type') options.types.push(value());
    else if (arg === '--team') options.teams.push(value());
    else if (arg === '--shot') options.shots.push(...value().split(','));
    else if (arg === '--out-dir') options.outDir = path.resolve(value());
    else if (arg === '--width') options.width = Number(value());
    else if (arg === '--height') options.height = Number(value());
    else if (arg === '--prefix') options.prefix = value();
    else if (arg === '--browser') options.browser = path.resolve(value());
    else if (arg === '--overlay') { const [pub, local] = value().split('='); options.overlays.push([pub.replace(/^\/+/, ''), path.resolve(local)]); }
    else if (arg === '--eval') options.evals.push(value());
    else if (arg === '--param') { const [key, ...rest] = value().split('='); options.params[key] = rest.join('='); }
    else if (arg === '--list') options.list = true;
    else if (arg === '--abilities') options.abilities = true;
    else if (arg === '--at') options.at = Number(value());
    else if (arg === '--no-lock') options.lock = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.types.length) options.types = ['titan_ion'];
  if (options.types.includes('all')) options.types = [...TITAN_TYPE_IDS];
  for (const type of options.types) if (!TITAN_TYPE_IDS.includes(type)) throw new Error(`unknown titan type ${type}`);
  if (!options.teams.length) options.teams = options.abilities ? ['alpha'] : ['alpha', 'bravo'];
  if (options.abilities && options.outDir === DEFAULT_OUT_DIR) options.outDir = path.join(DEFAULT_OUT_DIR, 'abilities');
  return options;
}

// ---- capture lock (mkdir + owner file, stale after 15 min, released on exit) -------------
async function acquireLock() {
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(path.join(LOCK, 'owner'), `${process.pid} ${Math.floor(Date.now() / 1000)} titanfall-model-capture\n`);
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

// ---- static server with optional file overlays ----------------------------------------------
async function startServer(overlays) {
  const map = new Map(overlays.map(([pub, local]) => [`/${pub}`, local]));
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const overlay = map.get(url.pathname);
      if (overlay) {
        const body = await readFile(overlay);
        response.writeHead(200, { 'Content-Type': overlay.endsWith('.js') || overlay.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/octet-stream', 'Cache-Control': 'no-store' });
        response.end(body);
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
  const shots = TITAN_CAPTURE_SHOTS.filter(shot => !options.shots.length || options.shots.includes(shot.name));
  const plan = [];
  if (options.abilities) {
    for (const name of Object.keys(TITAN_ABILITY_SHOTS)) if (!options.shots.length || options.shots.includes(name)) {
      for (const team of options.teams) plan.push({ type: TITAN_ABILITY_SHOTS[name].type, team, shot: { name, ability: name, once: true } });
    }
  } else for (const type of options.types) for (const team of options.teams) for (const shot of shots) {
    if (shot.once && type !== options.types[0]) continue;
    if (shot.only && !shot.only.includes(type)) continue;
    plan.push({ type, team, shot });
  }
  const fileName = ({ type, team, shot }) => `${options.prefix ? `${options.prefix}-` : ''}${shot.once ? '' : `${type.replace('titan_', '')}-`}${shot.name}-${team}.png`;
  if (options.list) { for (const entry of plan) console.log(fileName(entry)); return; }
  if (!plan.length) throw new Error('no titan capture matches the selection');
  for (const [, local] of options.overlays) await stat(local);
  const release = options.lock ? await acquireLock() : () => {};
  const { server, base } = await startServer(options.overlays);
  await mkdir(options.outDir, { recursive: true });
  let session = null;
  try {
    const maxW = Math.max(options.width, ...plan.map(entry => entry.shot.width || 0));
    const maxH = Math.max(options.height, ...plan.map(entry => entry.shot.height || 0));
    session = await launchCdpSession(`${base}/vehicle-capture.html?type=${plan[0].type}&manual=1`, { browser: options.browser, width: maxW, height: maxH });
    const page = session.page;
    await page.waitFor('window.titanCapture?.ready === true', { timeoutMs: 60000, label: 'titan capture page' });
    for (const entry of plan) {
      const { type, team, shot } = entry;
      const width = shot.width || options.width, height = shot.height || options.height;
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const params = shot.ability ? { type, team, ability: shot.ability, ...(Number.isFinite(options.at) ? { at: String(options.at) } : {}) } : { type, team, view: shot.view, pose: shot.pose };
      for (const key of ['phase', 'frames', 'aim', 'aimPitch', 'studio', 'yaw']) if (shot[key] !== undefined) params[key] = String(shot[key]);
      Object.assign(params, options.params);
      const result = await page.evaluate(`window.titanCapture.render(${JSON.stringify(params)})`);
      if (page.errors.length) throw new Error(page.errors.join('\n'));
      const shotData = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
      const output = path.join(options.outDir, fileName(entry));
      const bytes = Buffer.from(shotData.data, 'base64');
      if (bytes.length < 10_000) throw new Error(`invalid screenshot output: ${output}`);
      await writeFile(output, bytes);
      for (const expression of options.evals) console.log(`  eval: ${JSON.stringify(await page.evaluate(expression))}`);
      console.log(`${fileName(entry)} -> ${path.relative(PROJECT_ROOT, output)} (${bytes.length} bytes; ${result?.label ?? ''}; root ${result?.rootY?.toFixed?.(2)} pelvis ${result?.pelvisY?.toFixed?.(2)}; fx ${result?.particles ? `${result.particles.alive}/${result.particles.emitters}` : '-'}${result?.clips ? `; embark clips ${result.clips.length ? result.clips.join(', ') : 'none'}` : ''})`);
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
