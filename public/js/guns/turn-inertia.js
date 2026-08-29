const REFERENCE_WEIGHT_KG = 3.4;
const MIN_WEIGHT_KG = 1.2;
const MAX_WEIGHT_KG = 8.5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shortestAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function profileForWeight(weightKg) {
  const weight = clamp(Number(weightKg) || REFERENCE_WEIGHT_KG, MIN_WEIGHT_KG, MAX_WEIGHT_KG);
  const massScale = Math.sqrt(weight / REFERENCE_WEIGHT_KG);
  return {
    weightKg: weight,
    maxSpeed: clamp(7 / massScale, 4.2, 11),
    maxAcceleration: clamp(28 / massScale, 17, 46),
    frequency: clamp(18 / (0.65 + massScale * 0.35), 12, 22),
    dampingRatio: 0.84,
    yawLimit: clamp(0.07 + weight * 0.012, 0.08, 0.175),
  };
}

/**
 * Weight-limited angular follower for the first-person weapon only.
 *
 * The camera supplies an absolute target orientation. This module owns a separate
 * weapon orientation, accelerates it toward that target, caps its angular speed,
 * and returns the small camera-local transform consumed by the viewmodel rig.
 */
export class WeaponTurnInertia {
  constructor() {
    this._initialized = false;
    this._sourceYaw = 0;
    this._targetYaw = 0;
    this._targetPitch = 0;
    this._weaponYaw = 0;
    this._weaponPitch = 0;
    this._yawVelocity = 0;
    this._pitchVelocity = 0;
    this._readModel = {
      yaw: 0,
      pitch: 0,
      x: 0,
      y: 0,
      yawVelocity: 0,
      pitchVelocity: 0,
      speed: 0,
      maxSpeed: 0,
      maxAcceleration: 0,
      weightKg: REFERENCE_WEIGHT_KG,
    };
  }

  get readModel() { return this._readModel; }

  reset(yaw = 0, pitch = 0) {
    const safeYaw = Number.isFinite(yaw) ? yaw : 0;
    const safePitch = Number.isFinite(pitch) ? pitch : 0;
    this._initialized = true;
    this._sourceYaw = safeYaw;
    this._targetYaw = safeYaw;
    this._targetPitch = safePitch;
    this._weaponYaw = safeYaw;
    this._weaponPitch = safePitch;
    this._yawVelocity = 0;
    this._pitchVelocity = 0;
    this._writeReadModel(profileForWeight(REFERENCE_WEIGHT_KG));
    return this._readModel;
  }

  update(dt, { yaw = 0, pitch = 0, weightKg = REFERENCE_WEIGHT_KG } = {}) {
    const safeYaw = Number.isFinite(yaw) ? yaw : this._sourceYaw;
    const safePitch = Number.isFinite(pitch) ? pitch : this._targetPitch;
    const profile = profileForWeight(weightKg);
    if (!this._initialized) this.reset(safeYaw, safePitch);

    // Unwrap camera yaw so crossing ±PI never becomes a full weapon revolution.
    this._targetYaw += shortestAngle(safeYaw - this._sourceYaw);
    this._sourceYaw = safeYaw;
    this._targetPitch = safePitch;

    const frameDt = clamp(Number(dt) || 0, 0, 0.033);
    if (frameDt > 0) {
      const steps = Math.max(1, Math.ceil(frameDt * 240));
      const h = frameDt / steps;
      const stiffness = profile.frequency * profile.frequency;
      const damping = 2 * profile.dampingRatio * profile.frequency;

      for (let step = 0; step < steps; step++) {
        let yawAcceleration =
          (this._targetYaw - this._weaponYaw) * stiffness - this._yawVelocity * damping;
        let pitchAcceleration =
          (this._targetPitch - this._weaponPitch) * stiffness - this._pitchVelocity * damping;
        const acceleration = Math.hypot(yawAcceleration, pitchAcceleration);
        if (acceleration > profile.maxAcceleration) {
          const scale = profile.maxAcceleration / acceleration;
          yawAcceleration *= scale;
          pitchAcceleration *= scale;
        }

        this._yawVelocity += yawAcceleration * h;
        this._pitchVelocity += pitchAcceleration * h;
        const speed = Math.hypot(this._yawVelocity, this._pitchVelocity);
        if (speed > profile.maxSpeed) {
          const scale = profile.maxSpeed / speed;
          this._yawVelocity *= scale;
          this._pitchVelocity *= scale;
        }

        this._weaponYaw += this._yawVelocity * h;
        this._weaponPitch += this._pitchVelocity * h;
      }
    }

    this._writeReadModel(profile);
    return this._readModel;
  }

  _writeReadModel(profile) {
    const yaw = clamp(this._weaponYaw - this._targetYaw, -profile.yawLimit, profile.yawLimit);
    const pitchLimit = profile.yawLimit * 0.72;
    const pitch = clamp(
      this._weaponPitch - this._targetPitch,
      -pitchLimit,
      pitchLimit,
    );
    const out = this._readModel;
    out.yaw = yaw;
    out.pitch = pitch;
    out.x = -yaw * 0.10;
    out.y = pitch * 0.08;
    out.yawVelocity = this._yawVelocity;
    out.pitchVelocity = this._pitchVelocity;
    out.speed = Math.hypot(this._yawVelocity, this._pitchVelocity);
    out.maxSpeed = profile.maxSpeed;
    out.maxAcceleration = profile.maxAcceleration;
    out.weightKg = profile.weightKg;
  }
}
