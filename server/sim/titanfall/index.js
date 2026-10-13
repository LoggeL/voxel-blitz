/**
 * Titanfall projectile router (frozen by WP0, docs/titanfall.md §5.4 / §12.5).
 * ProjectileSystem owns one instance and hands it every projectile carrying
 * `tf` (the kind): 'titan:*' goes to titan-projectiles.js (WP3), 'archer',
 * 'thunderbolt' and 'mgl' to pilot-projectiles.js (WP4). The router is inert
 * unless a projectile has `tf`. It owns expiry: `explodeAt` and out-of-world
 * call the kind's `explode*Projectile` hook once, then remove the projectile.
 */
import { stepTitanProjectile, launchTitanProjectile, explodeTitanProjectile } from './titan-projectiles.js';
import { stepPilotProjectile, launchPilotProjectile, explodePilotProjectile, TF_PILOT_PROJECTILES } from './pilot-projectiles.js';
import { worldDimensions } from '../../../shared/world/dimensions.js';

const titanKind = kind => typeof kind === 'string' && kind.startsWith('titan:');

/** Past the map (and its airspace apron) by 2 m: the same bounds as ProjectileSystem's stock check. */
export function tfOutsideWorld(p, ctx) {
  const { sx, sz } = worldDimensions(ctx), edge = 2 + (ctx.airLimit || 0);
  return !(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
    || p.y < -2 || p.x < -edge || p.z < -edge || p.x > sx + edge || p.z > sz + edge;
}

export class TitanfallProjectiles {
  constructor(system) { this.system = system; }
  /**
   * Expiry is enforced here, before the kind module runs: at `explodeAt` (or once it leaves
   * the world) the kind's explode hook gets one call and the router then always removes the
   * projectile. The kind's step therefore only ever sees a live, in-world projectile.
   */
  step(projectile, stepSeconds, substeps, ctx) {
    const kind = projectile.tf, titan = titanKind(kind), pilot = !titan && TF_PILOT_PROJECTILES.includes(kind);
    if (!titan && !pilot) { this.system.active.delete(projectile.id); return undefined; } // unknown kinds never linger
    if (!(ctx.now < projectile.explodeAt) || tfOutsideWorld(projectile, ctx)) {
      try {
        if (titan) explodeTitanProjectile(this.system, projectile, ctx);
        else explodePilotProjectile(this.system, projectile, ctx);
      } finally {
        this.system.active.delete(projectile.id);
      }
      return undefined;
    }
    if (titan) return stepTitanProjectile(this.system, projectile, stepSeconds, substeps, ctx);
    return stepPilotProjectile(this.system, projectile, stepSeconds, substeps, ctx);
  }
  launch(kind, opts, ctx) {
    if (titanKind(kind)) return launchTitanProjectile(this.system, kind, opts, ctx);
    if (TF_PILOT_PROJECTILES.includes(kind)) return launchPilotProjectile(this.system, kind, opts, ctx);
    return null;
  }
}
