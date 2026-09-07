import assert from 'node:assert/strict';
import { MinigunMotor } from '../public/js/audio/minigun-motor.js';
import { VoicePool } from '../public/js/audio/voices.js';

class Param {
  constructor() { this.value = 0; this.events = []; }
  setValueAtTime(value, at) { this.events.push(['set', value, at]); }
  linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]); }
  setTargetAtTime(value, at, decay) { this.events.push(['target', value, at, decay]); }
  cancelScheduledValues(at) { this.events = this.events.filter((event) => event[2] < at); }
}
class Node {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.connections = [];
    this.gain = new Param();
    this.frequency = new Param();
    this.Q = new Param();
    ctx.nodes.push(this);
  }
  connect(target) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; this.connections.length = 0; }
  start(at) { this.startedAt = at; }
  stop(at) {
    assert.ok(this.stoppedAt == null || this.ctx.currentTime < this.stoppedAt || at == null,
      'a stopped source must never be restarted by moving its deadline');
    this.stoppedAt = at;
  }
}
const ctx = {
  nodes: [], currentTime: 0, state: 'running',
  createGain() { return new Node(this, 'gain'); },
  createBufferSource() { return new Node(this, 'noise'); },
  createOscillator() { return new Node(this, 'oscillator'); },
  createBiquadFilter() { return new Node(this, 'filter'); },
};
const engine = { ctx, bus: {}, noiseBuffer: {}, _registerVoicePool() {} };
const pool = new VoicePool(engine);
const motor = new MinigunMotor(engine, pool);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
try {
  assert.equal(motor.refresh(0, 0), false, 'equipped idle weapon allocates no graph');
  assert.equal(ctx.nodes.length, 0);
  assert.equal(motor.refresh(0.2, 0.1), true);
  const voice = motor.voice;
  const initialPitch = voice.teeth.source.frequency.events.at(-1)[1];
  const count = ctx.nodes.length;
  const timer = pool._byOutput.get(voice.output).timer;
  assert.deepEqual(voice.output.connections, [engine.bus], 'motor uses shared master volume and limiter');
  assert.equal(voice.warning.target, 0, 'cool barrels have no warning tone');
  for (let i = 1; i <= 300; i++) {
    ctx.currentTime = i / 60;
    motor.refresh(0.2 + i / 375, i / 300);
  }
  assert.equal(ctx.nodes.length, count, 'five seconds of rotor/heat updates reuse all sources and nodes');
  assert.equal(pool._byOutput.get(voice.output).timer, timer, 'no cleanup timer per frame');
  assert.ok(voice.teeth.source.frequency.events.at(-1)[1] > initialPitch * 2, 'rotor pitch tracks speed');
  assert.ok(voice.warning.target > 0 && voice.warning.target <= 0.019, 'high heat has a restrained warning');
  for (const layer of voice.layers) {
    near(layer.source.stoppedAt, 5.18);
    if (layer !== voice.steam) assert.deepEqual(layer.gain.gain.events.at(-1), ['ramp', 0, 5.18],
      'missed refresh schedules exact silence on the audio clock');
  }

  ctx.currentTime = 5.01;
  motor.refresh(0.9, 1, true, true);
  const steamEnd = voice.steam.end;
  assert.ok(voice.steam.target > 0);
  assert.equal(voice.warning.target, 0, 'overheat replaces warning with cooling hiss');
  ctx.currentTime = 5.03;
  motor.refresh(0.8, 0.99, true, true);
  assert.equal(voice.steam.end, steamEnd, 'held overheat state does not restart steam');
  assert.equal(ctx.nodes.length, count, 'overheat reuses the same bounded graph');

  ctx.currentTime = 5.04;
  motor.refresh(0, 0.99, false, true);
  const stoppedAt = voice.end;
  near(stoppedAt, 5.1);
  ctx.currentTime = 5.05;
  motor.refresh(0, 0.99, false, true);
  assert.equal(voice.end, stoppedAt, 'repeated inactive frames cannot prolong a stop');
  for (const layer of voice.layers) assert.deepEqual(layer.gain.gain.events.at(-1), ['ramp', 0, stoppedAt]);
  ctx.currentTime = 5.06;
  motor.refresh(0.5, 0.4);
  assert.equal(motor.voice, voice, 'quick re-press reuses sources before their stop deadline');
  ctx.currentTime = 5.08;
  motor.refresh(0, 0, false);
  near(voice.end, 5.14);
  ctx.currentTime = 5.3;
  motor.refresh(0.4, 0.2);
  assert.notEqual(motor.voice, voice, 'expired sources are replaced on the next active refresh');
  assert.ok(voice.layers.every((layer) => layer.source.disconnected && layer.filter.disconnected && layer.gain.disconnected));

  ctx.state = 'suspended';
  assert.equal(motor.refresh(1, 1), false, 'suspended audio never queues stale motor feedback');
  ctx.state = 'running';
  ctx.currentTime = 5.31;
  motor.refresh(Infinity, -Infinity);
  assert.ok(Number.isFinite(motor.voice.teeth.source.frequency.events.at(-1)[1]));
  for (let i = 0; i < 50; i++) pool.acquire(null, 0.1);
  assert.equal(motor.voice, null, 'global voice pressure releases every motor source');
  motor.refresh(1, 1, true, true);
  assert.ok(motor.voice.steam.target > 0, 'new overheat edge remains audible after voice stealing');
  const finalVoice = motor.voice;
  motor.dispose();
  assert.equal(motor.voice, null);
  assert.ok(finalVoice.layers.every((layer) => layer.source.disconnected && layer.filter.disconnected && layer.gain.disconnected));
  assert.ok(ctx.nodes.filter((node) => ['noise', 'oscillator'].includes(node.kind)).every((node) => node.disconnected),
    'all sources disconnect on final disposal');
} finally {
  motor.dispose();
  pool.disposeAll();
}
console.log('Minigun audio: bounded rotor graph, RPM/heat feedback, one overheat hiss, frame expiry, release/re-press, suspension, voice stealing and disposal passed.');
