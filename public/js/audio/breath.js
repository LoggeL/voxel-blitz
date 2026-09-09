/** Close, unspatialized breathing cues, rendered only on lifecycle transitions. */
export function renderBreath(out, primitives, event) {
  const inhale = event === 'inhale';
  const gasp = event === 'gasp';
  const t0 = primitives.nowT();
  primitives.hiss(out, {
    t0, filter: 'bandpass', f: inhale ? 650 : 1100, q: 0.7,
    sweepTo: inhale ? 1500 : 420, sweepMs: gasp ? 0.5 : 0.28,
    att: inhale ? 0.12 : 0.035, dec: gasp ? 0.65 : 0.3,
    g: gasp ? 0.24 : 0.14,
  });
  primitives.hiss(out, {
    t0, filter: 'lowpass', f: 380, q: 0.5,
    att: 0.06, dec: gasp ? 0.5 : 0.22, g: gasp ? 0.08 : 0.04,
  });
}
