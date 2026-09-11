import { DEFAULT_DIMENSIONS } from '../../shared/world/dimensions.js';

/** Owned wire rows; zero progress clears an existing damaged block. */
export function copyBlockDamage(rows, dimensions = DEFAULT_DIMENSIONS) {
  const { sx: SX, sy: SY, sz: SZ } = dimensions;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row &&
    Number.isInteger(row.x) && row.x >= 0 && row.x < SX &&
    Number.isInteger(row.y) && row.y >= 0 && row.y < SY &&
    Number.isInteger(row.z) && row.z >= 0 && row.z < SZ &&
    Number.isInteger(row.v) && row.v >= 0 &&
    Number.isFinite(row.progress))
    .map(({ x, y, z, v, progress }) => ({ x, y, z, v,
      progress: Math.max(0, Math.min(1, progress)) }));
}
