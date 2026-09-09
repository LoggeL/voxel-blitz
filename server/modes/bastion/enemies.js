import { evShoot } from '../../protocol/events.js';
import { BASTION_ENEMIES } from '../../../shared/bastion.js';
import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { REACTOR_LAYOUT } from '../../../shared/world/reactor-layout.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { PlayerEntity, aimAngles, wrapAngle } from '../../sim/player.js';
import { observeBotTarget } from '../../bot-perception.js';
import { BastionNavigation } from './navigation.js';

const turn = (a, b, rate) => a + Math.max(-rate, Math.min(rate, wrapAngle(b - a)));
export class BastionEnemies {
  constructor(engine, policy) {
    this.engine = engine; this.policy = policy; this.serial = 0;
    this.nav = new BastionNavigation(engine.world, REACTOR_LAYOUT.core);
  }
  spawn(role, lane, index) {
    const profile = BASTION_ENEMIES[role], spawn = REACTOR_LAYOUT.lanes[lane].spawns[index % 3];
    const p = new PlayerEntity(`npc-${this.policy.run}-${++this.serial}`, profile.name, spawn, true);
    Object.assign(p, { npcRole: role, npcSpeed: profile.speed, team: 'bravo', lane,
      hp: profile.hp, armor: profile.armor, weapon: WEAPON_IDS.indexOf(profile.weapon),
      infiniteMagazines: true, grenades: p.grenades.map(() => 0),
      ai: { target: null, seenAt: 0, burstStart: 0, burstShots: 0, pauseUntil: 0,
        windup: 0, lastShot: 0, coreAt: 0, lastMoveAt: this.engine.now, watchX: p.x, watchZ: p.z } });
    this.engine.npcs.set(p.id, p);
    return p;
  }
  visible(p, point) {
    const origin = [p.x, p.eyeY, p.z], delta = point.map((n, i) => n - origin[i]);
    return !this.engine.projectiles.smoke.blocksSight(origin, point, this.engine.now)
      && !raycastVoxels(this.engine.solidAt, ...origin, ...delta, Math.hypot(...delta) - 0.1);
  }
  tick(dt) {
    const e = this.engine, policy = this.policy;
    this.nav.rebuild(e.changedBlocks.size);
    for (const p of e.npcs.values()) {
      if (p.state !== 'alive') { if (e.now >= p.respawnAt) e.npcs.delete(p.id); continue; }
      const ai = p.ai, profile = BASTION_ENEMIES[p.npcRole];
      p.input = { keys: {}, wantFire: false, reload: p.mag[p.weapon] === 0, yaw: p.yaw, pitch: p.pitch };
      if (policy.phase !== 'live') continue;
      const core = policy.core, corePoint = [core.x, core.eyeY, core.z];
      let target = null, targetId = null;
      for (const defender of e.entities.values()) {
        if (!policy.active.has(defender.id) || defender.state !== 'alive') continue;
        const seen = observeBotTarget(p, defender, e.solidAt, e.projectiles.smoke, e.now, ai.target === defender.id);
        if (seen && (!target || seen.distance < target.distance)) {
          target = { point: seen.aimPoint, distance: seen.distance }; targetId = defender.id;
        }
      }
      const distCore = Math.hypot(core.x - p.x, core.z - p.z);
      if (!target && p.npcRole === 'breacher') {
        const b = REACTOR_LAYOUT.lanes[p.lane].breach;
        const point = [Math.floor(b.x) + 0.5, b.y + 1.5, Math.floor(b.z) + 0.5];
        if (e.world.getBlock(Math.floor(b.x), Math.floor(point[1]), Math.floor(b.z))
            && Math.hypot(p.x - b.x, p.z - b.z) < 24) {
          // Aim just in front of the actual blocking wall, keeping smoke checks.
          const delta = point.map((n,i) => n - [p.x,p.eyeY,p.z][i]);
          const length = Math.hypot(...delta);
          const front = point.map((n,i) => n - delta[i] / length * 1.5);
          if (this.visible(p, front)) { target = { point, distance: length }; targetId = 'cover'; }
        }
      }
      if (!target && p.npcRole !== 'runner' && distCore < 26 && this.visible(p, corePoint)) {
        target = { point: corePoint, distance: distCore }; targetId = core.id;
      }
      if (ai.target !== targetId) {
        ai.target = targetId; ai.seenAt = e.now; ai.windup = 0; ai.burstStart = 0;
      }
      const next = this.nav.next(p);
      const move = !target && distCore > 2.3 && next;
      const point = target?.point || (next ? [next.x, p.eyeY, next.z] : corePoint);
      const angles = aimAngles([p.x, p.eyeY, p.z], point);
      p.yaw = turn(p.yaw, angles.yaw, dt * 3); p.pitch = turn(p.pitch, angles.pitch, dt * 3);
      p.input.yaw = p.yaw; p.input.pitch = p.pitch;
      if (move) { p.input.keys.f = true; p.input.viewYaw = aimAngles([p.x,0,p.z],[next.x,0,next.z]).yaw; }
      p.npcAttack = 'advance';
      if (p.npcRole === 'runner' && !target && distCore <= 2.5 && this.visible(p, corePoint)) {
        p.npcAttack = 'strike';
        if (e.now >= ai.coreAt) { core.takeDamage(10, false, p); ai.coreAt = e.now + 1000; p.firing = true; }
      }
      if (!target || Math.abs(wrapAngle(angles.yaw - p.yaw)) > 0.15 || e.now - ai.seenAt < 600) continue;
      if (e.now < ai.pauseUntil) { p.npcAttack = 'cooldown'; continue; }
      if (p.npcRole === 'breacher') {
        if (!ai.windup) {
          ai.windup = e.now;
          policy.emit('bastion_charge',{id:p.id,pos:[p.x,p.eyeY,p.z]});
        }
        p.npcAttack = 'charging';
        if (e.now - ai.windup < profile.windupMs) continue;
        // Launch through the normal projectile simulation after the visible tell.
        const dir = { x: -Math.sin(p.yaw)*Math.cos(p.pitch), y: Math.sin(p.pitch), z: -Math.cos(p.yaw)*Math.cos(p.pitch) };
        e.projectiles.launchRocket(p, e.contexts.projectiles, dir);
        e.tickEvents.push(evShoot(p.id,[p.x,p.eyeY,p.z],[dir.x,dir.y,dir.z],'rocket',[dir.x,dir.y,dir.z]));
        ai.pauseUntil = e.now + profile.pauseMs; ai.windup = 0;
      } else {
        if (!ai.burstStart) { ai.burstStart = e.now; ai.burstShots = p.shotSeq; }
        if (p.shotSeq - ai.burstShots >= profile.shots || e.now - ai.burstStart >= 2000) {
          ai.pauseUntil = e.now + profile.pauseMs; ai.burstStart = 0; p.npcAttack = 'cooldown';
        } else { p.input.wantFire = true; p.npcAttack = 'firing'; }
      }
    }
  }
}
