import { AIR, SX, SY, SZ, idx } from './blocks.js';

export const MAP_VERSION = 1;
export const MAP_HEADER_BYTES = 6;
export const MAP_BYTES = MAP_HEADER_BYTES + SX * SY * SZ;

/** Serialize blocks as 'VB', version, dimensions, then raw idx-layout bytes. */
export function serializeBlocks(blocks) {
  const out = new Uint8Array(MAP_BYTES);
  out[0] = 86;
  out[1] = 66;
  out[2] = MAP_VERSION;
  out[3] = SX;
  out[4] = SZ;
  out[5] = SY;
  out.set(blocks, MAP_HEADER_BYTES);
  return out;
}

export function validateSerializedWorld(buf) {
  if (!buf || typeof buf.length !== 'number') throw new Error('invalid map buffer');
  if (buf.length !== MAP_BYTES) throw new Error('map length mismatch');
  if (buf[0] !== 86 || buf[1] !== 66) throw new Error('bad magic');
  if (buf[2] !== MAP_VERSION) throw new Error('version mismatch');
  if (buf[3] !== SX || buf[4] !== SZ || buf[5] !== SY) throw new Error('dim mismatch');
}

export function rebuildHeights(blocks, heights) {
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      let top = -1;
      for (let y = SY - 1; y >= 0; y--) {
        if (blocks[idx(x, y, z)] !== AIR) {
          top = y;
          break;
        }
      }
      heights[z * SX + x] = top;
    }
  }
}
