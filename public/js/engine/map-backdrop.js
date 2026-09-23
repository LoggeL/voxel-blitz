// Distant map backdrops: voxel landforms, skylines and industry far outside the
// arena walls, merged into ONE vertex-coloured mesh per map (one draw, one
// program with a fixed key).
//
// Landforms are a seeded voxel heightfield on a ring `near..near+depth` metres
// beyond the map rectangle: small cells (so the faces read as terrain, never as
// one big placeholder slab), strata bands on the walls, lighter caps, per-cell
// brightness jitter. Every height is capped by `maxRise` x its distance to the
// rectangle, so from inside the map a ridge only ever peeks a few degrees over
// the arena wall and never fills the sky or reads as reachable geometry.
// Skylines and industry use the same builder: floor/window bands and ribs are
// vertex colour, so detail costs no textures and no extra draws.
//
// Shading is baked per face from the palette's sun (sides clearly darker than
// tops) and the material is unlit, so backlit faces keep their hue. Aerial
// perspective is independent of the map's fog density: the patched fog step
// fades toward the fog/horizon colour with view depth (`air` uniform) and
// melts every silhouette's base into haze (per-vertex `backdropFx.x`), then
// applies the usual exp2 fog and the 290-392 m far fade. Faces with
// `backdropFx.y` = 1 are emissive (the caldera crater and lava streaks) and
// mostly skip the fog, so they stay orange and bloom on HDR tiers.
//
// `skyline: [h0, h1]` blends the whole backdrop out while the camera rises
// h0..h1 m above the backdrop ground, so overview cameras see the arena on
// open sky instead of a flat hazed floor (uniform-only; blending is fixed per map).
//
// `lit: true` (Nuketown's desert ring) keeps the original Lambert look.

import * as THREE from '../vendor/three.module.js';
import { fbm2, mulberry32 } from '../../../shared/noise.js';
import { FAR_FADE_START, FAR_FADE_END } from './fog-chunk.js';

/** Ground and sea rings reach this far beyond the map rectangle. */
const REACH = 470;
/** No structure face comes closer than this to the playable rectangle. */
const CLEARANCE = 42;
const GRID = 2;

const q = (v) => Math.round(v / GRID) * GRID;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

/** Integer-lattice hash in [0, 1). */
function hash(a, b, seed) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

class BackdropBuilder {
  constructor({ sun, ambient = 0.5, direct = 0.55, hazeY0 = 0, hazeH = 30, hazeK = 0.8 }) {
    this.position = [];
    this.normal = [];
    this.color = [];
    this.fx = [];
    this.index = [];
    this.sun = sun;
    this.ambient = ambient;
    this.direct = direct;
    this.hazeY0 = hazeY0;
    this.hazeH = hazeH;
    this.hazeK = hazeK;
  }

  /**
   * Baked light: sky fill by facing, sun by N.L. Shadowed walls lose a little
   * saturation instead of being pushed toward blue, so warm rock stays sandstone
   * and brown dirt stays brown (a blue push turned them salmon and mauve).
   */
  shade(c, nx, ny, nz, k = 1) {
    const nl = Math.max(0, nx * this.sun.x + ny * this.sun.y + nz * this.sun.z);
    const s = k * (this.ambient * (0.62 + 0.38 * ny) + this.direct * nl);
    const dim = (1 - Math.min(1, nl * 1.6)) * 0.5 * (1 - Math.max(0, ny));
    const luma = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    const d = 0.22 * dim;
    return [(c[0] + (luma - c[0]) * d) * s, (c[1] + (luma - c[1]) * d) * s, (c[2] + (luma - c[2]) * d) * s * (1 + 0.03 * dim)];
  }

  /** Ground haze: silhouettes melt into the horizon toward their base. */
  hazeAt(y) { return this.hazeK * (1 - smooth(this.hazeY0, this.hazeY0 + this.hazeH, y)); }

  vertex(x, y, z, nx, ny, nz, c, haze, glow) {
    this.position.push(x, y, z);
    this.normal.push(nx, ny, nz);
    this.color.push(c[0], c[1], c[2]);
    this.fx.push(haze, glow);
  }

  /** Quad a-b-c-d (counter-clockwise seen from the normal side), colours per corner. */
  quad(a, b, c, d, n, colors, { haze = null, glow = 0 } = {}) {
    const base = this.position.length / 3;
    const pts = [a, b, c, d];
    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      this.vertex(p[0], p[1], p[2], n[0], n[1], n[2], colors[i] || colors[0], haze ? haze[i] : this.hazeAt(p[1]), glow);
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Lit horizontal top face. */
  top(x0, z0, x1, z1, y, c, { glow = 0, raw = false } = {}) {
    const col = raw ? c : this.shade(c, 0, 1, 0);
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], [col], { glow });
  }

  /**
   * Vertical wall from p0 to p1 (x,z; counter-clockwise from the normal side)
   * between yb and yt, split at `cuts`; `colorAt(y0, y1, i)` gives each band's
   * albedo (or { c, glow }). Bands darken toward the wall's foot (contact AO).
   */
  wall(p0, p1, n, yb, yt, cuts, colorAt, { ao = 0.22, aoH = 8 } = {}) {
    if (yt - yb < 0.01) return;
    let lo = yb;
    let i = 0;
    const edges = [];
    for (const c of cuts) if (c > yb + 0.05 && c < yt - 0.05) edges.push(c);
    edges.push(yt);
    for (const hi of edges) {
      const got = colorAt(lo, hi, i++);
      const glow = got && got.c ? got.glow || 0 : 0;
      const alb = got && got.c ? got.c : got;
      const fb = 1 - ao * (1 - smooth(yb, yb + aoH, lo));
      const ft = 1 - ao * (1 - smooth(yb, yb + aoH, hi));
      const cb = glow ? alb : this.shade(alb, n[0], n[1], n[2], fb);
      const ct = glow ? alb : this.shade(alb, n[0], n[1], n[2], ft);
      this.quad([p0[0], lo, p0[1]], [p1[0], lo, p1[1]], [p1[0], hi, p1[1]], [p0[0], hi, p0[1]], n, [cb, cb, ct, ct], { glow });
      lo = hi;
    }
  }

  /** Axis-aligned box without a bottom; walls banded by `cuts` + `colorAt`. */
  box(x0, y0, z0, x1, y1, z1, { top, cuts = [], colorAt, ao = 0.2 }) {
    if (top) this.top(x0, z0, x1, z1, y1, top);
    const at = (face) => (lo, hi, i) => colorAt(lo, hi, i, face);
    this.wall([x0, z1], [x1, z1], [0, 0, 1], y0, y1, cuts, at(0), { ao });
    this.wall([x1, z0], [x0, z0], [0, 0, -1], y0, y1, cuts, at(1), { ao });
    this.wall([x1, z1], [x1, z0], [1, 0, 0], y0, y1, cuts, at(2), { ao });
    this.wall([x0, z0], [x0, z1], [-1, 0, 0], y0, y1, cuts, at(3), { ao });
  }

  /** Merge a three geometry, flat-shaded; `paint(y, x, z, face)` gives albedo per triangle. */
  geometry(geo, matrix, paint) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.applyMatrix4(matrix);
    g.computeVertexNormals();
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    for (let t = 0, f = 0; t + 8 < p.length; t += 9, f++) {
      const cy = (p[t + 1] + p[t + 4] + p[t + 7]) / 3;
      const alb = paint(cy, (p[t] + p[t + 3] + p[t + 6]) / 3, (p[t + 2] + p[t + 5] + p[t + 8]) / 3, f);
      const c = this.shade(alb, n[t], n[t + 1], n[t + 2]);
      const base = this.position.length / 3;
      for (let i = t; i < t + 9; i += 3) {
        this.vertex(p[i], p[i + 1], p[i + 2], n[i], n[i + 1], n[i + 2], c, this.hazeAt(p[i + 1]), 0);
      }
      this.index.push(base, base + 1, base + 2);
    }
    g.dispose();
  }

  build({ normals = true } = {}) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    if (normals) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    geometry.setAttribute('backdropFx', new THREE.Float32BufferAttribute(this.fx, 2));
    const count = this.position.length / 3;
    geometry.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(this.index, 1) : new THREE.Uint16BufferAttribute(this.index, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Rays from the map centre to a point `gap` metres beyond the rectangle. */
function ring(dimensions) {
  const cx = dimensions.sx / 2, cz = dimensions.sz / 2;
  const hx = dimensions.sx / 2, hz = dimensions.sz / 2;
  return {
    cx, cz, hx, hz,
    at(angleDeg, gap) {
      const a = angleDeg * Math.PI / 180;
      const dx = Math.cos(a), dz = Math.sin(a);
      const edge = Math.min(hx / Math.max(Math.abs(dx), 1e-6), hz / Math.max(Math.abs(dz), 1e-6));
      const r = edge + gap;
      return { x: cx + dx * r, z: cz + dz * r, dx, dz, r };
    },
    /** Euclidean distance from (x,z) to the map rectangle. */
    gap(x, z) {
      return Math.hypot(Math.max(0, Math.abs(x - cx) - hx), Math.max(0, Math.abs(z - cz) - hz));
    },
  };
}

/**
 * A box footprint around (x,z), stretched along the ring tangent and pushed
 * outward until it clears the map rectangle.
 */
function footprint(frame, point, along, across, shift = 0) {
  const tx = -point.dz, tz = point.dx;
  let x = point.x + tx * shift, z = point.z + tz * shift;
  const hx = (Math.abs(tx) * along + Math.abs(point.dx) * across) / 2;
  const hz = (Math.abs(tz) * along + Math.abs(point.dz) * across) / 2;
  for (let i = 0; i < 40; i++) {
    const gx = Math.max(0, Math.abs(x - frame.cx) - hx - frame.hx);
    const gz = Math.max(0, Math.abs(z - frame.cz) - hz - frame.hz);
    if (Math.max(gx, gz) >= CLEARANCE) break;
    x += point.dx * 4; z += point.dz * 4;
  }
  return { x0: q(x - hx), x1: q(x + hx), z0: q(z - hz), z1: q(z + hz), x, z };
}

/** Deterministic angles around the ring, skipping `open` sectors. */
function angles(rng, count, open = []) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = ((i + 0.2 + rng() * 0.6) / count) * 360;
    if (inSector(a, open)) continue;
    out.push(a);
  }
  return out;
}

function inSector(a, open = []) { return open.some(([lo, hi]) => a >= lo && a <= hi); }

/** 1 inside the landform ring, 0 in `open` sectors, feathered over `feather` degrees. */
function sectorMask(a, open = [], feather = 12) {
  const circ = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
  let m = 1;
  for (const [lo, hi] of open) {
    const d = a >= lo && a <= hi ? 0 : Math.min(circ(a, lo), circ(a, hi));
    m = Math.min(m, smooth(0, feather, d));
  }
  return m;
}

function between(rng, [lo, hi]) { return lo + rng() * (hi - lo); }

// ------------------------------------------------------------ landforms

/**
 * Voxel heightfield ring. Shapes: `mesa` (terraced benches and cliffs),
 * `hills` (rolling, grass lip), `peaks` (ridged), `islands` (land patches on
 * a sea). Optional `volcano` adds a terraced cone with a glowing crater and
 * lava streaks facing the map.
 */
function landforms(b, frame, cfg, palette) {
  const seed = ((cfg.seed ?? 1) * 7919) | 0;
  const cell = cfg.cell ?? 5;
  const stepY = cfg.step ?? 2;
  const near = cfg.near ?? 100;
  const rise = cfg.rise ?? 50;
  const depth = cfg.depth ?? 110;
  const outer = near + depth;
  const [lo, hi] = cfg.height;
  const maxRise = cfg.maxRise ?? 0.2;
  const scale = cfg.scale ?? 55;
  const shape = cfg.shape || 'hills';
  const y0 = cfg.ground;
  const sink = cfg.sink ?? 3;
  const open = cfg.open || [];

  const strata = (cfg.colors || ['#888888']).map(lin);
  const topA = lin(cfg.top || cfg.colors[0]);
  const topB = cfg.top2 ? lin(cfg.top2) : topA;
  const rock = cfg.rock ? lin(cfg.rock) : null;
  const sand = cfg.sand ? lin(cfg.sand) : null;
  const band = cfg.band ?? 4;
  const lip = cfg.lip ?? 0;
  const jitter = cfg.jitter ?? 0.09;

  const vol = cfg.volcano ? (() => {
    const v = cfg.volcano;
    const p = frame.at(v.angle ?? 270, v.gap ?? 200);
    const toMap = Math.atan2(frame.cz - p.z, frame.cx - p.x);
    return { x: p.x, z: p.z, height: v.height ?? 60, radius: v.radius ?? 80, crater: v.crater ?? 16,
      deep: v.deep ?? 6, toMap, glow: lin(cfg.glow || '#ff5a14'), streaks: v.streaks ?? [-0.45, 0.05, 0.5] };
  })() : null;
  const volcanoH = (x, z) => {
    if (!vol) return { h: 0 };
    const d = Math.hypot(x - vol.x, z - vol.z);
    if (d > vol.radius) return { h: 0 };
    if (d < vol.crater) return { h: vol.height - vol.deep, crater: true, d };
    const t = (d - vol.crater) / (vol.radius - vol.crater);
    const n = fbm2(x / 23, z / 23, seed + 91, 2) * 0.08;
    return { h: vol.height * Math.pow(clamp01(1 - t + n), 1.25), d };
  };
  const lava = (x, z, d) => {
    if (!vol || d == null || d < vol.crater) return 0;
    const a = Math.atan2(z - vol.z, x - vol.x);
    let best = 0;
    for (const s of vol.streaks) {
      let da = a - (vol.toMap + s);
      da = Math.atan2(Math.sin(da), Math.cos(da));
      // Flows meander (angular offset wanders with distance), thin to a thread
      // and break up downhill, so they read as streams, not painted strips.
      const off = Math.abs(da + 0.12 * fbm2(d / 14, s * 7, seed + 23, 2)) * d;
      const len = vol.radius * (0.55 + 0.2 * (s + 0.5));
      const t = (d - vol.crater) / (len - vol.crater);
      const width = 2.9 * (1 - 0.55 * t);
      if (off < width && t < 1) {
        const broken = fbm2(d / 7, s * 13, seed + 41, 2);
        const k = (1 - t) * smooth(-0.35, 0.1, broken);
        best = Math.max(best, k);
      }
    }
    return best;
  };

  const heightAt = (x, z) => {
    const g = frame.gap(x, z);
    let h = 0;
    if (g >= near && g <= outer) {
      const a = (Math.atan2(z - frame.cz, x - frame.cx) * 180 / Math.PI + 360) % 360;
      const env = smooth(near, near + rise, g) * (1 - smooth(outer - 35, outer, g)) * sectorMask(a, open);
      if (env > 0) {
        const u = clamp01(0.5 + 0.7 * fbm2(x / scale, z / scale, seed, 4));
        let raw;
        if (shape === 'mesa') {
          raw = lo + (hi - lo) * smooth(0.28, 0.78, u);
          const t = cfg.terrace ?? 8;
          const k = raw / t;
          raw = (Math.floor(k) + smooth(0.5, 0.85, k - Math.floor(k))) * t;
        } else if (shape === 'peaks') {
          const r = 1 - Math.abs(fbm2(x / scale, z / scale, seed + 7, 4));
          raw = lo + (hi - lo) * r * r * (0.55 + 0.45 * u);
        } else if (shape === 'islands') {
          const land = smooth(0.5, 0.72, u);
          raw = land > 0.02 ? 1 + (hi - 1) * Math.pow(land, 1.6) : 0;
        } else {
          raw = lo + (hi - lo) * smooth(0.12, 0.95, u);
        }
        h = Math.min(raw * env, maxRise * g);
      }
    }
    const v = volcanoH(x, z);
    if (v.h > h) return { h: v.h, crater: v.crater, lava: v.crater ? 0 : lava(x, z, v.d), volcano: true };
    return { h };
  };

  const reach = outer;
  const minX = Math.min(frame.cx - frame.hx - reach, vol ? vol.x - vol.radius : Infinity);
  const maxX = Math.max(frame.cx + frame.hx + reach, vol ? vol.x + vol.radius : -Infinity);
  const minZ = Math.min(frame.cz - frame.hz - reach, vol ? vol.z - vol.radius : Infinity);
  const maxZ = Math.max(frame.cz + frame.hz + reach, vol ? vol.z + vol.radius : -Infinity);
  const gx0 = Math.floor(minX / cell), gz0 = Math.floor(minZ / cell);
  const nx = Math.ceil(maxX / cell) - gx0 + 1, nz = Math.ceil(maxZ / cell) - gz0 + 1;
  const H = new Float32Array(nx * nz);
  const info = new Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (gx0 + i + 0.5) * cell, z = (gz0 + j + 0.5) * cell;
      const r = heightAt(x, z);
      let h = Math.round(r.h / stepY) * stepY;
      if (h < stepY) h = shape === 'islands' && r.h > 0.5 ? stepY * 0.5 : 0;
      H[j * nx + i] = h;
      if (r.volcano) info[j * nx + i] = r;
    }
  }
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= nz ? 0 : H[j * nx + i]);
  // Clean-up passes: a lone one-cell spike standing far above all four
  // neighbours reads as a stray pillar, and island specks (a shore-height
  // cell with no real land beside it) read as floating foam or snow blocks.
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const h = H[k];
        if (h <= 0 || info[k]) continue;
        const m = Math.max(at(i + 1, j), at(i - 1, j), at(i, j + 1), at(i, j - 1));
        if (h - m > stepY * 2) H[k] = m + stepY;
        else if (shape === 'islands' && h <= stepY && m <= stepY) {
          let land = 0;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (at(i + di, j + dj) > stepY) land++;
          if (land === 0) H[k] = 0;
        }
      }
    }
  }

  // Lava stays under the tone curve's roll-off knee in its brightest channel,
  // so it reads saturated orange instead of rolling off toward salmon/white.
  const glowFor = (k) => mul(vol.glow, 0.55 + 0.4 * k);
  // Strata undulate: each cell shifts its band edges by low-frequency noise,
  // so layers tilt and wander across a cliff instead of ruling it like paper.
  const strataShift = (x, z) => band * 1.6 * fbm2(x / 70, z / 70, seed + 29, 2);
  const cutsFor = (off, top) => {
    const out = [];
    for (let y = y0 - sink + (((off % band) + band) % band); y < top; y += band) out.push(y);
    return out;
  };

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const h = H[j * nx + i];
      if (h <= 0) continue;
      const x0 = (gx0 + i) * cell, x1 = x0 + cell, z0 = (gz0 + j) * cell, z1 = z0 + cell;
      const yt = y0 + h;
      const cxw = x0 + cell / 2, czw = z0 + cell / 2;
      const inf = info[j * nx + i];
      const jit = 1 + (hash(i + gx0, j + gz0, seed) - 0.5) * 2 * jitter;
      const off = strataShift(cxw, czw);
      const cuts = cutsFor(off, yt);
      // Top: cap colour, patchy blend to top2, rock above `rockAbove`, sand at the shore.
      let topC = mix(topA, topB, smooth(0.35, 0.65, 0.5 + 0.5 * fbm2(cxw / 31, czw / 31, seed + 5, 2)));
      if (rock && h >= (cfg.rockAbove ?? Infinity)) topC = rock;
      if (sand && h <= (cfg.sandBelow ?? 0)) topC = sand;
      if (inf?.volcano) topC = inf.crater ? null : mix(lin(cfg.crater || cfg.colors[0]), topC, 0.25);
      const lavaK = inf?.lava || 0;
      // A lava cell carries a narrow flow ribbon (a third to a half of the
      // cell, offset per cell so a stream meanders) running downhill; the
      // rest of the cell is scorched crust.
      const flow = lavaK > 0.25;
      const fw = 0.3 + 0.2 * hash(i + gx0, j + gz0, seed + 71);
      const fc = 0.5 + (hash(i + gx0, j + gz0, seed + 73) - 0.5) * (0.9 - fw);
      const fa = fc - fw / 2, fb = fc + fw / 2;
      const crust = inf?.volcano ? mix(lin(cfg.crater || cfg.colors[0]), glowFor(0.2), 0.1 * lavaK) : null;
      if (inf?.crater) b.top(x0, z0, x1, z1, yt, glowFor(0.6), { glow: 1, raw: true });
      else if (flow) {
        const rock = b.shade(mix(crust, topC, 0.4), 0, 1, 0);
        const hot = glowFor(0.35 + 0.6 * lavaK);
        const alongX = Math.abs(cxw - vol.x) > Math.abs(czw - vol.z);
        const s0 = alongX ? z0 : x0;
        const a = s0 + fa * cell, c = s0 + fb * cell, e = s0 + cell;
        const part = (p, q2, col, glow) => (alongX ? b.top(x0, p, x1, q2, yt, col, { glow, raw: true }) : b.top(p, z0, q2, z1, yt, col, { glow, raw: true }));
        part(s0, a, rock, 0);
        part(a, c, hot, 1);
        part(c, e, rock, 0);
      } else if (lavaK > 0.05) b.top(x0, z0, x1, z1, yt, mix(b.shade(topC, 0, 1, 0), mul(glowFor(0.3), 0.5), 0.35 * smooth(0.05, 0.25, lavaK)), { raw: true });
      else b.top(x0, z0, x1, z1, yt, mul(topC, jit));

      const sides = [
        [at(i, j + 1), [x0, z1], [x1, z1], [0, 0, 1], 0],
        [at(i, j - 1), [x1, z0], [x0, z0], [0, 0, -1], 1],
        [at(i + 1, j), [x1, z1], [x1, z0], [1, 0, 0], 2],
        [at(i - 1, j), [x0, z0], [x0, z1], [-1, 0, 0], 3],
      ];
      for (const [hn, p0, p1, n, s] of sides) {
        if (hn >= h) continue;
        const yb = hn > 0 ? y0 + hn : y0 - sink;
        const nInf = s === 0 ? info[(j + 1) * nx + i] : s === 1 ? info[(j - 1) * nx + i] : s === 2 ? info[j * nx + i + 1] : info[j * nx + i - 1];
        // Crater rim walls facing the lava lake glow from below.
        const rimGlow = inf?.volcano && !inf.crater && nInf?.crater;
        const rockAt = (ya, yb2) => {
          const mid = (ya + yb2) / 2;
          if (rimGlow) {
            const t = 1 - smooth(yb, yt, mid);
            return t > 0.35 ? { c: glowFor(t * 0.7), glow: 1 } : lin(cfg.crater || cfg.colors[0]);
          }
          if (flow) return crust;
          if (lip > 0 && ya >= yt - lip - 0.01) return topC ? mul(topC, 0.92) : strata[0];
          const bandIdx = Math.floor((mid - y0 + sink - (((off % band) + band) % band)) / band) + Math.floor(off / band);
          const c = strata[((bandIdx % strata.length) + strata.length) % strata.length];
          const jj = 1 + (hash(i * 4 + s, bandIdx + 977 * j, seed + 3) - 0.5) * 2 * jitter;
          return mul(inf?.volcano ? mix(c, lin(cfg.crater || cfg.colors[0]), smooth(vol.height * 0.5, vol.height, mid - y0) * 0.6) : c, jj);
        };
        const extra = lip > 0 && !flow ? [yt - lip] : null;
        if (!flow) {
          landWall(b, p0, p1, n, yb, yt, cuts, rockAt, extra);
          continue;
        }
        // Lava pours over the terrace edge: a ribbon down the face, hottest
        // at the lip and cooling to dull red toward the foot.
        const lerp2 = (t) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
        const pa = lerp2(fa), pb = lerp2(fb);
        const fallAt = (ya, yb2) => {
          const t = smooth(yb, yt, (ya + yb2) / 2);
          return { c: mul(glowFor(0.3 + 0.7 * lavaK), 0.3 + 0.7 * t), glow: 1 };
        };
        landWall(b, p0, pa, n, yb, yt, cuts, rockAt, null);
        landWall(b, pa, pb, n, yb, yt, cuts, fallAt, null);
        landWall(b, pb, p1, n, yb, yt, cuts, rockAt, null);
      }
    }
  }
}

/** Wall with an optional extra cut (the grass lip). */
function landWall(b, p0, p1, n, yb, yt, cuts, colorAt, extra) {
  const all = extra ? [...cuts.filter((c) => c < extra[0] - 0.4), ...extra] : cuts;
  b.wall(p0, p1, n, yb, yt, all, colorAt);
}

// ------------------------------------------------------------ structures

/** Floor bands: dark glazing rows between light spandrels, per-floor variety. */
function towerBands(y0, y1, floor = 3.6) {
  const cuts = [];
  for (let y = y0 + 4; y < y1 - 1; y += floor) cuts.push(y + 0.9, y + floor - 0.5);
  return cuts;
}

/** City block: tower with setbacks, window bands and a rooftop box. */
function tower(b, rng, frame, point, { y0, height, wall, glass, sky, width = [16, 28], seed }) {
  const w = width[0] + rng() * (width[1] - width[0]);
  const d = width[0] + rng() * (width[1] - width[0]);
  const tiers = 1 + Math.floor(rng() * 3);
  const tint = 0.9 + rng() * 0.2;
  const wallC = mul(wall, tint);
  let y = y0;
  for (let t = 0; t < tiers; t++) {
    const f = 1 - t * 0.2;
    const h = t === tiers - 1 ? y0 + height - y : height * (0.5 + rng() * 0.2) / tiers;
    const box = footprint(frame, point, w * f, d * f);
    const y1 = q(Math.max(y + 6, y + h));
    const cuts = towerBands(y, y1);
    b.box(box.x0, y, box.z0, box.x1, y1, box.z1, {
      top: mul(wallC, 0.95),
      cuts,
      colorAt: (lo, hi, i, face) => {
        const window = lo >= y + 4 && Math.abs(((lo - y - 4) % 3.6) - 0.9) < 0.05;
        if (!window) return wallC;
        const k = hash(Math.floor(lo * 3), face + t * 7, seed);
        return k > 0.82 ? mix(glass, sky, 0.55) : mul(glass, 0.85 + k * 0.3);
      },
    });
    y = y1;
  }
  const top = footprint(frame, point, w * 0.3, d * 0.3);
  b.box(top.x0, y, top.z0, top.x1, y + 4, top.z1, { top: mul(wallC, 0.8), colorAt: () => mul(wallC, 0.75) });
}

/** Hyperboloid cooling tower as a faceted lathe with horizontal ribs. */
function coolingTower(b, x, y0, z, height, radius, concrete, stain) {
  const pts = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = radius * (1 - 0.34 * Math.sin(Math.PI * Math.min(1, t * 1.18)));
    pts.push(new THREE.Vector2(r, t * height));
  }
  const geo = new THREE.LatheGeometry(pts, 16);
  b.geometry(geo, new THREE.Matrix4().makeTranslation(x, y0, z), (y) => {
    // Colour per lathe ring (both triangles of a quad agree), never per centroid.
    const ring = Math.min(steps - 1, Math.floor((y - y0) / height * steps));
    const t = (ring + 0.5) / steps;
    let c = ring % 2 ? mul(concrete, 0.9) : concrete;
    if (t > 0.9) c = stain;
    else if (t > 0.78) c = mix(c, stain, 0.45);
    if (t < 0.08) c = mul(c, 0.7);
    return c;
  });
}

/** Chimney: concrete shaft, red/white aviation bands near the top, dark lip. */
function stack(b, x, y0, z, height, size, concrete, band, dark) {
  const s = size / 2;
  const redFrom = y0 + height * 0.72;
  const cuts = [];
  for (let y = redFrom; y < y0 + height - 2; y += 4) cuts.push(y);
  cuts.push(y0 + height - 2);
  b.box(q(x - s), y0, q(z - s), q(x + s), y0 + height, q(z + s), {
    top: dark, cuts,
    colorAt: (lo) => (lo >= y0 + height - 2.05 ? dark : lo >= redFrom - 0.05 ? (Math.round((lo - redFrom) / 4) % 2 ? concrete : band) : concrete),
  });
}

/** Industrial shed: plinth, cladding, clerestory window strip, roof monitor. */
function shed(b, box, y0, h, color, glass) {
  const y1 = y0 + h;
  const cuts = [y0 + 2, y0 + h * 0.62, y0 + h * 0.8];
  b.box(box.x0, y0, box.z0, box.x1, y1, box.z1, {
    top: mul(color, 1.05), cuts,
    colorAt: (lo) => (lo < y0 + 2 ? mul(color, 0.7) : Math.abs(lo - (y0 + h * 0.62)) < 0.05 ? glass : color),
  });
  if (box.x1 - box.x0 > 16 && box.z1 - box.z0 > 16) {
    b.box(box.x0 + 6, y1, box.z0 + 6, box.x1 - 6, y1 + 3, box.z1 - 6, {
      top: mul(color, 0.95), cuts: [y1 + 1.2], colorAt: (lo) => (lo < y1 + 1.1 ? glass : mul(color, 0.9)),
    });
  }
}

// ----------------------------------------------------------------- styles

const STYLES = {
  /** Voxel landform ring (mesas, hills, peaks, islands, volcano). */
  terrain(b, rng, frame, cfg, palette) { landforms(b, frame, cfg, palette); },

  /** Legacy key: terraced desert mesas. */
  mesa(b, rng, frame, cfg, palette) {
    landforms(b, frame, {
      shape: 'mesa', near: cfg.near ?? cfg.gap?.[0] ?? 100, depth: cfg.depth ?? ((cfg.gap?.[1] ?? 170) - (cfg.gap?.[0] ?? 100) + 80),
      top: cfg.top || cfg.colors[cfg.colors.length - 1], ...cfg, shape: 'mesa',
    }, palette);
  },

  /** Cooling towers, stacks and sheds in front of low hills. */
  industrial(b, rng, frame, cfg, palette) {
    if (cfg.hills?.length) {
      landforms(b, frame, {
        ...cfg, shape: 'hills', colors: cfg.hills, top: cfg.hillTop || cfg.hills[0], top2: cfg.hillTop2,
        height: cfg.hillHeight || [14, 34], near: cfg.hillNear ?? 150, depth: cfg.hillDepth ?? 90, lip: 0.8,
      }, palette);
    }
    const concrete = lin(cfg.concrete || '#a7a8a2');
    const stain = lin(cfg.stain || '#6d6c66');
    const dark = lin(cfg.metal || '#4d5054');
    const band = lin(cfg.band || '#b0413a');
    const white = lin(cfg.white || '#d8d6cf');
    const glass = lin(cfg.glass || '#3b4650');
    for (const t of cfg.towers || []) {
      const p = frame.at(t[0], t[1]);
      coolingTower(b, p.x, cfg.ground, p.z, t[2], t[3], concrete, stain);
    }
    for (const s of cfg.stacks || []) {
      const p = frame.at(s[0], s[1]);
      stack(b, p.x, cfg.ground, p.z, s[2], s[3] || 6, white, band, dark);
    }
    const shedColors = (cfg.sheds || ['#7a7d80']).map(lin);
    const shedGap = cfg.shedGap || [cfg.gap[0] - 20, cfg.gap[0] + 20];
    for (const a of angles(rng, cfg.shedCount ?? 10, cfg.open)) {
      const p = frame.at(a, between(rng, shedGap));
      const box = footprint(frame, p, 30 + rng() * 34, 18 + rng() * 16);
      const h = q(8 + rng() * 12);
      if (cfg.minX != null && box.x0 < cfg.minX) continue;
      shed(b, box, cfg.ground, h, shedColors[Math.floor(rng() * shedColors.length)], glass);
    }
    // Gantry cranes: two legs and a boom, thin enough to read as distant steel.
    for (const c of cfg.cranes || []) {
      const p = frame.at(c[0], c[1]);
      const h = c[2];
      const along = Math.abs(p.dx) > Math.abs(p.dz);
      const px = cfg.minX == null ? p.x : Math.max(p.x, cfg.minX + 2);
      const steel = { top: band, colorAt: () => band };
      const leg = (ox, oz) => b.box(q(px + ox) - 1, cfg.ground, q(p.z + oz) - 1, q(px + ox) + 1, cfg.ground + h, q(p.z + oz) + 1, steel);
      if (along) { leg(0, -8); leg(0, 8); } else { leg(-8, 0); leg(8, 0); }
      const at = along ? px : p.z;
      const centre = along ? frame.cx : frame.cz;
      const inward = at > centre ? -1 : 1;
      const room = Math.abs(at - centre) - (along ? frame.hx : frame.hz) - CLEARANCE - GRID;
      const reach = Math.max(4, Math.min(34, room));
      const lo = q(Math.min(at + inward * reach, at - inward * 14));
      const hi = q(Math.max(at + inward * reach, at - inward * 14));
      if (along) b.box(lo, cfg.ground + h, q(p.z) - 8, hi, cfg.ground + h + 3, q(p.z) + 8, steel);
      else b.box(q(px) - 8, cfg.ground + h, lo, q(px) + 8, cfg.ground + h + 3, hi, steel);
    }
  },

  /** Two rows of stepped city towers with window bands, hills behind. */
  city(b, rng, frame, cfg, palette) {
    const walls = cfg.colors.map(lin);
    const glass = lin(cfg.glass || '#3d4a57');
    const sky = lin(palette.skyHorizon || '#b3ddf5');
    const seed = (cfg.seed ?? 1) * 131;
    const cap = (gap) => Math.min(cfg.height[1], (cfg.maxRise ?? 0.24) * (gap + CLEARANCE));
    for (const a of angles(rng, cfg.count ?? 22, cfg.open)) {
      const gap = between(rng, cfg.gap);
      tower(b, rng, frame, frame.at(a, gap), {
        y0: cfg.ground, height: Math.min(cap(gap), between(rng, cfg.height)), wall: walls[Math.floor(rng() * walls.length)], glass, sky, seed,
      });
    }
    if (cfg.far !== false) {
      for (const a of angles(rng, Math.round((cfg.count ?? 22) * 0.7), cfg.open)) {
        const gap = cfg.gap[1] + 25 + rng() * 30;
        tower(b, rng, frame, frame.at(a, gap), {
          y0: cfg.ground, height: Math.min(cap(gap), between(rng, cfg.height)), wall: walls[Math.floor(rng() * walls.length)], glass, sky, seed: seed + 1, width: [18, 32],
        });
      }
    }
    if (cfg.hills?.length) {
      landforms(b, frame, {
        ...cfg, shape: 'hills', colors: cfg.hills, top: cfg.hillTop || cfg.hills[0], height: cfg.hillHeight || [16, 36],
        near: cfg.hillNear ?? cfg.gap[1] + 50, depth: cfg.hillDepth ?? 80, lip: 0.8, open: cfg.hillOpen || cfg.open,
      }, palette);
    }
  },

  /** Harbor: quay land with a skyline and cranes on one side, headlands elsewhere. */
  harbor(b, rng, frame, cfg, palette) {
    const land = cfg.land;
    if (land) {
      const x0 = frame.cx + frame.hx + land.channel;
      const landC = lin(land.color);
      b.box(q(x0), cfg.ground, q(frame.cz - frame.hz - REACH), q(frame.cx + frame.hx + REACH), land.y, q(frame.cz + frame.hz + REACH), {
        top: landC, cuts: [land.y - 1.2], colorAt: (lo) => (lo < land.y - 1.3 ? mul(landC, 0.62) : mul(landC, 0.9)),
      });
      STYLES.city(b, rng, frame, { ...cfg, ground: land.y, open: land.cityOpen, count: 18, hills: null, far: true }, palette);
      STYLES.industrial(b, rng, frame, { ...cfg, ground: land.y, hills: null, towers: [], stacks: cfg.stacks, shedCount: 0, minX: x0 }, palette);
    }
    landforms(b, frame, {
      ...cfg, shape: cfg.headlandShape || 'hills', colors: cfg.headland, top: cfg.headlandTop, open: cfg.headlandOpen,
      near: cfg.headlandNear ?? 110, depth: cfg.headlandDepth ?? 90, height: cfg.headlandHeight || [10, 30], lip: 0.8,
      ground: cfg.headlandGround ?? cfg.sea?.y ?? cfg.ground, sand: cfg.headlandSand, sandBelow: 2,
    }, palette);
  },

  /** Minecraft-style voxel islands scattered on the sea. */
  islands(b, rng, frame, cfg, palette) {
    landforms(b, frame, { ...cfg, shape: 'islands', lip: 0.6 }, palette);
  },

  /** Nuketown's desert ring: the original eighteen frustums, now one draw. */
  nuketown(b, rng, frame, cfg) {
    const color = lin(cfg.colors[0]);
    for (let i = 0; i < 18; i++) {
      const angle = i * Math.PI * 2 / 18, height = 10 + (i * 7) % 17;
      const geo = new THREE.CylinderGeometry(14 + (i * 3) % 14, 45 + (i * 11) % 26, height, 6, 1);
      const m = new THREE.Matrix4().makeRotationY(i * 0.7)
        .setPosition(frame.cx + Math.cos(angle) * 235, cfg.ground - 0.9 + height / 2, frame.cz + Math.sin(angle) * 235);
      litGeometry(b, geo, m, color);
    }
  },
};

/** Smooth-normal merge for the lit (Lambert) path: albedo only, no baked light. */
function litGeometry(b, geo, matrix, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.applyMatrix4(matrix);
  const p = g.attributes.position.array;
  const n = g.attributes.normal.array;
  for (let i = 0; i < p.length; i += 3) {
    b.index.push(b.position.length / 3);
    b.vertex(p[i], p[i + 1], p[i + 2], n[i], n[i + 1], n[i + 2], color, 0, 0);
  }
  g.dispose();
}

/**
 * Ground or sea ring around the map rectangle (the map footprint stays open),
 * hazing out toward REACH. It is one continuous grid (denser near the map), so
 * haze and a faint low-frequency tone mottle are interpolated seamlessly: the
 * old four-quad ring disagreed at its corners and showed a diagonal seam.
 * `skirt` > 0 hangs an inward-facing wall that deep from the ring's inner edge,
 * so map edges lower than the ring never show sky beneath it.
 */
function groundRing(b, frame, y, color, { sides = null, skirt = 0, haze = [0, 0], lit = false, mottle = 0, seed = 1 } = {}) {
  const x0 = frame.cx - frame.hx, x1 = frame.cx + frame.hx, z0 = frame.cz - frame.hz, z1 = frame.cz + frame.hz;
  const want = (s) => !sides || sides.includes(s);
  const top = lit ? color : b.shade(color, 0, 1, 0);
  const wall = mul(lit ? color : top, 0.72);
  const walls = [wall];
  const lo = y - skirt;
  const [hIn, hOut] = haze;
  const outward = [];
  for (let i = 1; i <= 12; i++) outward.push(REACH * Math.pow(i / 12, 1.6));
  const axis = (a0, a1) => {
    const inner = [];
    const n = Math.max(1, Math.round((a1 - a0) / 24));
    for (let i = 0; i <= n; i++) inner.push(a0 + (a1 - a0) * i / n);
    return [...outward.slice().reverse().map((d) => a0 - d), ...inner, ...outward.map((d) => a1 + d)];
  };
  const xs = axis(x0, x1), zs = axis(z0, z1);
  const tone = (x, z) => (mottle > 0 ? mul(top, 1 + mottle * fbm2(x / 90, z / 90, seed + 61, 3)) : top);
  const hz = (x, z) => hIn + (hOut - hIn) * clamp01(frame.gap(x, z) / REACH);
  for (let j = 0; j + 1 < zs.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const ax = xs[i], bx = xs[i + 1], az = zs[j], bz = zs[j + 1];
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const side = mz < z0 ? 'north' : mz > z1 ? 'south' : mx < x0 ? 'west' : mx > x1 ? 'east' : null;
      if (!side || !want(side)) continue;
      const pts = [[ax, bz], [bx, bz], [bx, az], [ax, az]];
      b.quad([ax, y, bz], [bx, y, bz], [bx, y, az], [ax, y, az], [0, 1, 0],
        pts.map(([px, pz]) => tone(px, pz)), { haze: pts.map(([px, pz]) => hz(px, pz)) });
    }
  }
  if (skirt > 0) {
    const h4 = [hIn, hIn, hIn, hIn];
    if (want('north')) b.quad([x0, lo, z0], [x1, lo, z0], [x1, y, z0], [x0, y, z0], [0, 0, 1], walls, { haze: h4 });
    if (want('south')) b.quad([x1, lo, z1], [x0, lo, z1], [x0, y, z1], [x1, y, z1], [0, 0, -1], walls, { haze: h4 });
    if (want('west')) b.quad([x0, lo, z1], [x0, lo, z0], [x0, y, z0], [x0, y, z1], [1, 0, 0], walls, { haze: h4 });
    if (want('east')) b.quad([x1, lo, z0], [x1, lo, z1], [x1, y, z1], [x1, y, z0], [-1, 0, 0], walls, { haze: h4 });
  }
}

const AIR_FOG = /* glsl */ `
#ifdef USE_FOG
  vec3 vbKeep = gl_FragColor.rgb;
  #ifdef FOG_EXP2
    float vbFog = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float vbFog = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  float vbAir = backdropAir.x * smoothstep( backdropAir.y, backdropAir.z, vFogDepth );
  float vbHaze = 1.0 - ( 1.0 - vbAir ) * ( 1.0 - clamp( vBackdropFx.x, 0.0, 1.0 ) );
  float vbF = 1.0 - ( 1.0 - vbHaze ) * ( 1.0 - backdropAir.w * vbFog );
  float vbFar = smoothstep( ${FAR_FADE_START.toFixed(1)}, ${FAR_FADE_END.toFixed(1)}, vFogDepth );
  // Air and ground haze may lean toward the map's dust tint; the far fade
  // still lands exactly on the fog colour so the skyline melts into the sky.
  vec3 vbTint = mix( fogColor, backdropHaze.rgb, backdropHaze.a * vbHaze / max( vbF, 1e-3 ) );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, mix( vbTint, fogColor, vbFar ), max( vbF, vbFar ) );
  // Emissive faces (lava) keep most of their colour through the haze.
  gl_FragColor.rgb = mix( gl_FragColor.rgb, vbKeep, vBackdropFx.y * 0.94 * ( 1.0 - vbFar ) );
#endif
  // Skyline maps: from a high overview camera the backdrop dissolves into the
  // real sky (camera height above the backdrop ground, uniform-only), so the
  // arena floats on sky there instead of on a flat hazed floor.
  gl_FragColor.a *= 1.0 - smoothstep( backdropFade.x, backdropFade.y, cameraPosition.y - backdropFade.z );
  if ( gl_FragColor.a < 0.004 ) discard;`;

/** Conservative extent for sky.js: a circle inside every silhouette, and the top. */
function cloudGuard(cfg, frame, b) {
  let top = -Infinity, inner = Infinity;
  const p = b.position;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i + 1] > cfg.ground + 1) {
      top = Math.max(top, p[i + 1]);
      inner = Math.min(inner, Math.hypot(p[i] - frame.cx, p[i + 2] - frame.cz));
    }
  }
  if (!Number.isFinite(top)) return null;
  return { cx: frame.cx, cz: frame.cz, radius: inner, top, ground: cfg.ground };
}

/**
 * @param {object} palette mapAtmosphere() result; `palette.backdrop` configures it
 * @param {{sx:number,sz:number}} dimensions map extents
 * @returns {{group:THREE.Group, stats:{draws:number, vertices:number}, dispose:()=>void}|null}
 */
export function buildMapBackdrop(palette = {}, dimensions) {
  const cfg = palette.backdrop;
  if (!cfg || !STYLES[cfg.style] || !dimensions) return null;
  const rng = mulberry32((cfg.seed ?? 1) * 0x9E3779B1);
  const frame = ring(dimensions);
  const lit = cfg.lit === true;
  const sun = new THREE.Vector3(...(palette.sunDir || [60, 90, 20])).normalize();
  const top = (cfg.height?.[1] ?? 30);
  const b = new BackdropBuilder({
    sun, ambient: cfg.ambient ?? 0.52, direct: cfg.direct ?? 0.6,
    hazeY0: (cfg.hazeGround ?? cfg.ground) - 2, hazeH: cfg.hazeHeight ?? top * 0.55, hazeK: lit ? 0 : cfg.baseHaze ?? 0.62,
  });

  if (cfg.groundColor) {
    groundRing(b, frame, cfg.groundY ?? cfg.ground, lin(cfg.groundColor), {
      sides: cfg.groundSides, skirt: cfg.groundSkirt ?? 5, haze: lit ? [0, 0] : cfg.groundHaze || [0.3, 1], lit,
      mottle: lit ? 0 : cfg.groundMottle ?? 0.08, seed: cfg.seed ?? 1,
    });
  }
  // Open water is a flat tinted ring: animated ripples alias into moire this far out.
  if (cfg.sea) groundRing(b, frame, cfg.sea.y, lin(cfg.sea.color || '#3d6d82'), { sides: cfg.sea.sides, haze: cfg.sea.haze || [0.05, 0.9] });
  STYLES[cfg.style](b, rng, frame, cfg, palette);

  const group = new THREE.Group();
  group.name = 'map-backdrop';
  group.userData.cloudGuard = cloudGuard(cfg, frame, b);
  const geometry = b.build({ normals: lit });
  let material;
  if (lit) {
    material = new THREE.MeshLambertMaterial({ vertexColors: true });
    material.customProgramCacheKey = () => 'backdrop-lit-v1';
  } else {
    // `skyline: [h0, h1]` fades the whole backdrop out while the camera rises
    // from h0 to h1 metres above the backdrop ground (overview cameras). The
    // material is then blended; its transparency is fixed at map load.
    const skyline = Array.isArray(cfg.skyline) ? cfg.skyline : null;
    material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: !!skyline });
    const fade = { value: new THREE.Vector3(skyline ? skyline[0] : 1e5, skyline ? skyline[1] : 2e5, cfg.ground ?? 0) };
    const air = cfg.air || {};
    const uniform = { value: new THREE.Vector4(air.strength ?? 0.32, air.near ?? 60, air.far ?? 320, air.fog ?? 0.45) };
    const hazeColor = new THREE.Color(cfg.hazeColor || '#ffffff');
    const tint = { value: new THREE.Vector4(hazeColor.r, hazeColor.g, hazeColor.b, cfg.hazeColor ? cfg.hazeTint ?? 0.6 : 0) };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.backdropAir = uniform;
      shader.uniforms.backdropHaze = tint;
      shader.uniforms.backdropFade = fade;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 backdropFx;\nvarying vec2 vBackdropFx;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBackdropFx = backdropFx;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec4 backdropAir;\nuniform vec4 backdropHaze;\nuniform vec3 backdropFade;\nvarying vec2 vBackdropFx;')
        .replace('#include <fog_fragment>', AIR_FOG);
    };
    material.customProgramCacheKey = () => 'backdrop-air-v4';
  }
  material.name = 'backdrop';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'backdrop-silhouettes';
  mesh.matrixAutoUpdate = false;
  // A blended (skyline) backdrop draws first among transparents, right after
  // the opaque world, so water and particles in front still cover it.
  if (material.transparent) mesh.renderOrder = -5;
  group.add(mesh);
  return {
    group,
    stats: { draws: 1, vertices: geometry.attributes.position.count },
    dispose() {
      group.removeFromParent();
      geometry.dispose();
      material.dispose();
      group.clear();
    },
  };
}
