// Particle presets for the shared ParticleField. Each kind fixes its blend
// mode, atlas tile and motion; emit() params override per call. Values are
// presentation only: every emit is triggered by an authoritative event or a
// snapshot field (see vehicle-fx.js), never by client gameplay state.
//
// Fields:
//   blend    'alpha' (lit, fogged smoke and dust) or 'add' (emissive flashes)
//   tile     atlas tile: 0 soft puff, 1 billowing smoke, 2 hot glow, 3 chip
//   life     [min, max] seconds
//   size     [start, end] metres (scaled by params.scale)
//   speed    [min, max] initial speed along params.dir (or random if absent)
//   spread   cone half-angle around dir, radians (Math.PI = sphere)
//   gravity  m/s^2 on Y (negative falls, positive rises)
//   drag     exponential velocity decay per second
//   color0/1 linear RGB (HDR > 1 allowed for 'add'); alpha0/alpha1
//   streak   velocity-aligned stretch factor (sparks, tracer puffs)
//   spin     max angular speed, rad/s
//   ground   fade where the quad meets the emitter's ground plane
//   near     fade within 2.5 m of the camera (true for everything large)

export const FX_KINDS = Object.freeze(['dust', 'smoke', 'smokeColumn', 'fire', 'spark', 'debris', 'muzzle', 'exhaust', 'flare', 'water', 'ember', 'tracerPuff', 'grit']);

const preset = fields => Object.freeze({
  blend: 'alpha', tile: 0, life: [1, 1], size: [1, 1], speed: [0, 0], spread: Math.PI, gravity: 0, drag: 0,
  color0: [1, 1, 1], color1: [1, 1, 1], alpha0: 1, alpha1: 0, streak: 0, spin: 0.6, ground: false, near: true, jitter: 0,
  ...fields,
});

export const FX_PRESETS = Object.freeze({
  dust: preset({ tile: 0, life: [1.4, 2.6], size: [0.6, 2.4], speed: [0.6, 2.2], spread: 1.1, gravity: 0.25, drag: 1.6,
    color0: [0.55, 0.46, 0.34], color1: [0.62, 0.55, 0.45], alpha0: 0.55, alpha1: 0, ground: true, jitter: 0.25 }),
  smoke: preset({ tile: 1, life: [2.4, 4.2], size: [0.8, 3.6], speed: [0.6, 1.6], spread: 0.5, gravity: 1.1, drag: 0.8,
    color0: [0.16, 0.15, 0.14], color1: [0.32, 0.31, 0.3], alpha0: 0.7, alpha1: 0, jitter: 0.2 }),
  smokeColumn: preset({ tile: 1, life: [7, 10], size: [1.6, 7.5], speed: [1.6, 2.6], spread: 0.22, gravity: 0.7, drag: 0.25,
    color0: [0.09, 0.085, 0.08], color1: [0.27, 0.26, 0.25], alpha0: 0.62, alpha1: 0, near: true, jitter: 0.5 }),
  fire: preset({ blend: 'add', tile: 2, life: [0.35, 0.75], size: [0.9, 0.25], speed: [1.2, 3], spread: 0.45, gravity: 2.5, drag: 1.4,
    color0: [3.2, 1.25, 0.32], color1: [1.6, 0.32, 0.05], alpha0: 0.9, alpha1: 0, jitter: 0.3 }),
  spark: preset({ blend: 'add', tile: 2, life: [0.18, 0.45], size: [0.07, 0.03], speed: [6, 16], spread: 0.9, gravity: -14, drag: 0.6,
    color0: [4, 2.6, 1.1], color1: [2.4, 0.8, 0.2], alpha0: 1, alpha1: 0, streak: 0.045, near: false }),
  debris: preset({ tile: 3, life: [0.9, 1.8], size: [0.16, 0.12], speed: [3, 9], spread: 1, gravity: -16, drag: 0.4,
    color0: [0.2, 0.18, 0.16], color1: [0.16, 0.15, 0.13], alpha0: 1, alpha1: 0.6, spin: 9, near: false }),
  muzzle: preset({ blend: 'add', tile: 2, life: [0.05, 0.08], size: [1.4, 0.6], speed: [0, 0.5], spread: 0.2,
    color0: [5, 3.4, 1.5], color1: [3, 1.2, 0.3], alpha0: 1, alpha1: 0, near: false }),
  exhaust: preset({ tile: 0, life: [0.7, 1.3], size: [0.3, 1.3], speed: [1, 2.5], spread: 0.35, gravity: 0.8, drag: 1.5,
    color0: [0.2, 0.19, 0.18], color1: [0.42, 0.41, 0.4], alpha0: 0.32, alpha1: 0, jitter: 0.1 }),
  flare: preset({ blend: 'add', tile: 2, life: [2.6, 3.2], size: [1.1, 0.7], speed: [12, 20], spread: 0.5, gravity: -5, drag: 0.7,
    color0: [6, 4.6, 2.6], color1: [3.4, 1.4, 0.4], alpha0: 1, alpha1: 0.2, near: false }),
  water: preset({ tile: 0, life: [0.8, 1.6], size: [0.4, 1.8], speed: [2, 5], spread: 1.2, gravity: -5, drag: 1.2,
    color0: [0.78, 0.84, 0.88], color1: [0.86, 0.9, 0.92], alpha0: 0.5, alpha1: 0, ground: true, jitter: 0.2 }),
  ember: preset({ blend: 'add', tile: 2, life: [0.8, 2], size: [0.08, 0.03], speed: [1.5, 5], spread: 0.8, gravity: 2.2, drag: 0.9,
    color0: [3.6, 1.4, 0.25], color1: [1.8, 0.3, 0.04], alpha0: 1, alpha1: 0, streak: 0.02, near: false, jitter: 0.6 }),
  // Fine mortar and splinter dust trickling out of a creaking structure (structure-fx.js).
  grit: preset({ tile: 0, life: [0.8, 1.5], size: [0.18, 0.6], speed: [0.05, 0.35], spread: Math.PI, gravity: -3.6, drag: 1.6,
    color0: [0.66, 0.62, 0.56], color1: [0.7, 0.67, 0.62], alpha0: 0.75, alpha1: 0, spin: 1.2, jitter: 0.3 }),
  tracerPuff: preset({ blend: 'add', tile: 2, life: [0.12, 0.2], size: [0.5, 0.15], speed: [0, 0], spread: 0,
    color0: [4, 2.8, 1.2], color1: [2, 0.8, 0.2], alpha0: 0.8, alpha1: 0, near: false }),
});

/** Particle budget per graphics tier (2 draws at every tier). */
export const PARTICLE_CAPACITY = Object.freeze({ low: 2048, medium: 4096, high: 8192, ultra: 8192 });
export const particleCapacityForTier = tier => PARTICLE_CAPACITY[tier] ?? PARTICLE_CAPACITY.medium;

/** Ground-dust tint by block family (top surface under a wheel or blast). */
export const DUST_TINTS = Object.freeze({
  grass: [0.46, 0.44, 0.3], dirt: [0.47, 0.37, 0.26], sand: [0.74, 0.65, 0.48], rock: [0.52, 0.51, 0.5],
  snow: [0.88, 0.9, 0.93], mud: [0.33, 0.26, 0.19], asphalt: [0.38, 0.37, 0.36], wood: [0.45, 0.35, 0.24],
});
