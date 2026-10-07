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
// Message protocol (worker): post { type: 'bake', state } where state holds
// W, H, D, cell, shearX, shearZ, cls (Uint8Array, transferred), emitters
// ([[cellIndex, level, hue255], ...]); the reply is { type: 'baked', ms, sky,
// sun, block, hue, data } with every array transferred back.

export const LIGHT_MAX = 15;
export const OPAQUE = 0, CLEAR = 1, FOLIAGE = 2, WATER = 3;
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
      const s = createLightState(message.state);
      s.extra = message.state.extra || [];
      bakeLightState(s);
      self.postMessage({
        type: 'baked', id: message.id, ms: performance.now() - started,
        cls: s.cls, sky: s.sky, sun: s.sun, block: s.block, hue: s.hue, data: s.data,
      }, [s.cls.buffer, s.sky.buffer, s.sun.buffer, s.block.buffer, s.hue.buffer, s.data.buffer]);
    } catch (error) {
      self.postMessage({ type: 'error', id: message.id, message: String(error?.message || error) });
    }
  };
}
