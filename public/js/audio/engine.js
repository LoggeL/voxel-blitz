// AudioContext ownership, master graph, lifecycle recovery, and deferred cues.

const GESTURE_EVENTS = ['pointerdown', 'touchend', 'keydown'];
const MAX_QUEUED_CUES = 16;

/** Build the exact shared master bus/limiter graph for live or offline contexts. */
export function buildMasterGraph(context, masterGain = 0.9) {
  if (!context || typeof context.createGain !== 'function' ||
      typeof context.createDynamicsCompressor !== 'function') {
    throw new TypeError('buildMasterGraph requires a WebAudio-compatible context');
  }
  const bus = context.createGain();
  bus.gain.value = Math.max(0, Number(masterGain) || 0);
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.knee.value = 3;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.11;
  bus.connect(limiter).connect(context.destination);
  return { bus, limiter };
}

/** Build the exact shared multi-tap echo graph against an injected master bus. */
export function buildEchoGraph(context, bus) {
  if (!context || !bus) throw new TypeError('buildEchoGraph requires context and bus');
  const input = context.createGain();
  const damp = context.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 4200;
  damp.Q.value = 0.5;
  const output = context.createGain();
  const nodes = [input, damp, output];
  output.gain.value = 0.55;
  damp.connect(output);
  output.connect(bus);

  const times = [0.11, 0.23, 0.31];
  const feedback = [0.52, 0.61, 0.45];
  for (let i = 0; i < times.length; i++) {
    const delay = context.createDelay(1);
    delay.delayTime.value = times[i];
    input.connect(delay);
    const feedbackGain = context.createGain();
    feedbackGain.gain.value = feedback[i];
    delay.connect(feedbackGain).connect(delay);
    const tap = context.createGain();
    tap.gain.value = 0.25;
    delay.connect(tap).connect(damp);
    nodes.push(delay, feedbackGain, tap);
  }
  return { in: input, nodes };
}

function supportsDocumentListeners() {
  return typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function' &&
    typeof document.removeEventListener === 'function';
}

export class AudioEngine {
  constructor() {
    this._ctx = null;
    this._bus = null;
    this._masterLimiter = null;
    this._noiseBuffer = null;
    this._echo = null;
    this._masterVolume = 0.9;
    this._resumePromise = null;
    this._gestureListenersArmed = false;
    this._visibilityListenerArmed = false;
    this._pageShowListenerArmed = false;
    this._flushingCues = false;
    this._lastListener = null;
    this._queuedCues = [];
    this._voicePools = new Set();

    // Listener identity is stable for the lifetime of the engine so every
    // registration can be removed with the exact same callback.
    this._onUnlockGesture = this._handleUnlockGesture.bind(this);
    this._onVisibilityChange = this._handleVisibilityChange.bind(this);
    this._onPageShow = this._handlePageShow.bind(this);
    this._onAudioStateChange = this._handleAudioStateChange.bind(this);
  }

  get ctx() { return this._ctx; }
  get bus() { return this._bus; }
  get noiseBuffer() { return this._noiseBuffer; }
  get echoIn() { return this._echo?.in || null; }
  get now() { return this._ctx?.currentTime || 0; }

  ensure() {
    if (this._ctx && this._ctx.state !== 'closed') return true;
    const AudioContextCtor = typeof window !== 'undefined' &&
      (window.AudioContext || window.webkitAudioContext);
    if (!AudioContextCtor) return false;

    let next = null;
    try {
      next = new AudioContextCtor();
      this._ctx = next;
      const master = buildMasterGraph(next, this._audibleMasterGain());
      this._bus = master.bus;
      this._masterLimiter = master.limiter;
      this._noiseBuffer = this._makeNoiseBuffer(next);
      this._echo = buildEchoGraph(next, this._bus);
      next.addEventListener?.('statechange', this._onAudioStateChange);
      this._armLifecycleListeners();
      this._handleAudioStateChange();
      return true;
    } catch (_) {
      this._disarmGestureUnlock();
      this._disarmLifecycleListeners();
      try { next?.removeEventListener?.('statechange', this._onAudioStateChange); } catch (_) {}
      try { next?.close(); } catch (_) {}
      this._ctx = null;
      this._bus = null;
      this._masterLimiter = null;
      this._noiseBuffer = null;
      this._echo = null;
      return false;
    }
  }

  resume(force = false) {
    const activeCtx = this._ctx;
    if (!activeCtx || activeCtx.state === 'closed') return Promise.resolve(false);
    if (activeCtx.state === 'running') {
      this._disarmGestureUnlock();
      this._flushQueuedCues();
      return Promise.resolve(true);
    }
    this._armGestureUnlock();
    if (this._resumePromise && !force) return this._resumePromise;

    let resumeResult;
    try {
      // This invocation must remain synchronous with the caller. In particular,
      // never put it behind Promise.resolve().then(...): browsers consume the
      // activation token before that continuation runs.
      resumeResult = activeCtx.resume();
    } catch (_) {
      this._armGestureUnlock();
      return Promise.resolve(false);
    }

    const finish = () => {
      const running = activeCtx === this._ctx && activeCtx.state === 'running';
      if (running) {
        this._disarmGestureUnlock();
        this._flushQueuedCues();
      } else {
        this._armGestureUnlock();
      }
      return running;
    };
    const attempt = Promise.resolve(resumeResult).then(finish, finish);
    this._resumePromise = attempt;
    void attempt.finally(() => {
      if (this._resumePromise === attempt) this._resumePromise = null;
    });
    return attempt;
  }

  setMasterVolume(value) {
    const next = Number(value);
    if (Number.isFinite(next)) {
      this._masterVolume = Math.min(1, Math.max(0, next));
    }
    const activeCtx = this._ctx;
    if (this._bus && activeCtx && activeCtx.state !== 'closed') {
      this._bus.gain.cancelScheduledValues(activeCtx.currentTime);
      this._bus.gain.setValueAtTime(this._audibleMasterGain(), activeCtx.currentTime);
    }
  }

  setListener({ fwd, pos } = {}) {
    this._lastListener = {
      fwd: Array.isArray(fwd) ? fwd.slice(0, 3) : null,
      pos: Array.isArray(pos) ? pos.slice(0, 3) : null,
    };
    this._applyLastListener();
  }

  // Runs immediately when audio is live; otherwise retains a bounded replay.
  // Context creation and resume both occur before this method returns.
  queueOrRun(kind, replay) {
    if (!this.ensure()) return false;
    if (this._ctx.state === 'running') {
      replay();
      return true;
    }
    const queued = this._queueCue(kind, replay);
    void this.resume();
    return queued;
  }

  async dispose() {
    this._disarmGestureUnlock();
    this._disarmLifecycleListeners();
    const activeCtx = this._ctx;
    try {
      activeCtx?.removeEventListener?.('statechange', this._onAudioStateChange);
    } catch (_) {}

    this._queuedCues.length = 0;
    this._flushingCues = false;
    for (const pool of this._voicePools) pool.disposeAll();
    this._voicePools.clear();

    const echoNodes = this._echo?.nodes;
    if (echoNodes) {
      for (let i = 0; i < echoNodes.length; i++) {
        try { echoNodes[i].disconnect(); } catch (_) {}
      }
    }
    try { this._masterLimiter?.disconnect(); } catch (_) {}
    try { this._bus?.disconnect(); } catch (_) {}

    this._ctx = null;
    this._bus = null;
    this._masterLimiter = null;
    this._noiseBuffer = null;
    this._echo = null;
    this._resumePromise = null;
    this._lastListener = null;

    if (activeCtx && activeCtx.state !== 'closed') {
      try { await activeCtx.close(); } catch (_) {}
    }
  }

  // Internal ownership seam used by VoicePool. Keeping pool teardown here makes
  // the public dispose operation preserve listener -> voices -> graph -> context.
  _registerVoicePool(pool) {
    this._voicePools.add(pool);
  }

  _audibleMasterGain() {
    return this._masterVolume <= 0 ? 0 : Math.max(0.025, this._masterVolume);
  }

  _armGestureUnlock() {
    const activeCtx = this._ctx;
    if (this._gestureListenersArmed || !activeCtx ||
        activeCtx.state === 'running' || activeCtx.state === 'closed' ||
        !supportsDocumentListeners()) return;
    this._gestureListenersArmed = true;
    for (let i = 0; i < GESTURE_EVENTS.length; i++) {
      document.addEventListener(GESTURE_EVENTS[i], this._onUnlockGesture, {
        capture: true,
        passive: true,
      });
    }
  }

  _disarmGestureUnlock() {
    if (!this._gestureListenersArmed) return;
    this._gestureListenersArmed = false;
    if (!supportsDocumentListeners()) return;
    for (let i = 0; i < GESTURE_EVENTS.length; i++) {
      document.removeEventListener(GESTURE_EVENTS[i], this._onUnlockGesture, true);
    }
  }

  _armLifecycleListeners() {
    if (!this._visibilityListenerArmed && supportsDocumentListeners()) {
      document.addEventListener('visibilitychange', this._onVisibilityChange, true);
      this._visibilityListenerArmed = true;
    }
    if (!this._pageShowListenerArmed && typeof window !== 'undefined' &&
        typeof window.addEventListener === 'function' &&
        typeof window.removeEventListener === 'function') {
      window.addEventListener('pageshow', this._onPageShow, true);
      this._pageShowListenerArmed = true;
    }
  }

  _disarmLifecycleListeners() {
    if (this._visibilityListenerArmed) {
      this._visibilityListenerArmed = false;
      if (supportsDocumentListeners()) {
        document.removeEventListener('visibilitychange', this._onVisibilityChange, true);
      }
    }
    if (this._pageShowListenerArmed) {
      this._pageShowListenerArmed = false;
      if (typeof window !== 'undefined' &&
          typeof window.removeEventListener === 'function') {
        window.removeEventListener('pageshow', this._onPageShow, true);
      }
    }
  }

  _queueCue(kind, replay) {
    const activeCtx = this._ctx;
    if (!activeCtx || activeCtx.state === 'closed') return false;
    if (kind === 'footstep') {
      for (let i = 0; i < this._queuedCues.length; i++) {
        const cue = this._queuedCues[i];
        if (cue.kind === kind) {
          cue.replay = replay;
          return true;
        }
      }
    }
    if (this._queuedCues.length >= MAX_QUEUED_CUES) return false;
    this._queuedCues.push({ kind, replay });
    return true;
  }

  _applyLastListener() {
    const activeCtx = this._ctx;
    if (!this._lastListener || !activeCtx ||
        activeCtx.state !== 'running' || !activeCtx.listener) return;
    const { fwd, pos } = this._lastListener;
    const listener = activeCtx.listener;
    if (listener.forwardX) {
      if (fwd) {
        listener.forwardX.value = fwd[0];
        listener.forwardY.value = fwd[1];
        listener.forwardZ.value = fwd[2];
        listener.upX.value = 0;
        listener.upY.value = 1;
        listener.upZ.value = 0;
      }
      if (pos) {
        listener.positionX.value = pos[0];
        listener.positionY.value = pos[1];
        listener.positionZ.value = pos[2];
      }
    } else {
      if (fwd) listener.setOrientation(fwd[0], fwd[1], fwd[2], 0, 1, 0);
      if (pos) listener.setPosition(pos[0], pos[1], pos[2]);
    }
  }

  _flushQueuedCues() {
    const activeCtx = this._ctx;
    if (this._flushingCues || !activeCtx || activeCtx.state !== 'running') return;
    this._flushingCues = true;
    try {
      this._applyLastListener();
      while (this._queuedCues.length && this._ctx === activeCtx &&
             activeCtx.state === 'running') {
        const cue = this._queuedCues.shift();
        try { cue.replay(); } catch (_) {}
      }
    } finally {
      this._flushingCues = false;
    }
  }

  _handleUnlockGesture() {
    this._disarmGestureUnlock();
    if (this.ensure()) void this.resume(true);
  }

  _handleVisibilityChange() {
    if (typeof document !== 'undefined' &&
        document.visibilityState === 'hidden') return;
    if (this._ctx && this._ctx.state !== 'closed') void this.resume(true);
  }

  _handlePageShow() {
    if (this._ctx && this._ctx.state !== 'closed') void this.resume(true);
  }

  _handleAudioStateChange() {
    const activeCtx = this._ctx;
    if (!activeCtx || activeCtx.state === 'closed') {
      this._disarmGestureUnlock();
    } else if (activeCtx.state === 'running') {
      this._disarmGestureUnlock();
      this._flushQueuedCues();
    } else {
      this._armGestureUnlock();
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        void this.resume();
      }
    }
  }

  _makeNoiseBuffer(activeCtx) {
    const len = activeCtx.sampleRate | 0;
    const buffer = activeCtx.createBuffer(1, len, activeCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

}
