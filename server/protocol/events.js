import { ANNOUNCER_CUES } from '../../shared/announcer.js';

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

/**
 * A flying round (`def.ballistic`) has settled. `paths` is its resolved arc as
 * straight segments (cut at every contact and every eighth of a second), with
 * the hitscan segment shape (`hit`, `action`); `hitVictims` lists the bodies it
 * struck. Clients take continuation streaks, wall feedback and flybys from it.
 */
export function evBullet(id, w, path, hitVictims = []) {
  const event = { t: 'ev', kind: 'bullet', id: String(id), w: String(w), paths: [path] };
  if (hitVictims.length) event.hitVictims = hitVictims.map(String);
  return event;
}

function damageMetadata(damage) {
  if (!damage || !Number.isFinite(damage.healthDamage) || !Number.isFinite(damage.overkill)) return {};
  return { healthDamage: round(Math.max(0, damage.healthDamage), D2),
    overkill: damage.lethal ? round(Math.max(0, damage.overkill), D2) : 0,
    lethal: !!damage.lethal };
}

/** Damage feedback. v = impact point; damage describes the accepted post-armor hit. */
export function evHit(attacker, victim, dmg, hs, v, damage = null) {
  return {
    t: 'ev', kind: 'hit',
    attacker: String(attacker), victim: String(victim),
    dmg: round(dmg, 1), hs: !!hs,
    vx: round(v[0], D2), vy: round(v[1], D2), vz: round(v[2], D2),
    ...damageMetadata(damage),
  };
}

/** Killfeed row with authoritative shot traits; `dist` is the lethal shot length (ray kills only). */
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
    ...(Object.hasOwn(ANNOUNCER_CUES, markers?.announcer) ? { announcer: markers.announcer } : {}),
    ...(Number.isFinite(markers?.dist) ? { dist: round(markers.dist, 10) } : {}),
    ...damageMetadata(markers?.damage),
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

export function evDie(id, damage = null) {
  return { t: 'die', kind: 'die', id: String(id), ...damageMetadata(damage) };
}

/**
 * A grenade leaves the hand, a rocket leaves the tube, a bolt leaves the coil or a
 * RIPTIDE disc or MGL round leaves its launcher. `type` is a throwable or weapon
 * projectile id. Ricochet projectiles carry `bn`, their bounces remaining at launch.
 */
export function evProjectileLaunch(id, projectileId, type, origin, velocity, fuseMs, bounces) {
  const event = {
    t: 'ev', kind: 'projectileLaunch', id: String(id), pid: String(projectileId),
    type: String(type),
    o: origin.map((value) => round(value, D2)),
    v: velocity.map((value) => round(value, D2)),
    fuse: Math.max(0, Math.round(Number(fuseMs) || 0)),
  };
  if (['bolt', 'glaive', 'mgl'].includes(String(type)) && Number.isFinite(bounces)) {
    event.bn = Math.max(0, Math.trunc(bounces));
  }
  return event;
}

/** A Chaos 2 SUDSBLASTER bubble clung to terrain: frozen there with a fresh fuse. */
export function evProjectileStick(id, projectileId, origin, fuseMs, normal = null) {
  const event = {
    t: 'ev', kind: 'projectileStick', id: String(id), pid: String(projectileId),
    x: round(origin[0], D2), y: round(origin[1], D2), z: round(origin[2], D2),
    fuse: Math.max(0, Math.round(Number(fuseMs) || 0)),
  };
  // Optional mount face normal (Clingfilm bubbles flatten against it).
  if (Array.isArray(normal) && normal.length === 3 && normal.every(Number.isFinite)) {
    event.n = [round(normal[0], D2), round(normal[1], D2), round(normal[2], D2)];
  }
  return event;
}

export function evProjectileExplode(id, projectileId, type, origin, radius) {
  return {
    t: 'ev', kind: 'projectileExplode', id: String(id), pid: String(projectileId),
    type: String(type),
    x: round(origin[0], D2), y: round(origin[1], D2), z: round(origin[2], D2),
    radius: round(radius, D2),
  };
}

/** Match launch precision; full simulation precision stays on the server. */
export function evProjectileUpdate(projectileId, origin, velocity, bounces) {
  const event = {
    t: 'ev', kind: 'projectileUpdate', pid: String(projectileId),
    o: origin.map(value => round(value, D2)),
    v: velocity.map(value => round(value, D2)),
  };
  if (Number.isFinite(bounces)) event.bn = Math.max(0, Math.trunc(bounces));
  return event;
}

/**
 * A RIPTIDE owner's disc stock outside hand and air: `fab` lists the milliseconds
 * until each queued fabrication completes, `pickups` the owner-only embedded discs
 * (`pid` is the disc that embedded, `regen` the milliseconds until it fabricates
 * instead). `restored` ('pickup'|'fab') marks the change that returned a disc.
 */
export function evGlaiveStock(id, fab, pickups, restored = null) {
  const event = {
    t: 'ev', kind: 'glaiveStock', id: String(id),
    fab: fab.map((ms) => Math.max(0, Math.round(Number(ms) || 0))),
    pickups: pickups.map((pickup) => ({
      pid: String(pickup.id),
      x: round(pickup.x, D2), y: round(pickup.y, D2), z: round(pickup.z, D2),
      regen: Math.max(0, Math.round(Number(pickup.regen) || 0)),
    })),
  };
  if (restored) event.restored = String(restored);
  return event;
}

/**
 * Mounted shot: the ordinary shoot event plus the firing hull, mount id and
 * vehicle weapon key. `w` is the weapon's presentation family. Hitscan mounts
 * set `tracer` on every third round and publish one compact path for impact FX.
 */
export function evVehicleShoot(id, origin, dir, presentation, { vehicleId, mount, vehicleWeapon, tracer = false, side = null, end = null, hit = null } = {}) {
  const event = Object.assign(evShoot(id, origin, dir, presentation, dir), {
    vehicleId: String(vehicleId), mount: String(mount), vehicleWeapon: String(vehicleWeapon), tracer: !!tracer,
  });
  if (side != null) event.side = side ? 1 : 0;
  if (Array.isArray(end) && end.length === 3) {
    const segment = { o: event.o, end: end.map(value => round(value, D2)) };
    if (hit) segment.hit = { x: hit.x | 0, y: hit.y | 0, z: hit.z | 0, nx: hit.nx | 0, ny: hit.ny | 0, nz: hit.nz | 0 };
    event.paths = [[segment]];
  }
  return event;
}

/** Hull damage feedback, merged per attacker, hull and window (contract `vehicle_hit`). */
export function evVehicleHit(vehicleId, attacker, dmg, zone, cls, eff, pos) {
  return {
    t: 'ev', kind: 'vehicle_hit', vehicleId: String(vehicleId), attacker: attacker == null ? null : String(attacker),
    dmg: round(dmg, 1), zone: String(zone), cls: String(cls), eff: eff ? 1 : 0,
    pos: [round(pos?.[0], D2), round(pos?.[1], D2), round(pos?.[2], D2)],
  };
}

export function evVehicleDisabled(vehicleId, attacker) {
  return { t: 'ev', kind: 'vehicle_disabled', vehicleId: String(vehicleId), attacker: attacker == null ? null : String(attacker) };
}

export function evVehicleRepaired(vehicleId, by, hp) {
  return { t: 'ev', kind: 'vehicle_repaired', vehicleId: String(vehicleId), by: by == null ? null : String(by), hp: round(hp, 1) };
}

/** `kind` is taken by the event kind, so the countermeasure type travels as `cm` (flares|smoke). */
export function evCountermeasure(vehicleId, kind) {
  return { t: 'ev', kind: 'countermeasure', vehicleId: String(vehicleId), cm: String(kind) };
}

/**
 * Structural integrity events (docs/structural-physics.md). Blocks travel as
 * `o` (integer origin, the cells' minimum corner) plus `b`, a flat list of
 * [dx, dy, dz, type] per block relative to `o`; `n` counts every block even
 * when `b` was capped. `at` is the server clock (ms) of the tick.
 */
export function evCreak(id, at, fallMs, origin, cells, count) {
  return { t: 'ev', kind: 'creak', id: String(id), at: round(at, 1), fall: Math.max(0, Math.round(fallMs)),
    n: count | 0, o: origin.map(v => v | 0), b: cells };
}

/**
 * A cluster lost its support and falls as one rigid chunk (closed-form motion,
 * see shared/structure.js). Kill credit stays on the server: the event names
 * nobody, so it cannot reveal who brought a structure down (TTT).
 */
export function evCollapse(id, doomId, at, origin, cells, count, pivot, velocity, spin, gravity, landMs) {
  return {
    t: 'ev', kind: 'collapse', id: String(id), k: String(doomId), at: round(at, 1),
    n: count | 0, o: origin.map(v => v | 0), b: cells,
    p: pivot.map(v => round(v, D2)), v: velocity.map(v => round(v, D3)), w: spin.map(v => round(v, D3)),
    g: round(gravity, D2), land: Math.max(0, Math.round(landMs)),
  };
}

/** A falling chunk hit the ground: impact point, blocks, rubble blocks left (they arrive as block deltas), speed. */
export function evCollapseLand(id, at, point, count, rubble, speed) {
  return { t: 'ev', kind: 'collapseLand', id: String(id), at: round(at, 1),
    x: round(point[0], D2), y: round(point[1], D2), z: round(point[2], D2),
    n: count | 0, r: rubble | 0, speed: round(speed, D2) };
}

/** Blocks removed without falling (over the chunk caps, or nowhere to fall): burst them in place. */
export function evCrumble(id, at, origin, cells, count) {
  return { t: 'ev', kind: 'crumble', id: String(id), at: round(at, 1), n: count | 0, o: origin.map(v => v | 0), b: cells };
}
