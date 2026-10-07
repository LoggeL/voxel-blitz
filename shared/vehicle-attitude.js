/**
 * Ground attitude: pitch and roll fitted to the voxel support under a ground
 * hull. The server feeds the result into colliders and mount poses; clients
 * may use it to tilt presentation (it is a pure function of the world).
 * Positive pitch raises the nose; positive roll raises the right side, both in
 * the renderer's YXZ convention used by vehicleLocalPoint.
 */
import { isSolidBlock } from './world/blocks.js';
import { vehicleDef } from './vehicle-defs.js';

export const GROUND_ATTITUDE_RULES = Object.freeze({ sampleFraction: 0.8, maxAngle: 0.45, rise: 1.6, fall: 3, scanTop: 128 });

const FRACTIONS = [-1, 0, 1];

/** Top surface height of the support column near `around`, or null. */
function supportHeight(getBlock, x, z, around) {
  const bx = Math.floor(x), bz = Math.floor(z);
  const top = Number.isFinite(around) ? Math.floor(around + GROUND_ATTITUDE_RULES.rise) : GROUND_ATTITUDE_RULES.scanTop;
  const bottom = Number.isFinite(around) ? Math.floor(around - GROUND_ATTITUDE_RULES.fall) : 0;
  for (let y = top; y >= Math.max(0, bottom); y--) if (isSolidBlock(getBlock(bx, y, bz))) return y + 1;
  return null;
}

/**
 * Fit a plane h = a + b*u + c*w to 3x3 support samples across the footprint
 * (u forward, w right). `y` (optional) is the hull's current height; without
 * it the scan starts at the top of the world. Missing samples are ignored.
 */
export function groundAttitude(getBlock, type, x, z, yaw, y = undefined) {
  const def = vehicleDef(type);
  if (!def || typeof getBlock !== 'function' || ![x, z, yaw].every(Number.isFinite)) return { pitch: 0, roll: 0 };
  const { halfWidth, halfLength } = def.collider, f = GROUND_ATTITUDE_RULES.sampleFraction;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
  let n = 0, su = 0, sw = 0, sh = 0, suu = 0, sww = 0, suw = 0, suh = 0, swh = 0;
  for (const i of FRACTIONS) for (const j of FRACTIONS) {
    const u = i * halfLength * f, w = j * halfWidth * f;
    const h = supportHeight(getBlock, x + fx * u + rx * w, z + fz * u + rz * w, y);
    if (h == null) continue;
    n++; su += u; sw += w; sh += h; suu += u * u; sww += w * w; suw += u * w; suh += u * h; swh += w * h;
  }
  if (n < 3) return { pitch: 0, roll: 0 };
  // Normal equations for [a b c]; solved by Cramer's rule on the 3x3 system.
  const m = [[n, su, sw], [su, suu, suw], [sw, suw, sww]], r = [sh, suh, swh];
  const det3 = q => q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0])
    + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const det = det3(m);
  if (Math.abs(det) < 1e-9) return { pitch: 0, roll: 0 };
  const column = k => m.map((row, i) => row.map((value, j) => j === k ? r[i] : value));
  const b = det3(column(1)) / det, c = det3(column(2)) / det;
  const limit = GROUND_ATTITUDE_RULES.maxAngle;
  return { pitch: Math.max(-limit, Math.min(limit, Math.atan(b))), roll: Math.max(-limit, Math.min(limit, Math.atan(c))) };
}
