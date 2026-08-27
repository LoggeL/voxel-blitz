// WebAudio synthesis operations bound once to one live AudioEngine context.

export function createVoices(engine) {
  const ctx = engine?.ctx;
  const noiseBuffer = engine?.noiseBuffer;
  if (!ctx || ctx.state === 'closed' || !noiseBuffer) {
    throw new Error('createVoices requires a live AudioEngine context');
  }

  function nowT(offset = 0) {
    return ctx.currentTime + 0.001 + offset;
  }

  function rnd(a, b) {
    return a + Math.random() * (b - a);
  }

  function createGain() {
    return ctx.createGain();
  }

  function createOscillator() {
    return ctx.createOscillator();
  }

  function biquad(type, frequency, q) {
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = Math.max(20, frequency);
    if (q != null) filter.Q.value = q;
    return filter;
  }

  function shaper(drive) {
    const waveShaper = ctx.createWaveShaper();
    const length = 256;
    const curve = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const x = (i / (length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
    }
    waveShaper.curve = curve;
    return waveShaper;
  }

  function envGain(t0, peak, attackSec, decaySec) {
    const gain = ctx.createGain();
    const param = gain.gain;
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + attackSec);
    param.exponentialRampToValueAtTime(
      0.0001,
      t0 + attackSec + decaySec,
    );
    return gain;
  }

  // o={t0,type,f0,f1,detune,g,att,dec}
  function tone(dest, o) {
    const t0 = o.t0 ?? nowT();
    const attack = o.att ?? 0.003;
    const decay = o.dec ?? 0.1;
    const oscillator = ctx.createOscillator();
    oscillator.type = o.type || 'sine';
    oscillator.frequency.setValueAtTime(Math.max(1, o.f0), t0);
    if (o.f1) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(1, o.f1),
        t0 + decay,
      );
    }
    if (o.detune) oscillator.detune.value = o.detune;
    const gain = envGain(t0, o.g ?? 0.3, attack, decay);
    oscillator.connect(gain).connect(dest);
    oscillator.start(t0);
    oscillator.stop(t0 + attack + decay + 0.03);
  }

  // o={t0,filter,f,q,sweepTo,sweepMs,rate,g,att,dec,pan}
  function hiss(dest, o) {
    const t0 = o.t0 ?? nowT();
    const attack = o.att ?? 0.001;
    const decay = o.dec ?? 0.08;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;
    if (o.rate) source.playbackRate.value = o.rate;
    const filter = biquad(o.filter || 'bandpass', o.f ?? 1200, o.q ?? 1);
    if (o.sweepTo) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(30, o.sweepTo),
        t0 + (o.sweepMs ?? decay),
      );
    }
    const gain = envGain(t0, o.g ?? 0.3, attack, decay);
    let last = gain;
    if (o.pan && ctx.createStereoPanner) {
      const stereo = ctx.createStereoPanner();
      stereo.pan.value = o.pan;
      gain.connect(stereo);
      last = stereo;
    }
    source.connect(filter).connect(gain);
    last.connect(dest);
    source.start(t0);
    source.stop(t0 + attack + decay + 0.05);
  }

  return {
    nowT,
    rnd,
    biquad,
    shaper,
    envGain,
    tone,
    hiss,
    createGain,
    createOscillator,
  };
}
