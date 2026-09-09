/** Frame-driven breathing cadence. No timers or queued catch-up breaths survive a pause. */
export class PanicBreathCadence {
  constructor() { this.reset(); }
  reset() { this.nextAt = null; this.inhale = true; }
  update(level, now, { active = true, holding = false } = {}) {
    const panic = Math.max(0, Math.min(1, Number(level) || 0));
    if (!active || holding || panic < 0.15 || !Number.isFinite(now)) {
      this.reset();
      return null;
    }
    if (this.nextAt == null) { this.nextAt = now + 300; return null; }
    if (now < this.nextAt) return null;
    const event = this.inhale ? 'inhale' : 'exhale';
    this.inhale = !this.inhale;
    this.nextAt = now + 1250 - panic * 650;
    return { event, gain: 0.10 + panic * 0.22 };
  }
}
