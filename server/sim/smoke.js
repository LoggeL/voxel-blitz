import { SMOKE, smokeProfile, smokeBlocksSight, copySmokeFields } from '../../shared/smoke-rules.js';

export class SmokeSystem {
  constructor() {
    this.active = new Map();
    // Extra sight blockers by id, `(from, to, now) => bool` (a Conquest map event's smoke column);
    // their owner sets and drops them, `clear()` leaves them alone.
    this.occluders = new Map();
  }
  /** Register (fn) or drop (null) the sight blocker `id`. */
  setOccluder(id, fn) { if (typeof fn === 'function') this.occluders.set(id, fn); else this.occluders.delete(id); }
  clear() { this.active.clear(); }
  deploy(projectile, ctx) {
    if (ctx.canAffectWorld?.() === false) return null;
    const { x, y, z } = projectile;
    if (![x, y, z].every(Number.isFinite)) return null;
    const profile = smokeProfile(projectile.chaosLevel);
    const field = { id: `smoke-${projectile.id}`, x, y: y + 1, z,
      radius: profile.radius, createdAt: ctx.now, expiresAt: ctx.now + profile.durationMs };
    if (this.active.size >= SMOKE.maxFields) this.active.delete(this.active.keys().next().value);
    this.active.set(field.id, field);
    return field;
  }
  /** Place one field directly (tank smoke launchers). Same budget as grenades. */
  deployField({ id, x, y, z, radius = SMOKE.radius, durationMs = SMOKE.durationMs }, now) {
    if (typeof id !== 'string' || ![x, y, z, radius, durationMs, now].every(Number.isFinite) || radius <= 0 || durationMs <= 0) return null;
    const field = { id, x, y, z, radius: Math.min(6, radius), createdAt: now, expiresAt: now + durationMs };
    if (this.active.size >= SMOKE.maxFields) this.active.delete(this.active.keys().next().value);
    this.active.set(field.id, field);
    return field;
  }
  step(ctx) {
    if (ctx.canAffectWorld?.() === false) { this.clear(); return; }
    for (const [id, field] of this.active) if (ctx.now >= field.expiresAt) this.active.delete(id);
  }
  blocksSight(from, to, now) {
    if (smokeBlocksSight(this.active.values(), from, to, now)) return true;
    for (const blocks of this.occluders.values()) if (blocks(from, to, now)) return true;
    return false;
  }
  snapshot() { return copySmokeFields([...this.active.values()]); }
}
