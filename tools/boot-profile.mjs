// Measure the real browser boot: start the server, open the game in headless
// Chromium, wait for the startup screen to close (interactive menu) and report
// what was transferred by then, then wait for the background asset scheduler
// to go idle and report the total. Usage: node tools/boot-profile.mjs [--json] [--repeat] [--top]
// --repeat reloads once more in the same profile to measure a warm cache.
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const args = new Set(process.argv.slice(2));
const server = startServer();
let session = null;
try {
  const port = await server.port;
  const url = `http://127.0.0.1:${port}/`;
  session = await launchCdpSession(url);
  // The default resource-timing buffer (250 entries) is smaller than the boot.
  await session.page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'performance.setResourceTimingBufferSize(4000);' });
  const reload = async (ignoreCache) => {
    // Mark the old document so the wait below only accepts the new one.
    await session.page.evaluate('window.__vbStaleDocument = true; true');
    await session.page.send('Page.reload', { ignoreCache });
  };
  const summarize = (label, filter) => session.page.evaluate(`(() => {
      const boot = window.__vbBoot || {};
      const menuAt = (boot.startedAt || 0) + (boot.readyMs || 0);
      const entries = performance.getEntriesByType('resource')${filter === 'menu' ? '.filter((e) => e.responseEnd <= menuAt)' : ''};
      const byType = {};
      let transfer = 0, decoded = 0, encoded = 0;
      for (const e of entries) {
        const ext = (new URL(e.name).pathname.match(/\\.([a-z0-9]+)$/i)?.[1] || 'other').toLowerCase();
        const row = byType[ext] ??= { count: 0, transfer: 0, decoded: 0, cached: 0 };
        row.count++; row.transfer += e.transferSize; row.decoded += e.decodedBodySize;
        if (e.transferSize === 0 && e.decodedBodySize > 0) row.cached++;
        transfer += e.transferSize; decoded += e.decodedBodySize; encoded += e.encodedBodySize;
      }
      const nav = performance.getEntriesByType('navigation')[0];
      const top = entries.slice().sort((a, b) => b.transferSize - a.transferSize).slice(0, 12)
        .map((e) => ({ name: new URL(e.name).pathname, transfer: e.transferSize, decoded: e.decodedBodySize }));
      const assets = window.__vbAssets?.status || null;
      return { requests: entries.length, transfer, encoded, decoded, byType, top,
        bootMs: boot.readyMs ?? null, phases: boot.phases ?? null,
        assets: assets ? { done: assets.done, total: assets.total, failed: assets.failed, idle: assets.idle, timings: assets.timings } : null,
        domInteractiveMs: nav ? Math.round(nav.domInteractive) : null };
    })()`);
  const print = (label, summary) => {
    summary.errors = session.page.errors.slice();
    if (args.has('--json')) { console.log(JSON.stringify({ label, ...summary }, null, 1)); return; }
    const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
    console.log(`[${label}] ${summary.bootMs != null ? `menu interactive after ${summary.bootMs} ms · ` : ''}${summary.requests} requests · ${mb(summary.transfer)} on the wire · ${mb(summary.decoded)} decoded`);
    for (const [ext, row] of Object.entries(summary.byType).sort((a, b) => b[1].transfer - a[1].transfer)) {
      console.log(`  ${ext.padEnd(6)} ${String(row.count).padStart(4)} files  ${mb(row.transfer).padStart(9)} wire  ${mb(row.decoded).padStart(9)} decoded${row.cached ? `  (${row.cached} from cache)` : ''}`);
    }
    if (summary.phases) console.log('  phases', JSON.stringify(summary.phases));
    if (summary.assets) console.log(`  background assets ${summary.assets.done}/${summary.assets.total} done${summary.assets.failed ? `, ${summary.assets.failed} failed` : ''} · task ms ${JSON.stringify(summary.assets.timings)}`);
    if (args.has('--top')) for (const row of summary.top) console.log(`    ${mb(row.transfer).padStart(9)}  ${row.name}`);
    if (summary.errors.length) console.log('  browser errors:', summary.errors.join(' | '));
  };
  const report = async (label) => {
    await session.page.waitFor(`(() => {
      const screen = document.getElementById('loading-screen');
      return !window.__vbStaleDocument && !!screen && (window.__vbBoot?.readyMs > 0 || !screen.open);
    })()`, { timeoutMs: 120_000, label: 'startup screen closed' });
    print(`${label} · menu`, await summarize(label, 'menu'));
    await session.page.waitFor('window.__vbAssets?.idle === true',
      { timeoutMs: 180_000, label: 'background assets idle' });
    print(`${label} · all assets`, await summarize(label, 'all'));
  };
  await reload(true);
  await report('cold');
  if (args.has('--repeat')) {
    await reload(false);
    await report('warm');
  }
} finally {
  await session?.close();
  await stopServer(server);
}
