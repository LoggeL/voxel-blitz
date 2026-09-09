import { collectNearMisses, applyNearMisses } from './suppression.js';
import { beginReload, reloadPhase } from '../../shared/reload.js';
import { createMinigunState, stepMinigun, heatMinigun, minigunDamageMult } from '../../shared/minigun.js';
import { rayPlayerHitboxes } from '../../shared/player-hitboxes.js';
import { chaosShot, chaosHit } from './chaos-combat.js';
import { chaosWeaponDef } from '../../shared/chaos.js';
import { QUICK_MELEE_SECONDS } from '../../shared/quick-melee.js';
// Authoritative weapon intent, ballistics, and destructible-block damage.
// The caller owns world/entity state and exposes only the narrow operations
// needed by this hot path through `ctx`.

import { BULLET_RULES, bulletPower, bulletMaterialImpact, voxelExitDistance } from '../../shared/bullet-material.js';
import { MINING_HITS } from '../../shared/world/blocks.js';
import { weaponSwapProfile } from '../../shared/weapon-swap.js';
import { AIR, BEDROCK, GLASS, LEAVES, BLOCK_HP } from '../../shared/worlddata.js';
import {
  CONDITION_RULES,
  WEAPONS,
  SNIPER_SCOPE_ADS_THRESHOLD,
  HITSCAN_REACH,
  PLAYER_HALF,
  damageAtDistance,
  samplePelletDirection,
  computeSpreadConeDeg,
  chargeProfile,
  chargeFromHold,
  chargeDamageMult,
  chargeShotProfile,
  railDamageMult,
} from '../../shared/combatmath.js';
import { clearReload } from './movement.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { NETWORK_PRESENTATION } from '../../shared/networking.js';
import { evShoot, evHit, evBlock } from '../protocol/events.js';
import {
  clamp01,
  clampWeaponSlot,
  fwdFromYawPitch,
  shotRng,
} from './player.js';

const LONG_RANGE_KILL_DISTANCE = 40;
const NO_SCOPE_ADS_THRESHOLD = SNIPER_SCOPE_ADS_THRESHOLD;
const HISTORY_WINDOW_MS = 500;

export function computeConeDeg(p) {
  return computeSpreadConeDeg(
    p.def,
    p.bloom,
    Math.hypot(p.vx, p.vz),
    p.adsT,
    p.panic,
    p.exhaustion,
    p.crouch,
    p.pain,
  );
}

/** Drop a capacitor charge without firing (switch, reload, death, blocked mode). */
export function cancelCharge(p) {
  p.charging = false;
  p.chargeT = 0;
  p.charge = 0;
}

export function switchWeapon(p, slot) {
  p.mining = null;
  if (p.minigun) p.minigun.spin = 0;
  p.weapon = clampWeaponSlot(slot);
  clearReload(p);
  cancelCharge(p);
  p.cooldown = Math.max(p.cooldown, 0);
  p.deployT = weaponSwapProfile(p.def).total;
  p.ads = false;
  p.adsT = 0;
}

export function canFire(p, fireEdge, ctx) {
  const mode = p.def.mode;
  // Melee swings are free: no magazine and no semi-auto lock — the rpm cadence
  // is the only rate limiter, so a held trigger keeps swinging.
  const semi = mode !== 'auto' && mode !== 'melee';
  return ctx.canFire(p) && !p.vault && !p.reloading && p.deployT <= 0 &&
    p.cooldown <= 0 && (mode === 'melee' || p.mag[p.weapon] > 0) &&
    !(semi && p.triggerPrev && !fireEdge);
}

/**
 * Consume the latest weapon intent for one living entity.
 *
 * ctx = { canFire, canUseWeapon, killPlayer, getBlock, setBlock, blockHp,
 *         entities, canDamage, now, solidAt, pushBlockDelta, pushEvent }
 */
export function resolveWeaponIntent(p, _dt, ctx) {
  const inp = p.input;
  p.minigun ??= createMinigunState();
  if (inp?.grenadeHandling || p.grenadeHandlingQueued) {
    p.quickMeleeQueued = null;
    p.grenadeHandlingQueued = false;
    p.fireEdgeQueued = false;
    p.fireAimQueued = null;
    p.triggerPrev = false;
    p.reloadPrev = false;
    p.mining = null;
    p.ads = false;
    cancelCharge(p);
    stepMinigun(p.minigun, _dt, false, false);
    return;
  }
  const quickAim = p.quickMeleeQueued;
  p.quickMeleeQueued = null;
  if (quickAim && ctx.canFire(p) && !p.vault && p.deployT <= 0 && !(p.quickMeleeT > 0)
    && (p.def.mode !== 'melee' || p.cooldown <= 0)) {
    clearReload(p);
    cancelCharge(p);
    p.minigun.spin = 0;
    p.ads = false;
    p.adsT = 0;
    p.quickMeleeT = QUICK_MELEE_SECONDS;
    p.cooldown = Math.max(p.cooldown, QUICK_MELEE_SECONDS);
    meleeSwing(p, ctx, chaosWeaponDef(p, WEAPONS.knife), quickAim);
  }
  if (p.quickMeleeT > 0) {
    p.fireEdgeQueued = false;
    p.fireAimQueued = null;
    p.triggerPrev = !!inp?.wantFire;
    return;
  }
  const minigunEnabled = p.def.id === 'minigun' && inp &&
    (inp.switchTo == null || inp.switchTo === p.weapon) && !inp.reload &&
    ctx.canFire(p) && !p.vault && !p.reloading && p.deployT <= 0 && p.mag[p.weapon] > 0;
  const minigunReady = stepMinigun(p.minigun, _dt,
    !!(minigunEnabled && (inp.wantFire || p.fireEdgeQueued)), !!(minigunEnabled && inp.wantAds));
  if (!inp?.wantFire && !p.fireEdgeQueued) p.mining = null;
  if (!inp) { p.triggerPrev = false; p.reloadPrev = false; return; }
  const identifiedReload = Number.isSafeInteger(inp.reloadId) && inp.reloadId > 0;
  const reloadEdge = !!inp.reload && (identifiedReload
    ? inp.reloadId > (p.reloadAck || 0) : !p.reloadPrev);
  p.reloadPrev = !!inp.reload;

  // A new selection interrupts the current draw and starts the selected
  // weapon's full deploy timer, matching the client-side equip contract.
  if (inp.switchTo != null &&
      inp.switchTo !== p.weapon &&
      ctx.canUseWeapon(p, inp.switchTo)) {
    switchWeapon(p, inp.switchTo);
  }

  // The client holds its reload request while prediction is active. Keep an
  // unaccepted edge pending across a draw/vault lock, so the same request starts
  // when the weapon becomes usable. Accepted requests retain their edge latch.
  if (reloadEdge && (p.vault || p.deployT > 0)) p.reloadPrev = false;
  if (p.vault) { cancelCharge(p); p.triggerPrev = !!inp.wantFire; return; }
  const def = p.def;
  if (reloadEdge && p.deployT <= 0) {
    // Acknowledge accepted and permanently rejected requests. Draw/vault locks
    // defer acknowledgment so the client keeps sending the same request.
    if (identifiedReload) p.reloadAck = inp.reloadId;
    if (ctx.canUseWeapon(p, p.weapon) && !p.reloading) {
      const ammo = { mag: p.mag[p.weapon], reserve: p.reserve[p.weapon] };
      const reload = beginReload(def, ammo, p.infiniteMagazines);
      if (reload) {
        cancelCharge(p);
        p.reloadState = reload;
        p.reloading = true;
        p.reloadStage = reloadPhase(reload);
        p.reloadT = reload.seconds;
        p.mag[p.weapon] = ammo.mag;
      }
    }
  }

  const fireEdge = p.fireEdgeQueued;
  const fireAim = fireEdge ? p.fireAimQueued : null;
  p.fireEdgeQueued = false;
  p.fireAimQueued = null;
  if (def.mode === 'charge') {
    resolveChargeIntent(p, _dt, inp, fireEdge, ctx);
    p.triggerPrev = inp.wantFire;
    return;
  }
  if (def.mode === 'melee') {
    resolveMeleeIntent(p, inp, fireEdge, ctx);
    p.triggerPrev = inp.wantFire;
    return;
  }
  const wantsShot = inp.wantFire || fireEdge;
  // A staged tube reload yields to the trigger: whatever is seated fires now.
  if (!reloadEdge && (fireEdge || (inp.wantFire && !p.triggerPrev)) &&
      p.reloading && p.reloadStage && p.mag[p.weapon] > 0) clearReload(p);
  if (def.id === 'minigun' && !minigunReady) {
    p.triggerPrev = inp.wantFire;
    return;
  }
  if (wantsShot && canFire(p, fireEdge, ctx)) fireOneShot(p, ctx, 1, fireAim);
  p.triggerPrev = inp.wantFire;
}

/**
 * Charge weapons (VOLTLANCE): the trigger press starts the capacitor bank, the hold time
 * becomes the shot's charge, and the slug leaves on release (or when the bank vents at
 * `holdMaxMs`). A hold that started while the weapon could not fire never charges.
 */
function resolveChargeIntent(p, dt, inp, fireEdge, ctx) {
  const profile = chargeProfile(p.def);
  const held = inp.wantFire;
  if (!p.charging) {
    const pressed = fireEdge || (held && !p.triggerPrev);
    if (pressed && canFire(p, true, ctx)) {
      p.charging = true;
      p.chargeT = 0;
      p.charge = 0;
    }
    return;
  }
  p.chargeT += Math.max(0, dt) * 1000;
  p.charge = chargeFromHold(p.def, p.chargeT);
  const vent = p.chargeT >= profile.holdMaxMs;
  if (held && !vent) return;
  const charge = p.charge;
  cancelCharge(p);
  if (!ctx.canFire(p) || p.reloading || p.deployT > 0 || p.mag[p.weapon] <= 0) return;
  fireOneShot(p, ctx, charge);
}

/**
 * Melee weapons (PIXEL PICK): every swing is free — no magazine, no reload — so
 * the press edge or a held trigger swings at the rpm cadence alone. A short
 * reach cone replaces ballistics entirely (see `meleeSwing`).
 */
function resolveMeleeIntent(p, inp, fireEdge, ctx) {
  if (!(inp.wantFire || fireEdge) || !canFire(p, true, ctx)) return;
  p.cooldown = 60 / p.def.rpm;
  meleeSwing(p, ctx);
}

/**
 * Resolve one accepted swing: the single best-angle living victim inside
 * `melee.reach` (center distance + victim radius) and the `melee.coneDeg` arc,
 * with voxel line of sight from the shooter's eye, takes the hit. A victim
 * facing along the swing direction beyond `melee.backstabDot` is a backstab.
 * Damage flows through the same body-hit event path as `fireOneShot` — kill
 * credit included. Swings without an unobstructed victim mine the aimed block.
 */
function meleeSwing(p, ctx, def = p.def, aim = p) {
  const melee = def.melee;
  p.spawnProtectedUntil = 0;
  p.spawnProtected = false;
  p.shotSeq++;
  p.firing = true;
  const fwd = fwdFromYawPitch(aim.yaw, aim.pitch);
  const oEye = [p.x, p.eyeY, p.z];
  // Same presentation origin as fireOneShot so client FX share one contract.
  const muzzle = [
    oEye[0] + fwd.x * 0.25,
    oEye[1] - 0.15 + fwd.y * 0.25,
    oEye[2] + fwd.z * 0.25,
  ];
  ctx.pushEvent(evShoot(
    p.id, muzzle, [fwd.x, fwd.y, fwd.z], def.id, [fwd.x, fwd.y, fwd.z],
  ));

  chaosShot(p, ctx, fwd, def);
  const cosHalf = Math.cos(melee.coneDeg * Math.PI / 360);
  let best = null;
  let bestDot = -Infinity;
  let bestDist = Infinity;
  for (const v of (ctx.targets || ctx.entities).values()) {
    if (v === p || v.state !== 'alive') continue;
    if (!ctx.canDamage(p, v)) continue;
    const dx = v.x - oEye[0];
    const dy = v.y + PLAYER_HALF.h - oEye[1];
    const dz = v.z - oEye[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > melee.reach + PLAYER_HALF.x) continue;
    const dot = dist > 0 ? (dx * fwd.x + dy * fwd.y + dz * fwd.z) / dist : 1;
    if (dot < cosHalf) continue;
    // Smallest angle to the aim ray wins; ties break to the nearer victim.
    if (dot < bestDot - 1e-9 || (dot <= bestDot + 1e-9 && dist >= bestDist)) {
      continue;
    }
    bestDot = dot;
    bestDist = dist;
    best = { victim: v, dx, dy, dz, dist };
  }
  const mine = () => mineBlock(p, oEye, fwd, ctx, def.melee.reach);
  if (!best) { mine(); return; }

  // Voxel line of sight: a wall between the blade and the body stops the swing.
  const dirX = best.dx / best.dist;
  const dirY = best.dy / best.dist;
  const dirZ = best.dz / best.dist;
  if (raycastVoxels(
    ctx.solidAt,
    oEye[0], oEye[1], oEye[2],
    dirX, dirY, dirZ,
    Math.max(0.05, best.dist - 0.2),
  )) { mine(); return; }

  p.mining = null;
  const victim = best.victim;
  const vFwd = fwdFromYawPitch(victim.yaw, victim.pitch);
  const backstab = vFwd.x * dirX + vFwd.y * dirY + vFwd.z * dirZ > melee.backstabDot;
  const dmg = Math.round(def.damage[0] * (backstab ? melee.backstabMult : 1) * 10) / 10;
  const lethal = victim.takeDamage(dmg, false, p);
  ctx.pushEvent(evHit(p.id, victim.id, dmg, false, [victim.x, victim.eyeY, victim.z], victim.lastDamage));
  if (lethal) ctx.killPlayer(victim, p, def.id, false);
}

/** Accepted swings leave shared damage on the block until it is replaced. */
function mineBlock(p, eye, fwd, ctx, reach) {
  const hit = raycastVoxels(ctx.solidAt, ...eye, fwd.x, fwd.y, fwd.z, reach);
  if (!hit || hit.y <= 0) { p.mining = null; return; }
  const type = ctx.getBlock(hit.x, hit.y, hit.z);
  const required = MINING_HITS[type];
  if (!required) { p.mining = null; return; }
  const key = blockKey(hit.x, hit.y, hit.z);
  const mining = ctx.blockMining || (ctx.blockMining = new Map());
  const previousProgress = blockDamageProgress(key, type, ctx);
  const hits = (mining.get(key) || 0) + 1;
  mining.set(key, hits);
  p.mining = { key, type, hits, at: ctx.now };
  ctx.pushEvent({ t: 'ev', kind: 'mine', id: String(p.id),
    x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz,
    from: type, progress: Math.min(1, hits / required) });
  if (hits >= required) {
    destroyBlock(hit.x, hit.y, hit.z, key, ctx);
    p.mining = null;
  } else {
    publishBlockDamage(hit.x, hit.y, hit.z, type, previousProgress, ctx);
  }
}

/** Position a human shooter saw at its bounded reported presentation age. */
function rewindVictim(v, now, viewAgeMs = NETWORK_PRESENTATION.defaultViewAgeMs) {
  const h = v.hist;
  if (!h || !h.length) return v;
  const boundedAge = Math.max(
    NETWORK_PRESENTATION.minViewAgeMs,
    Math.min(
      NETWORK_PRESENTATION.maxViewAgeMs,
      Number.isFinite(viewAgeMs) ? viewAgeMs : NETWORK_PRESENTATION.defaultViewAgeMs,
    ),
  );
  const readAt = now - boundedAge;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].t <= readAt || i === 0) {
      // Clamp: never use a sample older than the window start.
      if (readAt - h[i].t > HISTORY_WINDOW_MS) return v;
      return h[i];
    }
  }
  return v;
}

export function nearestVictim(shooter, o, d, limit, ctx, minT = 0, radius = 0, hitVictims = null) {
  let best = null, bestT = limit;
  const rewoundByShooter = !shooter.bot;
  for (const v of (ctx.targets || ctx.entities).values()) {
    if (v === shooter || v.state !== 'alive' || hitVictims?.has(v)) continue;
    if (!ctx.canDamage(shooter, v)) continue;
    const pos = rewoundByShooter ? rewindVictim(v, ctx.now, shooter.input?.viewAge) : v;
    const hit = rayPlayerHitboxes(o, d, pos, limit, { minT, radius, preferCore: true });
    if (hit && hit.t < bestT) {
      bestT = hit.t;
      best = { victim: v, x: pos.x, y: pos.y, z: pos.z, ...hit };
    }
  }
  if (!best) return null;
  return { victim: best.victim, t: bestT, rx: best.x, ry: best.y, rz: best.z, radialDistance: best.radialDistance, coreHit: best.coreHit, zone: best.zone };
}

export function blockKey(x, y, z) {
  return x + ',' + y + ',' + z;
}

/** Remove exactly one non-air block and emit its one authoritative mutation. */
export function destroyBlockDirect(x, y, z, key, ctx) {
  const damageKey = key || blockKey(x, y, z);
  const from = ctx.getBlock(x, y, z);
  if (from === BEDROCK) return false;
  if (from === AIR) {
    ctx.blockHp.delete(damageKey);
    ctx.blockMining?.delete(damageKey);
    return false;
  }
  ctx.setBlock(x, y, z, AIR);
  ctx.blockHp.delete(damageKey);
  ctx.blockMining?.delete(damageKey);
  ctx.pushBlockDelta(x, y, z, AIR);
  ctx.pushEvent(evBlock(x, y, z, AIR, from));
  return true;
}

export function destroyBlock(x, y, z, key, ctx) {
  if (!destroyBlockDirect(x, y, z, key, ctx)) return false;

  // Fragile chain-support: GLASS/LEAVES stacked above collapse too.
  const above = ctx.getBlock(x, y + 1, z);
  if (above === GLASS || above === LEAVES) {
    destroyBlock(x, y + 1, z, null, ctx);
  }
  return true;
}

export function damageBlock(x, y, z, type, dmg, ctx) {
  if (y <= 0 || !(dmg > 0) || !Number.isFinite(dmg) || !BLOCK_HP[type] || ctx.getBlock(x, y, z) !== type) return;
  const key = blockKey(x, y, z);
  const previousProgress = blockDamageProgress(key, type, ctx);
  let hp = ctx.blockHp.get(key) ?? BLOCK_HP[type];
  hp -= dmg;
  if (hp <= 0) destroyBlock(x, y, z, key, ctx);
  else {
    ctx.blockHp.set(key, hp);
    publishBlockDamage(x, y, z, type, previousProgress, ctx);
  }
}

/** Bullet HP and mining retain their own balance, sharing one visible state. */
function blockDamageProgress(key, type, ctx) {
  const hp = ctx.blockHp.get(key);
  const bulletProgress = Number.isFinite(hp) && BLOCK_HP[type] ? 1 - hp / BLOCK_HP[type] : 0;
  const miningProgress = (ctx.blockMining?.get(key) || 0) / (MINING_HITS[type] || Infinity);
  return Math.max(0, Math.min(1, Math.max(bulletProgress, miningProgress)));
}

function publishBlockDamage(x, y, z, type, previousProgress, ctx) {
  const progress = blockDamageProgress(blockKey(x, y, z), type, ctx);
  if (progress <= previousProgress) return;
  ctx.pushBlockDamage?.(x, y, z, type, progress);
  ctx.pushEvent({ t: 'ev', kind: 'blockDamage', x, y, z, v: type, from: type,
    progress, previousProgress });
}

/**
 * Resolve one accepted shot, including every pellet, in authoritative order.
 * `charge` (0..1) only applies to `charge` weapons and scales damage (and the
 * lance's wall piercing); hitscan guns pass the default full charge.
 */
export function fireOneShot(p, ctx, charge = 1, aim = null) {
  const def = p.def;
  const shotReach = HITSCAN_REACH;
  p.spawnProtectedUntil = 0;
  p.spawnProtected = false;
  p.mag[p.weapon]--;
  p.cooldown += 60 / def.rpm;
  p.shotSeq++;
  p.firing = true;
  const charged = def.mode === 'charge';
  const charge01 = charged ? Math.max(0, Math.min(1, Number.isFinite(charge) ? charge : 1)) : 1;
  const chargeMult = charged ? chargeDamageMult(def, charge01) : def.id === 'minigun' ? minigunDamageMult(p.minigun) : 1;
  if (def.id === 'minigun') heatMinigun(p.minigun);
  const rng = shotRng(p);
  const fwd = fwdFromYawPitch(aim?.yaw ?? p.yaw, aim?.pitch ?? p.pitch);
  const coneDeg = typeof ctx.computeConeDeg === 'function'
    ? ctx.computeConeDeg(p)
    : computeConeDeg(p);
  p.exhaustion = clamp01(p.exhaustion + CONDITION_RULES.exhaustionShotGain * (def.flame ? 0.25 : 1));
  p.bloom = Math.min(def.bloomMaxDeg, p.bloom + def.bloomDeg);
  const oEye = [p.x, p.eyeY, p.z];
  // Muzzle-ish origin reported to clients: eye dropped 0.15, nudged forward.
  const muzzle = [
    oEye[0] + fwd.x * 0.25,
    oEye[1] - 0.15 + fwd.y * 0.25,
    oEye[2] + fwd.z * 0.25,
  ];

  const firstDir = samplePelletDirection(def, fwd, rng, coneDeg, 0);
  const shootEvent = evShoot(
    p.id, def.flame ? oEye : muzzle, [fwd.x, fwd.y, fwd.z], def.id,
    [firstDir.x, firstDir.y, firstDir.z],
  );
  if (charged) shootEvent.charge = Math.round(charge01 * 1000) / 1000;
  ctx.pushEvent(shootEvent);
  chaosShot(p, ctx, fwd);
  if (def.projectile === 'rocket') {
    // The rocket is its own authoritative entity from here on.
    if (typeof ctx.launchRocket === 'function') ctx.launchRocket(p, firstDir);
    return;
  }
  if (def.projectile === 'bolt' && typeof ctx.launchBolt === 'function') {
    // The LONGARC bolt is its own authoritative entity from here on: it launches
    // and ricochets inside the projectile system, piercing neither players nor
    // walls, so none of the pierce code below may run for it.
    ctx.launchBolt(p, firstDir, charge01);
    return;
  }
  if (def.flame) { ctx.flames.launch(p, oEye, fwd, ctx); return; }
  const shotProfile = chargeShotProfile(def, charge01);
  const playerLimit = Math.max(1, Math.trunc(def.pierce?.players || 1));
  const playerFalloff = def.pierce?.playerFalloff ?? 1;
  // Publish the resolved polyline with the shot so clients never guess a bounce.
  shootEvent.paths = [];
  const nearMisses = new Map();
  const shotHitVictims = new Set();
  for (let pellet = 0; pellet < def.pellets; pellet++) {
    let d = pellet === 0 ? { ...firstDir } : samplePelletDirection(def, fwd, rng, coneDeg, pellet);
    let origin = [...oEye];
    let traveled = 0, damageScale = chargeMult, power = bulletPower(def, charge01), bounces = 0;
    let playersLeft = playerLimit;
    const hitVictims = new Set();
    const path = [];
    shootEvent.paths.push(path);
    for (let contact = 0; contact < BULLET_RULES.maxContacts; contact++) {
      const reach = shotReach - traveled;
      if (!(reach > 0) || damageScale < 0.001) break;
      const hit = raycastVoxels(ctx.solidAt, ...origin, d.x, d.y, d.z, reach);
      const wallT = hit ? hit.t : reach;
      let minT = 0, stopped = false;
      for (;;) {
        const tgt = nearestVictim(p, origin, d, wallT, ctx, minT, shotProfile.hitRadius, hitVictims);
        if (!tgt) break;
        const point = origin.map((value, i) => value + d[['x', 'y', 'z'][i]] * tgt.t);
        if (playersLeft <= 0) { path.push({ o: origin, end: point }); stopped = true; break; }
        const dist = traveled + tgt.t;
        const hs = !!tgt.coreHit && tgt.zone === 'head';
        const radialScale = shotProfile.hitRadius > 0 ? railDamageMult(shotProfile, tgt.radialDistance) : 1;
        const dmg = Math.round(radialScale * damageAtDistance(def, dist) * (hs ? def.headMult : 1) * damageScale * 10) / 10;
        const lethal = tgt.victim.takeDamage(dmg, hs, p);
        ctx.pushEvent(evHit(p.id, tgt.victim.id, dmg, hs, point, tgt.victim.lastDamage));
        if (lethal) ctx.killPlayer(tgt.victim, p, def.id, hs, {
          longRange: dist >= LONG_RANGE_KILL_DISTANCE,
          noScope: def.id === 'sniper' && p.adsT < NO_SCOPE_ADS_THRESHOLD,
        });
        chaosHit(p, tgt.victim, point, ctx);
        hitVictims.add(tgt.victim);
        shotHitVictims.add(tgt.victim);
        playersLeft--;
        if (!def.pierce?.players) { path.push({ o: origin, end: point }); stopped = true; break; }
        damageScale *= playerFalloff;
        power *= playerFalloff;
        minT = tgt.t + 0.001;
      }
      if (stopped) {
        collectNearMisses(p, origin, path[path.length - 1].end, ctx, nearMisses);
        break;
      }
      // Keep empty-sky presentation finite without limiting the damage ray.
      const endT = hit ? hit.t : Math.min(reach, 180);
      const point = origin.map((value, i) => value + d[['x', 'y', 'z'][i]] * endT);
      const segment = { o: origin, end: point };
      path.push(segment);
      // Damage reach may be infinite. Bound the suppression segment by the
      // furthest current player, rather than the shorter tracer presentation.
      let suppressionReach = hit ? hit.t : 0;
      if (!hit) for (const v of ctx.entities.values()) {
        suppressionReach = Math.max(suppressionReach,
          Math.hypot(v.x - origin[0], v.y + 1.05 - origin[1], v.z - origin[2]) + 2);
      }
      collectNearMisses(p, origin, origin.map((v, i) =>
        v + d[['x', 'y', 'z'][i]] * Math.min(reach, suppressionReach)), ctx, nearMisses);
      if (!hit) break;
      segment.hit = { x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz };
      if (hit.y <= 0) break;
      const type = ctx.getBlock(hit.x, hit.y, hit.z);
      const exit = voxelExitDistance(origin, d, hit);
      const dot = d.x * hit.nx + d.y * hit.ny + d.z * hit.nz;
      const result = bulletMaterialImpact({ type, power,
        damage: damageAtDistance(def, traveled + hit.t) * damageScale,
        hp: ctx.blockHp.get(blockKey(hit.x, hit.y, hit.z)) ?? BLOCK_HP[type],
        incidence: hit.nx || hit.ny || hit.nz ? Math.abs(dot) : 1,
        thickness: exit - hit.t, bounces });
      damageBlock(hit.x, hit.y, hit.z, type, result.damage, ctx);
      segment.action = result.action;
      power = result.power;
      damageScale *= result.damageScale;
      if (result.action === 'stop') break;
      if (result.action === 'ricochet') {
        bounces++;
        d = { x: d.x - 2 * dot * hit.nx, y: d.y - 2 * dot * hit.ny, z: d.z - 2 * dot * hit.nz };
        origin = point.map((value, i) => value + d[['x', 'y', 'z'][i]] * BULLET_RULES.epsilon);
        traveled += hit.t + BULLET_RULES.epsilon;
      } else {
        const step = exit + BULLET_RULES.epsilon;
        origin = origin.map((value, i) => value + d[['x', 'y', 'z'][i]] * step);
        traveled += step;
      }
    }
  }
  // Presentation suppresses a flyby when this shot already supplies hit audio.
  if (shotHitVictims.size) shootEvent.hitVictims = [...shotHitVictims].map((victim) => victim.id);
  applyNearMisses(nearMisses, shotHitVictims, ctx);
}
