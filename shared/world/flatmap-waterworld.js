import { AIR } from './blocks.js';
import { WATERWORLD_DIMENSIONS, WATERWORLD_RLE } from './waterworld-data.js';

/**
 * WATERWORLD is compiled from ttt_waterworld.bsp (Leith Waterworld) by
 * tools/compile-waterworld-reference.py at 32 Source units per voxel. The
 * pool hall, its pools, flumes, changing rooms, cafe mezzanine, traitor room
 * and the glass-roofed foyer all come from those bytes; simulation and
 * rendering share them unchanged.
 */
export function generateWaterworldInto(world, blocks, heights) {
  const { sx, sy, sz } = world.dimensions;
  const expected = WATERWORLD_DIMENSIONS;
  if (sx !== expected.sx || sy !== expected.sy || sz !== expected.sz) {
    throw new Error('Waterworld data dimensions mismatch');
  }
  blocks.fill(AIR);
  heights.fill(-1);
  const rle = atob(WATERWORLD_RLE);
  let cursor = 0;
  for (let i = 0; i < rle.length; i += 3) {
    const count = rle.charCodeAt(i) | (rle.charCodeAt(i + 1) << 8);
    const type = rle.charCodeAt(i + 2);
    if (type !== AIR) blocks.fill(type, cursor, cursor + count);
    cursor += count;
  }
  if (cursor !== sx * sy * sz) throw new Error('Invalid Waterworld voxel data');
}
