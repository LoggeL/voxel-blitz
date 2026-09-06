// One refreshable noise graph per shooter, using the shared master bus and pool.
// All fade and source-stop deadlines run on the audio clock, including if JS stalls.
const HOLD = 0.1;
const FADE = 0.04;
const ATTACK = 0.02;
const LEVEL = 0.75;
const MAX_LOOPS = 8;

export class FlameLoops {
  constructor(engine, pool) {
    this.engine = engine;
    this.pool = pool;
    this.voices = new Map();
  }

  refresh(options = {}) {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running') return false;
    const key = options.shooterId ?? (options.pos ? 'remote' : 'local');
    const at = ctx.currentTime;
    let voice = this.voices.get(key);
    if (voice && at >= voice.end) {
      this.pool.release(voice.output);
      voice = null;
    }
    if (!voice) {
      while (this.voices.size >= MAX_LOOPS) {
        // Prefer reclaiming the least recently refreshed remote emitter.
        const candidates = [...this.voices.values()].filter((entry) => entry.key !== 'local');
        const oldest = (candidates.length ? candidates : [...this.voices.values()])
          .reduce((a, b) => a.last < b.last ? a : b);
        this.pool.release(oldest.output);
      }
      const output = this.pool.acquire(options, HOLD + FADE);
      const source = ctx.createBufferSource();
      source.buffer = this.engine.noiseBuffer;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1800;
      filter.Q.value = 0.65;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(output);
      voice = { key, output, source, filter, gain, last: at, start: at, from: 0, end: at };
      this.voices.set(key, voice);
      this.pool.addCleanup(output, () => {
        try { source.stop(); } catch {}
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
        if (this.voices.get(key) === voice) this.voices.delete(key);
      });
      source.start(at);
    }
    const level = this._levelAt(voice, at);
    voice.release = null;
    voice.from = level;
    voice.start = at;
    voice.last = at;
    voice.fadeAt = at + HOLD;
    voice.end = at + HOLD + FADE;
    const gain = voice.gain.gain;
    gain.cancelScheduledValues(at);
    gain.setValueAtTime(level, at);
    gain.linearRampToValueAtTime(LEVEL, at + ATTACK);
    gain.setValueAtTime(LEVEL, voice.fadeAt);
    gain.linearRampToValueAtTime(0, voice.end);
    // WebAudio permits replacing a future stop deadline until the source ends.
    voice.source.stop(voice.end);
    this.pool.refresh(voice.output, options, HOLD + FADE);
    return true;
  }

  _levelAt(voice, at) {
    if (at >= voice.end) return 0;
    if (voice.release) return voice.release.from *
      (voice.end - at) / (voice.end - voice.release.at);
    if (at >= voice.fadeAt) return LEVEL * (voice.end - at) / FADE;
    return voice.from + (LEVEL - voice.from) * Math.min(1, (at - voice.start) / ATTACK);
  }

  stop(shooterId = null) {
    const voice = this.voices.get(shooterId ?? 'local');
    if (!voice) return;
    const at = this.engine.ctx.currentTime;
    if (at >= voice.end || voice.end <= at + FADE) return;
    const level = this._levelAt(voice, at);
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(level, at);
    voice.gain.gain.linearRampToValueAtTime(0, at + FADE);
    voice.release = { at, from: level };
    voice.end = at + FADE;
    voice.source.stop(voice.end);
  }

  dispose() {
    for (const voice of this.voices.values()) this.pool.release(voice.output);
    this.voices.clear();
  }
}
