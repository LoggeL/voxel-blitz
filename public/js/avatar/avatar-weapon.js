import { applyAttachmentModel } from '../guns/attachment-model.js';
import { applyStattrakModule } from '../guns/stattrak-module.js';
import { applyGunCosmetics } from '../cosmetics/skins.js';
import * as THREE from '../vendor/three.module.js';
import { animateHeavyWeapon } from '../guns/heavy-weapon-animation.js';
import { glaivePresentationFor } from '../guns/glaive-presentation.js';
import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import { SWIM } from '../../../shared/player-stance.js';
import { buildGun, disposeGunModels } from '../guns/assemble.js';
import { HANDS } from '../guns/defs.js';
import { pickaxeChopPitch } from '../guns/pickaxe-swing.js';
import { MaterialCache } from '../guns/kit.js';

const BASE_POSITION = new THREE.Vector3(0.15, 1.30, -0.21);
const MODEL_SCALE = 1.10;
const ADS_SIGHT_X = 0.055;
const ADS_SIGHT_Y = 1.62;
const ADS_DEPTH_OFFSET = -0.045;
const MAX_PITCH = (80 * Math.PI) / 180;
const X_AXIS = new THREE.Vector3(1, 0, 0);
// Remote RIPTIDE discs: without their authoritative flight the mount assumes the natural
// return (out leg plus the curve home, measured at about 1.45 s) and replays the catch.
// Lost-event guard only: remote discs resolve from the authoritative explode/stock events.
const GLAIVE_LOST_EVENT_S = 6;
const REFERENCE_GRIP_TARGET = new THREE.Vector3(
  BASE_POSITION.x + HANDS.rifle.grip.x * MODEL_SCALE,
  BASE_POSITION.y + HANDS.rifle.grip.y * MODEL_SCALE,
  BASE_POSITION.z + HANDS.rifle.grip.z * MODEL_SCALE,
);

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function weaponId(value) {
  if (typeof value === 'string' && WEAPON_IDS.includes(value)) return value;
  return WEAPON_IDS[Math.max(0, Math.min(WEAPON_IDS.length - 1,
    Number.isInteger(value) ? value : 0))];
}

function mountProfile(id, sightHeight) {
  const hands = HANDS[id];
  const hip = new THREE.Vector3(
    REFERENCE_GRIP_TARGET.x - hands.grip.x * MODEL_SCALE,
    REFERENCE_GRIP_TARGET.y - hands.grip.y * MODEL_SCALE,
    REFERENCE_GRIP_TARGET.z - hands.grip.z * MODEL_SCALE,
  );
  return {
    hands,
    hip,
    ads: new THREE.Vector3(
      ADS_SIGHT_X,
      ADS_SIGHT_Y - sightHeight * MODEL_SCALE,
      hip.z + ADS_DEPTH_OFFSET,
    ),
  };
}

/** One real gun model mounted to a remote avatar, with ownership isolated from the FPS rig. */
export class AvatarWeaponModel {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'avatar_weapon_mount';
    this.root.position.copy(BASE_POSITION);
    this._cache = null;
    this._model = null;
    this._weaponId = null;
    this._recoil = 0;
    // Seconds since this carrier's current IRON PICK swing started (null = none).
    // Set by the roster from the swing event clock; drives the overhead chop.
    this.meleeSwing = null;
    this._chopGrip = new THREE.Vector3();
    this._flash = 0;
    this._ads = 0;
    this._reload = 0;      // smoothed 0..1 reload pose weight
    this._reloadT = 0;     // seconds into the reload loop
    this._deployT = 0;     // seconds left in the draw raise
    this._deployDur = 0;
    this._profile = null;
    this._disposed = false;
  }

  /** 0..1 reload pose weight (third-person mag work). */
  get reloadT() { return this._reload; }
  /** 0..1 draw progress; 1 once the new weapon is fully raised. */
  get deployT() {
    return this._deployDur > 0 ? 1 - this._deployT / this._deployDur : 1;
  }

  get flashLight() { return this._model?.flash.light || null; }

  get id() { return this._weaponId; }
  get modelRoot() { return this._model?.root || null; }
  get handPose() { return this._profile?.hands || HANDS.rifle; }
  get twoHanded() { return !!this.handPose.support; }
  get adsT() { return this._ads; }

  /** World-space barrel-tip anchor for remote shot presentation. */
  getMuzzleWorldPosition(out = new THREE.Vector3()) {
    if (!this._model?.muzzleMarker) return out.set(NaN, NaN, NaN);
    return this._model.muzzleMarker.getWorldPosition(out);
  }

  /** World-space sight-line anchor without exposing gun assembly internals. */
  getSightWorldPosition(out = new THREE.Vector3()) {
    if (!this._model) return out.set(NaN, NaN, NaN);
    const sightHeight = Number(this._model.body?.userData?.sightHeight);
    this._model.root.updateWorldMatrix(true, false);
    return out.set(0, Number.isFinite(sightHeight) ? sightHeight : 0.12, 0)
      .applyMatrix4(this._model.root.matrixWorld);
  }

  setCosmetics(loadout) {
    this._cosmetics = loadout;
    if (this._model) applyGunCosmetics(this._model, this._weaponId, loadout);
  }

  setWeapon(value) {
    const nextId = weaponId(value);
    if (this._disposed || nextId === this._weaponId) return false;
    const previousId = this._weaponId;
    this._disposeModel();
    this._cache = new MaterialCache();
    this._model = buildGun(nextId, this._cache);
    this._weaponId = nextId;
    applyGunCosmetics(this._model, nextId, this._cosmetics);
    this._model.root.traverse((object) => {
      if (object.name === 'hand_r' || object.name === 'hand_l') object.visible = false;
    });
    this._model.root.scale.setScalar(MODEL_SCALE);
    const sightHeight = Number(this._model.body?.userData?.sightHeight);
    this._profile = mountProfile(nextId, Number.isFinite(sightHeight) ? sightHeight : 0.12);
    this._model.flash.grp.scale.setScalar(0.58);
    for (const object of this._model.flash.grp.children) {
      if (object.isMesh) object.scale.set(1, 0.22, 1);
    }
    this.root.add(this._model.root);
    const hadWeapon = !!previousId;
    this.resetPose();
    if (hadWeapon) {
      // A swap on a remote player reads as the same raise the first-person rig plays.
      this._deployDur = Math.max(0.12, WEAPONS[nextId]?.deployTime || 0.4);
      this._deployT = this._deployDur;
    }
    return true;
  }

  update({
    weapon,
    attachments,
    pitch = 0,
    firing = false,
    ads = false,
    reloading = false,
    crouchT = 0,
    prone = 0,
    stride = 0,
    swing = 0,
    dt = 0,
    charge = 0,
    minigun,
    swim = 0,
    swimSway = 0,
    glaive,
  } = {}) {
    this.setWeapon(weapon);
    if (!this._model) return;
    applyAttachmentModel(this._model, this._weaponId, attachments);
    // Remote mastery never crosses the snapshot wire, so their plates stay off
    // rather than showing a wrong number; the toggle state still flows through.
    applyStattrakModule(this._model, this._weaponId, attachments);
    const frameDt = Math.max(0, Number(dt) || 0);
    this._machineTime = (this._machineTime || 0) + frameDt;
    animateHeavyWeapon(this._model.body, { dt: frameDt, time: this._machineTime,
      minigun: minigun || { spin: firing ? 1 : 0, heat: 0 },
      flameActive: this._weaponId === 'flamethrower' && !!firing });
    // Melee (T.melee): the swing clock drives an overhead chop about the fist, not a
    // recoil shove, and the assembled flash stub stays dark — a pick neither flashes nor kicks.
    if (this._weaponId === 'glaive') this._animateGlaive(frameDt, !!firing, glaive);
    const melee = this._model.T.melee === true;
    const continuous = this._model.T.continuous === true;
    const weight = WEAPONS[this._weaponId]?.weightKg || 3.4;
    // Heavier guns kick their carrier harder and settle slower, as in first person.
    const kickScale = Math.max(0.7, Math.min(1.5, Math.pow(weight / 3.4, 0.35)));
    const blend = 1 - Math.exp(-frameDt * (firing ? 28 : 16 / Math.sqrt(kickScale)));
    this._recoil += ((firing && !melee ? continuous ? 0.12 : 1 : 0) - this._recoil) * blend;
    this._flash = melee || continuous ? 0 : (firing ? 1 : Math.max(0, this._flash - frameDt / 0.065));
    const chop = melee ? pickaxeChopPitch(this.meleeSwing) : 0;
    const adsTime = Math.max(0.05, WEAPONS[this._weaponId]?.adsTime || 0.16);
    const adsBlend = 1 - Math.exp(-frameDt * 3 / adsTime);
    this._ads += (((ads && !reloading) ? 1 : 0) - this._ads) * adsBlend;
    const reloadBlend = 1 - Math.exp(-frameDt * 9);
    this._reload += ((reloading ? 1 : 0) - this._reload) * reloadBlend;
    this._reloadT = reloading ? this._reloadT + frameDt : 0;
    if (this._deployT > 0) this._deployT = Math.max(0, this._deployT - frameDt);
    const deploy = this._deployDur > 0 ? this._deployT / this._deployDur : 0;
    // Draw raise lives on the model root, so the mount/sight contract stays intact
    // and an aimed weapon is never held below its sight line.
    const raise = chop ? 0 : deploy * deploy * (1 - this._ads);
    const reloadPulse = Math.sin(Math.PI * ((this._reloadT / 0.9) % 1));
    const crouch = clamp01(crouchT) * (1 - prone);
    const aimPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Number(pitch) || 0));
    const hip = this._profile.hip;
    const aimed = this._profile.ads;
    const recoil = melee ? 0 : this._recoil * kickScale;
    // Swimming carries the gun low and canted at the hip; aiming lifts it back
    // to the sight line, so the arm zones keep covering the settled mount.
    const carry = clamp01(swim) * (1 - this._ads) * (1 - prone);
    this.root.position.set(
      THREE.MathUtils.lerp(hip.x, aimed.x, this._ads) - this._reload * 0.02 + swimSway * SWIM.sway * carry,
      THREE.MathUtils.lerp(hip.y, aimed.y, this._ads) - crouch * 0.29 - prone * 1.14 +
        Math.abs(swing) * stride * 0.012 - this._reload * 0.07 - SWIM.weaponDip * carry,
      THREE.MathUtils.lerp(hip.z, aimed.z, this._ads) + recoil * 0.035 + this._reload * 0.03,
    );
    this.root.rotation.set(
      aimPitch * (1 - this._reload * 0.6) + recoil * 0.045 - this._reload * 0.42 -
        SWIM.weaponPitch * carry,
      this._reload * 0.18,
      -swing * stride * 0.025 * (1 - this._ads * 0.72) + this._reload * 0.28 +
        (SWIM.weaponRoll + swimSway * 0.04) * carry,
    );
    if (chop) {
      // Rx(chop) premultiplies the mount rotation; shift the mount so the fist
      // (HANDS.knife.grip) stays put and the solved arms follow the chop exactly.
      const g = this._chopGrip.copy(this._profile.hands.grip).multiplyScalar(MODEL_SCALE)
        .applyEuler(this.root.rotation);
      this.root.position.add(g);
      this.root.position.sub(g.applyAxisAngle(X_AXIS, chop));
      this.root.rotation.x += chop;
    }
    this._model.root.position.y = -raise * 0.14;
    this._model.root.rotation.x = -raise * 0.5;
    this._model.bolt.position.z = continuous || this._weaponId === 'minigun' ? 0 : recoil * this._model.T.boltTravel * 0.55;
    this._model.triggerGroup.rotation.x = recoil * 0.18;
    if (this._model.mag) {
      this._model.mag.position.y = -0.05 * reloadPulse * this._reload;
      this._model.mag.rotation.x = 0.3 * reloadPulse * this._reload;
    }
    // Belt-fed receivers show their feed cover thrown open for the whole swap.
    const cover = this._model.extra?.userData.reloadPart;
    if (cover) cover.rotation[cover.userData.reloadAxis || 'x'] = -1.0 * this._reload;
    this._model.flash.grp.visible = this._flash > 0;
    for (const material of this._model.flash.mats) material.opacity = this._flash;
    this._model.flash.light.intensity = this._flash * 1.4;
    // A remote capacitor charge lights the coils exactly like the first-person rig.
    const charge01 = Math.max(0, Math.min(1, Number(charge) || 0));
    const glow = this._model.uni.uGlow;
    glow.value = Math.max(charge01, glow.value * Math.exp(-frameDt / 0.05), this._flash);
  }

  /**
   * Third-person RIPTIDE: the same horn flare/clamp as first person. `glaive` may carry
   * authoritative `{discs, magSize, caught}`; otherwise the roster forwards the owner's
   * `projectileExplode` (glaiveEnded) and restored `glaiveStock` (glaiveRestored) events.
   * A throw no event resolves is only written back after a lost-event guard.
   */
  _animateGlaive(dt, firing, glaive) {
    const presentation = glaivePresentationFor(this._model);
    this._glaiveOut ||= [];
    this._glaiveClock = (this._glaiveClock || 0) + dt;
    if (firing && !this._glaiveFiring && presentation.discs > 0) {
      presentation.throw();
      this._glaiveOut.push(this._glaiveClock);
    }
    this._glaiveFiring = firing;
    if (glaive && Number.isFinite(glaive.discs)) {
      if (glaive.caught) presentation.caught();
      presentation.setDiscs(glaive.discs, glaive.magSize, glaive.fab01);
      this._glaiveOut.length = 0;
    } else if (this._glaiveOut.length && this._glaiveClock - this._glaiveOut[0] >= GLAIVE_LOST_EVENT_S) {
      this._glaiveOut.shift();
      presentation.setDiscs(presentation.discs + 1);
    }
    presentation.update(dt);
  }

  /** Authoritative end of one of this avatar's discs: a catch clamps; embed/fizzle/loss do not. */
  glaiveEnded(caught) {
    if (this._weaponId !== 'glaive' || !this._model) return;
    const presentation = glaivePresentationFor(this._model);
    this._glaiveOut?.shift();
    if (!caught) return;
    presentation.caught();
    presentation.setDiscs(presentation.discs + 1);
  }

  /** An embedded or fizzled disc came back (pickup or fabrication): the cassette lift. */
  glaiveRestored() {
    if (this._weaponId !== 'glaive' || !this._model) return;
    const presentation = glaivePresentationFor(this._model);
    presentation.setDiscs(presentation.discs + 1);
  }

  resetPose() {
    if (this._model && this._weaponId === 'glaive') glaivePresentationFor(this._model).reset();
    this._glaiveOut = [];
    this._glaiveFiring = false;
    this._recoil = 0;
    this._flash = 0;
    this._ads = 0;
    this._reload = 0;
    this._reloadT = 0;
    this._deployT = 0;
    this._deployDur = 0;
    this.root.position.copy(this._profile?.hip || BASE_POSITION);
    this.root.rotation.set(0, 0, 0);
    if (this._model) {
      this._model.root.position.set(0, 0, 0);
      this._model.root.rotation.set(0, 0, 0);
      this._model.bolt.position.set(0, 0, 0);
      this._model.bolt.rotation.set(0, 0, 0);
      this._model.triggerGroup.rotation.set(0, 0, 0);
      if (this._model.mag) {
        this._model.mag.position.set(0, 0, 0);
        this._model.mag.rotation.set(0, 0, 0);
      }
      this._model.flash.grp.visible = false;
      for (const material of this._model.flash.mats) material.opacity = 0;
      this._model.flash.light.intensity = 0;
    }
  }

  stopDeathEffects() {
    this._flash = 0;
    if (!this._model) return;
    this._model.flash.grp.visible = false;
    this._model.flash.light.intensity = 0;
    for (const material of this._model.flash.mats) material.opacity = 0;
    this._model.uni.uGlow.value = 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._disposeModel();
    this.root.removeFromParent();
    this.root.clear();
  }

  _disposeModel() {
    if (this._model) disposeGunModels([this._model], this._cache);
    this._model = null;
    this._cache = null;
    this._weaponId = null;
    this._profile = null;
  }
}
