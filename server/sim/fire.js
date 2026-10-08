import { combatDamage } from '../../shared/combat-balance.js';
// Authoritative travelling fire packets. Every packet can hit one body once.
import { WEAPONS, damageAtDistance } from '../../shared/combatmath.js';
import { FLAME_RULES, flamePanicFloor } from '../../shared/flame-rules.js';
import { combatHitboxes, rayPlayerHitboxes } from '../../shared/player-hitboxes.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evHit } from '../protocol/events.js';
import { occupantShielded, occupantHitPose, occupantDamageScale } from './vehicle-damage.js';

// Expanded body volumes must never pull damage across cover. Find a real body
// point inside the packet and require an unobstructed line from its launch eye.
function visibleContact(center, victim, radius, origin, solidAt) {
  for (const box of combatHitboxes(victim)) {
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
        // Hulls stop the stream; light hulls take the fire dose (armour matrix).
        const hull = ctx.vehicles?.rayHit?.(origin, [dir.x, dir.y, dir.z], wall ? wall.t : travel, packet.owner?.vehicleId ?? null) ?? null;
        // The stream ends at the hull face, but it still washes through an open
        // cab: exposed crew inside that hull's box are reachable up to its exit.
        const limit = hull ? Math.max(hull.distance, hull.exit ?? hull.distance) : wall ? wall.t : travel;
        const radius = FLAME_RULES.radius + (packet.distance + limit) * FLAME_RULES.radiusGrowth;
        let nearest = null;
        for (const victim of (ctx.targets || ctx.entities).values()) {
          // A fire-immune body (Conquest Pyro) lets the stream through: no hit, burn or panic.
          if (victim.fireImmune === true || occupantShielded(victim) || victim === packet.owner || victim.state !== 'alive' || !ctx.canDamage(packet.owner, victim)) continue;
          if (Math.hypot(victim.x - origin[0], victim.y - origin[1], victim.z - origin[2]) > 3 + radius + limit) continue;
          const pose = occupantHitPose(victim);
          const hit = rayPlayerHitboxes(origin, dir, pose, limit, { radius });
          if (!hit || (nearest && hit.t >= nearest.t) || (wall && hit.t >= wall.t)
            || (hull && hit.t >= hull.distance && victim.vehicleId !== hull.id)) continue;
          const center = [origin[0] + dir.x * hit.t, origin[1] + dir.y * hit.t, origin[2] + dir.z * hit.t];
          const point = visibleContact(center, pose, radius, packet.origin, ctx.solidAt);
          if (point) nearest = { victim, point, t: hit.t };
        }
        if (!nearest && hull) {
          const point = [origin[0] + dir.x * hull.distance, origin[1] + dir.y * hull.distance, origin[2] + dir.z * hull.distance];
          ctx.vehicles.damage(hull.id, damageAtDistance(WEAPONS.flamethrower, packet.distance + hull.distance), packet.owner, { cls: 'fire', point });
          ended = true;
        } else if (nearest) {
          const { victim, point, t } = nearest;
          const def = WEAPONS.flamethrower;
          const damage = combatDamage(damageAtDistance(def, packet.distance + t) * occupantDamageScale(victim));
          const lethal = victim.takeDamage(damage, false, packet.owner, 'flamethrower');
          ctx.pushEvent(evHit(packet.owner.id, victim.id, damage, false, point, victim.lastDamage));
          if (lethal) ctx.killPlayer(victim, packet.owner, def.id, false);
          else {
            const remaining = Math.min(def.flame.maxDuration ?? 8,
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

/** Lava sets a body alight with no owner; the flames outlast the contact. */
export function igniteFromLava(victim, seconds) {
  const remaining = Math.max(victim.burn?.remaining || 0, seconds);
  victim.burn = { owner: null, source: 'lava', remaining, elapsed: victim.burn?.elapsed || 0 };
  victim.burning = remaining;
  victim.panic = Math.max(victim.panic, flamePanicFloor(remaining));
}

/** Water puts any fire out at once. */
export function extinguish(victim) {
  if (!victim.burn) return false;
  victim.burn = null;
  victim.burning = 0;
  return true;
}

export function updateBurn(victim, dt, ctx) {
  const burn = victim.burn;
  if (!burn) return;
  // Fire immunity (Conquest Pyro) puts out a flamethrower burn; lava still burns.
  if (victim.fireImmune === true && !burn.source) { victim.burn = null; victim.burning = 0; return; }
  // World fire (lava) has no owner and needs no damage permission.
  const owner = burn.owner || null;
  const source = burn.source || 'flamethrower';
  if (victim.state !== 'alive' || ctx.canBurn?.() === false || (owner && !ctx.canDamage(owner, victim))) {
    victim.burn = null;
    victim.burning = 0;
    return;
  }
  const rules = WEAPONS.flamethrower.flame;
  const elapsed = Math.min(burn.remaining, Math.max(0, dt));
  burn.remaining = Math.max(0, burn.remaining - elapsed);
  // A sealed-seat crew member keeps the fire's clock, without accumulating body
  // damage to apply after exit. Hull destruction still owns lethal crew damage.
  // Open seats burn like a body on foot, at the exposed-crew share.
  const shielded = occupantShielded(victim);
  burn.elapsed = shielded ? 0 : burn.elapsed + elapsed;
  victim.burning = burn.remaining;
  victim.panic = Math.max(victim.panic, flamePanicFloor(burn.remaining));
  // Half-second hit events keep damage feedback and network traffic bounded.
  if (!shielded && (burn.elapsed >= 0.5 - 1e-9 || burn.remaining <= 0)) {
    const damage = combatDamage(rules.damagePerS * burn.elapsed * occupantDamageScale(victim));
    burn.elapsed = 0;
    const lethal = victim.takeDamage(damage, false, owner, source);
    ctx.pushEvent(evHit(owner ? owner.id : '', victim.id, damage, false,
      [victim.x, victim.eyeY, victim.z], victim.lastDamage));
    if (lethal) ctx.killPlayer(victim, owner, source, false);
  }
  if (burn.remaining <= 0 || victim.state !== 'alive') {
    victim.burn = null;
    victim.burning = 0;
  }
}
