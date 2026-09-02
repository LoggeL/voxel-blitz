// Procedural firearm report graphs. The caller owns output voice lifetime and
// injects the primitive builders; this module never owns an AudioContext.

import { cycleActionClick } from './mechanics.js';

export const FIRE_PARAMS = {
  rifle: {
    blipType: 'square', blipF0: 140, blipF1: 60, blipMs: 90,
    nzFilter: 'highpass', nzF: 2000, nzQ: 0.7, nzMs: 70,
    subHz: 55, subG: 0.5, subMs: 120, drive: 3,
  },
  smg: {
    blipType: 'square', blipF0: 110, blipF1: 46, blipMs: 55,
    nzFilter: 'bandpass', nzF: 3000, nzQ: 1.4, nzMs: 48,
    subHz: 66, subG: 0.32, subMs: 65, drive: 3,
  },
};

// One audible identity per weapon. Sample gain compensates the measured source
// peaks, playback rate follows cadence/weight, and layerGain keeps the synthetic
// transient/mechanics audible without doubling the full report.
const FIRE_REPORT_PROFILES = Object.freeze({
  rifle: Object.freeze({
    lifetime: 0.72, sampleGain: 0.72, sampleRate: 1, layerGain: 0.16,
  }),
  smg: Object.freeze({
    lifetime: 0.5, sampleGain: 1.3, sampleRate: 1.08, layerGain: 0.1,
  }),
  shotgun: Object.freeze({
    lifetime: 1.05, sampleGain: 1.4, sampleRate: 0.92, layerGain: 0.26,
  }),
  sniper: Object.freeze({
    lifetime: 1.45, sampleGain: 0.7, sampleRate: 0.96, layerGain: 0.2,
  }),
  lmg: Object.freeze({
    lifetime: 0.78, sampleGain: 0.66, sampleRate: 0.94, layerGain: 0.18,
  }),
  revolver: Object.freeze({
    lifetime: 0.95, sampleGain: 0.8, sampleRate: 1.02, layerGain: 0.18,
  }),
  longarc: Object.freeze({
    lifetime: 1.15, sampleGain: 0.85, sampleRate: 1, layerGain: 0.22,
  }),
});

export function fireReportProfile(key) {
  return FIRE_REPORT_PROFILES[key] || FIRE_REPORT_PROFILES.rifle;
}

export function shotRifleSmg(out, primitives, params) {
  primitives.tone(out, {
    type: params.blipType,
    f0: params.blipF0,
    f1: params.blipF1,
    dec: params.blipMs / 1000,
    g: 0.26,
  });
  primitives.hiss(out, {
    filter: params.nzFilter,
    f: params.nzF,
    q: params.nzQ,
    dec: params.nzMs / 1000,
    g: 0.5,
  });
  const sat = primitives.shaper(params.drive);
  sat.connect(out);
  primitives.tone(sat, {
    type: 'sine',
    f0: params.subHz,
    f1: params.subHz * 0.72,
    dec: params.subMs / 1000,
    g: params.subG,
    att: 0.001,
  });
}

export function shotShotgun(out, primitives, includeMechanics = true) {
  primitives.hiss(out, {
    filter: 'lowpass', f: 900, sweepTo: 200, sweepMs: 0.22,
    dec: 0.22, g: 0.9,
  });
  primitives.tone(out, {
    type: 'sine', f0: 45, f1: 34, dec: 0.26, g: 0.5, att: 0.001,
  });
  primitives.tone(out, {
    type: 'sine', f0: 60, f1: 44, dec: 0.22, g: 0.36,
    detune: 9, att: 0.001,
  });
  if (includeMechanics) {
    // Remote reports have no local rig callback, so mirror the 430ms pump contacts.
    [0.0602, 0.215, 0.3698].forEach((offset, index) => {
      cycleActionClick(out, primitives, 'shotgun', index + 1, primitives.nowT(offset));
    });
  }
}

// echoIn is the engine-owned persistent echo input. addCleanup is the narrow
// VoicePool cleanup capability; neither owner object crosses this seam.
export function sendEcho(out, primitives, gain, echoIn, addCleanup, cleanupOwner = out) {
  if (!echoIn) return;
  const send = primitives.createGain();
  send.gain.value = gain;
  out.connect(send).connect(echoIn);
  addCleanup(cleanupOwner, () => send.disconnect());
}

export function shotSniper(
  out,
  primitives,
  echoIn,
  addCleanup,
  cleanupOwner = out,
  includeMechanics = true,
) {
  primitives.hiss(out, {
    filter: 'highpass', f: 6000, dec: 0.03, g: 0.6,
  });
  primitives.tone(out, {
    type: 'sawtooth', f0: 180, f1: 70, dec: 0.2, g: 0.3,
  });
  primitives.tone(out, {
    type: 'sine', f0: 38, f1: 30, dec: 0.42, g: 0.55, att: 0.001,
  });
  sendEcho(out, primitives, 0.5, echoIn, addCleanup, cleanupOwner);
  if (includeMechanics) {
    // Remote reports mirror the one-second bolt animation's three contacts.
    [0.12, 0.5, 0.92].forEach((offset, index) => {
      cycleActionClick(out, primitives, 'sniper', index + 1, primitives.nowT(offset));
    });
  }
}

export function shotLmg(out, primitives) {
  primitives.hiss(out, {
    filter: 'bandpass', f: 1350, q: 0.75, sweepTo: 430,
    sweepMs: 0.1, dec: 0.11, g: 0.58,
  });
  primitives.tone(out, {
    type: 'square', f0: 98, f1: 43, dec: 0.11, g: 0.3,
  });
  primitives.tone(out, {
    type: 'sine', f0: 43, f1: 31, dec: 0.18, g: 0.48, att: 0.001,
  });
  primitives.hiss(out, {
    t0: primitives.nowT(0.055), filter: 'bandpass', f: 2350, q: 6,
    dec: 0.018, g: 0.24,
  });
}

export function shotRevolver(out, primitives) {
  primitives.hiss(out, {
    filter: 'highpass', f: 5200, q: 0.65, dec: 0.045, g: 0.68,
  });
  primitives.tone(out, {
    type: 'sawtooth', f0: 270, f1: 92, dec: 0.15, g: 0.31,
  });
  primitives.tone(out, {
    type: 'sine', f0: 58, f1: 41, dec: 0.21, g: 0.36, att: 0.001,
  });
  primitives.tone(out, {
    t0: primitives.nowT(0.055), type: 'square', f0: 1850, f1: 880,
    dec: 0.018, g: 0.13,
  });
}

export function shotLongarc(out, primitives) {
  const t0 = primitives.nowT();
  const crackAt = primitives.nowT(0.12);
  // Capacitor whine rising into the discharge.
  primitives.tone(out, {
    t0, type: 'sawtooth', f0: 320, f1: 2600, dec: 0.12, g: 0.13,
  });
  primitives.tone(out, {
    t0, type: 'sine', f0: 640, f1: 3100, dec: 0.12, g: 0.07,
  });
  // Hypersonic crack: brighter and louder than the revolver transient.
  primitives.hiss(out, {
    t0: crackAt, filter: 'highpass', f: 6800, q: 0.6, dec: 0.05, g: 0.74,
  });
  primitives.tone(out, {
    t0: crackAt, type: 'sawtooth', f0: 340, f1: 90, dec: 0.16, g: 0.34,
  });
  // Sub thump under the crack, lighter than the sniper's weight.
  primitives.tone(out, {
    t0: crackAt, type: 'sine', f0: 55, f1: 30, dec: 0.3, g: 0.46, att: 0.001,
  });
  // ~0.5s ionized tail sweeping down from the discharge.
  primitives.hiss(out, {
    t0: crackAt, filter: 'bandpass', f: 4200, sweepTo: 900,
    sweepMs: 0.5, q: 1.2, dec: 0.5, g: 0.2,
  });
}

/** Render the weapon-specific synthetic transient and mechanical tail. */
export function renderFireReport(
  key,
  out,
  primitives,
  echoIn,
  addCleanup,
  cleanupOwner = out,
  { includeMechanics = true } = {},
) {
  if (key === 'shotgun') shotShotgun(out, primitives, includeMechanics);
  else if (key === 'sniper') {
    shotSniper(out, primitives, echoIn, addCleanup, cleanupOwner, includeMechanics);
  } else if (key === 'lmg') shotLmg(out, primitives);
  else if (key === 'revolver') shotRevolver(out, primitives);
  else if (key === 'longarc') shotLongarc(out, primitives);
  else shotRifleSmg(out, primitives, FIRE_PARAMS[key] || FIRE_PARAMS.rifle);
}
