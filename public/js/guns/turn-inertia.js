const REFERENCE_WEIGHT_KG = 3.4;
const MIN_WEIGHT_KG = 1.2;
const MAX_WEIGHT_KG = 8.5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shortestAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Mass-derived follower profile. Everything scales off sqrt(mass ratio) so a gun twice
 * as heavy is ~1.4x lazier, not 2x: heavier weapons swing slower, accelerate slower,
 * and are allowed to fall further behind the eye before the clamp catches them.
 *
 * `ads01` tightens the follower toward the sight line: at full ADS the spring is ~3x
 * stiffer, the lag budget shrinks to a quarter, and the translation coupling fades so
 * the iron sights stay usable while turning.
 */
function profileForWeight(weightKg, ads01 = 0) {
  const weight = clamp(Number(weightKg) || REFERENCE_WEIGHT_KG, MIN_WEIGHT_KG, MAX_WEIGHT_KG);
  const ads = clamp(Number(ads01) || 0, 0, 1);
  const massScale = Math.sqrt(weight / REFERENCE_WEIGHT_KG);
  const tighten = 1 + ads * 2.2;
  const budget = 1 - ads * 0.75;
  return {
    weightKg: weight,
    massScale,
    maxSpeed: clamp(4.6 / massScale, 2.6, 7.5) * tighten,
    maxAcceleration: clamp(21 / massScale, 11, 34) * tighten,
    frequency: clamp(11 / (0.6 + massScale * 0.4), 7, 14) * Math.sqrt(tighten),
    dampingRatio: 0.74 + ads * 0.16,
    yawLimit: clamp(0.10 + weight * 0.016, 0.11, 0.26) * budget,
    // Translation coupling in meters per radian of lag (the gun swings out on its sling).
    swingX: (0.22 + weight * 0.012) * (1 - ads * 0.6),
    swingY: (0.12 + weight * 0.008) * (1 - ads * 0.6),
    // Roll from angular velocity: the receiver cants into a fast swing (rad per rad/s).
    rollPerYawRate: 0.011 * massScale * (1 - ads * 0.7),
    rollLimit: 0.075 * (1 - ads * 0.7),
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
      roll: 0,
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

  update(dt, { yaw = 0, pitch = 0, weightKg = REFERENCE_WEIGHT_KG, ads = 0 } = {}) {
    const safeYaw = Number.isFinite(yaw) ? yaw : this._sourceYaw;
    const safePitch = Number.isFinite(pitch) ? pitch : this._targetPitch;
    const profile = profileForWeight(weightKg, ads);
    if (!this._initialized) this.reset(safeYaw, safePitch);

    // Unwrap camera yaw so crossing ±PI never becomes a full weapon revolution.
    const yawDelta = shortestAngle(safeYaw - this._sourceYaw);
    const pitchDelta = safePitch - this._targetPitch;
    this._targetYaw += yawDelta;
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

      // The lag budget is a physical stop: once the gun is pinned there it is being
      // dragged by the eye at the eye's own rate (still capped by weight), and the excess
      // is folded into the pose rather than kept as hidden error that unwinds seconds later.
      const yawLag = this._weaponYaw - this._targetYaw;
      if (Math.abs(yawLag) > profile.yawLimit) {
        this._weaponYaw = this._targetYaw + Math.sign(yawLag) * profile.yawLimit;
        this._yawVelocity = this._dragVelocity(this._yawVelocity, yawDelta / frameDt, profile);
      }
      const pitchLimit = profile.yawLimit * 0.72;
      const pitchLag = this._weaponPitch - this._targetPitch;
      if (Math.abs(pitchLag) > pitchLimit) {
        this._weaponPitch = this._targetPitch + Math.sign(pitchLag) * pitchLimit;
        this._pitchVelocity = this._dragVelocity(this._pitchVelocity, pitchDelta / frameDt, profile);
      }
      const speed = Math.hypot(this._yawVelocity, this._pitchVelocity);
      if (speed > profile.maxSpeed) {
        const scale = profile.maxSpeed / speed;
        this._yawVelocity *= scale;
        this._pitchVelocity *= scale;
      }
    }

    this._writeReadModel(profile);
    return this._readModel;
  }

  /** Velocity of a pinned axis: whichever is faster in the drag direction, eye or spring. */
  _dragVelocity(current, eyeRate, profile) {
    const drag = clamp(eyeRate, -profile.maxSpeed, profile.maxSpeed);
    if (drag === 0) return current;
    return Math.sign(drag) === Math.sign(current)
      ? Math.sign(drag) * Math.max(Math.abs(drag), Math.abs(current))
      : drag;
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
    out.roll = clamp(
      -this._yawVelocity * profile.rollPerYawRate,
      -profile.rollLimit,
      profile.rollLimit,
    );
    out.x = -yaw * profile.swingX;
    out.y = pitch * profile.swingY;
    out.yawVelocity = this._yawVelocity;
    out.pitchVelocity = this._pitchVelocity;
    out.speed = Math.hypot(this._yawVelocity, this._pitchVelocity);
    out.maxSpeed = profile.maxSpeed;
    out.maxAcceleration = profile.maxAcceleration;
    out.weightKg = profile.weightKg;
  }
}
