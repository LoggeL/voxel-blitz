import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ChunkStore } from '../public/js/engine/chunks.js';
import {
  DAMAGE_GRID, DAMAGE_THRESHOLDS, damageStage, damageCells, removedDamageCells,
} from '../public/js/engine/block-damage-geometry.js';
import { AIR, STONE, LEAVES, GLASS } from '../shared/worlddata.js';

const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const key = (x, y, z) => `${x},${y},${z}`;
const cellIndex = (x, y, z) => x + DAMAGE_GRID * (y + DAMAGE_GRID * z);
const remaining = [64, 59, 51, 41, 29, 18];
const atlas = {
  texture: () => null,
  faceTile: (id, face) => id * 6 + face,
  tileRect: () => ({ u0: 0.1, u1: 0.2, v0: 0.8, v1: 0.7 }),
};

assert.equal(damageStage(0), 0);
assert.equal(damageStage(0.001), 0, 'tiny hits retain the intact model');
assert.equal(damageStage(0.2), 1);
assert.equal(damageStage(0.201), 1);
for (const [index, threshold] of DAMAGE_THRESHOLDS.entries()) {
  assert.equal(damageStage(threshold - 0.000001), index, 'shape waits until the threshold');
  assert.equal(damageStage(threshold), index + 1);
}
assert.equal(damageStage(1), 5);
assert.equal(damageStage(2), 5);
for (const invalid of [-1, NaN, Infinity, undefined]) assert.equal(damageStage(invalid), 0);

const distinct = new Set();
for (let position = 0; position < 96; position++) {
  const previous = new Uint8Array(64).fill(1);
  for (let stage = 0; stage <= 5; stage++) {
    const cells = damageCells(position, 8, 7, stage);
    assert.equal(cells.reduce((sum, value) => sum + value, 0), remaining[stage]);
    assert.equal(cells, damageCells(position, 8, 7, stage), 'shapes are deterministic and cached');
    for (let i = 0; i < cells.length; i++) {
      assert.ok(!cells[i] || previous[i], 'erosion never restores detached pieces');
      previous[i] = cells[i];
    }
    const visited = new Set([cellIndex(1, 1, 1)]);
    const queue = [[1, 1, 1]];
    for (const [x, y, z] of queue) {
      for (const [dx, dy, dz] of normals) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if ([nx, ny, nz].some((value) => value < 0 || value >= DAMAGE_GRID)) continue;
        const next = cellIndex(nx, ny, nz);
        if (!cells[next] || visited.has(next)) continue;
        visited.add(next);
        queue.push([nx, ny, nz]);
      }
    }
    assert.equal(visited.size, remaining[stage], 'every remaining cell stays joined to the core');
    for (const x of [1, 2]) for (const y of [1, 2]) for (const z of [1, 2]) {
      assert.equal(cells[cellIndex(x, y, z)], 1, 'solid core stays present until destruction');
    }
    if (stage === 1) for (const n of normals) {
      const axis = n.findIndex((value) => value !== 0);
      const face = n[axis] > 0 ? 3 : 0;
      let missing = 0;
      for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        if ([x, y, z][axis] === face && !cells[cellIndex(x, y, z)]) missing++;
      }
      assert.ok(missing > 0, 'first damage stage is visible on every exposed face, including wall blocks');
    }
    if (stage === 3) distinct.add(cells.join(''));
  }
}
assert.ok(distinct.size > 20, 'block positions have varied fracture shapes');
assert.equal(removedDamageCells(8, 8, 8, 0, 0.199).length, 0, 'small hits detach no geometry');
assert.equal(removedDamageCells(8, 8, 8, 0.199, 0.2).length, 5);
assert.equal(removedDamageCells(8, 8, 8, 0.2, 0.3).length, 0, 'same stage produces no detached chips');
assert.equal(removedDamageCells(8, 8, 8, 0.2, 0.6).length, 18);
assert.equal(removedDamageCells(8, 8, 8, 0.6, 0.2).length, 0, 'repair produces no detached chips');

function faceKey(axis, sign, plane, u, v) { return `${axis}:${sign}:${plane}:${u}:${v}`; }

// Expand emitted quads into quarter-cell squares and compare the exact surface
// against a solid occupancy reference. This catches hidden faces, duplicate
// faces, missing cut walls, wrong winding and gaps next to intact neighbours.
function checkSurface(store, blocks, damage) {
  const occupied = new Set();
  for (const [blockKey, id] of blocks) {
    if (id === AIR) continue;
    const [wx, wy, wz] = blockKey.split(',').map(Number);
    const cells = damageCells(wx, wy, wz, damageStage(damage.get(blockKey) ?? 0));
    for (let z = 0; z < DAMAGE_GRID; z++) for (let y = 0; y < DAMAGE_GRID; y++) for (let x = 0; x < DAMAGE_GRID; x++) {
      if (cells[cellIndex(x, y, z)]) occupied.add(key(wx * 4 + x, wy * 4 + y, wz * 4 + z));
    }
  }
  const expected = new Set();
  for (const point of occupied) {
    const p = point.split(',').map(Number);
    for (const n of normals) {
      if (occupied.has(key(...p.map((value, axis) => value + n[axis])))) continue;
      const axis = n.findIndex((value) => value !== 0);
      const tangents = [0, 1, 2].filter((value) => value !== axis);
      expected.add(faceKey(axis, n[axis], p[axis] + Number(n[axis] > 0), p[tangents[0]], p[tangents[1]]));
    }
  }
  const actual = new Set();
  for (const mesh of store.group.children) {
    const geometry = mesh.geometry;
    const positions = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    for (let first = 0; first < positions.count; first += 4) {
      const n = [normal.getX(first), normal.getY(first), normal.getZ(first)];
      const axis = n.findIndex((value) => value !== 0);
      const tangents = [0, 1, 2].filter((value) => value !== axis);
      const corners = Array.from({ length: 4 }, (_, offset) =>
        [positions.getX(first + offset), positions.getY(first + offset), positions.getZ(first + offset)]
          .map((value) => value * 4));
      assert.ok(corners.flat().every(Number.isInteger), 'vertices align across chunk borders');
      const a = new THREE.Vector3(...corners[0]), b = new THREE.Vector3(...corners[1]);
      const c = new THREE.Vector3(...corners[2]);
      assert.ok(b.sub(a).cross(c.sub(a)).dot(new THREE.Vector3(...n)) > 0, 'cut walls face outwards');
      const minimum = tangents.map((tangent) => Math.min(...corners.map((p) => p[tangent])));
      const maximum = tangents.map((tangent) => Math.max(...corners.map((p) => p[tangent])));
      for (let u = minimum[0]; u < maximum[0]; u++) for (let v = minimum[1]; v < maximum[1]; v++) {
        const square = faceKey(axis, n[axis], corners[0][axis], u, v);
        assert.ok(!actual.has(square), `surface never overlaps itself: ${square}`);
        actual.add(square);
      }
    }
    for (const value of geometry.attributes.color.array) assert.ok(Number.isFinite(value) && value > 0);
    for (let i = 0; i < geometry.attributes.uv.count; i++) {
      assert.ok(geometry.attributes.uv.getX(i) >= 0.09999 && geometry.attributes.uv.getX(i) <= 0.20001);
      assert.ok(geometry.attributes.uv.getY(i) >= 0.69999 && geometry.attributes.uv.getY(i) <= 0.80001);
    }
  }
  assert.deepEqual(actual, expected, 'rendered surface exactly closes the remaining block volume');
}

function fixture(entries, damageEntries = []) {
  const blocks = new Map(entries.map(([position, id = STONE]) => [key(...position), id]));
  const damage = new Map(damageEntries.map(([position, progress]) => [key(...position), progress]));
  const store = new ChunkStore(new THREE.Scene(), atlas,
    (x, y, z) => blocks.get(key(x, y, z)) ?? AIR,
    (x, y, z) => damage.get(key(x, y, z)) ?? 0);
  const chunks = new Set(entries.map(([[x, , z]]) => `${x >> 4},${z >> 4}`));
  for (const chunk of chunks) store.rebuildChunk(...chunk.split(',').map(Number));
  return { store, blocks, damage };
}

for (const progress of [0, 0.001, 0.199, ...DAMAGE_THRESHOLDS]) {
  const f = fixture([[[8, 8, 8]]], [[[8, 8, 8], progress]]);
  checkSurface(f.store, f.blocks, f.damage);
  assert.equal(f.store.stats.meshes, 1, 'damage keeps the existing single material draw call');
  if (progress < 0.2) assert.equal(f.store.group.children[0].geometry.attributes.position.count, 24,
    'sub-threshold damage still renders the intact cube');
  f.store.dispose();
}

for (const n of normals) {
  // Both x and z chunk borders are exercised, in either adjacency direction.
  const a = [15, 8, 15], b = a.map((value, axis) => value + n[axis]);
  for (const neighbourDamage of [0, 0.5]) {
    const f = fixture([[a], [b]], [[a, 0.9], [b, neighbourDamage]]);
    checkSurface(f.store, f.blocks, f.damage);
    let disposed = 0;
    const meshCount = f.store.stats.meshes;
    for (const mesh of f.store.group.children) mesh.geometry.addEventListener('dispose', () => disposed++);
    f.damage.set(key(...a), 0.1);
    f.store.applyBlockDelta(...a, STONE);
    while (f.store.stats.queued) f.store.update();
    assert.equal(disposed, meshCount, 'stage changes dispose all affected chunk geometries');
    checkSurface(f.store, f.blocks, f.damage);
    assert.equal(f.blocks.get(key(...a)), STONE, 'rendering preserves authoritative voxel occupancy');
    f.store.dispose();
  }
}

for (const [id, bucket] of [[STONE, 'opaque'], [LEAVES, 'cutout'], [GLASS, 'glass']]) {
  const f = fixture([[[8, 8, 8], id]], [[[8, 8, 8], 0.7]]);
  assert.equal(f.store.group.children[0].name, bucket, 'damaged blocks keep their material bucket');
  checkSurface(f.store, f.blocks, f.damage);
  f.damage.clear();
  f.store.applyBlockDelta(8, 8, 8, id);
  f.store.update();
  assert.equal(f.store.group.children[0].geometry.attributes.position.count, 24, 'damage reset returns to cheap intact cube');
  f.store.dispose();
}

console.log('Block damage geometry: cumulative stages, connected cores, complete surfaces, chunk seams and disposal passed.');
