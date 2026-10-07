// 2.5D surface navigation (server/bot-surface-nav.js) on the authoritative
// Frontier v2 world. Every coordinate comes from mapMeta; nothing is hard-coded.
//
//  - the graph builds from real voxels in <= 400 ms for 768 x 768;
//  - every flag, every flag spawn cell and every HQ pad (base spawns and the
//    HQ vehicle pads) is reachable from both HQs, and the median route is at
//    most 1.35x the straight line;
//  - straight walks never shortcut through the river; bridges are surfaces;
//  - terrain changes are applied incrementally and reroute around a crater;
//  - pocket goals are proven unreachable cheaply; a crater replans only the
//    cached routes it touches;
//  - maps without navigation {mode:'surface'} keep the legacy navigation.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { FLUID_BLOCKS, AIR } from '../shared/world/blocks.js';
import { SurfaceNav, surfaceNavigation, TerrainWatch } from '../server/bot-surface-nav.js';
import { groundNavigation, groundSegmentClear } from '../server/bot-navigation.js';

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const median = list => { const s = list.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const meta = getMapMeta('frontier');
assert.equal(meta.navigation?.mode, 'surface', 'Frontier declares 2.5D surface navigation');
const world = createMapState('frontier');

// --- build budget ------------------------------------------------------------
{
  // A fresh SurfaceNav on the same world, timed on its own (no caching).
  const samples = [];
  for (let i = 0; i < 2; i++) {
    const nav = new SurfaceNav(world, meta.navigation);
    const t0 = performance.now();
    nav.build();
    samples.push(performance.now() - t0);
  }
  const best = Math.min(...samples);
  console.log(`surface graph build ${samples.map(ms => ms.toFixed(0)).join(' / ')} ms for ${meta.dimensions?.sx ?? world.dimensions.sx}^2`);
  assert(best <= 400, `surface graph builds in <= 400 ms (${best.toFixed(0)} ms)`);
}

const nav = surfaceNavigation(world);
assert(nav instanceof SurfaceNav, 'surfaceNavigation caches one graph per world');
assert.equal(surfaceNavigation(world), nav, 'the cached graph is reused');
assert.equal(groundNavigation(world), nav, 'the navigation facade dispatches to the surface graph');
let walk = 0, water = 0;
for (let i = 0; i < nav.nodes; i++) { if (nav.flags[i] & 1) walk++; else if (nav.flags[i] & 2) water++; }
assert(walk > nav.gw * nav.gd * 0.6, `most cells carry a walkable layer (${walk})`);
assert(water > 0, 'the river is swimmable (water nodes exist)');

// --- reachability from both HQs ----------------------------------------------
const bases = meta.conquest.bases;
const targets = [];
for (const flag of meta.conquest.flags) {
  targets.push({ name: `flag ${flag.id}`, ...flag });
  flag.spawns.forEach((s, i) => targets.push({ name: `flag ${flag.id} spawn ${i}`, ...s }));
}
for (const team of ['alpha', 'bravo']) bases[team].spawns.forEach((s, i) => targets.push({ name: `${team} HQ spawn ${i}`, ...s }));
for (const pad of meta.conquest.vehicleSpawns) {
  const hq = Object.values(bases).find(b => flat(b, pad) <= b.radius + 60);
  if (hq && !pad.flag) targets.push({ name: `HQ pad ${pad.id}`, x: pad.x, y: pad.y, z: pad.z, pad: true });
}
const ratios = [];
for (const team of ['alpha', 'bravo']) {
  const from = bases[team].spawns[0];
  const reach = nav.reachableFrom(from);
  for (const target of targets) {
    // Hull pads are occupied by the hull: walk to its side, within enter reach.
    const node = nav.nodeAt(target, target.pad ? 2 : 1);
    assert(node >= 0, `${target.name} sits on the navigation graph`);
    assert(reach[node], `${target.name} is reachable from the ${team} HQ`);
    const route = nav.route(from, target);
    assert(route.reached, `${target.name}: A* reaches it from the ${team} HQ`);
    const straight = flat(from, target);
    if (straight > 60) ratios.push(route.length / straight);
  }
}
const ratio = median(ratios);
console.log(`reachability: ${targets.length} targets x 2 HQs, median route/straight ${ratio.toFixed(3)} (max ${Math.max(...ratios).toFixed(2)})`);
assert(ratio <= 1.35, `median route length <= 1.35x the straight line (${ratio.toFixed(3)})`);

// --- bridges are surfaces, the river is not a shortcut -------------------------
{
  for (const crossing of meta.conquest.crossings.filter(c => c.kind === 'bridge')) {
    const node = nav.nodeAt({ x: crossing.x, y: crossing.y, z: crossing.z }, 1);
    assert(node >= 0 && (nav.flags[node] & 1), `${crossing.id}: the deck is a walkable surface`);
    assert(Math.abs(nav.height[node] - Math.round(crossing.y - 0.02)) <= 2, `${crossing.id}: the deck layer sits at deck height`);
  }
  // A straight line from one dry bank to the other across open water is refused.
  const ford = meta.conquest.crossings.find(c => c.id === 'iron-bridge');
  let refused = 0, tried = 0;
  for (const dz of [-40, -30, 30, 40]) {
    const a = nav.snap({ x: ford.x - 14, y: 26, z: ford.z + dz }, 2), b = nav.snap({ x: ford.x + 14, y: 26, z: ford.z + dz }, 2);
    if (!a || !b) continue;
    let wet = false;
    for (let t = 0; t <= 1; t += 0.02) if (FLUID_BLOCKS.has(world.getBlock(Math.floor(a.x + (b.x - a.x) * t), 21, Math.floor(a.z + (b.z - a.z) * t)))) wet = true;
    if (!wet) continue;
    tried++;
    if (!groundSegmentClear(world, a, b)) refused++;
  }
  assert(tried > 0 && refused === tried, `straight walks across open water are refused (${refused}/${tried})`);
  // Beside the bridge (steep banks) the dry route over the deck wins over a swim.
  const across = nav.route(nav.snap({ x: ford.x - 26, y: 26, z: ford.z + 12 }, 2), nav.snap({ x: ford.x + 26, y: 26, z: ford.z + 12 }, 2));
  assert(across.reached, 'a route crosses the river beside the iron bridge');
  const swims = across.points.filter(p => FLUID_BLOCKS.has(world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))).length;
  assert.equal(swims, 0, 'the crossing uses the bridge deck, not a swim');
  // A swimmer under the deck is on the graph (a water layer below the deck layer) and can get out.
  const under = { x: ford.x + 0.5, y: 21, z: ford.z + 0.5 };
  const swimNode = nav.nodeAt(under, 0);
  assert(swimNode >= 0 && (nav.flags[swimNode] & 2) && nav.height[swimNode] <= 22, 'the water under the bridge deck is a swim layer');
  const deckNode = nav.nodeAt({ x: ford.x + 0.5, y: ford.y, z: ford.z + 0.5 }, 0);
  assert(deckNode >= 0 && (nav.flags[deckNode] & 1) && deckNode !== swimNode, 'the deck above it is a separate walk layer');
  const out = nav.route(under, nav.snap({ x: ford.x - 30, y: 26, z: ford.z + 30 }, 2));
  assert(out.reached, 'a swimmer under the bridge has a route out of the river');
}

// --- incremental terrain changes ------------------------------------------------
{
  const fresh = createMapState('frontier');
  const graph = surfaceNavigation(fresh);
  const flag = meta.conquest.flags.find(f => f.id === 'A');
  const from = graph.snap({ x: flag.x - 40, y: flag.y, z: flag.z }, 3), to = graph.snap({ x: flag.x + 30, y: flag.y, z: flag.z }, 3);
  assert(from && to, 'test endpoints near flag A are on the graph');
  const before = graph.route(from, to);
  assert(before.reached, 'route near flag A before the crater');
  // A 9 x 9 x 6 crater on the straight line, logged the way the engine logs it.
  const engine = { world: fresh, changedBlocks: new Set(), blockRevision: 0 };
  const watch = new TerrainWatch(engine);
  const { sx, sz } = fresh.dimensions;
  // Centre the crater on a node of the old route, so the old route crosses it.
  const mid = before.points[Math.floor(before.points.length / 2)];
  const cx = Math.floor(mid.x), cz = Math.floor(mid.z), top = Math.round(mid.y);
  for (let x = cx - 4; x <= cx + 4; x++) for (let z = cz - 4; z <= cz + 4; z++) for (let y = top - 6; y <= top + 2; y++) {
    if (fresh.getBlock(x, y, z) === AIR) continue;
    fresh.setBlock(x, y, z, AIR);
    engine.changedBlocks.add((y * sz + z) * sx + x);
    engine.blockRevision++;
  }
  const columns = watch.poll();
  assert(columns && columns.size > 0, 'TerrainWatch reports the changed columns');
  const revision = graph.revision;
  const t0 = performance.now();
  graph.applyChanges(columns);
  const ms = performance.now() - t0;
  assert(graph.revision > revision, 'the graph revision advances');
  assert(ms < 120, `incremental update stays local (${ms.toFixed(1)} ms)`);
  const pit = graph.nodeAt({ x: cx + 0.5, y: top - 6, z: cz + 0.5 }, 0);
  assert(pit < 0 || graph.height[pit] < top - 3, 'the crater floor replaces the old surface');
  const after = graph.route(from, to);
  assert(after.reached, 'a route still exists around the crater');
  const inside = after.points.filter(pt => Math.abs(pt.x - cx - 0.5) < 3 && Math.abs(pt.z - cz - 0.5) < 3 && pt.y > top - 4);
  assert.equal(inside.length, 0, 'no route point floats over the removed surface');
  const crossesPit = before.points.some(pt => Math.abs(pt.x - cx - 0.5) < 4 && Math.abs(pt.z - cz - 0.5) < 4);
  assert(crossesPit, 'the crater sits on the old route');
  if (crossesPit) assert(after.length > before.length + 1 || after.points.every(pt => !(Math.abs(pt.x - cx - 0.5) < 4 && Math.abs(pt.z - cz - 0.5) < 4 && pt.y > top - 4)),
    'the old straight route through the crater is replaced');
  assert.equal(watch.poll().size, 0, 'no further changes are reported');
  console.log(`crater update ${ms.toFixed(1)} ms, route ${before.length.toFixed(0)} m -> ${after.length.toFixed(0)} m (old route crossed the pit: ${crossesPit})`);
}

// --- unreachable pockets are cheap; routes survive unrelated terrain changes -------
{
  const fresh = createMapState('frontier');
  const graph = surfaceNavigation(fresh);
  const from = bases.alpha.spawns[0], start = graph.nodeAt(from);
  // A pocket node (roof, sealed ledge) no route reaches from the HQ.
  const reach = graph.reachableFrom(from);
  let pocket = -1;
  for (let i = 0; i < graph.nodes && pocket < 0; i++) {
    if ((graph.flags[i] & 1) && !reach[i] && graph.component[i] !== graph.component[start] && graph.provablyUnreachable(start, i)) pocket = i;
  }
  assert(pocket >= 0, 'Frontier has pockets outside the HQ component');
  const target = graph.nodePoint(pocket);
  const route = graph.route(from, target);
  assert(!route.reached, 'a pocket goal is not reached');
  let expanded = 0;
  for (let i = 0; i < graph.nodes; i++) if (graph.closed[i] === graph.search) expanded++;
  assert(expanded <= 4100, `the partial search toward a pocket is budgeted (${expanded} nodes expanded)`);
  assert(route.points.length >= 1, 'a partial route still leads toward the pocket');
  const near = graph.nodeAt(graph.snap({ x: target.x + 30, y: target.y, z: target.z }, 4) ?? target);
  assert(!graph.provablyUnreachable(start, start), 'the start itself is never provably unreachable');
  if (near >= 0 && reach[near]) assert(!graph.provablyUnreachable(start, near), 'a reachable goal is never proven unreachable');
  // A strafing target in the pocket does not force a full replan every 3 m.
  const brain = { index: 0 };
  graph.waypoint(from, target, brain, 0);
  const planned = brain.surfaceRoute;
  graph.waypoint(from, { x: target.x + 4, y: target.y, z: target.z }, brain, 100);
  assert.equal(brain.surfaceRoute, planned, 'an unreachable route keeps its plan while the target shifts a few metres');

  // Two cached routes: a crater on one replans only that one.
  const flagA = meta.conquest.flags.find(f => f.id === 'A'), flagE = meta.conquest.flags.find(f => f.id === 'E');
  const aFrom = graph.snap({ x: flagA.x - 40, y: flagA.y, z: flagA.z }, 3), aTo = graph.snap({ x: flagA.x + 30, y: flagA.y, z: flagA.z }, 3);
  const eFrom = graph.snap({ x: flagE.x - 40, y: flagE.y, z: flagE.z }, 3), eTo = graph.snap({ x: flagE.x + 30, y: flagE.y, z: flagE.z }, 3);
  const near1 = { index: 1 }, far1 = { index: 2 };
  graph.waypoint(aFrom, aTo, near1, 0);
  graph.waypoint(eFrom, eTo, far1, 0);
  const nearRoute = near1.surfaceRoute, farRoute = far1.surfaceRoute;
  assert(nearRoute.reached && farRoute.reached, 'both routes reach their goals');
  const engine = { world: fresh, changedBlocks: new Set(), blockRevision: 0 };
  const watch = new TerrainWatch(engine);
  const { sx, sz } = fresh.dimensions;
  const mid = nearRoute.points[Math.floor(nearRoute.points.length / 2)];
  const cx = Math.floor(mid.x), cz = Math.floor(mid.z), top = Math.round(mid.y);
  for (let x = cx - 3; x <= cx + 3; x++) for (let z = cz - 3; z <= cz + 3; z++) for (let y = top - 4; y <= top + 2; y++) {
    if (fresh.getBlock(x, y, z) === AIR) continue;
    fresh.setBlock(x, y, z, AIR);
    engine.changedBlocks.add((y * sz + z) * sx + x);
    engine.blockRevision++;
  }
  graph.applyChanges(watch.poll());
  graph.waypoint(eFrom, eTo, far1, 50);
  assert.equal(far1.surfaceRoute, farRoute, 'a crater far from a route leaves it cached');
  assert.equal(farRoute.revision, graph.revision, 'the untouched route adopts the new revision');
  graph.waypoint(aFrom, aTo, near1, 50);
  assert.notEqual(near1.surfaceRoute, nearRoute, 'the route crossing the crater replans');
  // A full rebuild leaves no change log to check against: every route replans.
  graph.revision++;
  graph.waypoint(eFrom, eTo, far1, 60);
  assert.notEqual(far1.surfaceRoute, farRoute, 'a revision without a logged change replans');
  console.log(`pocket route: ${expanded} nodes expanded (component ${graph.component[pocket]})`);
}

// --- other maps keep their navigation ----------------------------------------
{
  for (const id of ['foundry', 'dust2']) {
    const other = createMapState(id);
    assert.equal(surfaceNavigation(other), null, `${id} has no surface graph`);
  }
}

console.log('surface navigation tests passed');
