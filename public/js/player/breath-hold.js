/** Finite breath reserve. Exhaustion requires release and recovery before reuse. */
export class BreathHold {
  constructor() { this.reset(); }

  reset() {
    this.reserve = 1;
    this.holding = false;
    this.exhausted = false;
    this.releasedFor = 0;
    return this;
  }

  update(dt, { eligible = false, pressed = false, panic = 0, pain = 0 } = {}) {
    const step = Math.max(0, Math.min(0.25, Number(dt) || 0));
    const wasHolding = this.holding;
    const capacity = Math.max(0.7, 2.4 - panic * 1.05 - pain * 0.8);
    const requested = eligible && pressed;
    this.releasedFor = requested ? 0 : this.releasedFor + step;
    if (!requested && this.releasedFor >= 0.35) {
      this.reserve = Math.min(1, this.reserve + step / 2.4);
      if (this.reserve >= 0.35) this.exhausted = false;
    }
    this.holding = requested && !this.exhausted && this.reserve > 0;
    if (this.holding) {
      this.reserve = Math.max(0, this.reserve - step / capacity);
      if (this.reserve <= 1e-9) {
        this.reserve = 0;
        this.exhausted = true;
        this.holding = false;
      }
    }
    return {
      holdingBreath: this.holding,
      breathRemaining01: this.reserve,
      breathExhausted: this.exhausted,
      canHoldBreath: eligible,
      breathEvent: this.holding && !wasHolding ? 'inhale'
        : wasHolding && !this.holding ? (this.exhausted ? 'gasp' : 'exhale') : null,
    };
  }
}
