#!/usr/bin/env node
/**
 * Muted CDP captures of the hold-to-use interaction animations
 * (docs/design/interact-anims/): the first-person hands mid-hold and in the
 * finishing beat for every kind, a cancel, and the third-person pose with the
 * world charge, through public/interact-anim-capture.html (the real
 * ViewmodelRig and avatar). Chromium runs with --mute-audio; the page creates
 * no AudioContext. A page error fails the run (exit 1). Not part of any
 * suite (it needs a local Chromium).
 *
 *   node tools/interact-anims-capture.mjs [--out <dir>] [--sizes desktop,portrait]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const outDir = path.resolve(root, arg('--out', 'docs/design/interact-anims/captures'));
const SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900, mobile: false, touch: false }),
  portrait: Object.freeze({ width: 390, height: 844, mobile: true, touch: true }),
});
const sizes = arg('--sizes', 'desktop').split(',').filter(s => SIZES[s]);
const FIRST = [['plant-1-work', 'plant', 'work', 1500], ['plant-2-armed', 'plant', 'finish', 260], ['defuse-1-work', 'defuse', 'work', 2600],
  ['defuse-2-done', 'defuse', 'finish', 200], ['revive-1-press', 'revive', 'work', 820], ['revive-2-pulse', 'revive', 'finish', 260],
  ['repair-1-sparks', 'repair', 'work', 1430], ['hack-1-typing', 'hack', 'work', 1900], ['hack-2-done', 'hack', 'finish', 250],
  ['cancel-plant-90ms', 'plant', 'cancel', 90]];
const THIRD = [['third-plant', 'plant', 'side'], ['third-defuse', 'defuse', 'side'], ['third-revive', 'revive', 'side'],
  ['third-repair', 'repair', 'side'], ['third-hack', 'hack', 'front'], ['world-charge', 'prop', 'side']];

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', env: { PORT: process.env.PORT || '5021' }, failureContext: 'interact anims capture' });
  const report = { generated: new Date().toISOString(), shots: [], errors: [] };
  try {
    const port = await server.port;
    const size0 = SIZES[sizes[0]];
    const session = await launchCdpSession(`http://127.0.0.1:${port}/interact-anim-capture.html`, { width: size0.width, height: size0.height });
    try {
      const page = session.page;
      await page.waitFor('window.__interact?.ready === true', { timeoutMs: 120000, label: 'interact capture' });
      const shoot = async (size, name) => {
        const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
        const file = path.join(outDir, `${name}.jpg`);
        await writeFile(file, Buffer.from(shot.data, 'base64'));
        return path.relative(root, file);
      };
      for (const sizeId of sizes) {
        const size = SIZES[sizeId];
        await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
        const shots = sizeId === 'desktop' ? FIRST : FIRST.filter(([name]) => name === 'plant-1-work' || name === 'revive-1-press');
        for (const [name, kind, phase, ms] of shots) {
          const info = await page.evaluate(`window.__interact.render(${JSON.stringify({ kind, phase, ms })})`);
          report.shots.push({ size: sizeId, name, file: await shoot(size, `${sizeId}-${name}`), ...info });
          console.log(`${sizeId} ${name} ${info.phase} level ${info.level?.toFixed?.(2)} dip ${info.dip?.toFixed?.(2)}`);
        }
        if (sizeId !== 'desktop') continue;
        for (const [name, kind, view] of THIRD) {
          const info = await page.evaluate(`window.__interact.third(${JSON.stringify({ kind, view, ms: 900 })})`);
          report.shots.push({ size: sizeId, name, file: await shoot(size, name), ...info });
          console.log(`${name} level ${info.level?.toFixed?.(2)}`);
        }
      }
      report.errors.push(...(page.errors ?? []));
    } finally { await session.close(); }
  } catch (error) {
    report.errors.push(String(error?.stack ?? error));
  } finally {
    await stopServer(server);
  }
  await writeFile(path.join(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) { console.error(report.errors.join('\n')); process.exit(1); }
  console.log(`${report.shots.length} shots -> ${path.relative(root, outDir)}`);
}

main().catch(error => { console.error(error); process.exit(1); });
