import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as THREE from '../public/js/vendor/three.module.js';
import { ChunkStore } from '../public/js/engine/chunks.js';
import { AIR, STONE, GRASS, LEAVES, GLASS, MC_WATER } from '../shared/worlddata.js';

const dimensions = { sx: 32, sy: 24, sz: 32 };
const index = (x, y, z) => x + dimensions.sx * (z + dimensions.sz * y);
const atlas = {
  texture: () => null,
  faceTile: (id, face) => id * 6 + face,
  tileRect: () => ({ u0: 0.1, u1: 0.2, v0: 0.8, v1: 0.7 }),
};
// Captured from the pre-optimization mesher, including colours and atlas UVs.
const expected = {
  'intact-floor': { hash: '18bfe1b021e2e0898a3e2233ddb11bd9dc0cd38f7ecac5ab690cf522f807c0b6', vertices: 3200, meshes: 1 },
  'chipped-floor': { hash: 'e5f8ddfe055bfd6f85ebf15d1c52d83dc4892176910a60aebbf619211f6e1427', vertices: 89624, meshes: 1 },
  'mixed-materials': { hash: '55c4bb1eb58c31f9c018b38114a251ee3e575fcf9af0616d64b708c576edb468', vertices: 24552, meshes: 4 },
};

function makeFixture(kind) {
  const blocks = new Uint8Array(dimensions.sx * dimensions.sy * dimensions.sz);
  const damage = new Float32Array(blocks.length);
  for (let z = 0; z <= 16; z++) for (let x = 0; x <= 16; x++) {
    blocks[index(x, 3, z)] = kind === 'chipped-floor' ? STONE : GRASS;
    if (kind === 'chipped-floor') damage[index(x, 3, z)] = [0.25, 0.65, 0.9][(x + z) % 3];
    if (x % 4 === 0 && z % 4 === 0) {
      for (let y = 4; y < 8; y++) {
        blocks[index(x, y, z)] = kind === 'mixed-materials'
          ? [STONE, LEAVES, GLASS, MC_WATER][y - 4] : STONE;
        if (kind !== 'intact-floor') damage[index(x, y, z)] = 0.65;
      }
    }
  }
  const inRange = (x, y, z) => x >= 0 && y >= 0 && z >= 0
    && x < dimensions.sx && y < dimensions.sy && z < dimensions.sz;
  return new ChunkStore(new THREE.Scene(), atlas,
    (x, y, z) => inRange(x, y, z) ? blocks[index(x, y, z)] : AIR,
    (x, y, z) => inRange(x, y, z) ? damage[index(x, y, z)] : 0,
    dimensions);
}

function geometryFingerprint(store) {
  const hash = createHash('sha256');
  let vertices = 0;
  for (const mesh of store.group.children) {
    hash.update(mesh.name);
    const geometry = mesh.geometry;
    vertices += geometry.attributes.position.count;
    for (const name of Object.keys(geometry.attributes).sort()) {
      const attribute = geometry.attributes[name];
      hash.update(name);
      hash.update(Buffer.from(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength));
    }
    hash.update(Buffer.from(geometry.index.array.buffer));
  }
  return { hash: hash.digest('hex'), vertices, meshes: store.stats.meshes };
}

// Timings are diagnostic: CI load must never turn a correct mesh into a failure.
const repetitions = Math.max(1, Math.min(1000, Math.floor(Number(process.env.VB_MESH_BENCH_REPEATS) || 24)));
for (const kind of ['intact-floor', 'chipped-floor', 'mixed-materials']) {
  const store = makeFixture(kind);
  try {
    for (let run = 0; run < 8; run++) store.rebuildChunk(0, 0);
    const fingerprint = geometryFingerprint(store);
    assert.deepEqual(fingerprint, expected[kind], `${kind}: optimization preserves all original mesh bytes`);
    const samples = [];
    for (let run = 0; run < repetitions; run++) {
      const start = performance.now();
      store.rebuildChunk(0, 0);
      samples.push(performance.now() - start);
    }
    assert.deepEqual(geometryFingerprint(store), fingerprint, `${kind}: rebuilds preserve every attribute`);
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ kind, ...fingerprint, repetitions,
      medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
      p95Ms: Number(samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))].toFixed(3)),
    }));
  } finally {
    store.dispose();
  }
}
