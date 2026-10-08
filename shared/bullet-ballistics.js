// Shared bullet ballistics for weapons whose round flies instead of arriving
// instantly (the LONGSHOT MK-II). One launch formula and one trajectory feed the
// authoritative flight (server/sim/combat.js), the shooter's streak, the remote
// presentation, the scope's holdover marks and the bots' holdover and lead.
//
// Model: constant muzzle speed, no drag, `gravity` m/s² straight down. The bore
// is tilted up by the zero angle, so the round climbs through the sight line,
// crosses it again at `zeroM` and falls below it beyond. Without drag the drop
// below the sight line grows linearly in milliradians with range:
//   holdover(R) ≈ 1000 · (g·R / (2v²) − tan θ0)  mil.

import { raycastVoxels } from './raycast.js';

/** Flight chord per authoritative step; the parabola sags < 1 mm over one chord. */
export const BALLISTIC_STEP_S = 1 / 60;

/** The ballistic profile of a weapon definition, or null for hitscan weapons. */
export function ballisticProfile(def) {
  const profile = def?.ballistic;
  return profile && profile.speed > 0 ? profile : null;
}

/** Bore elevation in radians that puts a level shot back on the sight line at `zeroM`. */
export function zeroAngle(profile, zeroM = profile?.zeroM) {
  if (!profile || !(zeroM > 0)) return 0;
  const s = profile.gravity * zeroM / (profile.speed * profile.speed);
  return s >= 1 ? Math.PI / 4 : 0.5 * Math.asin(s);
}

/**
 * Launch state for a round leaving `origin` ([x,y,z], the sight/eye point) along
 * the unit aim `dir` ({x,y,z}, spread already sampled). The bore is tilted up by
 * the zero angle inside the aim's vertical plane.
 * @returns {{x:number,y:number,z:number,vx:number,vy:number,vz:number}}
 */
export function ballisticLaunch(profile, origin, dir, zeroM = profile?.zeroM) {
  const flat = Math.hypot(dir.x, dir.z);
  const hx = flat > 1e-9 ? dir.x / flat : 0;
  const hz = flat > 1e-9 ? dir.z / flat : 0;
  const pitch = Math.atan2(dir.y, flat) + (flat > 1e-9 ? zeroAngle(profile, zeroM) : 0);
  const horizontal = Math.cos(pitch) * profile.speed;
  return {
    x: origin[0], y: origin[1], z: origin[2],
    vx: hx * horizontal,
    vy: Math.sin(pitch) * profile.speed,
    vz: hz * horizontal,
  };
}

/** Position `t` seconds into the flight (writes into `out`). */
export function ballisticPoint(profile, launch, t, out = { x: 0, y: 0, z: 0 }) {
  out.x = launch.x + launch.vx * t;
  out.y = launch.y + launch.vy * t - 0.5 * profile.gravity * t * t;
  out.z = launch.z + launch.vz * t;
  return out;
}

/**
 * Drop below the sight line, in milliradians, of a level shot at horizontal
 * range `rangeM` (negative while the round still rides above the line).
 */
export function holdoverMils(profile, rangeM, zeroM = profile?.zeroM) {
  if (!profile || !(rangeM > 0)) return 0;
  const theta = zeroAngle(profile, zeroM);
  const t = rangeM / (profile.speed * Math.cos(theta));
  const height = rangeM * Math.tan(theta) - 0.5 * profile.gravity * t * t;
  return -height / rangeM * 1000;
}

/** Seconds a level shot needs to cover `rangeM` horizontally. */
export function flightTimeS(profile, rangeM, zeroM = profile?.zeroM) {
  if (!profile || !(rangeM > 0)) return 0;
  return rangeM / (profile.speed * Math.cos(zeroAngle(profile, zeroM)));
}

/**
 * The sight-line pitch (radians) that drops the round onto a point `flat` metres
 * away horizontally and `dy` metres above the sight. The flat-fire (low) solution
 * minus the zero angle; null when the point is out of the round's reach.
 */
export function ballisticAimPitch(profile, flat, dy, zeroM = profile?.zeroM) {
  const x = Math.max(0.01, flat);
  const v2 = profile.speed * profile.speed;
  const g = profile.gravity;
  const disc = v2 * v2 - g * (g * x * x + 2 * dy * v2);
  if (disc < 0) return null;
  const launch = g > 0 ? Math.atan((v2 - Math.sqrt(disc)) / (g * x)) : Math.atan2(dy, x);
  return launch - zeroAngle(profile, zeroM);
}

/**
 * Sight-line yaw/pitch for hitting a target point that moves with `velocity`:
 * the point is led by the round's flight time (scaled by `leadScale`) and the
 * pitch holds over for the drop. Two fixed-point passes converge to well under
 * a centimetre at sniper ranges.
 */
export function ballisticIntercept(profile, origin, point, velocity = null, leadScale = 1) {
  let t = 0, aim = point;
  for (let pass = 0; pass < 3; pass++) {
    aim = [
      point[0] + (velocity?.[0] || 0) * t * leadScale,
      point[1] + (velocity?.[1] || 0) * t * leadScale,
      point[2] + (velocity?.[2] || 0) * t * leadScale,
    ];
    const flat = Math.hypot(aim[0] - origin[0], aim[2] - origin[2]);
    const pitch = ballisticAimPitch(profile, flat, aim[1] - origin[1]);
    const launch = (pitch ?? 0) + zeroAngle(profile);
    t = flat / Math.max(1e-6, profile.speed * Math.cos(launch));
  }
  const flat = Math.hypot(aim[0] - origin[0], aim[2] - origin[2]);
  return {
    yaw: Math.atan2(-(aim[0] - origin[0]), -(aim[2] - origin[2])),
    pitch: ballisticAimPitch(profile, flat, aim[1] - origin[1]),
    point: aim,
    flightTime: t,
  };
}

/**
 * Presentation flight: the round's path until its first voxel contact (or the
 * end of its flight time). Cheap enough for the client to run per shot.
 * @returns {{t:number, hit:object|null, end:{x:number,y:number,z:number}}}
 */
export function traceBallistic(profile, launch, solidAt, maxFlightS = profile.maxFlightS) {
  const step = BALLISTIC_STEP_S;
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
  ballisticPoint(profile, launch, 0, a);
  for (let t0 = 0; t0 < maxFlightS; t0 += step) {
    ballisticPoint(profile, launch, t0 + step, b);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const length = Math.hypot(dx, dy, dz);
    const hit = raycastVoxels(solidAt, a.x, a.y, a.z, dx, dy, dz, length);
    if (hit) {
      const f = length > 0 ? hit.t / length : 0;
      return { t: t0 + step * f, hit, end: { x: a.x + dx * f, y: a.y + dy * f, z: a.z + dz * f } };
    }
    if (b.y < -4) return { t: t0 + step, hit: null, end: { ...b } };
    a.x = b.x; a.y = b.y; a.z = b.z;
  }
  return { t: maxFlightS, hit: null, end: { ...a } };
}
