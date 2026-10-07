import { AIR } from './blocks.js';
import { DEFAULT_DIMENSIONS, KNOWN_DIMENSIONS } from './dimensions.js';

// V1: VB, version, uint8 sx/sz/sy, raw y/z/x bytes.
export const MAP_HEADER_BYTES = 6;
// V2: VB, version, codec, uint16 LE sx/sz/sy, uint32 LE payload length.
// Codec 0 is raw; codec 1 is (uint32 LE run length, uint8 block) records.
export const MAP_V2_HEADER_BYTES = 14;
export const MAX_MAP_VOXELS = 64 * 1024 * 1024;
const MAX_AXIS = 2048;

function checkedVolume({ sx, sy, sz }) {
  if (![sx, sy, sz].every(n => Number.isInteger(n) && n > 0 && n <= MAX_AXIS)
    || sx * sy * sz > MAX_MAP_VOXELS) throw new Error('dim mismatch');
  return sx * sy * sz;
}

export function serializeBlocks(blocks, dimensions = DEFAULT_DIMENSIONS) {
  const { sx, sy, sz } = dimensions;
  const volume = checkedVolume(dimensions);
  if (!(blocks instanceof Uint8Array) || blocks.length !== volume) throw new Error('map length mismatch');
  if (sx <= 255 && sy <= 255 && sz <= 255) {
    const out = new Uint8Array(MAP_HEADER_BYTES + volume);
    out.set([86, 66, 1, sx, sz, sy]);
    out.set(blocks, MAP_HEADER_BYTES);
    return out;
  }
  let runs = 1;
  for (let i = 1; i < volume; i++) if (blocks[i] !== blocks[i - 1]) runs++;
  const codec = runs * 5 < volume ? 1 : 0;
  const payloadLength = codec ? runs * 5 : volume;
  const out = new Uint8Array(MAP_V2_HEADER_BYTES + payloadLength);
  const view = new DataView(out.buffer);
  out.set([86, 66, 2, codec]);
  view.setUint16(4, sx, true); view.setUint16(6, sz, true); view.setUint16(8, sy, true);
  view.setUint32(10, payloadLength, true);
  if (!codec) out.set(blocks, MAP_V2_HEADER_BYTES);
  else {
    let offset = MAP_V2_HEADER_BYTES;
    for (let start = 0; start < volume;) {
      let end = start + 1;
      while (end < volume && blocks[end] === blocks[start]) end++;
      view.setUint32(offset, end - start, true); out[offset + 4] = blocks[start];
      offset += 5; start = end;
    }
  }
  return out;
}

function inspectMap(buf, expected) {
  if (!(buf instanceof Uint8Array)) throw new Error('invalid map buffer');
  if (buf.length < MAP_HEADER_BYTES) throw new Error('map length mismatch');
  if (buf[0] !== 86 || buf[1] !== 66) throw new Error('bad magic');
  let dimensions, volume, codec = 0, header = MAP_HEADER_BYTES;
  if (buf[2] === 1) {
    dimensions = KNOWN_DIMENSIONS.find(({ sx, sy, sz }) => buf[3] === sx && buf[4] === sz && buf[5] === sy);
    if (!dimensions) throw new Error('dim mismatch');
    volume = checkedVolume(dimensions);
    if (buf.length !== header + volume) throw new Error('map length mismatch');
  } else if (buf[2] === 2) {
    header = MAP_V2_HEADER_BYTES;
    if (buf.length < header) throw new Error('map length mismatch');
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    dimensions = { sx: view.getUint16(4, true), sz: view.getUint16(6, true), sy: view.getUint16(8, true) };
    volume = checkedVolume(dimensions);
    codec = buf[3];
    const payloadLength = view.getUint32(10, true);
    if (payloadLength > volume || buf.length !== header + payloadLength) throw new Error('map length mismatch');
    if (codec === 0) {
      if (payloadLength !== volume) throw new Error('map length mismatch');
    } else if (codec === 1) {
      if (!payloadLength || payloadLength % 5) throw new Error('invalid map runs');
      let decoded = 0;
      for (let offset = header; offset < buf.length; offset += 5) {
        const count = view.getUint32(offset, true);
        if (!count || count > volume - decoded) throw new Error('invalid map runs');
        decoded += count;
      }
      if (decoded !== volume) throw new Error('map length mismatch');
    } else throw new Error('unsupported map codec');
  } else throw new Error('version mismatch');
  if (expected && (expected.sx !== dimensions.sx || expected.sy !== dimensions.sy || expected.sz !== dimensions.sz)) {
    throw new Error('dim mismatch');
  }
  return { dimensions, volume, codec, header };
}

export function validateSerializedWorld(buf, expected = null) {
  return inspectMap(buf, expected).dimensions;
}

/** Validate the complete wire payload before allocating its bounded world copy. */
export function deserializeBlocks(buf, expected = null) {
  const { dimensions, volume, codec, header } = inspectMap(buf, expected);
  if (!codec) return { dimensions, blocks: Uint8Array.from(buf.subarray(header)) };
  const blocks = new Uint8Array(volume);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let index = 0;
  for (let offset = header; offset < buf.length; offset += 5) {
    const count = view.getUint32(offset, true);
    blocks.fill(buf[offset + 4], index, index + count);
    index += count;
  }
  return { dimensions, blocks };
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
