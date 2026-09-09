/** Render pacing stays separate from input, prediction, and network updates. */
export const FPS_MODES = Object.freeze([
  { value: 'native', label: 'DISPLAY SYNC (NO CAP)', fps: 0 },
  ...[30, 60, 90, 120, 144, 165, 240, 360].map(fps => ({ value: String(fps), label: `${fps} FPS`, fps })),
]);
export const FPS_PREF_KEY = 'vb-fps-mode';
export function normalizeFpsMode(value) {
  return FPS_MODES.some(mode => mode.value === value) ? value : 'native';
}
let mode = 'native';
try { mode = normalizeFpsMode(localStorage.getItem(FPS_PREF_KEY)); } catch {}
export function fpsMode() { return mode; }
export function setFpsMode(value) {
  mode = normalizeFpsMode(value);
  try { localStorage.setItem(FPS_PREF_KEY, mode); } catch {}
}

export function explainFrameRate(stats) {
  if (stats.hidden) return { code: 'hidden', label: 'TAB HIDDEN', detail: 'Rendering pauses while this tab is hidden. The browser can also suspend frame callbacks.' };
  if (!stats.ready) return { code: 'measuring', label: 'MEASURING', detail: 'Collecting a fresh second of gameplay timing.' };
  const { targetFps, renderedFps, callbackFps, callbackMs, cpuRenderFrameMs, callbackP95Ms } = stats;
  if (targetFps && renderedFps >= targetFps * 0.96) {
    return { code: 'target', label: `AT ${targetFps} FPS TARGET`, detail: stats.skippedFrames > 0
      ? `The selected ${targetFps} FPS cap is pacing rendering. Choose a higher cap or Display sync to allow more frames.`
      : `Rendering is at the selected ${targetFps} FPS target. Browser pacing may also match this rate; a higher setting cannot guarantee more frames.` };
  }
  if (cpuRenderFrameMs >= callbackMs * 0.8) {
    return { code: 'work', label: 'FRAME WORK LIKELY', detail: `Game updates and render submission take ${cpuRenderFrameMs.toFixed(1)} ms per rendered frame. That uses most of the observed frame interval. CPU work or graphics-driver stalls may contribute.` };
  }
  if (stats.callbackSamples >= 20 && callbackP95Ms <= callbackMs * 1.35) {
    return { code: 'browser', label: 'BROWSER PACING', detail: `The browser currently provides about ${Math.round(callbackFps)} frame callbacks/s${targetFps ? ` for a ${targetFps} FPS target` : ''}. Rendering cannot exceed that cadence. Display sync, browser/OS power limits, or GPU load can cause this; monitor Hz is not detected.` };
  }
  return { code: 'unknown', label: 'LIMIT UNCLEAR', detail: 'Frame callbacks are uneven. GPU load, other browser tasks, or OS scheduling may be involved. These timings cannot isolate the cause.' };
}

export class FrameRateController {
  constructor() { this.reset(); }

  reset(value = fpsMode(), hidden = false) {
    this.mode = normalizeFpsMode(value);
    this.targetFps = FPS_MODES.find(option => option.value === this.mode).fps;
    this.hidden = hidden;
    this.nextRenderAt = null;
    this.lastAt = null;
    this.windowStart = null;
    this.intervals = [];
    this.renderedFrames = 0;
    this.skippedFrames = 0;
    this.cpuMs = 0;
    this.cpuRenderMs = 0;
    this.renderSubmitMs = 0;
    this.snapshot = { mode: this.mode, targetFps: this.targetFps, ready: false, hidden };
    this.snapshot.limit = explainFrameRate(this.snapshot);
  }

  /** Called on every browser callback, including callbacks without a render. */
  begin(atMs, hidden = false, value = fpsMode()) {
    if (normalizeFpsMode(value) !== this.mode || hidden !== this.hidden
      || (this.lastAt != null && (atMs - this.lastAt > 2000 || atMs < this.lastAt))) {
      this.reset(value, hidden);
    }
    this.sampleFrame = !hidden && this.lastAt != null && atMs > this.lastAt;
    if (this.sampleFrame) this.intervals.push(atMs - this.lastAt);
    this.lastAt = atMs;
    this.windowStart ??= atMs;
    this.render = false;
    if (hidden) return false;
    if (!this.targetFps) return (this.render = true);
    const interval = 1000 / this.targetFps;
    this.nextRenderAt ??= atMs;
    // Keep fractional time so e.g. 60 on 144 Hz averages 60, not 48.
    // Never render catch-up bursts after a stall.
    if (atMs + 0.5 < this.nextRenderAt) return false;
    this.nextRenderAt += Math.max(1, Math.floor((atMs + 0.5 - this.nextRenderAt) / interval) + 1) * interval;
    return (this.render = true);
  }

  end(cpuMs, renderSubmitMs = 0) {
    if (!this.sampleFrame) return this.snapshot;
    this.cpuMs += Math.max(0, cpuMs);
    if (this.render) {
      this.renderedFrames++;
      this.cpuRenderMs += Math.max(0, cpuMs);
      this.renderSubmitMs += Math.max(0, renderSubmitMs);
    } else this.skippedFrames++;
    const elapsed = this.lastAt - this.windowStart;
    if (elapsed < 1000) return this.snapshot;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const count = sorted.length;
    this.snapshot = {
      mode: this.mode, targetFps: this.targetFps, hidden: false, ready: true,
      renderedFps: this.renderedFrames * 1000 / elapsed,
      callbackFps: count * 1000 / elapsed,
      callbackSamples: count,
      callbackMs: elapsed / count,
      callbackP95Ms: sorted[Math.ceil(count * 0.95) - 1],
      cpuMs: this.cpuMs / count,
      cpuRenderFrameMs: this.renderedFrames ? this.cpuRenderMs / this.renderedFrames : 0,
      renderSubmitMs: this.renderedFrames ? this.renderSubmitMs / this.renderedFrames : 0,
      skippedFrames: this.skippedFrames,
    };
    this.snapshot.limit = explainFrameRate(this.snapshot);
    this.windowStart = this.lastAt;
    this.intervals.length = 0;
    this.renderedFrames = this.skippedFrames = this.cpuMs = this.cpuRenderMs = this.renderSubmitMs = 0;
    return this.snapshot;
  }
}
