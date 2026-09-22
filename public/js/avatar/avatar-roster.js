import { applyAvatarCosmetics } from '../cosmetics/skins.js';
import { footstepVolume, gaitPhaseRate, strideCrossed } from '../audio/footsteps.js';
import { applyBastionSignal, updateBastionAvatar } from './bastion-avatar.js';
import { makeVehicleAvatar } from './bastion-vehicle.js';
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
// A killed body stays on the ground for this long. Respawn is far shorter than
// that in most modes, so the dead avatar is detached from its player the moment
// it dies: the corpse plays out its own disassembly and fade while the living
// avatar is rebuilt at the next spawn. One corpse per player id, so the scene
// holds at most as many bodies as there are players.
const CORPSE_SECONDS = 10;
const CORPSE_FADE_SECONDS = 1.2;

export class AvatarRoster {
  constructor({ scene, getBlock = null, gore = null, getMyId = () => null, now = nowMs, footstep = null, vehicle = null }) {
    this._footstep = typeof footstep === 'function' ? footstep : null;
    // Positional engine drone: vehicle(id, [x,y,z], kind) while alive, vehicle(id, null) to stop.
    this._vehicleSfx = typeof vehicle === 'function' ? vehicle : null;
    this._scene = scene;
    this._solidAt = getBlock ? (x, y, z) => !!getBlock(x, y, z) : null;
    this._labelTarget = new THREE.Vector3();
    this._labelDirection = new THREE.Vector3();
    this._debugView = new AvatarDebugView(scene);
    this._gore = gore;
    this._getMyId = getMyId;
    this._now = now;
    this._avatars = new Map();
    this._burnFX = null;
    this._pendingHits = new Map();
    this._remoteImpacts = new Map();
    this._pendingDeaths = new Map();
    this._pickaxeSwings = new Map();
    this._corpses = new Map();
    // Rows whose body already fell during their current death: a still-dead row
    // is never rebuilt, so its corpse cannot be killed (and gored) again.
    this._fallen = new Set();
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

  /** Barrel tip of a living remote avatar, or null. Presentation only: hits
   *  stay authoritative. */
  muzzleWorldPos(id, out) {
    if (id === this._getMyId()) return null;
    const avatar = this._avatars.get(id);
    if (!avatar?.alive) return null;
    try {
      const p = avatar.weaponModel?.getMuzzleWorldPosition?.(out);
      return p && Number.isFinite(p.x + p.y + p.z) ? p : null;
    } catch { return null; }
  }
  updateMuzzleLights(pool, local, camera) {
    pool.update(local, this._avatars, camera);
  }

  /** Afterburn presentation for burning snapshot rows. The roster owns no pool:
   *  puffs come from the shared FlameFX batch and expire on their own, so a
   *  burning character stops smoking the moment its row stops burning. */
  setBurnFX(flames) {
    this._burnFX = flames || null;
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
    if (avatar.vehicle) {
      // Vehicles keep their hull: no limb physics, the presenter tilts it over.
      // No gore either: a destroyed hull is not a body.
      if (!avatar.beginDeath?.()) return;
      avatar.deathForcedUntil = Math.max(avatar.deathForcedUntil || 0, now + 1420);
      this._pendingDeaths.delete(id);
      this._vehicleSfx?.(id, null);
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
    this._fallen.delete(id);
    this._pickaxeSwings.delete(id);
    this._pendingHits.delete(id);
    this._pendingDeaths.delete(id);
    this._remoteImpacts.delete(id);
    const avatar = this._avatars.get(id);
    if (!avatar) return;
    if (avatar.vehicle) avatar.reset?.(); else resetAvatarPose(avatar);
    avatar.lastHp = null;
    avatar.lastImpact = null;
    avatar.updateHealth(1);
    if (ev && [ev.x, ev.y, ev.z].every(Number.isFinite)) {
      avatar.px = ev.x;
      avatar.pz = ev.z;
      avatar.group.position.set(ev.x, ev.y, ev.z);
    }
  }

  /**
   * Authoritative RIPTIDE events for a remote avatar's mount: the disc's
   * `projectileExplode` (catch or loss) and a `glaiveStock` that restored a disc.
   */
  glaive(id, event) {
    const model = this._avatars.get(String(id))?.weaponModel;
    if (!model || !event) return;
    if (event.kind === 'projectileExplode' && event.type === 'glaive') model.glaiveEnded?.(event.caught === true);
    else if (event.kind === 'glaiveStock' && event.restored) model.glaiveRestored?.();
  }

  /** Presented world position of one remote avatar (`{x,y,z}`), or null when absent. */
  positionOf(id) {
    const avatar = this._avatars.get(String(id));
    if (!avatar) return null;
    const position = avatar.alive || avatar.vehicle ? avatar.group.position : avatar.hips.position;
    return { x: position.x, y: position.y, z: position.z };
  }

  /** Detach a killed avatar from its player; the body finishes on its own. */
  _retireCorpse(id, avatar) {
    this._fallen.add(id);
    this._avatars.delete(id);
    this._dropCorpse(id);
    this._corpses.set(id, { avatar, elapsed: 0 });
  }

  _dropCorpse(id) {
    const corpse = this._corpses.get(id);
    if (!corpse) return;
    this._corpses.delete(id);
    if (corpse.avatar.vehicle) this._vehicleSfx?.(id, null);
    this._scene?.remove(corpse.avatar.group);
    disposeAvatar(corpse.avatar);
  }

  /** Loose pieces collide and settle, then rest: a still body costs nothing. */
  _stepCorpses(dt) {
    const step = Math.max(0, Math.min(dt, 0.1));
    for (const [id, corpse] of this._corpses) {
      corpse.elapsed += step;
      if (corpse.elapsed >= CORPSE_SECONDS) { this._dropCorpse(id); continue; }
      this._counters.dyingAvatars++;
      if (corpse.avatar.vehicle) corpse.avatar.update?.(step, null);
      if (!corpse.settled) {
        updateAvatarDeath(corpse.avatar, step, corpse.elapsed / CORPSE_SECONDS, this._solidAt);
        corpse.settled = corpse.avatar.limbStates.every(limb =>
          limb.velocity.lengthSq() < 1e-4 && limb.angular.lengthSq() < 1e-4);
      }
      setAvatarOpacity(corpse.avatar, 1 - smooth01(
        (corpse.elapsed - (CORPSE_SECONDS - CORPSE_FADE_SECONDS)) / CORPSE_FADE_SECONDS));
    }
  }

  sync(remotes, dt, now, persistentCorpses = false) {
    for (const [id, until] of this._pickaxeSwings) {
      if (now >= until || !remotes.has(id)) this._pickaxeSwings.delete(id);
    }
    const counters = this._counters;
    counters.dyingAvatars = 0;
    counters.runningAvatars = 0;
    counters.maxAvatarSpeed = 0;
    this._stepCorpses(dt);

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
    for (const id of this._fallen) {
      if (!remotes.get(id) || remotes.get(id).state === 'alive') this._fallen.delete(id);
    }
    for (const [id, avatar] of this._avatars) {
      if (id === myId || !remotes.has(id)) {
        this._scene.remove(avatar.group);
        if (avatar.vehicle) this._vehicleSfx?.(id, null);
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
      // A dead row whose body already fell needs no live avatar: building one
      // here would only be killed again on the same frame, and once the corpse
      // has faded it would drop a second body with a fresh gore burst.
      if (!avatar && remote.state !== 'alive'
          && (this._fallen.has(remote.id) || this._corpses.has(remote.id))) continue;
      if (!avatar) {
        avatar = remote.npcVehicle ? makeVehicleAvatar(remote.id, remote.npcRole) : makeAvatar(remote.id, remote.name, remote.team);
        avatar.px = remote.x;
        avatar.pz = remote.z;
        avatar.group.position.set(remote.x, remote.y, remote.z);
        this._scene.add(avatar.group);
        this._avatars.set(remote.id, avatar);
      }
      if (avatar.vehicle) { this._syncVehicle(avatar, remote, dt, now, persistentCorpses); continue; }
      setAvatarTeam(avatar, remote.team);
      applyAvatarCosmetics(avatar, remote.cosmetics);
      updateBastionAvatar(avatar,remote);
      avatar.disguised = remote.disguised === true;
      if (this._settleDeadRow(avatar, remote, now, persistentCorpses)) continue;

      if (!avatar.alive) resetAvatarPose(avatar);
      avatar.alive = true;
      avatar.group.visible = true;
      avatar.group.rotation.set(0, remote.yaw, 0);
      avatar.group.scale.setScalar(avatar.bodyScale || 1);
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
        const phaseBefore = avatar.runPhase;
        avatar.runPhase += dt * gaitPhaseRate(avatar.speedEst, avatar.motion.air);
        counters.runningAvatars++;
        // A footfall lands with each forward leg extreme; hurried, grounded,
        // upright bodies are audible so nearby enemies can be heard.
        if (this._footstep && strideCrossed(phaseBefore, avatar.runPhase)) {
          const volume = footstepVolume({ speed: avatar.speedEst, grounded,
            crouch: !!remote.crouch || (remote.proneT || 0) > 0.2, swimming: remote.swimming === true });
          if (volume > 0) this._footstep(remote, volume, avatar);
        }
      }

      const swing = Math.sin(avatar.runPhase) * stride;
      const cadence = 0.5 - Math.cos(avatar.runPhase * 2) * 0.5;
      const poseBlend = 1 - Math.exp(-dt * (9 + stride * 5));
      const hit01 = avatar.hitT > 0 ? avatar.hitT / 0.18 : 0;
      avatar.hitT = Math.max(0, avatar.hitT - dt);
      const flinch = avatar.hitSide * hit01 * 0.2;

      // Floating swimmers bob under a steady head; wading in shallow water keeps walking.
      const floating = remote.swimming === true && !grounded;
      avatar.group.position.set(remote.x,
        remote.y + cadence * stride * 0.025 * (1 - avatar.motion.air) * (1 - (avatar.swimPose || 0)) + (avatar.swimBob || 0),
        remote.z);
      const pickaxeUntil = this._pickaxeSwings.get(remote.id);
      const pickaxe = pickaxeUntil !== undefined;
      // Chop clock: every swing event restarts one quick-melee window, so its
      // start is the expiry minus that window.
      avatar.weaponModel.meleeSwing = pickaxe ? (now - pickaxeUntil) / 1000 + QUICK_MELEE_SECONDS : null;
      updateAvatarWeaponPose(avatar, {
        attachments: remote.attachments,
        weapon: pickaxe ? WEAPON_IDS.indexOf('knife') : remote.weapon,
        pitch: remote.pitch,
        firing: pickaxe || remote.firing,
        ads: !pickaxe && remote.ads,
        reloading: !pickaxe && remote.reloading,
        crouching: remote.crouch,
        proneT: remote.proneT,
        leanT: remote.leanT,
        stride,
        swing,
        dt,
        blend: poseBlend,
        charge: remote.charge,
        minigun: remote.minigun,
        swimming: floating,
        speed: avatar.speedEst,
        movement: {
          grounded,
          verticalSpeed: avatar.verticalSpeed,
          lateralSpeed: velocityX * Math.cos(remote.yaw) - velocityZ * Math.sin(remote.yaw),
          forwardSpeed: -(velocityX * Math.sin(remote.yaw) + velocityZ * Math.cos(remote.yaw)),
          turnSpeed,
        },
      });
      if (!persistentCorpses && Array.isArray(remote.owned) && remote.owned.length === 0) avatar.weaponModel.root.visible = false;
      updateAvatarStancePose(avatar, { stride, swing, blend: poseBlend });
      avatar.torso.rotation.z += ((-swing * stride * 0.055) + flinch + (avatar.leanRoll || 0) - avatar.torso.rotation.z) * poseBlend;
      avatar.hips.rotation.z += (swing * stride * 0.045 - avatar.hips.rotation.z) * poseBlend;
      avatar.head.rotation.x += (remote.pitch * 0.7 - hit01 * 0.1 + (avatar.swimHeadTilt || 0) - avatar.head.rotation.x) * poseBlend;
      avatar.head.rotation.z += (-flinch * 0.7 + (avatar.leanRoll || 0) - avatar.head.rotation.z) * poseBlend;
      setAvatarFlash(avatar, hit01);
      // The flash owns the emissive channel while it lasts; the tell returns after it.
      if (hit01 === 0 && avatar.bastionSignal) applyBastionSignal(avatar, remote);
      // Outside-in burning: while the snapshot row burns, feed the shared flame
      // batch from three staggered body emitters (chest/head/legs) at a bounded
      // ~30 puffs/second. Numbers only, no allocation; puffs expire on their own
      // so nothing lingers once burning reaches zero.
      if (this._burnFX && (Number(remote.burning) || 0) > 0) {
        avatar.burnAcc = (avatar.burnAcc || 0) + Math.min(Math.max(dt, 0), 0.1) * 30;
        while (avatar.burnAcc >= 1) {
          avatar.burnAcc -= 1;
          const slot = (avatar.burnSlot || 0) % 3;
          avatar.burnSlot = (avatar.burnSlot || 0) + 1;
          const bx = avatar.group.position.x, by = avatar.group.position.y, bz = avatar.group.position.z;
          if (slot === 0) this._burnFX.emitBurn(bx, by + avatar.torso.position.y, bz, 1);
          else if (slot === 1) this._burnFX.emitBurn(bx, by + avatar.head.position.y, bz, 0.8);
          else this._burnFX.emitBurn(bx, by + 0.45, bz, 0.9);
        }
      } else avatar.burnAcc = 0;

      if (remote.hp != null && remote.hp !== avatar.lastHp) {
        avatar.lastHp = remote.hp;
        avatar.updateHealth(remote.hp / (BASTION_ENEMIES[remote.npcRole]?.hp || 100));
      }
    }
    this._debugView.sync(remotes, this._avatars, myId);
  }

  /**
   * Replay hits and deaths that arrived before the avatar existed, then settle
   * a dead row: kill the avatar once, and either hide it (persistent corpses)
   * or hand it to the corpse pool. Returns true when the row is done this frame.
   */
  _settleDeadRow(avatar, remote, now, persistentCorpses) {
    const pendingHit = this._pendingHits.get(remote.id);
    if (pendingHit) {
      this._pendingHits.delete(remote.id);
      if (pendingHit.until >= now) this.hit(remote.id, pendingHit.ev);
    }
    const pendingDeath = this._pendingDeaths.get(remote.id);
    if (pendingDeath?.until >= now && avatar.alive) this.death(remote.id, now, pendingDeath.damageEvent);
    if (remote.state === 'alive' && now >= (avatar.deathForcedUntil || 0)) return false;
    if (avatar.alive) this.death(remote.id, now);
    if (persistentCorpses) { avatar.group.visible = false; return true; }
    // beginAvatarDeath already baked the world pose into the loose pieces,
    // so the whole avatar can be handed over to the corpse pool as it is.
    this._retireCorpse(remote.id, avatar);
    return true;
  }

  /**
   * Vehicle rows keep position, yaw, opacity, hit flash, hp bar and the corpse
   * pool; the presenter animates wheels, legs and the attack tell itself.
   */
  _syncVehicle(avatar, remote, dt, now, persistentCorpses) {
    if (this._settleDeadRow(avatar, remote, now, persistentCorpses)) return;
    if (!avatar.alive) avatar.reset?.();
    avatar.alive = true;
    avatar.group.visible = true;
    avatar.group.position.set(remote.x, remote.y, remote.z);
    avatar.group.rotation.set(0, remote.yaw, 0);
    setAvatarOpacity(avatar, 1);
    const hit01 = avatar.hitT > 0 ? avatar.hitT / 0.18 : 0;
    avatar.hitT = Math.max(0, avatar.hitT - dt);
    avatar.update?.(dt, remote);
    setAvatarFlash(avatar, hit01);
    if (remote.hp != null && remote.hp !== avatar.lastHp) {
      avatar.lastHp = remote.hp;
      avatar.updateHealth(remote.hp / (BASTION_ENEMIES[remote.npcRole]?.hp || 100));
    }
    this._vehicleSfx?.(remote.id, [remote.x, remote.y, remote.z], remote.npcRole);
  }

  /** Test the player's head, so a tag above cover cannot reveal a hidden enemy. */
  updateLabels(camera, raycast, mode, ownTeam, obscured = null) {
    for (const avatar of this._avatars.values()) {
      const friendly = isTeamMode(mode) && ownTeam != null && avatar.team === ownTeam;
      avatar.tag.material.color.setHex(friendly ? 0x69cfff : 0xff4055);
      let visible = avatar.alive && avatar.group.visible && !avatar.disguised;
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
    for (const [id, avatar] of this._avatars) {
      this._scene?.remove(avatar.group);
      if (avatar.vehicle) this._vehicleSfx?.(id, null);
      disposeAvatar(avatar);
    }
    for (const id of [...this._corpses.keys()]) this._dropCorpse(id);
    this._avatars.clear();
    this._pendingHits.clear();
    this._remoteImpacts.clear();
    this._pendingDeaths.clear();
    this._pickaxeSwings.clear();
    this._fallen.clear();
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
