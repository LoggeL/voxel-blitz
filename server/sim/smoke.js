import { SMOKE, smokeProfile, smokeBlocksSight, copySmokeFields } from '../../shared/smoke-rules.js';

export class SmokeSystem {
  constructor() { this.active = new Map(); }
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
  blocksSight(from, to, now) { return smokeBlocksSight(this.active.values(), from, to, now); }
  snapshot() { return copySmokeFields([...this.active.values()]); }
}
