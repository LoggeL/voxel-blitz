import assert from 'node:assert/strict';
import { PainMoanCadence } from '../public/js/audio/pain-moans.js';

function seededRandom() {
  let state = 17;
  return () => ((state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 2 ** 32);
}

function simulate(pain, fps = 60) {
  const cadence = new PainMoanCadence(seededRandom());
  const cues = [];
  for (let frame = 0; frame <= fps * 60; frame++) {
    const now = frame * 1000 / fps;
    const cue = cadence.update(pain, now);
    if (cue) cues.push({ ...cue, at: now });
  }
  return cues;
}

assert.deepEqual(simulate(0), []);
assert.deepEqual(simulate(0.09), [], 'negligible pain is silent');
for (const level of [NaN, Infinity, -1, undefined]) assert.deepEqual(simulate(level), []);
const mild = simulate(0.2), severe = simulate(1);
assert.ok(mild.length >= 5 && severe.length > mild.length * 1.6,
  'severe pain moans substantially more often than mild pain');
assert.ok(severe[0].gain > mild[0].gain && severe[0].duration > mild[0].duration,
  'severe pain produces louder, longer moans');
assert.equal(new Set(severe.map(cue => cue.variant)).size, 3, 'all three vocal shapes occur');
assert.ok(severe.every((cue, i) => !i || cue.variant !== severe[i - 1].variant),
  'consecutive moans never repeat the same shape');
const gaps = severe.slice(1).map((cue, i) => cue.at - severe[i].at);
assert.ok(Math.max(...gaps) - Math.min(...gaps) > 300, 'timing has audible variation');
assert.ok(severe.every((cue, i) => !i || cue.at > severe[i - 1].at + severe[i - 1].duration * 1000 + 1900),
  'moans leave quiet space and cannot overlap');
for (const fps of [30, 144]) {
  const alternate = simulate(1, fps);
  assert.equal(alternate.length, severe.length, 'cadence is independent of frame rate');
  assert.deepEqual(alternate.map(cue => cue.variant), severe.map(cue => cue.variant));
}

const cadence = new PainMoanCadence(() => 0.5);
assert.equal(cadence.update(1, 0), null);
assert.equal(cadence.update(1, 649), null);
assert.ok(cadence.update(1, 650));
for (const options of [{ active: false }, { holding: true }]) {
  assert.equal(cadence.update(1, 700, options), null);
  assert.equal(cadence.update(1, 750), null, 'resuming starts with a quiet lead-in');
  assert.ok(cadence.update(1, 1400));
}
assert.equal(cadence.update(0, 1450), null);
assert.equal(cadence.update(1, 1500), null, 'new injury starts a fresh cadence');
assert.ok(cadence.update(1, 2150));
assert.equal(cadence.update(1, 100000), null, 'stalled frames never trigger a catch-up moan');
assert.equal(cadence.update(1, 100649), null);
assert.ok(cadence.update(1, 100650));
assert.equal(cadence.update(1, 0), null, 'a new session clock resets scheduling');
cadence.reset();
assert.equal(cadence.update(1, 900), null);
console.log(`Pain moans: variation, spacing, recovery, lifecycle and frame cadence passed (${mild.length} mild / ${severe.length} severe per minute).`);
