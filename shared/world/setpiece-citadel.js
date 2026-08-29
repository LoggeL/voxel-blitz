import {
  ACCENT,
  AIR,
  BRICK,
  CONCRETE,
  GLASS,
  GROUND,
  LEAVES,
  PALE,
  PLANK,
  SEED,
  STONE,
  WOOD,
} from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';

// ---------------------------------------------------------------------------
// Deterministic dressing helpers shared by the citadel builders.
// ---------------------------------------------------------------------------

/** Deterministic per-voxel noise in [0, 1), keyed off the shared map seed. */
export function hash3(x, y, z) {
  let h =
    (SEED ^
      Math.imul(x + 1013, 0x27d4eb2f) ^
      Math.imul(y + 7919, 0x9e3779b1) ^
      Math.imul(z + 31337, 0x85ebca6b)) |
    0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Brick masonry with weathered STONE speckling for large, flat faces. */
export function masonry(world, x0, y0, z0, x1, y1, z1, variance = 0.14) {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        world.setBlock(x, y, z, hash3(x, y, z) < variance ? STONE : BRICK);
      }
    }
  }
}

function merlonBlock(x, y, z) {
  return hash3(x, y + 55021, z) < 0.3 ? CONCRETE : STONE;
}

function forAxisLine(axis, fixed, start, end, visit) {
  for (let value = start; value <= end; value++) {
    const x = axis === 'x' ? value : fixed;
    const z = axis === 'z' ? value : fixed;
    visit(value, x, z);
  }
}

/** 2-on/2-off crenellation along an X run. */
export function merlonLineX(world, z, y, x0, x1) {
  forAxisLine('x', z, x0, x1, (value, x, lineZ) => {
    if (value % 4 < 2) world.setBlock(x, y, lineZ, merlonBlock(x, y, lineZ));
  });
}

/** 2-on/2-off crenellation along a Z run. */
export function merlonLineZ(world, x, y, z0, z1) {
  forAxisLine('z', x, z0, z1, (value, lineX, z) => {
    if (value % 4 < 2) world.setBlock(lineX, y, z, merlonBlock(lineX, y, z));
  });
}

/** Crenellation around all four edges of a rectangle. */
export function merlons(world, x0, z0, x1, z1, y) {
  merlonLineX(world, z0, y, x0, x1);
  merlonLineX(world, z1, y, x0, x1);
  merlonLineZ(world, x0, y, z0, z1);
  merlonLineZ(world, x1, y, z0, z1);
}

/** Single GLASS arrow slits along an X run, embedded in the wall face. */
export function slitX(world, z, y, x0, x1, spacing = 5, offset = 2) {
  forAxisLine('x', z, x0, x1, (value, x, lineZ) => {
    if ((value + offset) % spacing === 0) world.setBlock(x, y, lineZ, GLASS);
  });
}

/** Single GLASS arrow slits along a Z run. */
export function slitZ(world, x, y, z0, z1, spacing = 5, offset = 2) {
  forAxisLine('z', x, z0, z1, (value, lineX, z) => {
    if ((value + offset) % spacing === 0) world.setBlock(lineX, y, z, GLASS);
  });
}

/** Flush ACCENT torch sconces along an X run. */
export function sconceX(world, z, y, x0, x1, spacing = 7, offset = 3) {
  forAxisLine('x', z, x0, x1, (value, x, lineZ) => {
    if ((value + offset) % spacing === 0) world.setBlock(x, y, lineZ, ACCENT);
  });
}

/** Flush ACCENT torch sconces along a Z run. */
export function sconceZ(world, x, y, z0, z1, spacing = 7, offset = 3) {
  forAxisLine('z', x, z0, z1, (value, lineX, z) => {
    if ((value + offset) % spacing === 0) world.setBlock(lineX, y, z, ACCENT);
  });
}

/** WOOD banner pole with a hanging ACCENT flag and finial, based at (x, y, z). */
export function banner(world, x, y, z, fx = 0, fz = 1) {
  fillBox(world, x, y, z, x, y + 3, z, WOOD);
  world.setBlock(x, y + 4, z, ACCENT);
  world.setBlock(x + fx, y + 3, z + fz, ACCENT);
  world.setBlock(x + fx, y + 2, z + fz, ACCENT);
}

/** Small tree: WOOD trunk under a LEAVES canopy, fun to shoot apart. */
export function tree(world, x, z, trunk = 2) {
  const T = GROUND;
  fillBox(world, x, T + 1, z, x, T + trunk, z, WOOD);
  const cy = T + trunk + 1;
  fillBox(world, x - 1, cy, z - 1, x + 1, cy, z + 1, LEAVES);
  world.setBlock(x, cy + 1, z, LEAVES);
}

// ---------------------------------------------------------------------------
// The keep: corner towers, great hall, curtains, gates, bridges, court.
// ---------------------------------------------------------------------------

/** Strong keep/tower silhouettes for Citadel. */
export function addCitadelSetpieces(world) {
  buildKeep(world);
  buildNorthGate(world);
  buildFountain(world);
}

/** One corner tower: brick drum, stone quoins, slits, battlement cap. */
function tower(world, x0, z0, x1, z1, top) {
  const T = GROUND;
  masonry(world, x0, T + 1, z0, x1, top, z1, 0.1);
  fillBox(world, x0, T + 1, z0, x0 + 1, top, z0 + 1, STONE);
  fillBox(world, x1 - 1, T + 1, z0, x1, top, z0 + 1, STONE);
  fillBox(world, x0, T + 1, z1 - 1, x0 + 1, top, z1, STONE);
  fillBox(world, x1 - 1, T + 1, z1 - 1, x1, top, z1, STONE);
  fillBox(world, x0, top, z0, x1, top, z1, CONCRETE);
  merlons(world, x0, z0, x1, z1, top + 1);
  for (const y of [T + 3, T + 6]) {
    slitX(world, z0, y, x0 + 2, x1 - 2, 4, 1);
    slitX(world, z1, y, x0 + 2, x1 - 2, 4, 3);
    slitZ(world, x0, y, z0 + 2, z1 - 2, 4, 2);
    slitZ(world, x1, y, z0 + 2, z1 - 2, 4, 0);
  }
}

function buildKeep(world) {
  const T = GROUND;

  // Corner towers: the tall northern pair carries the skyline.
  tower(world, 48, 25, 55, 32, T + 10);
  tower(world, 71, 25, 78, 32, T + 10);
  tower(world, 48, 58, 55, 65, T + 8);
  tower(world, 71, 58, 78, 65, T + 8);
  banner(world, 49, T + 11, 26, 1, 0);
  banner(world, 54, T + 11, 31, 0, 1);
  banner(world, 77, T + 11, 26, -1, 0);
  banner(world, 72, T + 11, 31, 0, 1);
  banner(world, 49, T + 9, 62, 1, 0);
  banner(world, 77, T + 9, 62, -1, 0);

  // Great hall: a solid masonry mass anchoring the keep and sealing the
  // direct A-to-B angle, dressed with pilasters and a wide banner panel.
  masonry(world, 56, T + 1, 27, 70, T + 6, 42, 0.1);
  fillBox(world, 56, T + 6, 27, 70, T + 6, 42, CONCRETE);
  for (const x of [58, 63, 68]) fillBox(world, x, T + 1, 42, x, T + 5, 42, STONE);
  fillBox(world, 62, T + 3, 42, 64, T + 5, 42, ACCENT);
  merlons(world, 56, 27, 70, 42, T + 7);
  world.setBlock(60, T + 2, 43, ACCENT);
  world.setBlock(66, T + 2, 43, ACCENT);

  // West/east curtains with half-open timber gates into the inner court.
  masonry(world, 48, T + 1, 33, 50, T + 6, 57);
  masonry(world, 76, T + 1, 33, 78, T + 6, 57);
  fillBox(world, 48, T + 6, 33, 50, T + 6, 57, CONCRETE);
  fillBox(world, 76, T + 6, 33, 78, T + 6, 57, CONCRETE);
  fillBox(world, 48, T + 1, 44, 50, T + 3, 47, AIR);
  fillBox(world, 76, T + 1, 44, 78, T + 3, 47, AIR);
  fillBox(world, 48, T + 1, 44, 48, T + 2, 45, PLANK);
  fillBox(world, 78, T + 1, 46, 78, T + 2, 47, PLANK);
  for (const z of [33, 42, 56]) {
    fillBox(world, 48, T + 1, z, 50, T + 6, z, STONE);
    fillBox(world, 76, T + 1, z, 78, T + 6, z, STONE);
  }
  slitZ(world, 48, T + 3, 34, 56, 5, 2);
  slitZ(world, 78, T + 3, 34, 56, 5, 2);
  sconceZ(world, 48, T + 2, 34, 56, 6, 5);
  sconceZ(world, 78, T + 2, 34, 56, 6, 5);
  merlonLineZ(world, 48, T + 7, 33, 57);
  merlonLineZ(world, 78, T + 7, 33, 57);

  // South curtain closing the court, torches facing the green.
  masonry(world, 56, T + 1, 64, 70, T + 6, 65, 0.1);
  fillBox(world, 56, T + 6, 64, 70, T + 6, 65, CONCRETE);
  merlonLineX(world, 65, T + 7, 56, 70);
  sconceX(world, 63, T + 2, 57, 69, 4, 1);
  slitX(world, 65, T + 4, 57, 69, 5, 2);

  // High battlement bridges linking the towers; overhead, so the ground
  // rotations beneath stay open.
  fillBox(world, 56, T + 8, 25, 70, T + 9, 27, CONCRETE);
  merlonLineZ(world, 25, T + 10, 56, 70);
  merlonLineZ(world, 27, T + 10, 56, 70);
  banner(world, 63, T + 10, 26, 0, 1);
  fillBox(world, 56, T + 7, 63, 70, T + 8, 65, CONCRETE);
  merlonLineZ(world, 63, T + 9, 56, 70);
  merlonLineZ(world, 65, T + 9, 56, 70);
  banner(world, 63, T + 9, 64, 0, -1);

  // Inner court: pale processional path between the gates, monument, green.
  paintFloor(world, 51, 45, 75, 46, T, PALE);
  paintFloor(world, 51, 44, 54, 47, T, PALE);
  paintFloor(world, 72, 44, 75, 47, T, PALE);
  paintFloor(world, 61, 50, 63, 52, T, PALE);
  fillBox(world, 62, T + 1, 51, 62, T + 2, 51, STONE);
  world.setBlock(62, T + 3, 51, ACCENT);
  tree(world, 54, 54);
  tree(world, 72, 54);
}

/** Gatehouse on the courtyard's north wall: flanking towers, timber doors. */
function buildNorthGate(world) {
  const T = GROUND;
  for (const x0 of [24, 30]) {
    masonry(world, x0, T + 1, 11, x0 + 1, T + 6, 13, 0.1);
    fillBox(world, x0, T + 6, 11, x0 + 1, T + 6, 13, CONCRETE);
    merlons(world, x0, 11, x0 + 1, 13, T + 7);
  }
  banner(world, 24, T + 7, 12, 1, 0);
  banner(world, 31, T + 7, 12, -1, 0);
  // Carve the gate opening and hang half-open PLANK doors (destructible).
  fillBox(world, 26, T + 1, 11, 29, T + 3, 12, AIR);
  fillBox(world, 26, T + 1, 11, 27, T + 2, 11, PLANK);
  world.setBlock(25, T + 2, 12, ACCENT);
  world.setBlock(30, T + 2, 12, ACCENT);
}

/** Fountain in the A courtyard's west garden: stone basin, water, pier. */
function buildFountain(world) {
  const T = GROUND;
  fillBox(world, 17, T + 1, 23, 20, T + 1, 27, STONE);
  fillBox(world, 18, T + 1, 24, 19, T + 1, 26, AIR);
  paintFloor(world, 18, 24, 19, 26, T, PALE);
  fillBox(world, 18, T + 1, 25, 19, T + 2, 25, STONE);
  world.setBlock(18, T + 3, 25, ACCENT);
  world.setBlock(19, T + 3, 25, ACCENT);
}
