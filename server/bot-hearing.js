// Bot hearing. Gunshots and hurried footsteps of enemies leave a position
// memory that the bot investigates when nothing is in sight. Shots are
// detected from the authoritative per-player shot counter, footsteps from
// grounded horizontal speed, so no event plumbing is needed: the bot tick
// runs before this tick's events exist, and the previous tick's list has
// already been flushed to clients.
//
// Ranges are in blocks through open air. Voxel occlusion between the two
// heads halves the range rather than silencing the sound; walls muffle,
// they do not mute. Pure math, no engine dependency.

import { raycastVoxels } from '../shared/raycast.js';

export const GUNSHOT_RANGE = 72;
export const SPRINT_STEP_RANGE = 18;
export const WALK_STEP_RANGE = 10;
export const OCCLUDED_FACTOR = 0.5;
const STEP_SPEED_MIN = 3.2;      // below this a body is creeping, not stepping

/** What a body is emitting this tick, or null when it is quiet. */
export function noiseOf(source, fired) {
  if (fired) return { kind: 'shot', range: GUNSHOT_RANGE };
  if (!source.grounded || source.crouch) return null;
  if (Math.hypot(source.vx || 0, source.vz || 0) < STEP_SPEED_MIN) return null;
  return { kind: 'step', range: source.sprint ? SPRINT_STEP_RANGE : WALK_STEP_RANGE };
}

/**
 * Whether `listener` hears `source` this tick.
 * @param {object} listener entity with x, eyeY, z
 * @param {object} source entity with x, y, eyeY, z, vx, vz, grounded, crouch, sprint
 * @param {boolean} fired the source fired since the listener last checked
 * @param {(x:number,y:number,z:number)=>number|null} solidAt voxel getter for occlusion
 * @param {number} rangeScale difficulty scaling of every range
 * @returns {{kind:'shot'|'step', distance:number, loudness:number, position:{x,y,z}}|null}
 */
export function hearNoise(listener, source, fired, solidAt, rangeScale = 1) {
  const noise = noiseOf(source, fired);
  if (!noise) return null;
  const dx = source.x - listener.x, dy = source.eyeY - listener.eyeY, dz = source.z - listener.z;
  const distance = Math.hypot(dx, dy, dz);
  let range = noise.range * rangeScale;
  if (distance > range) return null;
  if (distance > 0.01
      && raycastVoxels(solidAt, listener.x, listener.eyeY, listener.z, dx / distance, dy / distance, dz / distance, distance)) {
    range *= OCCLUDED_FACTOR;
    if (distance > range) return null;
  }
  return {
    kind: noise.kind,
    distance,
    loudness: 1 - distance / range,
    position: { x: source.x, y: source.y, z: source.z },
  };
}
