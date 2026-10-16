// Titanfall pilot movement (docs/titanfall.md §4, §11.1; WP1). Headless and audio-free.
//
// Asserts: wallrun entry/exit timing; stairs never wallrun; alley ping-pong
// stays under 8 m; the wallrun feel against tools/titanfall-wallrun-measure.mjs
// (keyless entry, the catch kick, speed build, height profile, a full run in
// 16 m, bridged gaps/windows/pillars/steps, street chains that build speed and
// hand the double jump back, mantles, the roll spring, Ashfall faces and
// rough-wall parity); one double jump; a wall-jump restores it; slide boost,
// cooldown and duration; a 30 s slide-hop + strafe run never beats the clamp;
// jumpSeq presses; grapple charges and pull; stim, cloak and perception;
// regen; client adoption of the `tfs` frame; and prediction/authority parity:
// `stepPilot` on a server body and on the client's physics view over 2000
// random ticks (bit-equal), plus the full integrators (stepMovement vs
// PlayerPhysics.step) over 2000 random ticks at 60, 20 and 120 Hz (bit-equal).
// Prints speed/height summaries of the scripted feel runs.
import assert from 'node:assert/strict';
import { PILOT_RULES, createPilotState, stepPilot, pilotJumpSeq, pilotMoveKind } from '../shared/pilot-movement.js';
import { PHYSICS } from '../shared/player-movement.js';
import { PlayerPhysics, moveSpeedFor } from '../public/js/player-physics.js';
import { PlayerEntity } from '../server/sim/player.js';
import { stepMovement } from '../server/sim/movement.js';
import { usePilotTactical, stepPilotTacticals, resetPilotTactical, pilotTacticalFlags, pilotTacticalStatus } from '../server/sim/titanfall/pilot-tacticals.js';
import { isPerceivable, perceptionAimMul, noteExposure } from '../server/sim/titanfall/perception.js';
import { encodeTitanfallSelf, decodeTitanfallSelf, TITANFALL_PLAYER_FLAGS } from '../shared/titan-contract.js';
import { wallSideOf, PilotCamera } from '../public/js/titanfall/pilot-camera.js';
import { Input } from '../public/js/engine/input.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { airborneEntry, runProfile, irregularRun, chainRun, falsePositiveRuns, mantleRun, cameraRun, cameraIrregular, cameraEyeRun, wallWorld,
  ashfallSolid, ashfallRun } from './titanfall-wallrun-measure.mjs';
import { playerHullContact } from '../shared/player-vehicle-collision.js';

const R = PILOT_RULES;
const DT = 1 / 60;
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.equal(a, b, message); checks++; };

/*
 * Test world (voxels): floor y < 10.
 *   long wall   x = 30, z 10..40, up to y 30 (wall-run lane on its -X face)
 *   alley       x = 50 and x = 54, z 0..60, up to y 40 (open x 51..54)
 *   stairs A    z 70..73, x 10..29, 1 m deep steps; side wall z = 74
 *   stairs B    z 80..83, x 10..29, 2 m deep steps; side wall z = 84
 *   grapple pad x 100..104, z 100..104, y 24 (a roof slab to hook)
 */
function world(x, y, z) {
  if (y < 10) return true;
  if (x === 30 && z >= 10 && z < 40 && y < 30) return true;
  if ((x === 50 || x === 54) && z >= 0 && z < 60 && y < 40) return true;
  if (z >= 70 && z < 74 && x >= 10 && x < 30) return y < 11 + (x - 10);
  if (z === 74 && x >= 0 && x < 40 && y < 40) return true;
  if (z >= 80 && z < 84 && x >= 10 && x < 30) return y < 11 + Math.floor((x - 10) / 2);
  if (z === 84 && x >= 0 && x < 40 && y < 40) return true;
  if (y === 24 && x >= 100 && x < 104 && z >= 100 && z < 104) return true;
  return false;
}

/** Server PlayerEntity and client PlayerPhysics driven by the same keys (tools/traversal-test.mjs pair()). */
function pair(position, { pilot = true, solid = world } = {}) {
  const client = new PlayerPhysics();
  client.solid = solid;
  client.pilotRules = pilot;
  Object.assign(client.pos, position);
  client.grounded = true;
  const server = new PlayerEntity('pilot', 'Pilot', { ...position }, false);
  Object.assign(server, { grounded: true, deployT: 0 });
  server.pilot = createPilotState();
  server.input = { yaw: 0, pitch: 0, keys: {} };
  const ctx = { solidAt: solid, fluidAt: null, mapMeta: null, now: 0, pilotRules: pilot, onFall: () => assert.fail('unexpected fall') };
  function step(dt, k = {}) {
    const { forward = false, back = false, left = false, right = false, jump = false, crouch = false, sprint = false, yaw = 0,
      jumpSeq, prone = false } = k;
    Object.assign(server.input.keys, { f: forward, b: back, l: left, r: right, jump, crouch, sprint, prone });
    server.input.yaw = yaw;
    server.input.viewYaw = yaw;
    if (jumpSeq !== undefined) server.input.jumpSeq = jumpSeq;
    if (server.coyote > 0) server.coyote -= dt;   // updateTimers runs before integrate in GameEngine.step
    ctx.now += dt * 1000;
    stepMovement(server, dt, ctx);
    const fwd = (forward ? 1 : 0) - (back ? 1 : 0), str = (right ? 1 : 0) - (left ? 1 : 0);
    const wx = fwd * -Math.sin(yaw) + str * Math.cos(yaw), wz = fwd * -Math.cos(yaw) + str * -Math.sin(yaw);
    const length = Math.hypot(wx, wz);
    client._crouching = crouch;
    client.wantProne = prone;
    // LocalPlayer._stepPrediction's pilotInput (physics.step adds the post-stance prone gate).
    client.pilotInput = { sprint: sprint && fwd > 0 && !crouch, crouch, ads: false, stim: false };
    client.step(dt, length > 0 ? { x: wx / length, z: wz / length } : { x: 0, z: 0 },
      moveSpeedFor({ forward, back, crouch, sprint }, false), jump, fwd, yaw);
  }
  return { client, server, ctx, step };
}
const hspeed = b => Math.hypot(b.vx, b.vz);
const yawToward = (dx, dz) => Math.atan2(-dx, -dz);   // forward = (-sin yaw, -cos yaw)

/* ---------------------------------------------------------------- numbers */
{
  eq(R.walk, 5.2, 'walk'); eq(R.sprint, 8.5, 'sprint'); eq(R.crouch, 2.6, 'crouch');
  eq(R.clamp, 14, 'clamp'); eq(R.doubleJumpVy, 7.4, 'double jump vy'); eq(R.wallrun.seconds, 1.5, 'wallrun seconds');
  eq(R.slide.boost, 2.5, 'slide boost'); eq(R.grapple.charges, 2, 'grapple charges');
  // Sprint on flat ground reaches the pilot sprint speed.
  const h = pair({ x: -100.5, y: 10, z: 120.5 });
  for (let i = 0; i < 120; i++) h.step(DT, { forward: true, sprint: true, yaw: -Math.PI / 2 });
  ok(Math.abs(hspeed(h.server) - R.sprint) < 0.01, `pilot sprint ${hspeed(h.server).toFixed(3)}`);
  for (let i = 0; i < 120; i++) h.step(DT, { forward: true, yaw: -Math.PI / 2 });
  ok(Math.abs(hspeed(h.server) - R.walk) < 0.01, 'pilot walk');
  // Without pilot rules the same keys keep the stock speeds (other modes untouched).
  const stock = pair({ x: -100.5, y: 10, z: 130.5 }, { pilot: false });
  for (let i = 0; i < 120; i++) stock.step(DT, { forward: true, sprint: true, yaw: -Math.PI / 2 });
  ok(Math.abs(hspeed(stock.server) - PHYSICS.sprint) < 0.01, 'stock sprint unchanged without pilotRules');
  eq(stock.server.pilot.wall, 0, 'stock movement never touches pilot state');
}

/* ---------------------------------------------------------------- wallrun entry and exit timing */
const feel = [];
{
  // Ground approach: sprint at 30° toward the long wall, jump about a metre out.
  const h = pair({ x: 27.3, y: 10, z: 9.5 });
  const a = 30 * Math.PI / 180, yaw = yawToward(Math.sin(a), Math.cos(a));
  let enter = -1, exit = -1, z0 = 0, z1 = 0, maxH = 0, rise = 0;
  for (let i = 0; i < 240; i++) {
    h.step(DT, { forward: true, sprint: true, jump: i >= 24 && i < 27, yaw });
    const s = h.server;
    if (enter < 0 && s.pilot.wall) { enter = i; z0 = s.z; eq(s.pilot.wall, -1, 'wall on the +X side has normal -X (code -1)'); }
    if (enter >= 0 && exit < 0) {
      if (s.pilot.wall) { maxH = Math.max(maxH, hspeed(s)); rise = Math.max(rise, s.y - 10); } else { exit = i; z1 = s.z; }
    }
  }
  ok(enter > 0, 'a ground jump at the wall starts a wallrun');
  const seconds = (exit - enter) * DT;
  ok(exit > enter && seconds > 1.4, `ground-start wallrun lasts until the floor (${seconds.toFixed(2)} s)`);
  ok(maxH >= R.wallrun.speed - 0.05 && maxH <= R.clamp, `wallrun speed reaches ${R.wallrun.speed} (${maxH.toFixed(2)})`);
  feel.push(`wallrun from the ground: ${seconds.toFixed(2)} s, ${(z1 - z0).toFixed(1)} m along the wall, top speed ${maxH.toFixed(2)} m/s, peak ${rise.toFixed(2)} m`);
}
{
  // High entry: the full 1.75 s, then the spent wall cannot be re-entered before ground.
  const h = pair({ x: 29.6, y: 20, z: 12.5 });
  for (const b of [h.server]) { Object.assign(b, { grounded: false, vx: 0, vy: 0, vz: 8 }); b.pilot.lastGroundY = 14; }
  Object.assign(h.client, { grounded: false });
  Object.assign(h.client.vel, { x: 0, y: 0, z: 8 });
  h.client.pilot.lastGroundY = 14;
  let first = -1, last = -1, reentered = false;
  const yaw = Math.PI;   // forward = +z
  for (let i = 0; i < 200; i++) {
    h.step(DT, { forward: true, yaw });
    const s = h.server;
    if (s.pilot.wall && first < 0) first = i;
    if (s.pilot.wall && last >= 0 && i > last + 1) reentered = true;
    if (!s.pilot.wall && first >= 0 && last < 0) last = i;
    if (s.grounded) break;
  }
  const seconds = (last - first) * DT;
  ok(first === 0, 'airborne next to a wall with tangent speed: wallrun on the first tick');
  ok(Math.abs(seconds - R.wallrun.seconds) <= 2 * DT, `wallrun ends after ${R.wallrun.seconds} s (${seconds.toFixed(3)})`);
  ok(!reentered, 'a spent wall is not re-entered before touching ground');
  ok(Math.abs(h.server.x - h.client.pos.x) + Math.abs(h.server.y - h.client.pos.y) + Math.abs(h.server.z - h.client.pos.z) === 0,
    'wallrun prediction is bit-equal to authority');
}
{
  // Entry rules: no wallrun with less than minAir of air, too slow, pointing into the wall or above lastGroundY + 8.
  const tryEntry = (y, vz, wishInto, groundY) => {
    const b = { x: 29.6, y, z: 12.5, vx: 0, vy: 0, vz, grounded: false, coyote: 0 };
    const state = createPilotState();
    state.lastGroundY = groundY;
    const wishX = wishInto ? 1 : 0, wishZ = wishInto ? 0 : 1;
    stepPilot(state, b, { jump: false, jumpPressed: false, crouch: false, wishX, wishZ }, { solidAt: world }, DT);
    return state.wall;
  };
  eq(tryEntry(20, 8, false, 14), -1, 'reference entry');
  eq(tryEntry(10 + R.wallrun.minAir - 0.1, 8, false, 10), 0, `under ${R.wallrun.minAir} m of air: no wallrun`);
  eq(tryEntry(20, R.wallrun.minTangent - 0.5, false, 14), 0, `tangent speed under ${R.wallrun.minTangent}: no wallrun`);
  eq(tryEntry(20, 8, true, 14), 0, 'wish straight into the wall: no wallrun');
  eq(tryEntry(20, 8, false, 11), 0, 'more than 8 m above the last ground: no wallrun');
  // A wall only one voxel long along the run is not runnable: the run heads off the wall's end (z 39 -> 40).
  const b = { x: 29.6, y: 20, z: 39.5, vx: 0, vy: 0, vz: 8, grounded: false, coyote: 0 };
  const state = createPilotState(); state.lastGroundY = 14;
  stepPilot(state, b, { wishX: 0, wishZ: 1 }, { solidAt: world }, DT);
  eq(state.wall, 0, 'wall shorter than 2 voxels along the run: no wallrun');
}
{
  // Aggressive catch: a wall at x = 40 with a one-voxel gap at z 20 and a lone post at z 60.
  const gapWorld = (x, y, z) => y < 10 || (x === 40 && y < 40 && ((z >= 0 && z < 50 && z !== 20) || z === 60));
  const enter = (x, z, vx = 0) => {
    const body = { x, y: 14, z, vx, vy: 0, vz: 8, grounded: false, coyote: 0 };
    const st = createPilotState(); st.lastGroundY = 10;
    stepPilot(st, body, { wishX: 0, wishZ: 1 }, { solidAt: gapWorld }, DT);
    return { st, body };
  };
  const hullHalf = PHYSICS.halfW;
  eq(enter(40 - hullHalf - 0.7, 10.5).st.wall, -1, 'a wall 0.7 m off the hull is caught');
  eq(enter(40 - hullHalf - 1.2, 10.5).st.wall, 0, 'a wall 1.2 m off the hull is not');
  eq(enter(39.6, 20.5).st.wall, -1, 'over a one-voxel gap with the wall resuming ahead: caught');
  eq(enter(39.6, 60.5).st.wall, 0, 'a lone post is not a wall');
  // Caught 0.7 m out, the hull is pulled flush within a few ticks and runs past the gap.
  const { st, body } = enter(40 - hullHalf - 0.7, 12.5);
  let flushAt = -1, held = true;
  for (let i = 0; i < 90 && held; i++) {
    stepPilot(st, body, { wishX: 0, wishZ: 1 }, { solidAt: gapWorld }, DT);
    if (flushAt < 0 && body.x > 40 - hullHalf - 0.01) flushAt = i;
    held = st.wall !== 0;
  }
  ok(flushAt >= 0 && flushAt <= 8, `the catch pulls the hull flush in ${flushAt} ticks`);
  ok(held && body.z > 21.5, `the run carries over the one-voxel gap (z ${body.z.toFixed(1)})`);
}

/* ---------------------------------------------------------------- stairs never wallrun */
for (const [label, z, yawSign] of [['1 m steps', 72.5, 1], ['2 m steps', 82.5, 1]]) {
  const h = pair({ x: 8.5, y: 10, z });
  let walled = false, top = 0;
  const a = 25 * Math.PI / 180 * yawSign, yaw = yawToward(Math.cos(a), Math.sin(a));   // up the stairs (+x), angled at the side wall (+z)
  for (let i = 0; i < 360; i++) {
    h.step(DT, { forward: true, sprint: true, jump: true, yaw });
    if (h.server.pilot.wall || h.client.pilot.wall) walled = true;
    top = Math.max(top, h.server.y);
  }
  ok(top > 15, `${label}: the stair run climbs (${(top - 10).toFixed(1)} m)`);
  ok(!walled, `${label}: a stair climb hugging the side wall never wallruns`);
}

/* ---------------------------------------------------------------- alley ping-pong */
{
  // Jump off each wall the first tick it is caught, aiming at the other wall: the best possible climb.
  const h = pair({ x: 52.5, y: 10, z: 1.5 });
  let maxRise = 0, wallJumps = 0, prevChain = 0, target = 1;
  for (let i = 0; i < 600; i++) {
    const s = h.server, onWall = s.pilot.wall !== 0;
    if (onWall) target = s.pilot.wall > 0 ? 1 : -1;
    const ang = 40 * Math.PI / 180 * target;
    h.step(DT, { forward: true, sprint: true, yaw: yawToward(Math.sin(ang), Math.cos(ang)),
      jump: (i >= 18 && i < 21) || (onWall && i % 2 === 0) });
    maxRise = Math.max(maxRise, h.server.y - 10);
    if (h.server.pilot.chain > prevChain) wallJumps++;
    prevChain = h.server.pilot.chain;
  }
  ok(wallJumps >= 4, `alley chain wall-jumps (${wallJumps})`);
  ok(maxRise <= R.wallrun.maxRise, `alley ping-pong stays within ${R.wallrun.maxRise} m (${maxRise.toFixed(2)})`);
  feel.push(`alley ping-pong: ${wallJumps} wall-jumps, peak ${maxRise.toFixed(2)} m`);
}

/* ---------------------------------------------------------------- double jump, wall-jump restores it */
{
  const h = pair({ x: -100.5, y: 10, z: 140.5 });
  h.step(DT, { jump: true });
  ok(h.server.vy > 7.5 && !h.server.grounded, 'ground jump');
  for (let i = 0; i < 10; i++) h.step(DT, {});
  h.step(DT, { jump: true });
  ok(Math.abs(h.server.vy - (R.doubleJumpVy - PHYSICS.gravity * DT)) < 1e-9, 'double jump sets vy 7.4');
  eq(h.server.pilot.jumpsLeft, 0, 'double jump spent');
  for (let i = 0; i < 5; i++) h.step(DT, {});
  const vy = h.server.vy;
  h.step(DT, { jump: true });
  ok(Math.abs(h.server.vy - (vy - PHYSICS.gravity * DT)) < 1e-9, 'only one double jump');
  while (!h.server.grounded) h.step(DT, {});
  eq(h.server.pilot.jumpsLeft, 1, 'landing restores the double jump');

  // Wall-jump restores a spent double jump and decays with the chain.
  const b = { x: 29.6, y: 20, z: 12.5, vx: 0, vy: 0, vz: 8, grounded: false, coyote: 0 };
  const state = createPilotState(); state.lastGroundY = 14; state.jumpsLeft = 0;
  stepPilot(state, b, { wishX: 0, wishZ: 1 }, { solidAt: world }, DT);
  eq(state.wall, -1, 'on the wall');
  state.jumpsLeft = 0;
  stepPilot(state, b, { wishX: 0, wishZ: 1 }, { solidAt: world }, DT);
  stepPilot(state, b, { jump: true, jumpPressed: true, wishX: 0, wishZ: 1 }, { solidAt: world }, DT);
  eq(state.jumped, 2, 'wall-jump');
  eq(state.jumpsLeft, 1, 'wall-jump restores the double jump');
  // A wish along the wall jumps out at minOut with the run's speed (at least wallrun.speed) + boost.
  const jumpSpeed = R.wallrun.speed + R.wallJump.boost;
  ok(Math.abs(b.vx - -jumpSpeed * Math.sin(R.wallJump.minOut)) < 1e-9 && Math.abs(b.vz - jumpSpeed * Math.cos(R.wallJump.minOut)) < 1e-9
    && b.vy > 7, `wall-jump goes out ${(R.wallJump.minOut * 180 / Math.PI).toFixed(0)}° and forward at ${jumpSpeed} m/s, and up`);
  eq(state.wall, 0, 'wall-jump leaves the wall');
  for (let i = 0; i < 10; i++) stepPilot(state, b, { wishX: 0, wishZ: 1 }, { solidAt: world }, DT);
  eq(state.wall, 0, 'the same wall is locked out right after the wall-jump');
  stepPilot(state, b, { jump: true, jumpPressed: true, wishX: 0, wishZ: 1 }, { solidAt: world }, DT);
  eq(state.jumped, 3, 'the restored double jump fires');
}

/* ---------------------------------------------------------------- slide */
{
  const h = pair({ x: -400.5, y: 10, z: 200.5 });
  const yaw = -Math.PI / 2;
  for (let i = 0; i < 60; i++) h.step(DT, { forward: true, sprint: true, yaw });
  const before = hspeed(h.server);
  h.step(DT, { forward: true, sprint: true, crouch: true, yaw });
  ok(h.server.pilot.slideT > 0, 'sprint + crouch slides');
  ok(Math.abs(hspeed(h.server) - (before + R.slide.boost)) < 0.15, `slide boost +2.5 (${before.toFixed(2)} -> ${hspeed(h.server).toFixed(2)})`);
  ok(h.server.crouch === true, 'a slide keeps the crouch hitbox');
  eq(pilotMoveKind(h.server.pilot, h.server), 2, 'tf mv reports the slide');
  let ticks = 1, x0 = h.server.x;
  while (h.server.pilot.slideT > 0 && ticks < 300) { h.step(DT, { forward: true, sprint: true, crouch: true, yaw }); ticks++; }
  const seconds = ticks * DT;
  ok(seconds > 0.95 && seconds < 1.3, `slide lasts ≈1.1 s (${seconds.toFixed(2)})`);
  feel.push(`slide from sprint: ${seconds.toFixed(2)} s over ${(h.server.x - x0).toFixed(1)} m`);
  // Within the cooldown a second slide gets no boost.
  for (let i = 0; i < 40; i++) h.step(DT, { forward: true, sprint: true, yaw });
  ok(h.server.pilot.slideCd > 0, 'slide boost cooldown running');
  const again = hspeed(h.server);
  h.step(DT, { forward: true, sprint: true, crouch: true, yaw });
  ok(h.server.pilot.slideT > 0 && hspeed(h.server) <= again, 'no boost inside the 2 s cooldown');
  // Entering faster than sprint + 0.5 gives no boost either.
  const b = { x: -400.5, y: 10, z: 210.5, vx: -11, vy: 0, vz: 0, grounded: true, coyote: 0 };
  const state = createPilotState();
  stepPilot(state, b, { crouch: true, wishX: -1, wishZ: 0 }, { solidAt: world }, DT);
  ok(state.slideT > 0 && hspeed(b) <= 11, 'no boost when entering above sprint + 0.5');
}

/* ---------------------------------------------------------------- 30 s slide-hop + air strafe stays under the clamp */
{
  const h = pair({ x: -900.5, y: 10, z: 300.5 });
  let peak = 0, sum = 0, n = 0, over = 0;
  for (let i = 0; i < 1800; i++) {
    const s = h.server;
    // Strafe-turn: the view sweeps while the strafe key follows it (the classic air-strafe gain input).
    const sweep = Math.sin(i / 25);
    const k = { forward: true, sprint: true, yaw: -Math.PI / 2 + 0.9 * sweep, left: sweep > 0, right: sweep <= 0 };
    if (i > 60) { k.crouch = true; k.jump = s.grounded && (s.pilot.slideT > 0 || i % 3 === 0); }
    h.step(DT, k);
    for (const body of [h.server, { vx: h.client.vel.x, vz: h.client.vel.z }]) {
      const v = hspeed(body);
      if (v > R.clamp + 1e-9) over++;
      peak = Math.max(peak, v);
    }
    if (i > 120) { sum += hspeed(h.server); n++; }
  }
  eq(over, 0, `30 s slide-hop never exceeds the ${R.clamp} m/s clamp (peak ${peak.toFixed(2)})`);
  ok(sum / n > R.sprint, 'slide-hopping beats sprint speed');
  feel.push(`30 s slide-hop + strafe: mean ${(sum / n).toFixed(2)} m/s, peak ${peak.toFixed(2)} m/s (sprint ${R.sprint}, clamp ${R.clamp})`);
}

/* ---------------------------------------------------------------- one wall never holds a pilot up */
{
  // One straight wall: sprint at it, wall-jump some time after each catch and double-jump
  // after that (the best re-catch timings): the jumped-off wall is spent and the double
  // jump decays with the chain, so the pilot comes down within a few seconds.
  const single = (x, y, z) => y < 10 || (x === 30 && z >= 0 && z < 3000 && y < 60);
  let worst = 0;
  for (const catchTicks of [1, 6, 20, 30]) for (const djTicks of [0, 6, 12, 20]) for (const deg of [30, 45]) {
    const st = createPilotState(), b = { x: 27.5, y: 10, z: 1.5, vx: 0, vy: 0, vz: 0, grounded: true, coyote: 0 };
    const a = deg * Math.PI / 180, yaw = yawToward(Math.sin(a), Math.cos(a));
    let wallT = -1, since = 99, last = false, first = -1, end = -1;
    for (let i = 0; i < 600; i++) {
      const onWall = st.wall !== 0;
      if (onWall) { if (wallT < 0) wallT = i; } else wallT = -1;
      let jump = i >= 30 && i < 33;
      if (onWall && i - wallT >= catchTicks) { jump = true; since = 0; }
      if (!onWall && since > djTicks && st.jumpsLeft > 0 && st.chain > 0) jump = !last;
      const pressed = jump && !last; last = jump; since++;
      stepPilot(st, b, { jump, jumpPressed: pressed, sprint: true, wishX: -Math.sin(yaw), wishZ: -Math.cos(yaw) }, { solidAt: single }, DT);
      if (!b.grounded && first < 0) first = i;
      if (first >= 0 && b.grounded) { end = i; break; }
    }
    worst = Math.max(worst, ((end < 0 ? 600 : end) - first) * DT);
  }
  ok(worst < 3, `one flat wall: the pilot touches the ground again within 3 s (worst ${worst.toFixed(2)} s of 10)`);
  feel.push(`one-wall surf attempt: longest airtime ${worst.toFixed(2)} s`);
}
{
  // Alley ping-pong with a double jump between the walls: bounded height and airtime.
  let peakAll = 0, airAll = 0;
  for (const width of [3, 5]) {
    const L = 50, R2 = 50 + width + 1;
    const alley = (x, y, z) => y < 10 || ((x === L || x === R2) && z >= 0 && z < 3000 && y < 80);
    for (const deg of [25, 40, 55]) for (const catchTicks of [1, 4, 10]) for (const djTicks of [3, 8, 15, 25]) {
      const st = createPilotState(), b = { x: L + 1.5 + width / 2, y: 10, z: 1.5, vx: 0, vy: 0, vz: 0, grounded: true, coyote: 0 };
      let target = 1, wallT = -1, since = 99, last = false, first = -1, end = -1, peak = 0;
      for (let i = 0; i < 1200; i++) {
        const onWall = st.wall !== 0;
        if (onWall) { target = st.wall > 0 ? 1 : -1; if (wallT < 0) wallT = i; } else wallT = -1;
        let jump = i >= 18 && i < 21;
        if (onWall && i - wallT >= catchTicks) { jump = true; since = 0; }
        if (!onWall && since === djTicks && st.jumpsLeft > 0) jump = true;
        const pressed = jump && !last; last = jump; since++;
        const a = deg * Math.PI / 180 * target, yaw = yawToward(Math.sin(a), Math.cos(a));
        stepPilot(st, b, { jump, jumpPressed: pressed, sprint: true, wishX: -Math.sin(yaw), wishZ: -Math.cos(yaw) }, { solidAt: alley }, DT);
        peak = Math.max(peak, b.y - 10);
        if (!b.grounded && first < 0) first = i;
        if (first >= 0 && b.grounded) { end = i; break; }
      }
      peakAll = Math.max(peakAll, peak);
      airAll = Math.max(airAll, ((end < 0 ? 1200 : end) - first) * DT);
    }
  }
  ok(peakAll <= R.wallrun.maxRise, `alley ping-pong with double jumps stays within ${R.wallrun.maxRise} m (${peakAll.toFixed(2)})`);
  // The 0.75 m catch takes the opposite wall early, so chains run longer; the decay still lands them.
  ok(airAll < 15, `alley ping-pong with double jumps comes down (${airAll.toFixed(2)} s of 20)`);
  feel.push(`alley ping-pong + double jumps: peak ${peakAll.toFixed(2)} m, longest airtime ${airAll.toFixed(2)} s`);
}

/* ---------------------------------------------------------------- wallrun feel (tools/titanfall-wallrun-measure.mjs) */
{
  // Entry: touching a wall airborne while moving along it attaches, no held key needed, up to maxAngle into it.
  ok(airborneEntry({ speed: 8.5, angle: 20, vy: 0, key: false }).attached, 'airborne along a wall: wallrun without a held key');
  ok(airborneEntry({ speed: 8.5, angle: 60, vy: 0 }).attached, 'a 60° approach attaches');
  ok(!airborneEntry({ speed: 8.5, angle: 80, vy: 0 }).attached, 'an 80° (head-on) approach does not');
  ok(!airborneEntry({ speed: 2.5, angle: 20, vy: 0 }).attached, 'too slow along the wall: no wallrun');
  const falling = airborneEntry({ speed: 8.5, angle: 20, vy: -6 });
  ok(falling.attached && falling.vy > 0, `a falling catch kicks up (vy ${falling.vy})`);
  // Profile of a sprint-jump run: attaches within 0.2 s, builds to the top speed, a short rise and a slow sink, all in 16 m.
  const run = runProfile();
  ok(run.attached && run.entryDelay <= 0.2, `sprint-jump attaches ${run.entryDelay} s after the jump`);
  ok(run.vMax >= R.wallrun.top - 0.05 && run.v0 < R.wallrun.speed, `speed builds ${run.v0} -> ${run.vMax} m/s along the wall`);
  ok(run.rise > 0.5 && run.rise < 1.2 && run.endDrop > -1.2, `height: up ${run.rise} m, ends ${run.endDrop} m from the catch`);
  ok(Math.abs(run.seconds - R.wallrun.seconds) <= 2 * DT && run.reason === 'time' && run.distance <= 16,
    `a full run lasts ${run.seconds} s over ${run.distance} m (walls of 16 m carry it)`);
  feel.push(`sprint-jump wallrun: ${run.seconds} s, ${run.distance} m, ${run.v0} -> ${run.vMax} m/s, +${run.rise} / ${run.endDrop} m`);
  const coast = runProfile({ key: false });
  ok(coast.attached && coast.v1 < coast.vMax - 2, `no key: the run coasts down (${coast.vMax} -> ${coast.v1} m/s)`);
}
{
  // Contact is forgiving on uneven voxel walls; gaps of 3 m, corners and crates end it.
  for (const feature of ['gap1', 'gap2', 'window', 'facade', 'pillar', 'recess', 'stepout', 'angle-away', 'angle-toward', 'slant2']) {
    const r = irregularRun(feature);
    ok(r.passed && r.segments === 1 && Math.abs(r.seconds - R.wallrun.seconds) <= 2 * DT, `${feature}: the run carries on past it (${r.seconds} s, one run)`);
  }
  for (const feature of ['gap3', 'outer', 'inner']) ok(!irregularRun(feature).passed, `${feature}: the run ends there`);
  ok(irregularRun('outer').vEnd > 10, 'off an outer corner the pilot keeps the run speed');
  // A 45° voxel staircase is not a wall: the second step-around within stepGap ends the run.
  const stairs = irregularRun('slant1');
  ok(!stairs.passed && stairs.seconds < 0.7, `slant 1:1: the run ends at the second step (${stairs.seconds} s)`);
}
{
  // A step-around never puts the hull into a live hull (a parked titan beside a pillar): the run ends instead.
  const titan = { id: 7, type: 'titan_ion', x: 27.55, y: 10, z: 37, yaw: 0, hp: 2500 };
  for (const vehicles of [[], [titan]]) {
    const state = createPilotState();
    state.lastGroundY = 10;
    const body = { x: 30 - 0.32 - 0.05, y: 12.5, z: 30.5, vx: 0, vy: 0, vz: 9.5, grounded: false, coyote: 0 };
    const ctx = { solidAt: wallWorld('pillar', 36), vehicles };
    let inHull = 0;
    for (let i = 0; i < 60; i++) {
      stepPilot(state, body, { sprint: true, wishX: 0, wishZ: 1, yaw: Math.PI }, ctx, DT);
      if (playerHullContact(body, titan)) inHull++;
    }
    if (vehicles.length) ok(state.shiftX === 0 && inHull === 0 && state.wall === 0, `a titan beside the pillar: no step-around into it (${inHull} ticks inside)`);
    else ok(state.shiftX === -1, 'the same pillar without the titan is stepped around');
  }
}
{
  // Wall-to-wall chains across a street build momentum and hand the double jump back every catch.
  const street8 = chainRun({ width: 8, aim: 60, runT: 0.5, double: true, djVy: -3 });
  ok(street8.walls >= 8, `8 m street: ${street8.walls} walls chained`);
  ok(street8.catches.every(c => c.jumpsLeft === 1), 'every catch hands the double jump back');
  ok(street8.catches.at(-1).speed >= 13 && street8.topSpeed <= R.clamp, `the chain builds to ${street8.catches.at(-1).speed} m/s (clamp ${R.clamp})`);
  const hop = street8.hops[0];
  ok(hop.speed > R.wallrun.speed && Math.abs(hop.out - 60) < 0.5, `the wall-jump goes out at the aim (${hop.out}°) at ${hop.speed} m/s`);
  const street12 = chainRun({ width: 12, aim: 65, runT: 0.5, double: true, djVy: -6 });
  ok(street12.walls >= 3, `12 m street: ${street12.walls} walls with a timed double jump`);
  const street6 = chainRun({ width: 6, aim: 45, runT: 0.25, double: true, djVy: -3 });
  ok(street6.walls >= 10 && street6.peak <= R.wallrun.maxRise + 1e-9, `6 m street: ${street6.walls} walls, peak ${street6.peak} m`);
  // Untuned play: double jump at the apex, a quarter second on each wall.
  const plain6 = chainRun({ width: 6, aim: 45, runT: 0.25, double: true, djVy: 0 });
  const plain8 = chainRun({ width: 8, aim: 60, runT: 0.25, double: true, djVy: 0 });
  ok(plain6.walls >= 8 && plain8.walls >= 5, `apex double jumps: 6 m at 45° ${plain6.walls} walls, 8 m at 60° ${plain8.walls} walls`);
  feel.push(`street chains: 6 m ${street6.walls} walls, 8 m ${street8.walls} walls to ${street8.topSpeed} m/s, 12 m ${street12.walls} walls`);
}
{
  // Stairs, crates and low walls along a wall: stairs and the low wall never start a run.
  const runs = falsePositiveRuns();
  for (const [label, r] of Object.entries(runs)) if (!label.startsWith('crates')) eq(r.wallTicks, 0, `${label}: no wallrun (${r.climbed} m climbed)`);
  // Hopping crates beside a tall wall catches the wall from a hop's height (intended, the catch is
  // aggressive): each catch starts above the 2-voxel crates with minAir under the feet, never off a crate top.
  const crates = runs['crates along a wall'];
  ok(crates.entries <= 4 && (crates.entries === 0 || crates.entryHeight >= 2),
    `crates: ${crates.entries} run(s), entered ${crates.entryHeight} m up`);
  ok(runs['stairs 1 m (held jump)'].climbed > 5 && runs['stairs 2 m (held jump)'].climbed > 5, 'the stair runs climb');
}
{
  // Mantle: an airborne pilot pushing into a ledge within reach of the feet climbs it; a wallrun steered into its wall's top too.
  ok(mantleRun({ rise: 1.2 }).onTop, 'airborne into a ledge 1.2 m above the feet: mantle');
  ok(!mantleRun({ rise: 1.8 }).onTop, 'a ledge out of reach is not grabbed');
  const wall = mantleRun({ from: 'wall' });
  ok(wall.walled && wall.mantled && wall.onTop, 'a wallrun steered into a 3 m wall mantles onto it');
}
{
  // Camera: roll eases in and out on a critically damped spring (no snap, no overshoot) and holds over gaps.
  const chain = cameraRun({ hz: 144 });
  ok(chain.maxRoll <= R.wallrun.roll * 180 / Math.PI + 1e-6 && chain.maxRoll > 11, `roll peaks at ${chain.maxRoll}°`);
  ok(chain.maxRate < 90 && chain.maxAccel < 4000 && chain.overshoot < 0.05, `roll rate ${chain.maxRate}°/s, accel ${chain.maxAccel}°/s², overshoot ${chain.overshoot}°`);
  ok(chain.rollAt250ms > 10, `the roll is in after 0.25 s (${chain.rollAt250ms}°)`);
  ok(chain.fovRate < 120, `FOV changes ease (${chain.fovRate}°/s at most)`);
  for (const feature of ['facade', 'gap2']) {
    const c = cameraIrregular(feature);
    eq(c.reversals, 0, `${feature}: the roll never wobbles along the wall`);
  }
  const step = cameraIrregular('angle-toward');
  ok(step.eyeSideSpeed < 10, `stepping around a wall voxel eases the eye sideways (${step.eyeSideSpeed} m/s)`);
  // Through the client path (stepPilotFixed + PilotCamera, eye = pos + pilotLerp + offset): the eye never
  // enters a stepped-around voxel, keeps the near plane clear and moves sideways at most ~8 m/s.
  for (const feature of ['pillar', 'stepout', 'angle-toward', 'slant2', 'slant1']) {
    for (const hz of [30, 144, 240]) {
      const r = cameraEyeRun(feature, { hz });
      ok(r.inside === 0 && r.clearance >= 0.1 && r.eyeSideStep * hz < 8,
        `${feature} @${hz} Hz: eye inside ${r.inside} frames, clearance ${r.clearance} m, sideways ${(r.eyeSideStep * hz).toFixed(1)} m/s`);
    }
  }
}
{
  // A step-around whose run ends on the same tick still hands its shift to the camera (no one-frame voxel pop).
  const cam = new PilotCamera();
  const pilot = { wall: -1, wallT: 0.5, wallPlane: 30, wallTan: 10, wallStepAt: null, shiftX: 0, shiftZ: 0, jumpsLeft: 1, chain: 0, slideT: 0, grapple: null };
  const solid = wallWorld('pillar', 36);
  const player = { physics: { pilot, vel: { x: 0, y: 0, z: 10 }, pos: { x: 29.68, y: 12, z: 32 }, pilotLerp: { x: 0, y: 0, z: 0 }, solid },
    view: { yaw: Math.PI }, alive: true, adsT: 0, deathCamMotion: 1 };
  // Up to the pillar along the wall (the eye eases out ahead of it), then the step on a run-ending tick.
  for (; player.physics.pos.z < 35.6; player.physics.pos.z += 10 * DT) cam.update(DT, player);
  const before = player.physics.pos.x + cam.ox;
  Object.assign(pilot, { wall: 0, wallPlane: 29, wallStepAt: 36, shiftX: -1 });
  player.physics.pos.x -= 1;
  cam.update(DT, player);
  ok(Math.abs(player.physics.pos.x + cam.ox - before) < 0.1, `a same-tick run end keeps the eye in place (${(player.physics.pos.x + cam.ox - before).toFixed(3)} m)`);
}
{
  // Prediction presents a step-around without a sideways pop (stepPilotFixed leaves the shift to the camera).
  const solid = wallWorld('angle-toward', 36);
  const physics = new PlayerPhysics();
  physics.solid = solid;
  physics.pilotRules = true;
  Object.assign(physics.pos, { x: 30 - 0.32 - 0.05, y: 12.5, z: 30.5 });
  Object.assign(physics.vel, { x: 0, y: 0, z: 9.5 });
  physics.grounded = false;
  physics.pilot.lastGroundY = 10;
  physics.pilotInput = { sprint: true, crouch: false, ads: false, stim: false };
  let shifts = 0, worst = 0;
  for (let i = 0; i < 90; i++) {
    const before = physics.pilot.shiftX;
    physics.stepPilotFixed(DT, { x: 0, z: 1 }, R.sprint, false, 1, Math.PI);
    if (physics.pilot.shiftX !== before) shifts++;
    worst = Math.max(worst, Math.abs(physics.pilotLerp.x));
  }
  ok(shifts >= 1 && worst < 0.2, `step-arounds (${shifts}) leave the presented step alone (|lerp x| ${worst.toFixed(3)} m)`);
}
{
  // Ashfall: the Hab alley faces and the facades along the cross street carry a full sprint-jump run.
  const solid = await ashfallSolid();
  for (const [label, wall] of [['Hab alley, annex face', { plane: 60, side: 1, z: 38.5 }], ['Hab alley, tower face', { plane: 55, side: -1, z: 38.5 }],
    ['annex east facade (windows)', { plane: 68, side: -1, z: 36.5 }], ['smelter west face (door)', { plane: 83, side: 1, z: 36.5 }]]) {
    const r = ashfallRun(solid, { ...wall, ground: 14 });
    ok(r.attached && r.segments === 1 && Math.abs(r.seconds - R.wallrun.seconds) <= 2 * DT && r.distance <= 16,
      `Ashfall ${label}: one ${r.seconds} s run over ${r.distance} m`);
  }
}
{
  // Prediction and authority stay bit-equal over rough walls (gaps, windows, step-arounds, recesses).
  const rough = (x, y, z) => {
    if (y < 10) return true;
    if (z < 0 || z >= 120 || y >= 40) return false;
    if (z >= 20 && z < 22 && x === 30) return false;
    if (z >= 30 && z < 32 && y >= 12 && y < 14 && x === 30) return false;
    if (z === 40) return x === 29 || x === 30;
    if (z >= 50 && z < 60) return x === 31;
    if (z >= 60) return x === 30 - Math.floor((z - 60) / 5);
    return x === 30;
  };
  let stepArounds = 0;
  for (const hz of [60, 20, 120]) {
    let seed = 0x7a11 + hz;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const h = pair({ x: 28.5, y: 10, z: 12.5 }, { solid: rough });
    let keys = {}, worst = 0, walls = 0, shifts = 0;
    for (let i = 0; i < 1500; i++) {
      if (i % 150 === 0) {
        const at = { x: 29.3, y: 10, z: 8.5 + rnd() * 50 };
        Object.assign(h.server, at, { vx: 0, vy: 0, vz: 0, grounded: true, coyote: 0, vault: null });
        Object.assign(h.client.pos, at);
        Object.assign(h.client.vel, { x: 0, y: 0, z: 0 });
        Object.assign(h.client, { grounded: true, coyote: 0, vault: null });
      }
      if (i % 7 === 0) keys = { forward: true, sprint: rnd() < 0.8, jump: rnd() < 0.3, left: rnd() < 0.15, right: rnd() < 0.15,
        yaw: Math.PI + 0.1 + rnd() * 0.5 };
      const before = h.server.pilot?.shiftX ?? 0;
      h.step(1 / hz, keys);
      if (h.server.pilot.wall) walls++;
      if (h.server.pilot.shiftX !== before) shifts++;
      worst = Math.max(worst, Math.hypot(h.server.x - h.client.pos.x, h.server.y - h.client.pos.y, h.server.z - h.client.pos.z));
    }
    eq(worst, 0, `rough-wall integrators bit-equal at ${hz} Hz`);
    console.log(`rough-wall parity @${hz} Hz: 1500 random ticks bit-equal (${walls} wallrun ticks, ${shifts} step-arounds)`);
    ok(walls > 100, `rough-wall parity run wallruns at ${hz} Hz`);
    stepArounds += shifts;
  }
  ok(stepArounds > 0, `rough-wall parity runs step around wall voxels (${stepArounds})`);
}

/* ---------------------------------------------------------------- hop timing and the air-strafe cap */
{
  // Holding jump through every landing gets no hop window: the speed falls back toward sprint.
  const runHops = mode => {
    const h = pair({ x: -1500.5, y: 10, z: 400.5 });
    const yaw = -Math.PI / 2;
    for (let i = 0; i < 90; i++) h.step(DT, { forward: true, sprint: true, yaw });
    for (let i = 0; i < 6; i++) h.step(DT, { forward: true, sprint: true, crouch: true, yaw });
    let sum = 0, n = 0, wasAir = false;
    for (let i = 0; i < 1200; i++) {
      // 'timed': jump is up in the air and pressed on the first ground tick (a fresh press in the window).
      const jump = mode === 'hold' || i === 0 || (h.server.grounded && wasAir);
      wasAir = !h.server.grounded;
      h.step(DT, { forward: true, sprint: true, jump, yaw });
      if (i > 120) { sum += hspeed(h.server); n++; }
    }
    return sum / n;
  };
  const hold = runHops('hold'), timed = runHops('timed');
  ok(hold < R.sprint + 0.5, `held jump bunny-hop decays toward sprint (${hold.toFixed(2)} m/s)`);
  ok(timed > hold + 0.5, `a timed press keeps the slide speed (${timed.toFixed(2)} vs held ${hold.toFixed(2)} m/s)`);
  feel.push(`slide then hop 20 s: held jump ${hold.toFixed(2)} m/s, timed presses ${timed.toFixed(2)} m/s`);
}
for (const hz of [60, 144, 30]) {
  // A near-optimal strafe bot holding jump: each air tick aims the wish at the Quake-optimal angle.
  const dt = 1 / hz;
  const h = pair({ x: -2000.5, y: 10, z: 500.5 });
  const yaw0 = -Math.PI / 2;
  for (let t = 0; t < 1.5; t += dt) h.step(dt, { forward: true, sprint: true, yaw: yaw0 });
  for (let t = 0; t < 0.1; t += dt) h.step(dt, { forward: true, sprint: true, crouch: true, yaw: yaw0 });
  let sum = 0, n = 0, peak = 0;
  for (let t = 0; t < 20; t += dt) {
    const b = h.server, v = hspeed(b), side = Math.floor(t / 0.5) % 2 === 0 ? 1 : -1;
    let k = { jump: true, sprint: true, forward: true, yaw: yaw0 };
    if (!b.grounded && v > 0.1) {
      const c = Math.max(0, R.airWishCap - R.airAccel * dt);
      const ang = Math.acos(Math.min(1, c / v)) * side, dx = b.vx / v, dz = b.vz / v;
      const wx = dx * Math.cos(ang) - dz * Math.sin(ang), wz = dx * Math.sin(ang) + dz * Math.cos(ang);
      k = { jump: true, right: true, yaw: Math.atan2(-wz, wx) };
    }
    h.step(dt, k);
    peak = Math.max(peak, hspeed(h.server));
    sum += hspeed(h.server); n++;
  }
  ok(sum / n <= 11.5, `optimal air strafe at ${hz} Hz averages at most 11.5 m/s (${(sum / n).toFixed(2)}, peak ${peak.toFixed(2)})`);
  if (hz === 60) feel.push(`optimal strafe bot 20 s: mean ${(sum / n).toFixed(2)} m/s, peak ${peak.toFixed(2)} m/s`);
}

/* ---------------------------------------------------------------- seats and rodeo end pilot motion */
{
  // Tick order of GameEngine.step: policy.beforeTick (stepPilotTacticals), vehicles/titans
  // (stepRodeo, stood in for here: a new jumpSeq jumps off the back), then integrate,
  // which skips a seated or riding body.
  const flat = (x, y, z) => y < 10 || (y === 30 && x >= 60 && x < 64 && z >= 0 && z < 4);
  const p = new PlayerEntity('rider', 'R', { x: 0.5, y: 10, z: 0.5 }, false);
  Object.assign(p, { grounded: true, deployT: 0, team: 'b' });
  p.pilot = createPilotState();
  resetPilotTactical(p, 'grapple');
  p.input = { yaw: 0, pitch: 0, viewYaw: 0, keys: {}, jumpSeq: 0 };
  const ctx = { solidAt: flat, fluidAt: null, mapMeta: null, now: 0, pilotRules: true, onFall: () => {} };
  const policy = { now: 0, engine: { solidAt: flat } };
  const stepRodeo = () => {
    if (!p.rodeoVehicleId) return;
    Object.assign(p, { x: 3.5, y: 13.4, z: 3.5, vx: 0, vy: 0, vz: 0, grounded: false });
    if (p.input.jumpSeq !== p.rodeoJumpSeq) Object.assign(p, { rodeoVehicleId: null, vx: 0, vy: 5.5, vz: 3.5 });
  };
  const mountTitan = () => { p.rodeoVehicleId = 'T1'; p.rodeoJumpSeq = p.input.jumpSeq; return true; };
  const tick = (rodeo = true) => {
    ctx.now += DT * 1000; policy.now = ctx.now;
    stepPilotTacticals(policy, [p], ctx.now, DT);
    if (rodeo) stepRodeo();
    if (p.coyote > 0) p.coyote -= DT;
    if (!p.rodeoVehicleId && !p.vehicleId) stepMovement(p, DT, ctx);
  };
  for (let i = 0; i < 10; i++) tick(false);
  ok(mountTitan(), 'rodeo mount');
  for (let i = 0; i < 30; i++) tick();
  p.input = { ...p.input, keys: { jump: true }, jumpSeq: 1 };
  tick();
  eq(p.rodeoVehicleId ?? null, null, 'a jump press dismounts the rodeo');
  eq(p.pilot.jumped, 0, 'the dismount press is not replayed as a pilot jump');
  eq(p.pilot.jumpsLeft, 1, 'the jump-off keeps the double jump');
  tick();
  eq(p.pilot.jumped, 0, 'nor on the next tick');

  // Taking a seat mid-grapple ends the pull; nothing resumes after the exit.
  Object.assign(p, { x: 0.5, y: 10, z: 0.5, vx: 0, vy: 0, vz: 0, grounded: true });
  for (let i = 0; i < 30; i++) tick(false);
  p.pilot.grapple = { anchor: [61, 29.95, 1], t: 0, vehicleId: null, offset: null };
  for (let i = 0; i < 18; i++) tick(false);
  ok(p.pilot.grapple, 'pulling');
  p.vehicleId = 'V1';
  tick(false);
  eq(p.pilot.grapple, null, 'a seat ends the grapple');
  for (let i = 0; i < 120; i++) tick(false);
  p.vehicleId = null;
  Object.assign(p, { x: 20.5, y: 10, z: 20.5, vx: 0, vy: 0, vz: 0, grounded: true, coyote: 0 });
  for (let i = 0; i < 30; i++) tick(false);
  ok(Math.hypot(p.x - 20.5, p.z - 20.5) < 1e-9 && !p.pilot.grapple, 'the pilot stays put after the exit');
}

/* ---------------------------------------------------------------- grapple over cover */
{
  // Floor y < 10; 2-voxel cover at z 98; a building face at z 80..81 up to y 30.
  const cover = (x, y, z) => y < 10 || (z === 98 && y < 12) || (z >= 80 && z < 82 && y < 30);
  let over = 0, refused = 0;
  for (const pitch of [0.2, 0.24, 0.28, 0.33, 0.4, 0.5]) {
    const p = new PlayerEntity('g', 'G', { x: 5.5, y: 10, z: 100.5 }, false);
    Object.assign(p, { grounded: true, deployT: 0, yaw: 0, pitch });
    p.input = { yaw: 0, pitch, keys: {} };
    p.pilot = createPilotState();
    resetPilotTactical(p, 'grapple');
    const policy = { now: 1000, engine: { solidAt: cover, vehicles: null } };
    if (!usePilotTactical(policy, p, 1000)) { refused++; eq(p.pilotTac.charges, 2, `pitch ${pitch}: a refused grapple spends nothing`); continue; }
    const ctx = { solidAt: cover, fluidAt: null, mapMeta: null, now: 1000, pilotRules: true, onFall: () => {} };
    let ticks = 0;
    while (p.pilot.grapple && ticks < 120) { ctx.now += DT * 1000; stepMovement(p, DT, ctx); ticks++; }
    ok(p.z < 97, `pitch ${pitch}: the pull carries the pilot over the cover (z ${p.z.toFixed(2)}, ${ticks} ticks)`);
    over++;
  }
  ok(over >= 4 && refused >= 1, `grapple over cover: ${over} pulls over the lip, ${refused} too-close anchors refused`);
}

/* ---------------------------------------------------------------- fixed-step prediction at any display rate */
{
  // The client predicts on the server's 60 Hz step whatever the frame rate: same keys per
  // tick, bit-equal states at every step, for 75/144/240 Hz with ±15 % frame jitter.
  const lane = (x, y, z) => y < 10 || (x === 30 && z >= 0 && z < 300 && y < 40);
  const a = 30 * Math.PI / 180, wallYaw = yawToward(Math.sin(a), Math.cos(a));
  const scripts = {
    'wallrun + wall-jump': t => ({ forward: true, sprint: true, yaw: wallYaw, jump: (t >= 0.4 && t < 0.45) || (t >= 1.2 && t < 1.25) }),
    'air strafe hop': t => ({ right: t > 1, forward: t <= 1, sprint: true, jump: true, yaw: -Math.PI / 2 + (t > 1 ? 0.9 + t * 0.4 : 0) }),
    'slide hop': t => ({ forward: true, sprint: true, crouch: t > 1 && t < 1.6, jump: t > 1.5 && Math.floor(t * 4) % 2 === 0, yaw: -Math.PI / 2 }),
  };
  const wishOf = k => {
    const fwd = (k.forward ? 1 : 0) - (k.back ? 1 : 0), str = (k.right ? 1 : 0) - (k.left ? 1 : 0), yaw = k.yaw || 0;
    const wx = fwd * -Math.sin(yaw) + str * Math.cos(yaw), wz = fwd * -Math.cos(yaw) + str * -Math.sin(yaw), l = Math.hypot(wx, wz);
    return { fwd, wish: l > 0 ? { x: wx / l, z: wz / l } : { x: 0, z: 0 } };
  };
  for (const [name, script] of Object.entries(scripts)) {
    const h = pair({ x: 27.3, y: 10, z: 9.5 }, { solid: lane });
    const trail = [];
    for (let n = 0; n < 180; n++) {
      const k = script(n / 60);
      Object.assign(h.server.input.keys, { f: !!k.forward, b: false, l: !!k.left, r: !!k.right, jump: !!k.jump, crouch: !!k.crouch, sprint: !!k.sprint });
      h.server.input.yaw = h.server.input.viewYaw = k.yaw;
      if (h.server.coyote > 0) h.server.coyote -= DT;
      h.ctx.now += DT * 1000;
      stepMovement(h.server, DT, h.ctx);
      trail.push([h.server.x, h.server.y, h.server.z]);
    }
    for (const hz of [75, 144, 240]) {
      let seed = hz;
      const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
      const c = new PlayerPhysics();
      c.solid = lane; c.pilotRules = true; c.grounded = true;
      Object.assign(c.pos, { x: 27.3, y: 10, z: 9.5 });
      let steps = 0, held = false, worst = 0, frames = 0;
      while (steps < 180 && frames < 2000) {
        const k = script(steps / 60), { fwd, wish } = wishOf(k);
        c._crouching = !!k.crouch;
        c.pilotInput = { sprint: !!k.sprint && fwd > 0 && !k.crouch, crouch: !!k.crouch, ads: false, stim: false };
        if (k.jump && !held) c.notePilotJumpPress();
        held = !!k.jump;
        const frameDt = (1 / hz) * (1 + (rnd() - 0.5) * 0.3), acc0 = c._pilotAcc;
        c.stepPilotFixed(frameDt, wish, moveSpeedFor({ forward: !!k.forward, crouch: !!k.crouch, sprint: !!k.sprint }, false), !!k.jump, fwd, k.yaw);
        const done = Math.round((acc0 + frameDt - c._pilotAcc) * 60);
        steps += done; frames++;
        if (done > 0) { const r = trail[steps - 1]; worst = Math.max(worst, Math.hypot(r[0] - c.pos.x, r[1] - c.pos.y, r[2] - c.pos.z)); }
        const lerp = Math.hypot(c.pilotLerp.x, c.pilotLerp.y, c.pilotLerp.z);
        if (lerp > 0.5) assert.fail(`${name} @${hz} Hz: presentation trail ${lerp}`);
      }
      eq(worst, 0, `${name}: fixed-step prediction at ${hz} Hz matches the 60 Hz authority`);
    }
  }
}

/* ---------------------------------------------------------------- jumpSeq presses */
{
  const state = createPilotState();
  eq(pilotJumpSeq(state, 41), false, 'the first jumpSeq only syncs');
  eq(pilotJumpSeq(state, 41), false, 'same value: no press');
  eq(pilotJumpSeq(state, 43), true, 'a new value is a press');
  eq(pilotJumpSeq(state, 43), true, 'two presses in one packet are consumed one per tick');
  eq(pilotJumpSeq(state, 43), false, 'then nothing');
  eq(state.jumpSeqAck, 43, 'ack follows');
  eq(pilotJumpSeq(state, 0), true, 'wraps at 256');
  // A tap shorter than a send interval: the key reads up, the counter moved.
  const h = pair({ x: -100.5, y: 10, z: 150.5 });
  h.step(DT, { jumpSeq: 7 });
  h.step(DT, { jump: true, jumpSeq: 8 });
  for (let i = 0; i < 12; i++) h.step(DT, { jumpSeq: 8 });
  h.step(DT, { jump: false, jumpSeq: 9 });
  eq(h.server.pilot.jumped, 3, 'a press seen only through jumpSeq still double-jumps on the server');
  eq(h.server.pilot.jumpSeqAck, 9, 'the frame acknowledges the press');
}

/* ---------------------------------------------------------------- grapple */
{
  const now0 = 1000;
  const p = new PlayerEntity('g', 'G', { x: 101.5, y: 10, z: 110.5 }, false);
  Object.assign(p, { grounded: true, deployT: 0, yaw: 0, pitch: 0.9 });   // facing -z, up at the slab
  p.input = { yaw: 0, pitch: 0.9, keys: {} };
  p.pilot = createPilotState();
  resetPilotTactical(p, 'grapple');
  const policy = { now: now0, engine: { solidAt: world, vehicles: null } };
  ok(usePilotTactical(policy, p, now0), 'grapple hooks the slab');
  ok(Array.isArray(p.pilot.grapple?.anchor) && Math.abs(p.pilot.grapple.anchor[1] - 24) < 0.2, 'anchor on the slab underside');
  ok(pilotTacticalFlags(p, now0) & TITANFALL_PLAYER_FLAGS.grappling, 'tf flag grappling');
  eq(pilotMoveKind(p.pilot, p), 5, 'tf mv reports the grapple');
  eq(p.tfRegen, null, 'fresh regen state');
  const ctx = { solidAt: world, fluidAt: null, mapMeta: null, now: now0, pilotRules: true, onFall: () => {} };
  const y0 = p.y;
  let released = -1, peak = 0;
  for (let i = 0; i < 120 && released < 0; i++) {
    ctx.now += DT * 1000;
    stepMovement(p, DT, ctx);
    peak = Math.max(peak, Math.hypot(p.vx, p.vy, p.vz));
    if (!p.pilot.grapple) released = i;
  }
  ok(p.y > y0 + 4, `the pull lifts the pilot (${(p.y - y0).toFixed(1)} m)`);
  ok(released > 0 && released * DT <= R.grapple.seconds + DT, `released by ${R.grapple.seconds} s or at the anchor (${(released * DT).toFixed(2)} s)`);
  ok(peak <= R.grapple.cap + 1e-9, `pull speed capped at ${R.grapple.cap} (${peak.toFixed(2)})`);
  eq(p.pilotTac.charges, 1, 'one charge spent');
  p.pilot.grapple = null;
  Object.assign(p, { x: 101.5, y: 10, z: 110.5, vx: 0, vy: 0, vz: 0, grounded: true });
  ok(usePilotTactical(policy, p, now0 + 100), 'second charge');
  eq(p.pilotTac.charges, 0, 'both charges spent');
  p.pilot.grapple = null;
  eq(usePilotTactical(policy, p, now0 + 200), false, 'no charge left');
  stepPilotTacticals(policy, [p], now0 + R.grapple.recharge * 1000 + 1, DT);
  eq(p.pilotTac.charges, 1, 'a charge returns after 6 s');
  ok(pilotTacticalStatus(p, now0 + R.grapple.recharge * 1000 + 1).tacReady < 1, 'the next charge is still recharging');
  stepPilotTacticals(policy, [p], now0 + 2 * R.grapple.recharge * 1000 + 2, DT);
  eq(p.pilotTac.charges, 2, 'both charges back after 12 s');
  // Nothing to hook: refused, no charge spent.
  p.pitch = 0.3; p.yaw = Math.PI / 2;
  eq(usePilotTactical(policy, p, now0 + 20000), false, 'grapple into the open sky is refused');
  eq(p.pilotTac.charges, 2, 'a refused grapple spends nothing');
  // A jump press releases the hook.
  p.pitch = 0.9; p.yaw = 0;
  ok(usePilotTactical(policy, p, now0 + 21000), 'hooked again');
  const state = p.pilot;
  stepPilot(state, p, { jump: true, jumpPressed: true }, { solidAt: world }, DT);
  eq(state.grapple, null, 'jump releases the grapple');
}

/* ---------------------------------------------------------------- stim, cloak, perception */
{
  const p = new PlayerEntity('s', 'S', { x: 0, y: 10, z: 0 }, false);
  resetPilotTactical(p, 'stim');
  const policy = { now: 0, engine: { solidAt: world } };
  ok(usePilotTactical(policy, p, 1000), 'stim');
  ok(pilotTacticalFlags(p, 1000) & TITANFALL_PLAYER_FLAGS.stimmed, 'tf flag stimmed');
  eq(usePilotTactical(policy, p, 2000), false, 'stim cooldown');
  ok(usePilotTactical(policy, p, 1000 + R.stim.cooldown * 1000), 'stim ready after 12 s');
  // Stimmed speed under the clamp.
  const h = pair({ x: -100.5, y: 10, z: 160.5 });
  h.server.pilotTac = { kind: 'stim', charges: 0, readyAt: 1e12, cloakUntil: 0, stimUntil: 1e12 };
  for (let i = 0; i < 120; i++) h.step(DT, { forward: true, sprint: true, yaw: -Math.PI / 2 });
  ok(Math.abs(hspeed(h.server) - R.sprint * R.stim.speedMul) < 0.02, `stim sprint ×1.3 (${hspeed(h.server).toFixed(2)})`);

  const c = new PlayerEntity('c', 'C', { x: 0, y: 10, z: 0 }, false);
  resetPilotTactical(c, 'cloak');
  ok(usePilotTactical(policy, c, 1000), 'cloak');
  ok(pilotTacticalFlags(c, 1000) & TITANFALL_PLAYER_FLAGS.cloaked, 'tf flag cloaked');
  const far = { x: 20, y: 10, z: 0 }, near = { x: 10, y: 10, z: 0 };
  eq(isPerceivable(far, c, 1500), false, 'cloaked pilot invisible at 20 m');
  eq(isPerceivable(near, c, 1500), true, 'cloaked pilot perceivable within 12 m');
  eq(perceptionAimMul(near, c, 1500), 3, 'close cloaked target: ×3 aim error');
  eq(perceptionAimMul(far, c, 1500), 0, 'not perceivable: no engagement');
  noteExposure(c, 1600);
  eq(isPerceivable(far, c, 2000), true, 'exposed for 1 s after firing or damage');
  eq(perceptionAimMul(far, c, 2000), 1, 'exposed: normal aim');
  eq(isPerceivable(far, c, 2700), false, 'hidden again after 1 s');
  eq(isPerceivable(far, c, 1000 + R.cloak.seconds * 1000 + 1), true, 'cloak ends after 5 s');
  // Firing exposes through stepPilotTacticals (shotSeq).
  const c2 = new PlayerEntity('c2', 'C2', { x: 0, y: 10, z: 0 }, false);
  resetPilotTactical(c2, 'cloak');
  usePilotTactical(policy, c2, 1000);
  stepPilotTacticals(policy, [c2], 1100, DT);
  c2.shotSeq++;
  stepPilotTacticals(policy, [c2], 1200, DT);
  eq(isPerceivable(far, c2, 1300), true, 'a shot reveals the cloaked pilot');
  // Taking damage reveals through the chained beforeDamage hook.
  const c3 = new PlayerEntity('c3', 'C3', { x: 0, y: 10, z: 0 }, false);
  resetPilotTactical(c3, 'cloak');
  usePilotTactical(policy, c3, 1000);
  policy.now = 1100;
  stepPilotTacticals(policy, [c3], 1100, DT);
  c3.takeDamage(5, false, null, 'rifle');
  eq(isPerceivable(far, c3, 1500), true, 'damage reveals the cloaked pilot');
}

/* ---------------------------------------------------------------- regen */
{
  const p = new PlayerEntity('r', 'R', { x: 0, y: 10, z: 0 }, false);
  resetPilotTactical(p, 'grapple');
  const policy = { now: 0, engine: { solidAt: world } };
  let now = 10000;
  stepPilotTacticals(policy, [p], now, DT);
  policy.now = now;
  p.takeDamage(50, false, null, 'rifle');
  eq(p.hp, 50, 'damaged');
  const run = seconds => { for (let i = 0; i < Math.round(seconds * 60); i++) { now += DT * 1000; policy.now = now; stepPilotTacticals(policy, [p], now, DT); } };
  run(4.9);
  eq(p.hp, 50, 'no regen inside 5 s');
  run(0.2 + 1);
  ok(p.hp > 60 && p.hp < 75, `regen 20 hp/s after 5 s (${p.hp.toFixed(1)})`);
  run(5);
  eq(p.hp, 100, 'regen tops out at 100');
  // Stim: no delay, 30 hp/s.
  p.pilotTac = { kind: 'stim', charges: 1, readyAt: 0, cloakUntil: 0, stimUntil: 0 };
  usePilotTactical(policy, p, now);
  p.takeDamage(60, false, null, 'rifle');
  run(1);
  ok(p.hp > 40 + 28 && p.hp < 40 + 32, `stim regen 30 hp/s without delay (${p.hp.toFixed(1)})`);
}

/* ---------------------------------------------------------------- tfs adoption and LocalPlayer wiring */
{
  const physics = new PlayerPhysics();
  physics.solid = world;
  eq(physics.adoptPilot({ vx: 1, vy: 2, vz: 3 }), false, 'adoptPilot is inert without pilotRules');
  physics.pilotRules = true;
  Object.assign(physics.pos, { x: 29.6, y: 20, z: 12.5 });
  const frame = decodeTitanfallSelf({ t: 'tfs', s: 5, d: encodeTitanfallSelf({ vx: 0, vy: -0.5, vz: 9, wallN: -1, wallT: 0.4,
    jumpsLeft: 0, slideT: 0, slideCd: 1.5, jumpSeqAck: 3 }) });
  ok(physics.adoptPilot(frame), 'adoptPilot adopts');
  eq(physics.vel.z, 9, 'velocity adopted');
  eq(physics.pilot.wall, -1, 'wall adopted');
  eq(physics.pilot.wallPlane, 30, 'wall plane re-derived from the body');
  eq(physics.pilot.jumpsLeft, 0, 'jumps adopted');
  eq(physics.pilot.slideCd, 1.5, 'slide cooldown adopted');
  ok(physics.adoptPilotGrapple([101, 23.95, 103]), 'grapple anchor adopted');
  ok(physics.adoptPilotGrapple(null), 'grapple released by the row');

  const input = new Input({});
  input.fallback = true;
  const client = new PlayerPhysics();
  client.solid = world;
  Object.assign(client.pos, { x: -100.5, y: 10, z: 170.5 });
  client.grounded = true;
  const player = new LocalPlayer({ input, physics: client });
  const sent = [];
  const intents = { fireAllowed: true, sendInput: payload => { sent.push(payload); return true; } };
  try {
    player.setGameplayInputEnabled(true);
    player.update(1 / 60, 1000, intents);
    ok(!('jumpSeq' in sent.at(-1)), 'no jumpSeq outside titanfall (input fixtures unchanged)');
    client.pilotRules = true;
    const event = code => ({ code, repeat: false, preventDefault() {} });
    input._onKeyDown(event('Space'));
    player.update(1 / 60, 1017, intents);
    eq(sent.at(-1).jumpSeq, 1, 'a jump press bumps jumpSeq');
    input._onKeyUp?.(event('Space'));
    player.update(1 / 60, 1034, intents);
    eq(sent.at(-1).jumpSeq, 1, 'holding or releasing does not');
    // Reconcile: a 1 m error adopts the tick's tfs frame only when it acknowledged every press.
    const raw = { t: 'tfs', s: 777, d: encodeTitanfallSelf({ vx: 4, vy: 0, vz: 0, jumpsLeft: 1, jumpSeqAck: 0 }) };
    player.pilotSelfFrameFor = s => (s === 777 ? raw : null);
    player.pilotSnapNow = 777;
    const row = { state: 'alive', hp: 100, x: client.pos.x + 1, y: client.pos.y, z: client.pos.z };
    player.reconcile(row, 10);
    ok(client.vel.x !== 4, 'a frame behind a local press is not adopted');
    raw.d = encodeTitanfallSelf({ vx: 4, vy: 0, vz: 0, jumpsLeft: 1, jumpSeqAck: 1 });
    player.reconcile({ ...row, x: client.pos.x + 1 }, 11);
    eq(client.vel.x, 4, 'a diverged prediction adopts the acknowledged frame');
    // The frame can also arrive after the tick (adoptPilotFrame).
    player.pilotSelfFrameFor = () => null;
    player.pilotSnapNow = 778;
    player.reconcile({ ...row, x: client.pos.x + 1 }, 12);
    ok(player.adoptPilotFrame({ t: 'tfs', s: 778, d: encodeTitanfallSelf({ vx: -2, jumpSeqAck: 1 }) }), 'a trailing frame is adopted');
    eq(client.vel.x, -2, 'trailing frame velocity');
    eq(player.adoptPilotFrame({ t: 'tfs', s: 778, d: encodeTitanfallSelf({ vx: 5, jumpSeqAck: 1 }) }), false, 'adopted once');
    // Rodeo: prediction off, the body rides the authoritative anchor.
    player.reconcile({ ...row, x: 5, y: 30, z: 5, tf: [6, 0, 0, 0, 0, 'T1', 0, 0] }, 13);
    player.update(1 / 60, 1051, intents);
    eq(client.pos.x, 5, 'rodeo body follows the row');
    eq(client.pos.y, 30, 'rodeo body is not integrated');
    // Camera: a wallrun with the wall on the right rolls the view left.
    client.pilot.wall = -1;
    player.view.yaw = Math.PI;   // facing +z: the +X wall is on the left
    ok(wallSideOf(-1, Math.PI) < -0.99 && wallSideOf(-1, 0) > 0.99, 'wall side relative to the view');
    const cam = new PilotCamera();
    let roll = 0;
    for (let i = 0; i < 60; i++) roll = cam.update(1 / 60, player).roll;
    ok(Math.abs(roll + R.wallrun.roll) < 0.01, `wallrun roll ±12° (${(roll * 180 / Math.PI).toFixed(1)}°)`);
  } finally { player.dispose(); input.dispose(); }
}

{
  // Rodeo prediction (rodeo feel pass): an airborne contact (titan-ui's rodeoContactFor) is
  // grabbed at once; the body holds on the drawn hull (rodeoPoseFor) until the authority's
  // mount arrives, the camera glides over instead of popping, and the confirmed ride neither
  // moves the body off the drawn hull nor restarts the glide. A grab the authority never
  // confirms lapses after 600 ms and prediction resumes.
  const input = new Input({});
  input.fallback = true;
  const client = new PlayerPhysics();
  client.solid = world;
  client.pilotRules = true;
  Object.assign(client.pos, { x: -100.5, y: 14, z: 190.5 });
  client.grounded = false;
  const player = new LocalPlayer({ input, physics: client });
  const intents = { fireAllowed: true, sendInput: () => true };
  let hullZ = 192, now = 5000, grabs = 0;
  player.rodeoContactFor = pos => (pos.y < 13.6 ? (grabs++, 'T7') : null);
  player.rodeoPoseFor = id => (id === 'T7' ? { x: -100.5, y: 15.4, z: hullZ } : null);
  // One display frame: update, then the camera's offset decay (updateCamera's first step).
  const frame = () => { now += 1000 / 60; hullZ -= 0.08; player.update(1 / 60, now, intents); player._stepReconcileOffset(1 / 60); };
  const near = (a, b, tol, message) => ok(Math.abs(a - b) <= tol, `${message}: ${a} vs ${b}`);
  const eye = () => ({ x: client.pos.x + player._reconcileOffset.x, y: client.pos.y + player._reconcileOffset.y, z: client.pos.z + player._reconcileOffset.z });
  try {
    player.setGameplayInputEnabled(true);
    let before = null;
    for (let i = 0; i < 60 && !player._rodeoPending; i++) { before = { ...client.pos }; frame(); }
    eq(player._rodeoPending?.id, 'T7', 'an airborne contact is grabbed by the prediction');
    near(client.pos.y, 15.4, 1e-9, 'the grabbed body is on the back (drawn hull)');
    ok(Math.hypot(eye().x - before.x, eye().y - before.y, eye().z - before.z) < 0.3, 'the camera starts where the body was (glide, no pop)');
    for (let i = 0; i < 12; i++) frame();
    near(client.pos.z, hullZ, 1e-9, 'the held body rides the moving hull');
    near(client.pos.y, 15.4, 1e-9, 'the held body does not fall');
    ok(Math.hypot(player._reconcileOffset.x, player._reconcileOffset.y, player._reconcileOffset.z) < 0.4, 'the glide settles in ~200 ms');
    // The authority's mount (its row trails the drawn hull a little): no snap, no new glide.
    const offset = { ...player._reconcileOffset };
    player.reconcile({ state: 'alive', hp: 100, x: -100.5, y: 15.4, z: hullZ + 0.3, tf: [6, 0, 0, 0, 0, 'T7', 0, 0] }, 20);
    frame();
    near(client.pos.z, hullZ, 1e-9, 'the confirmed rider stays on the drawn hull');
    ok(Math.abs(player._reconcileOffset.z) <= Math.abs(offset.z) + 1e-9, 'the confirmed mount adds no camera jump');
    eq(player._rodeoPending, null, 'the authority mount clears the predicted grab');
    // Jump off: the ride ends, the same hull is not re-grabbed by the hook (titan-ui) — here the hook says no.
    player.rodeoContactFor = () => null;
    player.reconcile({ state: 'alive', hp: 100, x: -100.5, y: 15.4, z: hullZ, tf: [4, 0, 0, 0, 0, 0, 0, 0] }, 21);
    frame();
    ok(client.pos.y < 15.4, 'off the back, prediction resumes (the body falls)');
    // A grab the authority never confirms lapses.
    Object.assign(client.pos, { x: -100.5, y: 14, z: 190.5 }); client.vel.y = 0; client.grounded = false;
    player.rodeoContactFor = pos => (pos.y < 13.6 ? 'T7' : null);
    for (let i = 0; i < 60 && !player._rodeoPending; i++) frame();
    ok(!!player._rodeoPending, 'grabbed again (unconfirmed)');
    player.rodeoContactFor = () => null;
    for (let i = 0; i < Math.ceil(0.6 * 60) + 1; i++) frame();
    eq(player._rodeoPending, null, 'an unconfirmed grab lapses after 600 ms');
    const y0 = client.pos.y;
    frame(); frame();
    ok(client.pos.y < y0, 'prediction resumes after the lapse');
    ok(grabs > 0, 'contact hook consulted');
  } finally { player.dispose(); input.dispose(); }
}

{
  // LocalPlayer on a 240 Hz display: a tap that starts and ends between two 60 Hz steps
  // still jumps (latched press), bumps jumpSeq once, and the camera trails the body by
  // less than one step.
  const input = new Input({});
  input.fallback = true;
  const client = new PlayerPhysics();
  client.solid = world;
  client.pilotRules = true;
  Object.assign(client.pos, { x: -100.5, y: 10, z: 180.5 });
  client.grounded = true;
  const player = new LocalPlayer({ input, physics: client });
  const sent = [];
  const intents = { fireAllowed: true, sendInput: payload => { sent.push(payload); return true; } };
  const event = code => ({ code, repeat: false, preventDefault() {} });
  try {
    player.setGameplayInputEnabled(true);
    let now = 2000;
    const frame = () => { now += 1000 / 240; player.update(1 / 240, now, intents); };
    for (let i = 0; i < 8; i++) frame();
    while (client._pilotAcc > 0.004) frame();   // just after a step
    input._onKeyDown(event('Space'));
    frame();
    input._onKeyUp(event('Space'));
    frame();
    ok(client.vel.y === 0 && client.grounded, 'no step ran during the tap');
    for (let i = 0; i < 4; i++) frame();
    ok(client.vel.y > 7, `the latched tap jumps on the next 60 Hz step (vy ${client.vel.y.toFixed(2)})`);
    eq(sent.at(-1).jumpSeq, 1, 'the tap bumps jumpSeq once');
    input._onKeyDown(event('KeyW'));
    for (let i = 0; i < 30; i++) {
      frame();
      const trail = Math.hypot(client.pilotLerp.x, client.pilotLerp.y, client.pilotLerp.z);
      if (!(trail <= Math.hypot(client.vel.x, client.vel.y, client.vel.z) / 60 + 0.05)) assert.fail(`camera trail ${trail}`);
    }
    checks++;
    input._onKeyUp(event('KeyW'));
  } finally { player.dispose(); input.dispose(); }
}

/* ---------------------------------------------------------------- stepPilot parity: server body vs client view */
{
  let seed = 0x5eed;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const client = new PlayerPhysics();
  client.solid = world;
  client.pilotRules = true;
  const view = client._pilotView();
  const server = { x: 28.5, y: 10, z: 12.5, vx: 0, vy: 0, vz: 0, grounded: true, coyote: 0, crouch: false, sprint: false };
  Object.assign(client.pos, { x: 28.5, y: 10, z: 12.5 });
  client.grounded = true;
  const sState = createPilotState(), cState = client.pilot;
  let input = {};
  for (let i = 0; i < 2000; i++) {
    if (i % 5 === 0) {
      const a = rnd() * Math.PI * 2, moving = rnd() < 0.85;
      input = { jump: rnd() < 0.3, jumpPressed: rnd() < 0.15, crouch: rnd() < 0.2, sprint: rnd() < 0.7, stim: rnd() < 0.1,
        wishX: moving ? Math.sin(a) : 0, wishZ: moving ? Math.cos(a) : 0 };
    }
    const dt = [1 / 60, 1 / 120, 1 / 20][i % 3];
    stepPilot(sState, server, input, { solidAt: world }, dt);
    stepPilot(cState, view, input, { solidAt: world }, dt);
    for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'grounded', 'coyote']) {
      if (!Object.is(server[key], view[key])) assert.fail(`stepPilot parity tick ${i}: ${key} ${server[key]} != ${view[key]}`);
    }
    if (JSON.stringify(sState) !== JSON.stringify(cState)) assert.fail(`stepPilot state parity tick ${i}`);
    if (server.y < 0) { Object.assign(server, { x: 28.5, y: 10, z: 12.5, vx: 0, vy: 0, vz: 0 }); Object.assign(client.pos, { x: 28.5, y: 10, z: 12.5 }); client.vel.x = client.vel.y = client.vel.z = 0; }
  }
  checks++;
  console.log('stepPilot parity: 2000 random ticks bit-equal (server body vs client physics view)');
}

/* ---------------------------------------------------------------- integrator parity: stepMovement vs PlayerPhysics.step */
for (const hz of [60, 20, 120]) {
  let seed = 0xbeef + hz;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const h = pair({ x: 28.5, y: 10, z: 12.5 });
  let keys = {}, worst = 0, walls = 0, slides = 0, doubles = 0, wallRun = false, slideRun = false, episode = 0;
  for (let i = 0; i < 2000; i++) {
    if (i % 160 === 0) {
      // Every 160 ticks both bodies restart at the long wall: half the runs head along it (wallruns, wall-jumps).
      const at = { x: 27.3, y: 10, z: 10.5 + rnd() * 5 };
      Object.assign(h.server, at, { vx: 0, vy: 0, vz: 0, grounded: true, coyote: 0, vault: null });
      Object.assign(h.client.pos, at);
      Object.assign(h.client.vel, { x: 0, y: 0, z: 0 });
      Object.assign(h.client, { grounded: true, coyote: 0, vault: null });
      const kind = rnd();
      wallRun = kind < 0.4;
      slideRun = !wallRun && kind < 0.7;
      episode = i;
    }
    if (i % 7 === 0) {
      const along = Math.PI + 0.3 + rnd() * 0.5;   // heading +z, angled toward the +X wall
      keys = { forward: rnd() < 0.85, back: rnd() < 0.05, left: rnd() < 0.3, right: rnd() < 0.3, jump: rnd() < 0.4,
        crouch: rnd() < 0.25, sprint: rnd() < 0.7, yaw: wallRun ? along : rnd() * Math.PI * 2 };
      if (wallRun) keys.left = keys.right = false;
    }
    // Wall runs take off about a metre from the wall (the inputs are a function of the shared state).
    // Slide runs sprint down the lane, then crouch-slide and hop at random.
    if (slideRun) keys = { ...keys, forward: true, back: false, sprint: true, yaw: Math.PI + 0.05,
      crouch: i - episode > 40, jump: i - episode > 40 && keys.jump };
    // Off the ground they hold the run and press jump now and then (wall-jumps, double jumps).
    if (wallRun) keys = { ...keys, forward: true, back: false, sprint: true, crouch: false,
      jump: h.server.grounded ? h.server.x > 28.3 : (i % 23 === 0 && rnd() < 0.5) };
    h.step(1 / hz, keys);
    const s = h.server, c = h.client;
    worst = Math.max(worst, Math.hypot(s.x - c.pos.x, s.y - c.pos.y, s.z - c.pos.z));
    if (s.pilot.wall) walls++;
    if (s.pilot.slideT > 0) slides++;
    if (s.pilot.jumped === 3) doubles++;
    eq(s.grounded, c.grounded, `grounded parity at ${hz} Hz tick ${i}`);
  }
  // pilotPostCollide mirrors the client's sub-millimetre velocity snap, so pilot mode is bit-equal at every rate.
  eq(worst, 0, `pilot integrators bit-equal at ${hz} Hz`);
  ok(walls > 0 && slides > 0 && doubles > 0, `parity run covers wallruns, slides and double jumps at ${hz} Hz`);
  console.log(`integrator parity @${hz} Hz: 2000 random ticks bit-equal (${walls} wallrun, ${slides} slide, ${doubles} double-jump ticks)`);
}

/* ---------------------------------------------------------------- integrator parity with prone and stand-ups */
for (const hz of [60, 20, 120]) {
  // Random keys including prone: the sprint gate reads the stance after this step's prone update on both sides.
  let seed = 0x9a0e + hz;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const h = pair({ x: -3000.5, y: 10, z: 600.5 });
  let keys = {}, worst = 0, proneTicks = 0;
  for (let i = 0; i < 2000; i++) {
    if (i % 9 === 0) keys = { forward: rnd() < 0.8, back: rnd() < 0.05, left: rnd() < 0.25, right: rnd() < 0.25, jump: rnd() < 0.2,
      crouch: rnd() < 0.15, sprint: rnd() < 0.8, prone: rnd() < 0.3, yaw: rnd() * Math.PI * 2 };
    h.step(1 / hz, keys);
    if (h.server.proneT > 0) proneTicks++;
    worst = Math.max(worst, Math.hypot(h.server.x - h.client.pos.x, h.server.y - h.client.pos.y, h.server.z - h.client.pos.z));
  }
  ok(proneTicks > 100, `prone parity run goes prone (${proneTicks} ticks at ${hz} Hz)`);
  eq(worst, 0, `pilot integrators bit-equal through prone and stand-ups at ${hz} Hz`);
}

/* ---------------------------------------------------------------- tfs adoption never rewinds a run */
{
  const physics = new PlayerPhysics();
  physics.solid = world;
  physics.pilotRules = true;
  Object.assign(physics.pos, { x: 29.6, y: 20, z: 12.5 });
  Object.assign(physics.pilot, { wall: -1, wallPlane: 30, wallT: 0.9, wallSpeed: 9 });
  const old = decodeTitanfallSelf({ t: 'tfs', s: 9, d: encodeTitanfallSelf({ vx: 0, vy: -0.5, vz: 9, wallN: -1, wallT: 0.75,
    jumpsLeft: 1, slideT: 0, slideCd: 0, jumpSeqAck: 0 }) });
  physics.adoptPilot(old);
  eq(physics.pilot.wallT, 0.9, 'a stale frame on the same wall keeps the predicted run time');
  physics.pilot.wall = 0; physics.pilot.wallT = 0;
  physics.adoptPilot(old);
  ok(physics.pilot.wall === -1 && Math.abs(physics.pilot.wallT - 0.75) < 0.01, 'a wall the prediction missed is adopted with the frame time');
  physics.pilot.wall = 0; physics.pilot.slideT = 0.6;
  physics.adoptPilot(decodeTitanfallSelf({ t: 'tfs', s: 10, d: encodeTitanfallSelf({ vx: 9, vy: 0, vz: 0, slideT: 0.4, jumpSeqAck: 0 }) }));
  eq(physics.pilot.slideT, 0.6, 'a stale frame mid-slide keeps the predicted slide time');
}

for (const line of feel) console.log(`feel: ${line}`);
console.log(`titanfall pilot movement test passed (${checks} checks)`);
