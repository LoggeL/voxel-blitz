/**
 * Shared client/server contract for the GV-4 RIPTIDE throw-and-return disc: one launch
 * formula, one flight integrator and one damage/ammo rule set so the local prediction,
 * the remote presentation and the authoritative simulation all fly the identical disc.
 *
 * A disc flies an `out` leg in a straight line (no gravity) until `flipAt`, its first
 * wall contact (one reflection) or an R press, then a `back` leg that steers toward the
 * owner's chest with a capped turn rate. A wall on the back leg embeds the disc.
 */
import { WEAPONS } from './combatmath.js';
import { COMBAT_DAMAGE_SCALE } from './combat-balance.js';

export const GLAIVE_RULES = WEAPONS.glaive.glaive;
/** The return leg aims at the chest: this far below the eye. */
export const GLAIVE_CHEST_DROP = 0.35;
/** Embedded-disc pickup height band around the owner's feet, metres. */
const PICKUP_BELOW = 0.75;
const PICKUP_ABOVE = 2.35;
const D2R = Math.PI / 180;

const rulesOf = (rules) => rules || GLAIVE_RULES;

/**
 * Launch state for a disc leaving the spindle: a point just ahead of the eye on the aim
 * ray plus a straight velocity along the (already spread-sampled) unit `dir`. `now` is
 * the authority clock in ms; `rules` lets a Chaos-modified def lengthen the out leg.
 */
export function glaiveLaunch({ x, y, z, dir, now = 0, rules }) {
  const r = rulesOf(rules);
  const d = dir || { x: 0, y: 0, z: -1 };
  return {
    type: 'glaive',
    phase: 'out',
    x: x + d.x * 0.45,
    y: y + d.y * 0.45,
    z: z + d.z * 0.45,
    vx: d.x * r.speedOut,
    vy: d.y * r.speedOut,
    vz: d.z * r.speedOut,
    bouncesLeft: r.bounces,
    launchedAt: now,
    flipAt: now + r.outMs,
    flippedAt: null,
    expiresAt: now + r.lifetimeMs,
  };
}

/**
 * Switch a disc into its return leg at `now` and rescale it to the return speed while
 * keeping its heading (the steer then bends it home). Returns false when it already
 * was returning. `reason` ('time'|'bounce'|'return') is kept for presentation.
 */
export function glaiveFlip(disc, now, reason = 'time', rules) {
  if (disc.phase !== 'out') return false;
  const r = rulesOf(rules);
  const speed = Math.hypot(disc.vx, disc.vy, disc.vz);
  const scale = speed > 1e-6 ? r.speedBack / speed : 0;
  disc.vx *= scale; disc.vy *= scale; disc.vz *= scale;
  disc.phase = 'back';
  disc.flippedAt = now;
  disc.flipped = reason;
  return true;
}

/** The point a returning disc steers toward and is caught at: the owner's chest. */
export function glaiveTarget(owner) {
  if (!owner) return null;
  const eyeY = Number.isFinite(owner.eyeY) ? owner.eyeY : owner.y;
  return { x: owner.x, y: eyeY - GLAIVE_CHEST_DROP, z: owner.z };
}

/**
 * Rotate the velocity of `disc` toward `target` by at most `turnDegPerSec * dt`, keeping
 * its speed. A disc with its owner behind it yaws around in a level, boomerang-like loop,
 * so the return always traces a visible curve instead of snapping back or diving.
 */
export function steerGlaive(disc, dt, target, rules) {
  const r = rulesOf(rules);
  const speed = Math.hypot(disc.vx, disc.vy, disc.vz);
  if (!(speed > 1e-6) || !target) return disc;
  const dx = target.x - disc.x, dy = target.y - disc.y, dz = target.z - disc.z;
  const dist = Math.hypot(dx, dy, dz);
  if (!(dist > 1e-6)) return disc;
  const ux = disc.vx / speed, uy = disc.vy / speed, uz = disc.vz / speed;
  const wx = dx / dist, wy = dy / dist, wz = dz / dist;
  const cos = Math.max(-1, Math.min(1, ux * wx + uy * wy + uz * wz));
  const angle = Math.acos(cos);
  const maxTurn = r.turnDegPerSec * D2R * Math.max(0, dt);
  if (angle <= maxTurn) {
    disc.vx = wx * speed; disc.vy = wy * speed; disc.vz = wz * speed;
    return disc;
  }
  // Unit vector perpendicular to u toward which the heading turns. While the target is
  // behind the disc it banks like a boomerang, yawing about world up toward the target's
  // side (left when dead astern), so a level throw loops level instead of diving into
  // the floor; once the target is ahead it slerps in the u/w plane. Antiparallel or
  // vertical headings fall back to the axis around world up (or +x when vertical).
  let px, py, pz, pl = 0;
  if (cos < 0) {
    const side = uz * wx - ux * wz;
    const sign = side < -1e-6 ? -1 : 1;
    px = uz * sign; py = 0; pz = -ux * sign;
    pl = Math.hypot(px, pz);
  }
  if (pl < 1e-6) {
    px = wx - cos * ux; py = wy - cos * uy; pz = wz - cos * uz;
    pl = Math.hypot(px, py, pz);
  }
  if (pl < 1e-6) {
    px = -uz; py = 0; pz = ux;
    pl = Math.hypot(px, py, pz);
    if (pl < 1e-6) { px = 1; py = 0; pz = 0; pl = 1; }
  }
  px /= pl; py /= pl; pz /= pl;
  const c = Math.cos(maxTurn), s = Math.sin(maxTurn);
  disc.vx = (ux * c + px * s) * speed;
  disc.vy = (uy * c + py * s) * speed;
  disc.vz = (uz * c + pz * s) * speed;
  return disc;
}

/** Squared distance from point `p` to the segment a→b. */
function segmentDistanceSq(a, b, p) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  const t = len2 > 1e-12
    ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2)) : 0;
  const x = a.x + abx * t - p.x, y = a.y + aby * t - p.y, z = a.z + abz * t - p.z;
  return x * x + y * y + z * z;
}

/**
 * Advance one disc by `dt` seconds. Per-step results are reset and then reported on the
 * disc: `flipped` ('time'|'bounce' when the leg changed this step), `bounced` (the
 * reflected wall contact), `hit` (the embedding wall contact on the back leg), `caught`
 * (the back leg passed within `catchRadius` of `target`) and `expired` (lifetime spent).
 * `raycast` is the shared DDA returning `{x,y,z,nx,ny,nz,t}`; `target` is the owner's
 * chest (`glaiveTarget`) or null once the owner is gone. Observers:
 * `onTravel(from, disc)` sees every traveled segment (return true to stop the step);
 * `onBounce(contact)` the out-leg reflection; `onEmbed(contact)` the back-leg wall hit.
 * `now` (ms) drives the timed flip and the lifetime; omit it to fly without timers.
 */
export function stepGlaive(disc, dt, raycast, target, { onTravel, onBounce, onEmbed, now, rules } = {}) {
  const r = rulesOf(rules);
  const step = Math.max(0, Number(dt) || 0);
  disc.hit = null;
  disc.bounced = null;
  disc.caught = false;
  disc.flipped = null;
  disc.expired = false;
  if (Number.isFinite(now)) {
    if (now >= disc.expiresAt) {
      disc.expired = true;
      return disc;
    }
    if (disc.phase === 'out' && now >= disc.flipAt) glaiveFlip(disc, now, 'time', r);
  }
  if (disc.phase === 'back') steerGlaive(disc, step, target, r);
  const speed = Math.hypot(disc.vx, disc.vy, disc.vz);
  let budget = speed * step;
  if (!(budget > 1e-6)) return disc;
  let ux = disc.vx / speed;
  let uy = disc.vy / speed;
  let uz = disc.vz / speed;
  const catchSq = r.catchRadius * r.catchRadius;
  let guard = 0;
  while (budget > 1e-6 && guard++ < 6) {
    const hit = raycast(disc.x, disc.y, disc.z, ux, uy, uz, budget + r.radius);
    const t = hit ? Math.min(budget, Math.max(0, hit.t - r.radius * 0.5)) : budget;
    const from = { x: disc.x, y: disc.y, z: disc.z };
    disc.x += ux * t;
    disc.y += uy * t;
    disc.z += uz * t;
    budget -= t;
    if (onTravel?.(from, disc)) return disc;
    disc.traveled = (disc.traveled || 0) + t;
    if (disc.phase === 'back' && target && segmentDistanceSq(from, disc, target) <= catchSq) {
      disc.caught = true;
      return disc;
    }
    if (!hit) return disc;
    const contact = { x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz, t };
    const normalLength = Math.hypot(hit.nx, hit.ny, hit.nz);
    if (disc.phase !== 'out' || (disc.bouncesLeft ?? 0) <= 0
      || !Number.isFinite(normalLength) || normalLength < 0.5) {
      disc.hit = contact;
      onEmbed?.(contact);
      return disc;
    }
    // The first out-leg wall contact reflects exactly like a LONGARC bolt and turns
    // the disc home at once; the leftover distance flies at the return speed.
    disc.bouncesLeft -= 1;
    disc.bounced = contact;
    const dot = disc.vx * hit.nx + disc.vy * hit.ny + disc.vz * hit.nz;
    disc.vx -= 2 * dot * hit.nx;
    disc.vy -= 2 * dot * hit.ny;
    disc.vz -= 2 * dot * hit.nz;
    const left = Math.hypot(disc.vx, disc.vy, disc.vz);
    if (!(left > 1e-6)) {
      disc.hit = contact;
      onEmbed?.(contact);
      return disc;
    }
    budget *= r.speedBack / left;
    glaiveFlip(disc, Number.isFinite(now) ? now : disc.flippedAt, 'bounce', r);
    onBounce?.(contact);
    ux = disc.vx / r.speedBack;
    uy = disc.vy / r.speedBack;
    uz = disc.vz / r.speedBack;
    disc.x += hit.nx * 0.002;
    disc.y += hit.ny * 0.002;
    disc.z += hit.nz * 0.002;
  }
  return disc;
}

/**
 * Raw per-hit damage before `combatDamage` scaling: the leg's base damage, reduced by
 * `pierceFalloff` for every body the disc already cut on this leg (`n` = 0 for the
 * first), times `headMult` on a headshot. Rounded to 0.1 like the bolt path.
 */
export function glaiveLegDamage(leg, n = 0, head = false, rules) {
  const r = rulesOf(rules);
  const base = leg === 'back' ? r.backDamage : r.outDamage;
  const pierced = Math.max(0, Math.trunc(Number(n) || 0));
  const raw = base * r.pierceFalloff ** pierced * (head ? WEAPONS.glaive.headMult : 1);
  return Math.round(raw * 10) / 10;
}

/** The same hit after the global time-to-kill scale: what the victim actually loses. */
export function glaiveHitDamage(leg, n = 0, head = false, rules) {
  return glaiveLegDamage(leg, n, head, rules) * COMBAT_DAMAGE_SCALE;
}

/** Fire gate: a disc must be seated and fewer than `magSize` may already be flying. */
export function glaiveCanThrow(mag, inFlight, magSize = WEAPONS.glaive.magSize) {
  return (mag | 0) > 0 && (inFlight | 0) < magSize;
}

/**
 * Pure core of the ammo invariant `mag + inFlight + embedded + fab <= magSize`. Discs in
 * the air are never trimmed; the excess is removed from pending fabrications first, then
 * embedded pickups, then the seated count (clamped at 0). Returns the new `mag` plus how
 * many `fab` entries and embedded pickups the caller must drop (oldest first is fine).
 */
export function trimGlaiveAmmo({ magSize, mag = 0, inFlight = 0, embedded = 0, fab = 0 }) {
  const cap = Math.max(0, magSize | 0);
  let seated = Math.max(0, mag | 0);
  let excess = seated + Math.max(0, inFlight | 0) + Math.max(0, embedded | 0) + Math.max(0, fab | 0) - cap;
  const dropFab = Math.max(0, Math.min(fab | 0, excess));
  excess -= dropFab;
  const dropEmbedded = Math.max(0, Math.min(embedded | 0, excess));
  excess -= dropEmbedded;
  if (excess > 0) seated = Math.max(0, seated - excess);
  return { mag: seated, dropFab, dropEmbedded };
}

/**
 * Owner-only pickup test for an embedded disc at `pos`: horizontal reach within
 * `pickupRadius` (the powerup dx/dz test) and the disc inside the body's height band,
 * so a disc embedded chest-high in a wall is collected by walking up to it.
 */
export function glaivePickupReached(pos, player, rules) {
  const r = rulesOf(rules);
  if (!pos || !player) return false;
  const dy = pos.y - player.y;
  if (dy < -PICKUP_BELOW || dy > PICKUP_ABOVE) return false;
  return Math.hypot(pos.x - player.x, pos.z - player.z) <= r.pickupRadius;
}
