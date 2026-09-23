// Bikini Bottom: an undersea cartoon town on the 128x40x96 grid. Original
// procedural voxel work inspired by the show; no assets are copied and place
// names are only labels. Point-symmetric about P(x, z) = (127 - x, 95 - z):
// Krusty Krab (site A, west) faces the Chum Bucket (site B, east) across the
// Boating School, Conch Street runs north and Jellyfish Trail south.
//
// This module is the CORE owner (docs: map-spec §3): reef boundary, seafloor
// and road paint, outer-lane blockers, road conch sculptures, spawn-strip
// cover and the final recolour polish. The five region builders own every
// voxel above GROUND inside their rectangles.
import { mulberry32 } from '../noise.js';
import {
  AIR, GRASS, GROUND, PALE, SX, SY, SZ, STONE,
  BB_CORAL, BB_HULL, BB_KELP, BB_MOAI, BB_ROAD, BB_ROCK, BB_SAND,
} from './blocks.js';
import { fillBox, generateFlatBase, paintFloor } from './flatmaps.js';
import { MAP_LANDMARKS, MAP_SPAWN_ANCHORS } from './metadata.js';
import { BIKINI_BOTTOM_POWERUPS } from './bikini-bottom-data.js';
import { buildConchStreetHouses } from './setpiece-bikini-bottom-conch.js';
import { buildKrustyKrab } from './setpiece-bikini-bottom-krab.js';
import { buildBoatingSchool } from './setpiece-bikini-bottom-school.js';
import { buildChumBucket } from './setpiece-bikini-bottom-chum.js';
import { buildSouthQuarter } from './setpiece-bikini-bottom-south.js';

const T = GROUND;
const SALT = 20260922;

/** Per-voxel hash in [0, 1): clone of setpiece-caldera.js hashC with the core salt. */
function hashBB(x, y, z) {
  let h = (SALT ^ Math.imul(x + 1013, 0x27d4eb2f) ^ Math.imul(y + 7919, 0x9e3779b1) ^ Math.imul(z + 31337, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Inclusive box, heights relative to GROUND (h0/h1 are "T+n"). */
const tbox = (w, x0, h0, z0, x1, h1, z1, m) => fillBox(w, Math.min(x0, x1), T + Math.min(h0, h1), Math.min(z0, z1),
  Math.max(x0, x1), T + Math.max(h0, h1), Math.max(z0, z1), m);
const P = (x, z) => [127 - x, 95 - z];
/** tbox plus its exact point twin. */
function mbox(w, x0, h0, z0, x1, h1, z1, m) {
  tbox(w, x0, h0, z0, x1, h1, z1, m);
  const [a, b] = P(x0, z0);
  const [c, d] = P(x1, z1);
  tbox(w, a, h0, b, c, h1, d, m);
}

export function generateBikiniBottomInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  dressReefBoundary(world);
  paintSeafloor(world);
  buildOuterLanes(world);
  buildRoadSculptures(world);
  buildSpawnStrips(world);
  buildConchStreetHouses(world);
  buildKrustyKrab(world);
  buildBoatingSchool(world);
  buildChumBucket(world);
  buildSouthQuarter(world);
  polishBikiniBottom(world);
}

// Reef wall: only the inner METAL face cells are re-dressed; the shell
// footprint is unchanged. Smooth value noise over (along, rise) with a ragged
// per-voxel edge lays coral clusters and low blue-grey stone into the rock,
// so the wall never reads as ruler-straight bands; the pale sand line drifts
// between rise 1 and 2 and kelp ribbons stand in hash-picked columns.
function reefNoise(along, rise, side) {
  const u = along / 7, v = rise / 4;
  const i = Math.floor(u), j = Math.floor(v);
  const fu = u - i, fv = v - j;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
  const h = (a, b) => hashBB(a, b + 50, side + 90);
  const near = h(i, j) + (h(i + 1, j) - h(i, j)) * su;
  const far = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * su;
  return near + (far - near) * sv;
}
function dressReefBoundary(world) {
  const face = (x, z, along, side) => {
    const drift = hashBB(along >> 2, 1, side) < 0.4 ? 2 : 1;
    const kelpRoll = Math.min(hashBB(along, 0, side), hashBB(along - 1, 0, side) + 0.05);
    const kelpTop = kelpRoll < 0.07 ? 5 + Math.floor(hashBB(along, 2, side) * 10) : 0;
    for (let y = T + 1; y <= SY - 8; y++) {
      const rise = y - T;
      const n = reefNoise(along, rise, side) + 0.2 * (hashBB(x, y, z) - 0.5);
      let material = n > 0.8 ? BB_CORAL : n < 0.15 && rise <= 9 ? BB_MOAI : BB_ROCK;
      if (rise <= kelpTop && rise > drift) material = BB_KELP;
      if (rise <= drift) material = PALE;
      world.setBlock(x, y, z, material);
    }
  };
  for (let x = 2; x < SX - 2; x++) {
    face(x, 2, x, 0);
    face(x, SZ - 3, x, 1);
  }
  for (let z = 3; z < SZ - 3; z++) {
    face(2, z, z, 2);
    face(SX - 3, z, z, 3);
  }
}

// y = GROUND only: sand everywhere, Conch Street (north) and Jellyfish Trail
// (south) roads with pale centre dashes and crosswalks at the site entrances.
function paintSeafloor(world) {
  paintFloor(world, 3, 3, 124, 92, T, BB_SAND);
  paintFloor(world, 3, 28, 124, 33, T, BB_ROAD);
  paintFloor(world, 3, 62, 124, 67, T, BB_ROAD);
  for (let x = 3; x <= 124; x++) {
    if (x % 8 >= 4) continue;
    world.setBlock(x, T, 31, PALE);
    world.setBlock(x, T, 64, PALE);
  }
  const crosswalk = (x0, x1, rows) => {
    for (const z of rows) paintFloor(world, x0, z, x1, z, T, PALE);
  };
  crosswalk(24, 27, [28, 30, 32]);     // Krusty Krab back door
  crosswalk(100, 103, [28, 30, 32]);   // B north stair
  crosswalk(24, 27, [63, 65, 67]);     // Krusty Krab front
  crosswalk(100, 103, [63, 65, 67]);   // B south stair
  crosswalk(107, 109, [63, 65, 67]);   // B south-east stair
}

// Outer lanes x3-14 / x113-124: west side authored, every item point-twinned.
function buildOuterLanes(world) {
  // Kelp thicket: staggered 1x1 stalks, every x column has one, no sealed pockets.
  for (let x = 10; x <= 14; x++) {
    for (let z = 18; z <= 22; z++) {
      if (!((x % 2 === 0 && z % 4 === 0) || (x % 2 === 1 && z % 4 === 2))) continue;
      mbox(world, x, 1, z, x, 8, z, BB_KELP);
    }
  }
  // Reef boulder terraces step down toward the lane.
  mbox(world, 3, 1, 29, 4, 3, 33, BB_ROCK);
  mbox(world, 5, 1, 29, 6, 2, 33, BB_ROCK);
  mbox(world, 7, 1, 29, 8, 1, 33, BB_ROCK);
  // Giant clam: pale lower shell, coral upper shell, pearl.
  mbox(world, 5, 1, 48, 9, 1, 51, PALE);
  mbox(world, 5, 2, 48, 5, 6, 51, BB_CORAL);
  mbox(world, 6, 5, 48, 6, 6, 51, BB_CORAL);
  mbox(world, 7, 2, 49, 7, 2, 50, PALE);
  // Overturned rowboat with its keel.
  mbox(world, 9, 1, 62, 14, 1, 67, BB_HULL);
  mbox(world, 10, 2, 64, 13, 2, 65, BB_HULL);
  // Urchin mound with coral spikes.
  mbox(world, 3, 1, 74, 7, 1, 78, BB_CORAL);
  for (let x = 3; x <= 7; x++) {
    for (let z = 74; z <= 78; z++) {
      if ((x + z) % 3 === 0) mbox(world, x, 2, z, x, 5, z, BB_CORAL);
    }
  }
}

// Conch shells split both roads at the centre; every column top is >= T+4.
function buildRoadSculptures(world) {
  for (const [x0, z0, x1, z1] of [[60, 28, 62, 31], [65, 30, 67, 33]]) {
    for (const [a0, b0, a1, b1] of [[x0, z0, x1, z1], [127 - x1, 95 - z1, 127 - x0, 95 - z0]]) {
      tbox(world, a0, 1, b0, a1, 4, b1, PALE);
      tbox(world, a0, 2, b0, a1, 2, b1, BB_CORAL);
      tbox(world, a0 + 1, 5, b0 + 1, a1, 6, b1 - 1, PALE);
      tbox(world, a0 + 1, 7, b0 + 1, a0 + 1, 7, b0 + 1, BB_CORAL);
    }
  }
}

// Spawn strips z3-13 / z82-92: coral heads break the row sightlines, low tide
// rocks give crouch cover at the strip edges.
function buildSpawnStrips(world) {
  for (const x0 of [12, 27, 41, 58, 68, 85, 99]) {
    tbox(world, x0, 1, 7, x0 + 1, 4, 9, BB_CORAL);
    tbox(world, x0, 4, 7, x0 + 1, 4, 9, PALE);
    const a = 126 - x0;
    tbox(world, a, 1, 86, a + 1, 4, 88, BB_CORAL);
    tbox(world, a, 4, 86, a + 1, 4, 88, PALE);
  }
  for (const x0 of [26, 44, 80, 98]) {
    tbox(world, x0, 1, 12, x0 + 3, 1, 12, BB_ROCK);
    tbox(world, x0, 1, 83, x0 + 3, 1, 83, BB_ROCK);
  }
}

const inRect = (x, z, x0, z0, x1, z1) => x >= x0 && x <= x1 && z >= z0 && z <= z1;

// LAST: recolour-only pass on exposed sand and road at y = GROUND. It never
// adds height and keeps spawn, pad and landmark surroundings clean.
function polishBikiniBottom(world) {
  const anchors = MAP_SPAWN_ANCHORS.bikini_bottom;
  const spawnCells = [
    ...anchors.fun, ...anchors.tdm.alpha, ...anchors.tdm.bravo,
    ...anchors.snd.attackers, ...anchors.snd.defenders,
  ];
  const markCells = [
    ...BIKINI_BOTTOM_POWERUPS.map(([x, , z]) => [x, z]),
    ...MAP_LANDMARKS.bikini_bottom.map(({ x, z }) => [x, z]),
  ];
  const near = (cells, x, z, r) => cells.some(([ax, az]) => Math.max(Math.abs(x - ax), Math.abs(z - az)) <= r);
  const nearDash = (x, z) => {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (world.getBlock(x + dx, T, z + dz) === PALE) return true;
      }
    }
    return false;
  };
  const skip = (x, z) => near(spawnCells, x, z, 3) || near(markCells, x, z, 2);
  const exposed = (x, z, type) => world.getBlock(x, T, z) === type && world.getBlock(x, T + 1, z) === AIR;

  // Sand ripples outside the Jellyfish Fields and the Goo Lagoon beach.
  for (let z = 3; z <= 92; z++) {
    const shift = 2 * Math.round(3 * Math.sin(z * 0.35));
    for (let x = 3; x <= 124; x++) {
      if ((x + shift) % 7 !== 0 || !exposed(x, z, BB_SAND) || skip(x, z)) continue;
      if (inRect(x, z, 95, 68, 112, 81) || inRect(x, z, 31, 68, 47, 82)) continue;
      if (hashBB(x, T, z) < 0.5) world.setBlock(x, T, z, PALE);
    }
  }
  // Coral crumbs and sea-grass tufts on sand, loose stones on the road.
  const rng = mulberry32(SALT);
  for (let i = 0; i < 260; i++) {
    const x = 3 + ((rng() * (SX - 6)) | 0);
    const z = 3 + ((rng() * (SZ - 6)) | 0);
    const roll = rng();
    if (skip(x, z)) continue;
    if (exposed(x, z, BB_SAND)) {
      if (roll < 0.06) world.setBlock(x, T, z, BB_CORAL);
      else if (roll < 0.16) world.setBlock(x, T, z, GRASS);
    } else if (exposed(x, z, BB_ROAD) && !nearDash(x, z) && roll < 0.05) {
      world.setBlock(x, T, z, STONE);
    }
  }
}
