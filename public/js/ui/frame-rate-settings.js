import { FPS_MODES, fpsMode, setFpsMode } from '../engine/frame-rate.js';
import { el } from './hud-support.js';

/** Frame-rate controls and the measured explanation share one display card. */
export class FrameRateSettings {
  mount(parent) {
    this.root = el('section', 'vb-frame-settings', parent);
    this.root.setAttribute('aria-label', 'Frame rate');
    const row = el('div', 'vb-setting-row', this.root);
    const header = el('div', 'vb-setting-header', row);
    const label = el('label', 'vb-label', header);
    label.textContent = 'FRAME RATE MODE';
    label.htmlFor = 'settings-fps-mode';
    this.select = el('select', 'vb-select', row, 'settings-fps-mode');
    this.select.setAttribute('aria-describedby', 'settings-fps-help');
    for (const mode of FPS_MODES) {
      const option = el('option', '', this.select);
      option.value = mode.value;
      option.textContent = mode.label;
    }
    this.select.value = fpsMode();
    this.select.addEventListener('change', () => {
      setFpsMode(this.select.value);
      this.update(null);
    });
    el('p', 'vb-frame-help', this.root, 'settings-fps-help').textContent = 'Lower caps reduce rendering work. Display sync adds no game cap. All modes follow browser timing; a higher cap needs enough display and device headroom. Input and network updates keep their normal cadence.';
    const card = el('div', 'vb-frame-diagnostics', this.root);
    this.status = el('strong', '', card, 'settings-fps-status');
    this.metrics = el('p', 'vb-frame-metrics', card, 'settings-fps-metrics');
    this.detail = el('p', '', card, 'settings-fps-detail');
    el('p', 'vb-frame-help', card).textContent = 'CPU timing includes game work and render submission, not GPU execution. GPU timing and monitor Hz are unavailable. Caps that do not divide the browser cadence can produce uneven frame spacing.';
    this.update(null);
    return this.root;
  }

  update(stats) {
    if (!this.root || (stats && this.lastStats === stats)) return;
    this.lastStats = stats;
    this.select.value = fpsMode();
    this.status.textContent = stats?.limit.label || 'MEASURING';
    this.detail.textContent = stats?.limit.detail || 'Collecting a fresh second of gameplay timing.';
    this.root.dataset.limit = stats?.limit.code || 'measuring';
    this.metrics.textContent = stats?.ready
      ? `${Math.round(stats.renderedFps)} rendered FPS · ${stats.renderedFps > 0 ? (1000 / stats.renderedFps).toFixed(1) : '--'} ms/frame · ${Math.round(stats.callbackFps)} browser callbacks/s · ${stats.cpuMs.toFixed(1)} ms CPU/callback · ${stats.renderSubmitMs.toFixed(1)} ms render submission`
      : 'FPS -- · frame time --';
  }
}
