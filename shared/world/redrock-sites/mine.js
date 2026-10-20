// Flag B, Copperhead Mine (250, 540): a steel headframe over the shaft, the
// brick hoist house, the corrugated ore mill joined to the headframe by an
// inclined conveyor, the mine office and two grey tailings heaps. Landmark:
// the headframe and its sheave wheels, readable from either HQ.

import {
  AIR, BRICK, CORRUGATED_STEEL, METAL, RUST, GRAVEL, CONCRETE, PLANK, GLASS, DUST_CRATE, TIMBER, STONE,
  DUST_PLASTER, PALE,
} from '../blocks.js';
import { REDROCK_PLAN } from '../redrock-plan.js';
import { rect, pickSpawnCells, wall } from './plan.js';
import { adobe, latticeTower } from './props.js';
import { crateStack, wreckTruck } from '../frontier-sites/props.js';

const FLAG = REDROCK_PLAN.flags.find(f => f.id === 'B');
const HEADFRAME = rect(226, 548, 234, 556);
const HOIST = rect(236, 560, 246, 570);
const MILL = rect(254, 556, 272, 570);
const OFFICE = rect(212, 526, 222, 536);
const HEAPS = [{ x: 288.5, z: 560.5, r: 7, h: 6 }, { x: 210.5, z: 572.5, r: 6, h: 5 }];
const JEEP = { x: 262.5, z: 548.5, yaw: Math.PI / 2 };

export const MINE_SITE = Object.freeze({
  flag: 'B', site: 'mine', x: FLAG.x, z: FLAG.z,
  buildings: Object.freeze([HOIST, MILL, OFFICE]),
  hard: HOIST,
  heaps: Object.freeze(HEAPS.map(h => Object.freeze({ ...h }))),
  landmarks: Object.freeze([
    Object.freeze({ id: 'copperhead-headframe', kind: 'headframe', x: (HEADFRAME.minX + HEADFRAME.maxX + 1) / 2, z: (HEADFRAME.minZ + HEADFRAME.maxZ + 1) / 2, rise: 28, primary: true }),
    Object.freeze({ id: 'copperhead-mill', kind: 'ore mill', x: (MILL.minX + MILL.maxX + 1) / 2, z: (MILL.minZ + MILL.maxZ + 1) / 2, rise: 15 }),
  ]),
  vehicle: Object.freeze({ id: 'flag-B-jeep', type: 'jeep', team: 'alpha', ...JEEP }),
  lanes: Object.freeze([
    Object.freeze({ id: 'B-ore-wall', from: [204, 548], to: [204, 590] }),
  ]),
  ambush: Object.freeze([
    Object.freeze({ x: 247.5, z: 572.5, faces: 'b-e-trestle' }),
    Object.freeze({ x: 224.5, z: 538.5, faces: 'hq-west-b' }),
    Object.freeze({ x: 276.5, z: 552.5, faces: 'b-c' }),
  ]),
  spawns: pickSpawnCells(FLAG.x, FLAG.z, {
    exclude: [HEADFRAME, HOIST, MILL, OFFICE, rect(257, 543, 267, 553), ...HEAPS.map(h => rect(h.x - h.r - 1, h.z - h.r - 1, h.x + h.r + 1, h.z + h.r + 1)),
      rect(234, 552, 254, 558)],
    radii: [9, 13, 17],
  }),
});

function headframe(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = HEADFRAME;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, CONCRETE);
  // The shaft collar (open, fenced) under the frame.
  kit.box(x0 + 3, y, z0 + 3, x1 - 3, y, z1 - 3, METAL);
  const cx = (x0 + x1) >> 1, cz = (z0 + z1) >> 1;
  const top = latticeTower(kit, cx, cz, y + 1, 24, 4, { leg: RUST, brace: METAL });
  kit.box(cx - 3, top + 1, cz - 3, cx + 3, top + 1, cz + 3, METAL);
  // Twin sheave wheels on the head, facing the hoist house.
  for (const dx of [-2, 2]) {
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8;
      kit.set(cx + dx, top + 4 + Math.round(Math.sin(a) * 2.5), cz + Math.round(Math.cos(a) * 2.5), RUST);
    }
    kit.box(cx + dx, top + 2, cz, cx + dx, top + 4, cz, METAL);
  }
  // Back legs raking down to the hoist house side.
  kit.line(cx - 3, top, cz + 3, HOIST.minX + 1, y + 1, HOIST.minZ - 1, RUST);
  kit.line(cx + 3, top, cz + 3, HOIST.minX + 5, y + 1, HOIST.minZ - 1, RUST);
  // Hoist cables to the drum house.
  kit.line(cx, top + 4, cz + 2, (HOIST.minX + HOIST.maxX) >> 1, y + 7, HOIST.minZ, METAL);
  kit.feature('landmark', { id: 'copperhead-headframe', x: (x0 + x1 + 1) / 2, y: top + 6, z: (z0 + z1 + 1) / 2 });
}

function hoistHouse(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = HOIST;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, CONCRETE, STONE);
  const eave = y + 6;
  kit.walls(x0, z0, x1, z1, y + 1, eave, BRICK);
  kit.box(x0 + 4, y + 1, z0, x0 + 6, y + 4, z0, AIR);                 // door to the headframe
  kit.box(x1, y + 1, z1 - 4, x1, y + 3, z1 - 3, AIR);                 // side door
  kit.box(x0, y + 1, z0 + 4, x0, y + 3, z0 + 5, AIR);
  for (let x = x0 + 2; x < x1; x += 3) kit.box(x, y + 4, z1, x, y + 5, z1, GLASS);
  // The winding drum and the engine bed.
  for (let x = x0 + 2; x <= x1 - 2; x++) kit.cylinderAlongX(x, y + 3, z0 + 5.5, 1.8, RUST);
  kit.box(x0 + 2, y + 1, z0 + 7, x1 - 2, y + 1, z1 - 2, METAL);
  kit.box(x0, eave + 1, z0, x1, eave + 1, z1, CONCRETE);
  kit.box(x1 - 2, eave + 2, z1 - 2, x1 - 1, eave + 7, z1 - 1, BRICK);   // boiler stack
  kit.feature('building', { id: 'copperhead-hoist-house', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge: eave + 1, enterable: true, hard: true });
  kit.feature('hard-building', { flag: 'B', id: 'copperhead-hoist-house', ...HOIST });
}

function mill(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = MILL;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, CONCRETE, STONE);
  const eave = y + 9;
  kit.walls(x0, z0, x1, z1, y + 1, eave, CORRUGATED_STEEL);
  kit.walls(x0, z0, x1, z1, y + 1, y + 1, CONCRETE);
  kit.box(x0 + 7, y + 1, z0, x0 + 11, y + 5, z0, AIR);                 // truck door north
  kit.box(x1, y + 1, z0 + 5, x1, y + 3, z0 + 6, AIR);
  kit.box(x0, y + 1, z1 - 5, x0, y + 3, z1 - 4, AIR);
  // Interior: crusher, ore bins and a catwalk.
  kit.box(x0 + 2, y + 1, z0 + 3, x0 + 5, y + 4, z0 + 7, RUST);
  kit.box(x1 - 6, y + 1, z1 - 5, x1 - 2, y + 3, z1 - 2, METAL);
  kit.box(x0 + 1, y + 5, z1 - 2, x1 - 1, y + 5, z1 - 1, PLANK);
  for (let x = x0 + 2; x < x1; x += 4) kit.box(x, y + 6, z0, x + 1, y + 7, z0, GLASS);
  kit.gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, eave + 1, 'x', CORRUGATED_STEEL, CORRUGATED_STEEL);
  // Inclined conveyor from the headframe's ore bin into the mill gable.
  const hy = kit.top(HEADFRAME.maxX, HEADFRAME.maxZ);
  kit.line(HEADFRAME.maxX + 1, hy + 9, HEADFRAME.maxZ - 2, x0, eave - 1, z0 + 4, METAL, 0);
  kit.line(HEADFRAME.maxX + 1, hy + 10, HEADFRAME.maxZ - 2, x0, eave, z0 + 4, CORRUGATED_STEEL, 0);
  kit.feature('building', { id: 'copperhead-mill', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge: eave + 8, enterable: true });
  kit.feature('landmark', { id: 'copperhead-mill', x: (x0 + x1 + 1) / 2, y: y + 15, z: (z0 + z1 + 1) / 2 });
}

function heap(kit, h) {
  for (let z = Math.floor(h.z - h.r); z <= Math.ceil(h.z + h.r); z++) for (let x = Math.floor(h.x - h.r); x <= Math.ceil(h.x + h.r); x++) {
    const d = Math.hypot(x + 0.5 - h.x, z + 0.5 - h.z) / h.r;
    if (d > 1) continue;
    const g = kit.top(x, z), top = g + Math.round(h.h * (1 - d * d));
    if (top > g) kit.box(x, g + 1, z, x, top, z, GRAVEL);
  }
  kit.feature('cover', { cover: 'tailings', x: h.x, z: h.z, height: h.h });
}

export function buildMine(kit) {
  headframe(kit);
  hoistHouse(kit);
  mill(kit);
  adobe(kit, OFFICE.minX, OFFICE.minZ, OFFICE.maxX, OFFICE.maxZ, { floors: 1, doors: ['e', 's'], wall: DUST_PLASTER, id: 'copperhead-office' });
  for (const h of HEAPS) heap(kit, h);
  // Ore wagons, timber props and a dumped truck in the yard.
  crateStack(kit, 240, 548, 2, 2, 2, DUST_CRATE);
  crateStack(kit, 248, 528, 3, 1, 1, TIMBER);
  wreckTruck(kit, 280, 540, false, { cold: true });
  // A dry-stone ore wall gives the west approach a covered lane.
  wall(kit, [[204, 548], [204, 590]], 2, STONE, { gapEvery: 14, kind: 'ore wall' });
  wall(kit, [[232, 584], [262, 584]], 2, STONE, { kind: 'ore wall' });
  for (const lane of MINE_SITE.lanes) kit.feature('lane', { flag: 'B', ...lane });
  // A fenced powder magazine.
  const g = kit.top(220, 552);
  kit.box(216, g + 1, 550, 220, g + 2, 553, CONCRETE);
  kit.box(216, g + 3, 550, 220, g + 3, 553, PALE);
  for (const a of MINE_SITE.ambush) kit.feature('ambush', { flag: 'B', ...a });
  kit.reserve(JEEP.x - 3.5, JEEP.z - 3.5, JEEP.x + 2.5, JEEP.z + 2.5, 5, 'flag-B-jeep');
}
