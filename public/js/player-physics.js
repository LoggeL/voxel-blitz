// Client-side predicted player movement. Mirrors the server constants
// (see BUILD-CONTRACT) so prediction tracks authority closely.
import { PRONE, stepProne, stanceEye } from '../../shared/player-stance.js';
import { EYE_HEIGHT } from '../../shared/combatmath.js';
import { PHYSICS, MOVEMENT_RULES, boxCollides, slidePlayerAxis, solidBelow, canStartVault, findVault, stepVault } from '../../shared/player-movement.js';
import { getBlock, ladderContact } from '../../shared/worlddata.js';

const { walk: WALK, sprint: SPRINT, crouch: CROUCH, jump: JUMP_VEL,
  accelGround: GROUND_ACCEL, accelAir: AIR_ACCEL, gravity: GRAVITY } = PHYSICS;
const { coyoteS: COYOTE_S, terminalVy: TERMINAL_VY, ladderUp: LADDER_UP_SPEED } = MOVEMENT_RULES;
const LADDER_DOWN_SPEED = -MOVEMENT_RULES.ladderDown;

export class PlayerPhysics {
  constructor(mapMeta = null) {
    this.pos = { x: 64.5, y: 30, z: 48.5 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.grounded = false;
    this.vault = null;
    this.lastImpulseSeq = 0;
    this.jumpGroundY = null;
    this.coyote = 0;
    this._crouching = false;
    this.proneT = 0;
    this.wantProne = false;
    this.mapMeta = null;
    this._solidAt = (x, y, z) => this.solid(x, y, z);
    this.setMapMeta(mapMeta);
  }

  setMapMeta(mapMeta = null) {
    this.mapMeta = mapMeta && typeof mapMeta === 'object' ? mapMeta : null;
    return this;
  }

  solid(x, y, z) { return getBlock(x, y, z) !== 0; }

  boxBlocked(x, y, z) {
    return boxCollides(this._solidAt, x, y, z);
  }

  solidBelow(x, y, z) {
    return solidBelow(this._solidAt, x, y, z);
  }

  moveAxis(axis, amount) {
    const collided = slidePlayerAxis(this.pos, axis, amount, this._solidAt);
    if (collided) this.vel[axis] = 0;
    return collided;
  }

  /**
   * Integrates one prediction step and returns true only for an accepted
   * ground jump. climbAxis is +1 for forward and -1 for back.
   */
  step(dt, wish, speedTarget, wantJump, climbAxis = 0) {
    const onLadderNow = ladderContact(this.mapMeta, this.pos.x, this.pos.y, this.pos.z);
    this.proneT = stepProne(this.proneT, this.wantProne && !this.vault && !onLadderNow, dt);
    const low = this.wantProne || this.proneT > 0;
    if (low) { speedTarget = Math.min(speedTarget, PRONE.speed); wantJump = false; }
    if (this.coyote > 0) this.coyote = Math.max(0, this.coyote - dt);

    if (this.grounded) this.jumpGroundY = this.pos.y;
    if (!this.vault && canStartVault(this.grounded, wantJump, climbAxis,
        this._crouching || low, this.pos.y, this.jumpGroundY)) {
      this.vault = findVault(this._solidAt, this.pos, wish, this.jumpGroundY);
    }
    if (this.vault) {
      const active = stepVault(this.pos, this.vault, dt, this._solidAt);
      this.vel.x = this.vel.y = this.vel.z = 0;
      this.grounded = !active && this.solidBelow(this.pos.x, this.pos.y, this.pos.z);
      this.coyote = 0;
      if (!active) this.vault = null;
      return false;
    }
    const onLadder = !low && onLadderNow;
    let ladderVy = 0;
    if (onLadder && (wantJump || climbAxis > 0)) ladderVy = LADDER_UP_SPEED;
    else if (onLadder && (this._crouching || climbAxis < 0)) ladderVy = LADDER_DOWN_SPEED;

    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const blend = 1 - Math.exp(-accel * dt);
    this.vel.x += (wish.x * speedTarget - this.vel.x) * blend;
    this.vel.z += (wish.z * speedTarget - this.vel.z) * blend;
    let jumpAccepted = false;

    if (!onLadder && wantJump && (this.grounded || this.coyote > 0) && this.vel.y <= 0.01) {
      this.vel.y = JUMP_VEL;
      this.grounded = false;
      this.coyote = 0;
      jumpAccepted = true;
    }
    if (ladderVy !== 0) this.vel.y = ladderVy;
    else this.vel.y = Math.max(TERMINAL_VY, this.vel.y - GRAVITY * dt);

    this.moveAxis('x', this.vel.x * dt);
    this.moveAxis('z', this.vel.z * dt);
    const descending = this.vel.y < 0;
    let hitY = false;
    if (ladderVy > 0) {
      this.pos.y += this.vel.y * dt;
      if (!ladderContact(this.mapMeta, this.pos.x, this.pos.y, this.pos.z)) this.vel.y = 0;
    } else if (ladderVy < 0) {
      const targetY = this.pos.y + this.vel.y * dt;
      if (ladderContact(this.mapMeta, this.pos.x, targetY, this.pos.z)) {
        this.pos.y = targetY;
      } else {
        hitY = this.moveAxis('y', this.vel.y * dt);
      }
    } else {
      hitY = this.moveAxis('y', this.vel.y * dt);
    }

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

  adoptImpulse(impulse) {
    if (!Number.isSafeInteger(impulse?.seq) || impulse.seq <= this.lastImpulseSeq
        || !Array.isArray(impulse.velocity) || impulse.velocity.length !== 3
        || !impulse.velocity.every(Number.isFinite)) return false;
    this.lastImpulseSeq = impulse.seq;
    [this.vel.x, this.vel.y, this.vel.z] = impulse.velocity;
    this.vault = null;
    this.jumpGroundY = null;
    this.grounded = false;
    this.coyote = 0;
    return true;
  }

  eyeY() {
    return this.pos.y + stanceEye(EYE_HEIGHT, this._crouching, this.proneT);
  }
}

export function moveSpeedFor(keys, ads = false) {
  if (keys.crouch) return CROUCH;
  if (!ads && keys.sprint && keys.forward && !keys.back) return SPRINT;
  return WALK;
}
