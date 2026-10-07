// Flag C, Iron Bridge (384, 384): the steel bowstring truss carrying the
// paved axis over the river (CONCRETE deck over a METAL core), riverside
// ruins, a brick toll house, sandbagged bridgeheads and a water tower.
// Also builds the deck, girders and railings of the north and south bridges.

import {
  AIR, METAL, CONCRETE, RUST, BRICK, COBBLE_WALL, CORRUGATED_STEEL, PLANK, GLASS, MC_WATER,
  DIRT, TIMBER,
} from '../blocks.js';
import { FRONTIER_PLAN } from '../../conquest-contract.js';
import { FRONTIER_CROSSINGS, FRONTIER_CELL_KIND as KIND, riverOffset } from '../frontier-terrain.js';
import { rect, pickSpawnCells } from './plan.js';
import { sandbags, fieldWall, crateStack } from './props.js';

const FLAG = FRONTIER_PLAN.flags.find(f => f.id === 'C');
const IRON = FRONTIER_CROSSINGS.find(c => c.id === 'iron-bridge');
const ARCH = { x0: 370, x1: 397, zs: [378, 389], rise: 19 };
const TOLL = rect(358, 364, 368, 373);
const WAREHOUSE = rect(399, 394, 409, 403);
const RUIN_W = rect(356, 396, 366, 406);
const RUIN_E = rect(401, 361, 411, 371);
const WATER_TOWER = { x: 348.5, z: 362.5, rise: 25 };
const TANK_WEST = { x: 346.5, z: 392.5 }, TANK_EAST = { x: 421.5, z: 375.5 };
export const IRON_ARCH_TOP_Y = IRON.deckY + 1 + ARCH.rise;

export const BRIDGE_SITE = Object.freeze({
  flag: 'C', site: 'bridge', x: FLAG.x, z: FLAG.z,
  buildings: Object.freeze([TOLL, WAREHOUSE, RUIN_W, RUIN_E]),
  hard: TOLL,
  landmarks: Object.freeze([
    Object.freeze({ id: 'iron-bridge-arch', kind: 'truss', x: 384, z: 384, y: IRON_ARCH_TOP_Y, primary: true }),
    Object.freeze({ id: 'iron-bridge-water-tower', kind: 'water tower', x: WATER_TOWER.x, z: WATER_TOWER.z, rise: WATER_TOWER.rise }),
  ]),
  // The C tank pad flips bank with the owner: west for alpha, east for bravo.
  vehicle: Object.freeze({ id: 'flag-C-tank', type: 'tank', team: null, x: TANK_WEST.x, z: TANK_WEST.z, yaw: -Math.PI / 2,
    altX: TANK_EAST.x, altZ: TANK_EAST.z, altYaw: Math.PI / 2 }),
  lanes: Object.freeze([
    Object.freeze({ id: 'C-west-quay', from: [374, 340], to: [374, 428] }),
    Object.freeze({ id: 'C-east-quay', from: [394, 428], to: [394, 340] }),
  ]),
  ambush: Object.freeze([
    Object.freeze({ x: 366.5, z: 374.5, faces: 'axis' }),
    Object.freeze({ x: 401.5, z: 393.5, faces: 'axis' }),
    Object.freeze({ x: 357.5, z: 395.5, faces: 'axis' }),
    Object.freeze({ x: 410.5, z: 372.5, faces: 'axis' }),
  ]),
  spawns: pickSpawnCells(FLAG.x, FLAG.z, {
    exclude: [TOLL, WAREHOUSE, RUIN_W, RUIN_E, rect(342, 388, 351, 397), rect(417, 371, 426, 380),
      rect(362, 374, 373, 377), rect(362, 390, 373, 393), rect(394, 374, 405, 377), rect(394, 390, 405, 393)],
    radii: [13, 17, 21, 25],
    accept: (x, z) => Math.abs(riverOffset(x, z)) > 9 && x > 340 && x < 428,
  }),
});

/** Deck, girders and railings for every bridge crossing. */
function decks(kit) {
  const { kind } = kit.terrain;
  for (const c of FRONTIER_CROSSINGS.filter(c => c.kind === 'bridge')) {
    const r = c.halfSpan + c.width;
    const deck = [];
    for (let z = Math.floor(c.z - r); z <= Math.ceil(c.z + r); z++) for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
      if (kind[z * kit.SX + x] === KIND.BRIDGE) deck.push([x, z]);
    }
    const isDeck = new Set(deck.map(([x, z]) => `${x},${z}`));
    for (const [x, z] of deck) {
      kit.set(x, c.deckY, z, CONCRETE);
      kit.set(x, c.deckY - 1, z, METAL);
      kit.box(x, c.deckY + 1, z, x, c.deckY + 6, z, AIR);
    }
    // Edge girders and railings over open water beside the deck.
    for (const [x, z] of deck) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (isDeck.has(`${nx},${nz}`) || kind[nz * kit.SX + nx] !== KIND.RIVER) continue;
      kit.box(nx, c.deckY - 1, nz, nx, c.deckY, nz, METAL);
      if (c.id !== 'iron-bridge') kit.set(nx, c.deckY + 1, nz, (nx + nz) % 3 ? METAL : RUST);
    }
    // Mid-river piers.
    const pierX = Math.round(c.x) - 1;
    for (const [x, z] of deck) if (x === pierX || x === pierX + 1) {
      if ((z - Math.floor(c.z - c.width / 2)) % 3 !== 1) continue;
      for (let y = 1; y < c.deckY - 1; y++) if (kit.get(x, y, z) === MC_WATER || kit.get(x, y, z) === AIR) kit.set(x, y, z, CONCRETE);
    }
    kit.feature('bridge', { id: c.id, x: c.x, z: c.z, deckY: c.deckY, cells: deck.length });
  }
}

function ironTruss(kit) {
  const y0 = IRON.deckY + 1;
  const archY = x => y0 + Math.round(ARCH.rise * Math.max(0, 1 - ((x + 0.5 - IRON.x) / ((ARCH.x1 - ARCH.x0) / 2 + 0.5)) ** 2));
  for (const z of ARCH.zs) {
    // Feet: concrete abutment blocks on both banks.
    for (const fx of [ARCH.x0, ARCH.x1]) kit.box(fx - 1, kit.top(fx, z) - 2, z - 1, fx + 1, y0, z + 1, CONCRETE);
    for (let x = ARCH.x0; x <= ARCH.x1; x++) {
      const a = archY(x), b = archY(Math.min(ARCH.x1, x + 1));
      kit.box(x, Math.min(a, b), z, x, Math.max(a, b), z, METAL);     // top chord
      kit.set(x, y0, z, METAL);                                        // bottom chord / rail
      if ((x - ARCH.x0) % 3 === 0) kit.box(x, y0, z, x, a, z, METAL);  // verticals
    }
    for (let x = ARCH.x0; x + 3 <= ARCH.x1; x += 3) {
      const up = ((x - ARCH.x0) / 3) % 2 === 0;
      kit.line(x, up ? y0 : archY(x), z, x + 3, up ? archY(x + 3) : y0, z, RUST);
    }
  }
  // Overhead lateral bracing wherever the arch clears the deck by 7 m.
  for (let x = ARCH.x0; x <= ARCH.x1; x++) {
    const a = archY(x);
    if (a < y0 + 7) continue;
    if ((x - ARCH.x0) % 3 === 0) kit.box(x, a, ARCH.zs[0], x, a, ARCH.zs[1], METAL);
  }
  kit.line(ARCH.x0 + 9, archY(ARCH.x0 + 9), ARCH.zs[0], ARCH.x1 - 9, archY(ARCH.x1 - 9), ARCH.zs[1], RUST);
  kit.line(ARCH.x0 + 9, archY(ARCH.x0 + 9), ARCH.zs[1], ARCH.x1 - 9, archY(ARCH.x1 - 9), ARCH.zs[0], RUST);
  const crown = archY(Math.floor(IRON.x));
  kit.box(Math.floor(IRON.x), crown, ARCH.zs[0], Math.floor(IRON.x), crown, ARCH.zs[1], METAL);
  kit.feature('landmark', { id: 'iron-bridge-arch', x: IRON.x, y: crown, z: IRON.z });
}

function waterTower(kit) {
  const { x, z } = WATER_TOWER, g = kit.top(x, z);
  const fx = Math.floor(x), fz = Math.floor(z);
  for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) kit.box(fx + dx, g + 1, fz + dz, fx + dx, g + 16, fz + dz, METAL);
  for (const y of [g + 6, g + 12]) { kit.walls(fx - 3, fz - 3, fx + 3, fz + 3, y, y, RUST); }
  kit.line(fx - 3, g + 1, fz - 3, fx + 3, g + 12, fz - 3, RUST);
  kit.line(fx + 3, g + 1, fz + 3, fx - 3, g + 12, fz + 3, RUST);
  kit.cylinder(x, z, 4.2, g + 17, g + 17, METAL);
  kit.cylinder(x, z, 4.2, g + 18, g + 22, CORRUGATED_STEEL, true);
  kit.cylinder(x, z, 3.4, g + 23, g + 23, RUST);
  kit.cylinder(x, z, 2.2, g + 24, g + 24, RUST);
  kit.set(fx, g + WATER_TOWER.rise, fz, METAL);
  kit.box(fx + 4, g + 1, fz, fx + 4, g + 17, fz, METAL);              // ladder
  kit.feature('landmark', { id: 'iron-bridge-water-tower', x, y: g + WATER_TOWER.rise, z });
}

/** Two-storey brick toll house with a flat parapet roof: the hard point. */
function tollHouse(kit, r, ruined) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = r;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, PLANK, COBBLE_WALL);
  const top = y + 8;
  kit.walls(x0, z0, x1, z1, y + 1, top, BRICK);
  kit.box(x0 + 1, y + 4, z0 + 1, x1 - 1, y + 4, z1 - 1, PLANK);
  kit.box(x0 + 1, y + 4, z1 - 2, x0 + 3, y + 4, z1 - 1, AIR);
  for (let s = 0; s < 3; s++) kit.box(x0 + 1 + s, y + 1, z1 - 2, x0 + 1 + s, y + 1 + s, z1 - 1, PLANK);
  for (const wy of [y + 2, y + 6]) {
    for (let x = x0 + 2; x < x1 - 1; x += 3) { kit.box(x, wy, z0, x, wy + 1, z0, ruined ? AIR : GLASS); kit.box(x, wy, z1, x, wy + 1, z1, AIR); }
    for (let z = z0 + 2; z < z1 - 1; z += 3) { kit.box(x0, wy, z, x0, wy + 1, z, AIR); kit.box(x1, wy, z, x1, wy + 1, z, ruined ? AIR : GLASS); }
  }
  const mz = (z0 + z1) >> 1, mx = (x0 + x1) >> 1;
  kit.box(x1, y + 1, mz - 1, x1, y + 3, mz, AIR); kit.box(x0, y + 1, mz - 1, x0, y + 3, mz, AIR);
  kit.box(mx, y + 1, z0, mx + 1, y + 3, z0, AIR);
  if (ruined) {
    // Shell damage: a collapsed corner and a half roof of charred joists.
    kit.box(x1 - 3, y + 5, z0, x1, top, z0 + 3, AIR);
    for (let x = x0 + 1; x < x1 - 3; x += 2) kit.box(x, top, z0 + 1, x, top, z1 - 1, TIMBER);
    kit.box(x1 - 4, y + 1, z0 + 1, x1 - 1, y + 2, z0 + 3, BRICK);
  } else {
    kit.box(x0, top + 1, z0, x1, top + 1, z1, CONCRETE);
    kit.walls(x0, z0, x1, z1, top + 2, top + 2, BRICK);
    kit.box(x0 + 2, top + 1, z0 + 2, x0 + 3, top + 1, z0 + 3, AIR);     // roof hatch
    kit.box(x0 + 2, y + 5, z0 + 2, x0 + 2, top, z0 + 2, METAL);         // ladder to the hatch
  }
  kit.feature('building', { minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: top, enterable: true, hard: !ruined });
}

/** Roofless brick ruin with broken wall tops and rubble. */
function ruin(kit, r, seed) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = r;
  const y = kit.maxTop(x0, z0, x1, z1);
  const height = (x, z) => 2 + ((x * 7 + z * 13 + seed) % 5);
  for (let x = x0; x <= x1; x++) for (const z of [z0, z1]) kit.box(x, y + 1, z, x, y + height(x, z), z, BRICK);
  for (let z = z0; z <= z1; z++) for (const x of [x0, x1]) kit.box(x, y + 1, z, x, y + height(x, z), z, BRICK);
  kit.box(x0 + 3, y + 1, z0, x0 + 5, y + 3, z0, AIR);
  kit.box(x1, y + 1, z0 + 3, x1, y + 3, z0 + 5, AIR);
  kit.box(x0 + 2, y + 1, z1 - 3, x0 + 4, y + 1, z1 - 2, COBBLE_WALL);
  kit.box(x1 - 3, y + 1, z0 + 2, x1 - 2, y + 2, z0 + 2, BRICK);
  kit.feature('building', { minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: y + 6, enterable: true, ruin: true });
}

/** Stone quay faces where the C banks drop straight to the water. */
function quays(kit) {
  const { kind, heights } = kit.terrain;
  for (let z = FLAG.z - 46; z <= FLAG.z + 46; z++) for (let x = FLAG.x - 20; x <= FLAG.x + 20; x++) {
    const i = z * kit.SX + x;
    if (kind[i] !== KIND.PAD) continue;
    const nearWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => kind[(z + dz) * kit.SX + x + dx] === KIND.RIVER);
    if (nearWater) kit.box(x, heights[i] - 4, z, x, heights[i], z, COBBLE_WALL);
  }
}

export function buildBridgeSite(kit) {
  decks(kit);
  ironTruss(kit);
  quays(kit);
  waterTower(kit);
  tollHouse(kit, TOLL, false);
  kit.feature('hard-building', { flag: 'C', id: 'iron-bridge-toll-house', ...TOLL });
  tollHouse(kit, WAREHOUSE, true);
  ruin(kit, RUIN_W, 3);
  ruin(kit, RUIN_E, 5);
  // Sandbagged bridgeheads beside the roadway.
  sandbags(kit, [[363, 376], [372, 376], [372, 374]]);
  sandbags(kit, [[363, 391], [372, 391], [372, 393]]);
  sandbags(kit, [[404, 391], [395, 391], [395, 393]]);
  sandbags(kit, [[404, 376], [395, 376], [395, 374]]);
  // Quay lanes: a wall on the landward side of each riverbank path.
  fieldWall(kit, [[370, 338], [370, 375]]);
  fieldWall(kit, [[370, 392], [370, 430]]);
  fieldWall(kit, [[397, 338], [397, 375]]);
  fieldWall(kit, [[397, 392], [397, 430]]);
  for (const lane of BRIDGE_SITE.lanes) kit.feature('lane', { flag: 'C', ...lane });
  crateStack(kit, 352, 380, 2, 2, 2);
  crateStack(kit, 414, 386, 2, 2, 2);
  kit.paintRect(342, 388, 351, 397, DIRT);
  kit.paintRect(417, 371, 426, 380, DIRT);
  for (const a of BRIDGE_SITE.ambush) kit.feature('ambush', { flag: 'C', ...a });
  for (const p of [TANK_WEST, TANK_EAST]) kit.reserve(p.x - 4.5, p.z - 4.5, p.x + 3.5, p.z + 3.5, 5, 'flag-C-tank');
}
