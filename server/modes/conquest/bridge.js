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
// The stage machine, the fall and the crush are the generic levolution's
// (./map-events/levolution.js, lifted from here with the same numbers); this
// class keeps what is the bridge's own: the Frontier detection, the blast
// falloff over its supports, one `bridge` event per stage, the
// `match.conquest.br` row for late joiners and the BRIDGE DESTROYED score.
// A rematch restores the world and resets the bridge.
import { isSolidBlock } from '../../../shared/world/blocks.js';
import {
  BRIDGE_STAGE, BRIDGE_STAGES, IRON_BRIDGE, IRON_BRIDGE_RULES, bridgeBlastDamage, encodeBridge,
} from '../../../shared/conquest-bridge.js';
import { strikeCapped } from './map-events/integrity.js';
import { Levolution } from './map-events/levolution.js';

/** The bridge as a levolution structure (one span box, the pier stumps sunk, columns over the river only). */
const bridgeStructure = bridge => ({
  id: bridge.id, crossing: bridge.crossing, flag: bridge.flag, x: bridge.x, z: bridge.z, deckY: bridge.deckY, waterY: bridge.waterY,
  span: [bridge.span], sinks: [bridge.piers], supports: bridge.supports, heads: bridge.heads ?? [],
});

export class IronBridge extends Levolution {
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
    super({ engine, now, canDamage, structure: bridgeStructure(bridge), rules });
    this.emit = emit; this.award = award; this.bridge = bridge;
  }

  /** Only a world that has the Iron Bridge deck takes part (Frontier; fixtures without it stay inert). */
  _detect() {
    const engine = this.engine, world = engine?.world;
    if (engine?.mapMeta?.id !== 'frontier' || typeof world?.getBlock !== 'function') return false;
    if (!(engine.mapMeta?.conquest?.crossings ?? []).some(c => c.id === this.structure.crossing)) return false;
    const { x, z, deckY } = this.structure;
    return isSolidBlock(world.getBlock(x, deckY, z)) && isSolidBlock(world.getBlock(x - 1, deckY - 1, z));
  }

  /**
   * An explosion (ProjectileSystem.explode via the mode's onBlast): wear the
   * supports down. `key` is the blast's weapon key, `radius` its damage radius,
   * `strike` a scripted strike's cap (a call-in takes at most its capShare).
   * Returns the integrity taken (0..1 share).
   */
  onBlast(origin, { key = null, radius = 0, ownerId = null, strike = null } = {}) {
    if (!this.active || this.stage >= BRIDGE_STAGE.failing) return 0;
    const damage = strikeCapped(this, strike, bridgeBlastDamage(origin, key, radius, this.rules, this.bridge).damage, this.rules.integrity);
    return this.wear(damage, ownerId);
  }

  _fallen(blocks) {
    if (this.by) this.award(this.by, this.rules.scoreReason);
    this._announce({ blocks });
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
