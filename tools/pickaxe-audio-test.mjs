import assert from 'node:assert/strict';
import {
  PICKAXE_SWING_SLOTS, PICKAXE_IMPACT_SLOTS,
  pickaxeSampleChoice, pickaxeMaterial, renderPickaxeContact,
} from '../public/js/audio/pickaxe.js';
import {
  GRASS, DIRT, SAND, WOOD, LEAVES, PLANK, DUST_CRATE, DUST_WOOD,
  METAL, ACCENT, RUST, BUS_YELLOW, TRUCK_RED, GLASS, STONE,
} from '../shared/world/blocks.js';

// Record every scheduled voice instead of rendering one, so the contact stays
// inspectable: one attack, its material colour, and the optional debris tail.
function recorder(now = 0) {
  const calls = [];
  return {
    calls,
    nowT: () => now,
    hiss: (out, opts) => calls.push({ kind: 'hiss', out, ...opts }),
    tone: (out, opts) => calls.push({ kind: 'tone', out, ...opts }),
  };
}
const attacks = (calls) => calls.filter((call) => call.t0 <= 0.01);
const render = (material, options) => {
  const primitives = recorder();
  renderPickaxeContact('out', primitives, material, options);
  return primitives.calls;
};

// Swings and impacts each rotate through their own slots and detune table, so
// repeated mining never machine-guns one identical recording.
const swings = Array.from({ length: 8 }, (_, i) => pickaxeSampleChoice(i));
const impacts = Array.from({ length: 8 }, (_, i) => pickaxeSampleChoice(i, true));
assert.deepEqual(swings.slice(0, 4).map(({ slot }) => slot),
  [PICKAXE_SWING_SLOTS[0], PICKAXE_SWING_SLOTS[1], PICKAXE_SWING_SLOTS[0], PICKAXE_SWING_SLOTS[1]]);
assert.deepEqual(impacts.slice(0, 4).map(({ slot }) => slot),
  [PICKAXE_IMPACT_SLOTS[0], PICKAXE_IMPACT_SLOTS[1], PICKAXE_IMPACT_SLOTS[0], PICKAXE_IMPACT_SLOTS[1]]);
assert.equal(new Set(swings.slice(0, 4).map(({ rate }) => rate)).size, 4,
  'four consecutive swings each carry a distinct playback rate');
assert.deepEqual(swings.slice(4), swings.slice(0, 4), 'the swing rotation repeats exactly');
assert.deepEqual(impacts.slice(4), impacts.slice(0, 4), 'the impact rotation repeats exactly');
assert.ok(swings.every(({ rate }) => rate >= 0.95 && rate <= 1.05),
  'detune stays subtle enough to read as the same tool');
assert.equal(pickaxeSampleChoice(-0).slot, PICKAXE_SWING_SLOTS[0]);

// Material classification drives both the filter and the debris colour.
for (const type of [GRASS, DIRT, SAND, WOOD, LEAVES, PLANK, DUST_CRATE, DUST_WOOD]) {
  assert.equal(pickaxeMaterial(type), 'soft', `block ${type} is soft`);
}
for (const type of [METAL, ACCENT, RUST, BUS_YELLOW, TRUCK_RED]) {
  assert.equal(pickaxeMaterial(type), 'metal', `block ${type} is metal`);
}
assert.equal(pickaxeMaterial(GLASS), 'glass');
assert.equal(pickaxeMaterial(STONE), 'stone');
assert.equal(pickaxeMaterial(9999), 'stone', 'unknown blocks fall back to stone');

// With a recording in hand the synthetic strike stays out of the way; without
// one the fallback supplies exactly one attack.
const sampled = render('stone', { sampled: true, broken: false });
assert.equal(attacks(sampled).length, 0, 'a played recording is not doubled by a synthetic strike');
const fallback = render('stone', { sampled: false, broken: false });
assert.equal(attacks(fallback).length, 2, 'the fallback strike is one hiss plus one body tone');
assert.equal(fallback.filter(({ kind }) => kind === 'hiss').length, 1);
assert.equal(fallback.filter(({ kind }) => kind === 'tone').length, 1);
const soft = render('soft', { sampled: false, broken: false });
assert.ok(soft.find(({ kind }) => kind === 'hiss').f
  < fallback.find(({ kind }) => kind === 'hiss').f,
'soft ground sounds duller than stone');

// Metal rings, and only metal.
const metal = render('metal', { sampled: true, broken: false });
assert.equal(metal.length, 2, 'a sampled metal strike adds only its two ring partials');
assert.ok(metal.every(({ kind, type }) => kind === 'tone' && type === 'sine'));
for (const material of ['stone', 'soft', 'glass']) {
  assert.equal(render(material, { sampled: true, broken: false }).length, 0,
    `${material} adds no ring to a sampled strike`);
}

// Breaking a block adds fragments that trail the one impact and decay away.
for (const material of ['stone', 'soft', 'glass', 'metal']) {
  const whole = render(material, { sampled: true, broken: false });
  const broken = render(material, { sampled: true, broken: true });
  const debris = broken.slice(whole.length);
  assert.equal(debris.length, 3, `${material} debris is three fragments`);
  assert.ok(debris.every(({ kind, t0 }) => kind === 'hiss' && t0 > 0.01),
    `${material} fragments follow the impact and never add a second attack`);
  for (let i = 1; i < debris.length; i++) {
    assert.ok(debris[i].t0 > debris[i - 1].t0, 'fragments are ordered in time');
    assert.ok(debris[i].g < debris[i - 1].g, 'fragments fade');
    assert.ok(debris[i].g > 0, 'no fragment is silent');
  }
}
assert.ok(render('glass', { sampled: true, broken: true }).at(-3).f
  > render('stone', { sampled: true, broken: true }).at(-3).f,
'glass shards ring brighter than stone rubble');
assert.ok(render('soft', { sampled: true, broken: true }).at(-3).f
  < render('stone', { sampled: true, broken: true }).at(-3).f,
'soft debris stays below stone rubble');

// Every scheduled voice targets the caller's output, never a stray node.
for (const material of ['stone', 'soft', 'metal', 'glass']) {
  for (const sampledFlag of [true, false]) {
    assert.ok(render(material, { sampled: sampledFlag, broken: true })
      .every(({ out, g }) => out === 'out' && g > 0),
    `${material} routes every audible voice to the supplied output`);
  }
}

console.log('Pickaxe audio: swing/impact rotation, material classification, single attack, metal ring, debris tails and routing passed.');

const { CombatFeedback } = await import('../public/js/combat/feedback.js');
const played = [];
const feedback = Object.assign(Object.create(CombatFeedback.prototype), {
  _disposed: false, _minedBreak: null, isRunning: () => true, getMyId: () => 'self',
  _lastBulletFlybyAt: -Infinity, blockSound: () => 'stone',
  player: { alive: true }, camera: { position: { x: 0.5, y: 2, z: 5 } },
  effects: { shoot() {}, impacts: { mine() {}, chipBlock() {} }, explodeBlock() {} },
  sfx: Object.fromEntries(['fire', 'bulletWhiz', 'mine', 'impact'].map(name =>
    [name, (...args) => played.push({ name, args })])),
  world: { getBlock: () => 0, setBlock() {}, applyDeltas() {} },
});
const nearPass = { kind: 'shoot', id: 'other', o: [0,2,0], d: [0,0,1],
  paths: [[{ o: [0,2,0], end: [0,2,10] }]] };
feedback.handleEvent({ ...nearPass, w: 'knife' });
assert.deepEqual(played.map(x => x.name), ['fire'], 'remote melee has a swing without a bullet fly-by');
feedback.handleEvent({ ...nearPass, w: 'rifle' });
assert.equal(played.at(-1).name, 'bulletWhiz', 'nearby bullets retain fly-by feedback');
assert.deepEqual(played.at(-1).args[1].pos, [0,2,5], 'the pass plays beside the listener on the resolved segment');
played.length = 0;
feedback.handleEvent({ kind: 'mine', from: STONE, x: 1, y: 2, z: 3, progress: 1 });
feedback.handleEvent({ kind: 'block', from: STONE, v: 0, x: 1, y: 2, z: 3 });
assert.deepEqual(played.map(x => x.name), ['mine'], 'mined break does not double the contact');
feedback.handleEvent({ kind: 'block', from: STONE, v: 0, x: 1, y: 2, z: 4 });
assert.equal(played.at(-1).name, 'impact', 'other block destruction retains its sound');
console.log('Pickaxe event feedback: melee fly-by exclusion and mined-break deduplication passed.');

let localContacts = 0;
feedback.onLocalMine = () => localContacts++;
feedback.handleEvent({ kind: 'mine', id: 'other', from: STONE, x: 1, y: 2, z: 3, progress: 0.2 });
feedback.handleEvent({ kind: 'mine', id: 'self', from: STONE, x: 1, y: 2, z: 3, progress: 0.2 });
assert.equal(localContacts, 1, 'only the local accepted strike rebounds the held pickaxe');
