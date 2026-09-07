// Bounded output graphs for positional, rapid-fire, and human voices.

const MAX_POSITIONAL_VOICES = 16;
const MAX_VOICES = 48;
const MAX_HUMAN_VOICES = 4;
const FIRE_LIMIT = { lmg: 6, revolver: 4 };

export class VoicePool {
  constructor(engine) {
    if (!engine || typeof engine._registerVoicePool !== 'function') {
      throw new TypeError('VoicePool requires an AudioEngine');
    }
    this._engine = engine;
    this._positional = [];
    this._voices = [];
    this._byOutput = new Map();
    this._cleanupTimers = new Set();
    this._humanActive = [];
    this._lmgActive = [];
    this._revolverActive = [];
    this._fireActive = {
      lmg: this._lmgActive,
      revolver: this._revolverActive,
    };
    this._fireLists = [this._lmgActive, this._revolverActive];
    engine._registerVoicePool(this);
  }

  acquire(opts, lifetimeSec) {
    const activeCtx = this._context();
    const lifetime = lifetimeSec || 1.4;
    const now = activeCtx.currentTime;
    this._pruneVoices(now);

    const output = activeCtx.createGain();
    let panner = null;
    let last = output;
    if (opts && opts.muffled) {
      const lowpass = activeCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 480;
      lowpass.Q.value = 0.6;
      last.connect(lowpass);
      last = lowpass;
    }
    if (opts && Array.isArray(opts.pos) && activeCtx.createPanner) {
      panner = activeCtx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 7;
      panner.maxDistance = 170;
      panner.rolloffFactor = 1.05;
      this._movePanner(panner, opts.pos, activeCtx);
      last.connect(panner);
      panner.connect(this._engine.bus);
    } else {
      last.connect(this._engine.bus);
    }

    const entry = {
      out: output,
      panner,
      priority: Math.max(0, Math.min(2, Number(opts?.priority) || 0)),
      until: now + lifetime + 0.5,
      timer: null,
      cleanups: [],
      closed: false,
    };
    this._voices.push(entry);
    this._byOutput.set(output, entry);
    if (panner) this._positional.push(entry);
    entry.timer = this._scheduleCleanup(
      () => this._expireVoice(entry),
      (lifetime + 0.5) * 1000,
    );
    // A blast arrives before the block-break events it causes. Keep those
    // quieter voices from stealing the blast before its first audio frame.
    // Include the new voice in selection so lower-priority arrivals cannot
    // evict an all-important pool. Equal priorities retain FIFO behavior.
    while (this._positional.length > MAX_POSITIONAL_VOICES) {
      this._cleanupVoice(this._leastImportantVoice(this._positional));
    }
    while (this._voices.length > MAX_VOICES) {
      this._cleanupVoice(this._leastImportantVoice(this._voices));
    }
    return output;
  }

  acquireFire(key, opts, lifetime) {
    const output = this.acquire(opts, lifetime);
    output.gain.value = 1.16;
    const active = this._fireActive[key];
    if (!active) return output;

    const now = this._context().currentTime;
    for (let i = active.length - 1; i >= 0; i--) {
      const shot = active[i];
      if (shot.until <= now || !this._byOutput.has(shot.out)) active.splice(i, 1);
    }
    while (active.length >= FIRE_LIMIT[key]) {
      const oldest = active[0];
      const voice = this._byOutput.get(oldest.out);
      if (voice) this._cleanupVoice(voice);
      else active.shift();
    }
    active.push({ out: output, until: now + lifetime });
    return output;
  }

  acquireHuman(opts, lifetime) {
    const now = this._context().currentTime;
    for (let i = this._humanActive.length - 1; i >= 0; i--) {
      const voice = this._humanActive[i];
      if (voice.until <= now || !this._byOutput.has(voice.out)) {
        this._humanActive.splice(i, 1);
      }
    }
    while (this._humanActive.length >= MAX_HUMAN_VOICES) {
      const oldest = this._humanActive[0];
      const voice = this._byOutput.get(oldest.out);
      if (voice) this._cleanupVoice(voice);
      else this._humanActive.shift();
    }
    const output = this.acquire(opts, lifetime);
    this._humanActive.push({ out: output, until: now + lifetime });
    return output;
  }

  addCleanup(output, cleanup) {
    const entry = this._byOutput.get(output);
    if (!entry || entry.closed) {
      try { cleanup(); } catch (_) {}
      return;
    }
    entry.cleanups.push(cleanup);
  }

  /** Extend one sustained voice without allocating another graph or timer per refresh. */
  refresh(output, opts, lifetimeSec) {
    const entry = this._byOutput.get(output);
    if (!entry || entry.closed) return false;
    const ctx = this._context();
    entry.until = ctx.currentTime + lifetimeSec + 0.5;
    if (entry.panner && Array.isArray(opts?.pos)) {
      if (entry.panner.positionX) {
        ['X', 'Y', 'Z'].forEach((axis, index) => {
          entry.panner[`position${axis}`].setTargetAtTime(opts.pos[index], ctx.currentTime, 0.025);
        });
      } else entry.panner.setPosition(...opts.pos);
    }
    return true;
  }

  release(output) {
    this._cleanupVoice(this._byOutput.get(output));
  }

  _expireVoice(entry) {
    if (entry.closed) return;
    const ctx = this._context();
    // A suspended audio clock must not leave a cleanup timer rescheduling forever.
    const remaining = ctx.state === 'running' ? entry.until - ctx.currentTime : 0;
    if (remaining > 0.001) {
      entry.timer = this._scheduleCleanup(() => this._expireVoice(entry), remaining * 1000);
    } else this._cleanupVoice(entry);
  }

  disposeAll() {
    while (this._voices.length) this._cleanupVoice(this._voices[0]);
    for (const handle of this._cleanupTimers) clearTimeout(handle);
    this._cleanupTimers.clear();
    this._positional.length = 0;
    this._voices.length = 0;
    this._humanActive.length = 0;
    this._lmgActive.length = 0;
    this._revolverActive.length = 0;
    this._byOutput.clear();
  }

  _context() {
    const activeCtx = this._engine.ctx;
    if (!activeCtx || activeCtx.state === 'closed' || !this._engine.bus) {
      throw new Error('AudioEngine context is not ready');
    }
    return activeCtx;
  }

  _leastImportantVoice(voices) {
    let candidate = voices[0];
    for (let i = 1; i < voices.length; i++) {
      if (voices[i].priority < candidate.priority) candidate = voices[i];
    }
    return candidate;
  }

  _scheduleCleanup(cleanup, delayMs) {
    const handle = setTimeout(() => {
      this._cleanupTimers.delete(handle);
      cleanup();
    }, delayMs);
    this._cleanupTimers.add(handle);
    return handle;
  }

  _cleanupVoice(entry) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    if (entry.timer != null) {
      clearTimeout(entry.timer);
      this._cleanupTimers.delete(entry.timer);
    }
    for (let i = 0; i < entry.cleanups.length; i++) {
      try { entry.cleanups[i](); } catch (_) {}
    }
    try { entry.panner?.disconnect(); } catch (_) {}
    try { entry.out.disconnect(); } catch (_) {}
    this._removeEntry(this._voices, entry);
    this._removeEntry(this._positional, entry);
    this._byOutput.delete(entry.out);

    for (let listIndex = 0; listIndex < this._fireLists.length; listIndex++) {
      const active = this._fireLists[listIndex];
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].out === entry.out) active.splice(i, 1);
      }
    }
    for (let i = this._humanActive.length - 1; i >= 0; i--) {
      if (this._humanActive[i].out === entry.out) this._humanActive.splice(i, 1);
    }
  }

  _pruneVoices(now) {
    // cleanupVoice removes from this array, so advance only when an entry stays.
    for (let i = 0; i < this._voices.length;) {
      const entry = this._voices[i];
      if (entry.until <= now) this._cleanupVoice(entry);
      else i++;
    }
  }

  _movePanner(panner, pos, activeCtx) {
    if (panner.positionX) {
      panner.positionX.setValueAtTime(pos[0], activeCtx.currentTime);
      panner.positionY.setValueAtTime(pos[1], activeCtx.currentTime);
      panner.positionZ.setValueAtTime(pos[2], activeCtx.currentTime);
    } else {
      panner.setPosition(pos[0], pos[1], pos[2]);
    }
  }

  _removeEntry(list, entry) {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  }
}
