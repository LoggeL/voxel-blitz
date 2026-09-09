import { displaySettings } from './display-settings.js';
const BAR_COUNT = 32;
const UPDATE_MS = 250;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Compact FPS + measured RTT history presentation. */
export class NetworkHud {
  constructor() {
    this.root = null;
    this.ping = null;
    this.fps = null;
    this.limit = null;
    this.buffer = null;
    this.bars = [];
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

  applyVisibility() {
    if (!this.root) return;
    const { showPing, showFps, showNetwork } = displaySettings();
    this.root.style.display = showPing || showFps || showNetwork ? 'block' : 'none';
    this.ping.style.display = showPing ? '' : 'none';
    this.fps.style.display = showFps ? '' : 'none';
    this.limit.style.display = showFps ? 'block' : 'none';
    this.buffer.style.display = showNetwork ? 'block' : 'none';
    this.root.querySelector('.vb-net-history').style.display = showNetwork ? 'flex' : 'none';
  }

  update(frameDt, stats = null, atMs = performance.now(), frameStats = null) {
    if (Number.isFinite(frameDt) && frameDt > 0 && frameDt < 1) {
      const instant = clamp(1 / frameDt, 1, 360);
      this.fpsEma = this.fpsEma === 0 ? instant : this.fpsEma * 0.9 + instant * 0.1;
    }
    if (!this.root || atMs - this.lastPaintAt < UPDATE_MS) return;
    this.lastPaintAt = atMs;
    this.applyVisibility();
    if (this.root.style.display === 'none') return;

    const pingMs = Math.max(0, Number(stats?.pingMs) || 0);
    const jitterMs = Math.max(0, Number(stats?.jitterMs) || 0);
    const bufferMs = Math.max(0, Number(stats?.bufferMs) || 0);
    const fps = frameStats ? (frameStats.ready ? Math.round(frameStats.renderedFps) : 0) : Math.round(this.fpsEma);
    this.ping.textContent = pingMs > 0 ? `PING ${Math.round(pingMs)} MS` : 'PING --';
    this.fps.textContent = fps > 0 ? `FPS ${fps}` : 'FPS --';
    this.limit.textContent = frameStats?.limit.label || '';
    this.limit.title = frameStats?.limit.detail || '';
    this.buffer.textContent = `JIT ${Math.round(jitterMs)} · BUF ${Math.round(bufferMs)} MS`;
    const { showPing, showNetwork, showFps } = displaySettings();
    const expectedFps = frameStats?.targetFps || 60;
    const lowFps = showFps && fps > 0 && fps < Math.min(45, expectedFps * 0.75);
    const badFps = showFps && fps > 0 && fps < Math.min(28, expectedFps * 0.5);
    this.root.classList.toggle('vb-net-warn', ((showPing || showNetwork) && pingMs >= 85) || lowFps);
    this.root.classList.toggle('vb-net-bad', ((showPing || showNetwork) && pingMs >= 150) || badFps);

    const samples = Array.isArray(stats?.pingHistory) ? stats.pingHistory : [];
    const visible = samples.slice(-BAR_COUNT);
    const start = BAR_COUNT - visible.length;
    for (let index = 0; index < BAR_COUNT; index++) {
      const sample = index >= start ? Number(visible[index - start]) : 0;
      const height = sample > 0 ? clamp(2 + sample / 7, 3, 22) : 2;
      const bar = this.bars[index];
      bar.style.height = `${height}px`;
      bar.className = sample >= 150 ? 'bad' : sample >= 85 ? 'warn' : '';
    }
  }

  reset() {
    this.fpsEma = 0;
    this.lastPaintAt = -Infinity;
    if (this.ping) this.ping.textContent = 'PING --';
    if (this.fps) this.fps.textContent = 'FPS --';
    if (this.limit) { this.limit.textContent = ''; this.limit.title = ''; }
    if (this.buffer) this.buffer.textContent = 'BUFFER --';
    for (const bar of this.bars) {
      bar.style.height = '2px';
      bar.className = '';
    }
  }

  dispose() {
    this.root?.remove();
    this.root = this.ping = this.fps = this.limit = this.buffer = null;
    this.bars = [];
  }
}
