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
  RUST,
  BRICK,
  YELLOW_SIDING, TEAL_SIDING, ASPHALT, ROOF, BUS_YELLOW, TRUCK_RED,
  DUST_SANDSTONE, DUST_PLASTER, DUST_ROCK, DUST_FLOOR,
  DUST_TRIM, DUST_TILE, DUST_CRATE, DUST_WOOD,
  BLOCK_HP,
  GRENADE_RESISTANCE,
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
