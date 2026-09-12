import { worldDimensions } from '../shared/world/dimensions.js';
import { PHYSICS, boxCollides, solidBelow } from '../shared/player-movement.js';

const GRIDS = new WeakMap();
const CELL = 2;
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const LOOKAHEAD = 12;
const EPS = 1e-4;
const pointAt = (graph, node) => ({ x: (node % graph.width) * CELL + 0.5,
  y: graph.floor + 0.02, z: Math.floor(node / graph.width) * CELL + 0.5 });
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
  const solid = (x, y, z) => world.getBlock(x, y, z) !== 0;
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    if (!solidBelow(solid, from.x + (to.x - from.x) * t, floor, from.z + (to.z - from.z) * t)) return false;
  }
  return true;
}

function refreshNode(graph, node) {
  const point = pointAt(graph, node), x = node % graph.width, z = Math.floor(node / graph.width);
  graph.walk[node] = x >= 1 && z >= 1 && x < graph.width - 1 && z < graph.depth - 1
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

/** Shared bounded graph; only changed floor/body columns invalidate cells.
 * High crane lights and material changes outside navigation height do no work. */
export function groundNavigation(world) {
  if (!Number.isFinite(world.meta?.navigationFloor)) return null;
  let graph = GRIDS.get(world);
  const revision = world.navigationRevision ?? 0;
  if (graph?.revision === revision) return graph;
  let changed;
  if (graph) changed = world.navigationChangesSince?.(graph.revision);
  if (!graph) {
    const { sx, sz } = worldDimensions(world);
    const width = Math.ceil(sx / CELL), depth = Math.ceil(sz / CELL);
    graph = { world, width, depth, walk: new Uint8Array(width * depth), edges: new Uint8Array(width * depth),
      floor: world.meta.navigationFloor + 1, revision: -1, solid: (x, y, z) => world.getBlock(x, y, z) !== 0 };
    GRIDS.set(world, graph);
  }
  if (!changed) {
    for (let node = 0; node < graph.walk.length; node++) refreshNode(graph, node);
    for (let node = 0; node < graph.walk.length; node++) refreshEdges(graph, node);
  } else {
    const affected = new Set();
    for (const { x, z } of changed) {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
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

function closest(graph, point) {
  const x = Math.round((point.x - 0.5) / CELL), z = Math.round((point.z - 0.5) / CELL);
  const candidates = [];
  for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) {
    const nx = x + dx, nz = z + dz, node = nz * graph.width + nx;
    if (nx >= 0 && nx < graph.width && nz >= 0 && nz < graph.depth && graph.walk[node])
      candidates.push({ node, distance: distance(point, pointAt(graph, node)) });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.node - b.node);
  return candidates.find(candidate => groundSegmentClear(graph.world, point, pointAt(graph, candidate.node)))?.node ?? -1;
}

/** Breadth-first route with valid swept edges and visible endpoint connectors. */
export function groundRoute(world, from, to) {
  const graph = groundNavigation(world);
  if (!graph || !from || !to) return [];
  if (groundSegmentClear(world, from, to)) return [{ x: to.x, y: graph.floor + 0.02, z: to.z }];
  const start = closest(graph, from), end = closest(graph, to);
  if (start < 0 || end < 0) return [];
  const parent = new Int32Array(graph.walk.length).fill(-1), queue = new Int32Array(parent.length);
  let read = 0, write = 1;
  queue[0] = start; parent[start] = start;
  while (read < write && parent[end] < 0) {
    const current = queue[read++];
    DIRECTIONS.forEach(([dx, dz], direction) => {
      if (!(graph.edges[current] & (1 << direction))) return;
      const next = current + dz * graph.width + dx;
      if (parent[next] >= 0) return;
      parent[next] = current; queue[write++] = next;
    });
  }
  if (parent[end] < 0) return [];
  const route = [{ x: to.x, y: graph.floor + 0.02, z: to.z }];
  for (let node = end; ; node = parent[node]) {
    route.push(pointAt(graph, node));
    if (node === start) break;
  }
  return route.reverse();
}

export function navigationWaypoint(world, from, to, brain, now) {
  if (!Number.isFinite(world.meta?.navigationFloor) || !to) return to;
  const graph = groundNavigation(world);
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
