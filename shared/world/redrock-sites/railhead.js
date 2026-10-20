// Flag E, Sulphur Railhead (518, 540): the end of a desert branch line. A
// steel water tower over the track, the brick station house (the hard
// point), the long engine shed the rails run into, a freight office, yellow
// sulphur heaps and a string of boxcars on the siding. Landmark: the water
// tower, readable from either HQ.
//
// The lots mirror Copperhead Mine's (flag B), so routes and cover distances
// match; every structure is different.

import {
  AIR, BRICK, CORRUGATED_STEEL, METAL, RUST, CONCRETE, PLANK, GLASS, DUST_CRATE, TIMBER, STONE, DUST_PLASTER,
  TERRACOTTA_ROOF, BUS_YELLOW, TRUCK_RED, TEAL_SIDING, PALE, GRAVEL,
} from '../blocks.js';
import { REDROCK_PLAN } from '../redrock-plan.js';
import { rect, pickSpawnCells, wall } from './plan.js';
import { adobe, railTrack, boxcar } from './props.js';
import { crateStack } from '../frontier-sites/props.js';

const FLAG = REDROCK_PLAN.flags.find(f => f.id === 'E');
const TOWER = { x: 538.5, z: 552.5, rise: 24 };
const STATION = rect(522, 560, 532, 570);
const ENGINE_SHED = rect(496, 556, 514, 570);
const FREIGHT = rect(546, 526, 556, 536);
const HEAPS = [{ x: 479.5, z: 560.5, r: 7, h: 5 }, { x: 557.5, z: 572.5, r: 6, h: 4 }];
const RAIL_Z = 588, RAIL_X0 = 470, RAIL_X1 = 584;
const SIDING_Z = 563;
const JEEP = { x: 505.5, z: 548.5, yaw: -Math.PI / 2 };
const CARS = [{ x: 478, colour: TRUCK_RED }, { x: 490, colour: TEAL_SIDING }, { x: 532, colour: RUST }, { x: 552, colour: TRUCK_RED }];

export const RAILHEAD_SITE = Object.freeze({
  flag: 'E', site: 'railhead', x: FLAG.x, z: FLAG.z,
  buildings: Object.freeze([STATION, ENGINE_SHED, FREIGHT]),
  hard: STATION,
  heaps: Object.freeze(HEAPS.map(h => Object.freeze({ ...h }))),
  rail: Object.freeze({ z: RAIL_Z, x0: RAIL_X0, x1: RAIL_X1, siding: SIDING_Z }),
  landmarks: Object.freeze([
    Object.freeze({ id: 'sulphur-water-tower', kind: 'water tower', x: TOWER.x, z: TOWER.z, rise: TOWER.rise, primary: true }),
    Object.freeze({ id: 'sulphur-engine-shed', kind: 'engine shed', x: (ENGINE_SHED.minX + ENGINE_SHED.maxX + 1) / 2, z: (ENGINE_SHED.minZ + ENGINE_SHED.maxZ + 1) / 2, rise: 14 }),
  ]),
  vehicle: Object.freeze({ id: 'flag-E-jeep', type: 'jeep', team: 'bravo', ...JEEP }),
  lanes: Object.freeze([
    Object.freeze({ id: 'E-boxcars', from: [RAIL_X0, RAIL_Z], to: [RAIL_X1, RAIL_Z] }),
  ]),
  ambush: Object.freeze([
    Object.freeze({ x: 520.5, z: 572.5, faces: 'b-e-trestle' }),
    Object.freeze({ x: 543.5, z: 538.5, faces: 'hq-east-e' }),
    Object.freeze({ x: 491.5, z: 552.5, faces: 'e-c' }),
  ]),
  spawns: pickSpawnCells(FLAG.x, FLAG.z, {
    exclude: [rect(533, 547, 544, 558), STATION, ENGINE_SHED, FREIGHT, rect(500, 543, 510, 553),
      ...HEAPS.map(h => rect(h.x - h.r - 1, h.z - h.r - 1, h.x + h.r + 1, h.z + h.r + 1)), rect(480, SIDING_Z - 2, 560, SIDING_Z + 2)],
    radii: [9, 13, 17],
  }),
});

function waterTower(kit) {
  const { x, z } = TOWER, g = kit.top(x, z);
  const fx = Math.floor(x), fz = Math.floor(z);
  for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) kit.box(fx + dx, g + 1, fz + dz, fx + dx, g + 15, fz + dz, METAL);
  for (const y of [g + 5, g + 10, g + 15]) kit.walls(fx - 3, fz - 3, fx + 3, fz + 3, y, y, RUST);
  kit.line(fx - 3, g + 1, fz - 3, fx + 3, g + 10, fz - 3, METAL);
  kit.line(fx + 3, g + 1, fz + 3, fx - 3, g + 10, fz + 3, METAL);
  kit.line(fx - 3, g + 1, fz + 3, fx - 3, g + 10, fz - 3, METAL);
  kit.cylinder(x, z, 4.6, g + 16, g + 16, METAL);
  kit.cylinder(x, z, 4.6, g + 17, g + 21, BUS_YELLOW, true);
  kit.cylinder(x, z, 4.6, g + 19, g + 19, RUST, true);
  kit.cylinder(x, z, 3.6, g + 22, g + 22, RUST);
  kit.cylinder(x, z, 2.2, g + 23, g + 23, RUST);
  kit.set(fx, g + TOWER.rise, fz, METAL);
  // Ladder on the south leg.
  kit.box(fx + 4, g + 1, fz + 3, fx + 4, g + 17, fz + 3, METAL);
  kit.feature('landmark', { id: 'sulphur-water-tower', x, y: g + TOWER.rise, z });
}

/** Brick station house with a platform canopy along the siding: the hard point. */
function station(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = STATION;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, PLANK, STONE);
  const top = y + 8;
  kit.walls(x0, z0, x1, z1, y + 1, top, BRICK);
  kit.box(x0 + 1, y + 4, z0 + 1, x1 - 1, y + 4, z1 - 1, PLANK);
  kit.box(x1 - 3, y + 4, z1 - 2, x1 - 1, y + 4, z1 - 1, AIR);
  for (let s = 0; s < 3; s++) kit.box(x1 - 1 - s, y + 1, z1 - 2, x1 - 1 - s, y + 1 + s, z1 - 1, PLANK);
  for (const wy of [y + 2, y + 6]) {
    for (let x = x0 + 2; x < x1 - 1; x += 3) { kit.box(x, wy, z0, x, wy + 1, z0, GLASS); kit.box(x, wy, z1, x, wy + 1, z1, AIR); }
    for (let z = z0 + 2; z < z1 - 1; z += 3) { kit.box(x0, wy, z, x0, wy + 1, z, AIR); kit.box(x1, wy, z, x1, wy + 1, z, GLASS); }
  }
  const mx = (x0 + x1) >> 1, mz = (z0 + z1) >> 1;
  kit.box(mx - 1, y + 1, z0, mx, y + 3, z0, AIR);
  kit.box(x0, y + 1, mz - 1, x0, y + 3, mz, AIR);
  kit.box(x1, y + 1, mz - 1, x1, y + 3, mz, AIR);
  kit.box(x0 + 2, y + 1, z0 + 2, x0 + 5, y + 2, z0 + 2, PLANK);            // ticket counter
  kit.box(x0, top + 1, z0, x1, top + 1, z1, CONCRETE);
  kit.walls(x0, z0, x1, z1, top + 2, top + 2, BRICK);
  kit.box(x0 + 2, top + 1, z0 + 2, x0 + 3, top + 1, z0 + 3, AIR);
  kit.box(x0 + 2, y + 5, z0 + 2, x0 + 2, top, z0 + 2, METAL);
  // Station clock face and the name board over the north door.
  kit.box(mx - 3, top - 1, z0 - 1, mx + 2, top - 1, z0 - 1, PALE);
  kit.set(mx - 1, top - 2, z0 - 1, METAL);
  kit.feature('building', { id: 'sulphur-station', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: top, ridge: top + 2, enterable: true, hard: true });
  kit.feature('hard-building', { flag: 'E', id: 'sulphur-station', ...STATION });
  // Platform canopy on the east side.
  for (const px of [x1 + 4, x1 + 8]) for (const pz of [z0 + 1, z1 - 1]) kit.box(px, y + 1, pz, px, y + 4, pz, METAL);
  kit.box(x1 + 1, y + 5, z0, x1 + 9, y + 5, z1, TERRACOTTA_ROOF);
}

/** Long engine shed straddling the siding, both gables open to the track. */
function engineShed(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = ENGINE_SHED;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, CONCRETE, STONE);
  const eave = y + 8;
  kit.walls(x0, z0, x1, z1, y + 1, eave, CORRUGATED_STEEL);
  kit.walls(x0, z0, x1, z1, y + 1, y + 2, BRICK);
  // Track doors on both gables, a side door north.
  kit.box(x0, y + 1, SIDING_Z - 3, x0, y + 6, SIDING_Z + 3, AIR);
  kit.box(x1, y + 1, SIDING_Z - 3, x1, y + 6, SIDING_Z + 3, AIR);
  kit.box(x0 + 7, y + 1, z0, x0 + 8, y + 3, z0, AIR);
  kit.box(x0 + 7, y + 1, z1, x0 + 8, y + 3, z1, AIR);
  for (let x = x0 + 2; x < x1; x += 4) { kit.box(x, y + 5, z0, x + 1, y + 6, z0, GLASS); kit.box(x, y + 5, z1, x + 1, y + 6, z1, GLASS); }
  // Inspection pit edge, workbenches and a smoke vent along the ridge.
  kit.box(x0 + 2, y + 1, z0 + 1, x0 + 6, y + 1, z0 + 2, METAL);
  kit.box(x1 - 6, y + 1, z1 - 2, x1 - 2, y + 2, z1 - 1, PLANK);
  const ridge = kit.gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, eave + 1, 'x', CORRUGATED_STEEL, CORRUGATED_STEEL);
  for (let x = x0 + 2; x < x1; x += 5) kit.box(x, ridge + 1, (z0 + z1) >> 1, x + 1, ridge + 2, ((z0 + z1) >> 1) + 1, RUST);
  kit.feature('building', { id: 'sulphur-engine-shed', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge, enterable: true });
  kit.feature('landmark', { id: 'sulphur-engine-shed', x: (x0 + x1 + 1) / 2, y: ridge + 2, z: (z0 + z1 + 1) / 2 });
}

function heap(kit, h) {
  for (let z = Math.floor(h.z - h.r); z <= Math.ceil(h.z + h.r); z++) for (let x = Math.floor(h.x - h.r); x <= Math.ceil(h.x + h.r); x++) {
    const d = Math.hypot(x + 0.5 - h.x, z + 0.5 - h.z) / h.r;
    if (d > 1) continue;
    const g = kit.top(x, z), top = g + Math.round(h.h * (1 - d * d));
    if (top > g) kit.box(x, g + 1, z, x, top, z, BUS_YELLOW);
  }
  kit.feature('cover', { cover: 'sulphur heap', x: h.x, z: h.z, height: h.h });
}

export function buildRailhead(kit) {
  // Track first: the main line along the south, the siding through the shed.
  railTrack(kit, RAIL_X0, RAIL_Z, RAIL_X1, RAIL_Z);
  waterTower(kit);
  station(kit);
  engineShed(kit);
  railTrack(kit, 484, SIDING_Z, 520, SIDING_Z);
  adobe(kit, FREIGHT.minX, FREIGHT.minZ, FREIGHT.maxX, FREIGHT.maxZ, { floors: 1, doors: ['w', 's'], wall: DUST_PLASTER, id: 'sulphur-freight-office' });
  for (const h of HEAPS) heap(kit, h);
  for (const c of CARS) boxcar(kit, c.x, RAIL_Z, c.colour, true);
  // A loading dock with crates and a hand crane by the freight office.
  crateStack(kit, 540, 540, 2, 2, 2, DUST_CRATE);
  crateStack(kit, 512, 528, 3, 1, 1, TIMBER);
  const g = kit.top(560, 540);
  kit.box(558, g + 1, 538, 562, g + 1, 542, CONCRETE);
  kit.box(560, g + 2, 540, 560, g + 7, 540, METAL);
  kit.line(560, g + 7, 540, 556, g + 7, 540, METAL);
  // A stone stock wall gives the east approach a covered lane (the mirror of B's ore wall).
  wall(kit, [[564, 548], [564, 590]], 2, STONE, { gapEvery: 14, kind: 'stock wall' });
  for (const lane of RAILHEAD_SITE.lanes) kit.feature('lane', { flag: 'E', ...lane });
  kit.paintRect(500, 543, 510, 553, GRAVEL);
  for (const a of RAILHEAD_SITE.ambush) kit.feature('ambush', { flag: 'E', ...a });
  kit.reserve(JEEP.x - 3.5, JEEP.z - 3.5, JEEP.x + 2.5, JEEP.z + 2.5, 5, 'flag-E-jeep');
}
