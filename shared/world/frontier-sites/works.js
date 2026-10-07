// Flag E, Kessler Works (536, 520): the enterable smelter hall, a conveyor
// from the coal heaps, a rail yard with wagons and a hyperbolic cooling
// tower. Landmarks: two soot-brick chimneys rising to y78.

import {
  AIR, SOOT_BRICK, CORRUGATED_STEEL, METAL, RUST, CONCRETE, BRICK, GRAVEL, SCORCHED_EARTH, PLANK,
  GLASS, TIMBER, PALE, ACCENT,
} from '../blocks.js';
import { FRONTIER_PLAN } from '../../conquest-contract.js';
import { rect, pickSpawnCells, roadClearance } from './plan.js';
import { fieldWall, crateStack, sandbags } from './props.js';

const FLAG = FRONTIER_PLAN.flags.find(f => f.id === 'E');
const HALL = rect(544, 526, 574, 546);
export const CHIMNEY_TOP_Y = FRONTIER_PLAN.heights.landmarkMax;
const CHIMNEYS = [{ id: 'kessler-chimney-west', x: 552.5, z: 554.5 }, { id: 'kessler-chimney-east', x: 564.5, z: 554.5 }];
const COOLING = { x: 508.5, z: 557.5, r: 9.5, rise: 35 };
const JEEP = { x: 520.5, z: 532.5, yaw: Math.PI / 2 };
const COAL = [{ x: 586, z: 560, r: 6, h: 4 }, { x: 596, z: 546, r: 5, h: 3 }];
const RAILS = [568, 574];
const WAGONS = [rect(506, 566, 514, 570), rect(530, 566, 538, 570), rect(548, 572, 556, 576)];
const YARD = rect(556, 502, 566, 510);
const PUMP_HOUSE = rect(508, 523, 515, 530);

export const WORKS_SITE = Object.freeze({
  flag: 'E', site: 'works', x: FLAG.x, z: FLAG.z,
  buildings: Object.freeze([HALL, PUMP_HOUSE]),
  hard: HALL,
  landmarks: Object.freeze([
    Object.freeze({ id: CHIMNEYS[0].id, kind: 'chimney', x: CHIMNEYS[0].x, z: CHIMNEYS[0].z, y: CHIMNEY_TOP_Y, primary: true }),
    Object.freeze({ id: CHIMNEYS[1].id, kind: 'chimney', x: CHIMNEYS[1].x, z: CHIMNEYS[1].z, y: CHIMNEY_TOP_Y }),
    Object.freeze({ id: 'kessler-cooling-tower', kind: 'cooling tower', x: COOLING.x, z: COOLING.z, rise: COOLING.rise }),
  ]),
  vehicle: Object.freeze({ id: 'flag-E-jeep', type: 'jeep', team: 'bravo', ...JEEP }),
  lanes: Object.freeze([
    Object.freeze({ id: 'E-rail-embankment', from: [470, 571], to: [530, 571] }),
    Object.freeze({ id: 'E-yard-alley', from: [600, 515], to: [562, 515] }),
  ]),
  ambush: Object.freeze([
    Object.freeze({ x: 543.5, z: 524.5, faces: 'e-b-ford' }),
    Object.freeze({ x: 526.5, z: 503.5, faces: 'e-c' }),
    Object.freeze({ x: 550.5, z: 511.5, faces: 'hq-east-e' }),
  ]),
  spawns: pickSpawnCells(FLAG.x, FLAG.z, {
    exclude: [HALL, PUMP_HOUSE, rect(516, 528, 524, 536), YARD, rect(523, 494, 541, 499), ...CHIMNEYS.map(c => rect(c.x - 4, c.z - 4, c.x + 4, c.z + 4))],
    radii: [8, 12, 16],
  }),
});

function smelterHall(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = HALL;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, CONCRETE, CONCRETE);
  const eave = y + 11;
  kit.walls(x0, z0, x1, z1, y + 1, eave, SOOT_BRICK);
  // Pilasters and a band of clerestory glazing.
  for (let x = x0; x <= x1; x += 5) { kit.box(x, y + 1, z0 - 1, x, eave, z0 - 1, BRICK); kit.box(x, y + 1, z1 + 1, x, eave, z1 + 1, BRICK); }
  for (let x = x0 + 2; x < x1 - 1; x += 5) { kit.box(x, y + 7, z0, x + 2, y + 9, z0, GLASS); kit.box(x, y + 7, z1, x + 2, y + 9, z1, GLASS); }
  // Rolling door west, two personnel doors and a breach in the east gable.
  kit.box(x0, y + 1, z0 + 7, x0, y + 6, z0 + 13, AIR);
  kit.box(x0 + 8, y + 1, z0, x0 + 9, y + 3, z0, AIR);
  kit.box(x1 - 8, y + 1, z1, x1 - 7, y + 3, z1, AIR);
  kit.box(x1, y + 1, z0 + 4, x1, y + 4, z0 + 6, AIR);
  // Furnaces, a crucible, slag carts and a gantry with a catwalk.
  for (const fx of [x0 + 6, x0 + 16]) {
    kit.box(fx, y + 1, z1 - 6, fx + 4, y + 5, z1 - 2, BRICK);
    kit.box(fx + 1, y + 2, z1 - 6, fx + 3, y + 3, z1 - 6, SCORCHED_EARTH);
    kit.box(fx + 1, y + 6, z1 - 5, fx + 3, y + 10, z1 - 3, SOOT_BRICK);
  }
  kit.cylinder(x1 - 5.5, z0 + 6.5, 2.2, y + 1, y + 3, METAL);
  kit.box(x0 + 12, y + 1, z0 + 3, x0 + 14, y + 2, z0 + 5, RUST);
  kit.box(x0 + 1, y + 8, z0 + 1, x1 - 1, y + 8, z0 + 2, METAL);
  kit.box(x0 + 1, y + 9, z0 + 2, x1 - 1, y + 9, z0 + 2, METAL);
  for (let s = 0; s < 7; s++) kit.box(x1 - 2, y + 1 + s, z0 + 3 + s, x1 - 1, y + 1 + s, z0 + 3 + s, METAL);
  kit.box(x0 + 1, eave - 1, z0 + 10, x1 - 1, eave - 1, z0 + 10, METAL);   // crane rail
  kit.box(x0 + 14, eave - 3, z0 + 9, x0 + 15, eave - 2, z0 + 11, ACCENT);  // hoist
  kit.box(x0 - 1, eave + 1, z0 - 1, x1 + 1, eave + 1, z1 + 1, CORRUGATED_STEEL);
  const ridge = kit.gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, eave + 1, 'x', CORRUGATED_STEEL, SOOT_BRICK);
  // Roof monitor along the ridge.
  kit.box(x0 + 4, ridge + 1, ((z0 + z1) >> 1) - 1, x1 - 4, ridge + 2, ((z0 + z1) >> 1) + 1, CORRUGATED_STEEL);
  kit.feature('building', { id: 'kessler-smelter-hall', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge, enterable: true, hard: true });
  kit.feature('hard-building', { flag: 'E', id: 'kessler-smelter-hall', ...HALL });
}

function chimney(kit, c) {
  const g = kit.top(c.x, c.z);
  kit.cylinder(c.x, c.z, 3.2, g + 1, g + 3, CONCRETE);
  for (let y = g + 4; y <= CHIMNEY_TOP_Y; y++) {
    const r = 2.6 - (y - g) * 0.012;
    kit.cylinder(c.x, c.z, r, y, y, (y - g) % 12 === 0 ? RUST : SOOT_BRICK, true);
  }
  kit.cylinder(c.x, c.z, 2.6, CHIMNEY_TOP_Y, CHIMNEY_TOP_Y, SCORCHED_EARTH, true);
  // A flue duct from the hall's furnaces.
  kit.box(Math.floor(c.x), g + 6, HALL.maxZ + 1, Math.floor(c.x), g + 7, Math.floor(c.z) - 3, RUST);
  kit.feature('landmark', { id: c.id, x: c.x, y: CHIMNEY_TOP_Y, z: c.z });
}

/** Hyperbolic shell with a waist at 70 % height and arched ground openings. */
function coolingTower(kit) {
  const { x, z, r, rise } = COOLING, g = kit.top(x, z);
  for (let k = 1; k <= rise; k++) {
    const t = k / rise;
    const radius = r - 3.4 * Math.sin(Math.min(1, t / 0.7) * Math.PI / 2) + (t > 0.7 ? (t - 0.7) * 3 : 0);
    kit.cylinder(x, z, radius, g + k, g + k, CONCRETE, true);
  }
  kit.cylinder(x, z, r + 0.6, g, g, CONCRETE);
  for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) kit.box(Math.floor(x + dx) - 1, g + 1, Math.floor(z + dz) - 1, Math.floor(x + dx) + 1, g + 3, Math.floor(z + dz) + 1, AIR);
  kit.cylinder(x, z, r - 1.2, g, g, SCORCHED_EARTH);
  kit.feature('building', { id: 'kessler-cooling-tower', minX: Math.floor(x - r), minZ: Math.floor(z - r), maxX: Math.floor(x + r), maxZ: Math.floor(z + r), floorY: g, eave: g + rise, enterable: true });
  kit.feature('landmark', { id: 'kessler-cooling-tower', x, y: g + rise, z });
}

function railYard(kit) {
  for (const rz of RAILS) {
    for (let x = 470; x <= 606; x++) {
      if (roadClearance(x + 0.5, rz + 0.5) < 1) continue;
      const g = kit.top(x, rz);
      kit.box(x, g, rz - 1, x, g, rz + 2, GRAVEL);
      if (x % 2 === 0) kit.box(x, g + 1, rz - 1, x, g + 1, rz + 2, PLANK);
      else { kit.set(x, g + 1, rz - 1, METAL); kit.set(x, g + 1, rz + 2, METAL); }
    }
  }
  WAGONS.forEach((w, n) => {
    const y = kit.maxTop(w.minX, w.minZ, w.maxX, w.maxZ) + 1;
    kit.box(w.minX, y + 1, w.minZ, w.maxX, y + 3, w.maxZ, n === 1 ? METAL : RUST);
    if (n === 1) kit.box(w.minX + 1, y + 3, w.minZ + 1, w.maxX - 1, y + 3, w.maxZ - 1, SCORCHED_EARTH);
    else kit.box(w.minX + 1, y + 2, w.minZ, w.maxX - 1, y + 2, w.minZ, AIR);
    kit.feature('cover', { cover: 'wagon', x: (w.minX + w.maxX) / 2, z: (w.minZ + w.maxZ) / 2, height: 3 });
  });
  // Buffer stop and a water crane.
  const g = kit.top(606, 568);
  kit.box(606, g + 1, 567, 607, g + 2, 571, TIMBER);
  kit.box(598, g + 1, 578, 598, g + 6, 578, METAL); kit.box(598, g + 6, 575, 598, g + 6, 578, METAL);
}

function coal(kit) {
  for (const heap of COAL) {
    const g = kit.top(heap.x, heap.z);
    for (let k = 0; k < heap.h; k++) kit.cylinder(heap.x, heap.z, heap.r * (1 - k / heap.h), g + 1 + k, g + 1 + k, SCORCHED_EARTH);
    kit.feature('cover', { cover: 'coal heap', x: heap.x, z: heap.z, height: heap.h });
  }
  // Inclined conveyor from the heaps to the hall's roof hopper.
  const a = [584, kit.top(584, 552) + 2, 552], b = [HALL.maxX - 2, kit.top(HALL.maxX, HALL.maxZ) + 13, HALL.maxZ - 4];
  kit.line(a[0], a[1], a[2], b[0], b[1], b[2], RUST);
  kit.line(a[0], a[1] + 1, a[2], b[0], b[1] + 1, b[2], METAL);
  for (let i = 0; i <= 3; i++) {
    const t = i / 3, x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t), z = Math.round(a[2] + (b[2] - a[2]) * t);
    kit.box(x, kit.top(x, z) + 1, z, x, y - 1, z, METAL);
  }
}

/** Brick pump house by the cooling ponds: a small hard point west of the flag. */
function pumpHouse(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = PUMP_HOUSE;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, CONCRETE, BRICK);
  kit.walls(x0, z0, x1, z1, y + 1, y + 5, BRICK);
  kit.box(x1, y + 1, z0 + 3, x1, y + 3, z0 + 4, AIR);                 // door toward the flag
  kit.box(x0, y + 3, z0 + 2, x0, y + 3, z1 - 2, AIR);                 // firing slot west
  kit.box(x0 + 2, y + 3, z0, x1 - 2, y + 3, z0, AIR);                 // firing slot north
  kit.box(x0 + 1, y + 1, z0 + 1, x0 + 2, y + 2, z1 - 1, METAL);       // pumps
  kit.box(x0, y + 6, z0, x1, y + 6, z1, CONCRETE);
  kit.line(x0 - 1, y + 2, z1 - 1, x0 - 8, y + 1, z1 + 4, RUST);       // outfall pipe
  kit.feature('building', { id: 'kessler-pump-house', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: y + 6, enterable: true, hard: true });
}

export function buildWorks(kit) {
  for (const c of CHIMNEYS) chimney(kit, c);
  smelterHall(kit);
  coolingTower(kit);
  railYard(kit);
  coal(kit);
  // Yard: brick walls forming the east alley, gas cylinders and pipe racks.
  fieldWall(kit, [[562, 512], [600, 512]], { height: 3 });
  fieldWall(kit, [[562, 518], [576, 518], [576, 524]], { height: 3 });
  fieldWall(kit, [[588, 518], [600, 518]], { height: 3 });
  for (const lane of WORKS_SITE.lanes) kit.feature('lane', { flag: 'E', ...lane });
  for (const [x, z] of [[559, 505], [563, 508]]) { const g = kit.top(x, z); kit.cylinder(x, z, 1.6, g + 1, g + 4, PALE); kit.feature('cover', { cover: 'tank', x, z, height: 4 }); }
  for (let x = 546; x <= 566; x += 5) { const g = kit.top(x, 521); kit.box(x, g + 1, 521, x, g + 5, 521, METAL); }
  kit.box(546, kit.top(546, 521) + 5, 521, 566, kit.top(546, 521) + 5, 521, RUST);
  pumpHouse(kit);
  // Approach cover on the open north and west: a sandbagged pipe stack beside
  // the e-c track, a concrete blast wall and a broken boundary wall.
  sandbags(kit, [[524, 499], [530, 499], [530, 496]]);
  const pg = kit.top(536, 495);
  kit.box(533, pg + 1, 495, 540, pg + 2, 496, CONCRETE);
  kit.feature('cover', { cover: 'blast wall', x: 536.5, z: 495.5, height: 2 });
  fieldWall(kit, [[511, 538], [518, 545]], { height: 2 });
  crateStack(kit, 530, 540, 3, 2, 2);
  crateStack(kit, 546, 512, 2, 2, 1);
  kit.paintRect(516, 528, 524, 536, CONCRETE);
  for (const a of WORKS_SITE.ambush) kit.feature('ambush', { flag: 'E', ...a });
  kit.reserve(JEEP.x - 3.5, JEEP.z - 3.5, JEEP.x + 2.5, JEEP.z + 2.5, 5, 'flag-E-jeep');
}
