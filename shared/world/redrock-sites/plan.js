// Static planning helpers for the Redrock Canyon sites (the Redrock twin of
// shared/world/frontier-sites/plan.js): road clearance against Redrock's own
// roads, deterministic spawn picking and a ground wall that keeps every road
// open. Nothing here touches voxels or builds the terrain.

import { REDROCK_ROAD_PLAN } from '../redrock-terrain.js';
import { lineCells } from '../frontier-sites/props.js';
import { MC_WATER } from '../blocks.js';

export { rect, inRect } from '../frontier-sites/plan.js';
import { inRect } from '../frontier-sites/plan.js';

function segmentDistance(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / len2)) : 0;
  return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t);
}

/** Distance from (x, z) to the nearest Redrock road edge (negative on the road). */
export function roadClearance(x, z) {
  let best = Infinity;
  for (const road of REDROCK_ROAD_PLAN) {
    for (let i = 1; i < road.points.length; i++) {
      best = Math.min(best, segmentDistance(x, z, road.points[i - 1], road.points[i]) - road.width / 2);
    }
  }
  return best;
}

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
export function pickSpawnCells(cx, cz, { exclude = [], count = 12, radii = [10, 14, 18], roadMargin = 1.5, minGap = 4, accept = () => true } = {}) {
  const candidates = [];
  for (const r of radii) {
    for (let a = 0; a < 48; a++) {
      const angle = (a / 48) * Math.PI * 2 + r * 0.13;
      const x = Math.floor(cx + Math.cos(angle) * r) + 0.5, z = Math.floor(cz + Math.sin(angle) * r) + 0.5;
      if (exclude.some(e => inRect(e, x, z, 1.5))) continue;
      if (roadClearance(x, z) < roadMargin) continue;
      if (!accept(x, z)) continue;
      candidates.push({ x, z, angle: Math.atan2(z - cz, x - cx), r });
    }
  }
  candidates.sort((p, q) => p.angle - q.angle || p.r - q.r);
  const picked = [];
  for (let gap = Math.max(minGap, 8); picked.length < count && gap >= minGap; gap -= 1) {
    for (const c of candidates) {
      if (picked.length >= count) break;
      if (picked.some(p => Math.hypot(p.x - c.x, p.z - c.z) < gap)) continue;
      picked.push(c);
    }
  }
  if (picked.length < count) throw new Error(`only ${picked.length} spawn cells near ${cx},${cz}`);
  return Object.freeze(picked.slice(0, count).map(({ x, z }) => Object.freeze([x, z])));
}

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
