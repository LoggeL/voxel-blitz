/**
 * GL-3 SKIPJACK: shared authority and client flight/blast contract.
 * A launched 40 mm round follows a real arc, skips off solid faces, arms shortly
 * after leaving the muzzle, detonates on an armed body/solid contact, or airbursts
 * at the fixed fuse. Blast damage is intentionally below a one-hit kill.
 */
export const MGL_RULES = Object.freeze({
  speed: 26,
  gravity: 11,
  radius: 0.11,
  fuseMs: 2600,
  armMs: 160,
  maxBounces: 4,
  bounce: 0.46,
  floorFriction: 0.78,
  wallDamping: 0.86,
  splashDamage: 60,
  directDamage: 20,
  damageRadius: 4.5,
  damageFalloffExponent: 1.15,
  selfDamage: 0.35,
  knockback: 8.5,
  selfKnockback: 8,
  knockbackRadius: 4.5,
  knockbackFalloff: 0.65,
  terrainRadius: 0,
  terrainPower: 0,
  maxDestroyedBlocks: 0,
  muzzleForward: 0.52,
  muzzleDrop: 0.12,
  color: '#c5a84b',
});

/** Spawn a round just ahead of the eye along the already spread-sampled aim. */
export function mglLaunch({ x, y, z, dir }) {
  const d = dir || { x: 0, y: 0, z: -1 };
  const length = Math.hypot(d.x || 0, d.y || 0, d.z || 0) || 1;
  return {
    type: 'mgl',
    x: x + d.x / length * MGL_RULES.muzzleForward,
    y: y - MGL_RULES.muzzleDrop + d.y / length * MGL_RULES.muzzleForward,
    z: z + d.z / length * MGL_RULES.muzzleForward,
    vx: d.x / length * MGL_RULES.speed,
    vy: d.y / length * MGL_RULES.speed,
    vz: d.z / length * MGL_RULES.speed,
    bouncesLeft: MGL_RULES.maxBounces,
  };
}

/**
 * Advance one MGL round using a short swept step per voxel contact. Mutates `round`;
 * `hitSolid` is set only when the round has spent its bounce budget and reaches a
 * further surface. Server and client share this integrator.
 */
export function stepMgl(round, dt, raycast) {
  const duration = Number.isFinite(dt) ? Math.max(0, Math.min(0.05, dt)) : 0;
  round.hit = null;
  round.hitSolid = false;
  round.bounced = false;
  if (!duration) return round;
  const speed = Math.hypot(round.vx, round.vy, round.vz) + MGL_RULES.gravity * duration;
  const count = Math.max(1, Math.ceil(speed * duration / Math.max(0.035, MGL_RULES.radius * 0.65)));
  const step = duration / count;
  for (let i = 0; i < count; i++) {
    round.vy -= MGL_RULES.gravity * step;
    const dx = round.vx * step, dy = round.vy * step, dz = round.vz * step;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-7) continue;
    const hit = raycast(round.x, round.y, round.z, dx / length, dy / length, dz / length,
      length + MGL_RULES.radius);
    if (!hit) {
      round.x += dx; round.y += dy; round.z += dz;
      continue;
    }
    const t = Math.max(0, Math.min(length, (Number(hit.t) || 0) - MGL_RULES.radius));
    round.x += dx / length * t;
    round.y += dy / length * t;
    round.z += dz / length * t;
    const normalLength = Math.hypot(hit.nx || 0, hit.ny || 0, hit.nz || 0);
    const n = normalLength > 0
      ? { x: hit.nx / normalLength, y: hit.ny / normalLength, z: hit.nz / normalLength }
      : { x: 0, y: 1, z: 0 };
    const velocityDot = round.vx * n.x + round.vy * n.y + round.vz * n.z;
    round.hit = { x: hit.x, y: hit.y, z: hit.z, nx: n.x, ny: n.y, nz: n.z, t };
    if (round.bouncesLeft <= 0) {
      round.hitSolid = true;
      round.vx = round.vy = round.vz = 0;
      break;
    }
    round.bouncesLeft--;
    round.bounced = true;
    if (velocityDot < 0) {
      const impulse = (1 + MGL_RULES.bounce) * velocityDot;
      round.vx -= impulse * n.x;
      round.vy -= impulse * n.y;
      round.vz -= impulse * n.z;
    }
    if (n.y > 0.5) {
      round.vx *= MGL_RULES.floorFriction;
      round.vz *= MGL_RULES.floorFriction;
      if (round.vy < 0.65) round.vy = 0;
      if (Math.hypot(round.vx, round.vz) < 0.4) round.vx = round.vz = 0;
    } else {
      round.vx *= MGL_RULES.wallDamping;
      round.vz *= MGL_RULES.wallDamping;
    }
    // The remaining fraction of this tiny sweep is resolved next substep. This avoids
    // a second collision being silently skipped at sharp voxel corners.
    break;
  }
  return round;
}
