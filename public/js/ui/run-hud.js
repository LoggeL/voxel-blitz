// Training-mode run overlay for the killhouse firing range. Owns the local run
// clock (performance.now via the injectable _now), the personal-best record,
// and the four run events emitted by the server's training policy: run_start,
// run_split, run_finish, run_reset. Presentation-only; authoritative timings
// arrive inside the events. Visibility follows the live match mode the same
// way sibling HUD overlays do (spectator, match result).

import {
  el,
  formatClock,
  loadPrefNum,
  savePref,
} from './hud-support.js';

export const RUN_BEST_KEY = 'vb-run-best-killhouse';
export const RUN_STAGES = 4;
export const RUN_RESULT_HOLD_MS = 5000;
export const RUN_SPLIT_FADE_MS = 2600;

function nowDefault() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function requestFrameDefault(callback) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(() => callback(nowDefault()), 16);
}

function cancelFrameDefault(handle) {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

/** Local run clock: m:ss.t — tenth-of-a-second precision for race times. */
function formatRunClock(seconds) {
  const totalMs = Math.max(0, Math.floor(seconds * 1000));
  const minutes = Math.floor(totalMs / 60000);
  const restMs = totalMs % 60000;
  const wholeSeconds = Math.floor(restMs / 1000);
  const tenths = Math.floor((restMs % 1000) / 100);
  return `${minutes}:${String(wholeSeconds).padStart(2, '0')}.${tenths}`;
}

/**
 * Presentation-only killhouse run overlay. The overlay lazily attaches to the
 * #hud root on first use because HUD.buildHUD rebuilds that subtree during the
 * live boot; a detached root is rebuilt transparently by _ensureDom.
 */
export class RunHud {
  constructor({
    getMyId = null,
    now = nowDefault,
    requestFrame = requestFrameDefault,
    cancelFrame = cancelFrameDefault,
  } = {}) {
    this._getMyId = typeof getMyId === 'function' ? getMyId : null;
    this._now = now;
    this._requestFrame = requestFrame;
    this._cancelFrame = cancelFrame;
    this._setTimer = (callback, delay) => setTimeout(callback, delay);
    this._clearTimer = (handle) => clearTimeout(handle);

    this.dom = {};
    this._mode = null;
    this._state = null;
    this._running = false;
    this._startedAt = 0;
    this._raf = 0;
    this._resultTimer = 0;
    this._toastTimer = 0;
  }

  /** Match snapshots drive visibility: the overlay exists only in training. */
  setMatch(match) {
    const mode = match && typeof match === 'object' ? (match.mode || null) : null;
    if (mode === this._mode) return;
    this._mode = mode;
    const dom = this._ensureDom();
    if (!dom) return;
    dom.root.classList.toggle('hidden', mode !== 'training');
    if (mode !== 'training' || !this._state) this._toIdle();
    else this._applyStateClasses();
  }

  /** Server run events (netclient emits per kind), scoped to the local operator. */
  handleEvent(event) {
    if (!event || typeof event.kind !== 'string') return;
    const myId = this._getMyId ? this._getMyId() : null;
    if (event.id != null && myId != null && event.id !== myId) return;
    switch (event.kind) {
      case 'run_start': this._startRun(); break;
      case 'run_split': this._showSplit(event); break;
      case 'run_finish': this._showResult(event); break;
      case 'run_reset': this._toIdle(); break;
    }
  }

  reset() {
    this._toIdle();
  }

  dispose() {
    this._stopTimer();
    this._clearTimer(this._resultTimer);
    this._clearTimer(this._toastTimer);
    this._resultTimer = 0;
    this._toastTimer = 0;
    this.dom.root?.remove();
    this.dom = {};
    this._mode = null;
    this._state = null;
    this._running = false;
  }

  /* -------------------------------------------------------------- internals */

  _domIfConnected() {
    return this.dom.root && this.dom.root.isConnected ? this.dom : null;
  }

  _ensureDom() {
    if (this._domIfConnected()) return this.dom;
    this.dom.root?.remove();
    const hudRoot = typeof document !== 'undefined' ? document.getElementById('hud') : null;
    if (!hudRoot) return null;
    const root = el('section', 'vb-run-hud', hudRoot, 'run-overlay');
    root.setAttribute('aria-live', 'polite');
    const dom = {
      root,
      hint: el('div', 'vb-run-hint', root),
      best: el('div', 'vb-run-best', root),
      timer: el('div', 'vb-run-timer', root),
      stage: el('div', 'vb-run-stage', root),
      result: el('div', 'vb-run-result', root),
      newBest: el('div', 'vb-run-newbest', root),
      toast: el('div', 'vb-run-toast', root),
    };
    dom.newBest.textContent = 'NEW BEST';
    this.dom = dom;
    dom.root.classList.toggle('hidden', this._mode !== 'training');
    this._applyStateClasses();
    return dom;
  }

  _applyStateClasses() {
    const dom = this._domIfConnected();
    if (!dom) return;
    dom.root.classList.toggle('state-idle', this._state === 'idle');
    dom.root.classList.toggle('state-live', this._state === 'live');
    dom.root.classList.toggle('state-result', this._state === 'result');
  }

  _bestMs() {
    return loadPrefNum(RUN_BEST_KEY, 0);
  }

  _bestText() {
    const best = this._bestMs();
    return best > 0 ? `BEST ${formatRunClock(best / 1000)}` : 'BEST —';
  }

  _toIdle() {
    this._running = false;
    this._stopTimer();
    if (this._resultTimer) {
      this._clearTimer(this._resultTimer);
      this._resultTimer = 0;
    }
    this._state = 'idle';
    const dom = this._domIfConnected();
    if (!dom) return;
    dom.root.classList.remove('is-new-best');
    if (this._toastTimer) {
      this._clearTimer(this._toastTimer);
      this._toastTimer = 0;
    }
    dom.toast.classList.remove('is-visible');
    dom.hint.textContent = 'KILLHOUSE · Step on the start pad to begin the run';
    dom.best.textContent = this._bestText();
    this._applyStateClasses();
  }

  _startRun() {
    const dom = this._ensureDom();
    if (!dom) return;
    if (this._resultTimer) {
      this._clearTimer(this._resultTimer);
      this._resultTimer = 0;
    }
    this._running = true;
    this._startedAt = this._now();
    this._state = 'live';
    dom.root.classList.remove('is-new-best');
    dom.toast.classList.remove('is-visible');
    dom.timer.textContent = formatRunClock(0);
    dom.stage.textContent = `STAGE 1 / ${RUN_STAGES}`;
    dom.best.textContent = this._bestText();
    this._applyStateClasses();
    this._startClock();
  }

  _startClock() {
    this._stopTimer();
    const tick = () => {
      this._raf = 0;
      if (!this._running) return;
      const dom = this._domIfConnected();
      if (dom) dom.timer.textContent = formatRunClock((this._now() - this._startedAt) / 1000);
      this._raf = this._requestFrame(tick);
    };
    this._raf = this._requestFrame(tick);
  }

  _stopTimer() {
    if (this._raf) {
      this._cancelFrame(this._raf);
      this._raf = 0;
    }
  }

  _showSplit(event) {
    const dom = this._domIfConnected() || this._ensureDom();
    if (!dom) return;
    const stage = Number(event.stage) | 0;
    const ms = Number(event.ms);
    const seconds = Number.isFinite(ms) ? ms / 1000 : 0;
    dom.toast.textContent = `STAGE ${stage + 1} CLEARED · ${formatClock(seconds)}`;
    dom.toast.classList.add('is-visible');
    if (this._toastTimer) this._clearTimer(this._toastTimer);
    this._toastTimer = this._setTimer(() => {
      this._toastTimer = 0;
      const live = this._domIfConnected();
      if (live) live.toast.classList.remove('is-visible');
    }, RUN_SPLIT_FADE_MS);
    const next = stage + 2;
    dom.stage.textContent = next > RUN_STAGES ? 'FINISH PAD' : `STAGE ${next} / ${RUN_STAGES}`;
  }

  _showResult(event) {
    const dom = this._ensureDom();
    if (!dom) return;
    this._running = false;
    this._stopTimer();
    if (this._toastTimer) {
      this._clearTimer(this._toastTimer);
      this._toastTimer = 0;
    }
    dom.toast.classList.remove('is-visible');
    const ms = Number(event.ms);
    const runMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const previous = this._bestMs();
    const isNewBest = runMs > 0 && (previous <= 0 || runMs < previous);
    const bestMs = isNewBest ? runMs : previous;
    if (isNewBest) savePref(RUN_BEST_KEY, runMs);
    if (runMs > 0) dom.timer.textContent = formatRunClock(runMs / 1000);
    dom.result.textContent =
      `KILLHOUSE RUN ${formatRunClock(runMs / 1000)} · BEST ` +
      (bestMs > 0 ? formatRunClock(bestMs / 1000) : '—');
    dom.root.classList.toggle('is-new-best', isNewBest);
    this._state = 'result';
    this._applyStateClasses();
    if (this._resultTimer) this._clearTimer(this._resultTimer);
    this._resultTimer = this._setTimer(() => {
      this._resultTimer = 0;
      this._toIdle();
    }, RUN_RESULT_HOLD_MS);
  }
}
