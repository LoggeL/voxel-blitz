// Flag B, St. Aldric (272, 520) on its hill: two-storey plaster houses with
// stepped terracotta roofs around a cobbled square, walled yards and alleys.
// Landmark: the church spire, whose cross tops out at y78.

import {
  AIR, COBBLE_WALL, WHITE_PLASTER, TERRACOTTA_ROOF, PLANK, GLASS, METAL, TIMBER, MC_COBBLE,
  DIRT, DUST_CRATE, ACCENT,
} from '../blocks.js';
import { FRONTIER_PLAN } from '../../conquest-contract.js';
import { rect, pickSpawnCells, roadClearance } from './plan.js';
import { plasterHouse, fieldWall, hedge, crateStack, oak, poplar, lineCells } from './props.js';
import { seededRandom } from './kit.js';

const FLAG = FRONTIER_PLAN.flags.find(f => f.id === 'B');
const NAVE = rect(266, 540, 286, 552);
const TOWER = rect(258, 542, 265, 550);
export const SPIRE_TOP_Y = FRONTIER_PLAN.heights.landmarkMax;
const HOUSES = [
  { r: rect(240, 512, 251, 524), axis: 'z', doors: ['e', 'w'] },
  { r: rect(244, 530, 255, 540), axis: 'x', doors: ['n', 'e'] },
  { r: rect(290, 530, 300, 542), axis: 'z', doors: ['w', 's'] },
  { r: rect(262, 494, 274, 503), axis: 'x', doors: ['s', 'n'] },
  { r: rect(292, 497, 301, 506), axis: 'x', doors: ['s'] },
  { r: rect(228, 506, 238, 516), axis: 'z', doors: ['e'], floors: 1 },
];
/**
 * The hill village around the square: closed plaster houses on stone plinths
 * stepping up the west rise and down the south slope toward Ashgrove, behind
 * the square as seen from the river. The east and north approaches stay open
 * so attackers from the fords can still reach the flag (a ring of closed
 * houses there halved the flag turnover in conquest-action-test). Lots are
 * dropped where a road or lane would come within 3 m (plan time, no voxels).
 */
const HILL_LOTS = [
  [212, 500, 222, 509, 'z', 2], [206, 513, 216, 522, 'x', 2], [212, 527, 223, 536, 'z', 3], [204, 540, 213, 549, 'x', 1],
  [220, 540, 230, 549, 'z', 2], [226, 560, 236, 569, 'x', 2], [241, 562, 250, 571, 'z', 2], [257, 562, 267, 570, 'x', 3],
  [272, 563, 281, 572, 'z', 1], [286, 560, 295, 569, 'x', 2], [234, 578, 244, 586, 'z', 1], [252, 580, 262, 589, 'x', 2],
  [268, 581, 276, 590, 'z', 1], [196, 526, 204, 535, 'z', 1], [286, 576, 294, 584, 'x', 1], [220, 590, 229, 598, 'z', 2],
].map(([x0, z0, x1, z1, axis, floors]) => ({ r: rect(x0, z0, x1, z1), axis, floors }))
  .filter(({ r }) => {
    for (let x = r.minX - 1; x <= r.maxX + 1; x++) for (const z of [r.minZ - 1, r.maxZ + 1]) if (roadClearance(x + 0.5, z + 0.5) < 3) return false;
    for (let z = r.minZ - 1; z <= r.maxZ + 1; z++) for (const x of [r.minX - 1, r.maxX + 1]) if (roadClearance(x + 0.5, z + 0.5) < 3) return false;
    return true;
  });
/** Every hill lot (plain rectangles): the woodland keeps clear of them. */
export const VILLAGE_LOTS = Object.freeze(HILL_LOTS.map(l => l.r));
/** Stepped cobble lanes from the square up and down the hill. */
const STREETS = [
  [[240, 524.5], [218, 524.5], [200, 524.5]],
  [[253, 556], [253, 576], [248, 592]],
  [[226, 552], [282, 576]],
];
const JEEP = { x: 256.5, z: 520.5, yaw: 0 };
const WELL = { x: 278.5, z: 523.5 };

export const VILLAGE_SITE = Object.freeze({
  flag: 'B', site: 'village', x: FLAG.x, z: FLAG.z,
  buildings: Object.freeze([NAVE, TOWER, ...HOUSES.map(h => h.r)]),
  hard: NAVE,
  landmarks: Object.freeze([
    Object.freeze({ id: 'st-aldric-spire', kind: 'spire', x: 261.5, z: 546.5, y: SPIRE_TOP_Y, primary: true }),
  ]),
  vehicle: Object.freeze({ id: 'flag-B-jeep', type: 'jeep', team: 'alpha', ...JEEP }),
  lanes: Object.freeze([
    Object.freeze({ id: 'B-north-alley', from: [279, 468], to: [279, 492] }),
    Object.freeze({ id: 'B-east-sunken-lane', from: [330, 549], to: [302, 549] }),
  ]),
  ambush: Object.freeze([
    Object.freeze({ x: 291.5, z: 508.5, faces: 'e-b-ford' }),
    Object.freeze({ x: 283.5, z: 490.5, faces: 'b-c' }),
    Object.freeze({ x: 238.5, z: 504.5, faces: 'hq-west-b' }),
  ]),
  spawns: pickSpawnCells(FLAG.x, FLAG.z, {
    exclude: [NAVE, TOWER, ...HOUSES.map(h => h.r), rect(253, 516, 260, 525), rect(WELL.x - 2, WELL.z - 2, WELL.x + 2, WELL.z + 2)],
    radii: [8, 12, 16],
  }),
});

function church(kit) {
  const y = kit.maxTop(TOWER.minX, NAVE.minZ, NAVE.maxX, NAVE.maxZ);
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = NAVE;
  kit.foundation(TOWER.minX, z0, x1, z1, y, MC_COBBLE, COBBLE_WALL);
  const eave = y + 9;
  // Thick rubble walls, a lime-washed clerestory band and buttresses.
  kit.walls(x0, z0, x1, z1, y + 1, eave, COBBLE_WALL);
  kit.walls(x0, z0, x1, z1, eave - 2, eave, WHITE_PLASTER);
  for (let x = x0 + 4; x < x1; x += 5) { kit.box(x, y + 1, z0 - 1, x, y + 5, z0 - 1, COBBLE_WALL); kit.box(x, y + 1, z1 + 1, x, y + 5, z1 + 1, COBBLE_WALL); }
  for (let x = x0 + 2; x < x1 - 1; x += 5) { kit.box(x, y + 3, z0, x, y + 7, z0, GLASS); kit.box(x, y + 3, z1, x, y + 7, z1, GLASS); }
  kit.box(x1, y + 4, z0 + 4, x1, y + 8, z1 - 4, GLASS);               // east rose window
  kit.box(x0 + 9, y + 1, z0, x0 + 11, y + 4, z0, AIR);                 // north door onto the square
  kit.box(x1, y + 1, z0 + 5, x1, y + 3, z0 + 7, AIR);                  // vestry door
  // Pews, an altar step and a gallery.
  for (let x = x0 + 3; x < x1 - 4; x += 2) { kit.box(x, y + 1, z0 + 2, x, y + 1, z0 + 4, PLANK); kit.box(x, y + 1, z1 - 4, x, y + 1, z1 - 2, PLANK); }
  kit.box(x1 - 3, y + 1, z0 + 2, x1 - 1, y + 1, z1 - 2, MC_COBBLE);
  kit.box(x0 + 1, y + 5, z0 + 1, x0 + 4, y + 5, z1 - 1, PLANK);
  for (let s = 0; s < 4; s++) kit.box(x0 + 5 + s, y + 1, z1 - 2, x0 + 5 + s, y + 4 - s, z1 - 1, PLANK);
  kit.box(x0 - 1, eave + 1, z0 - 1, x1 + 1, eave + 1, z1 + 1, TERRACOTTA_ROOF);
  const ridge = kit.gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, eave + 1, 'x', TERRACOTTA_ROOF, WHITE_PLASTER);
  kit.feature('building', { id: 'st-aldric-church', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge, enterable: true, hard: true });

  // Bell tower and spire.
  const { minX: tx0, minZ: tz0, maxX: tx1, maxZ: tz1 } = TOWER;
  const belfry = 60;
  // Lime-washed tower on a rubble base with stone quoins: the white shaft
  // reads against the hillside from both HQs.
  kit.walls(tx0, tz0, tx1, tz1, y + 1, belfry, WHITE_PLASTER);
  kit.walls(tx0, tz0, tx1, tz1, y + 1, y + 4, COBBLE_WALL);
  for (const [qx, qz] of [[tx0, tz0], [tx1, tz0], [tx0, tz1], [tx1, tz1]]) kit.box(qx, y + 5, qz, qx, belfry, qz, COBBLE_WALL);
  kit.box(tx0 + 1, y + 1, tz0 + 1, tx1 - 1, belfry, tz1 - 1, AIR);
  kit.box(tx1, y + 1, tz0 + 3, tx1, y + 4, tz1 - 3, AIR);              // tower arch into the nave
  kit.box(tx0, y + 1, tz0 + 3, tx0, y + 4, tz1 - 3, AIR);              // west door
  for (let fy = y + 7; fy < belfry - 2; fy += 6) {
    kit.box(tx0 + 1, fy, tz0 + 1, tx1 - 1, fy, tz1 - 1, PLANK);
    kit.box(tx0 + 2, fy, tz0 + 2, tx0 + 3, fy, tz0 + 3, AIR);
    kit.box(tx0 + 4, fy + 2, tz0 - 0, tx0 + 4, fy + 3, tz0, AIR);       // lancets
    kit.box(tx0 + 4, fy + 2, tz1, tx0 + 4, fy + 3, tz1, AIR);
  }
  // Belfry louvres, a cornice and the bell.
  for (const [ax, az, bx, bz] of [[tx0 + 2, tz0, tx1 - 2, tz0], [tx0 + 2, tz1, tx1 - 2, tz1], [tx0, tz0 + 2, tx0, tz1 - 2], [tx1, tz0 + 2, tx1, tz1 - 2]]) {
    kit.box(ax, belfry - 5, az, bx, belfry - 2, bz, AIR);
    kit.box(ax, belfry - 4, az, bx, belfry - 4, bz, TIMBER);
  }
  kit.box(tx0 + 3, belfry - 4, tz0 + 3, tx0 + 4, belfry - 3, tz0 + 4, ACCENT);
  kit.box(tx0 - 1, belfry, tz0 - 1, tx1 + 1, belfry, tz1 + 1, WHITE_PLASTER);
  // Stepped spire from the 8 m tower to a single cross column at y78.
  const cx = (tx0 + tx1) / 2, cz = (tz0 + tz1) / 2;
  const levels = SPIRE_TOP_Y - 3 - belfry;
  for (let k = 1; k <= levels; k++) {
    const half = 3.6 * (1 - (k - 1) / levels);
    const ax = Math.round(cx - half), bx = Math.round(cx + half), az = Math.round(cz - half), bz = Math.round(cz + half);
    if (bx - ax >= 2) kit.walls(ax, az, bx, bz, belfry + k, belfry + k, TERRACOTTA_ROOF);
    else kit.box(ax, belfry + k, az, bx, belfry + k, bz, TERRACOTTA_ROOF);
  }
  const top = { x: Math.floor(cx), z: Math.floor(cz) };
  kit.box(top.x, SPIRE_TOP_Y - 3, top.z, top.x, SPIRE_TOP_Y, top.z, METAL);
  kit.box(top.x - 1, SPIRE_TOP_Y - 1, top.z, top.x + 1, SPIRE_TOP_Y - 1, top.z, METAL);
  kit.feature('landmark', { id: 'st-aldric-spire', x: top.x + 0.5, y: SPIRE_TOP_Y, z: top.z + 0.5 });
  kit.feature('hard-building', { flag: 'B', id: 'st-aldric-church', ...NAVE });
}

/** Closed houses on the hill lots, stepped cobble lanes, garden walls and cypresses. */
function hillside(kit, rng) {
  for (const points of STREETS) {
    for (let i = 1; i < points.length; i++) {
      for (const [x, z] of lineCells(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])) {
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const cx = x + dx, cz = z + dz;
          if (roadClearance(cx + 0.5, cz + 0.5) < 0.5 || kit.surface(cx, cz) !== kit.top(cx, cz)) continue;
          kit.paint(cx, cz, MC_COBBLE);
        }
      }
    }
  }
  const sides = ['n', 's', 'e', 'w'];
  HILL_LOTS.forEach(({ r, axis, floors }, n) => {
    const doors = axis === 'x' ? [sides[n % 2]] : [sides[2 + (n % 2)]];
    plasterHouse(kit, r.minX, r.minZ, r.maxX, r.maxZ, { floors, axis, doors, closed: true });
    // A walled garden plot on the downhill side of every other house.
    if (n % 2) return;
    const g = kit.top(r.minX, r.maxZ + 3), h = kit.top(r.maxX, r.maxZ + 3);
    const downhillSouth = g + h <= kit.top(r.minX, r.minZ - 3) + kit.top(r.maxX, r.minZ - 3);
    const z = downhillSouth ? r.maxZ + 4 : r.minZ - 4;
    fieldWall(kit, [[r.minX - 1, z], [r.maxX + 1, z]], { height: 1 });
  });
  // Cypresses and fruit trees between the houses.
  for (const [x, z] of [[218, 511], [226, 538], [238, 575], [266, 577], [300, 562], [282, 590], [210, 552]]) {
    if (kit.surface(x, z) !== kit.top(x, z)) continue;
    if (rng() < 0.6) poplar(kit, x, z, 9 + Math.floor(rng() * 3));
    else oak(kit, x, z, 6 + Math.floor(rng() * 2), rng);
  }
}

function square(kit) {
  // Cobbled square, a covered well and market stalls.
  for (let z = FLAG.z - 15; z <= FLAG.z + 15; z++) for (let x = FLAG.x - 15; x <= FLAG.x + 15; x++) {
    if (Math.hypot(x + 0.5 - FLAG.x, z + 0.5 - FLAG.z) <= 15) kit.paint(x, z, MC_COBBLE);
  }
  const g = kit.top(WELL.x, WELL.z);
  kit.cylinder(WELL.x, WELL.z, 1.6, g + 1, g + 1, COBBLE_WALL);
  for (const [dx, dz] of [[-1, -1], [1, 1]]) kit.box(Math.floor(WELL.x) + dx, g + 2, Math.floor(WELL.z) + dz, Math.floor(WELL.x) + dx, g + 3, Math.floor(WELL.z) + dz, TIMBER);
  kit.box(Math.floor(WELL.x) - 1, g + 4, Math.floor(WELL.z) - 1, Math.floor(WELL.x) + 1, g + 4, Math.floor(WELL.z) + 1, TERRACOTTA_ROOF);
  kit.feature('cover', { cover: 'well', x: WELL.x, z: WELL.z, height: 1 });
  crateStack(kit, 284, 528, 2, 1, 1, DUST_CRATE);
  crateStack(kit, 262, 507, 2, 2, 2, DUST_CRATE);
}

export function buildVillage(kit) {
  const rng = seededRandom(0x5a1d);
  // Walled yards and alleys first, so houses overwrite their back walls.
  fieldWall(kit, [[236, 510], [236, 528], [242, 528]]);
  fieldWall(kit, [[257, 528], [257, 538]]);
  fieldWall(kit, [[288, 526], [302, 526], [304, 544], [288, 546]], { height: 2 });
  fieldWall(kit, [[302, 494], [306, 494], [306, 510]]);
  fieldWall(kit, [[258, 492], [260, 504]]);
  fieldWall(kit, [[226, 504], [226, 520], [238, 520]]);
  // North alley and east sunken lane: walls on both sides.
  fieldWall(kit, [[276, 468], [276, 491]]);
  fieldWall(kit, [[282, 468], [282, 490]]);
  fieldWall(kit, [[302, 546], [330, 546]]);
  fieldWall(kit, [[302, 552], [330, 552]]);
  for (const lane of VILLAGE_SITE.lanes) kit.feature('lane', { flag: 'B', ...lane });
  church(kit);
  for (const h of HOUSES) plasterHouse(kit, h.r.minX, h.r.minZ, h.r.maxX, h.r.maxZ, { floors: h.floors ?? 2, axis: h.axis, doors: h.doors });
  hillside(kit, rng);
  square(kit);
  // Kitchen gardens and yard trees behind the houses.
  for (const [x, z] of [[232, 524], [298, 548], [306, 500], [250, 546]]) oak(kit, x, z, 7, rng);
  hedge(kit, [[232, 552], [240, 556]], { gapEvery: 0 });
  kit.paintRect(253, 516, 260, 525, DIRT);
  // Churchyard: low wall and two stone crosses.
  fieldWall(kit, [[256, 554], [288, 556]], { height: 1 });
  for (const x of [270, 278]) { const g = kit.top(x, 555); kit.box(x, g + 1, 555, x, g + 2, 555, COBBLE_WALL); }
  for (const a of VILLAGE_SITE.ambush) kit.feature('ambush', { flag: 'B', ...a });
  kit.reserve(JEEP.x - 3.5, JEEP.z - 3.5, JEEP.x + 2.5, JEEP.z + 2.5, 5, 'flag-B-jeep');
}
