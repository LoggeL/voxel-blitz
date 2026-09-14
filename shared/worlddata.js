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
  BEDROCK,
  MC_GRASS, MC_DIRT, MC_STONE, MC_COBBLE, MC_MOSSY, MC_SAND, MC_GRAVEL, MC_CLAY,
  MC_LOG, MC_LEAVES, MC_PLANKS, MC_GLASS, MC_BRICK, MC_BOOKSHELF, MC_WOOL_WHITE,
  MC_WOOL_RED, MC_IRON, MC_GOLD, MC_DIAMOND, MC_DIAMOND_ORE, MC_COAL_ORE,
  MC_OBSIDIAN, MC_NETHERRACK, MC_GLOWSTONE, MC_CLOUD, MC_CACTUS, MC_CHEST,
  MC_FURNACE, MC_CRAFTING, MC_TNT, MC_WATER, MC_LAVA, MC_PORTAL,
  MC_GHOST_GRASS, MC_GHOST_PLANKS, MC_GHOST_STONE, MC_GHOST_WOOL_WHITE,
  MC_GHOST_GLOWSTONE, MC_GHOST_NETHERRACK, MC_GHOST_WOOL_RED, MC_GHOST_BOOKSHELF,
  MC_GHOST_DIRT, MC_GHOST_LOG, MC_GHOST_SOLID, FLUID_BLOCKS, PASSABLE_BLOCKS, isSolidBlock,
  BLOCK_HP,
  BLOCK_HARDNESS,
  GRENADE_RESISTANCE,
  SX,
  SZ,
  SY,
  GROUND,
  SEED,
} from './world/blocks.js';

export { ladderContact, portalAt } from './world/state.js';

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

export { getMapDimensions, worldDimensions } from './world/dimensions.js';
