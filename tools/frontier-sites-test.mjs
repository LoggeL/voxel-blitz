// Frontier v2 sites (spec 4.3): every flag offers a hard building, two covered
// infantry lanes, a vehicle route, AT ambush points and twelve dry, walkable
// spawn cells; each site carries its landmark; forests respect the tree cap
// and exclusions and are point-mirrored; the battlefield dressing is present.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { FRONTIER_PLAN } from '../shared/conquest-contract.js';
import { generateFrontierV2Into } from '../shared/world/frontier-sites/generate.js';
import { FRONTIER_SITES } from '../shared/world/frontier-layout.js';
import { frontierForestPlan, FRONTIER_TREE_CAP } from '../shared/world/frontier-sites/forest.js';
import { frontierWrecks, DRESSING_HEDGES, DRESSING_WALLS } from '../shared/world/frontier-sites/dressing.js';
import { BUNKER_TRENCHES } from '../shared/world/frontier-sites/bunkers.js';
import { FRONTIER_LOCATIONS } from '../shared/world/frontier-sites/locations.js';
import { roadClearance } from '../shared/world/frontier-sites/plan.js';
import { frontierTopY, FRONTIER_CROSSINGS, FRONTIER_CELL_KIND as KIND, frontierTerrain } from '../shared/world/frontier-terrain.js';
import { createMapState, getMapMeta } from '../shared/world/templates.js';
import { serializeBlocks } from '../shared/world/serialize.js';
import {
  AIR, MC_WATER, CONCRETE, METAL, PLANK, BARRICADE, LEAVES, COBBLE_WALL, isSolidBlock,
} from '../shared/world/blocks.js';
import { boxCollides, solidBelow } from '../shared/player-movement.js';

const started = performance.now();
const dims = FRONTIER_PLAN.dimensions;
const blocks = new Uint8Array(dims.sx * dims.sy * dims.sz);
const kit = generateFrontierV2Into({ dimensions: dims }, blocks, null);
const at = (x, y, z) => (x < 0 || z < 0 || y < 0 || x >= dims.sx || y >= dims.sy || z >= dims.sz ? AIR : blocks[(y * dims.sz + z) * dims.sx + x]);
const solid = (x, y, z) => isSolidBlock(at(x, y, z));
const meta = getMapMeta('frontier');
const world = createMapState('frontier');

// The template is exactly this generator's output.
assert.deepEqual(world.serializeWorld(), serializeBlocks(blocks, dims), 'templates.js builds Frontier v2 through the site generator');

const feature = kind => kit.features.filter(f => f.kind === kind);
const standable = (x, y, z) => solidBelow(solid, x, y, z) && !boxCollides(solid, x, y, z);

/** Voxel DDA sight line; true if it reaches within `reach` of b unobstructed. */
function sightLine(a, b, reach = 1.5) {
  const d = [b.x - a.x, b.y - a.y, b.z - a.z], len = Math.hypot(...d), dir = d.map(v => v / len);
  for (let t = 0.6; t < len - reach; t += 0.25) {
    if (solid(Math.floor(a.x + dir[0] * t), Math.floor(a.y + dir[1] * t), Math.floor(a.z + dir[2] * t))) return false;
  }
  return true;
}
/** Two-high cover, a berm or a trench at a column. */
function coverAt(x, z, refY) {
  const g = frontierTopY(x + 0.5, z + 0.5);
  const raised = solid(x, g + 1, z) && solid(x, g + 2, z) && at(x, g + 1, z) !== MC_WATER;
  const dug = !solid(x, g, z) && !solid(x, g - 1, z) && at(x, g, z) !== MC_WATER;
  return raised || dug || g + 1 - refY >= 1.5;
}

/**
 * Infantry reach around a flag: a 2.5D flood over standable voxels (two clear
 * voxels over a solid or water floor) from the flag's spawn cells, stepping up
 * at most one voxel and dropping at most three, inside a square window.
 */
function reachFrom(starts, cx, cz, half = 80) {
  const x0 = Math.max(1, Math.floor(cx - half)), x1 = Math.min(dims.sx - 2, Math.floor(cx + half));
  const z0 = Math.max(1, Math.floor(cz - half)), z1 = Math.min(dims.sz - 2, Math.floor(cz + half));
  const levels = new Map();
  const levelsAt = (x, z) => {
    const key = z * dims.sx + x;
    let out = levels.get(key);
    if (!out) {
      out = [];
      for (let y = 1; y < dims.sy - 2; y++) {
        const below = at(x, y - 1, z);
        if ((isSolidBlock(below) || below === MC_WATER) && !solid(x, y, z) && !solid(x, y + 1, z) && at(x, y, z) !== MC_WATER) out.push(y);
      }
      levels.set(key, out);
    }
    return out;
  };
  const seen = new Set();
  const queue = [];
  for (const p of starts) { const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; if (!seen.has(k)) { seen.add(k); queue.push([Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]); } }
  while (queue.length) {
    const [x, y, z] = queue.pop();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < x0 || nx > x1 || nz < z0 || nz > z1) continue;
      for (const ny of levelsAt(nx, nz)) {
        if (ny > y + 1 || ny < y - 3 || (ny > y && solid(x, y + 2, z))) continue;
        const k = `${nx},${ny},${nz}`;
        if (seen.has(k)) continue;
        seen.add(k); queue.push([nx, ny, nz]);
      }
    }
  }
  return seen;
}

assert.equal(FRONTIER_SITES.length, 5);
for (const site of FRONTIER_SITES) {
  const flag = meta.conquest.flags.find(f => f.id === site.flag);
  const plan = FRONTIER_PLAN.flags.find(f => f.id === site.flag);
  assert.equal(site.site, plan.site);
  assert.equal(flag.site, plan.site);

  // --- hard building: enterable, roofed, with a doorway at floor level.
  const hard = feature('hard-building').filter(f => f.flag === site.flag);
  assert.equal(hard.length, 1, `${site.flag}: one designated hard building`);
  const h = hard[0];
  const building = feature('building').find(b => b.minX === h.minX && b.minZ === h.minZ && b.maxX === h.maxX && b.maxZ === h.maxZ);
  assert.ok(building?.enterable && building.hard, `${site.flag}: the hard building is enterable`);
  let interior = 0, roofed = 0;
  for (let z = h.minZ + 1; z < h.maxZ; z++) for (let x = h.minX + 1; x < h.maxX; x++) {
    if (!solid(x, building.floorY + 1, z) && !solid(x, building.floorY + 2, z)) interior++;
    for (let y = building.floorY + 3; y < dims.sy; y++) if (solid(x, y, z)) { roofed++; break; }
  }
  const area = (h.maxX - h.minX - 1) * (h.maxZ - h.minZ - 1);
  assert.ok(interior >= area * 0.4, `${site.flag}: hard building has a usable interior (${interior}/${area})`);
  assert.ok(roofed >= area * 0.8, `${site.flag}: hard building is roofed`);
  let doors = 0;
  for (let x = h.minX; x <= h.maxX; x++) for (const z of [h.minZ, h.maxZ]) if (!solid(x, building.floorY + 1, z) && !solid(x, building.floorY + 2, z)) doors++;
  for (let z = h.minZ; z <= h.maxZ; z++) for (const x of [h.minX, h.maxX]) if (!solid(x, building.floorY + 1, z) && !solid(x, building.floorY + 2, z)) doors++;
  assert.ok(doors >= 2, `${site.flag}: hard building has a doorway`);
  // Every enterable building at the site can be walked into from the flag's
  // spawns: doorways on a slope get entrance steps down to the ground.
  const reached = reachFrom(flag.spawns, flag.x, flag.z);
  for (const b of feature('building').filter(f => f.enterable && !f.open && Math.hypot((f.minX + f.maxX) / 2 - flag.x, (f.minZ + f.maxZ) / 2 - flag.z) < 60)) {
    let floorCells = 0, inside = 0;
    for (let z = b.minZ + 1; z < b.maxZ; z++) for (let x = b.minX + 1; x < b.maxX; x++) {
      if (solid(x, b.floorY + 1, z) || solid(x, b.floorY + 2, z) || !solid(x, b.floorY, z)) continue;
      floorCells++;
      if (reached.has(`${x},${b.floorY + 1},${z}`)) inside++;
    }
    assert.ok(floorCells > 0 && inside >= floorCells * 0.6,
      `${site.flag}: ${b.id ?? `building ${b.minX},${b.minZ}`} (floor y${b.floorY}) is walkable from the flag (${inside}/${floorCells})`);
  }

  // --- two infantry approach lanes with cover along them.
  assert.ok(site.lanes.length >= 2, `${site.flag}: two approach lanes`);
  for (const lane of site.lanes) {
    const [ax, az] = lane.from, [bx, bz] = lane.to, len = Math.hypot(bx - ax, bz - az);
    let covered = 0, walkable = 0, samples = 0;
    for (let s = 0; s <= len; s += 1) {
      const x = ax + (bx - ax) * s / len, z = az + (bz - az) * s / len, cx = Math.floor(x), cz = Math.floor(z);
      const g = frontierTopY(x, z);
      samples++;
      let ok = false;
      for (let y = g - 2; y <= g + 1 && !ok; y++) if (standable(cx + 0.5, y + 1, cz + 0.5)) ok = true;
      if (ok) walkable++;
      let near = false;
      for (let dz = -5; dz <= 5 && !near; dz++) for (let dx = -5; dx <= 5 && !near; dx++) if (coverAt(cx + dx, cz + dz, g + 1)) near = true;
      if (near) covered++;
    }
    assert.ok(walkable >= samples * 0.85, `${site.flag} ${lane.id}: walkable (${walkable}/${samples})`);
    assert.ok(covered >= samples * 0.7, `${site.flag} ${lane.id}: covered (${covered}/${samples})`);
  }

  // --- vehicle route: a road reaches the flag.
  const roadNear = meta.conquest.roads.some(r => r.points.some(([x, , z]) => Math.hypot(x - flag.x, z - flag.z) <= flag.radius + 12));
  assert.ok(roadNear, `${site.flag}: a road reaches the flag`);
  assert.ok(meta.conquest.vehicleSpawns.some(v => v.flag === site.flag), `${site.flag}: flag-bound vehicle pad`);

  // --- AT ambush points: standable, with sight of a road at 15-90 m.
  assert.ok(site.ambush.length >= 2, `${site.flag}: AT ambush points`);
  for (const a of site.ambush) {
    const g = frontierTopY(a.x, a.z);
    let y = null;
    for (let yy = g - 2; yy <= g + 12 && y == null; yy++) if (standable(a.x, yy, a.z)) y = yy;   // trenches sit below grade
    assert.ok(y != null, `${site.flag}: ambush ${a.x},${a.z} is standable`);
    const eye = { x: a.x, y: y + 1.5, z: a.z };
    const sees = meta.conquest.roads.some(r => r.points.some(([x, py, z]) => {
      const d = Math.hypot(x - a.x, z - a.z);
      return d >= 15 && d <= 90 && sightLine(eye, { x, y: py + 1, z });
    }));
    assert.ok(sees, `${site.flag}: ambush ${a.x},${a.z} overlooks a road`);
  }

  // --- twelve dry, walkable spawn cells.
  assert.equal(flag.spawns.length, 12);
  assert.equal(new Set(flag.spawns.map(p => `${Math.floor(p.x)},${Math.floor(p.z)}`)).size, 12);
  for (const p of flag.spawns) {
    assert.ok(standable(p.x, p.y, p.z), `${site.flag}: spawn ${p.x},${p.z} is standable at y${p.y}`);
    assert.notEqual(at(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)), MC_WATER, `${site.flag}: spawn floor is dry`);
    assert.notEqual(at(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), MC_WATER, `${site.flag}: spawn feet are dry`);
    assert.ok(Math.hypot(p.x - flag.x, p.z - flag.z) <= flag.radius + 6, `${site.flag}: spawn near the flag`);
  }

  // --- landmark tops are real voxels at the published heights.
  for (const l of site.landmarks) {
    const top = meta.landmarks.find(m => m.id === l.id);
    assert.ok(top, `${l.id} is published`);
    let found = false;
    // Hollow tops (chimney rims, the cooling tower lip) ring their centre.
    for (let dz = -9; dz <= 9; dz++) for (let dx = -9; dx <= 9; dx++) if (solid(Math.floor(top.x) + dx, top.y, Math.floor(top.z) + dz)) found = true;
    for (let dz = -9; dz <= 9; dz++) for (let dx = -9; dx <= 9; dx++) assert.ok(!solid(Math.floor(top.x) + dx, top.y + 2, Math.floor(top.z) + dz), `${l.id} tops out at y${top.y}`);
    assert.ok(found, `${l.id} top voxel at y${top.y}`);
    assert.ok(top.y - frontierTopY(top.x, top.z) >= 9, `${l.id} rises above its ground`);
  }
}

// Spec heights: spire and chimneys to y78, cooling tower ~35, silo/windmill ~28, truss ~20.
const landmark = id => meta.landmarks.find(l => l.id === id);
assert.equal(landmark('st-aldric-spire').y, FRONTIER_PLAN.heights.landmarkMax);
assert.equal(landmark('kessler-chimney-west').y, FRONTIER_PLAN.heights.landmarkMax);
assert.equal(landmark('kessler-chimney-east').y, FRONTIER_PLAN.heights.landmarkMax);
const rise = id => landmark(id).y - frontierTopY(landmark(id).x, landmark(id).z);
assert.ok(Math.abs(rise('kessler-cooling-tower') - 35) <= 2);
assert.ok(Math.abs(rise('kestrel-silo') - 28) <= 3);
assert.ok(rise('kestrel-windmill') >= 20);
const iron = FRONTIER_CROSSINGS.find(c => c.id === 'iron-bridge');
assert.ok(Math.abs(landmark('iron-bridge-arch').y - iron.deckY - 20) <= 2, 'truss arches about 20 m over the deck');
assert.ok(rise('iron-bridge-water-tower') >= 20);

// Site set pieces the spec names.
const buildings = feature('building');
assert.ok(buildings.filter(b => b.id?.startsWith('kestrel-') && b.enterable).length >= 2, 'A: two enterable barns');
assert.ok(buildings.filter(b => b.minX >= 225 && b.maxX <= 305 && b.minZ >= 490 && b.maxZ <= 560 && b.floors === 2).length >= 4, 'B: two-storey houses');
assert.equal(buildings.filter(b => b.pillbox).length, 2, 'D: two concrete pillboxes');
assert.ok(buildings.some(b => b.id === 'kessler-smelter-hall' && b.enterable), 'E: enterable smelter hall');
// C: concrete deck over a metal core on every iron-bridge deck cell.
const { kind } = frontierTerrain();
let deckCells = 0;
for (let z = 370; z < 400; z++) for (let x = 370; x < 400; x++) if (kind[z * dims.sx + x] === KIND.BRIDGE) {
  deckCells++;
  assert.equal(at(x, iron.deckY, z), CONCRETE); assert.equal(at(x, iron.deckY - 1, z), METAL);
}
assert.ok(deckCells >= FRONTIER_PLAN.river.width * iron.width, `iron bridge deck ${deckCells} cells`);
// D: zig-zag trenches two voxels deep with duckboards and sandbag lips.
for (const t of BUNKER_TRENCHES) {
  const [x, z] = t.points[1], g = frontierTopY(x + 0.5, z + 0.5);
  assert.equal(at(x, g, z), AIR, `${t.id} is dug out`); assert.equal(at(x, g - 1, z), AIR);
  assert.equal(at(x, g - 2, z), PLANK, `${t.id} duckboards`);
}
assert.ok(blocks.includes(BARRICADE), 'sandbag lips');

// Woodland: under the cap, clear of roads and flags, point-mirrored.
const plan = frontierForestPlan();
assert.ok(plan.total <= FRONTIER_TREE_CAP && plan.total >= 1800, `tree count ${plan.total}`);
assert.equal(plan.west.length, plan.east.length);
assert.ok(plan.bushes.length >= 40, `bush clumps ${plan.bushes.length * 2}`);
for (const tree of [...plan.west, ...plan.east, ...plan.burnt]) {
  assert.ok(roadClearance(tree.x + 0.5, tree.z + 0.5) >= 3, `tree ${tree.x},${tree.z} clear of the road corridor`);
  for (const f of FRONTIER_PLAN.flags) assert.ok(Math.hypot(tree.x + 0.5 - f.x, tree.z + 0.5 - f.z) >= f.radius, `tree ${tree.x},${tree.z} outside flag ${f.id}`);
}
let same = 0, total = 0;
for (let n = 0; n < plan.west.length; n++) {
  const a = plan.west[n], b = plan.east[n];
  assert.equal(b.x, dims.sx - 1 - a.x); assert.equal(b.z, dims.sz - 1 - a.z);
  const ga = frontierTopY(a.x + 0.5, a.z + 0.5), gb = frontierTopY(b.x + 0.5, b.z + 0.5);
  for (let k = 1; k <= a.height; k++) { total++; if (at(a.x, ga + k, a.z) === at(b.x, gb + k, b.z)) same++; }
}
assert.ok(same >= total * 0.97, `the east woods mirror the west (${same}/${total} trunk voxels)`);

// Dressing: 4-8 burning wrecks near C, D and B and at the river crossings
// (the ambience smokes up to 8); hedgerows and walls between flags.
const wrecks = frontierWrecks();
assert.ok(wrecks.length >= 4 && wrecks.length <= 8);
for (const near of ['C', 'D', 'B']) assert.ok(wrecks.some(w => w.near === near), `a wreck near ${near}`);
for (const w of wrecks) {
  const flag = FRONTIER_PLAN.flags.find(f => f.id === w.near);
  const crossing = FRONTIER_PLAN.crossings.find(c => c.id === w.near);
  assert.ok(flag ? Math.hypot(w.x - flag.x, w.z - flag.z) <= 75 : Math.hypot(w.x - crossing.x, w.z - crossing.z) <= 40, `${w.id} stands near ${w.near}`);
  const g = frontierTopY(w.x + 0.5, w.z + 0.5);
  assert.ok(solid(w.x, g + 1, w.z) || solid(w.x, g + 2, w.z), `${w.id} hulk is solid`);
  assert.ok(meta.conquest.dressing.some(d => d.id === w.id && d.y === w.y), `${w.id} is published for wreck smoke`);
  assert.ok(roadClearance(w.x, w.z) >= 3, `${w.id} leaves the road open`);
}
const hedgeVoxels = blocks.reduce((n, b) => n + (b === LEAVES ? 1 : 0), 0);
assert.ok(feature('cover').filter(c => c.cover === 'hedge').length >= DRESSING_HEDGES.length * 2 && hedgeVoxels > 0);
assert.ok(feature('cover').filter(c => c.cover === 'stone wall').length >= DRESSING_WALLS.length * 2 && blocks.includes(COBBLE_WALL));
assert.ok(feature('crater').length >= 12, 'scattered craters');

// Places between the flags (2026-10-07 locations pass): each is published as
// a named place row plus a landmark that tops out where published and rises
// at least 15 m; its buildings stand more than 80 m from every flag (squads
// stage 50-76 m out) and can be walked into from the nearest road; the quarry
// floor can be walked out of.
const placeRows = meta.landmarks.filter(l => l.kind === 'place');
assert.deepEqual(placeRows.map(p => p.id), FRONTIER_LOCATIONS.map(l => l.id), 'every place is published');
const roadPoints = meta.conquest.roads.flatMap(r => r.points.map(([x, y, z]) => ({ x, y, z })));
let placeBuildings = 0;
for (const loc of FRONTIER_LOCATIONS) {
  assert.ok(placeRows.find(p => p.id === loc.id).name === loc.name, `${loc.id} carries its name`);
  const mark = meta.landmarks.find(m => m.id === loc.landmark.id);
  assert.ok(mark && mark.place === loc.id && mark.y === loc.landmark.y, `${loc.landmark.id} is published`);
  let found = false;
  for (let dz = -9; dz <= 9; dz++) for (let dx = -9; dx <= 9; dx++) {
    if (solid(Math.floor(mark.x) + dx, mark.y, Math.floor(mark.z) + dz)) found = true;
    assert.ok(!solid(Math.floor(mark.x) + dx, mark.y + 2, Math.floor(mark.z) + dz), `${mark.id} tops out at y${mark.y}`);
  }
  assert.ok(found, `${mark.id} top voxel at y${mark.y}`);
  assert.ok(mark.y - frontierTopY(mark.x, mark.z) >= 15, `${mark.id} reads from afar (${mark.y})`);
  const road = roadPoints.reduce((a, b) => (Math.hypot(b.x - loc.x, b.z - loc.z) < Math.hypot(a.x - loc.x, a.z - loc.z) ? b : a));
  assert.ok(Math.hypot(road.x - loc.x, road.z - loc.z) <= 60, `${loc.id} lies by a road`);
  const reached = reachFrom([road], loc.x, loc.z, 90);
  for (const b of feature('building').filter(f => f.location === loc.id)) {
    for (const f of FRONTIER_PLAN.flags) {
      const nx = Math.max(b.minX, Math.min(b.maxX + 1, f.x)), nz = Math.max(b.minZ, Math.min(b.maxZ + 1, f.z));
      assert.ok(Math.hypot(nx - f.x, nz - f.z) > 80, `${b.id ?? loc.id} stands more than 80 m from flag ${f.id}`);
    }
    if (!b.enterable || b.open) continue;
    placeBuildings++;
    let floorCells = 0, inside = 0;
    for (let z = b.minZ + 1; z < b.maxZ; z++) for (let x = b.minX + 1; x < b.maxX; x++) {
      if (solid(x, b.floorY + 1, z) || solid(x, b.floorY + 2, z) || !solid(x, b.floorY, z)) continue;
      floorCells++;
      if (reached.has(`${x},${b.floorY + 1},${z}`)) inside++;
    }
    assert.ok(floorCells > 0 && inside >= floorCells * 0.6, `${b.id} is walkable from the road (${inside}/${floorCells})`);
  }
  if (Number.isFinite(loc.floorY)) {
    let floor = 0, out = 0;
    for (let z = loc.footprint.minZ; z <= loc.footprint.maxZ; z++) for (let x = loc.footprint.minX; x <= loc.footprint.maxX; x++) {
      if (!solid(x, loc.floorY, z) || solid(x, loc.floorY + 1, z) || solid(x, loc.floorY + 2, z)) continue;
      floor++;
      if (reached.has(`${x},${loc.floorY + 1},${z}`)) out++;
    }
    assert.ok(floor >= 150 && out >= floor * 0.9, `${loc.id} floor connects to the road (${out}/${floor})`);
  }
}
assert.ok(placeBuildings >= 3, 'the places offer enterable buildings');

console.log(`Frontier sites passed: ${FRONTIER_SITES.length} sites, ${plan.total} trees, ${wrecks.length} wrecks, `
  + `${FRONTIER_LOCATIONS.length} places, ${kit.features.length} features (${(performance.now() - started).toFixed(0)}ms)`);
