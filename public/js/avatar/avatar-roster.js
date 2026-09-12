import { applyAvatarCosmetics } from '../cosmetics/skins.js';
import { updateBastionAvatar } from './bastion-avatar.js';
import { BASTION_ENEMIES } from '../../../shared/bastion.js';
import * as THREE from '../vendor/three.module.js';
import { isTeamMode } from '../../../shared/modes.js';
import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { QUICK_MELEE_SECONDS } from '../../../shared/quick-melee.js';
import { AvatarDebugView } from './debug-view.js';
import { nowMs, smooth01 } from '../util/math.js';
import { boundedMapSet } from '../util/bounded-map.js';
import { hashInt } from '../util/hash.js';
import { withGoreDamage } from '../weapons/gore-profile.js';
import {
  beginAvatarDeath,
  disposeAvatar,
  makeAvatar,
  resetAvatarPose,
  setAvatarFlash,
  setAvatarOpacity,
  setAvatarTeam,
  updateAvatarDeath,
  updateAvatarStancePose,
  updateAvatarWeaponPose,
} from './avatar.js';

const IMPACT_TTL_MS = 2200;
const PENDING_HIT_TTL_MS = 650;

export class AvatarRoster {
  constructor({ scene, getBlock = null, gore = null, getMyId = () => null, now = nowMs }) {
    this._scene = scene;
    this._solidAt = getBlock ? (x, y, z) => !!getBlock(x, y, z) : null;
    this._labelTarget = new THREE.Vector3();
    this._labelDirection = new THREE.Vector3();
    this._debugView = new AvatarDebugView(scene);
    this._gore = gore;
    this._getMyId = getMyId;
    this._now = now;
    this._avatars = new Map();
    this._pendingHits = new Map();
    this._remoteImpacts = new Map();
    this._pendingDeaths = new Map();
    this._pickaxeSwings = new Map();
    this._counters = {
      dyingAvatars: 0,
      runningAvatars: 0,
      maxAvatarSpeed: 0,
    };
    const counters = this._counters;
    this._counterView = Object.freeze({
      get dyingAvatars() { return counters.dyingAvatars; },
      get runningAvatars() { return counters.runningAvatars; },
      get maxAvatarSpeed() { return counters.maxAvatarSpeed; },
    });
  }

  updateMuzzleLights(pool, local, camera) {
    pool.update(local, this._avatars, camera);
  }

  get size() {
    return this._avatars.size;
  }

  get counters() {
    return this._counterView;
  }

  swingPickaxe(id) {
    if (id === this._getMyId()) return;
    boundedMapSet(this._pickaxeSwings, id, this._now() + QUICK_MELEE_SECONDS * 1000);
  }

  hit(id, ev) {
    if (id === this._getMyId()) return;
    const now = this._now();
    boundedMapSet(this._remoteImpacts, id, { ev, until: now + IMPACT_TTL_MS });
    const avatar = this._avatars.get(id);
    if (!avatar) {
      boundedMapSet(this._pendingHits, id, { ev, until: now + PENDING_HIT_TTL_MS });
      return;
    }
    avatar.lastImpact = { ev, until: now + IMPACT_TTL_MS };
    if (!avatar.alive) return;
    avatar.hitT = 0.18;
    avatar.hitSide = (hashInt(String(ev && ev.attacker || id)) & 1) ? 1 : -1;
  }

  death(id, at, damageEvent = null) {
    if (id === this._getMyId()) return;
    const now = Number.isFinite(at) ? at : this._now();
    const avatar = this._avatars.get(id);
    if (!avatar) {
      boundedMapSet(this._pendingDeaths, id, { until: now + IMPACT_TTL_MS, damageEvent });
      return;
    }
    const stored = this._remoteImpacts.get(id);
    const recentAvatarImpact = avatar.lastImpact?.until >= now ? avatar.lastImpact.ev : null;
    const impact = withGoreDamage(stored?.ev || recentAvatarImpact || {
      vx: avatar.group.position.x,
      vy: avatar.group.position.y + 1.08,
      vz: avatar.group.position.z,
      hs: false,
    }, damageEvent);
    if (!beginAvatarDeath(avatar, now, impact)) return;
    this._pendingDeaths.delete(id);
    this._gore?.(impact, { lethal: true, local: false });
  }

  respawn(id, ev) {
    this._pickaxeSwings.delete(id);
    this._pendingHits.delete(id);
    this._pendingDeaths.delete(id);
    this._remoteImpacts.delete(id);
    const avatar = this._avatars.get(id);
    if (!avatar) return;
    resetAvatarPose(avatar);
    avatar.lastHp = null;
    avatar.lastImpact = null;
    avatar.updateHealth(1);
    if (ev && [ev.x, ev.y, ev.z].every(Number.isFinite)) {
      avatar.px = ev.x;
      avatar.pz = ev.z;
      avatar.group.position.set(ev.x, ev.y, ev.z);
    }
  }

  /** Presented world position of one remote avatar (`{x,y,z}`), or null when absent. */
  positionOf(id) {
    const avatar = this._avatars.get(String(id));
    if (!avatar) return null;
    const position = avatar.alive ? avatar.group.position : avatar.hips.position;
    return { x: position.x, y: position.y, z: position.z };
  }

  sync(remotes, dt, now) {
    for (const [id, until] of this._pickaxeSwings) {
      if (now >= until || !remotes.has(id)) this._pickaxeSwings.delete(id);
    }
    const counters = this._counters;
    counters.dyingAvatars = 0;
    counters.runningAvatars = 0;
    counters.maxAvatarSpeed = 0;

    for (const [id, pending] of this._pendingHits) {
      if (pending.until < now) this._pendingHits.delete(id);
    }
    for (const [id, pending] of this._remoteImpacts) {
      if (pending.until < now) this._remoteImpacts.delete(id);
    }
    for (const [id, pending] of this._pendingDeaths) {
      if (pending.until < now) this._pendingDeaths.delete(id);
    }

    const myId = this._getMyId();
    for (const [id, avatar] of this._avatars) {
      if (id === myId || !remotes.has(id)) {
        this._scene.remove(avatar.group);
        this._avatars.delete(id);
        this._pendingHits.delete(id);
        this._pendingDeaths.delete(id);
        this._remoteImpacts.delete(id);
        disposeAvatar(avatar);
      }
    }

    for (const remote of remotes.values()) {
      if (remote.id === myId) continue;
      let avatar = this._avatars.get(remote.id);
      if (!avatar) {
        avatar = makeAvatar(remote.id, remote.name, remote.team);
        avatar.px = remote.x;
        avatar.pz = remote.z;
        avatar.group.position.set(remote.x, remote.y, remote.z);
        this._scene.add(avatar.group);
        this._avatars.set(remote.id, avatar);
      }
      setAvatarTeam(avatar, remote.team);
      applyAvatarCosmetics(avatar, remote.cosmetics);
      updateBastionAvatar(avatar,remote);

      const pendingHit = this._pendingHits.get(remote.id);
      if (pendingHit) {
        this._pendingHits.delete(remote.id);
        if (pendingHit.until >= now) this.hit(remote.id, pendingHit.ev);
      }
      const pendingDeath = this._pendingDeaths.get(remote.id);
      if (pendingDeath?.until >= now && avatar.alive) this.death(remote.id, now, pendingDeath.damageEvent);

      const rowAlive = remote.state === 'alive';
      const alive = rowAlive && now >= avatar.deathForcedUntil;
      if (!alive) {
        if (avatar.alive) this.death(remote.id, now);
        avatar.deathT = Math.min(2.8, avatar.deathT + dt);
        const t = smooth01(avatar.deathT / 2.7);
        const fade = 1 - smooth01((t - 0.72) / 0.28);
        avatar.group.visible = avatar.deathT < 2.7;
        if (avatar.group.visible) {
          counters.dyingAvatars++;
          updateAvatarDeath(avatar, dt, t, this._solidAt);
        }
        setAvatarOpacity(avatar, fade);
        continue;
      }

      if (!avatar.alive) resetAvatarPose(avatar);
      avatar.alive = true;
      avatar.group.visible = true;
      avatar.group.rotation.set(0, remote.yaw, 0);
      avatar.group.scale.set(1, 1, 1);
      setAvatarOpacity(avatar, 1);

      const sampleMotion = avatar.motionSeeded && dt > 0;
      const velocityX = sampleMotion ? (remote.x - avatar.px) / dt : 0;
      const velocityZ = sampleMotion ? (remote.z - avatar.pz) / dt : 0;
      const verticalSpeed = sampleMotion && avatar.py != null ? (remote.y - avatar.py) / dt : 0;
      const turnSpeed = sampleMotion && avatar.lastYaw != null
        ? Math.atan2(Math.sin(remote.yaw - avatar.lastYaw), Math.cos(remote.yaw - avatar.lastYaw)) / dt : 0;
      // Authoritative flags cover jump apices and the level finish of a mantle.
      // The short hold also keeps older snapshots stable around a jump apex.
      avatar.airborneHold = Math.abs(verticalSpeed) > 0.35 ? 0.14 : Math.max(0, avatar.airborneHold - dt);
      const grounded = !remote.vaulting && (typeof remote.grounded === 'boolean'
        ? remote.grounded : avatar.airborneHold === 0);
      const rawSpeed = Number.isFinite(remote.moveSpeed)
        ? remote.moveSpeed : Math.hypot(velocityX, velocityZ);
      const speedBlend = 1 - Math.exp(-dt * 10);
      avatar.speedEst += (Math.min(9, rawSpeed) - avatar.speedEst) * speedBlend;
      avatar.motionSeeded = true;
      avatar.px = remote.x;
      avatar.pz = remote.z;
      avatar.py = remote.y;
      avatar.lastYaw = remote.yaw;
      avatar.verticalSpeed = Math.max(-20, Math.min(12, verticalSpeed));
      counters.maxAvatarSpeed = Math.max(counters.maxAvatarSpeed, avatar.speedEst);
      const stride = Math.min(1, avatar.speedEst / 5.8);
      if (stride > 0.03) {
        avatar.runPhase += dt * (5.2 + avatar.speedEst * 1.25) * (1 - avatar.motion.air * 0.85);
        counters.runningAvatars++;
      }

      const swing = Math.sin(avatar.runPhase) * stride;
      const cadence = 0.5 - Math.cos(avatar.runPhase * 2) * 0.5;
      const poseBlend = 1 - Math.exp(-dt * (9 + stride * 5));
      const hit01 = avatar.hitT > 0 ? avatar.hitT / 0.18 : 0;
      avatar.hitT = Math.max(0, avatar.hitT - dt);
      const flinch = avatar.hitSide * hit01 * 0.2;

      avatar.group.position.set(remote.x, remote.y + cadence * stride * 0.025 * (1 - avatar.motion.air), remote.z);
      const pickaxe = this._pickaxeSwings.has(remote.id);
      updateAvatarWeaponPose(avatar, {
        attachments: remote.attachments,
        weapon: pickaxe ? WEAPON_IDS.indexOf('knife') : remote.weapon,
        pitch: remote.pitch,
        firing: pickaxe || remote.firing,
        ads: !pickaxe && remote.ads,
        reloading: !pickaxe && remote.reloading,
        crouching: remote.crouch,
        proneT: remote.proneT,
        stride,
        swing,
        dt,
        blend: poseBlend,
        charge: remote.charge,
        minigun: remote.minigun,
        movement: {
          grounded,
          verticalSpeed: avatar.verticalSpeed,
          lateralSpeed: velocityX * Math.cos(remote.yaw) - velocityZ * Math.sin(remote.yaw),
          forwardSpeed: -(velocityX * Math.sin(remote.yaw) + velocityZ * Math.cos(remote.yaw)),
          turnSpeed,
        },
      });
      updateAvatarStancePose(avatar, { stride, swing, blend: poseBlend });
      avatar.torso.rotation.z += ((-swing * stride * 0.055) + flinch - avatar.torso.rotation.z) * poseBlend;
      avatar.hips.rotation.z += (swing * stride * 0.045 - avatar.hips.rotation.z) * poseBlend;
      avatar.head.rotation.x += (remote.pitch * 0.7 - hit01 * 0.1 - avatar.head.rotation.x) * poseBlend;
      avatar.head.rotation.z += (-flinch * 0.7 - avatar.head.rotation.z) * poseBlend;
      setAvatarFlash(avatar, hit01);

      if (remote.hp != null && remote.hp !== avatar.lastHp) {
        avatar.lastHp = remote.hp;
        avatar.updateHealth(remote.hp / (BASTION_ENEMIES[remote.npcRole]?.hp || 100));
      }
    }
    this._debugView.sync(remotes, this._avatars, myId);
  }

  /** Test the player's head, so a tag above cover cannot reveal a hidden enemy. */
  updateLabels(camera, raycast, mode, ownTeam, obscured = null) {
    for (const avatar of this._avatars.values()) {
      const friendly = isTeamMode(mode) && ownTeam != null && avatar.team === ownTeam;
      avatar.tag.material.color.setHex(friendly ? 0x69cfff : 0xff4055);
      let visible = avatar.alive && avatar.group.visible;
      if (visible) {
        avatar.head.getWorldPosition(this._labelTarget);
        this._labelDirection.copy(this._labelTarget).sub(camera.position);
        const distance = this._labelDirection.length();
        this._labelDirection.multiplyScalar(1 / Math.max(distance, 0.0001));
        const hit = raycast(camera.position, this._labelDirection, distance);
        visible = (!hit || hit.t >= distance) && !obscured?.(camera.position, this._labelTarget);
      }
      avatar.tag.visible = visible;
      avatar.hpSpr.visible = visible;
    }
  }

  hideLabels() {
    for (const avatar of this._avatars.values()) {
      avatar.tag.visible = false;
      avatar.hpSpr.visible = false;
    }
  }

  dispose() {
    this._debugView.dispose();
    for (const avatar of this._avatars.values()) {
      this._scene?.remove(avatar.group);
      disposeAvatar(avatar);
    }
    this._avatars.clear();
    this._pendingHits.clear();
    this._remoteImpacts.clear();
    this._pendingDeaths.clear();
    this._pickaxeSwings.clear();
    this._counters.dyingAvatars = 0;
    this._counters.runningAvatars = 0;
    this._counters.maxAvatarSpeed = 0;
    this._scene = null;
    this._gore = null;
    this._solidAt = null;
    this._getMyId = null;
    this._now = null;
  }
}
