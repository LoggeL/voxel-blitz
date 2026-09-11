import { AIR, SX, SY, SZ } from './blocks.js';
import { DEFAULT_DIMENSIONS, LARGE_DIMENSIONS } from './dimensions.js';

const MAP_VERSION = 1;
export const MAP_HEADER_BYTES = 6;
export const MAP_BYTES = MAP_HEADER_BYTES + SX * SY * SZ;

/** Serialize blocks as 'VB', version, dimensions, then raw y/z/x bytes. */
export function serializeBlocks(blocks, dimensions = DEFAULT_DIMENSIONS) {
  const { sx, sy, sz } = dimensions;
  if (blocks.length !== sx * sy * sz) throw new Error('map length mismatch');
  const out = new Uint8Array(MAP_HEADER_BYTES + blocks.length);
  out.set([86, 66, MAP_VERSION, sx, sz, sy]);
  out.set(blocks, MAP_HEADER_BYTES);
  return out;
}

export function validateSerializedWorld(buf, expected = null) {
  if (!buf || typeof buf.length !== 'number') throw new Error('invalid map buffer');
  if (buf[0] !== 86 || buf[1] !== 66) throw new Error('bad magic');
  if (buf[2] !== MAP_VERSION) throw new Error('version mismatch');
  const dimensions = [DEFAULT_DIMENSIONS, LARGE_DIMENSIONS].find(({ sx, sy, sz }) =>
    buf[3] === sx && buf[4] === sz && buf[5] === sy);
  if (!dimensions || (expected && (expected.sx !== dimensions.sx
    || expected.sy !== dimensions.sy || expected.sz !== dimensions.sz))) throw new Error('dim mismatch');
  if (buf.length !== MAP_HEADER_BYTES + dimensions.sx * dimensions.sy * dimensions.sz) {
    throw new Error('map length mismatch');
  }
  return dimensions;
}

export function rebuildHeights(blocks, heights, dimensions = DEFAULT_DIMENSIONS) {
  const { sx, sy, sz } = dimensions;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      let top = -1;
      for (let y = sy - 1; y >= 0; y--) {
        if (blocks[(y * sz + z) * sx + x] !== AIR) { top = y; break; }
      }
      heights[z * sx + x] = top;
    }
  }
}
