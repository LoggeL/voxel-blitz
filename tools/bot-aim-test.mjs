import assert from 'node:assert/strict';
import { AimSteering, gaussish } from '../server/bot-aim.js';
import { mulberry32 } from '../shared/noise.js';

const DT = 1 / 60;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// Ease-in, cruise, ease-out: speed never jumps, and the turn still covers
// the old constant-rate distance early enough for reaction timing.
{
  const aim = new AimSteering();
  const maxSpeed = 3;
  let yaw = -1;
  const speeds = [];
  let after50ms = null;
  for (let tick = 1; tick <= 120; tick++) {
    yaw = aim.steer('yaw', yaw, -Math.PI / 2, maxSpeed, DT);
    speeds.push(Math.abs(aim.yaw.v));
    if (tick === 3) after50ms = yaw;
  }
  assert.ok(after50ms < -1.1, `turns at least 0.1 rad in the first 50 ms (${after50ms})`);
  assert.ok(Math.max(...speeds) <= maxSpeed + 1e-9, 'never exceeds the turn-rate ceiling');
  for (let i = 1; i < speeds.length; i++) {
    assert.ok(Math.abs(speeds[i] - speeds[i - 1]) <= (maxSpeed / 0.035) * DT + 1e-9,
      'angular speed changes are bounded by the acceleration cap');
  }
  assert.ok(speeds[0] < maxSpeed, 'first tick starts below cruise speed (ease-in)');
  assert.ok(speeds.slice(3, 6).every(v => Math.abs(v - maxSpeed) < 1e-9), 'cruises at the cap far from the target');
  const settleTick = speeds.findIndex((v, i) => i > 6 && v < maxSpeed * 0.5);
  assert.ok(settleTick > 0, 'slows down before arriving (ease-out)');
  assert.ok(Math.abs(wrap(yaw + Math.PI / 2)) < 0.005, `settles on the target (${yaw})`);
  assert.ok(Math.abs(aim.yaw.v) < 0.05, 'comes to rest on the target');
}

// A moving target is tracked without lagging further than a few frames.
{
  const aim = new AimSteering();
  let yaw = 0, target = 0;
  let worstLag = 0;
  for (let tick = 0; tick < 240; tick++) {
    target += 0.6 * DT; // 0.6 rad/s sweep, a strafing enemy at mid range
    yaw = aim.steer('yaw', yaw, target, 3, DT);
    if (tick > 30) worstLag = Math.max(worstLag, Math.abs(wrap(target - yaw)));
  }
  assert.ok(worstLag < 0.06, `steady tracking lag stays small (${worstLag})`);
}

// Pitch is not wrapped and respects the same easing.
{
  const aim = new AimSteering();
  let pitch = 0;
  for (let tick = 0; tick < 120; tick++) pitch = aim.steer('pitch', pitch, 1.2, 4, DT);
  assert.ok(Math.abs(pitch - 1.2) < 0.005, 'pitch converges');
}

// An external snap (respawn/takeover) drops stale momentum instead of carrying it.
{
  const aim = new AimSteering();
  let yaw = 0;
  for (let tick = 0; tick < 10; tick++) yaw = aim.steer('yaw', yaw, 2, 3, DT);
  assert.ok(Math.abs(aim.yaw.v) > 1, 'has momentum mid-turn');
  const next = aim.steer('yaw', yaw + 1.5, yaw + 1.5, 3, DT);
  assert.ok(Math.abs(next - (yaw + 1.5)) < 1e-9 && Math.abs(aim.yaw.v) < 1e-9, 'snap resets velocity');
  aim.reset();
  assert.equal(aim.yaw.last, null);
}

// Wander is time-correlated (no tick jitter) but keeps the old stationary
// spread of one gaussish draw, so hit rates do not shift.
{
  const rng = mulberry32(0xB07A1);
  const aim = new AimSteering();
  const samples = [];
  for (let tick = 0; tick < 60_000; tick++) samples.push(aim.wander(DT, 1, 0.6, rng));
  const yaw = samples.map(s => s.yaw);
  const mean = yaw.reduce((a, b) => a + b, 0) / yaw.length;
  const sd = Math.sqrt(yaw.reduce((a, b) => a + (b - mean) ** 2, 0) / yaw.length);
  const refRng = mulberry32(0xB07A1);
  const ref = Array.from({ length: 60_000 }, () => gaussish(refRng));
  const refSd = Math.sqrt(ref.reduce((a, b) => a + b * b, 0) / ref.length);
  assert.ok(Math.abs(sd - refSd) / refSd < 0.08, `stationary spread matches white noise (${sd} vs ${refSd})`);
  let lag1 = 0;
  for (let i = 1; i < yaw.length; i++) lag1 += (yaw[i] - mean) * (yaw[i - 1] - mean);
  lag1 /= (yaw.length - 1) * sd * sd;
  assert.ok(lag1 > 0.85, `consecutive ticks are strongly correlated (${lag1})`);
  const pitchSd = Math.sqrt(samples.reduce((a, s) => a + s.pitch ** 2, 0) / samples.length);
  assert.ok(Math.abs(pitchSd - refSd * 0.6) / (refSd * 0.6) < 0.08, 'pitch wander follows its scale');
  // Old per-tick jitter: two independent draws, so its step spread was sqrt(2) * sd.
  const steps = yaw.slice(1).map((v, i) => v - yaw[i]);
  const stepRms = Math.sqrt(steps.reduce((a, b) => a + b * b, 0) / steps.length);
  assert.ok(stepRms < Math.SQRT2 * refSd * 0.3, `per-tick movement is a fraction of the old jitter (${stepRms})`);
  const maxStep = Math.max(...steps.map(Math.abs));
  assert.ok(maxStep < refSd * 2, `no single-tick jump exceeds the old typical jitter (${maxStep})`);
  assert.deepEqual(aim.wander(0, 1, 0.6, rng), aim.wander(0, 1, 0.6, rng), 'zero dt leaves the wander unchanged');
}

console.log('ok: bot aim steering eases in/out, tracks, resets on snaps and wanders smoothly');

// Simulated view kick: a shot lifts the view at once; skill decides how fast
// the shooter pulls it back down.
{
  const slow = new AimSteering();
  const fast = new AimSteering();
  slow.kick(0.3, 0.7);
  fast.kick(0.3, 0.7);
  const kicked = slow.recoil(0, 0.2);
  assert.ok(Math.abs(kicked.pitch - 0.7 * Math.PI / 180) < 1e-12, 'kick is applied in radians');
  assert.equal(kicked.prev.pitch, kicked.pitch, 'zero dt neither adds nor removes kick');
  let slowResidual = 0, fastResidual = 0;
  for (let tick = 0; tick < 12; tick++) {           // 200 ms
    slowResidual = slow.recoil(DT, 0.2).pitch;
    fastResidual = fast.recoil(DT, 1).pitch;
  }
  assert.ok(fastResidual < slowResidual * 0.2, `skilled shooters recover much faster (${fastResidual} vs ${slowResidual})`);
  assert.ok(slowResidual > 0.4 * 0.7 * Math.PI / 180, 'a novice still carries most of the kick after 200 ms');
  const before = slow.recoil(DT, 0.2);
  assert.ok(before.prev.pitch > before.pitch, 'the residual before the tick exceeds the one after');
  slow.dropKick();
  assert.equal(slow.recoil(DT, 0.2).pitch, 0, 'dropKick clears the residual');
  fast.kick(0, 1);
  fast.reset();
  assert.equal(fast.kickPitch, 0, 'reset clears the residual too');
}

console.log('ok: bot view kick is applied and recovered by skill');
