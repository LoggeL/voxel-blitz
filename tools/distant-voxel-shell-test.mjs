import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as THREE from '../public/js/vendor/three.module.js';
import { AIR, GRASS, METAL, RUST, SAND, createMapState } from '../shared/worlddata.js';
import { DistantVoxelShell } from '../public/js/engine/distant-voxel-shell.js';
import { FarTerrain, FAR_GROUND_IDS, FAR_PAVING_IDS } from '../public/js/engine/far-terrain.js';
import { renderDistanceProfile } from '../public/js/engine/render-distance.js';

const dimensions = { sx: 32, sy: 40, sz: 16 }, blocks = new Uint8Array(32 * 40 * 16);
const index = (x, y, z) => x + z * dimensions.sx + y * dimensions.sx * dimensions.sz;
const getBlock = (x, y, z) => blocks[index(x, y, z)];
const fill = (x0, y0, z0, x1, y1, z1, id) => {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) blocks[index(x, y, z)] = id;
};
fill(0, 0, 0, 31, 10, 15, GRASS);
fill(4, 33, 4, 27, 35, 11, RUST);
fill(4, 11, 4, 5, 32, 5, METAL);
fill(26, 11, 4, 27, 32, 5, METAL);
fill(31, 11, 13, 31, 25, 13, METAL);
fill(8, 11, 0, 13, 14, 3, SAND);
const scene = new THREE.Scene(), shell = new DistantVoxelShell(scene, getBlock, dimensions);
const mesh = shell.mesh;
assert(shell.ready);
assert.equal(scene.children.length, 1, 'all distant structures share one mesh');
assert.equal(shell.stats.draws, 1);
assert.equal(shell.geometry.groups.length, 0, 'no material groups add extra draws');
const hit = (origin, direction) => {
  mesh.updateMatrixWorld();
  return new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction)).intersectObject(mesh)[0];
};
assert.equal(hit([20, 39, 8], [0, -1, 0])?.point.y, 36, 'roof keeps its authoritative upper surface');
assert.equal(hit([20, 20, -1], [0, 0, 1]), undefined, 'the open gap below an elevated bridge stays open');
assert.equal(hit([20, 20, 8], [0, 1, 0])?.point.y, 33, 'roof underside remains visible from below');
assert.equal(hit([30.5, 39, 12.5], [0, -1, 0])?.point.y, 26, 'any occupied column retains a one-voxel pole on odd coordinates');
assert.equal(hit([10, 39, 2], [0, -1, 0])?.point.y, 15, 'raised terrain remains part of the shell');
assert.equal(hit([2, 39, 14], [0, -1, 0]), undefined, 'underground and the base floor are excluded');

const positions = shell.geometry.attributes.position, normals = shell.geometry.attributes.normal, colors = shell.geometry.attributes.color;
// Record slots carry spare vertices past their live quads; walk the drawn quads.
const drawn = shell.geometry.index.array;
for (let quad = 0; quad < drawn.length; quad += 6) {
  if (drawn[quad] === drawn[quad + 1]) continue;
  const vertex = drawn[quad];
  const a = new THREE.Vector3().fromBufferAttribute(positions, vertex);
  const b = new THREE.Vector3().fromBufferAttribute(positions, vertex + 1);
  const c = new THREE.Vector3().fromBufferAttribute(positions, vertex + 2);
  const expected = new THREE.Vector3().fromBufferAttribute(normals, vertex);
  assert(b.sub(a).cross(c.sub(a)).normalize().dot(expected) > .999, 'winding agrees with each outward axis normal');
  for (let corner = 1; corner < 4; corner++) for (let channel = 0; channel < 3; channel++) {
    assert.equal(colors.array[(vertex + corner) * 3 + channel], colors.array[vertex * 3 + channel], 'each material face has flat vertex colours');
  }
}
const roof = hit([20, 39, 8], [0, -1, 0]), pole = hit([30.5, 39, 12.5], [0, -1, 0]);
assert.notDeepEqual(Array.from(colors.array.subarray(roof.face.a * 3, roof.face.a * 3 + 3)),
  Array.from(colors.array.subarray(pole.face.a * 3, pole.face.a * 3 + 3)), 'rust and metal retain distinct material colours');

shell.syncChunks({ chunks: new Map(), loadQueue: [{ x: 1, z: 0 }] });
assert(hit([20, 39, 8], [0, -1, 0]), 'pending detailed chunks keep their distant shell');
shell.syncChunks({ chunks: new Map([['1,0', {}]]) });
assert.equal(hit([20, 39, 8], [0, -1, 0]), undefined, 'completed detailed chunk hides its exact index span');
assert(hit([10, 39, 8], [0, -1, 0]), 'another chunk remains visible');
const hiddenVersion = shell.geometry.index.version;
shell.syncChunks({ chunks: new Map([['1,0', {}]]) });
assert.equal(shell.geometry.index.version, hiddenVersion, 'unchanged streaming state causes no buffer upload');
shell.syncChunks({ chunks: new Map() });
assert(hit([20, 39, 8], [0, -1, 0]), 'evicted detailed chunk restores cached distant geometry');

const deltas = [];
for (let y = 33; y <= 35; y++) for (let z = 8; z <= 9; z++) for (let x = 20; x <= 21; x++) {
  blocks[index(x, y, z)] = AIR; deltas.push({ x, y, z, id: AIR });
}
shell.applyDeltas(deltas);
assert.equal(shell.stats.dirty, 2, 'changed chunk and its neighbour are invalidated');
const geometryBeforePatch = shell.geometry, mergesBeforePatch = shell.stats.merges;
while (shell.stats.dirty) {
  const rebuilt = shell.stats.rebuilds;
  shell.update();
  assert.equal(shell.stats.rebuilds, rebuilt + 1, 'only one dirty chunk is rebuilt in a frame');
  assert.strictEqual(shell.mesh, mesh, 'remeshing preserves the single scene mesh');
}
assert.equal(shell.stats.merges, mergesBeforePatch, 'a blast patches the records in place: no buffer re-layout');
assert.strictEqual(shell.geometry, geometryBeforePatch, 'the GPU buffers survive the patch');
assert(shell.geometry.attributes.position.updateRanges.length > 0
  && shell.geometry.attributes.position.updateRanges.every(range => range.count < shell.geometry.attributes.position.array.length),
'only the patched slots upload');
assert.equal(hit([20.5, 39, 8.5], [0, -1, 0]), undefined, 'destruction removes authoritative geometry');
assert(hit([22.5, 39, 8.5], [0, -1, 0]), 'remaining bridge roof is preserved');
fill(20, 33, 8, 21, 35, 9, RUST);
shell.syncChunks({ chunks: new Map([['1,0', {}]]) });
shell.applyDeltas(deltas);
while (shell.stats.dirty) shell.update();
assert.equal(shell.stats.deferred, 1, 'a record hidden behind detailed chunks waits instead of rebuilding');
assert.equal(hit([20.5, 39, 8.5], [0, -1, 0]), undefined, 'rebuilding a hidden chunk preserves its hole');
shell.syncChunks({ chunks: new Map() });
assert.equal(shell.stats.queued, 0, 'the deferred record is rebuilt as it shows again');
assert(hit([20.5, 39, 8.5], [0, -1, 0]), 'eviction restores the newly rebuilt roof');
fill(20, 33, 8, 21, 35, 9, AIR);
shell.applyDeltas(deltas);
shell.flush();
assert.equal(shell.stats.queued, 0, 'replay flush drains every dirty record before rendering');
assert.equal(hit([20.5, 39, 8.5], [0, -1, 0]), undefined, 'replay flush shows the current recorded voxel state immediately');

let geometryDisposed = 0, materialDisposed = 0;
shell.geometry.addEventListener('dispose', () => geometryDisposed++);
shell.material.addEventListener('dispose', () => materialDisposed++);
shell.dispose(); shell.dispose();
assert.equal(scene.children.length, 0);
assert.equal(geometryDisposed, 1);
assert.equal(materialDisposed, 1);

// A uniform prism needs exactly six greedy quads rather than per-cell faces.
const prism = new DistantVoxelShell(scene, (x, y, z) => x >= 2 && x < 14 && z >= 2 && z < 14 && y >= 14 && y < 30 ? RUST : AIR,
  { sx: 16, sy: 40, sz: 16 });
assert.equal(prism.stats.quads, 6, 'greedy meshing combines a solid prism into six faces');
prism.dispose();

// The left coarse cell contains x=14, but its detailed voxel ends at x=15.
// It cannot occlude the right record's x=16 face across the one-metre gap.
const seamScene = new THREE.Scene();
const seam = new DistantVoxelShell(seamScene, (x, y, z) => y === 12 && z === 0 && (x === 14 || x === 16) ? METAL : AIR,
  { sx: 32, sy: 16, sz: 16 });
const seamHit = () => {
  seam.mesh.updateMatrixWorld();
  return new THREE.Raycaster(new THREE.Vector3(15.5, 12.5, .5), new THREE.Vector3(1, 0, 0)).intersectObject(seam.mesh)[0];
};
assert.equal(seamHit()?.point.x, 16, 'coarse records retain their boundary face');
seam.syncChunks({ chunks: new Map([['0,0', {}]]) });
assert.equal(seamHit()?.point.x, 16, 'right shell has a west face when the left chunk switches to detailed voxels');
seam.syncChunks({ chunks: new Map() });
assert.equal(seamHit()?.point.x, 16, 'boundary face remains correct after detailed eviction');
seam.dispose();
console.log('Distant voxel shell fixture passed: open bridge, odd pole, terrain, normals, flat material colours, streaming, deltas, greedy merge and teardown.');

// --- The real Frontier v2 world, as worldview builds it (FarTerrain floor) -------------------
{
  const world = createMapState('frontier'), started = performance.now();
  const { sx, sy, sz } = world.dimensions;
  const profile = renderDistanceProfile('frontier', 'medium');
  const far = new FarTerrain(new THREE.Scene(), world.getBlock, world.dimensions, {
    step: profile.terrainStep, silhouetteStep: profile.silhouetteStep, groundHeight: world.meta.groundLevel,
  });
  const full = far.silhouette;
  const buildMs = performance.now() - started;
  assert.equal(full.stats.draws, 1);
  assert.equal(far.stats.draws, 2, 'far ground plus the voxel shell: two draws for the whole distant world');
  assert(full.stats.quads < 170000, `greedy Frontier shell geometry is bounded (${full.stats.quads} quads)`);
  const shellQuads = full.stats.quads, shellBytes = full.stats.bytes;
  assert(full.stats.bytes < 32 * 1024 * 1024, `shell CPU buffers ${(full.stats.bytes / 1048576).toFixed(1)} MiB stay below 32 MiB`);
  assert(full.stats.sampleReads <= sx * sz * (sy - full.groundHeight), 'initial scan reads each source voxel at most once');
  // Bulk terrain stays in the far mesh: ground under the shell floor is buried,
  // so no cell emits a bottom face or an underground side face against it.
  const normals = full.geometry.attributes.normal.array, positions = full.geometry.attributes.position.array;
  let down = 0, buriedFaces = 0;
  for (let v = 0; v < normals.length / 3; v += 4) {
    if (normals[v * 3 + 1] >= 0) continue;
    down++;
    // A downward face at the floor of its column would face buried ground.
    const x = Math.min(full.width - 1, Math.floor(Math.min(positions[v * 3], positions[(v + 2) * 3]) / full.step));
    const z = Math.min(full.depth - 1, Math.floor(Math.min(positions[v * 3 + 2], positions[(v + 2) * 3 + 2]) / full.step));
    if (positions[v * 3 + 1] <= full.floor[x + z * full.width]) buriedFaces++;
  }
  assert.equal(buriedFaces, 0, 'no face is emitted against buried terrain');
  assert(down < full.stats.quads * 0.06, `downward faces are only real undersides (${down} of ${full.stats.quads})`);
  // The same world without its natural ground: what is left is structures, trees and props.
  const floor = { width: full.width, depth: full.depth, heights: full.floor };
  const structuresOnly = new DistantVoxelShell(new THREE.Scene(), (x, y, z) => {
    const id = world.getBlock(x, y, z);
    return FAR_GROUND_IDS.has(id) ? AIR : id;
  }, world.dimensions, { step: profile.silhouetteStep, groundHeight: world.meta.groundLevel, floor });
  const terrainShare = 1 - structuresOnly.stats.quads / full.stats.quads;
  structuresOnly.dispose();
  assert(terrainShare < 0.7, `visible terrain surface is ${(terrainShare * 100).toFixed(0)} % of the shell`);
  // A shell hit on a Kessler Works chimney: the dirty chunk rebuilds within a frame budget.
  const modified = [];
  const chimney = world.meta.landmarks.find(mark => mark.kind === 'chimney');
  for (let z = Math.floor(chimney.z) - 3; z <= Math.floor(chimney.z) + 3; z++) for (let x = Math.floor(chimney.x) - 3; x <= Math.floor(chimney.x) + 3; x++) {
    for (let y = 50; y < 62; y++) {
      const id = world.getBlock(x, y, z);
      if (id !== AIR) { modified.push({ x, y, z, previous: id, id: AIR }); world.setBlock(x, y, z, AIR); }
    }
  }
  assert(modified.length > 20, 'the hit removes chimney voxels');
  full.applyDeltas(modified);
  const updateMs = [], mergesBefore = full.stats.merges;
  while (full.stats.dirty) { full.update(); updateMs.push(full.stats.lastUpdateMs); }
  assert(updateMs.length >= 1 && Math.max(...updateMs) < 10, `dirty chunk patch ${updateMs.map(ms => ms.toFixed(1)).join(', ')} ms`);
  assert.equal(full.stats.merges, mergesBefore, 'a chimney hit patches its records in place');
  const uploaded = full.geometry.attributes.position.updateRanges.reduce((sum, range) => sum + range.count, 0);
  assert(uploaded > 0 && uploaded < full.geometry.attributes.position.array.length * 0.05,
    `the hit uploads ${(uploaded / full.geometry.attributes.position.array.length * 100).toFixed(2)} % of the shell positions`);
  // Behind detailed chunks the same hit costs nothing until the chunk streams out.
  const chimneyKey = `${Math.floor(chimney.x / 16)},${Math.floor(chimney.z / 16)}`;
  full.syncChunks({ chunks: new Map([[chimneyKey, {}]]) });
  for (const delta of modified) world.setBlock(delta.x, delta.y, delta.z, delta.previous);
  full.applyDeltas(modified);
  const rebuildsHidden = full.stats.rebuilds;
  full.update();
  assert(full.stats.deferred >= 1, 'hidden records defer');
  for (let i = 0; i < 8; i++) full.update();
  full.syncChunks({ chunks: new Map() });
  assert.equal(full.stats.queued, 0, 'deferred records rebuild when shown');
  assert(full.stats.rebuilds > rebuildsHidden);
  far.dispose();
  console.log(`Frontier distant shell passed (${buildMs.toFixed(0)} ms): ${shellQuads} quads, ${(shellBytes / 1048576).toFixed(1)} MiB, `
    + `visible terrain surface ${(terrainShare * 100).toFixed(0)} % of quads, no buried faces, rebuild ${Math.max(...updateMs).toFixed(1)} ms.`);
}
