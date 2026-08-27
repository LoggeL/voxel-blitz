// Material impact synthesis profiles and pure graph builders.

export const IMPACT_PARAMS = {
  stone: {
    nzFilter: 'bandpass', nzF: 1200, nzQ: 4, ms: 60, g: 0.68,
  },
  wood: {
    nzFilter: 'bandpass', nzF: 500, nzQ: 5, ms: 75, g: 0.62,
    knock: { type: 'triangle', f: 180, ms: 40, g: 0.36 },
  },
  metal: {
    partials: [900, 1359, 2140, 3415], ringMs: 300, g: 0.19,
    strikeMs: 6, strikeG: 0.38,
  },
  glass: {
    sparkles: 5, fMin: 2400, fMax: 7000, lifeMs: 260, g: 0.1,
  },
  flesh: {
    nzFilter: 'lowpass', nzF: 400, nzQ: 0.7, ms: 85, g: 0.58, cap: 0.45,
  },
};

export function impactGlass(out, primitives, volume) {
  const params = IMPACT_PARAMS.glass;
  const t0 = primitives.nowT();
  for (let i = 0; i < params.sparkles; i++) {
    const frequency = primitives.rnd(params.fMin, params.fMax);
    primitives.tone(out, {
      t0: t0 + i * 0.019 + primitives.rnd(0, 0.008),
      type: 'sine',
      f0: frequency,
      f1: frequency * 0.93,
      att: 0.002,
      dec: (params.lifeMs / 1000) * (1 - i * 0.09),
      g: params.g * volume,
    });
  }
  primitives.hiss(out, {
    t0, filter: 'highpass', f: 6500, q: 0.5,
    dec: 0.16, g: 0.1 * volume,
  });
}

export function impactMetal(out, primitives, volume) {
  const params = IMPACT_PARAMS.metal;
  const t0 = primitives.nowT();
  primitives.hiss(out, {
    t0,
    filter: 'highpass',
    f: 3200,
    dec: params.strikeMs / 1000,
    g: params.strikeG * volume,
  });
  params.partials.forEach((frequency, index) => {
    primitives.tone(out, {
      t0,
      type: 'sine',
      f0: frequency,
      att: 0.002,
      dec: params.ringMs / 1000,
      g: params.g * (1 - index * 0.16) * volume,
      detune: primitives.rnd(-4, 4),
    });
  });
}

export function genericImpact(
  out,
  primitives,
  params,
  volume,
  t0 = primitives.nowT(),
) {
  primitives.hiss(out, {
    t0,
    filter: params.nzFilter,
    f: params.nzF,
    q: params.nzQ,
    dec: params.ms / 1000,
    g: params.g * volume,
  });
  if (params.knock) {
    primitives.tone(out, {
      t0,
      type: params.knock.type,
      f0: params.knock.f,
      f1: params.knock.f * 0.82,
      dec: params.knock.ms / 1000,
      g: params.knock.g * volume,
    });
  }
}
