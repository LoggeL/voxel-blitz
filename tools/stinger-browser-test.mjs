import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { runCaptureFlow } from './lib/capture-flow.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/design/stinger');
const desktop = ['held', 'scoped', 'lock-acquire', 'lock-ready', 'empty', 'firing',
  'reload-open', 'reload-eject', 'reload-load', 'reload-charge'];
const shots = [
  ...desktop.map(state => ({ state, layout: 'desktop', width: 1600, height: 800 })),
  ...['held', 'scoped', 'lock-ready', 'reload-open', 'reload-load'].map(state =>
    ({ state, layout: 'mobile', width: 844, height: 390 })),
  ...['held', 'scoped', 'reload-load'].map(state =>
    ({ state, layout: 'portrait', width: 390, height: 844 })),
  ...['hero', 'left', 'rear'].map(angle => ({ state: 'held', angle, layout: 'inspection', width: 1400, height: 850 })),
];
const rows = await runCaptureFlow({
  options: { outDir, browser: null, baseUrl: null, width: 1600, height: 800 },
  projectRoot: root, route: '/weapon-capture.html', failureContext: 'stinger presentation', shots,
  formatShot: shot => `${shot.layout}/${shot.angle || shot.state}`,
  async captureShot({ browser, baseUrl, shot }) {
    const url = new URL('/weapon-capture.html', baseUrl);
    url.searchParams.set('weapon', 'stinger'); url.searchParams.set('state', shot.state);
    if (shot.angle) url.searchParams.set('angle', shot.angle);
    const session = await launchCdpSession(url.href, { browser, width: shot.width, height: shot.height });
    try {
      await session.page.waitFor('document.documentElement.dataset.captureReady === "true"',
        { timeoutMs: 30000, label: 'Stinger capture ready' });
      assert.deepEqual(session.page.errors, [], 'browser has no rendering errors');
      const state = await session.page.evaluate('window.__vbWeaponCapture');
      assert.equal(state.weapon, 'stinger'); assert.equal(state.stinger.finite, true);
      assert.equal(state.stinger.surfaces.length, 3, 'all three ImageGen materials are applied to the runtime model');
      assert.ok(state.stinger.surfaces.every(map => map.width > 0 && map.height > 0 && map.bump > 0),
        'ImageGen textures are decoded and supply the material detail');
      const lit = state.stinger.lamps.filter(value => value > 1).length;
      if (shot.state === 'lock-acquire') assert.equal(lit, 3);
      if (['lock-ready', 'scoped'].includes(shot.state)) assert.equal(lit, 5);
      if (shot.state === 'empty' || shot.state === 'firing' || shot.state.startsWith('reload-')) assert.equal(lit, 0);
      if (shot.state === 'empty' || shot.state === 'firing') assert.equal(state.stinger.cover, false);
      if (shot.state === 'reload-load') {
        assert.equal(state.stinger.canister.visible, true);
        assert.ok(state.stinger.canister.position[1] > 0.05, 'new canister clears the saddle');
        assert.ok(state.stinger.canister.position[2] < -0.30, 'raised canister clears the first-person camera');
      }
      if (shot.state === 'reload-open') assert.ok(state.stinger.clamps.every(angle => angle < -1), 'lids open away from tube');
      if (shot.state === 'reload-charge') assert.ok(state.stinger.clamps.every(angle => Math.abs(angle) < 1e-8));
      if (shot.angle) assert.ok(state.renderInfo.triangles < 5000, 'inspection geometry remains inexpensive');
      const output = path.join(outDir, shot.layout, `stinger-${shot.angle || shot.state}.png`);
      await mkdir(path.dirname(output), { recursive: true });
      const png = await session.page.send('Page.captureScreenshot', { format: 'png' });
      const bytes = Buffer.from(png.data, 'base64');
      assert.ok(bytes.length > 3000, 'render produced a nonempty PNG');
      await writeFile(output, bytes);
      return { ...shot, output, bytes: bytes.length, state: state.state, renderInfo: state.renderInfo,
        presentation: state.stinger, browserErrors: [...session.page.errors] };
    } finally { await session.close(); }
  },
});
await writeFile(path.join(outDir, 'browser-report.json'), JSON.stringify(rows, null, 2) + '\n');
console.log(`Stinger browser: ${rows.length} captures; real viewmodel, decoded textures, lock/ammo readback, staged reload, desktop/mobile/portrait; no browser errors.`);
