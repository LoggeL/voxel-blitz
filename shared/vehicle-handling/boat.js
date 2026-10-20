/**
 * River patrol boat. Distances are metres, time seconds, angles radians.
 *
 * The hull floats `draft` m into the water surface (the top face of the
 * highest water voxel under it) and planes: below `planeSpeed` it pushes a
 * bow wave (`humpAcceleration` share of the thrust), above it the drag drops
 * and the bow trims down from its hump angle to `planeTrim`. Steering is a
 * waterjet: the turn rate grows with the flow over the nozzle up to
 * `turnSpeed` (at rest it still pivots at `pivotTurn`), the hull carries its
 * course into a turn and slides (`grip` per second pulls the course back onto
 * the heading). Pitch and roll are presentation only and clamped, so the boat
 * never capsizes. Thrust needs water under the stern (`wet`): beached on a
 * bank or a ford the hull grinds (`groundDrag`) and only creeps. Over water
 * shallower than `shallowDepth` (a ford's one voxel) the hull scrapes along:
 * its top speed falls toward `shallowSpeed` and `shallowDrag` slows it down.
 */
export const BOAT_RULES = Object.freeze({
  hp: 360, radius: 3.65, height: 1.6, seatHeight: 1.2,
  speed: 20, reverse: 4.5, acceleration: 5.5, humpAcceleration: 0.55, planeSpeed: 9, brake: 7,
  drag: 1.6, dragPerSpeed: 0.05, planeDrag: 0.6,
  turn: 0.95, pivotTurn: 0.4, turnSpeed: 7, turnAcceleration: 2.6, grip: 2.2, planeGrip: 1.4,
  draft: 0.45, maxStep: 0.6, maxSlope: 1.1,
  // A water face one voxel higher (a surge's front, a flood) lifts the hull onto it; ground never rises more than maxStep.
  waterStep: 1.1,
  groundDrag: 9, creep: 1.2,
  shallowDepth: 1.5, shallowSpeed: 5, shallowDrag: 20,
  buoyancy: 3, sinkRate: 0.7,
  // Presentation attitude (published pitch/roll; never physics) and the client-side swell amplitude.
  humpTrim: 0.085, planeTrim: 0.035, heel: 0.012, maxRoll: 0.18, maxPitch: 0.14, bob: 0.014,
  wreckPitch: 0.22, wreckRoll: 0.32,
  respawnSeconds: 20, fireSeconds: 0,
});

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : 0));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const approach = (value, target, amount) => value < target ? Math.min(target, value + amount) : Math.max(target, value - amount);

/** 0 in displacement mode, 1 fully on the plane. */
export const boatPlaning = speed => clamp((Math.abs(finite(speed)) - BOAT_RULES.planeSpeed * 0.6) / (BOAT_RULES.planeSpeed * 0.6), 0, 1);

/**
 * Mutates speed, yaw, yawRate and course (the direction the hull actually
 * travels) only; the caller owns position and collisions. `wet` (0..1) is the
 * share of the stern in water, `aground` (0..1) the share of the hull resting
 * on the bed or a bank, `shallow` (0..1) the share over water shallower than
 * `shallowDepth`. Positive steer turns right, like the jeep.
 */
export function stepBoatDrive(state, input = {}, dt, { wet = 1, aground = 0, shallow = 0 } = {}, tune = null) {
  if (!state || !Number.isFinite(dt) || dt <= 0) return state;
  const R = BOAT_RULES;
  // `tune` scales the top speed and the acceleration (a waterjet upgrade, shared/vehicle-upgrades.js).
  const top = R.speed * (tune?.speed > 0 ? tune.speed : 1), acceleration = R.acceleration * (tune?.acceleration > 0 ? tune.acceleration : 1);
  state.speed = clamp(state.speed, -R.reverse, top);
  state.yaw = wrap(finite(state.yaw));
  state.course = wrap(finite(state.course, state.yaw));
  state.yawRate = clamp(finite(state.yawRate), -R.turn, R.turn);
  const throttle = clamp(input?.throttle, -1, 1) * clamp(wet, 0, 1);
  const steer = clamp(input?.steer, -1, 1);
  const brake = clamp(input?.brake, 0, 1);
  const ground = clamp(aground, 0, 1), scrape = clamp(shallow, 0, 1);
  let remaining = Math.min(dt, 0.25);
  while (remaining > 1e-10) {
    const h = Math.min(remaining, 1 / 120);
    remaining -= h;
    const speed = state.speed, planing = boatPlaning(speed);
    const drag = (R.drag + Math.abs(speed) * R.dragPerSpeed) * (1 - (1 - R.planeDrag) * planing) + R.groundDrag * ground + R.shallowDrag * scrape;
    const reversing = throttle !== 0 && speed !== 0 && Math.sign(throttle) !== Math.sign(speed);
    if (brake > 0 || reversing) state.speed = approach(speed, 0, (R.brake * (brake || 1) + drag) * h);
    else if (throttle === 0) state.speed = approach(speed, 0, drag * h);
    else {
      const limit = (throttle > 0 ? top : R.reverse) * (1 - ground) + R.creep * ground;
      const hump = Math.abs(speed) > R.planeSpeed * 0.35 && Math.abs(speed) < R.planeSpeed ? R.humpAcceleration : 1;
      // Scraping over a ford caps the speed (part throttle below the cap is unchanged).
      const cap = limit + (Math.min(limit, R.shallowSpeed) - limit) * scrape;
      const target = Math.sign(throttle) * Math.min(Math.abs(throttle) * limit, cap);
      state.speed = Math.abs(speed) > Math.abs(target) ? approach(speed, target, drag * h)
        : approach(speed, target, acceleration * hump * h);
    }
    // Waterjet steering: authority grows with the flow, a slow pivot at rest.
    const flow = clamp(Math.abs(state.speed) / R.turnSpeed, 0, 1) * (1 - ground);
    const authority = R.pivotTurn * clamp(wet, 0, 1) * (1 - ground * 0.7) + (R.turn - R.pivotTurn) * flow;
    const direction = state.speed < -0.3 ? -1 : 1;
    const targetRate = -steer * authority * direction;
    const oldRate = state.yawRate;
    state.yawRate = approach(oldRate, targetRate, R.turnAcceleration * h);
    state.yaw = wrap(state.yaw + (oldRate + state.yawRate) * 0.5 * h);
    // The course trails the heading: a planing hull slides through its turns.
    const grip = R.grip + (R.planeGrip - R.grip) * boatPlaning(state.speed) + R.groundDrag * ground;
    state.course = wrap(state.course + wrap(state.yaw - state.course) * Math.min(1, grip * h));
  }
  // Presentation: planing state for the wake and the rudder angle for the crew.
  state.visualSteer = steer * 0.4;
  return state;
}

/**
 * Published attitude of a live hull: bow up on the hump, trimmed on the
 * plane, a squat under hard acceleration and a heel into the turn. Always
 * inside ±maxPitch / ±maxRoll: the boat cannot capsize. A boat at rest
 * publishes a level hull (no per-tick row churn); the swell is client-side
 * presentation (boatSwell).
 */
export function boatAttitude(state, accel) {
  const R = BOAT_RULES, speed = Math.abs(finite(state.speed)), planing = boatPlaning(speed);
  const hump = speed < R.planeSpeed * 0.3 ? speed / (R.planeSpeed * 0.3) : 1;
  const trim = (R.humpTrim * hump * (1 - planing) + R.planeTrim * planing) * Math.sign(finite(state.speed, 1) || 1);
  const squat = clamp(finite(accel) * 0.006, -0.03, 0.03);
  const heel = clamp(finite(state.yawRate) * finite(state.speed) * R.heel, -R.maxRoll, R.maxRoll);
  return { pitch: clamp(trim + squat, -R.maxPitch, R.maxPitch), roll: clamp(heel, -R.maxRoll, R.maxRoll) };
}

/** Presentation swell { pitch, roll, heave } of a hull at (x, z) at `time` seconds (client only). */
export function boatSwell(time, x, z, speed = 0) {
  const R = BOAT_RULES, calm = 1 - 0.6 * boatPlaning(speed);
  const t = finite(time);
  return {
    pitch: Math.sin(t * 1.7 + finite(x) * 0.31) * R.bob * calm,
    roll: Math.sin(t * 1.3 + finite(z) * 0.27) * R.bob * 1.4 * calm,
    heave: Math.sin(t * 1.1 + finite(x) * 0.2 + finite(z) * 0.17) * 0.05 * calm,
  };
}
