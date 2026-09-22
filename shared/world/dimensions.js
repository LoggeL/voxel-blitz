import { SX, SY, SZ } from './blocks.js';

export const DEFAULT_DIMENSIONS = Object.freeze({ sx: SX, sy: SY, sz: SZ });
export const LARGE_DIMENSIONS = Object.freeze({ sx: 192, sy: SY, sz: 144 });
/** Minecraft B5 stacks the Nether under the island and the lighthouse above it. */
export const TALL_DIMENSIONS = Object.freeze({ sx: SX, sy: 88, sz: SZ });
/** Leith Waterworld: the whole leisure centre and its foyer at 32 Source units per voxel. */
export const WATERWORLD_DIMENSIONS = Object.freeze({ sx: 200, sy: 36, sz: 188 });
export const KNOWN_DIMENSIONS = Object.freeze([DEFAULT_DIMENSIONS, LARGE_DIMENSIONS, TALL_DIMENSIONS, WATERWORLD_DIMENSIONS]);

/** Authored extents. Legacy maps keep their original voxel scale and footprint. */
export function getMapDimensions(mapId) {
  if (mapId === 'harbor' || mapId === 'canyon' || mapId === 'causeway') return LARGE_DIMENSIONS;
  if (mapId === 'minecraft_b5') return TALL_DIMENSIONS;
  if (mapId === 'waterworld') return WATERWORLD_DIMENSIONS;
  return DEFAULT_DIMENSIONS;
}

export function worldDimensions(world) {
  return world?.dimensions || world?.meta?.dimensions || DEFAULT_DIMENSIONS;
}
