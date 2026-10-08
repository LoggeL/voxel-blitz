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

// ------------------------------------------------------------ map frames
// V3 frame (the wire format for clients that keep a map cache):
//   'VB', 3, kind, 8-byte template fingerprint, uint32 LE template length,
//   uint32 LE patch count, [template: a V1/V2 serialization of the map's
//   pristine voxels], then patch records (uint32 LE voxel index, uint8 block).
// kind 0 carries the template, kind 1 only names it: the client rebuilds the
// live world from its cached template plus the patch (every cell that differs
// from the template), so a rejoin moves a few bytes instead of the whole map.
export const MAP_FRAME_VERSION = 3;
export const MAP_FRAME_HEADER_BYTES = 20;
export const MAP_FRAME_TEMPLATE = 0;
export const MAP_FRAME_REFERENCE = 1;
const PATCH_RECORD_BYTES = 5;
/** Fingerprints travel as 16 lower-case hex characters. */
export const MAP_FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

/** Two independent 32-bit hashes (FNV-1a and a multiplicative one) over the bytes, as 16 hex chars. */
export function mapFingerprint(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('invalid map buffer');
  let a = 0x811c9dc5, b = 0x9e3779b9 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    a = Math.imul(a ^ v, 0x01000193);
    b = Math.imul(b ^ v, 0x5bd1e995); b ^= b >>> 15;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * Encode a V3 frame. `template` is the pristine serialization (included when
 * `includeTemplate`), `fingerprint` its mapFingerprint. The patch is either
 * `patch`, an iterable of [index, block] pairs, or `cells` (a Set of voxel
 * indices) read from `blocks`: the server's live path, written straight into
 * the frame without a temporary pair per cell.
 */
export function encodeMapFrame({ template, fingerprint, patch = [], cells = null, blocks = null, includeTemplate = true }) {
  if (!(template instanceof Uint8Array) || !MAP_FINGERPRINT_PATTERN.test(fingerprint)) throw new Error('invalid map frame');
  if (cells && !(blocks instanceof Uint8Array)) throw new Error('invalid map frame');
  const records = cells ? null : Array.isArray(patch) ? patch : [...patch];
  const count = cells ? cells.size : records.length;
  const templateLength = includeTemplate ? template.length : 0;
  const out = new Uint8Array(MAP_FRAME_HEADER_BYTES + templateLength + count * PATCH_RECORD_BYTES);
  const view = new DataView(out.buffer);
  out.set([86, 66, MAP_FRAME_VERSION, includeTemplate ? MAP_FRAME_TEMPLATE : MAP_FRAME_REFERENCE]);
  for (let i = 0; i < 8; i++) out[4 + i] = parseInt(fingerprint.slice(i * 2, i * 2 + 2), 16);
  view.setUint32(12, templateLength, true);
  view.setUint32(16, count, true);
  if (templateLength) out.set(template, MAP_FRAME_HEADER_BYTES);
  let offset = MAP_FRAME_HEADER_BYTES + templateLength;
  if (cells) {
    for (const index of cells) {
      view.setUint32(offset, index, true); out[offset + 4] = blocks[index];
      offset += PATCH_RECORD_BYTES;
    }
  } else {
    for (const [index, block] of records) {
      view.setUint32(offset, index, true); out[offset + 4] = block;
      offset += PATCH_RECORD_BYTES;
    }
  }
  return out;
}

/** True for a V3 map frame header (any kind). */
export function isMapFrame(buf) {
  return buf instanceof Uint8Array && buf.length >= MAP_FRAME_HEADER_BYTES
    && buf[0] === 86 && buf[1] === 66 && buf[2] === MAP_FRAME_VERSION;
}

/**
 * Split a V3 frame: { fingerprint, template (a subarray, or null for a
 * reference), patch (subarray of records), patchCount }. Throws on a
 * malformed frame; the template itself is validated when it is decoded.
 */
export function parseMapFrame(buf) {
  if (!isMapFrame(buf)) throw new Error('version mismatch');
  const kind = buf[3];
  if (kind !== MAP_FRAME_TEMPLATE && kind !== MAP_FRAME_REFERENCE) throw new Error('unsupported map frame');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let fingerprint = '';
  for (let i = 4; i < 12; i++) fingerprint += buf[i].toString(16).padStart(2, '0');
  const templateLength = view.getUint32(12, true), patchCount = view.getUint32(16, true);
  if ((kind === MAP_FRAME_REFERENCE) !== (templateLength === 0)
    || buf.length !== MAP_FRAME_HEADER_BYTES + templateLength + patchCount * PATCH_RECORD_BYTES) {
    throw new Error('map length mismatch');
  }
  const template = templateLength ? buf.subarray(MAP_FRAME_HEADER_BYTES, MAP_FRAME_HEADER_BYTES + templateLength) : null;
  const patch = buf.subarray(MAP_FRAME_HEADER_BYTES + templateLength);
  return { fingerprint, template, patch, patchCount };
}

/** Write patch records into decoded voxels (bounds-checked). Returns the records applied. */
export function applyMapPatch(blocks, patch) {
  if (!(patch instanceof Uint8Array) || patch.length % PATCH_RECORD_BYTES) throw new Error('invalid map patch');
  const view = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
  for (let offset = 0; offset < patch.length; offset += PATCH_RECORD_BYTES) {
    const index = view.getUint32(offset, true);
    if (index >= blocks.length) throw new Error('invalid map patch');
    blocks[index] = patch[offset + 4];
  }
  return patch.length / PATCH_RECORD_BYTES;
}

/**
 * Decode any map frame to voxels. V1/V2 bytes decode as before; a V3 frame
 * takes its template from the frame or from `resolveTemplate(fingerprint)`
 * (the client's cache) and applies its patch.
 */
export function decodeMapFrame(buf, { expected = null, resolveTemplate = null } = {}) {
  if (!isMapFrame(buf)) return { ...deserializeBlocks(buf, expected), fingerprint: null, template: null };
  const frame = parseMapFrame(buf);
  const template = frame.template || resolveTemplate?.(frame.fingerprint) || null;
  if (!template) throw new Error('map template unavailable');
  const decoded = deserializeBlocks(template, expected);
  applyMapPatch(decoded.blocks, frame.patch);
  return { ...decoded, fingerprint: frame.fingerprint, template };
}
