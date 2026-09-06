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

export const VAULT_SECONDS = 0.48;

/** A forward jump keeps reaching for a ledge after the jump button is released. */
export function canStartVault(grounded, wantJump, forward, crouching, y, groundY) {
  return forward > 0 && !crouching && (grounded ? wantJump
    : Number.isFinite(groundY) && y > groundY + 0.1);
}

/** Find a reachable ledge relative to the last grounded height, never a midair wall climb. */
export function findVault(solidAt, position, wish, groundY) {
  if (!Number.isFinite(groundY) || Math.hypot(wish.x, wish.z) < 0.5) return null;
  const dx = Math.abs(wish.x) > Math.abs(wish.z) ? Math.sign(wish.x) : 0;
  const dz = dx ? 0 : Math.sign(wish.z);
  const tx = position.x + dx * 0.95, tz = position.z + dz * 0.95;
  const top = Math.round(groundY) + 2;
  if (top - groundY > 2.05 || top <= position.y + 0.1) return null;
  if (!solidAt(Math.floor(tx), top - 1, Math.floor(tz)) ||
      boxCollides(solidAt, tx, top, tz)) return null;
  const vault = { from: { x: position.x, y: position.y, z: position.z }, to: { x: tx, y: top, z: tz }, elapsed: 0 };
  // Check the complete lift and pull path, including headroom above the takeoff point.
  for (let i = 0; i <= 20; i++) {
    const point = vaultPoint(vault, i / 20);
    if (boxCollides(solidAt, point.x, point.y, point.z)) return null;
  }
  return vault;
}

function vaultPoint(vault, t) {
  const smooth = (v) => v * v * (3 - 2 * v);
  const lift = smooth(Math.min(1, t / 0.58));
  const pull = smooth(Math.max(0, (t - 0.58) / 0.42));
  return {
    x: vault.from.x + (vault.to.x - vault.from.x) * pull,
    y: vault.from.y + (vault.to.y - vault.from.y) * lift,
    z: vault.from.z + (vault.to.z - vault.from.z) * pull,
  };
}

/** Sweep each animation step so changing terrain cannot push a player through a ceiling. */
export function stepVault(position, vault, dt, solidAt) {
  const elapsed = Math.min(VAULT_SECONDS, vault.elapsed + dt);
  for (let time = vault.elapsed; time < elapsed;) {
    time = Math.min(elapsed, time + 1 / 120);
    const point = vaultPoint(vault, time / VAULT_SECONDS);
    if (boxCollides(solidAt, point.x, point.y, point.z)) return false;
    Object.assign(position, point);
  }
  vault.elapsed = elapsed;
  return elapsed < VAULT_SECONDS;
}
