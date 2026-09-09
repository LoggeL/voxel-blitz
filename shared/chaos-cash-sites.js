import { AIR, SX, SY, SZ } from './world/blocks.js';
import { isPowerupSiteSupported } from './powerup-sites.js';

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Discover walkable hiding places once per room, starting at player spawns.
 * Flooding standing cells keeps money out of sealed rooms and unreachable roofs.
 * Current terrain support is checked again by the pickup system before spawning.
 */
export function findChaosCashSites(world, meta = world.meta) {
  const spawns = meta?.spawns?.fun || [];
  const solid = (x, y, z) => world.getBlock(x, y, z) !== AIR;
  const walkable = (x, y, z) => x > 3 && x < SX - 4 && z > 3 && z < SZ - 4
    && y > 0 && y < SY - 2 && solid(x, y - 1, z)
    && !solid(x, y, z) && !solid(x, y + 1, z);
  const queue = [], seen = new Set(), sites = [];
  const add = (x, y, z) => {
    const key = x + SX * (z + SZ * y);
    if (seen.has(key) || !walkable(x, y, z)) return;
    seen.add(key); queue.push([x, y, z]);
  };
  for (const p of spawns) add(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  for (let i = 0; i < queue.length; i++) {
    const [x, y, z] = queue[i];
    const site = { x: x + 0.5, y: y + 0.02, z: z + 0.5 };
    // Sample a grid to avoid weighting large rooms by thousands of adjacent cells.
    if (x % 3 === 0 && z % 3 === 0 && isPowerupSiteSupported(world, site)
      && spawns.every(p => Math.hypot(p.x - site.x, p.z - site.z) >= 12)) {
      const cover = DIRECTIONS.filter(([dx, dz]) => {
        for (let d = 2; d <= 5; d++) if (solid(x + dx * d, y + 1, z + dz * d)) return true;
        return false;
      }).length;
      if (cover >= 2) sites.push(site);
    }
    for (const [dx, dz] of DIRECTIONS) {
      const nx = x + dx, nz = z + dz;
      if (walkable(nx, y, nz)) add(nx, y, nz);
      else if (!solid(x, y + 2, z) && walkable(nx, y + 1, nz)) add(nx, y + 1, nz);
      else if (!solid(nx, y, nz) && !solid(nx, y + 1, nz)) {
        for (let drop = 1; drop <= 3; drop++) {
          if (walkable(nx, y - drop, nz)) { add(nx, y - drop, nz); break; }
          if (solid(nx, y - drop, nz)) break;
        }
      }
    }
  }
  return sites;
}
