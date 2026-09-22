import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

export async function executableBrowser(explicitPath = process.env.VB_BROWSER) {
  explicitPath ||= process.env.VB_BROWSER;
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
  return rm(profileDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}

/** Capture one page once its readiness markers appear. Asset-backed captures
 * publish markers after decoded textures and a completed render; waitForLoad
 * also holds static pages until their images and CSS backgrounds have loaded.
 */
export async function captureReadyBrowserPage({
  browser, url, output, dimensions, readyMarkers, minBytes = 10_000, waitForLoad = false,
}) {
  const { launchCdpSession } = await import('./cdp-session.mjs');
  const session = await launchCdpSession(url, { browser, ...dimensions });
  try {
    await session.page.waitFor(`${waitForLoad ? "document.readyState === 'complete' && " : ''}${JSON.stringify(readyMarkers)}.every(marker => document.documentElement.outerHTML.includes(marker))`,
      { timeoutMs: 30000, label: 'asset capture ready' });
    if (session.page.errors.length) throw new Error(session.page.errors.join('\n'));
    const shot = await session.page.send('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(shot.data, 'base64');
    if (bytes.length < minBytes) throw new Error(`invalid screenshot output: ${output}`);
    await writeFile(output, bytes);
    return bytes.length;
  } finally { await session.close(); }
}
