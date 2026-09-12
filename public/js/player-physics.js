import { reactorDefenderSolid } from '../../shared/world/reactor-layout.js';
// Client-side predicted player movement. Mirrors the server constants
// (see BUILD-CONTRACT) so prediction tracks authority closely.
import { PRONE, stanceEye, stanceHeight } from '../../shared/player-stance.js';
import { EYE_HEIGHT } from '../../shared/combatmath.js';
import { PHYSICS, MOVEMENT_RULES, slidePlayerAxis, solidBelow, stepPlayerProne, canStartVault, findVault, stepVault } from '../../shared/player-movement.js';
import { getBlock, ladderContact } from '../../shared/worlddata.js';
import { slideTerrainAxis } from '../../shared/terrain-steps.js';

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
    this.jumpWasHeld = false;
    this.coyote = 0;
    this._crouching = false;
    this.proneT = 0;
    this.wantProne = false;
    this.climbBlocked = false;
    this.mapMeta = null;
    this._solidAt = (x, y, z) => this.solid(x, y, z);
    this.setMapMeta(mapMeta);
  }

  setMapMeta(mapMeta = null) {
    this.mapMeta = mapMeta && typeof mapMeta === 'object' ? mapMeta : null;
    return this;
  }

  solid(x, y, z) { return getBlock(x, y, z) !== 0
    || (this.mapMeta?.id === 'reactor' && reactorDefenderSolid(x,y,z)); }

  solidBelow(x, y, z) {
    return solidBelow(this._solidAt, x, y, z);
  }

  moveAxis(axis, amount, canStep = false) {
    const height = stanceHeight(PHYSICS.height, this.proneT);
    const collided = canStep
      ? slideTerrainAxis(this.pos, axis, amount, this._solidAt, this.mapMeta, true, height)
      : slidePlayerAxis(this.pos, axis, amount, this._solidAt, height);
    if (collided) this.vel[axis] = 0;
    return collided;
  }

  /**
   * Integrates one prediction step and returns true only for an accepted
   * ground jump. climbAxis is +1 for forward and -1 for back.
   */
  step(dt, wish, speedTarget, wantJump, climbAxis = 0, yaw = null) {
    const jumpPressed = !!wantJump && !this.jumpWasHeld;
    this.jumpWasHeld = !!wantJump;
    const onLadderNow = ladderContact(this.mapMeta, this.pos.x, this.pos.y, this.pos.z);
    if (this.climbBlocked) this.vault = null;
    this.proneT = stepPlayerProne(this.proneT, this.wantProne && !this.vault && !onLadderNow,
      dt, this._solidAt, this.pos);
    const low = this.wantProne || this.proneT > 0;
    if (low) { speedTarget = Math.min(speedTarget, PRONE.speed); wantJump = false; }
    if (this.coyote > 0) this.coyote = Math.max(0, this.coyote - dt);

    if (this.grounded) this.jumpGroundY = this.pos.y;
    const deliberateGrab = !this.grounded && jumpPressed && !low;
    if (!this.climbBlocked && !this.vault && canStartVault(this.grounded, this.grounded ? wantJump : deliberateGrab, climbAxis,
        this._crouching || low, this.pos.y, this.jumpGroundY)) {
      this.vault = findVault(this._solidAt, this.pos, wish,
        deliberateGrab ? this.pos.y : this.jumpGroundY, yaw, deliberateGrab ? 0 : 1);
    }
    if (this.vault) {
      const active = stepVault(this.pos, this.vault, dt, this._solidAt);
      this.vel.x = this.vel.y = this.vel.z = 0;
      this.grounded = !active && this.solidBelow(this.pos.x, this.pos.y, this.pos.z);
      this.coyote = 0;
      if (!active) this.vault = null;
      return false;
    }
    const onLadder = !this.climbBlocked && !low && onLadderNow;
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

    const canStepTerrain = this.grounded && !wantJump && !this.vault && !onLadder && this.vel.y <= 0.01;
    this.moveAxis('x', this.vel.x * dt, canStepTerrain);
    this.moveAxis('z', this.vel.z * dt, canStepTerrain);
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
