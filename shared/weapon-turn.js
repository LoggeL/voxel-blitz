import { weaponTurnProfile, WEAPON_HANDLING_PROFILES } from './weapon-handling.js';

const STEP = 1 / 240;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Independent world orientation. A lag clamp must never teleport the weapon to
 * the camera. Only cosmetic translation/roll are capped. Fixed simulation step. */
export class WeaponTurnInertia {
  constructor() {
    this._initialized = false;
    this._readModel = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0,
      weaponYaw: 0, weaponPitch: 0, yawVelocity: 0, pitchVelocity: 0,
      speed: 0, maxSpeed: 0, maxAcceleration: 0, weightKg: 3.4 };
  }
  get readModel() { return this._readModel; }
  reset(yaw = 0, pitch = 0) {
    this._initialized = true;
    this._weaponYaw = this._targetYaw = Number.isFinite(yaw) ? wrap(yaw) : 0;
    this._weaponPitch = this._targetPitch = Number.isFinite(pitch) ? clamp(pitch, -1.56, 1.56) : 0;
    this._yawVelocity = this._pitchVelocity = this._accumulator = 0;
    this._write(weaponTurnProfile(), 3.4, 0);
    return this._readModel;
  }
  update(dt, { yaw = 0, pitch = 0, weightKg = 3.4, ads = 0,
    handling = WEAPON_HANDLING_PROFILES.rifle } = {}) {
    if (!this._initialized) this.reset(yaw, pitch);
    this._targetYaw = Number.isFinite(yaw) ? wrap(yaw) : this._targetYaw;
    this._targetPitch = Number.isFinite(pitch) ? clamp(pitch, -1.56, 1.56) : this._targetPitch;
    const profile = weaponTurnProfile(handling, ads);
    this._accumulator += Number.isFinite(dt) ? clamp(dt, 0, 1) : 0;
    const k = profile.frequency ** 2, c = 2 * profile.frequency * profile.dampingRatio;
    while (this._accumulator + 1e-10 >= STEP) {
      this._accumulator -= STEP;
      let ay = wrap(this._targetYaw - this._weaponYaw) * k - this._yawVelocity * c;
      let ap = (this._targetPitch - this._weaponPitch) * k - this._pitchVelocity * c;
      const acceleration = Math.hypot(ay, ap);
      if (acceleration > profile.maxAcceleration) {
        const scale = profile.maxAcceleration / acceleration; ay *= scale; ap *= scale;
      }
      this._yawVelocity += ay * STEP; this._pitchVelocity += ap * STEP;
      const speed = Math.hypot(this._yawVelocity, this._pitchVelocity);
      if (speed > profile.maxSpeed) {
        const scale = profile.maxSpeed / speed;
        this._yawVelocity *= scale; this._pitchVelocity *= scale;
      }
      this._weaponYaw = wrap(this._weaponYaw + this._yawVelocity * STEP);
      this._weaponPitch += this._pitchVelocity * STEP;
      if (Math.abs(this._weaponPitch) > 1.56) {
        this._weaponPitch = clamp(this._weaponPitch, -1.56, 1.56); this._pitchVelocity = 0;
      }
    }
    this._write(profile, Number.isFinite(weightKg) ? clamp(weightKg, 0.5, 20) : 3.4, ads);
    return this._readModel;
  }
  _write(profile, weight, ads) {
    const out = this._readModel;
    out.yaw = wrap(this._weaponYaw - this._targetYaw);
    out.pitch = this._weaponPitch - this._targetPitch;
    out.weaponYaw = this._weaponYaw; out.weaponPitch = this._weaponPitch;
    out.yawVelocity = this._yawVelocity; out.pitchVelocity = this._pitchVelocity;
    out.speed = Math.hypot(this._yawVelocity, this._pitchVelocity);
    out.maxSpeed = profile.maxSpeed; out.maxAcceleration = profile.maxAcceleration;
    out.weightKg = weight;
    const aim = clamp(Number(ads) || 0, 0, 1);
    out.x = -clamp(out.yaw, -0.24, 0.24) * 0.16 * (1 - aim * 0.7);
    out.y = clamp(out.pitch, -0.18, 0.18) * 0.12 * (1 - aim * 0.7);
    out.roll = clamp(-this._yawVelocity * 0.006 * Math.sqrt(weight / 3.4), -0.065, 0.065) * (1 - aim * 0.7);
  }
}
