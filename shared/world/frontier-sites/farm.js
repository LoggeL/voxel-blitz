// Flag A, Kestrel Farm (232, 248): two enterable barns, a plaster farmhouse,
// haystacks, hedgerow lanes and wheat strips. Landmarks: the grain silo and
// the windmill north of the yard, both readable from either HQ.

import {
  AIR, TIMBER, CORRUGATED_STEEL, COBBLE_WALL, TERRACOTTA_ROOF, PLANK, FIELD_WHEAT, PALE,
  METAL, RUST, WHITE_PLASTER, DIRT, GLASS, DUST_CRATE, MEADOW,
} from '../blocks.js';
import { FRONTIER_PLAN } from '../../conquest-contract.js';
import { rect, pickSpawnCells } from './plan.js';
import { hayBale, hedge, fieldWall, plasterHouse, fence, crateStack } from './props.js';

const FLAG = FRONTIER_PLAN.flags.find(f => f.id === 'A');
const BARN = rect(196, 210, 218, 228);
const STONE_BARN = rect(242, 208, 258, 224);
const HOUSE = rect(198, 240, 212, 254);
const SILO = { x: 229.5, z: 199.5, r: 4, rise: 28 };
const MILL = { x: 270.5, z: 228.5, r: 3, rise: 25 };
const JEEP = { x: 248.5, z: 237.5, yaw: -Math.PI / 2 };
const HAY = [[236, 272], [242, 276], [254, 238], [214, 266], [186, 248], [258, 252]];

export const FARM_SITE = Object.freeze({
  flag: 'A', site: 'farm', x: FLAG.x, z: FLAG.z,
  buildings: Object.freeze([BARN, STONE_BARN, HOUSE]),
  hard: STONE_BARN,
  landmarks: Object.freeze([
    Object.freeze({ id: 'kestrel-silo', kind: 'silo', x: SILO.x, z: SILO.z, rise: SILO.rise, primary: true }),
    Object.freeze({ id: 'kestrel-windmill', kind: 'windmill', x: MILL.x, z: MILL.z, rise: MILL.rise }),
  ]),
  vehicle: Object.freeze({ id: 'flag-A-jeep', type: 'jeep', team: 'alpha', ...JEEP }),
  lanes: Object.freeze([
    Object.freeze({ id: 'A-west-hedgerow', from: [150, 236], to: [196, 236] }),
    Object.freeze({ id: 'A-south-hedgerow', from: [228, 310], to: [228, 272] }),
  ]),
  ambush: Object.freeze([
    Object.freeze({ x: 259.5, z: 226.5, faces: 'a-d-ford' }),
    Object.freeze({ x: 214.5, z: 258.5, faces: 'hq-west-a' }),
    Object.freeze({ x: 244.5, z: 279.5, faces: 'a-c' }),
  ]),
  spawns: pickSpawnCells(FLAG.x, FLAG.z, {
    exclude: [BARN, STONE_BARN, HOUSE, rect(244, 233, 253, 242), ...HAY.map(([x, z]) => rect(x - 2, z - 2, x + 2, z + 2))],
    radii: [9, 13, 17],
  }),
});

function barn(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = BARN;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, DIRT, COBBLE_WALL);
  const eave = y + 7;
  kit.walls(x0, z0, x1, z1, y + 1, eave, TIMBER);
  // Ground course of field stone, then vertical boarding.
  kit.walls(x0, z0, x1, z1, y + 1, y + 1, COBBLE_WALL);
  // Wagon doors south and east, man doors north and west.
  kit.box(x0 + 8, y + 1, z1, x0 + 13, y + 5, z1, AIR);
  kit.box(x1, y + 1, z0 + 6, x1, y + 5, z0 + 11, AIR);
  kit.box(x0 + 4, y + 1, z0, x0 + 5, y + 3, z0, AIR);
  kit.box(x0, y + 1, z0 + 12, x0, y + 3, z0 + 13, AIR);
  // Hay loft on the west half, reached by a stepped bale stack.
  kit.box(x0 + 1, y + 4, z0 + 1, x0 + 7, y + 4, z1 - 1, PLANK);
  for (let s = 0; s < 3; s++) kit.box(x0 + 8 + s, y + 1, z0 + 2, x0 + 8 + s, y + 3 - s, z0 + 4, FIELD_WHEAT);
  kit.box(x0 + 1, y + 5, z0 + 2, x0 + 5, y + 5, z0 + 6, FIELD_WHEAT);
  kit.box(x1 - 4, y + 1, z1 - 4, x1 - 2, y + 2, z1 - 2, FIELD_WHEAT);
  kit.box(x1 - 6, y + 1, z0 + 2, x1 - 4, y + 2, z0 + 3, DUST_CRATE);
  // Loft windows and the hay hoist beam.
  kit.box(x0, y + 5, z0 + 4, x0, y + 6, z0 + 5, AIR);
  kit.box(x0 + 2, y + 5, z1, x0 + 4, y + 6, z1, AIR);
  kit.box(x0 + 10, eave + 1, z1 + 1, x0 + 11, eave + 1, z1 + 3, TIMBER);
  kit.box(x0 - 1, eave + 1, z0 - 1, x1 + 1, eave + 1, z1 + 1, CORRUGATED_STEEL);
  const ridge = kit.gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, eave + 1, 'x', CORRUGATED_STEEL, TIMBER);
  kit.feature('building', { id: 'kestrel-barn', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge, enterable: true });
}

function stoneBarn(kit) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = STONE_BARN;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, DIRT, COBBLE_WALL);
  const eave = y + 6;
  kit.walls(x0, z0, x1, z1, y + 1, y + 3, COBBLE_WALL);
  kit.walls(x0, z0, x1, z1, y + 4, eave, TIMBER);
  kit.box(x0, y + 1, z0 + 6, x0, y + 4, z0 + 9, AIR);           // west cart door
  kit.box(x0 + 6, y + 1, z1, x0 + 9, y + 4, z1, AIR);           // south door to the yard
  kit.box(x1, y + 2, z0 + 3, x1, y + 3, z0 + 4, AIR);           // east firing slot
  kit.box(x1, y + 2, z1 - 4, x1, y + 3, z1 - 3, AIR);
  kit.box(x0 + 2, y + 1, z0 + 2, x0 + 4, y + 2, z0 + 3, FIELD_WHEAT);
  kit.box(x1 - 3, y + 1, z0 + 1, x1 - 1, y + 1, z1 - 1, PLANK); // feed trough
  kit.box(x0 - 1, eave + 1, z0 - 1, x1 + 1, eave + 1, z1 + 1, TERRACOTTA_ROOF);
  const ridge = kit.gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, eave + 1, 'z', TERRACOTTA_ROOF, TIMBER);
  kit.feature('building', { id: 'kestrel-stone-barn', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge, enterable: true, hard: true });
  kit.feature('hard-building', { flag: 'A', id: 'kestrel-stone-barn', ...STONE_BARN });
}

function silo(kit) {
  const g = kit.top(SILO.x, SILO.z);
  kit.cylinder(SILO.x, SILO.z, SILO.r + 0.6, g, g, PALE);
  kit.cylinder(SILO.x, SILO.z, SILO.r, g + 1, g + 22, CORRUGATED_STEEL, true);
  for (const band of [6, 12, 18]) kit.cylinder(SILO.x, SILO.z, SILO.r + 0.4, g + band, g + band, RUST, true);
  for (let i = 0; i < 4; i++) kit.cylinder(SILO.x, SILO.z, SILO.r - 0.7 - i * 0.9, g + 23 + i, g + 23 + i, PALE);
  kit.box(Math.floor(SILO.x), g + SILO.rise - 1, Math.floor(SILO.z), Math.floor(SILO.x), g + SILO.rise, Math.floor(SILO.z), METAL);
  // External ladder cage and the auger into the stone barn's loft.
  kit.box(Math.floor(SILO.x) + 4, g + 1, Math.floor(SILO.z), Math.floor(SILO.x) + 4, g + 22, Math.floor(SILO.z), METAL);
  kit.line(SILO.x + 3, g + 18, SILO.z + 2, STONE_BARN.minX, g + 8, STONE_BARN.minZ + 2, RUST);
  kit.feature('landmark', { id: 'kestrel-silo', x: SILO.x, y: g + SILO.rise, z: SILO.z });
}

function windmill(kit) {
  const g = kit.top(MILL.x, MILL.z);
  for (let y = g + 1; y <= g + 16; y++) {
    const r = MILL.r - (y - g) * 0.06;
    kit.cylinder(MILL.x, MILL.z, r, y, y, y < g + 4 ? COBBLE_WALL : WHITE_PLASTER, true);
  }
  kit.box(Math.floor(MILL.x), g + 1, Math.floor(MILL.z) + 2, Math.floor(MILL.x), g + 3, Math.floor(MILL.z) + 3, AIR);
  kit.box(Math.floor(MILL.x) + 2, g + 8, Math.floor(MILL.z), Math.floor(MILL.x) + 3, g + 9, Math.floor(MILL.z), GLASS);
  kit.cylinder(MILL.x, MILL.z, 2.6, g + 17, g + 17, TERRACOTTA_ROOF);
  kit.cylinder(MILL.x, MILL.z, 1.8, g + 18, g + 18, TERRACOTTA_ROOF);
  // Four lattice sails on the south face, cross-shaped like an X.
  const hx = Math.floor(MILL.x), hy = g + 17, hz = Math.floor(MILL.z) + 3;
  kit.box(hx, hy, hz - 1, hx, hy, hz, TIMBER);
  for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    for (let k = 1; k <= 8; k++) {
      kit.set(hx + dx * k, hy + dy * k, hz, TIMBER);
      if (k > 2) kit.set(hx + dx * k + dx, hy + dy * k, hz, PLANK);
    }
  }
  kit.set(hx, g + MILL.rise, Math.floor(MILL.z), TIMBER);
  kit.feature('landmark', { id: 'kestrel-windmill', x: MILL.x, y: g + MILL.rise, z: MILL.z });
}

export function buildFarm(kit) {
  // Wheat strips, field fences and hedgerows first; buildings overwrite them.
  barn(kit);
  stoneBarn(kit);
  plasterHouse(kit, HOUSE.minX, HOUSE.minZ, HOUSE.maxX, HOUSE.maxZ, { floors: 2, axis: 'z', doors: ['e', 'n'] });
  silo(kit);
  windmill(kit);
  for (const [x, z] of HAY) hayBale(kit, x, z);
  // Covered approach lanes: hedged footpaths from the west and the south.
  hedge(kit, [[150, 232], [195, 232]]);
  hedge(kit, [[150, 241], [196, 241]]);
  hedge(kit, [[223, 310], [223, 268]]);
  hedge(kit, [[233, 310], [233, 271]]);
  for (const lane of FARM_SITE.lanes) kit.feature('lane', { flag: 'A', ...lane });
  // Yard walls and stock fences around the strips.
  fieldWall(kit, [[256, 264], [262, 262], [266, 258]]);
  fieldWall(kit, [[190, 262], [196, 270], [204, 272]]);
  fieldWall(kit, [[218, 232], [218, 238]], { height: 1 });
  fence(kit, [[150, 168], [214, 168], [214, 226]]);
  fence(kit, [[252, 174], [318, 174], [318, 226]]);
  fence(kit, [[168, 266], [206, 266]]);
  crateStack(kit, 222, 230, 2, 2, 2, DUST_CRATE);
  crateStack(kit, 238, 262, 3, 1, 1, FIELD_WHEAT);
  // A hay cart parked by the stone barn and a feed trough in the yard.
  const g = kit.top(250, 228);
  kit.box(248, g + 1, 228, 252, g + 1, 230, PLANK); kit.box(248, g + 2, 228, 252, g + 2, 230, FIELD_WHEAT);
  kit.paintRect(222, 236, 242, 260, DIRT);
  kit.paintRect(186, 212, 194, 226, MEADOW);
  for (const a of FARM_SITE.ambush) kit.feature('ambush', { flag: 'A', ...a });
  kit.reserve(JEEP.x - 3.5, JEEP.z - 3.5, JEEP.x + 2.5, JEEP.z + 2.5, 5, 'flag-A-jeep');
}
