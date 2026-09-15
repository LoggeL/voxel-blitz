// Footstep cadence shared by remote avatars and the local body.
//
// Remote avatars already animate a gait phase from their smoothed speed; a
// footfall is the forward extreme of each leg swing, so the sound lands in
// sync with the visible legs. The local body has no leg animation and runs
// its own phase with the same rate. Loudness grades from a brisk walk to a
// sprint; creeping, crouching, swimming and airborne bodies are silent, which
// mirrors what server bots can hear (server/bot-hearing.js).

export const STEP_SPEED_MIN = 3.2;
export const SPRINT_SPEED = 6.2;
const WALK_VOLUME = 0.45;

/** Gait phase advance in rad/s for a body moving at `speed`, `air01` airborne. */
export function gaitPhaseRate(speed, air01 = 0) {
  return (5.2 + speed * 1.25) * (1 - air01 * 0.85);
}

/** Loudness in [0, 1] of a footfall under these motion conditions, 0 for none. */
export function footstepVolume({ speed = 0, grounded = true, crouch = false, swimming = false } = {}) {
  if (!grounded || crouch || swimming || !(speed >= STEP_SPEED_MIN)) return 0;
  const t = Math.max(0, Math.min(1, (speed - STEP_SPEED_MIN) / (SPRINT_SPEED - STEP_SPEED_MIN)));
  return WALK_VOLUME + (1 - WALK_VOLUME) * t;
}

/** Index of the stride a gait phase is in; changes once per footfall. */
export function strideIndex(phase) {
  return Math.floor((phase - Math.PI / 2) / Math.PI);
}

/** Whether a foot landed while the phase moved from `before` to `after`. */
export function strideCrossed(before, after) {
  return strideIndex(before) !== strideIndex(after);
}

/** Self-contained cadence for a body without a leg animation (the local player). */
export class FootstepCadence {
  constructor() {
    this.phase = 0;
  }

  /**
   * Advance by `dt` seconds and return the loudness of a footfall that landed
   * this frame, or 0.
   */
  update(dt, motion) {
    const speed = Number.isFinite(motion?.speed) ? motion.speed : 0;
    if (!(dt > 0) || speed < 0.2) return 0;
    // Wrap by a whole number of strides so precision holds over long sessions.
    if (this.phase > 1000 * Math.PI) this.phase -= 1000 * Math.PI;
    const before = this.phase;
    this.phase += dt * gaitPhaseRate(speed, motion?.grounded === false ? 1 : 0);
    return strideCrossed(before, this.phase) ? footstepVolume({ ...motion, speed }) : 0;
  }
}
