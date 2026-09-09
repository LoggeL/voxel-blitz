import { CONDITION_RULES } from './combatmath.js';
import { flamePanicFloor } from './flame-rules.js';

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
    const capacity = 2.4; // Pressure never removes the chance to steady yourself.
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

/** Shared eligibility for a deliberate, stationary recovery action. */
export function steadyEligible({ alive = true, grounded = true, stationary = false,
  ads = 0, handlingAllowed = true } = {}) {
  return !!(alive && grounded && stationary && handlingAllowed && ads > 0.5);
}

const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/** Mutates only conditions; authority and prediction use identical recovery rates. */
export function recoverConditions(state, dt, { hp = 100, burning = 0, sprinting = false,
  holdingBreath = false, crouching = false } = {}) {
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const missingHealth = 1 - clamp01(hp / 100);
  const recovery = (CONDITION_RULES.panicDecayPerS +
    (holdingBreath ? CONDITION_RULES.steadyPanicRecoverPerS : 0)) *
    (crouching && !sprinting ? CONDITION_RULES.crouchPanicRecoverMult : 1);
  state.panic = clamp01(Math.max(flamePanicFloor(burning), state.panic - recovery * step));
  state.pain = clamp01(Math.max(missingHealth * CONDITION_RULES.painLowHpFloor,
    state.pain - CONDITION_RULES.painDecayPerS * step));
  state.exhaustion = clamp01(state.exhaustion + (sprinting
    ? CONDITION_RULES.exhaustionSprintPerS : -CONDITION_RULES.exhaustionRecoverPerS) * step);
}
