// Redrock Dam breach, the server half (docs/conquest.md "Redrock Dam breach";
// definition and tuning in shared/map-events/dam.js, the plan and the flood
// field in ./dam-plan.js and shared/world/flood-field.js).
//
//   idle    both charge spots in the gallery open to planting (4 s hold;
//           Breakthrough: the attackers only, while flag C's sector is
//           active); the spillway's integrity pool takes every blast
//   armed   one charge set (reason 'one'): its 35 s fuse runs, the planters
//           may set the other, which cuts what is left to 12 s ('fuse'); the
//           rival team defuses (5 s): one of two leaves the fuse running
//           ('defused'), the last calls the event off (idle, 'defused')
//   warning the fuse ran out (10 s siren) or the spillway's pool reached 0
//           (4 s, 'spillway'): the crest closes for bot drivers, bots clear
//           the crest gap, the gallery and the canyon floor ahead of the water
//   active  the breach: the crest middle falls through the structural system
//           (crush on what stands on it), the gallery floods (lethal) and the
//           flood field starts (world.flood): the basin falls, the wave runs
//           down the canyon carrying and battering what stands in it,
//           credited to the breacher; voxels change only where the water has
//           settled (one tile job at a time); the wash ford closes once the
//           water reaches it
//   done    the field has settled and every commit is applied: the gap, the
//           lowered basin and the 2 m deeper canyon stay for the round
//
// `ev[i][5]` = [chargeMask] while armed, [chargeMask, sinceDs] while active
// (the clients evaluate the field at sinceDs), nothing once done (settled).
import { isAircraft, vehicleMaxHp } from '../../../../shared/vehicles.js';
import { WADE_RULES } from '../../../../shared/vehicle-defs.js';
import { damChargeIndex } from '../../../../shared/map-events/dam.js';
import { floodSet } from '../../../../shared/world/flood-field.js';
import { boxCollides } from '../../../../shared/player-movement.js';
import { REDROCK_DAM } from '../../../../shared/world/redrock-terrain.js';
import { markLaunched } from '../../../sim/player.js';
import { AIR, FLUID_BLOCKS } from '../../../../shared/world/blocks.js';
import { MapEventController } from './controller.js';
import { damPlan } from './dam-plan.js';
import { crossingDenialLocal } from './dam-bots.js';

const TEAMS = ['alpha', 'bravo'];
const FIELD_ID = 'dam';

export class DamController extends MapEventController {
  /** Boot warm-up (server/boot-warmup.js): build the template's plan and field before a room needs it. */
  static prepare(world, def) { return damPlan(world, def.tuning); }

  get tuning() { return this.def.tuning; }
  get world() { return this.system.engine?.world ?? null; }

  onReset() {
    const world = this.world;
    this.plan = world ? damPlan(world, this.tuning) : null;
    if (world) floodSet(world).remove(FIELD_ID);
    this.charges = this.tuning.charges.map(() => null);   // {by, team} per planted charge
    this.breachAt = null;
    this.cause = null;           // 'charges' | 'spillway'
    this.commitNext = 0;
    this.commitAt = 0;
    this.closed = new Set();
    this.galleryZone = null;
    this.waterZone = null;
    this.pulses = new Map();     // body id -> {hurt, knockAt}
    this.carry = 0;
    this.denial = { alpha: { at: -Infinity, value: 0 }, bravo: { at: -Infinity, value: 0 } };
    this.cleanupAt = null;
    this.plantRule = null;
    this.spillway = this.target(this.tuning.spillway.id);
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
    const set = this.charges.some(Boolean), phase = this.event.phase;
    const rule = phase === 'idle' ? this._plantTeams() : phase === 'armed' && set ? 'trigger' : 'none';
    this.plantRule = rule;
    this.tuning.charges.forEach((c, i) => {
      const planted = !!this.charges[i];
      this.system.points.enable(this.event, `plant-${c.id}`, !planted && rule !== 'none', { teams: rule === 'none' ? 'any' : rule });
      this.system.points.enable(this.event, `defuse-${c.id}`, planted && phase === 'armed', { teams: 'rival' });
    });
    // The spillway takes blasts while the dam stands (in Breakthrough only while C's sector is the active one).
    if (this.spillway) this.spillway.enabled = (phase === 'idle' || phase === 'armed') && this._plantTeams() !== 'none';
  }

  onUse(point, entity, team) {
    const i = damChargeIndex(point.id);
    if (i < 0 || !team) return;
    const ev = this.event, f = this.tuning.fuse;
    if (point.id.startsWith('plant-')) {
      if (this.charges[i] || (ev.phase !== 'idle' && ev.phase !== 'armed') || (ev.phase === 'armed' && ev.team !== team)) return;
      this.charges[i] = { by: String(entity?.id ?? ''), team };
      const both = this.charges.every(Boolean);
      // A plant pays nothing until its charge detonates (payDetonation at the breach).
      if (ev.phase === 'idle') ev.arm({ team, by: entity?.id ?? null, ms: both ? f.bothMs : f.oneMs, reason: both ? 'fuse' : 'one', data: { charge: i } });
      else ev.setPhase('armed', { ms: both ? Math.min(ev.leftMs ?? f.oneMs, f.bothMs) : ev.leftMs ?? f.oneMs, reason: both ? 'fuse' : 'one', data: { charge: i } });
    } else {
      if (!this.charges[i] || ev.phase !== 'armed' || team === ev.team) return;
      this.charges[i] = null;
      this.system.payDefuse(entity?.id);
      // One of two defused: the other's fuse keeps running.
      if (this.charges.some(Boolean)) ev.setPhase('armed', { ms: ev.leftMs ?? f.oneMs, reason: 'defused', data: { charge: i } });
      else ev.cancel({ reason: 'defused', by: entity?.id ?? null, team });
    }
    this._syncPlantPoints();
  }

  /** The spillway's pool reached 0: the dam goes (a shorter siren), the final blow credited. */
  onTarget(target, hit) {
    if (target !== this.spillway || !hit.destroyed) return;
    const ev = this.event;
    if (ev.phase !== 'idle' && ev.phase !== 'armed') return;
    this.cause = 'spillway';
    ev.trigger({ team: hit.team, by: hit.by, warningMs: this.tuning.spillway.warningMs, reason: 'spillway' });
  }

  // ----------------------------------------------------------- phases --

  onPhase(phase) {
    const now = this.system.now;
    if (phase === 'idle') { this.charges = this.charges.map(() => null); this._syncPlantPoints(); return; }
    if (phase === 'armed') { this._syncPlantPoints(); return; }
    if (phase === 'warning') {
      this.cause ??= 'charges';
      this._syncPlantPoints();
      this.closed.add(this.tuning.closes.crest);
      this._openAvoidZones(now, this.event.leftMs ?? 0);
      return;
    }
    if (phase === 'active') this._breach(now);
  }

  /**
   * From the siren on: bots keep off the crest gap and out of the gallery,
   * and leave each canyon segment `fleeLeadS` before the water reaches it
   * (the field's arrival), until it has settled into deep water.
   */
  _openAvoidZones(now, warnMs) {
    const t = this.tuning, hz = this.system.hazards, by = this.event.by, z = t.zones;
    const start = now + warnMs, field = this.plan?.field;
    const g = z.gap;
    hz.add(this.event, { id: 'dam-gap', kind: 'push', shape: 'box', x0: g.x0, x1: g.x1, z0: g.z0, z1: g.z1, y0: g.y0, from: Infinity, warnFrom: now, by });
    if (field) {
      for (let i = 1; i < z.segments.length; i++) {
        const z0 = z.segments[i - 1], z1 = z.segments[i];
        const arrive = field.run.arrival[field.row(z0)];
        if (!Number.isFinite(arrive)) continue;
        let settle = 0;
        for (let zz = z0; zz < z1; zz += field.dz) settle = Math.max(settle, field.run.settleS[field.row(zz)]);
        hz.add(this.event, { id: `dam-canyon-${i}`, kind: 'push', shape: 'box', x0: z.x0, x1: z.x1, z0, z1, y1: z.canyonY1, from: Infinity,
          warnFrom: Math.min(now, start + (arrive - z.fleeLeadS) * 1000), until: start + (settle + 5) * 1000, by });
      }
    }
    const gal = t.gallery;
    this.galleryZone = hz.add(this.event, { id: 'dam-gallery', kind: 'lethal', shape: 'box', x0: gal.x0, x1: gal.x1, z0: gal.z0, z1: gal.z1,
      y0: gal.y0, y1: gal.y1, from: start, until: start + gal.ms, warnFrom: now, graceMs: gal.graceMs, by, killKey: 'damFlood' });
  }

  /** The strike: the crest middle comes down, the flood field starts. */
  _breach(now) {
    const t = this.tuning, b = t.breach, by = this.event.by;
    this.breachAt = now;
    this.commitNext = 0;
    this.commitAt = now;
    // Results only: the fuse's planters, or the spillway's final blow and its assists.
    if (this.cause === 'spillway') this.system.payDestroyed(this.spillway, by);
    else this.system.payDetonation(this.charges.map(c => c?.by), by);
    if (this.spillway) { this.spillway.enabled = false; this.spillway.destroyed = true; }
    this.closed.add(t.closes.crest);
    if (!this.galleryZone) this._openAvoidZones(now, 0);
    const edits = this.system.edits, plan = this.plan;
    if (plan) {
      edits.enqueue({ id: 'dam-breach', instance: this.event, cells: plan.breachSolids, mode: 'fall', by,
        origin: [(b.x0 + b.x1 + 1) / 2, this.def.anchor?.y ?? 24, (b.z0 + b.z1 + 1) / 2], chunkCap: b.chunkCap });
      if (plan.breachWater.length) edits.enqueue({ id: 'dam-spillway', instance: this.event, cells: plan.breachWater, by });
      // Whatever the structural pass leaves (blocks it counts as ground) goes plainly a few seconds on.
      this.cleanupAt = now + 3000;
      // Drowning in the flood is the flood's kill (credited like its battering).
      if (this.world) floodSet(this.world).add(FIELD_ID, plan.field, now,
        { drown: (p, amount) => !!this.waterZone && this.system.hazards._hurt(this.waterZone, p, amount) });
    }
    this.system.hazards.add(this.event, { id: 'dam-crush', kind: 'crush', shape: 'box', x0: b.x0, x1: b.x1 + 1, z0: b.z0, z1: b.z1 + 1,
      y0: b.y0, damage: b.crush.damage, hullFraction: b.crush.hullFraction, by, killKey: 'damBreach', avoid: false });
    // The water's own credit: no team spared, kills go to the breacher (a teammate is hurt uncredited).
    this.waterZone = { by: by == null ? null : String(by), killKey: 'damFlood', spareTeam: false };
  }

  /** Seconds of field time now (the breach's start), or null before it. */
  /**
   * A settled tile's commit against the live world: the plan was made from the
   * template, so a cell the round has built since (the trestle's rubble berm, a
   * wreck) keeps its block, and only water drains and only air floods.
   */
  _live(cells) {
    const world = this.world;
    if (!world) return cells;
    const out = [];
    for (let i = 0; i < cells.length; i += 4) {
      const b = world.getBlock(cells[i], cells[i + 1], cells[i + 2]);
      if (cells[i + 3] === AIR ? FLUID_BLOCKS.has(b) : b === AIR) out.push(cells[i], cells[i + 1], cells[i + 2], cells[i + 3]);
    }
    return Int32Array.from(out);
  }

  since(now = this.system.now) { return this.breachAt == null ? null : Math.max(0, (now - this.breachAt) / 1000); }

  // ------------------------------------------------------------- tick --

  onTick(now, dt) {
    const ev = this.event;
    if (ev.phase === 'idle') {
      // Breakthrough: the plant spots follow flag C's sector (checked as it changes).
      if (this._plantTeams() !== this.plantRule) this._syncPlantPoints();
      return;
    }
    if (this.breachAt == null || !this.plan) return;
    if (this.world) floodSet(this.world).nowMs = now;
    if (ev.phase !== 'active') return;
    const t = this.tuning, plan = this.plan, since = this.since(now), field = plan.field;
    if (this.cleanupAt != null && now >= this.cleanupAt) {
      this.cleanupAt = null;
      this.system.edits.enqueue({ id: 'dam-breach-rest', instance: ev, cells: plan.breachSolids, by: ev.by });
    }
    // Settled tiles only, at most tilesPerS jobs a second.
    const gapMs = 1000 / t.commit.tilesPerS;
    while (this.commitNext < plan.commits.length && plan.commits[this.commitNext].t <= since && now >= this.commitAt) {
      const job = plan.commits[this.commitNext++];
      this.system.edits.enqueue({ id: `dam-commit-${this.commitNext}`, instance: ev, cells: this._live(job.cells), by: ev.by });
      this.commitAt = Math.max(this.commitAt, now - gapMs) + gapMs;
    }
    if (field.arrival(384, t.closes.fordZ) <= since) this.closed.add(t.closes.ford);
    this._water(now, dt, since);
    if (since >= field.endS && this.commitNext >= plan.commits.length && this.system.edits.pending === 0) ev.finish();
  }

  /**
   * The moving water on bodies and hulls (one pass a tick, server
   * authoritative): drift with the flow, damage and knockdown by depth x
   * speed^2, light hulls carried, a hull pinned to a wall battered.
   */
  _water(now, dtMs, since) {
    const engine = this.system.engine, field = this.plan.field, ph = this.tuning.physics;
    if (!engine || since >= field.endS) return;
    const dt = Math.min(0.1, (dtMs ?? 0) / 1000), b = field.bounds;
    this.carry += dtMs ?? 0;
    const pulse = this.carry >= ph.tickMs, pulseS = this.carry / 1000;
    if (pulse) this.carry = 0;
    const flow = { x: 0, z: 0 };
    for (const p of engine.combatants?.values?.() ?? []) {
      if (p.state !== 'alive' || p.vehicleId || p.objective) continue;
      if (p.x < b.x0 || p.x >= b.x1 + 1 || p.z < b.z0 || p.z >= b.z1 + 1) continue;
      const lv = field.level(p.x, p.z, since), depth = lv - p.y;
      if (!(depth >= ph.minDepth)) continue;
      field.velocity(p.x, p.z, since, flow);
      const speed = Math.hypot(flow.x, flow.z);
      if (speed > 0.05 && dt > 0) {
        const share = ph.carry * Math.min(1, depth / ph.carryDepth);
        const nx = p.x + flow.x * share * dt, nz = p.z + flow.z * share * dt;
        // The water lifts a body over a one-block step (rubble, a bank ledge) it is pushed into.
        const step = (x, z) => {
          if (!boxCollides(engine.solidAt, x, p.y, z)) return true;
          if (depth < 1.5 || boxCollides(engine.solidAt, x, p.y + 1.05, z)) return false;
          p.y += 1.05;
          return true;
        };
        if (step(nx, p.z)) p.x = nx;
        if (step(p.x, nz)) p.z = nz;
      }
      const power = Math.min(2, depth) * speed * speed, id = String(p.id);
      let state = this.pulses.get(id);
      if (!state) this.pulses.set(id, state = { knockAt: -Infinity });
      if (power >= ph.knock.power && now - state.knockAt >= ph.knock.cooldownMs) {
        state.knockAt = now;
        p.vx = (p.vx ?? 0) + flow.x * 0.5; p.vz = (p.vz ?? 0) + flow.z * 0.5; p.vy = Math.max(p.vy ?? 0, ph.knock.up);
        markLaunched(p);
      }
      if (pulse && power >= ph.damage.min && this.waterZone) {
        this.system.hazards._hurt(this.waterZone, p, Math.min(ph.damage.maxDps, ph.damage.k * power) * pulseS);
      }
    }
    const vehicles = engine.vehicles;
    for (const hull of vehicles?.vehicles?.values?.() ?? []) {
      if (!(hull.hp > 0) || isAircraft(hull.type) || !ph.hull.types.includes(hull.type)) continue;
      if (hull.x < b.x0 || hull.x >= b.x1 + 1 || hull.z < b.z0 || hull.z >= b.z1 + 1) continue;
      const depth = field.level(hull.x, hull.z, since) - hull.y;
      if (!(depth > (WADE_RULES.depth[hull.type] ?? ph.hull.depth))) continue;
      field.velocity(hull.x, hull.z, since, flow);
      const speed = Math.hypot(flow.x, flow.z);
      if (speed < ph.hull.minFlow) continue;
      const moved = dt > 0 && vehicles.drift?.(hull, flow.x * ph.hull.carry * dt, flow.z * ph.hull.carry * dt);
      if (!moved && pulse) {
        const killer = this.waterZone?.by ? this.system.entity(this.waterZone.by) : null;
        const friendly = killer && hull.team && this.system.policy?.teamFor?.(killer) === hull.team;
        vehicles.damage(hull.id, (vehicleMaxHp(hull.type) || hull.maxHp || 0) * ph.hull.wallFraction * pulseS, friendly ? null : killer,
          { cls: 'collision', point: [hull.x, hull.y + 1, hull.z] });
      }
    }
  }

  onTimer(phase) {
    // The breach phase ends once the field has settled (onTick), not on a timer.
    return phase === 'active';
  }

  // ------------------------------------------------------------- wire --

  progress() {
    const ev = this.event;
    if (ev.phase === 'armed' && Number.isFinite(ev.endsAt)) return 1 - ev.leftMs / this.tuning.fuse.oneMs;
    if (ev.phase === 'active') return Math.min(1, (this.since() ?? 0) / (this.plan?.field.endS ?? 1));
    if (ev.phase === 'done') return 1;
    // Idle: the spillway's wear rides the wire (the HUD shows a damaged dam).
    return this.spillway ? 1 - this.system.targets.share(this.spillway) : 0;
  }

  wireExtra() {
    const mask = this.charges.reduce((m, c, i) => m | (c ? 1 << i : 0), 0);
    const phase = this.event.phase;
    if (phase === 'active') return [mask, Math.round((this.since() ?? 0) * 10)];
    if (phase === 'done' || !mask) return null;
    return [mask];
  }

  closedCrossings() { return this.closed.size ? this.closed : null; }

  // ------------------------------------------------------------- bots --

  /** The breach's road value for `team` (crossing denial of the crest and the wash ford, cached). */
  denialValue(team) {
    const cache = this.denial[team], now = this.system.now, v = this.tuning.bots.value;
    if (!cache) return 0;
    if (now - cache.at < v.cacheMs) return cache.value;
    cache.at = now;
    const c = this.tuning.closes;
    cache.value = crossingDenialLocal(this.system.engine, team, [c.crest, c.ford], { capM: v.capM });
    return cache.value;
  }

  /**
   * Plant (one bot and one escort) or fire on the spillway while breaching
   * pays the side (denialValue over value.plant), finish the pair and guard a
   * running fuse; defuse an enemy charge (one bot and one escort) while the
   * breach costs the side (under value.defuse). Fleeing is the hazard zones' job.
   */
  botTasks(team) {
    const ev = this.event, b = this.tuning.bots, out = [], anchor = this.def.anchor;
    if (!TEAMS.includes(team)) return out;
    if (ev.phase === 'idle') {
      if (this.denialValue(team) < b.value.plant) return out;
      // The near portal for each side (WEST the west charge); the other stays open to humans.
      const c = this.tuning.charges[team === 'alpha' ? 0 : 1];
      const task = this.useTask(`plant-${c.id}`, team, { priority: b.plantPriority, squad: b.plantSquad, range: b.range });
      if (task) out.push(task, this.areaTask('escort', c, { kind: 'hold', radius: b.guardRadius, priority: b.plantPriority - 1, squad: b.escortSquad, range: b.range }));
      if (!this._ownHullOnCrest(team) && this.spillway?.enabled) {
        const box = this.tuning.spillway.boxes[0];
        out.push({ id: 'spillway', kind: 'shoot', point: { x: (box.x0 + box.x1 + 1) / 2, y: (box.y0 + box.y1) / 2, z: box.z1 }, radius: 4,
          priority: b.shootPriority, squad: 2, range: b.range, minRange: 25, projectiles: ['rocket'], hitWithin: 4 });
      }
      return out;
    }
    if (ev.phase !== 'armed') return out;
    if (team === ev.team) {
      for (const c of this.tuning.charges) {
        const task = this.useTask(`plant-${c.id}`, team, { priority: b.plantPriority + 1, squad: b.plantSquad, range: b.range });
        if (task) { out.push(task); break; }
      }
      out.push(this.areaTask('guard', anchor, { kind: 'hold', radius: b.guardRadius, priority: b.plantPriority, squad: b.escortSquad, range: b.range }));
      return out;
    }
    if (this.denialValue(team) > b.value.defuse) return out;
    for (const c of this.tuning.charges) {
      const task = this.useTask(`defuse-${c.id}`, team, { priority: b.defusePriority, squad: b.defuseSquad, range: b.range });
      if (task) { out.push(task); break; }
    }
    if (out.length) out.push(this.areaTask('escort', anchor, { kind: 'attack', radius: b.guardRadius, priority: b.defusePriority - 1, squad: b.escortSquad, range: b.range }));
    return out;
  }

  /** A hull of `team` on the crest road (a tank holding the dam would go down with it). */
  _ownHullOnCrest(team) {
    const { x0, x1, z0, z1, crestY } = REDROCK_DAM;
    for (const hull of this.system.engine?.vehicles?.vehicles?.values?.() ?? []) {
      if (!(hull.hp > 0) || hull.team !== team || isAircraft(hull.type)) continue;
      if (hull.x >= x0 && hull.x <= x1 && hull.z >= z0 - 2 && hull.z <= z1 + 2 && hull.y >= crestY - 2) return true;
    }
    return false;
  }
}
