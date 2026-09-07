import {
  ACCENT,
  AIR,
  BRICK,
  CONCRETE,
  GLASS,
  GROUND,
  METAL,
  PALE,
  PLANK,
  RUST,
  STONE,
  WOOD,
} from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';

// Caldera salt: date seed + 1 (26/27/28 taken by sibling maps). No Math.random.
const SALT = 20260830;

/** Deterministic per-voxel noise in [0, 1), salted for Caldera. */
function hashC(x, y, z) {
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
function masonryC(world, x0, y0, z0, x1, y1, z1, variance = 0.14) {
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
  buildCoolingStations(world);
  dressRefineryDetails(world);
  buildMainReactor(world);
  buildPlantInfrastructure(world);
}

/** A cylindrical reactor, cooling fins and exhaust replace the small vent. */
function buildMainReactor(world) {
  const T = GROUND;
  for (let rise = 1; rise <= 18; rise++) {
    const radius = rise <= 15 ? 5 : 20 - rise;
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dz * dz > radius * radius + 3) continue;
      const band = rise === 1 || rise === 5 || rise === 10 || rise === 15;
      world.setBlock(64 + dx, T + rise, 48 + dz, band ? METAL : CONCRETE);
    }
  }
  // Recessed inspection windows in front and rear of the filled vessel.
  for (const z of [43, 53]) {
    fillBox(world, 62, T + 7, z, 66, T + 9, z, GLASS);
    fillBox(world, 62, T + 7, z === 43 ? 44 : 52, 66, T + 9, z === 43 ? 44 : 52, ACCENT);
  }
  for (const [x, z] of [[57, 44], [57, 50], [70, 44], [70, 50]]) {
    fillBox(world, x, T + 1, z, x + 1, T + 12, z + 1, METAL);
    fillBox(world, x, T + 4, z, x + 1, T + 8, z + 1, RUST);
  }
  fillBox(world, 63, T + 19, 47, 65, T + 23, 49, RUST);
  fillBox(world, 62, T + 24, 46, 66, T + 24, 50, METAL);
  fillBox(world, 63, T + 24, 47, 65, T + 24, 49, STONE);
}

/** Accessible service decks, large pipe trunks and paired refinery stacks. */
function buildPlantInfrastructure(world) {
  const T = GROUND;
  for (const [cx, cz] of [[45, 31], [83, 65]]) {
    for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
      if (Math.abs(dx) <= 4 && Math.abs(dz) <= 4) continue;
      world.setBlock(cx + dx, T + 5, cz + dz, METAL);
      if (Math.abs(dx) === 8 || Math.abs(dz) === 8) world.setBlock(cx + dx, T + 6, cz + dz, RUST);
    }
    for (const x of [cx - 8, cx + 8]) for (const z of [cz - 8, cz + 8]) fillBox(world, x, T + 1, z, x, T + 4, z, CONCRETE);
  }
  // Three-wide stairs open directly onto the tank service decks.
  for (let x = 30; x <= 37; x++) fillBox(world, x, T + 1, 29, x, T + Math.min(5, Math.floor((x - 29) / 2) + 1), 31, PALE);
  fillBox(world, 37, T + 6, 29, 37, T + 6, 31, AIR);
  for (let x = 92; x <= 99; x++) fillBox(world, x, T + 1, 65, x, T + Math.min(5, Math.floor((100 - x) / 2) + 1), 67, PALE);
  fillBox(world, 91, T + 6, 65, 91, T + 6, 67, AIR);
  // A three-wide service bridge makes the west aqueduct spawn reachable
  // from the new stairs instead of leaving that high deck accessible by drop only.
  fillBox(world, 44, T + 5, 39, 46, T + 5, 46, METAL);
  fillBox(world, 44, T + 6, 39, 46, T + 6, 39, AIR);
  fillBox(world, 44, T + 1, 43, 44, T + 4, 43, CONCRETE);
  // Two thick supported pipe runs pass well above the ground rotations.
  for (const [x0, x1, z] of [[45, 64, 31], [64, 83, 65]]) {
    fillBox(world, x0, T + 11, z, x1, T + 12, z + 1, METAL);
    for (let x = x0 + 3; x < x1; x += 6) fillBox(world, x, T + 10, z - 1, x, T + 13, z + 2, RUST);
  }
  fillBox(world, 64, T + 11, 32, 65, T + 12, 43, METAL);
  fillBox(world, 64, T + 11, 53, 65, T + 12, 64, METAL);
  for (const [x, z] of [[54, 31], [74, 65], [64, 36], [64, 60]]) fillBox(world, x, T + 1, z, x, T + 10, z, CONCRETE);
  // Twin striped stacks occupy opposite refinery-deck corners, outside B.
  for (const [cx, cz] of [[92, 38], [109, 59]]) {
    for (let rise = 1; rise <= 18; rise++) {
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        world.setBlock(cx + dx, T + 3 + rise, cz + dz, rise % 6 < 2 ? METAL : PALE);
      }
    }
    fillBox(world, cx - 2, T + 22, cz - 2, cx + 2, T + 22, cz + 2, RUST);
    fillBox(world, cx - 1, T + 22, cz - 1, cx + 1, T + 22, cz + 1, STONE);
  }
}

/** Paired faceted cooling vessels turn the bare crust shoulders into a plant. */
function buildCoolingStations(world) {
  const T = GROUND;
  for (const [cx, cz, direction] of [[45, 31, 1], [83, 65, -1]]) {
    paintFloor(world, cx - 5, cz - 5, cx + 5, cz + 5, T, CONCRETE);
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (dx * dx + dz * dz > 19) continue;
        for (let rise = 1; rise <= 9; rise++) {
          world.setBlock(cx + dx, T + rise, cz + dz, rise === 1 || rise === 5 || rise === 9 ? METAL : PALE);
        }
        world.setBlock(cx + dx, T + 10, cz + dz, CONCRETE);
      }
    }
    // Raised exhaust is carried by the filled tank, with a warm open mouth.
    fillBox(world, cx, T + 11, cz, cx, T + 12, cz, RUST);
    world.setBlock(cx, T + 13, cz, ACCENT);
    // Side instrument panel occupies the vessel wall, not the approach.
    world.setBlock(cx, T + 7, cz + 4 * direction, GLASS);
    world.setBlock(cx, T + 8, cz + 4 * direction, GLASS);
    // Recessed coolant conduits connect the vessels to the vent. They cross
    // movement lanes as floor inlays, with no overhead or ankle obstruction.
    const x0 = Math.min(cx, 64), x1 = Math.max(cx, 64);
    for (let x = x0; x <= x1; x++) world.setBlock(x, T, cz, METAL);
    for (let z = Math.min(cz, 48); z <= Math.max(cz, 48); z++) world.setBlock(64, T, z, METAL);
    for (let x = cx - 3; x <= cx + 3; x++) {
      world.setBlock(x, T, cz - 3, x % 2 === 0 ? RUST : PALE);
      world.setBlock(x, T, cz + 3, x % 2 === 0 ? RUST : PALE);
    }
  }
}

/** Equipment cladding and thermal seams give the existing silhouettes scale. */
function dressRefineryDetails(world) {
  const T = GROUND, D = T + 3;
  // Segmented vent seams stay in solid masonry, with no new lane collision.
  for (let y = T + 2; y <= T + 8; y++) {
    world.setBlock(64, y, 46, y % 3 === 0 ? ACCENT : RUST);
    world.setBlock(64, y, 50, y % 3 === 0 ? ACCENT : RUST);
  }
  for (const y of [T + 3, T + 7]) {
    fillBox(world, 62, y, 46, 66, y, 46, METAL);
    fillBox(world, 62, y, 50, 66, y, 50, METAL);
  }
  // Gate's pale keystone and bronze bands stand out from the basalt walls.
  fillBox(world, 24, T + 7, 46, 27, T + 7, 46, PALE);
  fillBox(world, 24, T + 7, 50, 27, T + 7, 50, PALE);
  for (const x of [20, 31]) {
    world.setBlock(x, T + 2, 46, RUST);
    world.setBlock(x, T + 4, 46, RUST);
    world.setBlock(x, T + 2, 50, RUST);
    world.setBlock(x, T + 4, 50, RUST);
  }
  // Furnace housings provide dark ribs around the existing bright stacks.
  for (const [x, z] of [[99, 44], [105, 50]]) {
    for (let y = D + 1; y <= D + 5; y++) {
      world.setBlock(x, y, z, y === D + 3 ? RUST : METAL);
      world.setBlock(x + 1, y, z + 1, y === D + 3 ? RUST : METAL);
    }
    fillBox(world, x, D + 6, z, x + 1, D + 6, z + 1, RUST);
    world.setBlock(x, D + 6, z, ACCENT);
  }
  // Deck drainage marks leave the center and both stair landings untouched.
  for (const z of [36, 61]) {
    for (let x = 91; x <= 111; x++) world.setBlock(x, D, z, x % 3 === 0 ? METAL : STONE);
  }
  // Aqueduct joints are inset in the rail, keeping the entire walk width.
  for (const x of [20, 32, 44, 56, 68, 80]) {
    world.setBlock(x, T + 6, 46, PALE);
    world.setBlock(x, T + 6, 50, PALE);
  }
}

// ---------------------------------------------------------------------------
// Obsidian Gate: twin pylons flanking the site-A approach, tied by a lintel.
// ---------------------------------------------------------------------------

/** Twin BRICK pylons with a METAL lintel over the open gate throat. */
function buildObsidianGate(world) {
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
function buildCentralVent(world) {
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
function buildEmberRefinery(world) {
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
function buildSkybridges(world) {
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
function dressCaldera(world) {
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
