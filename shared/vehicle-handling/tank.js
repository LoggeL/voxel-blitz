/** Shared heavy arcade tank simulation. Aim angles are world-space radians. */
export const TANK_RULES = Object.freeze({
  hp: 850, speed: 13, reverse: 5, acceleration: 3.8, brake: 8,
  drag: 1.5, turn: 0.85, turnAcceleration: 1.7, pivotTurn: 0.72,
  radius: 2.65, height: 2.65, length: 5.1, width: 3.7, seatHeight: 1.9,
  maxStep: 1, maxSlope: 1.1, respawnSeconds: 25, fireSeconds: 2.5,
  turretRate: 1.05, turretPitchRate: 0.65,
  turretMinPitch: -0.18, turretMaxPitch: 0.55,
  turretForward: 0.19, gunPivotHeight: 2.06, gunPivotForward: 1, barrelLength: 3.2405,
});

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const approach = (value, target, amount) => value + clamp(target - value, -amount, amount);
const duration = dt => clamp(finite(dt), 0, 0.25);

/** Forward/reverse input first brakes opposing motion. Differential steering
 * remains available at rest; hull turn velocity takes time to build and stop.
 * Mouse aim is deliberately absent from this drive interface. */
export function stepTankDrive(state, { throttle = 0, steer = 0, brake = 0 } = {}, dt = 0) {
  const rules = TANK_RULES;
  throttle = clamp(finite(throttle), -1, 1);
  steer = clamp(finite(steer), -1, 1);
  brake = clamp(finite(brake), 0, 1);
  state.speed = clamp(finite(state.speed), -rules.reverse, rules.speed);
  state.yaw = wrap(finite(state.yaw));
  state.yawRate = clamp(finite(state.yawRate), -rules.turn, rules.turn);
  let remaining = duration(dt);
  while (remaining > 1e-10) {
    const step = Math.min(remaining, 1 / 120);
    remaining -= step;
    const targetSpeed = throttle * (throttle >= 0 ? rules.speed : rules.reverse);
    const opposing = state.speed * throttle < 0;
    const target = brake > 0 || opposing ? 0 : targetSpeed;
    const slowing = Math.abs(target) < Math.abs(state.speed);
    const rate = brake > 0 ? rules.brake * brake :
      (throttle === 0 ? rules.drag : (opposing || slowing ? rules.brake : rules.acceleration));
    state.speed = approach(state.speed, target, rate * step);
    // Travel gives the tracks more steering authority, without reversing the
    // driver's left/right convention when the hull travels backwards.
    const moving = clamp(Math.abs(state.speed) / 4, 0, 1);
    const targetTurn = -steer * (rules.pivotTurn + (rules.turn - rules.pivotTurn) * moving);
    const oldRate = state.yawRate;
    state.yawRate = approach(oldRate, targetTurn, rules.turnAcceleration * step);
    state.yaw = wrap(state.yaw + (oldRate + state.yawRate) * 0.5 * step);
  }
  state.leftTrackSpeed = state.speed - state.yawRate * rules.width * 0.5;
  state.rightTrackSpeed = state.speed + state.yawRate * rules.width * 0.5;
  return state;
}

/** Turret rotation takes the shortest angular path and can turn through 360
 * degrees independently of hull orientation. Elevation respects gun limits. */
export function stepTankTurret(state, { yaw, pitch } = {}, dt = 0) {
  const rules = TANK_RULES;
  state.turretYaw = wrap(finite(state.turretYaw, finite(state.yaw)));
  state.turretPitch = clamp(finite(state.turretPitch), rules.turretMinPitch, rules.turretMaxPitch);
  const elapsed = duration(dt);
  const targetYaw = wrap(finite(yaw, state.turretYaw));
  const targetPitch = clamp(finite(pitch, state.turretPitch), rules.turretMinPitch, rules.turretMaxPitch);
  state.turretYaw = wrap(state.turretYaw + clamp(wrap(targetYaw - state.turretYaw), -rules.turretRate * elapsed, rules.turretRate * elapsed));
  state.turretPitch = approach(state.turretPitch, targetPitch, rules.turretPitchRate * elapsed);
  return state;
}
