// Battlefield dressing between the sites (spec 4.3, strengthened to match the
// 2026-10-07 world references): eight burning wrecks on the approaches to C,
// D and B and at the river crossings (published as smoke anchors), cold
// burnt-out hulks in the open middle, czech hedgehogs and sandbag lines on
// the river banks beside every crossing, ruined cottages with rubble,
// hedgerows and dry-stone walls across the fields, and the pre-carved shell
// craters recorded for tests and metadata. Hulks, ruins, hedges, walls and
// bank defences are authored for the west half and point-mirrored.

import { FRONTIER_PLAN } from '../../conquest-contract.js';
import { FRONTIER_CRATERS, frontierTopY, riverCentreX, riverHalfAt } from '../frontier-terrain.js';
import { BRICK, COBBLE_WALL, RUST, SCORCHED_EARTH, TIMBER, MC_WATER, DRY_GRASS } from '../blocks.js';
import { mirroredKit, seededRandom } from './kit.js';
import { hedge, fieldWall, sandbags, wreckTank, wreckTruck, wreckHelicopter } from './props.js';
import { roadClearance } from './plan.js';

const { sx: SX, sz: SZ } = FRONTIER_PLAN.dimensions;
const RIVER_SURFACE = FRONTIER_PLAN.river.surfaceY;

/**
 * Burning wreck props. `y` is the smoke anchor on top of the hulk (terrain
 * derived). `near` is the flag (within 75 m) or the crossing (within 40 m).
 */
const WRECKS = [
  { id: 'wreck-tank-c-west', type: 'tank', x: 346, z: 348, alongX: true, near: 'C', rise: 4 },
  { id: 'wreck-truck-c-east', type: 'truck', x: 424, z: 420, alongX: false, near: 'C', rise: 4 },
  { id: 'wreck-tank-d-slope', type: 'tank', x: 460, z: 282, alongX: true, near: 'D', rise: 4 },
  { id: 'wreck-helicopter-d', type: 'helicopter', x: 528, z: 206, alongX: true, near: 'D', rise: 5 },
  { id: 'wreck-truck-b', type: 'truck', x: 246, z: 470, alongX: false, near: 'B', rise: 4 },
  { id: 'wreck-tank-ford-north', type: 'tank', x: 371, z: 255, alongX: false, near: 'ford-north', rise: 4 },
  { id: 'wreck-truck-ford-south', type: 'truck', x: 398, z: 513, alongX: true, near: 'ford-south', rise: 4 },
  { id: 'wreck-tank-bridge-south', type: 'tank', x: 354, z: 604, alongX: true, near: 'bridge-south', rise: 4 },
];

let wrecks = null;
export function frontierWrecks() {
  wrecks ??= Object.freeze(WRECKS.map(w => Object.freeze({ ...w, y: frontierTopY(w.x, w.z) + w.rise, smokeX: w.x + 0.5, smokeZ: w.z + 0.5 })));
  return wrecks;
}

/** Cold burnt-out hulks (no smoke), authored west and mirrored east. */
const HULKS_WEST = [
  { type: 'tank', x: 330, z: 300, alongX: false },
  { type: 'truck', x: 322, z: 470, alongX: true },
  { type: 'tank', x: 298, z: 448, alongX: true },
  { type: 'truck', x: 344, z: 214, alongX: false },
];
let hulks = null;
/** Every hulk on both halves (x, z of the hull centre). */
export function frontierHulks() {
  hulks ??= Object.freeze(HULKS_WEST.flatMap(h => [h, { ...h, x: SX - 1 - h.x, z: SZ - 1 - h.z }]).map(h => Object.freeze(h)));
  return hulks;
}

/** Ruined cottages (west half; mirrored): broken shells with rubble spill. */
export const DRESSING_RUINS = Object.freeze([
  { minX: 296, minZ: 362, maxX: 304, maxZ: 369 },
  { minX: 350, minZ: 474, maxX: 357, maxZ: 481 },
  { minX: 318, minZ: 162, maxX: 327, maxZ: 169 },
  { minX: 156, minZ: 418, maxX: 163, maxZ: 425 },
].map(r => Object.freeze(r)));

/** West-bank hedgerows and walls; each is mirrored onto the east bank. */
export const DRESSING_HEDGES = Object.freeze([
  [[288, 246], [318, 262], [348, 300]],
  [[300, 418], [330, 440], [346, 468]],
  [[206, 330], [248, 348], [292, 358]],
  [[160, 300], [188, 318], [214, 322]],
  [[300, 596], [326, 610], [352, 612]],
  [[228, 140], [262, 156], [300, 158]],
].map(points => Object.freeze(points.map(p => Object.freeze(p)))));
export const DRESSING_WALLS = Object.freeze([
  [[200, 402], [238, 420], [262, 424]],
  [[328, 516], [338, 540], [340, 562]],
  [[312, 352], [332, 346]],
  [[260, 432], [286, 440]],
].map(points => Object.freeze(points.map(p => Object.freeze(p)))));

/** Czech hedgehog: two steel beams crossed in an X on a pair of splayed feet. */
export function hedgehog(kit, x, z, acrossX = true) {
  const g = kit.top(x, z);
  const [ux, uz] = acrossX ? [1, 0] : [0, 1];
  for (const k of [-1, 1]) {
    kit.set(x + ux * k, g + 1, z + uz * k, RUST);
    kit.set(x - ux * k, g + 3, z - uz * k, RUST);
    kit.set(x + uz * k, g + 1, z + ux * k, RUST);
  }
  kit.set(x, g + 2, z, RUST);
  kit.feature('cover', { cover: 'hedgehog', x, z, height: 3 });
}

/** A roofless cottage shell: broken walls of falling height, a gap door, rubble spill. */
function ruin(kit, r, rng) {
  const y = kit.maxTop(r.minX, r.minZ, r.maxX, r.maxZ);
  // The wall ring in order around the perimeter, so the broken tops run on.
  const ring = [];
  for (let x = r.minX; x < r.maxX; x++) ring.push([x, r.minZ]);
  for (let z = r.minZ; z < r.maxZ; z++) ring.push([r.maxX, z]);
  for (let x = r.maxX; x > r.minX; x--) ring.push([x, r.maxZ]);
  for (let z = r.maxZ; z > r.minZ; z--) ring.push([r.minX, z]);
  const phase = rng() * 6;
  ring.forEach(([x, z], k) => {
    const g = kit.top(x, z);
    // Jagged but continuous wall tops, a doorway and one shell breach.
    const top = y + Math.max(1, Math.round(2.5 + 2.5 * Math.sin(k * 0.3 + phase) + (rng() < 0.3 ? 1 : 0)));
    if (k % 17 === 3 || k % 17 === 4) return;
    for (let yy = g + 1; yy <= top; yy++) kit.set(x, yy, z, yy <= y + 1 ? COBBLE_WALL : BRICK);
  });
  for (let n = 0; n < 7; n++) {
    const x = Math.floor(r.minX - 2 + rng() * (r.maxX - r.minX + 5)), z = Math.floor(r.minZ - 2 + rng() * (r.maxZ - r.minZ + 5));
    if (roadClearance(x + 0.5, z + 0.5) < 2) continue;
    kit.fillAir(x, kit.top(x, z) + 1, z, x, kit.top(x, z) + 1, z, n % 2 ? COBBLE_WALL : BRICK);
  }
  const cx = (r.minX + r.maxX) >> 1, cz = (r.minZ + r.maxZ) >> 1;
  kit.box(cx - 1, y + 1, cz, cx + 2, y + 1, cz, TIMBER);       // a fallen roof beam
  kit.paint(cx, cz + 1, SCORCHED_EARTH);
  kit.feature('cover', { cover: 'ruin', x: cx, z: cz, height: 3 });
}

/**
 * Bank defences beside the crossings north of the centre (the south ones are
 * their mirrors): hedgehog rows on the beaches and sandbag lines on the bank
 * top, both sides of the water, never on a road.
 */
function bankDefences(kit, rng) {
  for (const c of FRONTIER_PLAN.crossings.filter(c => c.z < SZ / 2)) {
    for (const along of [-1, 1]) for (const side of [-1, 1]) {
      for (const d of [15, 23]) {
        const z = c.z + along * d, x = Math.floor(riverCentreX(z) + side * (riverHalfAt(z) + 3)), zz = Math.floor(z);
        if (rng() < 0.35 || roadClearance(x + 0.5, zz + 0.5) < 3 || kit.get(x, kit.top(x, zz) + 1, zz) === MC_WATER) continue;
        hedgehog(kit, x, zz, rng() < 0.5);
      }
      const z = c.z + along * 22, x = riverCentreX(z) + side * (riverHalfAt(z) + 9);
      const line = [[x, z - 4], [x + side, z], [x, z + 4]].map(([px, pz]) => [Math.floor(px), Math.floor(pz)]);
      if (line.every(([px, pz]) => roadClearance(px + 0.5, pz + 0.5) >= 3)) sandbags(kit, line, { height: 1 });
    }
  }
}

/**
 * Reed beds: tufts of dry grass along the gravel beaches at the water's edge
 * and round the island rims, authored north of the centre and mirrored.
 */
function reeds(kit, rng) {
  const { water } = kit.terrain;
  for (let z = 28; z < SZ / 2 - 2; z++) {
    const cx = riverCentreX(z + 0.5), half = riverHalfAt(z + 0.5);
    for (let x = Math.floor(cx - half - 4); x <= Math.ceil(cx + half + 4); x++) {
      const bx = kit.mirrored ? SX - 1 - x : x, bz = kit.mirrored ? SZ - 1 - z : z;
      if (water[bz * SX + bx] || kit.top(x, z) < RIVER_SURFACE || kit.top(x, z) > RIVER_SURFACE + 1) continue;
      if (kit.get(x, kit.top(x, z) + 1, z) !== 0) continue;
      const wet = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => kit.get(x + dx, RIVER_SURFACE, z + dz) === MC_WATER);
      if (!wet || roadClearance(x + 0.5, z + 0.5) < 4 || rng() > 0.25) continue;
      const g = kit.top(x, z);
      kit.box(x, g + 1, z, x, g + (rng() < 0.4 ? 2 : 1), z, DRY_GRASS);
    }
  }
}

export function buildDressing(kit) {
  for (const w of frontierWrecks()) {
    if (w.type === 'tank') wreckTank(kit, w.x, w.z, w.alongX);
    else if (w.type === 'truck') wreckTruck(kit, w.x, w.z, w.alongX);
    else wreckHelicopter(kit, w.x, w.z);
  }
  for (const side of [kit, mirroredKit(kit)]) {
    for (const points of DRESSING_HEDGES) hedge(side, points, { gapEvery: 19 });
    for (const points of DRESSING_WALLS) fieldWall(side, points, { gapEvery: 17 });
    for (const h of HULKS_WEST) {
      if (h.type === 'tank') wreckTank(side, h.x, h.z, h.alongX, { cold: true });
      else wreckTruck(side, h.x, h.z, h.alongX, { cold: true });
    }
    const rng = seededRandom(0xd0c5);
    for (const r of DRESSING_RUINS) ruin(side, r, rng);
    bankDefences(side, seededRandom(0xb4a7));
    reeds(side, seededRandom(0x5eed));
  }
  for (const c of FRONTIER_CRATERS) kit.feature('crater', { x: c.x, z: c.z, r: c.r });
}

