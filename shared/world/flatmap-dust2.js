import {
  AIR, SAND, STONE, WOOD, LEAVES, CONCRETE, METAL, PLANK, PALE, BRICK,
  TEAL_SIDING, TRUCK_RED, GROUND,
} from './blocks.js';
import { generateFlatBase, fillBox, paintFloor } from './flatmaps.js';

/**
 * Dust 2's connected street plan, compressed to the shared 128 x 96 arena.
 * North is -z: B/Kasbah left, A/hotel right, CT behind mid, T to the south.
 * All walls, doors, roofs, stairs and cover are authoritative voxel geometry.
 */
export function generateDust2Into(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  const b = (x, y, z, X, Y, Z, material) =>
    fillBox(world, x, GROUND + y, z, X, GROUND + Y, Z, material);
  const f = (x, z, X, Z, material, level = 0) =>
    paintFloor(world, x, z, X, Z, GROUND + level, material);

  // A sandstone town fills the gaps between routes. Carving streets from the
  // same solid mass prevents accidental shortcuts behind decorative buildings.
  b(0, 1, 0, 127, 25, 95, AIR);
  f(0, 0, 127, 95, SAND);
  b(0, 1, 0, 127, 10, 95, SAND);
  b(0, 10, 0, 127, 10, 95, PALE);
  const streets = [
    [40, 77, 88, 89], // T spawn court
    [51, 59, 75, 82], // T slope / top mid
    [16, 70, 57, 80], // outside tunnels
    [18, 32, 30, 72], // upper tunnels north-south
    [16, 53, 35, 68], // upper tunnel chamber
    [30, 46, 55, 54], // lower tunnels to mid
    [12, 10, 39, 32], // B site / Kasbah
    [38, 20, 53, 28], // B doors to CT
    [45, 15, 58, 25], // CT western approach
    [49, 7, 83, 23], // CT spawn courtyard
    [51, 20, 67, 63], // middle lane and double doors
    [68, 38, 76, 65], // raised catwalk
    [68, 29, 93, 39], // A short turns east
    [76, 24, 93, 31], // CT approach to A
    [87, 10, 111, 32], // raised A site
    [105, 23, 117, 58], // A long
    [96, 46, 117, 58], // long corner and pit
    [89, 59, 104, 68], // long double-door passage
    [100, 49, 117, 74], // outer long court
    [76, 65, 111, 81], // T route to long doors
  ];
  for (const [x, z, X, Z] of streets) b(x, 1, z, X, 15, Z, AIR);

  // The CT-to-A route and short meet the three-block raised bomb platform.
  b(87, 1, 10, 111, 3, 32, SAND);
  f(87, 10, 111, 32, PALE, 3);
  b(68, 1, 29, 86, 3, 39, SAND);
  f(68, 29, 86, 39, PALE, 3);
  b(68, 1, 40, 76, 3, 60, SAND);
  f(68, 40, 76, 60, PALE, 3);
  b(86, 1, 24, 86, 3, 31, SAND);
  // Each tread is two cells deep. One-block rises stay within shared vault
  // reach and leave enough horizontal room for an ordinary jump to settle.
  for (let step = 0; step < 3; step++) {
    b(69, 1, 65 - step * 2, 75, step + 1, 66 - step * 2, SAND);
    f(69, 65 - step * 2, 75, 66 - step * 2, PALE, step + 1);
    b(80 + step * 2, 1, 24, 81 + step * 2, step + 1, 31, SAND);
    f(80 + step * 2, 24, 81 + step * 2, 31, PALE, step + 1);
    b(109, 1, 37 - step * 2, 117, step + 1, 38 - step * 2, SAND);
    f(109, 37 - step * 2, 117, 38 - step * 2, PALE, step + 1);
  }
  b(112, 1, 23, 117, 3, 32, SAND);
  f(112, 23, 117, 32, PALE, 3);

  // The narrow raised edge overlooking mid is the recognizable catwalk. Its
  // knee-high parapet protects the lane without closing sightlines across mid.
  b(68, 4, 40, 68, 4, 59, SAND);
  b(68, 4, 29, 78, 4, 29, SAND);
  b(69, 4, 29, 77, 4, 29, PALE);
  b(87, 4, 10, 111, 4, 10, SAND);
  b(111, 4, 11, 111, 4, 18, SAND);
  b(87, 4, 11, 87, 4, 19, SAND);
  // Short's elbow has a separate shoulder of cover; its center stays clear.
  b(80, 4, 37, 83, 5, 39, SAND);
  b(80, 5, 37, 83, 5, 39, PALE);

  // Mid doors frame the long north-south sightline. Timber leaves stand open
  // at opposite sides, with a full five-cell opening through their arch.
  b(51, 1, 29, 67, 9, 31, SAND);
  archZ(b, 54, 29, 10, 0, 7, 3);
  doorLeaf(b, 55, 0, 28, 'z', 4);
  doorLeaf(b, 63, 0, 31, 'z', 4);
  crate(b, 64, 53, 3, 3, 3);
  crate(b, 52, 40, 3, 4, 3);

  // B is an enclosed Kasbah with separate tunnel and CT entrances.
  b(12, 1, 31, 39, 9, 33, SAND);
  archZ(b, 19, 31, 10, 0, 7, 3);
  b(40, 1, 17, 42, 9, 31, SAND);
  archX(b, 40, 20, 8, 0, 7, 3);
  doorLeaf(b, 39, 0, 20, 'x', 3);
  doorLeaf(b, 42, 0, 27, 'x', 3);
  // B window: an optional vault shortcut, distinct from the broad doors.
  b(39, 1, 13, 42, 9, 18, SAND);
  b(39, 2, 14, 42, 5, 17, AIR);
  b(43, 1, 14, 44, 6, 20, AIR);
  b(38, 1, 14, 38, 1, 17, PALE);
  b(43, 1, 14, 43, 1, 17, PALE);

  // A covered upper-tunnel axis opens through the south arch into B. Skylight
  // slots are real openings, so daylight and grenade trajectories agree.
  b(18, 8, 34, 30, 8, 56, SAND);
  b(16, 8, 54, 35, 8, 68, SAND);
  b(18, 9, 34, 18, 9, 56, PALE);
  b(30, 9, 34, 30, 9, 56, PALE);
  for (const z of [39, 48, 59]) {
    b(22, 8, z, 27, 9, z + 2, AIR);
    b(21, 9, z - 1, 28, 9, z - 1, PALE);
    b(21, 9, z + 3, 28, 9, z + 3, PALE);
  }
  // Masonry ribs leave the central tunnel corridor at least nine cells wide.
  for (const z of [36, 44, 52, 62]) {
    b(18, 1, z, 19, 6, z, PALE);
    b(29, 1, z, 30, 6, z, PALE);
    b(19, 7, z, 29, 7, z, PALE);
  }
  b(31, 7, 46, 48, 7, 54, SAND);
  b(31, 6, 46, 48, 6, 46, PALE);
  b(31, 6, 54, 48, 6, 54, PALE);
  crate(b, 17, 56, 3, 4, 3);
  crate(b, 31, 63, 3, 4, 3);
  crate(b, 32, 47, 3, 3, 3);
  f(20, 35, 28, 68, CONCRETE);
  f(31, 48, 49, 52, CONCRETE);
  for (const z of [37, 45, 53, 61]) f(21, z, 28, z, SAND);

  // Long double doors turn a blind corner before the open eastern lane.
  // The elbow's outer wall makes the doors the actual connection from T;
  // the eastern courtyard cannot bypass their hinge by looping south.
  b(97, 1, 69, 99, 10, 81, SAND);
  b(100, 1, 75, 117, 10, 81, SAND);
  b(97, 10, 69, 99, 10, 81, PALE);
  b(100, 10, 75, 117, 10, 81, PALE);
  b(96, 1, 57, 99, 10, 59, SAND);
  b(96, 10, 57, 99, 10, 59, PALE);
  b(97, 1, 59, 99, 9, 68, SAND);
  archX(b, 97, 60, 8, 0, 7, 3);
  doorLeaf(b, 96, 0, 60, 'x', 4);
  doorLeaf(b, 99, 0, 67, 'x', 4);
  b(89, 8, 59, 100, 8, 68, PALE);
  b(90, 9, 59, 100, 9, 59, SAND);
  b(90, 9, 68, 100, 9, 68, SAND);
  crate(b, 101, 54, 3, 3, 4);
  crate(b, 115, 63, 2, 3, 4);
  // The pit is a sheltered ground-level recess at long's south-west corner.
  b(96, 1, 46, 104, 2, 47, SAND);
  b(96, 1, 48, 97, 3, 56, SAND);
  f(98, 49, 103, 57, CONCRETE);
  b(104, 1, 49, 104, 2, 52, SAND);

  // Site boxes ring deliberately clear plant rectangles: B x23..30,z20..27;
  // A x96..103,z21..28. No trim, prop or paint raises those walking floors.
  crate(b, 15, 24, 5, 5, 4);
  crate(b, 17, 27, 4, 4, 3);
  crate(b, 32, 19, 5, 5, 5);
  crate(b, 33, 28, 4, 3, 3);
  crate(b, 91, 13, 5, 5, 4, 3);
  crate(b, 91, 25, 4, 4, 4, 3);
  crate(b, 104, 16, 5, 4, 4, 3);
  crate(b, 105, 28, 4, 3, 3, 3);
  plantMark(f, 23, 20, 30, 27, 0);
  plantMark(f, 96, 21, 103, 28, 3);

  // Local cover gives spawn courts and rotations useful shoulders without
  // placing objects on the authored spawn pads or collectible anchors.
  crate(b, 42, 78, 4, 3, 4);
  crate(b, 82, 83, 4, 4, 4);
  crate(b, 79, 9, 3, 3, 3);
  crate(b, 47, 17, 3, 4, 3);
  crate(b, 80, 70, 4, 3, 3);
  barrel(b, 37, 29); barrel(b, 15, 19); barrel(b, 88, 78);
  barrel(b, 108, 44); barrel(b, 51, 26);

  dressTown(world, b, f);
}

/** Stepped masonry arch cut through a z-facing wall, all widths inclusive. */
function archZ(b, x, z, width, floor, height, depth) {
  b(x, floor + 1, z, x + width - 1, floor + height + 1, z + depth - 1, PALE);
  b(x + 1, floor + 1, z, x + width - 2, floor + height - 2, z + depth - 1, AIR);
  b(x + 2, floor + height - 1, z, x + width - 3, floor + height - 1, z + depth - 1, AIR);
  b(x + 3, floor + height, z, x + width - 4, floor + height, z + depth - 1, AIR);
}

function archX(b, x, z, width, floor, height, depth) {
  archZ((a, y, c, A, Y, C, material) => b(c, y, a, C, Y, A, material),
    z, x, width, floor, height, depth);
}

/** Open wooden gate leaf, including its iron braces and hinge heads. */
function doorLeaf(b, x, floor, z, direction, length) {
  const leaf = direction === 'z'
    ? (y, Y, material) => b(x, floor + y, z, x, floor + Y, z + length - 1, material)
    : (y, Y, material) => b(x, floor + y, z, x + length - 1, floor + Y, z, material);
  leaf(1, 5, WOOD);
  for (const y of [2, 4]) leaf(y, y, METAL);
  b(x, floor + 3, z, x, floor + 3, z, PALE);
}

function crate(b, x, z, width, depth, height, floor = 0) {
  b(x, floor + 1, z, x + width - 1, floor + height, z + depth - 1, PLANK);
  for (const px of [x, x + width - 1]) {
    for (const pz of [z, z + depth - 1]) {
      b(px, floor + 1, pz, px, floor + height, pz, WOOD);
    }
  }
  for (const pz of [z, z + depth - 1]) {
    b(x, floor + 1, pz, x + width - 1, floor + 1, pz, WOOD);
    b(x, floor + height, pz, x + width - 1, floor + height, pz, WOOD);
    for (let i = 1; i < Math.min(width - 1, height - 1); i++) {
      b(x + i, floor + i + 1, pz, x + i, floor + i + 1, pz, WOOD);
    }
  }
}

function barrel(b, x, z) {
  b(x, 1, z, x + 1, 3, z + 1, TEAL_SIDING);
  for (const y of [1, 3]) b(x, y, z, x + 1, y, z + 1, METAL);
}

function plantMark(f, x, z, X, Z, level) {
  f(x, z, X, z, TRUCK_RED, level); f(x, Z, X, Z, TRUCK_RED, level);
  f(x, z, x, Z, TRUCK_RED, level); f(X, z, X, Z, TRUCK_RED, level);
  f(x + 1, z + 1, x + 2, z + 1, PALE, level);
  f(X - 2, Z - 1, X - 1, Z - 1, PALE, level);
}

function dressTown(world, b, f) {
  // Weathered pale plaster over sandstone, stone skirting and cornice. Only
  // existing building faces are recoloured, keeping every street unmodified.
  for (let z = 6; z < 90; z++) for (let x = 7; x < 121; x++) {
    if (world.getBlock(x, GROUND + 1, z) !== SAND
      || world.getBlock(x, GROUND + 9, z) !== SAND) continue;
    const exposed = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) =>
      world.getBlock(x + dx, GROUND + 4, z + dz) === AIR);
    if (!exposed) continue;
    b(x, 1, z, x, 1, z, STONE);
    for (let y = 3; y <= 8; y++) {
      if (world.getBlock(x, GROUND + y, z) !== AIR
        && (x * 13 + z * 7 + y * 3) % 19 > 3) b(x, y, z, x, y, z, PALE);
    }
    b(x, 9, z, x, 9, z, SAND);
    b(x, 10, z, x, 10, z, PALE);
  }

  // Uneven flat roofs distinguish the Kasbah, hotel and market silhouettes.
  // Extensions apply only to solid town columns, never across an open street.
  for (const [x, z, X, Z, h] of [
    [7, 6, 42, 9, 13], [7, 10, 11, 36, 12], [32, 35, 49, 43, 13],
    [78, 40, 104, 58, 14], [88, 70, 98, 76, 12], [30, 57, 48, 68, 12],
    [43, 6, 48, 14, 12], [85, 6, 119, 9, 13], [45, 90, 93, 93, 12],
  ]) {
    for (let pz = z; pz <= Z; pz++) for (let px = x; px <= X; px++) {
      if (world.getBlock(px, GROUND + 9, pz) !== AIR
        && world.getBlock(px, GROUND + 1, pz) !== AIR) {
        b(px, 11, pz, px, h, pz, SAND);
        b(px, h, pz, px, h, pz, PALE);
      }
    }
  }

  // Blue shutters, dark recessed windows and narrow sills on actual facades.
  for (const [x, z, face] of [
    [19, 9, 1], [32, 9, 1], [55, 6, 1], [72, 6, 1], [96, 9, 1],
    [57, 90, -1], [74, 90, -1], [39, 69, 1], [46, 69, 1],
    [81, 64, 1], [89, 64, 1], [78, 28, 1],
  ]) {
    if (world.getBlock(x, GROUND + 6, z) === AIR) continue;
    b(x - 1, 5, z, x + 3, 8, z, SAND);
    b(x, 6, z, x + 2, 7, z, METAL);
    b(x - 1, 6, z + face, x - 1, 7, z + face, TEAL_SIDING);
    b(x + 3, 6, z + face, x + 3, 7, z + face, TEAL_SIDING);
    b(x - 1, 5, z + face, x + 3, 5, z + face, PALE);
  }
  // Hotel windows face A long along the x-facing facade.
  for (const z of [37, 44, 52]) {
    b(104, 6, z, 104, 9, z + 3, SAND);
    b(104, 7, z + 1, 104, 8, z + 2, METAL);
    b(105, 7, z, 105, 8, z, TEAL_SIDING);
    b(105, 7, z + 3, 105, 8, z + 3, TEAL_SIDING);
    b(105, 6, z, 105, 6, z + 3, PALE);
  }

  // North-west minaret, stepped dome and roof battlements are skyline anchors.
  b(6, 11, 6, 11, 18, 11, SAND);
  b(5, 18, 5, 12, 18, 12, PALE);
  b(7, 19, 7, 10, 20, 10, PALE);
  b(8, 21, 8, 9, 21, 9, SAND);
  for (const x of [7, 10]) b(x, 15, 11, x, 16, 11, METAL);
  for (let x = 13; x <= 38; x += 4) b(x, 14, 8, x + 1, 14, 9, SAND);
  // A smaller hotel roof turret and rooftop water tank break the east skyline.
  b(89, 15, 43, 94, 17, 48, SAND);
  b(90, 18, 44, 93, 18, 47, PALE);
  b(91, 19, 45, 92, 19, 46, PALE);
  b(97, 15, 52, 100, 18, 55, PALE);
  b(97, 19, 52, 100, 19, 55, METAL);

  // Shallow closed market stalls and a hotel doorway occupy wall recesses.
  for (const [x, z] of [[78, 76], [31, 68]]) {
    b(x, 1, z, x + 5, 4, z, WOOD);
    b(x - 1, 5, z, x + 6, 5, z + 2, TEAL_SIDING);
    b(x - 1, 1, z + 2, x - 1, 4, z + 2, WOOD);
    b(x + 6, 1, z + 2, x + 6, 4, z + 2, WOOD);
    b(x, 1, z + 1, x + 5, 1, z + 1, PLANK);
  }
  // Wall drains and paving seams provide human scale without trip hazards.
  for (let z = 35; z <= 58; z += 6) f(52, z, 53, z + 1, STONE);
  for (let z = 39; z <= 56; z += 7) f(116, z, 117, z + 1, STONE);
  for (let x = 48; x <= 81; x += 8) f(x, 88, x + 2, 88, PALE);
  // Potted date palms on roof corners remain outside movement and shot lanes.
  palm(b, 11, 39, 10); palm(b, 119, 20, 10); palm(b, 91, 86, 10);
  // A weathered red car beside A long, below the ramp and away from its pad.
  b(107, 1, 39, 109, 1, 43, METAL);
  b(107, 2, 39, 109, 2, 43, TRUCK_RED);
  b(107, 3, 40, 109, 3, 42, TRUCK_RED);
  b(107, 3, 40, 107, 3, 41, METAL);
  b(109, 3, 40, 109, 3, 41, METAL);
}

function palm(b, x, z, floor) {
  b(x - 1, floor + 1, z - 1, x + 1, floor + 1, z + 1, BRICK);
  b(x, floor + 2, z, x, floor + 8, z, WOOD);
  b(x - 4, floor + 8, z - 1, x + 4, floor + 8, z + 1, LEAVES);
  b(x - 1, floor + 8, z - 4, x + 1, floor + 8, z + 4, LEAVES);
  b(x - 2, floor + 9, z - 2, x + 2, floor + 9, z + 2, LEAVES);
  b(x, floor + 10, z, x, floor + 10, z, LEAVES);
}
