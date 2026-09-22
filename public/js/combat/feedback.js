// Combat event routing and presentation. Simulation and resource ownership stay
// with the injected player, roster, world, effects, HUD, and audio collaborators.
import * as THREE from '../vendor/three.module.js';
import { worldDimensions } from '../../../shared/worlddata.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { blockSoundFor } from '../weapons/effects.js';
import { THROWABLE_NAMES, WEAPON_NAMES } from '../ui/hud-support.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { GRENADE_TYPE_IDS } from '../../../shared/grenade-rules.js';
import { closestBulletFlyby, BULLET_FLYBY_COOLDOWN_MS, BULLET_FLYBY_RADIUS } from './bullet-flyby.js';

/**
 * Screen-space bearing (degrees, 0 = ahead, 90 = right) from the viewer at `from`
 * looking along `yaw` toward `to`; null when either point is incomplete.
 */
export function bearingDeg(from, yaw, to) {
  if (!from || !to || ![from.x, from.z, to.x, to.z, yaw].every(Number.isFinite)) return null;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 1e-6) return null;
  const forward = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
  const right = dx * Math.cos(yaw) + dz * -Math.sin(yaw);
  return Math.atan2(right, forward) * 180 / Math.PI;
}

/** One-line death recap: weapon, markers, range, and what the killer had left. */
export function deathRecapText({ weapon, headshot, longRange, noScope, distance, killerHp } = {}) {
  const parts = [];
  if (weapon && THROWABLE_NAMES[weapon]) parts.push(THROWABLE_NAMES[weapon]);
  else if (weapon && WEAPON_NAMES[weapon]) parts.push(WEAPON_NAMES[weapon]);
  if (headshot) parts.push('HEADSHOT');
  if (longRange) parts.push('LONG RANGE');
  if (noScope) parts.push('NO-SCOPE');
  if (Number.isFinite(distance)) parts.push(`${Math.round(distance)} M`);
  if (Number.isFinite(killerHp)) parts.push(`KILLER AT ${Math.max(0, Math.round(killerHp))} HP`);
  return parts.join(' · ');
}

function validImpact(ev) {
  return !!ev && Number.isFinite(Number(ev.vx)) &&
    Number.isFinite(Number(ev.vy)) && Number.isFinite(Number(ev.vz));
}

function impactPosition(ev) {
  return validImpact(ev) ? [Number(ev.vx), Number(ev.vy), Number(ev.vz)] : null;
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
  const { sx: SX, sy: SY, sz: SZ } = worldDimensions(world);
  const deltas = Array.isArray(msg?.blocks) ? msg.blocks : [];
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

  // NetClient has already applied these persistent health changes. A block
  // can keep its material ID while its silhouette needs to be rebuilt.
  for (const d of Array.isArray(msg?.blockDamage) ? msg.blockDamage : []) {
    if (!d || ![d.x, d.y, d.z].every(Number.isInteger) ||
        d.x < 0 || d.x >= SX || d.y < 0 || d.y >= SY || d.z < 0 || d.z >= SZ) continue;
    touched.push({ x: d.x, y: d.y, z: d.z, v: world.getBlock(d.x, d.y, d.z) });
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
    onLocalMine,
    onLocalFlinch,
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
    this.onLocalMine = onLocalMine;
    this.onLocalFlinch = onLocalFlinch;

    this._disposed = false;
    this._presentedDeaths = new WeakSet();
    this._minedBreak = null;
    this._lastBulletFlybyAt = -Infinity;
  }

  handleEvent(ev) {
    if (this._disposed || !this.isRunning()) return;

    const myId = this.getMyId();
    // A completed mine is immediately followed by its authoritative block
    // mutation. Its contact already includes debris; consume only that pair.
    const minedBreak = this._minedBreak;
    this._minedBreak = null;
    switch (ev.kind) {
      case 'powerup': {
        if (ev.id === myId) this.hud.powerup(ev);
        break;
      }
      case 'shoot': {
        if (ev.chaosArc) { this.effects.railBeams?.shoot(ev); break; }
        // Extra Chaos jets are authoritative and have no local prediction.
        if (ev.chaosFlame) { this.effects.shoot(ev); break; }
        const local = ev.id === myId;
        if (local) this.effects.confirmShot?.(ev);
        if (!local) {
          if (ev.w === 'knife') this.roster?.swingPickaxe?.(ev.id);
          this.effects.shoot(ev);
          this.sfx.fire(ev.w, ev.w === 'flamethrower'
            ? { pos: ev.o, shooterId: ev.id } : { pos: ev.o });
          const definition = WEAPONS[ev.w];
          if (this.player?.alive && definition && !definition.flame &&
              !definition.projectile && definition.mode !== 'melee' &&
              !ev.hitVictims?.includes(myId)) {
            const now = performance.now();
            const pass = closestBulletFlyby(ev.paths, this.camera?.position);
            if (pass && now - this._lastBulletFlybyAt >= BULLET_FLYBY_COOLDOWN_MS &&
                isWorldPointVisible(this.world, this.camera, pass.pos)) {
              this._lastBulletFlybyAt = now;
              this.sfx.bulletWhiz(pass.volume, { pos: pass.pos });
              // Grazing fire startles the hold and flickers the danger edge toward
              // the pass. Burns no panic itself; the server owns suppression gain.
              const proximity = Math.max(0, Math.min(1, 1 - pass.distance / BULLET_FLYBY_RADIUS));
              const angleDeg = bearingDeg(this.camera?.position, this.player?.view?.yaw,
                { x: pass.pos[0], z: pass.pos[2] });
              this.hud?.setPainImpulse?.(angleDeg == null
                ? 0.14 + 0.2 * proximity
                : { intensity: 0.14 + 0.2 * proximity, angleDeg });
              this.onLocalFlinch?.(0.35 + 0.65 * proximity);
            }
          }
        }
        break;
      }
      case 'hit': {
        const localVictim = ev.victim === myId;
        if (!localVictim) {
          const victimRow = this.getPlayersCache().find((row) => row.id === ev.victim);
          const lethal = ev.lethal ?? (victimRow?.state === 'dead' ||
            (Number.isFinite(victimRow?.hp) && victimRow.hp <= 0));
          this.roster.hit(ev.victim, ev);
          // Bastion vehicles are player rows too: their armour rings instead of bleeding.
          const vehicle = !!victimRow?.npcVehicle;
          if (!lethal && !vehicle) this.effects.gore(ev, { lethal: false, local: false });
          if (vehicle) this.sfx.impact('metal', Math.min(1, (Number(ev.dmg) || 0) / 40 + 0.35), impactPosition(ev));
          else this.sfx.pain({
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
            this.hud.hitmark(ev.hs ? 'head' : 'body');
            this.sfx.hitmark(ev.hs);
          }
          this.spawnDamageNumber(ev, visible);
        }
        if (localVictim && this.player.alive) this.applyLocalHit(ev);
        break;
      }
      case 'body_identified': {
        this.hud.bodyIdentified(ev);
        break;
      }
      case 'kill': {
        this.hud.killfeed(ev);
        if (ev.victim === myId) {
          this.localDeath(ev.killer, { headshot: ev.hs, event: ev });
        } else {
          this.roster.death(ev.victim, undefined, ev);
          if (ev.killer === myId) {
            // Kill confirmation outranks the body/head mark of the lethal hit.
            this.hud.hitmark(ev.hs ? 'killHead' : 'kill');
            if (!this.sfx.playCosmetic?.(this.getSelfRow()?.cosmetics?.sound, 'kill')) this.sfx.killConfirm?.(!!ev.hs);
          }
        }
        break;
      }
      case 'mine': {
        if (ev.id === this.getMyId()) this.onLocalMine?.(ev);
        this.effects.impacts.mine(ev);
        this.sfx.mine(ev.from, ev.progress >= 1, [ev.x + 0.5, ev.y + 0.5, ev.z + 0.5]);
        if (ev.progress >= 1) this._minedBreak = { x: ev.x, y: ev.y, z: ev.z };
        break;
      }
      case 'blockDamage': {
        this.effects.impacts.chipBlock(ev);
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
          if (!minedBreak || minedBreak.x !== ev.x || minedBreak.y !== ev.y || minedBreak.z !== ev.z) {
            this.sfx.impact(this.blockSound(fromType), 0.8, [ev.x, ev.y, ev.z]);
          }
        }
        break;
      }
      case 'projectileLaunch': {
        const fromSelf = ev.id === myId;
        this.effects.projectileLaunch(ev, { fromSelf });
        if (!fromSelf && GRENADE_TYPE_IDS.includes(ev.type)) {
          // The local hand release already played its predicted throw cue.
          this.sfx.grenadeThrow(Number.isFinite(ev.charge) ? ev.charge : 0.5, { pos: ev.o });
        }
        break;
      }
      case 'projectileUpdate': {
        this.effects.projectiles?.updateAuthority(ev);
        break;
      }
      case 'projectileExplode': {
        this.effects.projectileExplode(ev);
        this.sfx.explosion([ev.x, ev.y, ev.z], ev.type);
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
        if (ev.id === myId) this.localDeath(null, { event: ev });
        else this.roster.death(ev.id, undefined, ev);
        break;
      }
    }
  }

  blockSound(type) {
    return blockSoundFor(type);
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
    this.hud.spawnDamage(ev.dmg, x, y, !!visible, ev.hs, ev.victim ?? null);
  }

  /** Where the damage came from, relative to the current view, for the pain vignette. */
  attackerBearing(ev) {
    const attacker = this.getPlayersCache().find((row) => row.id === ev?.attacker);
    const pos = this.player?.pos;
    const yaw = this.player?.view?.yaw;
    return bearingDeg(pos, yaw, attacker);
  }

  applyLocalHit(ev) {
    if (this._disposed) return false;
    const hit = this.player.applyHit(ev);
    if (!hit) return false;

    const angleDeg = this.attackerBearing(ev);
    this.hud.setPainImpulse(angleDeg == null
      ? hit.painImpulse
      : { intensity: hit.painImpulse, angleDeg });
    const healthDamage = Number.isFinite(hit.healthDamage) ? hit.healthDamage : hit.damage;
    if (healthDamage > 0) {
      this.effects.gore(ev, { lethal: false, local: true });
      this.sfx.impact('flesh', Math.min(0.5, healthDamage / 60), null);
      this.sfx.pain({
        damage: healthDamage,
        headshot: ev.hs,
        lethal: false,
        pos: impactPosition(ev),
        local: true,
      });
    } else {
      this.sfx.impact('metal', Math.min(0.35, hit.damage / 80), null);
    }
    return true;
  }

  localDeath(killerId, context = null) {
    if (this._disposed) return false;
    const transition = this.player.die(killerId, {
      impact: context?.impact || null,
      damageEvent: context?.event || null,
      headshot: !!context?.headshot,
      id: this.getMyId(),
    });
    if (!transition) return false;

    return this.presentLocalDeath(killerId, transition, context?.event || null);
  }

  presentLocalDeath(killerId, transition, event = null) {
    if (this._disposed || !transition || typeof transition !== 'object' ||
        this._presentedDeaths.has(transition)) {
      return false;
    }
    this._presentedDeaths.add(transition);
    this.onLocalDeath(transition, killerId || null, event);

    const headshot = !!transition.headshot;
    this.hud.setPainImpulse(1);
    this.hud.setDeathBrutality(headshot ? 1 : 0.82);
    this.effects?.gore(transition.goreImpact, { lethal: true, local: true });
    this.sfx.deathSelf({ headshot });
    const killer = killerId && killerId !== this.getMyId() ? this.getPlayersCache().find(row => row.id === killerId) : null;
    const cosmetics = killerId && killerId !== this.getMyId() ? event?.cosmetics || killer?.cosmetics : null;
    this.sfx.stopCosmetics?.('kill');
    this.sfx.stopCosmetics?.('death');
    this.sfx.playCosmetic?.(cosmetics?.sound, 'death');
    this.hud.setDead(true, killerId ? this.nameOf(killerId) : '', this.deathRecap(killerId, event, headshot), cosmetics);
    return true;
  }

  deathRecap(killerId, event, headshot) {
    const killer = killerId ? this.getPlayersCache().find((row) => row.id === killerId) : null;
    const pos = this.player?.pos;
    // The server's shot length (ricochet legs included) decides LONG RANGE, so it
    // is the range shown; kills without a ray fall back to the 3D row distance.
    const distance = Number.isFinite(event?.dist) ? event.dist
      : killer && pos && [killer.x, killer.y, killer.z, pos.x, pos.y, pos.z].every(Number.isFinite)
        ? Math.hypot(killer.x - pos.x, killer.y - pos.y, killer.z - pos.z)
        : NaN;
    return deathRecapText({
      weapon: event?.w || null,
      headshot: !!(event?.hs ?? headshot),
      longRange: !!event?.lr,
      noScope: !!event?.ns,
      distance,
      killerHp: killer && killer.id !== this.getMyId() ? killer.hp : NaN,
    });
  }

  presentLocalRespawn() {
    if (this._disposed) return;
    this.sfx.stopCosmetics?.('kill');
    this.sfx.stopCosmetics?.('death');
    this._presentedDeaths = new WeakSet();
    this.hud.setPainImpulse(0);
    this.hud.setDeathBrutality(0);
    this.hud.setDead(false, '');
  }

  nameOf(id) {
    const player = this.getPlayersCache().find((row) => row.id === id);
    return player ? player.name : id;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.sfx.stopFlames?.();
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
