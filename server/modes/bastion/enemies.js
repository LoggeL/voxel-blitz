import { evShoot, evHit } from '../../protocol/events.js';
import { BASTION_ENEMIES, BASTION_PIERCING, BASTION_RULES as R } from '../../../shared/bastion.js';
import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { GROUND, BARRICADE, AIR } from '../../../shared/world/blocks.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { damageBlock } from '../../sim/combat.js';
import { PlayerEntity, aimAngles, wrapAngle, fwdFromYawPitch } from '../../sim/player.js';
import { observeBotTarget } from '../../bot-perception.js';
import { turn, flat, chargeReady, burstFire } from './ai-common.js';
import { BastionNavigation } from './navigation.js';
import { stepVehicle } from './vehicles.js';

const BREACH_REACH = 2.2, STRIKE_REACH = 2.5, STRIKE_MS = 1000;

/** An attacker behind the body (dot of facing and attacker direction below -0.5). */
export function rearHit(p, attacker) {
  const dx = attacker.x - p.x, dz = attacker.z - p.z, len = Math.hypot(dx, dz);
  if (!(len > 0.01)) return false;
  return (-Math.sin(p.yaw) * dx - Math.cos(p.yaw) * dz) / len < -0.5;
}

export class BastionEnemies {
  constructor(engine, policy, rng = Math.random) {
    this.engine = engine; this.policy = policy; this.rng = rng; this.serial = 0;
    this.nav = new BastionNavigation(engine.world, null, (x, y, z) => policy.structures.isBuiltCell(x, y, z));
  }
  spawn(role, stageIndex, index) {
    const profile = BASTION_ENEMIES[role], stage = this.policy.layout.stages[stageIndex];
    const base = profile.vehicle ? stage.vehicleRoute[0] : stage.spawns[index % stage.spawns.length];
    return this.spawnAt(role, stageIndex, profile.vehicle ? { ...base } : { ...base, ...this.jitterSpawn(base) });
  }
  /** Spawn at an explicit point (APC troop drop). */
  spawnAt(role, stageIndex, position) {
    const e = this.engine, policy = this.policy, profile = BASTION_ENEMIES[role], stage = policy.layout.stages[stageIndex];
    const at = { x: position.x, y: position.y ?? GROUND + 1.02, z: position.z };
    const p = new PlayerEntity(`npc-${policy.run}-${++this.serial}`, profile.name, at, true, e.world.dimensions);
    Object.assign(p, { npcRole: role, team: 'bravo', stage: stageIndex, hp: profile.hp, maxHp: profile.hp, armor: profile.armor,
      weapon: WEAPON_IDS.indexOf(profile.weapon), infiniteMagazines: true, grenades: p.grenades.map(() => 0),
      bodyScale: profile.scale ?? 1, npcSpeed: profile.vehicle ? 1 : profile.speed * (0.92 + this.rng() * 0.16),
      noPanic: !!profile.noPanic, npcRocketDamage: profile.rocket ? profile.damage : undefined,
      beforeDamage: (profile.rearMult || profile.smallArms) ? (dmg, attacker, weapon) => {
        let f = profile.vehicle && !BASTION_PIERCING.includes(weapon) ? profile.smallArms : 1;
        if (attacker && profile.rearMult && rearHit(p, attacker)) f *= profile.rearMult;
        return dmg * f;
      } : undefined,
      ai: { target: null, seenAt: 0, burstStart: 0, burstShots: 0, pauseUntil: 0, windup: 0, lastShot: 0,
        strikeAt: 0, breachAt: 0, slamAt: 0, breach: null, lastMoveAt: e.now, watchX: at.x, watchZ: at.z,
        bestDist: Infinity, stallSince: e.now, drift: profile.vehicle ? 0 : (this.rng() * 2 - 1) * 1.6 } });
    if (profile.vehicle) {
      Object.assign(p, { npcVehicle: true, combatBox: [...profile.combatBox],
        route: { index: 1, parked: false, stalledSince: 0, lastRam: 0, lastContact: new Map(), dropped: false, mortarAt: 0 } });
      Object.defineProperty(p, 'eyeY', { get: () => p.y + profile.combatBox[1] * 1.6, configurable: true });
      const next = stage.vehicleRoute[1] ?? stage.objective;
      p.yaw = aimAngles([p.x, 0, p.z], [next.x, 0, next.z]).yaw;
    } else p.yaw = 0;
    p.pitch = 0;
    e.npcs.set(p.id, p);
    if (['brute', 'juggernaut'].includes(role) && !policy.tierSeen.has(role)) { policy.tierSeen.add(role); policy.emit('bastion_tier', { role }); }
    if (profile.vehicle) policy.emit('bastion_vehicle', { id: p.id, kind: role, pos: [p.x, p.y, p.z], lane: stage.lane, phase: 'spawn' });
    return p;
  }
  /** APC troop drop: cap-gated spawns behind the hull, the rest to the queue front. Once per vehicle. */
  dropTroops(v) {
    const policy = this.policy, drop = BASTION_ENEMIES[v.npcRole]?.drop;
    if (!drop || !v.route || v.route.dropped) return;
    v.route.dropped = true;
    const cap = policy.plan?.cap ?? 6, n = Math.max(0, Math.min(drop.count, cap - policy.aliveEnemies().length));
    const fwd = fwdFromYawPitch(v.yaw, 0), base = { x: v.x - fwd.x * 3, y: GROUND + 1.02, z: v.z - fwd.z * 3 };
    for (let i = 0; i < n; i++) this.spawnAt(drop.role, v.stage, { ...base, ...this.jitterSpawn(base) });
    for (let i = n; i < drop.count; i++) policy.queue.unshift(drop.role);
    v.npcAttack = 'deploy'; v.ai.deployUntil = this.engine.now + 600;
    policy.emit('bastion_vehicle', { id: v.id, kind: v.npcRole, pos: [v.x, v.y, v.z], phase: 'deploy' });
  }
  walkable(x, z) {
    const w = this.engine.world;
    return !w.getBlock(x, GROUND + 1, z) && !w.getBlock(x, GROUND + 2, z) && !!w.getBlock(x, GROUND - 1, z)
      && !this.policy.structures.isBuiltCell(x, GROUND + 1, z);
  }
  jitterSpawn(base) {
    const bounds = this.policy.layout.bounds, margin = 1;
    // Spawn chambers may sit outside the play bounds; only clamp points that start inside them.
    const inside = base.x >= bounds.minX && base.x <= bounds.maxX && base.z >= bounds.minZ && base.z <= bounds.maxZ;
    const clamp = (v, min, max) => inside ? Math.min(max - margin, Math.max(min + margin, v)) : v;
    for (let i = 0; i < 8; i++) {
      const x = clamp(base.x + (this.rng() * 2 - 1) * 3, bounds.minX, bounds.maxX);
      const z = clamp(base.z + (this.rng() * 2 - 1) * 3, bounds.minZ, bounds.maxZ);
      if (this.walkable(Math.floor(x), Math.floor(z))) return { x, z };
    }
    return { x: base.x, z: base.z };
  }
  driftStep(p, next) {
    const drift = p.ai.drift || 0;
    if (!drift) return next;
    const dx = next.x - p.x, dz = next.z - p.z, len = Math.hypot(dx, dz) || 1;
    const cx = next.x + (-dz / len) * drift, cz = next.z + (dx / len) * drift;
    if (Math.floor(cx) === Math.floor(p.x) && Math.floor(cz) === Math.floor(p.z)) return next;
    if ((this.nav.dist?.[Math.floor(cz) * this.nav.sx + Math.floor(cx)] ?? -1) < 0) return next;
    return { x: cx, z: cz };
  }
  visible(p, point) {
    const origin = [p.x, p.eyeY, p.z], delta = point.map((n, i) => n - origin[i]);
    return !this.engine.projectiles.smoke.blocksSight(origin, point, this.engine.now)
      && !raycastVoxels(this.engine.solidAt, ...origin, ...delta, Math.hypot(...delta) - 0.1);
  }
  /** Line of sight to the centre of a (solid) built cell: the ray may end inside that very cell. */
  canSeeCell(p, point, cell) {
    const origin = [p.x, p.eyeY, p.z], delta = point.map((n, i) => n - origin[i]);
    if (this.engine.projectiles.smoke.blocksSight(origin, point, this.engine.now)) return false;
    const hit = raycastVoxels(this.engine.solidAt, ...origin, ...delta, Math.hypot(...delta));
    return !hit || (hit.x === cell.x && hit.z === cell.z && (hit.y === cell.y || hit.y === cell.y + 1));
  }
  /** Nearest visible active defender through the bot perception model. */
  scanDefenders(p, tracking = null) {
    const e = this.engine; let best = null;
    for (const defender of e.entities.values()) {
      if (!this.policy.active.has(defender.id) || defender.state !== 'alive') continue;
      const seen = observeBotTarget(p, defender, e.solidAt, e.projectiles.smoke, e.now, tracking === defender.id);
      if (seen && (!best || seen.distance < best.distance)) best = { point: seen.aimPoint, distance: seen.distance, id: defender.id, entity: defender };
    }
    return best;
  }
  nearestStructure(p, range, filter = null) {
    let best = null, bestDist = range;
    for (const s of this.policy.structures.items.values()) {
      if (s.state !== 'alive' || (filter && !filter(s))) continue;
      const d = flat(p, s);
      if (d >= bestDist || !this.visible(p, [s.x, s.eyeY, s.z])) continue;
      best = s; bestDist = d;
    }
    return best;
  }
  /** Melee/slam damage into a built cell: barricade voxels or the structure standing there. */
  hitBuilt(p, cell, dmg, weapon) {
    const e = this.engine, w = e.world;
    for (const y of [GROUND + 1, GROUND + 2]) {
      if (w.getBlock(cell.x, y, cell.z) !== BARRICADE) continue;
      damageBlock(cell.x, y, cell.z, BARRICADE, dmg, e.contexts.combat);
      if (w.getBlock(cell.x, y, cell.z) === AIR) this.policy.emitBreach(cell.x, y, cell.z, p.id);
    }
    const s = this.policy.structures.structureAt(cell.x, GROUND + 1, cell.z);
    if (s && s.state === 'alive') s.takeDamage(dmg, false, p, weapon);
  }
  swing(p, point) {
    const eye = [p.x, p.eyeY, p.z], delta = point.map((n, i) => n - eye[i]), len = Math.hypot(...delta) || 1;
    const dir = delta.map(n => n / len);
    this.engine.tickEvents.push(evShoot(p.id, eye, dir, 'knife', dir));
    p.firing = true;
  }
  tick(dt) {
    const e = this.engine, policy = this.policy;
    this.nav.rebuild(e.blockRevision);
    for (const p of e.npcs.values()) {
      if (p.state !== 'alive') { if (e.now >= p.respawnAt) e.npcs.delete(p.id); continue; }
      const ai = p.ai, profile = BASTION_ENEMIES[p.npcRole];
      p.input = { keys: {}, wantFire: false, reload: p.mag[p.weapon] === 0, yaw: p.yaw, pitch: p.pitch };
      if (p.noPanic) p.panic = 0;
      if (policy.phase !== 'live') continue;
      if (p.npcVehicle) { stepVehicle(e, policy, p, dt); continue; }
      const obj = policy.objective, objPoint = [obj.x, obj.eyeY, obj.z], distObj = flat(obj, p);
      // 1. Target scan: defenders, then structures, then the breach cell, then the objective.
      let target = null, targetId = null;
      const seen = this.scanDefenders(p, ai.target);
      const structure = this.nearestStructure(p, 20);
      const inBurst = !!ai.burstStart && profile.windupMs && !profile.rocket;
      if (structure && ['heavy', 'juggernaut'].includes(p.npcRole) && structure.structure === 'turret' && flat(p, structure) < 12) {
        target = { point: [structure.x, structure.eyeY, structure.z], distance: flat(p, structure) }; targetId = structure.id;
      } else if (seen) { target = { point: seen.point, distance: seen.distance, defender: seen.entity }; targetId = seen.id; }
      else if (structure) { target = { point: [structure.x, structure.eyeY, structure.z], distance: flat(p, structure) }; targetId = structure.id; }
      if (inBurst && ai.target && ai.target !== targetId && seen && seen.id === ai.target) {
        target = { point: seen.point, distance: seen.distance, defender: seen.entity }; targetId = seen.id;
      }
      if (ai.breach && !policy.structures.isBuiltCell(ai.breach.x, ai.breach.y, ai.breach.z)
          && !policy.structures.isBuiltCell(ai.breach.x, ai.breach.y + 1, ai.breach.z)) {
        policy.emitBreach(ai.breach.x, ai.breach.y, ai.breach.z, p.id); ai.breach = null;
      }
      let breaching = false, breachPoint = null;
      if (ai.breach) {
        breachPoint = [ai.breach.x + 0.5, GROUND + 1.5, ai.breach.z + 0.5];
        breaching = Math.hypot(p.x - breachPoint[0], p.z - breachPoint[2]) < BREACH_REACH && this.canSeeCell(p, breachPoint, ai.breach);
        if (!target && breaching) { target = { point: breachPoint, distance: 1 }; targetId = 'breach'; }
      }
      if (!target && !profile.rusher && distObj < 26 && obj.hp > 0 && this.visible(p, objPoint)) {
        target = { point: objPoint, distance: distObj }; targetId = obj.id;
      }
      if (ai.target !== targetId) { ai.target = targetId; ai.seenAt = e.now; ai.windup = 0; ai.burstStart = 0; }
      // 2. Steering: free-cell route first; breach route when sealed off or stalled without a target.
      let step = this.nav.next(p);
      if (!step || (!target && e.now - ai.stallSince > R.breachStallMs)) {
        const bs = this.nav.breachNext(p);
        if (bs) {
          step = bs;
          const cell = { x: Math.floor(bs.x), y: GROUND + 1, z: Math.floor(bs.z) };
          if (bs.built && Math.hypot(p.x - bs.x, p.z - bs.z) < BREACH_REACH
              && (policy.structures.isBuiltCell(cell.x, cell.y, cell.z) || policy.structures.isBuiltCell(cell.x, cell.y + 1, cell.z))) ai.breach = cell;
        }
      }
      step = step ? this.driftStep(p, step) : null;
      // Rushers fire on the move; brutes charge a close defender; everyone else duels from where they stand.
      const holdGround = target && targetId !== 'breach' && (!profile.rusher || targetId === obj.id || targetId === structure?.id);
      if (p.npcRole === 'brute' && target?.defender && target.distance <= 10 && target.distance > 2.2) {
        step = { x: target.defender.x, z: target.defender.z };
      }
      const move = !holdGround && !breaching && distObj > 2.3 && step;
      if (move) {
        if (distObj < ai.bestDist - 0.5) { ai.bestDist = distObj; ai.stallSince = e.now; }
        else if (ai.drift && e.now - ai.stallSince > 2500) ai.drift = 0;
      } else if (holdGround) ai.stallSince = e.now;
      const aimPoint = target?.point || (breaching ? breachPoint : step ? [step.x, p.eyeY, step.z] : objPoint);
      const angles = aimAngles([p.x, p.eyeY, p.z], aimPoint);
      p.yaw = turn(p.yaw, angles.yaw, dt * 3); p.pitch = turn(p.pitch, angles.pitch, dt * 3);
      p.input.yaw = p.yaw; p.input.pitch = p.pitch;
      if (move) { p.input.keys.f = true; p.input.viewYaw = aimAngles([p.x, 0, p.z], [step.x, 0, step.z]).yaw; }
      p.npcAttack = 'advance';
      // 3. Breach: melee the built cell (breachers fire their rocket at it instead).
      if (breaching && !profile.rocket) {
        p.npcAttack = 'breach';
        if (e.now >= ai.breachAt) { ai.breachAt = e.now + profile.breachMs; this.hitBuilt(p, ai.breach, profile.breachDamage, 'melee'); this.swing(p, breachPoint); }
      }
      // 4. Rushers: runner strikes, brute slams.
      if (p.npcRole === 'runner') {
        const near = this.nearestStructure(p, STRIKE_REACH);
        // Wide objectives are struck from their surface, not their centre.
        const objReach = STRIKE_REACH + Math.max(0, Math.max(obj.half[0], obj.half[2]) - 1);
        if (distObj <= objReach && obj.hp > 0 && this.visible(p, objPoint)) {
          p.npcAttack = 'strike';
          if (e.now >= ai.strikeAt) { obj.takeDamage(profile.objectiveHit, false, p); ai.strikeAt = e.now + STRIKE_MS; p.firing = true; }
        } else if (near) {
          p.npcAttack = 'strike';
          if (e.now >= ai.strikeAt) { near.takeDamage(profile.objectiveHit, false, p, 'melee'); ai.strikeAt = e.now + STRIKE_MS; this.swing(p, [near.x, near.eyeY, near.z]); }
        }
      }
      if (p.npcRole === 'brute') this.slam(p, profile, target, obj, distObj, breaching);
      // Rocket profiles keep the breach cell as a target so the rocket branch below fires at it.
      if (!target || (targetId === 'breach' && !profile.rocket) || Math.abs(wrapAngle(angles.yaw - p.yaw)) > 0.15 || e.now - ai.seenAt < 600) continue;
      if (p.npcRole === 'brute' && (!target.defender || target.distance < 4 || target.distance > 10)) continue;
      if (e.now < ai.pauseUntil) { p.npcAttack = 'cooldown'; continue; }
      if (profile.rocket) {
        if (!chargeReady(policy, p, profile, e.now)) continue;
        // Launch through the normal projectile simulation after the visible tell.
        const dir = fwdFromYawPitch(p.yaw, p.pitch);
        e.projectiles.launchRocket(p, e.contexts.projectiles, dir);
        e.tickEvents.push(evShoot(p.id, [p.x, p.eyeY, p.z], [dir.x, dir.y, dir.z], 'rocket', [dir.x, dir.y, dir.z]));
        ai.pauseUntil = e.now + profile.pauseMs; ai.windup = 0; p.npcAttack = 'firing';
        continue;
      }
      // Juggernaut spin-up (windupMs) is a visible tell before every burst.
      p.input.wantFire = burstFire(policy, p, profile, e.now);
    }
  }
  /** Brute slam: arc damage and knockback on defenders, flat hits on structures, the objective and barricades. */
  slam(p, profile, target, obj, distObj, breaching) {
    const e = this.engine, policy = this.policy, ai = p.ai, range = profile.slamRange;
    const defenders = [];
    for (const id of policy.active) {
      const d = e.entities.get(id);
      if (d?.state === 'alive' && flat(d, p) <= range && Math.abs(d.y - p.y) < 2.5) defenders.push(d);
    }
    const structures = [...policy.structures.items.values()].filter(s => s.state === 'alive' && flat(s, p) <= range + s.combatBox[0]);
    const objective = obj.hp > 0 && distObj <= range + obj.half[0];
    if (!defenders.length && !structures.length && !objective && !breaching) return;
    p.npcAttack = 'slam';
    if (e.now < ai.slamAt) return;
    ai.slamAt = e.now + profile.slamMs;
    const fwd = fwdFromYawPitch(p.yaw, 0);
    for (const d of defenders) {
      const dx = d.x - p.x, dz = d.z - p.z, len = Math.hypot(dx, dz) || 1;
      if (len > 2.2 || (dx * fwd.x + dz * fwd.z) / len < 0.2 || !policy.canDamage(p, d)) continue;
      const lethal = d.takeDamage(profile.slamDamage, false, p, 'slam');
      d.vx += fwd.x * profile.slamKnock; d.vz += fwd.z * profile.slamKnock; d.vy += 5;
      d.impulseSeq = (d.impulseSeq || 0) + 1; d.grounded = false; d.vault = null;
      e.tickEvents.push(evHit(p.id, d.id, profile.slamDamage, false, [d.x, d.y + 1, d.z], d.lastDamage));
      if (lethal) e.killPlayer(d, p, 'slam', false, null);
    }
    for (const s of structures) s.takeDamage(profile.objectiveHit, false, p, 'slam');
    if (objective) obj.takeDamage(profile.objectiveHit, false, p, 'slam');
    if (breaching) this.hitBuilt(p, ai.breach, profile.breachDamage, 'slam');
    this.swing(p, target?.point || [obj.x, obj.eyeY, obj.z]);
  }
}
