import assert from 'node:assert/strict';
import { JEEP_RULES, stepJeepDrive } from '../shared/vehicle-handling/jeep.js';

function drive(seconds, input, state = { speed: 0, yaw: 0 }, fps = 60) {
  for (let i = 0; i < Math.round(seconds * fps); i++) stepJeepDrive(state, input, 1 / fps);
  return state;
}
assert(Object.isFrozen(JEEP_RULES));
const launch = drive(1, { throttle: 1 });
assert(launch.speed > 8 && launch.speed < 10, 'responsive but gradual launch');
const cruise = drive(8, { throttle: 1 });
assert.equal(cruise.speed, 24);
const coast = drive(1, { throttle: 0 }, { ...cruise });
assert(coast.speed > 17 && coast.speed < 20, 'natural rolling resistance');
assert.equal(drive(8, { throttle: 0 }, { ...cruise }).speed, 0);
assert.equal(drive(1, { throttle: 1, brake: 1 }, { speed: 10, yaw: 0 }).speed, 0);
const reverse = { speed: 12, yaw: 0 };
stepJeepDrive(reverse, { throttle: -1 }, 0.25);
assert(Math.abs(reverse.speed - 7) < 1e-9, 'opposite throttle brakes before reversing');
drive(0.5, { throttle: -1 }, reverse);
assert(reverse.speed < 0 && reverse.speed > -2);
assert.equal(drive(4, { throttle: -1 }, reverse).speed, -7);
const parked = drive(2, { steer: 1 });
assert.equal(parked.yaw, 0, 'cannot pivot while stationary');
const forwardTurn = drive(1, { throttle: 1, steer: 1 }, { speed: 8, yaw: 0 });
const backwardTurn = drive(1, { throttle: -1, steer: 1 }, { speed: -7, yaw: 0 });
assert(forwardTurn.yaw < 0 && backwardTurn.yaw > 0);
const low = drive(0.1, { throttle: 1 / 3, steer: 1 }, { speed: 8, yaw: 0 });
const high = drive(0.1, { throttle: 1, steer: 1 }, { speed: 24, yaw: 0 });
const lowRadius = 8 / Math.abs(low.yawRate), highRadius = 24 / Math.abs(high.yawRate);
assert(lowRadius > 6 && lowRadius < 9, 'tight low speed offroad turning');
assert(highRadius > 20 && highRadius < 24, 'stable high speed turning');
const fpsResults = [30, 60, 120].map(fps => {
  const state = drive(3, { throttle: 1, steer: 0.7 }, undefined, fps);
  drive(1, { throttle: -1, steer: -0.4 }, state, fps);
  return drive(2, { throttle: 0, steer: 1 }, state, fps);
});
for (const result of fpsResults) {
  assert(Math.abs(result.speed - fpsResults[0].speed) < 1e-9);
  assert(Math.abs(result.yaw - fpsResults[0].yaw) < 1e-9);
}
const invalid = { speed: NaN, yaw: Infinity };
stepJeepDrive(invalid, { throttle: Infinity, steer: NaN, brake: -1 }, 1 / 60);
assert(Object.values(invalid).every(Number.isFinite));
const before = { ...invalid };
for (const dt of [NaN, Infinity, 0, -1]) stepJeepDrive(invalid, { throttle: 1 }, dt);
assert.deepEqual(invalid, before);
assert.deepEqual(stepJeepDrive({ speed: 0, yaw: 0 }, { throttle: 1 }, 100), stepJeepDrive({ speed: 0, yaw: 0 }, { throttle: 1 }, 0.25));
console.log('Jeep handling: acceleration, coast, braking, reverse, steering, frame rates and input boundaries passed');
