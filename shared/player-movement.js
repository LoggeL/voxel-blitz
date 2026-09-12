import { EYE_HEIGHT, GRAVITY, PLAYER_HALF } from './combatmath.js';
import { stepProne } from './player-stance.js';

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

export function boxCollides(solidAt, px, py, pz, height = P_HEIGHT) {
  const x0 = Math.floor(px - HALF_W + SHRINK), x1 = Math.floor(px + HALF_W - SHRINK);
  const y0 = Math.floor(py + SHRINK), y1 = Math.floor(py + height - SHRINK);
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

/** Stay low until the entire standing body fits, including at tunnel edges. */
export function stepPlayerProne(value = 0, target, dt, solidAt, position) {
  const blocked = value > 0 && !target && boxCollides(solidAt, position.x, position.y, position.z);
  return stepProne(value, target || blocked, dt);
}

/** Both ledge grabs and ladder movement need the player's hands. */
export function canClimb({ reloading = false, grenadeHandling = false, quickMelee = false,
  deploying = false, healing = false } = {}) {
  return !reloading && !grenadeHandling && !quickMelee && !deploying && !healing;
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
export function slidePlayerAxis(position, axis, amount, solidAt, height = P_HEIGHT) {
  if (!Number.isFinite(amount) || amount === 0) return false;
  const sign = amount < 0 ? -1 : 1;
  let remaining = Math.abs(amount);
  while (remaining > 1e-9) {
    const delta = Math.min(MAX_STEP, remaining) * sign;
    remaining -= Math.abs(delta);
    const before = position[axis];
    position[axis] += delta;
    if (!boxCollides(solidAt, position.x, position.y, position.z, height)) continue;
    if (axis === 'y') {
      const cell = Math.floor(sign > 0 ? position.y + height : position.y);
      position.y = sign > 0 ? cell - height - EPS : cell + 1;
    } else {
      const wall = Math.floor(position[axis] + sign * HALF_W);
      position[axis] = sign > 0 ? wall - HALF_W - EPS : wall + 1 + HALF_W + EPS;
    }
    if (boxCollides(solidAt, position.x, position.y, position.z, height)) position[axis] = before;
    return true;
  }
  return false;
}

export const VAULT_SECONDS = 0.48;
const VAULT_REACH = 2.05;

/** Airborne jump presses reach deliberately; forward jumps also keep their automatic grab. */
export function canStartVault(grounded, wantJump, forward, crouching, y, groundY) {
  return !crouching && (grounded ? wantJump && forward > 0
    : wantJump || (forward > 0 && Number.isFinite(groundY) && y > groundY + 0.1));
}

/**
 * Find a supported ledge within arm's reach. Automatic grabs use the takeoff
 * height as reachY; a fresh airborne jump press uses the current feet height.
 * Facing supplies a direction when the player releases the movement keys.
 * Ordinary one-block steps stay normal jumps. Deliberate airborne grabs pass
 * minRise=0 so a second jump press can still catch a low ledge while falling.
 */
export function findVault(solidAt, position, wish, reachY = position.y, yaw = null, minRise = 1) {
  if (!Number.isFinite(reachY)) return null;
  let dx = wish.x, dz = wish.z;
  const length = Math.hypot(dx, dz);
  if (length >= 0.5) { dx /= length; dz /= length; }
  else if (Number.isFinite(yaw)) { dx = -Math.sin(yaw); dz = -Math.cos(yaw); }
  else return null;
  const tx = position.x + dx * 0.95, tz = position.z + dz * 0.95;
  const maxTop = Math.floor(Math.min(reachY, position.y) + VAULT_REACH);
  for (let top = Math.floor(position.y + 0.1) + 1; top <= maxTop; top++) {
    if (top <= reachY + minRise + EPS) continue;
    if (!solidAt(Math.floor(tx), top - 1, Math.floor(tz)) ||
        boxCollides(solidAt, tx, top, tz)) continue;
    const vault = { from: { x: position.x, y: position.y, z: position.z }, to: { x: tx, y: top, z: tz }, elapsed: 0 };
    // Check the complete lift and pull path, including headroom above takeoff.
    let clear = true;
    for (let i = 0; i <= 20; i++) {
      const point = vaultPoint(vault, i / 20);
      if (boxCollides(solidAt, point.x, point.y, point.z)) { clear = false; break; }
    }
    if (clear) return vault;
  }
  return null;
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
