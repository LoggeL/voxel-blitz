import { ACCENT, AIR, BRICK, CONCRETE, GLASS, GROUND, METAL, PALE, PLANK, STONE } from './blocks.js';
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
];

/** A covered range and four skylit rooms, built from the authoritative voxels. */
export function addKillhouseSetpieces(world) {
  buildRange(world);
  buildCourse(world);
  buildEntrance(world);
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
