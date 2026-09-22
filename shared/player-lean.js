import { raycastVoxels } from './raycast.js';

// Shared peek-lean contract for prediction, authority, hitboxes and presentation.
// Q/E roll the upper body about the hips so the head and the carried weapon
// clear a corner while the feet stay behind cover. `leanT` is signed: -1 is a
// full lean left, +1 a full lean right, in the body's own frame (right = +X).
export const LEAN = Object.freeze({
  roll: 0.44,       // rad upper-body roll at full lean (head moves ~0.30 m standing)
  viewRoll: 0.12,   // rad camera cant at full lean, kept well below the body roll
  inS: 0.22,        // s from upright to a full lean (and back)
  headClear: 0.16,  // m kept free beside the leaned eye so the camera never enters a wall
  pivot: 0.96,      // m hip pivot above the feet while standing
  head: 1.66,       // m head joint above the feet while standing
  crouchPivot: 0.2, // m the pivot drops while crouched
  crouchHead: 0.34, // m the head joint drops while crouched
});

const clampSigned = v => Math.max(-1, Math.min(1, Number(v) || 0));

/** Signed lean request from held keys: -1 left, +1 right, 0 both or neither. */
export function leanInput(keys) {
  return (keys?.leanRight ? 1 : 0) - (keys?.leanLeft ? 1 : 0);
}

/**
 * Lean is an upright, planted peek. Sprinting forward, prone, swimming,
 * vaulting, ladders and slide rides all hold the body square.
 */
export function leanBlocked({ sprint = false, forward = false, crouch = false, prone = false,
  swimming = false, vaulting = false, ladder = false, riding = false } = {}) {
  return (!!sprint && !!forward && !crouch) || !!prone || !!swimming || !!vaulting || !!ladder || !!riding;
}

/** Signed smoothstep of the lean progress. */
export function leanPose(value = 0) {
  const t = Math.abs(clampSigned(value));
  return Math.sign(value) * t * t * (3 - 2 * t);
}

/** Upper-body roll (rad about the body's forward axis, three.js convention). */
export function leanRoll(value = 0) {
  return -leanPose(value) * LEAN.roll;
}

/** Hip pivot and head joint heights (feet-relative, unscaled) for a stance. */
export function leanJoints(crouch = 0) {
  const c = Math.max(0, Math.min(1, Number(crouch) || 0));
  return { pivot: LEAN.pivot - LEAN.crouchPivot * c, head: LEAN.head - LEAN.crouchHead * c };
}

/**
 * Rotate a feet-relative body-frame point about the hip pivot by the lean.
 * Writes into `out` (may alias `point`) and returns it.
 */
export function leanBodyPoint(point, value, crouch = 0, out = [0, 0, 0]) {
  const roll = leanRoll(value);
  const { pivot } = leanJoints(crouch);
  const c = Math.cos(roll), s = Math.sin(roll);
  const x = point[0], y = point[1] - pivot, z = point[2];
  out[0] = x * c - y * s;
  out[1] = pivot + x * s + y * c;
  out[2] = z;
  return out;
}

/** Lateral (body right) and vertical eye displacement at a lean, unscaled. */
export function leanEyeShift(value, crouch = 0) {
  const { pivot, head } = leanJoints(crouch);
  const roll = leanPose(value) * LEAN.roll;
  const lever = head - pivot;
  return { side: Math.sin(roll) * lever, drop: lever * (1 - Math.cos(roll)) };
}

/** World-space eye offset for a body facing `yaw` (right = (cos yaw, 0, -sin yaw)). */
export function leanEyeOffset(value, yaw = 0, crouch = 0, scale = 1) {
  if (!value) return { x: 0, y: 0, z: 0 };
  const { side, drop } = leanEyeShift(value, crouch);
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { x: Math.cos(yaw) * side * s, y: -drop * s, z: -Math.sin(yaw) * side * s };
}

/**
 * Largest lean (0..1) toward `side` (-1/+1) that keeps `headClear` metres of
 * air beside the leaned eye, traced from the upright eye along body right.
 */
export function leanReach(solidAt, x, eyeY, z, yaw, side, crouch = 0, scale = 1) {
  if (typeof solidAt !== 'function' || !side) return 1;
  const size = scale > 0 ? scale : 1;
  const full = leanEyeShift(1, crouch).side * size;
  const dx = Math.cos(yaw) * side, dz = -Math.sin(yaw) * side;
  const hit = raycastVoxels(solidAt, x, eyeY, z, dx, 0, dz, full + LEAN.headClear);
  if (!hit) return 1;
  const room = Math.max(0, hit.t - LEAN.headClear);
  if (room >= full) return 1;
  // Invert the smoothed, rolled displacement so the clamp limits the real eye.
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (leanEyeShift(mid, crouch).side * size <= room) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Advance the signed lean toward `target` at a fixed rate, then clamp it to
 * the room available on each side (walls snap it back immediately).
 */
export function stepLean(value = 0, target = 0, dt = 0, reachLeft = 1, reachRight = 1) {
  const goal = target < 0 ? -reachLeft : target > 0 ? reachRight : 0;
  const step = Math.max(0, dt) / LEAN.inS;
  let next = clampSigned(value);
  next = next < goal ? Math.min(goal, next + step) : Math.max(goal, next - step);
  return Math.max(-reachLeft, Math.min(reachRight, next));
}

/**
 * One authoritative/predicted lean step. `body` supplies x, y, z, yaw, crouch,
 * scale and the upright eye height; `request` is the signed key input after
 * `leanBlocked` gating (0 when blocked).
 */
export function stepBodyLean(value, request, dt, solidAt, body) {
  const crouch = body.crouch ? 1 : 0;
  const scale = body.scale > 0 ? body.scale : 1;
  const reachLeft = value < 0 || request < 0
    ? leanReach(solidAt, body.x, body.eyeY, body.z, body.yaw, -1, crouch, scale) : 1;
  const reachRight = value > 0 || request > 0
    ? leanReach(solidAt, body.x, body.eyeY, body.z, body.yaw, 1, crouch, scale) : 1;
  return stepLean(value, request, dt, reachLeft, reachRight);
}
