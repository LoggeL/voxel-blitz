import { vocalBurst } from './human.js';

export const PAIN_MOAN_THRESHOLD = 0.1;
const clamp01 = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Occasional local wound reactions, driven by pain rather than frame rate. */
export class PainMoanCadence {
  constructor(random = () => Math.random()) {
    this.random = random;
    this.reset();
  }

  reset() {
    this.nextAt = null;
    this.lastAt = null;
    this.variant = -1;
  }

  update(level, now, { active = true, holding = false } = {}) {
    const pain = clamp01(level);
    if (!active || holding || pain < PAIN_MOAN_THRESHOLD || !Number.isFinite(now)) {
      this.reset();
      return null;
    }
    // Hidden tabs and stopped frame loops cannot accumulate catch-up moans.
    if (this.lastAt != null && (now < this.lastAt || now - this.lastAt > 1000)) this.reset();
    this.lastAt = now;
    if (this.nextAt == null) {
      this.nextAt = now + (650 + (1 - pain) * 550) * (0.85 + this.random() * 0.3);
      return null;
    }
    if (now < this.nextAt) return null;
    this.variant = this.variant < 0 ? Math.floor(this.random() * 3)
      : (this.variant + 1 + Math.floor(this.random() * 2)) % 3;
    const duration = (0.38 + pain * 0.7) * (0.9 + this.random() * 0.2);
    this.nextAt = now + duration * 1000 + (6500 - pain * 4000) * (0.8 + this.random() * 0.4);
    return { pain, variant: this.variant, duration, gain: 0.5 + pain * 0.35 };
  }
}

/** Low groan, open moan, or a broken two-part groan, with a soft breath tail. */
export function renderPainMoan(out, primitives, addCleanup, { pain, variant, duration }) {
  const t0 = primitives.nowT();
  const formants = [[380, 900, 2200], [620, 1150, 2450], [480, 1000, 2300]][variant];
  const pitch = primitives.rnd(100, 122) + pain * 38;
  const level = 0.22 + pain * 0.14;
  const broken = variant === 2;
  vocalBurst(out, primitives, addCleanup, {
    t0, type: 'sawtooth', f0: pitch, f1: pitch * 0.68,
    duration: duration * (broken ? 0.42 : 0.82), gain: level, formants,
  });
  if (broken) vocalBurst(out, primitives, addCleanup, {
    t0: t0 + duration * 0.4, type: 'sawtooth', f0: pitch * 0.9, f1: pitch * 0.58,
    duration: duration * 0.5, gain: level * 0.75, formants,
  });
  primitives.hiss(out, {
    t0: t0 + duration * 0.15, filter: 'bandpass', f: 820 + pain * 400,
    q: 0.7, sweepTo: 380, sweepMs: duration * 0.7,
    att: 0.07, dec: duration * 0.72, g: level * 0.16,
  });
}
