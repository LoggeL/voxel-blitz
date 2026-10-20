// Flag A, Palmera Oasis (236, 236): a spring pool ringed by date palms, an
// adobe hamlet with flat roofs, market awnings and garden walls. Landmarks:
// the mission's bell tower south-east of the pool and the windpump west of
// it, both readable from either HQ.

import {
  AIR, DUST_PLASTER, DUST_SANDSTONE, DUST_WOOD, MC_WATER, MUD, MEADOW, PLANK, METAL, RUST, PALE, ACCENT,
  TERRACOTTA_ROOF, DUST_CRATE, DIRT, TIMBER, WHITE_PLASTER,
} from '../blocks.js';
import { REDROCK_PLAN } from '../redrock-plan.js';
import { rect, pickSpawnCells, wall } from './plan.js';
import { adobe, palm } from './props.js';
import { crateStack, shed } from '../frontier-sites/props.js';
import { seededRandom } from '../frontier-sites/kit.js';

const FLAG = REDROCK_PLAN.flags.find(f => f.id === 'A');
const POOL = { x: 204, z: 250, rx: 9, rz: 6 };
const MISSION = rect(262, 250, 276, 264);
const BELL = rect(262, 246, 267, 250);
const HOUSES = [rect(204, 214, 214, 224), rect(244, 208, 256, 218), rect(186, 228, 196, 238), rect(216, 272, 228, 280)];
const STALLS = [rect(222, 218, 228, 222), rect(212, 226, 218, 230)];
const WINDPUMP = { x: 200.5, z: 262.5, rise: 17 };
const JEEP = { x: 250.5, z: 236.5, yaw: -Math.PI / 2 };
const PALMS = [[192, 246], [194, 256], [200, 259], [208, 259], [214, 254], [215, 245], [206, 242], [197, 242],
  [188, 252], [210, 265], [218, 250], [186, 260], [240, 270], [252, 272]];

export const OASIS_SITE = Object.freeze({
  flag: 'A', site: 'oasis', x: FLAG.x, z: FLAG.z,
  buildings: Object.freeze([MISSION, ...HOUSES]),
  hard: MISSION,
  pool: Object.freeze({ ...POOL }),
  landmarks: Object.freeze([
    Object.freeze({ id: 'palmera-bell-tower', kind: 'bell tower', x: (BELL.minX + BELL.maxX + 1) / 2, z: (BELL.minZ + BELL.maxZ + 1) / 2, rise: 23, primary: true }),
    Object.freeze({ id: 'palmera-windpump', kind: 'windpump', x: WINDPUMP.x, z: WINDPUMP.z, rise: WINDPUMP.rise }),
  ]),
  vehicle: Object.freeze({ id: 'flag-A-jeep', type: 'jeep', team: 'alpha', ...JEEP }),
  lanes: Object.freeze([
    Object.freeze({ id: 'A-garden-wall', from: [180, 286], to: [214, 286] }),
  ]),
  ambush: Object.freeze([
    Object.freeze({ x: 258.5, z: 244.5, faces: 'a-c' }),
    Object.freeze({ x: 207.5, z: 228.5, faces: 'hq-west-a' }),
    Object.freeze({ x: 244.5, z: 214.5, faces: 'a-d-ford' }),
  ]),
  spawns: pickSpawnCells(FLAG.x, FLAG.z, {
    exclude: [MISSION, BELL, ...HOUSES, ...STALLS, rect(245, 231, 255, 241), rect(POOL.x - POOL.rx - 2, POOL.z - POOL.rz - 2, POOL.x + POOL.rx + 2, POOL.z + POOL.rz + 2),
      ...PALMS.map(([x, z]) => rect(x - 1, z - 1, x + 1, z + 1))],
    radii: [9, 13, 17],
  }),
});

function pool(kit) {
  for (let z = Math.floor(POOL.z - POOL.rz - 2); z <= Math.ceil(POOL.z + POOL.rz + 2); z++) for (let x = Math.floor(POOL.x - POOL.rx - 2); x <= Math.ceil(POOL.x + POOL.rx + 2); x++) {
    const q = ((x + 0.5 - POOL.x) / POOL.rx) ** 2 + ((z + 0.5 - POOL.z) / POOL.rz) ** 2;
    const g = kit.top(x, z);
    if (q <= 1) {
      // Two voxels of spring water, its surface flush with the ground around it.
      kit.box(x, g - 2, z, x, g - 2, z, MUD);
      kit.box(x, g - 1, z, x, g, z, MC_WATER);
    } else if (q <= 1.6) kit.set(x, g, z, q <= 1.25 ? MUD : MEADOW);
  }
  kit.feature('pool', { flag: 'A', ...POOL });
}

function mission(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = MISSION;
  const eave = adobe(kit, x0, z0, x1, z1, { floors: 2, doors: ['n', 'w', 'e'], wall: WHITE_PLASTER, id: 'palmera-mission', hard: true });
  // Buttresses and the bell tower on the north front.
  for (const z of [z0 + 4, z0 + 10]) { kit.box(x1 + 1, kit.top(x1 + 1, z) + 1, z, x1 + 1, eave - 2, z, DUST_SANDSTONE); kit.box(x0 - 1, kit.top(x0 - 1, z) + 1, z, x0 - 1, eave - 2, z, DUST_SANDSTONE); }
  const y = kit.top(BELL.minX, BELL.minZ);
  const { minX: bx0, minZ: bz0, maxX: bx1, maxZ: bz1 } = BELL;
  kit.foundation(bx0, bz0, bx1, bz1, y, PLANK, DUST_SANDSTONE);
  kit.walls(bx0, bz0, bx1, bz1, y + 1, y + 17, WHITE_PLASTER);
  kit.box(bx0 + 2, y + 1, bz0, bx0 + 3, y + 3, bz0, AIR);
  for (let s = 0; s < 4; s++) kit.box(bx0 + 1, y + 1 + s * 4, bz0 + 1, bx1 - 1, y + 1 + s * 4, bz1 - 1, PLANK);
  // Belfry arches, a bronze bell and the cross.
  kit.box(bx0, y + 14, bz0 + 1, bx1, y + 16, bz1 - 1, AIR);
  kit.box(bx0 + 1, y + 14, bz0, bx1 - 1, y + 16, bz1, AIR);
  kit.box(bx0 + 2, y + 15, bz0 + 1, bx0 + 3, y + 15, bz0 + 2, RUST);
  kit.box(bx0, y + 18, bz0, bx1, y + 18, bz1, TERRACOTTA_ROOF);
  kit.box(bx0 + 1, y + 19, bz0 + 1, bx1 - 1, y + 19, bz1 - 1, TERRACOTTA_ROOF);
  kit.box(bx0 + 2, y + 20, bz0 + 2, bx0 + 2, y + 23, bz0 + 2, DUST_WOOD);
  kit.box(bx0 + 1, y + 22, bz0 + 2, bx0 + 3, y + 22, bz0 + 2, DUST_WOOD);
  kit.feature('landmark', { id: 'palmera-bell-tower', x: (bx0 + bx1 + 1) / 2, y: y + 23, z: (bz0 + bz1 + 1) / 2 });
  kit.feature('hard-building', { flag: 'A', id: 'palmera-mission', ...MISSION });
}

function windpump(kit) {
  const g = kit.top(WINDPUMP.x, WINDPUMP.z), cx = Math.floor(WINDPUMP.x), cz = Math.floor(WINDPUMP.z);
  for (let y = g + 1; y <= g + 13; y++) {
    const h = y < g + 6 ? 2 : 1;
    for (const [dx, dz] of [[-h, -h], [h, -h], [-h, h], [h, h]]) kit.set(cx + dx, y, cz + dz, METAL);
  }
  kit.box(cx, g + 14, cz, cx, g + 15, cz, METAL);
  // Twelve-blade wheel facing south and the tail vane.
  for (let k = 0; k < 12; k++) {
    const a = k * Math.PI / 6;
    for (let r = 1; r <= 3; r++) kit.set(cx + Math.round(Math.cos(a) * r), g + 15 + Math.round(Math.sin(a) * r), cz + 1, r === 3 ? PALE : METAL);
  }
  kit.box(cx, g + 15, cz - 4, cx, g + 17, cz - 1, ACCENT);
  // Stock tank beside it.
  kit.cylinder(cx + 4.5, cz + 0.5, 2.4, g + 1, g + 1, RUST, true);
  kit.cylinder(cx + 4.5, cz + 0.5, 1.6, g + 1, g + 1, MC_WATER);
  kit.feature('landmark', { id: 'palmera-windpump', x: WINDPUMP.x, y: g + WINDPUMP.rise, z: WINDPUMP.z });
}

export function buildOasis(kit) {
  pool(kit);
  mission(kit);
  HOUSES.forEach((h, n) => adobe(kit, h.minX, h.minZ, h.maxX, h.maxZ, { floors: n === 1 ? 2 : 1, doors: n % 2 ? ['s', 'w'] : ['n', 'e'], id: `palmera-house-${n + 1}` }));
  windpump(kit);
  for (const s of STALLS) shed(kit, s.minX, s.minZ, s.maxX, s.maxZ, 3, { roof: ACCENT, post: DUST_WOOD });
  crateStack(kit, 230, 214, 2, 1, 1, DUST_CRATE);
  const rng = seededRandom(0xa51);
  for (const [x, z] of PALMS) palm(kit, x, z, 7 + Math.floor(rng() * 4), rng);
  // Adobe garden walls: waist-high cover on the approaches from C and HQ.
  wall(kit, [[180, 286], [214, 286]], 2, DUST_PLASTER, { kind: 'adobe wall' });
  wall(kit, [[268, 284], [282, 268], [282, 248]], 2, DUST_PLASTER, { gapEvery: 9, kind: 'adobe wall' });
  wall(kit, [[188, 206], [200, 200], [222, 198]], 2, DUST_SANDSTONE, { kind: 'stone wall' });
  for (const lane of OASIS_SITE.lanes) kit.feature('lane', { flag: 'A', ...lane });
  kit.paintRect(226, 226, 246, 246, DIRT);
  // Hitching rail and a well-head by the mission.
  kit.box(262, kit.top(262, 270) + 1, 270, 268, kit.top(262, 270) + 1, 270, TIMBER);
  for (const a of OASIS_SITE.ambush) kit.feature('ambush', { flag: 'A', ...a });
  kit.reserve(JEEP.x - 3.5, JEEP.z - 3.5, JEEP.x + 2.5, JEEP.z + 2.5, 5, 'flag-A-jeep');
}
