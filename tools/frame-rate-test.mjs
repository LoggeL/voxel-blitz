import assert from 'node:assert/strict';
import { FrameRateController, FPS_MODES, FPS_PREF_KEY, fpsMode, setFpsMode, normalizeFpsMode } from '../public/js/engine/frame-rate.js';

let checks = 0;
function simulate(value, hz, cpu = 2) {
  const controller = new FrameRateController();
  const rendered = [];
  for (let i = 0; i <= hz * 10; i++) {
    const at = i * 1000 / hz;
    if (controller.begin(at, false, value)) rendered.push(at);
    controller.end(cpu, 1);
  }
  return { controller, rendered };
}

// Exercise every target on common and non-divisible callback cadences. Verify
// actual render counts, not the limiter's internal deadline calculation.
for (const { value, fps } of FPS_MODES) {
  for (const hz of [30, 59.94, 60, 75, 90, 120, 144, 165, 240, 360, 480]) {
    const { controller, rendered } = simulate(value, hz);
    const expected = Math.min(fps || hz, hz);
    assert.ok(Math.abs((rendered.length - 1) / 10 - expected) < 0.2, `${value} on ${hz} callbacks/s`);
    assert.ok(Math.abs(controller.snapshot.renderedFps - expected) < 1.1, 'telemetry counts rendered frames');
    assert.ok(Math.abs(controller.snapshot.callbackFps - hz) < 0.01, 'callback cadence is independent of cap');
    checks += 3;
  }
}

const capped = simulate('30', 144).controller;
assert.equal(capped.snapshot.limit.code, 'target');
assert.ok(capped.snapshot.skippedFrames > 0);
assert.equal(simulate('240', 60).controller.snapshot.limit.code, 'browser');
assert.equal(simulate('native', 60, 15).controller.snapshot.limit.code, 'work');
assert.equal(simulate('native', 480).controller.snapshot.renderedFps, 480, 'no artificial 360 FPS ceiling');
checks += 5;

const uneven = new FrameRateController();
let at = 0;
for (let i = 0; i < 300; i++) {
  at += i % 2 ? 30 : 8;
  uneven.begin(at, false, 'native'); uneven.end(2, 1);
}
assert.equal(uneven.snapshot.limit.code, 'unknown');
assert.ok(Math.abs(uneven.snapshot.renderedFps - 1000 / 19) < 1, 'use elapsed time rather than averaging instantaneous FPS');
checks += 2;

// Switching, backgrounding, and match teardown must discard old timing and
// deadlines. A delayed callback produces one render, without catch-up bursts.
capped.begin(10020, false, '120'); capped.end(1);
assert.equal(capped.snapshot.ready, false);
assert.equal(capped.snapshot.targetFps, 120);
assert.equal(capped.begin(10040, true, '120'), false);
assert.equal(capped.snapshot.limit.code, 'hidden');
assert.equal(capped.begin(25000, false, '120'), true);
assert.equal(capped.snapshot.ready, false);
assert.equal(capped.begin(25001, false, '120'), false);
capped.reset('60');
assert.equal(capped.begin(0, false, '60'), true);
assert.equal(capped.begin(800, false, '60'), true);
assert.equal(capped.begin(801, false, '60'), false);
assert.equal(capped.begin(20000, false, '60'), true);
assert.equal(capped.snapshot.ready, false);
checks += 12;

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
setFpsMode('144');
assert.equal(storage.get(FPS_PREF_KEY), '144');
assert.equal(fpsMode(), '144');
assert.equal((await import('../public/js/engine/frame-rate.js?reload')).fpsMode(), '144');
for (const bad of [null, undefined, '0', 'unlimited', '999', 60, '__proto__']) {
  assert.equal(normalizeFpsMode(bad), 'native');
}
globalThis.localStorage = { setItem() { throw new Error('storage unavailable'); } };
assert.doesNotThrow(() => setFpsMode('30'));
assert.equal(fpsMode(), '30');
delete globalThis.localStorage;
checks += 12;
console.log(`ok - ${checks} FPS pacing, telemetry, limit diagnosis, lifecycle and preference checks`);
