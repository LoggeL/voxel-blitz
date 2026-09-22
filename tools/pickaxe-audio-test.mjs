import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PICKAXE_SWING_SLOTS, PICKAXE_IMPACT_SLOTS, PICKAXE_DIG_MATERIALS, PICKAXE_DIG_SLOTS, PICKAXE_BREAK_SLOTS,
  PICKAXE_ATTACK_KINDS, PICKAXE_ATTACK_SLOTS, PickaxeDigVariations,
  pickaxeSampleChoice, pickaxeMaterial, pickaxeDigMaterial, renderPickaxeContact, renderMeleeHitFallback,
} from '../public/js/audio/pickaxe.js';
import { BUILTIN_SAMPLE_MANIFEST } from '../public/js/audio/samples.js';
import * as BLOCK from '../shared/world/blocks.js';
import {
  GRASS, DIRT, SAND, WOOD, LEAVES, PLANK, DUST_CRATE, DUST_WOOD,
  METAL, ACCENT, RUST, BUS_YELLOW, TRUCK_RED, GLASS, STONE,
  BRICK, POOL_PANEL, MC_LEAVES, MC_GHOST_PLANKS, MC_GHOST_STONE,
} from '../shared/world/blocks.js';
import { blockSoundFor } from '../public/js/weapons/impacts.js';
import { footstepMaterial } from '../public/js/audio/footsteps.js';

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

// Block-game dig groups: every block lands in one bank, ghosts sound like their solid.
const digGroups = {
  stone: ['STONE', 'CONCRETE', 'BRICK', 'ASPHALT', 'DUST_ROCK', 'MC_STONE', 'MC_COBBLE', 'MC_OBSIDIAN',
    'MC_NETHERRACK', 'MC_COAL_ORE', 'MC_FURNACE', 'POOL_TILE_BLUE', 'BEDROCK'],
  wood: ['WOOD', 'PLANK', 'DUST_CRATE', 'TEAL_SIDING', 'MC_LOG', 'MC_PLANKS', 'MC_BOOKSHELF', 'MC_CHEST', 'SLIDE_BLUE'],
  grass: ['GRASS', 'LEAVES', 'MC_GRASS', 'MC_LEAVES', 'MC_TNT'],
  gravel: ['DIRT', 'MC_DIRT', 'MC_GRAVEL', 'MC_CLAY'],
  sand: ['SAND', 'MC_SAND'],
  cloth: ['MC_WOOL_WHITE', 'MC_WOOL_RED', 'MC_CLOUD', 'MC_CACTUS', 'BARRICADE'],
  glass: ['GLASS', 'MC_GLASS', 'MC_GLOWSTONE'],
  metal: ['METAL', 'ACCENT', 'RUST', 'BUS_YELLOW', 'MC_IRON', 'MC_GOLD', 'MC_DIAMOND', 'POOL_PANEL'],
};
for (const [material, names] of Object.entries(digGroups)) {
  for (const name of names) assert.equal(pickaxeDigMaterial(BLOCK[name]), material, `${name} digs like ${material}`);
}
for (const [ghost, solid] of Object.entries(BLOCK.MC_GHOST_SOLID)) {
  assert.equal(pickaxeDigMaterial(Number(ghost)), pickaxeDigMaterial(solid), `ghost ${ghost} digs like its solid`);
}
for (let type = 1; type <= 85; type++) assert.ok(PICKAXE_DIG_MATERIALS.includes(pickaxeDigMaterial(type)));
assert.equal(pickaxeDigMaterial(9999), 'stone');

// Take choice: never the same take twice in a row per material; mining hits
// are quiet and pitched down, the breaking strike is full; glass shatters.
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const variations = new PickaxeDigVariations();
for (const material of PICKAXE_DIG_MATERIALS) {
  let previous = null;
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const hit = variations.dig(material, false, random);
    assert.ok(PICKAXE_DIG_SLOTS[material].includes(hit.slot) && hit.slot !== previous, `${material} no-repeat`);
    assert.ok(hit.gain < 0.5 && hit.rate >= 0.76 && hit.rate <= 0.94, `${material} mining hit is low and quiet`);
    previous = hit.slot;
    seen.add(hit.slot);
  }
  assert.equal(seen.size, PICKAXE_DIG_SLOTS[material].length, `${material} rotates through every take`);
  const broken = variations.dig(material, true, random);
  assert.ok(broken.gain === 1 && broken.rate >= 0.96 && broken.rate <= 1.04, `${material} break is full level`);
  assert.ok((PICKAXE_BREAK_SLOTS[material] || PICKAXE_DIG_SLOTS[material]).includes(broken.slot));
}
assert.ok(PICKAXE_BREAK_SLOTS.glass.includes(variations.dig('glass', true, random).slot), 'glass shatters on break');
assert.ok(PICKAXE_DIG_SLOTS.glass.includes(variations.dig('glass', true, random,
  (slot) => !slot.startsWith('pickaxe.break')).slot), 'an unloaded shatter falls back to the glass dig take');
assert.equal(variations.dig('stone', false, random, () => false), null, 'nothing loaded leaves the legacy contact chain');
assert.equal(variations.dig('lava', false, random).material, 'stone');
for (const kind of PICKAXE_ATTACK_KINDS) {
  const a = variations.attack(kind, random);
  const b = variations.attack(kind, random);
  assert.ok(PICKAXE_ATTACK_SLOTS[kind].includes(a.slot) && a.slot !== b.slot, `${kind} attack no-repeat`);
  assert.ok(a.rate >= 0.97 && a.rate <= 1.03);
}
assert.equal(variations.attack('nope', random).kind, 'strong');
assert.equal(variations.attack('crit', random, () => false).slot, null);
for (const kind of PICKAXE_ATTACK_KINDS) {
  const primitives = recorder();
  renderMeleeHitFallback('out', primitives, kind);
  assert.ok(primitives.calls.length >= 2 && primitives.calls.every(({ out, g }) => out === 'out' && g > 0),
    `${kind} procedural fallback is audible and routed`);
  if (kind === 'crit') assert.ok(primitives.calls.filter(({ f0 }) => f0 > 3000).length >= 3, 'crit sparkles');
  if (kind === 'armor') assert.ok(primitives.calls.filter(({ type }) => type === 'sine').length === 3, 'armor rings');
}

// Listen-free QA on the shipped takes: receipt hashes match the files and the
// decoded metrics keep each material/kind in its own character.
const receipt = JSON.parse(readFileSync(new URL('../public/assets/audio/elevenlabs-pickaxe-dig-sources.json', import.meta.url)));
const bySlot = new Map(receipt.selections.map((entry) => [entry.slot, entry]));
const banks = [...Object.values(PICKAXE_DIG_SLOTS), ...Object.values(PICKAXE_BREAK_SLOTS),
  ...Object.values(PICKAXE_ATTACK_SLOTS)].flat();
assert.equal(receipt.selections.length, banks.length, 'one receipt entry per shipped take');
for (const slot of banks) {
  const entry = bySlot.get(slot);
  assert.ok(entry, `${slot} has a receipt`);
  assert.equal(`/${entry.output.replace(/^public\//, '')}`, BUILTIN_SAMPLE_MANIFEST[slot], `${slot} ships its file`);
  const bytes = readFileSync(new URL(`../${entry.output}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.output_sha256, `${slot} matches its receipt`);
  const m = entry.final_metrics;
  assert.ok(m.onset_seconds_2pct_peak <= 0.006 && m.peak <= 0.75 && m.clipping_samples_at_0_999 === 0
    && m.last_20ms_rms < 0.004 && m.duration_seconds <= (slot.includes('break') ? 0.62 : 0.46), `${slot} metrics`);
}
const mean = (slots, key) => slots.reduce((sum, slot) => sum + key(bySlot.get(slot).final_metrics), 0) / slots.length;
const centroid = (slots) => mean(slots, (m) => m.spectral_centroid_hz);
assert.ok(centroid(PICKAXE_DIG_SLOTS.cloth) < 600, 'wool digs as a muffled puff');
assert.ok(centroid(PICKAXE_DIG_SLOTS.cloth) < centroid(PICKAXE_DIG_SLOTS.wood)
  && centroid(PICKAXE_DIG_SLOTS.wood) < centroid(PICKAXE_DIG_SLOTS.stone), 'cloth < wood < stone brightness');
assert.ok(centroid(PICKAXE_DIG_SLOTS.wood) < 1800, 'wood is a hollow knock');
assert.ok(centroid(PICKAXE_BREAK_SLOTS.glass) > centroid(PICKAXE_DIG_SLOTS.glass)
  && centroid(PICKAXE_DIG_SLOTS.glass) > centroid(PICKAXE_DIG_SLOTS.metal), 'glass tinks bright and shatters brighter');
assert.ok(centroid(PICKAXE_ATTACK_SLOTS.crit) > 1.5 * centroid(PICKAXE_ATTACK_SLOTS.strong), 'crit carries a sparkle');
assert.ok(centroid(PICKAXE_ATTACK_SLOTS.backstab) < centroid(PICKAXE_ATTACK_SLOTS.crit), 'backstab is the heavy crunch');
assert.ok(mean(PICKAXE_ATTACK_SLOTS.knockback, (m) => m.energy_seconds['90'])
  > mean(PICKAXE_ATTACK_SLOTS.strong, (m) => m.energy_seconds['90']), 'knockback trails a whoosh');
console.log('Pickaxe dig/attack banks: block-game material groups, no-repeat hit/break choice, glass shatter, fallbacks and shipped-take metrics passed.');

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

// Bullet dust/sparks and block-break sounds share the named material tables:
// brick is masonry, painted vehicle and pool panels ring like metal, crates splinter.
assert.equal(blockSoundFor(BRICK), 'stone', 'brick never sparks or clangs like steel');
for (const type of [METAL, ACCENT, RUST, BUS_YELLOW, TRUCK_RED, POOL_PANEL]) assert.equal(blockSoundFor(type), 'metal');
for (const type of [WOOD, PLANK, DUST_CRATE, DUST_WOOD, LEAVES, MC_LEAVES, MC_GHOST_PLANKS]) assert.equal(blockSoundFor(type), 'wood');
assert.equal(blockSoundFor(GLASS), 'glass');
assert.equal(blockSoundFor(MC_GHOST_STONE), 'stone');
for (const type of new Set(Object.values(BLOCK).filter(Number.isInteger))) {
  const pickaxe = pickaxeMaterial(type), impact = blockSoundFor(type);
  assert.equal(impact === 'metal', pickaxe === 'metal', `impact and pickaxe agree on metal for block ${type}`);
  assert.equal(impact === 'glass', pickaxe === 'glass', `impact and pickaxe agree on glass for block ${type}`);
  if (footstepMaterial(type) === 'metal') assert.equal(impact, 'metal', `footsteps and impacts agree on metal for block ${type}`);
}
console.log('Impact materials: brick is stone; metal and glass agree across impact, pickaxe and footstep tables.');
