// Authoritative movement, collision, timers, and hidden-condition integration.

import { CONDITION_RULES } from '../../shared/combatmath.js';
import { ladderContact } from '../../shared/worlddata.js';
import { clamp01 } from './player.js';
import { PHYSICS, MOVEMENT_RULES, slidePlayerAxis, solidBelow, findVault, stepVault } from '../../shared/player-movement.js';

const WALK_SPEED = PHYSICS.walk;
const SPRINT_SPEED = PHYSICS.sprint;
const CROUCH_SPEED = PHYSICS.crouch;
const JUMP_VELOCITY = PHYSICS.jump;
const GRAVITY = PHYSICS.gravity;
const ACCEL_GROUND = PHYSICS.accelGround;
const ACCEL_AIR = PHYSICS.accelAir;

const COYOTE_S = MOVEMENT_RULES.coyoteS;
const CONCUSSED_SPEED_MULT = 0.6;
const LADDER_UP_SPEED = MOVEMENT_RULES.ladderUp;
const LADDER_DOWN_SPEED = MOVEMENT_RULES.ladderDown;
const TERMINAL_VY = MOVEMENT_RULES.terminalVy;
const DEAD_FALL_Y = -24;

/** Advance weapon, deploy, coyote, bloom, and reload timers. */
export function updateTimers(p, dt) {
  p.cooldown = Math.max(-dt, p.cooldown - dt);
  if (p.deployT > 0) p.deployT = Math.max(0, p.deployT - dt);
  if (p.coyote > 0) p.coyote -= dt;
  const def = p.def;
  if (p.bloom > 0) p.bloom = Math.max(0, p.bloom - def.bloomRecover * dt);

  if (p.reloading) {
    p.reloadT -= dt;
    if (p.reloadT <= 0) {
      if (p.reloadStage) advanceStagedReload(p, def);
      else {
        p.reloading = false;
        if (p.reserve[p.weapon] > 0) {
          if (!p.infiniteMagazines) p.reserve[p.weapon] -= 1;
          p.mag[p.weapon] = def.magSize;
        }
      }
    }
  }
}

/**
 * Tube reload stages: `start` hands the spare over as loose rounds, every `round`
 * stage seats one, `end` lowers the gun. Interrupting after `start` keeps every seated
 * round and forfeits the loose remainder, mirroring the dropped-magazine rule.
 */
function advanceStagedReload(p, def) {
  const stages = def.reloadStages;
  const slot = p.weapon;
  if (p.reloadStage === 'start') {
    if (p.reserve[slot] <= 0 || p.mag[slot] >= def.magSize) {
      clearReload(p);
      return;
    }
    if (!p.infiniteMagazines) p.reserve[slot] -= 1;
    p.reloadLoose = def.magSize;
    p.reloadStage = 'round';
    p.reloadT += stages.perRound;
    return;
  }
  if (p.reloadStage === 'round') {
    if (p.reloadLoose > 0 && p.mag[slot] < def.magSize) {
      p.mag[slot] += 1;
      p.reloadLoose -= 1;
    }
    if (p.reloadLoose > 0 && p.mag[slot] < def.magSize) {
      p.reloadT += stages.perRound;
    } else {
      p.reloadStage = 'end';
      p.reloadT += stages.end;
    }
    return;
  }
  clearReload(p);
}

export function clearReload(p) {
  p.reloading = false;
  p.reloadT = 0;
  p.reloadStage = null;
  p.reloadLoose = 0;
}

/** Advance pain, panic, and exhaustion after movement for this tick. */
export function updateCondition(p, dt) {
  const missingHealth = 1 - clamp01(p.hp / 100);
  const panicFloor = missingHealth * CONDITION_RULES.panicLowHpFloor;
  const painFloor = missingHealth * CONDITION_RULES.painLowHpFloor;
  p.panic = clamp01(Math.max(panicFloor, p.panic - CONDITION_RULES.panicDecayPerS * dt));
  p.pain = clamp01(Math.max(painFloor, p.pain - CONDITION_RULES.painDecayPerS * dt));
  const exhaustionRate = p.sprint
    ? CONDITION_RULES.exhaustionSprintPerS
    : -CONDITION_RULES.exhaustionRecoverPerS;
  p.exhaustion = clamp01(p.exhaustion + exhaustionRate * dt);
}

function slideAxis(player, axis, amount, solidAt) {
  const collided = slidePlayerAxis(player, axis, amount, solidAt);
  if (collided) player[`v${axis}`] = 0;
  return collided;
}

/**
 * Integrate one living entity for one fixed simulation step.
 *
 * ctx = { solidAt(x,y,z), mapMeta, now, movementLocked, onFall(entity) }
 */
export function stepMovement(p, dt, ctx) {
  const inp = p.input || {
    seq: 0,
    keys: { f: 0, b: 0, l: 0, r: 0, jump: 0, sprint: 0, crouch: 0 },
    yaw: p.yaw, pitch: p.pitch, wantAds: false,
  };

  // NaN paranoia: corrupted state never propagates.
  if (![isFinite(p.x), isFinite(p.y), isFinite(p.z)].every(Boolean)) {
    ctx.onFall(p, 'invalid');
    return;
  }

  p.yaw = inp.yaw; p.pitch = inp.pitch;
  p.ads = !!inp.wantAds;
  const adsStep = dt / Math.max(0.001, p.def.adsTime);
  p.adsT = Math.max(0, Math.min(1, p.adsT + (p.ads ? adsStep : -adsStep)));

  if (ctx.movementLocked) {
    p.vault = null;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.crouch = false;
    p.sprint = false;
    p.coyote = 0;
    p.grounded = solidBelow(ctx.solidAt, p.x, p.y, p.z);
    p.hist.push({ x: p.x, y: p.y, z: p.z, t: ctx.now });
    if (p.hist.length > 16) p.hist.shift();
    return;
  }

  const kf = inp.keys;
  const fwdAmt = (kf.f ? 1 : 0) - (kf.b ? 1 : 0);
  const strafe = (kf.r ? 1 : 0) - (kf.l ? 1 : 0);
  p.crouch = !!kf.crouch;
  p.sprint = !!kf.sprint && fwdAmt > 0 && !p.crouch && !p.ads;

  // Normalized wish direction prevents diagonal movement from gaining speed.
  let wx = 0, wz = 0;
  if (fwdAmt !== 0 || strafe !== 0) {
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    wx = -sy * fwdAmt + cy * strafe;
    wz = -cy * fwdAmt - sy * strafe;
    const length = Math.hypot(wx, wz);
    wx /= length; wz /= length;
  }
  if (p.grounded) p.jumpGroundY = p.y;
  if (!p.vault && kf.jump && fwdAmt > 0 && !p.crouch && (p.grounded || p.vy > 0)) {
    p.vault = findVault(ctx.solidAt, p, { x: wx, z: wz }, p.jumpGroundY);
  }
  if (p.vault) {
    const active = stepVault(p, p.vault, dt, ctx.solidAt);
    p.vx = p.vy = p.vz = 0;
    p.ads = false;
    p.grounded = !active && solidBelow(ctx.solidAt, p.x, p.y, p.z);
    p.coyote = 0;
    if (!active) p.vault = null;
    p.hist.push({ x: p.x, y: p.y, z: p.z, t: ctx.now });
    if (p.hist.length > 16) p.hist.shift();
    return;
  }
  let speed = p.crouch ? CROUCH_SPEED : (p.sprint ? SPRINT_SPEED : WALK_SPEED);
  // A pulse concussion drags the legs: 60% speed until the deadline passes.
  if (Number.isFinite(p.concussedUntil) && p.concussedUntil > ctx.now) speed *= CONCUSSED_SPEED_MULT;
  const accel = 1 - Math.exp(-(p.grounded ? ACCEL_GROUND : ACCEL_AIR) * dt);
  p.vx += (wx * speed - p.vx) * accel;
  p.vz += (wz * speed - p.vz) * accel;

  const onLadder = ladderContact(ctx.mapMeta, p.x, p.y, p.z);
  const ladderUp = onLadder && (kf.jump || (kf.f && !kf.b));
  const ladderDown = onLadder && !ladderUp && (kf.crouch || (kf.b && !kf.f));
  const ladderDirected = ladderUp || ladderDown;

  if (ladderDirected) {
    p.vy = ladderUp ? LADDER_UP_SPEED : -LADDER_DOWN_SPEED;
    p.grounded = false;
    p.coyote = 0;
  } else {
    // Jump with a short coyote window.
    if (kf.jump && (p.grounded || p.coyote > 0) && p.vy <= 0.01) {
      p.vy = JUMP_VELOCITY;
      p.grounded = false;
      p.coyote = 0;
      p.exhaustion = clamp01(p.exhaustion + CONDITION_RULES.exhaustionJumpGain);
    }
    p.vy = Math.max(TERMINAL_VY, p.vy - GRAVITY * dt);
  }

  // X and Z always collide. Upward travel crosses the solid tower deck.
  // Downward travel bypasses only while its destination remains in-volume,
  // so the ordinary collision path catches the floor at the ladder foot.
  slideAxis(p, 'x', p.vx * dt, ctx.solidAt);
  slideAxis(p, 'z', p.vz * dt, ctx.solidAt);
  const dy = p.vy * dt;
  const ladderBypass = ladderUp
    || (ladderDown && ladderContact(ctx.mapMeta, p.x, p.y + dy, p.z));
  const hitY = ladderBypass ? false : slideAxis(p, 'y', dy, ctx.solidAt);
  if (ladderBypass) {
    p.y += dy;
    if (ladderUp && !ladderContact(ctx.mapMeta, p.x, p.y, p.z)) p.vy = 0;
  }

  // Ground bookkeeping. Upward head impacts are not landings.
  if (!ladderBypass && hitY && dy < 0) {
    p.grounded = true;
  } else if (!ladderBypass && p.vy <= 0.001 && solidBelow(ctx.solidAt, p.x, p.y, p.z)) {
    p.grounded = true;
    p.vy = 0;
  } else {
    if (!ladderDirected && p.grounded) p.coyote = COYOTE_S;
    p.grounded = false;
  }

  // Keep the 16-sample authoritative trail used by shooter-side rewind.
  p.hist.push({ x: p.x, y: p.y, z: p.z, t: ctx.now });
  if (p.hist.length > 16) p.hist.shift();

  if (p.y < DEAD_FALL_Y) ctx.onFall(p, 'void');
}
