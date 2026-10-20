// Frontier ford sluices, the server half (docs/conquest.md "Ford sluices";
// definitions, release tuning and the bore in shared/map-events/sluice.js,
// geometry in shared/map-events/weir.js).
//
// A sluice is a levolution (LevolutionController: the supports' pool, the
// stages, the fall, the final blow and assists through payDestroyed, the
// crossing closed from the groan). The release rides the active phase:
//
//   groan    the bore's push zones are posted (bots clear the reach below
//            the gates from now on; the zones open with the fall)
//   0 s      the span falls (piers sunk, at most 12 chunks); the gate leaves
//            under the reach's face turn to water and the pond's top voxel
//            drains over 6 s, nearest the gates first
//   bore     each 10 m of reach shoves swimmers, boats and hulls downstream
//            from the front's arrival (5 m/s, a 1 m crest falling to 0.3 m
//            100 m down) for 20 s
//   5 s      stepping stones settle across the old walkway line
//   24 s     the ford bed is scoured two voxels deeper: 3 m of water, no hull
//            fords (WADE_RULES), the infantry graph relabels from the deltas
//
// Every voxel change is a StagedEdits block delta, so a joiner gets the
// washed-out ford from the map cache and a rematch's restoreWorld puts the
// sluice, the pond and the ford back.
//
// Bots: crossingDenialValue (server/bot-map-events.js) posts the demolish and
// bridgehead tasks from the structure view like any levolution's. On top of
// it the ford's armour decides (botTasks): a side whose lane enemy armour runs
// over (a tank, or two light hulls near the ford and none of its own) blows
// the sluice, and the side whose armour uses the ford holds its bank ends.
import { AIR, MC_WATER, RUST, isSolidBlock } from '../../../../shared/world/blocks.js';
import { vehicleDef } from '../../../../shared/vehicle-defs.js';
import { sluiceBore } from '../../../../shared/map-events/sluice.js';
import { floodSet } from '../../../../shared/world/flood-field.js';
import { sillStone } from '../../../../shared/world/frontier-sites/weir.js';
import { DEMOLISH_RULES, crossingDenialValue } from '../../../bot-map-events.js';
import { LevolutionController } from './levolution.js';

const GROUND = new Set(['wheeled', 'tracked']);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Top solid voxel of a column at or below `y`, or 0. */
function solidBelow(world, x, z, y) {
  for (let yy = y; yy > 0; yy--) if (isSolidBlock(world.getBlock(x, yy, z))) return yy;
  return 0;
}

/** Feet height over the highest solid voxel of a column (under y40). */
const groundY = (world, x, z) => solidBelow(world, Math.floor(x), Math.floor(z), 40) + 1.02;

/** The pond's top voxel row as drain cells [x, y, z, AIR, ...]: every pond water cell, nearest the gates first. */
export function sluiceDrainCells(world, weir) {
  const y = weir.pond.faceY - 1, mid = (weir.pass.x0 + weir.pass.x1) / 2, rows = [];
  for (let z = weir.pond.z1; z >= weir.sill.z0; z--) {
    const row = [];
    for (let x = weir.pond.x0; x <= weir.pond.x1; x++) if (world.getBlock(x, y, z) === MC_WATER) row.push(x);
    row.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    for (const x of row) rows.push(x, y, z, AIR);
  }
  return rows;
}

/** The gate leaves under the reach's face (shut, RUST, from the bed up) as water cells: the fall takes the rest of each leaf. */
export function sluiceLeafCells(world, weir, faceY = 22) {
  const out = [];
  for (const bay of weir.bays) for (let x = bay.x0; x <= bay.x1; x++) {
    for (let y = faceY - 1; y > 0 && world.getBlock(x, y, weir.gateZ) === RUST; y--) out.push(x, y, weir.gateZ, MC_WATER);
  }
  return out;
}

/**
 * The scour of a ford: every column of `weir.ford` whose bed stands under
 * the water at the authored ford level or below (y20, its y19 shelves) loses
 * its top `depth` solid voxels to water. Returns [x, y, z, MC_WATER, ...].
 */
export function sluiceScourCells(world, weir, depth, faceY = 22) {
  const out = [], f = weir.ford;
  for (let z = f.z0; z <= f.z1; z++) for (let x = f.x0; x <= f.x1; x++) {
    const top = solidBelow(world, x, z, faceY);
    if (top > faceY - 2 || world.getBlock(x, top + 1, z) !== MC_WATER) continue;
    for (let y = top; y > top - depth && y > 0; y--) if (isSolidBlock(world.getBlock(x, y, z))) out.push(x, y, z, MC_WATER);
  }
  return out;
}

/**
 * The stepping stones across the old walkway rows: one field-stone column
 * per cell from the bed, its top one voxel over the reach's face, every
 * `every`th column left out (a 1 m gap), and `ramp` stones stepping up to the
 * abutment decks at each end. Only water and air cells change.
 */
export function sluiceStoneCells(world, weir, { every, ramp }, faceY = 22) {
  const out = [], x0 = weir.abutments[0].x1 + 1, x1 = weir.abutments[1].x0 - 1;
  for (let x = x0; x <= x1; x++) {
    const k = Math.min(x - x0, x1 - x), up = Math.max(0, ramp - k);
    if (!up && (x - x0) % every === every - 1) continue;
    const top = Math.min(weir.deckY - 1, faceY + up);
    for (let z = weir.walk.z0; z <= weir.walk.z1; z++) {
      for (let y = solidBelow(world, x, z, top) + 1; y <= top; y++) {
        const b = world.getBlock(x, y, z);
        if (b === AIR || b === MC_WATER) out.push(x, y, z, sillStone(x, y, z));
      }
    }
  }
  return out;
}

export class SluiceController extends LevolutionController {
  onReset() {
    super.onReset();
    const { weir, release } = this.def.tuning.sluice;
    this.weir = weir; this.release = release;
    this.bore = sluiceBore(weir, release.bore);
    this.fellAt = null;
    this._dropField();
    this.stoned = false; this.scoured = false;
    this.scourJob = null;
  }

  onPhase(phase, prev) {
    if (phase === 'warning' || (phase === 'active' && !this.system.hazards.of(this.event).length)) {
      this._postBore(this.system.now + (phase === 'warning' ? this.event.leftMs ?? 0 : 0));
    }
    super.onPhase(phase, prev);
    if (phase === 'active' && this.fellAt == null) this._release(this.system.now);
    if (phase === 'done') this._dropField();
  }

  /** The bore's flood field leaves world.flood (the release is over, or a rematch). */
  _dropField() {
    const world = this.system.engine?.world;
    if (world?.flood) world.flood.remove(this.event.id);
  }

  /** The bore's push zones, opening at `at` (the fall): bots avoid the reach from now on. */
  _postBore(at) {
    const b = this.release.bore, now = this.system.now;
    this.system.hazards.clear(this.event);
    for (const [i, s] of this.bore.segments().entries()) {
      this.system.hazards.add(this.event, { id: `${this.event.id}-bore-${i}`, kind: 'push', shape: 'box', x0: s.x0, z0: s.z0, x1: s.x1, z1: s.z1,
        y0: b.y0, y1: b.y1, from: at + s.fromMs, until: at + s.untilMs, warnFrom: now, impulse: { x: 0, y: 0, z: b.push * s.crest }, up: b.up,
        hullPush: b.hullPush, by: null });
    }
  }

  /** The fall started: the leaves under the face and the pond's top voxel go (staged). */
  _release(now) {
    const world = this.system.engine?.world;
    if (!world || !this.levolution?.active) return;
    this.fellAt = now;
    const by = this.levolution.by, R = this.release, ticks = Math.max(1, R.drainMs / 16.67);
    const leaves = sluiceLeafCells(world, this.weir);
    if (leaves.length) this.system.edits.enqueue({ id: `${this.event.id}-leaves`, instance: this.event, cells: leaves, by, authored: true });
    const drain = sluiceDrainCells(world, this.weir);
    this.drainCells = drain.length / 4;
    if (drain.length) this.system.edits.enqueue({ id: `${this.event.id}-drain`, instance: this.event, cells: drain, by, authored: true,
      budget: Math.max(1, Math.ceil(this.drainCells / ticks)) });
    this.event.announce('release', { pond: this.drainCells });
    // The bore's water over the reach from the fall (world.flood: swimming, hull depth, boats).
    const field = sluiceBore(this.weir, R.bore, (x, y, z) => world.getBlock(x, y, z)).field;
    floodSet(world).add(this.event.id, field, now);
    floodSet(world).nowMs = now;
  }

  onTick(now, dt) {
    super.onTick(now, dt);
    if (this.fellAt == null) return;
    const world = this.system.engine?.world, R = this.release, by = this.levolution?.by ?? null;
    if (!world) return;
    if (world.flood?.get(this.event.id)) world.flood.nowMs = now;
    if (!this.stoned && now - this.fellAt >= R.stonesMs) {
      this.stoned = true;
      const cells = sluiceStoneCells(world, this.weir, R.stones);
      if (cells.length) this.system.edits.enqueue({ id: `${this.event.id}-stones`, instance: this.event, cells, by, authored: true });
    }
    if (!this.scoured && now - this.fellAt >= R.scourMs) {
      this.scoured = true;
      const cells = sluiceScourCells(world, this.weir, R.scour.depth);
      this.scourCells = cells.length / 4;
      this.scourJob = this.system.edits.enqueue({ id: `${this.event.id}-scour`, instance: this.event, cells, by, authored: true,
        onDone: () => this.event.announce('scoured', { cells: this.scourCells }) });
    }
  }

  /** Crewed ground hulls by side within the bots' reach of the ford: weight (a tank counts tankWeight). */
  fordArmour() {
    const b = this.release.bots, vehicles = this.system.engine?.vehicles;
    const ford = (this.system.engine?.mapMeta?.conquest?.crossings ?? []).find(c => c.id === this.weir.crossing);
    const out = { alpha: 0, bravo: 0 };
    if (!vehicles || !ford) return out;
    for (const v of vehicles.vehicles.values()) {
      if (!(v.hp > 0) || !(v.team in out) || !GROUND.has(vehicleDef(v)?.handling) || !vehicles.crew(v).length) continue;
      if (flat(v, ford) <= b.reach) out[v.team] += v.type === 'tank' ? b.tankWeight : 1;
    }
    return out;
  }

  /**
   * The ford's armour on top of the crossing-denial tasks: a side run over by
   * enemy armour at the ford (and none of its own there) blows the sluice; the
   * side whose armour uses the ford holds its bank ends. The demolish task has
   * the crossing-denial task's id and shape, so the commander books it the
   * same way (two RX-8 bots and one hull crew).
   */
  botTasks(team) {
    const view = this.structureView(), structure = this.structure, game = this.system.engine, D = DEMOLISH_RULES;
    if (!view?.standing || !structure || !game || this._denying) return [];
    const armour = this.fordArmour(), other = team === 'alpha' ? 'bravo' : 'alpha', b = this.release.bots;
    const overrun = armour[other] >= b.armour && armour[team] === 0, using = armour[team] >= b.armour && armour[other] === 0;
    if (!overrun && !using) return [];
    // Past ±minValue the crossing-denial task stands already: no second copy. (crossingDenial reads
    // the flags through the conquest view, which asks the events for their tasks again: no recursion.)
    this._denying = true;
    let value;
    try { value = crossingDenialValue(game, team, { close: structure.crossing }); } finally { this._denying = false; }
    if (Math.abs(value) > D.minValue) return [];
    const base = game.mapMeta?.conquest?.bases?.[team];
    if (overrun && base) {
      // The support nearest the side's HQ, stood off toward it (as the crossing-denial task).
      const aim = structure.supports.map(s => ({ x: (s.x0 + s.x1 + 1) / 2, y: s.y1 + 0.5, z: (s.z0 + s.z1 + 1) / 2, id: s.id }))
        .reduce((best, c) => (!best || flat(c, base) < flat(best, base) ? c : best), null);
      const d = Math.max(1, flat(base, aim)), k = Math.min(D.standoff, d) / d;
      const x = aim.x + (base.x - aim.x) * k, z = aim.z + (base.z - aim.z) * k;
      const point = { x: aim.x, y: aim.y, z: aim.z };
      return [{ id: `demolish:${structure.id}`, kind: 'demolish', structure: structure.id, value: 0, reason: 'overrun',
        point: { x, y: groundY(game.world, x, z), z }, radius: 8, squad: D.infantry, priority: D.priority, launchers: D.shoot.projectiles,
        aim: point, support: aim.id, hulls: D.hulls,
        shoot: { kind: 'shoot', point, minRange: D.shoot.minRange, range: D.shoot.range, hitWithin: D.shoot.hitWithin, projectiles: D.shoot.projectiles } }];
    }
    if (using) {
      return structure.heads.map((h, i) => this.areaTask(`hold:${structure.id}:${i}`, h,
        { kind: 'hold', radius: D.hold.radius, squad: D.hold.squad, priority: D.hold.priority }));
    }
    return [];
  }
}
