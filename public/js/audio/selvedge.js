// The gun, the first surface pin and the travelling seam are separate sources.
// A dry pull stays audible even when the shot fails to find a surface.
export function pullFilament(out, voice, sampled = false) {
  // Slightly different winding noise accompanies each pull of the sampled spool.
  const dragHz = voice.rnd(1360, 2310);
  voice.hiss(out, {
    t0: voice.nowT(0.019), filter: 'bandpass', f: dragHz, sweepTo: dragHz * 0.58,
    q: 1.8, att: 0.005, dec: 0.078, rate: voice.rnd(0.91, 1.09), g: 0.16,
  });
  if (sampled) return;
  const t0 = voice.nowT();
  const tuning = voice.rnd(0.977, 1.023);
  voice.hiss(out, {
    t0, filter: 'bandpass', f: 2150, q: 1.35, att: 0.001, dec: 0.023, g: 0.40,
  });
  voice.tone(out, {
    t0, type: 'triangle', f0: 238, f1: 104, att: 0.001, dec: 0.056, g: 0.33,
  });
  // The string unloads rapidly and excites both sides of the ceramic fork.
  for (const [hz, level, decay] of [[236, 0.27, 0.36], [884, 0.11, 0.23], [891, 0.08, 0.26]]) {
    voice.tone(out, {
      t0: t0 + 0.012, type: 'sine', f0: hz * tuning * 1.035, f1: hz * tuning,
      att: 0.003, dec: decay, g: level,
    });
  }
  voice.hiss(out, {
    t0: t0 + 0.13, filter: 'bandpass', f: 1470, q: 2.8, dec: 0.02, g: 0.18,
  });
}

export function reloadSelvedge(out, voice, step, t0) {
  if (step === 1) {
    // Pressure comes off the keeper. Felt pads brush the departing cassette.
    voice.tone(out, { t0, type: 'triangle', f0: 1160, f1: 610, att: 0.001, dec: 0.026, g: 0.21 });
    voice.hiss(out, { t0, filter: 'bandpass', f: 2510, q: 2.1, dec: 0.025, g: 0.25 });
    voice.hiss(out, {
      t0: t0 + 0.029, filter: 'bandpass', f: 1370, sweepTo: 490, sweepMs: 0.13,
      q: 0.72, att: 0.024, dec: 0.14, rate: voice.rnd(0.92, 1.08), g: 0.24,
    });
  } else if (step === 2) {
    // The loaded spool lands on the axle and its opposite cheek settles.
    voice.tone(out, { t0, type: 'sine', f0: 187, f1: 87, dec: 0.095, g: 0.42 });
    voice.hiss(out, { t0, filter: 'lowpass', f: 1150, q: 0.7, att: 0.002, dec: 0.055, g: 0.26 });
    voice.tone(out, { t0: t0 + 0.029, type: 'triangle', f0: 389, f1: 306, dec: 0.048, g: 0.12 });
  } else if (step === 3) {
    voice.hiss(out, { t0, filter: 'bandpass', f: 2810, q: 3.3, att: 0.001, dec: 0.022, g: 0.3 });
    voice.tone(out, { t0, type: 'triangle', f0: 810, f1: 380, dec: 0.027, g: 0.19 });
    voice.tone(out, { t0: t0 + 0.018, type: 'sine', f0: 208, f1: 236, att: 0.008, dec: 0.21, g: 0.13 });
  }
}

// Play once at each server pin, seam departure and simulated arrival. The
// descending arrival is deliberately shorter than the rising departure.
export function stitchContact(out, voice, phase) {
  const t0 = voice.nowT();
  if (phase === 'pin') {
    voice.hiss(out, { t0, filter: 'bandpass', f: 1730, q: 2.8, dec: 0.038, g: 0.30 });
    voice.tone(out, { t0, type: 'sine', f0: 826, f1: 783, dec: 0.21, g: 0.26 });
    voice.tone(out, { t0, type: 'sine', f0: 2140, f1: 1970, dec: 0.095, g: 0.09 });
  } else if (phase === 'sew') {
    voice.hiss(out, { t0, filter: 'bandpass', f: 640, sweepTo: 2590, sweepMs: 0.14,
      q: 2.6, att: 0.016, dec: 0.23, g: 0.28 });
    voice.tone(out, { t0, type: 'triangle', f0: 282, f1: 748, att: 0.012, dec: 0.22, g: 0.19 });
    voice.tone(out, { t0: t0 + 0.011, type: 'sine', f0: 594, f1: 1496, att: 0.016, dec: 0.15, g: 0.13 });
  } else if (phase === 'hem') {
    voice.tone(out, { t0, type: 'sine', f0: 741, f1: 381, att: 0.002, dec: 0.15, g: 0.24 });
    voice.hiss(out, { t0, filter: 'bandpass', f: 1510, sweepTo: 670, sweepMs: 0.07,
      q: 1.8, dec: 0.083, g: 0.19 });
  }
}
