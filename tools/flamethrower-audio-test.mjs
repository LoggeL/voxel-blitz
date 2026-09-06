import assert from 'node:assert/strict';
import { FlameLoops } from '../public/js/audio/flame-loop.js';
import { VoicePool } from '../public/js/audio/voices.js';

class Param {
  constructor() { this.events = []; }
  setValueAtTime(value, at) { this.events.push(['set', value, at]); }
  linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]); }
  setTargetAtTime(value, at, decay) { this.events.push(['target', value, at, decay]); }
  cancelScheduledValues(at) { this.events = this.events.filter((event) => event[2] < at); }
}
class Node {
  constructor(ctx, kind) {
    this.kind = kind;
    this.gain = new Param();
    this.frequency = new Param();
    this.Q = new Param();
    this.positionX = new Param();
    this.positionY = new Param();
    this.positionZ = new Param();
    ctx.nodes.push(this);
  }
  connect(target) { return target; }
  disconnect() { this.disconnected = true; }
  start(at) { this.startedAt = at; }
  stop(at) { this.stoppedAt = at; }
}
const ctx = {
  nodes: [], currentTime: 0, state: 'running',
  createGain() { return new Node(this, 'gain'); },
  createBufferSource() { return new Node(this, 'source'); },
  createBiquadFilter() { return new Node(this, 'filter'); },
  createPanner() { return new Node(this, 'panner'); },
};
const engine = { ctx, bus: {}, noiseBuffer: {}, _registerVoicePool() {} };
const pool = new VoicePool(engine);
const loops = new FlameLoops(engine, pool);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
try {
  loops.refresh();
  const local = loops.voices.get('local');
  const originalNodeCount = ctx.nodes.length;
  const originalTimer = pool._byOutput.get(local.output).timer;
  for (let i = 1; i <= 100; i++) {
    ctx.currentTime = i * 0.05;
    loops.refresh();
  }
  assert.equal(ctx.nodes.length, originalNodeCount, 'five seconds held fire reuses one graph');
  assert.equal(pool._byOutput.get(local.output).timer, originalTimer, 'no timer allocated per refresh');
  assert.equal(ctx.nodes.filter((node) => node.kind === 'source').length, 1);
  near(local.source.stoppedAt, 5.14);
  near(loops._levelAt(local, 5.07), 0.75);
  near(loops._levelAt(local, 5.12), 0.375);
  near(loops._levelAt(local, 5.14), 0);
  assert.deepEqual(local.gain.gain.events.at(-1), ['ramp', 0, local.end],
    'missing refresh has an audio-clock fade to exact silence');

  ctx.currentTime = 5.01;
  loops.stop();
  near(local.end, 5.05);
  near(loops._levelAt(local, 5.03), 0.375);
  ctx.currentTime = 5.02;
  loops.refresh();
  assert.equal(loops.voices.get('local'), local, 'release then quick re-press does not restart noise');
  near(local.from, 0.5625);
  ctx.currentTime = 5.3;
  loops.refresh();
  assert.notEqual(loops.voices.get('local'), local, 'restart after stopped source creates a fresh source');
  assert.ok(local.source.disconnected);

  loops.refresh({ shooterId: 'p1', pos: [1, 2, 3] });
  const remote = loops.voices.get('p1');
  const panner = pool._byOutput.get(remote.output).panner;
  loops.refresh({ shooterId: 'p1', pos: [2, 3, 4] });
  assert.equal(loops.voices.get('p1'), remote);
  assert.deepEqual(panner.positionX.events.at(-1), ['target', 2, 5.3, 0.025]);
  loops.refresh({ shooterId: 'p2', pos: [2, 3, 4] });
  assert.notEqual(loops.voices.get('p2'), remote, 'nearby shooters keep distinct loops');
  for (let i = 3; i < 30; i++) loops.refresh({ shooterId: `p${i}`, pos: [i, 0, 0] });
  assert.equal(loops.voices.size, 8, 'flame graph count is bounded');
  assert.ok(loops.voices.has('local'), 'remote saturation preserves local feedback');
  for (let i = 0; i < 50; i++) pool.acquire(null, 0.1);
  assert.equal(loops.voices.size, 0, 'global pool pressure cleans up flame sources');
  ctx.state = 'suspended';
  assert.equal(loops.refresh(), false, 'suspended audio never queues stale flames');
  ctx.state = 'running';
  loops.refresh();
  loops.dispose();
  assert.equal(loops.voices.size, 0);
  assert.ok(ctx.nodes.filter((node) => node.kind === 'source').every((node) => node.disconnected));
} finally {
  loops.dispose();
  pool.disposeAll();
}
console.log('Flamethrower audio: continuity, stop envelope, positional identity, caps and disposal passed.');
