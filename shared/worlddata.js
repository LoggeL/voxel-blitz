// Stable public facade for the shared voxel-world implementation.
// Keep callers on this module while the implementation remains split by
// responsibility under shared/world/.

export {
  AIR,
  GRASS,
  DIRT,
  STONE,
  SAND,
  WOOD,
  LEAVES,
  CONCRETE,
  METAL,
  ACCENT,
  PLANK,
  GLASS,
  PALE,
  BLOCK_HP,
  SX,
  SZ,
  SY,
  GROUND,
  SEED,
} from './world/blocks.js';

export { ladderContact } from './world/state.js';

export {
  MAP_IDS,
  getBlock,
  setBlock,
  heightAt,
  findSpawns,
  serializeWorld,
  deserializeWorld,
  rebuildHeightMap,
  generateWorld,
  getMapMeta,
  createMapState,
  createWorldState,
} from './world/templates.js';
