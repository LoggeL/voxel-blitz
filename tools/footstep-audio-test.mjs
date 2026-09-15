import assert from 'node:assert/strict';
import { FootstepCadence, footstepVolume, gaitPhaseRate, strideCrossed, STEP_SPEED_MIN, SPRINT_SPEED } from '../public/js/audio/footsteps.js';
import { sfx } from '../public/js/audio/sfx.js';

// Loudness grading mirrors what bots can hear.
assert.equal(footstepVolume({ speed: 2.2 }), 0, 'crouch-speed creeping is silent');
assert.equal(footstepVolume({ speed: 4.4, crouch: true }), 0, 'crouching is silent at any speed');
assert.equal(footstepVolume({ speed: 6.2, grounded: false }), 0, 'airborne bodies do not step');
assert.equal(footstepVolume({ speed: 6.2, swimming: true }), 0, 'swimmers do not step');
const walk = footstepVolume({ speed: 4.4 });
const sprint = footstepVolume({ speed: SPRINT_SPEED });
assert.ok(walk > 0.4 && walk < sprint && sprint === 1, `walking is audible, sprinting is loudest (${walk}, ${sprint})`);
assert.ok(footstepVolume({ speed: STEP_SPEED_MIN }) > 0, 'the threshold speed itself is audible');

// One footfall per half gait cycle, in step with the leg animation.
assert.ok(strideCrossed(Math.PI / 2 - 0.01, Math.PI / 2 + 0.01), 'a footfall lands at the forward leg extreme');
assert.ok(!strideCrossed(0.1, 1.2), 'no footfall between extremes');
{
  const cadence = new FootstepCadence();
  let steps = 0;
  const dt = 1 / 120;
  for (let i = 0; i < 120; i++) if (cadence.update(dt, { speed: SPRINT_SPEED, grounded: true }) > 0) steps++;
  const expected = gaitPhaseRate(SPRINT_SPEED) / Math.PI;
  assert.ok(Math.abs(steps - expected) <= 1, `sprinting yields about ${expected.toFixed(1)} steps per second (${steps})`);
  let quiet = 0;
  for (let i = 0; i < 120; i++) quiet += cadence.update(dt, { speed: SPRINT_SPEED, grounded: true, crouch: true });
  assert.equal(quiet, 0, 'crouch-sprinting keeps the phase moving but stays silent');
  assert.equal(cadence.update(0, { speed: SPRINT_SPEED }), 0, 'a zero-length frame never steps');
  const slow = new FootstepCadence();
  let walkSteps = 0;
  for (let i = 0; i < 120; i++) if (slow.update(dt, { speed: 4.4, grounded: true }) > 0) walkSteps++;
  assert.ok(walkSteps < steps, 'walking steps less often than sprinting');
}

// Remote footfalls route through world attenuation and direction; own steps do not.
class Param {
  constructor() { this.value = 0; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
  setTargetAtTime() {}
  cancelScheduledValues() {}
}
class AudioNode {
  constructor(ctx, kind) {
    this.kind = kind;
    this.connections = [];
    for (const key of ['gain', 'frequency', 'Q', 'playbackRate', 'detune', 'threshold', 'knee', 'ratio',
      'attack', 'release', 'delayTime', 'positionX', 'positionY', 'positionZ', 'pan']) this[key] = new Param();
    ctx.nodes.push(this);
  }
  connect(target) { this.connections.push(target); return target; }
  disconnect() {}
  start() {}
  stop() {}
}
let ctx;
class AudioContext {
  constructor() {
    ctx = this;
    this.nodes = [];
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = {};
  }
  createGain() { return new AudioNode(this, 'gain'); }
  createBufferSource() { return new AudioNode(this, 'source'); }
  createBiquadFilter() { return new AudioNode(this, 'filter'); }
  createDynamicsCompressor() { return new AudioNode(this, 'compressor'); }
  createDelay() { return new AudioNode(this, 'delay'); }
  createPanner() { return new AudioNode(this, 'panner'); }
  createStereoPanner() { return new AudioNode(this, 'stereo'); }
  createOscillator() { return new AudioNode(this, 'oscillator'); }
  createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  async decodeAudioData() { throw new Error('no samples in this test'); }
  async close() { this.state = 'closed'; }
}
const originalWindow = globalThis.window;
globalThis.window = { AudioContext };
try {
  await sfx.init();
  const before = ctx.nodes.length;
  sfx.footstep(0.8, { pos: [12, 3, -4] });
  const fresh = ctx.nodes.slice(before);
  const panner = fresh.find((node) => node.kind === 'panner');
  assert.ok(panner, 'a remote footfall is placed in the world');
  assert.deepEqual([panner.positionX.value, panner.positionY.value, panner.positionZ.value], [12, 3, -4]);
  assert.ok(fresh.some((node) => node.kind === 'source' || node.kind === 'oscillator'), 'the procedural footfall is audible without a sample');
  const ownBefore = ctx.nodes.length;
  sfx.footstep(0.3);
  assert.ok(!ctx.nodes.slice(ownBefore).some((node) => node.kind === 'panner'), 'own footfalls are not positional');
} finally {
  await sfx.dispose();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
console.log('ok: footstep cadence grades speed and stance, follows the gait phase, remote steps are positional');
