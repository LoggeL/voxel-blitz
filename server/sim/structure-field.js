// Structural support field: one byte of support per structural voxel, kept
// in 8^3 chunks that exist only where structural (non-ground) blocks are.
// Rooms fork the map template's field copy-on-write, so an untouched
// Frontier room shares the template's chunks and owns only what it changed.
//
// Values: 0 = unsupported, 1..MAX = support, PIN = load-time anchor (reads as
// MAX). Ground blocks (STRUCTURE_KIND 1) are implicit anchors and never
// stored. Support flows from an anchor straight up at no cost and loses
// STRUCTURE_SIDE_COST[type] per sideways or hanging (downward) step into a
// block; the field is the unique fixpoint s(b) = max(0, max over neighbours
// n of s(n) - cost(n -> b)). Every up edge costs 0 and every other edge > 0,
// so no zero-cost cycle exists and the fixpoint is unique.
import { STRUCTURE_KIND as KIND, STRUCTURE_SIDE_COST as COST, STRUCTURE_RULES } from '../../shared/structure.js';
import { worldDimensions } from '../../shared/world/dimensions.js';

export const SUPPORT_MAX = STRUCTURE_RULES.supportMax;
export const PIN = 255;
const MAX = SUPPORT_MAX;

/** Packed cell key: x (10 bits), z (10 bits), y (7 bits); every map fits (768 x 88 x 768). */
export const pack = (x, y, z) => (y << 20) | (z << 10) | x;
export const keyX = key => key & 1023;
export const keyZ = key => (key >> 10) & 1023;
export const keyY = key => key >> 20;

/** Bucket queue over support values, highest first; zero-cost pushes land in the bucket being drained. */
export class SupportQueue {
  constructor() {
    this.lists = Array.from({ length: MAX + 1 }, () => []);
    this.top = 0;
    this.size = 0;
    this.value = 0;
  }
  push(key, value) {
    this.lists[value].push(key);
    if (value > this.top) this.top = value;
    this.size++;
  }
  /** Pop the key of the highest value (in `this.value`); -1 when empty. */
  pop() {
    while (this.top > 0 && this.lists[this.top].length === 0) this.top--;
    if (this.top === 0) return -1;
    this.size--;
    this.value = this.top;
    return this.lists[this.top].pop();
  }
  clear() {
    for (const list of this.lists) list.length = 0;
    this.top = 0;
    this.size = 0;
  }
}

const TEMPLATE_FIELDS = new WeakMap();
/** Template builds in progress (warm-up slices): template -> suspended build. */
const TEMPLATE_BUILDS = new WeakMap();
/** Work units (cell visits) between the yields of a stepwise build. */
const BUILD_STEP_UNITS = 4096;

/** Packed keys of every structural cell above bedrock, in index (y, z, x) order. */
function structuralCells(field, raw) {
  const { sx, sy, sz } = field;
  let out = new Int32Array(4096), count = 0;
  const add = (key) => {
    if (count === out.length) { const next = new Int32Array(out.length * 2); next.set(out); out = next; }
    out[count++] = key;
  };
  if (raw) {
    const layer = sx * sz;
    for (let i = layer, end = sx * sy * sz; i < end; i++) {
      if (KIND[raw[i]] !== 2) continue;
      const x = i % sx, rest = (i - x) / sx, z = rest % sz, y = (rest - z) / sz;
      add((y << 20) | (z << 10) | x);
    }
  } else {
    for (let y = 1; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      if (KIND[field.block(x, y, z) & 255] === 2) add((y << 20) | (z << 10) | x);
    }
  }
  return out.subarray(0, count);
}

export class SupportField {
  /**
   * @param {{sx:number, sy:number, sz:number}} dimensions
   * @param {(x:number, y:number, z:number) => number} blockAt live voxel reader
   */
  constructor(dimensions, blockAt, slots = null) {
    const { sx, sy, sz } = dimensions;
    if (sx > 1024 || sz > 1024 || sy > 128) throw new RangeError('structure field: map too large for packed keys');
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.ncx = (sx + 7) >> 3; this.ncy = (sy + 7) >> 3; this.ncz = (sz + 7) >> 3;
    const count = this.ncx * this.ncy * this.ncz;
    this.block = blockAt;
    this.slots = slots ? slots.slice() : new Array(count).fill(null);
    // A forked field shares the template's chunk arrays until it writes one.
    this.owned = new Uint8Array(count);
    if (!slots) this.owned.fill(1);
    this.base = null;
    this.pins = 0;
    this.structural = 0;
  }

  chunkIndex(x, y, z) { return ((y >> 3) * this.ncz + (z >> 3)) * this.ncx + (x >> 3); }

  read(x, y, z) {
    const chunk = this.slots[((y >> 3) * this.ncz + (z >> 3)) * this.ncx + (x >> 3)];
    return chunk ? chunk[((y & 7) << 6) | ((z & 7) << 3) | (x & 7)] : 0;
  }

  write(x, y, z, value) {
    const c = ((y >> 3) * this.ncz + (z >> 3)) * this.ncx + (x >> 3);
    let chunk = this.slots[c];
    if (!chunk) {
      if (value === 0) return;
      chunk = this.slots[c] = new Uint8Array(512);
      this.owned[c] = 1;
    } else if (!this.owned[c]) {
      chunk = this.slots[c] = chunk.slice();
      this.owned[c] = 1;
    }
    chunk[((y & 7) << 6) | ((z & 7) << 3) | (x & 7)] = value;
  }

  inside(x, y, z) { return x >= 0 && z >= 0 && y >= 0 && x < this.sx && z < this.sz && y < this.sy; }

  /** Support a voxel gives its neighbours: 0 passable/out of map, MAX ground or pin. */
  valueAt(x, y, z) {
    if (!this.inside(x, y, z)) return 0;
    const kind = KIND[this.block(x, y, z) & 255];
    if (kind === 0) return 0;
    if (kind === 1) return MAX;
    const value = this.read(x, y, z);
    return value === PIN ? MAX : value;
  }

  /** Support a structural block of `type` at a cell would draw from its current neighbours. */
  bestFrom(x, y, z, type) {
    const cost = COST[type & 255];
    let best = this.valueAt(x, y - 1, z);
    if (best === MAX) return MAX;
    const side = Math.max(this.valueAt(x, y + 1, z), this.valueAt(x - 1, y, z), this.valueAt(x + 1, y, z),
      this.valueAt(x, y, z - 1), this.valueAt(x, y, z + 1)) - cost;
    return side > best ? side : best;
  }

  /** Raise one neighbour to `candidate` when that improves it; returns whether it did. */
  offer(x, y, z, value, up, queue) {
    if (!this.inside(x, y, z)) return;
    const type = this.block(x, y, z) & 255;
    if (KIND[type] !== 2) return;
    const candidate = up ? value : value - COST[type];
    if (candidate <= 0) return;
    const current = this.read(x, y, z);
    if (current === PIN || current >= candidate) return;
    this.write(x, y, z, candidate);
    queue.push(pack(x, y, z), candidate);
  }

  /** Drain `queue` (max-relaxation) for at most `budget` pops; returns the pops used. */
  propagate(queue, budget = Infinity) {
    let used = 0;
    while (used < budget) {
      const key = queue.pop();
      if (key < 0) break;
      used++;
      const value = queue.value, x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
      if (this.valueAt(x, y, z) !== value) continue;
      this.offer(x, y + 1, z, value, true, queue);
      this.offer(x, y - 1, z, value, false, queue);
      this.offer(x - 1, y, z, value, false, queue);
      this.offer(x + 1, y, z, value, false, queue);
      this.offer(x, y, z - 1, value, false, queue);
      this.offer(x, y, z + 1, value, false, queue);
    }
    return used;
  }

  /** Chunks this field owns (allocated or copied) and their bytes. */
  memory() {
    let chunks = 0;
    for (let c = 0; c < this.slots.length; c++) if (this.slots[c] && this.owned[c]) chunks++;
    return { chunks, bytes: chunks * 512 + this.slots.length * 9 };
  }

  /** Restore the template state (only for forks). */
  resetToBase() {
    if (!this.base) return false;
    this.slots = this.base.slots.slice();
    this.owned.fill(0);
    this.pins = this.base.pins;
    return true;
  }

  /** A copy-on-write fork that reads the live world. */
  fork(blockAt) {
    const field = new SupportField({ sx: this.sx, sy: this.sy, sz: this.sz }, blockAt, this.slots);
    field.base = this;
    field.pins = this.pins;
    field.structural = this.structural;
    return field;
  }

  /**
   * Compute the field from scratch. `raw` (the y/z/x voxel array) speeds up the
   * scan. With `pin`, every structural block left unsupported is anchored in
   * place (lowest first, preferring blocks touching supported ones, then the
   * smallest index), so a map never collapses at load. `pins` (packed keys)
   * replays a known pin set instead (verification).
   */
  static build(dimensions, blockAt, options = {}) {
    const steps = SupportField.buildSteps(dimensions, blockAt, options);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /**
   * `build` as a generator that yields about every BUILD_STEP_UNITS cell
   * visits and returns the field, so a caller can spread a large build over
   * short time slices (`warmStructureTemplates`).
   */
  static *buildSteps(dimensions, blockAt, { raw = null, pin = true, pins = null } = {}) {
    const field = new SupportField(dimensions, blockAt);
    const { sx, sy, sz } = field;
    if (raw) field.block = (x, y, z) => raw[(y * sz + z) * sx + x];
    const queue = new SupportQueue();
    if (pins) for (const key of pins) {
      const x = keyX(key), y = keyY(key), z = keyZ(key);
      if (KIND[field.block(x, y, z) & 255] === 2) { field.write(x, y, z, PIN); queue.push(key, MAX); field.pins++; }
    }
    // One flat scan collects the structural cells (y = 0 is bedrock).
    const cells = structuralCells(field, raw);
    yield;
    for (let i = 0; i < cells.length; i++) {
      if ((i & (BUILD_STEP_UNITS - 1)) === BUILD_STEP_UNITS - 1) yield;
      const key = cells[i], x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
      if (field.read(x, y, z) === PIN) continue;
      // Only ground neighbours (and cells seeded earlier in this scan) carry support yet.
      const best = field.bestFrom(x, y, z, field.block(x, y, z));
      if (best > 0) { field.write(x, y, z, best); queue.push(key, best); }
    }
    while (field.propagate(queue, BUILD_STEP_UNITS) === BUILD_STEP_UNITS) yield;
    field.structural = cells.length;
    if (pin && !pins) {
      const loose = [];
      for (let i = 0; i < cells.length; i++) {
        if ((i & (BUILD_STEP_UNITS - 1)) === BUILD_STEP_UNITS - 1) yield;
        const key = cells[i], x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
        if (field.read(x, y, z) !== 0) continue;
        const touching = field.valueAt(x, y - 1, z) > 0 || field.valueAt(x, y + 1, z) > 0
          || field.valueAt(x - 1, y, z) > 0 || field.valueAt(x + 1, y, z) > 0
          || field.valueAt(x, y, z - 1) > 0 || field.valueAt(x, y, z + 1) > 0;
        loose.push({ key, y, order: touching ? 0 : 1, index: (y * sz + z) * sx + x });
      }
      yield;
      loose.sort((a, b) => a.y - b.y || a.order - b.order || a.index - b.index);
      yield;
      let units = 0;
      for (const cell of loose) {
        if (++units >= BUILD_STEP_UNITS) { units = 0; yield; }
        const x = keyX(cell.key), y = cell.y, z = keyZ(cell.key);
        if (field.read(x, y, z) !== 0) continue;
        field.write(x, y, z, PIN);
        field.pins++;
        queue.push(cell.key, MAX);
        // Each pin settles completely before the next one is considered.
        for (;;) {
          const used = field.propagate(queue, BUILD_STEP_UNITS - units);
          units += used;
          if (queue.size === 0) break;
          units = 0;
          yield;
        }
      }
    }
    field.block = blockAt;
    return field;
  }

  /** Every pinned cell (packed keys). */
  pinKeys() {
    const out = [];
    for (let c = 0; c < this.slots.length; c++) {
      const chunk = this.slots[c];
      if (!chunk) continue;
      const cx = c % this.ncx, cz = Math.floor(c / this.ncx) % this.ncz, cy = Math.floor(c / (this.ncx * this.ncz));
      for (let i = 0; i < 512; i++) if (chunk[i] === PIN) out.push(pack((cx << 3) | (i & 7), (cy << 3) | (i >> 6), (cz << 3) | ((i >> 3) & 7)));
    }
    return out;
  }

  /**
   * The field of a live world state: a fork of the cached template field
   * when the world still matches its template, else a fresh build.
   */
  static forWorld(world) {
    const dimensions = worldDimensions(world);
    const blockAt = (x, y, z) => world.getBlock(x, y, z);
    const template = world.templateBlocks;
    if (template && template.length === dimensions.sx * dimensions.sy * dimensions.sz && world.matchesTemplate?.()) {
      let base = TEMPLATE_FIELDS.get(template);
      if (!base) {
        // Finish a warm-up build that is under way (or build it now).
        const steps = SupportField.templateSteps(world);
        let step = steps.next();
        while (!step.done) step = steps.next();
        base = TEMPLATE_FIELDS.get(template);
      }
      return base.fork(blockAt);
    }
    return SupportField.build(dimensions, blockAt);
  }

  /**
   * The stepwise build of a template-backed world's cached template field
   * (one shared build per template, resumable from anywhere: a warm-up slice
   * or `forWorld` finishing it). Null when the world has no template or its
   * field is cached already.
   */
  static templateSteps(world) {
    const template = world?.templateBlocks;
    if (!template || TEMPLATE_FIELDS.has(template)) return null;
    let steps = TEMPLATE_BUILDS.get(template);
    if (!steps) {
      const dimensions = worldDimensions(world);
      if (template.length !== dimensions.sx * dimensions.sy * dimensions.sz) return null;
      steps = (function* () {
        const base = yield* SupportField.buildSteps(dimensions,
          (x, y, z) => template[(y * dimensions.sz + z) * dimensions.sx + x], { raw: template });
        TEMPLATE_FIELDS.set(template, base);
        TEMPLATE_BUILDS.delete(template);
        return base;
      })();
      TEMPLATE_BUILDS.set(template, steps);
    }
    return steps;
  }

  /** True once a template-backed world's template field is cached. */
  static templateReady(world) { return !!world?.templateBlocks && TEMPLATE_FIELDS.has(world.templateBlocks); }
}
