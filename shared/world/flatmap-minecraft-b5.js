import { AIR } from './blocks.js';
import { MINECRAFT_B5_DIMENSIONS, MINECRAFT_B5_RLE } from './minecraft-b5-data.js';

/**
 * MINECRAFT B5 is compiled from ttt_minecraft_b5.bsp by
 * tools/compile-minecraft-b5-reference.py at one Source block per voxel. The
 * island, the ocean around it, the Nether below it and the clouds above it all
 * come from those bytes; simulation and rendering share them unchanged.
 */
export function generateMinecraftB5Into(world, blocks, heights) {
  const { sx, sy, sz } = world.dimensions;
  const expected = MINECRAFT_B5_DIMENSIONS;
  if (sx !== expected.sx || sy !== expected.sy || sz !== expected.sz) {
    throw new Error('Minecraft B5 data dimensions mismatch');
  }
  blocks.fill(AIR);
  heights.fill(-1);
  const rle = atob(MINECRAFT_B5_RLE);
  let cursor = 0;
  for (let i = 0; i < rle.length; i += 3) {
    const count = rle.charCodeAt(i) | (rle.charCodeAt(i + 1) << 8);
    const type = rle.charCodeAt(i + 2);
    if (type !== AIR) blocks.fill(type, cursor, cursor + count);
    cursor += count;
  }
  if (cursor !== sx * sy * sz) throw new Error('Invalid Minecraft B5 voxel data');
}
