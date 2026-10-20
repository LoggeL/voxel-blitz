import { bastionDefenderSolid } from '../../shared/world/bastion-layouts.js';
// Client-side predicted player movement. Mirrors the server constants
// (see BUILD-CONTRACT) so prediction tracks authority closely.
import { PRONE, stanceEye, stanceHeight } from '../../shared/player-stance.js';
import { leanBlocked, leanEyeOffset, stepBodyLean } from '../../shared/player-lean.js';
import { EYE_HEIGHT } from '../../shared/combatmath.js';
import { PHYSICS, MOVEMENT_RULES, SWIM_RULES, fluidContact, swimVerticalVelocity, slidePlayerAxis, solidBelow, stepPlayerProne, canStartVault, findVault, findSwimExit, stepVault } from '../../shared/player-movement.js';
import { getBlock, ladderContact, isSolidBlock, FLUID_BLOCKS } from '../../shared/worlddata.js';
import { LOCAL_FLOOD } from '../../shared/world/flood-field.js';
import { slideTerrainAxis } from '../../shared/terrain-steps.js';
import { slideContact, stepSlideRide } from '../../shared/slide-rules.js';
import { slidePlayerVehicleAxis, constrainPlayerVehicleMotion } from '../../shared/player-vehicle-collision.js';
import { CHUTE, EJECTION, chuteAvailable, stepChuteState, stepChuteVelocity } from '../../shared/parachute.js';
import { createPilotState, pilotSpeedFor, pilotPreStep, pilotAccel, pilotVertical, pilotPostCollide,
  resetPilotMotion, PILOT_RULES, PILOT_STEP_S } from '../../shared/pilot-movement.js';

const { walk: WALK, sprint: SPRINT, crouch: CROUCH, jump: JUMP_VEL,
  accelGround: GROUND_ACCEL, accelAir: AIR_ACCEL, gravity: GRAVITY } = PHYSICS;
const { coyoteS: COYOTE_S, terminalVy: TERMINAL_VY, ladderUp: LADDER_UP_SPEED } = MOVEMENT_RULES;
const LADDER_DOWN_SPEED = -MOVEMENT_RULES.ladderDown;
/** After a predicted chute toggle, snapshots still carry the old state for about
 * one round trip: they are not adopted for this long (seconds of prediction). */
const CHUTE_ADOPT_HOLD_S = 0.6;
/** After a predicted grapple release, the row's anchor is not re-adopted for this long. */
const GRAPPLE_ADOPT_HOLD_S = 0.4;

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
    this.leanT = 0;
    this.wantLean = 0;   // signed Q/E request, already cleared while sprinting
    this.leanYaw = 0;
    this.climbBlocked = false;
    // Authoritative speed multiplier (pulse concussion), applied after the
    // stance and swim caps exactly as the server's stepMovement does.
    this.speedScale = 1;
    this.slide = null;
    this.mapMeta = null;
    this._solidAt = (x, y, z) => this.solid(x, y, z);
    // A running flood field (LOCAL_FLOOD, shared/world/flood-field.js) answers for the cells it covers, as on the server.
    this._fluidAt = (x, y, z) => {
      const wet = LOCAL_FLOOD.fields.length ? LOCAL_FLOOD.wetCell(x, y, z) : undefined;
      return wet ?? FLUID_BLOCKS.has(getBlock(x, y, z));
    };
    // A ladder's support column (ladderContact): plain voxels.
    this._voxelAt = (x, y, z) => isSolidBlock(getBlock(x, y, z));
    this.swimming = false;
    // Conquest parachute / ejection seat (shared/parachute.js), predicted like the authority.
    this.airRules = false;
    // Conquest weather wind under an open canopy ({x, z} m/s from match.conquest.wx), like the authority.
    this.chuteDrift = null;
    this.chute = CHUTE.none;
    this.chuteT = 0;
    this._chuteHold = 0;
    // Titanfall pilot movement (shared/pilot-movement.js), predicted like the authority;
    // false everywhere else, so stock movement is untouched. pilotInput: {sprint, crouch, ads, stim} (LocalPlayer).
    this.pilotRules = false;
    this.pilot = createPilotState();
    this.pilotInput = null;
    this._pilotBody = null;
    this._pilotCtx = null;
    this._grappleHold = 0;
    // pilotSpeedFor input of the step: pilotInput with the server's post-prone sprint gate.
    this._pilotSpeedInput = { sprint: false, crouch: false, ads: false, stim: false };
    // stepPilotFixed: the authority's fixed step, a press seen between two steps, and
    // pilotLerp (metres): the presented body trails pos by the unstepped share of the last step.
    this._pilotAcc = 0;
    this._pilotJumpLatch = false;
    this._pilotStepDelta = { x: 0, y: 0, z: 0 };
    this.pilotLerp = { x: 0, y: 0, z: 0 };
    // Live authoritative snapshot rows, refreshed by the match runtime.
    this.vehicleColliders = [];
    this.setMapMeta(mapMeta);
  }

  setMapMeta(mapMeta = null) {
    this.mapMeta = mapMeta && typeof mapMeta === 'object' ? mapMeta : null;
    return this;
  }

  solid(x, y, z) { return isSolidBlock(getBlock(x, y, z))
    || (!!this.mapMeta?.bastion && bastionDefenderSolid(this.mapMeta.bastion, x, y, z)); }

  solidBelow(x, y, z) {
    return solidBelow(this._solidAt, x, y, z);
  }

  /**
   * Authoritative chute state from the self row (cq[7]). A fresh local toggle
   * keeps its prediction for CHUTE_ADOPT_HOLD_S so the in-flight snapshots do
   * not flip it back; server-side changes (ejection seat, landing) are adopted.
   */
  adoptChute(state) {
    const next = state === CHUTE.open || state === CHUTE.seat ? state : CHUTE.none;
    if (!this.airRules || this._chuteHold > 0 || next === this.chute) return false;
    this.chute = next;
    this.chuteT = next === CHUTE.seat ? EJECTION.seatSeconds * 0.8 : 0;
    return true;
  }

  /** HUD prompt: 'ready' (Jump opens a chute), 'open' (Jump cuts it), 'seat' or null. */
  chutePrompt() {
    if (!this.airRules) return null;
    if (this.chute === CHUTE.open) return 'open';
    if (this.chute === CHUTE.seat) return 'seat';
    if (this.grounded || this.swimming || this.vault || this.vel.y > -2) return null;
    return chuteAvailable({ grounded: false, chute: this.chute, x: this.pos.x, y: this.pos.y, z: this.pos.z }, this._solidAt, this._fluidAt) ? 'ready' : null;
  }

  /**
   * Authoritative pilot state from a decoded `tfs` self frame (§3.2): velocity,
   * wall, jumps, slide. LocalPlayer.reconcile calls it only when the position
   * error says the prediction diverged and the frame has consumed every local
   * jump press (jumpSeqAck), so a fresh predicted jump is never undone.
   */
  adoptPilot(frame) {
    if (!this.pilotRules || !frame || ![frame.vx, frame.vy, frame.vz].every(Number.isFinite)) return false;
    const pilot = this.pilot, wasWall = pilot.wall;
    this.vel.x = frame.vx;
    this.vel.y = frame.vy;
    this.vel.z = frame.vz;
    const wall = Number.isInteger(frame.wallN) && Math.abs(frame.wallN) <= 2 ? frame.wallN : 0;
    if (wall !== pilot.wall) {
      if (wall) {
        // The plane is re-derived from the body: the wall lies opposite its normal.
        const n = wall > 0 ? 1 : -1, reach = PHYSICS.halfW + PILOT_RULES.wallrun.probe, xAxis = Math.abs(wall) === 1;
        pilot.wallPlane = Math.floor(xAxis ? this.pos.x - n * reach : this.pos.z - n * reach);
        pilot.wallSpeed = Math.max(PILOT_RULES.wallrun.speed, Math.hypot(frame.vx, frame.vz));
        pilot.wallTan = xAxis ? frame.vz : frame.vx;
        pilot.wallGap = 0;
        pilot.wallStepAt = null;
      }
      pilot.wall = wall;
    }
    // The frame is about a round trip old: on the run (or slide) the prediction is
    // already on, its timer only moves forward, so adopting never lengthens the run.
    const wallT = wall && Number.isFinite(frame.wallT) ? frame.wallT : 0;
    pilot.wallT = wall && wall === wasWall && wallT < pilot.wallT ? pilot.wallT : wallT;
    if (Number.isInteger(frame.jumpsLeft)) pilot.jumpsLeft = frame.jumpsLeft;
    const slideT = Number.isFinite(frame.slideT) ? Math.max(0, frame.slideT) : 0;
    pilot.slideT = slideT > 0 && pilot.slideT > slideT ? pilot.slideT : slideT;
    if (Number.isFinite(frame.slideCd)) pilot.slideCd = Math.max(0, frame.slideCd);
    if (pilot.slideT === 0) pilot.slideAir = 0;
    return true;
  }

  /** The authoritative grapple anchor (`tf[6]`, metres) or null: starts or ends the predicted pull. */
  adoptPilotGrapple(anchor) {
    if (!this.pilotRules) return false;
    const pilot = this.pilot;
    if (Array.isArray(anchor) && anchor.length === 3 && anchor.every(Number.isFinite)) {
      if (pilot.grapple) { pilot.grapple.anchor = anchor.slice(); return false; }
      // A locally released grapple stays released until the authority catches up.
      if (this._grappleHold > 0) return false;
      pilot.grapple = { anchor: anchor.slice(), t: 0 };
      pilot.wall = 0; pilot.wallT = 0; pilot.slideT = 0;
      return true;
    }
    if (!pilot.grapple) return false;
    pilot.grapple = null;
    return true;
  }

  /** Fresh pilot state (spawn, teleport, death, leaving the mode). */
  resetPilot() {
    this.pilot = createPilotState();
    this._grappleHold = 0;
    this.resetPilotStep();
  }

  /** Drops the fixed-step backlog, a latched press and the presentation trail (spawn, rodeo, death). */
  resetPilotStep() {
    this._pilotAcc = 0;
    this._pilotJumpLatch = false;
    this._pilotStepDelta.x = this._pilotStepDelta.y = this._pilotStepDelta.z = 0;
    this.pilotLerp.x = this.pilotLerp.y = this.pilotLerp.z = 0;
  }

  /** A jump press this frame (LocalPlayer): the next fixed step sees it even if it was released first. */
  notePilotJumpPress() {
    this._pilotJumpLatch = true;
  }

  /**
   * Pilot prediction on the authority's fixed step (PILOT_STEP_S): the pilot rules
   * (air strafe, wall probes, hop window) are tick-based, so stepping at the frame
   * rate would drift from the 60 Hz server on high-refresh displays. Runs as many
   * whole steps as the frame time allows (at most four backlogged) and sets pilotLerp so the
   * camera and body present the state between the last two steps. Returns true
   * when a step accepted a ground jump.
   */
  stepPilotFixed(frameDt, wish, speedTarget, wantJump, climbAxis = 0, yaw = null) {
    this._pilotAcc = Math.min(this._pilotAcc + (frameDt > 0 ? frameDt : 0), PILOT_STEP_S * 4);
    let jumped = false;
    // A frame a hair short of a step still steps (vsync jitter around 60 Hz), the debt carries over.
    while (this._pilotAcc >= PILOT_STEP_S * 0.9) {
      const x = this.pos.x, y = this.pos.y, z = this.pos.z, shiftX = this.pilot.shiftX, shiftZ = this.pilot.shiftZ;
      if (this._pilotJumpLatch) this.jumpWasHeld = false;
      if (this.step(PILOT_STEP_S, wish, speedTarget, !!wantJump || this._pilotJumpLatch, climbAxis, yaw)) jumped = true;
      this._pilotJumpLatch = false;
      this._pilotAcc -= PILOT_STEP_S;
      // A wall step-around (pilot shiftX/Z) is not presented between steps: the pilot camera eases it out.
      this._pilotStepDelta.x = this.pos.x - x - (this.pilot.shiftX - shiftX);
      this._pilotStepDelta.y = this.pos.y - y;
      this._pilotStepDelta.z = this.pos.z - z - (this.pilot.shiftZ - shiftZ);
    }
    const behind = Math.max(0, Math.min(1, 1 - this._pilotAcc / PILOT_STEP_S));
    this.pilotLerp.x = -this._pilotStepDelta.x * behind;
    this.pilotLerp.y = -this._pilotStepDelta.y * behind;
    this.pilotLerp.z = -this._pilotStepDelta.z * behind;
    return jumped;
  }

  /** Movement lock: wallrun, slide and grapple end, counters stay (server: resetPilotMotion). */
  clearPilotMotion() {
    resetPilotMotion(this.pilot);
  }

  /** The physics body as the shared pilot hooks see it (server field names) and their context. */
  _pilotView() {
    if (!this._pilotBody) {
      const pos = this.pos, vel = this.vel, physics = this;
      this._pilotBody = {
        get x() { return pos.x; }, set x(value) { pos.x = value; },
        get y() { return pos.y; }, set y(value) { pos.y = value; },
        get z() { return pos.z; }, set z(value) { pos.z = value; },
        get vx() { return vel.x; }, set vx(value) { vel.x = value; },
        get vy() { return vel.y; }, set vy(value) { vel.y = value; },
        get vz() { return vel.z; }, set vz(value) { vel.z = value; },
        get grounded() { return physics.grounded; }, set grounded(value) { physics.grounded = value; },
        get coyote() { return physics.coyote; }, set coyote(value) { physics.coyote = value; },
        get crouch() { return physics._crouching; },
        get sprint() { return physics._pilotSpeedInput.sprint; },
      };
      this._pilotCtx = {
        pilotRules: true, solidAt: this._solidAt, fluidAt: this._fluidAt,
        get vehicles() { return physics.vehicleColliders; }, get mapMeta() { return physics.mapMeta; },
        get now() { return Number.isFinite(physics.pilotNow) ? physics.pilotNow : 0; },
      };
    }
    return this._pilotBody;
  }

  moveAxis(axis, amount, canStep = false) {
    const height = stanceHeight(PHYSICS.height, this.proneT);
    const start = this.pos[axis];
    const terrainCollision = canStep
      ? slideTerrainAxis(this.pos, axis, amount, this._solidAt, this.mapMeta, true, height)
      : slidePlayerAxis(this.pos, axis, amount, this._solidAt, height);
    const collided = slidePlayerVehicleAxis(this.pos, axis, start, this.vehicleColliders, height) || terrainCollision;
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
    const onLadderNow = ladderContact(this.mapMeta, this.pos.x, this.pos.y, this.pos.z, 0, this._voxelAt);
    const swimming = fluidContact(this._fluidAt, this.pos.x, this.pos.y, this.pos.z);
    const ride = swimming && !this.slide ? null
      : slideContact(this.mapMeta, this.pos.x, this.pos.y, this.pos.z, this.slide);
    if (this.climbBlocked) this.vault = null;
    this.proneT = stepPlayerProne(this.proneT, !!ride || (this.wantProne && !this.vault && !onLadderNow),
      dt, this._solidAt, this.pos);
    const low = this.wantProne || this.proneT > 0;
    if (Number.isFinite(yaw)) this.leanYaw = yaw;
    const leanRequest = leanBlocked({ prone: low, swimming, vaulting: !!this.vault, ladder: onLadderNow, riding: !!ride })
      ? 0 : this.wantLean;
    this.leanT = stepBodyLean(this.leanT, leanRequest, dt, this._solidAt, { x: this.pos.x, z: this.pos.z,
      eyeY: this.uprightEyeY(), yaw: this.leanYaw, crouch: this._crouching });
    if (low) {
      speedTarget = Math.min(speedTarget, PRONE.speed);
      // The authority still lets a prone swimmer hold jump to rise (a rider
      // splashing down from a flume is prone); only dry jumps are refused.
      if (!swimming) wantJump = false;
    }
    if (this.coyote > 0) this.coyote = Math.max(0, this.coyote - dt);
    if (this._chuteHold > 0) this._chuteHold = Math.max(0, this._chuteHold - dt);
    const chuteBefore = this.airRules ? this.chute : CHUTE.none;

    this.swimming = swimming;
    if (ride) {
      // On the slide rails: no collision, no jump, the tube sets the pace.
      this.vault = null;
      this.chute = CHUTE.none;
      const previous = { ...this.pos };
      this.slide = stepSlideRide(this.pos, this.vel, ride, dt, wish);
      if (constrainPlayerVehicleMotion(this.pos, previous, this.vehicleColliders, stanceHeight(PHYSICS.height, this.proneT))) {
        this.slide = null;
        this.vel.x = this.vel.y = this.vel.z = 0;
      }
      this.grounded = false;
      this.coyote = 0;
      this.jumpGroundY = null;
      if (this.pilotRules) resetPilotMotion(this.pilot);
      return false;
    }
    this.slide = null;
    if (swimming) speedTarget = Math.min(speedTarget, SWIM_RULES.speed);
    speedTarget *= this.speedScale;
    if (this.grounded) this.jumpGroundY = this.pos.y;
    // Titanfall pilot movement: double jump, wall-jump, slide entry (same place as server/sim/movement.js).
    const pilotBody = this.pilotRules ? this._pilotView() : null;
    const hadGrapple = !!pilotBody && !!this.pilot.grapple;
    if (this._grappleHold > 0) this._grappleHold = Math.max(0, this._grappleHold - dt);
    if (pilotBody) {
      // The server's sprint gate reads prone after this step's stance update (`low`).
      const input = this._pilotSpeedInput, source = this.pilotInput;
      input.sprint = !!source?.sprint && !low;
      input.crouch = source ? !!source.crouch : !!this._crouching;
      input.ads = !!source?.ads;
      input.stim = !!source?.stim;
      speedTarget = pilotSpeedFor(this.pilot, input, speedTarget);
    }
    const pilotLadder = !this.climbBlocked && !chuteBefore && !low && onLadderNow;
    const pilotJump = !!pilotBody && pilotPreStep(this.pilot, pilotBody, { jump: !!wantJump && !low, jumpPressed: jumpPressed && !low,
      crouch: this._crouching, wishX: wish.x, wishZ: wish.z, yaw, ladder: pilotLadder, swim: swimming }, this._pilotCtx, dt);
    const deliberateGrab = !pilotJump && !this.grounded && jumpPressed && !low && !chuteBefore;
    // Pilot mantle: an airborne pilot's automatic grab reaches from the feet, not the takeoff (as the server).
    const reachFromFeet = deliberateGrab || (!!pilotBody && !this.grounded);
    const handsFree = !this.climbBlocked && !chuteBefore;
    if (handsFree && !this.vault && swimming) {
      this.vault = findSwimExit(this._solidAt, this.pos, wish, !!wantJump, this._crouching || low, yaw);
    } else if (handsFree && !this.vault && !swimming && canStartVault(this.grounded, this.grounded ? wantJump : deliberateGrab, climbAxis,
        this._crouching || low, this.pos.y, this.jumpGroundY)) {
      this.vault = findVault(this._solidAt, this.pos, wish,
        reachFromFeet ? this.pos.y : this.jumpGroundY, yaw, reachFromFeet ? 0 : 1);
    }
    if (this.airRules) {
      // Same order as server/sim/movement.js: a ledge grab wins over the canopy.
      const before = this.chute;
      const next = stepChuteState({ chute: this.chute, chuteT: this.chuteT, grounded: this.grounded, vy: this.vel.y,
        x: this.pos.x, y: this.pos.y, z: this.pos.z }, { jumpPressed: jumpPressed && !this.vault && !(this.coyote > 0),
        blocked: !!this.vault || swimming, dt, solidAt: this._solidAt, fluidAt: this._fluidAt });
      this.chute = next.chute; this.chuteT = next.chuteT;
      if (this.chute !== before) this._chuteHold = CHUTE_ADOPT_HOLD_S;
    } else this.chute = CHUTE.none;
    if (this.vault) {
      const previous = { ...this.pos };
      const active = stepVault(this.pos, this.vault, dt, this._solidAt);
      const hullBlocked = constrainPlayerVehicleMotion(this.pos, previous, this.vehicleColliders, stanceHeight(PHYSICS.height, this.proneT));
      this.vel.x = this.vel.y = this.vel.z = 0;
      this.grounded = !active && this.solidBelow(this.pos.x, this.pos.y, this.pos.z);
      this.coyote = 0;
      if (!active || hullBlocked) this.vault = null;
      if (pilotBody) resetPilotMotion(this.pilot);
      return false;
    }
    const onLadder = handsFree && !low && onLadderNow;
    let ladderVy = 0;
    if (onLadder && (wantJump || climbAxis > 0)) ladderVy = LADDER_UP_SPEED;
    else if (onLadder && (this._crouching || climbAxis < 0)) ladderVy = LADDER_DOWN_SPEED;
    const ladderDirected = ladderVy !== 0;

    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const blend = 1 - Math.exp(-accel * dt);
    if (!this.chute && !(pilotBody && pilotAccel(this.pilot, pilotBody, { x: wish.x, z: wish.z, speed: speedTarget, accel: blend,
      ladder: pilotLadder, swim: swimming }, this._pilotCtx, dt))) {
      this.vel.x += (wish.x * speedTarget - this.vel.x) * blend;
      this.vel.z += (wish.z * speedTarget - this.vel.z) * blend;
    }
    let jumpAccepted = false;

    // Pilot rules jump inside pilotVertical, in the server's place (after the ladder and swim branches).
    if (!pilotBody && !this.chute && !onLadder && !swimming && wantJump && (this.grounded || this.coyote > 0) && this.vel.y <= 0.01) {
      this.vel.y = JUMP_VEL;
      this.grounded = false;
      this.coyote = 0;
      jumpAccepted = true;
    }
    if (this.chute === CHUTE.open) {
      stepChuteVelocity(this.vel, Number.isFinite(yaw) ? yaw : this.leanYaw, wish.x, wish.z, dt, this.chuteDrift);
    } else if (this.chute === CHUTE.seat) {
      // The ejection seat flies ballistic until the canopy opens.
      this.vel.y = Math.max(TERMINAL_VY, this.vel.y - GRAVITY * dt);
    } else if (ladderDirected) {
      // A directed climb is never grounded and never banks coyote time.
      this.vel.y = ladderVy;
      this.grounded = false;
      this.coyote = 0;
    } else if (swimming) {
      this.vel.y = swimVerticalVelocity(this.vel.y, !!wantJump, !!this._crouching, dt, this._fluidAt,
        this.pos.x, this.pos.y, this.pos.z);
      this.coyote = 0;
    } else if (pilotBody && pilotVertical(this.pilot, pilotBody, this._pilotCtx, dt)) {
      // Pilot jumps (ground, double), wallrun and grapple replaced the stock jump and gravity.
      if (this.pilot.jumped === 1) jumpAccepted = true;
    } else if (pilotBody) {
      // Pilot rules on a ladder: the stock jump in the server's place.
      if (!onLadder && wantJump && (this.grounded || this.coyote > 0) && this.vel.y <= 0.01) {
        this.vel.y = JUMP_VEL;
        this.grounded = false;
        this.coyote = 0;
        jumpAccepted = true;
      }
      this.vel.y = Math.max(TERMINAL_VY, this.vel.y - GRAVITY * dt);
    } else this.vel.y = Math.max(TERMINAL_VY, this.vel.y - GRAVITY * dt);

    const canStepTerrain = this.grounded && !wantJump && !this.vault && !ladderDirected && this.vel.y <= 0.01;
    const hitX = this.moveAxis('x', this.vel.x * dt, canStepTerrain);
    const hitZ = this.moveAxis('z', this.vel.z * dt, canStepTerrain);
    const dy = this.vel.y * dt;
    const descending = this.vel.y < 0;
    let hitY = false;
    // Climbing crosses the solid deck; descending bypasses only while the
    // destination stays in-volume, so the foot of the ladder still lands.
    const ladderBypass = ladderVy > 0
      || (ladderVy < 0 && ladderContact(this.mapMeta, this.pos.x, this.pos.y + this.vel.y * dt, this.pos.z, 0, this._voxelAt));
    if (ladderBypass) {
      const start = this.pos.y;
      this.pos.y += this.vel.y * dt;
      if (slidePlayerVehicleAxis(this.pos, 'y', start, this.vehicleColliders, stanceHeight(PHYSICS.height, this.proneT))) this.vel.y = 0;
      if (ladderVy > 0 && !ladderContact(this.mapMeta, this.pos.x, this.pos.y, this.pos.z, 0, this._voxelAt)) this.vel.y = 0;
    } else {
      hitY = this.moveAxis('y', this.vel.y * dt);
    }

    if (!ladderBypass && hitY && descending) {
      this.grounded = true;
    } else if (!ladderBypass && this.vel.y <= 0.001 && this.solidBelow(this.pos.x, this.pos.y, this.pos.z)) {
      this.grounded = true;
      this.vel.y = 0;
    } else {
      if (this.grounded) this.coyote = COYOTE_S;
      this.grounded = false;
    }
    if (pilotBody) {
      pilotPostCollide(this.pilot, pilotBody, this._pilotCtx, { x: hitX, z: hitZ, y: hitY, dy }, dt);
      if (hadGrapple && !this.pilot.grapple) this._grappleHold = GRAPPLE_ADOPT_HOLD_S;
    }
    if (this.grounded && this.chute) { this.chute = CHUTE.none; this.chuteT = 0; this._chuteHold = CHUTE_ADOPT_HOLD_S; }

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

  uprightEyeY() {
    return this.pos.y + stanceEye(EYE_HEIGHT, this._crouching, this.proneT);
  }

  /** World offset of the eye from the upright eye while peek-leaning. */
  leanEyeOffset() {
    return leanEyeOffset(this.leanT, this.leanYaw, this._crouching ? 1 : 0);
  }

  eyeY() {
    return this.uprightEyeY() + (this.leanT ? this.leanEyeOffset().y : 0);
  }
}

export function moveSpeedFor(keys, ads = false) {
  if (keys.crouch) return CROUCH;
  if (!ads && keys.sprint && keys.forward && !keys.back) return SPRINT;
  return WALK;
}
