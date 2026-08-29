import { mulberry32 } from '../noise.js';
import {
  ACCENT,
  AIR,
  CONCRETE,
  GLASS,
  GROUND,
  METAL,
  PALE,
  PLANK,
  RUST,
  STONE,
  SX,
  SZ,
  WOOD,
} from './blocks.js';
import {
  fillBox,
  paintFloor,
  generateFlatBase,
  mirroredBox,
} from './flatmaps.js';
import { addDepotSetpieces } from './setpiece-depot.js';

// Spawn anchors from metadata.js — scatter keeps a clear radius around each.
const ANCHORS = [
  [18, 18], [64, 12], [109, 18], [16, 48], [111, 47], [18, 77],
  [63, 83], [109, 77], [49, 20], [78, 75], [49, 75], [78, 20],
  [13, 18], [13, 33], [13, 48], [13, 63], [13, 78], [22, 48],
  [114, 77], [114, 62], [114, 47], [114, 32], [114, 17], [105, 47],
];

export function generateDepotInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);

  // ---- ground dressing -----------------------------------------------------
  // Main east-west haul road: dark asphalt with PALE curbs.
  paintFloor(world, 10, 44, 117, 51, GROUND, STONE);
  paintFloor(world, 10, 43, 117, 43, GROUND, PALE);
  paintFloor(world, 10, 52, 117, 52, GROUND, PALE);
  // North-south connector road with PALE curbs.
  paintFloor(world, 59, 10, 68, 85, GROUND, STONE);
  paintFloor(world, 58, 10, 58, 85, GROUND, PALE);
  paintFloor(world, 69, 10, 69, 85, GROUND, PALE);
  // Dashed centre line, placed in symmetric pairs.
  for (let x = 14; x <= 63; x += 8) {
    mirroredBox(world, x, GROUND, 47, x, GROUND, 47, ACCENT);
    mirroredBox(world, x, GROUND, 48, x, GROUND, 48, ACCENT);
  }
  // Crosswalks feeding the plaza from both roads.
  for (let z = 45; z <= 47; z += 2) {
    world.setBlock(57, GROUND, z, PALE);
    world.setBlock(SX - 1 - 57, GROUND, z, PALE);
    world.setBlock(57, GROUND, SZ - 1 - z, PALE);
    world.setBlock(SX - 1 - 57, GROUND, SZ - 1 - z, PALE);
  }
  for (let x = 61; x <= 63; x += 2) {
    mirroredBox(world, x, GROUND, 33, x, GROUND, 33, PALE);
    mirroredBox(world, x, GROUND, 62, x, GROUND, 62, PALE);
  }

  // Flush rail sidings with stone ties and orange end buffers.
  for (const z of [41, 54]) {
    paintFloor(world, 14, z, 113, z, GROUND, METAL);
  }
  // Ties after both rails, so no mirrored tie gets paved over.
  for (const z of [41, 54]) {
    for (let x = 16; x <= 63; x += 4) {
      world.setBlock(x, GROUND, z, STONE);
      world.setBlock(SX - 1 - x, GROUND, z, STONE);
    }
    world.setBlock(14, GROUND, z, ACCENT);
    world.setBlock(113, GROUND, z, ACCENT);
  }

  // Central plaza: PALE border ring with ACCENT corner ticks; the interior
  // stays base concrete so the eye reads a plaza, not a white field.
  paintFloor(world, 52, 34, 75, 34, GROUND, PALE);
  paintFloor(world, 52, 61, 75, 61, GROUND, PALE);
  paintFloor(world, 52, 35, 52, 60, GROUND, PALE);
  paintFloor(world, 75, 35, 75, 60, GROUND, PALE);
  for (let x = 55; x <= 72; x += 4) {
    world.setBlock(x, GROUND, 34, ACCENT);
    world.setBlock(SX - 1 - x, GROUND, 61, ACCENT);
  }
  // Loading-base silhouettes are exact 180-degree counterparts.
  mirroredBox(world, 7, GROUND + 1, 53, 9, GROUND + 5, 70, METAL);
  mirroredBox(world, 10, GROUND + 1, 25, 23, GROUND + 3, 27, STONE);
  mirroredBox(world, 10, GROUND + 1, 68, 23, GROUND + 3, 70, STONE);
  // Bay-exit marker: banded RUST body with METAL posts, not a flat slab.
  mirroredBox(world, 21, GROUND + 1, 38, 23, GROUND + 4, 44, RUST);
  mirroredBox(world, 21, GROUND + 2, 38, 23, GROUND + 2, 44, ACCENT);
  mirroredBox(world, 21, GROUND + 4, 38, 23, GROUND + 4, 44, METAL);
  for (const [px, pz] of [[21, 38], [23, 38], [21, 44], [23, 44]]) {
    mirroredBox(world, px, GROUND + 1, pz, px, GROUND + 4, pz, METAL);
  }
  buildContainerYard(world);
  buildDepotOffices(world);
  buildPerimeterSheds(world);

  // Low central monument: useful cover without sealing the plaza.
  fillBox(world, 61, GROUND + 1, 45, 66, GROUND + 2, 50, METAL);
  mirroredBox(world, 57, GROUND + 1, 39, 58, GROUND + 1, 40, ACCENT);
  mirroredBox(world, 69, GROUND + 1, 39, 70, GROUND + 1, 40, ACCENT);

  addDepotSetpieces(world);
  scatterDetail(world);
}

/** Container stacks with ribbed sides, door ends, and staggered second tiers. */
function buildContainerYard(world) {
  const specs = [
    [29, 17, 39, 23, 3, METAL, RUST],
    [31, 68, 41, 75, 3, RUST, ACCENT],
    [44, 25, 52, 30, 2, RUST, METAL],
    [43, 44, 50, 48, 2, METAL, ACCENT],
    [78, 13, 88, 19, 3, RUST, METAL],
    [92, 30, 101, 36, 3, ACCENT, METAL],
    [75, 62, 84, 68, 3, METAL, RUST],
  ];
  // Phase 1: every pad (both boxes of each pair) before any tick or body, so
  // overlapping rings can't break mirror symmetry via paint order.
  for (const [x0, z0, x1, z1] of specs) {
    paintPads(world, x0, z0, x1, z1);
    paintPads(world, SX - 1 - x1, SZ - 1 - z1, SX - 1 - x0, SZ - 1 - z0);
  }
  for (const [x0, z0, x1, z1] of specs) {
    paintPadTicks(world, x0, z0, x1, z1);
    paintPadTicks(world, SX - 1 - x1, SZ - 1 - z1, SX - 1 - x0, SZ - 1 - z0);
  }
  for (const [x0, z0, x1, z1, h, body, trim] of specs) {
    buildContainer(world, x0, z0, x1, z1, h, body, trim, false);
    buildContainer(
      world,
      SX - 1 - x1,
      SZ - 1 - z1,
      SX - 1 - x0,
      SZ - 1 - z0,
      h,
      body,
      trim,
      true,
    );
  }

  // Offset second tiers: stacked boxes read as a working yard, not rows.
  mirroredBox(world, 31, GROUND + 4, 18, 38, GROUND + 5, 22, RUST);
  mirroredBox(world, 33, GROUND + 4, 69, 40, GROUND + 5, 74, METAL);
  mirroredBox(world, 80, GROUND + 4, 14, 87, GROUND + 5, 18, ACCENT);
  mirroredBox(world, 77, GROUND + 4, 63, 83, GROUND + 5, 67, RUST);
}

function paintPads(world, x0, z0, x1, z1) {
  paintFloor(world, x0 - 1, z0 - 1, x1 + 1, z0 - 1, GROUND, PALE);
  paintFloor(world, x0 - 1, z1 + 1, x1 + 1, z1 + 1, GROUND, PALE);
  paintFloor(world, x0 - 1, z0, x0 - 1, z1, GROUND, PALE);
  paintFloor(world, x1 + 1, z0, x1 + 1, z1, GROUND, PALE);
}

function paintPadTicks(world, x0, z0, x1, z1) {
  for (const [px, pz] of [[x0 - 1, z0 - 1], [x1 + 1, z0 - 1], [x0 - 1, z1 + 1], [x1 + 1, z1 + 1]]) {
    world.setBlock(px, GROUND, pz, ACCENT);
  }
}

/** Maintenance offices flanking the haul road: GLASS fronts, RUST frames. */
function buildDepotOffices(world) {
  const y0 = GROUND + 1;
  // Hollow shell with RUST walls and METAL corner posts.
  mirroredBox(world, 26, y0, 39, 34, GROUND + 4, 44, RUST);
  mirroredBox(world, 27, y0, 40, 33, GROUND + 3, 43, AIR);
  for (const [px, pz] of [[26, 39], [34, 39], [26, 44], [34, 44]]) {
    mirroredBox(world, px, y0, pz, px, GROUND + 4, pz, METAL);
  }
  // Street-facing GLASS window band and an ACCENT door frame with a real
  // opening (frame first, then carve the door).
  mirroredBox(world, 27, GROUND + 2, 39, 33, GROUND + 3, 39, GLASS);
  mirroredBox(world, 28, y0, 39, 31, GROUND + 3, 39, ACCENT);
  mirroredBox(world, 29, y0, 39, 30, GROUND + 2, 39, AIR);
  // Flat METAL roof with RUST HVAC boxes and an ACCENT parapet lip.
  mirroredBox(world, 26, GROUND + 4, 39, 34, GROUND + 4, 44, METAL);
  mirroredBox(world, 28, GROUND + 5, 40, 29, GROUND + 5, 41, RUST);
  mirroredBox(world, 31, GROUND + 5, 42, 32, GROUND + 5, 43, RUST);
  mirroredBox(world, 26, GROUND + 5, 39, 34, GROUND + 5, 39, ACCENT);

  // RUST pipe run with ACCENT valves along the shed's rear wall.
  mirroredBox(world, 26, GROUND + 2, 45, 34, GROUND + 2, 45, RUST);
  for (let x = 27; x <= 33; x += 3) {
    mirroredBox(world, x, GROUND + 2, 45, x, GROUND + 2, 45, ACCENT);
  }
}

/** Low warehouse sheds hugging the north/south border walls. */
function buildPerimeterSheds(world) {
  const y0 = GROUND + 1;
  const top = GROUND + 5;
  // Hollow shells; the border wall forms the rear face.
  mirroredBox(world, 20, y0, 8, 44, top, 12, RUST);
  mirroredBox(world, 21, y0, 9, 43, top - 1, 11, AIR);
  for (const px of [20, 44]) {
    mirroredBox(world, px, y0, 8, px, top, 12, METAL);
  }
  // GLASS clerestory band under the roof line.
  mirroredBox(world, 21, GROUND + 4, 12, 43, GROUND + 4, 12, GLASS);
  // WOOD doors and an ACCENT lintel strip facing the yard.
  mirroredBox(world, 24, y0, 12, 26, GROUND + 2, 12, WOOD);
  mirroredBox(world, 38, y0, 12, 40, GROUND + 2, 12, WOOD);
  mirroredBox(world, 20, GROUND + 3, 12, 44, GROUND + 3, 12, ACCENT);
  // Roof slab with RUST ridge vents.
  mirroredBox(world, 20, top, 8, 44, top, 12, METAL);
  for (let x = 22; x <= 42; x += 5) {
    mirroredBox(world, x, top + 1, 9, x + 1, top + 1, 11, RUST);
  }
}

/**
 * Deterministic cosmetic scatter: oil stains on concrete, pallet stacks,
 * and crate clusters. Placed in mirrored pairs so symmetry always holds.
 */
function scatterDetail(world) {
  const rng = mulberry32(20260827);
  const nearAnchor = (x, z) => ANCHORS.some(
    ([ax, az]) => Math.max(Math.abs(x - ax), Math.abs(z - az)) <= 3,
  );

  // Oil stains and gravel patches: floor recolours only, on plain concrete.
  for (let i = 0; i < 90; i++) {
    const x = 6 + ((rng() * (SX - 12)) | 0);
    const z = 6 + ((rng() * (SZ - 12)) | 0);
    const mx = SX - 1 - x;
    const mz = SZ - 1 - z;
    const type = rng() < 0.6 ? STONE : CONCRETE;
    const ok = (px, pz) => world.getBlock(px, GROUND, pz) === CONCRETE;
    if (ok(x, z) && ok(mx, mz) && !nearAnchor(x, z) && !nearAnchor(mx, mz)) {
      world.setBlock(x, GROUND, z, type);
      world.setBlock(mx, GROUND, mz, type);
    }
  }

  // WOOD pallet stacks and PLANK crate clusters: destructible cover.
  for (let i = 0; i < 16; i++) {
    const x = 12 + ((rng() * (SX - 24)) | 0);
    const z = 12 + ((rng() * (SZ - 24)) | 0);
    const mx = SX - 1 - x;
    const mz = SZ - 1 - z;
    const free = (px, pz) => world.getBlock(px, GROUND + 1, pz) === AIR;
    if (!free(x, z) || !free(mx, mz) || nearAnchor(x, z) || nearAnchor(mx, mz)) {
      continue;
    }
    world.setBlock(x, GROUND + 1, z, WOOD);
    world.setBlock(mx, GROUND + 1, mz, WOOD);
    if (rng() < 0.4) {
      world.setBlock(x, GROUND + 2, z, WOOD);
      world.setBlock(mx, GROUND + 2, mz, WOOD);
    }
    if (rng() < 0.5) {
      const cx = x + 1;
      const cm = SX - 1 - cx;
      if (world.getBlock(cx, GROUND + 1, z) === AIR
        && world.getBlock(cm, GROUND + 1, mz) === AIR) {
        world.setBlock(cx, GROUND + 1, z, PLANK);
        world.setBlock(cm, GROUND + 1, mz, PLANK);
      }
    }
  }
}



/** Ribbed container with door-end detail; colours vary per instance. */
function buildContainer(world, x0, z0, x1, z1, height, body, trim, flip = false) {
  const doorX = flip ? x1 : x0;
  const seamX = flip ? x1 - 1 : x0 + 1;
  fillBox(world, x0, GROUND + 1, z0, x1, GROUND + height, z1, body);
  // Door end: trim panels with recessed seam and METAL lock rods.
  fillBox(world, doorX, GROUND + 1, z0, doorX, GROUND + height, z1, trim);
  fillBox(world, seamX, GROUND + 2, z0 + 2, seamX, GROUND + height - 1, z1 - 2, METAL);
  fillBox(world, doorX, GROUND + 1, z0 + 2, doorX, GROUND + height - 1, z0 + 2, METAL);
  fillBox(world, doorX, GROUND + 1, z1 - 2, doorX, GROUND + height - 1, z1 - 2, METAL);
  // Vertical ribs along the long faces, mirrored in x for flip.
  if (flip) {
    for (let x = x1 - 3; x >= x0 + 2; x -= 3) {
      for (const z of [z0, z1]) {
        fillBox(world, x, GROUND + 1, z, x, GROUND + height, z, trim);
      }
    }
  } else {
    for (let x = x0 + 3; x <= x1 - 2; x += 3) {
      for (const z of [z0, z1]) {
        fillBox(world, x, GROUND + 1, z, x, GROUND + height, z, trim);
      }
    }
  }
  // Corner castings (self-symmetric under the flip).
  for (const px of [x0, x1]) {
    for (const pz of [z0, z1]) {
      fillBox(world, px, GROUND + 1, pz, px, GROUND + height, pz, METAL);
    }
  }
}
