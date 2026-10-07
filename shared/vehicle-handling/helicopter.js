/** Assisted helicopter flight. Metres, seconds and world-space radians. */
export const HELICOPTER_RULES = Object.freeze({
  hp: 550, width: 3, length: 7, height: 3.2, radius: 4, seatHeight: 1.7,
  speed: 34, reverse: 12, acceleration: 8, brake: 15, drag: 0.08, airDrag: 0.0015,
  climb: 8, descent: 6, fallSpeed: 35, gravity: 9.81,
  liftAcceleration: 9, verticalResponse: 2.4, collectiveRate: 1.2,
  turn: 1.1, turnAcceleration: 2.2, aimResponse: 2.5,
  pitchRate: 0.75, rollRate: 0.9, minPitch: -0.45, maxPitch: 0.4,
  maxBank: 0.55, cyclicAcceleration: 2.4, attitudeResponse: 2.2,
  rotorAcceleration: 0.9, rotorDeceleration: 0.55,
  ceiling: 180, respawnSeconds: 30, fireSeconds: 0.65,
});

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const approach = (value, target, amount) => value + clamp(target - value, -amount, amount);

function limitHorizontal(state, maximum) {
  const speed = Math.hypot(state.vx, state.vz);
  if (speed > maximum) {
    state.vx *= maximum / speed;
    state.vz *= maximum / speed;
  }
}

/**
 * Mutates orientation, velocity and rotor presentation only. The caller owns
 * XYZ integration, swept collisions and the grounded contact flag.
 *
 * throttle is fore/aft cyclic, steer is lateral cyclic, lift is assisted
 * collective, all -1..1. Positive throttle lowers the nose, positive steer
 * banks right, positive lift climbs. Neutral lift stabilizes vertical speed.
 * Optional pitchControl/rollControl/yawControl are angular rate commands.
 * Positive pitchControl raises the nose; positive roll/yaw controls go right.
 * Pitch control combines with keyboard throttle. Explicit roll control
 * replaces steer; explicit pitch/yaw controls suppress legacy aim angles.
 * Legacy yaw/pitch are desired attitudes for assisted bot flight. Brake 0..1
 * counters drift through cyclic tilt, rather than cancelling velocity.
 * Centered cyclic gently levels the hull while horizontal momentum persists.
 * active:false removes rotor lift even while the rotor visibly winds down.
 * `rules` selects the airframe constants; the transport reuses this stepper.
 */
export function stepHelicopterFlight(state, input = {}, dt = 0, rules = HELICOPTER_RULES) {
  if (!state || typeof state !== 'object') return state;
  const maximumThrust = rules.gravity + rules.liftAcceleration;
  state.yaw = wrap(finite(state.yaw));
  state.pitch = clamp(finite(state.pitch), rules.minPitch, rules.maxPitch);
  state.roll = clamp(finite(state.roll), -rules.maxBank, rules.maxBank);
  state.yawRate = clamp(finite(state.yawRate), -rules.turn, rules.turn);
  state.pitchRate = clamp(finite(state.pitchRate), -rules.pitchRate, rules.pitchRate);
  state.rollRate = clamp(finite(state.rollRate), -rules.rollRate, rules.rollRate);
  state.vx = clamp(finite(state.vx), -rules.speed, rules.speed);
  state.vy = clamp(finite(state.vy), -rules.fallSpeed, rules.climb);
  state.vz = clamp(finite(state.vz), -rules.speed, rules.speed);
  state.rotorSpeed = clamp(finite(state.rotorSpeed), 0, 1);
  state.collective = clamp(finite(state.collective, rules.gravity / maximumThrust), 0, 1);
  limitHorizontal(state, rules.speed);

  const active = input?.active !== false;
  const grounded = typeof input?.grounded === 'boolean' ? input.grounded : state.grounded === true;
  const throttle = active ? clamp(finite(input?.throttle), -1, 1) : 0;
  const steer = active ? clamp(finite(input?.steer), -1, 1) : 0;
  const lift = active ? clamp(finite(input?.lift), -1, 1) : 0;
  const brake = active ? clamp(finite(input?.brake), 0, 1) : 0;
  const manualPitch = Number.isFinite(input?.pitchControl);
  const manualRoll = Number.isFinite(input?.rollControl);
  const manualYaw = Number.isFinite(input?.yawControl);
  const pitchControl = active ? clamp(finite(input?.pitchControl), -1, 1) : 0;
  const rollControl = active ? clamp(finite(input?.rollControl), -1, 1) : 0;
  const yawControl = active ? clamp(finite(input?.yawControl), -1, 1) : 0;
  const aimYaw = !manualYaw && Number.isFinite(input?.yaw) ? wrap(input.yaw) : null;
  const aimPitch = !manualPitch && Number.isFinite(input?.pitch) ? clamp(input.pitch, rules.minPitch, rules.maxPitch) : 0;
  const duration = clamp(finite(dt), 0, 0.25);
  const steps = Math.ceil(duration * 240 - 1e-9);
  const h = steps > 0 ? duration / steps : 0;

  for (let i = 0; i < steps; i++) {
    state.rotorSpeed = approach(state.rotorSpeed, active ? 1 : 0,
      (active ? rules.rotorAcceleration : rules.rotorDeceleration) * h);
    const authority = active ? state.rotorSpeed ** 2 : 0;

    const desiredTurn = !active ? 0 : manualYaw ? -yawControl * rules.turn :
      aimYaw === null ? 0 : clamp(wrap(aimYaw - state.yaw) * rules.aimResponse, -rules.turn, rules.turn);
    const oldTurn = state.yawRate;
    state.yawRate = approach(oldTurn, desiredTurn * authority, rules.turnAcceleration * h);
    state.yaw = wrap(state.yaw + (oldTurn + state.yawRate) * 0.5 * h);

    let desiredPitchRate, desiredRollRate;
    if (brake > 0 && active && !grounded) {
      // The hover assist requests opposite acceleration in the hull's frame.
      // The resulting rotor tilt still needs time and thrust to stop the craft.
      const forwardSpeed = -Math.sin(state.yaw) * state.vx - Math.cos(state.yaw) * state.vz;
      const sideSpeed = Math.cos(state.yaw) * state.vx - Math.sin(state.yaw) * state.vz;
      const counterPitch = clamp(Math.atan2(forwardSpeed * 1.5 * brake, rules.gravity), rules.minPitch, rules.maxPitch);
      const counterRoll = clamp(Math.atan2(sideSpeed * 1.5 * brake * Math.cos(counterPitch), rules.gravity), -rules.maxBank, rules.maxBank);
      desiredPitchRate = (counterPitch - state.pitch) * rules.attitudeResponse;
      desiredRollRate = (counterRoll - state.roll) * rules.attitudeResponse;
    } else {
      const cyclicPitch = clamp(pitchControl - throttle, -1, 1);
      // Neutral rate controls provide a mild attitude stabilizer. They do not
      // target a horizontal speed or align velocity to the hull's heading.
      desiredPitchRate = manualPitch ? cyclicPitch !== 0 ? cyclicPitch * rules.pitchRate : -state.pitch * rules.attitudeResponse :
        ((active ? aimPitch - throttle * (throttle > 0 ? -rules.minPitch : rules.maxPitch) : 0) - state.pitch) * rules.attitudeResponse;
      const cyclicRoll = manualRoll ? rollControl : steer;
      desiredRollRate = manualRoll && cyclicRoll !== 0 ? -cyclicRoll * rules.rollRate :
        ((active ? -cyclicRoll * rules.maxBank : 0) - state.roll) * rules.attitudeResponse;
    }
    if (grounded) {
      // The caller's real skid contact must remain level during rotor startup.
      state.pitch = state.roll = state.pitchRate = state.rollRate = 0;
    } else {
      const oldPitchRate = state.pitchRate, oldRollRate = state.rollRate;
      state.pitchRate = approach(oldPitchRate, clamp(desiredPitchRate, -rules.pitchRate, rules.pitchRate) * authority,
        rules.cyclicAcceleration * h);
      state.rollRate = approach(oldRollRate, clamp(desiredRollRate, -rules.rollRate, rules.rollRate) * authority,
        rules.cyclicAcceleration * h);
      const pitch = state.pitch + (oldPitchRate + state.pitchRate) * 0.5 * h;
      const roll = state.roll + (oldRollRate + state.rollRate) * 0.5 * h;
      state.pitch = clamp(pitch, rules.minPitch, rules.maxPitch);
      state.roll = clamp(roll, -rules.maxBank, rules.maxBank);
      if (state.pitch !== pitch) state.pitchRate = 0;
      if (state.roll !== roll) state.rollRate = 0;
    }

    // Rotor up in the renderer's YXZ attitude convention. Tilting the disk
    // spends thrust on horizontal acceleration; yaw never rotates velocity.
    const sy = Math.sin(state.yaw), cy = Math.cos(state.yaw);
    const sp = Math.sin(state.pitch), cp = Math.cos(state.pitch);
    const sr = Math.sin(state.roll), cr = Math.cos(state.roll);
    const upX = -sr * cy + cr * sp * sy;
    const upY = cr * cp;
    const upZ = sr * sy + cr * sp * cy;

    let desiredClimb = lift * (lift >= 0 ? rules.climb : rules.descent);
    if (Number.isFinite(state.y) && state.y >= rules.ceiling) desiredClimb = Math.min(0, desiredClimb);
    const commandedAcceleration = clamp((desiredClimb - state.vy) * rules.verticalResponse,
      -rules.gravity, rules.liftAcceleration);
    const requestedThrust = active ? clamp((rules.gravity + commandedAcceleration) / Math.max(0.5, upY), 0, maximumThrust) : 0;
    state.collective = active ? approach(state.collective, requestedThrust / maximumThrust, rules.collectiveRate * h) : 0;
    // Contact assist lowers excess collective after touchdown. A warm rotor
    // cannot lift the skids again unless the pilot requests positive lift.
    const availableThrust = state.collective * maximumThrust * authority;
    const thrust = grounded && lift <= 0 ? Math.min(rules.gravity, availableThrust) : availableThrust;
    const horizontalSpeed = Math.hypot(state.vx, state.vz);
    const damping = Math.exp(-(grounded ? 3 : rules.drag + horizontalSpeed * rules.airDrag) * h);
    state.vx = state.vx * damping + upX * thrust * h;
    state.vz = state.vz * damping + upZ * thrust * h;
    limitHorizontal(state, rules.speed);
    state.vy = clamp(state.vy + (upY * thrust - rules.gravity) * h,
      -rules.fallSpeed, rules.climb);
    if (grounded && state.vy < 0) state.vy = 0;
  }
  state.speed = Math.hypot(state.vx, state.vz);
  return state;
}
