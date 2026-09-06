import { createMinigunState, stepMinigun, heatMinigun, minigunDamageMult } from '../../shared/minigun.js';
import { fireFlame } from './fire.js';
import { rayPlayerHitboxes } from '../../shared/player-hitboxes.js';
import { chaosShot, chaosHit } from './chaos-combat.js';
// Authoritative weapon intent, ballistics, and destructible-block damage.
// The caller owns world/entity state and exposes only the narrow operations
// needed by this hot path through `ctx`.

import { MINING_HITS } from '../../shared/world/blocks.js';
import { weaponSwapProfile } from '../../shared/weapon-swap.js';
import { AIR, GLASS, LEAVES, BLOCK_HP } from '../../shared/worlddata.js';
import {
  CONDITION_RULES,
  SNIPER_SCOPE_ADS_THRESHOLD,
  PLAYER_HALF,
  damageAtDistance,
  reloadPlan,
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
import { evShoot, evHit, evBlock } from '../protocol.js';
import {
  clamp01,
  clampWeaponSlot,
  fwdFromYawPitch,
  shotRng,
} from './player.js';

export const SHOT_REACH = 120;
export const LONG_RANGE_KILL_DISTANCE = 40;
export const NO_SCOPE_ADS_THRESHOLD = SNIPER_SCOPE_ADS_THRESHOLD;
const BLOCK_MIN_DMG = 12;
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
  const minigunHeld = p.def.id === 'minigun' && inp?.wantFire &&
    (inp.switchTo == null || inp.switchTo === p.weapon) && !inp.reload &&
    ctx.canFire(p) && !p.vault && !p.reloading && p.deployT <= 0 && p.mag[p.weapon] > 0;
  const minigunReady = stepMinigun(p.minigun, _dt, minigunHeld);
  if (!inp?.wantFire && !p.fireEdgeQueued) p.mining = null;
  if (!inp) { p.triggerPrev = false; p.reloadPrev = false; return; }
  const reloadEdge = !!inp.reload && !p.reloadPrev;
  p.reloadPrev = !!inp.reload;

  // A new selection interrupts the current draw and starts the selected
  // weapon's full deploy timer, matching the client-side equip contract.
  if (inp.switchTo != null &&
      inp.switchTo !== p.weapon &&
      ctx.canUseWeapon(p, inp.switchTo)) {
    switchWeapon(p, inp.switchTo);
  }

  if (p.vault) { cancelCharge(p); p.triggerPrev = !!inp.wantFire; return; }
  const def = p.def;
  if (reloadEdge && ctx.canUseWeapon(p, p.weapon) &&
      !p.reloading && p.deployT <= 0 &&
      p.mag[p.weapon] < def.magSize && p.reserve[p.weapon] > 0) {
    const plan = reloadPlan(def, p.mag[p.weapon]);
    cancelCharge(p);
    p.reloading = true;
    if (plan.staged) {
      // Tube: rounds seat one by one and the chambered rounds stay usable.
      p.reloadStage = 'start';
      p.reloadLoose = 0;
      p.reloadT = plan.startSeconds;
    } else {
      p.reloadStage = null;
      p.reloadT = plan.seconds;
      // Dropping a magazine is irreversible, even if the reload is interrupted.
      // The replacement spare is consumed only when it is seated successfully.
      p.mag[p.weapon] = 0;
    }
  }

  const fireEdge = p.fireEdgeQueued;
  p.fireEdgeQueued = false;
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
  if (wantsShot && canFire(p, fireEdge, ctx)) fireOneShot(p, ctx);
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
function meleeSwing(p, ctx) {
  const def = p.def;
  const melee = def.melee;
  p.spawnProtectedUntil = 0;
  p.spawnProtected = false;
  p.shotSeq++;
  p.firing = true;
  const fwd = fwdFromYawPitch(p.yaw, p.pitch);
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

  chaosShot(p, ctx, fwd);
  const cosHalf = Math.cos(melee.coneDeg * Math.PI / 360);
  let best = null;
  let bestDot = -Infinity;
  let bestDist = Infinity;
  for (const v of ctx.entities.values()) {
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
  const mine = () => mineBlock(p, oEye, fwd, ctx);
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
  const lethal = victim.takeDamage(dmg, false);
  ctx.pushEvent(evHit(p.id, victim.id, dmg, false, [victim.x, victim.eyeY, victim.z]));
  if (lethal) ctx.killPlayer(victim, p, def.id, false);
}

/** Mining progress belongs to a player and expires when swings stop. */
function mineBlock(p, eye, fwd, ctx) {
  const hit = raycastVoxels(ctx.solidAt, ...eye, fwd.x, fwd.y, fwd.z, p.def.melee.reach);
  if (!hit || hit.y <= 0) { p.mining = null; return; }
  const type = ctx.getBlock(hit.x, hit.y, hit.z);
  const required = MINING_HITS[type];
  if (!required) { p.mining = null; return; }
  const key = blockKey(hit.x, hit.y, hit.z);
  const previous = p.mining;
  const hits = previous?.key === key && previous.type === type && ctx.now - previous.at < 800
    ? previous.hits + 1 : 1;
  p.mining = { key, type, hits, at: ctx.now };
  ctx.pushEvent({ t: 'ev', kind: 'mine', id: String(p.id),
    x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz,
    from: type, progress: Math.min(1, hits / required) });
  if (hits >= required) {
    destroyBlock(hit.x, hit.y, hit.z, key, ctx);
    p.mining = null;
  }
}

/** Segment (array origin o, unit object direction d) vs victim AABB. */
export function rayAABB(o, d, mnX, mnY, mnZ, mxX, mxY, mxZ) {
  let t0 = -Infinity, t1 = Infinity;
  const axes = [
    [o[0], d.x, mnX, mxX],
    [o[1], d.y, mnY, mxY],
    [o[2], d.z, mnZ, mxZ],
  ];
  for (let i = 0; i < 3; i++) {
    const ov = axes[i][0], dv = axes[i][1];
    if (Math.abs(dv) < 1e-9) {
      if (ov < axes[i][2] || ov > axes[i][3]) return null;
    } else {
      let ta = (axes[i][2] - ov) / dv;
      let tb = (axes[i][3] - ov) / dv;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
  }
  if (t1 < t0 || t1 < 0) return null;
  return Math.max(t0, 0);
}

/** Position a human shooter saw at its bounded reported presentation age. */
export function rewindVictim(v, now, viewAgeMs = NETWORK_PRESENTATION.defaultViewAgeMs) {
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
  for (const v of ctx.entities.values()) {
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
  const from = ctx.getBlock(x, y, z);
  if (from === AIR) {
    if (key) ctx.blockHp.delete(key);
    else ctx.blockHp.delete(blockKey(x, y, z));
    return false;
  }
  ctx.setBlock(x, y, z, AIR);
  if (key) ctx.blockHp.delete(key);
  else ctx.blockHp.delete(blockKey(x, y, z));
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
  const key = blockKey(x, y, z);
  let hp = ctx.blockHp.has(key) ? ctx.blockHp.get(key) : BLOCK_HP[type];
  hp -= dmg;
  if (hp <= 0) destroyBlock(x, y, z, key, ctx);
  else ctx.blockHp.set(key, hp);
}

/**
 * Resolve one accepted shot, including every pellet, in authoritative order.
 * `charge` (0..1) only applies to `charge` weapons and scales damage (and the
 * lance's wall piercing); hitscan guns pass the default full charge.
 */
export function fireOneShot(p, ctx, charge = 1) {
  const def = p.def;
  const shotReach = def.range ?? SHOT_REACH;
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
  const fwd = fwdFromYawPitch(p.yaw, p.pitch);
  const coneDeg = typeof ctx.computeConeDeg === 'function'
    ? ctx.computeConeDeg(p)
    : computeConeDeg(p);
  p.exhaustion = clamp01(p.exhaustion + CONDITION_RULES.exhaustionShotGain);
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
    p.id, muzzle, [fwd.x, fwd.y, fwd.z], def.id,
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
  if (def.flame) { fireFlame(p, oEye, fwd, ctx); return; }
  const pierce = def.pierce;
  const piercePlayers = Number.isFinite(pierce?.players) ? Math.max(0, Math.trunc(pierce.players)) : 0;
  const shotProfile = chargeShotProfile(def, charge01);
  const pierceWalls = shotProfile.walls;
  const playerFalloff = Number.isFinite(pierce?.playerFalloff) ? pierce.playerFalloff : 1;
  const wallFalloff = Number.isFinite(pierce?.wallFalloff) ? pierce.wallFalloff : 1;
  const piercing = piercePlayers > 0 || pierceWalls > 0;
  for (let pellet = 0; pellet < def.pellets; pellet++) {
    const d = pellet === 0
      ? firstDir
      : samplePelletDirection(def, fwd, rng, coneDeg, pellet);

    if (!piercing) {
      const hit = raycastVoxels(
        ctx.solidAt,
        oEye[0], oEye[1], oEye[2],
        d.x, d.y, d.z,
        shotReach,
      );
      const wallT = hit ? hit.t : shotReach;

      const tgt = nearestVictim(p, oEye, d, wallT, ctx);
      if (tgt) {
        const ix = oEye[0] + d.x * tgt.t;
        const iy = oEye[1] + d.y * tgt.t;
        const iz = oEye[2] + d.z * tgt.t;
        const hs = tgt.zone === 'head';
        let dmg = damageAtDistance(def, tgt.t) * (hs ? def.headMult : 1) * chargeMult;
        dmg = Math.round(dmg * 10) / 10;
        const lethal = tgt.victim.takeDamage(dmg, hs);
        ctx.pushEvent(evHit(p.id, tgt.victim.id, dmg, hs, [ix, iy, iz]));
        if (lethal) ctx.killPlayer(tgt.victim, p, def.id, hs, {
          longRange: tgt.t >= LONG_RANGE_KILL_DISTANCE,
          noScope: def.id === 'sniper' && p.adsT < NO_SCOPE_ADS_THRESHOLD,
        });
        chaosHit(p, tgt.victim, [ix, iy, iz], ctx);
      } else if (hit) {
        const type = ctx.getBlock(hit.x, hit.y, hit.z);
        if (BLOCK_HP[type] != null) {
          const dmgB = Math.max(BLOCK_MIN_DMG, Math.round(damageAtDistance(def, hit.t)));
          damageBlock(hit.x, hit.y, hit.z, type, dmgB, ctx);
        }
        // Indestructible types simply terminate the tracer here.
      }
      continue;
    }

    // Rail slug: one ray per pellet that keeps going through players and walls.
    // State resets per pellet; distances stay absolute from the eye for falloff.
    let ox = oEye[0], oy = oEye[1], oz = oEye[2];
    let traveled = 0;
    let dmgMult = chargeMult;
    let playersLeft = piercePlayers;
    let wallsLeft = pierceWalls;
    const hitVictims = new Set();
    for (;;) {
      const reach = shotReach - traveled;
      if (!(reach > 0)) break;
      const o = [ox, oy, oz];
      const hit = raycastVoxels(
        ctx.solidAt,
        ox, oy, oz,
        d.x, d.y, d.z,
        reach,
      );
      const wallSegT = hit ? hit.t : reach;
      let minT = 0;
      let stoppedInFlesh = false;
      for (;;) {
        const tgt = nearestVictim(p, o, d, wallSegT, ctx, minT, shotProfile.hitRadius, hitVictims);
        if (!tgt) break;
        // `pierce.players` caps the victims the slug damages; the next body in
        // line stops it (the lance pierces up to 6 players and, on a full charge,
        // crosses up to 8 voxels, including solid stone and metal; LONGARC is a bouncing bolt and never
        // reaches this path).
        if (playersLeft <= 0) { stoppedInFlesh = true; break; }
        const dist = traveled + tgt.t;
        const ix = ox + d.x * tgt.t;
        const iy = oy + d.y * tgt.t;
        const iz = oz + d.z * tgt.t;
        const hs = tgt.coreHit && tgt.zone === 'head';
        let dmg = railDamageMult(shotProfile, tgt.radialDistance) * damageAtDistance(def, dist) * (hs ? def.headMult : 1) * dmgMult;
        dmg = Math.round(dmg * 10) / 10;
        const lethal = tgt.victim.takeDamage(dmg, hs);
        ctx.pushEvent(evHit(p.id, tgt.victim.id, dmg, hs, [ix, iy, iz]));
        if (lethal) ctx.killPlayer(tgt.victim, p, def.id, hs, {
          longRange: dist >= LONG_RANGE_KILL_DISTANCE,
          noScope: def.id === 'sniper' && p.adsT < NO_SCOPE_ADS_THRESHOLD,
        });
        chaosHit(p, tgt.victim, [ix, iy, iz], ctx);
        hitVictims.add(tgt.victim);
        playersLeft -= 1;
        dmgMult *= playerFalloff;
        minT = tgt.t + 0.1;
      }
      if (stoppedInFlesh) break;
      if (!hit) break;
      const wallType = ctx.getBlock(hit.x, hit.y, hit.z);
      if (wallsLeft <= 0) {
        const type = ctx.getBlock(hit.x, hit.y, hit.z);
        if (BLOCK_HP[type] != null) {
          const dmgB = Math.max(BLOCK_MIN_DMG, Math.round(damageAtDistance(def, traveled + hit.t) * dmgMult));
          damageBlock(hit.x, hit.y, hit.z, type, dmgB, ctx);
        }
        // Indestructible types simply terminate the tracer here.
        break;
      }
      if (BLOCK_HP[wallType] != null) {
        damageBlock(hit.x, hit.y, hit.z, wallType,
          Math.max(BLOCK_MIN_DMG, Math.round(damageAtDistance(def, traveled + hit.t) * dmgMult)), ctx);
      }
      // Damage the pierced voxel and resume past its far face. The DDA reports
      // an origin voxel immediately, so entry + 0.05 would re-hit this same wall;
      // stepping to the far face + 0.05 carries the identical 0.05 epsilon.
      wallsLeft -= 1;
      dmgMult *= wallFalloff;
      let tExit = Infinity;
      if (d.x > 0) tExit = Math.min(tExit, (hit.x + 1 - ox) / d.x);
      else if (d.x < 0) tExit = Math.min(tExit, (hit.x - ox) / d.x);
      if (d.y > 0) tExit = Math.min(tExit, (hit.y + 1 - oy) / d.y);
      else if (d.y < 0) tExit = Math.min(tExit, (hit.y - oy) / d.y);
      if (d.z > 0) tExit = Math.min(tExit, (hit.z + 1 - oz) / d.z);
      else if (d.z < 0) tExit = Math.min(tExit, (hit.z - oz) / d.z);
      if (!Number.isFinite(tExit) || tExit < hit.t) tExit = hit.t;
      const step = tExit + 0.05;
      ox += d.x * step;
      oy += d.y * step;
      oz += d.z * step;
      traveled += step;
    }
  }
}
