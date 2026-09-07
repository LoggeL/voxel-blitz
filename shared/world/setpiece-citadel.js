import {
  ACCENT,
  AIR,
  BRICK,
  CONCRETE,
  GLASS,
  GROUND,
  LEAVES,
  METAL,
  PALE,
  PLANK,
  ROOF,
  RUST,
  SEED,
  STONE,
  WOOD,
  TEAL_SIDING,
} from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';

// ---------------------------------------------------------------------------
// Deterministic dressing helpers shared by the citadel builders.
// ---------------------------------------------------------------------------

/** Deterministic per-voxel noise in [0, 1), keyed off the shared map seed. */
function hash3(x, y, z) {
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
function merlons(world, x0, z0, x1, z1, y) {
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
  dressKeepFacades(world);
  buildGarrisonFurnishings(world);
  buildBellTower(world);
  buildSouthMarket(world);
  buildGardenCaravans(world);
}

/** The south keep grows into a full clock tower on a solid masonry footing. */
function buildBellTower(world) {
  const T = GROUND;
  // Tiled pitched roof of the great hall behind the new south tower.
  for (let inset = 0; inset <= 4; inset++) {
    fillBox(world, 55 + inset, T + 7 + inset, 27, 71 - inset, T + 7 + inset, 42, ROOF);
  }
  // The body stands on the south curtain, close enough to read on arrival.
  // Its rear footing occupies the dead-end garden, clear of both side gates.
  masonry(world, 59, T + 1, 58, 67, T + 18, 66, 0.08);
  for (const x of [59, 67]) for (const z of [58, 66]) {
    fillBox(world, x, T + 1, z, x, T + 18, z, PALE);
  }
  for (const y of [T + 12, T + 18]) {
    fillBox(world, 58, y, 57, 68, y, 67, STONE);
  }
  // Seven-cell clock face, with a pale dial and fixed dark hands.
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    if (Math.abs(dx) === 3 && Math.abs(dy) === 3) continue;
    world.setBlock(63 + dx, T + 14 + dy, 67, Math.abs(dx) === 3 || Math.abs(dy) === 3 ? RUST : PALE);
  }
  fillBox(world, 63, T + 14, 67, 63, T + 16, 67, METAL);
  fillBox(world, 63, T + 14, 67, 65, T + 14, 67, METAL);
  // Open belfry: four stone piers hold the roof around a bronze bell.
  for (const x of [59, 67]) for (const z of [58, 66]) fillBox(world, x, T + 19, z, x, T + 21, z, STONE);
  fillBox(world, 62, T + 19, 61, 64, T + 20, 63, RUST);
  fillBox(world, 61, T + 19, 60, 65, T + 19, 64, RUST);
  world.setBlock(63, T + 21, 62, METAL);
  // A steep dark hipped roof gives the skyline a distinct pointed silhouette.
  for (let inset = 0; inset <= 3; inset++) fillBox(world, 58 + inset, T + 22 + inset, 57 + inset, 68 - inset, T + 22 + inset, 67 - inset, ROOF);
}

/** Two real open-front stalls frame a generous central arrival lane. */
function buildSouthMarket(world) {
  const T = GROUND;
  for (const [x0, x1, canopy] of [[47, 57, TEAL_SIDING], [70, 80, PALE]]) {
    paintFloor(world, x0, 67, x1, 71, T, PLANK);
    for (const x of [x0, x1]) for (const z of [67, 71]) fillBox(world, x, T + 1, z, x, T + 5, z, WOOD);
    // Rear shelving and a low counter provide plausible, destructible cover.
    fillBox(world, x0 + 1, T + 1, 67, x1 - 1, T + 2, 67, PLANK);
    fillBox(world, x0 + 1, T + 1, 71, x1 - 3, T + 1, 71, PLANK);
    for (let x = x0; x <= x1; x++) {
      const cloth = (x - x0) % 4 < 2 ? canopy : PLANK;
      for (let z = 66; z <= 73; z++) {
        const rise = z >= 68 && z <= 70 ? 7 : 6;
        world.setBlock(x, T + rise, z, cloth);
      }
    }
    for (let x = x0 + 2; x <= x1 - 2; x += 3) {
      world.setBlock(x, T + 3, 67, x % 2 === 0 ? ACCENT : LEAVES);
      world.setBlock(x, T + 2, 71, PLANK);
    }
    // Timber valance ties the fabric roof to the supporting posts.
    fillBox(world, x0, T + 5, 71, x1, T + 5, 71, WOOD);
  }
}

function matureTree(world, cx, cz) {
  const T = GROUND;
  fillBox(world, cx, T + 1, cz, cx + 1, T + 8, cz + 1, WOOD);
  fillBox(world, cx - 2, T + 6, cz, cx + 3, T + 6, cz + 1, WOOD);
  fillBox(world, cx, T + 7, cz - 2, cx + 1, T + 7, cz + 3, WOOD);
  for (let rise = 7; rise <= 12; rise++) {
    const radius = rise === 12 ? 2 : rise === 7 || rise === 11 ? 4 : 5;
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dz * dz > radius * radius + 3) continue;
      if (world.getBlock(cx + dx, T + rise, cz + dz) === AIR) world.setBlock(cx + dx, T + rise, cz + dz, LEAVES);
    }
  }
  for (const [dx, dz] of [[-1, 0], [2, 1], [0, -1], [1, 2]]) world.setBlock(cx + dx, T + 1, cz + dz, WOOD);
}

/** Large trees and loaded carts make the open flanks into a garrison garden. */
function buildGardenCaravans(world) {
  const T = GROUND;
  for (const [x, z] of [[33, 73], [94, 77], [18, 58]]) matureTree(world, x, z);
  for (const [x, z] of [[29, 61], [92, 69]]) {
    // Four block-built wheels surround an elevated timber cart bed.
    for (const wheelX of [x, x + 6]) for (const wheelZ of [z, z + 3]) {
      fillBox(world, wheelX, T + 1, wheelZ, wheelX, T + 2, wheelZ, STONE);
      world.setBlock(wheelX, T + 2, wheelZ, WOOD);
    }
    fillBox(world, x + 1, T + 2, z, x + 5, T + 2, z + 3, WOOD);
    fillBox(world, x + 1, T + 3, z, x + 5, T + 3, z, PLANK);
    fillBox(world, x + 1, T + 3, z + 3, x + 5, T + 3, z + 3, PLANK);
    fillBox(world, x + 2, T + 3, z + 1, x + 4, T + 4, z + 2, PLANK);
    fillBox(world, x + 7, T + 1, z + 1, x + 9, T + 1, z + 1, WOOD);
  }
}

/** Large heraldry and fitted timberwork remain inside existing wall cells. */
function dressKeepFacades(world) {
  const T = GROUND;
  // The south curtain is the arrival landmark: pale edging around a shield.
  for (let y = T + 2; y <= T + 5; y++) {
    for (let x = 60; x <= 66; x++) {
      const edge = x === 60 || x === 66 || y === T + 5;
      world.setBlock(x, y, 65, edge ? PALE : ACCENT);
    }
  }
  world.setBlock(62, T + 1, 65, PALE);
  world.setBlock(63, T + 1, 65, ACCENT);
  world.setBlock(64, T + 1, 65, PALE);
  fillBox(world, 63, T + 2, 65, 63, T + 5, 65, PALE);
  // Timber hoarding and stone corbels on the solid tower faces.
  for (const [x0, x1, z, high] of [[48, 55, 65, 8], [71, 78, 65, 8], [48, 55, 25, 10], [71, 78, 25, 10]]) {
    fillBox(world, x0 + 2, T + high - 2, z, x1 - 2, T + high - 1, z, PLANK);
    for (const x of [x0 + 2, x1 - 2]) world.setBlock(x, T + high - 3, z, STONE);
  }
  // Ivy follows selected existing masonry joints, never a route or window.
  for (const [x, z, high] of [[13, 29, 4], [43, 34, 4], [48, 54, 5], [78, 36, 4], [113, 57, 6]]) {
    const base = x === 113 ? T + 4 : T + 1;
    for (let y = base; y <= T + high; y++) {
      if (world.getBlock(x, y, z) === BRICK || world.getBlock(x, y, z) === STONE) world.setBlock(x, y, z, LEAVES);
    }
  }
}

/** Small supply and armoury groups occupy the rear court and deck corners. */
function buildGarrisonFurnishings(world) {
  const T = GROUND;
  // Practice shields along the inner south curtain, beyond the gate crosswalk.
  for (const x of [56, 70]) {
    fillBox(world, x, T + 1, 61, x, T + 3, 61, WOOD);
    fillBox(world, x - 1, T + 2, 61, x + 1, T + 3, 61, PLANK);
    world.setBlock(x, T + 3, 61, ACCENT);
    world.setBlock(x, T + 1, 60, STONE);
  }
  // Coopered barrels on stone feet, with a timber supply bench between them.
  for (const [x, z, deck] of [[35, 33, T], [37, 33, T], [92, 39, T + 3], [94, 39, T + 3]]) {
    world.setBlock(x, deck + 1, z, WOOD);
    world.setBlock(x, deck + 2, z, PLANK);
    world.setBlock(x, deck + 3, z, METAL);
  }
  fillBox(world, 92, T + 4, 59, 94, T + 4, 60, PLANK);
  world.setBlock(92, T + 5, 60, WOOD);
  world.setBlock(94, T + 5, 60, WOOD);
  // Courtyard seats tucked beside the fountain garden, clear of site A.
  for (const x of [22, 31]) {
    fillBox(world, x, T + 1, 34, x + 2, T + 1, 34, PLANK);
    world.setBlock(x, T + 2, 34, WOOD);
    world.setBlock(x + 2, T + 2, 34, WOOD);
  }
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
