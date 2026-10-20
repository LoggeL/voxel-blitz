// Static planning helpers for the Redrock Canyon sites (the Redrock twin of
// shared/world/frontier-sites/plan.js): road clearance against Redrock's own
// roads, deterministic spawn picking and a ground wall that keeps every road
// open. Nothing here touches voxels or builds the terrain.

import { REDROCK_ROAD_PLAN } from '../redrock-terrain.js';
import { lineCells } from '../frontier-sites/props.js';
import { MC_WATER } from '../blocks.js';
import { roadPlanClearance, segmentDistance, spawnCellsAround } from '../frontier-sites/plan.js';

export { rect, inRect } from '../frontier-sites/plan.js';

/** Distance from (x, z) to the nearest Redrock road edge (negative on the road). */
export function roadClearance(x, z) { return roadPlanClearance(REDROCK_ROAD_PLAN, x, z); }

/** Distance from (x, z) to a polyline. */
export function polylineDistance(x, z, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(x, z, points[i - 1], points[i]));
  return best;
}

/**
 * Twelve dry, open spawn cells around a flag (as Frontier's pickSpawnCells):
 * rings at the given radii, clear of footprints and Redrock's roads.
 */
export function pickSpawnCells(cx, cz, options) { return spawnCellsAround(roadClearance, cx, cz, options); }

/** A wall `height` voxels over the local ground along a polyline; Redrock's roads stay open. */
export function wall(kit, points, height, material, { gapEvery = 0, gapWidth = 3, cap = null, kind = 'wall', roads = 1 } = {}) {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    for (const [x, z] of lineCells(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])) {
      n++;
      if (gapEvery && n % gapEvery < gapWidth) continue;
      if (roads && roadClearance(x + 0.5, z + 0.5) < roads) continue;
      const g = kit.top(x, z);
      if (kit.get(x, g + 1, z) === MC_WATER) continue;
      kit.box(x, g + 1, z, x, g + height, z, material);
      if (cap) kit.set(x, g + height + 1, z, cap);
    }
  }
  kit.feature('cover', { cover: kind, points: points.map(p => [p[0], p[1]]), height });
}
