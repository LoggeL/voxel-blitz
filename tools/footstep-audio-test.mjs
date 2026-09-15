import assert from 'node:assert/strict';
import { FootstepCadence, FootstepVariations, FOOTSTEP_SURFACES, FOOTSTEP_SLOTS,
  footstepMaterial, footstepSurfaceAt, footstepVolume, gaitPhaseRate, strideCrossed,
  STEP_SPEED_MIN, SPRINT_SPEED } from '../public/js/audio/footsteps.js';
import * as BLOCK from '../shared/world/blocks.js';
import { BUILTIN_SAMPLE_MANIFEST } from '../public/js/audio/samples.js';
import { sfx } from '../public/js/audio/sfx.js';

for (const [surface, types] of Object.entries({
  stone: [BLOCK.CONCRETE, BLOCK.STONE, BLOCK.POOL_TILE_BLUE, BLOCK.DUST_FLOOR, BLOCK.BEDROCK],
  wood: [BLOCK.WOOD, BLOCK.MC_PLANKS, BLOCK.DUST_CRATE, BLOCK.MC_CHEST],
  metal: [BLOCK.METAL, BLOCK.RUST, BLOCK.MC_IRON, BLOCK.POOL_PANEL],
  grass: [BLOCK.GRASS, BLOCK.DIRT, BLOCK.MC_DIRT, BLOCK.MC_LEAVES],
  gravel: [BLOCK.MC_GRAVEL], sand: [BLOCK.SAND, BLOCK.MC_SAND],
  cloth: [BLOCK.MC_WOOL_RED, BLOCK.MC_WOOL_WHITE, BLOCK.MC_CLOUD],
})) for (const type of types) assert.equal(footstepMaterial(type), surface);
assert.equal(footstepSurfaceAt(() => BLOCK.WOOD, { x: .5, y: 4, z: .5 }), 'wood');
const cells = new Map([['0,3,0', BLOCK.METAL]]);
const getBlock = (x, y, z) => cells.get(`${x},${y},${z}`) ?? BLOCK.AIR;
assert.equal(footstepSurfaceAt(getBlock, { x: 1.1, y: 4, z: .5 }), 'metal', 'supporting foot at a ledge');
cells.set('1,3,0', BLOCK.MC_GHOST_GRASS);
assert.equal(footstepSurfaceAt(getBlock, { x: 1.1, y: 4, z: .5 }), 'metal', 'ghost grass is not a floor');
cells.set('1,3,0', BLOCK.MC_WATER);
assert.equal(footstepSurfaceAt(getBlock, { x: 1.1, y: 4, z: .5 }), 'metal', 'fluid is not a floor');
cells.set('0,3,0', BLOCK.MC_SAND);
assert.equal(footstepSurfaceAt(getBlock, { x: 1.1, y: 4, z: .5 }), 'sand', 'live terrain edits change material');
assert.equal(footstepSurfaceAt(getBlock, { x: NaN, y: 4, z: .5 }), 'stone');
{
  const variations = new FootstepVariations();
  const me = {}, other = {};
  const first = variations.next('wood', me, () => 0);
  variations.next('metal', other, () => 0);
  const second = variations.next('wood', me, () => 0);
  assert.notEqual(first.slot, second.slot, 'consecutive footfalls use different takes');
  assert.equal(first.pan, -second.pan, 'other players cannot change local foot alternation');
  assert.equal(variations.next('wood', other, () => 0).slot, first.slot, 'variation belongs to the body');
  assert.equal(variations.next('invalid', me, () => 0).surface, 'stone');
  for (const surface of FOOTSTEP_SURFACES) {
    let previous;
    const used = new Set();
    for (let i = 0; i < 30; i++) {
      const next = variations.next(surface, me, () => (i % 3) / 3);
      assert.notEqual(next.slot, previous);
      assert.ok(next.rate >= .975 && next.rate <= 1.025);
      assert.ok(BUILTIN_SAMPLE_MANIFEST[next.slot]);
      used.add(next.slot); previous = next.slot;
    }
    assert.equal(used.size, 3, `${surface}: all three recordings are reachable`);
  }
}

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
  async decodeAudioData(data) {
    if (!this.allowSamples) throw new Error('no samples in this test');
    return { duration: .3, url: new TextDecoder().decode(data) };
  }
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
  ctx.allowSamples = true;
  const stepManifest = Object.fromEntries(Object.entries(BUILTIN_SAMPLE_MANIFEST)
    .filter(([slot]) => slot.startsWith('movement.footstep.')));
  const loaded = await sfx.loadSamples(stepManifest, async (url) => ({ ok: true,
    arrayBuffer: async () => new TextEncoder().encode(url) }));
  assert.deepEqual(loaded, { loaded: 21, failed: 0 });
  const ownBody = {}, remoteBody = {};
  for (const surface of FOOTSTEP_SURFACES) {
    let lastUrl;
    for (let i = 0; i < 4; i++) {
      const start = ctx.nodes.length;
      sfx.footstep(.3, { surface, body: ownBody });
      const nodes = ctx.nodes.slice(start);
      const sources = nodes.filter((node) => node.kind === 'source');
      assert.equal(sources.length, 1, 'one recording and no layered synthetic noise');
      assert.ok(FOOTSTEP_SLOTS[surface].some((slot) => stepManifest[slot] === sources[0].buffer.url));
      assert.notEqual(sources[0].buffer.url, lastUrl);
      lastUrl = sources[0].buffer.url;
      assert.ok(!nodes.some((node) => node.kind === 'oscillator' || node.kind === 'panner'));
      assert.equal(nodes.filter((node) => node.kind === 'stereo').length, 1, 'own sample gets subtle stereo alternation');
      sfx.footstep(1, { surface, body: remoteBody, pos: [4, 1, 0] });
    }
  }
  const silentBefore = ctx.nodes.length;
  for (const gain of [0, -1, NaN, Infinity]) sfx.footstep(gain, { surface: 'metal' });
  assert.equal(ctx.nodes.length, silentBefore, 'silent and invalid gains allocate no voices');
} finally {
  await sfx.dispose();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
console.log('ok: footstep cadence grades speed and stance, follows the gait phase, remote steps are positional');
