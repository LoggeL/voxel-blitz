// Signal Rock relay and radio mast, the server half (docs/conquest.md
// "Signal Rock relay"; data and geometry in shared/map-events/relay.js).
//
// Phases: `idle` (nobody owns the relay) -> `active` (held: `team` the
// owner, `endsAt` the next scan; a completed hold by the other side flips
// it, `reason: 'captured'`) -> when the mast's integrity runs out, `armed`
// (only on the way into the director, or queued behind another big event)
// -> `warning` (the groan) -> `done` (fallen; the relay is offline until
// the rematch). `team` / `by` from `armed` on are the side and the player
// that dealt the final blow (or whose charge did).
//
// The fall is presented through the structural FX path: a `creak` of the
// mast's cells at the groan, one `collapse` chunk spinning about the hinge
// as the mast goes (no drift, no gravity: the rotation is the fall) and a
// `collapseLand` when it lies down; the voxels move as block deltas through
// StagedEdits (the standing cells cleared as it starts to fall, the wreck
// written as it lands, pinned as placed), so joiners get the wreck from the
// map cache and the bots' nav relabels the columns.
import { AIR, isSolidBlock } from '../../../../shared/world/blocks.js';
import { RELAY_SITE, relayCrushLine, relayFallenCell, roadDistance } from '../../../../shared/map-events/relay.js';
import { evCollapse, evCollapseLand, evCreak, evProjectileExplode } from '../../../protocol/events.js';
import { MapEventController } from './controller.js';

const TEAMS = ['alpha', 'bravo'];
const rival = team => (team === 'alpha' ? 'bravo' : team === 'bravo' ? 'alpha' : null);
/** Gravity of the mast's collapse chunk: near zero (0 reads as the default on the client). */
const CHUNK_G = 0.01;

/** Highest solid block of a column at or below `from` (-1 none). */
function groundTop(world, x, z, from) {
  for (let y = from; y >= 0; y--) if (isSolidBlock(world.getBlock(x, y, z))) return y;
  return -1;
}

/**
 * The mast's fall from the current world: `standing` [{x, y, z, t}] (every
 * solid cell of RELAY_SITE.mast), `clear` (the job removing them) and
 * `wreck` (the job writing the fallen cells, hinge first). Deterministic for
 * a given world; `road` the polyline flattened to one layer.
 */
export function planRelayFall(world, fall, road = null, box = RELAY_SITE.mast) {
  const standing = [];
  for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) for (let x = box.x0; x <= box.x1; x++) {
    const t = world.getBlock(x, y, z);
    if (isSolidBlock(t)) standing.push({ x, y, z, t: t & 255 });
  }
  const band = road ? road.width / 2 + fall.roadPad : 0;
  const placed = new Map();
  for (const c of standing) {
    let [x, y, z] = relayFallenCell(c.x, c.y, c.z, fall);
    const top = groundTop(world, x, z, box.y0 + 8);
    if (road && roadDistance(road.points, x + 0.5, z + 0.5) <= band) y = top + 1;  // crushed flat on the road
    if (y <= top || (!(z < box.z0) && x >= box.x0 && x <= box.x1)) continue;       // buried, or back on the foundation
    const key = `${x},${y},${z}`;
    if (!placed.has(key) && !isSolidBlock(world.getBlock(x, y, z))) placed.set(key, { x, y, z, v: c.t });
  }
  const wreck = [...placed.values()].sort((a, b) => b.z - a.z || a.y - b.y || a.x - b.x);
  const clear = standing.slice().sort((a, b) => b.y - a.y || a.z - b.z || a.x - b.x);
  return {
    standing,
    clear: Int32Array.from(clear.flatMap(c => [c.x, c.y, c.z, AIR])),
    wreck: Int32Array.from(wreck.flatMap(c => [c.x, c.y, c.z, c.v])),
    cells: wreck.length,
  };
}

export class RelayController extends MapEventController {
  get tuning() { return this.def.tuning; }

  onReset() {
    this.holdSince = null;      // engine ms the current owner took the relay
    this.charge = null;         // {by, team, at, zone} a planted demolition charge
    this.landAt = null;         // engine ms the falling mast lies down
    this.fallPlan = null;
    this.contest = '';
    this.damagedNoted = false;
    this.scans = 0;
    this.lastScan = null;       // {at, team, players, hulls} (tests)
    this.system.points.enable(this.event, 'relay', true, { teams: TEAMS });
    this.system.points.enable(this.event, 'charge', false);
  }

  get online() { const p = this.event.phase; return p === 'idle' || p === 'active'; }
  get owner() { return this.event.phase === 'active' ? this.event.team : null; }
  get mast() { return this.target('mast'); }

  /** 0..1 on the wire: the mast's damage (0 intact, 1 down), as the bridge's gauge counts the other way. */
  progress() { const t = this.mast; return t ? 1 - this.system.targets.share(t) : 0; }

  /** Living combatants within the contest radius of the bunker, per team. */
  _present() {
    const { contestRadiusM: r, contestDy: dy } = this.tuning.capture, b = RELAY_SITE.bunker;
    const out = { alpha: 0, bravo: 0 };
    for (const p of this.system.engine?.combatants?.values?.() ?? []) {
      if (p.state !== 'alive' || p.vehicleId) continue;
      if (Math.hypot(p.x - b.x, p.z - b.z) > r || Math.abs(p.y - b.y) > dy) continue;
      const team = this.system.teamOf(p);
      if (team in out) out[team]++;
    }
    return out;
  }

  onTick(now) {
    if (this.online) {
      // The hold runs for a side that does not own the relay while no enemy of it stands in the zone.
      const present = this._present();
      const teams = TEAMS.filter(t => t !== this.owner && !present[rival(t)]);
      const key = teams.join(',');
      if (key !== this.contest) { this.contest = key; this.system.points.enable(this.event, 'relay', true, { teams }); }
    }
    if (this.charge && now >= this.charge.at) this._detonate();
    if (this.landAt != null && now >= this.landAt) this._land();
  }

  onUse(point, entity, team) {
    if (!this.online || !team) return;
    if (point.id === 'relay' && team !== this.owner) {
      this.holdSince = this.system.now;
      this.event.setPhase('active', { ms: this.tuning.scan.firstMs, team, by: entity?.id ?? null, reason: 'captured' });
      this.contest = '';
      this.system.award(entity?.id, 'use');
    } else if (point.id === 'charge' && this.owner && team !== this.owner && !this.charge) {
      const c = this.tuning.charge, at = this.system.now + c.fuseMs, by = entity?.id == null ? null : String(entity.id);
      // The blast's own crush zone: the owner's bots run from it through the fuse, the planter's side is spared.
      const zone = this.system.hazards.add(this.event, { kind: 'crush', shape: 'circle', x: point.x, z: point.z, r: c.blastR,
        y0: point.y - 3, y1: point.y + 4, from: at, warnFrom: this.system.now, by, killKey: 'relayCharge', damage: c.blastDamage, hullFraction: c.hullFraction });
      this.charge = { by, team, at, zone, pos: [point.x, point.y + 0.6, point.z] };
      this.system.points.enable(this.event, 'charge', false);
      this.event.announce('planted', { fuseMs: c.fuseMs, team });
      this.system.award(by, 'use');
    }
  }

  /** The charge goes off: an explosion for the clients and its share off the mast's pool. */
  _detonate() {
    const charge = this.charge;
    this.charge = null;
    const engine = this.system.engine;
    engine?.tickEvents?.push(evProjectileExplode(charge.by ?? '', `relay-charge-${Math.round(charge.at)}`, 'rocket', charge.pos,
      this.tuning.charge.blastR));
    this.system.targets.damage(this.mast, this.tuning.charge.damage, charge.by, { key: 'relayCharge' });
    if (this.online && this.owner) this.system.points.enable(this.event, 'charge', true);
  }

  onTarget(target, hit) {
    if (target.id !== 'mast' || !this.online) return;
    if (hit.destroyed) { this._blow(hit.by, hit.team); return; }
    if (!this.damagedNoted && hit.share <= this.tuning.damagedShare) {
      this.damagedNoted = true;
      this.event.announce('damaged', { share: Math.round(hit.share * 100) });
    }
  }

  /** The final blow: the relay goes offline, the director grants the groan. */
  _blow(by, team) {
    this.system.points.enable(this.event, 'relay', false);
    this.system.points.enable(this.event, 'charge', false);
    if (this.charge) { this.system.hazards.remove(this.charge.zone); this.charge = null; }
    this.holdSince = null;
    if (this.event.phase === 'active') this.event.setPhase('armed', { ms: null, team: team ?? null, by: by ?? null, reason: 'mast' });
    this.event.trigger({ team: team ?? null, by: by ?? null });
    this.system.award(by, 'trigger');
  }

  onPhase(phase) {
    if (phase === 'active') {
      // Held: the rival may plant on the mast; the owner's first scan comes `firstMs` after the capture.
      this.system.points.enable(this.event, 'charge', !this.charge, { teams: 'rival' });
    } else if (phase === 'warning') this._groan();
  }

  /** The groan: the creak of every standing cell (FX), the crush line warned for the bots. */
  _groan() {
    const engine = this.system.engine, world = engine?.world, fall = this.tuning.fall;
    if (!world) return;
    const road = this.system.policy?.mapMeta?.conquest?.roads?.find?.(r => r.id === fall.roadId) ?? null;
    this.fallPlan = planRelayFall(world, fall, road);
    const at = this.event.endsAt ?? this.system.now;
    // Engine time in the id: a rematch's fall never reuses a chunk id the client still knows.
    this.creakId = `relay-${Math.round(this.system.now)}`;
    const enc = encodeCells(this.fallPlan.standing);
    engine.tickEvents?.push(evCreak(this.creakId, this.system.now, Math.max(0, at - this.system.now), enc.o, enc.b, enc.n));
    this.system.hazards.add(this.event, { kind: 'crush', ...relayCrushLine(fall), from: at + fall.fallMs, warnFrom: this.system.now,
      by: this.event.by, damage: fall.crushDamage, hullFraction: fall.hullFraction, killKey: 'relayMast' });
  }

  onTimer(phase) {
    if (phase === 'active') { this._scan(); this.event.endsAt = this.system.now + this.tuning.scan.everyMs; return true; }
    if (phase === 'warning') { this._fall(); return true; }
    return false;
  }

  /** The mast goes: its cells clear under the budget while the client's chunk rotates about the hinge. */
  _fall() {
    const engine = this.system.engine, fall = this.tuning.fall;
    if (!this.fallPlan) this._groan();
    const plan = this.fallPlan, now = this.system.now;
    if (plan?.standing.length) {
      const enc = encodeCells(plan.standing);
      const rate = (fall.restDeg * Math.PI / 180) / (fall.fallMs / 1000);
      engine.tickEvents?.push(evCollapse(`${this.creakId}-c`, this.creakId, now, enc.o, enc.b, enc.n, fall.hinge, [0, 0, 0], [-rate, 0, 0], CHUNK_G, fall.fallMs));
      this.system.edits.enqueue({ id: `${this.creakId}-clear`, instance: this.event, cells: plan.clear, by: this.event.by, budget: fall.cellsPerTick });
    }
    this.landAt = now + fall.fallMs;
    this.event.setPhase('done', { reason: 'toppled' });
  }

  /** It lies down: the wreck's voxels (pinned as placed), the landing burst; the crush zone opens this tick. */
  _land() {
    this.landAt = null;
    const plan = this.fallPlan, fall = this.tuning.fall, engine = this.system.engine;
    if (!plan) return;
    this.system.edits.enqueue({ id: `${this.creakId}-wreck`, instance: this.event, cells: plan.wreck, by: this.event.by,
      budget: fall.cellsPerTick, authored: true });
    const line = relayCrushLine(fall);
    engine?.tickEvents?.push(evCollapseLand(`${this.creakId}-c`, this.system.now, [line.ax, fall.hinge[1] - 2, (line.az + line.bz) / 2],
      plan.standing.length, plan.cells, 14));
  }

  /** One scan: every living enemy of the owner (and crewed enemy hull) within the radius is spotted for the owner. */
  _scan() {
    const team = this.owner, s = this.tuning.scan, c = RELAY_SITE.mastCentre;
    const spotting = this.system.policy?.roles?.spotting;
    if (!team || !spotting) return;
    const until = this.system.now + s.revealMs;
    let players = 0, hulls = 0;
    for (const p of this.system.engine?.combatants?.values?.() ?? []) {
      if (p.state !== 'alive' || this.system.teamOf(p) !== rival(team) || Math.hypot(p.x - c.x, p.z - c.z) > s.radiusM) continue;
      if (spotting.markPlayer(p, { team, until }) || spotting.isSpotted(p)) players++;
    }
    for (const v of this.system.engine?.vehicles?.vehicles?.values?.() ?? []) {
      if (!(v.hp > 0) || v.team !== rival(team) || Math.hypot(v.x - c.x, v.z - c.z) > s.radiusM) continue;
      const crewed = !!v.occupantId || Object.values(v.seatOccupants ?? {}).some(Boolean);
      if (crewed && spotting.markVehicle(v, { team, until })) hulls++;
    }
    this.scans++;
    this.lastScan = { at: this.system.now, team, players, hulls };
    this.event.announce('scan', { team, n: players + hulls });
  }

  /**
   * Bots (server/bot-map-events.js): a side without the relay sends a small
   * squad to take it in duty windows (`bots.takeMs` of every `bots.cycleMs`,
   * the two sides half a cycle apart), the owner holds the bunker while an
   * enemy closes in, and once the enemy has held it for `chargeAfterMs` a
   * bot with explosives goes to plant the charge.
   */
  botTasks(team) {
    if (!this.online) return [];
    const b = this.tuning.bots, now = this.system.now, bunker = RELAY_SITE.bunker;
    const tasks = [];
    if (team === this.owner) {
      if (this._enemyNear(team, b.defendNearM)) {
        tasks.push(this.areaTask('defend', bunker, { kind: 'hold', radius: 5, priority: b.defendPriority, squad: b.defendSquad, range: b.range }));
      }
      return tasks;
    }
    const offset = team === 'alpha' ? 0 : b.cycleMs / 2;
    if ((now + offset) % b.cycleMs < b.takeMs) {
      const take = this.useTask('relay', team, { priority: b.takePriority, squad: b.takeSquad, range: b.range });
      if (take) tasks.push(take);
      tasks.push(this.areaTask('take', bunker, { kind: 'attack', radius: 8, priority: b.takePriority, squad: b.escortSquad, range: b.range }));
    }
    if (this.owner && this.holdSince != null && now - this.holdSince >= b.chargeAfterMs) {
      const plant = this.useTask('charge', team, { priority: b.chargePriority, squad: 1, range: b.range, kits: b.chargeKits });
      if (plant) tasks.push(plant);
    }
    return tasks;
  }

  _enemyNear(team, radius) {
    const b = RELAY_SITE.bunker;
    for (const p of this.system.engine?.combatants?.values?.() ?? []) {
      if (p.state === 'alive' && this.system.teamOf(p) === rival(team) && Math.hypot(p.x - b.x, p.z - b.z) <= radius) return true;
    }
    return false;
  }
}

/** Structure event cell encoding (StructureSystem.encode): origin + flat [dx, dy, dz, type]. */
function encodeCells(cells) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  for (const c of cells) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); z0 = Math.min(z0, c.z); }
  const b = [];
  for (const c of cells) b.push(c.x - x0, c.y - y0, c.z - z0, c.t);
  return { o: [x0, y0, z0], b, n: cells.length };
}
