// Levolutions, the server half (docs/conquest.md "Map events", "Levolutions";
// data in shared/map-events/levolution.js). The stage machine the Iron Bridge
// collapse introduced, lifted out of server/modes/conquest/bridge.js so any
// span can be blown down with the same numbers and the same fall:
//
//   intact  -> damaged   integrity at or below rules.damagedAt
//   damaged -> failing   integrity 0: the span groans for warnMs, the road
//                        crossing closes for bot drivers
//   failing -> down      every span block is brought down through the
//                        structural system (creak, at most chunkCap chunks,
//                        rubble), sunk supports under the water turn to
//                        water, bodies on the span take crush damage
//
// `Levolution` is the machine itself over one integrity pool (the Iron Bridge
// extends it with its own `bridge` event, `br` row and score reason).
// `LevolutionController` runs one as a map event: the pool is the
// definition's `supports` target (IntegrityTargets: assists, strike caps),
// the stages ride the event phases (damaged = armed, failing = warning, down
// = active then done), the final blow and the assists are paid through
// `payDestroyed`, and bots read `structureView()` (server/bot-map-events.js
// crossingDenialValue and the demolish tasks).
import { AIR, CONCRETE, FLUID_BLOCKS, MC_WATER, isSolidBlock } from '../../../../shared/world/blocks.js';
import { COLLAPSE_WEAPON, STRUCTURE_RULES } from '../../../../shared/structure.js';
import { isAircraft, vehicleMaxHp } from '../../../../shared/vehicles.js';
import { insideBox } from '../../../../shared/map-events/geometry.js';
import { LEVOLUTION_RULES, LEVOLUTION_STAGE, LEVOLUTION_STAGES, onLevolutionSpan } from '../../../../shared/map-events/levolution.js';
import { pack } from '../../../sim/structure-field.js';
import { evHit } from '../../../protocol/events.js';
import { MapEventController } from './controller.js';

export class Levolution {
  /**
   * @param {object} options
   * @param {() => object|null} options.engine  the GameEngine (world, structure, vehicles, combatants)
   * @param {() => number} options.now
   * @param {(a, b) => boolean} options.canDamage
   * @param {object} options.structure  {id, crossing, x, z, deckY, waterY?, span: [box], sinks: [box], supports, heads, fall?}
   * @param {object} options.rules      {integrity, damagedAt, warnMs, chunkCap, spanCrush}
   * @param {boolean} [options.autoFall]  true: the fall comes warnMs after the last blow (else `collapse()` is called)
   * @param {(stage, extra) => void} [options.onStage]  each stage change (and the fall, with {blocks})
   */
  constructor({ engine = () => null, now = () => 0, canDamage = () => true, structure, rules, autoFall = true, onStage = null } = {}) {
    this.engineOf = engine; this.now = now; this.canDamage = canDamage;
    this.structure = structure; this.rules = rules; this.autoFall = autoFall; this.onStage = onStage;
    this.reset();
  }

  get engine() { return this.engineOf() ?? null; }

  /** Round start and rematch: a whole structure (restoreWorld already put its voxels back). */
  reset() {
    this.stage = LEVOLUTION_STAGE.intact;
    this.damage = 0;
    this.fallAt = null;
    this.downAt = null;
    this.crushAt = null;
    this.by = null;
    this.creakId = null;
    this.strikes = null;      // scripted strike id -> integrity it took (strikeCapped)
    this.active = this._detect();
  }

  /** Only a world that has the structure takes part (the detect cell, else the deck under the anchor, is solid). */
  _detect() {
    const engine = this.engine, world = engine?.world, s = this.structure;
    if (typeof world?.getBlock !== 'function' || !s) return false;
    if (s.crossing && !(engine.mapMeta?.conquest?.crossings ?? []).some(c => c.id === s.crossing)) return false;
    const [x, y, z] = s.detect ?? [s.x, s.deckY, s.z];
    return isSolidBlock(world.getBlock(x, y, z));
  }

  get integrity() { return Math.max(0, 1 - this.damage / this.rules.integrity); }
  get failing() { return this.stage === LEVOLUTION_STAGE.failing; }
  get down() { return this.stage === LEVOLUTION_STAGE.down; }
  /** The road crossing bots may not drive over: closed from the groan on. */
  get closed() { return this.active && this.stage >= LEVOLUTION_STAGE.failing; }

  /**
   * Take `units` off the pool, credited to `by` (the last blow keeps the
   * credit). Returns the integrity share taken. Nothing changes from the
   * groan on: blasts after the last blow do not steal the credit.
   */
  wear(units, by = null) {
    if (!this.active || this.stage >= LEVOLUTION_STAGE.failing || !(units > 0)) return 0;
    const before = this.integrity;
    this.damage = Math.min(this.rules.integrity, this.damage + units);
    if (by != null && by !== '') this.by = String(by);
    const integrity = this.integrity;
    if (integrity <= 0) {
      this.stage = LEVOLUTION_STAGE.failing;
      this.fallAt = this.autoFall ? this.now() + this.rules.warnMs : null;
      this._announce();
    } else if (this.stage === LEVOLUTION_STAGE.intact && integrity <= this.rules.damagedAt) {
      this.stage = LEVOLUTION_STAGE.damaged;
      this._announce();
    }
    return before - integrity;
  }

  /** Policy tick: the fall at the end of the groan, then the crush on the span as it drops. */
  tick(now = this.now()) {
    if (!this.active) return;
    if (this.stage === LEVOLUTION_STAGE.failing && this.fallAt != null && now >= this.fallAt) this.collapse(now);
    if (this.crushAt != null && now >= this.crushAt) { this.crushAt = null; this._crushSpan(); }
  }

  /** The span goes: scripted demolition through the structural system. */
  collapse(now = this.now()) {
    if (!this.active || this.stage === LEVOLUTION_STAGE.down) return false;
    const engine = this.engine, world = engine.world, s = this.structure;
    this.stage = LEVOLUTION_STAGE.down;
    this.damage = this.rules.integrity;
    this.fallAt = null;
    this.downAt = now;
    const structure = engine.structure;
    const bottom = Math.min(...s.span.map(b => b.y0));
    // Supports under the water would hold the falling deck above the surface:
    // they become water (scripted block deltas). Whatever the structural pass
    // drops because of them is the final blow's, like the span itself.
    structure?.attribute?.(this.by);
    try {
      for (const sink of s.sinks ?? []) {
        for (let z = sink.z0; z <= sink.z1; z++) for (let x = sink.x0; x <= sink.x1; x++) {
          for (let y = Math.min(sink.y1, bottom - 1); y >= sink.y0 && world.getBlock(x, y, z) === CONCRETE; y--) {
            world.setBlock(x, y, z, MC_WATER);
            engine.pushBlockDelta(x, y, z, MC_WATER);
          }
        }
      }
    } finally { structure?.attribute?.(null); }
    // With a water line, footprint columns that stand on the bank (not over
    // the water in the pristine map) keep their blocks: a ledge on the quay.
    const keys = [];
    const seen = new Set();
    for (const b of s.span) {
      for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) {
        if (!this._overWater(world, x, z)) continue;
        for (let y = b.y0; y <= b.y1; y++) {
          if (!isSolidBlock(world.getBlock(x, y, z))) continue;
          const key = pack(x, y, z);
          if (!seen.has(key)) { seen.add(key); keys.push(key); }
        }
      }
    }
    const origin = [s.x, s.deckY, s.z];
    const structural = !!structure?.active;
    // bringDown returns null when every block is already creaking (the
    // structural pass doomed the span on its own): those fall as they are.
    this.creakId = structural
      ? structure.bringDown(keys, { cause: this.by, origin, chunkCap: this.rules.chunkCap, ...(s.fall ? { fall: s.fall } : {}) }) : null;
    if (!structural) {
      // No structural system (disabled, ad-hoc worlds): the span simply goes.
      for (const key of keys) {
        const x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
        world.setBlock(x, y, z, AIR);
        engine.pushBlockDelta(x, y, z, AIR);
      }
    }
    this.crushAt = now + (structural ? (structure.rules?.creakMs ?? STRUCTURE_RULES.creakMs) : 0);
    this._fallen(keys.length);
    return true;
  }

  /** The span is coming down (`blocks` doomed): the owner pays and announces. */
  _fallen(blocks) { this._announce({ blocks }); }

  /** A footprint column over open water (or a sunk support) in the pristine map; every column without a water line. */
  _overWater(world, x, z) {
    const y = this.structure.waterY;
    if (y == null) return true;
    const block = typeof world.templateBlock === 'function' ? world.templateBlock(x, y, z) : world.getBlock(x, y, z);
    return FLUID_BLOCKS.has(block) || (this.structure.sinks ?? []).some(b => insideBox(b, x, y, z));
  }

  /** True when a body stands on the span (its footprint, up to spanCrush.above over the deck). */
  onSpan(x, y, z) { return onLevolutionSpan(this.structure, x, y, z, this.rules.spanCrush.above); }

  /** Infantry and ground hulls on the deck as it drops: crush damage credited like a structural collapse. */
  _crushSpan() {
    const engine = this.engine;
    if (!engine || engine.mode?.phase !== 'live') return;
    const killer = this.by ? engine.combatants?.get?.(this.by) ?? null : null;
    const { infantry, hullFraction } = this.rules.spanCrush;
    for (const victim of engine.combatants?.values?.() ?? []) {
      if (victim.state !== 'alive' || victim.vehicleId || victim.objective) continue;
      if (!this.onSpan(victim.x, victim.y, victim.z)) continue;
      if (victim.spawnProtected || (Number.isFinite(victim.spawnProtectedUntil) && victim.spawnProtectedUntil > engine.now)) continue;
      // A team-mate's collapse spares you like their shots would; your own does not.
      const credited = killer && killer !== victim && !this.canDamage(killer, victim) ? null : killer;
      if (killer && killer !== victim && !credited) continue;
      const lethal = victim.takeDamage(infantry, false, credited, COLLAPSE_WEAPON);
      engine.tickEvents.push(evHit(credited ? credited.id : '', victim.id, infantry, false, [victim.x, victim.y + 1, victim.z], victim.lastDamage));
      if (lethal) engine.killPlayer(victim, credited, COLLAPSE_WEAPON, false, null);
    }
    for (const hull of engine.vehicles?.vehicles?.values?.() ?? []) {
      if (!(hull.hp > 0) || !this.onSpan(hull.x, hull.y, hull.z)) continue;
      // Ground hulls only: a helicopter hovering low over the deck flies on (one parked on it goes down with it).
      if (isAircraft(hull.type) && !hull.grounded) continue;
      engine.vehicles.damage(hull.id, (vehicleMaxHp(hull.type) || hull.maxHp || 0) * hullFraction, killer, { cls: 'collision',
        point: [hull.x, hull.y + 1, hull.z] });
    }
  }

  _announce(extra = {}) { this.onStage?.(this.stage, extra); }

  /**
   * The bots' read model of the structure (server/bot-map-events.js):
   * {id, crossing, flag, stage, standing, closed, down, integrity, supports, heads, x, z}.
   */
  structureView(extra = {}) {
    const s = this.structure;
    return { id: s.id, crossing: s.crossing ?? null, flag: s.flag ?? null, stage: this.stage, name: LEVOLUTION_STAGES[this.stage],
      standing: this.active && this.stage < LEVOLUTION_STAGE.failing, closed: this.closed, down: this.down, integrity: this.integrity,
      supports: s.supports, heads: s.heads ?? [], x: s.x, z: s.z, ...extra };
  }
}

/**
 * A levolution as a map event (definitions from `defineLevolution`). The
 * pool is the `supports` target; its stage machine runs on `Levolution`
 * without its own timer: the event's warning phase is the groan (the
 * director may queue it behind another big event, the crossing is closed
 * meanwhile) and the active phase is the fall.
 */
export class LevolutionController extends MapEventController {
  onReset() {
    const { structure, rules } = this.def.tuning.levolution;
    const target = this.target('supports');
    const anchor = this.system.anchorOf(this.event) ?? {};
    const policy = this.system.policy;
    this.levolution = new Levolution({
      engine: () => this.system.engine, now: () => this.system.now, canDamage: (a, b) => policy?.canDamage?.(a, b) ?? true,
      structure: { ...structure, flag: this.def.flag, x: anchor.x ?? structure.supports[0].x0, z: anchor.z ?? structure.supports[0].z0 },
      rules: { ...rules, integrity: target?.integrity ?? 1 }, autoFall: false,
      onStage: (stage, extra) => this._stage(stage, extra),
    });
    if (target) target.enabled = this.levolution.active;
  }

  get structure() { return this.levolution?.structure ?? null; }

  /** The supports took a blast (or a controller's own damage): the machine follows the pool. */
  onTarget(target, hit) {
    if (target.id !== 'supports' || !this.levolution) return;
    this.levolution.wear(target.damage - this.levolution.damage, hit.by);
  }

  _stage(stage, extra) {
    const event = this.event, lev = this.levolution;
    const team = this.target('supports')?.team ?? this.system.teamOf(lev.by), by = lev.by;
    const data = { integrity: Math.round(lev.integrity * 100) };
    if (stage === LEVOLUTION_STAGE.damaged) event.arm({ ms: null, team, by, reason: 'damaged', data });
    else if (stage === LEVOLUTION_STAGE.failing) event.trigger({ team, by, reason: 'failing', data });
    else if (stage === LEVOLUTION_STAGE.down) {
      this.system.payDestroyed(this.target('supports'), by);
      event.announce('fallen', { blocks: extra.blocks | 0 });
    }
  }

  onPhase(phase) {
    // The groan ran out: the span goes (the active phase is its fall).
    if (phase === 'active' && this.levolution && !this.levolution.down) this.levolution.collapse(this.system.now);
  }

  onTick(now) { this.levolution?.tick(now); }

  /** The wire gauge: the share of the pool gone (0 while intact, so an untouched row stays off the wire). */
  progress() { return this.levolution?.active ? 1 - this.levolution.integrity : 0; }

  closedCrossings() {
    const lev = this.levolution;
    return lev?.closed && lev.structure.crossing ? [lev.structure.crossing] : null;
  }

  structureView() {
    const lev = this.levolution;
    return lev?.active ? lev.structureView({ event: this.event.id }) : null;
  }
}

export { LEVOLUTION_RULES };
