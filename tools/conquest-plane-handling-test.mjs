import assert from 'node:assert/strict';
import { PLANE_RULES as rules, PILOT_ASSISTS, stepPlaneFlight } from '../shared/vehicle-handling/plane.js';

const ground = 11;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const numericFields = ['yaw', 'pitch', 'roll', 'pitchRate', 'rollRate', 'rudderRate', 'yawRate', 'vx', 'vy', 'vz', 'speed', 'airspeed', 'throttle', 'enginePower', 'angleOfAttack'];
const manual = { active: true, grounded: false, pitchControl: 0, rollControl: 0, yawControl: 0 };
function run(seconds, input, state = {}, hz = 120) {
  for (let i = 0; i < Math.round(seconds * hz); i++) stepPlaneFlight(state, input, 1 / hz);
  return state;
}
// The engine owns position and ground contact. This small flat runway adapter
// exercises that contract, including positive velocity leaving real contact.
function simulate(seconds, controls, state = { x: 0, y: ground, z: 0 }, hz = 120) {
  let touchdown = null, takeoff = null;
  for (let i = 0; i < Math.round(seconds * hz); i++) {
    const grounded = state.y <= ground + 1e-8;
    const input = typeof controls === 'function' ? controls(state, grounded, i / hz) : controls;
    stepPlaneFlight(state, { active: true, ...input, grounded }, 1 / hz);
    state.x += state.vx / hz; state.z += state.vz / hz;
    const y = state.y + state.vy / hz;
    if (grounded && y > ground && !takeoff) takeoff = { distance: Math.hypot(state.x, state.z), speed: state.speed, time: i / hz };
    if (!grounded && y <= ground && !touchdown) touchdown = { speed: state.speed, vy: state.vy, time: i / hz };
    state.y = Math.max(ground, y);
  }
  return { state, takeoff, touchdown };
}

assert(Object.isFrozen(rules));
assert.equal(rules.hp, 450);
assert(rules.radius >= Math.hypot(rules.width / 2, rules.length / 2), 'Broadphase radius contains wing and tail corners');
assert.equal(rules.ceiling, 180);

const parked = run(5, { active: true, grounded: true, lift: 1, steer: 1, pitch: 10 });
assert.equal(parked.speed, 0, 'Pitch and lift without thrust cannot move or hover');
assert.equal(parked.vy, 0);
assert.equal(parked.yaw, 0, 'A stationary jet cannot pivot on its landing gear');
assert.equal(parked.roll, 0);

const taxi = run(1, { active: true, grounded: true, throttle: 1, pitch: 0, lift: 1 });
assert(taxi.speed > 3 && taxi.speed < 5, 'Engine spool gives a gradual launch');
assert(taxi.speed < rules.takeoffSpeed && taxi.vy === 0, 'Airspeed below rotation speed stays on the runway');
const takeoff = simulate(4, { throttle: 1, lift: 1, pitch: 0, yaw: 0 });
assert(takeoff.takeoff && takeoff.takeoff.distance < 300, 'Jet rotates within the available runway');
assert(takeoff.takeoff.speed >= rules.takeoffSpeed && takeoff.takeoff.time > 1);
assert(takeoff.state.y > ground + 5 && takeoff.state.vy > 5, 'Nose-up lift continues climbing after rotation');
const level = simulate(12, { throttle: 1, pitch: 0, yaw: 0 }, takeoff.state).state;
// 2026-10-16: top speed 60 m/s (was 72) for tighter, easier turns.
assert.equal(rules.maxSpeed, 60);
assert(level.speed > rules.maxSpeed - 3 && level.speed <= rules.maxSpeed + 1e-8);
assert(Math.abs(level.vy) < 3, 'Trimmed wings sustain a shallow cruise at full power');
assert(level.z < -600 && !level.stalled);

const right = run(4, { active: true, grounded: false, throttle: 1, steer: 1, yaw: 0, pitch: 0 }, { speed: 50, throttle: 1, enginePower: 1 });
const left = run(4, { active: true, grounded: false, throttle: 1, steer: -1, yaw: 0, pitch: 0 }, { speed: 50, throttle: 1, enginePower: 1 });
assert(right.yaw < -0.8 && left.yaw > 0.8, 'Held A/D continues banking despite unchanged mouse yaw');
assert(right.vx > 0 && left.vx < 0, 'Velocity follows the bank into the turn');
assert(Math.abs(right.roll + rules.maxBank) < 0.01);
assert(Math.abs(left.roll - rules.maxBank) < 0.01);
assert(Math.abs(right.yawRate) <= rules.turn && right.vy > -2, 'Bank turn remains bounded and loses only modest height');
const aimed = run(1, { active: true, grounded: false, throttle: 1, yaw: 0.6, pitch: 0.12 }, { speed: 50, throttle: 1, enginePower: 1 });
assert(aimed.yaw > 0.05 && aimed.yaw < 0.4, 'Mouse heading turns the aircraft gradually');
run(3, { active: true, grounded: false, throttle: 1, yaw: 0.6, pitch: 0.12 }, aimed);
assert(Math.abs(aimed.yaw - 0.6) < 0.01 && Math.abs(aimed.roll) < 0.02, 'The nose settles on the aim with the wings level');
assert(Math.abs(aimed.pitch - 0.12) < 0.001 && aimed.vy > 3);
// Mouse-aim responsiveness from a trimmed top-speed cruise: a 10° correction
// settles within a second, a 30° turn within 2 s, 90° within 3.8 s, 179° within
// 6 s (2026-10-19: 1.93 / 3.57 / 5.60 s; before 2.05 / 4.30 / 7.45 s), and the
// roll-out stops on the aim with a small counter-bank; a held turn neither
// sinks nor balloons.
assert.deepEqual([rules.maxBank, rules.bankRate, rules.turn, rules.maxLiftLoad, rules.pitchRate, rules.minPitch], [1.36, 3, 0.9, 5.5, 1, -0.8]);
const cruise = (speed, power) => run(20, { active: true, grounded: false, yaw: 0, pitch: 0 }, { speed, vz: -speed, throttle: power, enginePower: power }, 60);
{
  for (const [degrees, limit] of [[10, 1], [30, 2], [90, 3.8], [179, 6]]) {
    const s = cruise(rules.maxSpeed, 1), target = degrees * Math.PI / 180;
    let settled = null, counter = 0;
    for (let i = 0; i < 9 * 60; i++) {
      stepPlaneFlight(s, { active: true, grounded: false, yaw: target, pitch: 0 }, 1 / 60);
      counter = Math.max(counter, -s.roll);
      if (Math.abs(target - s.yaw) < 3 * Math.PI / 180) settled ??= (i + 1) / 60; else settled = null;
    }
    assert(settled !== null && settled < limit, `a ${degrees}° aim change settles in ${settled?.toFixed(2)} s`);
    assert(counter < 0.08, `roll-out counter-bank ${counter.toFixed(3)} rad`);
  }
  const s = cruise(50, 0.55);
  let climb = 0, turned = 0;
  for (let i = 0; i < 12 * 60; i++) {
    const before = s.yaw;
    stepPlaneFlight(s, { active: true, grounded: false, yaw: s.yaw - 2, pitch: 0 }, 1 / 60);
    climb += s.vy / 60; turned += Math.abs(Math.atan2(Math.sin(s.yaw - before), Math.cos(s.yaw - before)));
  }
  assert(turned > 2 * Math.PI * 1.1, `a held turn at 50 m/s comes round in 12 s (${turned.toFixed(2)} rad)`);
  assert(Math.abs(climb) < 25, `a held turn keeps its height (${climb.toFixed(1)} m)`);
}
// A sustained mouse-aim turn (aim held 2 rad ahead of the nose), speed held
// with the throttle like a pilot on a bomb run. 2026-10-19: at the 60 m/s top
// speed at least 42°/s and a radius under 85 m (44.0°/s, 78 m; before 28.2°/s,
// 122 m), at 40 m/s at least 48°/s and under 50 m (51°/s, 45 m; before 33°/s,
// 71 m and a 113 m sink per 10 s), never stalling and sinking at most 20 m
// per 10 s: the instructor banks no steeper than the wing can lift
// (AIM_INSTRUCTOR.turnAlpha).
for (const [hold, minRate, maxRadius] of [[rules.maxSpeed, 42, 85], [40, 48, 50]]) {
  const s = cruise(hold, 1);
  let swept = 0, speedSum = 0, height = 0;
  for (let i = 0; i < 16 * 60; i++) {
    const before = s.yaw, throttle = s.speed < hold - 1 ? 1 : s.speed > hold + 1 ? -1 : 0;
    stepPlaneFlight(s, { active: true, grounded: false, yaw: s.yaw - 2, pitch: 0, throttle }, 1 / 60);
    if (i >= 6 * 60) { swept += Math.abs(Math.atan2(Math.sin(s.yaw - before), Math.cos(s.yaw - before))); speedSum += s.speed; height += s.vy / 60; }
    assert(!s.stalled, `a sustained ${hold} m/s turn never stalls`);
  }
  const rate = swept / 10, radius = speedSum / (10 * 60) / rate;
  assert(rate > minRate * Math.PI / 180, `sustained turn at ${hold} m/s: ${(rate * 180 / Math.PI).toFixed(1)}°/s`);
  assert(radius < maxRadius, `turn radius at ${hold} m/s: ${radius.toFixed(0)} m`);
  assert(height > -20, `a held ${hold} m/s turn sinks ${(-height).toFixed(1)} m in 10 s`);
}
// Nose response: a 0.4 rad aim-pitch step settles within 0.75 s (2026-10-19:
// 0.65 s; before 0.95 s), and the nose dives to minPitch (46°, was 31°).
{
  for (const aim of [-0.4, 0.4, -1.3]) {
    const s = { speed: 60, vz: -60, throttle: 1, enginePower: 1 }, target = clamp(aim, rules.minPitch, rules.maxPitch);
    let settled = null;
    for (let i = 0; i < 3 * 60; i++) {
      stepPlaneFlight(s, { active: true, grounded: false, yaw: 0, pitch: aim }, 1 / 60);
      if (Math.abs(s.pitch - target) < 0.03) settled ??= (i + 1) / 60; else settled = null;
    }
    assert(settled !== null && settled < (aim === -1.3 ? 1.2 : 0.75), `aim pitch ${aim} settles in ${settled?.toFixed(2)} s`);
  }
}
// Ground proximity (mouse aim, groundClearance from the server): a 46° dive
// at 60 m/s held at the ground pulls out on its own (wings level) above 8 m,
// starting below 100 m so a bomb run still has its dive; without the clearance
// the same dive hits the ground. A fast low pass climbs back toward 10 m; an
// idle approach still lands softly.
{
  const dive = (agl, clearance) => {
    const p = -rules.minPitch, s = { speed: 60, pitch: -p, vx: 0, vy: -60 * Math.sin(p), vz: -60 * Math.cos(p), throttle: 1, enginePower: 1 };
    let y = agl, lowest = Infinity, pull = null;
    for (let i = 0; i < 10 * 60 && y > 0; i++) {
      stepPlaneFlight(s, { active: true, grounded: false, yaw: 0, pitch: -1.3, ...(clearance ? { groundClearance: y } : {}) }, 1 / 60);
      y += s.vy / 60; lowest = Math.min(lowest, y);
      if (pull === null && s.pitchRate > 0.05) pull = y;
    }
    return { lowest, pull, s, y };
  };
  for (const agl of [70, 150]) {
    const assisted = dive(agl, true);
    assert(assisted.lowest > 8 && Math.abs(assisted.s.roll) < 0.01 && Math.abs(assisted.s.vy) < 1, `a ${agl} m dive bottoms out at ${assisted.lowest.toFixed(1)} m`);
    assert(assisted.pull < 100, `the pull-up starts at ${assisted.pull.toFixed(0)} m`);
    assert(dive(agl, false).y <= 0, 'without a clearance the dive reaches the ground');
  }
  const low = { speed: 60, vz: -60, throttle: 1, enginePower: 1 };
  let y = 4;
  for (let i = 0; i < 6 * 60; i++) { stepPlaneFlight(low, { active: true, grounded: false, yaw: 0, pitch: -0.1, groundClearance: y }, 1 / 60); y += low.vy / 60; }
  assert(y > 8, `a low pass at full power climbs back to ${y.toFixed(1)} m`);
  const approach = simulate(16, (state, grounded) => ({ throttle: 0, pitch: grounded ? 0 : -0.09, brake: grounded ? 1 : 0, groundClearance: state.y - ground }),
    { x: 0, y: 45, z: 0, speed: 45, yaw: 0, pitch: 0, throttle: 0.35, enginePower: 0.35 });
  assert(approach.touchdown && approach.touchdown.vy > -5 && approach.state.speed === 0, 'an idle mouse-aim approach still lands');
}
// Stall guard power: aiming straight up at idle, the instructor spools the
// engine (the throttle setting stays 0) and the jet climbs without stalling
// (before: it sank 116 m in 15 s); a closing throttle (S) is never overridden.
{
  const zoom = throttle => {
    const s = { speed: 45, vz: -45, throttle: 0, enginePower: 0 };
    let height = 0, stalled = false;
    for (let i = 0; i < 15 * 60; i++) {
      stepPlaneFlight(s, { active: true, grounded: false, yaw: 0, pitch: 1.3, throttle, groundClearance: 300 }, 1 / 60);
      height += s.vy / 60; stalled ||= s.stalled;
    }
    return { s, height, stalled };
  };
  const idle = zoom(0);
  assert(!idle.stalled && idle.height > 100 && idle.s.throttle === 0 && idle.s.enginePower > 0.3, `idle zoom climbs ${idle.height.toFixed(0)} m`);
  assert.equal(zoom(-1).s.enginePower, 0, 'S keeps the engine at idle');
}
// Alpha limiter (stick flight): a full pull at 30 m/s in a 60° bank stalled
// for 1.2 s (AoA 0.37) before; now the wing stays below the stall angle.
{
  const s = { speed: 30, vz: -30, roll: -1.05, throttle: 0.5, enginePower: 0.5 };
  let alpha = 0;
  for (let i = 0; i < 4 * 60; i++) {
    stepPlaneFlight(s, { ...manual, pitchControl: 1 }, 1 / 60);
    alpha = Math.max(alpha, s.angleOfAttack);
    assert(!s.stalled, 'a full stick pull in a slow bank never stalls');
  }
  assert(alpha < rules.stallAngle && alpha > PILOT_ASSISTS.alphaFade, `peak angle of attack ${alpha.toFixed(3)}`);
}
const down = run(2, { active: true, grounded: false, throttle: 1, pitch: 0, lift: -1 }, { speed: 50, throttle: 1, enginePower: 1 });
assert(Math.abs(down.pitch + 0.28) < 0.001);
assert(down.vy < -8, 'Negative lift noses down rather than applying a helicopter descent force');

const stalled = run(2, { active: true, grounded: false, pitch: 0.5, lift: 1 }, { speed: 10, pitch: 0, vy: 0 });
assert(stalled.stalled && stalled.vy < -10, 'Low forward airspeed sinks despite nose-up controls');
const falling = run(2, { active: true, grounded: false, pitch: 0, lift: 1 }, { speed: 0, vy: -30 });
assert(falling.stalled && falling.vy < -30 && Math.hypot(falling.vx, falling.vz) === 0, 'Vertical falling speed cannot create wing lift or hover');

const throttle = run(1.5, { active: true, grounded: true, throttle: 1 });
assert.equal(throttle.throttle, 1);
run(1, { active: true, grounded: true, throttle: 0 }, throttle);
assert.equal(throttle.throttle, 1, 'Released W preserves the engine throttle setting');
const beforeSlow = throttle.speed;
run(1, { active: true, grounded: true, throttle: -1 }, throttle);
assert(throttle.speed < beforeSlow && throttle.throttle === 0, 'S reduces power and brakes forward travel');
run(4, { active: true, grounded: true, throttle: -1 }, throttle);
assert.equal(throttle.speed, 0, 'The jet never accelerates in reverse');
const brake = run(3, { active: true, grounded: true, throttle: 1, brake: 1 }, { speed: 40, throttle: 1, enginePower: 1 });
assert.equal(brake.speed, 0, 'Wheel brakes stop taxi travel despite W being held');
assert.equal(brake.throttle, 0);

const landing = simulate(16, (state, grounded) => ({ throttle: 0, pitch: grounded ? 0 : -0.09, brake: grounded ? 1 : 0 }),
  { x: 0, y: 45, z: 0, speed: 45, yaw: 0, pitch: 0, throttle: 0.35, enginePower: 0.35 });
assert(landing.touchdown && landing.touchdown.vy > -5, 'A shallow powered approach touches down at a safe descent rate');
assert.equal(landing.state.y, ground);
assert.equal(landing.state.speed, 0, 'Landing brakes bring the jet to rest');
const empty = run(4, { active: false, grounded: false, throttle: 1, lift: 1, pitch: 1 }, { speed: 60, throttle: 1, enginePower: 1 });
assert.equal(empty.enginePower, 0);
assert.equal(empty.throttle, 0);
assert(empty.vy < 0 && empty.vy > -5 && empty.speed > 25 && empty.speed < 50, 'An unoccupied fast jet retains aerodynamic lift while losing power and airspeed');
const emptyGround = run(3, { active: false, grounded: true }, { speed: 30, vy: -20, pitch: 0.4, roll: 0.5, throttle: 1, enginePower: 1 });
assert.equal(emptyGround.speed, 0);
assert.equal(emptyGround.vy, 0, 'Ground contact prevents abandoned aircraft sinking through the floor');
assert.equal(emptyGround.roll, 0);

const pulse = run(0.5, { ...manual, pitchControl: 0.3, rollControl: 0.4 }, { speed: 50, throttle: 1, enginePower: 1 });
assert(pulse.pitch > 0 && pulse.pitch < 0.1 && pulse.roll < -0.1, 'Signed elevator and aileron input moves attitude gradually');
assert(pulse.pitchRate > 0 && pulse.pitchRate <= rules.pitchRate && pulse.rollRate < 0 && Math.abs(pulse.rollRate) <= rules.bankRate);
const released = run(1.5, manual, { ...pulse });
assert(released.pitch > pulse.pitch && released.roll < pulse.roll, 'Angular inertia continues briefly after control release');
assert(Math.abs(released.pitchRate) < 0.002 && Math.abs(released.rollRate) < 0.005, 'Released control surfaces damp angular velocity');
const held = run(2, { ...manual, yaw: 2, pitch: -0.5, steer: -1 }, { ...released });
assert(Math.abs(held.pitch - released.pitch) < 0.001 && Math.abs(held.roll - released.roll) < 0.001, 'Released manual controls retain pitch and bank despite legacy aim values');
assert(held.yaw < released.yaw - 0.05, 'A retained right bank continues its aerodynamic turn');
const ignoredAim = run(1, { ...manual, yaw: 2, pitch: 0.6, steer: 1 }, { speed: 50, throttle: 1, enginePower: 1 });
assert.equal(ignoredAim.yaw, 0, 'Manual zero fields never request an absolute mouse heading');
assert.equal(ignoredAim.pitch, 0); assert.equal(ignoredAim.roll, 0);

const pitchUp = run(0.5, { ...manual, pitchControl: 1 }, { speed: 50, throttle: 1, enginePower: 1 });
const pitchDown = run(0.5, { ...manual, pitchControl: -1 }, { speed: 50, throttle: 1, enginePower: 1 });
assert(pitchUp.pitch > 0.15 && pitchDown.pitch < -0.15, 'Elevator has both signed directions');
const manualTakeoff = simulate(4, { ...manual, throttle: 1, lift: 1 });
assert(manualTakeoff.takeoff && manualTakeoff.takeoff.distance < 54 && manualTakeoff.takeoff.speed >= rules.takeoffSpeed, 'Manual elevator assist rotates within the authored runway');
assert(manualTakeoff.state.y > ground + 5 && manualTakeoff.state.vy > 5);
const manualParked = run(5, { ...manual, grounded: true, pitchControl: 1, rollControl: 1, yawControl: 1, lift: 1 });
assert.equal(manualParked.speed, 0); assert.equal(manualParked.yaw, 0); assert.equal(manualParked.roll, 0); assert.equal(manualParked.vy, 0);
const taxiRudder = run(1, { ...manual, grounded: true, yawControl: 1 }, { speed: 12 });
assert(taxiRudder.yaw < -0.2 && taxiRudder.roll === 0, 'Moving landing gear steers without banking the hull');

const bank = 0.65;
const slowBank = run(2, manual, { speed: 50, roll: bank, throttle: 0.6, enginePower: 0.6 });
const fastBank = run(2, manual, { speed: 70, roll: bank, throttle: 0.95, enginePower: 0.95 });
for (const state of [slowBank, fastBank]) {
  const flow = -Math.sin(state.yaw) * state.vx - Math.cos(state.yaw) * state.vz;
  assert(Math.abs(state.yawRate - rules.gravity * Math.tan(bank) / flow) < 0.002, 'Banked heading rate follows gravity, bank and forward airspeed');
}
assert(slowBank.yawRate > fastBank.yawRate && slowBank.speed / slowBank.yawRate < fastBank.speed / fastBank.yawRate, 'Faster airspeed widens the same-bank turn');
const levelWing = run(2, manual, { speed: 50, throttle: 0.6, enginePower: 0.6 });
const steepBank = run(2, manual, { speed: 50, roll: 0.9, throttle: 0.6, enginePower: 0.6 });
assert(steepBank.vy < levelWing.vy - 1, 'Banking spends vertical lift without elevator compensation');
const rudder = run(2, { ...manual, yawControl: 1 }, { speed: 50, throttle: 1, enginePower: 1 });
const velocityYaw = Math.atan2(-rudder.vx, -rudder.vz);
assert(rudder.yaw < -0.2 && rudder.roll === 0 && Math.abs(rudder.yawRate) <= rules.rudderRate, 'Rudder provides a smaller flat turn without supplying bank');
assert(Math.abs(rudder.yaw - velocityYaw) > 0.04 && Math.abs(rudder.yaw - velocityYaw) < 0.2, 'Rudder turns the nose ahead of the retained flight path, producing bounded sideslip');

const idleStart = { speed: 60, pitch: -0.06, throttle: 0, enginePower: 0 };
const idleGlide = run(4, manual, { ...idleStart });
const unoccupiedGlide = run(4, { active: false, grounded: false }, { ...idleStart });
assert(idleGlide.speed > rules.stallSpeed && idleGlide.vy < 0 && idleGlide.vy > -5 && !idleGlide.stalled, 'An engine-off shallow glide retains forward aerodynamic lift');
for (const field of numericFields) assert(Math.abs(idleGlide[field] - unoccupiedGlide[field]) < 1e-9, `Pilot presence cannot change aerodynamic ${field}`);
const idleLanding = simulate(12, (_state, grounded) => ({ ...manual, brake: grounded ? 1 : 0 }),
  { x: 0, y: 25, z: 0, speed: 50, pitch: -0.06, throttle: 0, enginePower: 0 });
assert(idleLanding.touchdown && idleLanding.touchdown.vy > -5 && idleLanding.touchdown.speed > rules.stallSpeed, 'An idle jet can glide onto its landing gear safely');
assert.equal(idleLanding.state.speed, 0);
const flowingWing = run(1 / 120, manual, { speed: 50, pitch: 0.1, vx: 0, vy: 0, vz: -50, enginePower: 0, throttle: 0 });
const stalledWing = run(1 / 120, manual, { speed: 50, pitch: rules.maxPitch, vx: 0, vy: 0, vz: -50, enginePower: 0, throttle: 0 });
assert(flowingWing.vy > 0.1 && stalledWing.vy < 0 && stalledWing.stalled, 'Excessive angle of attack loses wing lift despite high airspeed');
const manualStall = run(2, manual, { speed: 10, pitch: 0.5, vy: 0 });
assert(manualStall.stalled && manualStall.vy < -10, 'Manual nose-up attitude cannot hover below stall speed');
const recovery = run(5, { ...manual, pitchControl: -1 }, { ...manualStall });
const recoveryFlow = -Math.cos(recovery.pitch) * recovery.vz + Math.sin(recovery.pitch) * recovery.vy;
assert(recovery.pitch < -0.4 && recoveryFlow > rules.stallSpeed, 'Reduced tail authority permits nose-down recovery after the stalled axial flow reverses');
const normalBank = run(0.25, manual, { speed: 50, roll: 0.65, pitch: 0, vx: 0, vy: 0, vz: -50 });
const stalledBank = run(0.25, manual, { speed: 50, roll: 0.65, pitch: rules.maxPitch, vx: 0, vy: 0, vz: -50 });
assert(stalledBank.stalled && stalledBank.yawRate < normalBank.yawRate * 0.6, 'A stalled wing reduces its bank-driven heading turn');
const manualFall = run(2, manual, { speed: 0, vy: -30 });
assert(manualFall.stalled && manualFall.vy < -30 && Math.hypot(manualFall.vx, manualFall.vz) === 0, 'Vertical speed does not supply forward wing flow');

const initial = { speed: 45, yaw: 0, pitch: 0, throttle: 0.35, enginePower: 0.35 };
const reference = run(4, { active: true, grounded: false, throttle: 1, steer: 0.6, pitch: 0.12 }, { ...initial }, 120);
for (const hz of [30, 60, 144]) {
  const actual = run(4, { active: true, grounded: false, throttle: 1, steer: 0.6, pitch: 0.12 }, { ...initial }, hz);
  for (const field of numericFields) assert(Math.abs(actual[field] - reference[field]) < 0.02, `Consistent ${field} at ${hz} Hz`);
}
const rateInput = { ...manual, throttle: 1, pitchControl: 0.12, rollControl: 0.2, yawControl: 0.3 };
const rateReference = run(4, rateInput, { ...initial }, 120);
const taxiInput = { ...manual, grounded: true, throttle: 1, yawControl: 1 };
const taxiInitial = { speed: 30, throttle: 1, enginePower: 1 };
const taxiReference = run(3, taxiInput, { ...taxiInitial }, 120);
for (const hz of [30, 60, 144]) {
  const actual = run(4, rateInput, { ...initial }, hz);
  for (const field of numericFields) assert(Math.abs(actual[field] - rateReference[field]) < 0.02, `Consistent manual ${field} at ${hz} Hz`);
  assert(actual.speed <= rules.maxSpeed + 1e-8);
  const actualTaxi = run(3, taxiInput, { ...taxiInitial }, hz);
  for (const field of numericFields) assert(Math.abs(actualTaxi[field] - taxiReference[field]) < 0.02, `Consistent taxi ${field} at ${hz} Hz`);
}
const invalid = Object.fromEntries(numericFields.map((field, i) => [field, i % 2 ? Infinity : NaN]));
Object.assign(invalid, { x: 17, y: 11, z: 29 });
stepPlaneFlight(invalid, { active: true, grounded: false, throttle: Infinity, steer: NaN, lift: -Infinity, brake: NaN, yaw: Infinity, pitch: NaN }, 0.25);
assert(numericFields.every(field => Number.isFinite(invalid[field])));
stepPlaneFlight(invalid, { ...manual, pitchControl: Infinity, rollControl: NaN, yawControl: -Infinity }, 0.25);
assert(numericFields.every(field => Number.isFinite(invalid[field])));
assert.deepEqual([invalid.x, invalid.y, invalid.z], [17, 11, 29], 'Flight handler never integrates position');
const unchanged = { ...invalid };
for (const dt of [0, -1, Infinity, NaN]) stepPlaneFlight(invalid, { throttle: 1 }, dt);
assert.deepEqual(invalid, unchanged);
assert.deepEqual(stepPlaneFlight({ ...initial }, { throttle: 1, steer: 1 }, 100), stepPlaneFlight({ ...initial }, { throttle: 1, steer: 1 }, 0.25));
const seam = run(1, { active: true, grounded: false, throttle: 1, yaw: -Math.PI + 0.05, pitch: 0 },
  { speed: 50, yaw: Math.PI - 0.05, throttle: 1, enginePower: 1 });
assert(Math.abs(Math.atan2(Math.sin(seam.yaw + Math.PI - 0.05), Math.cos(seam.yaw + Math.PI - 0.05))) < 0.12, 'Mouse heading crosses the yaw seam by the short path');
console.log(`Conquest jet handling: ${manualTakeoff.takeoff.distance.toFixed(1)} m manual takeoff, surface rates/inertia, retained attitude, bank turns/slip, AoA stall, idle glide/landing, autopilot, brakes and frame rates passed.`);
