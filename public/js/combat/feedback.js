// Combat event routing and presentation. Simulation and resource ownership stay
// with the injected player, roster, world, effects, HUD, and audio collaborators.
import * as THREE from '../vendor/three.module.js';
import { SX, SY, SZ } from '../../../shared/worlddata.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { blockSoundFor } from '../weapons/effects.js';

function validImpact(ev) {
  return !!ev && Number.isFinite(Number(ev.vx)) &&
    Number.isFinite(Number(ev.vy)) && Number.isFinite(Number(ev.vz));
}

function impactPosition(ev) {
  return validImpact(ev) ? [Number(ev.vx), Number(ev.vy), Number(ev.vz)] : null;
}

export function distanceToRay(point, origin, direction) {
  const px = point.x - origin[0];
  const py = point.y - origin[1];
  const pz = point.z - origin[2];
  const t = Math.max(0, px * direction[0] + py * direction[1] + pz * direction[2]);
  return Math.hypot(
    px - direction[0] * t,
    py - direction[1] * t,
    pz - direction[2] * t,
  );
}

/**
 * Keep world-anchored combat feedback behind the same voxel cover that hides
 * its impact point. The small end margin prevents the target surface itself
 * from being mistaken for intervening cover.
 */
export function isWorldPointVisible(world, camera, point, endMargin = 0.12) {
  const origin = camera?.position;
  if (!world || typeof world.getBlock !== 'function' || !origin || !Array.isArray(point)) {
    return false;
  }
  const dx = Number(point[0]) - Number(origin.x);
  const dy = Number(point[1]) - Number(origin.y);
  const dz = Number(point[2]) - Number(origin.z);
  const distance = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(distance)) return false;
  if (distance <= endMargin) return true;
  return !raycastVoxels(
    (x, y, z) => world.getBlock(x, y, z),
    Number(origin.x),
    Number(origin.y),
    Number(origin.z),
    dx,
    dy,
    dz,
    distance - endMargin,
  );
}

/** Apply authoritative block deltas before consuming the rest of a snapshot. */
export function applySnapshotBlocks(msg, world) {
  const deltas = msg && Array.isArray(msg.blocks) ? msg.blocks : null;
  if (!deltas || !deltas.length) return;

  const touched = [];
  for (const d of deltas) {
    const i = d.i | 0;
    if (i < 0 || i >= SX * SZ * SY) continue;
    const v = d.v | 0;
    const x = i % SX;
    const z = ((i / SX) | 0) % SZ;
    const y = (i / (SX * SZ)) | 0;
    if (world.getBlock(x, y, z) === v) continue;
    world.setBlock(x, y, z, v);
    touched.push({ x, y, z, v });
  }

  if (touched.length && world.applyDeltas) world.applyDeltas(touched);
}

export class CombatFeedback {
  constructor({
    effects,
    sfx,
    hud,
    roster,
    player,
    getMyId,
    getPlayersCache,
    getSelfRow,
    isRunning,
    camera,
    world,
    viewport = globalThis,
    respawnLocal,
    onLocalDeath,
  }) {
    this.effects = effects;
    this.sfx = sfx;
    this.hud = hud;
    this.roster = roster;
    this.player = player;
    this.getMyId = getMyId;
    this.getPlayersCache = getPlayersCache;
    this.getSelfRow = getSelfRow;
    this.isRunning = isRunning;
    this.camera = camera;
    this.world = world;
    this.viewport = viewport;
    this.respawnLocal = respawnLocal;
    this.onLocalDeath = onLocalDeath;

    this._disposed = false;
    this._presentedDeaths = new WeakSet();
  }

  handleEvent(ev) {
    if (this._disposed || (!this.isRunning() && ev.t !== 'tick')) return;

    const myId = this.getMyId();
    switch (ev.kind) {
      case 'shoot': {
        const local = ev.id === myId;
        if (!local) {
          this.effects.shoot(ev);
          this.sfx.fire(ev.w, { pos: ev.o });
          const d = this.distanceToRay(ev.o, ev.spread || ev.d);
          if (d < 2.2) this.sfx.bulletWhiz(Math.max(0.15, 1 - d / 2.2));
        }
        break;
      }
      case 'hit': {
        const localVictim = ev.victim === myId;
        if (!localVictim) {
          const victimRow = this.getPlayersCache().find((row) => row.id === ev.victim);
          const lethal = victimRow?.state === 'dead' ||
            (Number.isFinite(victimRow?.hp) && victimRow.hp <= 0);
          this.roster.hit(ev.victim, ev);
          if (!lethal) this.effects.gore(ev, { lethal: false, local: false });
          this.sfx.pain({
            damage: ev.dmg,
            headshot: ev.hs,
            lethal,
            pos: impactPosition(ev),
            local: false,
          });
        }
        this.effects.impact(ev);
        if (ev.attacker === myId && !localVictim) {
          const visible = this.isImpactVisible(ev);
          if (visible) {
            this.hud.hitmark(ev.hs);
            this.sfx.hitmark(ev.hs);
          }
          this.spawnDamageNumber(ev, visible);
        }
        if (localVictim && this.player.alive) this.applyLocalHit(ev);
        break;
      }
      case 'kill': {
        this.hud.killfeed(ev);
        if (ev.victim === myId) {
          this.localDeath(ev.killer, { headshot: ev.hs });
        } else {
          this.roster.death(ev.victim);
        }
        break;
      }
      case 'block': {
        const nextType = ev.v | 0;
        const fromType = ev.from | 0;
        if (this.world.getBlock(ev.x, ev.y, ev.z) !== nextType) {
          this.world.setBlock(ev.x, ev.y, ev.z, nextType);
          this.world.applyDeltas([{ x: ev.x, y: ev.y, z: ev.z, v: nextType }]);
        }
        if (nextType === 0 && fromType !== 0) {
          this.effects.explodeBlock(ev.x, ev.y, ev.z, fromType);
          this.sfx.impact(this.blockSound(fromType), 0.8, [ev.x, ev.y, ev.z]);
        }
        break;
      }
      case 'grenadeThrow': {
        this.effects.grenadeThrow(ev, { fromSelf: ev.id === myId });
        break;
      }
      case 'grenadeExplode': {
        this.effects.grenadeExplode(ev);
        this.sfx.grenadeExplosion([ev.x, ev.y, ev.z]);
        break;
      }
      case 'respawn': {
        if (ev.id === myId) {
          const selfRow = this.getSelfRow();
          const hp = selfRow?.hp;
          if (!this.player.alive && selfRow?.state === 'alive' &&
              Number.isFinite(hp) && hp > 0) {
            const transition = this.respawnLocal(selfRow);
            if (transition) this.presentLocalRespawn();
          }
        } else {
          this.roster.respawn(ev.id, ev);
        }
        break;
      }
      case 'die': {
        if (ev.id === myId) this.localDeath(null);
        else this.roster.death(ev.id);
        break;
      }
    }
  }

  applySnapshotBlocks(msg) {
    if (this._disposed) return;
    applySnapshotBlocks(msg, this.world);
  }

  blockSound(type) {
    return blockSoundFor(type);
  }

  distanceToRay(origin, direction) {
    return distanceToRay(this.camera.position, origin, direction);
  }

  isImpactVisible(ev) {
    const point = impactPosition(ev);
    return !!point && isWorldPointVisible(this.world, this.camera, point);
  }

  spawnDamageNumber(ev, impactVisible = this.isImpactVisible(ev)) {
    const v = new THREE.Vector3(ev.vx, ev.vy, ev.vz).project(this.camera);
    const behind = v.z > 1;
    const x = (v.x * 0.5 + 0.5) * this.viewport.innerWidth;
    const y = (-v.y * 0.5 + 0.5) * this.viewport.innerHeight;
    const visible = !behind && impactVisible;
    this.hud.spawnDamage(ev.dmg, x, y, !!visible, ev.hs);
  }

  applyLocalHit(ev) {
    if (this._disposed) return false;
    const hit = this.player.applyHit(ev);
    if (!hit) return false;

    this.hud.setPainImpulse(hit.painImpulse);
    this.effects.gore(ev, { lethal: false, local: true });
    this.sfx.impact('flesh', Math.min(0.5, hit.damage / 60), null);
    this.sfx.pain({
      damage: hit.damage,
      headshot: ev.hs,
      lethal: false,
      pos: impactPosition(ev),
      local: true,
    });
    return true;
  }

  localDeath(killerId, context = null) {
    if (this._disposed) return false;
    const transition = this.player.die(killerId, {
      impact: context?.impact || null,
      headshot: !!context?.headshot,
      id: this.getMyId(),
    });
    if (!transition) return false;

    return this.presentLocalDeath(killerId, transition);
  }

  presentLocalDeath(killerId, transition) {
    if (this._disposed || !transition || typeof transition !== 'object' ||
        this._presentedDeaths.has(transition)) {
      return false;
    }
    this._presentedDeaths.add(transition);
    this.onLocalDeath(transition);

    const headshot = !!transition.headshot;
    this.hud.setPainImpulse(1);
    this.hud.setDeathBrutality(headshot ? 1 : 0.82);
    this.effects?.gore(transition.goreImpact, { lethal: true, local: true });
    this.sfx.deathSelf({ headshot });
    this.hud.setDead(true, killerId ? this.nameOf(killerId) : '');
    return true;
  }

  presentLocalRespawn() {
    if (this._disposed) return;
    this._presentedDeaths = new WeakSet();
    this.hud.setPainImpulse(0);
    this.hud.setDeathBrutality(0);
    this.hud.setDead(false, '');
  }

  nameOf(id) {
    const player = this.getPlayersCache().find((row) => row.id === id);
    return player ? player.name : id;
  }

  reset() {
    this.presentLocalRespawn();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._presentedDeaths = new WeakSet();
    this.effects = null;
    this.sfx = null;
    this.hud = null;
    this.roster = null;
    this.player = null;
    this.camera = null;
    this.world = null;
    this.viewport = null;
    this.getMyId = null;
    this.getPlayersCache = null;
    this.getSelfRow = null;
    this.isRunning = null;
    this.respawnLocal = null;
    this.onLocalDeath = null;
  }
}
