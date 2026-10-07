/**
 * Authoritative hull damage: the armour-class x damage-class matrix with
 * heavy facing zones, merged `vehicle_hit` feedback, the disabled/burning
 * state, regeneration and the repair API. Crew exposure helpers live here
 * too, so every damage path asks one question: is this body behind armour?
 */
import { VEHICLE_DAMAGE_RULES, vehicleDef, vehicleWorldToLocal, vehicleMaxHp } from '../../shared/vehicle-defs.js';
import { armorMultiplier, armorEffective, classifyHitZone, EXPOSED_CREW_DAMAGE, isDamageClass, PHYSICAL_DAMAGE_CLASSES } from '../../shared/vehicle-armor.js';
import { evVehicleHit, evVehicleDisabled, evVehicleRepaired } from '../protocol/events.js';

/** Crouched hip height above the feet: exposed crew hitboxes hang below the seat hip. */
export const SEATED_HIP_HEIGHT = 0.64;

/** True for a seated body behind armour (sealed seats). Exposed seats are false. */
export function occupantShielded(victim) {
  return !!victim?.vehicleId && victim.vehicleSeatExposed !== true;
}
/** True for a body in an open seat (jeep, tank commander, door guns). */
export function occupantExposed(victim) {
  return !!victim?.vehicleId && victim.vehicleSeatExposed === true;
}
/** Damage share an exposed occupant takes; 1 for everyone else. */
export function occupantDamageScale(victim) {
  return occupantExposed(victim) ? EXPOSED_CREW_DAMAGE : 1;
}
/** Hitbox pose for ray tests: exposed crew are a crouched body under their seat hip. */
export function occupantHitPose(victim, pose = victim) {
  if (!occupantExposed(victim)) return pose;
  return { id: victim.id, x: victim.x, y: victim.y - SEATED_HIP_HEIGHT, z: victim.z, yaw: victim.yaw, pitch: victim.pitch,
    crouch: true, proneT: 0, leanT: 0, vx: 0, vz: 0, bodyScale: victim.bodyScale, combatBox: victim.combatBox ?? null };
}
/** Body centre used by blast visibility and falloff. */
export function occupantBodyCenter(victim) {
  return occupantExposed(victim) ? [victim.x, victim.y + 0.3, victim.z] : [victim.x, victim.y + 1.05, victim.z];
}

/** Facing zone of a world point (an impact or a blast origin) on a hull. */
export function hullZoneAt(vehicle, point) {
  const def = vehicleDef(vehicle);
  if (!def || !Array.isArray(point) || !point.every(Number.isFinite)) return 'side';
  const local = vehicleWorldToLocal(vehicle, point), height = def.height;
  return classifyHitZone(local, [def.collider.halfWidth, height / 2, def.collider.halfLength], height / 2);
}

const idOf = player => player?.id == null ? null : String(player.id);

export class VehicleDamageModel {
  constructor(system) {
    this.system = system;
    this.hits = new Map();
    this.repairs = new Map();
  }
  reset() { this.hits.clear(); this.repairs.clear(); }
  get engine() { return this.system.engine; }

  emit(kind, event, vehicle, extra = {}) {
    this.engine.tickEvents?.push(event);
    try { this.engine.mode?.onVehicleEvent?.(kind, { ...event, type: vehicle?.type ?? null, team: vehicle?.team ?? null, ...extra }); }
    catch { /* a broken mode hook never breaks hull damage */ }
  }

  /**
   * Apply one hit. Returns false when refused (friendly, dead hull, invalid),
   * true when accepted, including a zero-effect spark. `point` is the impact
   * (zone from the hull-local point); `origin` a blast centre (zone from the
   * blast direction). Physical damage (cls 'collision') bypasses armour.
   */
  apply(vehicle, amount, attacker, { cls = 'small', point = null, origin = null, impactVelocity = null, sourceTeam = null } = {}) {
    const system = this.system, v = vehicle;
    if (!v || !(v.hp > 0) || !Number.isFinite(amount) || amount <= 0) return false;
    if (!isDamageClass(cls) && !PHYSICAL_DAMAGE_CLASSES.includes(cls)) return false;
    if (attacker && (system.teamOf(attacker) === v.team || this.engine.mode?.canDamage?.(attacker, v) === false)) return false;
    const def = vehicleDef(v), max = def.hp, now = system.nowMs();
    const zone = point ? hullZoneAt(v, point) : origin ? hullZoneAt(v, origin) : 'side';
    const multiplier = armorMultiplier(cls, def.armor, zone), dealt = amount * multiplier;
    if (cls !== 'collision') this.recordHit(v, attacker, dealt, zone, cls, armorEffective(multiplier), point ?? origin ?? [v.x, v.y + def.height / 2, v.z], now);
    if (!(dealt > 0)) return true;
    if (impactVelocity) v.impactVelocity = impactVelocity;
    v.hp = Math.max(0, v.hp - dealt);
    v.lastDamagedAt = now;
    if (attacker) {
      const id = idOf(attacker), entry = v.damageLog.get(id) || { dmg: 0, at: now, player: attacker };
      entry.dmg += dealt; entry.at = now; entry.player = attacker;
      v.damageLog.set(id, entry);
    }
    if (v.hp > 0 && !v.disabled && (v.hp <= max * VEHICLE_DAMAGE_RULES.disabledFraction
        || cls === 'at' && (zone === 'rear' || zone === 'bottom') && dealt >= max * VEHICLE_DAMAGE_RULES.disableHitFraction)) {
      this.disable(v, attacker);
    }
    if (v.hp === 0) system.destroy(v, attacker, { sourceTeam });
    // A survived impact must not credit a later burn-out to the hull's own driver.
    else delete v.impactVelocity;
    return true;
  }

  disable(v, attacker) {
    v.disabled = true; v.burning = true; v.disabledBy = attacker ?? null;
    this.emit('vehicle_disabled', evVehicleDisabled(v.id, idOf(attacker)), v);
  }

  /** Merge hits per attacker and hull over one window; the merged event
   * carries the summed damage and the zone/class of its strongest hit. */
  recordHit(v, attacker, dmg, zone, cls, eff, pos, now) {
    const key = `${v.id}|${idOf(attacker) ?? ''}`;
    let open = this.hits.get(key);
    if (open && now - open.openedAt >= VEHICLE_DAMAGE_RULES.hitMergeMs) { this.flushHit(open); this.hits.delete(key); open = null; }
    if (!open) {
      open = { vehicle: v, attacker: idOf(attacker), openedAt: now, dmg: 0, best: -1, zone, cls, eff: false, pos };
      this.hits.set(key, open);
    }
    open.dmg += dmg; open.eff ||= eff;
    if (dmg > open.best) { open.best = dmg; open.zone = zone; open.cls = cls; open.pos = pos; }
  }
  flushHit(entry) {
    this.emit('vehicle_hit', evVehicleHit(entry.vehicle.id, entry.attacker, entry.dmg, entry.zone, entry.cls, entry.eff, entry.pos), entry.vehicle);
  }
  /** Emit every open window of one hull now (its destruction ends them). */
  flushVehicle(v) {
    for (const [key, entry] of this.hits) if (entry.vehicle === v) { this.flushHit(entry); this.hits.delete(key); }
  }
  /** Close merge and repair windows that have run their course. */
  flush(now = this.system.nowMs()) {
    for (const [key, entry] of this.hits) {
      if (now - entry.openedAt < VEHICLE_DAMAGE_RULES.hitMergeMs) continue;
      this.flushHit(entry);
      this.hits.delete(key);
    }
    for (const [key, entry] of this.repairs) {
      if (now - entry.emittedAt < VEHICLE_DAMAGE_RULES.repairEventMs) continue;
      if (entry.pending > 0) this.emitRepair(entry, now);
      else this.repairs.delete(key);
    }
  }

  /** Burning drains a disabled hull; regen restores an undamaged one up to its cap. */
  step(v, dt) {
    if (!(v.hp > 0) || !(dt > 0)) return;
    const max = vehicleMaxHp(v), now = this.system.nowMs();
    if (v.disabled && v.burning) {
      v.hp = Math.max(0, v.hp - max * VEHICLE_DAMAGE_RULES.burnFractionPerSecond * dt);
      if (v.hp === 0) {
        const credit = this.system.creditablePlayer(v.disabledBy, v);
        this.system.destroy(v, credit, {});
      }
      return;
    }
    const cap = max * VEHICLE_DAMAGE_RULES.regenCapFraction;
    if (!v.disabled && v.hp < cap && now - (v.lastDamagedAt ?? -Infinity) >= VEHICLE_DAMAGE_RULES.regenDelaySeconds * 1000) {
      v.hp = Math.min(cap, v.hp + max * VEHICLE_DAMAGE_RULES.regenFractionPerSecond * dt);
    }
  }

  /** Add hull points; clears disabled above the repair threshold. Returns HP added. */
  repair(v, amount, by = null) {
    if (!v || !(v.hp > 0) || v.padInactive || !Number.isFinite(amount) || amount <= 0) return 0;
    if (by && v.team != null && this.system.teamOf(by) !== v.team) return 0;
    const max = vehicleMaxHp(v), added = Math.min(amount, Math.max(0, max - v.hp));
    if (!(added > 0)) return 0;
    v.hp += added;
    if (v.disabled && v.hp > max * VEHICLE_DAMAGE_RULES.repairClearFraction) { v.disabled = false; v.burning = false; v.disabledBy = null; }
    const now = this.system.nowMs(), key = `${v.id}|${idOf(by) ?? ''}`;
    const entry = this.repairs.get(key) || { vehicle: v, by: idOf(by), pending: 0, emittedAt: -Infinity };
    entry.pending += added;
    this.repairs.set(key, entry);
    if (now - entry.emittedAt >= VEHICLE_DAMAGE_RULES.repairEventMs) this.emitRepair(entry, now);
    return added;
  }
  emitRepair(entry, now) {
    this.emit('vehicle_repaired', evVehicleRepaired(entry.vehicle.id, entry.by, entry.pending), entry.vehicle);
    entry.pending = 0; entry.emittedAt = now;
  }

  /** Other recent damage dealers, for vehicle_destroyed assists. */
  assists(v, killer) {
    const now = this.system.nowMs(), killerId = idOf(killer);
    return [...v.damageLog.entries()].filter(([id, entry]) => id !== killerId && entry.dmg > 0
      && now - entry.at <= VEHICLE_DAMAGE_RULES.assistWindowMs && this.system.teamOf(entry.player) !== v.team).map(([id]) => id);
  }
}
