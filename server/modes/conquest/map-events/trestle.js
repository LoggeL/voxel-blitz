// Canyon Trestle collapse, the server half (docs/conquest.md "Map events" ->
// "Canyon Trestle collapse"; data in shared/map-events/trestle.js). The
// generic levolution (./levolution.js: the bents' pool, the groan with the
// trestle crossing closed for bot drivers, the fall through the structural
// system, the crush credited as `trestle`, payDestroyed) plus what is the
// trestle's own:
//
//   berm   once the wreck has landed, a deterministic rubble bar across the
//          canyon floor under the old deck (one staged `set` job, authored so
//          it stays as placed): the river under it is filled from the bed up,
//          so infantry crosses the canyon dry where the deck was, with a
//          three-voxel ridge for cover; no road reaches the floor, vehicles
//          stay cut off
//   cut    the fall banners NO SOUTHERN CROSSING (reason `cut`) when the
//          other southern road crossing (the dam crest) is already closed
//
// Bots: the structure view feeds crossingDenialValue and the demolish / hold
// tasks (server/bot-map-events.js planStructureTasks); bot-bridge.js keeps
// bots off the closed span and routes them to its heads.
import { FLUID_BLOCKS, isSolidBlock } from '../../../../shared/world/blocks.js';
import { LevolutionController } from './levolution.js';

/**
 * The berm's cells over the pristine world, bottom up: [x, y, z, block, ...].
 * The trestle's own blocks count as air (they will have fallen).
 */
export function planTrestleBerm(world, def) {
  const { berm } = def.tuning;
  const own = new Set(def.tuning.levolution.structure.materials ?? []);
  const open = b => !isSolidBlock(b) || FLUID_BLOCKS.has(b) || own.has(b);
  const cells = [];
  let n = 0;
  for (const [zKey, rise] of Object.entries(berm.rows)) {
    const z = Number(zKey);
    for (let x = berm.x0; x <= berm.x1; x++) {
      const lump = rise >= 3 && (x * 7 + z * 13) % berm.lumpEvery === 0 ? 1 : 0;
      const top = berm.floorY + rise + lump;
      // The column's bed: the highest block that is not open, below the berm top.
      let bed = top;
      while (bed > 0 && open(world.getBlock(x, bed, z))) bed--;
      for (let y = bed + 1; y <= top; y++) {
        cells.push(x, y, z, berm.materials[(x * 3 + y * 5 + z * 11 + n++) % berm.materials.length]);
      }
    }
  }
  return Int32Array.from(cells);
}

export class TrestleController extends LevolutionController {
  onReset() {
    super.onReset();
    this.berm = this.levolution?.active ? planTrestleBerm(this.system.engine.world, this.def) : null;
    this.bermJob = null;
  }

  /** The groan ran out: the fall, banned `cut` when the other southern crossing is gone too. */
  onTimer(phase) {
    if (phase !== 'warning') return false;
    const alternate = this.def.tuning.alternate;
    const cut = !!alternate && this.system.instances.some(i => i !== this.event && (i.controller.closedCrossings?.() ?? []).includes(alternate));
    this.event.setPhase('active', cut ? { reason: 'cut' } : {});
    return true;
  }

  onTick(now) {
    super.onTick(now);
    const lev = this.levolution;
    if (!this.berm || this.bermJob || lev?.downAt == null || now < lev.downAt + this.def.tuning.berm.delayMs) return;
    // Never inside a body or a hull (a swimmer under the deck keeps its pocket).
    const structure = this.system.engine.structure;
    const cells = [];
    for (let i = 0; i < this.berm.length; i += 4) {
      if (structure?.occupied?.(this.berm[i], this.berm[i + 1], this.berm[i + 2])) continue;
      cells.push(this.berm[i], this.berm[i + 1], this.berm[i + 2], this.berm[i + 3]);
    }
    this.bermJob = this.system.edits.enqueue({ id: 'trestle-berm', instance: this.event, cells, by: lev.by, authored: true });
  }
}
