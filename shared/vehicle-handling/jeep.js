/** Arcade offroad Jeep. Distances are metres, time seconds, angles radians. */
export const JEEP_RULES = Object.freeze({
  hp: 260, radius: 2.1, height: 2.25, seatHeight: 1.35,
  speed: 24, reverse: 7, acceleration: 10, brake: 20, drag: 3.2,
  turn: 1.4, wheelbase: 2.6, maxStep: 1, maxSlope: 1.1,
  respawnSeconds: 18, fireSeconds: 0,
});

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : 0));
const approach = (value, target, amount) => value < target ? Math.min(target, value + amount) : Math.max(target, value - amount);

/**
 * Mutates speed/yaw only for motion; the caller owns position and collisions.
 * Positive steer turns right, matching vehicleDirection's negative-Z forward.
 * Optional brake (0..1) overrides throttle. visualSteer and yawRate are derived
 * presentation values, never additional movement inputs.
 */
export function stepJeepDrive(state, input = {}, dt) {
  if (!state || !Number.isFinite(dt) || dt <= 0) return state;
  state.speed = clamp(state.speed, -JEEP_RULES.reverse, JEEP_RULES.speed);
  state.yaw = Number.isFinite(state.yaw) ? state.yaw : 0;
  const throttle = clamp(input?.throttle, -1, 1);
  const steer = clamp(input?.steer, -1, 1);
  const brake = clamp(input?.brake, 0, 1);
  const duration = Math.min(dt, 0.25);
  const steps = Math.ceil(duration * 240 - 1e-9);
  const h = duration / steps;
  for (let i = 0; i < steps; i++) {
    const oldSpeed = state.speed;
    const reversing = throttle !== 0 && oldSpeed !== 0 && Math.sign(throttle) !== Math.sign(oldSpeed);
    if (brake > 0 || reversing) {
      // Direction changes reach zero first; never jump through zero in a step.
      state.speed = approach(oldSpeed, 0, JEEP_RULES.brake * (brake || 1) * h);
    } else if (throttle === 0) {
      state.speed = approach(oldSpeed, 0, (JEEP_RULES.drag + Math.abs(oldSpeed) * 0.11) * h);
    } else {
      const limit = throttle > 0 ? JEEP_RULES.speed : JEEP_RULES.reverse;
      const target = throttle * limit;
      const taper = 1 - 0.55 * Math.min(1, Math.abs(oldSpeed) / limit);
      state.speed = approach(oldSpeed, target, JEEP_RULES.acceleration * taper * h);
    }
    const speed = (oldSpeed + state.speed) * 0.5;
    // Bicycle curvature narrows steering at speed. Reversing reverses yaw.
    const wheelAngle = steer * (0.43 / (1 + (Math.abs(speed) / 15) ** 2));
    const yawRate = clamp(speed * Math.tan(wheelAngle) / JEEP_RULES.wheelbase, -JEEP_RULES.turn, JEEP_RULES.turn);
    state.yaw -= yawRate * h;
    state.visualSteer = wheelAngle;
    state.yawRate = -yawRate;
  }
  return state;
}
