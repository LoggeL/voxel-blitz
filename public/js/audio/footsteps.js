// Footstep cadence shared by remote avatars and the local body.
//
// Remote avatars already animate a gait phase from their smoothed speed; a
// footfall is the forward extreme of each leg swing, so the sound lands in
// sync with the visible legs. The local body has no leg animation and runs
// its own phase with the same rate. Loudness grades from a brisk walk to a
// sprint; creeping, crouching, swimming and airborne bodies are silent, which
// mirrors what server bots can hear (server/bot-hearing.js).

import * as BLOCK from '../../../shared/world/blocks.js';
import { PHYSICS } from '../../../shared/player-movement.js';

export const FOOTSTEP_SURFACES = Object.freeze(['stone', 'wood', 'metal', 'grass', 'gravel', 'sand', 'cloth']);
export const FOOTSTEP_SLOTS = Object.freeze(Object.fromEntries(FOOTSTEP_SURFACES.map((surface) =>
  [surface, Object.freeze([1, 2, 3].map((variant) => `movement.footstep.${surface}.${variant}`))])));

const MATERIALS = new Map();
for (const [surface, names] of Object.entries({
  wood: ['WOOD', 'PLANK', 'DUST_CRATE', 'DUST_WOOD', 'YELLOW_SIDING', 'TEAL_SIDING',
    'MC_LOG', 'MC_PLANKS', 'MC_BOOKSHELF', 'MC_CHEST', 'MC_CRAFTING', 'MC_TNT'],
  metal: ['METAL', 'ACCENT', 'RUST', 'BUS_YELLOW', 'TRUCK_RED', 'MC_IRON', 'MC_GOLD', 'MC_DIAMOND', 'POOL_PANEL'],
  grass: ['GRASS', 'DIRT', 'LEAVES', 'MC_GRASS', 'MC_DIRT', 'MC_LEAVES', 'MC_CACTUS', 'MC_CLAY'],
  gravel: ['MC_GRAVEL'],
  sand: ['SAND', 'MC_SAND'],
  cloth: ['MC_WOOL_WHITE', 'MC_WOOL_RED', 'MC_CLOUD', 'BARRICADE'],
})) for (const name of names) MATERIALS.set(BLOCK[name], surface);

/** Hard paving, tile, glass and unknown solid materials share the stone bank. */
export function footstepMaterial(block) {
  return MATERIALS.get(block) || 'stone';
}

/** Probe the actual support voxel, including a foot planted over a ledge.
 * Body coordinates are at the feet. The probe matches solidBelow's footprint;
 * fluids and decorative ghost blocks cannot conceal the supporting surface. */
export function footstepSurfaceAt(getBlock, position) {
  if (typeof getBlock !== 'function' || !position
    || ![position.x, position.y, position.z].every(Number.isFinite)) return 'stone';
  const { x, y, z } = position;
  const half = PHYSICS.halfW - 1e-4;
  const cellY = Math.floor(y - 0.06);
  for (const [dx, dz] of [[0, 0], [-half, -half], [-half, half], [half, -half], [half, half]]) {
    const block = getBlock(Math.floor(x + dx), cellY, Math.floor(z + dz));
    if (Number.isInteger(block) && block > 0 && BLOCK.isSolidBlock(block)) return footstepMaterial(block);
  }
  return 'stone';
}

/** Independent variation per body: other players cannot change your next foot
 * or cause the same recording to repeat. Weak keys disappear with the body. */
export class FootstepVariations {
  constructor() {
    this.bodies = new WeakMap();
    this.local = { side: 1, last: {} };
  }

  next(surface = 'stone', body = null, random = Math.random) {
    if (!Object.hasOwn(FOOTSTEP_SLOTS, surface)) surface = 'stone';
    let state = this.local;
    if (body && typeof body === 'object') {
      state = this.bodies.get(body);
      if (!state) this.bodies.set(body, state = { side: 1, last: {} });
    }
    const slots = FOOTSTEP_SLOTS[surface];
    const previous = state.last[surface];
    const choices = slots.filter((slot) => slot !== previous);
    const slot = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
    state.last[surface] = slot;
    state.side = -state.side;
    return { slot, surface, rate: 0.975 + random() * 0.05,
      gain: 0.55 * (0.96 + random() * 0.08), pan: state.side * 0.1 };
  }
}

export const STEP_SPEED_MIN = 3.2;
export const SPRINT_SPEED = 6.2;
const WALK_VOLUME = 0.45;

/** Gait phase advance in rad/s for a body moving at `speed`, `air01` airborne. */
export function gaitPhaseRate(speed, air01 = 0) {
  return (5.2 + speed * 1.25) * (1 - air01 * 0.85);
}

/** Loudness in [0, 1] of a footfall under these motion conditions, 0 for none. */
export function footstepVolume({ speed = 0, grounded = true, crouch = false, swimming = false } = {}) {
  if (!grounded || crouch || swimming || !(speed >= STEP_SPEED_MIN)) return 0;
  const t = Math.max(0, Math.min(1, (speed - STEP_SPEED_MIN) / (SPRINT_SPEED - STEP_SPEED_MIN)));
  return WALK_VOLUME + (1 - WALK_VOLUME) * t;
}

/** Index of the stride a gait phase is in; changes once per footfall. */
export function strideIndex(phase) {
  return Math.floor((phase - Math.PI / 2) / Math.PI);
}

/** Whether a foot landed while the phase moved from `before` to `after`. */
export function strideCrossed(before, after) {
  return strideIndex(before) !== strideIndex(after);
}

/** Self-contained cadence for a body without a leg animation (the local player). */
export class FootstepCadence {
  constructor() {
    this.phase = 0;
  }

  /**
   * Advance by `dt` seconds and return the loudness of a footfall that landed
   * this frame, or 0.
   */
  update(dt, motion) {
    const speed = Number.isFinite(motion?.speed) ? motion.speed : 0;
    if (!(dt > 0) || speed < 0.2) return 0;
    // Wrap by a whole number of strides so precision holds over long sessions.
    if (this.phase > 1000 * Math.PI) this.phase -= 1000 * Math.PI;
    const before = this.phase;
    this.phase += dt * gaitPhaseRate(speed, motion?.grounded === false ? 1 : 0);
    return strideCrossed(before, this.phase) ? footstepVolume({ ...motion, speed }) : 0;
  }
}
