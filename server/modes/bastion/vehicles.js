import { evShoot, evHit } from '../../protocol/events.js';
import { BASTION_ENEMIES } from '../../../shared/bastion.js';
import { BEDROCK, METAL, BARRICADE, AIR, GROUND, isSolidBlock } from '../../../shared/world/blocks.js';
import { damageBlock } from '../../sim/combat.js';
import { aimAngles, wrapAngle, fwdFromYawPitch } from '../../sim/player.js';
import { turn, flat, chargeReady, burstFire } from './ai-common.js';

const RAM_MS = 250, HARD_STALL_MS = 3000, OBJECTIVE_RAM_MS = 1000, CONTACT_MS = 700, SEEN_MS = 4000, ROCKET_SPREAD = 0.05;

/**
 * Probe the hull footprint at a candidate position. Cells whose centre lies
 * within half+0.3 decide hard/ram/advance; `wide` adds every solid cell the
 * hull edge still touches so a ram clears the whole line it drives through.
 */
function sweep(engine, policy, p, profile, nx, nz) {
  const [hx, , hz] = profile.combatBox, w = engine.world, ys = [GROUND + 1, GROUND + 2];
  if (p.npcRole === 'walker') ys.push(GROUND + 3);
  const hard = [], ram = [], wide = [], structures = [];
  for (let cx = Math.floor(nx - hx - 0.8); cx <= Math.floor(nx + hx + 0.8); cx++) {
    const dx = Math.abs(cx + 0.5 - nx);
    if (dx > hx + 0.8) continue;
    for (let cz = Math.floor(nz - hz - 0.8); cz <= Math.floor(nz + hz + 0.8); cz++) {
      const dz = Math.abs(cz + 0.5 - nz);
      if (dz > hz + 0.8) continue;
      const core = dx <= hx + 0.3 && dz <= hz + 0.3;
      for (const y of ys) {
        const type = w.getBlock(cx, y, cz);
        if (type === BEDROCK || type === METAL) { if (core) hard.push({ x: cx, y, z: cz, type }); }
        else if (isSolidBlock(type)) { if (core) ram.push({ x: cx, y, z: cz, type }); else wide.push({ x: cx, y, z: cz, type }); }
        const s = policy.structures.structureAt(cx, y, cz);
        if (s && s.state === 'alive') (core ? structures : wide).push(core ? s : { structure: s });
      }
    }
  }
  return { nx, nz, hard, ram, wide, structures };
}

function scanTarget(engine, policy, p, ai, obj) {
  const seen = policy.ai.scanDefenders(p);
  if (seen) { ai.seenAt = engine.now; ai.lastSeen = [...seen.point]; return { ...seen, kind: 'defender' }; }
  const s = policy.ai.nearestStructure(p, 20);
  if (s) return { point: [s.x, s.eyeY, s.z], distance: flat(p, s), id: s.id, kind: 'structure' };
  const objPoint = [obj.x, obj.eyeY, obj.z], d = flat(p, obj);
  if (obj.hp > 0 && (p.route.parked || d <= 26) && policy.ai.visible(p, objPoint)) return { point: objPoint, distance: d, id: obj.id, kind: 'objective' };
  return null;
}

export function stepVehicle(engine, policy, p, dt) {
  const profile = BASTION_ENEMIES[p.npcRole], ai = p.ai, route = p.route, now = engine.now;
  const stage = policy.layout.stages[p.stage], path = stage.vehicleRoute, obj = policy.objective;
  p.y = GROUND + 1.02;
  p.npcAttack = now < (ai.deployUntil || 0) ? 'deploy' : 'advance';
  // 1. Waypoint / parking.
  if (!route.parked && (route.index >= path.length || flat(obj, p) <= profile.standoff)) route.parked = true;
  const fwd = fwdFromYawPitch(p.yaw, 0);
  let moved = false;
  if (!route.parked) {
    // 2. Steering toward the waypoint; sharp turns slow the hull.
    const target = path[route.index];
    const desiredYaw = aimAngles([p.x, 0, p.z], [target.x, 0, target.z]).yaw;
    p.yaw = turn(p.yaw, desiredYaw, profile.turnRate * dt);
    const speed = profile.speed * (Math.abs(wrapAngle(desiredYaw - p.yaw)) > 0.6 ? 0.35 : 1);
    // 3. Sweep the footprint ahead; ram destructibles, slip around hard walls.
    const probe = yaw => { const f = fwdFromYawPitch(yaw, 0); return sweep(engine, policy, p, profile, p.x + f.x * speed * dt, p.z + f.z * speed * dt); };
    let s = probe(p.yaw);
    if (s.ram.length || s.structures.length) {
      p.npcAttack = 'ram';
      if (now - route.lastRam >= RAM_MS) {
        route.lastRam = now;
        const targets = new Set(s.structures);
        for (const c of [...s.ram, ...s.wide]) {
          if (c.structure) { targets.add(c.structure); continue; }
          damageBlock(c.x, c.y, c.z, c.type, profile.ramDamage / 4, engine.contexts.combat);
          if (c.type === BARRICADE && engine.world.getBlock(c.x, c.y, c.z) === AIR) policy.emitBreach(c.x, c.y, c.z, p.id);
        }
        for (const t of targets) t.takeDamage(profile.ramDamage / 4, false, p, 'ram');
      }
    } else {
      if (s.hard.length) {
        const left = probe(p.yaw + 0.6), right = probe(p.yaw - 0.6);
        const side = left.hard.length <= right.hard.length ? left : right;
        s = !side.hard.length && !side.ram.length && !side.structures.length ? side : null;
      }
      if (s) {
        p.x = s.nx; p.z = s.nz; moved = true; route.stalledSince = 0;
        if (flat(target, p) < 1.5) route.index++;
      } else if (!route.stalledSince) route.stalledSince = now;
      else if (now - route.stalledSince > HARD_STALL_MS) route.parked = true;
    }
  }
  // 4. Contact damage to defenders standing inside the hull footprint (spawn protection holds).
  const [hx, , hz] = profile.combatBox;
  for (const id of policy.active) {
    const d = engine.entities.get(id);
    if (!d || d.state !== 'alive' || now - (route.lastContact.get(id) || -Infinity) < CONTACT_MS) continue;
    if (Math.abs(d.x - p.x) > hx + 0.4 || Math.abs(d.z - p.z) > hz + 0.4 || Math.abs(d.y - p.y) > 2.5) continue;
    if (!policy.canDamage(p, d)) continue;
    route.lastContact.set(id, now);
    const lethal = d.takeDamage(profile.ramPlayerDamage, false, p, 'ram');
    d.vx += fwd.x * profile.ramKnock; d.vz += fwd.z * profile.ramKnock; d.vy += 5;
    d.impulseSeq = (d.impulseSeq || 0) + 1; d.grounded = false; d.vault = null;
    engine.tickEvents.push(evHit(p.id, d.id, profile.ramPlayerDamage, false, [d.x, d.y + 1, d.z], d.lastDamage));
    if (lethal) engine.killPlayer(d, p, 'ram', false, null);
  }
  // 5. Attacks.
  const target = scanTarget(engine, policy, p, ai, obj);
  const targetId = target?.id ?? null;
  if (ai.target !== targetId) { ai.target = targetId; ai.windup = 0; ai.burstStart = 0; }
  let aimYaw = p.yaw, canFire = false;
  if (target) {
    const angles = aimAngles([p.x, p.eyeY, p.z], target.point);
    p.pitch = turn(p.pitch, angles.pitch, dt * 3);
    if (route.parked) p.yaw = turn(p.yaw, angles.yaw, profile.turnRate * dt);
    aimYaw = angles.yaw;
    canFire = Math.abs(wrapAngle(angles.yaw - p.yaw)) < (route.parked ? 0.15 : 0.5);
  } else if (route.parked) p.pitch = turn(p.pitch, 0, dt * 3);
  p.input.yaw = p.yaw; p.input.pitch = p.pitch;
  if (p.npcRole === 'apc' && !route.dropped && (route.parked || p.hp < p.maxHp / 2)) policy.ai.dropTroops(p);
  // 6. Buggies grind the objective column while parked beside it.
  if (p.npcRole === 'buggy' && route.parked && obj.hp > 0 && flat(obj, p) <= profile.standoff + obj.half[0] + 3) {
    p.npcAttack = 'ram';
    if (now - route.lastRam >= OBJECTIVE_RAM_MS) { route.lastRam = now; obj.takeDamage(profile.objectiveHit, false, p, 'ram'); }
  }
  if (p.npcRole === 'walker' && profile.mortar && now - ai.seenAt <= SEEN_MS && ai.lastSeen && now >= (route.mortarAt || 0)) {
    route.mortarAt = now + profile.mortar.everyMs;
    policy.fireMortar(p, ai.lastSeen);
  }
  if (!target || !canFire || now < (ai.pauseUntil || 0)) { if (target && now < (ai.pauseUntil || 0)) p.npcAttack = 'cooldown'; return; }
  if (profile.rocket) {
    if (!chargeReady(policy, p, profile, now)) return;
    // Twin tubes: the salvo leaves together with a small yaw spread after the tell.
    for (let i = 0; i < profile.shots; i++) {
      const dir = fwdFromYawPitch(aimYaw + (i - (profile.shots - 1) / 2) * ROCKET_SPREAD, p.pitch);
      engine.projectiles.launchRocket(p, engine.contexts.projectiles, dir);
      engine.tickEvents.push(evShoot(p.id, [p.x, p.eyeY, p.z], [dir.x, dir.y, dir.z], 'rocket', [dir.x, dir.y, dir.z]));
    }
    p.npcAttack = 'firing'; p.firing = true; ai.windup = 0; ai.pauseUntil = now + profile.pauseMs;
    return;
  }
  if (burstFire(policy, p, profile, now)) { p.input.wantFire = true; p.input.yaw = aimYaw; }
}
