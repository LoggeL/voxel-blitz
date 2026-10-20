// Flag D, Mesa Radar (532, 236): an air-defence radar station on the east
// bench. A white radome on a concrete drum, the lattice dish tower beside
// it, the two-storey concrete operations block (the hard point), barracks
// huts and a generator shed inside a sandbagged perimeter. Landmark: the
// dish tower and its rotating-array frame, readable from either HQ.
//
// The lots are the mirror images of Palmera Oasis's (flag A) so the routes,
// cover distances and spawn rings match, but every structure is different.

import {
  AIR, CONCRETE, PALE, METAL, RUST, GLASS, PLANK, CORRUGATED_STEEL, BARRICADE, ACCENT, DUST_CRATE, GRAVEL,
  DUST_PLASTER, TRUCK_RED,
} from '../blocks.js';
import { REDROCK_PLAN } from '../redrock-plan.js';
import { rect, pickSpawnCells, wall } from './plan.js';
import { latticeTower } from './props.js';
import { crateStack, shed } from '../frontier-sites/props.js';

const FLAG = REDROCK_PLAN.flags.find(f => f.id === 'D');
const DOME = { x: 564.5, z: 249.5, r: 7.5, drum: 5 };
const DISH = { x: 567.5, z: 263.5, rise: 26 };
const OPS = rect(492, 250, 506, 264);
const HUTS = [rect(554, 214, 564, 224), rect(512, 208, 524, 218), rect(572, 228, 582, 238)];
const GENERATOR = rect(540, 272, 552, 280);
const SHEDS = [rect(540, 218, 546, 222), rect(550, 226, 556, 230)];
const JEEP = { x: 517.5, z: 236.5, yaw: Math.PI / 2 };

export const RADAR_SITE = Object.freeze({
  flag: 'D', site: 'radar', x: FLAG.x, z: FLAG.z,
  buildings: Object.freeze([OPS, ...HUTS, GENERATOR]),
  hard: OPS,
  dome: Object.freeze({ ...DOME }),
  landmarks: Object.freeze([
    Object.freeze({ id: 'mesa-radar-dish', kind: 'radar tower', x: DISH.x, z: DISH.z, rise: DISH.rise, primary: true }),
    Object.freeze({ id: 'mesa-radar-dome', kind: 'radome', x: DOME.x, z: DOME.z, rise: DOME.drum + Math.round(DOME.r) + 1 }),
  ]),
  vehicle: Object.freeze({ id: 'flag-D-jeep', type: 'jeep', team: 'bravo', ...JEEP }),
  lanes: Object.freeze([
    Object.freeze({ id: 'D-sandbag-line', from: [554, 286], to: [588, 286] }),
  ]),
  ambush: Object.freeze([
    Object.freeze({ x: 509.5, z: 244.5, faces: 'd-c' }),
    Object.freeze({ x: 560.5, z: 228.5, faces: 'hq-east-d' }),
    Object.freeze({ x: 523.5, z: 214.5, faces: 'a-d-ford' }),
  ]),
  spawns: pickSpawnCells(FLAG.x, FLAG.z, {
    exclude: [OPS, ...HUTS, GENERATOR, ...SHEDS, rect(512, 231, 522, 241),
      rect(DOME.x - DOME.r - 2, DOME.z - DOME.r - 2, DOME.x + DOME.r + 2, DOME.z + DOME.r + 2), rect(DISH.x - 4, DISH.z - 4, DISH.x + 4, DISH.z + 4)],
    radii: [9, 13, 17],
  }),
});

function radome(kit) {
  const { x, z, r, drum } = DOME;
  const y = kit.maxTop(Math.floor(x - r), Math.floor(z - r), Math.ceil(x + r), Math.ceil(z + r));
  kit.cylinder(x, z, r + 0.6, y, y, CONCRETE);
  kit.cylinder(x, z, r, y + 1, y + drum, CONCRETE, true);
  kit.ellipsoid(x, y + drum + 0.5, z, r, r, r, PALE);
  kit.ellipsoid(x, y + drum + 0.5, z, r - 1.2, r - 1.2, r - 1.2, AIR);
  kit.box(Math.floor(x - r) - 1, y + drum, Math.floor(z - r) - 1, Math.ceil(x + r) + 1, y + drum, Math.ceil(z + r) + 1, AIR);
  kit.cylinder(x, z, r, y + drum, y + drum, CONCRETE, true);
  kit.cylinder(x, z, r - 1.2, y + drum, y + drum, PLANK);
  // Doorway west, a stair to the inner floor and the antenna pedestal.
  const cx = Math.floor(x), cz = Math.floor(z);
  kit.box(cx - Math.ceil(r), y + 1, cz - 1, cx - Math.ceil(r) + 1, y + 3, cz, AIR);
  kit.box(cx - 2, y + drum + 1, cz - 2, cx + 2, y + drum + 1, cz + 2, METAL);
  kit.box(cx, y + drum + 2, cz, cx, y + drum + 4, cz, METAL);
  kit.box(cx - 3, y + drum + 5, cz, cx + 3, y + drum + 6, cz, RUST);
  for (let s = 0; s < drum - 1; s++) kit.box(cx - 3 + s, y + 1, cz + 3, cx - 3 + s, y + 1 + s, cz + 4, PLANK);
  kit.feature('building', { id: 'mesa-radar-radome', minX: Math.floor(x - r), minZ: Math.floor(z - r), maxX: Math.ceil(x + r) - 1, maxZ: Math.ceil(z + r) - 1,
    floorY: y, eave: y + drum, ridge: y + drum + Math.round(r), enterable: true, open: true });
  kit.feature('landmark', { id: 'mesa-radar-dome', x, y: y + drum + Math.round(r) + 1, z });
}

function dishTower(kit) {
  const g = kit.top(DISH.x, DISH.z), cx = Math.floor(DISH.x), cz = Math.floor(DISH.z);
  kit.box(cx - 3, g, cz - 3, cx + 3, g, cz + 3, CONCRETE);
  const top = latticeTower(kit, cx, cz, g + 1, 19, 3, { leg: METAL, brace: RUST });
  kit.box(cx - 2, top + 1, cz - 2, cx + 2, top + 1, cz + 2, METAL);
  kit.walls(cx - 2, cz - 2, cx + 2, cz + 2, top + 2, top + 2, METAL);
  // The planar array: a tilted 9 x 5 frame facing west over the battlefield.
  for (let dz = -4; dz <= 4; dz++) for (let k = 0; k < 5; k++) {
    const y = top + 3 + k, x = cx - 1 + (k >> 1);
    kit.set(x, y, cz + dz, Math.abs(dz) === 4 || k === 0 || k === 4 ? METAL : PALE);
  }
  kit.box(cx + 1, top + 3, cz, cx + 1, DISH.rise + g, cz, METAL);
  kit.set(cx + 1, g + DISH.rise + 1, cz, TRUCK_RED);
  // Ladder up the south-east leg (dishLadder) and a catwalk from its head
  // through a gap in the rail onto the platform: the station's overwatch.
  for (let y = g + 1; y <= top; y += 2) kit.set(cx + 4, y, cz + 3, METAL);
  kit.box(cx + 3, top + 1, cz + 2, cx + 4, top + 1, cz + 3, METAL);
  kit.set(cx + 2, top + 2, cz + 2, AIR);
  kit.feature('ladder', dishLadder(g));
  kit.feature('landmark', { id: 'mesa-radar-dish', x: DISH.x, y: g + DISH.rise, z: DISH.z });
}

/**
 * Ladder volume up the dish tower's south-east leg (its rungs every other
 * voxel) to the catwalk at the platform. `groundY` is the terrain top under
 * the tower (its concrete pad); `support` the rung column, so the ladder goes
 * with the tower (the flag radar's topple, shared/map-events/radar.js).
 */
export function dishLadder(groundY) {
  const x = Math.floor(DISH.x) + 4, z = Math.floor(DISH.z) + 3, top = groundY + 19;
  return { minX: x + 1, maxX: x + 2, minY: groundY + 1, maxY: top + 2.2, minZ: z, maxZ: z + 1, face: 'x-',
    support: { x, z, y0: groundY + 1, y1: top + 1 } };
}
export const DISH_TOWER = Object.freeze({ x: DISH.x, z: DISH.z });

/** Two-storey concrete operations block with a flat, sandbagged roof: the hard point. */
function opsBlock(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = OPS;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, CONCRETE);
  const top = y + 8;
  kit.walls(x0, z0, x1, z1, y + 1, top, CONCRETE);
  kit.box(x0 + 1, y + 4, z0 + 1, x1 - 1, y + 4, z1 - 1, PLANK);
  kit.box(x0 + 1, y + 4, z1 - 2, x0 + 3, y + 4, z1 - 1, AIR);
  for (let s = 0; s < 3; s++) kit.box(x0 + 1 + s, y + 1, z1 - 2, x0 + 1 + s, y + 1 + s, z1 - 1, PLANK);
  for (const wy of [y + 2, y + 6]) {
    for (let x = x0 + 2; x < x1 - 1; x += 4) { kit.box(x, wy, z0, x + 1, wy, z0, GLASS); kit.box(x, wy, z1, x + 1, wy, z1, GLASS); }
    for (let z = z0 + 3; z < z1 - 1; z += 4) { kit.box(x0, wy, z, x0, wy, z + 1, AIR); kit.box(x1, wy, z, x1, wy, z + 1, GLASS); }
  }
  const mx = (x0 + x1) >> 1, mz = (z0 + z1) >> 1;
  kit.box(mx - 1, y + 1, z0, mx, y + 3, z0, AIR);
  kit.box(x0, y + 1, mz - 1, x0, y + 3, mz, AIR);
  kit.box(x1, y + 1, mz - 1, x1, y + 3, mz, AIR);
  // Plotting tables and consoles.
  kit.box(x0 + 3, y + 1, z0 + 3, x0 + 7, y + 1, z0 + 5, PLANK);
  kit.box(x1 - 4, y + 1, z0 + 2, x1 - 2, y + 2, z0 + 6, METAL);
  kit.box(x0, top + 1, z0, x1, top + 1, z1, CONCRETE);
  kit.walls(x0, z0, x1, z1, top + 2, top + 2, BARRICADE);
  kit.box(x0 + 2, top + 1, z0 + 2, x0 + 3, top + 1, z0 + 3, AIR);
  kit.box(x0 + 2, y + 5, z0 + 2, x0 + 2, top, z0 + 2, METAL);
  kit.box(x1 - 2, top + 2, z1 - 2, x1 - 2, top + 8, z1 - 2, METAL);      // whip antenna
  kit.feature('building', { id: 'mesa-radar-ops', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: top, ridge: top + 2, enterable: true, hard: true });
  kit.feature('hard-building', { flag: 'D', id: 'mesa-radar-ops', ...OPS });
}

/** Quonset-style barracks hut: a corrugated half-barrel along the long axis. */
function hut(kit, r, id) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = r;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, PLANK, CONCRETE);
  const alongX = x1 - x0 >= z1 - z0;
  const span = alongX ? z1 - z0 : x1 - x0, half = span / 2;
  for (let s = 0; s <= span; s++) {
    const h = Math.round(Math.sqrt(Math.max(0, half * half - (s - half) ** 2)) * 1.1);
    if (alongX) kit.box(x0, y + 1 + Math.max(0, h - 1), z0 + s, x1, y + 1 + h, z0 + s, CORRUGATED_STEEL);
    else kit.box(x0 + s, y + 1 + Math.max(0, h - 1), z0, x0 + s, y + 1 + h, z1, CORRUGATED_STEEL);
  }
  // Gable ends with doors.
  const ends = alongX ? [x0, x1] : [z0, z1];
  for (const e of ends) for (let s = 0; s <= span; s++) {
    const h = Math.round(Math.sqrt(Math.max(0, half * half - (s - half) ** 2)) * 1.1);
    if (alongX) kit.box(e, y + 1, z0 + s, e, y + h, z0 + s, DUST_PLASTER); else kit.box(x0 + s, y + 1, e, x0 + s, y + h, e, DUST_PLASTER);
  }
  const m = Math.floor(half);
  for (const e of ends) {
    if (alongX) kit.box(e, y + 1, z0 + m - 1, e, y + 3, z0 + m, AIR); else kit.box(x0 + m - 1, y + 1, e, x0 + m, y + 3, e, AIR);
  }
  kit.feature('building', { id, minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: y + 3, ridge: y + 1 + Math.round(half * 1.1), enterable: true });
}

function generatorShed(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = GENERATOR;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, CONCRETE);
  kit.walls(x0, z0, x1, z1, y + 1, y + 4, CORRUGATED_STEEL);
  kit.box(x0 + 3, y + 1, z0, x0 + 6, y + 4, z0, AIR);
  kit.box(x1, y + 1, z0 + 3, x1, y + 3, z0 + 4, AIR);
  kit.box(x0 + 2, y + 1, z0 + 3, x1 - 2, y + 2, z1 - 2, RUST);
  kit.box(x0, y + 5, z0, x1, y + 5, z1, CORRUGATED_STEEL);
  kit.box(x1 - 2, y + 6, z1 - 2, x1 - 2, y + 9, z1 - 2, METAL);
  kit.feature('building', { id: 'mesa-radar-generator', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: y + 5, enterable: true });
}

export function buildRadar(kit) {
  radome(kit);
  dishTower(kit);
  opsBlock(kit);
  HUTS.forEach((h, n) => hut(kit, h, `mesa-radar-barracks-${n + 1}`));
  generatorShed(kit);
  for (const s of SHEDS) shed(kit, s.minX, s.minZ, s.maxX, s.maxZ, 3, { roof: CORRUGATED_STEEL });
  crateStack(kit, 538, 214, 2, 1, 1, DUST_CRATE);
  crateStack(kit, 546, 244, 2, 2, 2, DUST_CRATE);
  // Sandbag perimeter: the mirrors of the oasis garden walls.
  wall(kit, [[554, 286], [588, 286]], 2, BARRICADE, { kind: 'sandbags' });
  wall(kit, [[500, 284], [486, 268], [486, 248]], 2, BARRICADE, { gapEvery: 9, kind: 'sandbags' });
  wall(kit, [[580, 206], [568, 200], [546, 198]], 2, CONCRETE, { kind: 'blast wall' });
  for (const lane of RADAR_SITE.lanes) kit.feature('lane', { flag: 'D', ...lane });
  kit.paintRect(522, 226, 542, 246, GRAVEL);
  // A painted helipad cross by the ops block (dressing, not a vehicle pad).
  const hy = kit.top(500, 270);
  kit.box(498, hy, 268, 503, hy, 273, CONCRETE);
  kit.box(500, hy, 269, 501, hy, 272, ACCENT);
  for (const a of RADAR_SITE.ambush) kit.feature('ambush', { flag: 'D', ...a });
  kit.reserve(JEEP.x - 3.5, JEEP.z - 3.5, JEEP.x + 2.5, JEEP.z + 2.5, 5, 'flag-D-jeep');
}
