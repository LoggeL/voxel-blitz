import {
  AIR,
  GRENADE_RESISTANCE,
  SX,
  SY,
  SZ,
} from '../../shared/worlddata.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evGrenadeExplode, evGrenadeThrow, evHit } from '../protocol.js';
import { fwdFromYawPitch } from './player.js';
import { GRENADE_PER_LIFE, grenadeThrowProfile } from '../../shared/grenade-rules.js';

export const GRENADE_RULES = Object.freeze({
  perLife: GRENADE_PER_LIFE,
  fuseMs: 2300,
  terrainRadius: 3.8,
  damageRadius: 5.6,
  maxDestroyedBlocks: 110,
});

const RADIUS = 0.16;
const BOUNCE = 0.46;
const FLOOR_FRICTION = 0.82;
const GRAVITY = 18;

const finitePoint = (x, y, z) =>
  Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);

function solid(ctx, x, y, z) {
  return ctx.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) !== AIR;
}

function visibleTo(ctx, origin, target, endMargin = 0.18) {
  const dx = target[0] - origin[0];
  const dy = target[1] - origin[1];
  const dz = target[2] - origin[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance <= endMargin) return true;
  return !raycastVoxels(
    (x, y, z) => ctx.getBlock(x, y, z) !== AIR,
    origin[0], origin[1], origin[2], dx, dy, dz,
    distance - endMargin,
  );
}

/** Room-scoped authoritative thrown-grenade simulation. */
export class GrenadeSystem {
  constructor() {
    this.active = new Map();
    this._nextId = 1;
  }

  clear() {
    this.active.clear();
  }

  step(dt, ctx) {
    for (const player of ctx.entities.values()) {
      if (!player.grenadeEdgeQueued) continue;
      player.grenadeEdgeQueued = false;
      const charge = player.grenadeChargeQueued;
      player.grenadeChargeQueued = 0;
      if (player.state !== 'alive' || player.grenades <= 0 || !ctx.canThrow(player)) continue;
      this.throw(player, ctx, charge);
    }

    const substeps = 2;
    const stepSeconds = Math.max(0, Math.min(0.05, dt)) / substeps;
    for (const grenade of this.active.values()) {
      for (let i = 0; i < substeps; i++) this._integrate(grenade, stepSeconds, ctx);
      if (ctx.now >= grenade.explodeAt || !finitePoint(grenade.x, grenade.y, grenade.z) ||
          grenade.y < -2 || grenade.x < -2 || grenade.z < -2 ||
          grenade.x > SX + 2 || grenade.z > SZ + 2) {
        this.explode(grenade, ctx);
      }
    }
  }

  throw(player, ctx, charge = 0.5) {
    const direction = fwdFromYawPitch(player.yaw, player.pitch);
    const profile = grenadeThrowProfile(charge);
    const id = `g${this._nextId++}`;
    const grenade = {
      id,
      ownerId: String(player.id),
      owner: player,
      x: player.x + direction.x * 0.48,
      y: player.eyeY - 0.12 + direction.y * 0.38,
      z: player.z + direction.z * 0.48,
      vx: direction.x * profile.speed + player.vx * 0.35,
      vy: direction.y * profile.speed + profile.lift + player.vy * 0.2,
      vz: direction.z * profile.speed + player.vz * 0.35,
      charge: profile.charge,
      explodeAt: ctx.now + GRENADE_RULES.fuseMs,
    };
    player.grenades--;
    player.spawnProtectedUntil = 0;
    player.spawnProtected = false;
    this.active.set(id, grenade);
    ctx.pushEvent(evGrenadeThrow(
      player.id,
      id,
      [grenade.x, grenade.y, grenade.z],
      [grenade.vx, grenade.vy, grenade.vz],
      GRENADE_RULES.fuseMs,
    ));
    return grenade;
  }

  _integrate(grenade, dt, ctx) {
    grenade.vy -= GRAVITY * dt;
    this._moveAxis(grenade, 'x', grenade.vx * dt, ctx);
    this._moveAxis(grenade, 'z', grenade.vz * dt, ctx);
    const hitFloor = this._moveAxis(grenade, 'y', grenade.vy * dt, ctx);
    if (hitFloor && grenade.vy > 0) {
      grenade.vx *= FLOOR_FRICTION;
      grenade.vz *= FLOOR_FRICTION;
    }
  }

  _moveAxis(grenade, axis, delta, ctx) {
    if (!Number.isFinite(delta) || Math.abs(delta) < 1e-8) return false;
    const next = grenade[axis] + delta;
    const x = axis === 'x' ? next + Math.sign(delta) * RADIUS : grenade.x;
    const y = axis === 'y' ? next + Math.sign(delta) * RADIUS : grenade.y;
    const z = axis === 'z' ? next + Math.sign(delta) * RADIUS : grenade.z;
    const blocked = solid(ctx, x, y, z) ||
      (axis !== 'y' && solid(ctx, x, y + RADIUS, z));
    if (!blocked) {
      grenade[axis] = next;
      return false;
    }
    grenade['v' + axis] *= -BOUNCE;
    if (axis !== 'y') grenade['v' + axis] *= 0.88;
    return true;
  }

  explode(grenade, ctx) {
    if (!this.active.delete(grenade.id)) return false;
    const origin = [grenade.x, grenade.y, grenade.z];
    const owner = grenade.owner || ctx.entities.get(grenade.ownerId) || null;
    const ownerId = owner?.id == null ? grenade.ownerId : String(owner.id);
    ctx.pushEvent(evGrenadeExplode(
      ownerId,
      grenade.id,
      origin,
      GRENADE_RULES.damageRadius,
    ));
    if (typeof ctx.canAffectWorld === 'function' && !ctx.canAffectWorld()) return true;
    this._damagePlayers(owner, origin, ctx);
    this._destroyTerrain(origin, ctx);
    return true;
  }

  _damagePlayers(owner, origin, ctx) {
    for (const victim of ctx.entities.values()) {
      if (victim.state !== 'alive') continue;
      if (Number.isFinite(victim.spawnProtectedUntil) &&
          victim.spawnProtectedUntil > ctx.now) continue;
      const isSelf = !!owner && victim.id === owner.id;
      if (!isSelf && !ctx.canDamage(owner, victim)) continue;
      const target = [victim.x, victim.y + 1.05, victim.z];
      const dx = target[0] - origin[0];
      const dy = target[1] - origin[1];
      const dz = target[2] - origin[2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= GRENADE_RULES.damageRadius || !visibleTo(ctx, origin, target)) continue;
      const falloff = Math.pow(1 - distance / GRENADE_RULES.damageRadius, 1.22);
      const damage = Math.round(120 * falloff * (isSelf ? 0.72 : 1) * 10) / 10;
      if (damage <= 0) continue;
      const lethal = victim.takeDamage(damage, false);
      ctx.pushEvent(evHit(owner?.id || '', victim.id, damage, false, target));
      const impulse = Math.max(0, 8.5 * falloff);
      const invDistance = distance > 0.01 ? 1 / distance : 0;
      victim.vx += dx * invDistance * impulse;
      victim.vy += Math.max(0.8, dy * invDistance + 0.35) * impulse;
      victim.vz += dz * invDistance * impulse;
      if (lethal) ctx.killPlayer(victim, owner, 'grenade', false, null);
    }
  }

  _destroyTerrain(origin, ctx) {
    const radius = GRENADE_RULES.terrainRadius;
    const candidates = [];
    const minX = Math.max(0, Math.floor(origin[0] - radius));
    const maxX = Math.min(SX - 1, Math.ceil(origin[0] + radius));
    const minY = Math.max(1, Math.floor(origin[1] - radius));
    const maxY = Math.min(SY - 1, Math.ceil(origin[1] + radius));
    const minZ = Math.max(0, Math.floor(origin[2] - radius));
    const maxZ = Math.min(SZ - 1, Math.ceil(origin[2] + radius));
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const type = ctx.getBlock(x, y, z);
          const resistance = GRENADE_RESISTANCE[type];
          if (!Number.isFinite(resistance)) continue;
          const distance = Math.hypot(x + 0.5 - origin[0], y + 0.5 - origin[1], z + 0.5 - origin[2]);
          if (distance > radius) continue;
          const power = 150 * Math.pow(Math.max(0, 1 - distance / radius), 0.58);
          if (power >= resistance) candidates.push({ x, y, z, distance });
        }
      }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    let destroyed = 0;
    for (const block of candidates) {
      if (destroyed >= GRENADE_RULES.maxDestroyedBlocks) break;
      const target = [block.x + 0.5, block.y + 0.5, block.z + 0.5];
      const dx = target[0] - origin[0];
      const dy = target[1] - origin[1];
      const dz = target[2] - origin[2];
      const hit = raycastVoxels(
        (x, y, z) => ctx.getBlock(x, y, z) !== AIR,
        origin[0], origin[1], origin[2], dx, dy, dz,
        block.distance + 0.2,
      );
      if (hit && (hit.x !== block.x || hit.y !== block.y || hit.z !== block.z)) continue;
      if (ctx.destroyBlock(block.x, block.y, block.z)) destroyed++;
    }
  }
}
