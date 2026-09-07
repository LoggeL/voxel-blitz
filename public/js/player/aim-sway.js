import { clamp01 } from '../util/math.js';

const BASE_BREATH_SECONDS = 2.4;
const MIN_BREATH_SECONDS = 0.7;
const RELEASE_RECOVERY_SECONDS = 0.35;

/**
 * Owns deterministic idle aim motion and the complete hold-breath lifecycle.
 * Callers advance it once per player frame and consume the returned read model.
 */
export class AimSway {
  constructor() {
    this._time = 0;
    this._heldFor = 0;
    this._releasedFor = RELEASE_RECOVERY_SECONDS;
    this._spent = false;
    this._idleWeight = 0;
    this._rigMotionScale = 1;
    this._readModel = {
      yaw: 0,
      pitch: 0,
      holdingBreath: false,
      breathRemaining01: 1,
      rigMotionScale: 1,
    };
  }

  get readModel() { return this._readModel; }

  reset() {
    this._time = 0;
    this._heldFor = 0;
    this._releasedFor = RELEASE_RECOVERY_SECONDS;
    this._spent = false;
    this._idleWeight = 0;
    this._rigMotionScale = 1;
    Object.assign(this._readModel, {
      yaw: 0,
      pitch: 0,
      holdingBreath: false,
      breathRemaining01: 1,
      rigMotionScale: 1,
    });
    return this._readModel;
  }

  update(dt, {
    alive = true,
    grounded = true,
    stationary = false,
    shift = false,
    crouching = false,
    panic = 0,
    pain = 0,
    ads = 0,
    zoom = 1,
  } = {}) {
    const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
    // Magnified optics make the same wander visible: sway grows with the zoom you
    // are looking through, which is exactly what breath hold exists to cancel.
    const ads01 = clamp01(ads);
    const magnification = Number.isFinite(zoom) && zoom > 1 ? zoom : 1;
    const opticScale = 1 + ads01 * (magnification - 1) * 0.35;
    this._time += step;
    const panic01 = clamp01(panic);
    const pain01 = clamp01(pain);
    const eligible = !!(alive && grounded && stationary);
    const maxBreath = Math.max(
      MIN_BREATH_SECONDS,
      BASE_BREATH_SECONDS - panic01 * 1.05 - pain01 * 0.8,
    );

    if (eligible && shift) {
      this._releasedFor = 0;
      if (!this._spent) {
        this._heldFor += step;
        if (this._heldFor >= maxBreath) this._spent = true;
      }
    } else {
      this._heldFor = 0;
      this._releasedFor += step;
      if (this._releasedFor >= RELEASE_RECOVERY_SECONDS) this._spent = false;
    }

    const holdingBreath = eligible && shift && !this._spent;
    const breathRemaining01 = holdingBreath
      ? clamp01(1 - this._heldFor / maxBreath)
      : (this._spent ? 0 : 1);
    const conditionScale = 1 + panic01 * 1.35 + pain01 * 1.65;
    const crouchScale = crouching ? 0.55 : 1;
    const breathScale = holdingBreath ? 0.12 : 1;
    this._idleWeight += ((eligible ? 1 : 0) - this._idleWeight) * Math.min(1, step * 7);
    const targetRigScale = eligible ? crouchScale * breathScale : 1;
    this._rigMotionScale += (targetRigScale - this._rigMotionScale) * Math.min(1, step * 9);
    const idleScale = conditionScale * this._rigMotionScale * this._idleWeight * opticScale;

    // Two incommensurate waves avoid a mechanical circular orbit while staying
    // deterministic and allocation-free.
    const yaw = (
      Math.sin(this._time * 1.19) * 0.00125 +
      Math.sin(this._time * 0.47 + 1.7) * 0.00055
    ) * idleScale;
    const pitch = (
      Math.sin(this._time * 1.43 + 0.8) * 0.00155 +
      Math.sin(this._time * 0.61 + 2.4) * 0.00065
    ) * idleScale;

    Object.assign(this._readModel, {
      yaw,
      pitch,
      holdingBreath,
      breathRemaining01,
      rigMotionScale: this._rigMotionScale,
    });
    return this._readModel;
  }
}
