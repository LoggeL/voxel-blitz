import { loadingScreen, formatBytes } from './ui/loading-screen.js';

// Startup stages weighted by their share of a cold menu load: the menu's
// module graph, then the two account requests. Every stage reports real
// requests, never elapsed time. three.js, the Blender weapon/operator library,
// the sound samples and the match systems load in the background after the
// menu is interactive (see the asset scheduler in main.js); readyMs is the
// time to an interactive menu.
const startedAt = performance.now();
const moduleCount = Number(document.querySelector('meta[name="vb-module-count"]')?.content) || 0;
const boot = { startedAt, readyMs: 0, menuReadyMs: 0, phases: {}, modules: { done: 0, total: moduleCount, bytes: 0 } };
window.__vbBoot = boot;

loadingScreen?.show('boot', { status: 'Loading game systems…' });
loadingScreen?.setPlan([
  { id: 'modules', label: 'GAME SYSTEMS', weight: 70 },
  { id: 'account', label: 'ACCOUNT', weight: 12 },
  { id: 'career', label: 'CAREER & EQUIPMENT', weight: 18 },
], { startedAt });
loadingScreen?.step('modules', { status: 'active', done: 0, total: moduleCount });

// Count module responses as they land so the rail moves during the import.
let observer = null;
const countModules = (entries) => {
  for (const entry of entries) {
    if (!/\.js(\?|$)/.test(entry.name)) continue;
    boot.modules.done++;
    boot.modules.bytes += entry.transferSize || entry.encodedBodySize || 0;
  }
  const { done, total, bytes } = boot.modules;
  const size = formatBytes(bytes);
  loadingScreen?.step('modules', { done, total: total || Math.max(done, 1),
    detail: `${done}${total ? ` / ${total}` : ''} MODULES${size ? ` · ${size}` : ''}` });
};
try {
  countModules(performance.getEntriesByType('resource'));
  observer = new PerformanceObserver((list) => countModules(list.getEntries()));
  observer.observe({ type: 'resource', buffered: false });
} catch { /* progress detail is optional */ }

try {
  await import('./main.js');
  observer?.disconnect();
  boot.phases.modules = boot.phases.modules ?? Math.round(performance.now() - startedAt);
  boot.readyMs = boot.menuReadyMs = Math.round(performance.now() - startedAt);
  loadingScreen?.hide();
} catch (error) {
  observer?.disconnect();
  console.error('[vb] startup failed:', error);
  loadingScreen?.fail('The game could not start. Check your connection and reload.');
}
