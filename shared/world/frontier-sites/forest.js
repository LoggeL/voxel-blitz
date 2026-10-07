// Frontier woodland (spec 4.3, reworked to match the 2026-10-07 world
// references): dark pinewoods on the slopes and the valley rim, Ashgrove and
// its mirror Blackwood, copses between the roads, mixed tree lines along both
// river banks, bushes along every wood edge and scattered over the meadows,
// and the burnt stand of dead snags behind Ridge Bunkers.
//
// Trunks follow frontierWoodDensity() (shared/world/frontier-terrain.js) on
// a jittered grid. Every tree and bush is authored on the west half and
// point-mirrored onto the east half; a placement stands only where both
// halves allow it, so the valley stays fair. Nothing grows on a road corridor
// (+3 m), a flag pad, a field, the river, a crossing approach, a site
// footprint, an infantry lane or an HQ sight line to a site landmark, and
// trees are planted after the sites into air only, so they never cut a wall.
// The plan is pure and deterministic so tests can count it without voxels.

import { FRONTIER_PLAN } from '../../conquest-contract.js';
import {
  FRONTIER_FORESTS, FRONTIER_FIELDS, FRONTIER_WOODS, FRONTIER_CELL_KIND as KIND, forestWeight, frontierTerrain,
  frontierWoodDensity, frontierTopY,
} from '../frontier-terrain.js';
import { LEAVES } from '../blocks.js';
import { mirroredKit, seededRandom } from './kit.js';
import { roadClearance } from './plan.js';
import { pine, oak, birch, poplar, deadTree } from './props.js';
import { BUNKERS_SITE } from './bunkers.js';
import { FARM_SITE } from './farm.js';
import { VILLAGE_SITE, VILLAGE_LOTS } from './village.js';
import { BRIDGE_SITE } from './bridge.js';
import { WORKS_SITE, WORKS_KEEP_OUT } from './works.js';
import { HQ_LAYOUT } from './hq-airfield.js';
import { frontierWrecks, frontierHulks, DRESSING_HEDGES, DRESSING_WALLS, DRESSING_RUINS } from './dressing.js';
import { LOCATION_KEEP_OUT } from './locations.js';

const { sx: SX, sz: SZ } = FRONTIER_PLAN.dimensions;
const SITES = [FARM_SITE, VILLAGE_SITE, BRIDGE_SITE, BUNKERS_SITE, WORKS_SITE];

function segmentDistance(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / len2)) : 0;
  return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t);
}
const polylineDistance = (x, z, points) => {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(x, z, points[i - 1], points[i]));
  return best;
};
const mirrorLine = points => points.map(([x, z]) => [SX - x, SZ - z]);

/** Hard cap on trees across the whole map. */
export const FRONTIER_TREE_CAP = 4200;
/**
 * Trees keep this far from every flag: the bot commander stages squads and
 * sets transports down 42-76 m out, which must be open ground, not canopy.
 */
export const FLAG_CLEAR = 82;
/** Jittered-grid pitch of the woodland (m): one candidate trunk per cell. */
const PITCH = 5.7;
const MIN_GAP = 3.4;

let keepOut = null;
/** Static footprints no tree may touch (both halves; rectangles carry a margin). */
function keepOuts() {
  if (keepOut) return keepOut;
  const rects = [], circles = [], lines = [];
  const pad = (r, m) => ({ minX: r.minX - m, minZ: r.minZ - m, maxX: r.maxX + 1 + m, maxZ: r.maxZ + 1 + m });
  for (const site of SITES) {
    for (const b of site.buildings) rects.push(pad(b, 4));
    for (const l of site.landmarks) circles.push({ x: l.x, z: l.z, r: 9 });
    for (const lane of site.lanes) lines.push({ points: [lane.from, lane.to], r: 2 });
    for (const a of site.ambush) circles.push({ x: a.x, z: a.z, r: 5 });
    for (const [x, z] of site.spawns) circles.push({ x, z, r: 3 });
  }
  for (const t of BUNKERS_SITE.trenches) lines.push({ points: t.points, r: 4 });
  for (const r of [...VILLAGE_LOTS, ...WORKS_KEEP_OUT, ...DRESSING_RUINS]) rects.push(pad(r, 3));
  // The places between the flags (halt, depot, quarry, relay) and their drives.
  for (const r of LOCATION_KEEP_OUT) rects.push(pad(r, 2));
  for (const w of [...frontierWrecks(), ...frontierHulks()]) circles.push({ x: w.x, z: w.z, r: 9 });
  for (const points of [...DRESSING_HEDGES, ...DRESSING_WALLS]) { lines.push({ points, r: 2 }); lines.push({ points: mirrorLine(points), r: 2 }); }
  for (const c of FRONTIER_PLAN.crossings) circles.push({ x: c.x, z: c.z, r: 18 });
  // The shelled bridgehead at C stays open ground, and so does the meadow
  // running down to the north reach between the ford and the bridge.
  circles.push({ x: 384, z: 384, r: 58 }, { x: 368, z: 302, r: 22 });
  // The farm yard between its barns, the silo and the windmill.
  rects.push({ minX: 184, minZ: 192, maxX: 276, maxZ: 284 });
  for (const l of lines) {
    l.minX = Math.min(...l.points.map(p => p[0])) - l.r; l.maxX = Math.max(...l.points.map(p => p[0])) + l.r;
    l.minZ = Math.min(...l.points.map(p => p[1])) - l.r; l.maxZ = Math.max(...l.points.map(p => p[1])) + l.r;
  }
  keepOut = { rects, circles, lines };
  return keepOut;
}

const inField = (x, z, m) => FRONTIER_FIELDS.some(f => x >= f.x0 - m && x < f.x1 + m && z >= f.z0 - m && z < f.z1 + m);

/** True where a plant may stand at cell (x, z) (one half; callers test both). */
export function groundAllowed(x, z, terrain, { road = 3, slope = 1, tall = true } = {}) {
  if (x < 26 || z < 26 || x >= SX - 26 || z >= SZ - 26) return false;
  // The runway approach corridors stay open for aircraft.
  if (Math.abs(x + 0.5 - HQ_LAYOUT.runway.x) < 36 || Math.abs(x + 0.5 - (SX - HQ_LAYOUT.runway.x)) < 36) return false;
  const { kind, heights, water, sx } = terrain;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const j = (z + dz) * sx + x + dx;
    const k = kind[j];
    if (water[j]) return false;
    if (k === KIND.RIVER || k === KIND.FORD || k === KIND.BRIDGE || k === KIND.CLIFF || k === KIND.PAD || k === KIND.PLATEAU || k === KIND.ROAD) return false;
    if (Math.abs(heights[j] - heights[z * sx + x]) > slope) return false;
  }
  if (inField(x, z, 1)) return false;
  const px = x + 0.5, pz = z + 0.5;
  for (const f of FRONTIER_PLAN.flags) if (Math.hypot(px - f.x, pz - f.z) < (tall ? FLAG_CLEAR : f.radius + 3)) return false;
  for (const hq of Object.values(FRONTIER_PLAN.hqs)) if (Math.hypot(px - hq.x, pz - hq.z) < hq.radius) return false;
  const { rects, circles, lines } = keepOuts();
  for (const r of rects) if (px >= r.minX && px <= r.maxX && pz >= r.minZ && pz <= r.maxZ) return false;
  for (const c of circles) if (Math.abs(px - c.x) < c.r && Math.abs(pz - c.z) < c.r && Math.hypot(px - c.x, pz - c.z) < c.r) return false;
  for (const l of lines) if (px >= l.minX && px <= l.maxX && pz >= l.minZ && pz <= l.maxZ && polylineDistance(px, pz, l.points) < l.r) return false;
  return roadClearance(px, pz) >= road;
}

let sights = null;
/** Eye-to-landmark segments from both HQs (the frontier-terrain-test sight lines). */
function sightLines() {
  if (sights) return sights;
  const eyes = Object.values(FRONTIER_PLAN.hqs).map(hq => ({ x: hq.x, y: frontierTopY(hq.x, hq.z) + 1.02 + 1.62, z: hq.z }));
  const tops = [];
  for (const site of SITES) for (const l of site.landmarks) tops.push({ x: l.x, z: l.z, y: Number.isFinite(l.y) ? l.y : frontierTopY(l.x, l.z) + l.rise });
  sights = eyes.flatMap(a => tops.map(b => ({ a, b })));
  return sights;
}
/** A crown of radius 4 topping out at `top` stays below every HQ sight line. */
function clearOfSights(x, z, top) {
  for (const { a, b } of sightLines()) {
    const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x + 0.5 - a.x) * dx + (z + 0.5 - a.z) * dz) / len2));
    if (Math.hypot(x + 0.5 - a.x - dx * t, z + 0.5 - a.z - dz * t) > 5) continue;
    if (a.y + (b.y - a.y) * t < top + 2) return false;
  }
  return true;
}

const mirror = (x, z) => [SX - 1 - x, SZ - 1 - z];
const PINE_MIX = ['pine', 'pine', 'pine', 'pine', 'pine', 'pine', 'pine', 'pine', 'birch', 'oak'];
const BANK_MIX = ['pine', 'pine', 'pine', 'pine', 'birch', 'birch', 'birch', 'oak', 'oak', 'oak'];
const inWoods = (x, z) => FRONTIER_WOODS.some(w => forestWeight(w, x, z) > -0.05);

function treeHeight(species, rng, core) {
  if (species === 'pine') return 9 + Math.floor(rng() * 5) + (core ? 1 + Math.floor(rng() * 2) : 0);
  if (species === 'oak') return 6 + Math.floor(rng() * 3);
  return 7 + Math.floor(rng() * 4);
}

let plan = null;
/**
 * Deterministic plant plan. `west` holds the authored trees (alpha frame),
 * `east` their point mirrors in the same order, `burnt` the dead snags and
 * `bushes` the west-half bush clumps (each also mirrored when planted).
 * Each tree: {forest, species, x, z, height, seed}.
 */
export function frontierForestPlan() {
  if (plan) return plan;
  const terrain = frontierTerrain();
  const rng = seededRandom(0xa5b9);
  const both = (x, z, opts) => groundAllowed(x, z, terrain, opts) && groundAllowed(...mirror(x, z), terrain, opts);
  const west = [];
  const taken = new Map();
  const near = (x, z, gap) => {
    const gx = Math.floor(x / PITCH), gz = Math.floor(z / PITCH);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const p = taken.get((gz + dz) * 1024 + gx + dx);
      if (p && Math.hypot(p[0] - x, p[1] - z) < gap) return true;
    }
    return false;
  };
  for (let gz = Math.floor(26 / PITCH); gz * PITCH < SZ - 26 && west.length * 2 < FRONTIER_TREE_CAP - 80; gz++) {
    for (let gx = Math.floor(26 / PITCH); (gx + 1) * PITCH <= SX / 2; gx++) {
      const jx = rng(), jz = rng(), roll = rng(), pick = rng(), grow = rng(), seed = Math.floor(rng() * 1e9);
      const x = Math.floor((gx + 0.1 + jx * 0.8) * PITCH), z = Math.floor((gz + 0.1 + jz * 0.8) * PITCH);
      const d = frontierWoodDensity(x + 0.5, z + 0.5);
      if (roll >= smoothstep(0.12, 0.55, d) || near(x, z, MIN_GAP)) continue;
      if (!both(x, z)) continue;
      const woods = inWoods(x + 0.5, z + 0.5);
      const mix = woods ? PINE_MIX : BANK_MIX;
      const species = mix[Math.floor(pick * mix.length)];
      const height = treeHeight(species, () => grow, d > 0.7);
      const [mx, mz] = mirror(x, z);
      if (!clearOfSights(x, z, frontierTopY(x + 0.5, z + 0.5) + height + 1) || !clearOfSights(mx, mz, frontierTopY(mx + 0.5, mz + 0.5) + height + 1)) continue;
      taken.set(gz * 1024 + gx, [x, z]);
      west.push(Object.freeze({ forest: woods ? 'wood' : 'riverbank', species, x, z, height, seed }));
    }
  }
  const east = west.map(t => Object.freeze({ ...t, x: SX - 1 - t.x, z: SZ - 1 - t.z }));

  // Bushes: thick along the wood edges, scattered over the open meadows.
  const brng = seededRandom(0xb05e);
  const bushes = [];
  for (let gz = Math.floor(26 / 7); gz * 7 < SZ - 26; gz++) {
    for (let gx = Math.floor(26 / 7); (gx + 1) * 7 <= SX / 2; gx++) {
      const x = Math.floor((gx + 0.15 + brng() * 0.7) * 7), z = Math.floor((gz + 0.15 + brng() * 0.7) * 7);
      const roll = brng(), size = brng(), tall = brng();
      const d = frontierWoodDensity(x + 0.5, z + 0.5);
      const chance = d > 0.05 && d < 0.5 ? 0.3 : 0;
      if (roll >= chance || near(x, z, 2.5) || !both(x, z, { road: 2.5, slope: 1, tall: false })) continue;
      const cells = [[0, 0, tall < 0.45 ? 2 : 1]];
      const extra = 1 + Math.floor(size * 4);
      for (let k = 0; k < extra; k++) {
        const [dx, dz] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1]][(k + Math.floor(size * 7)) % 5];
        cells.push([dx, dz, 1]);
      }
      bushes.push(Object.freeze({ x, z, cells: Object.freeze(cells.map(c => Object.freeze(c))) }));
    }
  }

  const burnt = FRONTIER_FORESTS.find(f => f.id === 'burnt-stand');
  const srng = seededRandom(0xb0c7);
  const snags = [];
  for (let gz = Math.floor((burnt.z - 40) / 6); gz * 6 < burnt.z + 40; gz++) for (let gx = Math.floor((burnt.x - 44) / 6); gx * 6 < burnt.x + 44; gx++) {
    const x = Math.floor((gx + 0.1 + srng() * 0.8) * 6), z = Math.floor((gz + 0.1 + srng() * 0.8) * 6), roll = srng(), h = srng(), seed = Math.floor(srng() * 1e9);
    if (forestWeight(burnt, x, z) <= 0.05 || roll > 0.85 || !groundAllowed(x, z, terrain, { tall: false })) continue;
    snags.push(Object.freeze({ forest: 'burnt-stand', species: 'dead', x, z, height: 5 + Math.floor(h * 5), seed }));
  }
  plan = Object.freeze({ west: Object.freeze(west), east: Object.freeze(east), burnt: Object.freeze(snags), bushes: Object.freeze(bushes),
    total: west.length * 2 + snags.length });
  return plan;
}

function smoothstep(a, b, v) { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); }

function plant(kit, tree) {
  const rng = seededRandom(tree.seed);
  if (tree.species === 'pine') pine(kit, tree.x, tree.z, tree.height, rng);
  else if (tree.species === 'oak') oak(kit, tree.x, tree.z, tree.height, rng);
  else if (tree.species === 'birch') birch(kit, tree.x, tree.z, tree.height, rng);
  else if (tree.species === 'poplar') poplar(kit, tree.x, tree.z, tree.height);
  else deadTree(kit, tree.x, tree.z, tree.height, rng);
}

function bush(kit, b) {
  for (const [dx, dz, h] of b.cells) {
    const x = b.x + dx, z = b.z + dz, g = kit.top(x, z);
    if (kit.surface(x, z) !== g) continue;            // never on a wall, a roof or another plant
    kit.fillAir(x, g + 1, z, x, g + h, z, LEAVES);
  }
}

/** Plants the woodland after the sites: trunks and crowns fill air only. */
export function buildForests(kit) {
  const trees = frontierForestPlan();
  // The east half is written through the point-mirrored kit from the west
  // trunks, so the two halves are exact voxel mirrors.
  const mirrorKit = mirroredKit(kit);
  for (const tree of trees.west) { plant(kit, tree); plant(mirrorKit, tree); }
  for (const tree of trees.burnt) plant(kit, tree);
  for (const b of trees.bushes) { bush(kit, b); bush(mirrorKit, b); }
  const count = id => trees.west.filter(t => t.forest === id).length * 2;
  kit.feature('forest', { id: 'woods', name: 'Pinewoods and copses', trees: count('wood') });
  kit.feature('forest', { id: 'riverbank', name: 'Riverbank tree lines', trees: count('riverbank') });
  kit.feature('forest', { id: 'burnt-stand', name: 'Burnt stand', trees: trees.burnt.length });
  kit.feature('bushes', { count: trees.bushes.length * 2 });
  return trees.total;
}
