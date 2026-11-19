// Every half gait cycle plants a boot. Avatars and the first-person body use
// the same phase convention, with the left foot at +π/2. Walking loudness
// mirrors what server bots can hear (server/bot-hearing.js).

import * as BLOCK from '../../../shared/world/blocks.js';
import { PHYSICS } from '../../../shared/player-movement.js';

export const FOOTSTEP_SURFACES = Object.freeze(['stone', 'wood', 'metal', 'grass', 'gravel', 'sand', 'cloth']);
export const FOOTSTEP_SLOTS = Object.freeze(Object.fromEntries(FOOTSTEP_SURFACES.map((surface) =>
  [surface, Object.freeze([1, 2, 3].map((variant) => `movement.footstep.${surface}.${variant}`))])));

const MATERIALS = new Map();
for (const [surface, names] of Object.entries({
  wood: ['WOOD', 'PLANK', 'DUST_CRATE', 'DUST_WOOD', 'YELLOW_SIDING', 'TEAL_SIDING',
    'MC_LOG', 'MC_PLANKS', 'MC_BOOKSHELF', 'MC_CHEST', 'MC_CRAFTING', 'MC_TNT', 'BB_PINEAPPLE', 'BB_HULL', 'TIMBER', 'BIRCH_LOG'],
  metal: ['METAL', 'ACCENT', 'RUST', 'BUS_YELLOW', 'TRUCK_RED', 'MC_IRON', 'MC_GOLD', 'MC_DIAMOND', 'POOL_PANEL',
    'BB_CHUM', 'CORRUGATED_STEEL'],
  grass: ['GRASS', 'DIRT', 'LEAVES', 'MC_GRASS', 'MC_DIRT', 'MC_LEAVES', 'MC_CACTUS', 'MC_CLAY',
    'BB_PINE_LEAF', 'BB_KELP', 'MEADOW', 'DRY_GRASS', 'FIELD_WHEAT', 'MUD', 'SCORCHED_EARTH', 'PINE_NEEDLES', 'PINE_LEAVES'],
  gravel: ['MC_GRAVEL', 'GRAVEL'],
  sand: ['SAND', 'MC_SAND', 'BB_SAND'],
  cloth: ['MC_WOOL_WHITE', 'MC_WOOL_RED', 'MC_CLOUD', 'BARRICADE'],
})) for (const name of names) MATERIALS.set(BLOCK[name], surface);

/** Hard paving, tile, glass and unknown solid materials share the stone bank. */
export function footstepMaterial(block) {
  return MATERIALS.get(block) || 'stone';
}

/** Probe under the posed boot at physics floor height. When the boot hangs
 * off a ledge (or no pose is available), use the supporting body footprint. */
export function footstepSurfaceAt(getBlock, position, boot = null) {
  if (typeof getBlock !== 'function' || !position
    || ![position.x, position.y, position.z].every(Number.isFinite)) return 'stone';
  const { x, y, z } = position;
  const half = PHYSICS.halfW - 1e-4;
  const cellY = Math.floor(y - 0.06);
  if (Number.isFinite(boot?.x) && Number.isFinite(boot.z)) {
    const block = getBlock(Math.floor(boot.x), cellY, Math.floor(boot.z));
    if (Number.isInteger(block) && block > 0 && BLOCK.isSolidBlock(block)) return footstepMaterial(block);
  }
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
export function footstepVolume({ speed = 0, grounded = true, crouch = false, prone = false, swimming = false } = {}) {
  if (!grounded || crouch || prone || swimming || !(speed >= STEP_SPEED_MIN)) return 0;
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

// Ignore the small airborne corrections at seams. An ordinary jump (8.2 m/s
// at takeoff) lands partway up the scale, leaving room for a drop off a ledge.
const LANDING_MIN_SPEED = 1.5;
const LANDING_FULL_SPEED = 13;

/** Local ground contact, read by the legs, weapon and sound on the same frame. */
export class FootstepCadence {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = 0;
    this.side = -1;
    this.stepVolume = 0;
    this.landing = 0;
    this.wasGrounded = null;
    this.descentSpeed = 0;
  }

  /** Returns walking volume for audio-only callers (e.g. pilot wallrunning). */
  update(dt, motion = {}) {
    // On a shallow bottom the feet still walk, without a dry boot sound.
    if (motion.active === false || motion.vaulting || (motion.swimming && motion.grounded === false)) {
      this.reset();
      return 0;
    }
    this.stepVolume = this.landing = 0;
    if (!(dt > 0)) return 0;
    if (motion.grounded === false) {
      this.wasGrounded = false;
      // Standalone previews sample the last airborne speed. A cushion or
      // upward impulse can arrest a fall before the boots touch down.
      this.descentSpeed = Number.isFinite(motion.verticalVelocity) ? Math.max(0, -motion.verticalVelocity) : 0;
      return 0;
    }
    if (this.wasGrounded === false && !motion.swimming && !motion.prone) {
      const speed = motion.landingSpeed ?? this.descentSpeed;
      this.landing = Math.max(0, Math.min(1, (speed - LANDING_MIN_SPEED) / (LANDING_FULL_SPEED - LANDING_MIN_SPEED)));
    }
    this.wasGrounded = true;
    if (this.landing > 0) {
      // Resume walking from the planted boot, with a full step before the
      // other foot strikes. Landings get just one, centered, sound.
      const plant = Math.round((this.phase - Math.PI / 2) / Math.PI);
      this.phase = Math.PI / 2 + plant * Math.PI;
      this.side = plant % 2 === 0 ? -1 : 1;
      return 0;
    }
    const speed = Number.isFinite(motion.speed) ? motion.speed : 0;
    if (speed < 0.2) return 0;
    // Wrap by a whole number of strides so precision holds over long sessions.
    if (this.phase > 1000 * Math.PI) this.phase -= 1000 * Math.PI;
    const before = this.phase;
    this.phase += dt * gaitPhaseRate(speed);
    if (strideCrossed(before, this.phase)) {
      this.side = strideIndex(this.phase) % 2 === 0 ? -1 : 1;
      this.stepVolume = footstepVolume(motion);
    }
    return this.stepVolume;
  }
}
