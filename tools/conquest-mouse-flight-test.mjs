// Mouse flight (Battlefield-style aircraft piloting on desktop): the spring-
// centred mouse stick, the jet and helicopter layouts, the keyboard-flight
// fallback, pad/touch/gunner isolation, the attitude-hold wire flag, and a live
// loop in which a pilot flies the real client input stack (Input mouse events
// -> VehicleController -> NetClient frames at 20 Hz) against the authoritative
// server: take off, climb, bank-turn and level out with the mouse as the stick.
import assert from 'node:assert/strict';
import { Input } from '../public/js/engine/input.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { FLIGHT_MODES, FLIGHT_SENSITIVITY, INPUT_PREF_KEYS, LEGACY_FLIGHT_MODE_KEY, clampFlightSensitivity, readFlightMode } from '../public/js/input-settings.js';
import { MOUSE_AIM, MOUSE_FLIGHT, VehicleController, stepMouseFlightStick } from '../public/js/session/vehicle-controller.js';
import { GameEngine } from '../server/game.js';
import { HELICOPTER_RULES, stepHelicopterFlight } from '../shared/vehicle-handling/helicopter.js';

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- the stick
{
  // Steady pointer speed holds the same deflection at any frame rate, including
  // the slow frames (8 and 4 fps) a struggling client renders.
  const held = [1 / 4, 1 / 8, 1 / 30, 1 / 60, 1 / 144].map(dt => {
    const stick = { x: 0, y: 0 };
    for (let t = 0; t < 1; t += dt) stepMouseFlightStick(stick, { dx: 0.5 * dt, dy: -0.5 * dt }, dt);
    return stick;
  });
  for (const stick of held) {
    assert(near(stick.x, 0.5 / MOUSE_FLIGHT.rate, 2e-3), `steady motion deflects the stick (${stick.x})`);
    assert(near(stick.y, 0.5 / MOUSE_FLIGHT.rate, 2e-3), 'pointer up raises the nose');
  }
  // It springs back to centre once the mouse stops.
  const stick = { x: 1, y: -1 };
  for (let i = 0; i < 60; i++) stepMouseFlightStick(stick, {}, 1 / 60);
  assert(Math.abs(stick.x) < 0.001 && Math.abs(stick.y) < 0.001, 'the stick springs back within a second');
  // The release decays on real time: the same after 0.5 s at 60, 8 and 4 fps.
  for (const fps of [4, 8, 60]) {
    const released = { x: 1, y: 0 };
    for (let i = 0; i < fps / 2; i++) stepMouseFlightStick(released, {}, 1 / fps);
    assert(near(released.x, Math.exp(-MOUSE_FLIGHT.spring * 0.5), 1e-6), `release at ${fps} fps (${released.x})`);
  }
  // A single flick produces the same total stick travel as legacy direct mapping (Δ / rate).
  const flick = { x: 0, y: 0 };
  let area = 0;
  stepMouseFlightStick(flick, { dx: 0.05 }, 1 / 60); area += flick.x / 60;
  for (let i = 0; i < 240; i++) { stepMouseFlightStick(flick, {}, 1 / 60); area += flick.x / 60; }
  assert(near(area, 0.05 / MOUSE_FLIGHT.rate, 0.004), `flick travel ${area}`);
  // Sensitivity scales and invert flips the pitch only.
  const fast = stepMouseFlightStick({ x: 0, y: 0 }, { dx: 0.01, dy: 0.01 }, 1 / 60, { sensitivity: 2 });
  const slow = stepMouseFlightStick({ x: 0, y: 0 }, { dx: 0.01, dy: 0.01 }, 1 / 60, { sensitivity: 1 });
  assert(near(fast.x, slow.x * 2) && near(fast.y, slow.y * 2));
  const inverted = stepMouseFlightStick({ x: 0, y: 0 }, { dx: 0.01, dy: 0.01 }, 1 / 60, { sensitivity: 1, invertY: true });
  assert(near(inverted.y, -slow.y) && near(inverted.x, slow.x), 'invert flips pitch only');
  const huge = stepMouseFlightStick({ x: 0, y: 0 }, { dx: 1e300, dy: NaN }, NaN);
  assert(huge.x === 1 && huge.y === 0, 'malformed motion stays bounded');
  assert.equal(clampFlightSensitivity('x'), FLIGHT_SENSITIVITY.default);
  assert.equal(clampFlightSensitivity(99), FLIGHT_SENSITIVITY.max);
}

// ---------------------------------------------------------------- layouts
const self = { id: 'pilot', state: 'alive', hp: 100, team: 'alpha', x: 100, y: 40, z: 100 };
const row = type => ({ id: type, type, team: 'alpha', x: 100, y: 40, z: 100, yaw: 0.3, pitch: 0.05, roll: 0, hp: 600,
  seatOccupants: { driver: 'pilot' }, speed: 30, grounded: false });
const seat = (controller, type, seatId = 'driver') => controller.sync({ self, enabled: true,
  vehicles: [{ ...row(type), seatOccupants: { [seatId]: 'pilot' } }] });
const mouse = (mouseDx, mouseDy) => ({ dx: mouseDx, dy: mouseDy, mouseDx, mouseDy });
const axes = ['vehiclePitchControl', 'vehicleRollControl', 'vehicleYawControl'];
{
  const c = new VehicleController({ eventTarget: null });
  c.setFlightOptions({ mouse: true, sensitivity: 1, invertY: false });

  seat(c, 'plane');
  assert(c.mouseFlight);
  let cmd = c.controls({}, mouse(0.02, -0.02), false, 1 / 60);
  assert(cmd.vehiclePitchControl > 0 && cmd.vehicleRollControl > 0 && cmd.vehicleYawControl === 0,
    'jet: mouse Y pitches, mouse X rolls');
  assert(!('vehicleAttitudeHold' in cmd), 'the jet already holds attitude');
  for (let i = 0; i < 90; i++) cmd = c.controls({}, mouse(0, 0), false, 1 / 60);
  // The controller converts each frame's mouse motion over the real frame time
  // (main.js passes its 0.25 s-capped frame time), so 8 fps flies like 60 fps.
  const steady = frame => {
    const k = new VehicleController({ eventTarget: null });
    k.setFlightOptions({ mouse: true, sensitivity: 1, invertY: false });
    seat(k, 'plane');
    let out;
    for (let t = 0; t < 1; t += frame) out = k.controls({}, mouse(0.5 * frame, -0.5 * frame), false, frame);
    return out;
  };
  for (const frame of [1 / 8, 1 / 12]) {
    const slow = steady(frame), fast = steady(1 / 60);
    assert(near(slow.vehicleRollControl, fast.vehicleRollControl, 0.01) && near(slow.vehiclePitchControl, fast.vehiclePitchControl, 0.01),
      `${Math.round(1 / frame)} fps deflects the stick like 60 fps (${slow.vehicleRollControl} vs ${fast.vehicleRollControl})`);
  }
  for (const axis of axes) assert.equal(cmd[axis], 0, 'the jet stick springs back to exact neutral');
  cmd = c.controls({ right: true, forward: true }, mouse(0, 0), false, 1 / 60);
  assert.equal(cmd.vehicleYawControl, 1, 'jet: D is right rudder');
  assert.equal(cmd.vehicleRollControl, 0, 'jet: A/D no longer bank');
  assert.equal(cmd.vehicleThrottle, 1, 'jet: W is throttle');
  cmd = c.controls({ left: true, leanLeft: true }, mouse(0, 0), false, 1 / 60);
  assert.equal(cmd.vehicleYawControl, -1, 'A and Q share the rudder without overflowing');
  assert.equal(c.controls({ crouch: true }, mouse(0, 0)).vehicleBrake, 1, 'airbrake stays on the brake key');
  assert.equal(c.controls({ jump: true }, mouse(0, 0)).vehicleLift, 1, 'Space still pulls the jet up');

  for (const type of ['helicopter', 'transport']) {
    seat(c, type);
    cmd = c.controls({}, mouse(0.02, 0.02), false, 1 / 60);
    assert(cmd.vehicleYawControl > 0 && cmd.vehicleRollControl === 0, `${type}: mouse X is the pedals`);
    assert(cmd.vehiclePitchControl < 0, `${type}: mouse down lowers the nose`);
    assert.equal(cmd.vehicleAttitudeHold, true, `${type}: a centred stick holds attitude`);
    cmd = c.controls({ forward: true, right: true }, mouse(0, 0), false, 1 / 60);
    assert.equal(cmd.vehicleLift, 1, `${type}: W raises the collective`);
    assert.equal(cmd.vehicleThrottle, 0, `${type}: W no longer tilts`);
    assert.equal(cmd.vehicleRollControl, 1, `${type}: D banks (strafes) right`);
    assert.equal(c.controls({ back: true }, mouse(0, 0)).vehicleLift, -1, `${type}: S lowers the collective`);
    assert.equal(c.controls({ forward: true, jump: true }, mouse(0, 0)).vehicleLift, 1, 'W and Space clamp together');
    assert.equal(c.controls({ forward: true, sprint: true }, mouse(0, 0)).vehicleLift, 0);
    assert.equal(c.controls({ vehicleLift: -0.5, forward: true }, mouse(0, 0)).vehicleLift, -0.5, 'explicit lift wins');
  }

  // Pad and touch look (the non-pointer share) keep their direct mapping.
  seat(c, 'helicopter');
  cmd = c.controls({}, { dx: 0.02, dy: -0.02 }, false, 1 / 60);
  assert(cmd.vehicleRollControl > 0 && cmd.vehiclePitchControl > 0 && cmd.vehicleYawControl === 0,
    'pad/touch look still pitches and banks the helicopter');

  // Free look leaves the stick centred and clears it.
  c.controls({}, mouse(0.05, 0), false, 1 / 60);
  assert(c.stick.x > 0);
  c.freeLook = true;
  cmd = c.controls({}, mouse(0.05, 0.05), false, 1 / 60);
  for (const axis of axes) assert.equal(cmd[axis], 0, 'free look never steers');
  assert.deepEqual(c.stick, { x: 0, y: 0 });
  c.freeLook = false;

  // Gunners keep direct mouse aim.
  seat(c, 'helicopter', 'gunner');
  assert(!c.mouseFlight, 'only pilots fly with the mouse');
  const before = c.yaw;
  cmd = c.controls({}, mouse(0.1, 0.05), true, 1 / 60);
  assert(near(cmd.yaw, wrap(before - 0.1)) && !('vehiclePitchControl' in cmd), 'the chin gun still aims with the mouse');

  // Keyboard flight restores the older layout.
  c.setFlightOptions({ mouse: false });
  seat(c, 'helicopter');
  cmd = c.controls({ forward: true, right: true }, mouse(0.02, 0), false, 1 / 60);
  assert.equal(cmd.vehicleThrottle, 1, 'keyboard flight: W tilts');
  assert.equal(cmd.vehicleLift, 0);
  assert(cmd.vehicleRollControl === 1 && cmd.vehicleYawControl === 0, 'keyboard flight: D and the mouse bank');
  assert(!('vehicleAttitudeHold' in cmd));
  c.dispose();
}

// ---------------------------------------------------------------- mouse aim layout
{
  const c = new VehicleController({ eventTarget: null });
  c.setFlightOptions({ mode: 'aim', sensitivity: 1, invertY: false });
  seat(c, 'plane');
  assert(c.aimFlight && !c.mouseFlight, 'aim mode is not the mouse stick');
  let cmd = c.controls({}, mouse(0.1, -0.05), false, 1 / 60);
  assert(near(cmd.yaw, wrap(0.3 - 0.1)) && near(cmd.pitch, 0.05 + 0.05), 'jet: the mouse moves the world aim from the hull attitude');
  for (const axis of axes) assert(!(axis in cmd), `jet: no ${axis}, the server instructor flies to the aim`);
  assert.deepEqual(c.flightAim, { yaw: cmd.yaw, pitch: cmd.pitch }, 'the camera reads the same aim');
  cmd = c.controls({ forward: true, right: true, crouch: true }, mouse(0, 0), false, 1 / 60);
  assert(cmd.vehicleThrottle === 1 && cmd.vehicleSteer === 1 && cmd.vehicleBrake === 1, 'jet: W throttle, D roll override, Ctrl airbrake');
  const aimYaw = cmd.yaw;
  cmd = c.controls({ leanRight: true }, mouse(0, 0), false, 0.2);
  assert(near(cmd.yaw, wrap(aimYaw - MOUSE_AIM.nudge * 0.2)), 'E nudges the aim right');
  c.freeLook = true;
  const held = c.controls({}, mouse(0.4, 0.2), false, 1 / 60);
  assert(near(held.yaw, cmd.yaw) && near(held.pitch, cmd.pitch), 'free look leaves the aim in place');
  c.freeLook = false;
  for (let i = 0; i < 200; i++) cmd = c.controls({}, mouse(0, 0.05), false, 1 / 60);
  assert(near(cmd.pitch, MOUSE_AIM.pitch[0]), 'the aim pitch is bounded');
  c.setFlightOptions({ mode: 'aim', sensitivity: 2, invertY: true });
  const before = c.controls({}, mouse(0, 0), false, 1 / 60).pitch;
  cmd = c.controls({}, mouse(0.01, 0.01), false, 1 / 60);
  assert(near(cmd.pitch, before + 0.02), 'sensitivity scales and invert flips the aim pitch (pointer down raises it)');

  for (const type of ['helicopter', 'transport']) {
    c.setFlightOptions({ mode: 'aim', sensitivity: 1, invertY: false });
    seat(c, type);
    cmd = c.controls({ forward: true, right: true, jump: true }, mouse(0.2, 0.1), false, 1 / 60);
    assert(near(cmd.yaw, wrap(0.3 - 0.2)), `${type}: mouse X turns the aim the nose follows`);
    assert(near(cmd.pitch, -0.1), `${type}: mouse Y looks up and down`);
    assert.equal(cmd.vehicleThrottle, 1, `${type}: W is the forward cyclic`);
    assert.equal(cmd.vehicleRollControl, 1, `${type}: D is the lateral cyclic`);
    assert.equal(cmd.vehiclePitchControl, 0);
    assert.equal(cmd.vehicleSteer, 0);
    assert(!('vehicleYawControl' in cmd), `${type}: no pedal axis, so the server follows the aim yaw`);
    assert(!('vehicleAttitudeHold' in cmd), `${type}: assisted cyclic, not the stick hold`);
    assert.equal(cmd.vehicleLift, 1, `${type}: Space climbs`);
    assert.equal(c.controls({ sprint: true }, mouse(0, 0)).vehicleLift, -1, `${type}: Shift descends`);
    assert.equal(c.controls({ forward: true }, mouse(0, 0)).vehicleLift, 0, `${type}: W is not the collective`);
  }
  // A gunner never flies with the aim.
  seat(c, 'helicopter', 'gunner');
  assert(!c.aimFlight && c.flightAim === null);
  c.dispose();
}
{
  // The stored mode: the new key wins; only an explicit old keyboard choice
  // carries over (the old default mouse stick was saved with every settings save).
  const read = prefs => key => prefs[key] ?? null;
  assert.equal(readFlightMode(read({})), 'aim');
  assert.equal(readFlightMode(read({ [LEGACY_FLIGHT_MODE_KEY]: 'mouse' })), 'aim');
  assert.equal(readFlightMode(read({ [LEGACY_FLIGHT_MODE_KEY]: 'keyboard' })), 'keyboard');
  assert.equal(readFlightMode(read({ [INPUT_PREF_KEYS.flightMode]: 'mouse', [LEGACY_FLIGHT_MODE_KEY]: 'keyboard' })), 'mouse');
  assert.equal(readFlightMode(() => { throw new Error('blocked storage'); }), 'aim');
  assert.deepEqual([...FLIGHT_MODES], ['aim', 'mouse', 'keyboard']);
}

// ---------------------------------------------------------------- Input bridge
{
  const input = new Input({});
  input.fallback = true; input._locked = true;
  try {
    assert.equal(input.getOptions().flightMode, 'aim', 'mouse aim is the desktop default');
    assert.equal(input.flightOptions(0).aim, true);
    assert.equal(input.flightOptions(0).mouse, false);
    assert.equal(input.flightOptions(0).mode, 'aim');
    assert.equal(input.flightOptions(0), input.flightOptions(0), 'unchanged options are reused');
    input._onMouseMove({ movementX: 10, movementY: -4 });
    input._onTouchLook(5, 0);
    const look = input.consumeDelta();
    assert(near(look.mouseDx, 10 * input.sens) && near(look.mouseDy, -4 * input.sens), 'pointer share is reported');
    assert(look.dx > look.mouseDx, 'touch look stays outside the pointer share');
    assert.deepEqual(input.consumeDelta(), { dx: 0, dy: 0, mouseDx: 0, mouseDy: 0 });
    input._onMouseMove({ movementX: 10, movementY: 0 });
    input.clearTransient();
    assert.equal(input.consumeDelta().mouseDx, 0, 'transient resets clear the pointer share');
    input.setOptions({ flightMode: 'keyboard', flightSensitivity: 2, flightInvertY: true });
    assert.deepEqual({ ...input.flightOptions(0) }, { mode: 'keyboard', aim: false, mouse: false, sensitivity: 2, invertY: true });
    input.setOptions({ flightMode: 'joystick' });
    assert.equal(input.getOptions().flightMode, 'keyboard', 'unknown modes keep the current one');
    input.setOptions({ flightMode: 'mouse' });
    assert.equal(input.flightOptions(0).mouse, true, 'the mouse stick stays selectable');
    input.setOptions({ flightMode: 'aim' });
    input._pad._activeUntil = 5000;
    assert.equal(input.flightOptions(1000).mode, 'keyboard', 'an active pad keeps its own layout');
    assert.equal(input.flightOptions(6000).aim, true);
    input._touchMode = true;
    assert.equal(input.flightOptions(6000).aim, false, 'touch keeps its own layout');
    assert.ok(INPUT_PREF_KEYS.flightMode && INPUT_PREF_KEYS.flightSensitivity && INPUT_PREF_KEYS.flightInvert);
  } finally { input.dispose(); }
}

// ---------------------------------------------------------------- wire + model
{
  const net = new NetClient(), sent = [];
  net.ws = { readyState: 1, send: frame => sent.push(JSON.parse(frame)) };
  net.sendInput({ keys: {}, vehicleAttitudeHold: true });
  assert.equal(sent.at(-1).vehicleAttitudeHold, true);
  for (const value of [false, 1, 'true', undefined]) {
    net.sendInput({ keys: {}, vehicleAttitudeHold: value });
    assert(!('vehicleAttitudeHold' in sent.at(-1)), 'only a literal true travels');
  }

  const fly = hold => {
    const s = { yaw: 0, pitch: 0, roll: 0, vx: 0, vy: 0, vz: 0, rotorSpeed: 1, y: 60 };
    const input = { pitchControl: -1, rollControl: 0, yawControl: 0, attitudeHold: hold, grounded: false };
    for (let i = 0; i < 24; i++) stepHelicopterFlight(s, input, 1 / 60);
    input.pitchControl = 0;
    const tilted = s.pitch;
    for (let i = 0; i < 120; i++) stepHelicopterFlight(s, input, 1 / 60);
    return { tilted, after: s.pitch, speed: s.speed };
  };
  const held = fly(true), levelled = fly(false);
  assert(held.tilted < -0.1);
  assert(held.after < held.tilted * 0.8, `attitude hold keeps the nose down (${held.after})`);
  assert(Math.abs(levelled.after) < Math.abs(held.after) * 0.3, 'without hold a centred stick levels');
  assert(held.speed > levelled.speed, 'holding the tilt keeps accelerating');
  assert(HELICOPTER_RULES.holdLeveling > 0 && HELICOPTER_RULES.holdLeveling < HELICOPTER_RULES.attitudeResponse);
  const s = { yaw: 0, pitch: -0.2, roll: 0, vx: 0, vy: 0, vz: 0, rotorSpeed: 1, y: 60 };
  for (let i = 0; i < 120; i++) stepHelicopterFlight(s, { yaw: 0, pitch: 0, attitudeHold: true }, 1 / 60);
  assert(s.pitch > -0.05, 'attitude hold never applies to attitude (bot) requests');
  // Hold keeps only a pitch the pilot set. A tilt handed over by the boundary
  // autopilot or a bot (no stick input yet) levels at the normal rate...
  const handed = { yaw: 0, pitch: -0.45, roll: 0, vx: 0, vy: 0, vz: 0, rotorSpeed: 1, y: 60 };
  const centred = { pitchControl: 0, rollControl: 0, yawControl: 0, attitudeHold: true, grounded: false };
  for (let i = 0; i < 60; i++) stepHelicopterFlight(handed, centred, 1 / 60);
  assert(handed.pitch > -0.15 && !handed.attitudeHeld, `a handed-over tilt levels (${handed.pitch})`);
  // ...until the pilot moves the pitch stick, which arms the hold again.
  for (let i = 0; i < 12; i++) stepHelicopterFlight(handed, { ...centred, pitchControl: -1 }, 1 / 60);
  assert(handed.attitudeHeld === true);
  const set = handed.pitch;
  for (let i = 0; i < 60; i++) stepHelicopterFlight(handed, centred, 1 / 60);
  assert(handed.pitch < set * 0.9, 'the pilot\'s own tilt holds');
  // Any assisted step (autopilot or bot) or a non-hold input disarms it.
  stepHelicopterFlight(handed, { yaw: 0, pitch: 0, attitudeHold: true }, 1 / 60);
  assert(handed.attitudeHeld === false, 'an assisted step disarms the hold');
  handed.attitudeHeld = true;
  stepHelicopterFlight(handed, { ...centred, attitudeHold: false }, 1 / 60);
  assert(handed.attitudeHeld === false, 'a keyboard (non-hold) step disarms the hold');
}

// ------------------------------------------------- map-edge hand-back
{
  // A helicopter dives at the edge of a compact 768 m map. The soft edge
  // guidance brakes it toward a hover (the hard safety pilot only if that is
  // not enough); afterwards a centred mouse stick with attitude hold and the
  // assisted keyboard cyclic both end level and slow, inside the map.
  const handBack = attitudeHold => {
    const size = 768, dimensions = { sx: size, sy: 64, sz: size };
    const world = { dimensions, getBlock: (x, y) => y === 0 ? 3 : 0, findSpawns: () => [{ x: size / 2, y: 1, z: size - 60 }], setBlock: () => true };
    const game = new GameEngine({ mode: 'conquest', world, mapMeta: { id: 'frontier', dimensions,
      spawns: { conquest: { alpha: [{ x: size / 2, y: 1, z: size - 60 }], bravo: [{ x: size / 2, y: 1, z: 60 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [{ id: 'air', team: 'alpha', type: 'helicopter', x: size / 2, y: 1, z: size / 2, yaw: 0 }] } } });
    game.addClient('pilot', 'Pilot');
    const p = game.entities.get('pilot'), v = game.vehicles.vehicles.get('air');
    Object.assign(p, { x: v.x + 5, y: 1, z: v.z });
    game.applyInput(p.id, { keys: {}, vehicleAction: { type: 'enter', vehicleId: v.id } });
    const send = extra => game.applyInput(p.id, { keys: {}, weapon: 0, vehicleControlId: v.id, vehicleControlSeatId: 'driver',
      vehiclePitchControl: 0, vehicleRollControl: 0, vehicleYawControl: 0, vehicleThrottle: 0, vehicleSteer: 0, vehicleLift: 0, vehicleBrake: 0,
      yaw: v.yaw, pitch: v.pitch, ...(attitudeHold ? { vehicleAttitudeHold: true } : {}), ...extra });
    for (let i = 0; i < 300; i++) { send({ vehicleLift: 1 }); game.vehicles.step(1 / 60); }
    let guidedAt = null, minEdge = Infinity;
    for (let i = 0; i < 60 * 40 && (guidedAt == null || i - guidedAt < 60 * 20); i++) {
      if (guidedAt == null && (game.vehicles.boundaryAvoidance.has(v.id) || v.edgeSteer > 0)) guidedAt = i;
      // Dive at the edge (stick: hold the nose down; keyboard: hold W), then let go.
      send(guidedAt == null ? (attitudeHold ? { vehiclePitchControl: -0.4 } : { vehicleThrottle: 1 }) : {});
      game.vehicles.step(1 / 60);
      minEdge = Math.min(minEdge, v.x, v.z, size - v.x, size - v.z);
    }
    assert(guidedAt != null, `the edge guidance engaged (hold ${attitudeHold})`);
    assert(!game.vehicles.boundaryAvoidance.has(v.id) && !(v.edgeSteer > 0), `the edge guidance let go (hold ${attitudeHold})`);
    return { pitch: v.pitch, speed: v.speed, minEdge };
  };
  const keyboard = handBack(false), mouse = handBack(true);
  for (const [name, run] of [['keyboard', keyboard], ['mouse', mouse]]) {
    assert(run.minEdge > 3, `${name}: the helicopter never reached the map edge (${run.minEdge.toFixed(1)} m)`);
    assert(Math.abs(run.pitch) < 0.05 && run.speed < 1.5, `${name}: level and slow after the hand-back (${run.pitch}, ${run.speed})`);
  }
  assert(keyboard.speed < 0.5, `the assisted cyclic settles into a hover after the hand-back (${keyboard.speed})`);
}

// ---------------------------------------------------------------- live flight
function liveFlight(type, mode = 'mouse') {
  const dimensions = { sx: 4096, sy: 64, sz: 4096 };
  const world = { dimensions, getBlock: (x, y) => y === 0 ? 3 : 0, findSpawns: () => [{ x: 2048, y: 1, z: 3600 }], setBlock: () => true };
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: { id: 'frontier', dimensions,
    spawns: { conquest: { alpha: [{ x: 2048, y: 1, z: 3600 }], bravo: [{ x: 2048, y: 1, z: 400 }] } },
    conquest: { flags: [], bases: {}, vehicleSpawns: [{ id: 'air', team: 'alpha', type, x: 2048, y: 1, z: 3550, yaw: 0 }] } } });
  game.addClient('pilot', 'Pilot');
  const p = game.entities.get('pilot'), v = game.vehicles.vehicles.get('air');
  Object.assign(p, { x: v.x + 5, y: 1, z: v.z });
  game.applyInput(p.id, { keys: {}, vehicleAction: { type: 'enter', vehicleId: v.id } });
  assert.equal(p.vehicleId, v.id, `${type}: the pilot boards`);

  const input = new Input({});
  input.fallback = true; input._locked = true;
  input.setOptions({ flightMode: mode });
  const controller = new VehicleController({ eventTarget: null });
  const net = new NetClient();
  net.ws = { readyState: 1, send: frame => game.applyInput(p.id, JSON.parse(frame)) };
  const key = (code, down) => (down ? input._onKeyDown : input._onKeyUp).call(input,
    { code, key: code, repeat: false, defaultPrevented: false, target: null, preventDefault() {} });
  const held = new Set();
  const hold = codes => {
    for (const code of held) if (!codes.includes(code)) { key(code, false); held.delete(code); }
    for (const code of codes) if (!held.has(code)) { key(code, true); held.add(code); }
  };
  // The pilot's hand: a wanted stick deflection becomes the mouse speed (pixels per
  // frame) that holds it at flight sensitivity 1. Only pointer events reach Input.
  const dt = 1 / 60;
  const pixels = stick => Math.max(-1, Math.min(1, stick)) * MOUSE_FLIGHT.rate * dt / input.sens;
  const sample = { duration: 0, totals: [0, 0, 0] };
  let sendAt = 0, now = 0, boundary = false, mouseOnlySticks = true;
  const track = { minY: Infinity, maxY: -Infinity, maxRoll: 0 };
  // Mouse aim: move the pointer toward a wanted world aim, at most `maxStep` rad a frame.
  const aimPixels = (target, current, maxStep = 0.06) => Math.max(-maxStep, Math.min(maxStep, wrap(current - target))) / input.sens;
  const frame = (keys, stickX, stickY, aim = null) => {
    hold(keys);
    if (aim) {
      const current = controller.flightAim ?? { yaw: v.yaw, pitch: v.pitch };
      input._onMouseMove({ movementX: aimPixels(aim.yaw, current.yaw), movementY: aimPixels(aim.pitch, current.pitch) });
    } else input._onMouseMove({ movementX: pixels(stickX), movementY: -pixels(stickY) });
    input.poll(now, dt);
    controller.sync({ self: { id: 'pilot', state: 'alive', team: 'alpha', vehicleId: v.id, x: v.x, y: v.y, z: v.z },
      enabled: true, vehicles: [{ id: v.id, type, team: 'alpha', hp: v.hp, x: v.x, y: v.y, z: v.z, yaw: v.yaw,
        pitch: v.pitch, roll: v.roll, speed: v.speed, grounded: v.grounded, seatOccupants: { driver: 'pilot' } }] });
    controller.setFlightOptions(input.flightOptions(now));
    const controls = controller.controls(input.getKeys(), input.consumeDelta(), false, dt);
    axes.forEach((field, i) => { if (Object.hasOwn(controls, field)) sample.totals[i] += controls[field] * dt; });
    sample.duration += dt;
    if (now >= sendAt) {
      // Same 20 Hz averaging as the composition root (main.js): only the axes the seat sends.
      sendAt = now + 50;
      const sampled = { ...controls };
      axes.forEach((field, i) => { if (Object.hasOwn(sampled, field)) sampled[field] = sample.totals[i] / sample.duration; });
      sample.duration = 0; sample.totals.fill(0);
      net.sendInput({ ...sampled, keys: {}, weapon: 0, vehicleControlId: v.id, vehicleControlSeatId: controller.seatId });
      if (keys.some(code => ['KeyA', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft'].includes(code))) mouseOnlySticks = false;
    }
    game.vehicles.step(dt);
    now += dt * 1000;
    if (game.vehicles.boundaryAvoidance.has(v.id)) boundary = true;
    if (!v.grounded) { track.minY = Math.min(track.minY, v.y); track.maxY = Math.max(track.maxY, v.y); }
    track.maxRoll = Math.max(track.maxRoll, Math.abs(v.roll));
    if (process.env.MOUSE_FLIGHT_TRACE && Math.round(now / dt / 1000) % 15 === 0) {
      console.log(type, (now / 1000).toFixed(2), keys.join('+'), `stick ${stickX.toFixed(2)},${stickY.toFixed(2)}`,
        `y ${v.y.toFixed(1)} v ${v.speed.toFixed(1)} vy ${v.vy.toFixed(2)} yaw ${v.yaw.toFixed(2)} pitch ${v.pitch.toFixed(3)} roll ${v.roll.toFixed(3)}`,
        `rr ${(v.rollRate ?? 0).toFixed(3)} ctl ${p.input.vehiclePitchControl?.toFixed(2)},${p.input.vehicleRollControl?.toFixed(2)},${p.input.vehicleYawControl?.toFixed(2)}`);
    }
  };
  const result = { game, v, input, controller, frame, track, get boundary() { return boundary; }, get mouseOnly() { return mouseOnlySticks; },
    seconds: s => Math.round(s / dt), dispose: () => { controller.dispose(); input.dispose(); } };
  return result;
}

{
  // Jet (mouse stick): W throttle, the mouse rotates, climbs, banks right, turns and levels out.
  const f = liveFlight('plane', 'mouse'), v = f.v;
  const ground = v.y, heading0 = v.yaw;
  let t = 0;
  // Takeoff roll with a centred stick, then rotate with the mouse.
  for (; t < f.seconds(20) && v.speed < 30; t++) f.frame(['KeyW'], 0, 0);
  assert(v.speed >= 30 && v.grounded, `jet: takeoff roll reaches rotation speed (${v.speed.toFixed(1)} m/s)`);
  const pitchStick = target => Math.max(-1, Math.min(1, (target - v.pitch) * 4 - v.pitchRate * 0.6));
  const rollStick = target => Math.max(-1, Math.min(1, -((target - v.roll) * 3 - v.rollRate * 0.5)));
  for (let i = 0; i < f.seconds(5); i++) f.frame(['KeyW'], rollStick(0), pitchStick(0.25));
  assert(!v.grounded && v.y > ground + 25, `jet: climbs after takeoff (${(v.y - ground).toFixed(1)} m)`);
  const climbHeading = v.yaw, altitude = v.y;
  // Bank right and hold the turn, keeping the nose up through it.
  for (let i = 0; i < f.seconds(10); i++) f.frame(['KeyW'], rollStick(-0.75), pitchStick(0.1));
  const banked = f.track.maxRoll;
  const turned = wrap(climbHeading - v.yaw);
  assert(banked > 0.6, `jet: banks with mouse X (${banked.toFixed(2)} rad)`);
  assert(turned > 1, `jet: the bank turns the jet right (${turned.toFixed(2)} rad)`);
  // Level out: wings level and the flight path flat, then let go of the mouse.
  const pathStick = () => Math.max(-1, Math.min(1, -v.vy * 0.08 - v.pitchRate * 0.8));
  for (let i = 0; i < f.seconds(5); i++) f.frame(['KeyW'], rollStick(0), pathStick());
  for (let i = 0; i < f.seconds(2); i++) f.frame(['KeyW'], 0, 0);
  assert(Math.abs(v.roll) < 0.08, `jet: wings level (${v.roll.toFixed(3)})`);
  assert(Math.abs(v.pitch) < 0.1 && Math.abs(v.vy) < 2, `jet: level flight (pitch ${v.pitch.toFixed(3)}, vy ${v.vy.toFixed(2)})`);
  const headingAfter = v.yaw;
  for (let i = 0; i < f.seconds(2); i++) f.frame(['KeyW'], 0, 0);
  assert(Math.abs(wrap(v.yaw - headingAfter)) < 0.06, 'jet: a released stick holds the heading');
  assert(v.y > altitude - 25 && v.hp > 0, 'jet: the turn stays airborne');
  assert(!f.boundary, 'jet: the flight-boundary autopilot never took over');
  assert(f.mouseOnly, 'jet: only W and the mouse flew it');
  console.log(`  jet: rotate ${(t / 60).toFixed(1)} s, climb +${(altitude - ground).toFixed(0)} m, bank ${banked.toFixed(2)} rad, `
    + `turn ${turned.toFixed(2)} rad, end pitch ${v.pitch.toFixed(3)} roll ${v.roll.toFixed(3)} vy ${v.vy.toFixed(2)}`
    + ` (heading ${wrap(heading0 - v.yaw).toFixed(2)})`);
  f.dispose();
}

{
  // Helicopter: W collective lifts off, the mouse tilts forward and holds it,
  // mouse X turns on the pedals, and pulling back levels the hull.
  const f = liveFlight('helicopter', 'mouse'), v = f.v;
  const ground = v.y;
  for (let i = 0; i < f.seconds(5); i++) f.frame(['KeyW'], 0, 0);
  assert(!v.grounded && v.y > ground + 15, `heli: W lifts off and climbs (${(v.y - ground).toFixed(1)} m)`);
  const hover = v.y;
  for (let i = 0; i < f.seconds(1); i++) f.frame([], 0, 0);
  // Push the nose down with one mouse movement, then let go: the tilt holds.
  for (let i = 0; i < 24; i++) f.frame([], 0, -1);
  for (let i = 0; i < f.seconds(1); i++) f.frame([], 0, 0);
  const tilted = v.pitch;
  for (let i = 0; i < f.seconds(4); i++) f.frame([], 0, 0);
  assert(tilted < -0.2 && v.pitch < tilted * 0.75, `heli: the forward tilt holds (${tilted.toFixed(2)} -> ${v.pitch.toFixed(2)})`);
  assert(v.speed > 10, `heli: holding the tilt flies forward (${v.speed.toFixed(1)} m/s)`);
  // Turn right on the pedals with mouse X.
  const heading = v.yaw;
  for (let i = 0; i < f.seconds(2); i++) f.frame([], 0.6, 0);
  const turned = wrap(heading - v.yaw);
  assert(turned > 0.8, `heli: mouse X yaws the helicopter right (${turned.toFixed(2)} rad)`);
  // Pull back to level and let go.
  for (let i = 0; i < f.seconds(4); i++) f.frame([], 0, Math.max(-1, Math.min(1, -v.pitch * 5 - v.pitchRate * 0.5)));
  for (let i = 0; i < f.seconds(1); i++) f.frame([], 0, 0);
  assert(Math.abs(v.pitch) < 0.04 && Math.abs(v.roll) < 0.04, `heli: levels out (${v.pitch.toFixed(3)}, ${v.roll.toFixed(3)})`);
  assert(Math.abs(v.y - hover) < 6 && !v.grounded, 'heli: neutral collective holds the altitude');
  assert(!f.boundary && f.mouseOnly, 'heli: no autopilot, no stick keys');
  console.log(`  heli: lift-off +${(hover - ground).toFixed(0)} m, held tilt ${tilted.toFixed(2)} -> speed ${v.speed.toFixed(1)} m/s, `
    + `yaw turn ${turned.toFixed(2)} rad, end pitch ${v.pitch.toFixed(3)}`);
  f.dispose();
}

{
  // Jet, mouse aim: W throttle, aim a little up to rotate and climb, then put
  // the aim 1.2 rad to the right. The instructor banks into the turn, rolls out
  // with the nose on the aim and holds it once the mouse stops.
  const f = liveFlight('plane', 'aim'), v = f.v;
  const ground = v.y, heading0 = v.yaw;
  let t = 0;
  // A level aim: the takeoff assist rotates at take-off speed.
  for (; t < f.seconds(25) && v.grounded; t++) f.frame(['KeyW'], 0, 0, { yaw: heading0, pitch: 0 });
  assert(!v.grounded, `jet aim: W alone with a level aim takes off (${(t / 60).toFixed(1)} s)`);
  for (; t < f.seconds(40) && v.y < ground + 25; t++) f.frame(['KeyW'], 0, 0, { yaw: heading0, pitch: 0.2 });
  assert(v.y > ground + 25, `jet aim: aiming up climbs (${(v.y - ground).toFixed(1)} m in ${(t / 60).toFixed(1)} s)`);
  for (let i = 0; i < f.seconds(3); i++) f.frame(['KeyW'], 0, 0, { yaw: heading0, pitch: 0.05 });
  const target = wrap(heading0 - 1.2);
  let maxRoll = 0, settledAt = null;
  for (let i = 0; i < f.seconds(14); i++) {
    f.frame(['KeyW'], 0, 0, { yaw: target, pitch: 0.05 });
    maxRoll = Math.max(maxRoll, -v.roll);
    if (settledAt === null && Math.abs(wrap(target - v.yaw)) < 0.03 && Math.abs(v.roll) < 0.1) settledAt = i / 60;
  }
  assert(maxRoll > 0.6, `jet aim: banks right into the turn (${maxRoll.toFixed(2)} rad)`);
  assert(settledAt !== null && settledAt < 9, `jet aim: nose on the aim, wings level after ${settledAt} s`);
  assert(Math.abs(wrap(target - v.yaw)) < 0.02 && Math.abs(v.roll) < 0.05, `jet aim: holds the aim (${wrap(target - v.yaw).toFixed(3)}, roll ${v.roll.toFixed(3)})`);
  assert(Math.abs(v.pitch - 0.05) < 0.03, `jet aim: nose pitch on the aim (${v.pitch.toFixed(3)})`);
  for (let i = 0; i < f.seconds(3); i++) f.frame(['KeyW'], 0, 0);
  assert(Math.abs(wrap(target - v.yaw)) < 0.03 && Math.abs(v.roll) < 0.05, 'jet aim: a still mouse keeps flying straight');
  assert(!f.boundary && v.hp > 0, 'jet aim: no safety takeover');
  console.log(`  jet aim: airborne ${(t / 60).toFixed(1)} s, turn 1.2 rad settled in ${settledAt.toFixed(1)} s, max bank ${maxRoll.toFixed(2)} rad`);
  f.dispose();
}

{
  // Helicopter, mouse aim: Space alone takes off, a released collective holds
  // the height, W flies forward, letting go hovers within a few seconds, the
  // nose follows mouse X and Shift sinks.
  const f = liveFlight('helicopter', 'aim'), v = f.v;
  const ground = v.y, heading0 = v.yaw;
  for (let i = 0; i < f.seconds(4); i++) f.frame(['Space'], 0, 0, { yaw: heading0, pitch: 0 });
  assert(!v.grounded && v.y > ground + 12, `heli aim: Space alone lifts off (${(v.y - ground).toFixed(1)} m)`);
  for (let i = 0; i < f.seconds(1.5); i++) f.frame([], 0, 0, { yaw: heading0, pitch: 0 });
  const hover = v.y;
  for (let i = 0; i < f.seconds(2); i++) f.frame([], 0, 0, { yaw: heading0, pitch: 0 });
  assert(Math.abs(v.y - hover) < 0.5 && Math.abs(v.vy) < 0.2, 'heli aim: releasing Space holds the altitude');
  for (let i = 0; i < f.seconds(5); i++) f.frame(['KeyW'], 0, 0, { yaw: heading0, pitch: -0.2 });
  const cruise = v.speed;
  assert(cruise > 12 && v.pitch < -0.3, `heli aim: W tilts forward and flies (${cruise.toFixed(1)} m/s)`);
  let hovered = null;
  for (let i = 0; i < f.seconds(7); i++) {
    f.frame([], 0, 0, { yaw: heading0, pitch: -0.2 });
    if (hovered === null && v.speed < 1) hovered = i / 60;
  }
  assert(hovered !== null && hovered < 5, `heli aim: released cyclic hovers from ${cruise.toFixed(1)} m/s in ${hovered} s`);
  assert(v.speed < 0.5 && Math.abs(v.pitch) < 0.03 && Math.abs(v.roll) < 0.03, 'heli aim: a level, still hover');
  const turnTo = wrap(heading0 + 1);
  for (let i = 0; i < f.seconds(3); i++) f.frame([], 0, 0, { yaw: turnTo, pitch: 0 });
  assert(Math.abs(wrap(turnTo - v.yaw)) < 0.05 && v.speed < 1, `heli aim: the nose follows mouse X in place (${wrap(turnTo - v.yaw).toFixed(3)})`);
  const before = v.y;
  for (let i = 0; i < f.seconds(2); i++) f.frame(['ShiftLeft'], 0, 0, { yaw: turnTo, pitch: 0 });
  assert(v.y < before - 5, 'heli aim: Shift descends');
  assert(!f.boundary && v.hp > 0, 'heli aim: no safety takeover');
  console.log(`  heli aim: Space lift-off +${(hover - ground).toFixed(0)} m, cruise ${cruise.toFixed(1)} m/s -> hover in ${hovered.toFixed(1)} s`);
  f.dispose();
}

console.log('Mouse flight: stick, mouse aim (jet instructor, assisted heli), jet/helicopter layouts, keyboard fallback, mode migration, device isolation, attitude hold, edge hand-back and live takeoff/climb/turn/level/hover passed');
