import * as THREE from '../vendor/three.module.js';
import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { buildGun, disposeGunModels } from '../guns/assemble.js';
import { HANDS } from '../guns/defs.js';
import { MaterialCache } from '../guns/kit.js';

const BASE_POSITION = new THREE.Vector3(0.15, 1.30, -0.21);
const MAX_PITCH = Math.PI * 0.43;

function weaponId(value) {
  if (typeof value === 'string' && WEAPON_IDS.includes(value)) return value;
  return WEAPON_IDS[Math.max(0, Math.min(WEAPON_IDS.length - 1,
    Number.isInteger(value) ? value : 0))];
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
    this._disposed = false;
  }

  get id() { return this._weaponId; }
  get modelRoot() { return this._model?.root || null; }
  get twoHanded() { return !!HANDS[this._weaponId]?.support; }

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
    this._model.root.scale.setScalar(1.10);
    this._model.flash.grp.scale.setScalar(0.58);
    for (const object of this._model.flash.grp.children) {
      if (object.isMesh) object.scale.set(1, 0.22, 1);
    }
    this.root.add(this._model.root);
    this.resetPose();
    return true;
  }

  update({ weapon, pitch = 0, firing = false, stride = 0, swing = 0, dt = 0 } = {}) {
    this.setWeapon(weapon);
    if (!this._model) return;
    const blend = 1 - Math.exp(-Math.max(0, dt) * (firing ? 28 : 16));
    this._recoil += ((firing ? 1 : 0) - this._recoil) * blend;
    this._flash = firing ? 1 : Math.max(0, this._flash - Math.max(0, dt) / 0.065);
    const aimPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Number(pitch) || 0));
    this.root.position.set(
      BASE_POSITION.x,
      BASE_POSITION.y + Math.abs(swing) * stride * 0.012,
      BASE_POSITION.z + this._recoil * 0.035,
    );
    this.root.rotation.set(
      aimPitch + this._recoil * 0.045,
      0,
      -swing * stride * 0.025,
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
    this.root.position.copy(BASE_POSITION);
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
      BASE_POSITION.x + side * amount * 0.16,
      BASE_POSITION.y - amount * 0.62,
      BASE_POSITION.z + amount * 0.08,
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
  }
}
