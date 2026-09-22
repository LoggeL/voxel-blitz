import { GROUND, BARRICADE } from '../../../shared/world/blocks.js';

// Neighbour steps through a built cell cost this much more than a free cell,
// so NPCs prefer a short detour and only breach when the detour is long.
const BUILT_COST = 6;
// Seeds may start up to 2*(reach) deep, so the ring must span that plus a built edge.
const BUCKETS = BUILT_COST + 12;

/**
 * Reverse flood fields over the GROUND plane, rebuilt after any block change.
 * `dist` treats player structures as walls; `breachDist` lets NPCs pass them
 * at a cost so a sealed zone still has a route (through the cheapest wall).
 */
export class BastionNavigation {
  constructor(world, goal, isBuilt = () => false) {
    this.world = world; this.goal = goal; this.isBuilt = isBuilt;
    this.dist = null; this.breachDist = null; this.walk = null; this.breachWalk = null;
    this.version = -1;
    const { sx, sz } = world.dimensions; this.sx = sx; this.sz = sz;
  }
  rebuild(version) {
    if (this.version === version && this.dist) return;
    if (!this.goal) return;
    this.version = version;
    const w = this.world, { sx, sz } = w.dimensions, n = sx * sz;
    this.sx = sx; this.sz = sz;
    const walk = new Uint8Array(n), breach = new Uint8Array(n);
    for (let z = 4; z < sz - 4; z++) for (let x = 4; x < sx - 4; x++) {
      if (!w.getBlock(x, GROUND - 1, z)) continue;
      // Half-meter centers leave body clearance without corner cutting.
      const low = w.getBlock(x, GROUND + 1, z), high = w.getBlock(x, GROUND + 2, z);
      const built = this.isBuilt(x, GROUND + 1, z) || this.isBuilt(x, GROUND + 2, z);
      const i = z * sx + x;
      if (!low && !high && !built) { walk[i] = 1; breach[i] = 1; continue; }
      const passable = v => !v || v === BARRICADE;
      if (passable(low) && passable(high)) breach[i] = 2;
    }
    this.walk = walk; this.breachWalk = breach;
    this.dist = this._dijkstra(walk, this._seeds(walk));
    this.breachDist = this._dijkstra(breach, this._seeds(breach));
  }
  /**
   * Field roots: the goal cell plus every passable cell around the objective's
   * footprint, graded by distance. An objective ringed by its own base (the
   * Causeway tower) still pulls NPCs to its nearest open cell.
   */
  _seeds(walk) {
    const { sx, sz, goal } = this, gx = Math.floor(goal.x), gz = Math.floor(goal.z);
    const reach = Math.max(1, Math.ceil(Math.max(goal.half?.[0] ?? 0, goal.half?.[2] ?? 0)) + 1);
    const seeds = [];
    for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
      const x = gx + dx, z = gz + dz;
      if (x < 0 || z < 0 || x >= sx || z >= sz) continue;
      // Manhattan grades keep a strictly lower 4-neighbour on every ring (no plateaus).
      const i = z * sx + x, d = Math.abs(dx) + Math.abs(dz);
      if (walk[i] || d === 0) seeds.push({ i, d });
    }
    return seeds;
  }
  /** Dial's bucket queue: edge costs are 1 (free) or BUILT_COST (built cell). */
  _dijkstra(walk, seeds) {
    const sx = this.sx, dist = new Int16Array(walk.length).fill(-1);
    const buckets = Array.from({ length: BUCKETS }, () => []);
    let remaining = 0, d = 0;
    for (const seed of seeds) {
      if (dist[seed.i] >= 0 && dist[seed.i] <= seed.d) continue;
      dist[seed.i] = seed.d; buckets[seed.d % BUCKETS].push(seed.i); remaining++;
    }
    while (remaining > 0) {
      const bucket = buckets[d % BUCKETS];
      while (bucket.length) {
        const i = bucket.pop(); remaining--;
        if (dist[i] !== d) continue;
        for (const next of [i - 1, i + 1, i - sx, i + sx]) {
          if (!walk[next]) continue;
          const nd = d + (walk[next] === 2 ? BUILT_COST : 1);
          if (dist[next] >= 0 && dist[next] <= nd) continue;
          dist[next] = nd; buckets[nd % BUCKETS].push(next); remaining++;
        }
      }
      d++;
    }
    return dist;
  }
  _descend(field, p) {
    const sx = this.sx, x = Math.floor(p.x), z = Math.floor(p.z), i = z * sx + x;
    let best = i, value = field?.[i] ?? -1;
    for (const n of [i - 1, i + 1, i - sx, i + sx]) {
      const d = field?.[n] ?? -1;
      if (d >= 0 && (value < 0 || d < value)) { best = n; value = d; }
    }
    return value < 0 ? null : { x: best % sx + 0.5, z: Math.floor(best / sx) + 0.5, index: best };
  }
  /** Next cell centre toward the goal on free cells only, or null when sealed off. */
  next(p) {
    const step = this._descend(this.dist, p);
    return step ? { x: step.x, z: step.z } : null;
  }
  /** Same descent on the breach field; `built` marks a cell that must be breached. */
  breachNext(p) {
    const step = this._descend(this.breachDist, p);
    return step ? { x: step.x, z: step.z, built: this.breachWalk?.[step.index] === 2 } : null;
  }
}
