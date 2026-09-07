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
    // Rotating mass and feed chatter are broadband, pulsed textures. A rising
    // audible sawtooth made the old drive resemble a small electric drill.
    tune(voice.rotorPulse.frequency, 6 + spin * 26, at);
    tune(voice.motor.filter.frequency, 105 + spin * 115, at);
    tune(voice.teeth.filter.frequency, 260 + spin * 430, at);
    tune(voice.warning.filter.frequency, 360 + hot * 220, at);
    envelope(voice.motor, spin * 0.17, at);
    envelope(voice.teeth, spin * (0.062 + heat * 0.012), at);
    envelope(voice.warning, warning, at);
    if (newlyOverheated) envelope(voice.steam, 0.16, at, at + ATTACK, at + STEAM_DURATION);
    voice.end = Math.max(at + HOLD + FADE, voice.steam.end);
    // Calling stop again replaces a future deadline while a source is live.
    for (const source of voice.sources) source.stop(voice.end);
    this.pool.refresh(voice.output, null, voice.end - at);
    return true;
  }

  _createVoice(ctx, at) {
    const output = this.pool.acquire(null, HOLD + FADE);
    const makeLayer = (type, cutoff, q = 0.65) => {
      const source = ctx.createBufferSource();
      source.buffer = this.engine.noiseBuffer;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = cutoff;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(output);
      return { source, filter, gain, from: 0, target: 0, start: at, fadeAt: at, end: at };
    };
    const motor = makeLayer('lowpass', 170, 1.1);
    const teeth = makeLayer('bandpass', 480, 0.75);
    const warning = makeLayer('bandpass', 500, 0.8);
    const steam = makeLayer('lowpass', 1700);
    const pulse = ctx.createGain();
    pulse.gain.value = 0.62;
    const rotorPulse = ctx.createOscillator();
    rotorPulse.type = 'triangle';
    rotorPulse.frequency.value = 6;
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.38;
    rotorPulse.connect(pulseDepth).connect(pulse.gain);
    teeth.filter.disconnect();
    teeth.filter.connect(pulse).connect(teeth.gain);
    const layers = [motor, teeth, warning, steam];
    const sources = [...layers.map((layer) => layer.source), rotorPulse];
    const voice = { ctx, output, motor, teeth, warning, steam, layers,
      rotorPulse, pulse, pulseDepth, sources, end: at };
    this.voice = voice;
    this.pool.addCleanup(output, () => {
      for (const layer of layers) {
        try { layer.source.stop(); } catch {}
        layer.source.disconnect();
        layer.filter.disconnect();
        layer.gain.disconnect();
      }
      try { rotorPulse.stop(); } catch {}
      rotorPulse.disconnect();
      pulseDepth.disconnect();
      pulse.disconnect();
      if (this.voice === voice) this.voice = null;
    });
    // Decorrelate layers that share the reusable noise buffer.
    layers.forEach((layer, index) => layer.source.start(at, index * 0.137));
    rotorPulse.start(at);
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
    voice.rotorPulse.stop(at + FADE);
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

/** Low mechanical weight beneath a recording; a complete dry fallback if absent. */
export function renderMinigunReport(output, primitives, { sampled = false } = {}) {
  if (!sampled) primitives.hiss(output, {
    filter: 'lowpass', f: 1450, q: 0.65, sweepTo: 420,
    sweepMs: 0.065, dec: 0.085, g: 0.65,
  });
  primitives.hiss(output, {
    filter: 'bandpass', f: 230, q: 0.65, sweepTo: 105,
    sweepMs: 0.075, dec: 0.09, g: 0.55,
  });
  primitives.tone(output, {
    type: 'triangle', f0: 78, f1: 48, dec: 0.085, g: 0.22, att: 0.002,
  });
}

export const MINIGUN_REPORT = Object.freeze({ lifetime: 0.24, gain: 0.56, rate: 1, layerGain: 0.12 });

export const MINIGUN_REPORT_SLOTS = Object.freeze([
  'weapons.minigun.fire', 'weapons.minigun.fire.2', 'weapons.minigun.fire.3',
]);

// Different transients break the identical-sample buzz at 20 shots per second.
// The first slot stays compatible with existing optional sample manifests.
export function minigunReportChoice(index) {
  const step = Math.max(0, Math.floor(Number(index) || 0));
  return { slot: MINIGUN_REPORT_SLOTS[step % MINIGUN_REPORT_SLOTS.length],
    ...MINIGUN_REPORT, rate: MINIGUN_REPORT.rate * [1, 0.985, 1.015, 0.99, 1.01][step % 5] };
}
