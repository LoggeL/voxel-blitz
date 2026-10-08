// 2.5D surface navigation for large heightfield maps (mapMeta.navigation
// {mode:'surface', cell, maxStep}).
//
// The world is cut into square cells (4 voxels on Frontier). Each cell holds
// up to two standable layers found from real voxels: the ground (or a bridge
// deck over water, or an interior floor under a roof) and an upper surface at
// least three voxels higher (a deck over a dry bank, an upper storey). A layer
// needs two voxels of headroom and support from at least two of the cell's
// four inner columns. Open water with air above is a swim node: legal but
// expensive. Edges join the eight neighbours; each is validated by walking the
// straight line between cell centres at half-voxel steps, so walls, fences,
// trench lips and cliffs are found from the voxels themselves. Steps up of up
// to maxStep voxels are ordinary hops, one more is a vault (costlier), drops
// of up to three voxels are allowed downhill only: edges are directional.
//
// Routes are A* on typed arrays with an octile heuristic. A request whose
// target cannot be reached returns the path to the reachable node closest to
// it (flagged partial). Terrain changes are applied incrementally from the
// engine's changed-block log; nothing is rebuilt wholesale after attach.

import { worldDimensions } from '../shared/world/dimensions.js';
import { FLUID_BLOCKS, isSolidBlock } from '../shared/world/blocks.js';

const NAVS = new WeakMap();
// Graphs of pristine template worlds, per template voxels and graph options:
// a fresh room (or a fully restored map) copies them instead of rebuilding.
const PRISTINE_GRAPHS = new WeakMap();
const DIRS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]);
const OPPOSITE = Object.freeze([1, 0, 3, 2, 5, 4, 7, 6]);
const SQRT2 = Math.SQRT2;
const MAX_DROP = 3;          // voxels a walker may step down along an edge
const SOLID_RUN_STOP = 6;    // consecutive solid voxels that end a column scan (terrain mass)
const WATER_COST = 10;       // swimming is legal but slow, exposed and the banks are steep
const VAULT_COST = 1.6;      // a two-voxel rise needs a vault
const CLIMB_COST = 0.15;     // per voxel of rise, so gentle routes win ties
const LOOKAHEAD = 14;        // metres of straight walk a follower may skip ahead
const ROUTE_TTL_MS = 6000;
// A* node expansions per tick after which further replans wait for the next
// tick (a follower keeps its previous route meanwhile). The first search of a
// tick always runs, so a burst of replans (match start, a squad order, a
// crater across many routes) spreads over a few ticks instead of one.
const SEARCH_BUDGET_NODES = 12000;
const REVERSE_PROBE_NODES = 2048;    // reverse flood from a goal in another component before the full A*
const PARTIAL_SEARCH_NODES = 4096;   // A* budget toward a goal known to be unreachable
const CHANGE_LOG = 32;               // applyChanges entries kept for route invalidation
const UNREACHED_TARGET_SLACK = 8;    // m an unreachable (partial) route's target may move before a replan

const NODE_NONE = -1;
const F_WALK = 1, F_WATER = 2;

function passable(block) { return !isSolidBlock(block) && !FLUID_BLOCKS.has(block); }

/** Surface navigation for a world, built once and cached; null for other maps. */
export function surfaceNavigation(world) {
  if (world?.meta?.navigation?.mode !== 'surface') return null;
  let nav = NAVS.get(world);
  if (!nav) {
    nav = new SurfaceNav(world, world.meta.navigation);
    nav.rebuild();
    NAVS.set(world, nav);
  }
  return nav;
}

export class SurfaceNav {
  constructor(world, { cell = 4, maxStep = 1 } = {}) {
    this.world = world;
    const { sx, sy, sz } = worldDimensions(world);
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.cell = Math.max(2, Math.min(8, Math.trunc(cell) || 4));
    this.maxStep = Math.max(1, Math.trunc(maxStep) || 1);
    this.maxClimb = this.maxStep + 1;
    this.gw = Math.ceil(sx / this.cell);
    this.gd = Math.ceil(sz / this.cell);
    const cells = this.gw * this.gd;
    this.nodes = cells * 2;
    this.height = new Int16Array(this.nodes).fill(NODE_NONE);  // feet y of a layer
    this.flags = new Uint8Array(this.nodes);
    this.edges = new Uint16Array(this.nodes);   // 8 directions x 2 bits: target layer 0 / 1
    this.component = new Int32Array(this.nodes).fill(-1);
    this.revision = 0;
    this.buildMs = 0;
    // A* scratch, reused by every query.
    this.g = new Float32Array(this.nodes);
    this.f = new Float32Array(this.nodes);
    this.parent = new Int32Array(this.nodes);
    this.stamp = new Uint32Array(this.nodes);
    this.closed = new Uint32Array(this.nodes);
    this.search = 0;
    this.lastExpanded = 0;
    this.budgetAt = NaN;        // tick time of the expansion budget below
    this.budgetUsed = 0;        // A* expansions spent by waypoint() this tick
    this.heap = new Int32Array(this.nodes);
    this.heapSize = 0;
    this.rstamp = new Uint32Array(this.nodes);
    this.rsearch = 0;
    this.rqueue = new Int32Array(REVERSE_PROBE_NODES + 16);
    this.changes = [];          // [{ revision, cells: Set }] from applyChanges, newest last
    this.colScratch = [];
    // Node offset of each direction's neighbour cell (layer 0), for flood fills.
    this.dirOffsets = Int32Array.from(DIRS, ([dx, dz]) => (dz * this.gw + dx) * 2);
    this.floodQueue = null;
    this.watch = null;          // TerrainWatch over the engine's changed-block log (set by the bot manager)
  }

  // ---------------------------------------------------------------- build --

  /** Full build from the world's voxels. */
  build() {
    const start = performance.now();
    const cells = this.gw * this.gd;
    for (let c = 0; c < cells; c++) this.computeCell(c, true);
    for (let c = 0; c < cells; c++) this.computeEdgesFrom(c, true);
    this.labelComponents();
    this.buildMs = performance.now() - start;
    return this;
  }

  /**
   * build(), except that a world matching its pristine template copies the
   * template's graph (the graph is a pure function of the voxels; built once
   * per process): a new room or a fully restored map skips ~110 ms of work.
   */
  rebuild() {
    const template = this.world.matchesTemplate?.() ? this.world.templateBlocks : null;
    if (!template) return this.build();
    const key = `${this.cell}:${this.maxStep}:${this.nodes}`;
    const cached = PRISTINE_GRAPHS.get(template)?.get(key);
    if (!cached) {
      this.build();
      if (!PRISTINE_GRAPHS.has(template)) PRISTINE_GRAPHS.set(template, new Map());
      PRISTINE_GRAPHS.get(template).set(key, { height: this.height.slice(), flags: this.flags.slice(),
        edges: this.edges.slice(), component: this.component.slice() });
      return this;
    }
    const start = performance.now();
    this.height.set(cached.height); this.flags.set(cached.flags);
    this.edges.set(cached.edges); this.component.set(cached.component);
    this.buildMs = performance.now() - start;
    return this;
  }

  /** Standable feet heights in one column, top down, plus the open water surface (feet y) or -1. */
  scanColumn(x, z, initial, out) {
    out.length = 0;
    const getBlock = this.world.getBlock;
    let top = initial ? this.world.heightAt?.(x, z) : -1;
    if (!Number.isFinite(top) || top < 0 || top >= this.sy) top = this.sy - 1;
    let y = Math.min(this.sy - 1, top + 3);
    let headroom = y >= this.sy - 1 ? 3 : 0, solidRun = 0, water = -1;
    for (; y >= 0; y--) {
      const block = getBlock(x, y, z);
      if (FLUID_BLOCKS.has(block)) {
        if (water < 0 && headroom >= 1) water = y;
        headroom = 0; solidRun = 0;
        continue;
      }
      if (isSolidBlock(block)) {
        if (headroom >= 2) out.push(y + 1);
        headroom = 0;
        if (++solidRun >= SOLID_RUN_STOP) break;
      } else { headroom++; solidRun = 0; }
    }
    return water;
  }

  computeCell(c, initial) {
    const cx = c % this.gw, cz = (c / this.gw) | 0, cell = this.cell;
    const x0 = cx * cell, z0 = cz * cell;
    const lo = cell >= 4 ? 1 : 0, hi = cell >= 4 ? 2 : cell - 1;
    const floors = [];        // [height, column]
    let waterCols = 0, waterY = 0, column = 0;
    const scratch = this.colScratch;
    for (let dz = lo; dz <= hi; dz++) for (let dx = lo; dx <= hi; dx++) {
      const x = x0 + dx, z = z0 + dz;
      if (x >= this.sx || z >= this.sz) { column++; continue; }
      const water = this.scanColumn(x, z, initial, scratch);
      for (const h of scratch) floors.push(h * 8 + column);
      if (water >= 0) { waterCols++; waterY = Math.max(waterY, water); }
      column++;
    }
    const a = c * 2, b = a + 1;
    this.height[a] = this.height[b] = NODE_NONE;
    this.flags[a] = this.flags[b] = 0;
    floors.sort((p, q) => p - q);
    // Cluster heights whose neighbours differ by at most one voxel; a cluster
    // needs two distinct supporting columns.
    const clusters = [];
    let i = 0;
    while (i < floors.length) {
      let j = i, mask = 0, sum = 0, n = 0;
      let last = floors[i] >> 3;
      while (j < floors.length && (floors[j] >> 3) - last <= 1) {
        last = floors[j] >> 3; mask |= 1 << (floors[j] & 7); sum += last; n++; j++;
      }
      let cols = 0; for (let m = mask; m; m &= m - 1) cols++;
      if (cols >= 2) clusters.push(Math.round(sum / n));
      i = j;
    }
    // Two layers per cell, by importance: the lowest walkable floor (ground,
    // bridge deck, interior floor); then an open water surface at least three
    // voxels below it (the river under a deck) or, failing that, the highest
    // floor three or more above it (an upper storey). Open river cells with
    // no floor become swim nodes.
    const swim = waterCols >= 2 && !clusters.some(h => Math.abs(h - waterY) <= 2);
    if (clusters.length) {
      this.height[a] = clusters[0]; this.flags[a] = F_WALK;
      if (swim && clusters[0] - waterY >= 3) { this.height[b] = waterY; this.flags[b] = F_WATER; }
      else for (let k = clusters.length - 1; k >= 1; k--) {
        if (clusters[k] - clusters[0] >= 3) { this.height[b] = clusters[k]; this.flags[b] = F_WALK; break; }
      }
    } else if (swim) { this.height[a] = waterY; this.flags[a] = F_WATER; }
    if (cx === 0 || cz === 0 || cx === this.gw - 1 || cz === this.gd - 1) {
      // Map rim cells never carry routes (the outer wall and boundary).
      this.height[a] = this.height[b] = NODE_NONE; this.flags[a] = this.flags[b] = 0;
    }
  }

  /** Feet y of the standable (or swimmable) surface in a column nearest to `h`, within [h-down, h+up], or NaN. */
  floorNear(x, z, h, up = this.maxClimb, down = MAX_DROP) {
    x = Math.floor(x); z = Math.floor(z);
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return NaN;
    const getBlock = this.world.getBlock;
    let best = NaN, bestDelta = Infinity;
    const top = Math.min(this.sy - 2, h + up), bottom = Math.max(1, h - down);
    let above = getBlock(x, top + 1, z), at = getBlock(x, top, z);
    for (let feet = top; feet >= bottom; feet--) {
      const below = getBlock(x, feet - 1, z);
      const surface = (FLUID_BLOCKS.has(at) && passable(above))
        || (isSolidBlock(below) && passable(at) && passable(above));
      if (surface) {
        const delta = Math.abs(feet - h);
        if (delta < bestDelta) { best = feet; bestDelta = delta; if (!delta) break; }
      }
      above = at; at = below;
    }
    return best;
  }

  /**
   * Walk a straight line at half-voxel steps from (ax,az,ah) to (bx,bz).
   * Returns the arrival height and the extreme per-step rise and drop, or null
   * when the line is blocked (a wall, a missing floor, no body clearance).
   */
  walkLine(ax, az, ah, bx, bz) {
    const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(length / 0.5));
    const nx = length > 1e-6 ? -dz / length : 0, nz = length > 1e-6 ? dx / length : 0;
    const getBlock = this.world.getBlock;
    let h = ah, rise = 0, drop = 0, water = 0;
    let lastX = Math.floor(ax), lastZ = Math.floor(az);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, px = ax + dx * t, pz = az + dz * t;
      const vx = Math.floor(px), vz = Math.floor(pz);
      if (vx === lastX && vz === lastZ && i < steps) continue;
      lastX = vx; lastZ = vz;
      const next = this.floorNear(px, pz, h, this.maxClimb, MAX_DROP);
      if (Number.isNaN(next)) return null;
      const delta = next - h;
      if (delta > rise) rise = delta;
      if (-delta > drop) drop = -delta;
      h = next;
      if (FLUID_BLOCKS.has(getBlock(vx, h, vz))) water++;
      // Shoulder clearance at chest height on both sides of the line.
      for (const side of [-0.32, 0.32]) {
        const sx = Math.floor(px + nx * side), sz = Math.floor(pz + nz * side);
        if (sx === vx && sz === vz) continue;
        if (!passable(getBlock(sx, h + 1, sz)) && !FLUID_BLOCKS.has(getBlock(sx, h + 1, sz))) return null;
      }
    }
    return { h, rise, drop, water };
  }

  cellCenter(c) {
    const half = this.cell / 2;
    return [(c % this.gw) * this.cell + half, ((c / this.gw) | 0) * this.cell + half];
  }

  /** (Re)compute the edges of one cell's layers, both directions of every link. */
  computeEdgesFrom(c, initial) {
    const cx = c % this.gw, cz = (c / this.gw) | 0;
    const [ax, az] = this.cellCenter(c);
    for (let d = 0; d < 8; d++) {
      // During the full build each undirected pair is visited once (from the lower index).
      const nxC = cx + DIRS[d][0], nzC = cz + DIRS[d][1];
      if (nxC < 0 || nzC < 0 || nxC >= this.gw || nzC >= this.gd) {
        for (let l = 0; l < 2; l++) this.edges[c * 2 + l] &= ~(3 << (d * 2));
        continue;
      }
      const n = nzC * this.gw + nxC;
      if (initial && n < c) continue;
      for (let l = 0; l < 2; l++) this.edges[c * 2 + l] &= ~(3 << (d * 2));
      for (let l = 0; l < 2; l++) this.edges[n * 2 + l] &= ~(3 << (OPPOSITE[d] * 2));
      if (d >= 4 && !this.diagonalOpen(cx, cz, nxC, nzC)) continue;
      const [bx, bz] = this.cellCenter(n);
      for (let la = 0; la < 2; la++) {
        const a = c * 2 + la;
        if (!this.flags[a]) continue;
        for (let lb = 0; lb < 2; lb++) {
          const b = n * 2 + lb;
          if (!this.flags[b]) continue;
          const ha = this.height[a], hb = this.height[b];
          if (Math.abs(hb - ha) > MAX_DROP) continue;
          const walk = this.walkLine(ax, az, ha, bx, bz);
          if (!walk || Math.abs(walk.h - hb) > 1) continue;
          // Forward: rises within the climb limit, drops within MAX_DROP.
          if (walk.rise <= this.maxClimb && walk.drop <= MAX_DROP) this.edges[a] |= (1 << lb) << (d * 2);
          // Reverse traverses the same voxels with rise and drop swapped.
          if (walk.drop <= this.maxClimb && walk.rise <= MAX_DROP) this.edges[b] |= (1 << la) << (OPPOSITE[d] * 2);
        }
      }
    }
  }

  /** Diagonal moves must not cut a corner both of whose orthogonal cells are empty. */
  diagonalOpen(ax, az, bx, bz) {
    const c1 = az * this.gw + bx, c2 = bz * this.gw + ax;
    return (this.flags[c1 * 2] || this.flags[c1 * 2 + 1]) && (this.flags[c2 * 2] || this.flags[c2 * 2 + 1]);
  }

  labelComponents() {
    // Strongly connected components are overkill here: label by forward
    // reachability from the largest region, others get their own labels.
    // Edges only join in-bounds neighbours, so a neighbour is node base + offset.
    const component = this.component, flags = this.flags, edges = this.edges, off = this.dirOffsets;
    const nodes = this.nodes, queue = (this.floodQueue ??= new Int32Array(nodes));
    component.fill(-1);
    let label = 0;
    for (let s = 0; s < nodes; s++) {
      if (!flags[s] || component[s] >= 0) continue;
      let read = 0, write = 0;
      queue[write++] = s; component[s] = label;
      while (read < write) {
        const node = queue[read++];
        let mask = edges[node];
        const base = node & ~1;
        for (let d = 0; mask; d++, mask >>= 2) {
          const bits = mask & 3;
          if (!bits) continue;
          const next = base + off[d];
          if ((bits & 1) && component[next] < 0) { component[next] = label; queue[write++] = next; }
          if ((bits & 2) && component[next + 1] < 0) { component[next + 1] = label; queue[write++] = next + 1; }
        }
      }
      label++;
    }
  }

  // --------------------------------------------------------------- queries --

  nodePoint(node) {
    const c = node >> 1, [x, z] = this.cellCenter(c);
    return { x, y: this.height[node] + 0.02, z };
  }

  /** The node for a world position: its cell's layer nearest in height, else a nearby cell. */
  nodeAt(point, radiusCells = 3) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return NODE_NONE;
    const y = Number.isFinite(point.y) ? point.y : NaN;
    const cx = Math.floor(point.x / this.cell), cz = Math.floor(point.z / this.cell);
    let best = NODE_NONE, bestScore = Infinity;
    for (let r = 0; r <= radiusCells; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= this.gw || z >= this.gd) continue;
        const c = z * this.gw + x;
        for (let l = 0; l < 2; l++) {
          const node = c * 2 + l;
          if (!this.flags[node]) continue;
          const dh = Number.isFinite(y) ? Math.abs(this.height[node] - y) : 0;
          if (Number.isFinite(y) && dh > 4 + r) continue;
          const [px, pz] = this.cellCenter(c);
          const score = Math.hypot(px - point.x, pz - point.z) + dh * 1.5 + (this.flags[node] & F_WATER ? 6 : 0);
          if (score < bestScore) { bestScore = score; best = node; }
        }
      }
      if (best !== NODE_NONE && r >= 1) break;
    }
    return best;
  }

  /** Feet position on the navigable surface near a world point, or null. */
  snap(point, radiusCells = 4) {
    const node = this.nodeAt(point, radiusCells);
    return node === NODE_NONE ? null : this.nodePoint(node);
  }

  heapPush(node) {
    // Lazy deletion lets a node sit in the open list more than once: grow
    // instead of letting a typed-array write past the end vanish silently.
    if (this.heapSize >= this.heap.length) {
      const grown = new Int32Array(this.heap.length * 2);
      grown.set(this.heap);
      this.heap = grown;
    }
    const heap = this.heap, f = this.f;
    let i = this.heapSize++;
    heap[i] = node;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (f[heap[parent]] <= f[node]) break;
      heap[i] = heap[parent]; i = parent;
    }
    heap[i] = node;
  }
  heapPop() {
    const heap = this.heap, f = this.f;
    const top = heap[0], last = heap[--this.heapSize];
    let i = 0;
    const size = this.heapSize;
    while (true) {
      let child = i * 2 + 1;
      if (child >= size) break;
      if (child + 1 < size && f[heap[child + 1]] < f[heap[child]]) child++;
      if (f[heap[child]] >= f[last]) break;
      heap[i] = heap[child]; i = child;
    }
    heap[i] = last;
    return top;
  }

  edgeCost(from, to, diagonal) {
    let cost = this.cell * (diagonal ? SQRT2 : 1);
    if (this.flags[to] & F_WATER) cost *= WATER_COST;
    const rise = this.height[to] - this.height[from];
    if (rise > 0) cost += rise * CLIMB_COST * this.cell + (rise > this.maxStep ? VAULT_COST * this.cell : 0);
    return cost;
  }

  /**
   * A* between two nodes. Returns node ids from start to the goal, or to the
   * explored node nearest the goal (partial) when the goal is unreachable.
   */
  searchNodes(start, goal, maxExpanded = this.nodes) {
    const stampValue = ++this.search;
    if (stampValue >= 0xffffffff) { this.stamp.fill(0); this.closed.fill(0); this.search = 1; }
    const s = this.search;
    const gw = this.gw, cell = this.cell, gcx = (goal >> 1) % gw, gcz = ((goal >> 1) / gw) | 0;
    const heuristic = node => {
      const c = node >> 1;
      const dx = Math.abs(c % gw - gcx), dz = Math.abs(((c / gw) | 0) - gcz);
      return (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)) * cell * 0.999;
    };
    this.heapSize = 0;
    this.g[start] = 0; this.f[start] = heuristic(start); this.parent[start] = -1; this.stamp[start] = s;
    this.heapPush(start);
    let best = start, bestH = this.f[start], expanded = 0;
    while (this.heapSize) {
      const node = this.heapPop();
      if (this.closed[node] === s) continue;
      this.closed[node] = s;
      if (node === goal) { best = goal; break; }
      const h = this.f[node] - this.g[node];
      if (h < bestH) { bestH = h; best = node; }
      if (++expanded > maxExpanded) break;
      const mask = this.edges[node];
      if (!mask) continue;
      const c = node >> 1, cx = c % this.gw, cz = (c / this.gw) | 0;
      for (let d = 0; d < 8; d++) {
        const bits = (mask >> (d * 2)) & 3;
        if (!bits) continue;
        const n = (cz + DIRS[d][1]) * this.gw + cx + DIRS[d][0];
        for (let l = 0; l < 2; l++) {
          if (!(bits & (1 << l))) continue;
          const next = n * 2 + l;
          if (this.closed[next] === s) continue;
          const g = this.g[node] + this.edgeCost(node, next, d >= 4);
          if (this.stamp[next] === s && g >= this.g[next]) continue;
          this.stamp[next] = s; this.g[next] = g; this.parent[next] = node;
          this.f[next] = g + heuristic(next);
          this.heapPush(next);
        }
      }
    }
    this.lastExpanded = expanded;
    const path = [];
    for (let node = best; node !== -1; node = this.parent[node]) {
      path.push(node);
      if (node === start) break;
    }
    path.reverse();
    return { nodes: path, reached: best === goal, cost: this.g[best] };
  }

  /**
   * Cheap proof that `goal` cannot be reached from `start`: flood the edges
   * backwards from the goal. A pocket (a roof, a sealed ledge) has a small
   * reverse set; when it is exhausted without meeting `start`, no route
   * exists. Returns false when the flood is cut off by its budget (unknown).
   */
  provablyUnreachable(start, goal, budget = REVERSE_PROBE_NODES) {
    if (++this.rsearch >= 0xffffffff) { this.rstamp.fill(0); this.rsearch = 1; }
    const s = this.rsearch, queue = this.rqueue;
    let read = 0, write = 0;
    queue[write++] = goal; this.rstamp[goal] = s;
    while (read < write) {
      const node = queue[read++];
      if (node === start) return false;
      const c = node >> 1, layer = node & 1, cx = c % this.gw, cz = (c / this.gw) | 0;
      for (let d = 0; d < 8; d++) {
        const x = cx + DIRS[d][0], z = cz + DIRS[d][1];
        if (x < 0 || z < 0 || x >= this.gw || z >= this.gd) continue;
        const n = z * this.gw + x, back = OPPOSITE[d] * 2;
        for (let l = 0; l < 2; l++) {
          const prev = n * 2 + l;
          if (this.rstamp[prev] === s || !(((this.edges[prev] >> back) & 3) & (1 << layer))) continue;
          if (write >= budget) return false;
          this.rstamp[prev] = s; queue[write++] = prev;
        }
      }
    }
    return true;
  }

  /**
   * The node a route starts from: nodeAt's pick when the body can walk (or
   * swim) to it in a straight line, else the best-scored nearby node it can.
   * A swimmer beside a quay or under a deck would otherwise start from the
   * bank or crater floor behind the wall and press into that wall forever.
   */
  startNode(from) {
    const picked = this.nodeAt(from);
    if (picked === NODE_NONE || !Number.isFinite(from.y) || this.segmentWalkable(from, this.nodePoint(picked))) return picked;
    const getBlock = this.world.getBlock;
    const wet = FLUID_BLOCKS.has(getBlock(Math.floor(from.x), Math.floor(from.y + 0.55), Math.floor(from.z)));
    const cx = Math.floor(from.x / this.cell), cz = Math.floor(from.z / this.cell);
    const candidates = [];
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= this.gw || z >= this.gd) continue;
      for (let l = 0; l < 2; l++) {
        const node = (z * this.gw + x) * 2 + l;
        if (!this.flags[node] || node === picked) continue;
        const dh = Math.abs(this.height[node] - from.y);
        if (dh > 4) continue;
        const [px, pz] = this.cellCenter(node >> 1);
        const water = !!(this.flags[node] & F_WATER);
        candidates.push({ node, score: Math.hypot(px - from.x, pz - from.z) + dh * 1.5 + (water !== wet ? 6 : 0) });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    for (let i = 0; i < Math.min(8, candidates.length); i++) {
      if (this.segmentWalkable(from, this.nodePoint(candidates[i].node))) return candidates[i].node;
    }
    return picked;
  }

  /** World-space route from `from` to `to` (feet points), possibly partial. */
  route(from, to) {
    const start = this.startNode(from), goal = this.nodeAt(to);
    if (start === NODE_NONE || goal === NODE_NONE) return { points: [], reached: false, length: Infinity };
    // A goal outside the start's component is usually a pocket: prove it
    // cheaply and walk a budgeted partial route toward it instead of
    // exhausting the whole component (~6 ms on Frontier).
    const pocket = this.component[start] !== this.component[goal] && this.provablyUnreachable(start, goal);
    const result = this.searchNodes(start, goal, pocket ? PARTIAL_SEARCH_NODES : this.nodes);
    const points = result.nodes.map(node => this.nodePoint(node));
    if (result.reached) {
      const last = points.at(-1);
      // Finish on the exact requested point when it is a short straight walk away.
      if (!last || Math.hypot(last.x - to.x, last.z - to.z) < this.cell * 1.5) points.push({ x: to.x, y: Number.isFinite(to.y) ? to.y : last?.y ?? 0, z: to.z });
    }
    let length = 0, prev = from;
    for (const point of points) { length += Math.hypot(point.x - prev.x, point.z - prev.z); prev = point; }
    return { points, reached: result.reached, length };
  }

  /** Grid cells a polyline crosses (sampled every half cell), for change checks. */
  routeCells(from, points) {
    const cells = new Set(), step = this.cell * 0.5;
    let prev = from;
    const add = (x, z) => {
      const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
      if (cx >= 0 && cz >= 0 && cx < this.gw && cz < this.gd) cells.add(cz * this.gw + cx);
    };
    add(from.x, from.z);
    for (const point of points) {
      const n = Math.max(1, Math.ceil(Math.hypot(point.x - prev.x, point.z - prev.z) / step));
      for (let i = 1; i <= n; i++) add(prev.x + (point.x - prev.x) * i / n, prev.z + (point.z - prev.z) * i / n);
      prev = point;
    }
    return cells;
  }

  /**
   * Whether every graph change since a route was planned left its cells
   * alone. Changes are logged with their 3 x 3 ring, so a crater beside the
   * line counts. A gap in the log (a full rebuild) means unknown: replan.
   */
  routeIntact(route) {
    if (!route.cells || !route.reached) return false;
    const pending = this.changes.filter(change => change.revision > route.revision);
    if (pending.length !== this.revision - route.revision) return false;
    for (const change of pending) for (const cell of change.cells) if (route.cells.has(cell)) return false;
    return true;
  }

  /** Whether a body can walk a straight line between two feet positions. */
  segmentWalkable(from, to) {
    const h = Math.round(from.y - 0.02);
    const start = this.floorNear(from.x, from.z, h, 1, 2);
    if (Number.isNaN(start)) return false;
    const walk = this.walkLine(from.x, from.z, start, to.x, to.z);
    if (!walk || walk.rise > this.maxClimb || walk.drop > MAX_DROP) return false;
    // A dry walker never shortcuts through water: swims are only taken where
    // the graph routes them (expensive water nodes), not by a straight line.
    if (walk.water > 0 && !FLUID_BLOCKS.has(this.world.getBlock(Math.floor(from.x), start, Math.floor(from.z)))) return false;
    return !Number.isFinite(to.y) || Math.abs(walk.h - Math.round(to.y - 0.02)) <= 1;
  }

  /** Next steering point for a follower, refreshing the cached route as needed. */
  waypoint(from, to, brain, now) {
    if (!to) return to;
    let route = brain.surfaceRoute;
    // Terrain changes elsewhere on the map keep a route; only one whose cells
    // changed replans (shelling would otherwise replan every bot at once).
    if (route && route.revision !== this.revision && this.routeIntact(route)) route.revision = this.revision;
    // A partial route toward an unreachable target only replans when the
    // target moved well away (a strafing enemy on a roof).
    const slack = route?.reached === false ? UNREACHED_TARGET_SLACK : 3;
    const stale = !route || now >= route.until || route.revision !== this.revision
      || Math.hypot(to.x - route.target.x, to.z - route.target.z) > slack
      || Math.hypot(from.x - route.last.x, from.z - route.last.z) > 10;
    if (stale) {
      // Short open lines need no search at all.
      if (Math.hypot(to.x - from.x, to.z - from.z) <= LOOKAHEAD && this.segmentWalkable(from, to)) {
        brain.surfaceRoute = { target: { x: to.x, y: to.y, z: to.z }, points: [{ x: to.x, y: to.y, z: to.z }],
          until: now + 1500, last: { x: from.x, z: from.z }, revision: this.revision, reached: true,
          cells: this.routeCells(from, [to]) };
        return brain.surfaceRoute.points[0];
      }
      if (this.budgetAt !== now) { this.budgetAt = now; this.budgetUsed = 0; }
      if (this.budgetUsed >= SEARCH_BUDGET_NODES) {
        // Over this tick's search budget: keep walking the old route, or hold
        // still for a tick when there is none here yet (none, or the body
        // respawned or teleported away from it).
        if (!route || Math.hypot(from.x - route.last.x, from.z - route.last.z) > 10) return { x: from.x, y: from.y, z: from.z };
        route.last = { x: from.x, z: from.z };
        return this.followRoute(from, route);
      }
      this.lastExpanded = 0;
      const planned = this.route(from, to);
      this.budgetUsed += Math.max(1, this.lastExpanded);
      route = brain.surfaceRoute = { target: { x: to.x, y: to.y, z: to.z }, points: planned.points,
        until: now + ROUTE_TTL_MS + ((brain.index ?? 0) % 8) * 125, last: { x: from.x, z: from.z },
        revision: this.revision, reached: planned.reached, cells: planned.reached ? this.routeCells(from, planned.points) : null };
    }
    route.last = { x: from.x, z: from.z };
    return this.followRoute(from, route);
  }

  /** Steering point along a cached route: drop passed nodes, look ahead along clear straight walks. */
  followRoute(from, route) {
    const points = route.points;
    if (!points.length) return { x: from.x, y: from.y, z: from.z };
    // Drop nodes already passed, then look ahead along clear straight walks.
    while (points.length > 1 && Math.hypot(points[0].x - from.x, points[0].z - from.z) < this.cell * 0.6) points.shift();
    // Farthest first: in open country the first check succeeds.
    let last = 0;
    while (last + 1 < points.length && last < 7
      && Math.hypot(points[last + 1].x - from.x, points[last + 1].z - from.z) <= LOOKAHEAD) last++;
    for (let i = last; i > 0; i--) {
      if (this.segmentWalkable(from, points[i])) { points.splice(0, i); break; }
    }
    return points[0];
  }

  /** A random reachable navigable point in the follower's region. */
  randomSpot(from, rng, maxTries = 24) {
    const start = this.nodeAt(from);
    const label = start === NODE_NONE ? -1 : this.component[start];
    for (let i = 0; i < maxTries; i++) {
      const node = Math.floor(rng() * this.nodes);
      if (!(this.flags[node] & F_WALK)) continue;
      if (label >= 0 && this.component[node] !== label) continue;
      return this.nodePoint(node);
    }
    return null;
  }

  /** Nodes reachable forward from a start point (for diagnostics and tests). */
  reachableFrom(point) {
    const start = this.nodeAt(point);
    const seen = new Uint8Array(this.nodes);
    if (start === NODE_NONE) return seen;
    const edges = this.edges, off = this.dirOffsets;
    const queue = (this.floodQueue ??= new Int32Array(this.nodes));
    let read = 0, write = 0;
    queue[write++] = start; seen[start] = 1;
    while (read < write) {
      const node = queue[read++];
      let mask = edges[node];
      const base = node & ~1;
      for (let d = 0; mask; d++, mask >>= 2) {
        const bits = mask & 3;
        if (!bits) continue;
        const next = base + off[d];
        if ((bits & 1) && !seen[next]) { seen[next] = 1; queue[write++] = next; }
        if ((bits & 2) && !seen[next + 1]) { seen[next + 1] = 1; queue[write++] = next + 1; }
      }
    }
    return seen;
  }

  // -------------------------------------------------------------- refresh --

  /**
   * Apply block changes (voxel indices from the engine's changed-block log).
   * Recomputes the touched cells, then all edges around them.
   */
  applyChanges(columns) {
    if (!columns.size) return false;
    const cells = new Set();
    for (const key of columns) {
      const x = key % this.sx, z = (key / this.sx) | 0;
      cells.add(Math.floor(z / this.cell) * this.gw + Math.floor(x / this.cell));
    }
    const ring = new Set();
    for (const c of cells) {
      this.computeCell(c, false);
      const cx = c % this.gw, cz = (c / this.gw) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x >= 0 && z >= 0 && x < this.gw && z < this.gd) ring.add(z * this.gw + x);
      }
    }
    for (const c of ring) this.computeEdgesFrom(c, false);
    this.labelComponents();
    this.revision++;
    this.changes.push({ revision: this.revision, cells: ring });
    if (this.changes.length > CHANGE_LOG) this.changes.shift();
    return true;
  }
}

/**
 * Collect changed voxel columns since the last poll from the engine's
 * insertion-ordered changed-block set. Returns column keys (x + z * sx), or
 * null when the log cannot say which voxels changed and consumers must
 * rebuild: the log restarted (world restore), or a voxel already in the set
 * changed again (a Set does not re-append it). The engine bumps blockRevision
 * once per logged change, so every change the set did not grow by is one the
 * cursor cannot locate.
 */
export class TerrainWatch {
  constructor(game) { this.game = game; this.cursor = game.changedBlocks?.size ?? 0; this.revision = game.blockRevision ?? 0; }
  poll() {
    const game = this.game, set = game.changedBlocks;
    const revision = game.blockRevision ?? 0;
    if (!set || revision === this.revision) return EMPTY;
    const changes = revision - this.revision, grown = set.size - this.cursor;
    this.revision = revision;
    if (grown < changes) { this.cursor = set.size; return null; }
    const { sx, sz } = worldDimensions(game.world);
    const out = new Set();
    let i = 0;
    for (const index of set) {
      if (i++ < this.cursor) continue;
      out.add(index % (sx * sz));
    }
    this.cursor = set.size;
    return out;
  }
}
const EMPTY = new Set();
