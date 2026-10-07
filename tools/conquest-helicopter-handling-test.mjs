import assert from 'node:assert/strict';
import { HELICOPTER_RULES as rules, stepHelicopterFlight } from '../shared/vehicle-handling/helicopter.js';

const run = (seconds, input, state = {}, hz = 60) => {
  for (let i = 0; i < Math.round(seconds * hz); i++) stepHelicopterFlight(state, input, 1 / hz);
  return state;
};
const close = (actual, expected, tolerance = 1e-8) => assert(Math.abs(actual - expected) <= tolerance,
  `${actual} should be within ${tolerance} of ${expected}`);
const manual = { pitchControl: 0, rollControl: 0, yawControl: 0 };

assert(Object.isFrozen(rules));
assert.equal(rules.hp, 550);
assert.equal(rules.ceiling, 180);
assert.equal(rules.fireSeconds, 0.65);

const hover = run(10, {}, { y: 40, rotorSpeed: 1 });
close(hover.vy, 0);
close(hover.speed, 0);
close(hover.rotorSpeed, 1);
assert(hover.collective > 0 && hover.collective < 1, 'Hover requires a partial collective command');
const recovering = run(5, manual, { rotorSpeed: 1, vy: -5, vx: 8, vz: -4 });
assert(Math.abs(recovering.vy) < 0.001, 'Neutral collective catches downward momentum');
assert(recovering.speed > 5 && recovering.speed < 8.9, 'Centered cyclic retains drift while air drag gradually slows it');

const start = { grounded: true, y: 11, rotorSpeed: 0 };
run(0.5, { lift: 1, throttle: 1, rollControl: 1 }, start);
assert.equal(start.vy, 0, 'Rotor must build power before the grounded helicopter lifts');
assert.equal(start.pitch, 0);
assert.equal(start.roll, 0, 'Cyclic cannot tip the skids through ground during startup');
run(0.7, { lift: 1 }, start);
assert(start.vy > 0.5 && start.rotorSpeed > 0.99, 'Powered collective starts a gradual takeoff');
start.grounded = false;
run(3, { lift: 1 }, start);
assert(start.vy > 7.9 && start.vy <= rules.climb, 'Climb speed is bounded');
const groundedHover = run(3, manual, { grounded: true, rotorSpeed: 0, vy: -4, pitch: -0.3, roll: 0.3 });
assert.equal(groundedHover.vy, 0, 'Neutral grounded helicopter stays planted');
assert.equal(groundedHover.pitch, 0);
assert.equal(groundedHover.roll, 0);
for (const lift of [0, -1]) {
  const warmGrounded = run(0.5, { ...manual, lift }, { grounded: true, rotorSpeed: 1, collective: 1, vy: 0 });
  assert.equal(warmGrounded.vy, 0, 'Residual collective after touchdown cannot take off without positive lift');
}

// The caller integrates XYZ and resolves actual floor contact. Simultaneous
// lift and cyclic commands only start translating once the skids leave it.
const flight = { x: 20, y: 11, z: 30, rotorSpeed: 0, grounded: true };
const integrate = (seconds, input) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    flight.grounded = flight.y <= 11 && (flight.vy ?? 0) <= 0;
    stepHelicopterFlight(flight, input, 1 / 60);
    flight.x += flight.vx / 60;
    flight.y += flight.vy / 60;
    flight.z += flight.vz / 60;
    if (flight.y <= 11) {
      flight.y = 11;
      flight.vy = 0;
      flight.grounded = true;
    }
  }
};
integrate(4, { ...manual, throttle: 1, lift: 1, pitch: 0 });
assert(flight.y > 29 && !flight.grounded, 'Pilot lifts clear of a physical landing surface');
assert(flight.z < 20 && flight.pitch < -0.4, 'Level aim cannot suppress forward keyboard cyclic');
integrate(8, { ...manual, brake: 1 });
assert(flight.speed < 0.03, 'Hover assist arrests drift after takeoff');
const hoverAltitude = flight.y;
integrate(2, { ...manual, brake: 1 });
assert(Math.abs(flight.y - hoverAltitude) < 0.001, 'Neutral collective keeps a stable airborne altitude');
integrate(5, { active: false, lift: 1 });
assert.equal(flight.y, 11, 'Abandoned helicopter falls back to actual floor contact');
assert.equal(flight.vy, 0);
assert.equal(flight.rotorSpeed, 0);

const forward = run(0.1, { ...manual, throttle: 1 }, { rotorSpeed: 1 });
assert(forward.pitch < 0 && forward.pitch > -0.02, 'Cyclic rotates the hull with angular inertia');
assert(forward.vz < 0 && forward.vz > -0.02, 'Translation builds from tilt instead of jumping to a target speed');
run(0.9, { ...manual, throttle: 1 }, forward);
assert(forward.vz < -2 && forward.vz > -3, 'Forward tilt supplies finite horizontal acceleration');
close(forward.vx, 0);
run(19, { ...manual, throttle: 1 }, forward);
assert(forward.speed > 33 && forward.speed <= rules.speed, 'Sustained cyclic reaches the bounded cruise envelope');
const beforeRelease = forward.speed;
run(2, manual, forward);
assert(Math.abs(forward.pitch) < 0.01 && forward.speed > beforeRelease * 0.75,
  'Released cyclic levels the hull without cancelling existing momentum');
const reverse = run(4, { ...manual, throttle: -1 }, { rotorSpeed: 1 });
assert(reverse.vz > 10 && reverse.pitch > 0.39, 'A raised nose sends rotor thrust backward');

// With the same exact attitude, thrust must depend on pitch and bank even
// when throttle is zero. Legacy attitude hold is useful for bot autopilots.
const tilted = run(1, { pitch: -0.3 }, { rotorSpeed: 1, pitch: -0.3 });
assert(tilted.vz < -2.7 && Math.abs(tilted.vx) < 1e-8, 'Nose-down disk accelerates forward without throttle');
assert(Math.abs(tilted.vy) < 0.01 && tilted.collective > hover.collective,
  'Hover assistance supplies the extra collective needed by a tilted disk');
const right = run(1, { ...manual, rollControl: 1 }, { rotorSpeed: 1 });
const left = run(1, { ...manual, rollControl: -1 }, { rotorSpeed: 1 });
assert(right.roll < 0 && left.roll > 0, 'Cyclic banks right and left in the renderer convention');
assert(right.vx > 2.5 && left.vx < -2.5, 'Banked rotor thrust accelerates laterally');
close(right.yaw, 0);
close(left.yaw, 0);
const east = run(1, { pitch: -0.3 }, { yaw: -Math.PI / 2, rotorSpeed: 1, pitch: -0.3 });
assert(east.vx > 2.7 && Math.abs(east.vz) < 1e-8, 'Heading rotates the disk acceleration into world space');
const sideAtEast = run(1, { ...manual, rollControl: 1 }, { yaw: -Math.PI / 2, rotorSpeed: 1 });
assert(sideAtEast.vz > 2.5 && Math.abs(sideAtEast.vx) < 1e-8, 'Lateral acceleration rotates with the hull');

const yawing = run(1, { ...manual, yawControl: 1 }, { rotorSpeed: 1, vz: -20 });
assert(yawing.yaw < -0.7 && yawing.yawRate < -1, 'Yaw pedals build a bounded angular rate');
close(yawing.vx, 0);
assert(yawing.vz < -17, 'Yaw pedals cannot rotate existing flight momentum');
const oldYaw = yawing.yaw;
run(0.1, manual, yawing);
assert(yawing.yaw < oldYaw && yawing.yawRate < 0, 'Yaw momentum persists briefly after release');
run(1, manual, yawing);
close(yawing.yawRate, 0);
const bankedTurn = run(2, { ...manual, throttle: 1, rollControl: 0.6, yawControl: 0.5 },
  { rotorSpeed: 1, vz: -20 });
assert(bankedTurn.vx > 4 && bankedTurn.vz < -14 && bankedTurn.roll < 0 && bankedTurn.yaw < 0,
  'Bank, pedals and forward cyclic curve the flight path through actual acceleration');
const priority = run(0.5, { ...manual, yaw: 2, pitch: 0.3, steer: 1, throttle: 1 }, { rotorSpeed: 1 });
close(priority.yaw, 0);
close(priority.roll, 0);
assert(priority.pitch < 0, 'Explicit neutral rate controls suppress legacy aim while keyboard cyclic still works');
const opposingPitch = run(1, { ...manual, pitchControl: 1, throttle: 1 }, { rotorSpeed: 1 });
close(opposingPitch.pitch, 0);
const aim = run(3, { yaw: -Math.PI + 0.1, pitch: 0.2 }, { yaw: Math.PI - 0.1, rotorSpeed: 1 });
assert(Math.abs(Math.atan2(Math.sin(aim.yaw - (-Math.PI + 0.1)), Math.cos(aim.yaw - (-Math.PI + 0.1)))) < 0.01,
  'Legacy heading hold follows the shortest path across the angle seam');
close(aim.pitch, 0.2, 0.001);

const braking = { yaw: 1.2, rotorSpeed: 1, vx: 10, vz: -18 };
stepHelicopterFlight(braking, { ...manual, throttle: 1, brake: 1 }, 0.1);
assert(braking.speed > 20, 'Brake cannot remove velocity instantly');
run(8, { ...manual, throttle: 1, brake: 1 }, braking);
assert(braking.speed < 0.03 && Math.abs(braking.pitch) < 0.005 && Math.abs(braking.roll) < 0.005,
  'Hover brake uses heading-independent counter tilt and overrides held throttle');

const descending = run(4, { lift: -1 }, { rotorSpeed: 1, vy: 5 });
assert(descending.vy < -5.9 && descending.vy >= -rules.descent, 'Down collective brakes a climb and descends');
descending.grounded = true;
run(0.25, { lift: -1 }, descending);
assert.equal(descending.vy, 0, 'Landing contact stops downward travel');
const ceiling = run(3, { lift: 1 }, { rotorSpeed: 1, y: rules.ceiling, vy: 5 });
assert(ceiling.vy < 0.01, 'Ceiling removes upward climb demand');

const abandoned = run(1, { active: false, lift: 1, throttle: 1 }, { rotorSpeed: 1, vy: 0, y: 80 });
assert(abandoned.vy < -9.7, 'An unoccupied helicopter has no hover lift');
assert(abandoned.rotorSpeed > 0 && abandoned.rotorSpeed < 0.5, 'Rotor visibly spins down while the craft falls');
assert.equal(abandoned.collective, 0);
run(5, { active: false }, abandoned);
assert.equal(abandoned.rotorSpeed, 0);
assert.equal(abandoned.vy, -rules.fallSpeed, 'Unoccupied fall reaches a bounded terminal speed');
abandoned.grounded = true;
run(0.25, { active: false }, abandoned);
assert.equal(abandoned.vy, 0, 'An inactive helicopter rests after ground contact');

const position = { x: 25, y: 50, z: 60, rotorSpeed: 1 };
stepHelicopterFlight(position, { ...manual, throttle: 1, lift: 1, rollControl: 1 }, 0.25);
assert.deepEqual([position.x, position.y, position.z], [25, 50, 60], 'Caller owns all position integration');
assert(position.vy > 0 && position.speed > 0);

const sequence = state => {
  run(3, { ...manual, throttle: 0.8, lift: 0.5, rollControl: 0.6, yawControl: 0.4 }, state, state.hz);
  run(2, { ...manual, pitchControl: 0.4, lift: -0.3, rollControl: -0.2, yawControl: -0.3 }, state, state.hz);
  run(1, { ...manual, brake: 1 }, state, state.hz);
  return state;
};
const reference = sequence({ hz: 120 });
for (const hz of [30, 60, 144]) {
  const actual = sequence({ hz });
  for (const field of ['yaw', 'pitch', 'roll', 'yawRate', 'pitchRate', 'rollRate',
    'vx', 'vy', 'vz', 'speed', 'rotorSpeed', 'collective']) close(actual[field], reference[field], 0.015);
}

const invalid = { yaw: Infinity, pitch: NaN, roll: -Infinity, yawRate: NaN, pitchRate: Infinity, rollRate: NaN,
  vx: Infinity, vy: NaN, vz: -Infinity, rotorSpeed: NaN, collective: Infinity, speed: NaN };
stepHelicopterFlight(invalid, { throttle: Infinity, steer: NaN, lift: -Infinity,
  brake: NaN, yaw: Infinity, pitch: NaN, pitchControl: NaN, rollControl: Infinity, yawControl: NaN }, NaN);
assert(Object.values(invalid).every(Number.isFinite));
const noTime = { ...invalid };
for (const dt of [0, -1, Infinity, NaN]) stepHelicopterFlight(invalid, { throttle: 1, lift: 1 }, dt);
assert.deepEqual(invalid, noTime, 'Invalid or nonpositive durations advance no flight time');
assert.deepEqual(stepHelicopterFlight({}, { throttle: 1, lift: 1 }, 100),
  stepHelicopterFlight({}, { throttle: 1, lift: 1 }, 0.25), 'Large frame times are bounded');
assert.deepEqual(stepHelicopterFlight({}, { throttle: 2, lift: 9, steer: -8, brake: -4,
  pitchControl: 4, rollControl: -2, yawControl: 9 }, 0.25),
stepHelicopterFlight({}, { throttle: 1, lift: 1, steer: -1, brake: 0,
  pitchControl: 1, rollControl: -1, yawControl: 1 }, 0.25), 'Analog controls clamp to legal ranges');
assert.equal(stepHelicopterFlight(null, {}, 0.1), null);
stepHelicopterFlight({}, null, 0.1);
console.log('Conquest helicopter handling: rotor-vector cyclic, pedals, collective, momentum, hover brake, takeoff, landing, inactive gravity, frame rates and finite boundaries passed.');
