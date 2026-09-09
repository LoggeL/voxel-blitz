import { GROUND, SX, SZ } from '../../../shared/worlddata.js';

/** Reverse flood field over the courtyard floor, rebuilt after destruction. */
export class BastionNavigation {
  constructor(world, goal) { this.world = world; this.goal = goal; this.dist = null; this.version = -1; }
  rebuild(version) {
    if (this.version === version && this.dist) return;
    this.version = version;
    const walk = new Uint8Array(SX * SZ), dist = new Int16Array(SX * SZ).fill(-1);
    for (let z = 4; z < SZ - 4; z++) for (let x = 4; x < SX - 4; x++) {
      // Half-meter centers leave body clearance without corner cutting.
      walk[z * SX + x] = !this.world.getBlock(x, GROUND + 1, z)
        && !this.world.getBlock(x, GROUND + 2, z)
        && !!this.world.getBlock(x, GROUND - 1, z);
    }
    const queue = new Int32Array(SX * SZ);
    let head = 0, tail = 0;
    const root = Math.floor(this.goal.z) * SX + Math.floor(this.goal.x);
    dist[root] = 0; queue[tail++] = root;
    while (head < tail) {
      const i = queue[head++];
      for (const next of [i - 1, i + 1, i - SX, i + SX]) {
        if (!walk[next] || dist[next] >= 0) continue;
        dist[next] = dist[i] + 1; queue[tail++] = next;
      }
    }
    this.dist = dist;
  }
  next(p) {
    const x = Math.floor(p.x), z = Math.floor(p.z), i = z * SX + x;
    let best = i, value = this.dist?.[i] ?? -1;
    for (const n of [i - 1, i + 1, i - SX, i + SX]) {
      const d = this.dist?.[n] ?? -1;
      if (d >= 0 && (value < 0 || d < value)) { best = n; value = d; }
    }
    return value < 0 ? null : { x: best % SX + 0.5, z: Math.floor(best / SX) + 0.5 };
  }
}
