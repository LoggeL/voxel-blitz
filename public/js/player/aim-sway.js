import { clamp01 } from '../util/math.js';

import { BreathHold, steadyEligible } from '../../../shared/conditions.js';
import { sampleWeaponSway, WEAPON_HANDLING_PROFILES } from '../../../shared/weapon-handling.js';

/**
 * Owns deterministic idle aim motion and the complete hold-breath lifecycle.
 * Callers advance it once per player frame and consume the returned read model.
 */
export class AimSway {
  constructor() {
    this._time = 0;
    this._wave = { yaw: 0, pitch: 0 };
    this.breath = new BreathHold();
    this._idleWeight = 0;
    this._rigMotionScale = 1;
    this._readModel = {
      yaw: 0,
      pitch: 0,
      holdingBreath: false,
      breathEvent: null,
      breathExhausted: false,
      canHoldBreath: false,
      breathRemaining01: 1,
      rigMotionScale: 1,
    };
  }

  get readModel() { return this._readModel; }

  reset() {
    this._time = 0;
    this.breath.reset();
    this._idleWeight = 0;
    this._rigMotionScale = 1;
    Object.assign(this._readModel, {
      yaw: 0,
      pitch: 0,
      holdingBreath: false,
      breathEvent: null,
      breathExhausted: false,
      canHoldBreath: false,
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
    handling = WEAPON_HANDLING_PROFILES.rifle,
    handlingAllowed = true,
  } = {}) {
    const step = Math.max(0, Math.min(1, Number(dt) || 0));
    // Sway is a world angle. The camera FOV already magnifies its visible motion.
    const ads01 = clamp01(ads);
    this._time += step;
    const panic01 = clamp01(panic);
    const pain01 = clamp01(pain);
    const eligible = !!(alive && grounded && stationary);
    const breath = this.breath.update(dt, {
      eligible: steadyEligible({ alive, grounded, stationary, handlingAllowed, ads: ads01 }),
      pressed: shift, panic: panic01, pain: pain01,
    });
    const { holdingBreath } = breath;
    const conditionSway = alive ? panic01 * 1.65 : 0;
    const crouchScale = crouching ? 0.55 : 1;
    const breathScale = holdingBreath ? 0.12 : 1;
    this._idleWeight += ((eligible ? 1 : 0) - this._idleWeight) * (1 - Math.exp(-step * 7));
    const targetRigScale = eligible ? crouchScale * breathScale : 1;
    this._rigMotionScale += (targetRigScale - this._rigMotionScale) * (1 - Math.exp(-step * 9));
    // Panic affects the real shot direction even while moving. Ordinary idle
    // sway and pain retain their stationary behavior; crouch/steady still help.
    const idleScale = ((1 + pain01 * 0.25) * this._idleWeight + conditionSway) * this._rigMotionScale;

    // Two incommensurate waves avoid a mechanical circular orbit while staying
    // deterministic and allocation-free.
    const wave = sampleWeaponSway(handling?.sway, this._time, this._wave);
    const yaw = wave.yaw * idleScale;
    const pitch = wave.pitch * idleScale;

    Object.assign(this._readModel, {
      yaw,
      pitch,
      ...breath,
      rigMotionScale: this._rigMotionScale,
    });
    return this._readModel;
  }
}
