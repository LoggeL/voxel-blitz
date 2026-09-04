/**
 * Shared client/server contract for the LN-03 LONGARC arc bolt: one launch formula and
 * one flight integrator so the local prediction, the remote presentation, and the
 * authoritative simulation all fly — and ricochet — the identical projectile.
 */
export const BOLT_RULES = Object.freeze({
  speed: 52,
  gravity: 3.0,
  radius: 0.1,
  /** Self-destruct after this long in flight (map edge or open sky). */
  lifetimeMs: 3000,
  /** Wall reflections: a tap bolt skips once, a full charge ricochets three times. */
  bouncesTap: 1,
  bouncesCharged: 3,
  /** Charge (0..1) that arms the heavy multi-bounce bolt. 1 = a full charge only. */
  chargedAt: 1,
  /** Block damage dealt to a destructible voxel at every wall contact. */
  blockDamage: 18,
  color: '#7dfcff',
});

/** Reflections a bolt carries when launched at `charge01` (0..1). */
export function boltBounces(charge01) {
  const charge = Math.max(0, Math.min(1, Number.isFinite(charge01) ? charge01 : 1));
  return charge >= BOLT_RULES.chargedAt ? BOLT_RULES.bouncesCharged : BOLT_RULES.bouncesTap;
}

/**
 * Launch state for a bolt leaving the coil: a muzzle point just ahead of the eye plus a
 * straight velocity along the (already spread-sampled) unit `dir`.
 */
export function boltLaunch({ x, y, z, dir, charge01 = 1 }) {
  const d = dir || { x: 0, y: 0, z: -1 };
  return {
    type: 'bolt',
    x: x + d.x * 0.45,
    y: y - 0.1 + d.y * 0.45,
    z: z + d.z * 0.45,
    vx: d.x * BOLT_RULES.speed,
    vy: d.y * BOLT_RULES.speed,
    vz: d.z * BOLT_RULES.speed,
    bouncesLeft: boltBounces(charge01),
  };
}

/**
 * Advance one bolt `{x,y,z,vx,vy,vz,bouncesLeft}` by `dt` seconds. The bolt reflects off
 * solid faces using the DDA's face normal and may clear several walls inside one step;
 * every reflection consumes one `bouncesLeft`. Once the budget is spent the next contact
 * is terminal: `hit` reports it and the caller fizzles the bolt. A contact that
 * reflected sets `bounced` for presentation. `raycast` is the shared DDA returning
 * `{x,y,z,nx,ny,nz,t}`. Optional observers see each traveled segment before
 * its wall contact. `onTravel(from, bolt)` may return true to stop at a body;
 * `onBounce(contact)` observes every reflection, including multiple per step.
 */
export function stepBolt(bolt, dt, raycast, { onTravel, onBounce } = {}) {
  const step = Math.max(0, Number(dt) || 0);
  bolt.hit = null;
  bolt.bounced = null;
  bolt.vy -= BOLT_RULES.gravity * step;
  const speed = Math.hypot(bolt.vx, bolt.vy, bolt.vz);
  let budget = speed * step;
  if (!(budget > 1e-6)) return bolt;
  let ux = bolt.vx / speed;
  let uy = bolt.vy / speed;
  let uz = bolt.vz / speed;
  let guard = 0;
  while (budget > 1e-6 && guard++ < 6) {
    const hit = raycast(bolt.x, bolt.y, bolt.z, ux, uy, uz, budget + BOLT_RULES.radius);
    const t = hit ? Math.min(budget, Math.max(0, hit.t - BOLT_RULES.radius * 0.5)) : budget;
    const from = { x: bolt.x, y: bolt.y, z: bolt.z };
    bolt.x += ux * t;
    bolt.y += uy * t;
    bolt.z += uz * t;
    budget -= t;
    if (onTravel?.(from, bolt)) return bolt;
    bolt.traveled = (bolt.traveled || 0) + t;
    if (!hit) return bolt;
    const contact = { x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz, t };
    const normalLength = Math.hypot(hit.nx, hit.ny, hit.nz);
    if ((bolt.bouncesLeft ?? 0) <= 0 || !Number.isFinite(normalLength) || normalLength < 0.5) {
      bolt.hit = contact;
      return bolt;
    }
    bolt.bouncesLeft -= 1;
    bolt.bounced = contact;
    onBounce?.(contact);
    // Mirror the velocity about the face normal, nudge off the surface so the next
    // segment cannot re-hit the entry voxel, and keep flying the leftover budget.
    const dot = bolt.vx * hit.nx + bolt.vy * hit.ny + bolt.vz * hit.nz;
    bolt.vx -= 2 * dot * hit.nx;
    bolt.vy -= 2 * dot * hit.ny;
    bolt.vz -= 2 * dot * hit.nz;
    const left = Math.hypot(bolt.vx, bolt.vy, bolt.vz);
    if (!(left > 1e-6)) {
      bolt.hit = contact;
      return bolt;
    }
    ux = bolt.vx / left;
    uy = bolt.vy / left;
    uz = bolt.vz / left;
    bolt.x += hit.nx * 0.002;
    bolt.y += hit.ny * 0.002;
    bolt.z += hit.nz * 0.002;
  }
  // Exhausting this frame's distance at a reflection is not a terminal hit.
  if (budget > 1e-6) {
    bolt.hit = { x: bolt.x, y: bolt.y, z: bolt.z, nx: 0, ny: 1, nz: 0, t: 0 };
  }
  return bolt;
}
