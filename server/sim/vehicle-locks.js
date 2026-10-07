/**
 * Lock-on and countermeasures. Two lockers exist: an Engineer aiming down the
 * sights of the AX-9 STINGER at an airborne enemy aircraft (the RX-8 AT rocket
 * is dumb-fire), and a jet pilot with the AA missile rails selected. Line of sight is re-checked at 10 Hz
 * per locker and smoke blocks it. Locked launches home by proportional
 * navigation on a vehicle id (never Chaos homing). Flares decoy and reset
 * locks; tank smoke lays three SmokeSystem fields and breaks locks.
 */
import { LOCK_RULES, COUNTERMEASURE_RULES, vehicleDef, isAircraftType, vehicleDirection, vehicleLocalPoint } from '../../shared/vehicle-defs.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evCountermeasure } from '../protocol/events.js';

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const fwd = (yaw, pitch) => vehicleDirection(yaw, pitch);

export class VehicleLocks {
  constructor(system) {
    this.system = system;
    /** playerId -> { source, targetId, progress, losAt, los } */
    this.lockers = new Map();
  }
  get engine() { return this.system.engine; }
  reset() {
    for (const id of this.lockers.keys()) {
      const p = this.engine.entities?.get(id);
      if (p) { p.lockProgress = 0; p.lockTargetId = null; }
    }
    this.lockers.clear();
  }

  /** The lock source a player currently presents, with its eye and aim. */
  sourceFor(p) {
    if (!p || p.state !== 'alive') return null;
    let rideId = null;
    if (p.vehicleId) {
      const v = this.system.vehicles.get(p.vehicleId), seat = this.system.seatFor(p, v);
      if (!seat || !(v.hp > 0)) return null;
      if (seat.mounts.includes('rails')) {
        const choice = this.system.mounts.selected(v, seat.id);
        if (choice?.weapon !== 'aaMissile') return null;
        return { source: 'aaMissile', eye: vehicleLocalPoint(v, 0, 1.4, -5), aim: vehicleDirection(v.yaw, v.pitch), vehicleId: v.id };
      }
      // An Engineer in an open personal-weapons seat locks with the STINGER like on foot.
      if (!this.system.seatAllowsPersonalWeapons(p)) return null;
      rideId = v.id;
    }
    if (p.def?.projectile !== 'stinger' || !p.ads || !this.system.canOperate(p)) return null;
    return { source: 'stinger', eye: [p.eyeX ?? p.x, p.eyeY ?? p.y + 1.6, p.eyeZ ?? p.z], aim: fwd(p.yaw, p.pitch), vehicleId: rideId };
  }

  /** A hull a source may lock: hostile, alive, airborne aircraft without active flares. */
  candidate(p, v, info, rules, now) {
    if (!v || !(v.hp > 0) || v.padInactive || v.id === info.vehicleId || !isAircraftType(v) || v.grounded) return null;
    if (v.team == null || v.team === this.system.teamOf(p) || v.flaresUntil > now) return null;
    const center = this.system.hullCenter(v), delta = center.map((n, i) => n - info.eye[i]), distance = Math.hypot(...delta);
    if (!(distance > 0.5) || distance > rules.range) return null;
    const cos = (delta[0] * info.aim[0] + delta[1] * info.aim[1] + delta[2] * info.aim[2]) / distance;
    const angle = Math.acos(clamp(cos, -1, 1));
    return angle <= rules.cone ? { angle, distance, center } : null;
  }

  lineOfSight(eye, center, distance) {
    const solid = (x, y, z) => this.system.solid(x, y, z, true);
    const dir = center.map((n, i) => (n - eye[i]) / distance);
    if (raycastVoxels(solid, ...eye, ...dir, Math.max(0, distance - 2.5))) return false;
    return !this.engine.projectiles?.smoke?.blocksSight?.(eye, center, this.system.nowMs());
  }

  /** Once per tick: progress every locker and publish `lk` and lockProgress. */
  step(dt) {
    const now = this.system.nowMs(), seen = new Set();
    for (const v of this.system.vehicles.values()) v.lk = 0;
    for (const p of this.engine.entities?.values?.() ?? []) {
      const info = this.sourceFor(p), id = String(p.id);
      if (!info) { if (this.lockers.delete(id) || p.lockProgress) { p.lockProgress = 0; p.lockTargetId = null; } continue; }
      seen.add(id);
      const rules = LOCK_RULES[info.source];
      let lock = this.lockers.get(id);
      if (!lock || lock.source !== info.source) { lock = { source: info.source, targetId: null, progress: 0, losAt: -Infinity, los: false }; this.lockers.set(id, lock); }
      let current = lock.targetId ? this.candidate(p, this.system.vehicles.get(lock.targetId), info, { ...rules, cone: rules.cone * 1.5 }, now) : null;
      if (!current) {
        let best = null;
        for (const v of this.system.vehicles.values()) {
          const found = this.candidate(p, v, info, rules, now);
          if (found && (!best || found.angle < best.found.angle)) best = { v, found };
        }
        lock.targetId = best?.v.id ?? null; lock.progress = 0; lock.losAt = -Infinity;
        current = best?.found ?? null;
      }
      if (current && now - lock.losAt >= LOCK_RULES.losIntervalMs) {
        lock.los = this.lineOfSight(info.eye, current.center, current.distance); lock.losAt = now;
      }
      if (!current || !lock.los) { lock.progress = 0; if (!current) lock.targetId = null; }
      else lock.progress = Math.min(rules.seconds, lock.progress + dt);
      p.lockProgress = lock.targetId ? clamp(lock.progress / rules.seconds, 0, 1) : 0;
      p.lockTargetId = lock.targetId;
      const target = lock.targetId ? this.system.vehicles.get(lock.targetId) : null;
      if (target && lock.los) target.lk = Math.max(target.lk, lock.progress >= rules.seconds ? 2 : 1);
    }
    for (const id of this.lockers.keys()) if (!seen.has(id)) this.lockers.delete(id);
    for (const projectile of this.engine.projectiles?.active?.values?.() ?? []) {
      const target = projectile.guidance?.targetId ? this.system.vehicles.get(projectile.guidance.targetId) : null;
      if (target && target.hp > 0) target.lk = 3;
    }
  }

  /** Locked target id for a player and source, or null. */
  lockedTarget(p, source) {
    const lock = this.lockers.get(String(p?.id));
    return lock && lock.source === source && lock.targetId && lock.progress >= LOCK_RULES[source].seconds ? lock.targetId : null;
  }

  /** Reset every lock on a hull and break missiles tracking it. */
  breakLocks(vehicle, decoy = null) {
    for (const [id, lock] of this.lockers) {
      if (lock.targetId !== vehicle.id) continue;
      lock.targetId = null; lock.progress = 0;
      const p = this.engine.entities?.get(id);
      if (p) { p.lockProgress = 0; p.lockTargetId = null; }
    }
    for (const projectile of this.engine.projectiles?.active?.values?.() ?? []) {
      if (projectile.guidance?.targetId !== vehicle.id) continue;
      projectile.guidance.targetId = null;
      if (decoy) projectile.guidance.decoy = { ...decoy };
    }
  }

  /** Fire the hull's countermeasure. Returns the kind fired or null. */
  countermeasure(vehicle) {
    const kind = vehicleDef(vehicle)?.countermeasure, now = this.system.nowMs();
    if (!kind || !(vehicle.hp > 0) || vehicle.cmReadyAt > now) return null;
    const rules = COUNTERMEASURE_RULES[kind];
    vehicle.cmReadyAt = now + rules.cooldownSeconds * 1000;
    if (kind === 'flares') {
      vehicle.flaresUntil = now + rules.durationSeconds * 1000;
      // The flare cloud falls behind the airframe; missiles that lost the hull chase it.
      const velocity = [vehicle.vx || 0, vehicle.vy || 0, vehicle.vz || 0];
      this.breakLocks(vehicle, { x: vehicle.x - velocity[0] * 0.4, y: vehicle.y - rules.decoyDrop, z: vehicle.z - velocity[2] * 0.4,
        vx: velocity[0] * 0.2, vy: -4, vz: velocity[2] * 0.2 });
    } else {
      vehicle.smokeUntil = now + rules.durationSeconds * 1000;
      const smoke = this.engine.projectiles?.smoke;
      for (let i = 0; i < rules.fields; i++) {
        const offset = (i - (rules.fields - 1) / 2) * rules.spread, dir = vehicleDirection(vehicle.yaw + offset);
        smoke?.deployField?.({ id: `cm-${vehicle.id}-${now}-${i}`, x: vehicle.x + dir[0] * rules.distance,
          y: vehicle.y + rules.height, z: vehicle.z + dir[2] * rules.distance, radius: rules.radius,
          durationMs: rules.durationSeconds * 1000 }, now);
      }
      this.breakLocks(vehicle);
    }
    this.engine.tickEvents?.push(evCountermeasure(vehicle.id, kind));
    return kind;
  }

  /** Countermeasure readiness 0..100 for the snapshot row. */
  readiness(vehicle) {
    const kind = vehicleDef(vehicle)?.countermeasure;
    if (!kind) return null;
    const remaining = Math.max(0, (vehicle.cmReadyAt ?? 0) - this.system.nowMs());
    return Math.round(clamp(1 - remaining / (COUNTERMEASURE_RULES[kind].cooldownSeconds * 1000), 0, 1) * 100);
  }
}
