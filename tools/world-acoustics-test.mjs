import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { WorldAcoustics } from '../shared/world-acoustics.js';
import { createStateApi } from '../shared/world/state.js';
import { AIR, CONCRETE, GLASS, WOOD, MC_GHOST_STONE, MC_WATER } from '../shared/world/blocks.js';

function fixture() {
  const dimensions = { sx: 96, sy: 40, sz: 96 };
  return createStateApi(new Uint8Array(dimensions.sx * dimensions.sy * dimensions.sz),
    new Int16Array(dimensions.sx * dimensions.sz), null, 'test', null, dimensions);
}
function box(world, min, max, material) {
  for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) {
    for (let z = min[2]; z <= max[2]; z++) world.setBlock(x, y, z, material);
  }
}
function wall(world, material = CONCRETE, thickness = 1) {
  box(world, [40, 0, 20], [39 + thickness, 22, 76], material);
}
function finite(sample) {
  for (const key of ['gain', 'lowpassHz', 'wet', 'decaySeconds', 'preDelaySeconds', 'occlusion', 'enclosure', 'pathLength']) {
    assert(Number.isFinite(sample[key]), `${key} must be finite`);
  }
  assert(sample.gain >= 0 && sample.gain <= 1);
  assert(sample.wet >= 0 && sample.wet <= 1);
  assert(sample.lowpassHz >= 550 && sample.lowpassHz <= 20000);
}

const source = [44.5, 4.5, 48.5];
const listener = [36.5, 4.5, 48.5];
const world = fixture();
const model = new WorldAcoustics(world);
const open = model.sample(source, listener, 1);
finite(open);
assert.equal(open.gain, 1);
assert.equal(open.room, 'outdoor');
assert.equal(open.blockedVoxels, 0);
wall(world);
const sealed = model.sample(source, listener, 1.001);
finite(sealed);
assert(sealed.gain < 0.3, 'masonry wall attenuates sound');
assert(sealed.lowpassHz < 3000, 'masonry wall removes high frequencies');
assert.equal(sealed.apparentPosition, null, 'sealed wall has no phantom portal');
assert.equal(sealed.blockedVoxels, 1);
assert.equal(model.diagnostics().revisionInvalidations, 1);

// A nearby off-axis doorway must admit sound and provide its apparent direction.
box(world, [40, 1, 51], [40, 6, 52], AIR);
const doorway = model.sample(source, listener, 1.002);
finite(doorway);
assert(doorway.gain > sealed.gain * 1.5, 'sound diffracts through nearby doorway');
assert(doorway.lowpassHz > sealed.lowpassHz * 2);
assert(doorway.apparentPosition?.[2] >= 51, 'direction points at the doorway');
assert(doorway.pathLength > open.pathLength, 'doorway preserves longer propagation path');

// Same endpoints and timestamp: the production mutationCount invalidates both
// transmission and enclosure, without waiting for the 120 ms path cache TTL.
box(world, [40, 0, 20], [40, 22, 76], AIR);
const broken = model.sample(source, listener, 1.002);
assert.equal(broken.gain, open.gain, 'destroyed wall immediately restores direct sound');
assert.equal(broken.lowpassHz, open.lowpassHz);
assert.equal(broken.apparentPosition, null);
assert.equal(broken.blockedVoxels, 0);
const beforeCachedReads = model.diagnostics().voxelReads;
assert.strictEqual(model.sample(source, listener, 1.003), broken);
assert.equal(model.diagnostics().voxelReads, beforeCachedReads, 'cache hit performs no voxel reads');

wall(world, WOOD);
const wood = model.sample(source, listener, 2);
wall(world, GLASS);
const glass = model.sample(source, listener, 2.01);
wall(world, CONCRETE, 3);
const thick = model.sample(source, listener, 2.02);
assert(glass.gain > wood.gain && wood.gain > sealed.gain, 'real materials have different transmission');
assert(thick.gain < sealed.gain, 'thicker masonry blocks more sound');
assert.equal(thick.blockedVoxels, 3);
box(world, [40, 1, 51], [42, 6, 51], AIR);
const thickDoor = model.sample(source, listener, 2.03);
assert(thickDoor.gain > thick.gain * 3, 'narrow doorway routes across the thickness of a wall');
assert(thickDoor.apparentPosition?.[2] === 51.5);
wall(world, AIR, 3);
wall(world, MC_GHOST_STONE);
assert.equal(model.sample(source, listener, 3).gain, 1, 'illusion blocks never occlude sound');
wall(world, MC_WATER);
assert.equal(model.sample(source, listener, 3.01).gain, 1, 'passable water is not treated as masonry');

const roomWorld = fixture();
box(roomWorld, [32, 0, 32], [56, 0, 56], CONCRETE);
for (const x of [32, 56]) box(roomWorld, [x, 1, 32], [x, 9, 56], CONCRETE);
for (const z of [32, 56]) box(roomWorld, [32, 1, z], [56, 9, z], CONCRETE);
box(roomWorld, [32, 10, 32], [56, 10, 56], CONCRETE);
const roomModel = new WorldAcoustics(roomWorld);
const roomSource = [45.5, 4.5, 44.5];
const roomListener = [43.5, 4.5, 44.5];
const enclosed = roomModel.sample(roomSource, roomListener, 4);
assert.equal(enclosed.room, 'room');
assert(enclosed.enclosure > 0.9);
assert(enclosed.wet > open.wet * 5);
assert(enclosed.decaySeconds > open.decaySeconds * 2);
box(roomWorld, [32, 10, 32], [56, 10, 56], AIR);
const roofGone = roomModel.sample(roomSource, roomListener, 4.001);
assert.equal(roofGone.room, 'outdoor', 'destroyed roof changes room classification');
assert(roofGone.wet < enclosed.wet * 0.7, 'roof removal reduces reflected energy');
assert(roofGone.decaySeconds < enclosed.decaySeconds, 'roof removal shortens reverb');

const tunnelWorld = fixture();
for (const x of [40, 46]) box(tunnelWorld, [x, 0, 16], [x, 9, 80], CONCRETE);
box(tunnelWorld, [40, 10, 16], [46, 10, 80], CONCRETE);
const tunnelModel = new WorldAcoustics(tunnelWorld);
assert.equal(tunnelModel.sample([43.5, 4.5, 50.5], [43.5, 4.5, 48.5], 5).room, 'tunnel');

// A ceiling separates floors. A nearby stairwell opening routes vertically,
// without the whole floor becoming acoustically transparent.
const floors = fixture();
box(floors, [20, 10, 20], [76, 10, 76], CONCRETE);
const floorModel = new WorldAcoustics(floors);
const upstairs = [48.5, 14.5, 48.5];
const downstairs = [48.5, 6.5, 48.5];
const closedFloor = floorModel.sample(upstairs, downstairs, 6);
box(floors, [51, 10, 47], [52, 10, 49], AIR);
const stairs = floorModel.sample(upstairs, downstairs, 6.001);
assert(stairs.gain > closedFloor.gain * 1.5);
assert(stairs.apparentPosition?.[0] >= 51);

// Wrappers are allowed to omit mutationCount, but must invalidate explicitly.
const wrapperWorld = fixture();
wall(wrapperWorld);
const wrapped = new WorldAcoustics({ getBlock: (...args) => wrapperWorld.getBlock(...args) });
const wrappedSealed = wrapped.sample(source, listener, 7);
wall(wrapperWorld, AIR);
wrapped.invalidate();
assert(wrapped.sample(source, listener, 7).gain > wrappedSealed.gain * 2);
wrapped.setWorld(null);
assert.equal(wrapped.sample(source, listener).gain, 1);
finite(wrapped.sample([NaN, 0, 0], listener));

const budgetModel = new WorldAcoustics(world, { maxVoxelReads: 128, maxReadsPerFrame: 256, maxCacheEntries: 4 });
for (let i = 0; i < 20; i++) {
  const sample = budgetModel.sample([10 + i, 3.5, 48.5], listener, 8);
  finite(sample);
  assert.equal(sample.gain, sample.deferred ? 0 : 1,
    'empty paths are clear when measured; unknown new voices explicitly wait rather than inventing a wall');
}
assert(budgetModel.diagnostics().frameVoxelReads <= 256, 'many voices share a fixed audio-frame budget');
assert(budgetModel.diagnostics().lastVoxelReads <= 128, 'one voice cannot exceed its read budget');
assert(budgetModel.diagnostics().budgetLimited > 0);
const readsBeforeNextFrame = budgetModel.diagnostics().voxelReads;
budgetModel.sample(source, listener, 8.02);
assert(budgetModel.diagnostics().voxelReads > readsBeforeNextFrame, 'budget resets on the next audio frame');

// Long sealed paths formerly consumed all work on optional doorway rays, then
// produced a louder unfiltered fallback for later voices in the same frame.
const longWall = { getBlock: x => x >= 390 && x <= 394 ? CONCRETE : AIR };
const longModel = new WorldAcoustics(longWall);
const farListener = [0.5, 3.5, 0.5];
for (let i = 0; i < 24; i++) {
  const sample = longModel.sample([400.5, 3.5, i * 3 + 0.5], farListener, 10);
  assert(!sample.deferred, 'direct paths receive work before optional reflection probes');
  assert.equal(sample.gain, 0.035);
  assert.equal(sample.lowpassHz, 550);
}
assert(longModel.diagnostics().frameVoxelReads <= longModel.limits.maxReadsPerFrame);

// Under a deliberately tiny budget, incomplete DDAs resume across frames.
// Cached earlier voices must not continually starve later voices in the list.
const busyWorld = { mutationCount: 0, getBlock: x => x >= 70 && x <= 74 ? CONCRETE : AIR };
const busy = new WorldAcoustics(busyWorld, { maxVoxelReads: 128, maxReadsPerFrame: 256 });
const completed = new Set();
for (let frame = 0; frame < 80 && completed.size < 24; frame++) {
  for (let i = 0; i < 24; i++) {
    const sample = busy.sample([80.5, 3.5, i * 3 + 0.5], farListener, 11 + frame / 60);
    if (sample.deferred) assert.equal(sample.gain, 0, 'unknown new paths remain silent until traced');
    else {
      completed.add(i);
      assert.equal(sample.gain, 0.035, 'completed paths preserve measured wall transmission');
    }
  }
  assert(busy.diagnostics().frameVoxelReads <= 256);
}
assert.equal(completed.size, 24, 'all voices eventually receive a complete trace in stable update order');
assert.equal(busy.diagnostics().pendingPaths, 0);

// Cached open sound and partially traced paths must both be discarded if a
// wall is rebuilt. No previous-revision result can escape as a clear voice.
const changing = { mutationCount: 0, getBlock: () => AIR };
const changingModel = new WorldAcoustics(changing, { maxVoxelReads: 128, maxReadsPerFrame: 256 });
assert.equal(changingModel.sample([80.5, 3.5, 0.5], farListener, 13).gain, 1);
changingModel.sample([80.5, 3.5, 100.5], farListener, 13);
changing.getBlock = x => x >= 70 && x <= 74 ? CONCRETE : AIR;
changing.mutationCount++;
const changed = changingModel.sample([80.5, 3.5, 0.5], farListener, 13);
assert.equal(changed.gain, changed.deferred ? 0 : 0.035, 'mutation invalidates trusted open-path caches');
for (let frame = 1; frame < 5; frame++) {
  const sample = changingModel.sample([80.5, 3.5, 100.5], farListener, 13 + frame / 60);
  if (!sample.deferred) {
    assert.equal(sample.gain, 0.035, 'mutation also invalidates partial ray continuations');
    break;
  }
  assert(frame < 4, 'changed path eventually finishes');
}

const cacheModel = new WorldAcoustics(fixture(), { maxCacheEntries: 4 });
for (let i = 0; i < 20; i++) cacheModel.sample([32 + i, 4.5, 48.5], listener, 9 + i / 10);
assert(cacheModel.diagnostics().pathCacheSize <= 4);
assert(cacheModel.diagnostics().roomCacheSize <= 4);

// Production World data, bounded repeated movement/voices. Log measurement,
// avoid hardware-sensitive duration assertions.
const benchmark = new WorldAcoustics(roomWorld);
const start = performance.now();
for (let i = 0; i < 500; i++) {
  finite(benchmark.sample([34.5 + i % 18, 4.5, 34.5 + (i * 7) % 18], roomListener, 20 + i / 60));
  assert(benchmark.diagnostics().lastVoxelReads <= benchmark.limits.maxVoxelReads);
}
console.log(`world acoustics: passed (open/wall/door/destruction/materials/roof/tunnel/stairs/cache/budget), 500 samples ${(performance.now() - start).toFixed(1)} ms`);
console.log(JSON.stringify({ open, sealed, doorway, enclosed, roofGone, diagnostics: benchmark.diagnostics() }, null, 2));
