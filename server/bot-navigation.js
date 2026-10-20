import { worldDimensions } from '../shared/world/dimensions.js';
import { PHYSICS, boxCollides, solidBelow } from '../shared/player-movement.js';
import { FLUID_BLOCKS } from '../shared/worlddata.js';
import { surfaceNavigation } from './bot-surface-nav.js';

// Two navigation models share this facade: the flat-floor grid of maps with a
// navigationFloor (legacy large maps) and the 2.5D surface graph of maps that
// declare navigation {mode:'surface'} (Frontier v2, see bot-surface-nav.js).
// Every other map keeps straight-line steering.
export { surfaceNavigation } from './bot-surface-nav.js';

const GRIDS = new WeakMap();
// Grids of pristine template worlds, per template voxels and grid shape.
const PRISTINE_GRIDS = new WeakMap();
const NEAR_MEMO = 4096;   // closest() answers kept per grid until the voxels change
const CELL = 2;
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const LOOKAHEAD = 12;
const EPS = 1e-4;
const pointAt = (graph, node) => ({ x: (node % graph.width) * graph.cell + 0.5,
  y: graph.floor + 0.02, z: Math.floor(node / graph.width) * graph.cell + 0.5 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function intersectsExpandedVoxel(from, to, x, z) {
  let enter = 0, leave = 1;
  for (const [axis, cell] of [['x', x], ['z', z]]) {
    const min = cell - PHYSICS.halfW + EPS, max = cell + 1 + PHYSICS.halfW - EPS;
    const delta = to[axis] - from[axis];
    if (Math.abs(delta) < EPS) {
      if (from[axis] <= min || from[axis] >= max) return false;
      continue;
    }
    const first = (min - from[axis]) / delta, last = (max - from[axis]) / delta;
    enter = Math.max(enter, Math.min(first, last));
    leave = Math.min(leave, Math.max(first, last));
    if (enter > leave) return false;
  }
  return leave >= 0 && enter <= 1;
}

/** Sweep the standing collision body, not only a ray or two clear endpoints.
 * Ground sampling also excludes routes across removed floor tiles. */
export function groundSegmentClear(world, from, to) {
  if (!from || !to || ![from.x, from.z, to.x, to.z].every(Number.isFinite)) return false;
  const surface = surfaceNavigation(world);
  if (surface) return surface.segmentWalkable(from, to);
  const floor = world.meta?.navigationFloor + 1;
  if (!Number.isFinite(floor)) return false;
  const minX = Math.floor(Math.min(from.x, to.x) - PHYSICS.halfW + EPS);
  const maxX = Math.floor(Math.max(from.x, to.x) + PHYSICS.halfW - EPS);
  const minZ = Math.floor(Math.min(from.z, to.z) - PHYSICS.halfW + EPS);
  const maxZ = Math.floor(Math.max(from.z, to.z) + PHYSICS.halfW - EPS);
  const maxY = Math.floor(floor + PHYSICS.height - EPS);
  for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
    let occupied = false;
    for (let y = floor; y <= maxY; y++) if (world.getBlock(x, y, z) !== 0) { occupied = true; break; }
    if (occupied && intersectsExpandedVoxel(from, to, x, z)) return false;
  }
  const steps = Math.max(1, Math.ceil(distance(from, to) / 0.25));
  const solid = (x, y, z) => { const block = world.getBlock(x, y, z); return block !== 0 && !FLUID_BLOCKS.has(block); };
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    if (!solidBelow(solid, from.x + (to.x - from.x) * t, floor, from.z + (to.z - from.z) * t)) return false;
  }
  return true;
}

function refreshNode(graph, node) {
  const point = pointAt(graph, node), x = node % graph.width, z = Math.floor(node / graph.width);
  const wx = Math.floor(point.x), wz = Math.floor(point.z);
  // Fluid in the floor cell too: a sunk lava runner (Ashfall's Pour) is no floor to route over.
  const wet = [-1, 0, 1, 2].some(dy => FLUID_BLOCKS.has(graph.world.getBlock(wx, graph.floor + dy, wz)));
  graph.walk[node] = x >= 1 && z >= 1 && x < graph.width - 1 && z < graph.depth - 1
    && !wet
    && !boxCollides(graph.solid, point.x, graph.floor, point.z)
    && solidBelow(graph.solid, point.x, graph.floor, point.z) ? 1 : 0;
}

function refreshEdges(graph, node) {
  graph.edges[node] = 0;
  if (!graph.walk[node]) return;
  const x = node % graph.width, z = Math.floor(node / graph.width), point = pointAt(graph, node);
  DIRECTIONS.forEach(([dx, dz], direction) => {
    const nx = x + dx, nz = z + dz, next = nz * graph.width + nx;
    if (nx >= 0 && nx < graph.width && nz >= 0 && nz < graph.depth && graph.walk[next]
      && groundSegmentClear(graph.world, point, pointAt(graph, next))) graph.edges[node] |= 1 << direction;
  });
}

function createGrid(world) {
  const { sx, sz } = worldDimensions(world);
  const cell = Math.max(CELL, Math.min(16, Math.trunc(world.meta.navigationCell ?? (world.meta.id === 'frontier' ? 8 : CELL))));
  const width = Math.ceil(sx / cell), depth = Math.ceil(sz / cell);
  return { world, width, depth, cell, walk: new Uint8Array(width * depth), edges: new Uint8Array(width * depth),
    floor: world.meta.navigationFloor + 1, revision: -1, solid: (x, y, z) => world.getBlock(x, y, z) !== 0,
    // groundRoute's breadth-first scratch (parent valid where seen === search) and closest()'s memo.
    parent: null, queue: null, seen: null, search: 0, near: new Map(), nearAt: NaN, nearRevision: -1 };
}

/** The full sweep of every cell, then every edge, as a generator (one yield per `chunk` cells). */
function* fullBuildSteps(graph, chunk = Infinity) {
  const nodes = graph.walk.length;
  for (let node = 0; node < nodes; node++) { refreshNode(graph, node); if ((node + 1) % chunk === 0) yield; }
  for (let node = 0; node < nodes; node++) { refreshEdges(graph, node); if ((node + 1) % chunk === 0) yield; }
}

/** Cache slot of a grid while its world matches the pristine template, else null. */
function pristineSlot(graph) {
  const template = graph.world.matchesTemplate?.() ? graph.world.templateBlocks : null;
  if (!template) return null;
  if (!PRISTINE_GRIDS.has(template)) PRISTINE_GRIDS.set(template, new Map());
  return { map: PRISTINE_GRIDS.get(template), key: `${graph.cell}:${graph.floor}:${graph.width}:${graph.depth}` };
}

/**
 * The full build, except that a world matching its pristine template copies
 * the template's grid (a pure function of the voxels, swept once per process):
 * a new room skips 20-60 ms of segment sweeps in its first tick.
 */
function fullBuild(graph) {
  const slot = pristineSlot(graph), cached = slot?.map.get(slot.key);
  if (cached) { graph.walk.set(cached.walk); graph.edges.set(cached.edges); return; }
  for (const _ of fullBuildSteps(graph)) { /* one step: no chunking */ }
  slot?.map.set(slot.key, { walk: graph.walk.slice(), edges: graph.edges.slice() });
}

/**
 * groundNavigation(world) for a template world as a generator of short work
 * steps (one yield per 256 cells swept), so a boot warm-up fills the pristine
 * cache in slices between room ticks. Returns the grid, or null for maps
 * without a flat navigation floor (and for surface maps).
 */
export function* groundNavigationSteps(world) {
  if (world?.meta?.navigation?.mode === 'surface' || !Number.isFinite(world?.meta?.navigationFloor)) return null;
  const graph = createGrid(world), slot = pristineSlot(graph), mutations = world.mutationCount;
  if (!GRIDS.has(world) && slot && !slot.map.has(slot.key)) {
    yield* fullBuildSteps(graph, 256);
    // Only a sweep of voxels that stayed pristine throughout is the template's grid.
    if (world.mutationCount === mutations && world.matchesTemplate()) {
      slot.map.set(slot.key, { walk: graph.walk.slice(), edges: graph.edges.slice() });
    }
  }
  // Registers the world's own grid (a copy of the cached one when pristine).
  return groundNavigation(world);
}

/** Shared bounded graph; only changed floor/body columns invalidate cells.
 * High crane lights and material changes outside navigation height do no work. */
export function groundNavigation(world) {
  const surface = surfaceNavigation(world);
  if (surface) return surface;
  if (!Number.isFinite(world.meta?.navigationFloor)) return null;
  let graph = GRIDS.get(world);
  const revision = world.navigationRevision ?? 0;
  if (graph?.revision === revision) return graph;
  let changed;
  if (graph) changed = world.navigationChangesSince?.(graph.revision);
  if (!graph) {
    graph = createGrid(world);
    GRIDS.set(world, graph);
  }
  if (!changed) {
    fullBuild(graph);
  } else {
    const affected = new Set();
    for (const { x, z } of changed) {
      const cx = Math.floor(x / graph.cell), cz = Math.floor(z / graph.cell);
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx >= 0 && nx < graph.width && nz >= 0 && nz < graph.depth) affected.add(nz * graph.width + nx);
      }
    }
    for (const node of affected) refreshNode(graph, node);
    for (const node of affected) refreshEdges(graph, node);
  }
  graph.revision = revision;
  return graph;
}

/** Nearest walkable node in a straight, clear line from `point`; `loose` falls back to the
 * nearest walkable node when none is in line. */
function closest(graph, point, loose = false) {
  // The answer is a pure function of the point's x/z, the grid and the voxels:
  // a bot that cannot route (its roam search asks 14 times from one spot, each
  // failing after ~100 swept segments) asks once per terrain change.
  const mutations = graph.world.mutationCount;
  if (!Number.isFinite(mutations)) return closestNode(graph, point, loose);
  if (graph.nearAt !== mutations || graph.nearRevision !== graph.revision || graph.near.size >= NEAR_MEMO) {
    graph.near.clear(); graph.nearAt = mutations; graph.nearRevision = graph.revision;
  }
  const key = `${point.x},${point.z},${loose ? 1 : 0}`;
  let node = graph.near.get(key);
  if (node === undefined) graph.near.set(key, node = closestNode(graph, point, loose));
  return node;
}

function closestNode(graph, point, loose) {
  const x = Math.round((point.x - 0.5) / graph.cell), z = Math.round((point.z - 0.5) / graph.cell);
  const candidates = [];
  for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) {
    const nx = x + dx, nz = z + dz, node = nz * graph.width + nx;
    if (nx >= 0 && nx < graph.width && nz >= 0 && nz < graph.depth && graph.walk[node])
      candidates.push({ node, distance: distance(point, pointAt(graph, node)) });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.node - b.node);
  const clear = candidates.find(candidate => groundSegmentClear(graph.world, point, pointAt(graph, candidate.node)))?.node;
  return clear ?? (loose ? candidates[0]?.node ?? -1 : -1);
}

/** Breadth-first route with valid swept edges and visible endpoint connectors. */
export function groundRoute(world, from, to) {
  const surface = surfaceNavigation(world);
  if (surface) {
    if (!from || !to) return [];
    const route = surface.route(from, to);
    return route.reached ? route.points : [];
  }
  const graph = groundNavigation(world);
  if (!graph || !from || !to) return [];
  if (distance(from, to) <= 48 && groundSegmentClear(world, from, to)) return [{ x: to.x, y: graph.floor + 0.02, z: to.z }];
  // Maps with raised pilot levels (mapMeta.climbs: Ashfall's docks, ramps and perches) route a goal
  // standing up there to the nearest floor node instead of giving up.
  const start = closest(graph, from), end = closest(graph, to, Array.isArray(world.meta?.climbs));
  if (start < 0 || end < 0) return [];
  // Scratch reused by every search of this grid; a node counts as seen only
  // when stamped with this search (no per-route allocation or fill).
  if (!graph.parent) {
    graph.parent = new Int32Array(graph.walk.length);
    graph.queue = new Int32Array(graph.walk.length);
    graph.seen = new Uint32Array(graph.walk.length);
  }
  if (++graph.search >= 0xFFFFFFFF) { graph.seen.fill(0); graph.search = 1; }
  const { parent, queue, seen, search, edges, width } = graph;
  let read = 0, write = 1;
  queue[0] = start; parent[start] = start; seen[start] = search;
  while (read < write && seen[end] !== search) {
    const current = queue[read++], open = edges[current];
    for (let direction = 0; direction < DIRECTIONS.length; direction++) {
      if (!(open & (1 << direction))) continue;
      const next = current + DIRECTIONS[direction][1] * width + DIRECTIONS[direction][0];
      if (seen[next] === search) continue;
      seen[next] = search; parent[next] = current; queue[write++] = next;
    }
  }
  if (seen[end] !== search) return [];
  const route = [{ x: to.x, y: graph.floor + 0.02, z: to.z }];
  for (let node = end; ; node = parent[node]) {
    route.push(pointAt(graph, node));
    if (node === start) break;
  }
  return route.reverse();
}

// Authored climbs (mapMeta.climbs, Ashfall's rodeo perches): a polyline of world
// points from a ground foot up a stair to an upper deck. The flat graph knows only
// the floor, so a target on a climb's deck routes to its foot and then walks the
// points; a body standing on a climb walks it down before routing anywhere else.
const CLIMB_ABOVE = 2.5;   // m above the floor: a target on an upper level
const CLIMB_DECK = 4;      // m flat from a climb's last point: the target is that deck
const CLIMB_REACH = 1.3;   // m flat from a climb segment: the body is on it
const CLIMB_NEXT = 0.7;    // m: a reached climb point hands on to the next one

function nearestSegment(points, p) {
  let best = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1], dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
    const d = Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z), y = a.y + (b.y - a.y) * t;
    if (Math.abs(p.y - y) <= 2.5 && (!best || d < best.d)) best = { i, t, d };
  }
  return best;
}

/**
 * Next point along an authored climb, or null when no climb is involved.
 * `{ point }` is a straight steering target; `{ ground }` replaces the
 * route target by the climb's foot.
 */
export function climbStep(world, from, to, floor) {
  const climbs = world.meta?.climbs;
  if (!Array.isArray(climbs) || !climbs.length || !from || !to) return null;
  const goal = to.y > floor + CLIMB_ABOVE
    ? climbs.find(c => distance(c.points[c.points.length - 1], to) <= CLIMB_DECK) : null;
  const raised = from.y > floor + 0.5;
  let on = null;
  for (const climb of climbs) {
    if (!raised && climb !== goal) continue;
    const seg = nearestSegment(climb.points, from);
    if (seg && seg.d <= CLIMB_REACH && (raised || seg.t > 0) && (!on || seg.d < on.seg.d)) on = { climb, seg };
  }
  if (on && on.climb === goal) {
    const pts = goal.points;
    let next = on.seg.i + 1;
    if (next < pts.length - 1 && distance(from, pts[next]) < CLIMB_NEXT) next++;
    return { point: next === pts.length - 1 ? to : pts[next], climbing: true };
  }
  if (on) {
    const pts = on.climb.points;
    let next = on.seg.i;
    if (next > 0 && distance(from, pts[next]) < CLIMB_NEXT) next--;
    if (next === 0 && distance(from, pts[0]) < CLIMB_NEXT) return null;
    return { point: pts[next], climbing: true };
  }
  if (goal) {
    if (distance(from, goal.points[0]) < 1) return { point: goal.points[1], climbing: true };
    return { ground: goal.points[0], climbing: false };
  }
  return null;
}

export function navigationWaypoint(world, from, to, brain, now) {
  const surface = surfaceNavigation(world);
  if (surface) return surface.waypoint(from, to, brain, now);
  if (!Number.isFinite(world.meta?.navigationFloor) || !to) return to;
  const graph = groundNavigation(world);
  const climb = world.meta?.climbs ? climbStep(world, from, to, graph.floor) : null;
  brain.climbing = !!climb?.climbing;
  if (climb?.point) return climb.point;
  if (climb?.ground) to = climb.ground;
  let route = brain.groundRoute;
  if (!route || now >= route.until || distance(to, route.target) > 2
    || distance(from, route.last) > 12 || route.revision !== graph.revision) {
    route = brain.groundRoute = { target: { ...to }, points: groundRoute(world, from, to),
      until: now + 2000, last: { x: from.x, z: from.z }, revision: graph.revision };
  }
  route.last = { x: from.x, z: from.z };
  // Select a farther visible node while preserving corners. Consuming the
  // visible prefix also prevents a passed short waypoint from pulling us back.
  let candidate = -1;
  for (let index = 0; index < route.points.length; index++) {
    if (distance(from, route.points[index]) > LOOKAHEAD && index > 0) break;
    if (groundSegmentClear(world, from, route.points[index])) candidate = index;
  }
  if (candidate >= 0) {
    if (candidate > 0) route.points.splice(0, candidate);
    return route.points[0];
  }
  // A stale/destroyed floor or unreachable goal must not become a direct
  // steering command through the wall that made the route fail.
  return { x: from.x, y: from.y, z: from.z };
}
