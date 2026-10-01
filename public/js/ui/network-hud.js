import { displaySettings } from './display-settings.js';
const BAR_COUNT = 32;
const UPDATE_MS = 250;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function setValue(target, key, value) {
  if (target[key] !== value) target[key] = value;
}

function toggleClass(node, name, on) {
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

/** Compact FPS + measured RTT history presentation. */
export class NetworkHud {
  constructor() {
    this.root = null;
    this.ping = null;
    this.fps = null;
    this.limit = null;
    this.buffer = null;
    this.history = null;
    this.bars = [];
    this._barHeights = [];
    this.fpsEma = 0;
    this.lastPaintAt = -Infinity;
  }

  build(parent) {
    this.dispose();
    const root = document.createElement('div');
    root.id = 'net-meter';
    root.dataset.diagnostics = 'true';
    root.setAttribute('aria-label', 'Network and frame rate telemetry');
    const values = document.createElement('div');
    values.className = 'vb-net-values';
    this.ping = document.createElement('span');
    this.ping.className = 'vb-net-ping';
    this.ping.textContent = 'PING --';
    this.fps = document.createElement('span');
    this.fps.className = 'vb-net-fps';
    this.fps.textContent = 'FPS --';
    values.append(this.ping, this.fps);
    this.limit = document.createElement('span');
    this.limit.className = 'vb-net-limit';
    const history = document.createElement('div');
    this.history = history;
    history.className = 'vb-net-history';
    history.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < BAR_COUNT; index++) {
      const bar = document.createElement('i');
      history.appendChild(bar);
      this.bars.push(bar);
    }
    this.buffer = document.createElement('span');
    this.buffer.className = 'vb-net-buffer';
    this.buffer.textContent = 'BUFFER --';
    root.append(values, this.limit, history, this.buffer);
    parent.appendChild(root);
    this.root = root;
    this.applyVisibility();
    return root;
  }

  applyVisibility(publish = true) {
    if (!this.root) return;
    const { showPing, showFps, showNetwork } = displaySettings();
    setValue(this.root.style, 'display', showPing || showFps || showNetwork ? 'block' : 'none');
    setValue(this.ping.style, 'display', showPing ? '' : 'none');
    setValue(this.fps.style, 'display', showFps ? '' : 'none');
    setValue(this.limit.style, 'display', showFps ? 'block' : 'none');
    setValue(this.buffer.style, 'display', showNetwork ? 'block' : 'none');
    setValue(this.history.style, 'display', showNetwork ? 'flex' : 'none');
    if (publish) this.publishClearance();
  }

  /**
   * Everything else pinned to the top-right corner (career badge, mode chips)
   * reads `--vb-net-meter-clear`: the meter's bottom edge in CSS pixels, or 0
   * when it is hidden. The meter's height depends on which readouts are on.
   */
  publishClearance() {
    if (typeof document === 'undefined') return;
    const clear = !this.root || this.root.style.display === 'none' || !this.root.isConnected
      ? 0
      : Math.ceil(this.root.offsetTop + this.root.offsetHeight);
    if (clear === this._clearance) return;
    this._clearance = clear;
    document.documentElement.style.setProperty('--vb-net-meter-clear', `${clear}px`);
  }

  update(frameDt, stats = null, atMs = performance.now(), frameStats = null) {
    if (Number.isFinite(frameDt) && frameDt > 0 && frameDt < 1) {
      const instant = clamp(1 / frameDt, 1, 360);
      this.fpsEma = this.fpsEma === 0 ? instant : this.fpsEma * 0.9 + instant * 0.1;
    }
    if (!this.root || atMs - this.lastPaintAt < UPDATE_MS) return;
    this.lastPaintAt = atMs;
    this.applyVisibility(false);
    if (this.root.style.display === 'none') {
      this.publishClearance();
      return;
    }

    const pingMs = Math.max(0, Number(stats?.pingMs) || 0);
    const jitterMs = Math.max(0, Number(stats?.jitterMs) || 0);
    const bufferMs = Math.max(0, Number(stats?.bufferMs) || 0);
    const fps = frameStats ? (frameStats.ready ? Math.round(frameStats.renderedFps) : 0) : Math.round(this.fpsEma);
    setValue(this.ping, 'textContent', pingMs > 0 ? `PING ${Math.round(pingMs)} MS` : 'PING --');
    setValue(this.fps, 'textContent', fps > 0 ? `FPS ${fps}` : 'FPS --');
    setValue(this.limit, 'textContent', frameStats?.limit?.label || '');
    setValue(this.limit, 'title', frameStats?.limit?.detail || '');
    setValue(this.buffer, 'textContent', `JIT ${Math.round(jitterMs)} · BUF ${Math.round(bufferMs)} MS`);
    const { showPing, showNetwork, showFps } = displaySettings();
    const expectedFps = frameStats?.targetFps || 60;
    const lowFps = showFps && fps > 0 && fps < Math.min(45, expectedFps * 0.75);
    const badFps = showFps && fps > 0 && fps < Math.min(28, expectedFps * 0.5);
    toggleClass(this.root, 'vb-net-warn', ((showPing || showNetwork) && pingMs >= 85) || lowFps);
    toggleClass(this.root, 'vb-net-bad', ((showPing || showNetwork) && pingMs >= 150) || badFps);
    this.publishClearance();

    const samples = Array.isArray(stats?.pingHistory) ? stats.pingHistory : [];
    const visible = samples.slice(-BAR_COUNT);
    const start = BAR_COUNT - visible.length;
    for (let index = 0; index < BAR_COUNT; index++) {
      const sample = index >= start ? Number(visible[index - start]) : 0;
      const height = sample > 0 ? clamp(2 + sample / 7, 3, 22) : 2;
      const bar = this.bars[index];
      // CSS serializes fractional pixels with fewer digits. Compare the
      // numeric sample height rather than writing that rounding difference.
      if (this._barHeights[index] !== height) {
        bar.style.height = `${height}px`;
        this._barHeights[index] = height;
      }
      setValue(bar, 'className', sample >= 150 ? 'bad' : sample >= 85 ? 'warn' : '');
    }
  }

  reset() {
    this.fpsEma = 0;
    this.lastPaintAt = -Infinity;
    if (this.ping) setValue(this.ping, 'textContent', 'PING --');
    if (this.fps) setValue(this.fps, 'textContent', 'FPS --');
    if (this.limit) { setValue(this.limit, 'textContent', ''); setValue(this.limit, 'title', ''); }
    if (this.buffer) setValue(this.buffer, 'textContent', 'BUFFER --');
    if (this.root) {
      toggleClass(this.root, 'vb-net-warn', false);
      toggleClass(this.root, 'vb-net-bad', false);
    }
    for (const bar of this.bars) {
      setValue(bar.style, 'height', '2px');
      setValue(bar, 'className', '');
    }
    this._barHeights = this.bars.map(() => 2);
    this.publishClearance();
  }

  dispose() {
    this.root?.remove();
    this.root = this.ping = this.fps = this.limit = this.buffer = this.history = null;
    this.bars = [];
    this._barHeights = [];
    this.fpsEma = 0;
    this.lastPaintAt = -Infinity;
    this.publishClearance();
  }
}
