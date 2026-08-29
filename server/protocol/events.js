const D2 = 100, D3 = 1000;

function round(v, d) {
  return Number.isFinite(v) ? Math.round(v * d) / d : 0;
}

/**
 * Accepted gunshot. `o` is the muzzle origin, `d` is the pre-spread aim
 * direction, and `spread` is the sampled first-pellet direction. Clients drive
 * tracers, muzzle flash, shells, and sound from this event only.
 */
export function evShoot(id, o, d, w, spread) {
  return {
    t: 'ev', kind: 'shoot', id: String(id), w: String(w),
    o: [round(o[0], D2), round(o[1], D2), round(o[2], D2)],
    d: [round(d[0], D3), round(d[1], D3), round(d[2], D3)],
    spread: [round(spread[0], D3), round(spread[1], D3), round(spread[2], D3)],
  };
}

/** Damage feedback. v = impact point (or victim chest). */
export function evHit(attacker, victim, dmg, hs, v) {
  return {
    t: 'ev', kind: 'hit',
    attacker: String(attacker), victim: String(victim),
    dmg: round(dmg, 1), hs: !!hs,
    vx: round(v[0], D2), vy: round(v[1], D2), vz: round(v[2], D2),
  };
}

/** Killfeed row with authoritative shot traits. */
export function evKill(killer, victim, w, hs, markers = null) {
  return {
    t: 'ev',
    kind: 'kill',
    killer: String(killer),
    victim: String(victim),
    w: String(w),
    hs: !!hs,
    lr: !!markers?.longRange,
    ns: !!markers?.noScope,
  };
}

/** Block mutation; `from` is the pre-mutation block id. */
export function evBlock(x, y, z, v, from) {
  return {
    t: 'ev', kind: 'block',
    x: x | 0, y: y | 0, z: z | 0, v: v | 0, from: from | 0,
  };
}

/** State-transition events embedded in tick.events. */
export function evRespawn(id, x, y, z) {
  return {
    t: 'respawn', kind: 'respawn', id: String(id),
    x: round(x, D2), y: round(y, D2), z: round(z, D2),
  };
}

export function evDie(id) {
  return { t: 'die', kind: 'die', id: String(id) };
}

export function evGrenadeThrow(id, grenadeId, origin, velocity, fuseMs) {
  return {
    t: 'ev', kind: 'grenadeThrow', id: String(id), gid: String(grenadeId),
    o: origin.map((value) => round(value, D2)),
    v: velocity.map((value) => round(value, D2)),
    fuse: Math.max(0, Math.round(Number(fuseMs) || 0)),
  };
}

export function evGrenadeExplode(id, grenadeId, origin, radius) {
  return {
    t: 'ev', kind: 'grenadeExplode', id: String(id), gid: String(grenadeId),
    x: round(origin[0], D2), y: round(origin[1], D2), z: round(origin[2], D2),
    radius: round(radius, D2),
  };
}
