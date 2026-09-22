// IRON PICK first-person hold and swing, after the Minecraft right-hand item
// pose: the pick rides diagonally at the lower right, head up and forward, and
// every swing is the snappy arm arc — a clear up-right lift with the head tipped
// back, a fast down-and-inward dip that is mostly screen-plane travel (a short
// chop about the diagonal wrist axis plus a counter-clockwise roll, so the head
// keeps its lit face), a beat at the bottom, then a sine-eased return.
// Pure math: the viewmodel, the third-person mount and the capture page all
// read the same keyframe table, so stills and tests name phases, not seconds.
import { HANDS } from '../../../shared/avatar-hands.js';
import { HIP } from './models/common.js';

// Carry: yawed ~60° and rolled back ~57° so the lit sprite face tilts up toward
// the key light, the stick rises ~57° up-left from the fist and both crescent
// points sit at about the same height, front point toward the crosshair side.
export const PICKAXE_CARRY_PITCH = 0.1;
export const PICKAXE_CARRY_YAW = 1.05;
export const PICKAXE_CARRY_ROLL = -1.0;
// Carry seat in view space (m): the fist ~0.74 m deep, so the whole item fits the
// lower-right quadrant (~28% of a 2:1 frame) with the fist just above the edge.
export const PICKAXE_CARRY_OFFSET = Object.freeze([0.526, 0.065, -0.413]);
// Narrow screens: the view keeps a fixed vertical FOV, so the desktop seat runs
// off the right edge of a portrait phone. Below this aspect the fist slides in
// toward the aim line, the item shrinks about the fist (the viewmodel thins the
// sleeve to match) and rolls a little counter-clockwise, keeping it ~40% of the
// screen width in the lower-right quadrant.
export const PICKAXE_FRAME_ASPECT = 1.15;
const FIST_ASPECT = 1.9;
const FRAME_ROLL = 0.30;
// One swing inside the 0.5 s (120 rpm) cadence leaves a short settled beat.
export const PICKAXE_SWING_SECONDS = 0.40;
// Normalised phase keys (fractions of PICKAXE_SWING_SECONDS).
export const PICKAXE_LIFT_AT = 0.12;     // anticipation: lift up-right, head tipped back ~11°
export const PICKAXE_STRIKE_AT = 0.32;   // the head crosses the aim point
export const PICKAXE_IMPACT_AT = 0.44;   // follow-through bottom, then recover
const REBOUND_SPAN = 0.18;

// [t, chop, yaw, roll, x, y, z]: chop turns about the diagonal wrist axis
// (positive lifts the head back, negative drives it down and inward), yaw/roll
// are view-space turns, xyz a view-space arm drift in metres.
const KEYS = Object.freeze([
  [0, 0, 0, 0, 0, 0, 0],
  [PICKAXE_LIFT_AT, 0.20, -0.08, 0.06, 0.050, 0.100, 0.010],
  [PICKAXE_STRIKE_AT, -0.25, 0, 0.20, -0.170, -0.060, -0.020],
  [PICKAXE_IMPACT_AT, -0.30, 0, 0.24, -0.190, -0.080, -0.020],
  [1, 0, 0, 0, 0, 0, 0],
]);
// Minecraft's swing axis: the view x axis yawed 45° toward the aim.
const AXIS = Object.freeze([Math.SQRT1_2, 0, -Math.SQRT1_2]);

const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));

/** Keyframe channels at `progress` (0..1), sine-eased between keys. */
export function pickaxeSwingChannels(progress) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  let i = 1;
  while (i < KEYS.length - 1 && p > KEYS[i][0]) i++;
  const a = KEYS[i - 1], b = KEYS[i];
  const e = ease((p - a[0]) / Math.max(1e-6, b[0] - a[0]));
  const at = (k) => a[k] + (b[k] - a[k]) * e;
  return { chop: at(1), yaw: at(2), roll: at(3), x: at(4), y: at(5), z: at(6) };
}

/** Wrist rebound after an accepted contact: `contact` is true or the progress it arrived at. */
export function pickaxeRebound(progress, contact) {
  if (contact === false || contact == null) return 0;
  // A contact confirmed too late for a full rebound (slow round trip) is dropped
  // rather than jolting the settle.
  const start = Math.max(PICKAXE_STRIKE_AT, contact === true ? PICKAXE_IMPACT_AT : Number(contact) || 0);
  if (start > 1 - REBOUND_SPAN) return 0;
  const u = (progress - start) / REBOUND_SPAN;
  return u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0;
}

const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qAxis = (x, y, z, angle) => { const s = Math.sin(angle / 2); return [x * s, y * s, z * s, Math.cos(angle / 2)]; };
// Euler 'XYZ' (three.js default order) <-> quaternion.
const qEuler = (x, y, z) => qMul(qMul(qAxis(1, 0, 0, x), qAxis(0, 1, 0, y)), qAxis(0, 0, 1, z));
function qRotate(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
function eulerXYZ(q) {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w), m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
  const ry = Math.asin(Math.max(-1, Math.min(1, m13)));
  return Math.abs(m13) < 0.9999999
    ? [Math.atan2(-m23, m33), ry, Math.atan2(-m12, m11)]
    : [Math.atan2(m32, m22), ry, 0];
}

const CARRY_Q = qEuler(PICKAXE_CARRY_PITCH, PICKAXE_CARRY_YAW, PICKAXE_CARRY_ROLL);

/** Narrow-screen framing: `x` scales the fist's view-space x, `s` the item about
 * the fist, `r` a counter-clockwise screen roll that keeps the stick diagonal once
 * the fist sits near the aim line (depth there projects straight up). */
export function pickaxeFraming(aspect) {
  const a = Number(aspect);
  if (!(a > 0)) return { x: 1, s: 1, r: 0 };
  const s = Math.max(0.35, Math.min(1, a / PICKAXE_FRAME_ASPECT));
  return { x: Math.min(1, a / FIST_ASPECT) * (0.75 + 0.25 * s), s, r: FRAME_ROLL * (1 - s) };
}

/**
 * Full knife content pose at `progress`: carry orientation composed with the
 * swing, as an Euler 'XYZ' plus the offset that keeps HANDS.knife.grip on its
 * carried spot while the view-space arm drift moves the fist. progress 0 and 1
 * are the settled carry. `aspect` (view width / height) reframes narrow
 * screens; `out.s` is the content scale about the fist (1 on desktop).
 */
export function pickaxeSwingPose(progress, contact = false, out = {}, aspect) {
  const c = pickaxeSwingChannels(progress);
  const kick = pickaxeRebound(progress, contact);
  const chop = c.chop + 0.34 * kick;
  const frame = pickaxeFraming(aspect);
  const swing = qMul(qMul(qAxis(0, 1, 0, c.yaw), qAxis(AXIS[0], AXIS[1], AXIS[2], chop)), qAxis(0, 0, 1, c.roll + frame.r));
  const q = qMul(swing, CARRY_Q);
  const g = [HANDS.knife.grip.x, HANDS.knife.grip.y, HANDS.knife.grip.z];
  const rest = qRotate(CARRY_Q, g), now = qRotate(q, g);
  const [rx, ry, rz] = eulerXYZ(q);
  const seat = PICKAXE_CARRY_OFFSET;
  out.x = rest[0] - now[0] + c.x + seat[0];
  out.y = rest[1] - now[1] + c.y + seat[1] + 0.02 * kick;
  out.z = rest[2] - now[2] + c.z + seat[2] + 0.03 * kick;
  out.rx = rx; out.ry = ry; out.rz = rz;
  out.s = frame.s;
  if (frame.x !== 1 || frame.s !== 1) {
    // Fist in view space, pulled toward the aim line; the item shrinks about it.
    const fx = (HIP.x + out.x + now[0]) * frame.x - HIP.x;
    out.x = fx - frame.s * now[0];
    out.y += (1 - frame.s) * now[1];
    out.z += (1 - frame.s) * now[2];
  }
  return out;
}

/**
 * Third-person overhead chop: pitch about the grip for a remote swing `seconds`
 * after it started (null/out of range = no swing). The lift reads bigger from
 * outside (remotes keep a ~0.63 rad overhead lift), the strike reaches ~0.99 rad
 * down, short of the carrier's own feet.
 */
export function pickaxeChopPitch(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= PICKAXE_SWING_SECONDS) return 0;
  const { chop } = pickaxeSwingChannels(seconds / PICKAXE_SWING_SECONDS);
  return chop > 0 ? chop * 3.15 : chop * 3.3;
}
