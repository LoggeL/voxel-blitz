import assert from 'node:assert/strict';
import { BUILTIN_SAMPLE_MANIFEST } from '../public/js/audio/samples.js';
import { MINIGUN_REPORT } from '../public/js/audio/minigun-motor.js';
import { fireSampleProfile } from '../public/js/audio/reports.js';
import { sfx } from '../public/js/audio/sfx.js';

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
    for (const key of ['gain', 'frequency', 'Q', 'playbackRate', 'detune',
      'threshold', 'knee', 'ratio', 'attack', 'release', 'delayTime',
      'positionX', 'positionY', 'positionZ']) this[key] = new Param();
    ctx.nodes.push(this);
  }
  connect(target) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; }
  start(at) { this.startedAt = at; }
  stop(at) { this.stoppedAt = at; }
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
  createOscillator() { return new AudioNode(this, 'oscillator'); }
  createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  async decodeAudioData(data) { return { url: new TextDecoder().decode(data) }; }
  async close() { this.state = 'closed'; }
}
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
globalThis.window = { AudioContext };
globalThis.fetch = async (url) => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url) });

function sampledCue(play, slot) {
  const before = ctx.nodes.length;
  play();
  const sources = ctx.nodes.slice(before).filter((node) => node.kind === 'source' && node.buffer?.url);
  assert.deepEqual(sources.map((node) => node.buffer.url), [BUILTIN_SAMPLE_MANIFEST[slot]], slot);
  return sources[0];
}

try {
  await sfx.init();
  for (const headshot of [false, true]) {
    for (const [method, slot] of [
      ['hitmark', `ui.hitmark.${headshot ? 'head' : 'body'}`],
      ['killConfirm', `ui.kill.${headshot ? 'head' : 'body'}`],
    ]) {
      const before = ctx.nodes.length;
      sampledCue(() => sfx[method](headshot), slot);
      assert.equal(ctx.nodes.slice(before).filter((node) =>
        node.kind === 'source' || node.kind === 'oscillator').length, 1,
      'a loaded hit confirmation has one recording and no synthetic clap or chirp layer');
    }
  }
  sampledCue(() => sfx.impact('flesh', 0.45), 'impact.flesh');
  for (const type of ['frag', 'limpet', 'pulse', 'rocket']) {
    assert.ok(BUILTIN_SAMPLE_MANIFEST[`grenades.${type}.explosion`]);
    const source = sampledCue(() => sfx.explosion([0, 0, 0], type), `grenades.${type}.explosion`);
    assert.equal(source.playbackRate.value, 1, 'explosions retain their authored timing');
  }
  sampledCue(() => sfx.grenadePin(), 'combat.grenadePin');
  sampledCue(() => sfx.grenadeThrow(1), 'combat.grenadeThrow');
  const remoteThrow = sampledCue(() => sfx.grenadeThrow(0.5, { pos: [10, 2, 5] }), 'combat.grenadeThrow');
  const throwPanner = remoteThrow.connections[0].connections[0].connections[0];
  assert.equal(throwPanner.kind, 'panner', 'remote throw routes through world attenuation and direction');
  assert.equal(throwPanner.positionX.value, 10);
  assert.equal(throwPanner.positionY.value, 2);
  assert.equal(throwPanner.positionZ.value, 5);
  const knife = sampledCue(() => sfx.fire('knife'), 'weapons.knife.fire');
  assert.equal(knife.playbackRate.value, fireSampleProfile('knife').rate);
  const minigun = sampledCue(() => sfx.fire('minigun'), 'weapons.minigun.fire');
  assert.equal(minigun.playbackRate.value, MINIGUN_REPORT.rate);
  assert.equal(minigun.connections[0].gain.value, MINIGUN_REPORT.gain);
  assert.deepEqual(fireSampleProfile('minigun'), { gain: MINIGUN_REPORT.gain, rate: MINIGUN_REPORT.rate },
    'offline audit uses the same rotary report profile as live fire');
  const flame = sampledCue(() => sfx.fire('flamethrower'), 'weapons.flamethrower.loop');
  assert.equal(flame.loop, true);
  ctx.currentTime = 0.05;
  const beforeRefresh = ctx.nodes.length;
  sfx.fire('flamethrower');
  assert.equal(ctx.nodes.length, beforeRefresh, 'flame facade refreshes the loaded loop without a new source');
  sfx.stopFlame();
  assert.equal(flame.stoppedAt, ctx.currentTime + 0.04);

  const beforeBolt = ctx.nodes.length;
  sfx.explosion([0, 0, 0], 'bolt');
  const boltNodes = ctx.nodes.slice(beforeBolt);
  assert.ok(boltNodes.some((node) => node.kind === 'source'), 'bolt expiry has an electric fallback cue');
  assert.ok(boltNodes.every((node) => !node.buffer?.url), 'nonexplosive bolt expiry never plays a grenade blast');

  const blast = sampledCue(() => sfx.explosion([0, 0, 0], 'frag'), 'grenades.frag.explosion');
  for (let i = 0; i < 80; i++) sfx.mine(1, true, [i, 0, 0]);
  assert.equal(blast.disconnected, undefined, 'facade assigns enough priority to survive same-frame terrain debris');
  await sfx.dispose();
  assert.ok(blast.disconnected);

  globalThis.fetch = async () => ({ ok: false });
  await sfx.init();
  for (const headshot of [false, true]) {
    for (const method of ['hitmark', 'killConfirm']) {
      const before = ctx.nodes.length;
      sfx[method](headshot);
      const voices = ctx.nodes.slice(before).filter((node) => ['source', 'oscillator'].includes(node.kind));
      assert.equal(voices.length, 2, 'missing hit recording uses one soft noise and one rounded tone');
      assert.ok(voices.filter((node) => node.kind === 'oscillator').every((node) => node.type === 'triangle'),
        'fallback hit cues do not contain square-wave or delayed melodic chirps');
      assert.ok(voices.every((node) => node.stoppedAt - node.startedAt < 0.11),
        'fallback confirmations cannot ring across several automatic-fire hits');
    }
  }
  for (const type of ['frag', 'limpet', 'pulse', 'rocket']) sfx.explosion([0, 0, 0], type);
  sfx.grenadePin();
  sfx.grenadeThrow(1);
  sfx.fire('knife');
  sfx.fire('minigun');
  sfx.fire('flamethrower');
  assert.ok(ctx.nodes.some((node) => node.kind === 'source'), 'failed downloads retain audible synthesis');
  assert.ok(ctx.nodes.every((node) => !node.buffer?.url), 'no unavailable sample is scheduled');
} finally {
  await sfx.dispose();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
}
console.log('Sound samples: explosion identity, grenade handling, knife, minigun, sustained flame, blast priority, bolt expiry and failed-fetch fallbacks passed.');
