/** Fixed-wing jet. Distances are metres, time seconds, angles radians. */
export const PLANE_RULES = Object.freeze({
  hp: 450, width: 9, length: 10, height: 2.8, radius: 6.75, seatHeight: 1.55,
  speed: 60, maxSpeed: 60, reverse: 0, acceleration: 14, brake: 24,
  takeoffSpeed: 24, stallSpeed: 20, ceiling: 180,
  minPitch: -0.8, maxPitch: 0.65, maxBank: 1.36,
  rudderRate: 0.25, rateResponse: 5,
  liftSlope: 4.5, liftIncidence: 0.28, stallAngle: 0.3, maxLiftLoad: 5.5,
  pitchRate: 1, bankRate: 3, turn: 0.9, turnAcceleration: 1.4,
  taxiTurn: 0.65, throttleRate: 0.75, throttleDownRate: 1.1, spoolRate: 1.2,
  gravity: 9.8, maxFallSpeed: 45, maxClimbSpeed: 32,
  maxStep: 0.25, maxSlope: 0.08, respawnSeconds: 30, fireSeconds: 0.2,
});

/**
 * Attitude autopilot gains (mouse-aim instructor, boundary safety pilot).
 * turnGain: wanted turn rate per radian of heading error; turnDamping:
 * subtracts the turn already under way; rudder trims errors below
 * rudderWindow; below guardHigh x stall speed the stall guard limits the nose
 * to the flight path plus a shrinking angle of attack, guardDive (nose below
 * the path) at guardLow x stall speed. In a bank the nose trims the flight
 * path toward the aim pitch (turnPathGain x the error, at most turnPathMax),
 * and the bank is never steeper than the load the wing lifts at turnAlpha of
 * the stall angle; rolling out counter-banks at most counterBank; rollDamping
 * damps the roll rate in the bank loop; pitchGain/pitchDamping drive the
 * elevator onto the nose target. The guard and ground* numbers are the pilot
 * assists below.
 */
export const AIM_INSTRUCTOR = Object.freeze({ pitchGain: 8, pitchDamping: 0.9, turnGain: 2, turnDamping: 0.8, rudderWindow: 0.2, rudderGain: 8,
  guardLow: 1.05, guardHigh: 1.6, guardDive: -0.08, guardLead: 1.5, guardPower: 1,
  turnPathGain: 8, turnPathMax: 0.4, turnAlpha: 0.85, counterBank: 0.05, rollDamping: 1.3,
  groundLead: 2, groundMargin: 10, groundSink: 4, groundLanding: 1.8, groundIdle: 0.3, groundGain: 4, groundLevel: 0.1 });

/**
 * Pilot assists (2026-10-19). Mouse aim: the instructor spools the engine up
 * (to full at guardLow; guardPower is the guard margin where it starts) while
 * the stall guard works more than groundMargin x 2 above the ground, and in
 * proportion to the ground pull-up; the throttle setting itself stays, and a
 * closing throttle, the brake or the airbrake turn it off. It never descends
 * toward the terrain faster than the clearance allows: input.groundClearance
 * is the height above the highest terrain under the next seconds of track
 * (the server's), and the flight path may sink at most (clearance -
 * groundMargin) / groundLead m/s (a climb below groundMargin), or groundSink
 * m/s for a landing (slower than groundLanding x takeoff speed, or the
 * throttle at groundIdle or less); under that floor the instructor levels the
 * wings (fully groundLevel rad under it) and pulls up with the 1 g nose plus
 * groundGain x the path error. Stick flight
 * (mouse stick, keyboard, pad, touch, bots): the alpha limiter fades a
 * nose-up elevator out between alphaFade and alphaLimit of angle of attack
 * (the stall is at stallAngle), with alphaLead s of pitch rate lead, so a
 * held pull bleeds speed instead of stalling the wing. A stalled wing can
 * still be flown down out of the stall (a nose-down stick is never limited).
 */
export const PILOT_ASSISTS = Object.freeze({ alphaFade: 0.18, alphaLimit: 0.27, alphaLead: 0.15 });

const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, finite(n)));
const wrap = n => Math.atan2(Math.sin(n), Math.cos(n));
const approach = (n, target, amount) => n + clamp(target - n, -amount, amount);

/** Manual controls are signed control surfaces, including released zero input.
 * Positive pitch raises the nose; positive roll/rudder turns right, which is
 * negative roll/yaw in the shared renderer's YXZ coordinate system. */
function stepFlightDynamics(state, input, dt) {
  const r = PLANE_RULES, active = input?.active !== false, grounded = input?.grounded === true;
  const manual = ['pitchControl', 'rollControl', 'yawControl'].some(field => Object.hasOwn(input ?? {}, field));
  const throttle = active ? clamp(input?.throttle, -1, 1) : 0;
  const elevator = active ? clamp(finite(input?.pitchControl) + clamp(input?.lift, -1, 1) * 0.7, -1, 1) : 0;
  const aileron = active ? clamp(input?.rollControl, -1, 1) : 0;
  const rudder = active ? clamp(input?.yawControl, -1, 1) : 0;
  const brake = active ? clamp(input?.brake, 0, 1) : (grounded ? 1 : 0);
  const speedBrake = active ? clamp(input?.speedBrake, 0, 1) : 0;
  state.yaw = wrap(finite(state.yaw));
  state.pitch = clamp(state.pitch, r.minPitch, grounded ? 0.16 : r.maxPitch);
  state.roll = grounded ? 0 : clamp(state.roll, -r.maxBank, r.maxBank);
  state.pitchRate = clamp(state.pitchRate, -r.pitchRate, r.pitchRate);
  state.rollRate = grounded ? 0 : clamp(state.rollRate, -r.bankRate, r.bankRate);
  state.rudderRate = clamp(state.rudderRate, -r.rudderRate, r.rudderRate);
  const turnLimit = grounded ? r.taxiTurn : r.turn;
  state.yawRate = clamp(state.yawRate, -turnLimit, turnLimit);
  state.throttle = active ? clamp(state.throttle, 0, 1) : 0;
  state.enginePower = clamp(state.enginePower, 0, 1);
  const targetYaw = active && Number.isFinite(input?.yaw) ? wrap(input.yaw) : state.yaw;
  const targetPitch = clamp(finite(input?.pitch) + clamp(input?.lift, -1, 1) * 0.28, grounded ? -0.08 : r.minPitch, grounded ? 0.16 : r.maxPitch);
  const initialSpeed = clamp(state.speed, 0, r.maxSpeed), initialPitch = state.pitch;
  state.vx = clamp(finite(state.vx, -Math.sin(state.yaw) * Math.cos(initialPitch) * initialSpeed), -r.maxSpeed, r.maxSpeed);
  state.vy = clamp(finite(state.vy, Math.sin(initialPitch) * initialSpeed), -r.maxFallSpeed, r.maxClimbSpeed);
  state.vz = clamp(finite(state.vz, -Math.cos(state.yaw) * Math.cos(initialPitch) * initialSpeed), -r.maxSpeed, r.maxSpeed);
  let remaining = Math.min(dt, 0.25);
  while (remaining > 1e-10) {
    const h = Math.min(remaining, 1 / 240);
    remaining -= h;
    if (active && brake === 0) state.throttle = clamp(state.throttle + throttle * (throttle < 0 ? r.throttleDownRate : r.throttleRate) * h, 0, 1);
    else if (brake > 0) state.throttle = approach(state.throttle, 0, r.throttleDownRate * brake * h);
    // assistPower: the instructor's stall / ground spool-up (mouse aim only).
    state.enginePower = approach(state.enginePower, active ? Math.max(state.throttle, manual ? 0 : finite(state.assistPower)) : 0, r.spoolRate * h);
    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch), sy = Math.sin(state.yaw), cy = Math.cos(state.yaw);
    const forwardSpeed = Math.max(0, -sy * cp * state.vx + sp * state.vy - cy * cp * state.vz);
    const authority = clamp(forwardSpeed / r.takeoffSpeed, 0, 1) ** 2;
    // A separated flow still reaches the tail. Retain reduced elevator control
    // so a nose-up stall can be recovered even after axial flow reverses.
    const pitchAuthority = Math.max(authority, clamp(Math.hypot(state.vx, state.vy, state.vz) / r.takeoffSpeed, 0, 1) ** 2 * 0.35);
    let pitchControl = elevator, rollControl = aileron, yawControl = rudder;
    if (active && manual && !grounded && pitchControl > 0) {
      // Alpha limiter (stick flight): a nose-up stick fades out as the angle
      // of attack, led by the pitch rate, nears the stall.
      const sr = Math.sin(state.roll), cr = Math.cos(state.roll);
      const upFlow = (-cy * sr + sy * sp * cr) * state.vx + cp * cr * state.vy + (sy * sr + cy * sp * cr) * state.vz;
      const alpha = Math.atan2(-upFlow, Math.max(0.001, forwardSpeed)) + state.pitchRate * PILOT_ASSISTS.alphaLead;
      pitchControl = Math.min(pitchControl, clamp((PILOT_ASSISTS.alphaLimit - alpha) / (PILOT_ASSISTS.alphaLimit - PILOT_ASSISTS.alphaFade), -1, 1));
    }
    if (active && !manual) {
      // The mouse-aim instructor (and the boundary safety pilot) request an
      // attitude: the nose to a world yaw/pitch. It moves the same control
      // surfaces and obeys the same inertia/aerodynamics as a human stick.
      // Bank-to-turn: the bank whose coordinated turn rate closes the heading
      // error, wings level once the nose is on the aim; a short rudder trims
      // the last degrees. A/D (steer) override the bank.
      const yawError = wrap(targetYaw - state.yaw), steer = clamp(input?.steer, -1, 1);
      const pathSpeed = Math.max(r.takeoffSpeed, forwardSpeed);
      const turnRate = yawError * AIM_INSTRUCTOR.turnGain - state.yawRate * AIM_INSTRUCTOR.turnDamping;
      // Rolling out, the wings brake the turn by levelling; only a shallow
      // counter-bank helps, so the nose stops on the aim without a wobble.
      // Sustainable bank: the steepest bank whose load the wing still lifts
      // at turnAlpha of the stall angle (and maxLiftLoad), so a held turn at
      // bomb-run speed stays tight without sinking or stalling.
      const load = Math.min(r.maxLiftLoad, (forwardSpeed / r.takeoffSpeed) ** 2 * (r.liftIncidence + r.liftSlope * r.stallAngle * AIM_INSTRUCTOR.turnAlpha));
      const bankLimit = load > 1 ? Math.min(r.maxBank, Math.acos(1 / load)) : AIM_INSTRUCTOR.counterBank;
      const braking = turnRate * yawError < 0 ? AIM_INSTRUCTOR.counterBank : bankLimit;
      let bankTarget = Math.abs(steer) > 0.01 ? -steer * bankLimit
        : clamp(Math.atan(turnRate * pathSpeed / r.gravity), -braking, braking);
      // Stall guard: close to the stall speed the nose may rise less and less
      // above the flight path, so a held climb trades height for speed
      // instead of stalling (full freedom from guardHigh x stall speed).
      // The speed it is heading for (thrust, climb and drag over guardLead s)
      // decides, so a zoom climb is caught before the airspeed is gone. A jet
      // already without flying speed is left to the pilot.
      let pitchTarget = targetPitch;
      // Takeoff assist: at rotation speed a level (or higher) aim lifts the
      // nose for the takeoff instead of rolling off the end of the runway.
      if (grounded && forwardSpeed >= r.takeoffSpeed && targetPitch > -0.05) pitchTarget = Math.max(pitchTarget, 0.12);
      const path = Math.atan2(state.vy, Math.max(1, Math.hypot(state.vx, state.vz)));
      // Ground proximity: the flight path may sink only as fast as the
      // terrain clearance allows (PILOT_ASSISTS above). Under that floor the
      // wings level and the nose pulls the path back up, whatever the aim.
      const clearance = finite(input?.groundClearance, Infinity);
      let groundUrgency = 0, groundFloor = -Math.PI / 2;
      if (!grounded && clearance < Infinity) {
        const speed = Math.max(1, Math.hypot(state.vx, state.vy, state.vz));
        // A landing (slow, or the throttle near idle) may sink onto the ground.
        const landing = Math.max(clamp((r.takeoffSpeed * AIM_INSTRUCTOR.groundLanding - speed) / (r.takeoffSpeed * 0.3), 0, 1),
          clamp((AIM_INSTRUCTOR.groundIdle + 0.2 - state.throttle) / 0.2, 0, 1) * clamp((r.takeoffSpeed * 2.3 - speed) / (r.takeoffSpeed * 0.4), 0, 1));
        const climbOut = (clearance - AIM_INSTRUCTOR.groundMargin) / AIM_INSTRUCTOR.groundLead;
        const allowedSink = climbOut + landing * Math.max(0, AIM_INSTRUCTOR.groundSink - climbOut);
        groundFloor = Math.asin(clamp(-allowedSink / speed, -1, 1));
        groundUrgency = clamp((groundFloor - path) / AIM_INSTRUCTOR.groundLevel, 0, 1);
        bankTarget *= 1 - groundUrgency;
      }
      // Turn compensation: a steep bank tilts the lift away from the
      // vertical, so in a turn the nose trims toward holding the flight path
      // on the aim pitch (it would sink or balloon otherwise). Straight
      // flight keeps the nose on the aim.
      if (!grounded) {
        const bankWeight = clamp((1 - Math.cos(state.roll)) / (1 - Math.cos(r.maxBank)), 0, 1);
        pitchTarget += clamp((targetPitch - path) * AIM_INSTRUCTOR.turnPathGain, -AIM_INSTRUCTOR.turnPathMax, AIM_INSTRUCTOR.turnPathMax) * bankWeight;
      }
      if (groundFloor > -Math.PI / 2) {
        // The nose that holds the path on the floor (1 g of lift) plus groundGain x the path error.
        const trim = clamp(((r.takeoffSpeed / Math.max(1, forwardSpeed)) ** 2 - r.liftIncidence) / r.liftSlope, -0.1, r.stallAngle * 0.8);
        pitchTarget = Math.max(pitchTarget, Math.min(path + r.stallAngle * 0.8, groundFloor + trim + (groundFloor - path) * AIM_INSTRUCTOR.groundGain));
      }
      const trend = r.acceleration * state.enginePower - r.gravity * Math.sin(path) - (0.6 + forwardSpeed * forwardSpeed * 0.0025);
      const heading = forwardSpeed + Math.min(0, trend) * AIM_INSTRUCTOR.guardLead;
      let stallPower = 0;
      if (!grounded && forwardSpeed > r.stallSpeed * 0.5 && heading < r.stallSpeed * AIM_INSTRUCTOR.guardHigh) {
        const margin = clamp((heading - r.stallSpeed * AIM_INSTRUCTOR.guardLow)
          / (r.stallSpeed * (AIM_INSTRUCTOR.guardHigh - AIM_INSTRUCTOR.guardLow)), 0, 1);
        pitchTarget = Math.min(pitchTarget, path + AIM_INSTRUCTOR.guardDive + (r.stallAngle * 0.8 - AIM_INSTRUCTOR.guardDive) * margin);
        // Low over the ground (a landing approach) the guard leaves the power alone.
        if (clearance > AIM_INSTRUCTOR.groundMargin * 2) stallPower = clamp((AIM_INSTRUCTOR.guardPower - margin) / AIM_INSTRUCTOR.guardPower, 0, 1);
      }
      // Spool up while the guard or the pull-up works, unless the pilot is
      // closing the throttle or braking (a landing flare stays at idle).
      state.assistPower = grounded || throttle < 0 || brake > 0 || speedBrake > 0 ? 0 : Math.max(stallPower, groundUrgency);
      pitchControl = clamp(((pitchTarget - state.pitch) * AIM_INSTRUCTOR.pitchGain - state.pitchRate * AIM_INSTRUCTOR.pitchDamping) / r.pitchRate, -1, 1);
      rollControl = grounded ? steer : clamp(-((bankTarget - state.roll) * 4 - state.rollRate * AIM_INSTRUCTOR.rollDamping) / r.bankRate, -1, 1);
      yawControl = grounded ? (Math.abs(steer) <= 0.01 ? clamp(-yawError * 1.3 / r.taxiTurn, -1, 1) : 0)
        : Math.abs(yawError) < AIM_INSTRUCTOR.rudderWindow && Math.abs(steer) <= 0.01 ? clamp(-yawError * AIM_INSTRUCTOR.rudderGain, -1, 1) : 0;
    }
    const response = 1 - Math.exp(-r.rateResponse * h);
    const oldPitchRate = state.pitchRate, oldRollRate = state.rollRate;
    state.pitchRate += (pitchControl * r.pitchRate * pitchAuthority - state.pitchRate) * response;
    state.rollRate += (-rollControl * r.bankRate * authority - state.rollRate) * response;
    state.rudderRate += (-yawControl * r.rudderRate * authority - state.rudderRate) * response;
    state.pitch = clamp(state.pitch + (oldPitchRate + state.pitchRate) * 0.5 * h, grounded ? -0.08 : r.minPitch, grounded ? 0.16 : r.maxPitch);
    if (state.pitch === r.minPitch || state.pitch === r.maxPitch || grounded && (state.pitch === -0.08 || state.pitch === 0.16)) state.pitchRate = 0;
    state.roll = grounded ? 0 : clamp(state.roll + (oldRollRate + state.rollRate) * 0.5 * h, -r.maxBank, r.maxBank);
    if (grounded || Math.abs(state.roll) === r.maxBank) state.rollRate = 0;
    const horizontalSpeed = Math.hypot(state.vx, state.vz);
    const speed = Math.hypot(horizontalSpeed, state.vy);
    const turnAuthority = clamp((forwardSpeed - r.stallSpeed * 0.6) / (r.takeoffSpeed - r.stallSpeed * 0.6), 0, 1);
    const turnSp = Math.sin(state.pitch), turnCp = Math.cos(state.pitch), turnSr = Math.sin(state.roll), turnCr = Math.cos(state.roll);
    const turnFlow = Math.max(0, -sy * turnCp * state.vx + turnSp * state.vy - cy * turnCp * state.vz);
    const turnUpFlow = (-cy * turnSr + sy * turnSp * turnCr) * state.vx + turnCp * turnCr * state.vy + (sy * turnSr + cy * turnSp * turnCr) * state.vz;
    const wingAttachment = 1 - clamp((Math.abs(Math.atan2(-turnUpFlow, Math.max(0.001, turnFlow))) - r.stallAngle) / 0.28, 0, 1) * 0.88;
    const turnTarget = grounded ? -clamp(rollControl + yawControl, -1, 1) * r.taxiTurn * Math.min(1, horizontalSpeed / 8) :
      clamp(r.gravity * Math.tan(state.roll) / Math.max(r.stallSpeed, forwardSpeed) * turnAuthority * wingAttachment + state.rudderRate, -r.turn, r.turn);
    const oldYawRate = state.yawRate;
    state.yawRate = approach(state.yawRate, turnTarget, r.turnAcceleration * h);
    state.yaw = wrap(state.yaw + (oldYawRate + state.yawRate) * 0.5 * h);
    const cosPitch = Math.cos(state.pitch), sinPitch = Math.sin(state.pitch), sinYaw = Math.sin(state.yaw), cosYaw = Math.cos(state.yaw);
    const fx = -sinYaw * cosPitch, fy = sinPitch, fz = -cosYaw * cosPitch;
    const cosRoll = Math.cos(state.roll), sinRoll = Math.sin(state.roll);
    const ux = -cosYaw * sinRoll + sinYaw * sinPitch * cosRoll, uy = cosPitch * cosRoll;
    const uz = sinYaw * sinRoll + cosYaw * sinPitch * cosRoll;
    const flow = Math.max(0, state.vx * fx + state.vy * fy + state.vz * fz);
    const upFlow = state.vx * ux + state.vy * uy + state.vz * uz;
    const angleOfAttack = Math.atan2(-upFlow, Math.max(0.001, flow));
    const dynamicPressure = (flow / r.takeoffSpeed) ** 2;
    const stallLoss = 1 - clamp((Math.abs(angleOfAttack) - r.stallAngle) / 0.28, 0, 1) * 0.88;
    const coefficient = clamp(r.liftIncidence + r.liftSlope * angleOfAttack, -1.5, 2.3) * stallLoss;
    const lift = clamp(r.gravity * dynamicPressure * coefficient, -r.gravity * r.maxLiftLoad, r.gravity * r.maxLiftLoad);
    const drag = 0.6 + speed * speed * 0.0025 + Math.abs(lift / r.gravity) * 0.22 + dynamicPressure * angleOfAttack * angleOfAttack * 5;
    // speedBrake (0..1, the server's map-edge guidance) adds airbrake drag
    // without touching the pilot's persistent throttle setting.
    const slowing = Math.max(-throttle, 0) * (grounded ? 12 : 10) + brake * (grounded ? r.brake : 10)
      + (grounded ? 0 : speedBrake * 10);
    if (grounded) {
      const nextSpeed = clamp(horizontalSpeed + (r.acceleration * state.enginePower * cosPitch - drag - slowing) * h, 0, r.maxSpeed);
      state.vx = -sinYaw * nextSpeed; state.vz = -cosYaw * nextSpeed;
      // Wheel contact supplies the runway reaction; only forward speed permits rotation.
      state.vy = active && brake < 0.2 && nextSpeed >= r.takeoffSpeed && state.pitch > 0.06 ? Math.max(0.7, nextSpeed * sinPitch * 0.55) : 0;
    } else {
      const retention = speed > 0 ? Math.max(0, 1 - (drag + slowing) * h / speed) : 0;
      const thrust = r.acceleration * state.enginePower;
      // Lift is perpendicular to the flight path. It turns/climbs by redirecting
      // existing momentum; only the engine and gravity supply kinetic energy.
      const nx = speed > 1e-8 ? state.vx / speed : fx, ny = speed > 1e-8 ? state.vy / speed : fy, nz = speed > 1e-8 ? state.vz / speed : fz;
      const projection = ux * nx + uy * ny + uz * nz;
      let lx = ux - nx * projection, ly = uy - ny * projection, lz = uz - nz * projection;
      const normalLength = Math.hypot(lx, ly, lz);
      if (normalLength > 1e-8) { lx /= normalLength; ly /= normalLength; lz /= normalLength; }
      state.vx = state.vx * retention + (fx * thrust + lx * lift) * h;
      state.vy = state.vy * retention + (fy * thrust + ly * lift - r.gravity) * h;
      state.vz = state.vz * retention + (fz * thrust + lz * lift) * h;
      // Fuselage/fin stability corrects sideslip gradually. Rudder can swing the
      // nose ahead of the flight path, with bounded lateral acceleration.
      const horizontal = Math.hypot(state.vx, state.vz);
      const velocityYaw = horizontal > 1e-8 ? Math.atan2(-state.vx, -state.vz) : state.yaw;
      const slip = wrap(state.yaw - velocityYaw);
      const correction = clamp(slip * authority * stallLoss * 1.4, -r.gravity / Math.max(1, horizontal), r.gravity / Math.max(1, horizontal)) * h;
      state.vx = -Math.sin(velocityYaw + correction) * horizontal;
      state.vz = -Math.cos(velocityYaw + correction) * horizontal;
      state.vy = clamp(state.vy, -r.maxFallSpeed, r.maxClimbSpeed);
    }
    const airspeed = Math.hypot(state.vx, state.vy, state.vz);
    if (airspeed > r.maxSpeed) { const factor = r.maxSpeed / airspeed; state.vx *= factor; state.vy *= factor; state.vz *= factor; }
  }
  state.speed = state.airspeed = Math.hypot(state.vx, state.vy, state.vz);
  const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch), sy = Math.sin(state.yaw), cy = Math.cos(state.yaw), cr = Math.cos(state.roll), sr = Math.sin(state.roll);
  const flow = Math.max(0, -sy * cp * state.vx + sp * state.vy - cy * cp * state.vz);
  const upFlow = (-cy * sr + sy * sp * cr) * state.vx + cp * cr * state.vy + (sy * sr + cy * sp * cr) * state.vz;
  state.angleOfAttack = Math.atan2(-upFlow, Math.max(0.001, flow));
  state.stalled = !grounded && (flow < r.stallSpeed || Math.abs(state.angleOfAttack) > r.stallAngle);
  return state;
}

/**
 * Mutates attitude and velocity only; the caller owns position, contact and
 * flight ceiling. W/S adjusts persistent throttle. Optional pitchControl,
 * rollControl and yawControl use signed [-1, 1] control surfaces. Released
 * controls damp angular rates while retaining attitude. Lift assists elevator.
 * Legacy yaw/pitch requests use an attitude autopilot over the same dynamics.
 * Neither pitch nor Space can supply wing lift without forward airspeed.
 */
export function stepPlaneFlight(state, input = {}, dt = 0) {
  if (!state || !Number.isFinite(dt) || dt <= 0) return state;
  return stepFlightDynamics(state, input, dt);
}
