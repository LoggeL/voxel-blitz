import { AIR, ACCENT, ASPHALT, BRICK, CONCRETE, GLASS, GROUND, METAL,
  PALE, PLANK, ROOF, RUST, STONE, TEAL_SIDING, TRUCK_RED, WOOD, YELLOW_SIDING } from './blocks.js';
import { fillBox as box, mirroredBox as pair, paintFloor } from './flatmaps.js';

const T = GROUND;

/** Four cross-shaped terminal halls, with loading rooms around both open axes. */
function cargoTerminal(world, x, z, color) {
  box(world, x, T + 1, z, x + 32, T + 11, z + 18, color);
  box(world, x + 1, T + 1, z + 1, x + 31, T + 10, z + 17, AIR);
  for (const edgeZ of [z, z + 18]) {
    box(world, x, T + 1, edgeZ, x + 32, T + 2, edgeZ, CONCRETE);
    box(world, x, T + 9, edgeZ, x + 32, T + 11, edgeZ, METAL);
    for (const columnX of [x, x + 9, x + 23, x + 32]) box(world, columnX, T + 1, edgeZ, columnX, T + 11, edgeZ, METAL);
  }
  // Eleven-wide loading gates and seven-wide side doors retain the old axes.
  box(world, x + 11, T + 1, z, x + 21, T + 5, z + 18, AIR);
  box(world, x, T + 1, z + 6, x + 32, T + 5, z + 12, AIR);
  for (const edgeX of [x, x + 32]) {
    box(world, edgeX, T + 6, z + 5, edgeX, T + 6, z + 13, ACCENT);
    for (const windowZ of [z + 2, z + 14]) box(world, edgeX, T + 5, windowZ, edgeX, T + 7, windowZ + 2, GLASS);
  }
  // Segmented sawtooth roof, skylights and a high clerestory make each hall read
  // as an industrial building in ground views as well as the overhead capture.
  for (const roofZ of [z + 3, z + 8, z + 13]) {
    box(world, x + 1, T + 12, roofZ, x + 31, T + 12, roofZ + 2, ROOF);
    box(world, x + 2, T + 11, roofZ + 1, x + 30, T + 12, roofZ + 1, GLASS);
    box(world, x + 1, T + 13, roofZ, x + 31, T + 13, roofZ, PALE);
  }
  for (const supportX of [x + 2, x + 30]) box(world, supportX, T + 10, z + 1, supportX, T + 10, z + 17, RUST);
  // Occupied corners: packing benches, pallet racks and a glazed dispatch office.
  for (const rackX of [x + 3, x + 26]) {
    box(world, rackX, T + 1, z + 2, rackX + 3, T + 2, z + 4, WOOD);
    box(world, rackX, T + 4, z + 2, rackX + 3, T + 4, z + 4, METAL);
    for (const legX of [rackX, rackX + 3]) box(world, legX, T + 1, z + 2, legX, T + 5, z + 2, METAL);
    box(world, rackX + 1, T + 5, z + 3, rackX + 2, T + 6, z + 4, PLANK);
  }
  box(world, x + 2, T + 1, z + 14, x + 8, T + 5, z + 17, CONCRETE);
  box(world, x + 3, T + 1, z + 14, x + 7, T + 4, z + 16, AIR);
  box(world, x + 3, T + 3, z + 14, x + 7, T + 4, z + 14, GLASS);
  box(world, x + 8, T + 1, z + 14, x + 8, T + 3, z + 16, AIR);
  box(world, x + 25, T + 1, z + 14, x + 29, T + 2, z + 16, PLANK);
  // Five-deep covered loading apron. Columns stand outside the loading axis.
  for (const edgeZ of [z - 3, z + 21]) {
    box(world, x + 8, T + 7, edgeZ, x + 24, T + 7, edgeZ, METAL);
    for (const supportX of [x + 8, x + 24]) box(world, supportX, T + 1, edgeZ, supportX, T + 7, edgeZ, RUST);
    box(world, x + 8, T + 7, Math.min(edgeZ, edgeZ < z ? z : z + 18), x + 24, T + 7, Math.max(edgeZ, edgeZ < z ? z : z + 18), PALE);
  }
}

/** Ribbed shipping boxes; open units are genuine ground-level through passages. */
function container(world, x, z, length, color, open = false, base = 1) {
  pair(world, x, T + base, z, x + 8, T + base + 5, z + length, color);
  if (open) pair(world, x + 1, T + base, z, x + 7, T + base + 4, z + length, AIR);
  for (let dz = 0; dz <= length; dz += 4) {
    for (const edgeX of [x, x + 8]) pair(world, edgeX, T + base, z + dz, edgeX, T + base + 5, z + dz, METAL);
  }
  for (const edgeZ of [z, z + length]) pair(world, x, T + base + 5, edgeZ, x + 8, T + base + 5, edgeZ, PALE);
}

function maintenanceShed(world) {
  // Paired outer service halls occupy a formerly blank flank; both ends open.
  pair(world, 6, T + 1, 39, 18, T + 7, 53, TEAL_SIDING);
  pair(world, 7, T + 1, 40, 17, T + 6, 52, AIR);
  pair(world, 10, T + 1, 39, 15, T + 5, 53, AIR);
  pair(world, 6, T + 7, 38, 18, T + 7, 54, METAL);
  pair(world, 7, T + 8, 40, 17, T + 8, 52, ROOF);
  pair(world, 8, T + 1, 44, 9, T + 3, 48, RUST);
  pair(world, 17, T + 1, 42, 17, T + 2, 49, PLANK);
  for (const z of [42, 49]) pair(world, 6, T + 4, z, 6, T + 5, z + 2, GLASS);
}

/** Low tractor-trailer silhouette and cargo platform, clear of Dock A's pad. */
function freightTruck(world) {
  pair(world, 27, T + 2, 54, 44, T + 2, 59, METAL);
  for (const x of [28, 30, 38, 42]) for (const z of [54, 59]) pair(world, x, T + 1, z, x + 1, T + 2, z, STONE);
  pair(world, 28, T + 3, 54, 38, T + 6, 59, PALE);
  pair(world, 29, T + 4, 55, 37, T + 5, 58, AIR);
  pair(world, 28, T + 4, 55, 28, T + 5, 58, AIR);
  pair(world, 28, T + 5, 54, 38, T + 5, 54, TEAL_SIDING);
  pair(world, 28, T + 5, 59, 38, T + 5, 59, TEAL_SIDING);
  pair(world, 40, T + 3, 54, 44, T + 5, 59, TRUCK_RED);
  pair(world, 44, T + 4, 55, 44, T + 5, 58, GLASS);
  pair(world, 40, T + 6, 54, 44, T + 6, 59, METAL);
  pair(world, 44, T + 3, 55, 44, T + 3, 58, PALE);
}

/** Wide dock courts have overhead shelter and corner cover outside both sites. */
function coveredDock(world) {
  for (const x of [24, 45]) for (const z of [60, 81]) {
    pair(world, x, T + 1, z, x + 1, T + 8, z + 1, METAL);
    pair(world, x, T + 1, z, x + 2, T + 2, z + 2, CONCRETE);
  }
  pair(world, 24, T + 8, 60, 46, T + 8, 82, METAL);
  pair(world, 27, T + 8, 65, 43, T + 8, 78, AIR);
  for (const x of [28, 34, 40]) pair(world, x, T + 8, 65, x, T + 8, 78, PALE);
  pair(world, 24, T + 9, 60, 46, T + 9, 61, YELLOW_SIDING);
  pair(world, 24, T + 9, 81, 46, T + 9, 82, YELLOW_SIDING);
  // Dockside pump equipment and long wall make the outer lane feel occupied.
  pair(world, 7, T + 1, 65, 17, T + 1, 78, CONCRETE);
  for (const z of [66, 74]) {
    pair(world, 8, T + 2, z, 15, T + 4, z + 3, METAL);
    pair(world, 9, T + 5, z + 1, 14, T + 5, z + 2, PALE);
    pair(world, 8, T + 3, z, 8, T + 3, z + 3, ACCENT);
  }
  pair(world, 20, T + 1, 68, 23, T + 2, 73, WOOD);
  pair(world, 46, T + 1, 66, 48, T + 2, 70, PLANK);
}

/** A tall open steel gantry, hoist, operator cabin and cantilevered crane boom. */
function freightGantry(world) {
  for (const x of [87, 102]) for (const z of [63, 78]) {
    box(world, x - 1, T + 1, z - 1, x + 3, T + 2, z + 3, CONCRETE);
    for (const edgeX of [x, x + 2]) box(world, edgeX, T + 3, z, edgeX, T + 20, z + 2, RUST);
    for (let y = 4; y <= 18; y += 3) box(world, x, T + y, z + 1, x + 2, T + y, z + 1, ACCENT);
  }
  for (const z of [62, 81]) {
    box(world, 85, T + 19, z, 107, T + 19, z + 1, METAL);
    box(world, 85, T + 22, z, 107, T + 22, z + 1, ACCENT);
    for (let x = 85; x <= 107; x += 4) box(world, x, T + 20, z, x + 1, T + 21, z + 1, RUST);
  }
  for (const x of [86, 105]) box(world, x, T + 21, 50, x + 1, T + 22, 94, METAL);
  for (let z = 50; z <= 94; z += 5) box(world, 86, T + 22, z, 106, T + 22, z + 1, ACCENT);
  box(world, 85, T + 17, 68, 90, T + 20, 75, YELLOW_SIDING);
  box(world, 85, T + 18, 69, 90, T + 19, 74, GLASS);
  box(world, 93, T + 21, 69, 99, T + 22, 76, RUST);
  for (const x of [93, 99]) box(world, x, T + 11, 72, x, T + 20, 72, METAL);
  box(world, 92, T + 10, 70, 100, T + 11, 74, METAL);
  box(world, 93, T + 7, 71, 99, T + 9, 73, RUST);
  // A raised service catwalk crosses the west approach with stairs at both ends.
  box(world, 68, T + 5, 69, 81, T + 5, 73, METAL);
  for (const z of [69, 73]) box(world, 68, T + 6, z, 81, T + 6, z, PALE);
  for (let step = 1; step <= 5; step++) {
    box(world, 62 + step, T + 1, 70, 62 + step, T + step, 72, PLANK);
    box(world, 87 - step, T + 1, 70, 87 - step, T + step, 72, PLANK);
  }
}

/** Open arrival shelters give every spawn row nearby cover without moving it. */
function arrivalBays(world) {
  for (const x of [12, 56, 100, 144]) {
    for (const px of [x, x + 34]) for (const z of [6, 22]) pair(world, px, T + 1, z, px, T + 7, z, METAL);
    pair(world, x, T + 7, 6, x + 34, T + 7, 22, ROOF);
    pair(world, x + 2, T + 7, 12, x + 32, T + 7, 17, AIR);
    for (const px of [x + 8, x + 17, x + 26]) pair(world, px, T + 7, 12, px, T + 7, 17, METAL);
    pair(world, x, T + 8, 6, x + 34, T + 8, 6, TEAL_SIDING);
    pair(world, x, T + 8, 22, x + 34, T + 8, 22, PALE);
    pair(world, x + 10, T + 1, 6, x + 24, T + 3, 6, CONCRETE);
    pair(world, x + 12, T + 4, 6, x + 22, T + 5, 6, YELLOW_SIDING);
  }
}

export function buildHarborArchitecture(world) {
  paintFloor(world, 4, 4, 187, 139, T, ASPHALT);
  for (const x of [18, 73, 118, 173]) paintFloor(world, x, 23, x + 1, 120, T, PALE);
  for (const z of [25, 52, 91, 118]) paintFloor(world, 8, z, 183, z + 1, T, PALE);
  cargoTerminal(world, 28, 29, TEAL_SIDING);
  cargoTerminal(world, 132, 29, YELLOW_SIDING);
  cargoTerminal(world, 28, 96, YELLOW_SIDING);
  cargoTerminal(world, 132, 96, TEAL_SIDING);
  for (const [x, z, length, color, open] of [[49, 58, 19, RUST, false], [58, 82, 18, TEAL_SIDING, true],
    [80, 34, 17, RUST, true], [106, 51, 15, YELLOW_SIDING, false]]) container(world, x, z, length, color, open);
  container(world, 49, 58, 9, TEAL_SIDING, false, 7);
  container(world, 68, 31, 14, YELLOW_SIDING, true);
  maintenanceShed(world);
  freightTruck(world);
  coveredDock(world);
  freightGantry(world);
  arrivalBays(world);
  // Segmented roadside barriers shorten exposed runs without closing the roads.
  for (const [x, z] of [[20, 32], [68, 55], [72, 95]]) {
    pair(world, x, T + 1, z, x + 6, T + 2, z + 1, CONCRETE);
    pair(world, x, T + 2, z, x + 6, T + 2, z, ACCENT);
  }
  for (const x of [12, 78, 168]) pair(world, x, T + 1, 24, x + 10, T + 3, 25, BRICK);
}
