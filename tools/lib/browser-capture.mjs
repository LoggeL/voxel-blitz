import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
          const executable = process.platform === 'win32'
            ? 'chrome-headless-shell.exe'
            : 'chrome-headless-shell';
          candidates.push(path.join(cacheDir, entry.name, subdir, executable));
        }
      }
    } catch {}
  }
  return candidates;
}

export async function executableBrowser(explicitPath) {
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

export function createBrowserProfile(prefix = 'voxel-blitz-capture-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export function removeBrowserProfile(profileDir) {
  return rm(profileDir, { recursive: true, force: true });
}

function run(command, args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
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

function chromiumArgs(profileDir, { width, height }) {
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
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=1',
    '--virtual-time-budget=3500',
  ];
}

/** Capture and verify one page load; readiness markers and PNG share the same Chromium run. */
export async function captureBrowserPage({
  browser,
  profileDir,
  url,
  output,
  dimensions,
  readyMarkers,
  minBytes = 10_000,
  attempts = 2,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const capture = await run(browser, [
        ...chromiumArgs(profileDir, dimensions),
        '--dump-dom',
        `--screenshot=${output}`,
        url,
      ]);
      if (!readyMarkers.every((marker) => capture.stdout.includes(marker))) {
        throw new Error(`capture page did not confirm ready state: ${url}`);
      }
      const bytes = await readFile(output);
      if (bytes.length < minBytes || bytes.toString('ascii', 1, 4) !== 'PNG') {
        throw new Error(`invalid screenshot output: ${output}`);
      }
      return bytes.length;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
