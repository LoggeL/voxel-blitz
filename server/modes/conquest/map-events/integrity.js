// Integrity targets of the Conquest map events (docs/conquest.md "Map
// events"): the Iron Bridge pattern for any structure an event can blow up
// (fuel tanks, a radio mast's base, an elevator's legs, quarry charges).
//
// A target is one integrity pool over one or more voxel boxes. Every
// explosion (ProjectileSystem.explode -> ModeController.onBlast) within
// max(its damage radius, minReach) of the nearest box takes that weapon's
// `supportDamage` share off the pool, falling off linearly with the distance
// (integrityBlastDamage in shared/map-events/geometry.js, the bridge's own
// helper). The table defaults to the Iron Bridge's (IRON_BRIDGE_RULES), so
// 10 rockets drop a 1000 pool. The last blow is credited (`by`).
import { IRON_BRIDGE_RULES } from '../../../../shared/conquest-bridge.js';
import { integrityBlastDamage } from '../../../../shared/conquest-map-events.js';

export const DEFAULT_INTEGRITY_RULES = Object.freeze({ supportDamage: IRON_BRIDGE_RULES.supportDamage, minReach: IRON_BRIDGE_RULES.minReach });

export class IntegrityTargets {
  constructor(system) {
    this.system = system;
    this.reset();
  }

  reset() { this.targets = []; }

  /** Register a target of `instance`: {id, boxes, integrity, supportDamage?, minReach?}. Returns its state. */
  add(instance, spec) {
    const target = {
      instance, id: spec.id, boxes: spec.boxes, integrity: spec.integrity, damage: 0, by: null, team: null, destroyed: false,
      enabled: spec.enabled !== false,
      rules: { supportDamage: spec.supportDamage ?? DEFAULT_INTEGRITY_RULES.supportDamage, minReach: spec.minReach ?? DEFAULT_INTEGRITY_RULES.minReach },
    };
    this.targets.push(target);
    return target;
  }

  get(instance, id) { return this.targets.find(t => t.instance === instance && t.id === id) ?? null; }
  of(instance) { return this.targets.filter(t => t.instance === instance); }

  /** Remaining share 0..1 of a target. */
  share(target) { return target ? Math.max(0, 1 - target.damage / target.integrity) : 0; }

  /** An explosion: every live target in reach takes its share. Returns [{target, damage}] (damage as a share). */
  onBlast(origin, { key = null, radius = 0, ownerId = null } = {}) {
    const hits = [];
    for (const target of this.targets) {
      if (target.destroyed || !target.enabled) continue;
      const { damage, support } = integrityBlastDamage(origin, key, radius, target.rules, target.boxes);
      if (damage > 0) hits.push(this.damage(target, damage, ownerId, { key, support }));
    }
    return hits.filter(Boolean);
  }

  /** Take `amount` integrity off a target (a controller's own damage path); credits `by`. */
  damage(target, amount, by = null, extra = {}) {
    if (!target || target.destroyed || !(amount > 0)) return null;
    const before = this.share(target);
    target.damage = Math.min(target.integrity, target.damage + amount);
    if (by != null && by !== '') {
      target.by = String(by);
      target.team = this.system.policy?.teamFor?.(this.system.entity(target.by)) ?? null;
    }
    const after = this.share(target);
    if (after <= 0) target.destroyed = true;
    const hit = { target, damage: before - after, share: after, by: target.by, team: target.team, destroyed: target.destroyed, ...extra };
    target.instance.controller.onTarget(target, hit);
    return hit;
  }
}
