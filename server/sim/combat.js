// Authoritative weapon intent, ballistics, and destructible-block damage.
// The caller owns world/entity state and exposes only the narrow operations
// needed by this hot path through `ctx`.

import { AIR, GLASS, LEAVES, BLOCK_HP } from '../../shared/worlddata.js';
import {
  CONDITION_RULES,
  PLAYER_HALF,
  HEADSHOT_Y_FRAC,
  damageAtDistance,
  sampleSpreadDir,
  computeSpreadConeDeg,
} from '../../shared/combatmath.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evShoot, evHit, evBlock } from '../protocol.js';
import {
  clamp01,
  clampWeaponSlot,
  fwdFromYawPitch,
  shotRng,
} from './player.js';

export const SHOT_REACH = 120;
const P_HEIGHT = PLAYER_HALF.h * 2;
const BLOCK_MIN_DMG = 12;
const REWIND_MS = 100;
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

export function switchWeapon(p, slot) {
  p.weapon = clampWeaponSlot(slot);
  p.reloading = false;
  p.reloadT = 0;
  p.cooldown = Math.max(p.cooldown, 0);
  p.deployT = p.def.deployTime;
  p.ads = false;
  p.adsT = 0;
}

export function canFire(p, fireEdge, ctx) {
  const semi = p.def.mode !== 'auto';
  return ctx.canFire(p) && !p.reloading && p.deployT <= 0 &&
    p.cooldown <= 0 && p.mag[p.weapon] > 0 &&
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
  if (!inp) { p.triggerPrev = false; return; }

  // A new selection interrupts the current draw and starts the selected
  // weapon's full deploy timer, matching the client-side equip contract.
  if (inp.switchTo != null &&
      inp.switchTo !== p.weapon &&
      ctx.canUseWeapon(p, inp.switchTo)) {
    switchWeapon(p, inp.switchTo);
  }

  const def = p.def;
  if (inp.reload && ctx.canUseWeapon(p, p.weapon) &&
      !p.reloading && p.deployT <= 0 &&
      p.mag[p.weapon] < def.magSize && p.reserve[p.weapon] > 0) {
    p.reloading = true;
    p.reloadT = p.mag[p.weapon] > 0 ? def.tacTime : def.reloadTime;
  }

  const fireEdge = p.fireEdgeQueued;
  p.fireEdgeQueued = false;
  if ((inp.wantFire || fireEdge) && canFire(p, fireEdge, ctx)) fireOneShot(p, ctx);
  p.triggerPrev = inp.wantFire;
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

/** Position a human shooter saw after the fixed interpolation rewind. */
export function rewindVictim(v, now) {
  const h = v.hist;
  if (!h || !h.length) return v;
  const readAt = now - REWIND_MS;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].t <= readAt || i === 0) {
      // Clamp: never use a sample older than the window start.
      if (readAt - h[i].t > HISTORY_WINDOW_MS) return v;
      return h[i];
    }
  }
  return v;
}

export function nearestVictim(shooter, o, d, limit, ctx) {
  let best = null, bestT = limit;
  const rewoundByShooter = !shooter.bot;
  for (const v of ctx.entities.values()) {
    if (v === shooter || v.state !== 'alive') continue;
    if (!ctx.canDamage(shooter, v)) continue;
    const pos = rewoundByShooter ? rewindVictim(v, ctx.now) : v;
    const t = rayAABB(
      o, d,
      pos.x - PLAYER_HALF.x, pos.y, pos.z - PLAYER_HALF.x,
      pos.x + PLAYER_HALF.x, pos.y + P_HEIGHT, pos.z + PLAYER_HALF.x,
    );
    if (t != null && t < bestT) {
      bestT = t;
      best = { victim: v, x: pos.x, y: pos.y, z: pos.z };
    }
  }
  if (!best) return null;
  return { victim: best.victim, t: bestT, rx: best.x, ry: best.y, rz: best.z };
}

export function blockKey(x, y, z) {
  return x + ',' + y + ',' + z;
}

export function destroyBlock(x, y, z, key, ctx) {
  const from = ctx.getBlock(x, y, z);
  ctx.setBlock(x, y, z, AIR);
  if (key) ctx.blockHp.delete(key);
  else ctx.blockHp.delete(blockKey(x, y, z));
  ctx.pushBlockDelta(x, y, z, AIR);
  ctx.pushEvent(evBlock(x, y, z, AIR, from));

  // Fragile chain-support: GLASS/LEAVES stacked above collapse too.
  const above = ctx.getBlock(x, y + 1, z);
  if (above === GLASS || above === LEAVES) {
    destroyBlock(x, y + 1, z, null, ctx);
  }
}

export function damageBlock(x, y, z, type, dmg, ctx) {
  const key = blockKey(x, y, z);
  let hp = ctx.blockHp.has(key) ? ctx.blockHp.get(key) : BLOCK_HP[type];
  hp -= dmg;
  if (hp <= 0) destroyBlock(x, y, z, key, ctx);
  else ctx.blockHp.set(key, hp);
}

/** Resolve one accepted shot, including every pellet, in authoritative order. */
export function fireOneShot(p, ctx) {
  const def = p.def;
  p.spawnProtectedUntil = 0;
  p.spawnProtected = false;
  p.mag[p.weapon]--;
  p.cooldown += 60 / def.rpm;
  p.shotSeq++;
  p.firing = true;

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

  const firstDir = sampleSpreadDir(fwd, rng, coneDeg);
  ctx.pushEvent(evShoot(
    p.id, muzzle, [fwd.x, fwd.y, fwd.z], def.id,
    [firstDir.x, firstDir.y, firstDir.z],
  ));
  for (let pellet = 0; pellet < def.pellets; pellet++) {
    const d = pellet === 0 ? firstDir : sampleSpreadDir(fwd, rng, coneDeg);

    const hit = raycastVoxels(
      ctx.solidAt,
      oEye[0], oEye[1], oEye[2],
      d.x, d.y, d.z,
      SHOT_REACH,
    );
    const wallT = hit ? hit.t : SHOT_REACH;

    const tgt = nearestVictim(p, oEye, d, wallT, ctx);
    if (tgt) {
      const ix = oEye[0] + d.x * tgt.t;
      const iy = oEye[1] + d.y * tgt.t;
      const iz = oEye[2] + d.z * tgt.t;
      const hs = iy - tgt.ry > HEADSHOT_Y_FRAC * P_HEIGHT;
      let dmg = damageAtDistance(def, tgt.t) * (hs ? def.headMult : 1);
      dmg = Math.round(dmg * 10) / 10;
      const lethal = tgt.victim.takeDamage(dmg, hs);
      ctx.pushEvent(evHit(p.id, tgt.victim.id, dmg, hs, [ix, iy, iz]));
      if (lethal) ctx.killPlayer(tgt.victim, p, def.id, hs);
    } else if (hit) {
      const type = ctx.getBlock(hit.x, hit.y, hit.z);
      if (BLOCK_HP[type] != null) {
        const dmgB = Math.max(BLOCK_MIN_DMG, Math.round(damageAtDistance(def, hit.t)));
        damageBlock(hit.x, hit.y, hit.z, type, dmgB, ctx);
      }
      // Indestructible types simply terminate the tracer here.
    }
  }
}
