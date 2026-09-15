// Second-order aim steering for bots. Two things make bot aim read as a
// smooth, human-like curve instead of a servo:
//
//  1. Velocity continuity. Each axis carries an angular velocity that ramps
//     up under an acceleration cap (ease-in), approaches the target
//     proportionally near it (ease-out, slight natural overshoot) and never
//     snaps. Far from the target the turn is still capped by the turn rate,
//     so reaction timing is unchanged.
//  2. Time-correlated aim error. The old code drew fresh noise every tick,
//     which jitters the crosshair at tick rate. The wander here is a slow
//     drift plus a faster tremor, both mean-reverting, with the same
//     stationary spread as before so hit rates are unchanged.
//  3. Simulated view kick. Humans see their view jump with every shot and
//     pull against it; the server only ever receives the corrected angles.
//     Bots get the same kick applied on top of their steered aim and bleed
//     it off at a skill-dependent rate, so low-skill bots climb during a
//     spray and high-skill bots hold the pattern down.
//
// No renderer, network or engine dependency; pure state + math.

const AIM_RAMP_S = 0.035;     // seconds to reach full turn speed from rest
const AIM_SETTLE_RATE = 14;   // 1/s proportional gain near the target
const SNAP_RESET = 0.25;      // external jump (respawn, takeover) above this drops velocity
const DRIFT_TAU_S = 0.45;     // slow wander correlation time
const TREMOR_TAU_S = 0.12;    // fast wander correlation time
const TREMOR_WEIGHT = 0.45;   // drift² + tremor² == 1 keeps the stationary spread
const DRIFT_WEIGHT = Math.sqrt(1 - TREMOR_WEIGHT ** 2);
const KICK_TAU_SLOW_S = 0.55;  // recoil recovery time constant at skill 0
const KICK_TAU_FAST_S = 0.08;  // ... and at skill 1
const DEG = Math.PI / 180;

const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

/** Cheap centered noise in [-1, 1] standing in for gaussian aim error. */
export function gaussish(rng) {
  return ((rng() + rng() + rng()) - 1.5) * (2 / 3);
}

/** Mean-reverting unit wander: stationary spread equals that of one gaussish draw. */
function ornsteinUhlenbeck(value, tauS, dt, rng) {
  const keep = Math.exp(-dt / tauS);
  return value * keep + gaussish(rng) * Math.sqrt(1 - keep * keep);
}

export class AimSteering {
  constructor() {
    this.yaw = { v: 0, last: null };
    this.pitch = { v: 0, last: null };
    this.driftYaw = 0; this.driftPitch = 0;
    this.tremorYaw = 0; this.tremorPitch = 0;
    this.kickYaw = 0; this.kickPitch = 0;
  }

  /** Drop momentum and kick, e.g. on respawn. Wander state is harmless to keep. */
  reset() {
    this.yaw.v = 0; this.yaw.last = null;
    this.pitch.v = 0; this.pitch.last = null;
    this.kickYaw = 0; this.kickPitch = 0;
  }

  /** Forget any uncorrected kick, e.g. when the fight ends. */
  dropKick() {
    this.kickYaw = 0; this.kickPitch = 0;
  }

  /** One shot's view kick in degrees, as the client would apply it. */
  kick(yawDeg, pitchDeg) {
    this.kickYaw += yawDeg * DEG;
    this.kickPitch += pitchDeg * DEG;
  }

  /**
   * Pull against the accumulated kick for one tick. Returns the residual
   * offset that still sits on the view before and after this tick, so the
   * caller can strip the old residual off the authoritative angles, steer
   * the clean aim, and add the new residual back on.
   */
  recoil(dt, skill) {
    const prev = { yaw: this.kickYaw, pitch: this.kickPitch };
    const s = Math.max(0, Math.min(1, skill));
    const tau = KICK_TAU_SLOW_S + (KICK_TAU_FAST_S - KICK_TAU_SLOW_S) * s;
    const keep = dt > 0 ? Math.exp(-dt / tau) : 1;
    this.kickYaw *= keep;
    this.kickPitch *= keep;
    return { prev, yaw: this.kickYaw, pitch: this.kickPitch };
  }

  /**
   * Advance one axis toward `target` and return the new angle.
   * @param {'yaw'|'pitch'} axis
   * @param {number} current authoritative angle this tick
   * @param {number} target desired angle
   * @param {number} maxSpeed rad/s ceiling
   * @param {number} dt seconds
   */
  steer(axis, current, target, maxSpeed, dt) {
    const s = this[axis];
    if (!(dt > 0) || !(maxSpeed > 0)) return current;
    if (s.last !== null && Math.abs(wrapAngle(current - s.last)) > SNAP_RESET) s.v = 0;
    const error = wrapAngle(target - current);
    const accel = maxSpeed / AIM_RAMP_S;
    const size = Math.abs(error);
    // Cruise at the cap, decelerate proportionally, and never demand more
    // speed than the acceleration cap can bleed off before the target.
    const wanted = Math.sign(error) * Math.min(maxSpeed, size * AIM_SETTLE_RATE, Math.sqrt(2 * accel * size));
    s.v += Math.max(-accel * dt, Math.min(accel * dt, wanted - s.v));
    let step = s.v * dt;
    if ((step > 0 && step > error) || (step < 0 && step < error)) { step = error; s.v = error / dt; }
    const next = axis === 'yaw' ? wrapAngle(current + step) : current + step;
    s.last = next;
    return next;
  }

  /**
   * Advance the wander and return the current aim error in radians for both
   * axes. `sigmaRad` scales the yaw error; pitch uses `pitchScale` of it.
   * The stationary spread matches one `gaussish(rng) * sigmaRad` draw.
   */
  wander(dt, sigmaRad, pitchScale, rng) {
    if (dt > 0) {
      this.driftYaw = ornsteinUhlenbeck(this.driftYaw, DRIFT_TAU_S, dt, rng);
      this.driftPitch = ornsteinUhlenbeck(this.driftPitch, DRIFT_TAU_S, dt, rng);
      this.tremorYaw = ornsteinUhlenbeck(this.tremorYaw, TREMOR_TAU_S, dt, rng);
      this.tremorPitch = ornsteinUhlenbeck(this.tremorPitch, TREMOR_TAU_S, dt, rng);
    }
    const unitYaw = this.driftYaw * DRIFT_WEIGHT + this.tremorYaw * TREMOR_WEIGHT;
    const unitPitch = this.driftPitch * DRIFT_WEIGHT + this.tremorPitch * TREMOR_WEIGHT;
    return { yaw: unitYaw * sigmaRad, pitch: unitPitch * sigmaRad * pitchScale };
  }

  /** Current angular speed in rad/s, for diagnostics and tests. */
  get speed() {
    return Math.hypot(this.yaw.v, this.pitch.v);
  }
}
