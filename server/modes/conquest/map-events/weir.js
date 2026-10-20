// Frontier sluice weir, the server half (docs/conquest.md "Sluice weir";
// definition, geometry and tuning in shared/map-events/weir.js).
//
//   idle      the sluice wheel is open to both teams (hold 5 s)
//   warning   6 s horn; bots clear the fords, drivers stop routing over them
//   active    the gate leaves rise into their gantries and the surge floods
//             both fords (one staged edit: the gates, then ford-north from the
//             weir down, then ford-south) for 120 s
//   cooldown  the water recedes and the gates shut again (one staged edit),
//   / done    then 4 minutes until the wheel turns again (three floods a match)
//
// Every voxel change is a StagedEdits block delta, so a joiner gets the
// flood from the map cache and a rematch's restoreWorld puts the river back.
// Ground hulls stall in the flooded fords by the vehicle rule (WADE_RULES),
// boats sail over them without scraping (BOAT_RULES.shallowDepth), swimmers
// swim: the event itself only moves water.
import { AIR, MC_WATER, RUST, isSolidBlock } from '../../../../shared/world/blocks.js';
import { vehicleDef } from '../../../../shared/vehicle-defs.js';
import { WEIR, WEIR_FLOODS } from '../../../../shared/map-events/weir.js';
import { weirGateCells } from '../../../../shared/world/frontier-sites/weir.js';
import { MapEventController } from './controller.js';

const GROUND = new Set(['wheeled', 'tracked']);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** The ford bed under a gate leaf column (the first solid below the shut leaf that is not the leaf). */
function gateBed(world, x) {
  for (let y = WEIR.shutTopY; y > 0; y--) {
    const b = world.getBlock(x, y, WEIR.gateZ);
    if (isSolidBlock(b) && b !== RUST) return y;
  }
  return 0;
}

/**
 * The gate cells to open (`open` true) or shut, as edit cells [x, y, z, v]:
 * the shut leaf turns to river water below the water face and air above it,
 * the open leaf appears in the gantry; shutting reverses it. Only cells in
 * the expected state change (a crater or a built block is left alone).
 */
export function weirGateEdits(world, open, riverFace = 22) {
  const out = [];
  for (const bay of WEIR.bays) {
    const shut = weirGateCells(bay, true, x => gateBed(world, x)), hung = weirGateCells(bay, false, null);
    const from = open ? shut : hung, to = open ? hung : shut;
    for (const [x, y, z] of from) if (world.getBlock(x, y, z) === RUST) out.push(x, y, z, y < riverFace ? MC_WATER : AIR);
    for (const [x, y, z] of to) { const b = world.getBlock(x, y, z); if (b === AIR || b === MC_WATER) out.push(x, y, z, RUST); }
  }
  return out;
}

/**
 * The flood cells over both fords, in surge order (ford-north from the weir
 * down, then ford-south; row by row, the lower layer first): [x, y, z, ...]
 * of air cells that turn to water. A cell floods only over water, so the
 * river rises in its own channel and never spreads onto a bank.
 */
export function weirFloodCells(world, { coreFace = 24, taperFace = 23, riverFace = 22 } = {}) {
  const out = [];
  for (const f of WEIR_FLOODS) {
    const wet = new Set();
    for (let z = f.taper[0]; z <= f.taper[1]; z++) {
      const face = z >= f.core[0] && z <= f.core[1] ? coreFace : taperFace;
      for (let y = riverFace; y < face; y++) for (let x = f.x0; x <= f.x1; x++) {
        if (world.getBlock(x, y, z) !== AIR) continue;
        const below = world.getBlock(x, y - 1, z);
        if (below !== MC_WATER && !wet.has(`${x},${y - 1},${z}`)) continue;
        wet.add(`${x},${y},${z}`);
        out.push(x, y, z);
      }
    }
  }
  return out;
}

export class WeirController extends MapEventController {
  onReset() {
    this.stage = 'low';      // low | rising | high | falling
    this.flood = [];         // flat [x, y, z, ...] of the surge's water cells
    this.job = null;
    this.system.points.enable(this.event, 'wheel', true);
  }

  get tuning() { return this.def.tuning; }
  get world() { return this.system.engine?.world ?? null; }

  onUse(point, entity, team) {
    if (point.id !== 'wheel' || this.event.phase !== 'idle') return;
    if (this.event.trigger({ team, by: entity?.id ?? null })) this.system.award(entity?.id, 'trigger');
  }

  onPhase(phase, prev) {
    this.system.points.enable(this.event, 'wheel', phase === 'idle');
    if (phase === 'warning') this.openSurgeZones();
    else if (phase === 'active') this.surge();
    else if ((phase === 'cooldown' || phase === 'done') && prev === 'active') this.recede();
  }

  /** The surge's push zones (downstream, +z) over each flooded reach; bots keep out of them from the horn on. */
  openSurgeZones() {
    const now = this.system.now, t = this.tuning, opens = now + (this.event.leftMs ?? 0);
    for (const f of WEIR_FLOODS) {
      this.system.hazards.add(this.event, { id: `weir-surge-${f.id}`, kind: 'push', shape: 'box', x0: f.x0, z0: f.taper[0], x1: f.x1 + 1, z1: f.taper[1] + 1,
        y0: 16, y1: t.coreFace + 2, from: opens, until: opens + t.surgePushMs, warnFrom: now, impulse: { x: 0, y: 0, z: t.surgePush }, hullPush: 0.3, by: null });
    }
  }

  surge() {
    const world = this.world;
    if (!world) return;
    const t = this.tuning;
    if (this.job) this.system.edits.cancel(this.job.id);
    // A recession cut short (a shortened cooldown) leaves flood water standing: the next recession drains it too.
    const standing = [];
    for (let i = 0; i < this.flood.length; i += 3) {
      if (world.getBlock(this.flood[i], this.flood[i + 1], this.flood[i + 2]) === MC_WATER) standing.push(this.flood[i], this.flood[i + 1], this.flood[i + 2]);
    }
    const flood = weirFloodCells(world, t);
    this.flood = standing.concat(flood);
    const cells = [];
    const gates = weirGateEdits(world, true, t.riverFace);
    cells.push(...gates);
    for (let i = 0; i < flood.length; i += 3) cells.push(flood[i], flood[i + 1], flood[i + 2], MC_WATER);
    this.total = cells.length / 4;
    this.stage = 'rising';
    this.job = this.system.edits.enqueue({ id: 'weir-surge', instance: this.event, cells, budget: t.surgeCellsPerTick, authored: true, by: this.event.by,
      onDone: () => { this.stage = 'high'; this.job = null; } });
    this.event.announce('surge', { cells: this.total });
  }

  recede() {
    const world = this.world;
    if (!world) return;
    const t = this.tuning;
    if (this.job) { this.system.edits.cancel(this.job.id); this.job = null; }
    this.system.hazards.clear(this.event);
    // The upper layer first, then the lower one; the gates shut last.
    const rows = [];
    for (let i = 0; i < this.flood.length; i += 3) {
      const [x, y, z] = [this.flood[i], this.flood[i + 1], this.flood[i + 2]];
      if (world.getBlock(x, y, z) === MC_WATER) rows.push([x, y, z]);
    }
    rows.sort((a, b) => b[1] - a[1] || a[2] - b[2] || a[0] - b[0]);
    const cells = [];
    for (const [x, y, z] of rows) cells.push(x, y, z, AIR);
    cells.push(...weirGateEdits(world, false, t.riverFace));
    this.total = cells.length / 4;
    this.stage = 'falling';
    this.job = this.system.edits.enqueue({ id: 'weir-recede', instance: this.event, cells, budget: t.recedeCellsPerTick, authored: true,
      onDone: () => { this.stage = 'low'; this.job = null; this.flood = []; } });
  }

  /** The flood gauge: 0 normal water, 1 high water (the HUD paints the fords with it). */
  progress() {
    const share = this.job && this.total > 0 ? Math.min(1, this.job.applied / this.total) : 0;
    if (this.stage === 'rising') return share;
    if (this.stage === 'high') return 1;
    if (this.stage === 'falling') return 1 - share;
    return 0;
  }

  /** Bot drivers keep off the fords from the horn until they have drained. */
  closedCrossings() {
    return this.event.phase === 'warning' || this.event.phase === 'active' || this.stage !== 'low' ? this.tuning.crossings : null;
  }

  /** Crewed hulls by side near the fords: {enemyArmour, ownArmour, ownBoat} for `team`. */
  fordThreat(team) {
    const b = this.tuning.bots, vehicles = this.system.engine?.vehicles;
    const fords = (this.system.policy?.mapMeta?.conquest?.crossings ?? []).filter(c => this.tuning.crossings.includes(c.id));
    const out = { enemyArmour: false, ownArmour: false, ownBoat: false };
    if (!vehicles || !fords.length) return out;
    for (const v of vehicles.vehicles.values()) {
      if (!(v.hp > 0) || !v.team || !vehicles.crew(v).length) continue;
      const handling = vehicleDef(v)?.handling, d = Math.min(...fords.map(c => flat(c, v)));
      if (GROUND.has(handling)) {
        if (v.team !== team && d <= b.armourReach) out.enemyArmour = true;
        if (v.team === team && d <= b.ownReach) out.ownArmour = true;
      } else if (handling === 'boat' && v.team === team && d <= b.boatReach) out.ownBoat = true;
    }
    return out;
  }

  /**
   * Bots open the sluice when enemy armour is about to ford (and none of
   * their own is in a ford) or to speed their own boat over the fords; a
   * rival turning the wheel draws a small squad to stop it.
   */
  botTasks(team) {
    const b = this.tuning.bots, wheel = this.point('wheel');
    if (!wheel?.enabled) return [];
    if (wheel.user && wheel.userTeam && wheel.userTeam !== team) {
      return [this.areaTask('contest', wheel, { kind: 'attack', radius: 4, priority: b.contestPriority, squad: b.contestSquad, range: b.contestRange })];
    }
    if (this.event.phase !== 'idle' || !this.system.director.mayFire(this.event)) return [];
    const threat = this.fordThreat(team);
    if (!((threat.enemyArmour && !threat.ownArmour) || (threat.ownBoat && !threat.ownArmour))) return [];
    const task = this.useTask('wheel', team, { priority: b.priority, squad: 1, range: b.range });
    return task ? [task] : [];
  }
}
