import { ACCENT, AIR, BRICK, CONCRETE, GLASS, GROUND, METAL, PALE, PLANK, RUST, STONE, SX, SY, SZ } from './blocks.js';
import { fillBox } from './flatmaps.js';
import { MAP_RUN_COURSE } from './metadata.js';

const T = GROUND;
const COURSE = MAP_RUN_COURSE.killhouse;
const STAGES = [24, 54, 84, 109];
const NUMERALS = [
  ['010', '110', '010', '010', '111'],
  ['110', '001', '010', '100', '111'],
  ['110', '001', '010', '001', '110'],
  ['101', '101', '111', '001', '001'],
  ['111', '100', '110', '001', '110'],
  ['011', '100', '110', '101', '111'],
];

/** A covered range and four skylit rooms, built from the authoritative voxels. */
export function addKillhouseSetpieces(world) {
  buildRange(world);
  buildCourse(world);
  buildEntrance(world);
  dressRange(world);
  dressCourse(world);
  dressPerimeter(world);
  buildObservationTower(world);
  buildEquipmentBays(world);
  buildBreachArchitecture(world);
}

function buildRange(world) {
  // Covered firing gallery, with supports outside spawn and firing positions.
  fillBox(world, 7, T + 8, 82, 121, T + 8, 91, METAL);
  fillBox(world, 7, T + 7, 82, 121, T + 7, 82, ACCENT);
  fillBox(world, 7, T + 1, 90, 121, T + 7, 91, CONCRETE);
  fillBox(world, 7, T + 2, 89, 121, T + 2, 89, STONE);
  for (const x of [8, 27, 47, 67, 87, 120]) {
    fillBox(world, x, T + 1, 83, x, T + 7, 83, METAL);
    fillBox(world, x, T + 1, 89, x, T + 7, 89, METAL);
  }
  for (const x of [18, 34, 54, 74, 94, 114]) {
    fillBox(world, x - 3, T + 4, 90, x + 3, T + 5, 90, GLASS);
    fillBox(world, x - 2, T + 7, 85, x + 2, T + 7, 85, PALE);
  }
  for (const x of [24, 44, 84, 104]) {
    fillBox(world, x, T + 1, 77, x, T + 2, 82, PLANK);
    fillBox(world, x, T + 3, 81, x, T + 6, 82, METAL);
  }
  // Tall backstop and side walls enclose the target field without blocking lanes.
  fillBox(world, 8, T + 1, 55, 11, T + 7, 56, CONCRETE);
  fillBox(world, 18, T + 1, 55, 120, T + 7, 56, CONCRETE);
  fillBox(world, 18, T + 3, 57, 120, T + 5, 57, STONE);
  fillBox(world, 18, T + 6, 57, 120, T + 6, 57, ACCENT);
  for (const x of [7, 121]) {
    fillBox(world, x, T + 1, 55, x, T + 7, 90, CONCRETE);
    fillBox(world, x, T + 5, 55, x, T + 5, 90, ACCENT);
  }
}

function buildCourse(world) {
  // The original stage boundaries and removable gates remain the simulation seam.
  for (const z of [27, 47]) {
    fillBox(world, 9, T + 1, z, 118, T + 8, z, CONCRETE);
    fillBox(world, 9, T + 1, z, 118, T + 2, z, BRICK);
    fillBox(world, 9, T + 7, z, 118, T + 7, z, ACCENT);
  }
  for (const x of [9, 118]) fillBox(world, x, T + 1, 28, x, T + 8, 46, CONCRETE);
  // High clerestory strips leave the center open to daylight.
  fillBox(world, 9, T + 9, 27, 118, T + 9, 31, METAL);
  fillBox(world, 9, T + 9, 43, 118, T + 9, 47, METAL);
  for (const gate of COURSE.gates) {
    fillBox(world, gate.x, COURSE.gateY[0], COURSE.gateZ[0], gate.x, COURSE.gateY[1], COURSE.gateZ[1], METAL);
    fillBox(world, gate.x, T + 4, 28, gate.x, T + 9, 46, CONCRETE);
    fillBox(world, gate.x, T + 4, 28, gate.x, T + 4, 46, ACCENT);
  }
  const baffles = [[22, 23, 33, 40], [50, 51, 30, 36], [58, 59, 38, 44],
    [80, 81, 38, 44], [88, 89, 30, 36], [108, 109, 32, 40]];
  for (const [x0, x1, z0, z1] of baffles) {
    fillBox(world, x0, T + 1, z0, x1, T + 2, z1, BRICK);
    fillBox(world, x0, T + 3, z0, x1, T + 3, z1, PLANK);
  }
  for (const [x, z] of [[30, 36], [64, 32], [76, 40], [112, 34]]) {
    fillBox(world, x, T + 1, z, x + 1, T + 2, z + 1, PLANK);
  }
  // Large room numbers are wall inlays, with no extra client geometry or colliders.
  for (let stage = 0; stage < STAGES.length; stage++) {
    const x = STAGES[stage];
    fillBox(world, x - 2, T + 3, 27, x + 2, T + 8, 27, METAL);
    NUMERALS[stage].forEach((row, ry) => [...row].forEach((cell, rx) => {
      if (cell === '1') world.setBlock(x + rx - 1, T + 7 - ry, 27, ACCENT);
    }));
    fillBox(world, x - 2, T + 8, 30, x + 2, T + 8, 30, PALE);
  }
}

function buildEntrance(world) {
  // An open portal frames the start pad; the course starts on foot at ground level.
  fillBox(world, 13, T + 1, 47, 16, T + 4, 47, AIR);
  for (const x of [11, 18]) fillBox(world, x, T + 1, 48, x, T + 6, 49, METAL);
  fillBox(world, 11, T + 6, 48, 18, T + 7, 49, ACCENT);
  // Service walkway and a return door at the finish keep the facility connected.
  fillBox(world, 113, T + 1, 47, 116, T + 4, 47, AIR);
  fillBox(world, 112, T + 5, 47, 117, T + 5, 47, ACCENT);
}

function paintNumeral(world, digit, x, y, z, type = PALE) {
  NUMERALS[digit - 1].forEach((row, ry) => [...row].forEach((cell, rx) => {
    if (cell === '1') world.setBlock(x + rx, y - ry, z, type);
  }));
}

function dressRange(world) {
  const lanes = [18, 34, 54, 74, 94, 114];
  // Numbered firing bays and paper-colored impact panels are wall inlays.
  // Every firing ray, post and divider retains its original solid footprint.
  lanes.forEach((x, index) => {
    fillBox(world, x - 2, T + 2, 90, x + 2, T + 7, 90, METAL);
    paintNumeral(world, index + 1, x - 1, T + 6, 90, ACCENT);
    fillBox(world, Math.max(18, x - 2), T + 3, 57, x + 2, T + 5, 57, PALE);
    world.setBlock(x, T + 4, 57, STONE);
    if (x > 18) world.setBlock(x - 1, T + 3, 57, CONCRETE);
    world.setBlock(x + 1, T + 5, 57, CONCRETE);
    // Diffusers are inset into the existing canopy above each firing position.
    fillBox(world, x - 1, T + 8, 86, x + 1, T + 8, 86, PALE);
  });
  for (const x of [8, 27, 47, 67, 87, 120]) {
    fillBox(world, x, T + 2, 83, x, T + 4, 83, PALE);
    world.setBlock(x, T + 5, 83, ACCENT);
  }
  // Alternating acoustic liner courses and steel seams break up the backstop.
  for (let x = 20; x <= 118; x++) {
    if (x % 8 === 0) fillBox(world, x, T + 1, 56, x, T + 7, 56, METAL);
    else if (x % 3 === 0) world.setBlock(x, T + 2, 56, PLANK);
  }
  for (const x of [7, 121]) {
    for (let z = 60; z <= 84; z += 8) {
      fillBox(world, x, T + 2, z, x, T + 4, z + 3, PALE);
      world.setBlock(x, T + 3, z + 1, STONE);
    }
  }
  for (const x of [24, 44, 84, 104]) {
    fillBox(world, x, T + 2, 77, x, T + 2, 82, PALE);
    world.setBlock(x, T + 2, 77, ACCENT);
  }
}

function dressCourse(world) {
  const finishes = [PALE, PLANK, RUST, STONE];
  // Each room gets a distinct wall finish within the original structural shell:
  // clean instruction bay, plywood drill room, service bay and dark final room.
  COURSE.stages.forEach(([x0, , x1], index) => {
    for (const z of [27, 47]) {
      fillBox(world, x0 + 1, T + 3, z, x1 - 1, T + 6, z, finishes[index]);
      for (let x = x0 + 3; x < x1; x += 8) {
        fillBox(world, x, T + 3, z, x, T + 6, z, CONCRETE);
        world.setBlock(x, T + 6, z, METAL);
      }
    }
    // Paired overhead diffuser strips stay well above player and target height.
    for (const z of [30, 44]) {
      fillBox(world, STAGES[index] - 2, T + 9, z, STAGES[index] + 2, T + 9, z, PALE);
    }
    // Short entry marks indicate room progression without cluttering target pads.
    for (let n = 0; n <= index; n++) {
      world.setBlock(x0 + 2 + n * 2, T, 29, ACCENT);
      world.setBlock(x0 + 2 + n * 2, T, 45, ACCENT);
    }
    // Restore the numeral backing after applying the room's wall treatment.
    const x = STAGES[index];
    fillBox(world, x - 2, T + 3, 27, x + 2, T + 8, 27, METAL);
    paintNumeral(world, index + 1, x - 1, T + 7, 27, ACCENT);
  });
  for (const [x0, x1, z0, z1] of [[22, 23, 33, 40], [50, 51, 30, 36], [58, 59, 38, 44],
    [80, 81, 38, 44], [88, 89, 30, 36], [108, 109, 32, 40]]) {
    // Edge protection makes cover ends easier to read when moving between rooms.
    for (const z of [z0, z1]) fillBox(world, x0, T + 3, z, x1, T + 3, z, PALE);
  }
  // The entrance and finish doors were cut before surface dressing. Their exact
  // existing apertures are restored so the wall inlays cannot refill headroom.
  fillBox(world, 13, T + 1, 47, 16, T + 4, 47, AIR);
  fillBox(world, 113, T + 1, 47, 116, T + 4, 47, AIR);
  fillBox(world, 112, T + 5, 47, 117, T + 5, 47, ACCENT);
}

function dressPerimeter(world) {
  // Reface only the inner occupied layer. The outer METAL containment shell and
  // all wall heights remain intact, with no freestanding props in the range.
  for (let y = T + 1; y <= SY - 8; y++) {
    for (let x = 2; x <= SX - 3; x++) {
      const type = x % 16 < 2 ? METAL : y === T + 9 ? ACCENT : y < T + 5 ? STONE : CONCRETE;
      for (const z of [2, SZ - 3]) world.setBlock(x, y, z, type);
    }
    for (let z = 3; z < SZ - 3; z++) {
      const type = z % 16 < 2 ? METAL : y === T + 9 ? ACCENT : y < T + 5 ? STONE : CONCRETE;
      for (const x of [2, SX - 3]) world.setBlock(x, y, z, type);
    }
  }
  for (let section = 0; section < 6; section++) {
    const x = 20 + section * 18;
    fillBox(world, x - 1, T + 11, 2, x + 3, T + 16, 2, METAL);
    paintNumeral(world, section + 1, x, T + 15, 2);
  }
}

function buildObservationTower(world) {
  const U = T + 4;
  // A full control building occupies the unused north yard. Its broad windowed
  // cabin overlooks the range above both the course roof and the safety backstop.
  fillBox(world, 57, T + 1, 11, 70, U + 10, 22, CONCRETE);
  fillBox(world, 60, T + 1, 14, 67, U + 9, 21, AIR);
  fillBox(world, 62, T + 1, 22, 65, T + 4, 22, AIR);
  for (const x of [57, 70]) fillBox(world, x, T + 1, 11, x, U + 10, 22, METAL);
  fillBox(world, 53, U + 10, 9, 74, U + 10, 25, METAL);
  fillBox(world, 54, U + 11, 10, 73, U + 17, 24, PALE);
  fillBox(world, 55, U + 11, 11, 72, U + 16, 23, AIR);
  for (const z of [10, 24]) fillBox(world, 55, U + 12, z, 72, U + 16, z, GLASS);
  for (const x of [54, 73]) fillBox(world, x, U + 12, 11, x, U + 16, 23, GLASS);
  for (const x of [54, 59, 64, 69, 73]) {
    for (const z of [10, 24]) fillBox(world, x, U + 11, z, x, U + 17, z, METAL);
  }
  fillBox(world, 52, U + 18, 8, 75, U + 18, 26, METAL);
  fillBox(world, 53, U + 17, 25, 74, U + 17, 25, ACCENT);
  // Inside: facing console banks, cabinets and seats are visible through glass.
  fillBox(world, 56, U + 11, 21, 71, U + 12, 22, RUST);
  for (let x = 57; x <= 70; x += 4) {
    fillBox(world, x, U + 13, 22, x + 1, U + 14, 22, GLASS);
    fillBox(world, x, U + 11, 19, x + 1, U + 11, 19, METAL);
    fillBox(world, x, U + 12, 18, x + 1, U + 13, 18, PLANK);
  }
  fillBox(world, 56, U + 11, 12, 58, U + 15, 14, METAL);
  fillBox(world, 69, U + 11, 12, 71, U + 15, 14, METAL);
  // Rooftop HVAC and a recognizable aerial complete the silhouette.
  fillBox(world, 56, U + 19, 11, 61, U + 20, 15, CONCRETE);
  for (const x of [57, 59]) fillBox(world, x, U + 20, 11, x, U + 20, 15, METAL);
  fillBox(world, 69, U + 19, 15, 69, U + 20, 15, METAL);
  fillBox(world, 66, U + 20, 15, 72, U + 20, 15, METAL);
  world.setBlock(69, U + 21, 15, ACCENT);
  // An actual three-block-wide stair and landing reach the observer cabin.
  for (let step = 0; step < 14; step++) {
    const z = 25 - step;
    fillBox(world, 76, T + 1, z, 78, T + 1 + step, z, CONCRETE);
    for (const x of [75, 79]) fillBox(world, x, T + 2 + step, z, x, T + 3 + step, z, METAL);
  }
  fillBox(world, 74, U + 10, 10, 78, U + 10, 13, METAL);
  fillBox(world, 75, U + 11, 11, 75, U + 14, 13, AIR);
  fillBox(world, 73, U + 11, 11, 73, U + 14, 13, AIR);
}

function equipmentShelf(world, x0, z0, width) {
  for (const x of [x0, x0 + width - 1]) {
    for (const z of [z0, z0 + 2]) fillBox(world, x, T + 1, z, x, T + 7, z, METAL);
  }
  for (const y of [T + 1, T + 4, T + 7]) fillBox(world, x0, y, z0, x0 + width - 1, y, z0 + 2, METAL);
  for (let x = x0 + 1; x < x0 + width - 2; x += 3) {
    fillBox(world, x, T + 2, z0, x + 1, T + 3, z0 + 1, PLANK);
    fillBox(world, x, T + 5, z0 + 1, x + 1, T + 6, z0 + 2, RUST);
    world.setBlock(x, T + 3, z0, PALE);
    world.setBlock(x, T + 6, z0 + 2, PALE);
  }
}

function buildEquipmentBays(world) {
  // The two open-faced equipment stores flank the observation tower. Their
  // entire footprint lies north of the original timed-course wall at z27.
  for (const [x0, x1] of [[14, 46], [84, 116]]) {
    fillBox(world, x0, T + 1, 10, x1, T + 9, 22, PALE);
    fillBox(world, x0 + 1, T + 1, 11, x1 - 1, T + 8, 21, AIR);
    fillBox(world, x0 + 3, T + 1, 22, x1 - 3, T + 7, 22, AIR);
    fillBox(world, x0 - 1, T + 10, 9, x1 + 1, T + 10, 23, METAL);
    fillBox(world, x0 + 2, T + 8, 22, x1 - 2, T + 8, 22, ACCENT);
    equipmentShelf(world, x0 + 2, 12, 12);
    equipmentShelf(world, x1 - 13, 12, 12);
    // Workbench, monitor and stacked flight cases leave a wide aisle to shelves.
    fillBox(world, x0 + 3, T + 1, 18, x0 + 9, T + 2, 19, RUST);
    fillBox(world, x0 + 3, T + 3, 18, x0 + 9, T + 3, 19, PALE);
    fillBox(world, x0 + 4, T + 4, 18, x0 + 6, T + 5, 18, GLASS);
    fillBox(world, x1 - 8, T + 1, 18, x1 - 3, T + 3, 20, PLANK);
    fillBox(world, x1 - 7, T + 4, 18, x1 - 5, T + 5, 20, RUST);
    for (const x of [x0 + 6, x1 - 6]) fillBox(world, x, T + 9, 15, x + 3, T + 9, 15, PALE);
  }
  // Full-scale equipment at the gallery's rear stays behind every firing
  // position. The continuous walking aisle at z84..87 remains unobstructed.
  for (const x0 of [29, 49, 89]) {
    fillBox(world, x0, T + 1, 88, x0 + 8, T + 3, 89, METAL);
    fillBox(world, x0, T + 3, 88, x0 + 8, T + 3, 89, PLANK);
    fillBox(world, x0 + 1, T + 4, 89, x0 + 3, T + 5, 89, GLASS);
    fillBox(world, x0 + 6, T + 4, 88, x0 + 7, T + 5, 89, RUST);
  }
  for (const x0 of [9, 69, 109]) {
    fillBox(world, x0, T + 1, 88, x0 + 4, T + 6, 89, PALE);
    for (const x of [x0 + 1, x0 + 3]) {
      fillBox(world, x, T + 2, 88, x, T + 5, 88, METAL);
      world.setBlock(x, T + 4, 88, ACCENT);
    }
  }
}

function buildBreachArchitecture(world) {
  // Turn the existing waist-high baffles into full breach-training wall modules.
  // Their original ground footprint and all walk-around gaps remain unchanged.
  for (const [x0, x1, z0, z1] of [[22, 23, 33, 40], [50, 51, 30, 36], [58, 59, 38, 44],
    [80, 81, 38, 44], [88, 89, 30, 36], [108, 109, 32, 40]]) {
    for (const z of [z0, z1]) fillBox(world, x0, T + 4, z, x1, T + 7, z, METAL);
    fillBox(world, x0, T + 7, z0, x1, T + 7, z1, PLANK);
    fillBox(world, x0, T + 4, z0 + 1, x1, T + 5, z0 + 2, PLANK);
    fillBox(world, x0, T + 4, z1 - 2, x1, T + 5, z1 - 1, PLANK);
    fillBox(world, x0, T + 6, z0 + 1, x1, T + 6, z1 - 1, PALE);
  }
  // Exposed long roof trusses tie the four-room silhouette together above gates.
  for (const z of [28, 46]) {
    fillBox(world, 10, T + 11, z, 117, T + 11, z, METAL);
    for (const x of [10, 39, 41, 69, 71, 99, 101, 117]) {
      fillBox(world, x, T + 9, z, x, T + 10, z, PALE);
    }
  }
}
