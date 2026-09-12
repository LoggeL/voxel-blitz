import { AIR, BEDROCK, METAL } from '../../../shared/world/blocks.js';
import { MAP_HEADER_BYTES, validateSerializedWorld } from '../../../shared/world/serialize.js';

/** One terrain copy plus sparse, reversible changes per recorded snapshot. */
export class KillcamTerrain {
  constructor(mapBytes, damage = [], time = -Infinity) {
    this.dimensions = validateSerializedWorld(mapBytes);
    this.blocks = mapBytes.slice(MAP_HEADER_BYTES);
    this.damage = new Map();
    this.time = time;
    for (const row of damage) {
      const i = this.index(row.x, row.y, row.z);
      if (i !== null && this.blocks[i] !== AIR && Number.isFinite(row.progress) && row.progress > 0) {
        this.damage.set(i, Math.min(1, row.progress));
      }
    }
  }

  index(x, y, z) {
    const { sx, sy, sz } = this.dimensions;
    return [x, y, z].every(Number.isInteger) && x >= 0 && x < sx && y >= 0 && y < sy && z >= 0 && z < sz
      ? (y * sz + z) * sx + x : null;
  }

  coords(i) {
    const { sx, sz } = this.dimensions;
    return { x: i % sx, y: Math.floor(i / (sx * sz)), z: Math.floor(i / sx) % sz };
  }

  getBlock(x, y, z) {
    x |= 0; y |= 0; z |= 0;
    const { sx, sy, sz } = this.dimensions;
    if (y < 0) return BEDROCK;
    if (y >= sy) return AIR;
    if (x < 0 || x >= sx || z < 0 || z >= sz) return METAL;
    return this.blocks[(y * sz + z) * sx + x];
  }

  getBlockDamage(x, y, z) {
    const { sx, sy, sz } = this.dimensions;
    if (x < 0 || x >= sx || y < 0 || y >= sy || z < 0 || z >= sz) return 0;
    return this.damage.get((y * sz + z) * sx + x) || 0;
  }

  record(snapshot) {
    const changes = new Map();
    const remember = i => {
      if (!changes.has(i)) changes.set(i, { i, ...this.coords(i),
        before: this.blocks[i], damageBefore: this.damage.get(i) || 0 });
    };
    for (const row of snapshot.blocks || []) {
      const i = row?.i;
      if (!Number.isInteger(i) || i < 0 || i >= this.blocks.length || !Number.isInteger(row.v)) continue;
      remember(i);
      this.blocks[i] = row.v;
      this.damage.delete(i);
    }
    for (const row of snapshot.blockDamage || []) {
      if (!row || !Number.isFinite(row.progress)) continue;
      const i = this.index(row.x, row.y, row.z);
      if (i === null) continue;
      remember(i);
      if (row.progress <= 0 || row.v === AIR || this.blocks[i] === AIR) this.damage.delete(i);
      else this.damage.set(i, Math.min(1, row.progress));
    }
    this.time = snapshot.serverNow;
    return [...changes.values()].map(change => ({ ...change,
      v: this.blocks[change.i], damage: this.damage.get(change.i) || 0,
    })).filter(change => change.before !== change.v || change.damageBefore !== change.damage);
  }

  apply(changes, backwards = false) {
    for (const change of changes) {
      this.blocks[change.i] = backwards ? change.before : change.v;
      const damage = backwards ? change.damageBefore : change.damage;
      if (damage > 0) this.damage.set(change.i, damage);
      else this.damage.delete(change.i);
    }
  }

  /** Freeze at death, then rewind to the first frame's post-snapshot state. */
  clip(frames) {
    const terrain = Object.create(KillcamTerrain.prototype);
    terrain.dimensions = this.dimensions;
    terrain.blocks = this.blocks.slice();
    terrain.damage = new Map(this.damage);
    terrain.time = frames[0].time;
    terrain.changed = [];
    for (let i = frames.length - 1; i > 0; i--) {
      const changes = frames[i].terrain;
      terrain.apply(changes, true);
      terrain.changed.push(...changes);
    }
    return terrain;
  }
}
