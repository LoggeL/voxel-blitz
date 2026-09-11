import { AIR, ACCENT, ASPHALT, BRICK, CONCRETE, DUST_CRATE, DUST_FLOOR,
  DUST_ROCK, DUST_SANDSTONE, DUST_TRIM, GLASS, GROUND, METAL, PALE, RUST, SAND,
  TEAL_SIDING, YELLOW_SIDING, WOOD } from './blocks.js';
import { fillBox, generateFlatBase, mirroredBox, paintFloor } from './flatmaps.js';
import { LARGE_SITES } from './large-layout.js';

const T = GROUND;

function sitePads(world, floor, trim) {
  for (const site of LARGE_SITES) {
    paintFloor(world, site.minX, site.minZ, site.maxX, site.maxZ, T, floor);
    for (const z of [site.minZ, site.maxZ]) paintFloor(world, site.minX, z, site.maxX, z, T, trim);
    for (const x of [site.minX, site.maxX]) paintFloor(world, x, site.minZ, x, site.maxZ, T, trim);
  }
}

function warehouse(world, x, z, color) {
  fillBox(world, x, T + 1, z, x + 32, T + 8, z + 18, color);
  fillBox(world, x + 1, T + 1, z + 1, x + 31, T + 7, z + 17, AIR);
  fillBox(world, x + 11, T + 1, z, x + 21, T + 5, z + 18, AIR);
  fillBox(world, x, T + 1, z + 6, x + 32, T + 4, z + 12, AIR);
  for (const wx of [x + 4, x + 26]) fillBox(world, wx, T + 3, z + 18, wx + 2, T + 5, z + 18, GLASS);
  for (const wz of [z, z + 18]) fillBox(world, x, T + 8, wz, x + 32, T + 8, wz, PALE);
  fillBox(world, x + 3, T + 1, z + 3, x + 7, T + 2, z + 5, WOOD);
  fillBox(world, x + 26, T + 1, z + 14, x + 29, T + 2, z + 16, WOOD);
}

/** Broad dock roads, permeable warehouses and staggered cargo alleys. */
export function generateHarborInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  paintFloor(world, 4, 4, 187, 139, T, ASPHALT);
  for (const x of [18, 73, 118, 173]) paintFloor(world, x, 23, x + 1, 120, T, PALE);
  for (const z of [25, 52, 91, 118]) paintFloor(world, 8, z, 183, z + 1, T, PALE);
  warehouse(world, 28, 29, TEAL_SIDING);
  warehouse(world, 132, 29, YELLOW_SIDING);
  warehouse(world, 28, 96, YELLOW_SIDING);
  warehouse(world, 132, 96, TEAL_SIDING);
  for (const [x, z, length, color] of [
    [49, 58, 19, RUST], [58, 82, 18, TEAL_SIDING],
    [80, 34, 17, RUST], [106, 51, 15, YELLOW_SIDING],
  ]) {
    mirroredBox(world, x, T + 1, z, x + 8, T + 5, z + length, color);
    for (let dz = 1; dz < length; dz += 4) mirroredBox(world, x, T + 1, z + dz, x, T + 5, z + dz, METAL);
    mirroredBox(world, x, T + 5, z, x + 8, T + 5, z, PALE);
  }
  // Crane is a landmark above two broad cross-map routes; its feet give cover.
  for (const x of [88, 102]) for (const z of [64, 78]) {
    fillBox(world, x, T + 1, z, x + 2, T + 19, z + 2, RUST);
    fillBox(world, x - 1, T + 1, z - 1, x + 3, T + 2, z + 3, CONCRETE);
  }
  fillBox(world, 86, T + 19, 62, 106, T + 21, 82, ACCENT);
  fillBox(world, 89, T + 19, 65, 103, T + 20, 79, AIR);
  fillBox(world, 93, T + 12, 70, 99, T + 14, 74, METAL);
  for (const [x, z] of [[20, 53], [25, 87], [167, 53], [162, 87], [76, 66], [112, 75]]) {
    fillBox(world, x, T + 1, z, x + 4, T + 2, z + 4, WOOD);
  }
  // Spawn screens interrupt long sightlines while preserving wide exits.
  for (const x of [12, 78, 168]) mirroredBox(world, x, T + 1, 24, x + 10, T + 3, 25, BRICK);
  sitePads(world, CONCRETE, ACCENT);
}

function mesa(world, x, z, width, depth) {
  fillBox(world, x, T + 1, z, x + width, T + 10, z + depth, DUST_ROCK);
  fillBox(world, x + 2, T + 11, z + 2, x + width - 2, T + 14, z + depth - 2, DUST_SANDSTONE);
  fillBox(world, x + 4, T + 15, z + 4, x + width - 4, T + 16, z + depth - 4, SAND);
  // Strata and cut corners keep formations legible without tiny decoration.
  fillBox(world, x, T + 5, z, x + width, T + 5, z + depth, DUST_SANDSTONE);
  for (const cx of [x, x + width - 2]) for (const cz of [z, z + depth - 2]) {
    fillBox(world, cx, T + 1, cz, cx + 2, T + 10, cz + 2, AIR);
  }
}

function ruin(world, x, z) {
  fillBox(world, x, T + 1, z, x + 15, T + 5, z + 1, DUST_SANDSTONE);
  fillBox(world, x, T + 1, z, x + 1, T + 4, z + 16, DUST_SANDSTONE);
  fillBox(world, x + 14, T + 1, z, x + 15, T + 4, z + 16, DUST_SANDSTONE);
  fillBox(world, x + 5, T + 1, z, x + 10, T + 3, z + 1, AIR);
  fillBox(world, x, T + 1, z + 7, x + 15, T + 3, z + 11, AIR);
  fillBox(world, x + 2, T + 1, z + 13, x + 5, T + 2, z + 16, DUST_CRATE);
}

/** Braided canyon routes, ruined side compounds and an open dry-river center. */
export function generateCanyonInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  paintFloor(world, 3, 3, 188, 140, T, SAND);
  for (let z = 23; z <= 120; z++) {
    const bend = Math.round(Math.sin(z / 18) * 8);
    paintFloor(world, 83 + bend, z, 107 + bend, z, T, DUST_FLOOR);
  }
  for (const [x, z, w, d] of [[52, 29, 17, 23], [121, 29, 17, 23],
    [52, 91, 17, 23], [121, 91, 17, 23], [59, 64, 14, 15], [118, 64, 14, 15]]) {
    mesa(world, x, z, w, d);
  }
  for (const [x, z] of [[22, 43], [153, 43], [22, 85], [153, 85]]) ruin(world, x, z);
  // Broken aqueduct straddles the river, with three unobstructed archways.
  for (const x of [78, 93, 108]) fillBox(world, x, T + 1, 68, x + 2, T + 8, 70, DUST_SANDSTONE);
  fillBox(world, 78, T + 8, 68, 110, T + 9, 70, DUST_TRIM);
  for (const [x, z] of [[16, 29], [168, 29], [16, 112], [168, 112],
    [40, 68], [145, 75], [79, 48], [107, 95], [88, 86], [103, 56]]) {
    fillBox(world, x, T + 1, z, x + 4, T + 2, z + 4, DUST_ROCK);
    fillBox(world, x + 1, T + 3, z + 1, x + 3, T + 3, z + 3, SAND);
  }
  for (const x of [12, 78, 166]) mirroredBox(world, x, T + 1, 24, x + 12, T + 3, 25, DUST_SANDSTONE);
  sitePads(world, DUST_FLOOR, DUST_TRIM);
}
