import { playerHitboxes } from '../shared/player-hitboxes.js';
import { pronePose } from '../shared/player-stance.js';
import { raycastVoxels } from '../shared/raycast.js';

const SIGHT_RANGE = 38;
const TRACK_RANGE = 42;
const HALF_FOV = 55 * Math.PI / 180;
const TRACK_HALF_FOV = 65 * Math.PI / 180;
const HALF_VERTICAL_FOV = 50 * Math.PI / 180;

/** Current visual evidence only. Hidden positions never enter combat memory. */
export function observeBotTarget(observer, target, solidAt, smoke, now, tracking = false) {
  const origin = [observer.x, observer.eyeY, observer.z];
  const dx = target.x - origin[0], dz = target.z - origin[2];
  const flat = Math.hypot(dx, dz);
  const distance = Math.hypot(flat, target.eyeY - origin[1]);
  const maxRange = tracking ? TRACK_RANGE : SIGHT_RANGE;
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
  const visibleRange = maxRange * (0.55 + 0.45 * exposure) * (1 - 0.2 * low);
  if (distance > visibleRange) return null;

  // Integrate evidence over time: distant, peripheral or mostly covered
  // players take longer to recognize. Even a close, exposed target gets a beat.
  const recognitionMs = 320 + 500 * (distance / SIGHT_RANGE) ** 2
    + 650 * (1 - exposure) + 180 * low + 220 * (offAxis / halfFov) ** 2;
  return { aimPoint, exposure, distance, recognitionMs };
}
