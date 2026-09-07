// Local rotary drive and thermal feedback. One pooled graph is refreshed on the
// audio clock; a missing game frame expires it without depending on JS timers.
const HOLD = 0.12;
const FADE = 0.06;
const ATTACK = 0.025;
const STEAM_DURATION = 0.65;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function levelAt(layer, at) {
  if (at >= layer.end) return 0;
  if (at >= layer.fadeAt) return layer.target * (layer.end - at) / (layer.end - layer.fadeAt);
  return layer.from + (layer.target - layer.from) * Math.min(1, (at - layer.start) / ATTACK);
}

function envelope(layer, target, at, fadeAt = at + HOLD, end = fadeAt + FADE) {
  const from = levelAt(layer, at);
  Object.assign(layer, { from, target, start: at, fadeAt, end });
  const param = layer.gain.gain;
  param.cancelScheduledValues(at);
  param.setValueAtTime(from, at);
  param.linearRampToValueAtTime(target, Math.min(fadeAt, at + ATTACK));
  param.setValueAtTime(target, fadeAt);
  param.linearRampToValueAtTime(0, end);
}

function tune(param, value, at) {
  param.cancelScheduledValues(at);
  param.setTargetAtTime(value, at, 0.035);
}

export class MinigunMotor {
  constructor(engine, pool) {
    this.engine = engine;
    this.pool = pool;
    this.voice = null;
    this.overheated = false;
  }

  refresh(spin01, heat01, active = true, overheated = false) {
    const newlyOverheated = !!overheated && !this.overheated;
    this.overheated = !!overheated;
    const ctx = this.engine.ctx;
    if (!active || !ctx || ctx.state !== 'running') {
      this.stop();
      return false;
    }
    const spin = clamp01(spin01);
    const heat = clamp01(heat01);
    const at = ctx.currentTime;
    if (this.voice && (this.voice.ctx !== ctx || at >= this.voice.end)) this.disposeVoice();
    // An equipped, motionless weapon needs no silent oscillators.
    if (spin <= 0.002 && !newlyOverheated && (!this.voice || at >= this.voice.steam.end)) {
      this.stop();
      return false;
    }
    const voice = this.voice || this._createVoice(ctx, at);
    voice.stopping = false;
    const hot = Math.max(0, (heat - 0.82) / 0.18);
    const warning = !overheated && spin > 0.1
      ? hot * (0.012 + 0.007 * Math.sin(at * 16)) : 0;
    tune(voice.motor.source.frequency, 38 + spin * 68, at);
    tune(voice.teeth.source.frequency, 110 + spin * 490, at);
    tune(voice.motor.filter.frequency, 230 + spin * 380, at);
    tune(voice.teeth.filter.frequency, 300 + spin * 1900, at);
    tune(voice.warning.source.frequency, 680 + hot * 160, at);
    envelope(voice.motor, spin * 0.065, at);
    envelope(voice.teeth, spin * (0.026 + heat * 0.009), at);
    envelope(voice.warning, warning, at);
    if (newlyOverheated) envelope(voice.steam, 0.16, at, at + ATTACK, at + STEAM_DURATION);
    voice.end = Math.max(at + HOLD + FADE, voice.steam.end);
    // Calling stop again replaces a future deadline while a source is live.
    for (const layer of voice.layers) layer.source.stop(voice.end);
    this.pool.refresh(voice.output, null, voice.end - at);
    return true;
  }

  _createVoice(ctx, at) {
    const output = this.pool.acquire(null, HOLD + FADE);
    const makeLayer = (type, cutoff) => {
      const source = type === 'noise' ? ctx.createBufferSource() : ctx.createOscillator();
      if (type === 'noise') {
        source.buffer = this.engine.noiseBuffer;
        source.loop = true;
      } else source.type = type;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      filter.Q.value = 0.65;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(output);
      return { source, filter, gain, from: 0, target: 0, start: at, fadeAt: at, end: at };
    };
    const motor = makeLayer('triangle', 400);
    const teeth = makeLayer('sawtooth', 1100);
    const warning = makeLayer('sine', 1200);
    const steam = makeLayer('noise', 2100);
    const layers = [motor, teeth, warning, steam];
    const voice = { ctx, output, motor, teeth, warning, steam, layers, end: at };
    this.voice = voice;
    this.pool.addCleanup(output, () => {
      for (const layer of layers) {
        try { layer.source.stop(); } catch {}
        layer.source.disconnect();
        layer.filter.disconnect();
        layer.gain.disconnect();
      }
      if (this.voice === voice) this.voice = null;
    });
    for (const layer of layers) layer.source.start(at);
    return voice;
  }

  stop() {
    const voice = this.voice;
    if (!voice) return;
    const at = voice.ctx.currentTime;
    if (at >= voice.end) { this.disposeVoice(); return; }
    // Repeated inactive frames must never push a release deadline forward.
    if (voice.stopping) return;
    for (const layer of voice.layers) {
      const from = levelAt(layer, at);
      const param = layer.gain.gain;
      param.cancelScheduledValues(at);
      param.setValueAtTime(from, at);
      param.linearRampToValueAtTime(0, at + FADE);
      Object.assign(layer, { from, target: from, start: at, fadeAt: at, end: at + FADE });
      layer.source.stop(at + FADE);
    }
    voice.stopping = true;
    voice.end = at + FADE;
  }

  disposeVoice() {
    if (this.voice) this.pool.release(this.voice.output);
    this.voice = null;
  }

  dispose() {
    this.disposeVoice();
    this.overheated = false;
  }
}

/** Short, dry rotary layer beneath the dedicated shot sample or LMG fallback. */
export function renderMinigunReport(output, primitives) {
  primitives.hiss(output, {
    filter: 'bandpass', f: 2600, q: 0.8, sweepTo: 900,
    sweepMs: 0.045, dec: 0.05, g: 0.46,
  });
  primitives.tone(output, {
    type: 'square', f0: 145, f1: 62, dec: 0.05, g: 0.25, att: 0.001,
  });
  primitives.tone(output, {
    type: 'sine', f0: 67, f1: 42, dec: 0.075, g: 0.32, att: 0.001,
  });
}

export const MINIGUN_REPORT = Object.freeze({ lifetime: 0.4, gain: 0.48, rate: 1.17, layerGain: 0.2 });
