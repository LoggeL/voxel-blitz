import assert from 'node:assert/strict';
import { DEATH_HEAD, DeathHeadCam, deathFadeOpacity } from '../public/js/player/death-head-cam.js';
import { Killcam } from '../public/js/player/killcam.js';
import { KILLCAM } from '../shared/killcam-rules.js';

const FLOOR = 10;
const floor = (x, y) => y < FLOOR;
const run = (head, seconds, solid, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) head.step(dt, solid);
  return head;
};

// Thrown away from the killer, up first, then down onto the floor without sinking in.
const head = new DeathHeadCam().start({ x: 0, y: FLOOR + 1.6, z: 0, yaw: 0, pitch: 0,
  away: { x: 0, z: 1 }, side: 1, headshot: true });
run(head, 0.12, floor);
assert.ok(head.pos.y > FLOOR + 1.6, 'the head is launched upwards off the neck');
assert.ok(head.pos.z > 0.5, 'the head flies away from the killer');
assert.ok(head.pitch > 0.25, 'the neck whips the view backwards');
assert.ok(Math.abs(head.roll) > 0.6, 'the head barrel-rolls');
run(head, 2.5, floor);
assert.ok(head.grounded, 'the head comes to rest on the floor');
assert.ok(head.pos.y >= FLOOR + DEATH_HEAD.radius - 1e-9, 'the head never sinks into the floor');
assert.ok(Math.abs(Math.hypot(head.vel.x, head.vel.z)) < 0.2, 'the head stops rolling');
const rest = Math.atan2(Math.sin(head.roll), Math.cos(head.roll));
assert.ok(Math.abs(rest - DEATH_HEAD.restRoll) < 0.15, 'it settles on its cheek');
const toBody = Math.atan2(head.pos.x, head.pos.z);
assert.ok(Math.abs(Math.atan2(Math.sin(head.yaw - toBody), Math.cos(head.yaw - toBody))) < 0.1,
  'the resting head stares back at its body');

// Shot in the back: the head flies forwards, then turns round to face the body.
const turned = run(new DeathHeadCam().start({ x: 0, y: FLOOR + 1.6, z: 0, yaw: 0, away: { x: 0, z: -1 } }), 1.2, floor);
assert.ok(turned.pos.z < -1, 'shot from behind, the head flies forwards');
const back = Math.atan2(turned.pos.x, turned.pos.z);
assert.ok(Math.abs(Math.atan2(Math.sin(turned.yaw - back), Math.cos(turned.yaw - back))) < 0.1,
  'and whips round to look back at the body');

// A wall right behind the victim stops the throw at the wall face.
const wall = (x, y, z) => y < FLOOR || z >= 1;
const walled = run(new DeathHeadCam().start({ x: 0.5, y: FLOOR + 1.6, z: 0.5, away: { x: 0, z: 1 } }), 1.5, wall);
assert.ok(walled.pos.z <= 1 - DEATH_HEAD.radius + 1e-9, 'the head never passes through a wall');

// Without a killer position the head leaves backwards out of the view (yaw 0 looks at -z).
const fallback = run(new DeathHeadCam().start({ x: 0, y: FLOOR + 1.6, z: 0, yaw: 0 }), 0.2, floor);
assert.ok(fallback.pos.z > 0.3, 'suicides and world deaths still throw the head backwards');

// Reduced motion keeps the throw but drops most of the spin.
const calm = run(new DeathHeadCam().start({ x: 0, y: FLOOR + 1.6, z: 0, away: { x: 0, z: 1 }, motion: 0.15 }), 0.12, floor);
const wild = run(new DeathHeadCam().start({ x: 0, y: FLOOR + 1.6, z: 0, away: { x: 0, z: 1 }, motion: 1 }), 0.12, floor);
assert.ok(Math.abs(calm.roll) < Math.abs(wild.roll) * 0.3, 'reduced motion barely rolls');

// Long frames are sub-stepped: one 100 ms frame lands where six 16.7 ms frames do.
const coarse = new DeathHeadCam().start({ x: 0, y: FLOOR + 1.6, z: 0, away: { x: 1, z: 0 } }).step(0.1, floor);
const fine = run(new DeathHeadCam().start({ x: 0, y: FLOOR + 1.6, z: 0, away: { x: 1, z: 0 } }), 0.099, floor);
assert.ok(Math.hypot(coarse.pos.x - fine.pos.x, coarse.pos.y - fine.pos.y) < 0.02, 'frame rate does not change the flight');

// Fade: clear, black by the end of the intro, lifted again after the reveal.
assert.equal(deathFadeOpacity(0), 0);
assert.equal(deathFadeOpacity(DEATH_HEAD.fadeStartMs), 0);
assert.equal(deathFadeOpacity(DEATH_HEAD.introMs), 1, 'the intro ends on full black');
assert.equal(deathFadeOpacity(DEATH_HEAD.introMs + DEATH_HEAD.revealMs), 0);
assert.equal(deathFadeOpacity(NaN), 0);
let previous = 0;
for (let t = 0; t <= DEATH_HEAD.introMs; t += 10) {
  const value = deathFadeOpacity(t);
  assert.ok(value >= previous, 'the screen only darkens during the head flight');
  previous = value;
}

// The killcam waits for the intro and trims its lead-in so it ends before the respawn.
let now = 1000;
let activated = 0;
const clip = { start: 0, killTime: 3000, end: 3000 + KILLCAM.postKillMs };
const killcam = { history: { clip: () => clip }, stop() {}, now: () => now, _activate() { activated++; this.active = false; } };
assert.equal(Killcam.prototype.start.call(killcam, {}, 'tdm', { delayMs: DEATH_HEAD.introMs }), true);
assert.equal(activated, 0, 'the replay does not take the screen during the head flight');
assert.equal(Killcam.prototype.update.call(killcam, 1 / 60, 1, 80), false);
now += DEATH_HEAD.introMs - 1;
Killcam.prototype.update.call(killcam, 1 / 60, 1, 80);
assert.equal(activated, 0);
now += 1;
Killcam.prototype.update.call(killcam, 1 / 60, 1, 80);
assert.equal(activated, 1, 'the replay starts as the cut to black completes');
const replayMs = clip.end - killcam.replayStart;
assert.ok(DEATH_HEAD.introMs + replayMs + 300 < KILLCAM.respawnMs, 'the trimmed replay still finishes before the respawn');
assert.ok(killcam.replayStart < clip.killTime - 2000, 'at least two seconds of lead-in stay in the replay');
Killcam.prototype.start.call(killcam, {}, 'tdm');
assert.equal(killcam.replayStart, clip.start, 'an undelayed replay keeps its whole history');

console.log('Death head cam: throw away from the killer, whip, barrel roll, gaze on the body, voxel bounces, cheek rest, no wall clipping, reduced motion, sub-stepping, cut to black and delayed trimmed killcam passed.');
