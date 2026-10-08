// RX-8 HAVOC rangefinder: the distance to whatever sits under the launcher
// sight's aim point and the rocket's estimated impact for the current aim.
// Pure functions over injected world pickers so Node tests run them as-is.
//
// The world picker must ignore water like the authoritative rocket does
// (WorldView.pickSolidRay: only solid blocks stop the ray), so a lake between
// the shooter and the target never reads as the range.

import { ROCKET_RULES, ROCKET_SIGHT, ROCKET_FLIGHT_STEP_S, rocketLaunch, stepRocket } from '../../../shared/rocket-rules.js';
import { vehicleHullParts, rayHullPartSpan, solidHull } from '../../../shared/vehicle-collision.js';

const BODY_HALF = 0.4;
const BODY_HEIGHT = 1.85;

/** Entry distance of a ray into an axis-aligned box, or null. */
function rayBox(origin, dir, lo, hi, max) {
  let near = 0, far = max;
  for (let i = 0; i < 3; i++) {
    const o = origin[i], d = dir[i];
    if (Math.abs(d) < 1e-9) { if (o < lo[i] || o > hi[i]) return null; continue; }
    const a = (lo[i] - o) / d, b = (hi[i] - o) / d;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return near;
}

/** A hull that stops the rangefinder: live, or a ground wreck the server still collides with. */
function hullSolid(row) {
  return !!row && Number.isFinite(row.x) && Number.isFinite(row.y) && Number.isFinite(row.z) && solidHull(row);
}

/** Nearest vehicle hull along the ray (shared hull boxes), or null. */
export function hullRayDistance(hulls, origin, dir, max, ignoreVehicleId = null) {
  let best = null;
  for (const row of hulls || []) {
    if (!hullSolid(row) || (ignoreVehicleId != null && String(row.id) === String(ignoreVehicleId))) continue;
    const ox = row.x - origin[0], oy = row.y - origin[1], oz = row.z - origin[2];
    const along = ox * dir[0] + oy * dir[1] + oz * dir[2];
    if (along < -20 || along > max + 20 || ox * ox + oy * oy + oz * oz - along * along > 400) continue;
    let parts;
    try { parts = vehicleHullParts(row); } catch { continue; }
    for (const part of parts) {
      const span = rayHullPartSpan(part, origin, dir, max);
      if (span && span.near <= max && (best == null || span.near < best)) best = span.near;
    }
  }
  return best;
}

/** Nearest standing body (feet-anchored box) along the ray, or null. */
export function bodyRayDistance(bodies, origin, dir, max) {
  let best = null;
  for (const body of bodies || []) {
    if (!body || !Number.isFinite(body.x) || !Number.isFinite(body.y) || !Number.isFinite(body.z)) continue;
    const t = rayBox(origin, dir, [body.x - BODY_HALF, body.y, body.z - BODY_HALF],
      [body.x + BODY_HALF, body.y + BODY_HEIGHT, body.z + BODY_HALF], max);
    if (t != null && (best == null || t < best)) best = t;
  }
  return best;
}

/**
 * Rangefinder reading along a unit `dir` from the eye `origin` ({x,y,z} both).
 * `pickSolid(origin, dir, max)` returns the shared raycast hit ({t}) or null;
 * `hulls` are presented vehicle rows and `bodies` presented player rows (feet
 * positions; the caller leaves out the shooter, mates are fine to range).
 * @returns {{distance:number, target:'terrain'|'vehicle'|'player'}|null} null past `maxM`.
 */
export function rangefinderReading({ origin, dir, pickSolid = null, hulls = [], bodies = [],
  maxM = ROCKET_SIGHT.rangefinderMaxM, ignoreVehicleId = null } = {}) {
  if (!origin || !dir) return null;
  const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z];
  if (![...o, ...d].every(Number.isFinite)) return null;
  const length = Math.hypot(d[0], d[1], d[2]);
  if (!(length > 1e-9)) return null;
  for (let i = 0; i < 3; i++) d[i] /= length;
  const unit = { x: d[0], y: d[1], z: d[2] };
  let best = null;
  const terrain = pickSolid ? pickSolid(origin, unit, maxM) : null;
  if (terrain && Number.isFinite(terrain.t) && terrain.t <= maxM) best = { distance: terrain.t, target: 'terrain' };
  const reach = best ? best.distance : maxM;
  const hull = hullRayDistance(hulls, o, d, reach, ignoreVehicleId);
  if (hull != null && (!best || hull < best.distance)) best = { distance: hull, target: 'vehicle' };
  const body = bodyRayDistance(bodies, o, d, best ? best.distance : maxM);
  if (body != null && (!best || body < best.distance)) best = { distance: body, target: 'player' };
  return best;
}

/**
 * Where a rocket fired now along `dir` from the eye would end: the shared launch
 * and flight integrator (exactly the server's), stopped by solid terrain, a
 * hull or the lifetime. `airburst` marks a self-destruct in the open.
 * @returns {{point:number[], range:number, time:number, airburst:boolean}|null}
 */
export function rocketImpactEstimate({ origin, dir, pickSolid = null, hulls = [], ignoreVehicleId = null } = {}) {
  if (!origin || !dir || ![origin.x, origin.y, origin.z, dir.x, dir.y, dir.z].every(Number.isFinite)) return null;
  const rocket = rocketLaunch({ x: origin.x, y: origin.y, z: origin.z, dir });
  const raycast = (ox, oy, oz, dx, dy, dz, max) => (pickSolid
    ? pickSolid({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }, max) : null);
  const step = ROCKET_FLIGHT_STEP_S, life = ROCKET_RULES.lifetimeMs / 1000;
  for (let time = 0; time < life - 1e-9; time += step) {
    const from = [rocket.x, rocket.y, rocket.z];
    stepRocket(rocket, step, raycast);
    const delta = [rocket.x - from[0], rocket.y - from[1], rocket.z - from[2]];
    const length = Math.hypot(delta[0], delta[1], delta[2]);
    const hull = length > 0 ? hullRayDistance(hulls, from, delta.map(v => v / length), length, ignoreVehicleId) : null;
    if (hull != null) {
      const point = from.map((v, i) => v + delta[i] * hull / length);
      return { point, range: Math.hypot(point[0] - origin.x, point[2] - origin.z), time: time + step * hull / length, airburst: false };
    }
    if (rocket.hit) {
      const point = [rocket.x, rocket.y, rocket.z];
      return { point, range: Math.hypot(point[0] - origin.x, point[2] - origin.z), time: time + step, airburst: false };
    }
  }
  const point = [rocket.x, rocket.y, rocket.z];
  return { point, range: Math.hypot(point[0] - origin.x, point[2] - origin.z), time: life, airburst: true };
}

/**
 * Throttled sampler for the live sight: re-ranges at most every `intervalMs`
 * (ROCKET_SIGHT.sampleMs, 10 Hz) while the sight is up, keeps the last
 * return for ROCKET_SIGHT.memoryMs when the aim point loses it (flagged
 * `held`), and forgets everything the moment the sight drops. `input` (or a function returning it, so idle
 * frames build nothing) carries rangefinderReading / rocketImpactEstimate's
 * arguments.
 */
export class LauncherRangefinder {
  constructor({ intervalMs = ROCKET_SIGHT.sampleMs, memoryMs = ROCKET_SIGHT.memoryMs } = {}) {
    this.intervalMs = intervalMs;
    this.memoryMs = memoryMs;
    this.reset();
  }

  reset() {
    this._at = -Infinity;
    this._last = null;
    this._lastAt = -Infinity;
    this.reading = null;
    this.impact = null;
    this.samples = 0;
  }

  /** @returns {{reading:object|null, impact:object|null}|null} null while inactive. */
  sample(nowMs, active, input) {
    if (!active) {
      if (this.samples) this.reset();
      return null;
    }
    if (nowMs - this._at >= this.intervalMs) {
      this._at = nowMs;
      this.samples++;
      const args = typeof input === 'function' ? input() : input;
      const fresh = rangefinderReading(args);
      // Holding over a target usually puts the aim point on the sky behind it:
      // the last return stays on the readout (flagged `held`) for memoryMs.
      if (fresh) { this._last = fresh; this._lastAt = nowMs; }
      this.reading = fresh ?? (this._last && nowMs - this._lastAt <= this.memoryMs ? { ...this._last, held: true } : null);
      this.impact = rocketImpactEstimate(args);
    }
    return { reading: this.reading, impact: this.impact };
  }
}
