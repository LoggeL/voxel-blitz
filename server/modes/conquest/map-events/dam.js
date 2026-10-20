// Redrock Dam breach, the server half (docs/conquest.md "Redrock Dam breach";
// definition and tuning in shared/map-events/dam.js, the voxel plan in
// ./dam-plan.js).
//
//   idle    both charge spots in the gallery open to planting (5 s hold;
//           Breakthrough: the attackers only, while flag C's sector is active)
//   armed   one charge set (open, reason 'one'): the planters may set the
//           other, the rival team defuses (5 s); both set (reason 'fuse'):
//           the 40 s fuse runs, a defuse stops it (reason 'defused'), the
//           last defuse calls the event off (idle, 'defused')
//   warning the fuse ran out: 10 s siren; the crest closes for bot drivers,
//           bots clear the crest, the gallery and the canyon floor
//   active  the breach: the crest middle falls through the structural system
//           (crush on what stands on it), the gallery floods (lethal), the
//           flood timeline drains the reservoir over 45 s while the wave
//           front runs down the canyon (push, damage, light hulls shoved)
//           and floods it 2 m higher; the wash ford closes once it passes
//   done    the timeline applied and the wave out: the gap, the dry lake
//           bed and the flooded canyon stay for the round
//
// Every voxel change is a StagedEdits job (block deltas; a joiner gets them
// through the map cache). `ev[i][5]` = [chargeMask, drain100, frontZ].
import { isAircraft, vehicleMaxHp } from '../../../../shared/vehicles.js';
import { damChargeIndex } from '../../../../shared/map-events/dam.js';
import { REDROCK_DAM } from '../../../../shared/world/redrock-terrain.js';
import { MapEventController } from './controller.js';
import { damPlan } from './dam-plan.js';

const TEAMS = ['alpha', 'bravo'];
const other = team => (team === 'alpha' ? 'bravo' : team === 'bravo' ? 'alpha' : null);
/** Flood timeline cells handed to StagedEdits per job (one job every tick at most). */
const SLICE_MAX = 400;

export class DamController extends MapEventController {
  /** Boot warm-up (server/boot-warmup.js): build the template's voxel plan before a room needs it. */
  static prepare(world, def) { return damPlan(world, def.tuning); }

  get tuning() { return this.def.tuning; }

  onReset() {
    const world = this.system.engine?.world;
    this.plan = world ? damPlan(world, this.tuning) : null;
    this.charges = this.tuning.charges.map(() => null);   // {by, team} per planted charge
    this.breachAt = null;
    this.floodNext = 0;
    this.front = null;
    this.waveZone = null;
    this.closed = new Set();
    this.hullHits = new Map();
    this.cleanupAt = null;
    this.plantRule = null;
    this._syncPlantPoints();
  }

  // ---------------------------------------------------------- charges --

  /** Who may plant now: 'any' (Conquest), the attackers while C's sector is active (Breakthrough), or nobody. */
  _plantTeams() {
    const policy = this.system.policy;
    if (this.system.variant !== 'breakthrough') return 'any';
    const flag = (policy?.flags ?? []).find(f => f.id === this.tuning.breakthrough.flag);
    if (flag && policy?.capture?.locked?.(flag)) return 'none';
    return policy?.attackerTeam ?? 'alpha';
  }

  _syncPlantPoints() {
    const set = this.charges.some(Boolean);
    const rule = this.event.phase === 'idle' ? this._plantTeams() : this.event.phase === 'armed' && set ? 'trigger' : 'none';
    this.plantRule = rule;
    this.tuning.charges.forEach((c, i) => {
      const planted = !!this.charges[i];
      this.system.points.enable(this.event, `plant-${c.id}`, !planted && rule !== 'none', { teams: rule === 'none' ? 'any' : rule });
      this.system.points.enable(this.event, `defuse-${c.id}`, planted && this.event.phase === 'armed', { teams: 'rival' });
    });
  }

  onUse(point, entity, team) {
    const i = damChargeIndex(point.id);
    if (i < 0 || !team) return;
    const ev = this.event;
    if (point.id.startsWith('plant-')) {
      if (this.charges[i] || (ev.phase !== 'idle' && ev.phase !== 'armed') || (ev.team && ev.team !== team)) return;
      this.charges[i] = { by: String(entity?.id ?? ''), team };
      const both = this.charges.every(Boolean);
      // A plant pays nothing until its charge detonates (payDetonation at the breach).
      ev.arm({ team, by: entity?.id ?? null, ms: both ? this.tuning.fuseMs : null, reason: both ? 'fuse' : 'one', data: { charge: i } });
    } else {
      if (!this.charges[i] || ev.phase !== 'armed' || team === ev.team) return;
      this.charges[i] = null;
      this.system.payDefuse(entity?.id);
      if (this.charges.some(Boolean)) ev.setPhase('armed', { ms: null, reason: 'defused', data: { charge: i } });
      else ev.cancel({ reason: 'defused', by: entity?.id ?? null, team });
    }
    this._syncPlantPoints();
  }

  // ----------------------------------------------------------- phases --

  onPhase(phase) {
    const now = this.system.now;
    if (phase === 'idle') { this.charges = this.charges.map(() => null); this._syncPlantPoints(); return; }
    if (phase === 'armed') { this._syncPlantPoints(); return; }
    if (phase === 'warning') {
      this._syncPlantPoints();
      this.closed.add(this.tuning.closes.crest);
      this._openAvoidZones(now);
      return;
    }
    if (phase === 'active') this._breach(now);
  }

  /** From the siren on: bots keep off the crest gap, out of the gallery and off the canyon floor. */
  _openAvoidZones(now) {
    const t = this.tuning, hz = this.system.hazards, by = this.event.by;
    const end = now + (this.def.durations.warningMs ?? 0) + Math.max(t.drain.ms, this.plan?.flood.endMs ?? 0) + 4000;
    // Avoid-only zones (`from` never comes): the canyon floor through the wave, the crest gap for good.
    hz.add(this.event, { id: 'dam-canyon', kind: 'push', shape: 'box', x0: t.wave.x0, x1: t.wave.x1, z0: t.wave.z0 - 2, z1: t.wave.z1,
      y1: t.zones.canyonY1, from: Infinity, warnFrom: now, until: end, by });
    const g = t.zones.gap;
    hz.add(this.event, { id: 'dam-gap', kind: 'push', shape: 'box', x0: g.x0, x1: g.x1, z0: g.z0, z1: g.z1, y0: g.y0, from: Infinity, warnFrom: now, by });
    const gal = t.gallery;
    this.galleryZone = hz.add(this.event, { id: 'dam-gallery', kind: 'lethal', shape: 'box', x0: gal.x0, x1: gal.x1, z0: gal.z0, z1: gal.z1,
      y0: gal.y0, y1: gal.y1, from: now + (this.def.durations.warningMs ?? 0), until: now + (this.def.durations.warningMs ?? 0) + gal.ms,
      warnFrom: now, graceMs: gal.graceMs, by, killKey: 'damFlood' });
  }

  /** The strike: the crest middle comes down, the flood timeline and the wave start. */
  _breach(now) {
    const t = this.tuning, b = t.breach, by = this.event.by;
    this.breachAt = now;
    this.floodNext = 0;
    this.system.payDetonation(this.charges.map(c => c?.by), by);
    this.closed.add(t.closes.crest);
    if (!this.galleryZone) this._openAvoidZones(now - (this.def.durations.warningMs ?? 0));
    const edits = this.system.edits, plan = this.plan;
    if (plan) {
      edits.enqueue({ id: 'dam-breach', instance: this.event, cells: plan.breachSolids, mode: 'fall', by,
        origin: [(b.x0 + b.x1 + 1) / 2, this.def.anchor?.y ?? 24, (b.z0 + b.z1 + 1) / 2], chunkCap: b.chunkCap });
      if (plan.breachWater.length) edits.enqueue({ id: 'dam-spillway', instance: this.event, cells: plan.breachWater, by });
      // Whatever the structural pass leaves (blocks it counts as ground) goes plainly a few seconds on.
      this.cleanupAt = now + 3000;
    }
    this.system.hazards.add(this.event, { id: 'dam-crush', kind: 'crush', shape: 'box', x0: b.x0, x1: b.x1 + 1, z0: b.z0, z1: b.z1 + 1,
      y0: b.y0, damage: b.crush.damage, hullFraction: b.crush.hullFraction, by, killKey: 'damBreach', avoid: false });
    const w = t.wave;
    this.front = w.z0;
    this.waveZone = this.system.hazards.add(this.event, { id: 'dam-wave', kind: 'push', shape: 'box', x0: w.x0, x1: w.x1, z0: w.z0 - w.length, z1: w.z0,
      y1: w.y1, from: now + w.delayMs, until: now + w.delayMs + (w.z1 - w.z0) / w.speed * 1000, impulse: w.push, up: w.up, damage: w.damage,
      hullPush: 0, hullFraction: 0, by, killKey: 'damFlood', avoid: false });
  }

  // ------------------------------------------------------------- tick --

  onTick(now) {
    const ev = this.event;
    if (ev.phase === 'idle') {
      // Breakthrough: the plant spots follow flag C's sector (checked as it changes).
      if (this._plantTeams() !== this.plantRule) this._syncPlantPoints();
      return;
    }
    if (ev.phase !== 'active' || this.breachAt == null) return;
    const t = this.tuning, plan = this.plan, since = now - this.breachAt;
    if (plan) {
      const { cells, at } = plan.flood;
      const n = at.length;
      let end = this.floodNext;
      while (end < n && at[end] <= since && end - this.floodNext < SLICE_MAX) end++;
      if (end > this.floodNext) {
        this.system.edits.enqueue({ id: `dam-flood-${this.floodNext}`, instance: ev, cells: cells.subarray(this.floodNext * 4, end * 4), by: ev.by });
        this.floodNext = end;
      }
      if (this.cleanupAt != null && now >= this.cleanupAt) {
        this.cleanupAt = null;
        this.system.edits.enqueue({ id: 'dam-breach-rest', instance: ev, cells: plan.breachSolids, by: ev.by });
      }
    }
    // The wave front and its shove zone.
    const w = t.wave;
    const run = since - w.delayMs;
    this.front = run < 0 ? w.z0 : Math.min(w.z1, w.z0 + run / 1000 * w.speed);
    if (this.waveZone) { this.waveZone.z1 = this.front; this.waveZone.z0 = this.front - w.length; }
    if (run >= 0 && this.front < w.z1) this._shoveHulls(now);
    if (this.front >= t.closes.fordZ - 10) this.closed.add(t.closes.ford);
    const flooded = !plan || this.floodNext >= plan.flood.at.length;
    if (flooded && this.front >= w.z1 && this.system.edits.pending === 0) ev.finish();
  }

  /** Light hulls in the wave: shoved downstream and battered (heavy armour rides it out). */
  _shoveHulls(now) {
    const w = this.tuning.wave, zone = this.waveZone, engine = this.system.engine;
    if (!zone || !engine?.vehicles) return;
    const killer = this.event.by ? this.system.entity(this.event.by) : null;
    const killerTeam = killer ? this.system.policy?.teamFor?.(killer) : null;
    for (const hull of engine.vehicles.vehicles?.values?.() ?? []) {
      if (!(hull.hp > 0) || !w.lightHulls.includes(hull.type) || (isAircraft(hull.type) && !hull.grounded)) continue;
      if (hull.x < zone.x0 || hull.x > zone.x1 || hull.z < zone.z0 || hull.z > zone.z1 + 1 || hull.y > zone.y1) continue;
      const id = String(hull.id);
      if (now - (this.hullHits.get(id) ?? -Infinity) < 1000) continue;
      this.hullHits.set(id, now);
      hull.vz = (hull.vz ?? 0) + w.hullPush;
      const friendly = killerTeam && hull.team === killerTeam;
      if (!friendly) engine.vehicles.damage(hull.id, (vehicleMaxHp(hull.type) || hull.maxHp || 0) * w.hullFraction, killer,
        { cls: 'collision', point: [hull.x, hull.y + 1, hull.z] });
    }
  }

  onTimer(phase) {
    // The breach phase ends when the flood is applied (onTick), not on a timer.
    return phase === 'active';
  }

  // ------------------------------------------------------------- wire --

  progress() {
    const ev = this.event;
    if (ev.phase === 'armed' && Number.isFinite(ev.endsAt)) return 1 - ev.leftMs / this.tuning.fuseMs;
    if (ev.phase === 'active') return this.drainShare();
    if (ev.phase === 'done') return 1;
    return 0;
  }

  /** 0..1 of the flood timeline applied. */
  drainShare() {
    const n = this.plan?.flood.at.length ?? 0;
    return n ? Math.min(1, this.floodNext / n) : (this.event.phase === 'done' ? 1 : 0);
  }

  wireExtra() {
    const mask = this.charges.reduce((m, c, i) => m | (c ? 1 << i : 0), 0);
    const phase = this.event.phase;
    if (phase === 'idle' && !mask) return null;
    const front = phase === 'active' && this.front != null ? Math.round(this.front) : 0;
    return [mask, Math.round(this.drainShare() * 100), front];
  }

  closedCrossings() { return this.closed.size ? this.closed : null; }

  // ------------------------------------------------------------- bots --

  /**
   * Plant when the breach pays off (the enemy holds C or enemy armour works
   * the crest), finish a half-set pair, guard a running fuse; defuse what the
   * enemy planted, with an escort. Fleeing is the hazard zones' job.
   */
  botTasks(team) {
    const ev = this.event, b = this.tuning.bots, out = [];
    const anchor = this.def.anchor;
    if (ev.phase === 'idle') {
      if (!this._worthBreaching(team)) return out;
      for (const c of this.tuning.charges) {
        const task = this.useTask(`plant-${c.id}`, team, { priority: b.plantPriority, squad: b.plantSquad, range: b.range });
        if (task) out.push(task);
      }
      return out;
    }
    if (ev.phase !== 'armed') return out;
    if (team === ev.team) {
      for (const c of this.tuning.charges) {
        const task = this.useTask(`plant-${c.id}`, team, { priority: b.plantPriority + 1, squad: b.plantSquad, range: b.range });
        if (task) out.push(task);
      }
      out.push(this.areaTask('guard', anchor, { kind: 'hold', radius: b.guardRadius, priority: b.plantPriority, squad: b.guardSquad, range: b.range }));
      return out;
    }
    const fuse = Number.isFinite(ev.endsAt);
    for (const c of this.tuning.charges) {
      const task = this.useTask(`defuse-${c.id}`, team, { priority: fuse ? b.defusePriority : b.defusePriority - 2, squad: b.defuseSquad, range: b.range });
      if (task) out.push(task);
    }
    if (out.length) out.push(this.areaTask('escort', anchor, { kind: 'attack', radius: b.guardRadius, priority: b.defusePriority - 1, squad: b.escortSquad, range: b.range }));
    return out;
  }

  /** The enemy holds flag C, or an enemy ground hull works the crest road. */
  _worthBreaching(team) {
    const policy = this.system.policy, enemy = other(team);
    if (!TEAMS.includes(team)) return false;
    const flag = (policy?.flags ?? []).find(f => f.id === this.def.flag);
    if (flag?.owner === enemy) return true;
    const pad = this.tuning.bots.armourPad, { x0, x1, z0, z1 } = REDROCK_DAM;
    for (const hull of this.system.engine?.vehicles?.vehicles?.values?.() ?? []) {
      if (!(hull.hp > 0) || hull.team !== enemy || isAircraft(hull.type)) continue;
      if (hull.x >= x0 - pad && hull.x <= x1 + pad && hull.z >= z0 - 6 && hull.z <= z1 + 6 && hull.y >= REDROCK_DAM.crestY - 2) return true;
    }
    return false;
  }
}
