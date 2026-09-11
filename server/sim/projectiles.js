import { combatDamage } from '../../shared/combat-balance.js';
import { collectNearMisses, applyNearMisses, suppressExplosion } from './suppression.js';
import { pointPlayerDistance } from '../../shared/player-hitboxes.js';
import { chaosLevel } from '../../shared/chaos.js';
// Room-scoped authoritative projectile simulation: four throwable types, the
// rocket, and the LONGARC bolt. One system owns flight, sticking, detonation,
// blast damage, knockback, concussion, terrain carving, sympathetic (chain)
// detonation, and bolt ricochets so every projectile follows the same rules.

import {
  AIR,
  BLOCK_HP,
  GRENADE_RESISTANCE,
  worldDimensions,
} from '../../shared/worlddata.js';
import { raycastVoxels } from '../../shared/raycast.js';
import {
  PLAYER_HALF,
  WEAPONS,
  chargeDamageMult,
  damageAtDistance,
} from '../../shared/combatmath.js';
import {
  evHit,
  evProjectileExplode,
  evProjectileLaunch,
  evProjectileUpdate,
  evProjectileStick,
} from '../protocol/events.js';
import { fwdFromYawPitch } from './player.js';
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
import { sweepPlayers } from './projectile-contact.js';
import { SmokeSystem } from './smoke.js';
import { MolotovFireSystem } from './molotov-fire.js';
import { CLAYMORE_RULES, placeClaymore, claymoreProfile, claymoreBeam, crossesClaymore } from '../../shared/claymore-rules.js';

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
  molotov: GRENADE_TYPES.molotov,
  smoke: GRENADE_TYPES.smoke,
  rocket: Object.freeze({
    id: 'rocket',
    name: 'RX-8 HAVOC',
    fuseMs: ROCKET_RULES.lifetimeMs,
    damage: ROCKET_RULES.splashDamage,
    damageRadius: ROCKET_RULES.damageRadius,
    selfDamage: ROCKET_RULES.selfDamage,
    knockback: ROCKET_RULES.knockback,
    selfKnockback: ROCKET_RULES.selfKnockback,
    knockbackFalloff: ROCKET_RULES.knockbackFalloff,
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
    ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== AIR),
    origin[0], origin[1], origin[2], dx, dy, dz,
    distance - endMargin,
  );
}

function outsideWorld(p, ctx) {
  const { sx: SX, sz: SZ } = worldDimensions(ctx);
  return !finitePoint(p.x, p.y, p.z) ||
    p.y < -2 || p.x < -2 || p.z < -2 || p.x > SX + 2 || p.z > SZ + 2;
}

/** Sphere contact against the same body zones used by hitscan and bolts. */
function touchesPlayer(p, radius, victim) {
  return pointPlayerDistance([p.x, p.y, p.z], victim) <= radius;
}

export class ProjectileSystem {
  constructor() {
    this.active = new Map();
    this.fire = new MolotovFireSystem();
    this.smoke = new SmokeSystem();
    this._nextId = 1;
    this._homingCandidates = [];
    this._stepping = [];
    this._previousPlayers = new Map();
  }

  clear() {
    this.active.clear();
    this.fire.clear();
    this.smoke.clear();
    this._previousPlayers.clear();
  }

  step(dt, ctx) {
    this.fire.step(dt, ctx);
    this.smoke.step(ctx);
    for (const player of ctx.entities.values()) {
      if (!player.grenadeEdgeQueued) continue;
      player.grenadeEdgeQueued = false;
      const charge = player.grenadeChargeQueued;
      const typeIndex = player.grenadeTypeQueued;
      const cook = player.grenadeCookQueued;
      const aim = player.grenadeAimQueued;
      player.grenadeChargeQueued = 0;
      player.grenadeTypeQueued = 0;
      player.grenadeCookQueued = 0;
      player.grenadeAimQueued = null;
      if (player.state !== 'alive' || !ctx.canThrow(player)) continue;
      if (!(player.grenades[typeIndex] > 0)) continue;
      const type = GRENADE_TYPES[GRENADE_TYPE_IDS[typeIndex]];
      if (type.cook && clampGrenadeCook(cook, type) >= type.fuseMs) {
        this.detonateInHand(player, ctx, typeIndex);
      } else {
        this.throw(player, ctx, charge, typeIndex, cook, aim);
      }
    }

    const substeps = 2;
    const stepSeconds = Math.max(0, Math.min(0.05, dt)) / substeps;
    // Snapshot membership before flight: an explosion can delete siblings and
    // spawn children, whose first integration belongs to the following tick.
    const stepping = this._stepping;
    stepping.length = 0;
    for (const projectile of this.active.values()) stepping.push(projectile);
    for (const projectile of stepping) {
      if (!this.active.has(projectile.id)) continue;
      if (projectile.type === 'limpet') {
        this._stepClaymore(projectile, ctx);
        continue;
      }
      if (projectile.chaosHoming && !projectile.stuck) this._home(projectile, dt, ctx);
      if (projectile.type === 'pulse' && projectile.chaosLevel >= 1 && !projectile.child) this._pull(projectile, dt, ctx);
      if (projectile.stuckTo) this._followCarrier(projectile, ctx);
      else if (projectile.type === 'rocket') this._flyRocket(projectile, stepSeconds * substeps, ctx);
      else if (projectile.type === 'bolt') this._flyBolt(projectile, stepSeconds * substeps, ctx);
      else this._flyGrenade(projectile, stepSeconds, substeps, ctx);
      if (!this.active.has(projectile.id)) continue;
      if (projectile.chaosLevel && ctx.now >= (projectile.syncAt || 0)) {
        projectile.syncAt = ctx.now + 100;
        ctx.pushEvent(evProjectileUpdate(projectile.id,
          [projectile.x, projectile.y, projectile.z],
          [projectile.vx, projectile.vy, projectile.vz], projectile.bouncesLeft));
      }
      if (ctx.now >= projectile.explodeAt || outsideWorld(projectile, ctx)) this.explode(projectile, ctx);
    }
    stepping.length = 0;
    this._previousPlayers.clear();
    for (const p of ctx.entities.values()) {
      if (p.state === 'alive') this._previousPlayers.set(p.id, { x: p.x, y: p.y, z: p.z, now: ctx.now });
    }
  }

  _stepClaymore(mine, ctx) {
    if (ctx.now >= mine.explodeAt) return this.explode(mine, ctx);
    if (!mine.mount || ctx.getBlock(...mine.mount) === AIR) {
      this.active.delete(mine.id);
      return;
    }
    if (ctx.now < mine.armedAt || (ctx.canAffectWorld && !ctx.canAffectWorld())) return;
    const beam = claymoreBeam(mine, ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== AIR));
    for (const victim of ctx.entities.values()) {
      if (victim === mine.owner || victim.state !== 'alive' || victim.spawnProtectedUntil > ctx.now
        || !ctx.canDamage(mine.owner, victim)) continue;
      const previous = this._previousPlayers.get(victim.id);
      if (crossesClaymore(beam, victim, previous?.now >= mine.armedAt ? previous : null)) {
        return this.explode(mine, ctx);
      }
    }
  }

  _placeClaymore(player, ctx, direction, index) {
    const placement = placeClaymore({ x: player.x, eyeY: player.eyeY, z: player.z, dir: direction },
      ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== AIR));
    if (!placement || !(player.grenades[index] > 0)) return null;
    const owned = [...this.active.values()].filter(p => p.type === 'limpet' && p.ownerId === String(player.id));
    if (owned.length >= CLAYMORE_RULES.maxPerOwner) this.active.delete(owned[0].id);
    const level = chaosLevel(player, 'limpet');
    const profile = claymoreProfile(level);
    const mine = { ...placement, id: `g${this._nextId++}`, ownerId: String(player.id), owner: player,
      stuck: true, launchedAt: ctx.now, armedAt: ctx.now + profile.armMs,
      explodeAt: Infinity, laserRange: profile.laserRange, chaosLevel: level };
    player.grenades[index]--;
    player.spawnProtectedUntil = 0;
    player.spawnProtected = false;
    this.active.set(mine.id, mine);
    ctx.pushEvent(this._claymoreRow(mine, ctx.now));
    return mine;
  }

  _claymoreRow(mine, now) {
    return { ...evProjectileLaunch(mine.ownerId, mine.id, 'limpet', [mine.x, mine.y, mine.z], [0, 0, 0], 0),
      n: [...mine.n], armMs: Math.max(0, mine.armedAt - now), laserRange: mine.laserRange, chaos: mine.chaosLevel };
  }

  /** Full persistent mine state also reaches players who join after placement. */
  mineSnapshot(now) {
    return [...this.active.values()].filter(p => p.type === 'limpet' && p.mount)
      .map(p => this._claymoreRow(p, now));
  }

  _flyGrenade(projectile, stepSeconds, substeps, ctx) {
    const type = GRENADE_TYPES[projectile.type];
    for (let i = 0; i < substeps; i++) {
      stepGrenade(projectile, stepSeconds, projectile.isSolid);
      if (type.sticky && !projectile.stuck) {
        const victim = this._contactVictim(projectile, type.physics.radius, ctx);
        if (victim) return this._stick(projectile, ctx, victim);
        if (projectile.hitSolid) return this._stick(projectile, ctx, null);
      } else if (type.impact && !(projectile.child && projectile.type === 'pulse')) {
        const victim = this._contactVictim(projectile, type.physics.radius, ctx);
        if (victim || projectile.hitSolid) return this.explode(projectile, ctx);
      }
    }
    return false;
  }

  _flyRocket(projectile, seconds, ctx) {
    const prev = { x: projectile.x, y: projectile.y, z: projectile.z };
    stepRocket(projectile, seconds, projectile.raycast);
    const contact = this._sweepVictim(prev, projectile, ROCKET_RULES.radius, ctx, projectile);
    if (contact) {
      projectile.x = contact.x; projectile.y = contact.y; projectile.z = contact.z;
      projectile.directVictim = contact.victim;
      return this.explode(projectile, ctx);
    }
    if (projectile.hit) return this.explode(projectile, ctx);
    return false;
  }

  /**
   * One bolt flies on the shared integrator: every wall contact chips the voxel
   * it bounced from, the first body it touches (never its owner) takes falloff
   * damage measured along its entire flight path, and a spent bolt always fizzles.
   */
  _flyBolt(projectile, seconds, ctx) {
    stepBolt(projectile, seconds, projectile.raycast, {
      onTravel: (from, to) => {
        const contact = this._sweepVictim(from, to, BOLT_RULES.radius, ctx, projectile, true);
        const end = contact || to;
        applyNearMisses(collectNearMisses(projectile.owner,
          [from.x, from.y, from.z], [end.x, end.y, end.z], ctx),
          contact ? new Set([contact.victim]) : null, ctx);
        if (!contact) return false;
        const { victim, x, y, z } = contact;
        const traveled = (projectile.traveled || 0) + Math.hypot(x - from.x, y - from.y, z - from.z);
        projectile.x = x; projectile.y = y; projectile.z = z;
        const hs = contact.zone === 'head';
        let dmg = damageAtDistance(WEAPONS.longarc, traveled)
          * chargeDamageMult(WEAPONS.longarc, projectile.charge01);
        if (hs) dmg *= WEAPONS.longarc.headMult;
        dmg = combatDamage(Math.round(dmg * 10) / 10);
        const lethal = victim.takeDamage(dmg, hs);
        ctx.pushEvent(evHit(projectile.ownerId, victim.id, dmg, hs, [x, y, z], victim.lastDamage));
        if (lethal) ctx.killPlayer(victim, projectile.owner, WEAPONS.longarc.id, hs, {});
        this._fizzleBolt(projectile, ctx);
        return true;
      },
      onBounce: (contact) => {
        if (typeof ctx.canAffectWorld === 'function' && !ctx.canAffectWorld()) return;
        if (projectile.chaosLevel >= 3) this.chaosBlast(projectile.owner, [projectile.x, projectile.y, projectile.z], 'pulse', 3, 25, 12, ctx);
        const type = ctx.getBlock(contact.x, contact.y, contact.z);
        if (BLOCK_HP[type] != null) {
          ctx.damageBlock?.(contact.x, contact.y, contact.z, type, BOLT_RULES.blockDamage);
        }
      },
    });
    if (!this.active.has(projectile.id)) return true;
    if (projectile.hit || ctx.now >= projectile.explodeAt || outsideWorld(projectile, ctx)) {
      return this._fizzleBolt(projectile, ctx);
    }
    return false;
  }

  _fizzleBolt(projectile, ctx) {
    if (!this.active.delete(projectile.id)) return false;
    ctx.pushEvent(evProjectileExplode(projectile.ownerId, projectile.id, 'bolt',
      [projectile.x, projectile.y, projectile.z], BOLT_FIZZLE_RADIUS));
    return true;
  }

  _canContact(victim, projectile, ctx, ignoreOwner = false) {
    if (victim.state !== 'alive') return false;
    if (victim === projectile.owner) {
      return !ignoreOwner && ctx.now - projectile.launchedAt >= OWNER_GRACE_MS;
    }
    return ctx.canDamage(projectile.owner, victim);
  }

  _sweepVictim(from, to, radius, ctx, projectile, ignoreOwner = false) {
    return sweepPlayers(from, to, radius, ctx.targets || ctx.entities,
      (victim) => this._canContact(victim, projectile, ctx, ignoreOwner));
  }

  _contactVictim(point, radius, ctx, projectile = point, ignoreOwner = false) {
    for (const victim of (ctx.targets || ctx.entities).values()) {
      if (!this._canContact(victim, projectile, ctx, ignoreOwner)) continue;
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
  throw(player, ctx, charge = 0.5, typeIndex = 0, cookMs = 0, aim = null) {
    if (this.active.size >= 192) return null;
    const index = clampGrenadeType(typeIndex);
    const type = GRENADE_TYPES[GRENADE_TYPE_IDS[index]];
    const direction = fwdFromYawPitch(aim?.yaw ?? player.yaw, aim?.pitch ?? player.pitch);
    if (type.wallMine) return this._placeClaymore(player, ctx, direction, index);
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
    this._configureChaos(projectile);
    this.active.set(id, projectile);
    ctx.pushEvent(Object.assign(evProjectileLaunch(
      player.id,
      id,
      type.id,
      [projectile.x, projectile.y, projectile.z],
      [projectile.vx, projectile.vy, projectile.vz],
      fuseMs,
    ), { chaos: projectile.chaosLevel || 0 }));
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
    this._configureChaos(projectile);
    this.active.set(id, projectile);
    ctx.pushEvent(Object.assign(evProjectileLaunch(
      player.id, id, type.id,
      [projectile.x, projectile.y, projectile.z], [0, 0, 0], 0,
    ), { chaos: projectile.chaosLevel || 0 }));
    this.explode(projectile, ctx);
    return projectile;
  }

  /** A rocket leaves the tube from the shooter's eye along the spread-sampled `dir`. */
  launchRocket(player, ctx, dir) {
    if (this.active.size >= 192) return null;
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
        ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== AIR), ox, oy, oz, dx, dy, dz, max,
      ),
    };
    this._configureChaos(projectile);
    this.active.set(id, projectile);
    ctx.pushEvent(Object.assign(evProjectileLaunch(
      player.id,
      id,
      'rocket',
      [projectile.x, projectile.y, projectile.z],
      [projectile.vx, projectile.vy, projectile.vz],
      ROCKET_RULES.lifetimeMs,
    ), { chaos: projectile.chaosLevel || 0 }));
    return projectile;
  }

  /** A bolt leaves the coil from the shooter's eye along the spread-sampled `dir`. */
  launchBolt(player, ctx, dir, charge01 = 1, satellite = false) {
    if (this.active.size >= 192) return null;
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
      // Accumulated path length includes every reflection for damage falloff.
      traveled: 0,
      raycast: (ox, oy, oz, dx, dy, dz, max) => raycastVoxels(
        ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== AIR), ox, oy, oz, dx, dy, dz, max,
      ),
    };
    this._configureChaos(projectile);
    this.active.set(id, projectile);
    ctx.pushEvent(Object.assign(evProjectileLaunch(
      player.id,
      id,
      'bolt',
      [projectile.x, projectile.y, projectile.z],
      [projectile.vx, projectile.vy, projectile.vz],
      BOLT_RULES.lifetimeMs,
      projectile.bouncesLeft,
    ), { chaos: projectile.chaosLevel || 0 }));
    if (!satellite && chaosLevel(player, 'longarc') >= 2 && player.def.id === 'longarc') {
      for (const angle of [-0.18, 0.18]) this.launchBolt(player, ctx, {
        x: dir.x * Math.cos(angle) - dir.z * Math.sin(angle), y: dir.y,
        z: dir.x * Math.sin(angle) + dir.z * Math.cos(angle),
      }, charge01, true);
    }
    return projectile;
  }

  _configureChaos(projectile) {
    if (projectile.child) return;
    const p = projectile.owner;
    projectile.chaosLevel = chaosLevel(p, projectile.type === 'bolt' ? 'longarc' : projectile.type);
    if (projectile.type === 'bolt' && p?.chaosUpgrades && (projectile.chaosLevel > 0 || p.def.id !== 'longarc')) {
      projectile.chaosLevel = Math.max(1, projectile.chaosLevel);
      projectile.bouncesLeft = 8;
    }
    projectile.chaosHoming = (projectile.type === 'rocket' && (projectile.chaosLevel >= 2
      || chaosLevel(p, 'smg') >= 3 && p.def.id === 'smg'
      || chaosLevel(p, 'lmg') >= 3 && p.def.id === 'lmg'));
    if (projectile.chaosHoming) projectile.chaosLevel = Math.max(1, projectile.chaosLevel);
  }

  _home(projectile, dt, ctx) {
    const speed = Math.hypot(projectile.vx, projectile.vy, projectile.vz);
    if (speed < 0.1) return;
    const candidates = this._homingCandidates;
    candidates.length = 0;
    for (const v of ctx.entities.values()) {
      if (v === projectile.owner || v.state !== 'alive' || !ctx.canDamage(projectile.owner, v)) continue;
      const dx = v.x - projectile.x, dy = v.y + 1 - projectile.y, dz = v.z - projectile.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 0.01 || d2 >= 42 * 42) continue;
      const d = Math.sqrt(d2);
      if ((dx * projectile.vx + dy * projectile.vy + dz * projectile.vz) / (d * speed) < 0.15) continue;
      candidates.push({ v, dx, dy, dz, d });
    }
    // The nearest visible candidate wins. Near-first traversal avoids raycasting
    // every progressively closer enemy; stable sorting preserves distance ties.
    candidates.sort((a, b) => a.d - b.d);
    for (const { v, dx, dy, dz, d } of candidates) {
      if (!visibleTo(ctx, [projectile.x, projectile.y, projectile.z], [v.x, v.y + 1, v.z])) continue;
      const t = Math.min(1, Math.max(0, dt) * 5);
      const x = projectile.vx / speed * (1 - t) + dx / d * t;
      const y = projectile.vy / speed * (1 - t) + dy / d * t;
      const z = projectile.vz / speed * (1 - t) + dz / d * t;
      const scale = speed / (Math.hypot(x, y, z) || 1);
      projectile.vx = x * scale; projectile.vy = y * scale; projectile.vz = z * scale;
      break;
    }
    candidates.length = 0;
  }

  _pull(projectile, dt, ctx) {
    for (const v of ctx.entities.values()) {
      if (v === projectile.owner || v.state !== 'alive' || !ctx.canDamage(projectile.owner, v)) continue;
      const dx = projectile.x - v.x, dy = projectile.y - (v.y + 1), dz = projectile.z - v.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance < 0.5 || distance > 9 || !visibleTo(ctx, [projectile.x, projectile.y, projectile.z], [v.x, v.y + 1, v.z])) continue;
      const force = Math.min(0.05, Math.max(0, dt)) * 32 / distance;
      v.vx += dx * force; v.vy += Math.max(0.15, dy) * force; v.vz += dz * force;
      v.impulseSeq = (v.impulseSeq || 0) + 1; v.grounded = false; v.vault = null;
    }
  }

  _scatter(source, count, ctx) {
    const type = source.type === 'rocket' ? 'frag' : source.type;
    for (let i = 0; i < count && this.active.size < 192; i++) {
      const angle = i / count * Math.PI * 2;
      const id = `g${this._nextId++}`;
      const child = { ...source, id, type, child: true, stuck: false, stuckTo: null,
        stickOffset: null, hitSolid: false, directVictim: null, chained: false,
        x: source.x, y: source.y + 0.2, z: source.z,
        vx: Math.cos(angle) * (count > 6 ? 10 : 7), vy: 8 + i % 3, vz: Math.sin(angle) * (count > 6 ? 10 : 7),
        launchedAt: ctx.now, explodeAt: ctx.now + (type === 'frag' ? 1500 : 700) + i * 65,
        chaosHoming: false,
        isSolid: (x, y, z) => solid(ctx, x, y, z),
      };
      this.active.set(id, child);
      ctx.pushEvent(Object.assign(evProjectileLaunch(child.ownerId, id, type,
        [child.x, child.y, child.z], [child.vx, child.vy, child.vz], child.explodeAt - ctx.now),
        { chaos: child.chaosLevel, child: true }));
    }
  }

  chaosBlast(owner, origin, type, radius, damage, knockback, ctx) {
    const id = `c${this._nextId++}`;
    const projectile = { id, type, owner, ownerId: String(owner.id),
      x: origin[0], y: origin[1], z: origin[2], child: true,
      blastRules: { ...PROJECTILE_RULES[type], damageRadius: radius, damage,
        knockback, terrainRadius: 0, selfDamage: 0, selfKnockback: 0 } };
    this.active.set(id, projectile);
    return this.explode(projectile, ctx);
  }

  explode(projectile, ctx) {
    if (projectile.type === 'bolt') return this._fizzleBolt(projectile, ctx);
    if (!this.active.delete(projectile.id)) return false;
    const baseRules = PROJECTILE_RULES[projectile.type] || PROJECTILE_RULES.frag;
    const level = projectile.chaosLevel || 0;
    const giant = projectile.type === 'rocket' && level >= 1;
    const rules = projectile.blastRules || { ...baseRules,
      damageRadius: baseRules.damageRadius * (giant ? 1.8 : projectile.type === 'limpet' && level >= 3 ? 1.3 : projectile.child && level >= 3 ? 1.3 : 1),
      damage: baseRules.damage * (projectile.type === 'limpet' && level >= 3 ? 1.3 : 1),
      terrainRadius: Math.min(7, baseRules.terrainRadius * (giant ? 1.7 : level >= 3 ? 1.4 : 1)),
      selfKnockback: projectile.type === 'pulse' && level >= 2 ? 64 : baseRules.selfKnockback,
      knockback: projectile.type === 'pulse' && level >= 2 ? 64 : baseRules.knockback * (level >= 3 ? 1.8 : 1),
    };
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
    if (projectile.type === 'smoke') {
      this.smoke.deploy(projectile, ctx);
      return true;
    }
    if (projectile.type === 'molotov') {
      this.fire.ignite(projectile, ctx);
      return true;
    }
    const hitVictims = new Set();
    this._damagePlayers(owner, origin, rules, projectile, ctx, hitVictims);
    if (ctx.grenadeDamage !== false || projectile.type === 'rocket' || projectile.type === 'pulse') {
      suppressExplosion(owner, origin, rules.damageRadius, hitVictims, ctx);
    }
    if (rules.terrainRadius > 0) this._destroyTerrain(origin, rules, ctx);
    this._chainDetonate(projectile, origin, rules, ctx);
    if (!projectile.child) {
      const count = projectile.type === 'frag' && level >= 1 ? (level >= 2 ? 12 : 6)
        : projectile.type === 'rocket' && level >= 3 ? 6
        : projectile.type === 'pulse' && level >= 3 ? 8 : 0;
      if (count) this._scatter(projectile, count, ctx);
    }
    return true;
  }

  _damagePlayers(owner, origin, rules, projectile, ctx, hitVictims = new Set()) {
    const damageEnabled = ctx.grenadeDamage !== false || projectile.type === 'rocket';
    if (!damageEnabled && projectile.type !== 'pulse') return;
    const weaponKey = projectile.type;
    for (const victim of (ctx.targets || ctx.entities).values()) {
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
      // NPC rockets retain the real flight/blast/terrain simulation, with a
      // readable 70-damage attack instead of the player rocket's lethal impact.
      if (owner?.npcRole === 'breacher' && projectile.type === 'rocket') damage = 70 * falloff;
      damage = Math.round(damage * (isSelf ? rules.selfDamage : 1) * 10) / 10;
      let lethal = false;
      if (damageEnabled && damage > 0) {
        hitVictims.add(victim);
        damage = combatDamage(damage);
        lethal = victim.takeDamage(damage, false, owner);
        ctx.pushEvent(evHit(owner?.id || '', victim.id, damage, false, target, victim.lastDamage));
      }
      const strength = victim.objective ? 0 : isSelf && Number.isFinite(rules.selfKnockback)
        ? rules.selfKnockback
        : rules.knockback;
      // Pressure falls off more gently than damage for displacement-focused blasts.
      const pressure = direct ? 1 : Math.pow(Math.max(0, 1 - distance / rules.damageRadius),
        rules.knockbackFalloff ?? 1.22);
      const impulse = Math.max(0, strength * pressure);
      const invDistance = distance > 0.01 ? 1 / distance : 0;
      if (impulse > 0) {
        // A grounded acceleration step or an in-progress vault must not swallow the launch.
        victim.impulseSeq = (victim.impulseSeq || 0) + 1;
        victim.grounded = false;
        victim.coyote = 0;
        victim.vault = null;
        victim.jumpGroundY = null;
      }
      victim.vx += dx * invDistance * impulse;
      victim.vy += Math.max(0.8, dy * invDistance + 0.35) * impulse;
      victim.vz += dz * invDistance * impulse;
      if (projectile.type === 'pulse' && projectile.chaosLevel >= 2 && impulse > 0) victim.vy = Math.max(victim.vy, impulse);
      if (rules.concussMs > 0 && !isSelf) {
        victim.concussedUntil = Math.max(victim.concussedUntil || 0, ctx.now + rules.concussMs);
        // The ambient blast pass provides bounded panic for uninjured targets.
        // Injured targets already receive panic through takeDamage.
      }
      if (lethal) ctx.killPlayer(victim, owner, weaponKey, false, null);
    }
  }

  _destroyTerrain(origin, rules, ctx) {
    const { sx: SX, sy: SY, sz: SZ } = worldDimensions(ctx);
    const radius = rules.terrainRadius;
    const radiusSquared = radius * radius;
    const candidates = [];
    const solidAt = ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== AIR);
    const minX = Math.max(0, Math.floor(origin[0] - radius));
    const maxX = Math.min(SX - 1, Math.ceil(origin[0] + radius));
    const minY = Math.max(1, Math.floor(origin[1] - radius));
    const maxY = Math.min(SY - 1, Math.ceil(origin[1] + radius));
    const minZ = Math.max(0, Math.floor(origin[2] - radius));
    const maxZ = Math.min(SZ - 1, Math.ceil(origin[2] + radius));
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const dx = x + 0.5 - origin[0], dy = y + 0.5 - origin[1], dz = z + 0.5 - origin[2];
          // Reject the bounding cube's corners before touching world storage.
          // Keep the original distance calculation for ordering and damage.
          if (dx * dx + dy * dy + dz * dz > radiusSquared + 1e-9) continue;
          const type = ctx.getBlock(x, y, z);
          const resistance = GRENADE_RESISTANCE[type];
          if (!Number.isFinite(resistance)) continue;
          const distance = Math.hypot(dx, dy, dz);
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
        solidAt,
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
      if (other === source || other.type === 'bolt' || other.explodeAt <= ctx.now) continue;
      const distance = Math.hypot(other.x - origin[0], other.y - origin[1], other.z - origin[2]);
      if (distance > reach) continue;
      if (!visibleTo(ctx, origin, [other.x, other.y, other.z])) continue;
      other.explodeAt = ctx.now;
      other.chained = true;
    }
  }
}
