import { combatDamage } from '../../shared/combat-balance.js';
import { collectNearMisses, applyNearMisses, suppressExplosion } from './suppression.js';
import { pointPlayerDistance, rayPlayerHitboxes } from '../../shared/player-hitboxes.js';
import { chaosLevel, chaosWeaponDef } from '../../shared/chaos.js';
import { chaosGlaiveContact } from './chaos-combat.js';
// Room-scoped authoritative projectile simulation: five throwable types, the
// rocket, the LONGARC bolt and the RIPTIDE disc. One system owns flight, claymore
// mounting, detonation, blast damage, knockback, concussion, terrain carving,
// sympathetic (chain) detonation, bolt ricochets and disc returns so every
// projectile follows the same rules.

import {
  AIR,
  BLOCK_HP,
  GRENADE_RESISTANCE,
  worldDimensions,
} from '../../shared/worlddata.js';
import { raycastVoxels } from '../../shared/raycast.js';
import {
  WEAPONS,
  WEAPON_IDS,
  chargeDamageMult,
  damageAtDistance,
} from '../../shared/combatmath.js';
import {
  evGlaiveStock,
  evHit,
  evProjectileExplode,
  evProjectileLaunch,
  evProjectileUpdate,
} from '../protocol/events.js';
import { fwdFromYawPitch, markLaunched } from './player.js';
import {
  GRENADE_THROW_COOLDOWN_MS,
  GRENADE_TYPES,
  GRENADE_TYPE_IDS,
  clampGrenadeCook,
  clampGrenadeType,
  grenadeLaunch,
  grenadeThrowFuseMs,
  stepGrenade,
} from '../../shared/grenade-rules.js';
import { ROCKET_RULES, rocketLaunch, stepRocket } from '../../shared/rocket-rules.js';
import { BOLT_RULES, boltLaunch, stepBolt } from '../../shared/bolt-rules.js';
import {
  glaiveCanThrow,
  glaiveFlip,
  glaiveLaunch,
  glaiveLegDamage,
  glaivePickupReached,
  glaiveTarget,
  stepGlaive,
  trimGlaiveAmmo,
} from '../../shared/glaive-rules.js';
import { sweepPlayers } from './projectile-contact.js';
import { SmokeSystem } from './smoke.js';
import { MolotovFireSystem } from './molotov-fire.js';
import { CLAYMORE_RULES, rayClaymore, placeClaymore, claymoreProfile, claymoreBeam, crossesClaymore } from '../../shared/claymore-rules.js';

/** Live projectiles per room; launches beyond it are refused. */
export const MAX_ACTIVE_PROJECTILES = 192;
/**
 * Slots only paid launches (a fired rocket or bolt, a thrown grenade) may fill:
 * Chaos side projectiles and cluster children stop short of them, so a shot
 * whose ammunition is already spent always gets its projectile.
 */
export const PRIMARY_PROJECTILE_RESERVE = 32;
/** An impact projectile ignores its own thrower for this long after release. */
const OWNER_GRACE_MS = 220;
/** Chain detonation reaches this fraction of the blast radius. */
const CHAIN_REACH = 0.8;
/** A bolt contact ends in this tiny "blast" — a pop, never a real explosion. */
const BOLT_FIZZLE_RADIUS = 0.5;
/** The RIPTIDE's fixed weapon slot: catches and fabrications land here in any hand. */
const GLAIVE_SLOT = WEAPON_IDS.indexOf('glaive');
/** Every returning disc re-publishes its steered path this often (ms). */
const GLAIVE_SYNC_MS = 100;
/** How far past the swept contact the disc centre line is probed for the hit zone (m). */
const GLAIVE_ZONE_DEPTH = 0.8;

/** The owner's live RIPTIDE definition, Chaos ladder included, whatever is in hand. */
export function glaiveDef(player) {
  return chaosWeaponDef(player, WEAPONS.glaive);
}

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
    damageFalloffExponent: ROCKET_RULES.damageFalloffExponent,
    selfDamage: ROCKET_RULES.selfDamage,
    knockback: ROCKET_RULES.knockback,
    selfKnockback: ROCKET_RULES.selfKnockback,
    knockbackRadius: ROCKET_RULES.knockbackRadius,
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
    /** Embedded RIPTIDE discs keyed by the disc id that embedded: owner-only pickups. */
    this.glaivePickups = new Map();
    this._glaiveFlying = new Map();
  }

  _hasRoom(secondary = false) {
    return this.active.size < MAX_ACTIVE_PROJECTILES - (secondary ? PRIMARY_PROJECTILE_RESERVE : 0);
  }

  clear() {
    this.active.clear();
    this.glaivePickups.clear();
    this._glaiveFlying.clear();
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
      // Minimum interval between throws: an edge inside the cooldown is
      // dropped and spends nothing, so tap-spam cannot empty the pouch.
      if (ctx.now < (player.nextThrowAt || 0)) continue;
      const type = GRENADE_TYPES[GRENADE_TYPE_IDS[typeIndex]];
      const launched = type.cook && clampGrenadeCook(cook, type) >= type.fuseMs
        ? this.detonateInHand(player, ctx, typeIndex)
        : this.throw(player, ctx, charge, typeIndex, cook, aim);
      if (launched) player.nextThrowAt = ctx.now + GRENADE_THROW_COOLDOWN_MS;
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
      if (projectile.type === 'glaive' && !this._glaiveOwnerLive(projectile, ctx)) {
        // A dead or departed owner loses the disc outright; respawn refills the gun.
        this._endGlaive(projectile, ctx, 'owner');
        continue;
      }
      if (projectile.chaosHoming && !projectile.stuck) this._home(projectile, dt, ctx);
      if (projectile.type === 'pulse' && projectile.chaosLevel >= 1 && !projectile.child) this._pull(projectile, dt, ctx);
      if (projectile.type === 'rocket') this._flyRocket(projectile, stepSeconds * substeps, ctx);
      else if (projectile.type === 'bolt') this._flyBolt(projectile, stepSeconds * substeps, ctx);
      else if (projectile.type === 'glaive') this._flyGlaive(projectile, stepSeconds * substeps, ctx);
      else this._flyGrenade(projectile, stepSeconds, substeps, ctx);
      if (!this.active.has(projectile.id)) continue;
      // Returning discs steer toward a live owner, so remote presentation needs
      // the same 100 ms correction stream that Chaos projectiles already use.
      if ((projectile.chaosLevel || (projectile.type === 'glaive' && projectile.phase === 'back'))
          && ctx.now >= (projectile.syncAt || 0)) {
        projectile.syncAt = ctx.now + GLAIVE_SYNC_MS;
        const update = evProjectileUpdate(projectile.id,
          [projectile.x, projectile.y, projectile.z],
          [projectile.vx, projectile.vy, projectile.vz], projectile.bouncesLeft);
        if (projectile.type === 'glaive') update.phase = projectile.phase;
        ctx.pushEvent(update);
      }
      if (ctx.now >= projectile.explodeAt || outsideWorld(projectile, ctx)) this.explode(projectile, ctx);
    }
    stepping.length = 0;
    this._stepGlaiveStock(ctx);
    this._previousPlayers.clear();
    for (const p of ctx.entities.values()) {
      if (p.state === 'alive') this._previousPlayers.set(p.id, { x: p.x, y: p.y, z: p.z, now: ctx.now });
    }
  }

  nearestClaymore(origin, direction, limit, minT = 0, radius = 0) {
    let best = null;
    for (const mine of this.active.values()) {
      if (mine.type !== 'limpet') continue;
      const t = rayClaymore(mine, origin, direction, best?.t ?? limit, minT, radius);
      if (t !== null) best = {mine, t};
    }
    return best;
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
    const placement = placeClaymore({ x: player.eyeX ?? player.x, eyeY: player.eyeY, z: player.eyeZ ?? player.z, dir: direction },
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

  /**
   * Drop persistent mines: every one when a round ends, or one owner's when that
   * player leaves. Clients remove any mine missing from `mineSnapshot`.
   */
  clearMines(ownerId = null) {
    const owner = ownerId == null ? null : String(ownerId);
    for (const [id, projectile] of this.active) {
      if (projectile.type === 'limpet' && (owner === null || projectile.ownerId === owner)) this.active.delete(id);
    }
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
      if (type.impact && !(projectile.child && projectile.type === 'pulse')) {
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
        const length = Math.hypot(to.x-from.x, to.y-from.y, to.z-from.z);
        const dir = length > 0 ? {x:(to.x-from.x)/length,y:(to.y-from.y)/length,z:(to.z-from.z)/length} : null;
        const mine = dir && this.nearestClaymore([from.x,from.y,from.z],dir,
          contact ? Math.hypot(contact.x-from.x,contact.y-from.y,contact.z-from.z) : length, 0, BOLT_RULES.radius);
        if (mine) {
          this.explode(mine.mine,ctx);
          this._fizzleBolt(projectile,ctx);
          return true;
        }
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
        const lethal = victim.takeDamage(dmg, hs, projectile.owner, 'longarc');
        ctx.pushEvent(evHit(projectile.ownerId, victim.id, dmg, hs, [x, y, z], victim.lastDamage));
        if (lethal) ctx.killPlayer(victim, projectile.owner, projectile.weaponKey || WEAPONS.longarc.id, hs, {});
        this._fizzleBolt(projectile, ctx);
        return true;
      },
      onBounce: (contact) => {
        if (typeof ctx.canAffectWorld === 'function' && !ctx.canAffectWorld()) return;
        if (projectile.chaosLevel >= 3) this.chaosBlast(projectile.owner, [projectile.x, projectile.y, projectile.z], 'pulse', 3, 25, 12, ctx, projectile.weaponKey);
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

  /**
   * One RIPTIDE disc flies on the shared integrator. Unlike a bolt it never stops at
   * a body: every traveled segment is swept repeatedly so each victim takes at most
   * one hit per leg, up to the leg's pierce limit. The out-leg reflection chips its
   * voxel and turns the disc home; a return-leg wall embeds it as an owner pickup.
   */
  _flyGlaive(disc, seconds, ctx) {
    const owner = disc.owner;
    const rules = disc.rules;
    stepGlaive(disc, seconds, disc.raycast, glaiveTarget(owner), {
      now: ctx.now,
      rules,
      onTravel: (from, to) => { this._cutGlaive(disc, from, to, ctx); return false; },
      onBounce: (contact) => {
        if (typeof ctx.canAffectWorld === 'function' && !ctx.canAffectWorld()) return;
        const type = ctx.getBlock(contact.x, contact.y, contact.z);
        if (BLOCK_HP[type] != null) {
          ctx.damageBlock?.(contact.x, contact.y, contact.z, type, rules.blockDamage);
        }
        chaosGlaiveContact(owner, [disc.x, disc.y, disc.z], this._chaosPort(ctx));
      },
    });
    if (!this.active.has(disc.id)) return true;
    if (disc.expired) return this._endGlaive(disc, ctx, 'expire');
    if (disc.caught) return this._endGlaive(disc, ctx, 'catch');
    if (disc.hit) return this._endGlaive(disc, ctx, 'embed');
    if (disc.flipped) this._publishGlaiveFlip(disc, ctx, disc.flipped);
    return false;
  }

  /** Damage every eligible body along one traveled disc segment (see `_flyGlaive`). */
  _cutGlaive(disc, from, to, ctx) {
    const leg = disc.phase === 'back' ? 'back' : 'out';
    const cut = leg === 'back' ? disc.hitBack : disc.hitOut;
    const rules = disc.rules;
    const limit = Math.max(1, Math.trunc(rules.pierce) || 1);
    const owner = disc.owner;
    const hits = new Set();
    const end = { x: to.x, y: to.y, z: to.z };
    // Point-blank guard: a body cut on the out leg cannot take the return cut
    // until `legGapMs` later, so a disc bouncing off the wall behind it only hits once.
    const canCut = (victim) => !cut.has(victim)
      && !(leg === 'back' && ctx.now - (disc.lastHitAt.get(victim) ?? -Infinity) < rules.legGapMs)
      && this._canContact(victim, disc, ctx, true);
    while (cut.size < limit) {
      const contact = sweepPlayers(from, end, rules.radius, ctx.targets || ctx.entities, canCut);
      if (!contact) break;
      const { victim, x, y, z } = contact;
      // The 0.22 m disc reaches the inflated torso box before the head, so the zone
      // comes from the disc's centre line through the body (hitscan preferCore), probed
      // a body depth past the contact because the centre line may cross it next step.
      const span = Math.hypot(end.x - from.x, end.y - from.y, end.z - from.z) || 1;
      // Only a centre line through the head box is a headshot (hitscan `coreHit`);
      // a radius-only graze over the helmet cuts as a body hit.
      const probe = rayPlayerHitboxes([from.x, from.y, from.z],
        { x: (end.x - from.x) / span, y: (end.y - from.y) / span, z: (end.z - from.z) / span },
        victim, contact.t * span + GLAIVE_ZONE_DEPTH,
        { radius: rules.radius, preferCore: true });
      const hs = !!probe?.coreHit && probe.zone === 'head';
      const dmg = combatDamage(glaiveLegDamage(leg, cut.size, hs, rules));
      cut.add(victim);
      hits.add(victim);
      disc.lastHitAt.set(victim, ctx.now);
      if (leg === 'out') disc.lastOutHitAt = ctx.now;
      const lethal = victim.takeDamage(dmg, hs, owner, 'glaive');
      // `w` lets clients play the disc's slice (and headshot ring) cue.
      ctx.pushEvent(Object.assign(evHit(owner.id, victim.id, dmg, hs, [x, y, z], victim.lastDamage), { w: 'glaive' }));
      if (lethal) ctx.killPlayer(victim, owner, 'glaive', hs, {});
    }
    const length = Math.hypot(end.x - from.x, end.y - from.y, end.z - from.z);
    if (length > 0) {
      const dir = { x: (end.x - from.x) / length, y: (end.y - from.y) / length, z: (end.z - from.z) / length };
      const mine = this.nearestClaymore([from.x, from.y, from.z], dir, length, 0, rules.radius);
      if (mine) this.explode(mine.mine, ctx);
    }
    applyNearMisses(collectNearMisses(owner,
      [from.x, from.y, from.z], [end.x, end.y, end.z], ctx), hits.size ? hits : null, ctx);
  }

  _publishGlaiveFlip(disc, ctx, reason) {
    disc.syncAt = ctx.now + GLAIVE_SYNC_MS;
    ctx.pushEvent(Object.assign(evProjectileUpdate(disc.id,
      [disc.x, disc.y, disc.z], [disc.vx, disc.vy, disc.vz], disc.bouncesLeft),
    { phase: disc.phase, flip: reason }));
  }

  /** The disc's owner still exists and is alive; otherwise the disc is lost. */
  _glaiveOwnerLive(disc, ctx) {
    const owner = disc.owner;
    return !!owner && owner.state === 'alive' && ctx.entities.get(String(owner.id)) === owner;
  }

  _chaosPort(ctx) {
    return { chaosBlast: (p, origin, type, radius, damage, knockback, weaponKey) =>
      this.chaosBlast(p, origin, type, radius, damage, knockback, ctx, weaponKey) };
  }

  /**
   * Retire one disc. `catch` seats it in the owner's RIPTIDE slot, `embed` leaves an
   * owner-only pickup that fabricates after `regenMs`, `expire` (lifetime or out of
   * the world) queues a fabrication with no pickup, and `owner`/`clear` lose it.
   */
  _endGlaive(disc, ctx, reason) {
    if (!this.active.delete(disc.id)) return false;
    const owner = disc.owner;
    const live = this._glaiveOwnerLive(disc, ctx);
    const point = [disc.x, disc.y, disc.z];
    ctx.pushEvent(Object.assign(evProjectileExplode(owner?.id ?? disc.ownerId, disc.id, 'glaive', point, 0),
      { caught: reason === 'catch', reason }));
    if (!live) return true;
    if (reason === 'catch') {
      owner.mag[GLAIVE_SLOT] = Math.max(0, owner.mag[GLAIVE_SLOT] | 0) + 1;
      chaosGlaiveContact(owner, point, this._chaosPort(ctx));
    } else if (reason === 'embed') {
      const hit = disc.hit;
      this.glaivePickups.set(disc.id, {
        id: disc.id, owner, x: disc.x, y: disc.y, z: disc.z,
        cell: hit ? [hit.x, hit.y, hit.z] : null,
        expiresAt: ctx.now + disc.rules.regenMs,
      });
      if (!(typeof ctx.canAffectWorld === 'function' && !ctx.canAffectWorld())) {
        chaosGlaiveContact(owner, point, this._chaosPort(ctx));
      }
      this._publishGlaiveStock(owner, ctx);
    } else if (reason === 'expire') {
      (owner.glaiveFab ??= []).push(ctx.now + disc.rules.regenMs);
      this._publishGlaiveStock(owner, ctx);
    }
    return true;
  }

  _publishGlaiveStock(owner, ctx, restored = null) {
    const pickups = [];
    for (const pickup of this.glaivePickups.values()) {
      if (pickup.owner === owner) pickups.push({ ...pickup, regen: pickup.expiresAt - ctx.now });
    }
    ctx.pushEvent(evGlaiveStock(owner.id, (owner.glaiveFab || []).map((at) => at - ctx.now), pickups, restored));
  }

  /** Discs of `player` still in the air (the fire gate's `inFlight`). */
  glaiveInFlight(player) {
    let count = 0;
    for (const projectile of this.active.values()) {
      if (projectile.type === 'glaive' && projectile.owner === player) count++;
    }
    return count;
  }

  /** Discs `player` owns outside the hand: flying, embedded or queued for fabrication. */
  glaiveStock(player) {
    let count = this.glaiveInFlight(player) + (player?.glaiveFab?.length || 0);
    for (const pickup of this.glaivePickups.values()) if (pickup.owner === player) count++;
    return count;
  }

  /** Fire gate: a seated disc and fewer than `magSize` discs already flying. */
  canThrowGlaive(player) {
    return glaiveCanThrow(player.mag?.[GLAIVE_SLOT], this.glaiveInFlight(player), glaiveDef(player).magSize);
  }

  /**
   * R on the RIPTIDE: every disc the player owns that is still on its out leg turns
   * home now. Nothing about reloading changes. Returns how many discs turned.
   */
  returnDiscs(player, ctx) {
    let turned = 0;
    for (const disc of this.active.values()) {
      if (disc.type !== 'glaive' || disc.owner !== player || disc.phase !== 'out') continue;
      if (!glaiveFlip(disc, ctx.now, 'return', disc.rules)) continue;
      this._publishGlaiveFlip(disc, ctx, 'return');
      turned++;
    }
    return turned;
  }

  /**
   * Per-owner disc bookkeeping after flight: embedded pickups (proximity pickup,
   * destroyed anchor block, `regenMs` fabrication), due fabrications and then the
   * one ammo normaliser for every combatant.
   */
  _stepGlaiveStock(ctx) {
    if (GLAIVE_SLOT < 0) return;
    const changed = new Map();
    for (const pickup of this.glaivePickups.values()) {
      const owner = pickup.owner;
      if (!owner || owner.state !== 'alive' || ctx.entities.get(String(owner.id)) !== owner) {
        this.glaivePickups.delete(pickup.id);
        // Publish the empty stock so the owner's client drops the pickup and its ghost.
        if (owner && !changed.has(owner)) changed.set(owner, null);
        continue;
      }
      if (ctx.now >= pickup.expiresAt || glaivePickupReached(pickup, owner, glaiveDef(owner).glaive)) {
        this.glaivePickups.delete(pickup.id);
        owner.mag[GLAIVE_SLOT] = Math.max(0, owner.mag[GLAIVE_SLOT] | 0) + 1;
        changed.set(owner, ctx.now >= pickup.expiresAt ? 'fab' : 'pickup');
      } else if (pickup.cell && ctx.getBlock(...pickup.cell) === AIR) {
        // The anchor block is gone: the disc drops out of the world, and the
        // launcher still fabricates it on the pickup's original schedule.
        this.glaivePickups.delete(pickup.id);
        (owner.glaiveFab ??= []).push(pickup.expiresAt);
        if (!changed.has(owner)) changed.set(owner, null);
      }
    }
    const flying = this._glaiveFlying;
    flying.clear();
    for (const disc of this.active.values()) {
      if (disc.type === 'glaive') flying.set(disc.owner, (flying.get(disc.owner) || 0) + 1);
    }
    for (const player of ctx.entities.values()) {
      if (!Array.isArray(player.mag)) continue;
      const fab = player.glaiveFab;
      if (fab?.length) {
        let due = 0;
        for (let i = fab.length - 1; i >= 0; i--) {
          if (ctx.now >= fab[i]) { fab.splice(i, 1); due++; }
        }
        if (due) {
          player.mag[GLAIVE_SLOT] = Math.max(0, player.mag[GLAIVE_SLOT] | 0) + due;
          changed.set(player, 'fab');
        }
      }
      if (this.normalizeGlaiveAmmo(player, ctx, flying.get(player) || 0) && !changed.has(player)) {
        changed.set(player, null);
      }
    }
    for (const [owner, restored] of changed) this._publishGlaiveStock(owner, ctx, restored);
    flying.clear();
  }

  /**
   * The ammo invariant `mag + inFlight + embedded + fab <= magSize`, enforced in one
   * place so every refill path (spawn, round reset, Gun Game, loadouts) stays honest.
   * Excess comes off queued fabrications first, then embedded pickups, then the seated
   * count; discs in the air always outrank discs in hand. Returns true when the
   * owner's pickup or fabrication stock changed.
   */
  normalizeGlaiveAmmo(p, ctx, inFlight = this.glaiveInFlight(p)) {
    if (GLAIVE_SLOT < 0 || !Array.isArray(p.mag)) return false;
    // Discs are the only ammunition: a spare pool would let a reload conjure discs.
    if (Array.isArray(p.reserve) && p.reserve[GLAIVE_SLOT]) p.reserve[GLAIVE_SLOT] = 0;
    const fab = p.glaiveFab || [];
    let embedded = 0;
    for (const pickup of this.glaivePickups.values()) if (pickup.owner === p) embedded++;
    const trim = trimGlaiveAmmo({ magSize: glaiveDef(p).magSize,
      mag: p.mag[GLAIVE_SLOT], inFlight, embedded, fab: fab.length });
    p.mag[GLAIVE_SLOT] = trim.mag;
    if (!trim.dropFab && !trim.dropEmbedded) return false;
    // Keep the soonest fabrications and the freshest pickups.
    if (trim.dropFab) { fab.sort((a, b) => a - b); fab.length -= trim.dropFab; }
    let drop = trim.dropEmbedded;
    for (const pickup of [...this.glaivePickups.values()].filter((row) => row.owner === p)
      .sort((a, b) => a.expiresAt - b.expiresAt)) {
      if (drop-- <= 0) break;
      this.glaivePickups.delete(pickup.id);
    }
    return true;
  }

  /**
   * Fresh life, round reset or departure: delete the owner's discs and pickups and
   * clear queued fabrications. A respawn under the Third plate seats its extra disc.
   */
  resetGlaive(player, ctx) {
    if (!player) return;
    let touched = !!player.glaiveFab?.length;
    for (const disc of [...this.active.values()]) {
      if (disc.type === 'glaive' && disc.owner === player) touched = this._endGlaive(disc, ctx, 'clear') || touched;
    }
    for (const pickup of [...this.glaivePickups.values()]) {
      if (pickup.owner === player) { this.glaivePickups.delete(pickup.id); touched = true; }
    }
    player.glaiveFab = [];
    const base = WEAPONS.glaive.magSize;
    const cap = glaiveDef(player).magSize;
    if (GLAIVE_SLOT >= 0 && Array.isArray(player.mag) && cap > base && player.mag[GLAIVE_SLOT] === base) {
      player.mag[GLAIVE_SLOT] = cap;
    }
    if (touched) this._publishGlaiveStock(player, ctx);
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

  /** Release-edge throw. `typeIndex` selects the grenade; `cookMs` shortens a timed fuse. */
  throw(player, ctx, charge = 0.5, typeIndex = 0, cookMs = 0, aim = null) {
    if (!this._hasRoom()) return null;
    const index = clampGrenadeType(typeIndex);
    const type = GRENADE_TYPES[GRENADE_TYPE_IDS[index]];
    const direction = fwdFromYawPitch(aim?.yaw ?? player.yaw, aim?.pitch ?? player.pitch);
    if (type.wallMine) return this._placeClaymore(player, ctx, direction, index);
    const launch = grenadeLaunch({
      x: player.eyeX ?? player.x, y: player.y, z: player.eyeZ ?? player.z, eyeY: player.eyeY,
      vx: player.vx, vy: player.vy, vz: player.vz,
      dir: direction, charge, type: type.id,
    });
    const fuseMs = grenadeThrowFuseMs(type, cookMs);
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
      x: player.eyeX ?? player.x, y: player.eyeY - 0.2, z: player.eyeZ ?? player.z,
      vx: 0, vy: 0, vz: 0,
      charge: 0,
      launchedAt: ctx.now,
      explodeAt: ctx.now,
      stuck: true,
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

  /**
   * A rocket leaves the tube from the shooter's eye along the spread-sampled `dir`.
   * `weaponKey` credits a Chaos side effect to the weapon that fired it;
   * `secondary` side effects leave the paid-launch reserve free.
   */
  launchRocket(player, ctx, dir, { weaponKey = null, secondary = false } = {}) {
    if (!this._hasRoom(secondary)) return null;
    const launch = rocketLaunch({ x: player.eyeX ?? player.x, y: player.eyeY, z: player.eyeZ ?? player.z, dir });
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
      hit: null,
      directVictim: null,
      raycast: (ox, oy, oz, dx, dy, dz, max) => raycastVoxels(
        ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== AIR), ox, oy, oz, dx, dy, dz, max,
      ),
    };
    if (weaponKey) projectile.weaponKey = weaponKey;
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
  launchBolt(player, ctx, dir, charge01 = 1, satellite = false, { weaponKey = WEAPONS.longarc.id, secondary = false } = {}) {
    if (!this._hasRoom(satellite || secondary)) return null;
    const launch = boltLaunch({ x: player.eyeX ?? player.x, y: player.eyeY, z: player.eyeZ ?? player.z, dir });
    const id = `b${this._nextId++}`;
    const projectile = {
      id,
      type: 'bolt',
      weaponKey,
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
      }, charge01, true, { weaponKey });
    }
    return projectile;
  }

  /**
   * A RIPTIDE disc leaves the spindle from the shooter's eye along the spread-sampled
   * `dir`. Its rules (out leg, pierce) are frozen from the owner's Chaos ladder.
   */
  launchGlaive(player, ctx, dir) {
    if (!this._hasRoom()) return null;
    const rules = glaiveDef(player).glaive;
    const launch = glaiveLaunch({ x: player.eyeX ?? player.x, y: player.eyeY, z: player.eyeZ ?? player.z, dir, now: ctx.now, rules });
    const id = `d${this._nextId++}`;
    const projectile = {
      ...launch,
      id,
      ownerId: String(player.id),
      owner: player,
      rules,
      explodeAt: launch.expiresAt,
      hit: null,
      bounced: null,
      traveled: 0,
      // One cut per victim per leg; `lastHitAt` feeds the leg gap and the bots.
      hitOut: new Set(),
      hitBack: new Set(),
      lastHitAt: new Map(),
      lastOutHitAt: -Infinity,
      raycast: (ox, oy, oz, dx, dy, dz, max) => raycastVoxels(
        ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== AIR), ox, oy, oz, dx, dy, dz, max,
      ),
    };
    this._configureChaos(projectile);
    this.active.set(id, projectile);
    ctx.pushEvent(Object.assign(evProjectileLaunch(
      player.id,
      id,
      'glaive',
      [projectile.x, projectile.y, projectile.z],
      [projectile.vx, projectile.vy, projectile.vz],
      rules.lifetimeMs,
      projectile.bouncesLeft,
    ), { chaos: projectile.chaosLevel || 0, phase: 'out', flip: rules.outMs }));
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
      markLaunched(v);
    }
  }

  _scatter(source, count, ctx) {
    const type = source.type === 'rocket' ? 'frag' : source.type;
    for (let i = 0; i < count && this._hasRoom(true); i++) {
      const angle = i / count * Math.PI * 2;
      const id = `g${this._nextId++}`;
      const child = { ...source, id, type, child: true, stuck: false,
        hitSolid: false, directVictim: null, chained: false,
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

  chaosBlast(owner, origin, type, radius, damage, knockback, ctx, weaponKey = null) {
    const id = `c${this._nextId++}`;
    const projectile = { id, type, owner, ownerId: String(owner.id),
      x: origin[0], y: origin[1], z: origin[2], child: true,
      blastRules: { ...PROJECTILE_RULES[type], damageRadius: radius, damage,
        knockback, terrainRadius: 0, selfDamage: 0, selfKnockback: 0 } };
    if (weaponKey) projectile.weaponKey = weaponKey;
    this.active.set(id, projectile);
    return this.explode(projectile, ctx);
  }

  explode(projectile, ctx) {
    if (projectile.type === 'bolt') return this._fizzleBolt(projectile, ctx);
    if (projectile.type === 'glaive') return this._endGlaive(projectile, ctx, 'expire');
    if (!this.active.delete(projectile.id)) return false;
    const baseRules = PROJECTILE_RULES[projectile.type] || PROJECTILE_RULES.frag;
    const level = projectile.chaosLevel || 0;
    const giant = projectile.type === 'rocket' && level >= 1;
    const radiusScale = giant ? 1.8 : projectile.type === 'limpet' && level >= 3 ? 1.3 : projectile.child && level >= 3 ? 1.3 : 1;
    const rules = projectile.blastRules || { ...baseRules,
      damageRadius: baseRules.damageRadius * radiusScale,
      knockbackRadius: (baseRules.knockbackRadius ?? baseRules.damageRadius) * radiusScale,
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
    // Damage rules key on the blast type; kill credit goes to the source weapon.
    const weaponKey = projectile.weaponKey || projectile.type;
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
      const direct = projectile.directVictim === victim;
      if (!direct && (distance >= rules.damageRadius || !visibleTo(ctx, origin, target))) continue;
      const falloff = direct
        ? 1
        : Math.pow(1 - distance / rules.damageRadius, rules.damageFalloffExponent ?? 1.22);
      let damage = rules.damage * falloff;
      if (direct && Number.isFinite(rules.directDamage)) damage += rules.directDamage;
      // NPC rockets retain the real flight/blast/terrain simulation, with a
      // readable profile-damage attack instead of the player rocket's lethal impact.
      if (Number.isFinite(owner?.npcRocketDamage) && projectile.type === 'rocket') damage = owner.npcRocketDamage * falloff;
      damage = Math.round(damage * (isSelf ? rules.selfDamage : 1) * 10) / 10;
      let lethal = false;
      if (damageEnabled && damage > 0) {
        hitVictims.add(victim);
        damage = combatDamage(damage);
        lethal = victim.takeDamage(damage, false, owner, projectile.type);
        ctx.pushEvent(evHit(owner?.id || '', victim.id, damage, false, target, victim.lastDamage));
      }
      const strength = victim.objective ? 0 : isSelf && Number.isFinite(rules.selfKnockback)
        ? rules.selfKnockback
        : rules.knockback;
      // Pressure falls off more gently than damage for displacement-focused blasts.
      const pressure = direct ? 1 : Math.pow(Math.max(0, 1 - distance / (rules.knockbackRadius ?? rules.damageRadius)),
        rules.knockbackFalloff ?? 1.22);
      const impulse = Math.max(0, strength * pressure);
      const invDistance = distance > 0.01 ? 1 / distance : 0;
      // A grounded acceleration step or an in-progress vault must not swallow the launch.
      if (impulse > 0) markLaunched(victim);
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
      if (other === source || other.type === 'bolt' || other.type === 'glaive' || other.explodeAt <= ctx.now) continue;
      const distance = Math.hypot(other.x - origin[0], other.y - origin[1], other.z - origin[2]);
      if (distance > reach) continue;
      if (!visibleTo(ctx, origin, [other.x, other.y, other.z])) continue;
      other.explodeAt = ctx.now;
      other.chained = true;
    }
  }
}
