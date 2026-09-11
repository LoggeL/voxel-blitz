import { worldDimensions } from '../shared/world/dimensions.js';
import { boxCollides, solidBelow } from '../shared/player-movement.js';

const GRIDS = new WeakMap();
const CELL = 2;

/** Ground route graph shared by the bots of one large-map room. */
export function groundNavigation(world) {
  if (!Number.isFinite(world.meta?.navigationFloor)) return null;
  if (GRIDS.has(world)) return GRIDS.get(world);
  const { sx, sz } = worldDimensions(world);
  const width = Math.ceil(sx / CELL), depth = Math.ceil(sz / CELL);
  const floor = world.meta.navigationFloor + 1;
  const solid = (x, y, z) => world.getBlock(x, y, z) !== 0;
  const walk = new Uint8Array(width * depth);
  for (let z = 2; z < depth - 2; z++) for (let x = 2; x < width - 2; x++) {
    const px = x * CELL + 0.5, pz = z * CELL + 0.5;
    // A one-metre swept corridor keeps graph edges clear of thin walls.
    walk[z * width + x] = [-0.5, 0, 0.5].every(dx => [-0.5, 0, 0.5].every(dz =>
      !boxCollides(solid, px + dx, floor, pz + dz) && solidBelow(solid, px + dx, floor, pz + dz))) ? 1 : 0;
  }
  const graph = { width, depth, walk, floor };
  GRIDS.set(world, graph);
  return graph;
}

function closest(graph, point) {
  const x = Math.round((point.x - 0.5) / CELL), z = Math.round((point.z - 0.5) / CELL);
  for (let radius = 0; radius <= 5; radius++) {
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
      const nx = x + dx, nz = z + dz;
      if (nx >= 0 && nx < graph.width && nz >= 0 && nz < graph.depth
        && graph.walk[nz * graph.width + nx]) return nz * graph.width + nx;
    }
  }
  return -1;
}

/** Bounded breadth-first path, computed on goal changes or every two seconds. */
export function groundRoute(world, from, to) {
  const graph = groundNavigation(world);
  if (!graph) return [];
  const start = closest(graph, from), end = closest(graph, to);
  if (start < 0 || end < 0) return [];
  const parent = new Int32Array(graph.walk.length).fill(-1);
  const queue = new Int32Array(parent.length);
  let read = 0, write = 1;
  queue[0] = start; parent[start] = start;
  while (read < write && parent[end] < 0) {
    const current = queue[read++];
    const x = current % graph.width, z = Math.floor(current / graph.width);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, next = nz * graph.width + nx;
      if (nx < 0 || nz < 0 || nx >= graph.width || nz >= graph.depth
        || !graph.walk[next] || parent[next] >= 0) continue;
      parent[next] = current; queue[write++] = next;
    }
  }
  if (parent[end] < 0) return [];
  const path = [];
  for (let node = end; node !== start; node = parent[node]) {
    path.push({ x: (node % graph.width) * CELL + 0.5, y: graph.floor + 0.02,
      z: Math.floor(node / graph.width) * CELL + 0.5 });
  }
  return path.reverse();
}

export function navigationWaypoint(world, from, to, brain, now) {
  if (!world.meta?.navigationFloor || !to) return to;
  let route = brain.groundRoute;
  if (!route || now >= route.until || Math.hypot(to.x - route.target.x, to.z - route.target.z) > 6
    || Math.hypot(from.x - route.last.x, from.z - route.last.z) > 12) {
    route = brain.groundRoute = { target: { ...to }, points: groundRoute(world, from, to),
      until: now + 2000, last: { x: from.x, z: from.z } };
  }
  route.last = { x: from.x, z: from.z };
  while (route.points.length && Math.hypot(route.points[0].x - from.x, route.points[0].z - from.z) < 0.8) {
    route.points.shift();
  }
  return route.points[0] || to;
}
