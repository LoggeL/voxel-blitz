// Authoritative structural integrity (docs/structural-physics.md).
//
// Every world mutation reaches `onChange` through the world's block listener.
// Additions raise support at once (bounded max-relaxation). Removals queue a
// pass that runs under a per-tick work budget:
//   0 invalidate  zero every block whose support was derived ("tight") from a
//                 removed block, transitively (a superset of the dependants);
//   1 seed        give each invalidated block the best support its remaining
//                 neighbours offer;
//   2 refill      max-relax from those seeds (bucket queue, highest first);
//   3 collect     invalidated blocks still at 0 are unsupported: connected
//                 clusters `creak`, then fall `creakMs` later as chunks.
// A falling chunk follows a closed-form path (one `collapse` event), crushes
// bodies and hulls it sweeps, damages the blocks it lands on and leaves one
// layer of rubble as ordinary block deltas.
import { AIR, isSolidBlock } from '../../shared/world/blocks.js';
import {
  STRUCTURE_RULES, STRUCTURE_KIND as KIND, STRUCTURE_SIDE_COST as COST, STRUCTURE_DENSITY as DENSITY,
  STRUCTURE_RUBBLE as RUBBLE, COLLAPSE_WEAPON,
} from '../../shared/structure.js';
import { vehicleDef } from '../../shared/vehicle-defs.js';
import { SupportField, SupportQueue, PIN, SUPPORT_MAX as MAX, pack } from './structure-field.js';
import { evCollapse, evCollapseLand, evCreak, evCrumble, evHit } from '../protocol/events.js';
import { damageBlock } from './combat.js';

const BODY_HALF = 0.35;

/** Deterministic PRNG (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (...values) => values.reduce((h, v) => Math.imul(h ^ (v | 0), 0x9E3779B1) >>> 0, 0x811C9DC5);

/** True when the axis-aligned boxes [a0, a1] and [b0, b1] overlap on all axes. */
const overlaps = (ax0, ay0, az0, ax1, ay1, az1, bx0, by0, bz0, bx1, by1, bz1) =>
  ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0 && az0 < bz1 && az1 > bz0;

/**
 * Build a map template's cached support field now (SupportField.forWorld), so
 * the first room on that map forks it (0.1 ms, 4 ms Frontier) instead of
 * building it inside its creation (Frontier: ~110 ms on a Mac, about 400 ms
 * on the production host, stalling every running room's ticks). Returns false
 * for worlds without a template.
 */
export function prepareStructureTemplate(world) {
  if (!world?.templateBlocks) return false;
  SupportField.forWorld(world);
  return true;
}

/**
 * Prepare the template fields of `worlds` in short time slices: each slice
 * advances one map's stepwise build (`SupportField.templateSteps`) for at
 * most `sliceMs`, then hands back to the event loop; `schedule` decides when
 * the next slice runs (the server: right after a room tick completed, in the
 * gap before the next one, or at once while no room runs). A room created on
 * a map whose build is under way finishes it synchronously. `worlds` holds
 * template-backed world states or factories returning one (pass them
 * smallest first). Resolves with [{ map, ms, slices, longest }] per prepared
 * world (`ms` the summed work, `longest` the longest slice).
 */
export function warmStructureTemplates(worlds, {
  schedule = (fn) => setImmediate(fn), sliceMs = 2, now = () => performance.now(),
} = {}) {
  const queue = [...worlds];
  const timings = [];
  let current = null;
  return new Promise((resolve) => {
    const step = () => {
      const started = now();
      try {
        while (!current) {
          if (!queue.length) { resolve(timings); return; }
          const next = queue.shift();
          const world = typeof next === 'function' ? next() : next;
          const steps = SupportField.templateSteps(world);
          if (steps) {
            current = { steps, world, row: { map: world.mapId, ms: 0, slices: 0, longest: 0 } };
            timings.push(current.row);
          }
        }
        let done = false;
        do done = current.steps.next().done; while (!done && now() - started < sliceMs);
        // A room may have finished the build itself meanwhile: the generator then reports done too.
        if (done || SupportField.templateReady(current.world)) current = null;
      } catch (error) {
        const row = current?.row ?? { map: null, ms: 0, slices: 0, longest: 0 };
        if (!current) timings.push(row);
        row.error = error?.message || String(error);
        current = null;
      } finally {
        const row = timings[timings.length - 1], ms = now() - started;
        if (row) { row.ms += ms; row.slices++; if (ms > row.longest) row.longest = ms; }
      }
      schedule(step);
    };
    schedule(step);
  });
}

export class StructureSystem {
  constructor(engine, { enabled = true, rules = STRUCTURE_RULES } = {}) {
    this.engine = engine;
    this.rules = rules;
    this.enabled = enabled !== false;
    this.listener = (x, y, z, before, after) => this.onChange(x, y, z, before, after);
    this.world = null;
    this.field = null;
    this.queue = new SupportQueue();
    this.raise = new SupportQueue();
    this.cause = null;
    this.bulk = false;
    this.doomSerial = 0;
    this.chunkSerial = 0;
    this.stats = { units: 0, peakUnits: 0, raiseUnits: 0, passes: 0, creaks: 0, collapses: 0, crumbles: 0, rubble: 0, hits: 0 };
    this.clearState();
    this.bind();
  }

  clearState() {
    // Flat [key, support, tag] triples: each removal carries its own
    // attribution tag { cause, origin, authored }, so removals by different
    // players (or scripted edits) in one pass never borrow each other's.
    this.pending = [];
    // Flat [key, tag] pairs: blocks placed with no support at all.
    this.orphans = [];
    this.pass = null;
    this.queue.clear();
    this.raise.clear();
    this.dooms = [];
    // Clusters found unsupported but not yet announced (per-tick creak cap).
    this.creakQueue = [];
    this.doomed = new Set();
    this.chunks = [];
  }

  /** True while support is tracked for the engine's world. */
  get active() { return this.field !== null && this.world === this.engine.world; }

  /** Nothing queued, creaking or falling. */
  get idle() { return !this.pass && !this.pending.length && !this.orphans.length && !this.creakQueue.length && !this.dooms.length && !this.chunks.length; }

  /** Attach to the engine's current world (state API worlds only; ad-hoc test worlds stay inert). */
  bind() {
    const world = this.engine.world;
    if (this.world && this.world.onBlockChange === this.listener) this.world.onBlockChange = null;
    this.world = world;
    this.field = null;
    this.clearState();
    if (!this.enabled || !world || typeof world.getBlock !== 'function' || !world.dimensions
      || !Object.hasOwn(world, 'onBlockChange')) return false;
    this.field = SupportField.forWorld(world);
    world.onBlockChange = this.listener;
    return true;
  }

  setEnabled(enabled) {
    this.enabled = enabled !== false;
    if (!this.enabled && this.world?.onBlockChange === this.listener) this.world.onBlockChange = null;
    this.world = null;
    if (this.enabled) this.bind(); else { this.field = null; this.clearState(); }
  }

  /**
   * Run scripted map edits (training gates): blocks they would leave
   * unsupported are pinned in place instead of collapsing, as authored.
   */
  authored(fn) {
    this.authoredDepth = (this.authoredDepth ?? 0) + 1;
    try { return fn(); } finally { this.authoredDepth--; }
  }

  /** Attribute the next block removals to a combatant id (null: the world). */
  attribute(cause) { this.cause = cause == null || cause === '' ? null : String(cause); }

  /** Suspend tracking while a caller rewrites many blocks (restoreWorld), then `reset()`. */
  beginBulk() { this.bulk = true; }

  /** Recompute after a bulk rewrite: the template state when the world matches it again. */
  reset() {
    this.bulk = false;
    if (this.engine.world !== this.world || !this.field) { this.bind(); return; }
    this.clearState();
    if (!(this.world.matchesTemplate?.() && this.field.resetToBase())) this.field = SupportField.forWorld(this.world);
  }

  /** Block listener: the world just replaced `before` with `after` at a cell. */
  onChange(x, y, z, before, after) {
    if (this.bulk || !this.field) return;
    const field = this.field, kindBefore = KIND[before & 255], kindAfter = KIND[after & 255];
    if (kindBefore !== 0) {
      let old = MAX;
      if (kindBefore === 2) {
        const stored = field.read(x, y, z);
        old = stored === PIN ? MAX : stored;
        field.write(x, y, z, 0);
        this.doomed.delete(pack(x, y, z));
      }
      if (old > 0) this.pending.push(pack(x, y, z), old, this.tag(x, y, z));
    }
    if (kindAfter === 1) {
      this.raise.push(pack(x, y, z), MAX);
      this.stats.raiseUnits += field.propagate(this.raise);
    } else if (kindAfter === 2) {
      const best = field.bestFrom(x, y, z, after);
      if (best > 0) {
        field.write(x, y, z, best);
        this.raise.push(pack(x, y, z), best);
        this.stats.raiseUnits += field.propagate(this.raise);
      } else {
        this.orphans.push(pack(x, y, z), this.tag(x, y, z));
      }
    }
  }

  /** Attribution of a mutation made now at a cell: who caused it, where, and whether a script did. */
  tag(x, y, z) {
    return { cause: this.cause, origin: [x, y, z], authored: this.authoredDepth > 0 };
  }

  /** Support a structural block at a cell has now (0 unsupported or not structural, MAX anchored). */
  supportAt(x, y, z) {
    if (!this.field) return MAX;
    return KIND[this.world.getBlock(x, y, z) & 255] === 2 ? this.field.valueAt(x, y, z) : 0;
  }

  /** Would structural blocks of `type` placed at `cells` all be supported? (cells support each other) */
  canSupport(cells, type) {
    if (!this.field || KIND[type & 255] !== 2) return true;
    const field = this.field, values = new Map(), cost = COST[type & 255];
    const valueAt = (x, y, z) => values.get(pack(x, y, z)) ?? field.valueAt(x, y, z);
    const sorted = [...cells].sort((a, b) => a.y - b.y);
    for (let round = 0; round < 3; round++) for (const c of sorted) {
      const side = Math.max(valueAt(c.x, c.y + 1, c.z), valueAt(c.x - 1, c.y, c.z), valueAt(c.x + 1, c.y, c.z),
        valueAt(c.x, c.y, c.z - 1), valueAt(c.x, c.y, c.z + 1)) - cost;
      values.set(pack(c.x, c.y, c.z), Math.max(0, valueAt(c.x, c.y - 1, c.z), side));
    }
    return sorted.every(c => values.get(pack(c.x, c.y, c.z)) > 0);
  }

  /** One simulation tick: budgeted support passes, due collapses, falling chunks. */
  step() {
    if (this.engine.world !== this.world) this.bind();
    else if (this.field && this.world.onBlockChange !== this.listener) { this.field = null; this.clearState(); }
    if (!this.field) return;
    const budget = this.rules.tickBudget;
    let used = 0;
    for (let guard = 0; used < budget && guard < 64; guard++) {
      if (!this.pass) {
        if (!this.pending.length && !this.orphans.length) break;
        this.startPass();
      }
      used += this.advance(budget - used);
    }
    this.stats.units = used;
    if (used > this.stats.peakUnits) this.stats.peakUnits = used;
    if (this.creakQueue.length) this.announce();
    if (this.dooms.length) this.fallDue();
    if (this.chunks.length) this.stepChunks();
  }

  startPass() {
    // `invalid` and `tags` are parallel: each invalidated cell keeps the tag of
    // the removal it depended on.
    this.pass = { phase: 0, q: this.pending, head: 0, invalid: [], tags: [], orphans: this.orphans, seed: 0 };
    this.pending = [];
    this.orphans = [];
    this.stats.passes++;
  }

  advance(budget) {
    const pass = this.pass, field = this.field;
    if (pass.phase === 0) {
      // Removals made while dependants are still being found join this pass.
      if (this.pending.length) {
        for (let i = 0; i < this.pending.length; i++) pass.q.push(this.pending[i]);
        this.pending.length = 0;
      }
      const used = this.invalidate(pass, budget);
      if (pass.head >= pass.q.length) { pass.phase = 1; pass.q = null; }
      return used;
    }
    if (pass.phase === 1) {
      let used = 0;
      while (pass.seed < pass.invalid.length && used < budget) {
        const key = pass.invalid[pass.seed++], x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
        used++;
        const type = this.world.getBlock(x, y, z) & 255;
        if (KIND[type] !== 2 || field.read(x, y, z) !== 0) continue;
        const best = field.bestFrom(x, y, z, type);
        if (best > 0) { field.write(x, y, z, best); this.queue.push(key, best); }
      }
      if (pass.seed >= pass.invalid.length) pass.phase = 2;
      return used;
    }
    if (pass.phase === 2) {
      const used = field.propagate(this.queue, budget);
      if (this.queue.size === 0) pass.phase = 3;
      return used;
    }
    return pass.phase === 3 ? this.gather(pass, budget) : this.cluster(pass, budget);
  }

  invalidate(pass, budget) {
    const q = pass.q;
    let used = 0;
    while (pass.head < q.length && used < budget) {
      const key = q[pass.head++], value = q[pass.head++], tag = q[pass.head++], x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
      used++;
      this.drop(pass, x, y + 1, z, value, true, tag);
      this.drop(pass, x, y - 1, z, value, false, tag);
      this.drop(pass, x - 1, y, z, value, false, tag);
      this.drop(pass, x + 1, y, z, value, false, tag);
      this.drop(pass, x, y, z - 1, value, false, tag);
      this.drop(pass, x, y, z + 1, value, false, tag);
    }
    return used;
  }

  /** Invalidate a neighbour whose support was derived from a cell of support `value`; it inherits `tag`. */
  drop(pass, x, y, z, value, up, tag) {
    const field = this.field;
    if (!field.inside(x, y, z)) return;
    const type = this.world.getBlock(x, y, z) & 255;
    if (KIND[type] !== 2) return;
    const support = field.read(x, y, z);
    if (support === 0 || support === PIN) return;
    if (support !== value - (up ? 0 : COST[type])) return;
    field.write(x, y, z, 0);
    const key = pack(x, y, z);
    pass.invalid.push(key);
    pass.tags.push(tag);
    pass.q.push(key, support, tag);
  }

  /**
   * Phase 3: invalidated (and orphaned) blocks still at 0 are the unsupported
   * candidates, kept in invalidation order (key -> tag; the first tag wins).
   */
  gather(pass, budget) {
    const field = this.field, invalid = pass.invalid.length, total = invalid + pass.orphans.length / 2;
    pass.candidates ??= new Map();
    pass.next ??= 0;
    let used = 0;
    while (pass.next < total && used < budget) {
      const i = pass.next++, key = i < invalid ? pass.invalid[i] : pass.orphans[(i - invalid) * 2];
      used++;
      if (this.doomed.has(key) || pass.candidates.has(key)) continue;
      const x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
      if (KIND[this.world.getBlock(x, y, z) & 255] === 2 && field.read(x, y, z) === 0) {
        pass.candidates.set(key, i < invalid ? pass.tags[i] : pass.orphans[(i - invalid) * 2 + 1]);
      }
    }
    if (pass.next >= total) {
      pass.phase = 4;
      pass.list = [...pass.candidates.keys()];
      pass.next = 0;
      pass.seen = new Set();
      pass.group = null;
    }
    return used;
  }

  /**
   * Phase 4: split the candidates into 6-connected clusters; each one creaks.
   * A cluster is credited to the removal its first-invalidated cell depended
   * on (if that was a scripted edit, to the first other removal found among
   * its cells); it is pinned only when every one of its cells lost support
   * to scripted (authored) edits.
   */
  cluster(pass, budget) {
    const { candidates, list, seen } = pass;
    let used = 0;
    while (used < budget) {
      if (!pass.group) {
        while (pass.next < list.length && seen.has(list[pass.next])) pass.next++;
        if (pass.next >= list.length) { this.pass = null; return used; }
        const start = list[pass.next];
        seen.add(start);
        pass.group = [start];
        pass.expand = 0;
        // `list` is in invalidation order and earlier cells belong to earlier
        // clusters, so a cluster's first-invalidated cell is its start.
        const tag = candidates.get(start);
        pass.groupTag = tag.authored ? null : tag;
      }
      const group = pass.group;
      while (pass.expand < group.length && used < budget) {
        const key = group[pass.expand++], x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
        used++;
        const visit = (next) => {
          if (seen.has(next)) return;
          const tag = candidates.get(next);
          if (!tag) return;
          seen.add(next);
          group.push(next);
          if (!pass.groupTag && !tag.authored) pass.groupTag = tag;
        };
        visit(pack(x, y + 1, z));
        if (y > 0) visit(pack(x, y - 1, z));
        if (x > 0) visit(pack(x - 1, y, z));
        visit(pack(x + 1, y, z));
        if (z > 0) visit(pack(x, y, z - 1));
        visit(pack(x, y, z + 1));
      }
      if (pass.expand >= group.length) {
        const tag = pass.groupTag;
        if (!tag) this.pin(group); else this.doom(group, tag.cause, tag.origin);
        pass.group = null;
        pass.groupTag = null;
      }
    }
    return used;
  }

  /** Encode cells as the event origin + flat [dx, dy, dz, type] list (capped). */
  encode(cells) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    for (const c of cells) { if (c.x < minX) minX = c.x; if (c.y < minY) minY = c.y; if (c.z < minZ) minZ = c.z; }
    const b = [], limit = Math.min(cells.length, this.rules.eventCells);
    for (let i = 0; i < limit; i++) { const c = cells[i]; b.push(c.x - minX, c.y - minY, c.z - minZ, c.t); }
    return { o: [minX, minY, minZ], b, n: cells.length };
  }

  cellsOf(keys) {
    return keys.map(key => {
      const x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
      return { x, y, z, t: this.world.getBlock(x, y, z) & 255 };
    });
  }

  /** Anchor a cluster where it stands (scripted edits keep the authored shape). */
  pin(keys) {
    for (const key of keys) {
      const x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
      this.field.write(x, y, z, PIN);
      this.field.pins++;
      this.raise.push(key, MAX);
    }
    this.stats.raiseUnits += this.field.propagate(this.raise);
  }

  /** An unsupported cluster: its cells are doomed now; it creaks (and falls creakMs later) once announced. */
  doom(keys, cause, origin) {
    const id = 'k' + (++this.doomSerial);
    for (const key of keys) this.doomed.add(key);
    this.creakQueue.push({ id, keys, cause, origin });
  }

  /**
   * Emit the queued clusters' creaks, at most `maxCreaksPerTick` events and
   * `maxCreakCellsPerTick` listed blocks per tick (always at least one), so a
   * mass support loss spreads over ticks instead of one huge snapshot. Each
   * cluster falls creakMs after its own creak.
   */
  announce() {
    const rules = this.rules, at = this.engine.now;
    let events = 0, cells = 0;
    while (this.creakQueue.length) {
      const next = this.creakQueue[0], listed = Math.min(next.keys.length, rules.eventCells);
      if (events > 0 && (events >= rules.maxCreaksPerTick || cells + listed > rules.maxCreakCellsPerTick)) break;
      this.creakQueue.shift();
      // Cells destroyed while queued are gone already.
      const keys = next.keys.filter(key => this.doomed.has(key));
      if (!keys.length) continue;
      events++;
      cells += listed;
      const { id, cause, origin } = next;
      this.dooms.push({ id, keys, next: 0, at, fallAt: at + rules.creakMs, cause, origin });
      const { o, b, n } = this.encode(this.cellsOf(keys));
      this.engine.tickEvents.push(evCreak(id, at, rules.creakMs, o, b, n));
      this.stats.creaks++;
    }
  }

  fallDue() {
    const now = this.engine.now, field = this.field;
    let budget = this.rules.maxRemovalsPerTick;
    while (this.dooms.length && budget > 0 && this.dooms[0].fallAt <= now) {
      const doom = this.dooms[0], slice = doom.keys.slice(doom.next, doom.next + budget);
      doom.next += slice.length;
      if (doom.next >= doom.keys.length) this.dooms.shift();
      budget -= slice.length;
      const cells = [];
      for (const key of slice) {
        if (!this.doomed.delete(key)) continue;
        const x = key & 1023, z = (key >> 10) & 1023, y = key >> 20, t = this.world.getBlock(x, y, z) & 255;
        // A block that regained support (a pillar placed in time) stays.
        if (KIND[t] === 2 && field.read(x, y, z) === 0) cells.push({ x, y, z, t });
      }
      if (cells.length) this.release(doom, cells);
    }
  }

  /** Remove a doomed cluster from the world and send it down as chunks (or crumble it). */
  release(doom, cells) {
    const engine = this.engine;
    for (const c of cells) {
      engine.world.setBlock(c.x, c.y, c.z, AIR);
      engine.pushBlockDelta(c.x, c.y, c.z, AIR);
    }
    let groups = [cells];
    if (cells.length > this.rules.maxChunkCells) {
      const byCell = new Map();
      for (const c of cells) {
        const key = ((c.y >> 3) << 20) | ((c.z >> 3) << 10) | (c.x >> 3);
        let group = byCell.get(key);
        if (!group) byCell.set(key, group = []);
        group.push(c);
      }
      groups = [...byCell.values()].sort((a, b) => b.length - a.length);
    }
    // The chunk cap holds per cluster, across the ticks a big cluster is released over.
    const room = Math.max(0, Math.min(this.rules.maxChunksPerCluster - (doom.spawned ?? 0), this.rules.maxActiveChunks - this.chunks.length));
    const crumble = [];
    groups.forEach((group, i) => {
      if (i < room && this.spawnChunk(doom, group)) doom.spawned = (doom.spawned ?? 0) + 1;
      else crumble.push(...group);
    });
    if (crumble.length) {
      const { o, b, n } = this.encode(crumble);
      engine.tickEvents.push(evCrumble(doom.id, engine.now, o, b, n));
      this.stats.crumbles++;
    }
  }

  solidAt(x, y, z) { return isSolidBlock(this.world.getBlock(x, y, z)); }

  /** Air blocks straight below a cell before something solid (the cell itself is not counted). */
  gapBelow(x, y, z) {
    let gap = 0;
    while (y - 1 - gap >= 0 && !this.solidAt(x, y - 1 - gap, z)) gap++;
    return gap;
  }

  /**
   * Landing of a chunk whose cells were just removed: the integer drop `oy`
   * (< 0) and its time. Drifting chunks also check the neighbour columns they
   * slide over; a blocked drift falls straight instead.
   */
  landing(cells, vx, vz) {
    const own = new Set(cells.map(c => pack(c.x, c.y, c.z)));
    const bottoms = cells.filter(c => c.y === 0 || !own.has(pack(c.x, c.y - 1, c.z)));
    const g = this.rules.gravity;
    const dropOver = (columns) => {
      let drop = Infinity;
      for (const c of bottoms) for (const [dx, dz] of columns) drop = Math.min(drop, this.gapBelow(c.x + dx, c.y, c.z + dz));
      return drop;
    };
    let drop = dropOver([[0, 0]]);
    if ((vx || vz) && drop > 0) {
      const time = Math.sqrt(2 * drop / g);
      // Long falls drift at most 0.95 blocks, so only the adjacent columns are swept.
      const reach = Math.max(Math.abs(vx), Math.abs(vz)) * time;
      if (reach > 0.95) { vx *= 0.95 / reach; vz *= 0.95 / reach; }
      const hx = vx * time, hz = vz * time;
      const sx = Math.abs(hx) > 1e-6 ? Math.sign(hx) : 0, sz = Math.abs(hz) > 1e-6 ? Math.sign(hz) : 0;
      const columns = [[0, 0]];
      if (sx) columns.push([sx, 0]);
      if (sz) columns.push([0, sz]);
      if (sx && sz) columns.push([sx, sz]);
      const drift = dropOver(columns);
      let clear = drift > 0;
      // Every cell's swept neighbour columns must be open over the fall.
      for (let i = 0; clear && i < cells.length; i++) {
        const c = cells[i];
        for (const [dx, dz] of columns) {
          if (!dx && !dz) continue;
          for (let y = c.y - drift; clear && y <= c.y; y++) if (this.solidAt(c.x + dx, y, c.z + dz)) clear = false;
        }
      }
      if (clear) return { drop: drift, ms: Math.sqrt(2 * drift / g) * 1000, vx, vz };
      vx = 0; vz = 0;
    }
    if (!(drop > 0) || !Number.isFinite(drop)) return null;
    return { drop, ms: Math.sqrt(2 * drop / g) * 1000, vx: 0, vz: 0 };
  }

  spawnChunk(doom, cells) {
    const engine = this.engine, rules = this.rules, serial = ++this.chunkSerial;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let mass = 0, px = 0, py = 0, pz = 0;
    for (const c of cells) {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); minZ = Math.min(minZ, c.z);
      maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); maxZ = Math.max(maxZ, c.z);
      mass += DENSITY[c.t]; px += c.x + 0.5; py += c.y + 0.5; pz += c.z + 0.5;
    }
    const pivot = [px / cells.length, py / cells.length, pz / cells.length];
    const seed = hash(serial, minX, minY, minZ, cells.length);
    const random = prng(seed);
    let vx = 0, vz = 0, heading = random() * Math.PI * 2;
    if (cells.length <= rules.maxDriftCells) {
      // Drift away from the support that was lost.
      const origin = doom.origin;
      if (origin) {
        const dx = pivot[0] - origin[0] - 0.5, dz = pivot[2] - origin[2] - 0.5;
        if (Math.hypot(dx, dz) > 0.01) heading = Math.atan2(dz, dx) + (random() - 0.5) * 0.8;
      }
      const speed = rules.drift[0] + (rules.drift[1] - rules.drift[0]) * random();
      vx = Math.cos(heading) * speed;
      vz = Math.sin(heading) * speed;
    }
    const land = this.landing(cells, vx, vz);
    if (!land) return false;
    // Tumble about the horizontal axis across the drift.
    let rate = (rules.spin[0] + (rules.spin[1] - rules.spin[0]) * random()) * (random() < 0.5 ? -1 : 1);
    if (cells.length > rules.maxDriftCells) rate *= 0.35;
    const axis = heading + Math.PI / 2, spin = [Math.cos(axis) * rate, 0, Math.sin(axis) * rate];
    const id = 'c' + serial, at = engine.now, velocity = [land.vx, 0, land.vz];
    const chunk = {
      id, doom: doom.id, at, landAt: at + land.ms, landMs: land.ms, cells, o: [minX, minY, minZ],
      size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1], pivot, v: velocity, drop: land.drop,
      mass, cause: doom.cause, seed, hit: new Set(), prevMs: 0,
    };
    this.chunks.push(chunk);
    const { o, b, n } = this.encode(cells);
    engine.tickEvents.push(evCollapse(id, doom.id, at, o, b, n, pivot, velocity, spin, rules.gravity, land.ms));
    this.stats.collapses++;
    return true;
  }

  /** Translation of a chunk `ms` after its start. */
  offset(chunk, ms) {
    const t = Math.min(ms, chunk.landMs) / 1000;
    return [chunk.v[0] * t, -0.5 * this.rules.gravity * t * t, chunk.v[2] * t];
  }

  stepChunks() {
    const now = this.engine.now;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i], landed = now >= chunk.landAt, ms = Math.min(now - chunk.at, chunk.landMs);
      this.contacts(chunk, chunk.prevMs, ms, landed);
      chunk.prevMs = ms;
      if (landed || now - chunk.at > this.rules.maxFallMs) {
        this.land(chunk);
        this.chunks.splice(i--, 1);
      }
    }
  }

  /** Bodies and hulls the chunk swept between two times take crush damage once each. */
  contacts(chunk, fromMs, toMs, landed) {
    const engine = this.engine;
    if (engine.mode?.phase !== 'live') return;
    const d0 = this.offset(chunk, fromMs), d1 = this.offset(chunk, toMs), t = toMs / 1000;
    const lowX = Math.min(d0[0], d1[0]), highX = Math.max(d0[0], d1[0]);
    const lowZ = Math.min(d0[2], d1[2]), highZ = Math.max(d0[2], d1[2]);
    const lowY = d1[1], highY = d0[1];
    const [ox, oy, oz] = chunk.o, [sx, sy, sz] = chunk.size;
    const ax0 = ox + lowX, ay0 = oy + lowY, az0 = oz + lowZ, ax1 = ox + sx + highX, ay1 = oy + sy + highY, az1 = oz + sz + highZ;
    const speed = Math.hypot(chunk.v[0], this.rules.gravity * t, chunk.v[2]);
    const sweptHits = (bx0, by0, bz0, bx1, by1, bz1) => {
      if (!overlaps(ax0, ay0, az0, ax1, ay1, az1, bx0, by0, bz0, bx1, by1, bz1)) return null;
      for (const c of chunk.cells) {
        if (overlaps(c.x + lowX, c.y + lowY, c.z + lowZ, c.x + 1 + highX, c.y + 1 + highY, c.z + 1 + highZ,
          bx0, by0, bz0, bx1, by1, bz1)) return c;
      }
      return null;
    };
    const rules = this.rules.damage, root = Math.sqrt(Math.max(0.1, chunk.mass));
    const impact = Math.min(rules.max, rules.perMass * root * Math.max(0, speed - rules.minSpeed));
    const crush = landed ? Math.min(rules.max, rules.crush * root) : 0;
    for (const victim of engine.combatants.values()) {
      if (victim.state !== 'alive' || victim.vehicleId || victim.objective || chunk.hit.has(victim)) continue;
      const height = victim.proneT > 0.5 ? 0.7 : victim.crouch ? 1.3 : 1.85 * (victim.bodyScale || 1);
      const half = BODY_HALF * (victim.bodyScale || 1);
      const cell = sweptHits(victim.x - half, victim.y, victim.z - half, victim.x + half, victim.y + height, victim.z + half);
      if (!cell) continue;
      const damage = Math.max(impact, crush);
      chunk.hit.add(victim);
      if (damage > 0) this.hurt(chunk, victim, damage, [cell.x + 0.5 + d1[0], victim.y + height, cell.z + 0.5 + d1[2]]);
    }
    for (const vehicle of engine.vehicles?.vehicles?.values?.() ?? []) {
      if (!(vehicle.hp > 0) || chunk.hit.has(vehicle)) continue;
      const def = vehicleDef(vehicle);
      const reach = Math.max(def?.collider?.halfWidth ?? 1.5, def?.collider?.halfLength ?? 1.5), height = def?.height ?? 2;
      const cell = sweptHits(vehicle.x - reach, vehicle.y, vehicle.z - reach, vehicle.x + reach, vehicle.y + height, vehicle.z + reach);
      if (!cell) continue;
      chunk.hit.add(vehicle);
      const damage = Math.max(impact, crush) * rules.vehicleScale;
      if (!(damage > 0)) continue;
      // The hull model refuses a credited hit the cause may not deal (own team,
      // the mode's rules): such a chunk leaves the hull alone (no world retry).
      const { killer } = this.credit(chunk, null), point = [cell.x + 0.5 + d1[0], vehicle.y + height, cell.z + 0.5 + d1[2]];
      engine.vehicles.damage(vehicle.id, damage, killer, { cls: 'collision', point });
    }
  }

  /**
   * Who a chunk hits `victim` as: `{ killer }` the combatant whose damage
   * removed its support, null for the world (no cause, or the cause has left).
   * `{ refused: true }` when the cause may not damage that body (a team-mate
   * without friendly fire): the chunk then spares it, like any of their
   * shots would. Your own collapse still hurts you (a suicide).
   */
  credit(chunk, victim) {
    if (!chunk.cause) return { killer: null, refused: false };
    const killer = this.engine.combatants.get(chunk.cause) ?? null;
    if (!killer || killer === victim || !victim) return { killer, refused: false };
    return this.engine.mode?.canDamage?.(killer, victim) === false ? { killer: null, refused: true } : { killer, refused: false };
  }

  hurt(chunk, victim, damage, point) {
    const engine = this.engine;
    if (victim.spawnProtected || (Number.isFinite(victim.spawnProtectedUntil) && victim.spawnProtectedUntil > engine.now)) return;
    const { killer, refused } = this.credit(chunk, victim);
    if (refused) return;
    const lethal = victim.takeDamage(damage, false, killer, COLLAPSE_WEAPON);
    engine.tickEvents.push(evHit(killer ? killer.id : '', victim.id, damage, false, point, victim.lastDamage));
    this.stats.hits++;
    if (lethal) engine.killPlayer(victim, killer, COLLAPSE_WEAPON, false, null);
  }

  /** A body, hull or structure objective near a cell: rubble never fills it. */
  occupied(x, y, z) {
    const pad = this.rules.rubble.clearance, engine = this.engine;
    for (const p of engine.combatants.values()) {
      if (p.state !== 'alive' || p.vehicleId) continue;
      const half = BODY_HALF * (p.bodyScale || 1) + pad, height = 1.9 * (p.bodyScale || 1) + pad;
      if (overlaps(x, y, z, x + 1, y + 1, z + 1, p.x - half, p.y - pad, p.z - half, p.x + half, p.y + height, p.z + half)) return true;
    }
    for (const v of engine.vehicles?.vehicles?.values?.() ?? []) {
      const def = vehicleDef(v), reach = Math.max(def?.collider?.halfWidth ?? 1.5, def?.collider?.halfLength ?? 1.5) + pad;
      if (overlaps(x, y, z, x + 1, y + 1, z + 1, v.x - reach, v.y - pad, v.z - reach, v.x + reach, v.y + (def?.height ?? 2) + pad, v.z + reach)) return true;
    }
    for (const o of engine.objectives?.values?.() ?? []) {
      if (Math.floor(o.x) === x && Math.floor(o.z) === z && Math.abs(Math.floor(o.y) - y) <= 1) return true;
    }
    return false;
  }

  /** Touchdown: damage what it landed on, leave one layer of rubble, report the impact. */
  land(chunk) {
    const engine = this.engine, world = this.world, rules = this.rules;
    const d = this.offset(chunk, chunk.landMs), sx = Math.round(d[0]), sz = Math.round(d[2]), sy = -chunk.drop;
    const speed = Math.hypot(chunk.v[0], rules.gravity * chunk.landMs / 1000, chunk.v[2]);
    const own = new Set(chunk.cells.map(c => pack(c.x, c.y, c.z)));
    const bottoms = chunk.cells.filter(c => !own.has(pack(c.x, c.y - 1, c.z)));
    // Heavy chunks break what they hit (planks, roofs): chain collapses.
    const combat = engine.contexts?.combat;
    if (combat) {
      const per = rules.impact.perSpeed * speed * Math.min(4, Math.sqrt(chunk.mass));
      let hits = 0;
      for (const c of bottoms) {
        if (hits >= rules.impact.maxCells) break;
        const x = c.x + sx, y = c.y + sy - 1, z = c.z + sz, type = world.getBlock(x, y, z) & 255;
        if (KIND[type] !== 2 || y <= 0) continue;
        hits++;
        damageBlock(x, y, z, type, per, combat, chunk.cause);
      }
    }
    const random = prng(chunk.seed ^ 0x5bd1e995);
    let rubble = 0;
    for (const c of bottoms) {
      if (rubble >= rules.rubble.max) break;
      if (!RUBBLE[c.t] || random() >= rules.rubble.fraction) continue;
      const x = c.x + sx, z = c.z + sz;
      let y = c.y + sy;
      if (!this.field.inside(x, y, z) || y <= 0 || this.solidAt(x, y, z)) continue;
      for (let s = 0; s < rules.rubble.settle && y > 1 && !this.solidAt(x, y - 1, z); s++) y--;
      if (!this.solidAt(x, y - 1, z) || this.occupied(x, y, z)) continue;
      world.setBlock(x, y, z, c.t);
      engine.pushBlockDelta(x, y, z, c.t);
      rubble++;
    }
    this.stats.rubble += rubble;
    engine.tickEvents.push(evCollapseLand(chunk.id, engine.now,
      [chunk.pivot[0] + d[0], chunk.pivot[1] + d[1], chunk.pivot[2] + d[2]], chunk.cells.length, rubble, speed));
  }

  /** Per-room support memory (owned chunks only; template chunks are shared). */
  memory() { return this.field ? this.field.memory() : { chunks: 0, bytes: 0 }; }
}
