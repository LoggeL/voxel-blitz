import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';

import {
  captureBrowserPage,
  createBrowserProfile,
  executableBrowser,
  removeBrowserProfile,
} from './lib/browser-capture.mjs';

const root = process.cwd();
const source = path.join(root, 'tools', 'brand-card.html');
const output = path.join(root, 'public', 'assets', 'brand', 'voxel-blitz-og.png');
await mkdir(path.dirname(output), { recursive: true });
const browser = await executableBrowser(process.env.VB_BROWSER || null);
const profileDir = await createBrowserProfile('voxel-blitz-brand-');
try {
  const bytes = await captureBrowserPage({
    browser,
    profileDir,
    url: pathToFileURL(source).href,
    output,
    dimensions: { width: 1200, height: 630 },
    readyMarkers: ['voxel-blitz-brand-card'],
    minBytes: 40_000,
  });
  console.log(`rendered ${path.relative(root, output)} (${bytes} bytes)`);
} finally {
  await removeBrowserProfile(profileDir);
}
