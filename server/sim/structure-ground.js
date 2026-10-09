// Natural ground of a map (docs/structural-physics.md, "Anchors").
//
// Ground materials (STRUCTURE_GROUND: stone, dirt, sand, rock, ...) are
// anchors only where they form the map's natural ground mass. The same
// materials used as building material (a stone wall, a sandbag line, a
// lighthouse lantern, a dirt bunker) are "demoted": they are structural
// masonry like any other block, so they need support and fall.
//
// A ground cell is natural when both hold:
//   1. a horizontal `plate` x `plate` square of ground cells at its height
//      covers it (a 2D morphological opening per layer). Terrain is wide at
//      every height (a hill's cross-section is a blob), walls and pillars are
//      thinner than the plate, so they drop out here;
//   2. its 6-connected component among the cells kept by (1) touches the
//      bottom layers (y <= 1) or holds at least `minComponent` cells, so
//      wide slabs (stone roofs and floors held up by demoted walls) and
//      small detached solids (the lighthouse top) drop out too, while
//      floating islands (Minecraft B5's island over the Nether) stay.
// Every other ground cell is demoted. The result is a sparse bitmap over the
// support field's 8^3 chunks (64 bytes per chunk holding a demoted cell).
import { STRUCTURE_KIND as KIND } from '../../shared/structure.js';
import { BEDROCK } from '../../shared/world/blocks.js';

export const GROUND_RULES = Object.freeze({
  /** Side of the horizontal square a natural ground cell must lie in. */
  plate: 5,
  /** Detached plate-wide ground components smaller than this are building material. */
  minComponent: 2048,
});

/** Rows processed between the yields of a stepwise labeling. */
export const ROWS_PER_YIELD = 256;

// Bitsets hold one row (y, z) per `W` 32-bit words; cell (x, y, z) is bit
// p = ((y * sz + z) * W << 5) + x. The hot loops live in plain functions (not
// the generator) so V8 optimizes them fully; they work on whole words so
// solid ground and open air cost a word operation per 32 cells.
const has = (bits, p) => (bits[p >>> 5] >>> (p & 31)) & 1;
const set = (bits, p) => { bits[p >>> 5] |= 1 << (p & 31); };

/** Spread `s` (a subset of `o`) towards higher bits through runs of `o` (occluded fill). */
function fillUp(s, o) {
  let g = o;
  s |= g & (s << 1); g &= g << 1;
  s |= g & (s << 2); g &= g << 2;
  s |= g & (s << 4); g &= g << 4;
  s |= g & (s << 8); g &= g << 8;
  s |= g & (s << 16);
  return s;
}
/** `fillUp` towards lower bits. */
function fillDown(s, o) {
  let g = o;
  s |= g & (s >>> 1); g &= g >>> 1;
  s |= g & (s >>> 2); g &= g >>> 2;
  s |= g & (s >>> 4); g &= g >>> 4;
  s |= g & (s >>> 8); g &= g >>> 8;
  s |= g & (s >>> 16);
  return s;
}

/**
 * Scan rows [r0, r1) (row r = y * sz + z) of the voxels into the ground
 * bitset (bedrock is natural and kept outright). With `cells`
 * ({ keys: Int32Array, count }), the packed keys of structural cells above
 * bedrock are appended too (in key order), so the support build reads every
 * voxel once.
 */
export function scanRows(L, r0, r1, cells = null) {
  const { sx, sz, W, raw, blockAt, ground, open, natural } = L;
  for (let r = r0; r < r1; r++) {
    const z = r % sz, y = (r - z) / sz, base = r * sx, word0 = r * W, keyBase = (y << 20) | (z << 10);
    for (let w = 0; w < W; w++) {
      let bits = 0, rock = 0;
      for (let x = w << 5, end = Math.min(sx, x + 32), bit = 0; x < end; x++, bit++) {
        const type = (raw ? raw[base + x] : blockAt(x, y, z)) & 255, kind = KIND[type];
        if (kind === 1) {
          bits |= 1 << bit;
          if (type === BEDROCK) rock |= 1 << bit;
        } else if (kind === 2 && cells !== null && y > 0) {
          if (cells.count === cells.keys.length) { const next = new Int32Array(cells.keys.length * 2); next.set(cells.keys); cells.keys = next; }
          cells.keys[cells.count++] = keyBase | x;
        }
      }
      ground[word0 + w] = bits;
      if (rock) { open[word0 + w] |= rock; natural[word0 + w] |= rock; }
    }
  }
}

/** Plate opening of layer y: ground cells some k x k ground square at their height covers. */
function openLayer(L, y) {
  const { sz, W, k, ground, open, a, b, lastMask } = L, base = y * sz * W;
  // Erode along x: a = cells x with [x, x + k) ground.
  for (let z = 0; z < sz; z++) {
    const row = base + z * W, out = z * W;
    for (let w = 0; w < W; w++) {
      const g = ground[row + w], next = w + 1 < W ? ground[row + w + 1] : 0;
      let e = g;
      for (let j = 1; j < k && e; j++) e &= (g >>> j) | (next << (32 - j));
      a[out + w] = e;
    }
  }
  // Erode along z: b = squares [x, x + k) x [z, z + k) of ground.
  for (let z = 0; z < sz; z++) {
    for (let w = 0; w < W; w++) {
      let e = a[z * W + w];
      for (let j = 1; j < k && e; j++) e = z + j < sz ? e & a[(z + j) * W + w] : 0;
      b[z * W + w] = e;
    }
  }
  // Dilate along z (into a), then along x: every cell such a square covers.
  for (let z = 0; z < sz; z++) {
    for (let w = 0; w < W; w++) {
      let d = b[z * W + w];
      for (let j = 1; j < k && z - j >= 0; j++) d |= b[(z - j) * W + w];
      a[z * W + w] = d;
    }
  }
  for (let z = 0; z < sz; z++) {
    const row = base + z * W, src = z * W;
    for (let w = 0; w < W; w++) {
      const d = a[src + w], prev = w > 0 ? a[src + w - 1] : 0;
      let o = d;
      for (let j = 1; j < k; j++) o |= (d << j) | (prev >>> (32 - j));
      if (w === W - 1) o &= lastMask;
      open[row + w] |= o & ground[row + w];
    }
  }
}

/**
 * Settle rows [r0, r1): a kept cell is natural when it lies at y <= 1 or a
 * natural kept cell neighbours it below, at -z, or along its row (whole-word
 * fills both ways); any kept cell still unsettled floods its component.
 */
function settleRows(L, r0, r1) {
  const { sz, W, open, natural, seen } = L, layerWords = sz * W;
  for (let r = r0; r < r1; r++) {
    const z = r % sz, y = (r - z) / sz, row = r * W;
    let carry = 0, any = 0;
    for (let w = 0; w < W; w++) {
      const o = open[row + w];
      if (!o) { carry = 0; continue; }
      let s = natural[row + w] | (carry & 1);
      if (y <= 1) s = o;
      else {
        s |= natural[row + w - layerWords];
        if (z > 0) s |= natural[row + w - W];
      }
      const f = fillUp(s & o, o);
      natural[row + w] = f;
      carry = f >>> 31;
      any = 1;
    }
    if (!any) continue;
    carry = 0;
    for (let w = W - 1; w >= 0; w--) {
      const o = open[row + w];
      if (!o) { carry = 0; continue; }
      const f = fillDown((natural[row + w] | (carry << 31)) & o, o);
      natural[row + w] = f;
      carry = f & 1;
    }
    for (let w = 0; w < W; w++) {
      let u;
      while ((u = open[row + w] & ~natural[row + w] & ~seen[row + w]) !== 0) {
        const bit = 31 - Math.clz32(u & -u);
        flood(L, ((row + w) << 5) + bit);
      }
    }
  }
}

/**
 * Flood the kept component from bit `start` until it meets natural ground,
 * reaches y <= 1 or `minComponent` cells: then every flooded cell is natural.
 * A component that ends first stays `seen` but not natural (demoted).
 */
function flood(L, start) {
  const { sx, sy, sz, RB, open, natural, seen, queue, minComponent } = L, layerBits = sz * RB;
  let length = 0, isNatural = false;
  queue[length++] = start;
  set(seen, start);
  for (let head = 0; head < length && !isNatural; head++) {
    const p = queue[head], r = (p / RB) | 0, x = p - r * RB, z = r % sz, y = (r - z) / sz;
    if (y <= 1) { isNatural = true; break; }
    for (let d = 0; d < 6; d++) {
      let n;
      if (d === 0) n = p - layerBits;
      else if (d === 1) { if (y + 1 >= sy) continue; n = p + layerBits; }
      else if (d === 2) { if (x === 0) continue; n = p - 1; }
      else if (d === 3) { if (x + 1 >= sx) continue; n = p + 1; }
      else if (d === 4) { if (z === 0) continue; n = p - RB; }
      else { if (z + 1 >= sz) continue; n = p + RB; }
      if (!has(open, n)) continue;
      if (has(natural, n)) { isNatural = true; break; }
      if (has(seen, n)) continue;
      set(seen, n);
      queue[length++] = n;
      if (length >= minComponent) { isNatural = true; break; }
    }
  }
  if (isNatural) for (let j = 0; j < length; j++) set(natural, queue[j]);
  return length;
}

/** Demoted cells (ground, not natural) of rows [r0, r1) into the 8^3 chunk bitmap; returns the count. */
function demoteRows(L, r0, r1) {
  const { sy, sz, W, ground, natural, ncx, ncz } = L;
  let count = 0;
  for (let r = r0; r < r1; r++) {
    const z = r % sz, y = (r - z) / sz, row = r * W;
    for (let w = 0; w < W; w++) {
      let d = ground[row + w] & ~natural[row + w];
      while (d) {
        const low = d & -d, x = (w << 5) + 31 - Math.clz32(low);
        d ^= low;
        L.demoted ??= new Array(ncx * ((sy + 7) >> 3) * ncz).fill(null);
        const c = ((y >> 3) * ncz + (z >> 3)) * ncx + (x >> 3);
        const bits = L.demoted[c] ??= new Uint8Array(64);
        const bit = ((y & 7) << 6) | ((z & 7) << 3) | (x & 7);
        bits[bit >> 3] |= 1 << (bit & 7);
        count++;
      }
    }
  }
  return count;
}

/** Labeling state for `dimensions` (bitsets; `scanRows` fills the ground mask, `labelSteps` labels it). */
export function groundState(dimensions, { raw = null, blockAt = null, plate = GROUND_RULES.plate, minComponent = GROUND_RULES.minComponent } = {}) {
  const { sx, sy, sz } = dimensions, W = (sx + 31) >>> 5, rows = sy * sz, words = rows * W;
  if (rows * W * 32 > 2 ** 31) throw new RangeError('structure ground: map too large');
  const k = Math.min(32, Math.max(1, plate | 0)), cap = Math.max(1, minComponent | 0);
  return {
    sx, sy, sz, W, RB: W << 5, rows, raw, blockAt, k, minComponent: cap,
    lastMask: sx & 31 ? (1 << (sx & 31)) - 1 : -1,
    ground: new Int32Array(words), open: new Int32Array(words), natural: new Int32Array(words), seen: new Int32Array(words),
    a: new Int32Array(sz * W), b: new Int32Array(sz * W), queue: new Int32Array(cap + 6),
    ncx: (sx + 7) >> 3, ncz: (sz + 7) >> 3, demoted: null,
  };
}

/**
 * Label a scanned ground mask (generator; yields between row batches):
 * returns `{ demoted, count }` where `demoted` is an array over 8^3 chunks
 * (index ((cy * ncz) + cz) * ncx + cx) of Uint8Array(64) bitmaps or null,
 * or null itself when nothing is demoted. Bedrock is never demoted (it
 * cannot be destroyed).
 */
export function* labelSteps(L) {
  const { sy, rows } = L;
  for (let y = 0; y < sy; y++) { openLayer(L, y); yield; }
  for (let r = 0; r < rows; r += ROWS_PER_YIELD) { settleRows(L, r, Math.min(rows, r + ROWS_PER_YIELD)); yield; }
  let count = 0;
  for (let r = 0; r < rows; r += ROWS_PER_YIELD) { count += demoteRows(L, r, Math.min(rows, r + ROWS_PER_YIELD)); yield; }
  return { demoted: L.demoted, count };
}

/**
 * Generator labeling `dimensions`' ground from the voxels (`raw`, the y/z/x
 * voxel array, or `blockAt(x, y, z)`); returns what `labelSteps` returns.
 */
export function* groundSteps(dimensions, options = {}) {
  const L = groundState(dimensions, options);
  for (let r = 0; r < L.rows; r += ROWS_PER_YIELD) { scanRows(L, r, Math.min(L.rows, r + ROWS_PER_YIELD)); yield; }
  return yield* labelSteps(L);
}

/** `groundSteps` run to completion. */
export function labelGround(dimensions, options) {
  const steps = groundSteps(dimensions, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** True when the demoted bitmap marks a cell (dimensions as in `groundSteps`). */
export function demotedAt(demoted, ncx, ncz, x, y, z) {
  const bits = demoted[((y >> 3) * ncz + (z >> 3)) * ncx + (x >> 3)];
  if (!bits) return false;
  const bit = ((y & 7) << 6) | ((z & 7) << 3) | (x & 7);
  return ((bits[bit >> 3] >> (bit & 7)) & 1) === 1;
}
