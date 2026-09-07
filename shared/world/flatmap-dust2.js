import { AIR, DUST_FLOOR, DUST_ROCK, DUST_WOOD, SX, SY, SZ, idx } from './blocks.js';
import { DUST2_REFERENCE_RLE } from './dust2-reference-data.js';
import { DUST2_NAV_FLOORS, dust2SourceToWorld } from './dust2-layout.js';

/** Original CS:GO brush/displacement geometry, quantized uniformly at 48 units.
 * Both rendering and combat use these same bytes. See docs/maps/dust2.md.
 */
export function generateDust2Into(world, blocks, heights) {
  const rle = atob(DUST2_REFERENCE_RLE);
  let cursor = 0;
  for (let i = 0; i < rle.length; i += 3) {
    const count = rle.charCodeAt(i) | (rle.charCodeAt(i + 1) << 8);
    blocks.fill(rle.charCodeAt(i + 2), cursor, cursor + count);
    cursor += count;
  }
  if (cursor !== SX * SY * SZ) throw new Error('Invalid Dust 2 reference geometry');

  // The three characteristic double-door sets are static models in Source.
  // Their original origins/orientations are retained in voxel timber leaves.
  door(-416, 1624, -131, 0);
  door(-1320, 2205, 0, 90);
  door(641, 298, -2, 0);
  door(640, 746, -2, 0);

  // Preserve true walkable levels where a coarse surface voxel intersects a
  // player's head. In particular, do not flatten the upper A / lower CT stack.
  const lowest = new Map();
  for (let i = 0; i < DUST2_NAV_FLOORS.length; i += 3) {
    const [x, z, y] = DUST2_NAV_FLOORS.slice(i, i + 3);
    const key = z * SX + x;
    lowest.set(key, Math.min(lowest.get(key) ?? SY, y));
  }
  for (const [key, floor] of lowest) {
    const x = key % SX, z = Math.floor(key / SX);
    for (let y = 9; y < floor; y++) if (blocks[idx(x,y,z)] === AIR) blocks[idx(x,y,z)] = DUST_ROCK;
  }
  // All clearances first, then all surfaces: overlapping navigation rectangles
  // may describe the same stair at neighboring quantized heights.
  for (let i = 0; i < DUST2_NAV_FLOORS.length; i += 3) {
    const x = DUST2_NAV_FLOORS[i], z = DUST2_NAV_FLOORS[i + 1], y = DUST2_NAV_FLOORS[i + 2];
    blocks[idx(x,y+1,z)] = AIR;
    blocks[idx(x,y+2,z)] = AIR;
  }
  for (let i = 0; i < DUST2_NAV_FLOORS.length; i += 3) {
    const x = DUST2_NAV_FLOORS[i], z = DUST2_NAV_FLOORS[i + 1], y = DUST2_NAV_FLOORS[i + 2];
    blocks[idx(x,y,z)] = DUST_FLOOR;
  }
  removeFloatingFragments(blocks);
  // Heights are rebuilt by templates after every generated map.
  heights.fill(0);

  function door(sx, sy, sz, yaw) {
    const angle = yaw * Math.PI / 180;
    const base = dust2SourceToWorld(sx, sy, sz);
    for (const side of [-1, 1]) for (let along = 38; along <= 113; along += 16) {
      const ox = side * along, oy = side * (along - 38) * .36;
      const point = dust2SourceToWorld(sx + ox * Math.cos(angle) - oy * Math.sin(angle),
        sy + ox * Math.sin(angle) + oy * Math.cos(angle), sz);
      const x = Math.floor(point.x), z = Math.floor(point.z);
      for (let y = base.floorY + 1; y <= base.floorY + 3; y++) blocks[idx(x,y,z)] = DUST_WOOD;
    }
  }
}

// Model skins and thin decorative Source meshes can quantize to disconnected
// fragments. Retain only masonry/props physically attached to the map's base.
function removeFloatingFragments(blocks) {
  const connected = new Uint8Array(blocks.length);
  const queue = new Uint32Array(blocks.length);
  let read = 0, write = 0;
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const i = idx(x, 8, z);
    connected[i] = 1;
    queue[write++] = i;
  }
  while (read < write) {
    const i = queue[read++], x = i % SX, z = Math.floor(i / SX) % SZ, y = Math.floor(i / (SX * SZ));
    if (x > 0) visit(i - 1);
    if (x < SX - 1) visit(i + 1);
    if (z > 0) visit(i - SX);
    if (z < SZ - 1) visit(i + SX);
    if (y > 0) visit(i - SX * SZ);
    if (y < SY - 1) visit(i + SX * SZ);
  }
  for (let i = 0; i < blocks.length; i++) if (!connected[i]) blocks[i] = AIR;
  function visit(i) {
    if (!connected[i] && blocks[i] !== AIR) {
      connected[i] = 1;
      queue[write++] = i;
    }
  }
}
