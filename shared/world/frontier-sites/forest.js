// Frontier forests (spec 4.3): Ashgrove in the south-west and its exact point
// mirror Blackwood in the north-east, Poisson-disk scattered pine, oak and
// birch; the burnt stand of dead snags behind Ridge Bunkers. No tree stands in
// a road corridor (+3 m), inside a flag radius or on a cliff, river or pad.
// The scatter is pure and deterministic so tests can count it without voxels.

import { FRONTIER_PLAN } from '../../conquest-contract.js';
import { FRONTIER_FORESTS, FRONTIER_CELL_KIND as KIND, forestWeight, frontierTerrain } from '../frontier-terrain.js';
import { mirroredKit, seededRandom } from './kit.js';
import { roadClearance } from './plan.js';
import { pine, oak, birch, deadTree } from './props.js';
import { BUNKERS_SITE } from './bunkers.js';
import { frontierWrecks } from './dressing.js';

function segmentDistance(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / len2)) : 0;
  return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t);
}
/** Bunker works inside the burnt stand: trenches, the tower and the dome. */
function clearOfBunkers(x, z) {
  for (const t of BUNKERS_SITE.trenches) for (let i = 1; i < t.points.length; i++) {
    if (segmentDistance(x + 0.5, z + 0.5, t.points[i - 1], t.points[i]) < 4) return false;
  }
  for (const l of BUNKERS_SITE.landmarks) if (Math.hypot(x + 0.5 - l.x, z + 0.5 - l.z) < 8) return false;
  for (const b of BUNKERS_SITE.buildings) if (x >= b.minX - 3 && x <= b.maxX + 3 && z >= b.minZ - 3 && z <= b.maxZ + 3) return false;
  for (const w of frontierWrecks()) if (Math.hypot(x - w.x, z - w.z) < 10) return false;
  return true;
}

/** Hard cap on trees across the whole map (spec 4.3). */
export const FRONTIER_TREE_CAP = 1800;
const MIN_SPACING = { ashgrove: 4.6, 'burnt-stand': 6 };
const MAX_PER_FOREST = 860;

/** True where a trunk may stand: forest ground, clear of roads, flags and water. */
function treeAllowed(x, z, terrain) {
  if (x < 2 || z < 2 || x >= FRONTIER_PLAN.dimensions.sx - 2 || z >= FRONTIER_PLAN.dimensions.sz - 2) return false;
  if (roadClearance(x + 0.5, z + 0.5) < 3) return false;
  if (!clearOfBunkers(x, z)) return false;
  for (const f of FRONTIER_PLAN.flags) if (Math.hypot(x + 0.5 - f.x, z + 0.5 - f.z) < f.radius + 3) return false;
  for (const hq of Object.values(FRONTIER_PLAN.hqs)) if (Math.hypot(x + 0.5 - hq.x, z + 0.5 - hq.z) < hq.radius) return false;
  const { kind, heights, water, sx } = terrain;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const j = (z + dz) * sx + x + dx;
    const k = kind[j];
    if (water[j]) return false;
    if (k === KIND.RIVER || k === KIND.FORD || k === KIND.BRIDGE || k === KIND.CLIFF || k === KIND.PAD || k === KIND.PLATEAU || k === KIND.ROAD) return false;
    if (Math.abs(heights[j] - heights[z * sx + x]) > 1) return false;
  }
  return true;
}

/** Bridson Poisson-disk sampling inside one forest outline. */
function poissonDisk(forest, spacing, rng, terrain, limit) {
  const r = Math.max(forest.rx, forest.rz) * 1.25;
  const minX = Math.floor(forest.x - r), minZ = Math.floor(forest.z - r);
  const cell = spacing / Math.SQRT2, gw = Math.ceil((2 * r) / cell) + 1;
  const grid = new Int32Array(gw * gw).fill(-1);
  const points = [], active = [];
  const gridAt = (x, z) => [Math.floor((x - minX) / cell), Math.floor((z - minZ) / cell)];
  const inside = (x, z) => forestWeight(forest, x, z) > (forest.burnt ? 0.05 : 0.08);
  const far = (x, z) => {
    const [gx, gz] = gridAt(x, z);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const ix = gx + dx, iz = gz + dz;
      if (ix < 0 || iz < 0 || ix >= gw || iz >= gw) continue;
      const k = grid[iz * gw + ix];
      if (k >= 0 && Math.hypot(points[k].x - x, points[k].z - z) < spacing) return false;
    }
    return true;
  };
  const add = (x, z) => {
    const [gx, gz] = gridAt(x, z);
    grid[gz * gw + gx] = points.length;
    points.push({ x, z });
    active.push(points.length - 1);
  };
  add(forest.x, forest.z);
  while (active.length && points.length < limit * 3) {
    const pick = Math.floor(rng() * active.length), base = points[active[pick]];
    let placed = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = rng() * Math.PI * 2, d = spacing * (1 + rng());
      const x = base.x + Math.cos(a) * d, z = base.z + Math.sin(a) * d;
      if (!inside(x, z) || !far(x, z)) continue;
      add(x, z); placed = true; break;
    }
    if (!placed) active.splice(pick, 1);
  }
  // Integer trunk cells that pass the gameplay exclusions, in a stable order.
  const out = [];
  const seen = new Set();
  for (const p of points) {
    const x = Math.floor(p.x), z = Math.floor(p.z), key = z * 4096 + x;
    if (seen.has(key) || !treeAllowed(x, z, terrain)) continue;
    seen.add(key);
    out.push({ x, z });
    if (out.length >= limit) break;
  }
  return out;
}

const SPECIES = ['pine', 'pine', 'pine', 'pine', 'pine', 'pine', 'oak', 'oak', 'birch', 'birch'];

let plan = null;
/**
 * Deterministic tree plan: Ashgrove trunks (alpha frame), the burnt stand,
 * and the derived Blackwood mirror. Each tree: {forest, species, x, z, height}.
 */
export function frontierForestPlan() {
  if (plan) return plan;
  const terrain = frontierTerrain();
  const ash = FRONTIER_FORESTS.find(f => f.id === 'ashgrove');
  const burnt = FRONTIER_FORESTS.find(f => f.id === 'burnt-stand');
  const rng = seededRandom(0xa5b9);
  const ashgrove = poissonDisk(ash, MIN_SPACING.ashgrove, rng, terrain, MAX_PER_FOREST).map(p => {
    const species = SPECIES[Math.floor(rng() * SPECIES.length)];
    const height = species === 'pine' ? 9 + Math.floor(rng() * 6) : species === 'oak' ? 6 + Math.floor(rng() * 3) : 7 + Math.floor(rng() * 4);
    return Object.freeze({ forest: 'ashgrove', species, x: p.x, z: p.z, height, seed: Math.floor(rng() * 1e9) });
  });
  const { sx, sz } = FRONTIER_PLAN.dimensions;
  const blackwood = ashgrove.map(t => Object.freeze({ ...t, forest: 'blackwood', x: sx - 1 - t.x, z: sz - 1 - t.z }));
  const brng = seededRandom(0xb0c7);
  const snags = poissonDisk(burnt, MIN_SPACING['burnt-stand'], brng, terrain, 60).map(p => Object.freeze({
    forest: 'burnt-stand', species: 'dead', x: p.x, z: p.z, height: 5 + Math.floor(brng() * 5), seed: Math.floor(brng() * 1e9),
  }));
  plan = Object.freeze({ ashgrove: Object.freeze(ashgrove), blackwood: Object.freeze(blackwood), burnt: Object.freeze(snags),
    total: ashgrove.length * 2 + snags.length });
  return plan;
}

function plant(kit, tree) {
  const rng = seededRandom(tree.seed);
  if (tree.species === 'pine') pine(kit, tree.x, tree.z, tree.height, rng);
  else if (tree.species === 'oak') oak(kit, tree.x, tree.z, tree.height, rng);
  else if (tree.species === 'birch') birch(kit, tree.x, tree.z, tree.height, rng);
  else deadTree(kit, tree.x, tree.z, tree.height, rng);
}

export function buildForests(kit) {
  const trees = frontierForestPlan();
  // Blackwood is written through the point-mirrored kit from Ashgrove's
  // alpha-frame trunks, so the two woods are exact voxel mirrors.
  for (const tree of trees.ashgrove) plant(kit, tree);
  const mirror = mirroredKit(kit);
  for (const tree of trees.ashgrove) plant(mirror, tree);
  for (const tree of trees.burnt) plant(kit, tree);
  kit.feature('forest', { id: 'ashgrove', name: 'Ashgrove', trees: trees.ashgrove.length });
  kit.feature('forest', { id: 'blackwood', name: 'Blackwood', trees: trees.blackwood.length });
  kit.feature('forest', { id: 'burnt-stand', name: 'Burnt stand', trees: trees.burnt.length });
  return trees.total;
}
