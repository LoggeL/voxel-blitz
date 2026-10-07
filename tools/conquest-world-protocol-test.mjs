import assert from 'node:assert/strict';
import { DEFAULT_DIMENSIONS, FRONTIER_DIMENSIONS } from '../shared/world/dimensions.js';
import { createMapState } from '../shared/world/templates.js';
import { serializeBlocks, deserializeBlocks, validateSerializedWorld, MAP_V2_HEADER_BYTES } from '../shared/world/serialize.js';
import { KillcamTerrain } from '../public/js/player/killcam-terrain.js';

const legacy = new Uint8Array(DEFAULT_DIMENSIONS.sx * DEFAULT_DIMENSIONS.sy * DEFAULT_DIMENSIONS.sz);
legacy[100] = 7;
const v1 = serializeBlocks(legacy);
assert.equal(v1[2], 1);
assert.deepEqual(deserializeBlocks(v1).blocks, legacy);
assert.equal(new KillcamTerrain(v1).blocks[100], 7);

// Frontier v2 needs the V2 header: every axis is above the V1 uint8 limit or 80 tall.
const dimensions = FRONTIER_DIMENSIONS;
assert.deepEqual(dimensions, { sx: 768, sy: 80, sz: 768 });
const blocks = new Uint8Array(dimensions.sx * dimensions.sy * dimensions.sz);
const empty = serializeBlocks(blocks, dimensions);
assert.equal(empty.length, MAP_V2_HEADER_BYTES + 5);
assert.deepEqual(deserializeBlocks(empty, dimensions).blocks, blocks);
// Representative layered terrain with sparse structures across the large footprint.
blocks.fill(3, 0, dimensions.sx * dimensions.sz * 5);
blocks.fill(2, dimensions.sx * dimensions.sz * 5, dimensions.sx * dimensions.sz * 7);
for (let i = 0; i < 3000; i++) blocks[dimensions.sx * dimensions.sz * 8 + i * 97] = 7;
const terrain = serializeBlocks(blocks, dimensions);
assert.equal(terrain[2], 2);
assert.equal(terrain[3], 1);
assert.deepEqual(validateSerializedWorld(terrain, dimensions), dimensions);
assert.deepEqual(deserializeBlocks(terrain, dimensions).blocks, blocks);
assert.ok(terrain.length < 100000, `terrain payload ${terrain.length}`);
assert.equal(new KillcamTerrain(terrain).blocks.length, blocks.length);
for (const length of [0, 2, 6, 13, terrain.length - 1]) {
  assert.throws(() => deserializeBlocks(terrain.subarray(0, length)));
}
for (const mutate of [
  bytes => { bytes[0] = 0; },
  bytes => { bytes[2] = 9; },
  bytes => { bytes[3] = 9; },
  bytes => { new DataView(bytes.buffer).setUint16(4, 65535, true); },
  bytes => { new DataView(bytes.buffer).setUint32(10, 0xffffffff, true); },
  bytes => { new DataView(bytes.buffer).setUint32(14, 0, true); },
  bytes => { new DataView(bytes.buffer).setUint32(14, 0xffffffff, true); },
  bytes => { new DataView(bytes.buffer).setUint32(14, 1, true); },
]) {
  const malformed = terrain.slice(); mutate(malformed);
  assert.throws(() => deserializeBlocks(malformed));
}
assert.throws(() => deserializeBlocks(terrain, DEFAULT_DIMENSIONS));
// The real Frontier world: run-length payload within the 3.0 MB budget, exact decode.
const frontier = createMapState('frontier');
const frontierBytes = frontier.serializeWorld();
assert.equal(frontierBytes[2], 2); assert.equal(frontierBytes[3], 1, 'Frontier ships run-length records');
assert.ok(frontierBytes.length <= 3 * 1024 * 1024, `Frontier payload ${frontierBytes.length}`);
assert.deepEqual(validateSerializedWorld(frontierBytes, dimensions), { sx: 768, sz: 768, sy: 80 });
const decoded = new KillcamTerrain(frontierBytes).blocks;
assert.equal(decoded.length, dimensions.sx * dimensions.sy * dimensions.sz);
for (const [x, y, z] of [[384, 25, 384], [261, 78, 546], [72, 36, 384], [700, 60, 20]]) {
  assert.equal(decoded[(y * dimensions.sz + z) * dimensions.sx + x], frontier.getBlock(x, y, z), `client decode ${x},${y},${z}`);
}
assert.throws(() => serializeBlocks(new Uint8Array(1), { sx: 2048, sy: 2048, sz: 2048 }));
// Incompressible maps use bounded raw codec rather than expanded run records.
const noisy = Uint8Array.from({ length: 256 }, (_, i) => i % 2);
const raw = serializeBlocks(noisy, { sx: 256, sy: 1, sz: 1 });
assert.equal(raw[3], 0);
assert.deepEqual(deserializeBlocks(raw).blocks, noisy);
// Buffer/subarray inputs preserve byte offsets when reading uint16/uint32 values.
const padded = new Uint8Array(terrain.length + 9); padded.set(terrain, 9);
assert.deepEqual(validateSerializedWorld(padded.subarray(9)), dimensions);
console.log(`Conquest world protocol passed: empty ${empty.length} bytes, representative terrain ${terrain.length} bytes, Frontier ${frontierBytes.length} bytes, decoded ${blocks.length} bytes`);
