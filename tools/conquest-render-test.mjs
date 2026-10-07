import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ChunkStore, MAX_REBUILDS_PER_FRAME } from '../public/js/engine/chunks.js';
import { buildInitialMesh } from '../public/js/engine/initial-mesh.js';
import { FarTerrain } from '../public/js/engine/far-terrain.js';
import { GrassTufts, TUFT_STREAM_RADIUS } from '../public/js/engine/grass-tufts.js';
import {
  OutdoorLightVolume, VoxelLightVolume, largeWorldLightCell, createVoxelLightUniforms, bindVoxelLightVolume,
} from '../public/js/engine/voxel-light.js';
import { SCORCH_CAPACITY, SCORCH_CAPACITY_LARGE, ScorchDecals, configureScorchPool } from '../public/js/weapons/scorch-decals.js';
import { AIR, GRASS, STONE } from '../shared/worlddata.js';

const atlas = { texture: () => null, faceTile: () => 0, tileRect: () => ({ u0: 0, u1: 1, v0: 0, v1: 1 }) };

// --- Streaming chunk working set and the large-world rebuild budget -----------------
const dims = { sx: 1024, sy: 48, sz: 1024 };
const floor = (x, y, z) => x >= 0 && z >= 0 && x < 1024 && z < 1024 && y === 0 ? GRASS : AIR;
const store = new ChunkStore(new THREE.Scene(), atlas, floor, undefined, dims);
store.setViewPosition({ x: 512, z: 512 }, { ensureNear: false });
assert.equal(store.chunks.size, 0);
assert.equal(store.initialChunks().length, 169);
let yields = 0;
await buildInitialMesh(store, { yieldControl: async () => { yields++; } });
assert.equal(store.stats.chunks, 169);
assert(yields > 0);
let bytes = 0;
for (const mesh of store.group.children) {
  for (const attr of Object.values(mesh.geometry.attributes)) bytes += attr.array.byteLength;
  bytes += mesh.geometry.index.array.byteLength;
}
assert(bytes < 32 * 1024 * 1024, `flat terrain geometry grew to ${bytes} bytes`);
let disposed = 0;
for (const mesh of store.group.children) mesh.geometry.addEventListener('dispose', () => disposed++);
store.applyBlockDelta(20, 0, 20);
assert.equal(store.stats.queued, 0, 'unloaded terrain must not queue a mesh');

// Edits far from the view queue first; the budget still rebuilds the nearest first.
assert.equal(MAX_REBUILDS_PER_FRAME, 3, 'large worlds rebuild three chunks per frame');
const rebuilt = [];
const rebuildChunk = store.rebuildChunk.bind(store);
store.rebuildChunk = (cx, cz) => { rebuilt.push(`${cx},${cz}`); return rebuildChunk(cx, cz); };
store.applyBlockDelta(5 * 16 + 8, 0, 5 * 16 + 8 + 400);  // chunk (5,30): loaded? no, outside the working set
store.applyBlockDelta(37 * 16 + 8, 0, 32 * 16 + 8);      // chunk (37,32): 5 chunks east
store.applyBlockDelta(34 * 16 + 8, 0, 32 * 16 + 8);      // chunk (34,32): 2 chunks east
store.applyBlockDelta(38 * 16 + 8, 0, 32 * 16 + 8);      // chunk (38,32): 6 chunks east
store.applyBlockDelta(512, 0, 512);                      // chunk (32,32) corner: four AO neighbours
assert.equal(store.stats.queued, 7, 'interior edits queue one chunk each, the corner edit four');
assert.equal(store.update(), 3, 'large world drains three chunks per frame');
// The view chunk is (32,32): its own edit first, then its edge neighbours.
assert.deepEqual(rebuilt.slice(0, 3).sort(), ['31,32', '32,31', '32,32'], 'nearest edited chunks first');
assert.equal(store.update(), 3);
assert.deepEqual(rebuilt.slice(3, 6), ['31,31', '34,32', '37,32'], 'then outward by distance');
assert.equal(store.update(), 1, 'a partial frame rebuilds what is left');
assert.deepEqual(rebuilt.slice(6), ['38,32']);
store.rebuildChunk = rebuildChunk;

store.setViewPosition({ x: 720, z: 512 });
assert(disposed > 0);
assert(store.chunks.has('45,32'), 'new player cell must be visible immediately');
for (let z = 31; z <= 33; z++) for (let x = 44; x <= 46; x++) assert(store.chunks.has(`${x},${z}`));
assert(store.stats.chunks <= 169);
const pending = store.stats.pendingLoads;
assert.equal(store.update(), MAX_REBUILDS_PER_FRAME, 'streaming loads use the same budget');
assert.equal(store.stats.pendingLoads, pending - MAX_REBUILDS_PER_FRAME);
store.setViewPosition({ x: 16, z: 16 });
assert(store.stats.chunks <= 169);
store.buildAll();
assert.equal(store.stats.chunks, 64, 'edge working set is clipped to bounds');
store.dispose();
assert.equal(store.chunks.size, 0); assert.equal(store.stats.pendingLoads, 0); assert.equal(store.group.children.length, 0);
const legacy = new ChunkStore(new THREE.Scene(), atlas, floor, undefined, { sx: 32, sy: 4, sz: 32 });
legacy.buildAll(); assert.equal(legacy.stats.chunks, 4); assert.equal(legacy.streaming, false);
legacy.applyBlockDelta(16, 0, 16); assert.equal(legacy.update(), 3); legacy.dispose();
console.log(`Conquest chunks passed: 169 chunk ceiling, ${Math.round(bytes / 1024)} KiB flat geometry, three-chunk nearest-first budget, streaming and legacy checks.`);

// --- Coarse large-world light ---------------------------------------------------------
assert.equal(largeWorldLightCell({ sx: 768, sy: 80, sz: 768 }, { tier: 'medium' }), 2);
assert.equal(largeWorldLightCell({ sx: 768, sy: 80, sz: 768 }, { tier: 'ultra' }), 2);
assert.equal(largeWorldLightCell({ sx: 768, sy: 80, sz: 768 }, { tier: 'low' }), 4);
assert.equal(largeWorldLightCell({ sx: 768, sy: 80, sz: 768 }, { max3DTextureSize: 256 }), 4, 'grows until the GPU takes it');
const outdoor = new OutdoorLightVolume(); outdoor.build();
assert.equal(outdoor.data.byteLength, 4, 'the fallback stays four bytes');
assert.deepEqual(outdoor.sample(900, 20, 900), { sky: 1, sun: 1, block: 0, hue: 0 });
outdoor.dispose();

// A 96 x 32 x 96 field with a closed 10 x 5 x 10 bunker at (40..49, 10..14, 40..49).
const lightDims = { sx: 96, sy: 32, sz: 96 };
const bunker = new Set();
const inBunkerShell = (x, y, z) => x >= 40 && x <= 49 && z >= 40 && z <= 49 && y >= 10 && y <= 14
  && (x === 40 || x === 49 || z === 40 || z === 49 || y === 14);
const lightBlock = (x, y, z) => (y < 10 || inBunkerShell(x, y, z) || bunker.has(`${x},${y},${z}`) ? STONE : AIR);
const sun = new THREE.Vector3(-0.6, 0.7, 0.4).normalize();
const coarse = new VoxelLightVolume(lightBlock, lightDims, { cell: 2, sunDir: sun, worker: false });
assert.deepEqual(coarse.stats.cells, [48, 16, 48], 'two-voxel cells');
assert.equal(coarse.stats.bytes, 48 * 16 * 48 * 4);
coarse.build();
const inside = coarse.sample(44.5, 11.5, 44.5);
const open = coarse.sample(20.5, 11.5, 70.5);
assert(inside.sun < 0.2, `sun inside the bunker ${inside.sun.toFixed(2)}`);
assert(inside.sky < 0.6, `sky inside the bunker ${inside.sky.toFixed(2)}`);
assert(open.sun > 0.9 && open.sky > 0.9, 'open ground is sunlit');
// The extent uniform carries the cell size; shaders and program keys stay the same.
const uniforms = createVoxelLightUniforms();
bindVoxelLightVolume(uniforms, coarse);
assert.deepEqual(uniforms.voxelLightSize.value.toArray(), [96, 32, 96], 'cells x cell = world extent');
// Blowing the roof open patches through the pending region path.
for (let z = 41; z <= 48; z++) for (let x = 41; x <= 48; x++) bunker.add(`${x},14,${z}`);
const roof = [];
for (let z = 41; z <= 48; z++) for (let x = 41; x <= 48; x++) roof.push({ x, y: 14, z, v: AIR });
const openRoof = (x, y, z) => (y < 10 || (inBunkerShell(x, y, z) && !(y === 14 && x > 40 && x < 49 && z > 40 && z < 49)) ? STONE : AIR);
coarse.getBlock = openRoof;
coarse.applyDeltas(roof);
assert(coarse.pending, 'deltas queue a pending region');
coarse.flush();
assert.equal(coarse.pending, null);
const opened = coarse.sample(44.5, 11.5, 44.5);
assert(opened.sky > inside.sky + 0.2, `opening the roof lets the sky in (${inside.sky.toFixed(2)} -> ${opened.sky.toFixed(2)})`);
// The flush rebuilds the same light a full bake computes.
const fresh = new VoxelLightVolume(openRoof, lightDims, { cell: 2, sunDir: sun, worker: false });
fresh.build();
let differing = 0;
for (let i = 0; i < fresh.data.length; i++) if (fresh.data[i] !== coarse.data[i]) differing++;
assert.equal(differing, 0, 'a patched volume matches a fresh bake');
// A live match keeps destroying blocks while the async bake runs: the roof is
// blown open after its rows were classified, and the finished volume still
// matches a fresh bake of the opened world once the replayed cells flush.
let lateWorld = lightBlock, lateYields = 0;
const lateVolume = new VoxelLightVolume((x, y, z) => lateWorld(x, y, z), lightDims, { cell: 2, sunDir: sun, worker: false });
await lateVolume.buildAsync({ sliceMs: 0, yieldControl: async () => {
  if (++lateYields === 30) { lateWorld = openRoof; lateVolume.applyDeltas(roof); }
} });
assert(lateYields > 30, 'the roof opens after its light rows were classified');
assert(lateVolume.stats.lateReplayed > 0, 'deltas from the bake window are replayed against the finished volume');
assert(lateVolume.pending, 'replayed cells queue a pending region');
lateVolume.flush();
let lateDiffering = 0;
for (let i = 0; i < fresh.data.length; i++) if (fresh.data[i] !== lateVolume.data[i]) lateDiffering++;
assert.equal(lateDiffering, 0, 'a volume changed mid-bake matches a fresh bake after its first flush');
coarse.dispose(); fresh.dispose(); lateVolume.dispose();
console.log(`Coarse light passed: 2/4-voxel cells, extent uniform, bunker sun ${inside.sun.toFixed(2)}, patched roof equals a fresh bake.`);

// --- Far terrain relief -------------------------------------------------------------------
const reliefDims = { sx: 768, sy: 80, sz: 768 };
const groundAt = (x, z) => Math.round(30 + 8 * Math.sin(x / 47) + 6 * Math.cos(z / 61));
const relief = (x, y, z) => (x >= 0 && z >= 0 && x < 768 && z < 768 && y <= groundAt(x, z) ? GRASS : AIR);
const farScene = new THREE.Scene();
let coarseReads = 0;
const far = new FarTerrain(farScene, (x, y, z) => { coarseReads++; return relief(x, y, z); }, reliefDims, { step: 16, groundHeight: 24 });
assert.equal(far.stats.tiles, 48 * 48);
assert.equal(far.stats.draws, 1, 'one draw without a silhouette shell');
assert(far.stats.bytes < 3 * 1024 * 1024, 'far terrain geometry stays below 3 MiB');
assert(coarseReads < 500000, `initial height queries bounded (${coarseReads})`);
const heights = far.heightStats();
assert(heights.variance > 4, `sampled relief has height variance (${heights.variance.toFixed(1)})`);
assert(heights.max - heights.min >= 20, 'hills and valleys survive the far LOD');
for (const [x, z] of [[0, 0], [160, 320], [480, 96]]) {
  const tile = (x / 16) + (z / 16) * 48;
  assert(Math.abs(far.positions[tile * 9 * 3 + 1] - (groundAt(x, z) + 1 - 0.04)) < 0.001, 'tile corners sit on the voxel surface');
}
// Slopes shade darker than flats.
const flatTone = new Set(), slopeTone = new Set();
for (let tile = 0; tile < far.tiles; tile++) {
  const ny = far.normals[(tile * 9) * 3 + 1];
  (ny > 125 ? flatTone : slopeTone).add(far.colors[(tile * 9) * 3 + 1]);
}
assert(slopeTone.size > 1 && Math.min(...slopeTone) < Math.max(...flatTone), 'slope shade varies the painter colour');
far.syncChunks({ chunks: new Map([['10,10', { meshes: [] }], ['11,10', { meshes: [] }]]) });
assert.equal(far.stats.hidden, 2);
const hiddenOffset = (10 + 10 * 48) * 36;
assert(far.indices.subarray(hiddenOffset, hiddenOffset + 36).every(i => i === 0), 'loaded detail has no coincident LOD');
far.syncChunks({ chunks: new Map([['11,10', { meshes: [] }]]) });
assert(far.indices.subarray(hiddenOffset, hiddenOffset + 36).some(i => i !== 0), 'eviction restores far ground');
far.applyDeltas([{ x: 200, y: 20, z: 200 }]);
assert(far.dirty.size <= 9); const dirty = far.dirty.size; far.update(); assert.equal(far.dirty.size, dirty - 4);
let farDisposed = 0; far.geometry.addEventListener('dispose', () => farDisposed++); far.material.addEventListener('dispose', () => farDisposed++);
far.dispose(); assert.equal(farDisposed, 2); assert.equal(farScene.children.length, 0);
console.log(`Far terrain passed: ${far.tiles} tiles, one draw, <3 MiB, relief variance ${heights.variance.toFixed(1)}, slope shade, detail holes and disposal.`);

// --- Streamed grass tufts -----------------------------------------------------------------
const tuftScene = new THREE.Scene();
const tuftStore = new ChunkStore(new THREE.Scene(), atlas, relief, undefined, reliefDims);
tuftStore.setViewPosition({ x: 384, z: 384 }, { ensureNear: false });
tuftStore.buildAll();
const tufts = new GrassTufts(tuftScene, relief, () => 0, reliefDims, { density: 0.6, streaming: true, lightUniforms: createVoxelLightUniforms() });
tufts.build();
assert.equal(tufts.stats.regions, 0, 'streaming tufts never scan the whole map');
const warm = tufts.group.getObjectByName('grass-tufts-warmup');
assert(warm && warm.visible && warm.material === tufts.material, 'a zero-draw mesh carries the tuft program into shader warm-up');
assert.equal(warm.geometry.drawRange.count, 0);
tufts.syncChunks(tuftStore);
assert.equal(tufts.stats.regions, 2, 'two regions per frame');
assert.equal(warm.visible, false, 'the warm-up mesh goes quiet once a region draws');
tufts.syncChunks(tuftStore, { budget: Infinity });
const side = 2 * TUFT_STREAM_RADIUS + 1;
assert.equal(tufts.stats.regions, side * side, 'only chunks near the view grow tufts');
assert(tufts.stats.meshes <= side * side && tufts.stats.cells > 1000, 'regions carry tufts');
tuftStore.setViewPosition({ x: 384 + 16 * 3, z: 384 });
tufts.syncChunks(tuftStore, { budget: 0 });
assert.equal(tufts.stats.regions, side * (side - 3), 'regions out of reach are released at once');
tufts.dispose(); tuftStore.dispose();
console.log(`Streamed tufts passed: ${side}x${side} chunk reach, two regions per frame, release on move.`);

// --- Scorch pool ------------------------------------------------------------------------------
assert.equal(configureScorchPool('foundry'), SCORCH_CAPACITY);
const pool = new ScorchDecals(new THREE.Group(), () => false);
assert.equal(pool.capacity, SCORCH_CAPACITY);
assert.equal(configureScorchPool('frontier'), SCORCH_CAPACITY_LARGE);
assert.equal(SCORCH_CAPACITY_LARGE, 256);
assert.equal(pool.capacity, 256, 'live pools resize in place on Frontier');
for (let i = 0; i < 300; i++) pool.place(i, 12, 7, 3);
assert(pool.activeCount <= 256);
assert.equal(configureScorchPool('harbor'), SCORCH_CAPACITY);
assert.equal(pool.capacity, SCORCH_CAPACITY);
assert(pool.activeCount <= SCORCH_CAPACITY, 'leaving Frontier trims the pool');
const fixed = new ScorchDecals(new THREE.Group(), () => false, { capacity: 8 });
configureScorchPool('frontier');
assert.equal(fixed.capacity, 8, 'explicit capacities are never managed');
configureScorchPool(null);
console.log('Scorch pool passed: 24 on arenas, 256 on Frontier, resized in place.');

// --- Frontier v2 capture shots -----------------------------------------------------------------
{
  const { MAP_CAPTURE_SHOTS, resolveMapCaptureShot } = await import('../shared/map-capture-shots.js');
  const { createFrontierMetadata } = await import('../shared/world/frontier-layout.js');
  const { frontierSurfaceY } = await import('../shared/world/frontier-terrain.js');
  const { captureUrl, parseArgs } = await import('./render-map-scenes.mjs');
  const meta = createFrontierMetadata();
  const ids = MAP_CAPTURE_SHOTS.filter(shot => shot.map === 'frontier').map(shot => shot.id);
  assert.deepEqual(ids, ['vista', 'farm', 'village-street', 'bridge', 'trenches', 'works', 'tank-forest', 'heli-river', 'jet-sky', 'wreck-column', 'overview'],
    'the old Frontier shots are replaced by the v2 set');
  const { sx, sz } = meta.dimensions;
  for (const authored of MAP_CAPTURE_SHOTS.filter(shot => shot.map === 'frontier')) {
    assert.equal(authored.mode, 'conquest', `${authored.id} shows the Conquest layers`);
    if (authored.kind === 'orthographic') {
      assert.equal(authored.scale, Math.max(sx, sz), 'the overview frames the whole 768 m extent');
      continue;
    }
    const shot = resolveMapCaptureShot(authored, { meta });
    const [px, py, pz] = shot.position, [tx, ty, tz] = shot.target;
    assert.ok([px, py, pz, tx, ty, tz].every(Number.isFinite), `${shot.id} resolves to finite cameras`);
    assert.ok(px > 0 && pz > 0 && px < sx && pz < sz, `${shot.id} stands inside the map`);
    assert.ok(py >= frontierSurfaceY(px, pz) + 1, `${shot.id} camera stands above the terrain`);
    assert.ok(Math.hypot(tx - px, ty - py, tz - pz) > 8, `${shot.id} looks at a subject`);
    if (shot.stage) assert.ok(shot.stage.position[1] > frontierSurfaceY(shot.stage.position[0], shot.stage.position[2]) + 8, `${shot.id} stages its hull in the air`);
  }
  const wreck = meta.conquest.dressing.find(row => row.id === 'wreck-tank-c-west');
  const column = resolveMapCaptureShot(MAP_CAPTURE_SHOTS.find(shot => shot.id === 'wreck-column'), { meta });
  assert.ok(Math.hypot(column.target[0] - wreck.x, column.target[2] - wreck.z) < 1, 'the wreck shot frames the dressing wreck');
  const tank = meta.conquest.vehicleSpawns.find(row => row.id === 'alpha-tank');
  const forest = resolveMapCaptureShot(MAP_CAPTURE_SHOTS.find(shot => shot.id === 'tank-forest'), { meta });
  assert.ok(Math.hypot(forest.target[0] - tank.x, forest.target[2] - tank.z) < 1, 'the tank shot frames the authored tank pad');
  const options = parseArgs(['--map', 'frontier', '--shot', 'vista', '--vehicles', '--weather', 'mist', '--width', '1440', '--height', '1037']);
  assert.equal(options.vehicles, true); assert.equal(options.weather, 'mist');
  const url = captureUrl('http://127.0.0.1:1/', MAP_CAPTURE_SHOTS.find(shot => shot.id === 'vista'), options);
  assert.equal(url.searchParams.get('vehicles'), '1');
  assert.equal(url.searchParams.get('weather'), 'mist');
  assert.equal(url.searchParams.get('ambience'), '1', 'Conquest shots carry the battlefield ambience');
  assert.equal(url.searchParams.get('paint'), null, 'the retired paint sheet is never requested');
  assert.throws(() => parseArgs(['--weather', 'storm']), /invalid --weather/);
  console.log(`Capture shots passed: ${ids.length} Frontier v2 shots on the terrain, wreck and tank subjects from metadata, --vehicles/--weather passthrough.`);
}
