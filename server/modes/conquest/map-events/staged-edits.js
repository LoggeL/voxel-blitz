// Staged voxel edits of the Conquest map events (docs/conquest.md "Map
// events"): a reservoir drains, a flood fills a canyon floor, a rockslide
// closes a road, a tower comes down. An event hands over a precomputed,
// deterministic list of block changes; the helper applies them over many
// ticks under one per-tick cell budget (MAP_EVENT_RULES.edits.cellsPerTick,
// shared by every queued job, first come first served).
//
// Every change is an ordinary block delta (world.setBlock + pushBlockDelta):
// clients get it in the tick's `blocks`, a joiner through the map cache's
// changed cells, a rematch's restoreWorld puts the pristine voxels back, and
// the bots' surface graph and cover sets relabel the touched columns from
// the engine's change log (BotManager.pollTerrain, 4 Hz), as for the Iron
// Bridge. Removals run under `structure.attribute(by)`, so blocks the
// structural system then brings down (unsupported overhangs) credit the
// trigger like the bridge's span.
//
// Modes: `set` writes each cell's value under the budget; `fall` hands the
// solid cells to the structural system's scripted demolition
// (StructureSystem.bringDown: one creak, then chunks that crush what they
// land on and leave rubble), which spreads the removals itself. A `set` job
// with `authored: true` runs inside StructureSystem.authored: whatever it
// leaves unsupported stays pinned as placed (a rockslide's new rubble face)
// instead of collapsing.
//
// Measured on Frontier (tools/conquest-map-events-test.mjs): a 30 000-cell
// job at the default 40 cells a tick runs 750 ticks (12.5 s at 60 Hz) and
// costs well under 0.1 ms a tick; each cell rides the tick's `blocks` as
// {i, v} (about 20 B of JSON before deflate) and a joiner's map-cache delta
// as 5 B.
import { AIR, isSolidBlock } from '../../../../shared/world/blocks.js';
import { MAP_EVENT_RULES } from '../../../../shared/conquest-map-events.js';
import { pack } from '../../../sim/structure-field.js';

/**
 * A deterministic edit list for a box: every cell (x, then z, then y from
 * `order` 'top' down or 'bottom' up) whose current block passes `from`
 * becomes `to`. Returns a flat Int32Array [x, y, z, v, ...].
 */
export function planBoxEdit(world, box, { from = () => true, to = AIR, order = 'top' } = {}) {
  const out = [];
  const ys = [];
  for (let y = box.y0; y <= box.y1; y++) ys.push(y);
  if (order === 'top') ys.reverse();
  for (const y of ys) for (let z = box.z0; z <= box.z1; z++) for (let x = box.x0; x <= box.x1; x++) {
    const block = world.getBlock(x, y, z);
    if (block !== to && from(block, x, y, z)) out.push(x, y, z, typeof to === 'function' ? to(block, x, y, z) : to);
  }
  return Int32Array.from(out);
}

/** Flatten [{x, y, z, v}] into the job format. */
export const editCells = cells => Int32Array.from(cells.flatMap(c => [c.x, c.y, c.z, c.v]));

export class StagedEdits {
  constructor(system, rules = MAP_EVENT_RULES.edits) {
    this.system = system;
    this.rules = rules;
    this.reset();
  }

  /** Round start and rematch: drop every queued job (restoreWorld already put the voxels back). */
  reset() {
    this.jobs = [];
    this.serial = 0;
    this.stats = { cells: 0, ticks: 0, lastTickCells: 0, lastTickMs: 0, maxTickMs: 0 };
  }

  get engine() { return this.system.engine; }

  /**
   * Queue a job: `cells` a flat [x, y, z, v, ...] list (Int32Array or array),
   * `mode` 'set' (default) or 'fall', `by` the player credited with what the
   * edit kills or brings down, `origin` [x, y, z] of a fall, `chunkCap` for
   * the structural chunks, `topple` a fall over a hinge edge (bringDown's
   * `fall` {hinge, dir, minRise}), `budget` this job's own per-tick share (never
   * above the global budget), `onDone(job)` once applied. Returns the job.
   */
  enqueue({ id = null, instance = null, cells, mode = 'set', by = null, origin = null, chunkCap = null, topple = null, budget = null,
    authored = false, onDone = null } = {}) {
    const job = { id: id ?? `edit-${++this.serial}`, instance, cells: cells instanceof Int32Array ? cells : Int32Array.from(cells ?? []),
      mode, by: by == null ? null : String(by), origin, chunkCap, topple, budget, authored: !!authored, onDone, next: 0, applied: 0, done: false,
      creakId: null };
    if (mode === 'fall') this._fall(job);
    else this.jobs.push(job);
    if (job.done) job.onDone?.(job);
    return job;
  }

  /** Cells left to apply over every queued job. */
  get pending() { return this.jobs.reduce((n, j) => n + (j.cells.length / 4 - j.next / 4), 0); }

  cancel(id) {
    const i = this.jobs.findIndex(j => j.id === id);
    if (i >= 0) this.jobs.splice(i, 1);
    return i >= 0;
  }

  /** One tick: apply up to the budget, oldest job first. */
  tick() {
    if (!this.jobs.length) return 0;
    const t0 = performance.now();
    const engine = this.engine, world = engine?.world;
    if (!world) return 0;
    let budget = this.rules.cellsPerTick, applied = 0;
    const structure = engine.structure;
    while (budget > 0 && this.jobs.length) {
      const job = this.jobs[0];
      const share = Math.min(budget, Number.isFinite(job.budget) && job.budget > 0 ? job.budget : budget);
      structure?.attribute?.(job.by);
      try {
        const run = () => {
          let n = 0;
          while (n < share && job.next < job.cells.length) {
            const x = job.cells[job.next], y = job.cells[job.next + 1], z = job.cells[job.next + 2], v = job.cells[job.next + 3];
            job.next += 4;
            // A cell already at its value (dug out, flooded by a neighbour job) costs no budget.
            if (world.getBlock(x, y, z) === v) continue;
            n++;
            world.setBlock(x, y, z, v);
            engine.pushBlockDelta(x, y, z, v);
          }
          return n;
        };
        const n = job.authored && typeof structure?.authored === 'function' ? structure.authored(run) : run();
        job.applied += n; applied += n;
        budget -= n;
      } finally { structure?.attribute?.(null); }
      if (job.next >= job.cells.length) {
        this.jobs.shift();
        job.done = true;
        job.onDone?.(job);
      } else if (Number.isFinite(job.budget) && job.budget > 0) break; // a job with its own rate keeps it
    }
    const ms = performance.now() - t0;
    this.stats.cells += applied; this.stats.ticks++; this.stats.lastTickCells = applied; this.stats.lastTickMs = ms;
    this.stats.maxTickMs = Math.max(this.stats.maxTickMs, ms);
    return applied;
  }

  /** `fall`: the structural system's scripted demolition (or a plain removal without one). */
  _fall(job) {
    const engine = this.engine, world = engine?.world, structure = engine?.structure;
    const keys = [];
    for (let i = 0; i < job.cells.length; i += 4) {
      const x = job.cells[i], y = job.cells[i + 1], z = job.cells[i + 2];
      if (isSolidBlock(world.getBlock(x, y, z))) keys.push(pack(x, y, z));
    }
    if (structure?.active) {
      job.creakId = structure.bringDown(keys, { cause: job.by, origin: job.origin, chunkCap: job.chunkCap, fall: job.topple });
    } else {
      for (const key of keys) {
        const x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
        world.setBlock(x, y, z, AIR);
        engine.pushBlockDelta(x, y, z, AIR);
      }
    }
    job.applied = keys.length;
    job.next = job.cells.length;
    job.done = true;
  }
}
