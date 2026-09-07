// Authoritative travelling fire packets. Every packet can hit one body once.
import { WEAPONS, damageAtDistance } from '../../shared/combatmath.js';
import { FLAME_RULES, flamePanicFloor } from '../../shared/flame-rules.js';
import { playerHitboxes, rayPlayerHitboxes } from '../../shared/player-hitboxes.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evHit } from '../protocol/events.js';

// Expanded body volumes must never pull damage across cover. Find a real body
// point inside the packet and require an unobstructed line from its launch eye.
function visibleContact(center, victim, radius, origin, solidAt) {
  for (const box of playerHitboxes(victim)) {
    const offset = center.map((v, i) => v - box.center[i]);
    const local = box.basis.map(axis => axis.reduce((sum, v, i) => sum + v * offset[i], 0));
    const clamped = local.map((v, i) => Math.max(-box.half[i], Math.min(box.half[i], v)));
    const point = box.center.map((v, i) => v + clamped.reduce((sum, n, j) => sum + n * box.basis[j][i], 0));
    if (Math.hypot(...point.map((v, i) => v - center[i])) > radius + 1e-6) continue;
    const delta = point.map((v, i) => v - origin[i]);
    if (!raycastVoxels(solidAt, ...origin, ...delta, Math.hypot(...delta))) return point;
  }
  return null;
}

export class FlameSystem {
  constructor() { this.active = []; }
  clear() { this.active.length = 0; }
  launch(owner, origin, direction, ctx) {
    if (ctx.canBurn?.() === false || this.active.length >= FLAME_RULES.maxProjectiles) return;
    const norm = Math.hypot(direction.x, direction.y, direction.z);
    if (!Number.isFinite(norm) || norm <= 0 || !origin.every(Number.isFinite)) return;
    this.active.push({ owner, origin: [...origin], position: [...origin], distance: 0,
      direction: { x: direction.x / norm, y: direction.y / norm, z: direction.z / norm } });
  }
  step(dt, ctx) {
    if (ctx.canBurn?.() === false) { this.clear(); return; }
    if (!Number.isFinite(dt) || dt <= 0) return;
    let kept = 0;
    for (const packet of this.active) {
      if (ctx.canBurn?.() === false) { this.clear(); return; }
      let remaining = Math.min(dt * FLAME_RULES.speed, FLAME_RULES.range - packet.distance);
      let ended = false;
      // Short bounded sweeps preserve growing-radius accuracy even on a slow tick.
      while (remaining > 1e-9 && !ended) {
        const travel = Math.min(0.5, remaining);
        const origin = packet.position, dir = packet.direction;
        const wall = raycastVoxels(ctx.solidAt, ...origin, dir.x, dir.y, dir.z, travel);
        const limit = wall ? wall.t : travel;
        const radius = FLAME_RULES.radius + (packet.distance + limit) * FLAME_RULES.radiusGrowth;
        let nearest = null;
        for (const victim of ctx.entities.values()) {
          if (victim === packet.owner || victim.state !== 'alive' || !ctx.canDamage(packet.owner, victim)) continue;
          if (Math.hypot(victim.x - origin[0], victim.y - origin[1], victim.z - origin[2]) > 3 + radius + limit) continue;
          const hit = rayPlayerHitboxes(origin, dir, victim, limit, { radius });
          if (!hit || (nearest && hit.t >= nearest.t) || (wall && hit.t >= wall.t)) continue;
          const center = [origin[0] + dir.x * hit.t, origin[1] + dir.y * hit.t, origin[2] + dir.z * hit.t];
          const point = visibleContact(center, victim, radius, packet.origin, ctx.solidAt);
          if (point) nearest = { victim, point, t: hit.t };
        }
        if (nearest) {
          const { victim, point, t } = nearest;
          const def = WEAPONS.flamethrower;
          const damage = damageAtDistance(def, packet.distance + t);
          const lethal = victim.takeDamage(damage, false);
          ctx.pushEvent(evHit(packet.owner.id, victim.id, damage, false, point, victim.lastDamage));
          if (lethal) ctx.killPlayer(victim, packet.owner, def.id, false);
          else {
            const remaining = Math.min(def.flame.duration,
              Math.max(def.flame.minDuration, (victim.burn?.remaining || 0) + def.flame.buildupPerHit));
            victim.burn = { owner: packet.owner, remaining, elapsed: victim.burn?.elapsed || 0 };
            victim.burning = remaining;
            victim.panic = Math.max(victim.panic, flamePanicFloor(remaining));
          }
          ended = true;
        } else if (wall) ended = true;
        else {
          origin[0] += dir.x * travel; origin[1] += dir.y * travel; origin[2] += dir.z * travel;
          packet.distance += travel;
          remaining -= travel;
        }
      }
      if (!ended && packet.distance < FLAME_RULES.range - 1e-9) this.active[kept++] = packet;
    }
    this.active.length = kept;
  }
}

export function updateBurn(victim, dt, ctx) {
  const burn = victim.burn;
  if (!burn) return;
  if (victim.state !== 'alive' || ctx.canBurn?.() === false || !ctx.canDamage(burn.owner, victim)) {
    victim.burn = null;
    victim.burning = 0;
    return;
  }
  const rules = WEAPONS.flamethrower.flame;
  const elapsed = Math.min(burn.remaining, Math.max(0, dt));
  burn.remaining = Math.max(0, burn.remaining - elapsed);
  burn.elapsed += elapsed;
  victim.burning = burn.remaining;
  victim.panic = Math.max(victim.panic, flamePanicFloor(burn.remaining));
  // Half-second hit events keep damage feedback and network traffic bounded.
  if (burn.elapsed >= 0.5 - 1e-9 || burn.remaining <= 0) {
    const damage = rules.damagePerS * burn.elapsed;
    burn.elapsed = 0;
    const lethal = victim.takeDamage(damage, false);
    ctx.pushEvent(evHit(burn.owner.id, victim.id, damage, false,
      [victim.x, victim.eyeY, victim.z], victim.lastDamage));
    if (lethal) ctx.killPlayer(victim, burn.owner, 'flamethrower', false);
  }
  if (burn.remaining <= 0 || victim.state !== 'alive') {
    victim.burn = null;
    victim.burning = 0;
  }
}
