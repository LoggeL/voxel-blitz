import { SX, SY, SZ } from './blocks.js';

export const DEFAULT_DIMENSIONS = Object.freeze({ sx: SX, sy: SY, sz: SZ });
export const LARGE_DIMENSIONS = Object.freeze({ sx: 192, sy: SY, sz: 144 });

/** Authored extents. Legacy maps keep their original voxel scale and footprint. */
export function getMapDimensions(mapId) {
  return mapId === 'harbor' || mapId === 'canyon' ? LARGE_DIMENSIONS : DEFAULT_DIMENSIONS;
}

export function worldDimensions(world) {
  return world?.dimensions || world?.meta?.dimensions || DEFAULT_DIMENSIONS;
}
