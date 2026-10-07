// Static planning helpers shared by the Frontier site modules and the map
// metadata: road clearance, footprint tests and deterministic spawn picking.
// Nothing here touches voxels or builds the terrain.

import { FRONTIER_ROAD_PLAN } from '../frontier-terrain.js';

export const rect = (minX, minZ, maxX, maxZ, extra = {}) => Object.freeze({ minX, minZ, maxX, maxZ, ...extra });
export const inRect = (r, x, z, margin = 0) => x >= r.minX - margin && x <= r.maxX + 1 + margin && z >= r.minZ - margin && z <= r.maxZ + 1 + margin;

function segmentDistance(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / len2)) : 0;
  return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t);
}

/** Distance from (x, z) to the nearest road edge (negative on the road). */
export function roadClearance(x, z) {
  let best = Infinity;
  for (const road of FRONTIER_ROAD_PLAN) {
    for (let i = 1; i < road.points.length; i++) {
      best = Math.min(best, segmentDistance(x, z, road.points[i - 1], road.points[i]) - road.width / 2);
    }
  }
  return best;
}

/**
 * Twelve dry, open spawn cells around a flag: rings at the given radii,
 * clear of footprints and roads, spread by taking every k-th candidate.
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
