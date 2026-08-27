import { nowMs, smooth01 } from '../util/math.js';
import { boundedMapSet } from '../util/bounded-map.js';
import { hashInt } from '../util/hash.js';
import {
  beginAvatarDeath,
  disposeAvatar,
  makeAvatar,
  resetAvatarPose,
  setAvatarFlash,
  setAvatarOpacity,
  setAvatarTeam,
  updateAvatarDeath,
} from './avatar.js';

const IMPACT_TTL_MS = 2200;
const PENDING_HIT_TTL_MS = 650;

export class AvatarRoster {
  constructor({ scene, gore = null, getMyId = () => null, now = nowMs }) {
    this._scene = scene;
    this._gore = gore;
    this._getMyId = getMyId;
    this._now = now;
    this._avatars = new Map();
    this._pendingHits = new Map();
    this._remoteImpacts = new Map();
    this._pendingDeaths = new Map();
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

  get size() {
    return this._avatars.size;
  }

  get counters() {
    return this._counterView;
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

  death(id, at) {
    if (id === this._getMyId()) return;
    const now = Number.isFinite(at) ? at : this._now();
    const avatar = this._avatars.get(id);
    if (!avatar) {
      boundedMapSet(this._pendingDeaths, id, { until: now + IMPACT_TTL_MS });
      return;
    }
    const stored = this._remoteImpacts.get(id);
    const recentAvatarImpact = avatar.lastImpact?.until >= now ? avatar.lastImpact.ev : null;
    const impact = stored?.ev || recentAvatarImpact || {
      vx: avatar.group.position.x,
      vy: avatar.group.position.y + 1.08,
      vz: avatar.group.position.z,
      hs: false,
    };
    if (!beginAvatarDeath(avatar, now, impact)) return;
    this._pendingDeaths.delete(id);
    this._gore?.(impact, { lethal: true, local: false });
  }

  respawn(id, ev) {
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

  sync(remotes, dt, now) {
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

      const pendingHit = this._pendingHits.get(remote.id);
      if (pendingHit) {
        this._pendingHits.delete(remote.id);
        if (pendingHit.until >= now) this.hit(remote.id, pendingHit.ev);
      }
      const pendingDeath = this._pendingDeaths.get(remote.id);
      if (pendingDeath?.until >= now && avatar.alive) this.death(remote.id, now);

      const rowAlive = remote.state === 'alive';
      const alive = rowAlive && now >= avatar.deathForcedUntil;
      if (!alive) {
        if (avatar.alive) this.death(remote.id, now);
        avatar.deathT = Math.min(1.5, avatar.deathT + dt);
        const t = smooth01(avatar.deathT / 1.28);
        const fade = 1 - smooth01((t - 0.72) / 0.28);
        avatar.group.visible = avatar.deathT < 1.42;
        if (avatar.group.visible) {
          counters.dyingAvatars++;
          updateAvatarDeath(avatar, dt, t);
        }
        avatar.group.position.set(remote.x, remote.y, remote.z);
        avatar.group.rotation.set(0, remote.yaw, 0);
        setAvatarOpacity(avatar, fade);
        continue;
      }

      if (!avatar.alive) resetAvatarPose(avatar);
      avatar.alive = true;
      avatar.group.visible = true;
      avatar.group.rotation.set(0, remote.yaw, 0);
      avatar.group.scale.set(1, 1, 1);
      setAvatarOpacity(avatar, 1);

      const rawSpeed = avatar.motionSeeded && dt > 0
        ? Math.hypot(remote.x - avatar.px, remote.z - avatar.pz) / dt
        : 0;
      const speedBlend = 1 - Math.exp(-dt * 10);
      avatar.speedEst += (Math.min(9, rawSpeed) - avatar.speedEst) * speedBlend;
      avatar.motionSeeded = true;
      avatar.px = remote.x;
      avatar.pz = remote.z;
      counters.maxAvatarSpeed = Math.max(counters.maxAvatarSpeed, avatar.speedEst);
      const stride = Math.min(1, avatar.speedEst / 5.8);
      if (stride > 0.03) {
        avatar.runPhase += dt * (5.2 + avatar.speedEst * 1.25);
        counters.runningAvatars++;
      }

      const swing = Math.sin(avatar.runPhase) * stride;
      const cadence = Math.abs(Math.sin(avatar.runPhase * 2));
      const poseBlend = 1 - Math.exp(-dt * (9 + stride * 5));
      const hit01 = avatar.hitT > 0 ? avatar.hitT / 0.18 : 0;
      avatar.hitT = Math.max(0, avatar.hitT - dt);
      const flinch = avatar.hitSide * hit01 * 0.2;

      avatar.group.position.set(remote.x, remote.y + cadence * stride * 0.045, remote.z);
      avatar.lLeg.rotation.x += (swing * 0.78 - avatar.lLeg.rotation.x) * poseBlend;
      avatar.rLeg.rotation.x += (-swing * 0.78 - avatar.rLeg.rotation.x) * poseBlend;
      avatar.lArm.rotation.x += (-swing * 0.68 - avatar.lArm.rotation.x) * poseBlend;
      avatar.rArm.rotation.x += (swing * 0.68 - avatar.rArm.rotation.x) * poseBlend;
      avatar.lArm.rotation.z += (-0.08 - avatar.lArm.rotation.z) * poseBlend;
      avatar.rArm.rotation.z += (0.08 - avatar.rArm.rotation.z) * poseBlend;
      avatar.lElbow.rotation.x += (-0.34 - Math.max(0, swing) * 0.3 - avatar.lElbow.rotation.x) * poseBlend;
      avatar.rElbow.rotation.x += (-0.46 - Math.max(0, -swing) * 0.3 - avatar.rElbow.rotation.x) * poseBlend;
      avatar.torso.rotation.x += (stride * 0.16 - avatar.torso.rotation.x) * poseBlend;
      avatar.torso.rotation.z += ((-swing * stride * 0.055) + flinch - avatar.torso.rotation.z) * poseBlend;
      avatar.hips.rotation.z += (swing * stride * 0.045 - avatar.hips.rotation.z) * poseBlend;
      avatar.head.rotation.x += (remote.pitch * 0.7 - hit01 * 0.1 - avatar.head.rotation.x) * poseBlend;
      avatar.head.rotation.z += (-flinch * 0.7 - avatar.head.rotation.z) * poseBlend;
      setAvatarFlash(avatar, hit01);

      if (remote.hp != null && remote.hp !== avatar.lastHp) {
        avatar.lastHp = remote.hp;
        avatar.updateHealth(remote.hp / 100);
      }
    }
  }

  dispose() {
    for (const avatar of this._avatars.values()) {
      this._scene?.remove(avatar.group);
      disposeAvatar(avatar);
    }
    this._avatars.clear();
    this._pendingHits.clear();
    this._remoteImpacts.clear();
    this._pendingDeaths.clear();
    this._counters.dyingAvatars = 0;
    this._counters.runningAvatars = 0;
    this._counters.maxAvatarSpeed = 0;
    this._scene = null;
    this._gore = null;
    this._getMyId = null;
    this._now = null;
  }
}
