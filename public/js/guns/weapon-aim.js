import { WeaponTurnInertia } from './turn-inertia.js';

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
export const SPRINT_AIM_DIP = 0.11;

/** One carried-weapon direction for prediction, the wire, the rig and the reticle.
 * Camera look remains immediate. Sprint lowers the muzzle by about six degrees;
 * ADS settles both the carry and angular lag back onto the sight line. */
export class WeaponAimMotion {
  constructor() {
    this.turn = new WeaponTurnInertia();
    this._weapon = null;
    this.readModel = { yaw: 0, pitch: 0, sprint: 0, turn: this.turn.readModel };
  }

  reset(yaw = 0, pitch = 0) {
    this.turn.reset(yaw, pitch);
    Object.assign(this.readModel, { yaw: 0, pitch: 0, sprint: 0 });
    this._weapon = null;
    return this.readModel;
  }

  update(dt, { weapon = null, yaw = 0, pitch = 0, weightKg = 3.4, ads = 0,
    sprinting = false, grounded = true, crouching = false, vaulting = false,
    enabled = true } = {}) {
    const out = this.readModel;
    if (!enabled) return this.reset(yaw, pitch);
    if (weapon !== this._weapon) {
      this.reset(yaw, pitch);
      this._weapon = weapon;
    }
    const ads01 = clamp01(ads);
    const sight = ads01 * ads01 * (3 - 2 * ads01);
    const follow = 1 - Math.exp(-12 * Math.max(0, Math.min(0.25, Number(dt) || 0)));
    const target = sprinting && grounded && !crouching && !vaulting ? 1 : 0;
    out.sprint += (target - out.sprint) * follow;
    const turn = this.turn.update(dt, { yaw, pitch, weightKg, ads: ads01 });
    out.yaw = turn.yaw * (1 - sight);
    out.pitch = (turn.pitch - SPRINT_AIM_DIP * out.sprint) * (1 - sight);
    return out;
  }
}
