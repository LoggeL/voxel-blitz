#!/usr/bin/env node
/**
 * Muted CDP captures of the weapon wheel over the static Conquest HUD fixture
 * page (public/conquest-hud-capture.html, window.__cq.wheel): the real wheel
 * overlay fed by the session WeaponWheelController with each kit's
 * authoritative owned list and issued ammo, at desktop 1440x900, phone
 * portrait 390x844 and phone landscape 844x390 (touch). A TDM case renders the
 * unchanged full wheel for comparison. No live match, no audio.
 *
 *   node tools/conquest-weapon-wheel-capture.mjs [--out <dir>] [--sizes desktop,portrait,landscape]
 *
 * Fails (exit 1) on browser errors, on a wheel slot outside the viewport, or
 * when two Conquest wheel slots overlap.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';
import { CAPTURE_SIZES } from './conquest-hud-capture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const outDir = path.resolve(root, arg('--out', 'docs/design/conquest/weapon-wheel/captures'));
const sizes = arg('--sizes', 'desktop,portrait,landscape').split(',').map(s => s.trim()).filter(s => CAPTURE_SIZES[s]);

/** Wheel cases: kit, variant, gadget choice, mode, equipped role and hovered segment. */
const CASES = Object.freeze([
  { id: 'engineer-at', kit: 'engineer', variant: 0, gadget: 0, current: 'primary', hover: 1 },
  { id: 'engineer-aa', kit: 'engineer', variant: 1, gadget: 1, current: 'gadget', hover: 1 },
  { id: 'assault', kit: 'assault', variant: 0, current: 'primary', hover: 2 },
  { id: 'support-minigun', kit: 'support', variant: 1, current: 'sidearm', hover: 0 },
  { id: 'tdm-full', kit: 'assault', mode: 'tdm', current: 'primary', hover: 1 },
]);

/** Expected kit segments (role caption, key badge) per Conquest case, clockwise from the top. */
const EXPECTED = Object.freeze({
  'engineer-at': [['PRIMARY', '2'], ['GADGET · AT', '8'], ['SIDEARM', '6'], ['MELEE', '0']],
  'engineer-aa': [['PRIMARY', '3'], ['GADGET · AA', '8'], ['SIDEARM', '6'], ['MELEE', '0']],
  assault: [['PRIMARY', '1'], ['SIDEARM', '6'], ['MELEE', '0']],
  'support-minigun': [['PRIMARY', ''], ['SIDEARM', '6'], ['MELEE', '0']],
});
/** What a flick to each segment equips with the melee drawn (melee itself is already current). */
const FLICK = Object.freeze({
  'engineer-at': ['smg', 'rocket', 'revolver', null],
  'engineer-aa': ['shotgun', 'stinger', 'revolver', null],
  assault: ['rifle', 'revolver', null],
  'support-minigun': ['minigun', 'revolver', null],
});

const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'conquest weapon wheel capture' });
let browser = null;
const report = { generated: new Date().toISOString(), sizes: {}, problems: [], errors: [] };
try {
  await mkdir(outDir, { recursive: true });
  const port = await server.port;
  browser = await launchCdpSession(`http://127.0.0.1:${port}/conquest-hud-capture.html`, { width: 1440, height: 1037 });
  const page = browser.page;
  await page.waitFor('window.__cq?.ready === true', { label: 'capture page ready' });
  for (const sizeId of sizes) {
    const size = CAPTURE_SIZES[sizeId];
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
    await page.send('Emulation.setTouchEmulationEnabled', size.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    report.sizes[sizeId] = [];
    for (const item of CASES) {
      const info = await page.evaluate(`window.__cq.wheel(${JSON.stringify({ ...item, touch: size.touch })}).then(({ flick, ...rest }) => rest)`);
      // Let the icon images decode before the screenshot.
      await page.evaluate(`Promise.all([...document.querySelectorAll('#weapon-wheel img')].map(img => img.decode().catch(() => {})))`);
      const slots = await page.evaluate(`[...document.querySelectorAll('#weapon-wheel .vb-wheel-slot')].map(node => {
        const r = node.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, hl: node.classList.contains('is-hl'), text: node.innerText.replace(/\\s+/g, ' ').trim() };
      })`);
      const problems = [];
      const expected = EXPECTED[item.id];
      if (expected) {
        if (!info.kit) problems.push('kit layout class missing');
        const got = info.dom.map(d => `${d.role}|${d.key}`).join(' ');
        const want = expected.map(([role, key]) => `${role}|${key}`).join(' ');
        if (got !== want) problems.push(`segments ${got} != ${want}`);
        if (info.dom.some(d => d.locked)) problems.push('locked segment shown');
        if (info.dom.filter(d => d.current).length !== 1) problems.push('exactly one equipped segment expected');
      } else if (info.kit || info.count !== 15) problems.push('full wheel changed outside Conquest');
      for (const [i, s] of slots.entries()) {
        if (s.left < -0.5 || s.top < -0.5 || s.right > size.width + 0.5 || s.bottom > size.height + 0.5) problems.push(`slot ${i} outside viewport`);
      }
      if (item.mode !== 'tdm') {
        for (let i = 0; i < slots.length; i++) {
          for (let j = i + 1; j < slots.length; j++) {
            const a = slots[i], b = slots[j];
            if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) problems.push(`slots ${i} × ${j} overlap`);
          }
        }
      }
      const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(outDir, `${sizeId}-${item.id}.png`);
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      if (problems.length) report.problems.push({ size: sizeId, id: item.id, problems });
      report.sizes[sizeId].push({ id: item.id, file: path.relative(root, file), ids: info.ids, slots: slots.map(s => s.text), problems });
      console.log(`${sizeId.padEnd(9)} ${item.id.padEnd(16)} ${info.ids.join(',')} ${problems.length ? `PROBLEM ${problems.join(', ')}` : 'ok'}`);
    }
  }
  // Flick selection through the real overlay geometry (desktop metrics).
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const item of CASES.filter(c => EXPECTED[c.id])) {
    const equipped = await page.evaluate(`window.__cq.wheelFlick(${JSON.stringify({ ...item, current: 'melee' })})`);
    const want = FLICK[item.id];
    const ok = equipped.join() === want.join();
    if (!ok) report.problems.push({ size: 'desktop', id: `${item.id}-flick`, problems: [`flick equipped ${equipped.join()} != ${want.join()}`] });
    console.log(`flick     ${item.id.padEnd(16)} ${equipped.map(id => id ?? 'none').join(',')} ${ok ? 'ok' : 'PROBLEM'}`);
  }
  report.errors = [...page.errors];
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
await writeFile(path.join(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (report.errors.length) console.error(`Browser errors:\n  ${report.errors.join('\n  ')}`);
const failed = report.errors.length > 0 || report.problems.length > 0;
console.log(`${failed ? 'FAILED' : 'Captured'} weapon wheel states into ${path.relative(root, outDir)}`);
process.exitCode = failed ? 1 : 0;
