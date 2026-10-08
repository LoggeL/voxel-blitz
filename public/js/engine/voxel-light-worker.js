// Voxel light bake kernel: sky flood, block light and the swept sun on a grid
// of light cells. Pure typed-array code with no Three or DOM dependency, so the
// same functions run in a module worker (the large-world bake at load) and on
// the main thread (small maps and the local patches after block deltas).
//
// A light cell covers `cell` voxels per axis (1 on arena maps, 2 or 4 on large
// worlds). Its class byte packs the light class in bits 0-1 and, for a solid
// cell that still holds some air, the side its air lies on in bits 2-4
// (1 +x, 2 -x, 3 +y, 4 -y, 5 +z, 6 -z). Such a "partial" cell blocks light
// like a solid one, but it is stored with the light of its open neighbour, so
// a thin wall reads dark on its inside and bright on its outside, and a ground
// surface cell carries the light of the air above it.
//
// Message protocol (worker): post { type: 'bake', state, voxels? } where state
// holds W, H, D, cell, shearX, shearZ, cls (Uint8Array, transferred), emitters
// ([[cellIndex, level | hue255 << 8], ...]); the reply is { type: 'baked', ms,
// classifyMs, sky, sun, block, hue, data } with every array transferred back.
// With voxels ({ blocks, sx, sy, sz }, a transferred copy of the raw y/z/x
// array) the worker classifies the grid itself and also returns `emitters`.

import {
  AIR, GLASS, LEAVES, MC_GLASS, MC_LEAVES, MC_WATER, MC_LAVA, MC_PORTAL,
  MC_GLOWSTONE, MC_GHOST_GLOWSTONE, PINE_LEAVES,
} from '../../../shared/world/blocks.js';

export const LIGHT_MAX = 15;
export const OPAQUE = 0, CLEAR = 1, FOLIAGE = 2, WATER = 3;

// ------------------------------------------------------------- classify
/** Palette coordinates for block-light hues (see voxelBlockColor in GLSL). */
export const LIGHT_HUE = Object.freeze({ cyan: 0, warm: 0.33, amber: 0.45, lava: 0.66, portal: 1 });

export const LIGHT_EMITTERS = new Map([
  [MC_GLOWSTONE, { level: 15, hue: LIGHT_HUE.warm }],
  [MC_GHOST_GLOWSTONE, { level: 15, hue: LIGHT_HUE.warm }],
  [MC_LAVA, { level: 14, hue: LIGHT_HUE.lava }],
  [MC_PORTAL, { level: 11, hue: LIGHT_HUE.portal }],
]);

// Frontier foliage (WP4 blocks) shades like leaves once those ids exist.
const FOLIAGE_IDS = new Set([LEAVES, MC_LEAVES, PINE_LEAVES].filter(Number.isInteger));

export function lightClass(id) {
  if (id === AIR || id === GLASS || id === MC_GLASS || id === MC_PORTAL) return CLEAR;
  if (FOLIAGE_IDS.has(id)) return FOLIAGE;
  if (id === MC_WATER) return WATER;
  return OPAQUE;
}

const CLASS_TABLE = new Uint8Array(256).map((_, id) => lightClass(id));
export const classOfBlock = (id) => (id >= 0 && id < 256 ? CLASS_TABLE[id] : lightClass(id));
// Emitter level and hue per block id: the classifier reads these per voxel.
const EMIT_LEVEL = new Uint8Array(256), EMIT_HUE = new Float64Array(256);
for (const [id, { level, hue }] of LIGHT_EMITTERS) { EMIT_LEVEL[id] = level; EMIT_HUE[id] = hue; }

/** Cells of this edge and up classify by face coverage as well as by solid share. */
const COVERAGE_CELL = 4;
/** Share of a cell face that solid columns must cover for the cell to act as a barrier. */
const COVERAGE_SHARE = 0.75;

/**
 * Class byte of one light cell from its voxels: light class in bits 0-1 and,
 * for a cell that is at least half solid but still holds air, the side of its
 * air in bits 2-4. Records voxel emitters (cell index -> level | hue255 << 8).
 * `ctx` holds { cell, getBlock, dims: {sx, sy, sz}, W, H } and keeps its
 * coverage scratch arrays.
 */
export function classifyLightCell(ctx, cx, cy, cz, emitters) {
  const { cell, getBlock } = ctx;
  const { sx, sy, sz } = ctx.dims;
  const i = cx + ctx.W * (cy + ctx.H * cz);
  if (cell === 1) {
    const id = getBlock(cx, cy, cz);
    if (emitters) {
      const emitter = LIGHT_EMITTERS.get(id);
      if (emitter && classOfBlock(id) !== WATER) emitters.set(i, emitter.level | (Math.round(emitter.hue * 255) << 8));
      else emitters.delete(i);
    }
    return classOfBlock(id);
  }
  const x0 = cx * cell, y0 = cy * cell, z0 = cz * cell;
  const x1 = Math.min(sx, x0 + cell), y1 = Math.min(sy, y0 + cell), z1 = Math.min(sz, z0 + cell);
  const half = (cell - 1) / 2;
  let solid = 0, foliage = 0, water = 0, total = 0, ax = 0, ay = 0, az = 0;
  let emitLevel = 0, emitHue = 0;
  // Coarse cells (4+ voxels) also track which face columns hold any solid:
  // a one-voxel roof or wall fills only a quarter of a 4-voxel cell but
  // still covers its whole face, and must stop the sun like a solid cell.
  const coverage = cell >= COVERAGE_CELL;
  if (coverage) {
    const size = cell * cell;
    if (!ctx.coverY || ctx.coverY.length !== size) {
      ctx.coverX = new Uint8Array(size); ctx.coverY = new Uint8Array(size); ctx.coverZ = new Uint8Array(size);
    } else {
      ctx.coverX.fill(0); ctx.coverY.fill(0); ctx.coverZ.fill(0);
    }
  }
  const { coverX, coverY, coverZ } = ctx;
  for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const id = getBlock(x, y, z);
    total++;
    const c = classOfBlock(id);
    if (c === OPAQUE) {
      solid++;
      if (coverage) {
        const lx = x - x0, ly = y - y0, lz = z - z0;
        coverY[lx + lz * cell] = 1; coverX[ly + lz * cell] = 1; coverZ[lx + ly * cell] = 1;
      }
    } else {
      if (c === FOLIAGE) foliage++;
      else if (c === WATER) water++;
      ax += x - x0 - half; ay += y - y0 - half; az += z - z0 - half;
    }
    if (emitters && EMIT_LEVEL[id] > emitLevel) { emitLevel = EMIT_LEVEL[id]; emitHue = EMIT_HUE[id]; }
  }
  if (emitters) {
    if (emitLevel) emitters.set(i, emitLevel | (Math.round(emitHue * 255) << 8));
    else emitters.delete(i);
  }
  let barrier = solid * 2 >= total;
  if (!barrier && coverage && solid > 0) {
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    const covered = (cover, a, b) => { let n = 0; for (let j = 0; j < b; j++) for (let k = 0; k < a; k++) n += cover[k + j * cell]; return n; };
    barrier = covered(coverY, w, d) >= COVERAGE_SHARE * w * d
      || covered(coverX, h, d) >= COVERAGE_SHARE * h * d
      || covered(coverZ, w, h) >= COVERAGE_SHARE * w * h;
  }
  return cellClass(barrier, solid, foliage, water, total, ax, ay, az);
}

/** Class byte from a cell's voxel counts and its air's lean (see classifyLightCell). */
function cellClass(barrier, solid, foliage, water, total, ax, ay, az) {
  if (barrier) {
    if (solid === total) return OPAQUE;
    // The axis the air leans towards most is the cell's open side.
    const bx = Math.abs(ax), by = Math.abs(ay), bz = Math.abs(az);
    let side = 0;
    if (by >= bx && by >= bz && by > 0) side = ay > 0 ? 3 : 4;
    else if (bx >= bz && bx > 0) side = ax > 0 ? 1 : 2;
    else if (bz > 0) side = az > 0 ? 5 : 6;
    return OPAQUE | (side << 2);
  }
  if ((foliage + solid) * 2 >= total && foliage > 0) return FOLIAGE;
  if (water * 2 >= total) return WATER;
  return CLEAR;
}

/**
 * classifyLightRows over a raw y/z/x voxel array for 2- and 3-voxel cells
 * (large worlds): the same counts and class bytes as classifyLightCell,
 * without a getter call or a map lookup per voxel.
 */
function classifyArrayRows(blocks, dims, { W, H, cell }, cls, emitters, cz0, cz1) {
  const { sx, sy, sz } = dims, plane = sx * sz, half = (cell - 1) / 2;
  for (let cz = cz0; cz < cz1; cz++) {
    const z0 = cz * cell, z1 = Math.min(sz, z0 + cell);
    for (let cy = 0; cy < H; cy++) {
      const y0 = cy * cell, y1 = Math.min(sy, y0 + cell);
      let i = W * (cy + H * cz);
      for (let cx = 0; cx < W; cx++, i++) {
        const x0 = cx * cell, x1 = Math.min(sx, x0 + cell);
        let solid = 0, foliage = 0, water = 0, total = 0, ax = 0, ay = 0, az = 0, emitLevel = 0, emitHue = 0;
        for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) {
          const row = y * plane + z * sx;
          for (let x = x0; x < x1; x++) {
            const id = blocks[row + x];
            total++;
            const c = CLASS_TABLE[id];
            if (c === OPAQUE) solid++;
            else {
              if (c === FOLIAGE) foliage++;
              else if (c === WATER) water++;
              ax += x - x0 - half; ay += y - y0 - half; az += z - z0 - half;
            }
            if (EMIT_LEVEL[id] > emitLevel) { emitLevel = EMIT_LEVEL[id]; emitHue = EMIT_HUE[id]; }
          }
        }
        if (emitLevel) emitters.set(i, emitLevel | (Math.round(emitHue * 255) << 8));
        else if (emitters.size) emitters.delete(i);
        cls[i] = cellClass(solid * 2 >= total, solid, foliage, water, total, ax, ay, az);
      }
    }
  }
}

/** Classify light-cell slabs [cz0, cz1) into `cls`; returns the number of cells written. */
export function classifyLightRows(ctx, cls, emitters, cz0, cz1) {
  const { W, H } = ctx;
  for (let cz = cz0; cz < cz1; cz++) {
    for (let cy = 0; cy < H; cy++) {
      let i = W * (cy + H * cz);
      for (let cx = 0; cx < W; cx++, i++) cls[i] = classifyLightCell(ctx, cx, cy, cz, emitters);
    }
  }
  return (cz1 - cz0) * W * H;
}

/** Classifier context over a raw y/z/x voxel array (in-range reads only). */
export function voxelArrayContext(blocks, dims, { W, H, cell }) {
  const { sx, sz } = dims;
  const plane = sx * sz;
  return { cell, W, H, blocks, dims: { sx: dims.sx, sy: dims.sy, sz: dims.sz },
    getBlock: (x, y, z) => blocks[y * plane + z * sx + x] };
}

/** Classify a whole grid from raw voxels (the worker's load-time path). */
export function classifyVoxelArray(ctx, cls, emitters, cz0, cz1) {
  if (ctx.blocks && ctx.cell >= 2 && ctx.cell < COVERAGE_CELL) classifyArrayRows(ctx.blocks, ctx.dims, ctx, cls, emitters, cz0, cz1);
  else classifyLightRows(ctx, cls, emitters, cz0, cz1);
}
/** Neighbour offsets per side code 1..6 are resolved per grid at runtime. */
export const SIDE_NONE = 0;

/** Growable FIFO of cell indices (power-of-two ring). */
export class CellQueue {
  constructor(capacity = 1 << 16) {
    let size = 1024;
    while (size < capacity) size <<= 1;
    this.items = new Int32Array(size);
    this.mask = size - 1;
    this.head = 0;
    this.tail = 0;
  }

  get length() { return this.tail - this.head; }

  clear() { this.head = this.tail = 0; }

  push(value) {
    if (this.tail - this.head > this.mask) this.grow();
    this.items[this.tail & this.mask] = value;
    this.tail++;
  }

  shift() {
    const value = this.items[this.head & this.mask];
    this.head++;
    return value;
  }

  grow() {
    const count = this.tail - this.head;
    const next = new Int32Array(this.items.length * 2);
    for (let i = 0; i < count; i++) next[i] = this.items[(this.head + i) & this.mask];
    this.items = next;
    this.mask = next.length - 1;
    this.head = 0;
    this.tail = count;
  }
}

/**
 * Light state over a W x H x D cell grid. Arrays may be passed in (worker
 * transfer) or are allocated here.
 */
export function createLightState({ W, H, D, cell = 1, shearX = 0, shearZ = 0, cls = null, sky = null, sun = null, block = null, hue = null, data = null, emitters = null }) {
  const N = W * H * D;
  return {
    W, H, D, N, cell, shearX, shearZ,
    cls: cls || new Uint8Array(N),
    sky: sky || new Uint8Array(N),
    sun: sun || new Uint8Array(N),
    block: block || new Uint8Array(N),
    hue: hue || new Uint8Array(N),
    data: data || new Uint8Array(N * 4),
    // Sparse voxel-data emitters: cell index -> level | hue255 << 8.
    emitters: emitters instanceof Map ? emitters : new Map(emitters || []),
    extra: [],
    queue: new CellQueue(Math.min(Math.max(4096, N >> 3), 1 << 22)),
  };
}

const lightClassOf = (byte) => byte & 3;
const sideOf = (byte) => byte >> 2;

// ------------------------------------------------------------------ sky
/**
 * Columns first: full sky straight down through clear cells, foliage and
 * water dim it. Only cells that can raise a darker neighbour seed the flood,
 * so the open sky above a large world costs one pass and no queue traffic.
 */
export function rebuildSky(s, x0, x1, z0, z1) {
  const { W, H, D, cls, sky, cell } = s;
  const queue = s.queue;
  queue.clear();
  const foliageDim = 2 * cell, waterDim = cell;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      let level = LIGHT_MAX;
      for (let y = H - 1; y >= 0; y--) {
        const i = x + W * (y + H * z);
        const c = cls[i] & 3;
        if (c === OPAQUE) level = 0;
        else if (c === FOLIAGE) level = Math.max(0, level - foliageDim);
        else if (c === WATER) level = Math.max(0, level - waterDim);
        sky[i] = level;
      }
    }
  }
  const cost = cell;
  const stepZ = W * H;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      for (let y = H - 1; y >= 0; y--) {
        const i = x + W * (y + H * z);
        const level = sky[i];
        if (level <= cost) continue;
        const floor = level - cost;
        if ((x > 0 && sky[i - 1] < floor && (cls[i - 1] & 3) !== OPAQUE)
          || (x < W - 1 && sky[i + 1] < floor && (cls[i + 1] & 3) !== OPAQUE)
          || (z > 0 && sky[i - stepZ] < floor && (cls[i - stepZ] & 3) !== OPAQUE)
          || (z < D - 1 && sky[i + stepZ] < floor && (cls[i + stepZ] & 3) !== OPAQUE)
          || (y > 0 && sky[i - W] < floor && (cls[i - W] & 3) !== OPAQUE)) queue.push(i);
      }
    }
  }
  // Light flowing in from outside the rebuilt region seeds the flood.
  if (x0 > 0 || x1 < W - 1 || z0 > 0 || z1 < D - 1) {
    const seedEdge = (x, z) => {
      if (x < 0 || z < 0 || x >= W || z >= D) return;
      for (let y = 0; y < H; y++) {
        const i = x + W * (y + H * z);
        if (sky[i] > cost) queue.push(i);
      }
    };
    for (let z = z0 - 1; z <= z1 + 1; z++) { seedEdge(x0 - 1, z); seedEdge(x1 + 1, z); }
    for (let x = x0; x <= x1; x++) { seedEdge(x, z0 - 1); seedEdge(x, z1 + 1); }
  }
  flood(s, sky, null, x0, x1, z0, z1);
}

// ----------------------------------------------------------- block light
export function rebuildBlock(s, x0, x1, z0, z1) {
  const { W, H, D, cls, block, hue } = s;
  const queue = s.queue;
  queue.clear();
  for (let z = z0; z <= z1; z++) {
    for (let y = 0; y < H; y++) {
      const row = W * (y + H * z);
      block.fill(0, row + x0, row + x1 + 1);
    }
  }
  for (const [i, packed] of s.emitters) {
    const x = i % W, z = (i / (W * H)) | 0;
    if (x < x0 || x > x1 || z < z0 || z > z1) continue;
    const level = packed & 255;
    if (level <= block[i]) continue;
    block[i] = level;
    hue[i] = packed >> 8;
    queue.push(i);
  }
  for (const light of s.extra) {
    const { x, y, z } = light;
    if (x < x0 || x > x1 || z < z0 || z > z1 || y < 0 || y >= H) continue;
    const i = x + W * (y + H * z);
    if ((cls[i] & 3) === OPAQUE || light.level <= block[i]) continue;
    block[i] = light.level;
    hue[i] = Math.round(light.hue * 255);
    queue.push(i);
  }
  const cost = s.cell;
  if (x0 > 0 || x1 < W - 1 || z0 > 0 || z1 < D - 1) {
    const seedEdge = (x, z) => {
      if (x < 0 || z < 0 || x >= W || z >= D) return;
      for (let y = 0; y < H; y++) {
        const i = x + W * (y + H * z);
        if (block[i] > cost) queue.push(i);
      }
    };
    for (let z = z0 - 1; z <= z1 + 1; z++) { seedEdge(x0 - 1, z); seedEdge(x1 + 1, z); }
    for (let x = x0; x <= x1; x++) { seedEdge(x, z0 - 1); seedEdge(x, z1 + 1); }
  }
  flood(s, block, hue, x0, x1, z0, z1);
}

/** Breadth-first spread: each step into a clear neighbour costs one cell width. */
export function flood(s, level, hue, x0, x1, z0, z1) {
  const { W, H, D, cls, cell } = s;
  const queue = s.queue;
  const stepZ = W * H;
  const foliageCost = cell;
  const push = (from, to) => {
    const c = cls[to] & 3;
    if (c === OPAQUE) return;
    const next = level[from] - cell - (c === FOLIAGE ? foliageCost : 0);
    if (next <= level[to]) return;
    level[to] = next;
    if (hue) hue[to] = hue[from];
    if (next > cell) queue.push(to);
  };
  while (queue.length > 0) {
    const i = queue.shift();
    if (level[i] <= cell) continue;
    const x = i % W;
    const y = ((i / W) | 0) % H;
    const z = (i / stepZ) | 0;
    if (x > 0 && x - 1 >= x0) push(i, i - 1);
    if (x < W - 1 && x + 1 <= x1) push(i, i + 1);
    if (z > 0 && z - 1 >= z0) push(i, i - stepZ);
    if (z < D - 1 && z + 1 <= z1) push(i, i + stepZ);
    if (y > 0) push(i, i - W);
    if (y < H - 1) push(i, i + W);
  }
}

// ------------------------------------------------------------------ sun
/** Sheared column coordinate of a cell: every cell on one sun ray shares it. */
export function sunColumnOf(s, x, y, z) {
  return [Math.round(x - s.shearX * y), Math.round(z - s.shearZ * y)];
}

export function rebuildAllSun(s) {
  const { W, H, D, shearX, shearZ } = s;
  const uMin = Math.floor(Math.min(0, -shearX * (H - 1))) - 1;
  const uMax = Math.ceil(Math.max(W - 1, W - 1 - shearX * (H - 1))) + 1;
  const wMin = Math.floor(Math.min(0, -shearZ * (H - 1))) - 1;
  const wMax = Math.ceil(Math.max(D - 1, D - 1 - shearZ * (H - 1))) + 1;
  for (let w = wMin; w <= wMax; w++) for (let u = uMin; u <= uMax; u++) sweepSunColumn(s, u, w);
}

/** Walk one sun ray from the top of the map down, darkening behind occluders. */
export function sweepSunColumn(s, u, w) {
  const { W, H, D, cls, sun, shearX, shearZ, cell } = s;
  const foliage = Math.pow(0.45, cell), water = Math.pow(0.8, cell);
  let lit = 255;
  for (let y = H - 1; y >= 0; y--) {
    const x = Math.round(u + shearX * y);
    const z = Math.round(w + shearZ * y);
    if (x < 0 || z < 0 || x >= W || z >= D) continue;
    const i = x + W * (y + H * z);
    const c = cls[i] & 3;
    if (c === OPAQUE) { sun[i] = 0; lit = 0; continue; }
    sun[i] = lit;
    if (c === FOLIAGE) lit = (lit * foliage) | 0;
    else if (c === WATER) lit = (lit * water) | 0;
  }
}

// ------------------------------------------------------------- texture
/**
 * RGBA per cell: sky 0..255, sun 0..255, block 0..255, block hue. Solid cells
 * take light from their open side (partial) or the brightest open neighbour
 * (full), so linear filtering across a face never pulls light down towards a
 * solid cell's zero, and never through a thin wall.
 */
export function fillTexture(s, x0, x1, y0, y1, z0, z1) {
  const { W, H, D, cls, sky, sun, block, hue, data } = s;
  x0 = Math.max(0, x0); z0 = Math.max(0, z0); y0 = Math.max(0, y0);
  x1 = Math.min(W - 1, x1); z1 = Math.min(D - 1, z1); y1 = Math.min(H - 1, y1);
  const stepY = W, stepZ = W * H;
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      let i = x0 + W * (y + H * z);
      for (let x = x0; x <= x1; x++, i++) {
        let sk = sky[i], u = sun[i], b = block[i], h = hue[i];
        const byte = cls[i];
        if ((byte & 3) === OPAQUE) {
          sk = 0; u = 0;
          const side = byte >> 2;
          let j = -1;
          if (side === 1 && x < W - 1) j = i + 1;
          else if (side === 2 && x > 0) j = i - 1;
          else if (side === 3 && y < H - 1) j = i + stepY;
          else if (side === 4 && y > 0) j = i - stepY;
          else if (side === 5 && z < D - 1) j = i + stepZ;
          else if (side === 6 && z > 0) j = i - stepZ;
          if (j >= 0 && (cls[j] & 3) !== OPAQUE) {
            sk = sky[j]; u = sun[j];
            if (block[j] > b) { b = block[j]; h = hue[j]; }
          } else {
            for (let n = 0; n < 6; n++) {
              let k;
              if (n === 0) { if (x === 0) continue; k = i - 1; }
              else if (n === 1) { if (x === W - 1) continue; k = i + 1; }
              else if (n === 2) { if (y === 0) continue; k = i - stepY; }
              else if (n === 3) { if (y === H - 1) continue; k = i + stepY; }
              else if (n === 4) { if (z === 0) continue; k = i - stepZ; }
              else { if (z === D - 1) continue; k = i + stepZ; }
              if ((cls[k] & 3) === OPAQUE) continue;
              if (sky[k] > sk) sk = sky[k];
              if (sun[k] > u) u = sun[k];
              if (block[k] > b) { b = block[k]; h = hue[k]; }
            }
          }
        }
        const o = i * 4;
        data[o] = sk * 17;
        data[o + 1] = u;
        data[o + 2] = b * 17;
        data[o + 3] = h;
      }
    }
  }
}

/** Full bake of a classified grid: sky, block light, sun and the texture bytes. */
export function bakeLightState(s) {
  const { W, H, D } = s;
  rebuildSky(s, 0, W - 1, 0, D - 1);
  rebuildBlock(s, 0, W - 1, 0, D - 1);
  rebuildAllSun(s);
  fillTexture(s, 0, W - 1, 0, H - 1, 0, D - 1);
  return s;
}

export { lightClassOf, sideOf };

// ---------------------------------------------------------------- worker
const inWorker = typeof self !== 'undefined' && typeof self.postMessage === 'function'
  && typeof window === 'undefined' && typeof self.WorkerGlobalScope !== 'undefined';
if (inWorker) {
  self.onmessage = (event) => {
    const message = event.data || {};
    if (message.type !== 'bake') return;
    try {
      const started = performance.now();
      // Wall-clock stamps (epoch ms) show the worker start-up and reply latency.
      const startedAt = performance.timeOrigin + started;
      const s = createLightState(message.state);
      s.extra = message.state.extra || [];
      // With the voxels attached the worker classifies the grid itself, so
      // the main thread keeps meshing while the whole light volume bakes.
      const voxels = message.voxels;
      if (voxels) {
        s.emitters.clear();
        classifyVoxelArray(voxelArrayContext(voxels.blocks, voxels, s), s.cls, s.emitters, 0, s.D);
      }
      const classifyMs = performance.now() - started;
      bakeLightState(s);
      self.postMessage({
        type: 'baked', id: message.id, ms: performance.now() - started, classifyMs,
        startedAt, finishedAt: performance.timeOrigin + performance.now(),
        cls: s.cls, sky: s.sky, sun: s.sun, block: s.block, hue: s.hue, data: s.data,
        ...(voxels ? { emitters: [...s.emitters] } : {}),
      }, [s.cls.buffer, s.sky.buffer, s.sun.buffer, s.block.buffer, s.hue.buffer, s.data.buffer]);
    } catch (error) {
      self.postMessage({ type: 'error', id: message.id, message: String(error?.message || error) });
    }
  };
}
