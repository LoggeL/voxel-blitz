/**
 * Titan weapon and ability projectiles (docs/titanfall.md §5.4, kinds 'titan:*', WP3).
 * The router (index.js) owns expiry for every `projectile.tf`: once `ctx.now >=
 * explodeAt` or the projectile is outside the world it calls
 * `explodeTitanProjectile` once and then deletes the projectile itself, so
 * `stepTitanProjectile` only sees live, in-world projectiles. An impact found
 * during `step` is the kind's to handle (explode, then `system.active.delete`).
 *
 *   titan:t203         T-203 thermite shell: 260 direct, 120 splash (4 m, not the
 *                      struck hull), pilots 90 direct / 60 splash, terrain, a
 *                      thermite fire patch (MolotovFireSystem.ignite override) and
 *                      incendiary traps in reach ignite
 *   titan:leadwall     one Leadwall pellet: 26 to a titan, 25 to a pilot, one voxel
 *                      ricochet (projectileUpdate), explode events with radius 0.15 on a
 *                      hit and 0 when it runs out of range in the air
 *   titan:cluster      Cluster Missile: on impact it sticks and bursts `bursts` times
 *                      over `seconds` (80 each, 4 m), scattered around the impact; a
 *                      vortex counts it at all its bursts (6 × 80); at the end of its
 *                      fuse in flight every burst goes off at once
 *   titan:flightRocket Flight Core rocket: 70 (2.5 m blast), pilots 50
 *
 * Every projectile flies like a rocket (gravity, then the move: the client's
 * ProjectileFX mirrors it with the launch event's `g`). Per segment: enemy
 * sphere guards (guardRay: a vortex catches it, a thermal or gun shield stops
 * it), hulls (VehicleSystem.rayHit), pilots (ProjectileSystem._sweepVictim),
 * voxels. Damage credits the launching titan's core meter (`titanId`).
 * Projectiles use `type: 'titan'` so no stock ProjectileSystem branch touches them.
 */
import { TITAN_ABILITIES } from '../../../shared/titan-contract.js';
import { TITAN_WEAPONS } from '../../../shared/vehicle-handling/titan-weapons.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { armorMultiplier } from '../../../shared/vehicle-armor.js';
import { evProjectileLaunch, evProjectileExplode, evProjectileUpdate } from '../../protocol/events.js';
import { ABILITY_TUNING, guardRay, catchGuard, hurtHull, hurtPilot, blastAt, creditCore, igniteTraps } from './titan-abilities.js';

const CLUSTER = TITAN_ABILITIES.titan_northstar.ordnance;
const FLIGHT = TITAN_ABILITIES.titan_northstar.core;
const VORTEX = TITAN_ABILITIES.titan_ion.defensive;

/** Per kind: client event type, flight numbers, contact radius, and what a vortex counts it as. */
export const TITAN_PROJECTILES = Object.freeze({
  'titan:t203': Object.freeze({ type: 't203', speed: TITAN_WEAPONS.t203.speed, gravity: TITAN_WEAPONS.t203.gravity,
    lifetimeMs: TITAN_WEAPONS.t203.lifetimeMs, radius: 0.35, weight: 1, titanSide: TITAN_WEAPONS.t203.damage }),
  'titan:leadwall': Object.freeze({ type: 'leadwall', speed: TITAN_WEAPONS.leadwall.speed, gravity: TITAN_WEAPONS.leadwall.gravity,
    lifetimeMs: TITAN_WEAPONS.leadwall.lifetimeMs, radius: 0.12, weight: 1, titanSide: TITAN_WEAPONS.leadwall.damage }),
  'titan:cluster': Object.freeze({ type: 'cluster', speed: ABILITY_TUNING.cluster.speed, gravity: ABILITY_TUNING.cluster.gravity,
    lifetimeMs: 6000, radius: 0.3, weight: VORTEX.rocketWeight, titanSide: CLUSTER.damage * CLUSTER.bursts }),
  'titan:flightRocket': Object.freeze({ type: 'flightRocket', speed: ABILITY_TUNING.flightCore.speed, gravity: 0,
    lifetimeMs: 5000, radius: 0.25, weight: VORTEX.rocketWeight, titanSide: FLIGHT.damage }),
});

const titansOf = ctx => ctx?.vehicles?.titans ?? null;
const unit = d => {
  if (!Array.isArray(d) || d.length !== 3 || !d.every(Number.isFinite)) return null;
  const l = Math.hypot(...d);
  return l > 1e-6 ? d.map(n => n / l) : null;
};
const voxelRay = ctx => (ox, oy, oz, dx, dy, dz, max) => raycastVoxels(
  ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== 0), ox, oy, oz, dx, dy, dz, max);

/**
 * Launch a titan projectile of `kind`: opts { owner, origin, dir, vehicleId (the
 * launching hull, never struck), titanId (core credit), damageMul? }. Returns it, or null.
 */
export function launchTitanProjectile(system, kind, opts, ctx) {
  const rules = TITAN_PROJECTILES[kind], owner = opts?.owner, d = unit(opts?.dir), o = opts?.origin;
  if (!rules || !system || !ctx || !owner || !d || !Array.isArray(o) || !o.every(Number.isFinite) || !system._hasRoom?.()) return null;
  const id = `r${system._nextId++}`, speed = Number.isFinite(opts.speed) ? opts.speed : rules.speed;
  const titans = titansOf(ctx);
  const projectile = {
    id, type: 'titan', tf: kind, eventType: rules.type, weaponKey: rules.type, vehicleId: opts.vehicleId ?? null,
    titanId: opts.titanId ?? opts.vehicleId ?? null, team: titans?.vehicles.vehicles.get(opts.titanId ?? opts.vehicleId)?.team ?? ctx.vehicles?.teamOf?.(owner) ?? null,
    ownerId: String(owner.id), owner, damageMul: Number.isFinite(opts.damageMul) ? opts.damageMul : 1,
    x: o[0], y: o[1], z: o[2], vx: d[0] * speed, vy: d[1] * speed, vz: d[2] * speed, gravity: rules.gravity,
    launchedAt: ctx.now, explodeAt: ctx.now + rules.lifetimeMs, stuck: false, hit: null, directVictim: null,
    chaosLevel: 0, chaosHoming: false, bouncesLeft: kind === 'titan:leadwall' ? TITAN_WEAPONS.leadwall.ricochets : 0,
    raycast: voxelRay(ctx),
  };
  system.active.set(id, projectile);
  ctx.pushEvent?.(Object.assign(evProjectileLaunch(owner.id, id, rules.type, o, [projectile.vx, projectile.vy, projectile.vz], rules.lifetimeMs),
    { chaos: 0, g: projectile.gravity, ...(projectile.vehicleId ? { vehicleId: String(projectile.vehicleId) } : {}) }));
  return projectile;
}

/** One tick of flight (live, in-world projectiles only). */
export function stepTitanProjectile(system, projectile, stepSeconds, substeps, ctx) {
  if (projectile.stuck) return stepCluster(system, projectile, ctx);
  for (let i = 0; i < substeps; i++) {
    if (!system.active.has(projectile.id) || projectile.stuck) return undefined;
    flySegment(system, projectile, stepSeconds, ctx);
  }
  return undefined;
}

function flySegment(system, p, dt, ctx) {
  const rules = TITAN_PROJECTILES[p.tf], titans = titansOf(ctx);
  p.vy -= p.gravity * dt;
  const from = [p.x, p.y, p.z], delta = [p.vx * dt, p.vy * dt, p.vz * dt], len = Math.hypot(...delta);
  if (!(len > 1e-6)) return;
  const dir = delta.map(n => n / len);
  const voxel = p.raycast(from[0], from[1], from[2], dir[0], dir[1], dir[2], len + rules.radius * 0.5);
  let reach = voxel ? Math.min(len, Math.max(0, voxel.t - rules.radius * 0.5)) : len;
  const guard = titans ? guardRay(titans, p.team, from, dir, reach, p.titanId) : null;
  if (guard) reach = guard.t;
  const hull = ctx.vehicles?.rayHit?.(from, dir, reach, p.vehicleId) ?? null;
  const target = [from[0] + dir[0] * reach, from[1] + dir[1] * reach, from[2] + dir[2] * reach];
  // sweepPlayers reads from.x/.y/.z: both ends go in as points, not arrays.
  const contact = system._sweepVictim({ x: from[0], y: from[1], z: from[2] }, { x: target[0], y: target[1], z: target[2] }, rules.radius, ctx, p);
  const contactT = contact ? Math.hypot(contact.x - from[0], contact.y - from[1], contact.z - from[2]) : Infinity;
  const at = t => [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t];
  if (hull && !hull.wreck && hull.distance <= contactT) {
    const point = at(hull.distance);
    [p.x, p.y, p.z] = point;
    return impact(system, p, ctx, { point, hull: hull.vehicle, from, dir });
  }
  if (hull && hull.wreck && hull.distance <= contactT) {
    const point = at(hull.distance);
    [p.x, p.y, p.z] = point;
    return impact(system, p, ctx, { point, from, dir });
  }
  if (contact) {
    [p.x, p.y, p.z] = [contact.x, contact.y, contact.z];
    return impact(system, p, ctx, { point: [contact.x, contact.y, contact.z], victim: contact.victim, from, dir });
  }
  if (guard) {
    const point = at(guard.t);
    [p.x, p.y, p.z] = point;
    catchGuard(titans, guard.v, guard.guard, rules.titanSide * p.damageMul * armorMultiplier('titan', 'titan', 'front'), rules.weight);
    return remove(system, p, ctx, point, 0.15);
  }
  [p.x, p.y, p.z] = target;
  if (!voxel || voxel.t - rules.radius * 0.5 > len) return;
  if (p.tf === 'titan:leadwall' && p.bouncesLeft > 0) return ricochet(p, voxel, ctx);
  return impact(system, p, ctx, { point: target, voxel, from, dir });
}

/** Leadwall pellet off a voxel face: mirror the velocity, lose a bounce, resync the client. */
function ricochet(p, voxel, ctx) {
  const n = [voxel.nx, voxel.ny, voxel.nz];
  const dot = p.vx * n[0] + p.vy * n[1] + p.vz * n[2];
  p.vx -= 2 * dot * n[0]; p.vy -= 2 * dot * n[1]; p.vz -= 2 * dot * n[2];
  p.x += n[0] * 0.05; p.y += n[1] * 0.05; p.z += n[2] * 0.05;
  p.bouncesLeft--;
  ctx.pushEvent?.(evProjectileUpdate(p.id, [p.x, p.y, p.z], [p.vx, p.vy, p.vz], p.bouncesLeft));
}

function remove(system, p, ctx, point, radius) {
  ctx.pushEvent?.(evProjectileExplode(p.ownerId, p.id, TITAN_PROJECTILES[p.tf].type, point, radius));
  system.active.delete(p.id);
}

/** Contact: { point, hull? (a live titan or other hull), victim? (a pilot), voxel? }. */
function impact(system, p, ctx, { point, hull = null, victim = null }) {
  const titans = titansOf(ctx), owner = p.owner, source = titans?.vehicles.vehicles.get(p.titanId) ?? null, mul = p.damageMul;
  if (!Array.isArray(point) || !point.every(Number.isFinite)) {
    // Never deal damage, burn or burst at a non-finite point: the projectile just goes.
    ctx.pushEvent?.(evProjectileExplode(p.ownerId, p.id, TITAN_PROJECTILES[p.tf]?.type ?? 't203', [p.x, p.y, p.z].map(n => Number.isFinite(n) ? n : 0), 0.15));
    system.active.delete(p.id);
    return undefined;
  }
  if (!titans || !owner) return remove(system, p, ctx, point, 0.15);
  if (p.tf === 'titan:leadwall') {
    const W = TITAN_WEAPONS.leadwall;
    let dealt = 0;
    if (hull) dealt += hurtHull(titans, owner, hull, W.damage * mul, W.cls, { point });
    else if (victim) dealt += hurtPilot(titans, owner, victim, W.infantryDamage * mul, W.key, point);
    creditCore(titans, source, dealt);
    return remove(system, p, ctx, point, 0.15);
  }
  if (p.tf === 'titan:t203') {
    const W = TITAN_WEAPONS.t203;
    let dealt = 0;
    if (hull) dealt += hurtHull(titans, owner, hull, W.damage * mul, W.cls, { point });
    else if (victim) dealt += hurtPilot(titans, owner, victim, W.infantryDamage * mul, W.key, point);
    creditCore(titans, source, dealt);
    blastAt(titans, source, owner, point, { radius: W.splashRadius, hull: W.splash * mul, infantry: W.infantrySplash * mul,
      key: W.key, cls: W.splashCls, ignoreId: hull?.id ?? null, ignoreBody: victim });
    if (W.terrainRadius > 0) system._destroyTerrain?.(point, W, ctx, owner.id ?? null);
    const patch = [point[0], point[1] + 0.2, point[2]];
    system.fire?.ignite?.({ id: p.id, x: patch[0], y: patch[1], z: patch[2], ownerId: p.ownerId, owner, chaosLevel: 0 }, ctx,
      { ...W.firePatch, key: 'thermite', onHullDamage: fireCredit(titans, p.titanId) });
    igniteTraps(titans, point, W.firePatch.radius);
    return remove(system, p, ctx, point, W.splashRadius);
  }
  if (p.tf === 'titan:flightRocket') {
    const T = ABILITY_TUNING.flightCore;
    blastAt(titans, source, owner, point, { radius: T.splash, hull: FLIGHT.damage * mul, infantry: T.infantryDamage * mul, key: FLIGHT.key, cls: FLIGHT.cls });
    return remove(system, p, ctx, point, T.splash);
  }
  // Cluster: announce the impact (the client draws the bursts), then stay as a stuck emitter.
  ctx.pushEvent?.(evProjectileExplode(p.ownerId, p.id, 'cluster', point, ABILITY_TUNING.cluster.radius));
  p.stuck = true;
  p.vx = p.vy = p.vz = 0;
  p.burstsLeft = CLUSTER.bursts;
  p.burstAt = ctx.now;
  p.burstSeed = hashId(p.id);
  p.explodeAt = ctx.now + CLUSTER.seconds * 1000 + 100;
  return stepCluster(system, p, ctx);
}

/** A fire field's hull damage charges the core of the titan that lit it (looked up when it burns). */
export const fireCredit = (titans, titanId) => (hull, dealt) => creditCore(titans, titans.vehicles.vehicles.get(titanId) ?? null, dealt);

const hashId = text => { let h = 2166136261; for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h || 1; };
function stepCluster(system, p, ctx) {
  const titans = titansOf(ctx), T = ABILITY_TUNING.cluster;
  if (!titans) return undefined;
  const source = titans.vehicles.vehicles.get(p.titanId) ?? null;
  while (p.burstsLeft > 0 && p.burstAt <= ctx.now) {
    p.burstsLeft--;
    p.burstAt += CLUSTER.seconds / CLUSTER.bursts * 1000;
    p.burstSeed = (Math.imul(p.burstSeed, 1664525) + 1013904223) >>> 0;
    const a = (p.burstSeed >>> 8) / 16777216 * Math.PI * 2;
    p.burstSeed = (Math.imul(p.burstSeed, 1664525) + 1013904223) >>> 0;
    const r = (p.burstSeed >>> 8) / 16777216 * T.scatter;
    blastAt(titans, source, p.owner, [p.x + Math.cos(a) * r, p.y + 0.4, p.z + Math.sin(a) * r], { radius: T.radius, hull: CLUSTER.damage * p.damageMul,
      infantry: T.infantryDamage * p.damageMul, infantryRadius: T.infantryRadius, key: CLUSTER.key, cls: CLUSTER.cls });
  }
  if (p.burstsLeft <= 0) system.active.delete(p.id);
  return undefined;
}

/** Router expiry hook (fuse or out of world): effects only; the router deletes afterwards. */
export function explodeTitanProjectile(system, projectile, ctx) {
  if (projectile.stuck) { stepCluster(system, projectile, ctx); return; }
  const point = [projectile.x, projectile.y, projectile.z];
  if (projectile.tf === 'titan:leadwall') {
    // Radius 0: the pellet ran out of range in the air (the client draws and plays no hit for it).
    ctx.pushEvent?.(evProjectileExplode(projectile.ownerId, projectile.id, 'leadwall', point, 0));
    return;
  }
  // A shell or rocket at the end of its fuse goes off where it is. The router deletes the
  // projectile after this call, so a cluster lets every burst go at once.
  if (point.every(Number.isFinite) && projectile.y >= -2) {
    impact(system, projectile, ctx, { point });
    if (projectile.tf === 'titan:cluster' && projectile.burstsLeft > 0) { projectile.burstAt = -Infinity; stepCluster(system, projectile, ctx); }
  }
  else ctx.pushEvent?.(evProjectileExplode(projectile.ownerId, projectile.id, TITAN_PROJECTILES[projectile.tf]?.type ?? 't203', point.map(n => Number.isFinite(n) ? n : 0), 0.15));
}
