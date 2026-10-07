// Voxel construction kit for the Frontier v2 sites. Every site module builds
// through these helpers into the y/z/x block array, reading ground heights
// from the pure terrain (shared/world/frontier-terrain.js). The kit records
// authored features (landmarks, cover, interiors, ambush points) so tests can
// check the gameplay contract of each site without re-deriving geometry.

import { AIR, MC_WATER, isSolidBlock } from '../blocks.js';

const clampInt = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * @param {{blocks: Uint8Array, dimensions: {sx:number, sy:number, sz:number}, terrain: object}} options
 *   terrain is frontierTerrain(): heights (top terrain voxel per column) etc.
 */
export function createSiteKit({ blocks, dimensions, terrain }) {
  const { sx: SX, sy: SY, sz: SZ } = dimensions;
  const stats = { writes: 0, boxes: 0 };
  const features = [];
  const reserved = [];
  const index = (x, y, z) => (y * SZ + z) * SX + x;
  const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ;

  const kit = {
    SX, SY, SZ, stats, features, reserved, terrain,
    get(x, y, z) { return inside(x, y, z) ? blocks[index(x, y, z)] : AIR; },
    solid(x, y, z) { return isSolidBlock(kit.get(x, y, z)); },
    set(x, y, z, m) {
      if (!inside(x, y, z)) return;
      blocks[index(x, y, z)] = m; stats.writes++;
    },
    /** Inclusive axis-aligned box, clipped to the world. */
    box(x0, y0, z0, x1, y1, z1, m) {
      const ax = clampInt(Math.min(x0, x1), 0, SX - 1), bx = clampInt(Math.max(x0, x1), 0, SX - 1);
      const ay = clampInt(Math.min(y0, y1), 0, SY - 1), by = clampInt(Math.max(y0, y1), 0, SY - 1);
      const az = clampInt(Math.min(z0, z1), 0, SZ - 1), bz = clampInt(Math.max(z0, z1), 0, SZ - 1);
      if (Math.max(x0, x1) < 0 || Math.min(x0, x1) >= SX || Math.max(z0, z1) < 0 || Math.min(z0, z1) >= SZ
        || Math.max(y0, y1) < 0 || Math.min(y0, y1) >= SY) return;
      stats.boxes++;
      for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) {
        const row = index(0, y, z);
        blocks.fill(m, row + ax, row + bx + 1);
      }
      stats.writes += (bx - ax + 1) * (by - ay + 1) * (bz - az + 1);
    },
    /** Box that only replaces air (or water), never authored solids. */
    fillAir(x0, y0, z0, x1, y1, z1, m) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
          for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
            const b = this.get(x, y, z);
            if ((b === AIR || b === MC_WATER) && inside(x, y, z)) this.set(x, y, z, m);
          }
    },
    clear(x0, y0, z0, x1, y1, z1) { this.box(x0, y0, z0, x1, y1, z1, AIR); },
    /** Terrain top voxel y of a column (before set pieces). */
    top(x, z) {
      return terrain.heights[clampInt(Math.floor(z), 0, SZ - 1) * SX + clampInt(Math.floor(x), 0, SX - 1)];
    },
    /** Highest current solid voxel of a column (after set pieces). */
    surface(x, z) {
      for (let y = SY - 1; y > 0; y--) if (this.solid(x, y, z)) return y;
      return 0;
    },
    maxTop(x0, z0, x1, z1) {
      let m = -1;
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) m = Math.max(m, this.top(x, z));
      return m;
    },
    minTop(x0, z0, x1, z1) {
      let m = Infinity;
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) m = Math.min(m, this.top(x, z));
      return m;
    },
    /** Level slab at y: solid fill from each column's ground up to y, air above to clearTo. */
    foundation(x0, z0, x1, z1, y, m, under = m) {
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        const g = this.top(x, z);
        if (g < y) this.box(x, g + 1, z, x, y - 1, z, under);
        if (g > y) this.box(x, y + 1, z, x, g, z, AIR);
        this.set(x, y, z, m);
      }
    },
    /** Paint a column top (terrain top voxel) with another material. */
    paint(x, z, m) { this.set(x, this.top(x, z), z, m); },
    paintRect(x0, z0, x1, z1, m) {
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.paint(x, z, m);
    },
    /** Vertical cylinder; hollow keeps a one-voxel wall. */
    cylinder(cx, cz, r, y0, y1, m, hollow = false) {
      const r2 = r * r, inner = (r - 1.1) * (r - 1.1);
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d2 = (x + 0.5 - cx) ** 2 + (z + 0.5 - cz) ** 2;
        if (d2 > r2 || (hollow && d2 < inner)) continue;
        this.box(x, y0, z, x, y1, z, m);
      }
    },
    /** Horizontal cylinder slice: a disk in the y/z plane at column x. */
    cylinderAlongX(x, cy, cz, r, m) {
      const r2 = r * r;
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
        if ((y + 0.5 - cy) ** 2 + (z + 0.5 - cz) ** 2 <= r2) this.set(x, y, z, m);
      }
    },
    /** One horizontal disk layer that only fills air. */
    cylinderLayer(cx, cz, r, y, m) {
      const r2 = r * r;
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if ((x + 0.5 - cx) ** 2 + (z + 0.5 - cz) ** 2 > r2) continue;
        if (!this.solid(x, y, z)) this.set(x, y, z, m);
      }
    },
    /** Ellipsoid of material; onlyAir keeps existing solids. */
    ellipsoid(cx, cy, cz, rx, ry, rz, m, onlyAir = false) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++)
          for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
            const q = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 + ((z + 0.5 - cz) / rz) ** 2;
            if (q > 1) continue;
            if (onlyAir && this.solid(x, y, z)) continue;
            this.set(x, y, z, m);
          }
    },
    /** Straight voxel line between two points with a square thickness. */
    line(ax, ay, az, bx, by, bz, m, thick = 0) {
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay), Math.abs(bz - az))));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = Math.round(ax + (bx - ax) * t), y = Math.round(ay + (by - ay) * t), z = Math.round(az + (bz - az) * t);
        if (thick) this.box(x - thick, y - thick, z - thick, x + thick, y + thick, z + thick, m);
        else this.set(x, y, z, m);
      }
    },
    /**
     * Stepped gable roof over [x0..x1] x [z0..z1] starting at eave height y.
     * The ridge runs along `axis` ('x' or 'z'); each course steps in one voxel.
     */
    gableRoof(x0, z0, x1, z1, y, axis, m, gable = null) {
      const span = axis === 'x' ? z1 - z0 : x1 - x0;
      const courses = Math.ceil((span + 1) / 2);
      for (let c = 0; c < courses; c++) {
        const yy = y + c;
        if (axis === 'x') {
          this.box(x0, yy, z0 + c, x1, yy, z0 + c, m); this.box(x0, yy, z1 - c, x1, yy, z1 - c, m);
          if (gable) { this.box(x0 + 1, yy, z0 + c + 1, x0 + 1, yy, z1 - c - 1, gable); this.box(x1 - 1, yy, z0 + c + 1, x1 - 1, yy, z1 - c - 1, gable); }
        } else {
          this.box(x0 + c, yy, z0, x0 + c, yy, z1, m); this.box(x1 - c, yy, z0, x1 - c, yy, z1, m);
          if (gable) { this.box(x0 + c + 1, yy, z0 + 1, x1 - c - 1, yy, z0 + 1, gable); this.box(x0 + c + 1, yy, z1 - 1, x1 - c - 1, yy, z1 - 1, gable); }
        }
      }
      return y + courses - 1;
    },
    /** Hollow room shell: walls of m from y0..y1, floor at y0-1 left as is. */
    walls(x0, z0, x1, z1, y0, y1, m) {
      this.box(x0, y0, z0, x1, y1, z0, m); this.box(x0, y0, z1, x1, y1, z1, m);
      this.box(x0, y0, z0, x0, y1, z1, m); this.box(x1, y0, z0, x1, y1, z1, m);
    },
    /** Record an authored feature for tests and metadata. */
    feature(kind, data) { const f = { kind, ...data }; features.push(f); return f; },
    /** Keep a rectangle free of set pieces; the generator clears it last. */
    reserve(x0, z0, x1, z1, height = 4, label = 'reserved') {
      reserved.push({ minX: Math.floor(Math.min(x0, x1)), maxX: Math.floor(Math.max(x0, x1)), minZ: Math.floor(Math.min(z0, z1)), maxZ: Math.floor(Math.max(z0, z1)), height, label });
    },
  };
  return kit;
}

/**
 * Point-mirrored view of a kit: every cell (x, z) maps to (SX-1-x, SZ-1-z).
 * Bravo's HQ and Blackwood are built as exact mirrors of their alpha twins.
 */
export function mirroredKit(kit) {
  const mx = x => kit.SX - 1 - x, mz = z => kit.SZ - 1 - z;
  // Composite helpers (cylinders, roofs, walls, foundations) are written
  // against these primitives through `this`, so they mirror automatically.
  const view = Object.create(kit);
  Object.assign(view, {
    mirrored: true,
    get(x, y, z) { return kit.get(mx(x), y, mz(z)); },
    solid(x, y, z) { return kit.solid(mx(x), y, mz(z)); },
    set(x, y, z, m) { kit.set(mx(x), y, mz(z), m); },
    box(x0, y0, z0, x1, y1, z1, m) { kit.box(mx(x1), y0, mz(z1), mx(x0), y1, mz(z0), m); },
    top(x, z) { return kit.top(kit.SX - x - 1e-9, kit.SZ - z - 1e-9); },
    surface(x, z) { return kit.surface(mx(x), mz(z)); },
    feature(kind, data) { return kit.feature(kind, mirrorFeature(data, kit.SX, kit.SZ)); },
    reserve(x0, z0, x1, z1, height, label) { kit.reserve(mx(x1), mz(z1), mx(x0), mz(z0), height, label); },
  });
  return view;
}

function mirrorFeature(data, SX, SZ) {
  const out = { ...data };
  if (Number.isFinite(out.x)) out.x = SX - out.x;
  if (Number.isFinite(out.z)) out.z = SZ - out.z;
  for (const [a, b] of [['minX', 'maxX'], ['minZ', 'maxZ']]) {
    if (Number.isFinite(out[a]) && Number.isFinite(out[b])) {
      const size = a === 'minX' ? SX : SZ;
      [out[a], out[b]] = [size - 1 - out[b], size - 1 - out[a]];
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32) for authored scatter. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
