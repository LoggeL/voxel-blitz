// Reload and draw mechanism graphs. Output voice ownership and all WebAudio
// primitives are injected by the facade.

// Per-weapon brightness applied to mechanical click and ping filters.
export const WEP_TONE = {
  rifle: 1,
  smg: 1.16,
  shotgun: 0.86,
  sniper: 1.05,
  lmg: 0.72,
  revolver: 1.32,
  longarc: 1.42,
  rocket: 0.66,
};

// Cloth-rustle draw length per weapon.
export const DRAW_LEN = {
  rifle: 0.11,
  smg: 0.085,
  shotgun: 0.17,
  sniper: 0.21,
  lmg: 0.25,
  revolver: 0.13,
  longarc: 0.22,
  rocket: 0.3,
};

const CYCLE_TONE = Object.freeze({
  shotgun: Object.freeze({
    bandHz: [860, 1180, 2050],
    thumpHz: [94, 78, 112],
    gain: [0.34, 0.46, 0.38],
  }),
  sniper: Object.freeze({
    bandHz: [2950, 1620, 3380],
    thumpHz: [132, 86, 148],
    gain: [0.30, 0.42, 0.36],
  }),
  longarc: Object.freeze({
    bandHz: [1750, 980, 2900],
    thumpHz: [118, 70, 142],
    gain: [0.3, 0.4, 0.32],
  }),
});

/** Render one pump/bolt contact exactly when the viewmodel crosses that contact. */
export function cycleActionClick(out, primitives, weapon, step, t0 = primitives.nowT()) {
  const profile = CYCLE_TONE[weapon];
  if (!profile) return false;
  const numericStep = Number.isFinite(Number(step)) ? Math.trunc(Number(step)) : 1;
  const index = Math.max(0, Math.min(2, numericStep - 1));
  primitives.hiss(out, {
    t0,
    filter: 'bandpass',
    f: profile.bandHz[index],
    q: index === 1 ? 2.2 : 4.5,
    dec: index === 1 ? 0.045 : 0.026,
    g: profile.gain[index],
  });
  primitives.tone(out, {
    t0,
    type: index === 1 ? 'sine' : 'triangle',
    f0: profile.thumpHz[index],
    f1: profile.thumpHz[index] * 0.62,
    dec: index === 1 ? 0.065 : 0.038,
    g: profile.gain[index] * 0.72,
    att: 0.001,
  });
  return true;
}

export function reloadLmg(out, primitives, step, t0, brightness) {
  if (step === 1) {
    primitives.hiss(out, {
      t0, filter: 'lowpass', f: 520, q: 0.7, dec: 0.13, g: 0.5,
    });
    primitives.tone(out, {
      t0: t0 + 0.1, type: 'sine', f0: 86, f1: 45,
      dec: 0.075, g: 0.55,
    });
  } else if (step === 2) {
    primitives.tone(out, {
      t0, type: 'sine', f0: 78, f1: 39, dec: 0.085, g: 0.62,
    });
    primitives.tone(out, {
      t0: t0 + 0.095, type: 'sine', f0: 66, f1: 36,
      dec: 0.07, g: 0.52,
    });
    primitives.hiss(out, {
      t0: t0 + 0.16, filter: 'bandpass', f: 1050 * brightness, q: 5,
      dec: 0.025, g: 0.24,
    });
  } else if (step === 3) {
    primitives.hiss(out, {
      t0, filter: 'bandpass', f: 1250 * brightness, q: 1.5,
      dec: 0.14, g: 0.58,
    });
    primitives.tone(out, {
      t0: t0 + 0.115, type: 'square', f0: 540, f1: 290,
      dec: 0.025, g: 0.28,
    });
  }
}

export function reloadRevolver(out, primitives, step, t0, brightness) {
  if (step === 1) {
    primitives.tone(out, {
      t0, type: 'triangle', f0: 1250 * brightness,
      f1: 720 * brightness, dec: 0.04, g: 0.22,
    });
    primitives.hiss(out, {
      t0: t0 + 0.04, filter: 'highpass', f: 3200, q: 2,
      dec: 0.035, g: 0.2,
    });
  } else if (step === 2) {
    // Three chambers imply a cylinder load without an unbounded source loop.
    for (let i = 0; i < 3; i++) {
      primitives.tone(out, {
        t0: t0 + i * 0.055, type: 'sine', f0: 1420 * brightness,
        f1: 980 * brightness, dec: 0.022, g: 0.17,
      });
    }
  } else if (step === 3) {
    primitives.hiss(out, {
      t0, filter: 'bandpass', f: 2600 * brightness, q: 5,
      dec: 0.025, g: 0.28,
    });
    primitives.tone(out, {
      t0: t0 + 0.045, type: 'square', f0: 1780 * brightness,
      f1: 760 * brightness, dec: 0.026, g: 0.2,
    });
  }
}

/** Coilgun cell swap: generic handling plus a battery-seat clunk and energize chirp. */
export function reloadLongarc(out, primitives, step, t0, brightness) {
  genericReloadStep(out, primitives, step, t0, brightness);
  if (step === 1) {
    primitives.tone(out, {
      t0: t0 + 0.09, type: 'sine', f0: 140, f1: 62,
      dec: 0.06, g: 0.4, att: 0.002,
    });
  } else if (step === 2) {
    primitives.tone(out, {
      t0: t0 + 0.12, type: 'sawtooth', f0: 640 * brightness,
      f1: 2200 * brightness, dec: 0.1, g: 0.13,
    });
  }
}

/** Rocket reload: canister latch pops, a heavy rocket slides home, the arming lever cocks. */
export function reloadRocket(out, primitives, step, t0, brightness) {
  if (step === 1) {
    primitives.hiss(out, {
      t0, filter: 'lowpass', f: 600 * brightness, q: 0.8, dec: 0.09, g: 0.42,
    });
    primitives.tone(out, {
      t0: t0 + 0.05, type: 'square', f0: 900 * brightness, f1: 400, dec: 0.03, g: 0.2,
    });
  } else if (step === 2) {
    primitives.hiss(out, {
      t0, filter: 'bandpass', f: 520 * brightness, q: 0.9, dec: 0.22, g: 0.3,
    });
    primitives.tone(out, {
      t0: t0 + 0.16, type: 'sine', f0: 110, f1: 52, dec: 0.08, g: 0.55, att: 0.002,
    });
    primitives.tone(out, {
      t0: t0 + 0.2, type: 'sine', f0: 84, f1: 46, dec: 0.07, g: 0.4, att: 0.002,
    });
  } else {
    primitives.tone(out, {
      t0, type: 'square', f0: 1400 * brightness, f1: 700, dec: 0.02, g: 0.22,
    });
    primitives.hiss(out, {
      t0: t0 + 0.02, filter: 'bandpass', f: 2200 * brightness, q: 5, dec: 0.02, g: 0.16,
    });
  }
}

export function genericReloadStep(out, primitives, step, t0, brightness) {
  if (step === 1) {
    primitives.hiss(out, {
      t0, filter: 'lowpass', f: 800 * brightness, q: 0.8,
      dec: 0.075, g: 0.38,
    });
    primitives.tone(out, {
      t0: t0 + 0.065, type: 'square', f0: 1450 * brightness,
      dec: 0.012, g: 0.2,
    });
  } else if (step === 2) {
    primitives.tone(out, {
      t0, type: 'sine', f0: 118, f1: 62, dec: 0.05,
      g: 0.5, att: 0.002,
    });
    primitives.tone(out, {
      t0: t0 + 0.06, type: 'sine', f0: 96, f1: 54,
      dec: 0.05, g: 0.4, att: 0.002,
    });
    primitives.hiss(out, {
      t0: t0 + 0.105, filter: 'bandpass', f: 1250 * brightness, q: 4,
      dec: 0.014, g: 0.18,
    });
  } else if (step === 3) {
    primitives.hiss(out, {
      t0, filter: 'highpass', f: 1500 * brightness, q: 0.7,
      dec: 0.095, g: 0.55,
    });
    primitives.tone(out, {
      t0: t0 + 0.01, type: 'sine', f0: 1900 * brightness,
      detune: 6, dec: 0.07, g: 0.22,
    });
    primitives.tone(out, {
      t0: t0 + 0.085, type: 'square', f0: 820,
      dec: 0.012, g: 0.25,
    });
  }
}

export function drawCloth(out, primitives, weapon, t0 = primitives.nowT()) {
  const duration = DRAW_LEN[weapon] || 0.11;
  if (weapon === 'lmg') {
    primitives.hiss(out, {
      t0, filter: 'lowpass', f: 430, q: 0.7,
      dec: duration * 0.75, g: 0.34,
    });
    primitives.tone(out, {
      t0: t0 + duration * 0.55, type: 'sine', f0: 92, f1: 48,
      dec: 0.07, g: 0.3,
    });
    primitives.hiss(out, {
      t0: t0 + duration * 0.82, filter: 'bandpass', f: 1200, q: 5,
      dec: 0.032, g: 0.24,
    });
  } else if (weapon === 'revolver') {
    primitives.hiss(out, {
      t0, filter: 'bandpass', f: 1450, q: 1.1,
      dec: duration * 0.65, g: 0.18,
    });
    primitives.tone(out, {
      t0: t0 + duration * 0.45, type: 'triangle', f0: 1320, f1: 820,
      dec: 0.03, g: 0.16,
    });
    primitives.tone(out, {
      t0: t0 + duration * 0.82, type: 'square', f0: 2050, f1: 980,
      dec: 0.018, g: 0.12,
    });
  } else if (weapon === 'rocket') {
    primitives.hiss(out, {
      t0, filter: 'lowpass', f: 380, q: 0.7,
      dec: duration * 0.8, g: 0.38,
    });
    primitives.tone(out, {
      t0: t0 + duration * 0.6, type: 'sine', f0: 88, f1: 44,
      dec: 0.08, g: 0.34,
    });
    primitives.tone(out, {
      t0: t0 + duration * 0.88, type: 'square', f0: 1100, f1: 520,
      dec: 0.02, g: 0.14,
    });
  } else if (weapon === 'longarc') {
    primitives.hiss(out, {
      t0, filter: 'lowpass', f: 480, q: 0.7,
      dec: duration * 0.7, g: 0.32,
    });
    primitives.tone(out, {
      t0: t0 + duration * 0.5, type: 'sawtooth', f0: 300, f1: 1500,
      dec: 0.09, g: 0.1,
    });
    primitives.tone(out, {
      t0: t0 + duration * 0.85, type: 'square', f0: 1900, f1: 950,
      dec: 0.018, g: 0.1,
    });
  } else {
    primitives.hiss(out, {
      t0, filter: 'bandpass', f: 780, q: 0.8,
      dec: duration * 0.6, g: 0.22,
    });
    primitives.hiss(out, {
      t0: t0 + duration * 0.35, filter: 'bandpass', f: 900, q: 0.7,
      dec: duration * 0.5, g: 0.13,
    });
    primitives.tone(out, {
      t0: t0 + duration * 0.75, type: 'triangle', f0: 240,
      dec: 0.015, g: 0.12,
    });
  }
}
