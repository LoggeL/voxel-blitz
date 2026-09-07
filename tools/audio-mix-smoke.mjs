import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WEAPON_IDS } from '../shared/combatmath.js';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(PROJECT_ROOT, '.artifacts', 'audio-audit', 'current');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

async function main() {
  const server = startServer({
    cwd: PROJECT_ROOT,
    entry: 'tools/capture-server.mjs',
    failureContext: 'runtime audio mix audit',
  });
  let browser = null;
  try {
    const port = await server.port;
    await waitForHttp(port, { path: '/audio-mix-audit.html' });
    browser = await launchCdpSession(`http://127.0.0.1:${port}/audio-mix-audit.html`);
    const page = browser.page;
    await page.waitFor(`document.documentElement.dataset.audioMixReady === 'true' ||
      !!document.documentElement.dataset.audioMixError`, {
      timeoutMs: 30_000,
      label: 'offline WebAudio mix rendering',
    });
    const result = await page.evaluate(`({
      metrics: window.__vbAudioMixAudit || null,
      report: window.__vbAudioCueAudit || null,
      error: document.documentElement.dataset.audioMixError || '',
    })`);
    if (result.error) throw new Error(result.error);
    requireCondition(result.metrics && Object.keys(result.metrics).join(',') === WEAPON_IDS.join(','),
      'offline WebAudio audit renders the complete weapon roster');
    requireCondition(result.report && Array.isArray(result.report.checks)
      && result.report.checks.length >= 100 && result.report.checks.every((check) => check.passed)
      && result.report.failures.length === 0,
    'actual game-facade scenarios pass every audible, timing and lifecycle check');
    const requiredCues = [
      'Grenade pin', 'Grenade throw, light', 'Grenade throw, full charge',
      ...['frag', 'limpet', 'pulse', 'rocket'].map((type) => `${type} explosion, 4 m`),
      'Frag explosion, 35 m', 'Frag explosion plus 32 block impacts',
      'Minigun, 20-shot burst at 1200 RPM',
      'Flamethrower, 2.4-second hold and release', 'Flamethrower, missing refresh',
      'LONGARC bolt fizzle',
    ];
    requireCondition(requiredCues.every((cue) => result.report.cues?.[cue]),
      'grenade handling, every blast, distance, destruction, burst, loop and fizzle are rendered');
    console.table(Object.entries(result.metrics).map(([weapon, metrics]) => ({
      weapon,
      peak: metrics.peak.toFixed(4),
      rms: metrics.rms.toFixed(4),
      clippedPpm: Math.round(metrics.clippedRatio * 1_000_000),
      onsetMs: metrics.onsetMs.toFixed(2),
      tailMs: metrics.audibleTailMs.toFixed(1),
    })));
    for (const weapon of WEAPON_IDS) {
      const metrics = result.metrics[weapon];
      requireCondition(metrics.peak > 0.015 && metrics.peak <= 1,
        `${weapon} runtime mix is audible and limiter-bounded`);
      requireCondition(metrics.rms > 0.0003 && metrics.rms < 0.5,
        `${weapon} runtime mix RMS remains in a useful range`);
      requireCondition(metrics.clippedRatio <= 0.001,
        `${weapon} runtime mix avoids sustained clipping`);
      const onsetBudget = weapon === 'flamethrower' ? 60 : weapon === 'knife' ? 55 : 20;
      requireCondition(metrics.onsetMs <= onsetBudget && metrics.audibleTailMs >= 40,
        `${weapon} runtime mix preserves its attack timing and an audible tail`);
    }
    const tailOrder = ['sniper', 'revolver', 'shotgun', 'lmg', 'rifle', 'smg'];
    requireCondition(tailOrder.every((weapon, index) => index === 0 ||
      result.metrics[tailOrder[index - 1]].audibleTailMs > result.metrics[weapon].audibleTailMs),
    'runtime mixed tails preserve the intended heavy-to-compact weapon hierarchy');
    const bodyOrder = ['sniper', 'shotgun', 'revolver', 'lmg', 'rifle', 'smg'];
    requireCondition(bodyOrder.every((weapon, index) => index === 0 ||
      result.metrics[bodyOrder[index - 1]].rms > result.metrics[weapon].rms),
    'runtime mixed energy profiles preserve distinct weapon weight');
    await mkdir(OUT_DIR, { recursive: true });
    await Promise.all([
      writeFile(path.join(OUT_DIR, 'runtime-mix.json'), `${JSON.stringify(result.metrics, null, 2)}\n`),
      writeFile(path.join(OUT_DIR, 'runtime-cues.json'), `${JSON.stringify(result.report, null, 2)}\n`),
    ]);
    requireCondition(page.errors.length === 0,
      'runtime WebAudio mix audit completes without browser errors');
    console.log('AUDIO MIX SMOKE: OK');
  } finally {
    await browser?.close();
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
