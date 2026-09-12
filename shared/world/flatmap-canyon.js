import { AIR, DUST_CRATE, DUST_FLOOR, DUST_PLASTER, DUST_ROCK,
  DUST_SANDSTONE, DUST_TILE, DUST_TRIM, DUST_WOOD, GLASS, GROUND, METAL,
  PLANK, RUST, SAND, STONE, TEAL_SIDING, WOOD, YELLOW_SIDING } from './blocks.js';
import { fillBox as box, mirroredBox as pair, paintFloor } from './flatmaps.js';

const T = GROUND;

/** Authored terraced outcrops with broad, genuinely traversable ground tunnels. */
function terracedMesa(world, x, z, width, depth, peak = 18) {
  for (let dz = 0; dz <= depth; dz++) for (let dx = 0; dx <= width; dx++) {
    const nx = Math.abs((dx - width / 2) / (width / 2));
    const nz = Math.abs((dz - depth / 2) / (depth / 2));
    const contour = Math.max(nx * .91 + nz * .2, nz * .91 + nx * .2);
    const terrace = contour > 1.05 ? 0 : contour > .88 ? 3 : contour > .7 ? 8 : contour > .43 ? 14 : peak;
    const cut = ((dx + dz * 2) % 11 === 0 && terrace > 8) ? 1 : 0;
    for (let dy = 1; dy <= terrace - cut; dy++) {
      const material = dy === terrace - cut ? SAND : dy % 6 === 0 ? DUST_TRIM : dy % 6 < 2 ? DUST_SANDSTONE : DUST_ROCK;
      world.setBlock(x + dx, T + dy, z + dz, material);
    }
  }
  // Five-wide cut through the whole rock, independently accessible at both ends.
  const tunnelX = x + Math.floor(width / 2) - 2;
  box(world, tunnelX, T + 1, z, tunnelX + 4, T + 6, z + depth, AIR);
  for (const gateZ of [z + 2, z + depth - 2]) {
    for (const postX of [tunnelX - 1, tunnelX + 5]) box(world, postX, T + 1, gateZ, postX, T + 6, gateZ, DUST_WOOD);
    box(world, tunnelX - 1, T + 7, gateZ, tunnelX + 5, T + 7, gateZ, DUST_WOOD);
  }
  paintFloor(world, tunnelX, z, tunnelX + 4, z + depth, T, DUST_FLOOR);
}

/** Two-storey broken houses surround a six-wide open street and linked courtyards. */
function settlementPair(world, x, z) {
  pair(world, x, T + 1, z, x + 20, T + 8, z + 9, DUST_PLASTER);
  pair(world, x + 1, T + 1, z + 1, x + 19, T + 7, z + 8, AIR);
  pair(world, x + 7, T + 1, z, x + 13, T + 5, z + 9, AIR);
  pair(world, x, T + 1, z + 4, x + 20, T + 4, z + 7, AIR);
  for (const endZ of [z, z + 9]) {
    pair(world, x, T + 1, endZ, x + 6, T + 2, endZ, DUST_SANDSTONE);
    pair(world, x + 14, T + 1, endZ, x + 20, T + 2, endZ, DUST_SANDSTONE);
    pair(world, x, T + 7, endZ, x + 20, T + 7, endZ, DUST_TRIM);
    for (const windowX of [x + 2, x + 16]) pair(world, windowX, T + 4, endZ, windowX + 2, T + 5, endZ, AIR);
  }
  // A fragmented upper wall and a remaining corner tower break the skyline.
  pair(world, x, T + 9, z, x + 6, T + 11, z + 3, DUST_SANDSTONE);
  pair(world, x + 1, T + 9, z + 1, x + 5, T + 11, z + 2, AIR);
  pair(world, x + 3, T + 10, z, x + 4, T + 11, z, AIR);
  pair(world, x + 15, T + 9, z + 7, x + 20, T + 10, z + 9, DUST_ROCK);
  pair(world, x + 16, T + 9, z + 8, x + 19, T + 10, z + 9, AIR);
  // Broken side rooms form close-range pockets with two exits each.
  pair(world, x, T + 1, z + 15, x + 6, T + 5, z + 21, DUST_SANDSTONE);
  pair(world, x + 1, T + 1, z + 16, x + 6, T + 4, z + 20, AIR);
  pair(world, x + 2, T + 1, z + 15, x + 5, T + 3, z + 21, AIR);
  pair(world, x + 16, T + 1, z + 15, x + 20, T + 4, z + 21, DUST_PLASTER);
  pair(world, x + 16, T + 1, z + 16, x + 19, T + 3, z + 20, AIR);
  pair(world, x + 16, T + 1, z + 17, x + 20, T + 3, z + 19, AIR);
  // Courtyard awning, beams and pottery/store stacks stay out of the street.
  for (const postX of [x + 1, x + 6]) pair(world, postX, T + 1, z + 13, postX, T + 5, z + 13, DUST_WOOD);
  pair(world, x + 1, T + 5, z + 10, x + 6, T + 5, z + 13, DUST_TILE);
  pair(world, x + 2, T + 1, z + 1, x + 4, T + 2, z + 2, DUST_CRATE);
  pair(world, x + 17, T + 1, z + 1, x + 18, T + 3, z + 2, DUST_WOOD);
  pair(world, x + 1, T, z + 10, x + 19, T, z + 14, DUST_FLOOR);
}

/** The objective stays an open ground courtyard, framed by an old caravan hall. */
function caravanCourt(world) {
  for (const x of [24, 45]) for (const z of [61, 79]) {
    pair(world, x, T + 1, z, x + 1, T + 7, z + 2, DUST_SANDSTONE);
    pair(world, x - 1, T + 7, z - 1, x + 2, T + 8, z + 3, DUST_TRIM);
  }
  // Three roof fragments define the court while leaving most sky open.
  pair(world, 23, T + 8, 60, 47, T + 9, 62, DUST_SANDSTONE);
  pair(world, 23, T + 8, 81, 47, T + 9, 83, DUST_SANDSTONE);
  pair(world, 24, T + 8, 63, 26, T + 8, 78, DUST_WOOD);
  pair(world, 44, T + 8, 63, 46, T + 8, 78, DUST_WOOD);
  // Short broken low walls give a safe approach to the exposed objective pad.
  pair(world, 20, T + 1, 67, 23, T + 3, 72, DUST_ROCK);
  pair(world, 46, T + 1, 73, 49, T + 2, 77, DUST_SANDSTONE);
  pair(world, 25, T + 1, 85, 30, T + 2, 86, DUST_CRATE);
}

/** Monumental three-arch aqueduct; every arch carries a broad flat-ground route. */
function aqueduct(world) {
  for (const x of [76, 89, 102, 115]) {
    box(world, x, T + 1, 67, x + 2, T + 12, 73, DUST_ROCK);
    box(world, x - 1, T + 1, 66, x + 3, T + 2, 74, DUST_SANDSTONE);
    box(world, x - 1, T + 10, 66, x + 3, T + 12, 74, DUST_TRIM);
  }
  box(world, 76, T + 13, 67, 117, T + 15, 73, DUST_SANDSTONE);
  // Stepped voussoirs create curved negative space above the three portals.
  for (const x of [79, 92, 105]) {
    box(world, x, T + 9, 67, x + 1, T + 12, 73, DUST_SANDSTONE);
    box(world, x + 8, T + 9, 67, x + 9, T + 12, 73, DUST_SANDSTONE);
    box(world, x + 2, T + 11, 67, x + 3, T + 12, 73, DUST_SANDSTONE);
    box(world, x + 6, T + 11, 67, x + 7, T + 12, 73, DUST_SANDSTONE);
  }
  // A broken water channel and alternating parapet fragments cap the silhouette.
  box(world, 76, T + 16, 68, 117, T + 16, 72, DUST_FLOOR);
  for (let x = 76; x <= 116; x += 5) {
    box(world, x, T + 17, 67, x + 2, T + 17, 67, DUST_TRIM);
    box(world, x, T + 17, 73, x + 2, T + 17, 73, DUST_TRIM);
  }
  box(world, 113, T + 15, 69, 117, T + 17, 71, AIR);
  // Nearby fallen segments are cover rather than a single empty river corridor.
  box(world, 84, T + 1, 82, 88, T + 2, 89, DUST_ROCK);
  box(world, 85, T + 3, 83, 87, T + 3, 86, DUST_SANDSTONE);
  box(world, 106, T + 1, 51, 109, T + 3, 57, DUST_SANDSTONE);
}

function expeditionCamp(world) {
  // Two field shelters on the outer flanks, each open through its ground floor.
  pair(world, 7, T + 1, 42, 17, T + 6, 56, DUST_WOOD);
  pair(world, 8, T + 1, 43, 16, T + 5, 55, AIR);
  pair(world, 10, T + 1, 42, 15, T + 4, 56, AIR);
  pair(world, 7, T + 6, 42, 17, T + 6, 56, TEAL_SIDING);
  for (const x of [8, 16]) pair(world, x, T + 7, 43, x, T + 7, 55, WOOD);
  pair(world, 8, T + 1, 46, 9, T + 2, 51, DUST_CRATE);
  pair(world, 16, T + 1, 46, 16, T + 2, 50, PLANK);
  // Parked tracked excavator: tracks, glazed cab, tilted boom and digging bucket.
  for (const x of [78, 84]) pair(world, x, T + 1, 93, x + 1, T + 2, 104, STONE);
  pair(world, 80, T + 3, 95, 84, T + 4, 102, YELLOW_SIDING);
  pair(world, 81, T + 5, 98, 84, T + 7, 102, YELLOW_SIDING);
  pair(world, 81, T + 6, 98, 84, T + 7, 98, GLASS);
  pair(world, 81, T + 8, 98, 84, T + 8, 102, METAL);
  for (let step = 0; step < 6; step++) pair(world, 80, T + 5 + step, 96 - step, 81, T + 6 + step, 96 - step, RUST);
  for (let step = 0; step < 5; step++) pair(world, 80, T + 10 - step, 90 - step, 81, T + 11 - step, 90 - step, YELLOW_SIDING);
  pair(world, 79, T + 3, 84, 83, T + 5, 86, METAL);
  pair(world, 80, T + 4, 84, 82, T + 5, 85, AIR);
}

function excavationRigs(world) {
  // Borehole frame gives the northern river approach a readable destination.
  for (const x of [94, 104]) for (const z of [35, 44]) pair(world, x, T + 1, z, x, T + 12, z, METAL);
  pair(world, 94, T + 12, 35, 104, T + 12, 44, RUST);
  pair(world, 95, T + 12, 36, 103, T + 12, 43, AIR);
  for (const z of [35, 44]) pair(world, 94, T + 9, z, 104, T + 9, z, YELLOW_SIDING);
  pair(world, 98, T + 8, 39, 100, T + 14, 40, METAL);
  pair(world, 97, T + 6, 38, 101, T + 7, 41, RUST);
  pair(world, 109, T + 1, 37, 113, T + 3, 42, DUST_CRATE);
  pair(world, 109, T + 4, 38, 112, T + 4, 41, PLANK);
}

/** Caravan arrival courts shelter both spawn rows; all approach floors stay flat. */
function arrivalCourts(world) {
  for (const x of [12, 56, 100, 144]) {
    for (const px of [x, x + 34]) for (const z of [6, 22]) {
      pair(world, px, T + 1, z, px + 1, T + 6, z, DUST_SANDSTONE);
      pair(world, px, T + 7, z, px + 1, T + 7, z, DUST_TRIM);
    }
    for (const z of [6, 22]) pair(world, x, T + 7, z, x + 35, T + 7, z, DUST_WOOD);
    // Torn textile strips alternate with open sky rather than a heavy solid roof.
    for (const stripX of [x + 2, x + 10, x + 18, x + 26]) {
      pair(world, stripX, T + 7, 7, stripX + 4, T + 7, 11, TEAL_SIDING);
      pair(world, stripX, T + 7, 18, stripX + 4, T + 7, 21, DUST_TILE);
    }
    pair(world, x + 11, T + 1, 6, x + 23, T + 3, 6, DUST_SANDSTONE);
    pair(world, x + 14, T + 4, 6, x + 20, T + 5, 6, DUST_PLASTER);
  }
}

export function buildCanyonArchitecture(world) {
  paintFloor(world, 3, 3, 188, 140, T, SAND);
  for (let z = 23; z <= 120; z++) {
    const bend = Math.round(Math.sin(z / 18) * 8);
    paintFloor(world, 83 + bend, z, 107 + bend, z, T, DUST_FLOOR);
  }
  for (const [x, z, w, d, peak] of [[52, 29, 17, 23, 20], [121, 29, 17, 23, 18],
    [52, 91, 17, 23, 18], [121, 91, 17, 23, 20], [59, 64, 14, 15, 16], [118, 64, 14, 15, 16]]) terracedMesa(world, x, z, w, d, peak);
  settlementPair(world, 22, 37);
  settlementPair(world, 149, 37);
  caravanCourt(world);
  aqueduct(world);
  expeditionCamp(world);
  excavationRigs(world);
  arrivalCourts(world);
  // Long bare approach strips become a rhythm of ledges and fallen masonry.
  for (const [x, z] of [[18, 29], [43, 30], [72, 30], [18, 110], [44, 109], [77, 54], [111, 91], [9, 76]]) {
    pair(world, x, T + 1, z, x + 6, T + 2, z + 3, DUST_ROCK);
    pair(world, x + 1, T + 3, z + 1, x + 4, T + 3, z + 2, SAND);
  }
  for (const x of [12, 78, 166]) pair(world, x, T + 1, 24, x + 12, T + 3, 25, DUST_SANDSTONE);
}
