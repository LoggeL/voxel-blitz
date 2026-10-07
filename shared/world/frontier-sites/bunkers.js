// Flag D, Ridge Bunkers (496, 248): zig-zag trenches two voxels deep with
// sandbag lips and duckboards, two concrete pillboxes, tank traps on the
// western slope and the burnt stand behind. Landmarks: the observation tower
// and the radar dome on the ridge.

import {
  AIR, CONCRETE, METAL, PLANK, BARRICADE, CORRUGATED_STEEL, PALE, RUST, TIMBER, DIRT, ACCENT,
} from '../blocks.js';
import { FRONTIER_PLAN } from '../../conquest-contract.js';
import { rect, pickSpawnCells, roadClearance } from './plan.js';
import { lineCells, sandbags, crateStack } from './props.js';

const FLAG = FRONTIER_PLAN.flags.find(f => f.id === 'D');
const PILLBOX_1 = rect(480, 236, 486, 244);
const PILLBOX_2 = rect(494, 266, 500, 272);
const TOWER = { x: 512.5, z: 232.5, rise: 26 };
const RADAR = { x: 528.5, z: 226.5, rise: 9 };
const JEEP = { x: 510.5, z: 250.5, yaw: -Math.PI / 2 };
/** Threat axis for the parapet lips: toward the west and the iron bridge. */
const THREAT = [-0.8, 0.6];
export const BUNKER_TRENCHES = Object.freeze([
  Object.freeze({ id: 'D-west-trench', points: [[486, 212], [480, 218], [484, 224], [476, 230], [479, 236], [472, 242]] }),
  Object.freeze({ id: 'D-south-trench', points: [[466, 262], [471, 268], [465, 274], [468, 282]] }),
  Object.freeze({ id: 'D-north-trench', points: [[486, 212], [494, 216], [500, 214], [506, 220], [512, 214], [518, 220], [524, 214]] }),
]);

function trenchCells() {
  const cells = new Map();
  for (const t of BUNKER_TRENCHES) {
    for (let i = 1; i < t.points.length; i++) {
      for (const [x, z] of lineCells(t.points[i - 1][0], t.points[i - 1][1], t.points[i][0], t.points[i][1])) {
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const k = `${x + dx},${z + dz}`;
          if (roadClearance(x + dx + 0.5, z + dz + 0.5) < 1) continue;
          if (!cells.has(k)) cells.set(k, { x: x + dx, z: z + dz, trench: t.id });
        }
      }
    }
  }
  return cells;
}
const TRENCH = trenchCells();
const nearTrench = (x, z) => {
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (TRENCH.has(`${Math.floor(x) + dx},${Math.floor(z) + dz}`)) return true;
  return false;
};

export const BUNKERS_SITE = Object.freeze({
  flag: 'D', site: 'bunkers', x: FLAG.x, z: FLAG.z,
  buildings: Object.freeze([PILLBOX_1, PILLBOX_2]),
  hard: PILLBOX_1,
  trenches: BUNKER_TRENCHES,
  landmarks: Object.freeze([
    Object.freeze({ id: 'ridge-observation-tower', kind: 'tower', x: TOWER.x, z: TOWER.z, rise: TOWER.rise, primary: true }),
    Object.freeze({ id: 'ridge-radar-dome', kind: 'radar', x: RADAR.x, z: RADAR.z, rise: RADAR.rise }),
  ]),
  vehicle: Object.freeze({ id: 'flag-D-jeep', type: 'jeep', team: 'bravo', ...JEEP }),
  lanes: Object.freeze([
    Object.freeze({ id: 'D-west-trench', from: [486, 212], to: [472, 242] }),
    Object.freeze({ id: 'D-south-trench', from: [466, 262], to: [468, 282] }),
  ]),
  ambush: Object.freeze([
    Object.freeze({ x: 478.5, z: 241.5, faces: 'a-d-ford' }),
    Object.freeze({ x: 470.5, z: 270.5, faces: 'd-c' }),
    Object.freeze({ x: 501.5, z: 273.5, faces: 'hq-east-d' }),
  ]),
  spawns: pickSpawnCells(FLAG.x, FLAG.z, {
    exclude: [PILLBOX_1, PILLBOX_2, rect(507, 246, 514, 255), rect(509, 229, 516, 236)],
    radii: [8, 12, 16],
    accept: (x, z) => !nearTrench(x, z),
  }),
});

function trenches(kit) {
  for (const cell of TRENCH.values()) {
    const g = kit.top(cell.x, cell.z);
    kit.box(cell.x, g - 1, cell.z, cell.x, g + 3, cell.z, AIR);
    kit.set(cell.x, g - 2, cell.z, PLANK);
  }
  // Sandbag lips on the threat side, revetment boards on the rear wall.
  for (const cell of TRENCH.values()) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cell.x + dx, nz = cell.z + dz;
      if (TRENCH.has(`${nx},${nz}`) || roadClearance(nx + 0.5, nz + 0.5) < 1) continue;
      const g = kit.top(nx, nz);
      if (dx * THREAT[0] + dz * THREAT[1] > 0) kit.set(nx, g + 1, nz, BARRICADE);
      else kit.box(nx, g - 1, nz, nx, g, nz, TIMBER);
    }
  }
  // Ramp steps at each trench end.
  for (const t of BUNKER_TRENCHES) for (const [x, z] of [t.points[0], t.points.at(-1)]) {
    if (!TRENCH.has(`${x},${z}`)) continue;
    kit.set(x, kit.top(x, z) - 1, z, DIRT);
  }
  for (const t of BUNKER_TRENCHES) kit.feature('trench', { id: t.id, flag: 'D', points: t.points, depth: 2 });
}

function pillbox(kit, r, door, slits) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = r;
  const y = kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0 - 1, z0 - 1, x1 + 1, z1 + 1, y, CONCRETE, CONCRETE);
  kit.walls(x0, z0, x1, z1, y + 1, y + 3, CONCRETE);
  kit.box(x0 - 1, y + 4, z0 - 1, x1 + 1, y + 4, z1 + 1, CONCRETE);
  kit.box(x0, y + 5, z0, x1, y + 5, z1, DIRT);                       // earth cover
  for (const side of slits) {
    if (side === 'w') kit.box(x0, y + 2, z0 + 2, x0, y + 2, z1 - 2, AIR);
    if (side === 'e') kit.box(x1, y + 2, z0 + 2, x1, y + 2, z1 - 2, AIR);
    if (side === 'n') kit.box(x0 + 2, y + 2, z0, x1 - 2, y + 2, z0, AIR);
    if (side === 's') kit.box(x0 + 2, y + 2, z1, x1 - 2, y + 2, z1, AIR);
  }
  const mx = (x0 + x1) >> 1, mz = (z0 + z1) >> 1;
  if (door === 'e') kit.box(x1, y + 1, mz - 1, x1, y + 3, mz, AIR);
  if (door === 'n') kit.box(mx - 1, y + 1, z0, mx, y + 3, z0, AIR);
  kit.box(x0 + 1, y + 1, z0 + 1, x0 + 2, y + 1, z0 + 1, PLANK);       // ammo bench
  kit.box(x1 - 1, y + 1, z1 - 2, x1 - 1, y + 2, z1 - 1, METAL);       // gun mount
  kit.feature('building', { minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: y + 4, enterable: true, hard: true, pillbox: true });
}

/** Ladder volume inside the observation tower (east face, through the hatch). */
export function observationTowerLadder(groundY) {
  const fx = Math.floor(TOWER.x), fz = Math.floor(TOWER.z);
  return { minX: fx + 1, maxX: fx + 2, minY: groundY + 1, maxY: groundY + 21.2, minZ: fz, maxZ: fz + 1, face: 'x-' };
}
export const OBSERVATION_TOWER = Object.freeze({ x: TOWER.x, z: TOWER.z });

function observationTower(kit) {
  const { x, z } = TOWER, g = kit.top(x, z);
  const fx = Math.floor(x), fz = Math.floor(z);
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) kit.box(fx + dx, g + 1, fz + dz, fx + dx, g + 19, fz + dz, METAL);
  for (let y = g + 4; y < g + 19; y += 5) {
    kit.walls(fx - 2, fz - 2, fx + 2, fz + 2, y, y, RUST);
    kit.line(fx - 2, y, fz - 2, fx + 2, y + 4, fz - 2, RUST);
    kit.line(fx + 2, y, fz + 2, fx - 2, y + 4, fz + 2, RUST);
  }
  // Interior ladder on the east face up through a hatch.
  kit.box(fx + 1, g + 1, fz, fx + 1, g + 20, fz, METAL);
  kit.box(fx - 3, g + 20, fz - 3, fx + 3, g + 20, fz + 3, PLANK);
  kit.set(fx + 1, g + 20, fz, AIR);
  kit.walls(fx - 3, fz - 3, fx + 3, fz + 3, g + 21, g + 21, CORRUGATED_STEEL);
  for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) kit.box(fx + dx, g + 22, fz + dz, fx + dx, g + 23, fz + dz, TIMBER);
  kit.box(fx - 3, g + 24, fz - 3, fx + 3, g + 24, fz + 3, CORRUGATED_STEEL);
  kit.box(fx, g + 25, fz, fx, g + TOWER.rise, fz, METAL);
  kit.set(fx, g + TOWER.rise, fz, ACCENT);
  kit.feature('landmark', { id: 'ridge-observation-tower', x, y: g + TOWER.rise, z });
  kit.feature('ladder', observationTowerLadder(g));
}

function radarDome(kit) {
  const { x, z } = RADAR, g = kit.top(x, z);
  kit.cylinder(x, z, 4.5, g + 1, g + 3, CONCRETE);
  kit.box(Math.floor(x) - 1, g + 1, Math.floor(z) + 4, Math.floor(x), g + 2, Math.floor(z) + 4, AIR);
  for (let y = g + 4; y <= g + 8; y++) {
    const r = Math.sqrt(Math.max(0, 4.6 ** 2 - (y - (g + 3.5)) ** 2));
    kit.cylinder(x, z, r, y, y, PALE);
  }
  kit.set(Math.floor(x), g + RADAR.rise, Math.floor(z), METAL);
  kit.feature('landmark', { id: 'ridge-radar-dome', x, y: g + RADAR.rise, z });
}

function tankTraps(kit) {
  for (let z = 222; z <= 244; z += 5) for (let x = 450; x <= 464; x += 5) {
    const ox = x + ((z / 5) % 2) * 2;
    if (roadClearance(ox + 0.5, z + 0.5) < 2) continue;
    const g = kit.top(ox, z);
    kit.set(ox, g + 1, z, METAL); kit.set(ox - 1, g + 1, z, METAL); kit.set(ox + 1, g + 1, z, METAL);
    kit.set(ox, g + 1, z - 1, METAL); kit.set(ox, g + 1, z + 1, METAL); kit.set(ox, g + 2, z, METAL);
    kit.feature('cover', { cover: 'tank trap', x: ox, z, height: 2 });
  }
}

export function buildBunkers(kit) {
  trenches(kit);
  pillbox(kit, PILLBOX_1, 'e', ['w', 'n', 's']);
  kit.feature('hard-building', { flag: 'D', id: 'ridge-pillbox-west', ...PILLBOX_1 });
  pillbox(kit, PILLBOX_2, 'n', ['w', 's', 'e']);
  observationTower(kit);
  radarDome(kit);
  tankTraps(kit);
  // Sandbagged MG nests on the north lip and the eastern rear.
  sandbags(kit, [[502, 202], [508, 200], [512, 204]]);
  sandbags(kit, [[524, 252], [526, 258], [522, 262]]);
  sandbags(kit, [[488, 256], [484, 260]]);
  crateStack(kit, 504, 238, 2, 2, 2);
  crateStack(kit, 490, 232, 2, 1, 1);
  for (const lane of BUNKERS_SITE.lanes) kit.feature('lane', { flag: 'D', ...lane });
  for (const a of BUNKERS_SITE.ambush) kit.feature('ambush', { flag: 'D', ...a });
  kit.reserve(JEEP.x - 3.5, JEEP.z - 3.5, JEEP.x + 2.5, JEEP.z + 2.5, 5, 'flag-D-jeep');
}
