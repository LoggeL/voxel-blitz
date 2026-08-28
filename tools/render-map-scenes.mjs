import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_CAPTURE_SHOTS } from '../shared/map-capture-shots.js';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, '.artifacts', 'map-renders');
const PLAYWRIGHT_CACHE_DIRS = [
  path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  path.join(os.homedir(), '.cache', 'ms-playwright'),
];
const DEFAULT_BROWSER_PATHS = [
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    all: false,
    list: false,
    map: null,
    shot: null,
    outDir: DEFAULT_OUT_DIR,
    baseUrl: null,
    browser: null,
    width: 1600,
    height: 800,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--all') options.all = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--map') options.map = optionValue(argv, index++, arg);
    else if (arg === '--shot') options.shot = optionValue(argv, index++, arg);
    else if (arg === '--out-dir') options.outDir = path.resolve(optionValue(argv, index++, arg));
    else if (arg === '--base-url') options.baseUrl = optionValue(argv, index++, arg);
    else if (arg === '--browser') options.browser = path.resolve(optionValue(argv, index++, arg));
    else if (arg === '--width') options.width = Number(optionValue(argv, index++, arg));
    else if (arg === '--height') options.height = Number(optionValue(argv, index++, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.width) || options.width < 320) throw new Error('invalid --width');
  if (!Number.isInteger(options.height) || options.height < 180) throw new Error('invalid --height');
  if (options.shot && !options.map) throw new Error('--shot requires --map');
  if (options.all && (options.map || options.shot)) throw new Error('--all cannot be combined with --map or --shot');
  if (options.list && (options.all || options.map || options.shot)) {
    throw new Error('--list cannot be combined with capture selection');
  }
  if (options.baseUrl) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('--base-url must use http or https');
    }
    options.baseUrl = url.href;
  }
  return options;
}

function selectedShots(options) {
  if (options.all || !options.map) return MAP_CAPTURE_SHOTS;
  const matches = MAP_CAPTURE_SHOTS.filter((entry) =>
    entry.map === options.map && (!options.shot || entry.id === options.shot));
  if (!matches.length) throw new Error(`unknown capture selection: ${options.map}/${options.shot || '*'}`);
  return matches;
}

function headlessShellSubdirs() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64']
      : ['chrome-headless-shell-mac-x64', 'chrome-headless-shell-mac-arm64'];
  }
  if (process.platform === 'linux') return ['chrome-headless-shell-linux64'];
  if (process.platform === 'win32') return ['chrome-headless-shell-win64'];
  return [];
}

async function installedHeadlessShells() {
  const candidates = [];
  for (const cacheDir of PLAYWRIGHT_CACHE_DIRS) {
    try {
      const entries = await readdir(cacheDir, { withFileTypes: true });
      const versions = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium_headless_shell-'))
        .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
      for (const entry of versions) {
        for (const subdir of headlessShellSubdirs()) {
          const executable = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
          candidates.push(path.join(cacheDir, entry.name, subdir, executable));
        }
      }
    } catch {}
  }
  return candidates;
}

async function executableBrowser(explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : [...await installedHeadlessShells(), ...DEFAULT_BROWSER_PATHS];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('no supported Chromium browser found; pass --browser /absolute/path');
}

async function waitForBaseUrl(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(new URL('/capture.html', baseUrl), {
        signal: AbortSignal.timeout(500),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`capture server did not become ready: ${baseUrl}`);
}

function run(command, args, options = {}, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} failed (${code ?? signal}): ${stderr || stdout}`));
    });
  });
}

function chromiumArgs(profileDir, dimensions) {
  return [
    '--headless=new',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--hide-scrollbars',
    '--ignore-gpu-blocklist',
    '--use-angle=swiftshader',
    '--run-all-compositor-stages-before-draw',
    `--user-data-dir=${profileDir}`,
    `--window-size=${dimensions.width},${dimensions.height}`,
    '--force-device-scale-factor=1',
    '--virtual-time-budget=3500',
  ];
}

async function renderShot(browser, profileDir, baseUrl, outDir, dimensions, shot) {
  const output = path.join(outDir, `${shot.map}-${shot.id}.png`);
  const url = new URL('/capture.html', baseUrl);
  url.searchParams.set('map', shot.map);
  url.searchParams.set('shot', shot.id);
  const commonArgs = chromiumArgs(profileDir, dimensions);
  const capture = await run(browser, [
    ...commonArgs,
    '--dump-dom',
    `--screenshot=${output}`,
    url.href,
  ]);
  const readyMarkers = [
    'data-capture-ready="true"',
    `data-capture-map="${shot.map}"`,
    `data-capture-shot="${shot.id}"`,
  ];
  if (!readyMarkers.every((marker) => capture.stdout.includes(marker))) {
    throw new Error(`capture page did not confirm ready state: ${shot.map}/${shot.id}`);
  }
  const bytes = await readFile(output);
  if (bytes.length < 10_000 || bytes.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`invalid screenshot output: ${output}`);
  }
  return { ...shot, output, bytes: bytes.length };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const entry of MAP_CAPTURE_SHOTS) console.log(`${entry.map}/${entry.id}`);
    return;
  }

  const shots = selectedShots(options);
  const browser = await executableBrowser(options.browser);
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'voxel-blitz-capture-'));
  let server = null;
  let baseUrl = options.baseUrl;
  try {
    if (!baseUrl) {
      server = startServer({ cwd: PROJECT_ROOT, failureContext: 'map capture' });
      const port = await server.port;
      await waitForHttp(port, { path: '/capture.html' });
      baseUrl = `http://127.0.0.1:${port}`;
    } else {
      await waitForBaseUrl(baseUrl);
    }
    await mkdir(options.outDir, { recursive: true });
    const rendered = [];
    for (const entry of shots) {
      const capture = renderShot(
        browser,
        profileDir,
        baseUrl,
        options.outDir,
        { width: options.width, height: options.height },
        entry,
      );
      const result = server ? await Promise.race([capture, server.unexpectedExit]) : await capture;
      rendered.push(result);
      console.log(`${entry.map}/${entry.id} -> ${result.output} (${result.bytes} bytes)`);
    }
    console.log(`rendered ${rendered.length} scene${rendered.length === 1 ? '' : 's'}`);
  } finally {
    await stopServer(server);
    await rm(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
