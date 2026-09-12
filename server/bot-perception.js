import { playerHitboxes } from '../shared/player-hitboxes.js';
import { pronePose } from '../shared/player-stance.js';
import { botDifficulty } from '../shared/bot-difficulty.js';
import { raycastVoxels } from '../shared/raycast.js';

const HALF_FOV = 55 * Math.PI / 180;
const TRACK_HALF_FOV = 65 * Math.PI / 180;
const HALF_VERTICAL_FOV = 50 * Math.PI / 180;

/** Current visual evidence only. Hidden positions never enter combat memory. */
export function observeBotTarget(observer, target, solidAt, smoke, now, tracking = false, difficulty = undefined) {
  const profile = botDifficulty(difficulty);
  const origin = [observer.x, observer.eyeY, observer.z];
  const dx = target.x - origin[0], dz = target.z - origin[2];
  const flat = Math.hypot(dx, dz);
  const distance = Math.hypot(flat, target.eyeY - origin[1]);
  const maxRange = profile.sightRange + (tracking ? 12 : 0);
  if (distance > maxRange) return null;

  const yaw = Math.atan2(-dx, -dz);
  const offAxis = Math.abs(Math.atan2(Math.sin(yaw - observer.yaw), Math.cos(yaw - observer.yaw)));
  const halfFov = tracking ? TRACK_HALF_FOV : HALF_FOV;
  if (flat > 0.01 && offAxis > halfFov) return null;

  // Sample actual combat volumes, including the rotated crouch/prone body.
  // Prefer the torso for aim; a head or shoulder peeking out still counts,
  // but offers much less visual evidence than an exposed body.
  const boxes = playerHitboxes(target);
  const torso = boxes.find(box => box.zone === 'torso');
  const head = boxes.find(box => box.zone === 'head');
  const hips = boxes.find(box => box.zone === 'hips');
  const shoulder = side => torso.center.map((v, axis) =>
    v + torso.basis[0][axis] * torso.half[0] * 0.85 * side);
  const samples = [
    [torso.center, 0.35], [head.center, 0.2], [hips.center, 0.15],
    [shoulder(-1), 0.15], [shoulder(1), 0.15],
  ];
  let exposure = 0;
  let aimPoint = null;
  for (const [point, weight] of samples) {
    const delta = point.map((v, axis) => v - origin[axis]);
    const length = Math.hypot(...delta);
    const pitch = Math.atan2(delta[1], Math.hypot(delta[0], delta[2]));
    if (Math.abs(pitch - observer.pitch) > HALF_VERTICAL_FOV
        || smoke.blocksSight(origin, point, now)
        || raycastVoxels(solidAt, ...origin, ...delta, length)) continue;
    exposure += weight;
    aimPoint ||= point;
  }
  if (!aimPoint) return null;

  const low = Math.max(target.crouch ? 0.45 : 0, pronePose(target.proneT));
  // Approximate projected body area with the three core combat volumes.
  // Their face projections can overlap, so this is a salience estimate, not
  // a pixel-perfect silhouette. Occluded samples reduce the visible fraction.
  const direction = [dx / (distance || 1), (target.eyeY - origin[1]) / (distance || 1), dz / (distance || 1)];
  const dot = axis => Math.abs(axis.reduce((sum, value, i) => sum + value * direction[i], 0));
  let bodyArea = 0;
  for (const box of [torso, head, hips]) {
    const [x, y, z] = box.half;
    bodyArea += 4 * (y * z * dot(box.basis[0]) + x * z * dot(box.basis[1]) + x * y * dot(box.basis[2]));
  }
  const visibleArea = bodyArea * exposure * (1 - 0.35 * low);
  const angularArea = visibleArea / Math.max(4, distance * distance);
  const peripheral = 1 - 0.55 * (offAxis / halfFov) ** 2;
  // Hazard per second. The square root compresses the distance falloff so a
  // visible player across a large arena is discoverable, with a longer wait.
  const detectionRate = Math.max(0.08, Math.min(5, 4 * Math.sqrt(angularArea / 0.001)))
    * peripheral * profile.recognition;
  const recognitionMs = profile.reactionMs + 1000 / detectionRate;
  return { aimPoint, exposure, distance, visibleArea, angularArea, detectionRate,
    reactionMs: profile.reactionMs, recognitionMs };
}

/** One exponential evidence threshold per sighting, independent of tick rate. */
export function recognitionThreshold(random) {
  return -Math.log(Math.max(1e-9, 1 - Math.max(0, Math.min(1 - 1e-9, random))));
}
