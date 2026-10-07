#!/usr/bin/env node
/**
 * Conquest v2 visual captures, one muted CDP browser at a time:
 *   1. world   tools/render-map-scenes.mjs   (Frontier shots, overview, weather moods)
 *   2. vehicles tools/conquest-vehicle-capture.mjs (public/vehicle-capture.html)
 *   3. hud     tools/conquest-hud-capture.mjs (public/conquest-hud-capture.html, desktop + phones)
 *
 * Every child uses tools/lib/cdp-session.mjs (--mute-audio) on static capture
 * pages; none opens a live match, so no game audio plays. The steps run
 * strictly in sequence. Not part of conquest:test.
 *
 *   node tools/conquest-capture.mjs [--only world,vehicles,hud]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURES = path.join(ROOT, 'docs', 'design', 'conquest', 'redesign', 'captures');
const WORLD_SHOTS = ['vista', 'farm', 'village-street', 'bridge', 'trenches', 'works', 'tank-forest', 'heli-river', 'jet-sky', 'wreck-column'];

const scene = (args) => ['tools/render-map-scenes.mjs', '--map', 'frontier', '--vehicles',
  '--out-dir', path.join(CAPTURES, 'world'), ...args];

const STEPS = Object.freeze({
  world: [
    // The muted CDP session's viewport is the window size (no browser chrome):
    // 1440 x 900 frames, and a square overview so the orthographic map is not stretched.
    ...WORLD_SHOTS.map(shot => scene(['--shot', shot, '--width', '1440', '--height', '900'])),
    scene(['--shot', 'overview', '--width', '1024', '--height', '1024']),
    ...['mist', 'overcast'].map(weather => scene(['--shot', 'vista', '--weather', weather, '--width', '1440', '--height', '900'])),
  ],
  vehicles: [['tools/conquest-vehicle-capture.mjs', '--out-dir', path.join(CAPTURES, 'vehicles')]],
  hud: [['tools/conquest-hud-capture.mjs', '--out', path.join(CAPTURES, 'hud')]],
});

const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? String(process.argv[onlyIndex + 1] || '').split(',').filter(Boolean) : Object.keys(STEPS);
const unknown = only.filter(id => !STEPS[id]);
if (unknown.length) {
  console.error(`unknown capture group: ${unknown.join(', ')} (expected ${Object.keys(STEPS).join(', ')})`);
  process.exit(2);
}

let failed = 0;
for (const group of only) {
  for (const args of STEPS[group]) {
    console.log(`[conquest:capture] ${group}: node ${args.join(' ')}`);
    const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    if (result.status !== 0) {
      failed++;
      console.error(`[conquest:capture] ${group} step failed with exit ${result.status ?? result.signal}`);
    }
  }
}
process.exit(failed ? 1 : 0);
