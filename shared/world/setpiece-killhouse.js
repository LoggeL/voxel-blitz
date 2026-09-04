import { mulberry32 } from '../noise.js';
import {
  ACCENT,
  AIR,
  CONCRETE,
  GROUND,
  METAL,
  PLANK,
  RUST,
  STONE,
} from './blocks.js';
import { fillBox } from './flatmaps.js';
import { MAP_SPAWN_ANCHORS } from './metadata.js';

// Killhouse salt: 20260831 is the flatmap scatter seed; 20260832 dresses the
// setpieces here. No Math.random anywhere.
const SALT = 20260832;

/** Deterministic per-voxel noise in [0, 1), salted for Killhouse. */
export function hashC(x, y, z) {
  let h =
    (SALT ^
      Math.imul(x + 1013, 0x27d4eb2f) ^
      Math.imul(y + 7919, 0x9e3779b1) ^
      Math.imul(z + 31337, 0x85ebca6b)) |
    0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Fixed contract anchors (shared/world contract): fun + tdm.alpha + tdm.bravo.
// Every scatter/dressing guard below walks this list with a Chebyshev test.
export const KILLHOUSE_ANCHOR_CELLS = [
  ...MAP_SPAWN_ANCHORS.killhouse.fun,
  ...MAP_SPAWN_ANCHORS.killhouse.tdm.alpha,
  ...MAP_SPAWN_ANCHORS.killhouse.tdm.bravo,
];

/**
 * Dummy post cells, index = dummy bot id dummy-<i>: 9 firing-range posts then
 * 8 course stage posts. Mirrors MAP_DUMMY_POSTS.killhouse; each cell must
 * stay standable (solid below, 2 air above), so guards keep them clear.
 */
export const KILLHOUSE_DUMMY_POSTS = [
  { kind: 'range', x: 18, z: 74 },
  { kind: 'range', x: 34, z: 74 },
  { kind: 'range', x: 54, z: 74 },
  { kind: 'range', x: 74, z: 74 },
  { kind: 'range', x: 94, z: 74 },
  { kind: 'range', x: 114, z: 74 },
  { kind: 'range', x: 34, z: 64 },
  { kind: 'range', x: 94, z: 64 },
  { kind: 'range', x: 64, z: 58 },
  { kind: 'stage', stage: 0, x: 16, z: 32 },
  { kind: 'stage', stage: 0, x: 34, z: 42 },
  { kind: 'stage', stage: 1, x: 46, z: 30 },
  { kind: 'stage', stage: 1, x: 66, z: 44 },
  { kind: 'stage', stage: 2, x: 76, z: 44 },
  { kind: 'stage', stage: 2, x: 96, z: 30 },
  { kind: 'stage', stage: 3, x: 104, z: 30 },
  { kind: 'stage', stage: 3, x: 115, z: 42 },
];

/** Start/finish pad rects as [minX, minZ, maxX, maxZ]. */
const PAD_RECTS = [
  [12, 48, 17, 53],
  [112, 36, 116, 40],
];

/**
 * Single source of truth for both dressing guards (setpiece + flatmap
 * scatter): Chebyshev ring around every anchor cell, every dummy post, both
 * pads, the lane dividers, the firing-line band and the whole course.
 */
export function isKillhouseProtected(x, z) {
  for (const [ax, az] of KILLHOUSE_ANCHOR_CELLS) {
    if (Math.max(Math.abs(x - ax), Math.abs(z - az)) <= 3) return true;
  }
  for (const post of KILLHOUSE_DUMMY_POSTS) {
    if (Math.max(Math.abs(x - post.x), Math.abs(z - post.z)) <= 2) return true;
  }
  for (const [x0, z0, x1, z1] of PAD_RECTS) {
    if (x >= x0 - 1 && x <= x1 + 1 && z >= z0 - 1 && z <= z1 + 1) return true;
  }
  // Lane dividers x24/44/84/104, z74-83, with one shoulder each side.
  if (z >= 74 && z <= 83) {
    for (const dx of [24, 44, 84, 104]) {
      if (Math.abs(x - dx) <= 1) return true;
    }
  }
  // Course interior + walls (z27-47, x9-118) stay pristine contract cover.
  if (x >= 9 && x <= 118 && z >= 27 && z <= 47) return true;
  // PALE firing-line band.
  if (z >= 82 && z <= 83) return true;
  return false;
}

/**
 * All Killhouse setpieces: gallery, back wall, dividers, berm, course, range
 * dressing. The back wall runs after the gallery roof so the shared y18/z88
 * plane stays CONCRETE (load-bearing bone beats PLANK trim).
 */
export function addKillhouseSetpieces(world) {
  buildGallery(world);
  buildBackWall(world);
  buildLaneDividers(world);
  buildBerm(world);
  buildCourse(world);
  dressRange(world);
}

// ---------------------------------------------------------------------------
// Range hall: METAL 2x2 gallery posts (x20-21/64-65/108-109, z86-87) carrying
// a PLANK roof deck at y18 over z84-88, weapon racks (PLANK y15 + ACCENT
// y16) at z86 under the roof, CONCRETE back wall (z88, y15-18), and PLANK
// lane dividers (x24/44/84/104, z74-83, y15-16).
// ---------------------------------------------------------------------------

const GALLERY_POSTS = [
  [20, 86],
  [64, 86],
  [108, 86],
];

/** Gallery posts + PLANK roof deck + weapon racks. */
export function buildGallery(world) {
  const T = GROUND;
  for (const [px, pz] of GALLERY_POSTS) {
    fillBox(world, px, T + 1, pz, px + 1, T + 3, pz + 1, METAL);
  }
  // Roof deck at y18; the back wall re-caps the z88 top row afterwards.
  fillBox(world, 8, T + 4, 84, 120, T + 4, 88, PLANK);
  // Weapon racks: PLANK shelf y15 + ACCENT trim y16; METAL posts win cells.
  for (const [x0, x1] of [[30, 33], [62, 65], [94, 97]]) {
    for (let x = x0; x <= x1; x++) {
      if (world.getBlock(x, T + 1, 86) === METAL) continue;
      world.setBlock(x, T + 1, 86, PLANK);
      world.setBlock(x, T + 2, 86, ACCENT);
    }
  }
}

/** Solid CONCRETE back wall closing the range at z88. */
export function buildBackWall(world) {
  const T = GROUND;
  fillBox(world, 8, T + 1, 88, 120, T + 4, 88, CONCRETE);
}

/** Lane dividers: PLANK y15-16 posts splitting the range into lanes at
 * x24/44/84/104, running z74-83 across the firing line.
 */
export function buildLaneDividers(world) {
  const T = GROUND;
  for (const dx of [24, 44, 84, 104]) {
    fillBox(world, dx, T + 1, 74, dx, T + 2, 83, PLANK);
  }
}

// ---------------------------------------------------------------------------
// Berm: CONCRETE y15-17 across z55-56, x8-120, with the x12-17 entry gap so
// players walk from the yard through to the firing line.
// ---------------------------------------------------------------------------

export function buildBerm(world) {
  const T = GROUND;
  fillBox(world, 8, T + 1, 55, 11, T + 3, 56, CONCRETE);
  fillBox(world, 18, T + 1, 55, 120, T + 3, 56, CONCRETE);
}

// ---------------------------------------------------------------------------
// Course: CONCRETE walls y15-18 around interior x10-117 z28-46 (z27 full,
// z47 with the x13-16 door gap, west x9, east x118), METAL gates sealing
// x40/70/100, and the contract room cover. Gate and stage-post cells stay
// clear of cover by construction.
// ---------------------------------------------------------------------------

const COURSE_GATES = [40, 70, 100];

/** Room cover: [minX, maxX, minZ, maxZ] CONCRETE baffles, y15-16. */
const COURSE_BAFFLES = [
  [22, 23, 33, 40], // R1
  [50, 51, 30, 36], // R2
  [58, 59, 38, 44], // R2
  [80, 81, 38, 44], // R3
  [88, 89, 30, 36], // R3
  [108, 109, 32, 40], // R4
];

/** Room cover: [minX, maxX, minZ, maxZ] 2x2 PLANK crates, y15-16. */
const COURSE_CRATES = [
  [30, 31, 36, 37], // R1
  [64, 65, 32, 33], // R2
  [76, 77, 40, 41], // R3
  [112, 113, 34, 35], // R4
];

export function buildCourse(world) {
  const T = GROUND;
  // Perimeter walls, y15-18.
  fillBox(world, 9, T + 1, 27, 118, T + 4, 27, CONCRETE);
  fillBox(world, 9, T + 1, 47, 12, T + 4, 47, CONCRETE);
  fillBox(world, 17, T + 1, 47, 118, T + 4, 47, CONCRETE);
  fillBox(world, 13, T + 4, 47, 16, T + 4, 47, CONCRETE); // door lintel
  fillBox(world, 9, T + 1, 28, 9, T + 4, 46, CONCRETE);
  fillBox(world, 118, T + 1, 28, 118, T + 4, 46, CONCRETE);
  // METAL gates: every (gx, y15-17, z28-46) cell; policy removes them.
  for (const gx of COURSE_GATES) {
    fillBox(world, gx, T + 1, 28, gx, T + 3, 46, METAL);
  }
  for (const [x0, x1, z0, z1] of COURSE_BAFFLES) {
    fillBox(world, x0, T + 1, z0, x1, T + 2, z1, CONCRETE);
  }
  for (const [x0, x1, z0, z1] of COURSE_CRATES) {
    fillBox(world, x0, T + 1, z0, x1, T + 2, z1, PLANK);
  }
}

// ---------------------------------------------------------------------------
// Range dressing: brass speckle, scorch, barrels, crate debris and cones on
// the open range floor only (z57-81). Guarded by isKillhouseProtected;
// grenade-soft blocks only (ACCENT/PLANK/STONE/RUST), never heights[].
// ---------------------------------------------------------------------------

export function dressRange(world) {
  const T = GROUND;
  const rng = mulberry32(20260832);
  for (let z = 57; z <= 81; z++) {
    for (let x = 8; x <= 120; x++) {
      if (isKillhouseProtected(x, z)) continue;
      const floor = world.getBlock(x, T, z);
      if (floor !== CONCRETE && floor !== STONE) continue;
      // Flat spent-brass / scorch recolor first: never blocks a lane.
      const h = hashC(x, 5, z);
      if (h < 0.05) {
        world.setBlock(x, T, z, ACCENT);
        continue;
      }
      if (h < 0.1) {
        world.setBlock(x, T, z, RUST);
        continue;
      }
      if (world.getBlock(x, T + 1, z) !== AIR) continue;
      if (world.getBlock(x, T + 2, z) !== AIR) continue;
      const p = rng();
      if (p < 0.006) {
        // RUST barrel, sometimes stacked two high.
        world.setBlock(x, T + 1, z, RUST);
        if (hashC(x, 11, z) < 0.5) world.setBlock(x, T + 2, z, RUST);
      } else if (p < 0.012) {
        world.setBlock(x, T + 1, z, PLANK); // crate debris
      } else if (p < 0.018) {
        world.setBlock(x, T + 1, z, ACCENT); // traffic cone
      }
    }
  }
}
