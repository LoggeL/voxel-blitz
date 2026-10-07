import assert from 'node:assert/strict';
import { TANK_RULES as rules, stepTankDrive, stepTankTurret } from '../shared/vehicle-handling/tank.js';

const run = (seconds, input, state = {}, hz = 60) => {
  for (let i = 0; i < Math.round(seconds * hz); i++) stepTankDrive(state, input, 1 / hz);
  return state;
};
assert(Object.isFrozen(rules));
const drive = run(1, { throttle: 1 });
assert(drive.speed > 3 && drive.speed < 4, 'Heavy hull builds speed gradually');
run(4, { throttle: 1 }, drive);
assert.equal(drive.speed, rules.speed);
run(0.5, { throttle: -1 }, drive);
assert(drive.speed > 0 && drive.speed < 10, 'Reverse input brakes before reversing');
run(4, { throttle: -1 }, drive);
assert.equal(drive.speed, -rules.reverse);
run(4, {}, drive);
assert.equal(drive.speed, 0, 'Released controls coast to a stop');
const braking = run(0.5, { throttle: 1, brake: 1 }, { speed: 6 });
assert(Math.abs(braking.speed - 2) < 1e-8, 'Space brake overrides held throttle');
run(1, { throttle: -1, brake: 1, steer: 1 }, braking);
assert.equal(braking.speed, 0, 'Brake holds hull stationary even with reverse throttle');
assert(braking.yawRate < 0, 'Brake permits differential track pivot');
const partialBrake = run(0.5, { throttle: 1, brake: 0.5 }, { speed: 6 });
assert(Math.abs(partialBrake.speed - 4) < 1e-8, 'Analog brake scales deceleration');

const right = run(1, { steer: 1 });
const left = run(1, { steer: -1 });
assert.equal(right.speed, 0);
assert(right.yaw < 0 && left.yaw > 0);
assert(-Math.sin(right.yaw) > 0, 'D turns the forward vector toward world +X');
assert(right.leftTrackSpeed > 0 && right.rightTrackSpeed < 0, 'Right pivot counter-rotates tracks');
assert(left.leftTrackSpeed < 0 && left.rightTrackSpeed > 0);
const yawBefore = right.yaw;
run(0.1, {}, right);
assert(right.yaw < yawBefore && right.yawRate < 0, 'Hull steering inertia persists briefly after release');
run(1, {}, right);
assert.equal(right.yawRate, 0);

for (const hz of [30, 60, 144]) {
  const reference = run(3, { throttle: 1, steer: 0.6 }, {}, 120);
  const actual = run(3, { throttle: 1, steer: 0.6 }, {}, hz);
  assert(Math.abs(actual.speed - reference.speed) < 1e-8);
  assert(Math.abs(actual.yaw - reference.yaw) < 0.001, `Consistent hull turn at ${hz} Hz`);
}
const turret = { yaw: 1.4, turretYaw: Math.PI - 0.05, turretPitch: 0 };
stepTankTurret(turret, { yaw: -Math.PI + 0.05, pitch: 10 }, 0.1);
assert(Math.abs(turret.turretYaw - (-Math.PI + 0.05)) < 1e-8, 'Turret crosses angular seam by shortest path');
assert.equal(turret.yaw, 1.4);
assert(turret.turretPitch > 0 && turret.turretPitch < rules.turretMaxPitch);
for (let i = 0; i < 100; i++) stepTankTurret(turret, { yaw: 0, pitch: 10 }, 1 / 60);
assert.equal(turret.turretPitch, rules.turretMaxPitch);
stepTankDrive(turret, { throttle: 1, steer: 1 }, 0.1);
const worldAim = turret.turretYaw;
stepTankTurret(turret, { yaw: worldAim, pitch: -10 }, 0.1);
assert.equal(turret.turretYaw, worldAim, 'Turning hull does not drag world-space turret aim');
for (let i = 0; i < 100; i++) stepTankTurret(turret, { pitch: -10 }, 1 / 60);
assert.equal(turret.turretPitch, rules.turretMinPitch);

const invalid = { speed: NaN, yaw: Infinity, yawRate: -Infinity, turretYaw: NaN, turretPitch: Infinity };
stepTankDrive(invalid, { throttle: NaN, steer: Infinity }, NaN);
stepTankTurret(invalid, { yaw: Infinity, pitch: NaN }, Infinity);
assert(Object.values(invalid).every(Number.isFinite));
const noTime = { speed: 2, yaw: 0.3 };
stepTankDrive(noTime, { throttle: 1, steer: 1 }, -1);
assert.equal(noTime.speed, 2);
assert(Math.abs(noTime.yaw - 0.3) < 1e-10);
console.log('Conquest tank handling: acceleration, brake/reverse, tracks, inertia, turret, finite inputs and frame rates passed.');
