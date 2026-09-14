import { AIR, SX, SY, SZ } from './blocks.js';
import { generateFlatBase } from './flatmaps.js';
import { SUBSTATION_DIMENSIONS, SUBSTATION_RLE } from './substation-data.js';

/**
 * SUBSTATION is authored in Blender (tools/blender/substation/build-substation.py)
 * and voxelised into shared/world/substation-data.js at build time. The engine
 * base supplies the sub-floor stone and the containment shell; every authored
 * non-air cell overlays it, so simulation and rendering share these bytes.
 */
export function generateSubstationInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  const { sx, sy, sz } = SUBSTATION_DIMENSIONS;
  if (sx !== SX || sy !== SY || sz !== SZ) throw new Error('Substation data dimensions mismatch');
  const rle = atob(SUBSTATION_RLE);
  let cursor = 0;
  for (let i = 0; i < rle.length; i += 3) {
    const count = rle.charCodeAt(i) | (rle.charCodeAt(i + 1) << 8);
    const type = rle.charCodeAt(i + 2);
    if (type !== AIR) blocks.fill(type, cursor, cursor + count);
    cursor += count;
  }
  if (cursor !== SX * SY * SZ) throw new Error('Invalid Substation voxel data');
}
