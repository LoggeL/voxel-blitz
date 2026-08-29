// Authoritative movement, collision, timers, and hidden-condition integration.

import { CONDITION_RULES } from '../../shared/combatmath.js';
import { ladderContact } from '../../shared/worlddata.js';
import { PHYSICS, clamp01 } from './player.js';

const WALK_SPEED = PHYSICS.walk;
const SPRINT_SPEED = PHYSICS.sprint;
const CROUCH_SPEED = PHYSICS.crouch;
const JUMP_VELOCITY = PHYSICS.jump;
const GRAVITY = PHYSICS.gravity;
const ACCEL_GROUND = PHYSICS.accelGround;
const ACCEL_AIR = PHYSICS.accelAir;
const HALF_W = PHYSICS.halfW;
const P_HEIGHT = PHYSICS.height;

const COYOTE_S = 0.08;
const LADDER_UP_SPEED = 3.4;
const LADDER_DOWN_SPEED = 2.4;
const EPS = 1e-3;
const SHRINK = 1e-4;
const MAX_STEP = 0.45;
const TERMINAL_VY = -60;
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
      p.reloading = false;
      if (p.reserve[p.weapon] > 0) {
        p.reserve[p.weapon] -= 1;
        p.mag[p.weapon] = def.magSize;
      }
    }
  }
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

function boxCollides(solidAt, px, py, pz) {
  const x0 = Math.floor(px - HALF_W + SHRINK), x1 = Math.floor(px + HALF_W - SHRINK);
  const y0 = Math.floor(py + SHRINK), y1 = Math.floor(py + P_HEIGHT - SHRINK);
  const z0 = Math.floor(pz - HALF_W + SHRINK), z1 = Math.floor(pz + HALF_W - SHRINK);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (solidAt(x, y, z)) return true;
      }
    }
  }
  return false;
}

/** Grounded probe: any solid within a hair below the feet. */
function solidBelow(solidAt, px, py, pz) {
  const yy = py - 0.06;
  if (Math.floor(yy) < 0) return true;
  const xs = [px - HALF_W + SHRINK, px + HALF_W - SHRINK];
  const zs = [pz - HALF_W + SHRINK, pz + HALF_W - SHRINK];
  const cellY = Math.floor(yy);
  for (const cx of xs) {
    for (const cz of zs) {
      if (solidAt(Math.floor(cx), cellY, Math.floor(cz))) return true;
    }
  }
  return false;
}

/**
 * Move along one axis in <=MAX_STEP sub-steps, sliding flush against the
 * first obstructing voxel face. Returns true when a collision occurred.
 */
function slideAxis(p, axis, total, solidAt) {
  if (total === 0) return false;
  const sign = total < 0 ? -1 : 1;
  let collided = false;
  let rem = Math.abs(total);
  while (rem > 1e-9 && !collided) {
    const d = Math.min(MAX_STEP, rem) * sign;
    rem -= Math.abs(d);
    const before = p[axis];
    p[axis] = before + d;
    if (boxCollides(solidAt, p.x, p.y, p.z)) {
      collided = true;
      if (axis === 'x') {
        const wallCell = sign > 0 ? Math.floor(p.x + HALF_W) : Math.floor(p.x - HALF_W);
        p.x = sign > 0 ? wallCell - HALF_W - EPS : wallCell + 1 + HALF_W + EPS;
      } else if (axis === 'z') {
        const wallCell = sign > 0 ? Math.floor(p.z + HALF_W) : Math.floor(p.z - HALF_W);
        p.z = sign > 0 ? wallCell - HALF_W - EPS : wallCell + 1 + HALF_W + EPS;
      } else {
        const cell = Math.floor(sign > 0 ? p.y + P_HEIGHT : p.y);
        p.y = sign > 0 ? cell - P_HEIGHT - EPS : cell + 1;
        if (sign < 0) { p.vy = 0; } else { p.vy = 0; }
      }
      if (boxCollides(solidAt, p.x, p.y, p.z)) {
        // Corner degeneracy — fall back wholesale.
        p[axis] = before;
        if (axis === 'x') p.vx = 0;
        else if (axis === 'z') p.vz = 0;
        else p.vy = 0;
      } else if (axis === 'x') p.vx = 0;
      else if (axis === 'z') p.vz = 0;
      else p.vy = 0;
    }
  }
  return collided;
}

/**
 * Integrate one living entity for one fixed simulation step.
 *
 * ctx = { solidAt(x,y,z), mapMeta, now, onFall(entity) }
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
  const speed = p.crouch ? CROUCH_SPEED : (p.sprint ? SPRINT_SPEED : WALK_SPEED);
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
