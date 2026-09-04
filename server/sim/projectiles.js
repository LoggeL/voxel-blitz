// Room-scoped authoritative projectile simulation: three grenade types, the
// rocket, and the LONGARC bolt. One system owns flight, sticking, detonation,
// blast damage, knockback, concussion, terrain carving, sympathetic (chain)
// detonation, and bolt ricochets so every projectile follows the same rules.

import {
  AIR,
  BLOCK_HP,
  GRENADE_RESISTANCE,
  SX,
  SY,
  SZ,
} from '../../shared/worlddata.js';
import { raycastVoxels } from '../../shared/raycast.js';
import {
  HEADSHOT_Y_FRAC,
  PLAYER_HALF,
  WEAPONS,
  chargeDamageMult,
  damageAtDistance,
} from '../../shared/combatmath.js';
import {
  evHit,
  evProjectileExplode,
  evProjectileLaunch,
  evProjectileStick,
} from '../protocol.js';
import { fwdFromYawPitch, clamp01 } from './player.js';
import {
  GRENADE_TYPES,
  GRENADE_TYPE_IDS,
  clampGrenadeCook,
  clampGrenadeType,
  grenadeFuseAfterCook,
  grenadeLaunch,
  stepGrenade,
} from '../../shared/grenade-rules.js';
import { ROCKET_RULES, rocketLaunch, stepRocket } from '../../shared/rocket-rules.js';
import { BOLT_RULES, boltLaunch, stepBolt } from '../../shared/bolt-rules.js';

const P_HEIGHT = PLAYER_HALF.h * 2;
/** A sticky/impact projectile ignores its own thrower for this long after release. */
const OWNER_GRACE_MS = 220;
/** Chain detonation reaches this fraction of the blast radius. */
const CHAIN_REACH = 0.8;
/** A bolt contact ends in this tiny "blast" — a pop, never a real explosion. */
const BOLT_FIZZLE_RADIUS = 0.5;

/** Blast profile per projectile type, read by tests and the explosion path alike. */
export const PROJECTILE_RULES = Object.freeze({
  frag: GRENADE_TYPES.frag,
  limpet: GRENADE_TYPES.limpet,
  pulse: GRENADE_TYPES.pulse,
  rocket: Object.freeze({
    id: 'rocket',
    name: 'RX-8 HAVOC',
    fuseMs: ROCKET_RULES.lifetimeMs,
    damage: ROCKET_RULES.splashDamage,
    damageRadius: ROCKET_RULES.damageRadius,
    selfDamage: ROCKET_RULES.selfDamage,
    knockback: ROCKET_RULES.knockback,
    selfKnockback: ROCKET_RULES.selfKnockback,
    terrainRadius: ROCKET_RULES.terrainRadius,
    terrainPower: ROCKET_RULES.terrainPower,
    maxDestroyedBlocks: ROCKET_RULES.maxDestroyedBlocks,
    concussMs: 0,
    concussPanic: 0,
    directDamage: ROCKET_RULES.directDamage,
  }),
});

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

function outsideWorld(p) {
  return !finitePoint(p.x, p.y, p.z) ||
    p.y < -2 || p.x < -2 || p.z < -2 || p.x > SX + 2 || p.z > SZ + 2;
}

/** Player AABB overlap test for a sphere of `radius` at the projectile position. */
function touchesPlayer(p, radius, victim) {
  const nx = Math.max(victim.x - PLAYER_HALF.x, Math.min(p.x, victim.x + PLAYER_HALF.x));
  const ny = Math.max(victim.y, Math.min(p.y, victim.y + P_HEIGHT));
  const nz = Math.max(victim.z - PLAYER_HALF.x, Math.min(p.z, victim.z + PLAYER_HALF.x));
  const dx = p.x - nx, dy = p.y - ny, dz = p.z - nz;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

export class ProjectileSystem {
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
      const typeIndex = player.grenadeTypeQueued;
      const cook = player.grenadeCookQueued;
      player.grenadeChargeQueued = 0;
      player.grenadeTypeQueued = 0;
      player.grenadeCookQueued = 0;
      if (player.state !== 'alive' || !ctx.canThrow(player)) continue;
      if (!(player.grenades[typeIndex] > 0)) continue;
      const type = GRENADE_TYPES[GRENADE_TYPE_IDS[typeIndex]];
      if (type.cook && clampGrenadeCook(cook, type) >= type.fuseMs) {
        this.detonateInHand(player, ctx, typeIndex);
      } else {
        this.throw(player, ctx, charge, typeIndex, cook);
      }
    }

    const substeps = 2;
    const stepSeconds = Math.max(0, Math.min(0.05, dt)) / substeps;
    for (const projectile of Array.from(this.active.values())) {
      if (!this.active.has(projectile.id)) continue;
      if (projectile.stuckTo) this._followCarrier(projectile, ctx);
      else if (projectile.type === 'rocket') this._flyRocket(projectile, stepSeconds * substeps, ctx);
      else if (projectile.type === 'bolt') this._flyBolt(projectile, stepSeconds * substeps, ctx);
      else this._flyGrenade(projectile, stepSeconds, substeps, ctx);
      if (!this.active.has(projectile.id)) continue;
      if (ctx.now >= projectile.explodeAt || outsideWorld(projectile)) this.explode(projectile, ctx);
    }
  }

  _flyGrenade(projectile, stepSeconds, substeps, ctx) {
    const type = GRENADE_TYPES[projectile.type];
    for (let i = 0; i < substeps; i++) {
      stepGrenade(projectile, stepSeconds, projectile.isSolid);
      if (type.sticky && !projectile.stuck) {
        const victim = this._contactVictim(projectile, type.physics.radius, ctx);
        if (victim) return this._stick(projectile, ctx, victim);
        if (projectile.hitSolid) return this._stick(projectile, ctx, null);
      } else if (type.impact) {
        const victim = this._contactVictim(projectile, type.physics.radius, ctx);
        if (victim || projectile.hitSolid) return this.explode(projectile, ctx);
      }
    }
    return false;
  }

  _flyRocket(projectile, seconds, ctx) {
    const prev = { x: projectile.x, y: projectile.y, z: projectile.z };
    stepRocket(projectile, seconds, projectile.raycast);
    // Swept body test: sample the segment so a fast rocket cannot skip a player.
    const dx = projectile.x - prev.x, dy = projectile.y - prev.y, dz = projectile.z - prev.z;
    const length = Math.hypot(dx, dy, dz);
    const samples = Math.max(1, Math.ceil(length / 0.35));
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const probe = { x: prev.x + dx * t, y: prev.y + dy * t, z: prev.z + dz * t };
      const victim = this._contactVictim(probe, ROCKET_RULES.radius, ctx, projectile);
      if (victim) {
        projectile.x = probe.x; projectile.y = probe.y; projectile.z = probe.z;
        projectile.directVictim = victim;
        return this.explode(projectile, ctx);
      }
    }
    if (projectile.hit) return this.explode(projectile, ctx);
    return false;
  }

  /**
   * One bolt flies on the shared integrator: every wall contact chips the voxel
   * it bounced from, the first body it touches (never its owner) takes falloff
   * damage measured from the launch point, and a spent bolt always fizzles.
   */
  _flyBolt(projectile, seconds, ctx) {
    const prev = { x: projectile.x, y: projectile.y, z: projectile.z };
    stepBolt(projectile, seconds, projectile.raycast);
    // A ricochet abrades the destructible voxel it bounced from.
    if (projectile.bounced) {
      const type = ctx.getBlock(
        projectile.bounced.x, projectile.bounced.y, projectile.bounced.z,
      );
      if (BLOCK_HP[type] != null && typeof ctx.damageBlock === 'function') {
        ctx.damageBlock(
          projectile.bounced.x, projectile.bounced.y, projectile.bounced.z,
          type, BOLT_RULES.blockDamage,
        );
      }
    }
    // Swept body test: sample the segment so a fast bolt cannot skip a player.
    const dx = projectile.x - prev.x, dy = projectile.y - prev.y, dz = projectile.z - prev.z;
    const length = Math.hypot(dx, dy, dz);
    const samples = Math.max(1, Math.ceil(length / 0.35));
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const probe = { x: prev.x + dx * t, y: prev.y + dy * t, z: prev.z + dz * t };
      const victim = this._contactVictim(probe, BOLT_RULES.radius, ctx, projectile, true);
      if (!victim) continue;
      // A bolt never pierces: the first body it touches ends the flight.
      projectile.x = probe.x; projectile.y = probe.y; projectile.z = probe.z;
      const hs = probe.y - victim.y > HEADSHOT_Y_FRAC * P_HEIGHT;
      const traveled = Math.hypot(
        probe.x - projectile.origin.x,
        probe.y - projectile.origin.y,
        probe.z - projectile.origin.z,
      );
      let dmg = damageAtDistance(WEAPONS.longarc, traveled)
        * chargeDamageMult(WEAPONS.longarc, projectile.charge01);
      if (hs) dmg *= WEAPONS.longarc.headMult;
      dmg = Math.round(dmg * 10) / 10;
      const lethal = victim.takeDamage(dmg, hs);
      ctx.pushEvent(evHit(projectile.ownerId, victim.id, dmg, hs, [probe.x, probe.y, probe.z]));
      if (lethal) ctx.killPlayer(victim, projectile.owner, WEAPONS.longarc.id, hs, {});
      this.active.delete(projectile.id);
      ctx.pushEvent(evProjectileExplode(
        projectile.ownerId,
        projectile.id,
        'bolt',
        [projectile.x, projectile.y, projectile.z],
        BOLT_FIZZLE_RADIUS,
      ));
      return true;
    }
    if (projectile.hit || ctx.now >= projectile.explodeAt || outsideWorld(projectile)) {
      // Reflections spent or lifetime over: the bolt fizzles with no blast.
      this.active.delete(projectile.id);
      ctx.pushEvent(evProjectileExplode(
        projectile.ownerId,
        projectile.id,
        'bolt',
        [projectile.x, projectile.y, projectile.z],
        BOLT_FIZZLE_RADIUS,
      ));
      return true;
    }
    return false;
  }

  _contactVictim(point, radius, ctx, projectile = point, ignoreOwner = false) {
    const owner = projectile.owner;
    const skipOwner = ignoreOwner || ctx.now - projectile.launchedAt < OWNER_GRACE_MS;
    for (const victim of ctx.entities.values()) {
      if (victim.state !== 'alive') continue;
      if (victim === owner && skipOwner) continue;
      if (victim !== owner && !ctx.canDamage(owner, victim)) continue;
      if (touchesPlayer(point, radius, victim)) return victim;
    }
    return null;
  }

  _stick(projectile, ctx, victim) {
    const type = GRENADE_TYPES[projectile.type];
    projectile.stuck = true;
    projectile.vx = projectile.vy = projectile.vz = 0;
    projectile.explodeAt = ctx.now + type.fuseMs;
    if (victim) {
      projectile.stuckTo = victim;
      projectile.stickOffset = {
        x: projectile.x - victim.x,
        y: Math.max(0.3, Math.min(P_HEIGHT - 0.2, projectile.y - victim.y)),
        z: projectile.z - victim.z,
      };
    }
    ctx.pushEvent(evProjectileStick(
      projectile.ownerId,
      projectile.id,
      [projectile.x, projectile.y, projectile.z],
      victim ? victim.id : null,
      type.fuseMs,
    ));
    return true;
  }

  _followCarrier(projectile, ctx) {
    const carrier = projectile.stuckTo;
    if (!carrier || carrier.state !== 'alive' || !ctx.entities.has(String(carrier.id))) {
      // The carrier died or left: the charge drops where it was and keeps its fuse.
      projectile.stuckTo = null;
      return;
    }
    projectile.x = carrier.x + projectile.stickOffset.x;
    projectile.y = carrier.y + projectile.stickOffset.y;
    projectile.z = carrier.z + projectile.stickOffset.z;
  }

  /** Release-edge throw. `typeIndex` selects the grenade; `cookMs` shortens a timed fuse. */
  throw(player, ctx, charge = 0.5, typeIndex = 0, cookMs = 0) {
    const index = clampGrenadeType(typeIndex);
    const type = GRENADE_TYPES[GRENADE_TYPE_IDS[index]];
    const direction = fwdFromYawPitch(player.yaw, player.pitch);
    const launch = grenadeLaunch({
      x: player.x, y: player.y, z: player.z, eyeY: player.eyeY,
      vx: player.vx, vy: player.vy, vz: player.vz,
      dir: direction, charge, type: type.id,
    });
    const fuseMs = type.cook
      ? grenadeFuseAfterCook(cookMs, type)
      : (type.sticky ? type.flightMaxMs : type.fuseMs);
    const id = `g${this._nextId++}`;
    const projectile = {
      id,
      type: type.id,
      ownerId: String(player.id),
      owner: player,
      x: launch.x, y: launch.y, z: launch.z,
      vx: launch.vx, vy: launch.vy, vz: launch.vz,
      charge: launch.charge,
      launchedAt: ctx.now,
      explodeAt: ctx.now + fuseMs,
      stuck: false,
      stuckTo: null,
      stickOffset: null,
      hitSolid: false,
      isSolid: (x, y, z) => solid(ctx, x, y, z),
    };
    player.grenades[index]--;
    player.spawnProtectedUntil = 0;
    player.spawnProtected = false;
    this.active.set(id, projectile);
    ctx.pushEvent(evProjectileLaunch(
      player.id,
      id,
      type.id,
      [projectile.x, projectile.y, projectile.z],
      [projectile.vx, projectile.vy, projectile.vz],
      fuseMs,
    ));
    return projectile;
  }

  /** A fuse cooked to the end: the grenade goes off in the thrower's hand. */
  detonateInHand(player, ctx, typeIndex = 0) {
    const index = clampGrenadeType(typeIndex);
    const type = GRENADE_TYPES[GRENADE_TYPE_IDS[index]];
    const id = `g${this._nextId++}`;
    const projectile = {
      id,
      type: type.id,
      ownerId: String(player.id),
      owner: player,
      x: player.x, y: player.eyeY - 0.2, z: player.z,
      vx: 0, vy: 0, vz: 0,
      charge: 0,
      launchedAt: ctx.now,
      explodeAt: ctx.now,
      stuck: true,
      stuckTo: null,
      stickOffset: null,
      hitSolid: false,
      isSolid: (x, y, z) => solid(ctx, x, y, z),
    };
    player.grenades[index]--;
    player.spawnProtectedUntil = 0;
    player.spawnProtected = false;
    this.active.set(id, projectile);
    ctx.pushEvent(evProjectileLaunch(
      player.id, id, type.id,
      [projectile.x, projectile.y, projectile.z], [0, 0, 0], 0,
    ));
    this.explode(projectile, ctx);
    return projectile;
  }

  /** A rocket leaves the tube from the shooter's eye along the spread-sampled `dir`. */
  launchRocket(player, ctx, dir) {
    const launch = rocketLaunch({ x: player.x, y: player.eyeY, z: player.z, dir });
    const id = `r${this._nextId++}`;
    const projectile = {
      id,
      type: 'rocket',
      ownerId: String(player.id),
      owner: player,
      x: launch.x, y: launch.y, z: launch.z,
      vx: launch.vx, vy: launch.vy, vz: launch.vz,
      launchedAt: ctx.now,
      explodeAt: ctx.now + ROCKET_RULES.lifetimeMs,
      stuck: false,
      stuckTo: null,
      hit: null,
      directVictim: null,
      raycast: (ox, oy, oz, dx, dy, dz, max) => raycastVoxels(
        (x, y, z) => ctx.getBlock(x, y, z) !== AIR, ox, oy, oz, dx, dy, dz, max,
      ),
    };
    this.active.set(id, projectile);
    ctx.pushEvent(evProjectileLaunch(
      player.id,
      id,
      'rocket',
      [projectile.x, projectile.y, projectile.z],
      [projectile.vx, projectile.vy, projectile.vz],
      ROCKET_RULES.lifetimeMs,
    ));
    return projectile;
  }

  /** A bolt leaves the coil from the shooter's eye along the spread-sampled `dir`. */
  launchBolt(player, ctx, dir, charge01 = 1) {
    const launch = boltLaunch({ x: player.x, y: player.eyeY, z: player.z, dir, charge01 });
    const id = `b${this._nextId++}`;
    const projectile = {
      id,
      type: 'bolt',
      ownerId: String(player.id),
      owner: player,
      x: launch.x, y: launch.y, z: launch.z,
      vx: launch.vx, vy: launch.vy, vz: launch.vz,
      charge01: Math.max(0, Math.min(1, Number.isFinite(charge01) ? charge01 : 1)),
      bouncesLeft: launch.bouncesLeft,
      launchedAt: ctx.now,
      explodeAt: ctx.now + BOLT_RULES.lifetimeMs,
      hit: null,
      bounced: null,
      // Falloff is measured from the launch point, so post-bounce hits decay.
      origin: { x: launch.x, y: launch.y, z: launch.z },
      raycast: (ox, oy, oz, dx, dy, dz, max) => raycastVoxels(
        (x, y, z) => ctx.getBlock(x, y, z) !== AIR, ox, oy, oz, dx, dy, dz, max,
      ),
    };
    this.active.set(id, projectile);
    ctx.pushEvent(evProjectileLaunch(
      player.id,
      id,
      'bolt',
      [projectile.x, projectile.y, projectile.z],
      [projectile.vx, projectile.vy, projectile.vz],
      BOLT_RULES.lifetimeMs,
      projectile.bouncesLeft,
    ));
    return projectile;
  }

  explode(projectile, ctx) {
    if (!this.active.delete(projectile.id)) return false;
    const rules = PROJECTILE_RULES[projectile.type] || PROJECTILE_RULES.frag;
    const origin = [projectile.x, projectile.y, projectile.z];
    const owner = projectile.owner || ctx.entities.get(projectile.ownerId) || null;
    const ownerId = owner?.id == null ? projectile.ownerId : String(owner.id);
    ctx.pushEvent(evProjectileExplode(
      ownerId,
      projectile.id,
      projectile.type,
      origin,
      rules.damageRadius,
    ));
    if (typeof ctx.canAffectWorld === 'function' && !ctx.canAffectWorld()) return true;
    this._damagePlayers(owner, origin, rules, projectile, ctx);
    if (rules.terrainRadius > 0) this._destroyTerrain(origin, rules, ctx);
    this._chainDetonate(projectile, origin, rules, ctx);
    return true;
  }

  _damagePlayers(owner, origin, rules, projectile, ctx) {
    const weaponKey = projectile.type;
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
      const direct = projectile.directVictim === victim
        || (projectile.stuckTo === victim && !isSelf);
      if (!direct && (distance >= rules.damageRadius || !visibleTo(ctx, origin, target))) continue;
      const falloff = direct
        ? 1
        : Math.pow(1 - distance / rules.damageRadius, 1.22);
      let damage = rules.damage * falloff;
      if (direct && Number.isFinite(rules.directDamage)) damage += rules.directDamage;
      damage = Math.round(damage * (isSelf ? rules.selfDamage : 1) * 10) / 10;
      if (damage <= 0) continue;
      const lethal = victim.takeDamage(damage, false);
      ctx.pushEvent(evHit(owner?.id || '', victim.id, damage, false, target));
      const strength = isSelf && Number.isFinite(rules.selfKnockback)
        ? rules.selfKnockback
        : rules.knockback;
      const impulse = Math.max(0, strength * falloff);
      const invDistance = distance > 0.01 ? 1 / distance : 0;
      victim.vx += dx * invDistance * impulse;
      victim.vy += Math.max(0.8, dy * invDistance + 0.35) * impulse;
      victim.vz += dz * invDistance * impulse;
      if (rules.concussMs > 0 && !isSelf) {
        victim.concussedUntil = Math.max(victim.concussedUntil || 0, ctx.now + rules.concussMs);
        victim.panic = clamp01(victim.panic + rules.concussPanic * falloff);
      }
      if (lethal) ctx.killPlayer(victim, owner, weaponKey, false, null);
    }
  }

  _destroyTerrain(origin, rules, ctx) {
    const radius = rules.terrainRadius;
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
          const power = rules.terrainPower * Math.pow(Math.max(0, 1 - distance / radius), 0.58);
          if (power >= resistance) candidates.push({ x, y, z, distance });
        }
      }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    let destroyed = 0;
    for (const block of candidates) {
      if (destroyed >= rules.maxDestroyedBlocks) break;
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

  /** Any other live explosive inside the blast (with line of sight) goes off next tick. */
  _chainDetonate(source, origin, rules, ctx) {
    const reach = rules.damageRadius * CHAIN_REACH;
    for (const other of this.active.values()) {
      if (other === source || other.explodeAt <= ctx.now) continue;
      const distance = Math.hypot(other.x - origin[0], other.y - origin[1], other.z - origin[2]);
      if (distance > reach) continue;
      if (!visibleTo(ctx, origin, [other.x, other.y, other.z])) continue;
      other.explodeAt = ctx.now;
      other.chained = true;
    }
  }
}
