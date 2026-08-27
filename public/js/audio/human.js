// Procedural pain and death vocal graphs. The caller injects raw node factories,
// synthesis primitives, and the narrow voice-cleanup callback.

// A pitched source is split across resonant vocal bands. Two differently
// shaped bursts create glottal grit without samples or long-lived nodes.
export function vocalBurst(out, primitives, addCleanup, {
  t0,
  type,
  f0,
  f1,
  duration,
  gain,
  formants,
}) {
  const attack = Math.min(0.035, duration * 0.12);
  const osc = primitives.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(45, f0), t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + duration);

  const throat = primitives.biquad(
    'lowpass',
    primitives.rnd(2600, 3900),
    0.8,
  );
  const envelope = primitives.envGain(t0, gain, attack, duration);
  const nodes = [osc, throat, envelope];
  osc.connect(throat);
  for (let i = 0; i < formants.length; i++) {
    const band = primitives.biquad(
      'bandpass',
      formants[i] * primitives.rnd(0.94, 1.06),
      4.5 + i * 1.2,
    );
    const weight = primitives.createGain();
    weight.gain.value = [1, 0.72, 0.46][i] || 0.35;
    throat.connect(band).connect(weight).connect(envelope);
    nodes.push(band, weight);
  }
  envelope.connect(out);
  osc.start(t0);
  osc.stop(t0 + attack + duration + 0.04);
  addCleanup(out, () => {
    try { osc.stop(); } catch (_) {}
    for (const node of nodes) {
      try { node.disconnect(); } catch (_) {}
    }
  });
}

export function synthPainVoice(
  out,
  primitives,
  addCleanup,
  {
    damage = 0,
    headshot = false,
    lethal = false,
    self = false,
  } = {},
) {
  const heavy = lethal || damage >= 35;
  const duration = lethal
    ? primitives.rnd(0.86, 1.08)
    : headshot
      ? primitives.rnd(0.58, 0.76)
      : heavy
        ? primitives.rnd(0.52, 0.7)
        : primitives.rnd(0.28, 0.42);
  const t0 = primitives.nowT();
  const base = headshot
    ? primitives.rnd(235, 285)
    : heavy
      ? primitives.rnd(145, 185)
      : primitives.rnd(185, 225);
  const end = lethal
    ? primitives.rnd(62, 82)
    : heavy
      ? primitives.rnd(82, 108)
      : primitives.rnd(115, 145);
  const level = self ? 0.42 : lethal ? 0.36 : heavy ? 0.3 : 0.23;
  const formants = headshot
    ? [
        primitives.rnd(710, 820),
        primitives.rnd(1450, 1680),
        primitives.rnd(2480, 2820),
      ]
    : [
        primitives.rnd(520, 680),
        primitives.rnd(1080, 1370),
        primitives.rnd(2180, 2580),
      ];

  vocalBurst(out, primitives, addCleanup, {
    t0,
    type: lethal || heavy ? 'sawtooth' : 'triangle',
    f0: base,
    f1: end,
    duration: duration * 0.72,
    gain: level,
    formants,
  });
  vocalBurst(out, primitives, addCleanup, {
    t0: t0 + duration * (lethal ? 0.3 : 0.24),
    type: lethal || headshot ? 'sawtooth' : 'triangle',
    f0: base * primitives.rnd(0.88, 1.08),
    f1: end * primitives.rnd(0.82, 1),
    duration: duration * 0.68,
    gain: level * 0.7,
    formants: formants.map((frequency) => (
      frequency * primitives.rnd(0.95, 1.08)
    )),
  });
  primitives.hiss(out, {
    t0: t0 + duration * 0.08,
    filter: 'bandpass',
    f: headshot ? 1950 : 1280,
    q: 1.1,
    sweepTo: lethal ? 520 : 760,
    sweepMs: duration * 0.75,
    rate: primitives.rnd(0.78, 1.16),
    att: 0.008,
    dec: duration * 0.72,
    g: level * (self ? 0.72 : 0.5),
  });
  return { t0, duration };
}

export function bodyImpact(out, primitives, t0, gain = 1) {
  primitives.hiss(out, {
    t0,
    filter: 'lowpass',
    f: 310,
    q: 0.65,
    sweepTo: 95,
    sweepMs: 0.16,
    dec: 0.22,
    g: 0.72 * gain,
  });
  primitives.tone(out, {
    t0,
    type: 'sine',
    f0: 78,
    f1: 34,
    att: 0.001,
    dec: 0.24,
    g: 0.48 * gain,
  });
  primitives.hiss(out, {
    t0: t0 + 0.018,
    filter: 'bandpass',
    f: 1050,
    q: 5,
    dec: 0.028,
    g: 0.2 * gain,
  });
}
