import {
  ACCENT,
  AIR,
  BRICK,
  CONCRETE,
  GLASS,
  GROUND,
  METAL,
  PLANK,
  RUST,
  STONE,
  WOOD,
} from './blocks.js';
import { fillBox } from './flatmaps.js';

// Caldera salt: date seed + 1 (26/27/28 taken by sibling maps). No Math.random.
const SALT = 20260830;

/** Deterministic per-voxel noise in [0, 1), salted for Caldera. */
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

/** Brick mass with STONE weathering for large faces. */
export function masonryC(world, x0, y0, z0, x1, y1, z1, variance = 0.14) {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        world.setBlock(x, y, z, hashC(x, y, z) < variance ? STONE : BRICK);
      }
    }
  }
}

/** All Caldera setpieces: gate, vent, refinery, skybridges, dressing. */
export function addCalderaSetpieces(world) {
  buildObsidianGate(world);
  buildCentralVent(world);
  buildEmberRefinery(world);
  buildSkybridges(world);
  dressCaldera(world);
}

// ---------------------------------------------------------------------------
// Obsidian Gate: twin pylons flanking the site-A approach, tied by a lintel.
// ---------------------------------------------------------------------------

/** Twin BRICK pylons with a METAL lintel over the open gate throat. */
export function buildObsidianGate(world) {
  const T = GROUND;
  // Twin pylons; the throat between them (x22-29) stays open for play.
  masonryC(world, 19, T + 1, 46, 21, T + 6, 50, 0.12);
  masonryC(world, 30, T + 1, 46, 32, T + 6, 50, 0.12);
  // STONE quoins on the outer vertical edges.
  for (const [cx, cz] of [
    [19, 46],
    [21, 46],
    [19, 50],
    [21, 50],
    [30, 46],
    [32, 46],
    [30, 50],
    [32, 50],
  ]) {
    fillBox(world, cx, T + 1, cz, cx, T + 6, cz, STONE);
  }
  // CONCRETE caps, then the METAL lintel band tying the pylons overhead.
  fillBox(world, 19, T + 6, 46, 21, T + 6, 50, CONCRETE);
  fillBox(world, 30, T + 6, 46, 32, T + 6, 50, CONCRETE);
  fillBox(world, 19, T + 7, 46, 32, T + 7, 50, METAL);
  // ACCENT sconce pair on the inner faces, facing the throat.
  world.setBlock(21, T + 3, 48, ACCENT);
  world.setBlock(30, T + 3, 48, ACCENT);
  // GLASS slit windows high on the outer faces: single voxels embedded in
  // solid brick (BRICK below, CONCRETE cap above), never over weak bases.
  for (const z of [47, 49]) {
    world.setBlock(19, T + 5, z, GLASS);
    world.setBlock(32, T + 5, z, GLASS);
  }
  world.setBlock(20, T + 5, 46, GLASS);
  world.setBlock(31, T + 5, 50, GLASS);
}

// ---------------------------------------------------------------------------
// Central Vent: solid spire sealing the A-B sightline.
// ---------------------------------------------------------------------------

/**
 * Solid STONE/BRICK spire with a RUST/ACCENT ember crown. Center (64,48)
 * clears the (45,47)/(82,48) fun anchors by 18+ and blocks the A-B eye line.
 */
export function buildCentralVent(world) {
  const T = GROUND;
  masonryC(world, 62, T + 1, 46, 66, T + 8, 50, 0.2);
  for (const [cx, cz] of [
    [62, 46],
    [66, 46],
    [62, 50],
    [66, 50],
  ]) {
    fillBox(world, cx, T + 1, cz, cx, T + 8, cz, STONE);
  }
  // Ember crown: RUST cap on solid masonry with an ACCENT heart.
  fillBox(world, 62, T + 9, 46, 66, T + 9, 50, RUST);
  fillBox(world, 63, T + 9, 48, 65, T + 9, 48, ACCENT);
  world.setBlock(64, T + 9, 47, ACCENT);
  world.setBlock(64, T + 9, 49, ACCENT);
}

// ---------------------------------------------------------------------------
// Ember Refinery: RUST frame hall on the B deck with a safe glass clerestory.
// ---------------------------------------------------------------------------

const REFINERY_POSTS = [
  [98, 43],
  [102, 43],
  [107, 43],
  [98, 46],
  [107, 46],
  [98, 49],
  [107, 49],
  [98, 52],
  [102, 52],
  [107, 52],
];

/** RUST frame hall on the deck top (D = T+3) with chimneys and deck crates. */
export function buildEmberRefinery(world) {
  const D = GROUND + 3;
  // RUST frame posts; their D+4 tops double as caps (open sky between them).
  for (const [px, pz] of REFINERY_POSTS) {
    fillBox(world, px, D + 1, pz, px, D + 4, pz, RUST);
  }
  // Low RUST walls with west/east door gaps on the z47-48 axis.
  fillBox(world, 98, D + 1, 44, 98, D + 2, 46, RUST);
  fillBox(world, 98, D + 1, 49, 98, D + 2, 51, RUST);
  fillBox(world, 107, D + 1, 44, 107, D + 2, 46, RUST);
  fillBox(world, 107, D + 1, 49, 107, D + 2, 51, RUST);
  fillBox(world, 99, D + 1, 43, 106, D + 2, 43, RUST);
  fillBox(world, 99, D + 1, 52, 106, D + 2, 52, RUST);
  // GLASS clerestory: a single band resting on RUST with open sky above,
  // so blasting it never drops a load.
  fillBox(world, 99, D + 3, 43, 101, D + 3, 43, GLASS);
  fillBox(world, 103, D + 3, 43, 106, D + 3, 43, GLASS);
  fillBox(world, 99, D + 3, 52, 101, D + 3, 52, GLASS);
  fillBox(world, 103, D + 3, 52, 106, D + 3, 52, GLASS);
  fillBox(world, 98, D + 3, 44, 98, D + 3, 46, GLASS);
  fillBox(world, 98, D + 3, 49, 98, D + 3, 51, GLASS);
  fillBox(world, 107, D + 3, 44, 107, D + 3, 46, GLASS);
  fillBox(world, 107, D + 3, 49, 107, D + 3, 51, GLASS);
  // Free-standing ACCENT chimney stacks; nothing rests on them.
  fillBox(world, 99, D + 1, 44, 100, D + 6, 45, ACCENT);
  fillBox(world, 105, D + 1, 50, 106, D + 6, 51, ACCENT);
  // PLANK crate clusters against the side walls, clear of the site center.
  crateC(world, 99, 49);
  crateC(world, 105, 44);
}

/** 2x2 PLANK crate stack on the refinery deck. */
function crateC(world, x, z) {
  const D = GROUND + 3;
  fillBox(world, x, D + 1, z, x + 1, D + 1, z + 1, PLANK);
  world.setBlock(x, D + 2, z, PLANK);
}

// ---------------------------------------------------------------------------
// Skybridges: destructible GLASS walks past the vent, hung off CONCRETE posts.
// ---------------------------------------------------------------------------

const BRIDGE_XS = [52, 60, 68, 76];

/**
 * Two 1-wide GLASS walks at T+6 (z=40, z=56) with RUST curbs. The ends rest
 * on CONCRETE posts and a RUST arm ties each span back to the vent, so
 * destroying GLASS only removes the walk.
 */
export function buildSkybridges(world) {
  const T = GROUND;
  for (const z of [40, 56]) {
    for (const px of BRIDGE_XS) {
      fillBox(world, px, T + 1, z, px, T + 5, z, CONCRETE);
      fillBox(world, px, T + 5, z - 1, px, T + 5, z + 1, CONCRETE);
    }
    fillBox(world, 52, T + 6, z, 76, T + 6, z, GLASS);
    fillBox(world, 52, T + 6, z - 1, 76, T + 6, z - 1, RUST);
    fillBox(world, 52, T + 6, z + 1, 76, T + 6, z + 1, RUST);
  }
  // RUST support arms from the vent faces out to the bridge decks.
  fillBox(world, 64, T + 5, 40, 64, T + 5, 45, RUST);
  fillBox(world, 64, T + 5, 51, 64, T + 5, 56, RUST);
}

// ---------------------------------------------------------------------------
// Lava-crust dressing: ember veins, ash shrubs, pyres and supply stacks.
// ---------------------------------------------------------------------------

const FUN = [
  [12, 8],
  [36, 8],
  [64, 9],
  [92, 8],
  [115, 18],
  [115, 77],
  [92, 87],
  [64, 86],
  [36, 87],
  [12, 77],
  [45, 47],
  [82, 48],
];

function nearAnchor(x, z, r) {
  for (const [ax, az] of FUN) {
    if (Math.abs(x - ax) <= r && Math.abs(z - az) <= r) return true;
  }
  return false;
}

/** Lane corridors (bridge lanes + mid corridor) the dressing keeps clear of. */
function inLane(x, z) {
  if (z >= 38 && z <= 42) return true;
  if (z >= 54 && z <= 58) return true;
  if (x >= 33 && x <= 95 && z >= 43 && z <= 53) return true;
  return false;
}

/** Ember veins, ash shrubs, pyres and supply stacks in the off-lane crust. */
export function dressCaldera(world) {
  const T = GROUND;
  for (let z = 20; z <= 34; z++) {
    for (let x = 36; x <= 92; x++) {
      veinC(world, x, z);
      shrubC(world, x, z);
    }
  }
  for (let z = 62; z <= 76; z++) {
    for (let x = 36; x <= 92; x++) {
      veinC(world, x, z);
      shrubC(world, x, z);
    }
  }
  // WOOD pyre pillars with ACCENT ember tips, clear of lanes and anchors.
  for (const [px, pz] of [
    [40, 36],
    [88, 36],
    [40, 60],
    [88, 60],
  ]) {
    fillBox(world, px, T + 1, pz, px, T + 2, pz, WOOD);
    world.setBlock(px, T + 3, pz, ACCENT);
  }
  // PLANK supply stacks tucked into the crust bands.
  for (const [px, pz] of [
    [38, 64],
    [90, 64],
    [38, 32],
  ]) {
    fillBox(world, px, T + 1, pz, px + 1, T + 1, pz + 1, PLANK);
    world.setBlock(px, T + 2, pz, PLANK);
  }
}

/**
 * Flat 1-high ember vein: a floor recolor at y=T on flat CONCRETE ground,
 * so it can never block a lane by construction.
 */
function veinC(world, x, z) {
  const T = GROUND;
  if (nearAnchor(x, z, 3)) return;
  if (inLane(x, z)) return;
  if (world.getBlock(x, T, z) !== CONCRETE && world.getBlock(x, T, z) !== STONE) return;
  const h = hashC(x, 7, z);
  if (h < 0.05) world.setBlock(x, T, z, ACCENT);
  else if (h < 0.15) world.setBlock(x, T, z, RUST);
}

/**
 * Basalt rubble with an ember-rock tip on open ground deep in the off-lane
 * bands (4+ from any lane edge). STONE/RUST never chain-collapse, so the
 * dressing is strictly safer than foliage here.
 */
function shrubC(world, x, z) {
  const T = GROUND;
  if (nearAnchor(x, z, 4)) return;
  if (inLane(x, z)) return;
  if (world.getBlock(x, T, z) !== CONCRETE && world.getBlock(x, T, z) !== STONE) return;
  if (world.getBlock(x, T + 1, z) !== AIR) return;
  if (world.getBlock(x, T + 2, z) !== AIR) return;
  const h = hashC(x, 99, z);
  if (h >= 0.035) return;
  world.setBlock(x, T + 1, z, STONE);
  if (h < 0.012) world.setBlock(x, T + 2, z, RUST);
}
