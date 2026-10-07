// Coarse large-world voxel light on the real Frontier v2 world (spec 4.6, WP5
// acceptance): bake time, interiors in shadow, the ridge's lee side darker
// than its sunward side, open ground lit, destruction patches through the
// pending-region path, the module-worker bake (driven here through a
// node:worker_threads shim) matching the main-thread bake byte for byte, and
// the 4-voxel Low tier's face-coverage rule.
//
// FRONTIER_LIGHT_BUDGET_MS overrides the 1200 ms bake gate (e.g. on a loaded CI box).
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Worker as NodeWorker } from 'node:worker_threads';
import * as THREE from '../public/js/vendor/three.module.js';
import { AIR, STONE, createMapState } from '../shared/worlddata.js';
import {
  VoxelLightVolume, largeWorldLightCell, createVoxelLightUniforms, bindVoxelLightVolume,
} from '../public/js/engine/voxel-light.js';
import { mapAtmosphere, FRONTIER_WEATHER } from '../public/js/engine/map-atmosphere.js';
import { frontierSurfaceY } from '../shared/world/frontier-terrain.js';
import { BUNKERS_SITE } from '../shared/world/frontier-sites/bunkers.js';
import { VILLAGE_SITE } from '../shared/world/frontier-sites/village.js';
import { WORKS_SITE } from '../shared/world/frontier-sites/works.js';
import { FRONTIER_PLAN } from '../shared/conquest-contract.js';

const BUDGET_MS = Number(process.env.FRONTIER_LIGHT_BUDGET_MS) || 1200;

const world = createMapState('frontier');
const dims = world.dimensions;
assert.deepEqual(dims, FRONTIER_PLAN.dimensions, 'the Frontier v2 world is loaded');
const getBlock = world.getBlock;
const golden = mapAtmosphere('frontier', { weather: 'golden' });
const sunDir = new THREE.Vector3(...golden.sunDir).normalize();

// --- Cell size per tier --------------------------------------------------------------------------
assert.equal(largeWorldLightCell(dims, { tier: 'medium' }), 2);
assert.equal(largeWorldLightCell(dims, { tier: 'high' }), 2);
assert.equal(largeWorldLightCell(dims, { tier: 'ultra' }), 2);
assert.equal(largeWorldLightCell(dims, { tier: 'low' }), 4, 'Low bakes 4-voxel cells');
assert.equal(largeWorldLightCell(dims, { tier: 'medium', max3DTextureSize: 256 }), 4, 'a 256 texel GPU limit doubles the cell');

// --- Bake time and size (best of two: the first bake also warms the JIT) -------------------------
let volume = null;
const bakes = [];
for (let run = 0; run < 2; run++) {
  volume?.dispose();
  volume = new VoxelLightVolume(getBlock, dims, { cell: 2, sunDir, worker: false });
  bakes.push(volume.build());
}
const bakeMs = Math.min(...bakes);
assert.deepEqual(volume.stats.cells, [384, 40, 384], '2-voxel cells over 768 x 80 x 768');
assert.equal(volume.stats.bytes, 384 * 40 * 384 * 4, '23.6 MB RGBA8 volume');
assert.deepEqual(volume.extent, [768, 80, 768], 'the extent uniform carries the cell size');
const uniforms = createVoxelLightUniforms();
bindVoxelLightVolume(uniforms, volume, golden.light);
assert.deepEqual(uniforms.voxelLightSize.value.toArray(), [768, 80, 768]);
assert.ok(bakeMs <= BUDGET_MS, `Frontier light bake ${bakeMs.toFixed(0)} ms within ${BUDGET_MS} ms`);

// --- Interiors: pillboxes, church nave, smelter hall ---------------------------------------------
/** First standing height inside a footprint's centre column (floor + 1). */
function floorY(rect) {
  const x = Math.floor((rect.minX + rect.maxX) / 2), z = Math.floor((rect.minZ + rect.maxZ) / 2);
  for (let y = 1; y < dims.sy - 2; y++) {
    if (getBlock(x, y - 1, z) !== AIR && getBlock(x, y, z) === AIR && getBlock(x, y + 1, z) === AIR) return y;
  }
  throw new Error(`no floor inside ${JSON.stringify(rect)}`);
}
/** Sun and sky at chest height: the centre, and the mean over the interior kept 2 m off the walls. */
function interior(volumeToSample, rect) {
  const y = floorY(rect) + 1.5;
  const centre = volumeToSample.sample((rect.minX + rect.maxX + 1) / 2, y, (rect.minZ + rect.maxZ + 1) / 2);
  let sun = 0, sky = 0, n = 0;
  for (let z = rect.minZ + 2; z <= rect.maxZ - 2; z++) for (let x = rect.minX + 2; x <= rect.maxX - 2; x++) {
    const s = volumeToSample.sample(x + 0.5, y, z + 0.5);
    sun += s.sun; sky += s.sky; n++;
  }
  return { centre: { sun: centre.sun, sky: centre.sky }, sun: sun / n, sky: sky / n, y };
}
const rooms = [
  ['west pillbox', BUNKERS_SITE.buildings[0]],
  ['east pillbox', BUNKERS_SITE.buildings[1]],
  ['church nave', VILLAGE_SITE.hard],
  ['smelter hall', WORKS_SITE.hard],
];
const report = [];
for (const [name, rect] of rooms) {
  const light = interior(volume, rect);
  assert.ok(light.centre.sun < 0.2, `${name}: sun at the centre ${light.centre.sun.toFixed(2)} < 0.2`);
  assert.ok(light.sun < 0.2, `${name}: mean interior sun ${light.sun.toFixed(2)} < 0.2`);
  assert.ok(light.sky < 0.9, `${name}: the roof shades the sky (${light.sky.toFixed(2)})`);
  report.push(`${name} ${light.sun.toFixed(2)}`);
}

// --- Open ground is lit; the ridges' lee flanks are darker than their sunward flanks -------------
const surfaceTop = (x, z) => { let y = dims.sy - 1; while (y > 0 && getBlock(x, y, z) === AIR) y--; return y + 1; };
let openSun = 0, openPoints = 0, closedSky = 0;
for (let z = 40; z < dims.sz - 40; z += 37) for (let x = 40; x < dims.sx - 40; x += 41) {
  const s = volume.sample(x + 0.5, surfaceTop(x, z) + 0.5, z + 0.5);
  openSun += s.sun; openPoints++;
  if (s.sky < 0.5) closedSky++;
}
assert.ok(openSun / openPoints > 0.85, `open ground is sunlit (${(openSun / openPoints).toFixed(2)})`);
assert.equal(closedSky, 0, 'no open surface point reads as enclosed');
const flat = new THREE.Vector3(sunDir.x, 0, sunDir.z).normalize();
/** Lambert sunlight (voxel sun visibility x N.L) on a hill's sunward and lee flanks. */
function flanks(cx, cz, radius) {
  const sides = { sun: [0, 0], lee: [0, 0] };
  const normal = new THREE.Vector3();
  for (let dz = -radius; dz <= radius; dz += 3) for (let dx = -radius; dx <= radius; dx += 3) {
    const x = cx + dx, z = cz + dz;
    normal.set(-(frontierSurfaceY(x + 2, z) - frontierSurfaceY(x - 2, z)) / 4, 1,
      -(frontierSurfaceY(x, z + 2) - frontierSurfaceY(x, z - 2)) / 4).normalize();
    const slope = Math.hypot(normal.x, normal.z);
    if (slope < 0.08) continue;
    const facing = (normal.x * flat.x + normal.z * flat.z) / slope;
    const lit = volume.sample(x + 0.5, surfaceTop(x, z) + 0.5, z + 0.5).sun * Math.max(0, normal.dot(sunDir));
    const side = facing > 0.5 ? sides.sun : facing < -0.5 ? sides.lee : null;
    if (side) { side[0] += lit; side[1]++; }
  }
  return { sun: sides.sun[0] / sides.sun[1], lee: sides.lee[0] / sides.lee[1], samples: sides.sun[1] + sides.lee[1] };
}
const D = FRONTIER_PLAN.flags.find(flag => flag.id === 'D');
for (const [name, x, z, r] of [['Ridge Bunkers ridge', D.x + 10, D.z - 14, 70], ['north-west upland', 150, 128, 80]]) {
  const f = flanks(x, z, r);
  assert.ok(f.samples > 100, `${name} has sloped samples`);
  assert.ok(f.lee < f.sun * 0.7, `${name}: lee flank ${f.lee.toFixed(2)} darker than the sunward flank ${f.sun.toFixed(2)}`);
  report.push(`${name} lee/sun ${(f.lee / f.sun).toFixed(2)}`);
}

// --- Destruction: a breached nave roof patches through the pending region --------------------------
const reference = volume.data.slice();
const nave = VILLAGE_SITE.hard;
const naveFloor = floorY(nave);
const cx = Math.floor((nave.minX + nave.maxX) / 2), cz = Math.floor((nave.minZ + nave.maxZ) / 2);
const before = volume.sample(cx + 0.5, naveFloor + 1.5, cz + 0.5);
const hole = [];
for (let z = cz - 3; z <= cz + 3; z++) for (let x = cx - 6; x <= cx + 6; x++) {
  for (let y = naveFloor + 4; y < dims.sy; y++) {
    const id = getBlock(x, y, z);
    if (id === AIR) continue;
    hole.push({ x, y, z, v: AIR, previous: id });
    world.setBlock(x, y, z, AIR);
  }
}
assert.ok(hole.length > 40, 'the breach removes roof voxels');
volume.applyDeltas(hole);
assert.ok(volume.pending, 'roof deltas queue a pending region');
let at = performance.now();
volume.flush();
const patchMs = performance.now() - at;
assert.equal(volume.pending, null);
const after = volume.sample(cx + 0.5, naveFloor + 1.5, cz + 0.5);
assert.ok(after.sky > before.sky + 0.2, `the open roof lets the sky in (${before.sky.toFixed(2)} -> ${after.sky.toFixed(2)})`);
assert.ok(patchMs < 120, `a roof breach patches in ${patchMs.toFixed(1)} ms`);
const breached = new VoxelLightVolume(getBlock, dims, { cell: 2, sunDir, worker: false });
breached.build();
let differing = 0;
for (let i = 0; i < breached.data.length; i++) if (breached.data[i] !== volume.data[i]) differing++;
assert.equal(differing, 0, 'the patched Frontier volume equals a fresh bake of the breached world');
breached.dispose();
for (const d of hole) world.setBlock(d.x, d.y, d.z, d.previous);
volume.dispose();

// --- Module-worker bake (browser path) through a worker_threads shim --------------------------------
class WorkerShim {
  constructor(url, options = {}) {
    assert.equal(options.type, 'module', 'the light worker is a module worker');
    const bootstrap = [
      "import { parentPort } from 'node:worker_threads';",
      'globalThis.self = globalThis;',
      'globalThis.WorkerGlobalScope = function WorkerGlobalScope() {};',
      'globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);',
      "parentPort.on('message', (data) => globalThis.onmessage?.({ data }));",
      `await import(${JSON.stringify(String(url))});`,
    ].join('\n');
    this.worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`));
    this.worker.on('message', (data) => this.onmessage?.({ data }));
    this.worker.on('error', (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
    WorkerShim.created++;
  }
  postMessage(data, transfer) { this.worker.postMessage(data, transfer); }
  terminate() { this.worker.terminate(); }
}
WorkerShim.created = 0;
globalThis.Worker = WorkerShim;
let yields = 0;
const async = new VoxelLightVolume(getBlock, dims, { cell: 2, sunDir });
at = performance.now();
await async.buildAsync({ yieldControl: async () => { yields++; }, sliceMs: 8 });
const asyncMs = performance.now() - at;
delete globalThis.Worker;
assert.equal(WorkerShim.created, 1);
assert.equal(async.stats.mode, 'worker', 'the flood and sweep ran in the module worker');
assert.ok(yields > 0, 'classification yields to the page between slices');
assert.equal(async.data.length, reference.length);
let workerDiff = 0;
for (let i = 0; i < reference.length; i++) if (async.data[i] !== reference[i]) workerDiff++;
assert.equal(workerDiff, 0, 'the worker bake equals the main-thread bake byte for byte');
assert.equal(async.texture.image.data, async.data, 'the texture uploads the transferred bytes');
// Patches keep working on the arrays the worker handed back.
const pillbox = BUNKERS_SITE.buildings[0];
const pillboxFloor = floorY(pillbox);
const roofCells = [];
for (let z = pillbox.minZ; z <= pillbox.maxZ; z++) for (let x = pillbox.minX; x <= pillbox.maxX; x++) {
  for (let y = pillboxFloor + 2; y <= pillboxFloor + 7; y++) {
    const id = getBlock(x, y, z);
    if (id !== AIR) { roofCells.push({ x, y, z, v: AIR, previous: id }); world.setBlock(x, y, z, AIR); }
  }
}
const shaded = interior(async, pillbox).centre.sun;
async.applyDeltas(roofCells);
async.flush();
const opened = interior(async, pillbox).centre.sun;
assert.ok(opened > shaded + 0.5, `a destroyed pillbox lets the sun in after a worker bake (${shaded.toFixed(2)} -> ${opened.toFixed(2)})`);
for (const d of roofCells) world.setBlock(d.x, d.y, d.z, d.previous);
async.dispose();

// --- Low tier: 4-voxel cells with the face-coverage rule ----------------------------------------
const low = new VoxelLightVolume(getBlock, dims, { cell: 4, sunDir, worker: false });
const lowMs = low.build();
assert.equal(low.stats.bytes, 192 * 20 * 192 * 4, 'Low keeps a 2.9 MB volume');
assert.ok(lowMs <= BUDGET_MS, `Low bake ${lowMs.toFixed(0)} ms`);
for (const [name, rect] of [['church nave', VILLAGE_SITE.hard], ['smelter hall', WORKS_SITE.hard]]) {
  const light = interior(low, rect);
  assert.ok(light.centre.sun < 0.2, `Low ${name}: one-voxel roofs still shade 4-voxel cells (${light.centre.sun.toFixed(2)})`);
}
low.dispose();
// Fixture: a 10 m room under a one-voxel roof is dark in 4-voxel cells; the
// same roof made of every other voxel (half the face) does not act as a barrier.
const fixtureDims = { sx: 64, sy: 32, sz: 64 };
const room = (x, y, z, sparse = false) => {
  if (y < 8) return STONE;
  const inX = x >= 24 && x <= 35, inZ = z >= 24 && z <= 35;
  if (inX && inZ && y === 13) return sparse ? ((x + z) % 2 ? STONE : AIR) : STONE;
  if (inX && inZ && y >= 8 && y <= 12 && (x === 24 || x === 35 || z === 24 || z === 35)) return STONE;
  return AIR;
};
const coarse = new VoxelLightVolume(room, fixtureDims, { cell: 4, sunDir: new THREE.Vector3(0, 1, 0), worker: false });
coarse.build();
assert.ok(coarse.sample(30, 9.5, 30).sun < 0.2, 'a thin roof stops the sun in a 4-voxel cell');
coarse.dispose();
const lattice = new VoxelLightVolume((x, y, z) => room(x, y, z, true), fixtureDims, { cell: 4, sunDir: new THREE.Vector3(0, 1, 0), worker: false });
lattice.build();
assert.ok(lattice.sample(30, 9.5, 30).sun > 0.5, 'a half-open lattice is not a barrier');
lattice.dispose();

// --- Weather moods keep one light setup ----------------------------------------------------------
for (const weather of FRONTIER_WEATHER) {
  const palette = mapAtmosphere('frontier', { weather });
  assert.equal(palette.weather, weather);
  assert.deepEqual(Object.keys(palette.light).sort(), Object.keys(golden.light).sort(), `${weather}: light uniforms only`);
  assert.ok(palette.sunDir.length === 3 && palette.sunDir[1] > 0, `${weather}: the sun is above the horizon`);
}

console.log(`Frontier light passed: bake ${bakeMs.toFixed(0)} ms (worker path ${asyncMs.toFixed(0)} ms, identical bytes), `
  + `Low ${lowMs.toFixed(0)} ms, interiors sun ${report.slice(0, rooms.length).join(', ')}, ${report.slice(rooms.length).join(', ')}, `
  + `roof breach patch ${patchMs.toFixed(1)} ms equals a fresh bake.`);
