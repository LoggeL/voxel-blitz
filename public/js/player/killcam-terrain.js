import { AIR, BEDROCK, METAL } from '../../../shared/world/blocks.js';
import { deserializeBlocks } from '../../../shared/world/serialize.js';

/** One terrain copy plus sparse, reversible changes per recorded snapshot. */
export class KillcamTerrain {
  /**
   * `source` is a serialized map (V1/V2 bytes) or `{ blocks, dimensions }`,
   * the client's decoded arena, which is copied as is (no re-encoding).
   */
  constructor(source, damage = [], time = -Infinity) {
    const decoded = source instanceof Uint8Array ? deserializeBlocks(source)
      : { dimensions: { ...source.dimensions }, blocks: source.blocks.slice() };
    this.dimensions = decoded.dimensions;
    this.blocks = decoded.blocks;
    this.damage = new Map();
    this.time = time;
    // Replay views (clip) that read this copy and pin each cell before it changes.
    this.views = new Set();
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
      if (changes.has(i)) return;
      changes.set(i, { i, ...this.coords(i), before: this.blocks[i], damageBefore: this.damage.get(i) || 0 });
      for (const view of this.views) view.pin(i, this.blocks[i], this.damage.get(i) || 0);
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

  /**
   * Freeze at death, then rewind to the first frame's post-snapshot state. The clip is a
   * copy-on-write view over this copy (a Frontier map is 47 MB of voxels): only the
   * rewound cells and the cells live play changes later are held. One clip at a time.
   */
  clip(frames) {
    this.release();
    const terrain = new KillcamTerrainView(this, frames[0].time);
    for (let i = frames.length - 1; i > 0; i--) {
      const changes = frames[i].terrain;
      terrain.apply(changes, true);
      terrain.changed.push(...changes);
    }
    return terrain;
  }

  /** Stop pinning cells for a finished clip (all clips without an argument). */
  release(view = null) {
    if (view) this.views.delete(view);
    else this.views.clear();
  }
}

/** A clip's terrain: the base copy plus the cells whose replay state may differ from it. */
export class KillcamTerrainView {
  constructor(base, time) {
    this.base = base;
    this.dimensions = base.dimensions;
    this.time = time;
    this.changed = [];
    /** flat index -> [block, damage] of this view, where it may differ from the base. */
    this.cells = new Map();
    base.views.add(this);
  }

  index(x, y, z) { return this.base.index(x, y, z); }
  coords(i) { return this.base.coords(i); }

  /** The base is about to change cell `i`: keep this view's value. */
  pin(i, block, damage) {
    if (!this.cells.has(i)) this.cells.set(i, [block, damage]);
  }

  getBlock(x, y, z) {
    x |= 0; y |= 0; z |= 0;
    const { sx, sy, sz } = this.dimensions;
    if (y < 0) return BEDROCK;
    if (y >= sy) return AIR;
    if (x < 0 || x >= sx || z < 0 || z >= sz) return METAL;
    const i = (y * sz + z) * sx + x, cell = this.cells.get(i);
    return cell ? cell[0] : this.base.blocks[i];
  }

  getBlockDamage(x, y, z) {
    const { sx, sy, sz } = this.dimensions;
    if (x < 0 || x >= sx || y < 0 || y >= sy || z < 0 || z >= sz) return 0;
    const i = (y * sz + z) * sx + x, cell = this.cells.get(i);
    return cell ? cell[1] : this.base.damage.get(i) || 0;
  }

  apply(changes, backwards = false) {
    for (const change of changes) {
      const damage = backwards ? change.damageBefore : change.damage;
      this.cells.set(change.i, [backwards ? change.before : change.v, damage > 0 ? damage : 0]);
    }
  }

  release() { this.base.release(this); }
}
