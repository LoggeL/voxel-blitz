import * as THREE from '../vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import { buildGun, disposeGunModels } from '../guns/assemble.js';
import { HANDS } from '../guns/defs.js';
import { MaterialCache } from '../guns/kit.js';

const BASE_POSITION = new THREE.Vector3(0.15, 1.30, -0.21);
const MODEL_SCALE = 1.10;
const ADS_SIGHT_X = 0.055;
const ADS_SIGHT_Y = 1.62;
const ADS_DEPTH_OFFSET = -0.045;
const MAX_PITCH = Math.PI * 0.43;
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
    this._flash = 0;
    this._ads = 0;
    this._profile = null;
    this._disposed = false;
  }

  get id() { return this._weaponId; }
  get modelRoot() { return this._model?.root || null; }
  get handPose() { return this._profile?.hands || HANDS.rifle; }
  get twoHanded() { return !!this.handPose.support; }
  get adsT() { return this._ads; }

  /** World-space sight-line anchor without exposing gun assembly internals. */
  getSightWorldPosition(out = new THREE.Vector3()) {
    if (!this._model) return out.set(NaN, NaN, NaN);
    const sightHeight = Number(this._model.body?.userData?.sightHeight);
    this._model.root.updateWorldMatrix(true, false);
    return out.set(0, Number.isFinite(sightHeight) ? sightHeight : 0.12, 0)
      .applyMatrix4(this._model.root.matrixWorld);
  }

  setWeapon(value) {
    const nextId = weaponId(value);
    if (this._disposed || nextId === this._weaponId) return false;
    this._disposeModel();
    this._cache = new MaterialCache();
    this._model = buildGun(nextId, this._cache);
    this._weaponId = nextId;
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
    this.resetPose();
    return true;
  }

  update({
    weapon,
    pitch = 0,
    firing = false,
    ads = false,
    crouchT = 0,
    stride = 0,
    swing = 0,
    dt = 0,
  } = {}) {
    this.setWeapon(weapon);
    if (!this._model) return;
    const frameDt = Math.max(0, Number(dt) || 0);
    const blend = 1 - Math.exp(-frameDt * (firing ? 28 : 16));
    this._recoil += ((firing ? 1 : 0) - this._recoil) * blend;
    this._flash = firing ? 1 : Math.max(0, this._flash - frameDt / 0.065);
    const adsTime = Math.max(0.05, WEAPONS[this._weaponId]?.adsTime || 0.16);
    const adsBlend = 1 - Math.exp(-frameDt * 3 / adsTime);
    this._ads += ((ads ? 1 : 0) - this._ads) * adsBlend;
    const crouch = clamp01(crouchT);
    const aimPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Number(pitch) || 0));
    const hip = this._profile.hip;
    const aimed = this._profile.ads;
    this.root.position.set(
      THREE.MathUtils.lerp(hip.x, aimed.x, this._ads),
      THREE.MathUtils.lerp(hip.y, aimed.y, this._ads) - crouch * 0.29 +
        Math.abs(swing) * stride * 0.012,
      THREE.MathUtils.lerp(hip.z, aimed.z, this._ads) + this._recoil * 0.035,
    );
    this.root.rotation.set(
      aimPitch + this._recoil * 0.045,
      0,
      -swing * stride * 0.025 * (1 - this._ads * 0.72),
    );
    this._model.bolt.position.z = this._recoil * this._model.T.boltTravel * 0.55;
    this._model.triggerGroup.rotation.x = this._recoil * 0.18;
    this._model.flash.grp.visible = this._flash > 0;
    for (const material of this._model.flash.mats) material.opacity = this._flash;
    this._model.flash.light.intensity = this._flash * 1.4;
  }

  resetPose() {
    this._recoil = 0;
    this._flash = 0;
    this._ads = 0;
    this.root.position.copy(this._profile?.hip || BASE_POSITION);
    this.root.rotation.set(0, 0, 0);
    if (this._model) {
      this._model.bolt.position.set(0, 0, 0);
      this._model.bolt.rotation.set(0, 0, 0);
      this._model.triggerGroup.rotation.set(0, 0, 0);
      this._model.flash.grp.visible = false;
      for (const material of this._model.flash.mats) material.opacity = 0;
      this._model.flash.light.intensity = 0;
    }
  }

  setDeathPose(t, side) {
    const amount = Math.max(0, Math.min(1, Number(t) || 0));
    this.root.position.set(
      (this._profile?.hip.x ?? BASE_POSITION.x) + side * amount * 0.16,
      (this._profile?.hip.y ?? BASE_POSITION.y) - amount * 0.62,
      (this._profile?.hip.z ?? BASE_POSITION.z) + amount * 0.08,
    );
    this.root.rotation.set(amount * 0.92, side * amount * 0.38, -side * amount * 0.62);
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
