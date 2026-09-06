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
    lifetime: 1.25, sampleGain: 0.99, sampleRate: 1, layerGain: 0.12,
  }),
  lance: Object.freeze({
    lifetime: 1.0, sampleGain: 1.05, sampleRate: 1.04, layerGain: 0.12,
  }),
  knife: Object.freeze({
    lifetime: 0.5, sampleGain: 0.9, sampleRate: 1.12, layerGain: 0.18,
  }),
  flamethrower: Object.freeze({ lifetime: 0.5, sampleGain: 1, sampleRate: 1, layerGain: 1 }),
  rocket: Object.freeze({
    lifetime: 1.6, sampleGain: 0.99, sampleRate: 0.9, layerGain: 0.18,
  }),
});

export function fireReportProfile(key) {
  return FIRE_REPORT_PROFILES[key] || FIRE_REPORT_PROFILES.rifle;
}

// The recording is a full discharge. Early release must reduce the recorded
// layer as well as the procedural voice, including remote positional shots.
export function fireSampleProfile(key, charge = 1) {
  const profile = fireReportProfile(key);
  const held = Math.max(0, Math.min(1, Number.isFinite(charge) ? charge : 1));
  const strength = key === 'longarc' ? 0.16 + 0.84 * held * held
    : key === 'lance' ? 0.45 + 0.55 * held : 1;
  return { gain: profile.sampleGain * strength, rate: profile.sampleRate };
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

/**
 * LONGARC discharge. `charge` (0..1) is the released capacitor level: a tap is a short,
 * thin dart snap; a full charge is a hypersonic crack with a long ionized tail, and the
 * whine-up is skipped because the live charge loop already played it while held.
 */
export function shotLongarc(out, primitives, charge = 1) {
  const level = Math.max(0, Math.min(1, Number.isFinite(charge) ? charge : 1));
  const t0 = primitives.nowT();
  // A short, rounded pulse with a restrained ion tail, without the firearm crack.
  primitives.tone(out, {
    t0, type: 'sine', f0: 1500 + level * 500, f1: 420,
    att: 0.004, dec: 0.12, g: 0.12 + level * 0.05,
  });
  primitives.tone(out, {
    t0, type: 'sine', f0: 110, f1: 55,
    att: 0.004, dec: 0.1, g: 0.08 + level * 0.04,
  });
  primitives.hiss(out, {
    t0, filter: 'bandpass', f: 1800, sweepTo: 700,
    sweepMs: 0.16, q: 0.7, dec: 0.16, g: 0.035,
  });
}

/** RX-8 HAVOC launch: a deep tube thump, the igniter pop, and a roaring back-blast whoosh. */
export function shotRocket(out, primitives) {
  const t0 = primitives.nowT();
  primitives.tone(out, {
    t0, type: 'sine', f0: 92, f1: 34, dec: 0.5, g: 0.8, att: 0.002,
  });
  primitives.tone(out, {
    t0: t0 + 0.01, type: 'square', f0: 260, f1: 70, dec: 0.16, g: 0.24,
  });
  primitives.hiss(out, {
    t0, filter: 'lowpass', f: 900, sweepTo: 220, sweepMs: 0.45, q: 0.7, dec: 0.5, g: 0.7,
  });
  primitives.hiss(out, {
    t0: t0 + 0.04, filter: 'bandpass', f: 1600, sweepTo: 420, sweepMs: 0.6, q: 1.1, dec: 0.7, g: 0.3,
  });
  primitives.hiss(out, {
    t0: t0 + 0.006, filter: 'highpass', f: 3400, q: 0.6, dec: 0.06, g: 0.3,
  });
}

/** Chain-arc zap: a short electric crackle between two bodies. */
export function arcZap(out, primitives) {
  const t0 = primitives.nowT();
  primitives.hiss(out, {
    t0, filter: 'bandpass', f: 5200, sweepTo: 1800, sweepMs: 0.1, q: 2.4, dec: 0.12, g: 0.4,
  });
  primitives.tone(out, {
    t0, type: 'square', f0: 2400, f1: 480, dec: 0.09, g: 0.12,
  });
  primitives.tone(out, {
    t0: t0 + 0.015, type: 'sawtooth', f0: 180, f1: 60, dec: 0.1, g: 0.2, att: 0.001,
  });
}

/**
 * VOLTLANCE discharge. `charge` (0..1) is the released capacitor level, floor-lifted so a
 * tap still lands at the lance's minimum intensity: a needle-sharp high crack on release,
 * a fast descending bandpass "lance snap" tail, and much less boom than LONGARC's bank
 * dump. The whine-up is skipped because the live charge loop already played it while held.
 */
export function shotLance(out, primitives, charge = 1) {
  const held = Math.max(0, Math.min(1, Number.isFinite(charge) ? charge : 1));
  const level = 0.45 + 0.55 * held;
  const t0 = primitives.nowT();
  const crackAt = primitives.nowT(Math.max(0, 0.015 + 0.02 * (held - 1)));
  // Rail ionization tick: a thin, fast square needle, brighter and tighter than LONGARC's saw snap.
  primitives.tone(out, {
    t0, type: 'square', f0: 1600 + level * 1800, f1: 3400 + level * 2600, dec: 0.028, g: 0.05 + level * 0.05,
  });
  // Needle crack: an ultra-bright transient with almost no body behind it.
  primitives.hiss(out, {
    t0: crackAt, filter: 'highpass', f: 7400 + level * 2200, q: 0.5,
    dec: 0.02 + level * 0.015, g: 0.34 + level * 0.3,
  });
  primitives.tone(out, {
    t0: crackAt, type: 'square', f0: 980, f1: 210, dec: 0.05 + level * 0.04, g: 0.12 + level * 0.1,
  });
  // Less boom than LONGARC: a light, quick sub tap under the crack.
  primitives.tone(out, {
    t0: crackAt, type: 'sine', f0: 78, f1: 40, dec: 0.06 + level * 0.08, g: 0.05 + level * 0.09, att: 0.001,
  });
  // Lance snap: a fast descending bandpass tail, shorter and harder-edged than the ionized sweep.
  primitives.hiss(out, {
    t0: crackAt, filter: 'bandpass', f: 5600, sweepTo: 700,
    sweepMs: 0.1 + level * 0.18, q: 1.8, dec: 0.09 + level * 0.18, g: 0.05 + level * 0.13,
  });
}

/**
 * Pickaxe swing: a short wooden swish and low retro transient. Deliberately short and echo-free; melee needs no report.
 */
export function shotKnife(out, primitives) {
  const t0 = primitives.nowT();
  primitives.hiss(out, {
    t0, filter: 'bandpass', f: 1200, sweepTo: 280, sweepMs: 0.12,
    q: 0.6, dec: 0.12, g: 0.2,
  });
  primitives.hiss(out, { t0: t0 + 0.025, filter: 'lowpass', f: 420, dec: 0.06, g: 0.07 });
  primitives.tone(out, { t0, type: 'triangle', f0: 160, f1: 70, dec: 0.045, g: 0.025 });
}

/** Render the weapon-specific synthetic transient and mechanical tail. */
export function renderFireReport(
  key,
  out,
  primitives,
  echoIn,
  addCleanup,
  cleanupOwner = out,
  { includeMechanics = true, charge = 1 } = {},
) {
  if (key === 'flamethrower') {
    primitives.hiss(out, { filter: 'lowpass', f: 1800, sweepTo: 450, sweepMs: 0.3, dec: 0.32, att: 0.025, g: 0.6 });
    primitives.tone(out, { type: 'sine', f0: 75, f1: 40, dec: 0.25, att: 0.02, g: 0.2 });
  } else if (key === 'shotgun') shotShotgun(out, primitives, includeMechanics);
  else if (key === 'sniper') {
    shotSniper(out, primitives, echoIn, addCleanup, cleanupOwner, includeMechanics);
  } else if (key === 'lmg') shotLmg(out, primitives);
  else if (key === 'revolver') shotRevolver(out, primitives);
  else if (key === 'longarc') shotLongarc(out, primitives, charge);
  else if (key === 'lance') shotLance(out, primitives, charge);
  else if (key === 'knife') shotKnife(out, primitives);
  else if (key === 'rocket') shotRocket(out, primitives);
  else shotRifleSmg(out, primitives, FIRE_PARAMS[key] || FIRE_PARAMS.rifle);
}
