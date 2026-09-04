import { EYE_HEIGHT, GRAVITY, PLAYER_HALF } from './combatmath.js';

/** Movement and collision geometry shared by prediction and authority. */
export const PHYSICS = Object.freeze({
  walk: 4.4, sprint: 6.2, crouch: 2.2, jump: 8.2,
  gravity: GRAVITY, eye: EYE_HEIGHT, crouchEye: EYE_HEIGHT * 0.58,
  accelGround: 10, accelAir: 3, halfW: PLAYER_HALF.x, height: PLAYER_HALF.h * 2,
});
export const MOVEMENT_RULES = Object.freeze({
  coyoteS: 0.08, terminalVy: -60, ladderUp: 3.4, ladderDown: 2.4,
});
const HALF_W = PHYSICS.halfW;
const P_HEIGHT = PHYSICS.height;
const EPS = 1e-3;
const SHRINK = 1e-4;
const MAX_STEP = 0.45;

export function boxCollides(solidAt, px, py, pz) {
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
export function solidBelow(solidAt, px, py, pz) {
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
export function slidePlayerAxis(position, axis, amount, solidAt) {
  if (!Number.isFinite(amount) || amount === 0) return false;
  const sign = amount < 0 ? -1 : 1;
  let remaining = Math.abs(amount);
  while (remaining > 1e-9) {
    const delta = Math.min(MAX_STEP, remaining) * sign;
    remaining -= Math.abs(delta);
    const before = position[axis];
    position[axis] += delta;
    if (!boxCollides(solidAt, position.x, position.y, position.z)) continue;
    if (axis === 'y') {
      const cell = Math.floor(sign > 0 ? position.y + P_HEIGHT : position.y);
      position.y = sign > 0 ? cell - P_HEIGHT - EPS : cell + 1;
    } else {
      const wall = Math.floor(position[axis] + sign * HALF_W);
      position[axis] = sign > 0 ? wall - HALF_W - EPS : wall + 1 + HALF_W + EPS;
    }
    if (boxCollides(solidAt, position.x, position.y, position.z)) position[axis] = before;
    return true;
  }
  return false;
}
