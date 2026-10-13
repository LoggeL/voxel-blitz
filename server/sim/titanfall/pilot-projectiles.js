/**
 * Pilot AT projectiles (docs/titanfall.md §6): archer, thunderbolt, magnetic
 * mgl. WP4 owns the bodies; WP0 froze the exports. combat.js routes
 * fireOneShot for these ids here first (titanfall only); `false` falls through
 * to the stock path.
 *
 * - AT-12 ARCHER: a locked launch (LOCK_RULES.archer, VehicleLocks) homes on the
 *   titan by proportional navigation; an unlocked one flies straight. 330 `at`
 *   to the struck titan (spec 400; lowered so a rear ×1.3 hit keeps the ≥ 20 s
 *   solo-doom rule), 150 to a pilot it hits directly.
 * - TB-4 THUNDERBOLT (`arcball`): a 30 m/s orb, no drop. Every 0.25 s of flight it
 *   zaps up to three enemies (titans and pilots) within 6 m in its line of sight,
 *   each at most once per interval (45 `at` per titan zap); it bursts on contact
 *   (4 m blast, 160 `at` hull splash). Spec 300/60, lowered so the rear ×1.3 zone
 *   keeps the ≥ 20 s solo-doom rule.
 * - GL-3 SKIPJACK in titanfall: the stock round with a 4 m magnet toward enemy
 *   titans and a 70 `at` direct hit on a titan (no hull splash).
 *
 * Pilot numbers are final (after combatDamage, ×0.8): the raw values below are
 * divided by COMBAT_DAMAGE_SCALE.
 */
import { COMBAT_DAMAGE_SCALE, combatDamage } from '../../../shared/combat-balance.js';
import { ROCKET_RULES, stepRocket } from '../../../shared/rocket-rules.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { nearestHullPoint, vehicleHullParts } from '../../../shared/vehicle-collision.js';
import { TITAN_TYPE_IDS, isTitanType } from '../../../shared/titan-contract.js';
import { evHit, evProjectileLaunch, evProjectileUpdate } from '../../protocol/events.js';
import { occupantBodyCenter, occupantDamageScale, occupantShielded } from '../vehicle-damage.js';

export const TF_PILOT_PROJECTILES = Object.freeze(['archer', 'thunderbolt', 'mgl']);

const raw = finalDamage => finalDamage / COMBAT_DAMAGE_SCALE;
const byTitanType = amount => Object.freeze(Object.fromEntries(TITAN_TYPE_IDS.map(type => [type, amount])));
const blast = rules => Object.freeze({ fuseMs: 0, damageFalloffExponent: 1.15, selfDamage: 0.5, knockback: 0, selfKnockback: 0,
  knockbackRadius: rules.damageRadius, knockbackFalloff: 0.8, terrainRadius: 0, terrainPower: 0, maxDestroyedBlocks: 0,
  concussMs: 0, concussPanic: 0, directDamage: 0, ...rules });

/** Tuning (docs/titanfall.md §6). Titan numbers are before armour (at = 1.0, zones apply). */
export const PILOT_AT_RULES = Object.freeze({
  archer: Object.freeze({
    speed: 90, gravity: 0, lifetimeMs: 3200, launchForward: 0.6, turnRate: 1.8, navConstant: 4, proximity: 1.2,
    titanDamage: 330, cls: 'at', syncMs: 100,
    blast: blast({ id: 'archer', name: 'AT-12 ARCHER', damage: raw(40), damageRadius: 3, directDamage: raw(150) - raw(40),
      knockback: 18, selfKnockback: 22, knockbackRadius: 3.2, terrainRadius: 1.6, terrainPower: 120, maxDestroyedBlocks: 24 }),
  }),
  thunderbolt: Object.freeze({
    speed: 30, lifetimeMs: 2500, radius: 0.35, launchForward: 0.5,
    contactTitan: 160, blastRadius: 4, cls: 'at',
    zapIntervalS: 0.25, zapRadius: 6, zapTargets: 3, zapTitan: 45, zapPilot: 15,
    blast: blast({ id: 'arcball', name: 'TB-4 THUNDERBOLT', damage: raw(40), damageRadius: 4, damageFalloffExponent: 0.8,
      knockback: 6, selfKnockback: 6, knockbackRadius: 4 }),
  }),
  mgl: Object.freeze({ titanDamage: 70, cls: 'at', magnetRadius: 4, magnetTurn: 12, magnetMinSpeed: 14, syncMs: 100 }),
});

const ARCHER_DAMAGE = byTitanType(PILOT_AT_RULES.archer.titanDamage);
const MGL_DAMAGE = byTitanType(PILOT_AT_RULES.mgl.titanDamage);
const round2 = n => Math.round(n * 100) / 100;
const unit = dir => {
  const d = Array.isArray(dir) ? dir : [dir?.x, dir?.y, dir?.z];
  if (!d.every(Number.isFinite)) return null;
  const length = Math.hypot(d[0], d[1], d[2]);
  return length > 1e-6 ? d.map(n => n / length) : null;
};
const eyeOf = p => [p.eyeX ?? p.x, p.eyeY ?? p.y + 1.6, p.eyeZ ?? p.z];
const voxelRay = ctx => (ox, oy, oz, dx, dy, dz, max) => raycastVoxels(
  ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== 0), ox, oy, oz, dx, dy, dz, max);
const engineOf = ctx => ctx?.vehicles?.engine ?? null;

/** Enemy, live, landed titans of `owner` (the hulls the magnet and the zaps see). */
function* enemyTitans(ctx, owner) {
  const vehicles = ctx.vehicles;
  if (!vehicles?.vehicles) return;
  const team = owner ? vehicles.teamOf(owner) : null;
  if (team == null) return;
  for (const v of vehicles.vehicles.values()) {
    if (!isTitanType(v.type) || !(v.hp > 0) || v.dropping || v.team === team) continue;
    yield v;
  }
}

/** Nearest point on a hull's boxes to `point`, and its distance. */
function nearestOnHull(v, point) {
  let best = null, distance = Infinity;
  for (const part of vehicleHullParts(v)) {
    const at = nearestHullPoint(part, point), d = Math.hypot(at[0] - point[0], at[1] - point[1], at[2] - point[2]);
    if (d < distance) { distance = d; best = at; }
  }
  return best ? { point: best, distance } : null;
}

function clearLine(ctx, from, to, margin = 0.25) {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], distance = Math.hypot(...d);
  if (distance <= margin) return true;
  return !raycastVoxels(ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== 0),
    from[0], from[1], from[2], d[0] / distance, d[1] / distance, d[2] / distance, distance - margin);
}

function pushUpdate(projectile, ctx, syncMs) {
  if (!(ctx.now >= (projectile.syncAt || 0))) return;
  projectile.syncAt = ctx.now + syncMs;
  ctx.pushEvent(evProjectileUpdate(projectile.id, [projectile.x, projectile.y, projectile.z],
    [projectile.vx, projectile.vy, projectile.vz], projectile.bouncesLeft));
}

/* ------------------------------------------------------------------ launch */

/** Fire one pilot AT round. Returns true when handled (a refused launch refunds the round). */
export function firePilotProjectile(p, def, dir, ctx) {
  const engine = engineOf(ctx), system = engine?.projectiles, pctx = engine?.contexts?.projectiles;
  if (!system || !pctx || !ctx.vehicles?.titans || !TF_PILOT_PROJECTILES.includes(def?.id)) return false;
  let launched = null;
  if (def.id === 'archer') {
    const targetId = ctx.vehicles.locks?.lockedTarget?.(p, 'archer') ?? null;
    launched = launchPilotProjectile(system, 'archer', { owner: p, dir, targetId }, pctx);
  } else if (def.id === 'thunderbolt') {
    launched = launchPilotProjectile(system, 'thunderbolt', { owner: p, dir }, pctx);
  } else {
    launched = launchPilotProjectile(system, 'mgl', { owner: p, dir }, pctx);
  }
  if (!launched) p.mag[p.weapon]++;
  return true;
}

/** Launch a pilot projectile of `kind` ({ owner, dir, targetId? }). Returns it, or null when refused. */
export function launchPilotProjectile(system, kind, opts, ctx) {
  const owner = opts?.owner, d = unit(opts?.dir);
  if (!system || !ctx || !owner || !d || typeof system._hasRoom !== 'function' || !system._hasRoom()) return null;
  if (kind === 'archer') return launchArcher(system, owner, d, opts.targetId ?? null, ctx);
  if (kind === 'thunderbolt') return launchArcball(system, owner, d, ctx);
  if (kind === 'mgl') return launchMagneticMgl(system, owner, d, ctx);
  return null;
}

function launchArcher(system, owner, d, targetId, ctx) {
  const rules = PILOT_AT_RULES.archer, eye = eyeOf(owner);
  const target = targetId ? ctx.vehicles?.vehicles?.get?.(targetId) : null;
  const guided = !!(target && target.hp > 0 && isTitanType(target.type));
  const origin = [eye[0] + d[0] * rules.launchForward, eye[1] - 0.12 + d[1] * rules.launchForward, eye[2] + d[2] * rules.launchForward];
  const id = `r${system._nextId++}`;
  const projectile = {
    id, type: 'rocket', tf: 'archer', eventType: 'archer', weaponKey: 'archer', vehicleId: owner.vehicleId ?? null,
    ownerId: String(owner.id), owner,
    x: origin[0], y: origin[1], z: origin[2],
    vx: d[0] * rules.speed, vy: d[1] * rules.speed, vz: d[2] * rules.speed, gravity: rules.gravity,
    launchedAt: ctx.now, explodeAt: ctx.now + rules.lifetimeMs,
    stuck: false, hit: null, directVictim: null, chaosLevel: 0, chaosHoming: false,
    blastRules: rules.blast, hullSplash: 0, hullCls: rules.cls, hullDamageByType: ARCHER_DAMAGE,
    raycast: voxelRay(ctx),
  };
  if (guided) projectile.guidance = { targetId: target.id, turnRate: rules.turnRate, navConstant: rules.navConstant, proximity: rules.proximity };
  system.active.set(id, projectile);
  ctx.pushEvent(Object.assign(evProjectileLaunch(owner.id, id, 'archer', origin,
    [projectile.vx, projectile.vy, projectile.vz], rules.lifetimeMs), { chaos: 0, g: 0, ...(guided ? { target: String(target.id) } : {}) }));
  return projectile;
}

function launchArcball(system, owner, d, ctx) {
  const rules = PILOT_AT_RULES.thunderbolt, eye = eyeOf(owner);
  let reach = rules.launchForward;
  // Never spawn the orb inside a wall the pilot hugs.
  const wall = raycastVoxels(ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z) !== 0), eye[0], eye[1], eye[2], d[0], d[1], d[2], reach + rules.radius);
  if (wall) reach = Math.max(0, wall.t - rules.radius);
  const origin = [eye[0] + d[0] * reach, eye[1] - 0.1 + d[1] * reach, eye[2] + d[2] * reach];
  const id = `r${system._nextId++}`;
  const projectile = {
    id, type: 'arcball', tf: 'thunderbolt', eventType: 'arcball', weaponKey: 'thunderbolt', vehicleId: owner.vehicleId ?? null,
    ownerId: String(owner.id), owner,
    x: origin[0], y: origin[1], z: origin[2],
    vx: d[0] * rules.speed, vy: d[1] * rules.speed, vz: d[2] * rules.speed, gravity: 0,
    launchedAt: ctx.now, explodeAt: ctx.now + rules.lifetimeMs,
    stuck: false, hit: null, directVictim: null, chaosLevel: 0, chaosHoming: false,
    blastRules: rules.blast, hullSplash: rules.contactTitan, hullCls: rules.cls, hullDirect: 0,
    zapT: 0, zaps: 0,
    raycast: voxelRay(ctx),
  };
  system.active.set(id, projectile);
  ctx.pushEvent(Object.assign(evProjectileLaunch(owner.id, id, 'arcball', origin,
    [projectile.vx, projectile.vy, projectile.vz], rules.lifetimeMs), { chaos: 0, g: 0 }));
  return projectile;
}

function launchMagneticMgl(system, owner, d, ctx) {
  const projectile = system.launchMgl?.(owner, ctx, { x: d[0], y: d[1], z: d[2] });
  if (!projectile) return null;
  const rules = PILOT_AT_RULES.mgl;
  // Titanfall SKIPJACK: the router flies it (magnet), the stock blast hits pilots and
  // a direct titan hit deals the AT number; no hull splash.
  Object.assign(projectile, { tf: 'mgl', weaponKey: 'mgl', hullDamageByType: MGL_DAMAGE, hullCls: rules.cls, hullSplash: 0,
    chaosLevel: 0, chaosHoming: false });
  return projectile;
}

/* ------------------------------------------------------------------ flight */

/** One tick of flight (live, in-world projectiles only: the router owns expiry). */
export function stepPilotProjectile(system, projectile, stepSeconds, substeps, ctx) {
  // A router without the stock ProjectileSystem flight helpers (the WP0 contract fake) only expires.
  if (typeof system?._flyRocket !== 'function') return undefined;
  if (projectile.tf === 'archer') return stepArcher(system, projectile, stepSeconds * substeps, ctx);
  if (projectile.tf === 'thunderbolt') return stepArcball(system, projectile, stepSeconds, substeps, ctx);
  if (projectile.tf === 'mgl') return stepMagneticMgl(system, projectile, stepSeconds, substeps, ctx);
  return undefined;
}

/** Guided target lost: phased, electric smoke, dead or a wreck. */
function guidanceLost(v, now) {
  return !v || !(v.hp > 0) || (v.tfMove?.phasedUntil ?? 0) > now || (v.tfAbility?.smokeUntil ?? 0) > now;
}

function stepArcher(system, projectile, seconds, ctx) {
  const g = projectile.guidance;
  if (g?.targetId && guidanceLost(ctx.vehicles?.vehicles?.get(g.targetId), ctx.now)) g.targetId = null;
  if (g?.targetId) system._guide(projectile, seconds, ctx);
  if (system._flyRocket(projectile, seconds, ctx)) return true;
  if (!system.active.has(projectile.id)) return true;
  if (projectile.guidance?.targetId && system._proximity(projectile, ctx)) return true;
  if (projectile.guidance?.targetId) pushUpdate(projectile, ctx, PILOT_AT_RULES.archer.syncMs);
  return false;
}

function stepArcball(system, projectile, stepSeconds, substeps, ctx) {
  const rules = PILOT_AT_RULES.thunderbolt;
  for (let i = 0; i < substeps; i++) {
    const prev = { x: projectile.x, y: projectile.y, z: projectile.z };
    stepRocket(projectile, stepSeconds, projectile.raycast);
    const delta = [projectile.x - prev.x, projectile.y - prev.y, projectile.z - prev.z];
    const distance = Math.hypot(...delta);
    const hull = distance > 0 ? ctx.vehicles?.rayHit?.([prev.x, prev.y, prev.z], delta.map(n => n / distance), distance + rules.radius,
      projectile.vehicleId) : null;
    const contact = system._sweepVictim(prev, projectile, rules.radius, ctx, projectile);
    const reach = point => Math.hypot(point[0] - prev.x, point[1] - prev.y, point[2] - prev.z);
    if (hull && (!contact || hull.distance <= reach([contact.x, contact.y, contact.z]))) {
      const t = Math.max(0, Math.min(distance, hull.distance - rules.radius * 0.5)) / (distance || 1);
      [projectile.x, projectile.y, projectile.z] = [prev.x, prev.y, prev.z].map((n, k) => n + delta[k] * t);
      return system.explode(projectile, ctx);
    }
    if (contact) {
      [projectile.x, projectile.y, projectile.z] = [contact.x, contact.y, contact.z];
      projectile.directVictim = contact.victim;
      return system.explode(projectile, ctx);
    }
    if (projectile.hit) return system.explode(projectile, ctx);
    projectile.zapT += stepSeconds;
    if (projectile.zapT >= rules.zapIntervalS) {
      projectile.zapT -= rules.zapIntervalS;
      zap(system, projectile, ctx);
    }
  }
  return false;
}

/**
 * One zap pulse: the nearest ≤ zapTargets enemies in line of sight within
 * zapRadius (titans by their nearest hull point, pilots by the body centre),
 * each struck once. Publishes `arcZap` { pid, o, to } for the client arcs.
 */
export function zap(system, projectile, ctx) {
  const rules = PILOT_AT_RULES.thunderbolt, origin = [projectile.x, projectile.y, projectile.z];
  const owner = projectile.owner || ctx.entities?.get?.(projectile.ownerId) || null;
  const candidates = [];
  for (const v of enemyTitans(ctx, owner)) {
    const near = nearestOnHull(v, origin);
    if (near && near.distance <= rules.zapRadius && clearLine(ctx, origin, near.point)) candidates.push({ titan: v, point: near.point, distance: near.distance });
  }
  for (const victim of (ctx.targets || ctx.entities)?.values?.() ?? []) {
    if (victim === owner || victim.state !== 'alive' || occupantShielded(victim)) continue;
    if (Number.isFinite(victim.spawnProtectedUntil) && victim.spawnProtectedUntil > ctx.now) continue;
    if (!ctx.canDamage?.(owner, victim)) continue;
    const center = occupantBodyCenter(victim);
    const distance = Math.hypot(center[0] - origin[0], center[1] - origin[1], center[2] - origin[2]);
    if (distance <= rules.zapRadius && clearLine(ctx, origin, center)) candidates.push({ victim, point: center, distance });
  }
  if (!candidates.length) return [];
  candidates.sort((a, b) => a.distance - b.distance);
  const struck = candidates.slice(0, rules.zapTargets);
  for (const target of struck) {
    if (target.titan) {
      ctx.vehicles.damage(target.titan.id, rules.zapTitan, owner, { cls: rules.cls, point: target.point });
      continue;
    }
    const victim = target.victim;
    const damage = combatDamage(raw(rules.zapPilot)) * occupantDamageScale(victim);
    const lethal = victim.takeDamage(damage, false, owner, 'thunderbolt');
    ctx.pushEvent(evHit(owner?.id ?? '', victim.id, damage, false, target.point, victim.lastDamage));
    if (lethal) ctx.killPlayer(victim, owner, 'thunderbolt', false, null);
  }
  projectile.zaps++;
  ctx.pushEvent({ t: 'ev', kind: 'arcZap', pid: String(projectile.id), id: String(projectile.ownerId),
    o: origin.map(round2), to: struck.map(target => target.point.map(round2)) });
  return struck;
}

function stepMagneticMgl(system, projectile, stepSeconds, substeps, ctx) {
  const rules = PILOT_AT_RULES.mgl, owner = projectile.owner || null;
  const at = [projectile.x, projectile.y, projectile.z];
  let best = null;
  for (const v of enemyTitans(ctx, owner)) {
    const near = nearestOnHull(v, at);
    if (near && near.distance <= rules.magnetRadius && (!best || near.distance < best.distance)) best = near;
  }
  const speed = Math.hypot(projectile.vx, projectile.vy, projectile.vz);
  if (best && best.distance > 0.05 && speed > 0.5) {
    // Turn the heading toward the nearest hull point at magnetTurn rad/s (a ~2.5 m
    // radius at launch speed); the round keeps at least magnetMinSpeed.
    const heading = [projectile.vx / speed, projectile.vy / speed, projectile.vz / speed];
    const want = best.point.map((n, i) => (n - at[i]) / best.distance);
    const cos = Math.max(-1, Math.min(1, heading[0] * want[0] + heading[1] * want[1] + heading[2] * want[2]));
    const angle = Math.acos(cos), limit = rules.magnetTurn * stepSeconds * substeps;
    const t = angle > limit && angle > 1e-6 ? limit / angle : 1;
    const mix = heading.map((n, i) => n * (1 - t) + want[i] * t), length = Math.hypot(...mix) || 1;
    const keep = Math.max(speed, rules.magnetMinSpeed) / length;
    [projectile.vx, projectile.vy, projectile.vz] = mix.map(n => n * keep);
    projectile.magnetized = true;
  }
  system._flyMgl(projectile, stepSeconds, substeps, ctx);
  if (projectile.magnetized && system.active.has(projectile.id)) pushUpdate(projectile, ctx, rules.syncMs);
  return false;
}

/** Router expiry hook (fuse or out of world): the blast; the router deletes afterwards. */
export function explodePilotProjectile(system, projectile, ctx) {
  if (system?.active?.has(projectile.id) && typeof system.explode === 'function') system.explode(projectile, ctx);
}
