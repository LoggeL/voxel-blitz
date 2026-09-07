// Voxel DDA raycast (Amanatides & Woo). Pure function of a solidity callback,
// so client (impact FX) and server (damage occlusion) share one implementation.

// Enough cell crossings to traverse the entire supported coordinate envelope.
// This is a runaway guard, never a shorter distance limit on hitscan weapons.
const MAX_STEPS = 2 * (4096 + 2048 + 2) + 512 + 2;

/**
 * Cast a ray through the voxel grid.
 * @param {(x:number,y:number,z:number)=>number|null} solidAt block getter (>0 = solid);
 *        y<0 treated as solid ground, out-of-x/z-bounds eventually terminates the walk.
 * @returns {{x,y,z,nx,ny,nz,t}|null} hit voxel coords, face normal, distance along ray.
 */
export function raycastVoxels(solidAt, ox, oy, oz, dx, dy, dz, maxDist) {
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return null;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0)) return null;
  dx /= len; dy /= len; dz /= len;

  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  let tMaxX = dx !== 0 ? (stepX > 0 ? (x + 1 - ox) : (ox - x)) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (stepY > 0 ? (y + 1 - oy) : (oy - y)) * tDeltaY : Infinity;
  let tMaxZ = dz !== 0 ? (stepZ > 0 ? (z + 1 - oz) : (oz - z)) * tDeltaZ : Infinity;

  let nx = 0, ny = 0, nz = 0, t = 0;
  for (let i = 0; i < MAX_STEPS; i++) {
    if (t > maxDist) return null;
    if (y < 0) return { x, y, z, nx, ny, nz, t }; // below-world counts as solid floor
    if (solidAt(x, y, z)) return { x, y, z, nx, ny, nz, t };

    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      if ((x < -2048 && dx < 0) || x > 4096) return null;
    } else if (tMaxY <= tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      if (y > 512 && dy > 0) return null;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      if ((z < -2048 && dz < 0) || z > 4096) return null;
    }
  }
  return null;
}
