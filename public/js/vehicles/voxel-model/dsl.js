// Voxel modelling DSL for vehicle hulls. Every rigid part is a sparse grid of
// 0.2 m voxels authored in the hull frame (metres, ground at y=0, forward -Z).
// The mesher subtracts the part pivot, so a turret authored where it sits on
// the hull rotates about its own ring. Each voxel stores a palette material
// name and an optional fragment tag: tagged voxels render with the intact hull
// and break away as their own voxel chunk when the hull is destroyed.

export const VOXEL = 0.2;
const HALF = 1 << 9;
const SPAN = 1 << 10;

const cell = metres => Math.round(metres / VOXEL);
const key = (x, y, z) => ((x + HALF) * SPAN + (y + HALF)) * SPAN + (z + HALF);
const unkey = k => {
  const z = k % SPAN, rest = (k - z) / SPAN, y = rest % SPAN, x = (rest - y) / SPAN;
  return [x - HALF, y - HALF, z - HALF];
};
const AXES = Object.freeze({ x: 0, y: 1, z: 2 });

/** One rigid voxel part: authored in hull metres, meshed about `pivot`. */
export class VoxelPart {
  constructor(name, { pivot = [0, 0, 0], grid = [0, 0, 0] } = {}) {
    this.name = name;
    this.pivot = Object.freeze([...pivot]);
    // Grid offset (metres): cell boundaries sit at grid + k * VOXEL, so a
    // barrel can be centred exactly on its pivot.
    this.grid = Object.freeze([...grid]);
    this.cells = new Map();
    // priority: { [tag]: number } orders break-away pieces; breaks: instanced copies hide on wreck.
    this.userData = { priority: {}, breaks: false };
  }

  get size() { return this.cells.size; }

  /** Cell index of a metre coordinate on one axis (grid offset aware). */
  ci(metres, axis) { return cell(metres - this.grid[axis]); }
  /** Metre centre of a cell index on one axis. */
  cc(index, axis) { return (index + 0.5) * VOXEL + this.grid[axis]; }
  cells3(point) { return [this.ci(point[0], 0), this.ci(point[1], 1), this.ci(point[2], 2)]; }

  /** Set a single voxel by integer cell index (hull frame). */
  setCell(x, y, z, material, tag = null) {
    if (material == null) this.cells.delete(key(x, y, z));
    else this.cells.set(key(x, y, z), { material, tag });
    return this;
  }

  getCell(x, y, z) { return this.cells.get(key(x, y, z)) || null; }

  /** Inclusive-exclusive metre box snapped to the voxel grid. */
  box(min, max, material, { tag = null } = {}) {
    const [x0, y0, z0] = this.cells3(min), [x1, y1, z1] = this.cells3(max);
    for (let x = Math.min(x0, x1); x < Math.max(x0, x1); x++)
      for (let y = Math.min(y0, y1); y < Math.max(y0, y1); y++)
        for (let z = Math.min(z0, z1); z < Math.max(z0, z1); z++) this.setCell(x, y, z, material, tag);
    return this;
  }

  /**
   * Box whose extent along `slope` varies linearly along `along`. `from` and
   * `to` scale the slope-axis extent at the low and high end of `along`;
   * `anchor` 0 keeps the minimum face fixed, 1 the maximum and 0.5 centres it.
   * Sloped glacis plates, noses and tapered booms all use this.
   */
  wedge(min, max, material, { along = 'z', slope = 'y', from = 1, to = 0.4, anchor = 0, tag = null } = {}) {
    const a = AXES[along], s = AXES[slope];
    const lo = this.cells3(min), hi = this.cells3(max);
    const length = Math.max(1, hi[a] - lo[a]);
    const extent = hi[s] - lo[s];
    const index = [0, 0, 0];
    for (let i = lo[a]; i < hi[a]; i++) {
      const t = (i - lo[a] + 0.5) / length;
      const span = Math.max(1, Math.round(extent * (from + (to - from) * t)));
      const start = lo[s] + Math.round((extent - span) * anchor);
      const other = 3 - a - s;
      for (let j = start; j < start + span; j++) for (let k = lo[other]; k < hi[other]; k++) {
        index[a] = i; index[s] = j; index[other] = k;
        this.setCell(index[0], index[1], index[2], material, tag);
      }
    }
    return this;
  }

  /** Solid cylinder about `axis` through `center` (metres). */
  cyl(center, radius, length, axis, material, { tag = null, hollow = 0 } = {}) {
    const a = AXES[axis], u = (a + 1) % 3, v = (a + 2) % 3;
    const c = center.map((value, i) => (value - this.grid[i]) / VOXEL), r = radius / VOXEL, inner = hollow / VOXEL;
    const half = length / VOXEL / 2;
    const index = [0, 0, 0];
    // Axial cells whose centres lie within the length (minus a small margin),
    // so odd and even voxel widths both stay centred on their grid.
    for (let i = Math.floor(c[a] - half) - 1; i <= Math.ceil(c[a] + half) + 1; i++) {
      if (Math.abs(this.cc(i, a) - center[a]) > length / 2 - 0.05 + 1e-9) continue;
      for (let j = Math.floor(c[u] - r); j <= Math.ceil(c[u] + r); j++)
        for (let k = Math.floor(c[v] - r); k <= Math.ceil(c[v] + r); k++) {
          const d = Math.hypot(j + 0.5 - c[u], k + 0.5 - c[v]);
          if (d > r || d < inner) continue;
          index[a] = i; index[u] = j; index[v] = k;
          this.setCell(index[0], index[1], index[2], material, tag);
        }
    }
    return this;
  }

  /**
   * Extrude a 2-D polygon along `axis` over [from, to] metres. The polygon is
   * given in the two remaining axes in order (x: [z, y], y: [x, z], z: [x, y]).
   * `shell` > 0 keeps only cells within that distance of the outline (belts,
   * open frames); voxel centres decide membership.
   */
  prism(axis, polygon, [from, to], material, { shell = 0, tag = null } = {}) {
    const a = AXES[axis], u = axis === 'x' ? 2 : 0, v = axis === 'y' ? 2 : 1;
    const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
    const index = [0, 0, 0];
    for (let i = this.ci(Math.min(...xs), u) - 1; i <= this.ci(Math.max(...xs), u) + 1; i++)
      for (let j = this.ci(Math.min(...ys), v) - 1; j <= this.ci(Math.max(...ys), v) + 1; j++) {
        const px = this.cc(i, u), py = this.cc(j, v);
        if (!pointInPolygon(px, py, polygon)) continue;
        if (shell > 0 && distanceToOutline(px, py, polygon) > shell) continue;
        for (let k = this.ci(from, a); k < this.ci(to, a); k++) {
          index[a] = k; index[u] = i; index[v] = j;
          this.setCell(index[0], index[1], index[2], material, tag);
        }
      }
    return this;
  }

  /**
   * Fuselage loft along Z. Stations are [z, halfWidth, yBottom, yTop, power]
   * sorted by z; cross sections interpolate linearly and use a superellipse
   * (power 2 = ellipse, 4 = rounded box, 12 = near box). `xOffset` shifts the
   * whole loft (engine nacelles, pods).
   */
  loft(stations, material, { tag = null, xOffset = 0, shell = 0 } = {}) {
    const sorted = [...stations].sort((a, b) => a[0] - b[0]);
    const z0 = this.ci(sorted[0][0], 2), z1 = this.ci(sorted.at(-1)[0], 2);
    for (let k = z0; k < z1; k++) {
      const z = this.cc(k, 2);
      let s = 0;
      while (s < sorted.length - 2 && sorted[s + 1][0] <= z) s++;
      const a = sorted[s], b = sorted[s + 1], t = Math.max(0, Math.min(1, (z - a[0]) / Math.max(1e-6, b[0] - a[0])));
      const lerp = i => a[i] + (b[i] - a[i]) * t;
      const hw = lerp(1), yb = lerp(2), yt = lerp(3), power = lerp(4) || 4;
      if (hw <= 0 || yt <= yb) continue;
      const cy = (yb + yt) / 2, hh = (yt - yb) / 2;
      for (let i = this.ci(xOffset - hw, 0) - 1; i <= this.ci(xOffset + hw, 0) + 1; i++)
        for (let j = this.ci(yb, 1) - 1; j <= this.ci(yt, 1) + 1; j++) {
          const dx = Math.abs((this.cc(i, 0) - xOffset) / hw), dy = Math.abs((this.cc(j, 1) - cy) / hh);
          const f = Math.pow(dx, power) + Math.pow(dy, power);
          if (f > 1) continue;
          if (shell > 0) {
            const inner = Math.pow(dx * hw / Math.max(0.01, hw - shell), power) + Math.pow(dy * hh / Math.max(0.01, hh - shell), power);
            if (inner <= 1) continue;
          }
          this.setCell(i, j, k, material, tag);
        }
    }
    return this;
  }

  /** Remove every voxel inside a metre box. */
  carve(min, max) {
    const [x0, y0, z0] = this.cells3(min), [x1, y1, z1] = this.cells3(max);
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) this.cells.delete(key(x, y, z));
    return this;
  }

  /** Recolour existing voxels inside a box; `where(material)` filters them. */
  paint(min, max, material, { where = null, tag = undefined } = {}) {
    const [x0, y0, z0] = this.cells3(min), [x1, y1, z1] = this.cells3(max);
    for (const [k, voxel] of this.cells) {
      const [x, y, z] = unkey(k);
      if (x < x0 || x >= x1 || y < y0 || y >= y1 || z < z0 || z >= z1) continue;
      if (where && !where(voxel.material, voxel.tag)) continue;
      voxel.material = material;
      if (tag !== undefined) voxel.tag = tag;
    }
    return this;
  }

  /**
   * Paint only the exposed outer layer of a box (decals, stripes, roundels);
   * `where(material, tag)` filters which voxels take the paint.
   */
  skin(min, max, material, { normal = null, where = null } = {}) {
    const [x0, y0, z0] = this.cells3(min), [x1, y1, z1] = this.cells3(max);
    for (const [k, voxel] of this.cells) {
      const [x, y, z] = unkey(k);
      if (x < x0 || x >= x1 || y < y0 || y >= y1 || z < z0 || z >= z1) continue;
      if (where && !where(voxel.material, voxel.tag)) continue;
      const open = normal ? !this.cells.has(key(x + normal[0], y + normal[1], z + normal[2]))
        : [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
          .some(([dx, dy, dz]) => !this.cells.has(key(x + dx, y + dy, z + dz)));
      if (open) voxel.material = material;
    }
    return this;
  }

  /**
   * Team roundel on the surface facing `normal` ([0,1,0] roof, [±1,0,0] sides):
   * a disc of `inner` inside a ring of `outer`, painted only on exposed cells
   * within `depth` metres of the plane through `center`.
   */
  roundel(center, radius, normal, { inner = 'roundel', outer = 'ring', ring = 0.2, depth = 0.6 } = {}) {
    const axis = normal.findIndex(value => value !== 0);
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const [k, voxel] of this.cells) {
      const p = unkey(k);
      const q = [p[0] + normal[0], p[1] + normal[1], p[2] + normal[2]];
      if (this.cells.has(key(q[0], q[1], q[2]))) continue;
      const c = [this.cc(p[0], 0), this.cc(p[1], 1), this.cc(p[2], 2)];
      if (Math.abs(c[axis] - center[axis]) > depth) continue;
      const d = Math.hypot(c[u] - center[u], c[v] - center[v]);
      if (d > radius) continue;
      voxel.material = d > radius - ring ? outer : inner;
    }
    return this;
  }

  /** Mirror every voxel across x=0 (left/right symmetric details). */
  mirrorX({ onlyPositive = false } = {}) {
    const additions = [];
    for (const [k, voxel] of this.cells) {
      const [x, y, z] = unkey(k);
      if (onlyPositive && x < 0) continue;
      additions.push([Math.round(-2 * this.grid[0] / VOXEL) - 1 - x, y, z, voxel]);
    }
    for (const [x, y, z, voxel] of additions) {
      const mirroredTag = typeof voxel.tag === 'string'
        ? voxel.tag.replace(/-right$/, '-LEFT').replace(/-left$/, '-right').replace(/-LEFT$/, '-left') : voxel.tag;
      this.setCell(x, y, z, voxel.material, mirroredTag);
    }
    return this;
  }

  /** Iterate voxels as [x, y, z, material, tag] with integer cell indices. */
  *voxels() {
    for (const [k, voxel] of this.cells) {
      const [x, y, z] = unkey(k);
      yield [x, y, z, voxel.material, voxel.tag];
    }
  }

  /** Integer cell bounds [min, max) or null for an empty part. */
  bounds() {
    if (!this.cells.size) return null;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const k of this.cells.keys()) {
      const p = unkey(k);
      for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i] + 1); }
    }
    return { min, max };
  }

  tags() {
    const tags = new Set();
    for (const voxel of this.cells.values()) if (voxel.tag) tags.add(voxel.tag);
    return [...tags];
  }
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToOutline(x, y, polygon) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j], [bx, by] = polygon[i];
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}

/** Convenience: metres to the nearest voxel boundary. */
export const snap = metres => cell(metres) * VOXEL;
