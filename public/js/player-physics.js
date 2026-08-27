// Client-side predicted player movement. Mirrors the server constants
// (see BUILD-CONTRACT) so prediction tracks authority closely.
import { EYE_HEIGHT, GRAVITY, PLAYER_HALF } from '../../shared/combatmath.js';
import { getBlock } from '../../shared/worlddata.js';

const WALK = 4.4, SPRINT = 6.2, CROUCH = 2.2;
const JUMP_VEL = 8.2;
const GROUND_ACCEL = 10;
const AIR_ACCEL = 3;
const COYOTE_S = 0.08;
const TERMINAL_VY = -60;
const PLAYER_HEIGHT = PLAYER_HALF.h * 2;
const EPS = 1e-3;
const SHRINK = 1e-4;
const MAX_STEP = 0.45;

export class PlayerPhysics {
  constructor() {
    this.pos = { x: 64.5, y: 30, z: 48.5 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.grounded = false;
    this.coyote = 0;
    this._crouching = false;
  }

  solid(x, y, z) { return getBlock(x, y, z) !== 0; }

  boxBlocked(x, y, z) {
    const x0 = Math.floor(x - PLAYER_HALF.x + SHRINK);
    const x1 = Math.floor(x + PLAYER_HALF.x - SHRINK);
    const y0 = Math.floor(y + SHRINK);
    const y1 = Math.floor(y + PLAYER_HEIGHT - SHRINK);
    const z0 = Math.floor(z - PLAYER_HALF.x + SHRINK);
    const z1 = Math.floor(z + PLAYER_HALF.x - SHRINK);
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (let bx = x0; bx <= x1; bx++) {
          if (this.solid(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  solidBelow(x, y, z) {
    const yy = y - 0.06;
    if (Math.floor(yy) < 0) return true;
    const xs = [x - PLAYER_HALF.x + SHRINK, x + PLAYER_HALF.x - SHRINK];
    const zs = [z - PLAYER_HALF.x + SHRINK, z + PLAYER_HALF.x - SHRINK];
    const by = Math.floor(yy);
    for (const bx of xs) {
      for (const bz of zs) {
        if (this.solid(Math.floor(bx), by, Math.floor(bz))) return true;
      }
    }
    return false;
  }

  moveAxis(axis, amount) {
    if (amount === 0) return false;
    const p = this.pos;
    const sign = amount < 0 ? -1 : 1;
    let collided = false;
    let remaining = Math.abs(amount);
    while (remaining > 1e-9 && !collided) {
      const delta = Math.min(MAX_STEP, remaining) * sign;
      remaining -= Math.abs(delta);
      const before = p[axis];
      p[axis] = before + delta;
      if (!this.boxBlocked(p.x, p.y, p.z)) continue;

      collided = true;
      if (axis === 'x') {
        const wall = sign > 0
          ? Math.floor(p.x + PLAYER_HALF.x)
          : Math.floor(p.x - PLAYER_HALF.x);
        p.x = sign > 0
          ? wall - PLAYER_HALF.x - EPS
          : wall + 1 + PLAYER_HALF.x + EPS;
      } else if (axis === 'z') {
        const wall = sign > 0
          ? Math.floor(p.z + PLAYER_HALF.x)
          : Math.floor(p.z - PLAYER_HALF.x);
        p.z = sign > 0
          ? wall - PLAYER_HALF.x - EPS
          : wall + 1 + PLAYER_HALF.x + EPS;
      } else {
        const cell = Math.floor(sign > 0 ? p.y + PLAYER_HEIGHT : p.y);
        p.y = sign > 0 ? cell - PLAYER_HEIGHT - EPS : cell + 1;
      }

      if (this.boxBlocked(p.x, p.y, p.z)) p[axis] = before;
      this.vel[axis] = 0;
    }
    return collided;
  }

  /** Integrates one prediction step and returns true only for an accepted jump. */
  step(dt, wish, speedTarget, wantJump) {
    if (this.coyote > 0) this.coyote = Math.max(0, this.coyote - dt);

    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const blend = 1 - Math.exp(-accel * dt);
    this.vel.x += (wish.x * speedTarget - this.vel.x) * blend;
    this.vel.z += (wish.z * speedTarget - this.vel.z) * blend;
    let jumpAccepted = false;

    if (wantJump && (this.grounded || this.coyote > 0) && this.vel.y <= 0.01) {
      this.vel.y = JUMP_VEL;
      this.grounded = false;
      this.coyote = 0;
      jumpAccepted = true;
    }
    this.vel.y = Math.max(TERMINAL_VY, this.vel.y - GRAVITY * dt);

    this.moveAxis('x', this.vel.x * dt);
    this.moveAxis('z', this.vel.z * dt);
    const descending = this.vel.y < 0;
    const hitY = this.moveAxis('y', this.vel.y * dt);

    if (hitY && descending) {
      this.grounded = true;
    } else if (this.vel.y <= 0.001 && this.solidBelow(this.pos.x, this.pos.y, this.pos.z)) {
      this.grounded = true;
      this.vel.y = 0;
    } else {
      if (this.grounded) this.coyote = COYOTE_S;
      this.grounded = false;
    }

    if (Math.abs(this.vel.x) < 0.001) this.vel.x = 0;
    if (Math.abs(this.vel.z) < 0.001) this.vel.z = 0;
    return jumpAccepted;
  }

  eyeY() {
    return this.pos.y + EYE_HEIGHT * (this._crouching ? 0.58 : 1);
  }
}

export function moveSpeedFor(keys, ads = false) {
  if (keys.crouch) return CROUCH;
  if (!ads && keys.sprint && keys.forward && !keys.back) return SPRINT;
  return WALK;
}
