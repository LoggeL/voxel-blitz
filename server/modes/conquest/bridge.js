// Iron Bridge collapse, the Conquest levolution on Frontier (docs/conquest.md
// "Iron Bridge collapse"; geometry and tuning in shared/conquest-bridge.js).
//
//   intact  -> damaged   integrity at or below IRON_BRIDGE_RULES.damagedAt
//   damaged -> failing   integrity 0: the span groans for warnMs, the road
//                        through C closes for bot drivers
//   failing -> down      every span block is brought down through the
//                        structural system (creak, chunks, rubble in the
//                        river), the pier stumps under the water turn to
//                        water, bodies on the span take crush damage
//
// Each change emits one `bridge` event; `match.conquest.br` carries the state
// for late joiners. A rematch restores the world and resets the bridge.
import { AIR, CONCRETE, FLUID_BLOCKS, MC_WATER, isSolidBlock } from '../../../shared/world/blocks.js';
import { COLLAPSE_WEAPON, STRUCTURE_RULES } from '../../../shared/structure.js';
import { isAircraft, vehicleMaxHp } from '../../../shared/vehicles.js';
import {
  BRIDGE_STAGE, BRIDGE_STAGES, IRON_BRIDGE, IRON_BRIDGE_RULES, bridgeBlastDamage, encodeBridge, insideBox, onBridgeSpan,
} from '../../../shared/conquest-bridge.js';
import { pack } from '../../sim/structure-field.js';
import { strikeCapped } from './map-events/integrity.js';
import { evHit } from '../../protocol/events.js';

export class IronBridge {
  /**
   * @param {object} options
   * @param {() => object|null} options.engine  the GameEngine (world, structure, vehicles, combatants)
   * @param {() => number} options.now
   * @param {(kind, fields) => void} options.emit
   * @param {(id, reason) => number} options.award
   * @param {(a, b) => boolean} options.canDamage
   */
  constructor({ engine = () => null, now = () => 0, emit = () => {}, award = () => 0, canDamage = () => true,
    rules = IRON_BRIDGE_RULES, bridge = IRON_BRIDGE } = {}) {
    this.engineOf = engine; this.now = now; this.emit = emit; this.award = award; this.canDamage = canDamage;
    this.rules = rules; this.bridge = bridge;
    this.reset();
  }

  get engine() { return this.engineOf() ?? null; }

  /** Round start and rematch: a whole bridge (restoreWorld already put its voxels back). */
  reset() {
    this.stage = BRIDGE_STAGE.intact;
    this.damage = 0;
    this.fallAt = null;
    this.downAt = null;
    this.crushAt = null;
    this.by = null;
    this.creakId = null;
    this.strikes = null;      // scripted strike id -> integrity it took (strikeCapped)
    this.active = this._detect();
  }

  /** Only a world that has the Iron Bridge deck takes part (Frontier; fixtures without it stay inert). */
  _detect() {
    const engine = this.engine, world = engine?.world;
    if (engine?.mapMeta?.id !== 'frontier' || typeof world?.getBlock !== 'function') return false;
    if (!(engine.mapMeta?.conquest?.crossings ?? []).some(c => c.id === this.bridge.crossing)) return false;
    const { x, z, deckY } = this.bridge;
    return isSolidBlock(world.getBlock(x, deckY, z)) && isSolidBlock(world.getBlock(x - 1, deckY - 1, z));
  }

  get integrity() { return Math.max(0, 1 - this.damage / this.rules.integrity); }
  get failing() { return this.stage === BRIDGE_STAGE.failing; }
  get down() { return this.stage === BRIDGE_STAGE.down; }
  /** The road crossing bots may not drive over: closed from the groan on. */
  get closed() { return this.active && this.stage >= BRIDGE_STAGE.failing; }

  /**
   * An explosion (ProjectileSystem.explode via the mode's onBlast): wear the
   * supports down. `key` is the blast's weapon key, `radius` its damage radius,
   * `strike` a scripted strike's cap (a call-in takes at most its capShare).
   * Returns the integrity taken (0..1 share).
   */
  onBlast(origin, { key = null, radius = 0, ownerId = null, strike = null } = {}) {
    if (!this.active || this.stage >= BRIDGE_STAGE.failing) return 0;
    const damage = strikeCapped(this, strike, bridgeBlastDamage(origin, key, radius, this.rules, this.bridge).damage, this.rules.integrity);
    if (!(damage > 0)) return 0;
    const before = this.integrity;
    this.damage = Math.min(this.rules.integrity, this.damage + damage);
    if (ownerId != null && ownerId !== '') this.by = String(ownerId);
    const integrity = this.integrity;
    if (integrity <= 0) {
      this.stage = BRIDGE_STAGE.failing;
      this.fallAt = this.now() + this.rules.warnMs;
      this._announce();
    } else if (this.stage === BRIDGE_STAGE.intact && integrity <= this.rules.damagedAt) {
      this.stage = BRIDGE_STAGE.damaged;
      this._announce();
    }
    return before - integrity;
  }

  /** Policy tick: the fall at the end of the groan, then the crush on the span as it drops. */
  tick(now = this.now()) {
    if (!this.active) return;
    if (this.stage === BRIDGE_STAGE.failing && now >= this.fallAt) this.collapse(now);
    if (this.crushAt != null && now >= this.crushAt) { this.crushAt = null; this._crushSpan(); }
  }

  /** The span goes: scripted demolition through the structural system. */
  collapse(now = this.now()) {
    if (!this.active || this.stage === BRIDGE_STAGE.down) return false;
    const engine = this.engine, world = engine.world;
    this.stage = BRIDGE_STAGE.down;
    this.damage = this.rules.integrity;
    this.fallAt = null;
    this.downAt = now;
    const { span, piers } = this.bridge;
    const structure = engine.structure;
    // Pier stumps under the water would hold the falling deck above the
    // surface: they become river water (scripted block deltas). Whatever
    // the structural pass drops because of them is the final blow's, like
    // the span itself.
    structure?.attribute?.(this.by);
    try {
      for (let z = piers.z0; z <= piers.z1; z++) for (let x = piers.x0; x <= piers.x1; x++) {
        for (let y = Math.min(piers.y1, span.y0 - 1); y >= piers.y0 && world.getBlock(x, y, z) === CONCRETE; y--) {
          world.setBlock(x, y, z, MC_WATER);
          engine.pushBlockDelta(x, y, z, MC_WATER);
        }
      }
    } finally { structure?.attribute?.(null); }
    // Columns of the footprint that stand on the bank (not over the river
    // in the pristine map) keep their blocks: a ledge of deck on the quay.
    const keys = [];
    for (let z = span.z0; z <= span.z1; z++) for (let x = span.x0; x <= span.x1; x++) {
      if (!this._overWater(world, x, z)) continue;
      for (let y = span.y0; y <= span.y1; y++) if (isSolidBlock(world.getBlock(x, y, z))) keys.push(pack(x, y, z));
    }
    const origin = [this.bridge.x, this.bridge.deckY, this.bridge.z];
    const structural = !!structure?.active;
    // bringDown returns null when every block is already creaking (the
    // structural pass doomed the span on its own): those fall as they are.
    this.creakId = structural ? structure.bringDown(keys, { cause: this.by, origin, chunkCap: this.rules.chunkCap }) : null;
    if (!structural) {
      // No structural system (disabled, ad-hoc worlds): the span simply goes.
      for (const key of keys) {
        const x = key & 1023, z = (key >> 10) & 1023, y = key >> 20;
        world.setBlock(x, y, z, AIR);
        engine.pushBlockDelta(x, y, z, AIR);
      }
    }
    this.crushAt = now + (structural ? (structure.rules?.creakMs ?? STRUCTURE_RULES.creakMs) : 0);
    if (this.by) this.award(this.by, this.rules.scoreReason);
    this._announce({ blocks: keys.length });
    return true;
  }

  /** A footprint column over open water (or a pier) in the pristine map. */
  _overWater(world, x, z) {
    const y = this.bridge.waterY;
    const block = typeof world.templateBlock === 'function' ? world.templateBlock(x, y, z) : world.getBlock(x, y, z);
    return FLUID_BLOCKS.has(block) || insideBox(this.bridge.piers, x, y, z);
  }

  /** Infantry and ground hulls on the deck as it drops: crush damage credited like a structural collapse. */
  _crushSpan() {
    const engine = this.engine;
    if (!engine || engine.mode?.phase !== 'live') return;
    const killer = this.by ? engine.combatants?.get?.(this.by) ?? null : null;
    const { infantry, hullFraction } = this.rules.spanCrush;
    for (const victim of engine.combatants?.values?.() ?? []) {
      if (victim.state !== 'alive' || victim.vehicleId || victim.objective) continue;
      if (!onBridgeSpan(victim.x, victim.y, victim.z, { bridge: this.bridge })) continue;
      if (victim.spawnProtected || (Number.isFinite(victim.spawnProtectedUntil) && victim.spawnProtectedUntil > engine.now)) continue;
      // A team-mate's collapse spares you like their shots would; your own does not.
      const credited = killer && killer !== victim && !this.canDamage(killer, victim) ? null : killer;
      if (killer && killer !== victim && !credited) continue;
      const lethal = victim.takeDamage(infantry, false, credited, COLLAPSE_WEAPON);
      engine.tickEvents.push(evHit(credited ? credited.id : '', victim.id, infantry, false, [victim.x, victim.y + 1, victim.z], victim.lastDamage));
      if (lethal) engine.killPlayer(victim, credited, COLLAPSE_WEAPON, false, null);
    }
    for (const hull of engine.vehicles?.vehicles?.values?.() ?? []) {
      if (!(hull.hp > 0) || !onBridgeSpan(hull.x, hull.y, hull.z, { bridge: this.bridge })) continue;
      // Ground hulls only: a helicopter hovering low over the deck flies on (one parked on it goes down with it).
      if (isAircraft(hull.type) && !hull.grounded) continue;
      engine.vehicles.damage(hull.id, (vehicleMaxHp(hull.type) || hull.maxHp || 0) * hullFraction, killer, { cls: 'collision',
        point: [hull.x, hull.y + 1, hull.z] });
    }
  }

  _announce(extra = {}) {
    const fields = { bridge: this.bridge.id, stage: this.stage, name: BRIDGE_STAGES[this.stage],
      integrity: Math.round(this.integrity * 100) };
    if (this.stage === BRIDGE_STAGE.failing) fields.fallAt = Math.round(this.fallAt);
    if (this.stage >= BRIDGE_STAGE.failing && this.by) fields.by = this.by;
    this.emit('bridge', { ...fields, ...extra });
  }

  /** `match.conquest.br`, or null while untouched. */
  snapshot() {
    return this.active ? encodeBridge({ stage: this.stage, integrity: this.integrity, fallAt: this.fallAt }) : null;
  }

  /** Read model for bots: which crossing is closed and whether the span is about to go. */
  view() {
    return { active: this.active, stage: this.stage, failing: this.failing, down: this.down, closed: this.closed,
      crossing: this.bridge.crossing, span: this.bridge.span, fallAt: this.fallAt };
  }
}
