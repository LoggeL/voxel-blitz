#!/usr/bin/env node
/** Real ViewmodelRig and HUD, stepped on a deterministic clock with ammo snapshots.
 * Chromium is muted. No server simulation or AudioContext is needed for these
 * presentation checks. Run: node tools/thunderbolt-browser-test.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'docs/design/thunderbolt/captures/verified');
const sizes = [
  { id: 'desktop', width: 1920, height: 1080, mobile: false },
  { id: 'portrait', width: 390, height: 844, mobile: true },
  { id: 'landscape', width: 844, height: 390, mobile: true },
];
const cases = [
  { id: 'full', state: 'full', mag: 4, expected: 4, angle: 0 },
  ...[1, 2, 3, 4].map(shots => ({ id: `after-${shots}-shot${shots > 1 ? 's' : ''}`,
    state: 'fire', mag: 5 - shots, fireElapsed: 1.3, expected: 4 - shots, angle: shots * Math.PI / 2 })),
  { id: 'mid-index', state: 'fire', mag: 4, fireElapsed: 0.15, expected: 3 },
  { id: 'reload', state: 'reload', mag: 0, reloadProgress: 0.42, expected: 0, angle: 0 },
  { id: 'reload-unconfirmed', state: 'reload', mag: 0, reloadProgress: 1, expected: 0, angle: 2 * Math.PI },
  { id: 'refilled', state: 'reload', mag: 4, reloadProgress: 1, expected: 4, angle: 0 },
];

await mkdir(outDir, { recursive: true });
const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'thunderbolt browser validation' });
const report = { shots: [], errors: [] };
let session;
try {
  session = await launchCdpSession(`http://127.0.0.1:${await server.port}/titanfall-weapon-capture.html`, sizes[0]);
  const page = session.page;
  await page.waitFor('window.__tfw?.ready === true', { timeoutMs: 90000, label: 'thunderbolt capture page' });
  for (const size of sizes) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: size.width, height: size.height, mobile: size.mobile, deviceScaleFactor: 1,
    });
    for (const fixture of cases) {
      const { id, expected, angle, ...params } = fixture;
      const result = await page.evaluate(`window.__tfw.render(${JSON.stringify({
        weapon: 'thunderbolt', touch: size.mobile, ...params,
      })})`);
      const where = `${size.id}/${id}`;
      const parts = result.thunderbolt;
      assert.ok(parts, `${where}: real TB-4 parts present`);
      assert.equal(parts.source, 'thunderbolt', `${where}: actual Blender export is loaded`);
      assert.equal(result.ammo, expected, `${where}: snapshot ammunition`);
      assert.equal(result.hudAmmo, expected, `${where}: HUD ammunition`);
      assert.equal(result.display.mag, expected, `${where}: on-gun display ammunition`);
      assert.equal(result.displayMounted, true, `${where}: on-gun display is mounted`);
      assert.equal(result.live, size.id !== 'portrait', `${where}: offscreen counter keeps the HUD ammo card`);
      assert.equal(parts.authoritativeMag, expected, `${where}: animation reads the snapshot`);
      assert.equal(parts.visibleRounds, expected, `${where}: visible orbs match ammunition`);
      assert.ok(parts.rounds.every(part => [...part.position, ...part.rotation].every(Number.isFinite)),
        `${where}: finite orb transforms`);
      if (params.state === 'fire') assert.equal(result.fired, true, `${where}: rig accepted shot`);
      if (angle != null) assert.ok(Math.abs(parts.rotor.rotation[2] - angle) < 1e-6,
        `${where}: indexed rotor angle ${parts.rotor.rotation[2]}`);
      if (id === 'mid-index') {
        assert.ok(parts.rotor.rotation[2] > 0.1 && parts.rotor.rotation[2] < Math.PI / 2 - 0.1,
          `${where}: quarter turn is animated`);
        assert.equal(parts.arcsVisible, true, `${where}: electric discharge arcs`);
      }
      if (id === 'reload') assert.equal(parts.reloading, true, `${where}: reload is active`);
      if (id === 'reload-unconfirmed') {
        assert.equal(parts.energyVisible, false, `${where}: timer never creates an orb`);
        assert.equal(parts.reloading, false, `${where}: reload finished without a refill snapshot`);
      }
      assert.equal(page.errors.length, 0, page.errors.join('\n'));
      const screenshot = await page.send('Page.captureScreenshot', {
        format: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
      });
      const file = `${size.id}-${id}.png`;
      const bytes = Buffer.from(screenshot.data, 'base64');
      assert.ok(bytes.length > 10000, `${where}: rendered PNG`);
      await writeFile(path.join(outDir, file), bytes);
      report.shots.push({ size: size.id, width: size.width, height: size.height, state: id, file, ...result });
      console.log(`${where}: ${parts.visibleRounds} orbs, ${parts.rotor.rotation[2].toFixed(4)} rad, HUD ${result.hudAmmo}`);
    }
  }
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, mobile: false, deviceScaleFactor: 1,
  });
  const hero = await page.evaluate('window.__tfw.inspect({ weapon: "thunderbolt", mag: 4 })');
  assert.equal(hero.thunderbolt.visibleRounds, 4, 'hero: real loaded rotor');
  assert.ok(hero.bounds.size.every(value => Number.isFinite(value) && value > 0), 'hero: finite model bounds');
  const heroShot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(outDir, 'hero.png'), Buffer.from(heroShot.data, 'base64'));
  report.hero = { file: 'hero.png', ...hero };
  report.errors.push(...page.errors);
} catch (error) {
  report.errors.push(String(error?.stack ?? error));
} finally {
  await session?.close();
  await stopServer(server);
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
console.log(`TB-4 browser: ${report.shots.length} verified PNGs -> ${path.relative(root, outDir)}`);
