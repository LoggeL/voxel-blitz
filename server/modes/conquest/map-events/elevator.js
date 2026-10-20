// Kestrel Halt grain elevator topple (docs/conquest.md "Kestrel Halt grain
// elevator"; data and geometry in shared/map-events/elevator.js).
//
//   idle     the base takes blast damage (a 'damaged' note at half); either
//            side may hold PLANT CHARGE in the bay
//   armed    a planted charge: the fuse runs `armedMs`, the other side may
//            hold DEFUSE CHARGE (back to idle, the bay closed to a new plant
//            for `replantMs`); a director-queued trigger also waits here
//   warning  integrity 0 (the last blast or the charge): the timber creaks,
//            bots clear the fall line (an avoid zone from now on)
//   active   the tower is brought down through the structural system as a
//            topple over its east foundation edge (StagedEdits `fall` with
//            `topple`), the crush line fires as the chunks land, a staged
//            rubble pile lies along the fall line across the a-c road
//   done     the stump, the rubble cover; once per round
//
// A rematch restores the world; reset() then starts the event over. Joiners
// get the phase from `ev` and the fallen blocks through the map cache.
import { MAP_EVENT_RULES } from '../../../../shared/conquest-map-events.js';
import { STRUCTURE_RULES } from '../../../../shared/structure.js';
import {
  KESTREL_ELEVATOR, elevatorFallZone, elevatorStanding, elevatorTowerCells, planElevatorRubble,
} from '../../../../shared/map-events/elevator.js';
import { isSolidBlock, TIMBER } from '../../../../shared/world/blocks.js';
import { MapEventController } from './controller.js';

/** Milliseconds between the idle checks that the tower still stands and the bay may take a plant again. */
const CHECK_MS = 500;

export class ElevatorController extends MapEventController {
  get tower() { return KESTREL_ELEVATOR; }
  get world() { return this.system.engine?.world ?? null; }
  get getBlock() { const w = this.world; return (x, y, z) => w.getBlock(x, y, z); }

  onReset() {
    this.active = this._detect();
    this.damagedNoted = false;
    this.replantAt = 0;
    this.fallAt = null;      // engine ms the tower is released (creak over), set when it goes active
    this.crushDone = false;
    this.rubbleJob = null;
    this.cells = 0;
    this.zone = null;
    this.checkAt = 0;
    if (!this.active) {
      for (const id of ['plant', 'defuse']) this.system.points.enable(this.event, id, false);
      const base = this.target('base');
      if (base) base.enabled = false;
    }
  }

  /** Only a world with the timber bin standing on its foundation takes part (Frontier; ad-hoc worlds stay inert). */
  _detect() {
    const w = this.world, t = this.tower, b = t.box;
    if (typeof w?.getBlock !== 'function') return false;
    return w.getBlock(b.x0, b.y0 + 6, b.z0) === TIMBER && w.getBlock(b.x1, b.y0 + 10, b.z1) === TIMBER
      && isSolidBlock(w.getBlock(b.x0, t.foundationY, b.z0)) && elevatorStanding(this.getBlock, t);
  }

  get standing() { return this.active && this.event.phase !== 'active' && this.event.phase !== 'done' && elevatorStanding(this.getBlock, this.tower); }

  progress() {
    const base = this.target('base');
    if (this.event.phase === 'warning' || this.event.phase === 'active' || this.event.phase === 'done') return 1;
    return base ? 1 - this.system.targets.share(base) : 0;
  }

  // ------------------------------------------------------------ triggers --

  onTarget(target, hit) {
    if (!this.active || target.id !== 'base') return;
    const ev = this.event;
    if (ev.phase !== 'idle' && ev.phase !== 'armed') return;
    if (hit.destroyed) {
      // The last blow sets it off, whoever planted a charge before.
      if (ev.phase === 'armed' && !ev.queued) this.system.points.enable(ev, 'defuse', false);
      ev.trigger({ team: hit.team, by: hit.by, reason: 'blast' });
      return;
    }
    if (!this.damagedNoted && hit.share <= this.def.tuning.damagedAt) {
      this.damagedNoted = true;
      ev.announce('damaged', { integrity: Math.round(hit.share * 100) });
    }
  }

  onUse(point, entity, team) {
    const ev = this.event;
    if (!this.active || !entity) return;
    if (point.id === 'plant' && ev.phase === 'idle' && this.standing && this.system.now >= this.replantAt) {
      ev.arm({ team, by: entity.id, reason: 'planted' });
    } else if (point.id === 'defuse' && ev.phase === 'armed' && !ev.queued && team !== ev.team) {
      this.replantAt = this.system.now + this.def.tuning.replantMs;
      ev.cancel({ reason: 'defused', by: entity.id, team });
      this.system.award(entity.id, 'defuse');
    }
  }

  /** A fuse ran out: the charge blows the base (integrity 0) and the event goes off through the director. */
  onTimer(phase) {
    const ev = this.event;
    if (phase !== 'armed' || ev.queued) return false;
    const base = this.target('base');
    if (base && !base.destroyed) { base.damage = base.integrity; base.destroyed = true; }
    if (!ev.trigger({ team: ev.team, by: ev.by, reason: 'charge' })) ev.cancel({ reason: 'cancelled' });
    return true;
  }

  onPhase(phase) {
    const ev = this.event, now = this.system.now;
    const fuse = phase === 'armed' && !ev.queued;
    this.system.points.enable(ev, 'plant', this.active && phase === 'idle' && now >= this.replantAt);
    this.system.points.enable(ev, 'defuse', this.active && fuse);
    if (!this.active) return;
    if (phase === 'warning') {
      const base = this.target('base');
      if (base) { base.damage = base.integrity; base.destroyed = true; }
      // Bots keep out of the footprint and the fall line from the creak on; it fires once, as the chunks land.
      this.zone = this.system.hazards.add(ev, { kind: 'crush', ...elevatorFallZone(this.tower), by: ev.by, warnFrom: now,
        from: now + (ev.leftMs ?? 0) + (STRUCTURE_RULES.creakMs ?? 450) + this.def.tuning.crushDelayMs,
        damage: this.def.tuning.crush.damage, hullFraction: this.def.tuning.crush.hullFraction });
    } else if (phase === 'active') this._fall(now);
  }

  /** The topple: every block of the tower to the structural system, the crush line and the rubble pile on its timers. */
  _fall(now) {
    const ev = this.event, t = this.tower, tuning = this.def.tuning;
    const structure = this.system.engine?.structure;
    const creakMs = structure?.active ? (structure.rules?.creakMs ?? STRUCTURE_RULES.creakMs) : 0;
    const cells = elevatorTowerCells(this.getBlock, t);
    this.cells = cells.length / 4;
    this.fallAt = now + creakMs;
    this.system.edits.enqueue({ id: 'elevator-fall', instance: ev, cells, mode: 'fall', by: ev.by, origin: [t.hinge.x, t.hinge.y, t.hinge.z],
      chunkCap: tuning.chunkCap, topple: { hinge: [t.hinge.x, t.hinge.y, t.hinge.z], dir: [...t.dir], minRise: t.minRise } });
    if (this.zone) this.zone.from = this.fallAt + tuning.crushDelayMs;
    if (ev.by) this.system.award(ev.by, 'trigger');
    ev.announce('falling', { blocks: this.cells, dir: 'E' });
  }

  onTick(now) {
    const ev = this.event;
    if (!this.active) return;
    if (ev.phase === 'idle') {
      if (now < this.checkAt) return;
      this.checkAt = now + CHECK_MS;
      // A tower that came down by itself (cut through, not toppled) is spent: no plant, no fall.
      if (!elevatorStanding(this.getBlock, this.tower)) { ev.setPhase('done', { reason: 'collapsed' }); return; }
      // The bay opens for a new plant once the defuse lock is over.
      const plant = this.point('plant');
      if (plant && !plant.enabled && now >= this.replantAt) this.system.points.enable(ev, 'plant', true);
      return;
    }
    if (ev.phase !== 'active' || this.rubbleJob || !Number.isFinite(this.fallAt)) return;
    if (now < this.fallAt + this.def.tuning.rubbleDelayMs) return;
    const structure = this.system.engine?.structure;
    const cells = planElevatorRubble(this.getBlock);
    const keep = [];
    for (let i = 0; i < cells.length; i += 4) {
      // Rubble never fills a body or a hull that lived through the crush.
      if (structure?.occupied?.(cells[i], cells[i + 1], cells[i + 2])) continue;
      keep.push(cells[i], cells[i + 1], cells[i + 2], cells[i + 3]);
    }
    this.rubbleJob = this.system.edits.enqueue({ id: 'elevator-rubble', instance: ev, cells: keep, mode: 'set', by: ev.by, authored: true,
      budget: Math.min(this.def.tuning.rubbleCellsPerTick, MAP_EVENT_RULES.edits.cellsPerTick) });
  }

  // ---------------------------------------------------------------- bots --

  /** The side that brings the elevator down: the one that does not hold its flag (EAST while nobody does). */
  planTeam() {
    const owner = (this.system.policy?.flags ?? []).find(f => f.id === this.def.flag)?.owner ?? null;
    return owner === 'alpha' ? 'bravo' : owner === 'bravo' ? 'alpha' : 'bravo';
  }

  botTasks(team) {
    const ev = this.event, bots = this.def.tuning.bots;
    if (!this.active) return [];
    if (ev.phase === 'idle') {
      if (team !== this.planTeam() || !this.standing) return [];
      const task = this.useTask('plant', team, { priority: bots.plantPriority, squad: bots.plantSquad, range: bots.range });
      return task ? [task] : [];
    }
    if (ev.phase !== 'armed' || ev.queued) return [];
    const p = this.point('defuse');
    if (team === ev.team) return [this.areaTask('guard', p, { kind: 'hold', radius: bots.guardRadius, priority: bots.guardPriority, squad: bots.guardSquad, range: bots.range })];
    const defuse = this.useTask('defuse', team, { priority: bots.defusePriority, squad: bots.defuseSquad, range: bots.range + 40 });
    return [defuse, this.areaTask('escort', p, { kind: 'attack', radius: bots.guardRadius, priority: bots.defusePriority - 1, squad: bots.escortSquad, range: bots.range })]
      .filter(Boolean);
  }
}
