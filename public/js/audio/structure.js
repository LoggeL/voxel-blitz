// Procedural layers for structural collapses (sfx.structureCreak/Impact/Crumble):
// a stressed-material groan under the recorded creak, and the low body of a
// chunk hitting the ground under the recorded debris takes. Pure graph
// builders on a VoicePool output; every node stops on its own schedule.

/** Groan voice per sound material: fundamental (Hz), resonance multiple, wobble rate (Hz). */
export const STRUCTURE_GROAN = Object.freeze({
  wood: Object.freeze({ f: 92, res: 4.2, wobble: 6.5, q: 7, tick: 'bandpass', tickF: 1400 }),
  stone: Object.freeze({ f: 48, res: 3.1, wobble: 3.8, q: 4, tick: 'highpass', tickF: 2600 }),
  metal: Object.freeze({ f: 138, res: 5.5, wobble: 8.5, q: 11, tick: 'bandpass', tickF: 3200 }),
  glass: Object.freeze({ f: 210, res: 6, wobble: 10, q: 9, tick: 'highpass', tickF: 5200 }),
});

/**
 * Creak under load: a slowly bending sawtooth through a resonant band, plus
 * stick-slip ticks (wood, metal) or grinding grit (stone) that speed up
 * toward the break. `seconds` is the warning before the fall; `size` 0..1.
 */
export function renderStructureGroan(output, primitives, { seconds = 0.45, material = 'stone', size = 0.3, gain = 1 } = {}) {
  const voice = STRUCTURE_GROAN[material] || STRUCTURE_GROAN.stone;
  const t0 = primitives.nowT();
  const length = Math.max(0.3, seconds) + 0.35;
  const f = voice.f * (1.15 - 0.35 * Math.min(1, size));
  const osc = primitives.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(f * 1.06, t0);
  osc.frequency.exponentialRampToValueAtTime(f * 0.82, t0 + length);
  // Slow uneven wobble: the material catching and letting go.
  const lfo = primitives.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.setValueAtTime(voice.wobble * 0.6, t0);
  lfo.frequency.linearRampToValueAtTime(voice.wobble * 1.4, t0 + length);
  const depth = primitives.createGain();
  depth.gain.value = f * 0.07;
  lfo.connect(depth).connect(osc.frequency);
  const band = primitives.biquad('bandpass', f * voice.res, voice.q);
  band.frequency.setValueAtTime(f * voice.res, t0);
  band.frequency.exponentialRampToValueAtTime(f * voice.res * 0.7, t0 + length);
  const env = primitives.createGain();
  const peak = 0.16 * gain * (0.6 + 0.6 * Math.min(1, size));
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(peak, t0 + 0.09);
  env.gain.setValueAtTime(peak, t0 + Math.max(0.1, seconds * 0.8));
  env.gain.exponentialRampToValueAtTime(peak * 1.4, t0 + Math.max(0.12, seconds));
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + length);
  osc.connect(band).connect(env).connect(output);
  osc.start(t0); lfo.start(t0);
  osc.stop(t0 + length + 0.05); lfo.stop(t0 + length + 0.05);
  // Ticks accelerate toward the break.
  const ticks = Math.round(5 + 10 * Math.min(1, size) + seconds * 8);
  for (let i = 0; i < ticks; i++) {
    const k = i / ticks;
    const at = t0 + 0.04 + seconds * (1 - (1 - k) * (1 - k)) * (0.9 + primitives.rnd(-0.05, 0.05));
    primitives.hiss(output, {
      t0: at, filter: voice.tick, f: voice.tickF * primitives.rnd(0.75, 1.3), q: material === 'stone' ? 0.7 : 5,
      att: 0.002, dec: material === 'stone' ? 0.05 : 0.025, g: (0.05 + 0.1 * k) * gain,
    });
  }
}

/**
 * The body of a landing: a falling sine thump and a low-passed noise slam,
 * both bigger and lower for heavier chunks (`size` ~0.1..1.6) and harder for
 * faster ones (`hard` 0.2..1.4).
 */
export function renderStructureThump(output, primitives, { size = 0.5, hard = 0.6, gain = 1 } = {}) {
  const t0 = primitives.nowT();
  const big = Math.min(1.6, Math.max(0.1, size));
  primitives.tone(output, { t0, type: 'sine', f0: 86 - 22 * Math.min(1, big), f1: 30, att: 0.004,
    dec: 0.28 + 0.4 * big, g: (0.32 + 0.3 * big) * (0.6 + 0.4 * hard) * gain });
  primitives.hiss(output, { t0, filter: 'lowpass', f: 420 + 380 * hard, sweepTo: 140, sweepMs: 0.35 + 0.3 * big, q: 0.6,
    att: 0.003, dec: 0.3 + 0.55 * big, g: (0.26 + 0.24 * big) * gain });
  // Rattle of the pieces settling after the slam.
  const rattles = Math.round(3 + 6 * Math.min(1, big));
  for (let i = 0; i < rattles; i++) {
    primitives.hiss(output, { t0: t0 + 0.06 + i * primitives.rnd(0.03, 0.08) + 0.05 * i * i / rattles, filter: 'bandpass',
      f: primitives.rnd(700, 2400), q: 3, att: 0.002, dec: 0.04, g: 0.07 * gain * (1 - i / (rattles + 1)) });
  }
}
