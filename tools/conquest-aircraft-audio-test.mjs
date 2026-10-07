import assert from 'node:assert/strict';
import { VehicleAudio } from '../public/js/vehicles/vehicle-audio.js';
import { installGlobals } from './lib/install-globals.mjs';

// Run the public facade and its actual pooled graph without an audio device.
// The master is also muted, matching the requested browser test setting.
class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, at) { this.events.push(['set', value, at]); }
  linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]); }
  setTargetAtTime(value, at, tau) { this.events.push(['target', value, at, tau]); }
  exponentialRampToValueAtTime(value, at) { this.events.push(['exponential', value, at]); }
  cancelScheduledValues(at) { this.events = this.events.filter(event => event[2] < at); }
}
class Node {
  constructor(ctx, kind) {
    this.ctx = ctx; this.kind = kind; this.connections = []; this.starts = [];
    for (const key of ['gain', 'frequency', 'Q', 'detune', 'delayTime', 'playbackRate',
      'positionX', 'positionY', 'positionZ', 'threshold', 'knee', 'ratio', 'attack', 'release']) {
      this[key] = new Param(key === 'gain' || key === 'playbackRate' ? 1 : 0);
    }
    ctx.nodes.push(this);
  }
  connect(target) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; this.connections.length = 0; }
  start(at = 0) {
    assert.equal(this.starts.length, 0, 'each source is started once');
    this.starts.push(at);
  }
  stop(at) {
    assert.ok(at == null || this.stoppedAt == null || this.ctx.currentTime < this.stoppedAt,
      'an expired source cannot have its stop deadline extended');
    this.stoppedAt = at ?? this.ctx.currentTime;
  }
}
class RecordingAudioContext {
  static instances = [];
  constructor() {
    this.nodes = []; this.currentTime = 0; this.state = 'running'; this.sampleRate = 128;
    this.destination = new Node(this, 'destination');
    this.listener = {};
    for (const key of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY',
      'forwardZ', 'upX', 'upY', 'upZ']) this.listener[key] = new Param();
    RecordingAudioContext.instances.push(this);
  }
  createGain() { return new Node(this, 'gain'); }
  createOscillator() { return new Node(this, 'oscillator'); }
  createBufferSource() { return new Node(this, 'noise'); }
  createBiquadFilter() { return new Node(this, 'filter'); }
  createPanner() { return new Node(this, 'panner'); }
  createDynamicsCompressor() { return new Node(this, 'compressor'); }
  createDelay() { return new Node(this, 'delay'); }
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: index => data[index] };
  }
  addEventListener() {}
  removeEventListener() {}
  async close() { this.state = 'closed'; }
}
const restore = installGlobals({ window: { AudioContext: RecordingAudioContext } });
const { sfx } = await import('../public/js/audio/sfx.js');
const audio = new VehicleAudio(sfx);
const row = (id, type, extra = {}) => ({ id, type, hp: 100, x: 12, y: 10, z: 18,
  occupantId: 'pilot', speed: 0, rotorSpeed: 0, enginePower: 0, ...extra });
const helicopter = row('rotor', 'helicopter', { rotorSpeed: 0.25 });
const plane = row('jet', 'plane', { enginePower: 0.2, speed: 10 });
const target = param => param.events.findLast(event => event[0] === 'target')?.[1];
const level = graph => graph.gain.gain.events.findLast(event => event[0] === 'set')?.[1];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
let ctx;
const graph = refresh => {
  const from = ctx.nodes.length;
  refresh();
  const nodes = ctx.nodes.slice(from);
  const panner = nodes.find(node => node.kind === 'panner');
  const output = nodes.find(node => node.kind === 'gain' && node.connections.includes(panner));
  return { nodes, panner, output,
    gain: nodes.find(node => node.kind === 'gain' && node.connections.includes(output)),
    sources: nodes.filter(node => ['noise', 'oscillator'].includes(node.kind)) };
};
try {
  sfx.setMasterVolume(0);
  sfx.vehicleLoop('idle', [0, 0, 0], 'helicopter', { rotorSpeed: 0, occupied: true });
  ctx = RecordingAudioContext.instances[0];
  assert.equal(ctx.nodes.filter(node => ['noise', 'oscillator'].includes(node.kind)).length, 0,
    'occupied aircraft with an idle engine starts no sources');
  const master = ctx.nodes.find(node => node.kind === 'gain');
  assert.equal(master.gain.value, 0, 'the shared master is muted throughout the test');
  const limiter = master.connections[0];
  assert.equal(limiter.kind, 'compressor');
  assert.deepEqual(limiter.connections, [ctx.destination]);
  sfx.setListener({ pos: [0, 2, 0], fwd: [0, 0, -1] });
  assert.equal(ctx.listener.positionY.value, 2, 'aircraft use the existing world listener');

  const heli = graph(() => audio.update([helicopter], [0, 2, 0]));
  assert.equal(heli.sources.filter(source => source.kind === 'noise').length, 2,
    'helicopter uses broadband rotor body and air wash');
  assert.ok(heli.sources.every(source => source.type !== 'square' && source.type !== 'sawtooth'));
  const pulse = heli.sources.find(source => source.type === 'triangle');
  assert.equal(pulse.connections[0].connections[0] instanceof Param, true,
    'rotor blade-pass modulation connects to an amplitude parameter');
  const body = heli.sources.find(source => source.kind === 'noise').connections[0];
  const heliWash = heli.sources.filter(source => source.kind === 'noise')[1].connections[0];
  const originalPulse = target(pulse.frequency), originalBody = target(body.frequency);
  const originalHeliLevel = level(heli);
  const jet = graph(() => audio.update([helicopter, plane], [0, 2, 0]));
  assert.equal(jet.sources.filter(source => source.kind === 'noise').length, 2,
    'jet uses broadband thrust and exhaust');
  assert.ok(jet.sources.every(source => source.type !== 'square' && source.type !== 'sawtooth'));
  const turbine = jet.sources.find(source => source.type === 'sine');
  const originalTurbine = target(turbine.frequency), originalJetLevel = level(jet);
  for (const sound of [heli, jet]) {
    assert.equal(sound.panner.distanceModel, 'inverse');
    assert.equal(sound.panner.rolloffFactor, 1.05, 'aircraft share the existing distance rolloff');
    assert.deepEqual(sound.panner.connections, [master], 'positional sound passes through the shared master');
    assert.ok(sound.sources.every(source => source.starts.length === 1));
    assert.ok(level(sound) > 0 && level(sound) <= 0.16, 'aircraft loop level stays bounded');
  }
  const nodeCount = ctx.nodes.length;
  for (let frame = 1; frame <= 180; frame++) {
    ctx.currentTime = frame / 60;
    audio.update([{ ...helicopter, rotorSpeed: 0.25 + frame / 240, speed: frame / 6, x: 12 + frame / 10 },
      { ...plane, enginePower: 0.2 + frame / 225, speed: 10 + frame / 2, z: 18 + frame / 3 }], [0, 2, 0]);
  }
  assert.equal(ctx.nodes.length, nodeCount, 'three seconds of flight refreshes reuse both complete graphs');
  assert.ok(target(pulse.frequency) > originalPulse * 2, 'blade-pass rate follows authoritative rotor speed');
  assert.ok(target(body.frequency) > originalBody, 'rotor wash brightens as the rotor spools');
  assert.ok(target(turbine.frequency) > originalTurbine, 'turbine frequency follows authoritative engine power');
  assert.ok(level(heli) > originalHeliLevel && level(jet) > originalJetLevel,
    'rotor and thrust levels follow the live snapshot values');
  assert.equal(target(heli.panner.positionX), 30);
  assert.equal(target(jet.panner.positionZ), 78, 'both panners follow moving aircraft');
  for (const sound of [heli, jet]) for (const source of sound.sources) near(source.stoppedAt, 3.95);
  assert.deepEqual(heli.gain.gain.events.at(-1), ['ramp', 0, 3.9],
    'a missing frame schedules exact silence on the audio clock');

  // Speed changes timbre while the rotor and engine power remain constant.
  ctx.currentTime = 3.005;
  audio.update([{ ...helicopter, rotorSpeed: 1 }, { ...plane, enginePower: 1, speed: 0 }], [0, 2, 0]);
  ctx.currentTime = 3.01;
  const beforeWash = target(heliWash.frequency), beforeTurbine = target(turbine.frequency);
  audio.update([{ ...helicopter, rotorSpeed: 1, speed: 34 },
    { ...plane, enginePower: 1, speed: 130 }], [0, 2, 0]);
  assert.ok(target(heliWash.frequency) > beforeWash);
  assert.ok(target(turbine.frequency) > beforeTurbine);

  ctx.currentTime = 3.02;
  audio.update([{ ...helicopter, rotorSpeed: 0.1, occupantId: null, engineOn: false },
    { ...plane, enginePower: 1, occupantId: null, speed: 100 }], [0, 2, 0]);
  assert.ok(audio.active.has('conquest:rotor'), 'an unoccupied rotor remains audible during authoritative spin-down');
  assert.ok(!audio.active.has('conquest:jet'), 'an unoccupied jet never keeps its engine loop');
  assert.ok(level(heli) < originalHeliLevel, 'spin-down reduces rotor level');
  for (const source of jet.sources) near(source.stoppedAt, 3.37);
  ctx.currentTime = 3.03;
  audio.update([{ ...helicopter, rotorSpeed: 0, speed: 20 }], [0, 2, 0]);
  assert.equal(audio.active.size, 0, 'coasting with a stopped rotor creates no aircraft engine sound');
  for (const source of heli.sources) near(source.stoppedAt, 3.38);

  const baselineStarts = ctx.nodes.filter(node => ['noise', 'oscillator'].includes(node.kind)).length;
  audio.update([row('off', 'plane', { enginePower: 1, speed: 50, engineOn: false }),
    row('unoccupied', 'plane', { enginePower: 1, occupantId: null }),
    row('stopped', 'plane'), row('dead', 'helicopter', { hp: 0, rotorSpeed: 1, wreckAge: 30 }),
    row('far', 'helicopter', { x: 171, y: 2, z: 0, rotorSpeed: 1 })], [0, 2, 0]);
  assert.equal(ctx.nodes.filter(node => ['noise', 'oscillator'].includes(node.kind)).length, baselineStarts,
    'off, unoccupied, stopped, wrecked and out-of-range aircraft allocate no sources');

  // Ground engines and the options-free Bastion facade retain their behavior.
  const jeep = graph(() => audio.update([row('jeep', 'jeep', { speed: -12 })], [0, 2, 0]));
  near(target(jeep.sources[0].frequency), 230);
  const tank = graph(() => audio.update([row('jeep', 'jeep', { speed: -12 }),
    row('tank', 'tank', { speed: 0, leftTrackSpeed: -2, rightTrackSpeed: 2 })], [0, 2, 0]));
  near(target(tank.sources[0].frequency), 48);
  near(target(tank.sources[1].frequency), 29.6);
  const apc = graph(() => sfx.vehicleLoop('bastion:apc', [5, 2, 4], 'apc'));
  near(target(apc.sources[0].frequency), 90);
  near(level(apc), 0.16);

  ctx.currentTime = 3.04;
  const selected = Array.from({ length: 9 }, (_, i) => row(`air${i}`, i % 2 ? 'plane' : 'helicopter',
    { x: i + 1, y: 2, z: 0, rotorSpeed: 1, enginePower: 1 }));
  audio.update(selected, [0, 2, 0]);
  assert.deepEqual([...audio.active], ['conquest:air0', 'conquest:air1', 'conquest:air2', 'conquest:air3'],
    'aircraft and ground vehicles share four nearest Conquest slots');
  const activeSources = () => ctx.nodes.filter(node => ['noise', 'oscillator'].includes(node.kind)
    && !node.disconnected && node.stoppedAt > ctx.currentTime + 0.8);
  assert.equal(activeSources().length, 16, 'four aircraft plus one Bastion drone fit the shared six-loop budget');
  ctx.currentTime = 3.05;
  sfx.vehicleLoop('bastion:buggy', [4, 2, 4], 'buggy');
  assert.equal(activeSources().length, 18);
  ctx.currentTime = 3.06;
  sfx.vehicleLoop('bastion:replacement', [4, 2, 4], 'buggy');
  assert.equal(activeSources().length, 18, 'a seventh loop retires the oldest loop');

  ctx.currentTime = 3.07;
  audio.update(selected.slice(0, 4).map(vehicle => ({ ...vehicle, hp: 0, wreckAge: 30 })), [0, 2, 0]);
  assert.equal(audio.active.size, 0, 'wreck snapshots stop every aircraft loop');
  assert.equal(activeSources().length, 4, 'wrecks leave only the two active Bastion loops');
  ctx.currentTime = 3.08;
  const departing = graph(() => audio.update([helicopter, plane], [0, 2, 0]));
  audio.update([], null);
  assert.equal(audio.active.size, 0, 'snapshot removal and invalid listener silence both air types');
  for (const source of departing.sources) near(source.stoppedAt, 3.43);
  ctx.currentTime = 3.09;
  const disconnected = graph(() => audio.update([helicopter, plane], [0, 2, 0]));
  audio.dispose(); audio.dispose();
  assert.equal(audio.active.size, 0, 'disconnect disposal is idempotent');
  for (const source of disconnected.sources) near(source.stoppedAt, 3.44);

  // A missed frame expires sources instead of reusing their old deadlines.
  ctx.currentTime = 5;
  const renewed = graph(() => audio.update([helicopter], [0, 2, 0]));
  ctx.currentTime = 6.1;
  const replacement = graph(() => audio.update([helicopter], [0, 2, 0]));
  assert.notEqual(replacement.sources[0], renewed.sources[0]);
  ctx.state = 'suspended';
  const suspendedCount = ctx.nodes.length;
  for (let frame = 0; frame < 60; frame++) audio.update([helicopter, plane], [0, 2, 0]);
  assert.equal(ctx.nodes.length, suspendedCount, 'suspension queues no per-frame aircraft audio');
  ctx.state = 'running';
  await sfx.dispose();
  // One-shot cues (a hatch closing as the pilot left) have already ended on the audio clock.
  assert.ok(ctx.nodes.filter(node => ['noise', 'oscillator'].includes(node.kind))
    .every(node => node.disconnected || node.stoppedAt <= ctx.currentTime),
  'facade disposal disconnects every still-playing aircraft, ground and Bastion source');
  assert.equal(ctx.state, 'closed');
  assert.equal(RecordingAudioContext.instances.length, 1, 'all engines use one AudioContext');
} finally {
  audio.dispose();
  await sfx.dispose();
  restore();
}
console.log('Aircraft audio: muted facade graphs, authoritative rotor/thrust/speed, spatial rolloff, idle gating, '
  + 'bounded voices, expiry, wreck/removal/disconnect cleanup and ground/Bastion regressions passed.');
