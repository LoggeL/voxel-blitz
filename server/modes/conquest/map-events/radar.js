// Flag radars, the server half (docs/conquest.md "Flag radars"; data and
// geometry in shared/map-events/radar.js). One controller per radar.
//
//   idle     the radar stands and its flag is neutral: nobody owns it
//   active   the flag's holder owns it (`team`, re-read every tick from the
//            capture state); `endsAt` is the next sweep. A sweep spots every
//            crewed enemy ground hull within `groundM` of the flag and every
//            enemy aircraft or linked FPV drone within `airM` for `revealMs`
//            (the ordinary vehicle spot marks); one `map_event` note `sweep`
//            {team, ids} tells the clients which hulls it caught
//   warning  the pool ran out (blasts only: the Iron Bridge's supportDamage
//            table): the structure groans for `groanMs` (a creak of its
//            cells), bots of both sides keep off the fall lines; `team` /
//            `by` the side and player of the last blow (paid at once:
//            payDestroyed, final blow 300 and the assists)
//   done     it comes down through the structural system (StagedEdits
//            `fall`, part by part in the site's order: a toppling part over
//            its hinge, the rest in place, the chunks landing as the wreck);
//            no sweeps for the rest of the round, whoever holds the flag
//
// `armed` only bridges `active` into the trigger (the radar is a small
// event: the director never queues it). Joiners get the phase, owner and the
// seconds to the next sweep from `ev`, the wreck from the map cache; a
// rematch restores the world and reset() starts the radar over.
import { AIR, isSolidBlock } from '../../../../shared/world/blocks.js';
import { isAircraftType, isDroneType } from '../../../../shared/vehicle-defs.js';
import { radarFallZone, radarPartCells } from '../../../../shared/map-events/radar.js';
import { evCreak } from '../../../protocol/events.js';
import { MapEventController } from './controller.js';

const TEAMS = ['alpha', 'bravo'];
const rival = team => (team === 'alpha' ? 'bravo' : team === 'bravo' ? 'alpha' : null);
/** Cells a groan's creak lists at most (the structure FX samples the rest). */
const CREAK_CELLS = 600;

export class RadarController extends MapEventController {
  get T() { return this.def.tuning; }
  get site() { return this.T.site; }
  get engine() { return this.system.engine; }
  get world() { return this.engine?.world ?? null; }

  onReset() {
    const now = this.system.now;
    this.sweeps = 0;
    this.lastSweep = null;     // {at, team, ids} (tests)
    this.swept = [];           // [{at, team (the side swept), n}] for the bots
    this.notOursSince = { alpha: now, bravo: now };
    this.lastOwner = this.flag()?.owner ?? null;
    this.damagedNoted = false;
    this.fallAt = null;
    this.jobs = [];
    this.zones = [];
    this.cells = 0;
    // Only a world with the structure standing takes part (the battlefield; ad-hoc test worlds stay inert).
    this.present = this._standingCells() > 0;
    const target = this.target('radar');
    if (target) target.enabled = this.present;
  }

  get online() { const p = this.event.phase; return this.present && (p === 'idle' || p === 'active'); }
  get owner() { return this.event.phase === 'active' ? this.event.team : null; }

  /** The flag the radar belongs to (capture state: id, x, z, owner). */
  flag() { return (this.system.policy?.flags ?? []).find(f => f.id === this.site.flag) ?? null; }

  /** 0..1 on the wire: the structure's damage (0 intact, 1 spent). */
  progress() { const t = this.target('radar'); return t ? 1 - this.system.targets.share(t) : 0; }

  _standingCells() {
    const world = this.world;
    if (typeof world?.getBlock !== 'function') return 0;
    const get = (x, y, z) => world.getBlock(x, y, z);
    const taken = new Set();
    return this.site.parts.reduce((n, part) => n + radarPartCells(get, part, isSolidBlock, taken).length / 4, 0);
  }

  // ---------------------------------------------------------- ownership --

  onTick(now) {
    if (!this.online) return;
    const owner = this.flag()?.owner ?? null;
    if (owner === this.owner) return;
    const prior = this.owner;
    if (prior) this.notOursSince[prior] = now;
    if (owner) this.lastOwner = owner;
    if (owner) this.event.setPhase('active', { ms: this.T.firstMs, team: owner, by: null, reason: prior ? 'captured' : 'held' });
    else this.event.setPhase('idle', { reason: 'neutral' });
  }

  onTimer(phase) {
    if (phase === 'active') { this._sweep(); this.event.endsAt = this.system.now + this.T.everyMs; return true; }
    if (phase === 'warning') { this._fall(); return true; }
    return false;
  }

  // -------------------------------------------------------------- sweep --

  /** The side of a crewed hull (its first seated crew member's, a linked drone's own), or null when empty. */
  hullSide(v) {
    if (isDroneType(v.type)) return v.cutAt == null ? v.team ?? null : null;
    for (const id of [v.occupantId, ...Object.values(v.seatOccupants ?? {})]) {
      if (id == null) continue;
      const team = this.system.teamOf(id);
      if (team) return team;
    }
    return null;
  }

  /** The enemy hulls of `team` the radar's rings hold now: [{v, air}]. */
  hullsInRings(team) {
    const flag = this.flag(), enemy = rival(team), T = this.T, out = [];
    if (!flag || !enemy) return out;
    for (const v of this.engine?.vehicles?.vehicles?.values?.() ?? []) {
      if (!(v.hp > 0) || this.hullSide(v) !== enemy) continue;
      const air = isAircraftType(v.type) || isDroneType(v.type);
      if (Math.hypot(v.x - flag.x, v.z - flag.z) <= (air ? T.airM : T.groundM)) out.push({ v, air });
    }
    return out;
  }

  /** One sweep: the owner's side spots every enemy hull in the rings. */
  _sweep() {
    const team = this.owner, spotting = this.system.policy?.roles?.spotting, now = this.system.now;
    if (!team) return;
    const until = now + this.T.revealMs, ids = [];
    for (const { v } of this.hullsInRings(team)) {
      spotting?.markVehicle?.(v, { team, until });
      ids.push(String(v.id));
    }
    this.sweeps++;
    this.lastSweep = { at: now, team, ids };
    this.swept = this.swept.filter(s => now - s.at <= this.T.bots.sweptWindowMs);
    if (ids.length) this.swept.push({ at: now, team: rival(team), n: ids.length });
    this.event.announce('sweep', { team, ids });
  }

  // -------------------------------------------------------- destruction --

  onTarget(target, hit) {
    if (target.id !== 'radar' || !this.online) return;
    if (hit.destroyed) { this._blow(hit); return; }
    if (!this.damagedNoted && hit.share <= this.T.damagedShare) {
      this.damagedNoted = true;
      this.event.announce('damaged', { share: Math.round(hit.share * 100) });
    }
  }

  /** The last blow: paid at once, the groan through the trigger. */
  _blow(hit) {
    this.system.payDestroyed(this.target('radar'), hit.by);
    if (this.event.phase === 'active') this.event.setPhase('armed', { ms: null, team: hit.team ?? null, by: hit.by ?? null, reason: 'down' });
    this.event.trigger({ team: hit.team ?? null, by: hit.by ?? null });
  }

  onPhase(phase) {
    if (phase === 'warning') this._groan();
  }

  /** The groan: a creak of the standing cells (FX) and the fall lines the bots keep off from now on. */
  _groan() {
    const engine = this.engine, now = this.system.now, until = now + (this.event.leftMs ?? 0) + this.T.landMs;
    for (const part of this.site.parts) {
      this.zones.push(this.system.hazards.add(this.event, { kind: 'fire', dps: 0, hullDps: 0, ...radarFallZone(part), from: now, until, spareTeam: false }));
    }
    const world = this.world;
    if (!world || !engine?.tickEvents) return;
    const get = (x, y, z) => world.getBlock(x, y, z);
    const taken = new Set(), cells = [];
    for (const part of this.site.parts) {
      const list = radarPartCells(get, part, isSolidBlock, taken);
      for (let i = 0; i < list.length; i += 4) cells.push({ x: list[i], y: list[i + 1], z: list[i + 2], t: get(list[i], list[i + 1], list[i + 2]) & 255 });
    }
    if (!cells.length) return;
    const step = Math.max(1, Math.ceil(cells.length / CREAK_CELLS)), shown = cells.filter((_, i) => i % step === 0);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    for (const c of shown) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); z0 = Math.min(z0, c.z); }
    const b = [];
    for (const c of shown) b.push(c.x - x0, c.y - y0, c.z - z0, c.t);
    // Engine time in the id: a rematch's groan never reuses an id the client still knows.
    engine.tickEvents.push(evCreak(`${this.def.id}-${Math.round(now)}`, now, this.event.leftMs ?? 0, [x0, y0, z0], b, cells.length));
  }

  /** The fall: every part to the structural system, in the site's order (a roof before the tower that lands on it). */
  _fall() {
    const world = this.world, now = this.system.now;
    this.fallAt = now;
    this.jobs = [];
    if (world) {
      const get = (x, y, z) => world.getBlock(x, y, z);
      const taken = new Set();
      for (const part of this.site.parts) {
        const cells = radarPartCells(get, part, isSolidBlock, taken);
        if (!cells.length) continue;
        this.cells += cells.length / 4;
        const t = part.topple;
        this.jobs.push(this.system.edits.enqueue({ id: `${this.def.id}-${part.id}`, instance: this.event, cells: cells.map((v, i) => (i % 4 === 3 ? AIR : v)),
          mode: 'fall', by: this.event.by, origin: t ? [...t.hinge] : null, chunkCap: part.chunkCap ?? null,
          topple: t ? { hinge: [...t.hinge], dir: [...t.dir], minRise: t.minRise } : null }));
      }
    }
    this.event.setPhase('done', { reason: 'toppled', data: { cells: this.cells } });
  }

  // --------------------------------------------------------------- bots --

  /**
   * Bots (server/bot-map-events.js): a side never shoots a radar it owns. An
   * enemy radar it demolishes once that swept `sweptHulls` of its hulls
   * within `sweptWindowMs`. Its own radar (the side held it last) only as a
   * denial: its flag neutral or enemy for `denyAfterMs` and an enemy ground
   * hull in the ground ring (the other side is about to use it). The task is
   * a `shoot` order at the structure (any bot with an RX-8 within 25-120 m
   * and a line fires) and `squad` Engineers booked to close in to
   * `approachM`. The commander weighs a flag with a standing radar higher
   * (bot-commander.js eventFlagWeights, `flagWeightM`).
   */
  botTasks(team) {
    if (!this.online || !TEAMS.includes(team) || this.owner === team) return [];
    const b = this.T.bots, now = this.system.now;
    let go;
    if (this.lastOwner === team) {
      go = now - (this.notOursSince[team] ?? now) >= b.denyAfterMs && this._enemyGroundHull(team);
    } else {
      const swept = this.swept.filter(s => s.team === team && now - s.at <= b.sweptWindowMs).reduce((n, s) => n + s.n, 0);
      go = !!this.owner && swept >= b.sweptHulls;
    }
    if (!go) return [];
    const aim = this.aimPoint();
    return [
      { id: 'shoot', kind: 'shoot', point: aim, priority: b.priority, squad: 0, minRange: b.minRange, range: b.range, hitWithin: 6, projectiles: ['rocket'] },
      this.areaTask('demolish', aim, { kind: 'attack', radius: b.approachM, priority: b.priority, squad: b.squad, kits: b.kits }),
    ];
  }

  /** An enemy ground hull of `team` (crewed) in the radar's ground ring. */
  _enemyGroundHull(team) {
    const flag = this.flag(), enemy = rival(team);
    if (!flag) return false;
    for (const v of this.engine?.vehicles?.vehicles?.values?.() ?? []) {
      if (!(v.hp > 0) || isAircraftType(v.type) || isDroneType(v.type) || this.hullSide(v) !== enemy) continue;
      if (Math.hypot(v.x - flag.x, v.z - flag.z) <= this.T.groundM) return true;
    }
    return false;
  }

  /** Where shooters aim: the middle of the first integrity part's first box, a third of the way up. */
  aimPoint() {
    const b = this.site.parts.find(p => p.integrity !== false).boxes[0];
    return { x: (b.x0 + b.x1 + 1) / 2, y: b.y0 + (b.y1 + 1 - b.y0) / 3, z: (b.z0 + b.z1 + 1) / 2 };
  }
}

/** The controller of every radar id (the server registry spreads it into its radar slot). */
export const RADAR_CONTROLLERS = Object.freeze({
  'radar-aldric': RadarController, 'radar-ridge': RadarController, 'radar-mesa': RadarController, 'radar-palmera': RadarController,
});
