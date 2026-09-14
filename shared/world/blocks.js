export const AIR = 0;
export const GRASS = 1;
export const DIRT = 2;
export const STONE = 3;
export const SAND = 4;
export const WOOD = 5;
export const LEAVES = 6;
export const CONCRETE = 7;
export const METAL = 8;
export const ACCENT = 9;
export const PLANK = 10;
export const GLASS = 11;
export const PALE = 12;
export const RUST = 13;
export const BRICK = 14;
export const YELLOW_SIDING = 15;
export const TEAL_SIDING = 16;
export const ASPHALT = 17;
export const ROOF = 18;
export const BUS_YELLOW = 19;
export const TRUCK_RED = 20;
export const DUST_SANDSTONE = 21;
export const DUST_PLASTER = 22;
export const DUST_ROCK = 23;
export const DUST_FLOOR = 24;
export const DUST_TRIM = 25;
export const DUST_TILE = 26;
export const DUST_CRATE = 27;
export const DUST_WOOD = 28;
export const BEDROCK = 29;
// MINECRAFT B5 materials (ids 30-35 are retired). The island is compiled from
// ttt_minecraft_b5.bsp by tools/compile-minecraft-b5-reference.py.
export const MC_GRASS = 36;
export const MC_DIRT = 37;
export const MC_STONE = 38;
export const MC_COBBLE = 39;
export const MC_MOSSY = 40;
export const MC_SAND = 41;
export const MC_GRAVEL = 42;
export const MC_CLAY = 43;
export const MC_LOG = 44;
export const MC_LEAVES = 45;
export const MC_PLANKS = 46;
export const MC_GLASS = 47;
export const MC_BRICK = 48;
export const MC_BOOKSHELF = 49;
export const MC_WOOL_WHITE = 50;
export const MC_WOOL_RED = 51;
export const MC_IRON = 52;
export const MC_GOLD = 53;
export const MC_DIAMOND = 54;
export const MC_DIAMOND_ORE = 55;
export const MC_COAL_ORE = 56;
export const MC_OBSIDIAN = 57;
export const MC_NETHERRACK = 58;
export const MC_GLOWSTONE = 59;
export const MC_CLOUD = 60;
export const MC_CACTUS = 61;
export const MC_CHEST = 62;
export const MC_FURNACE = 63;
export const MC_CRAFTING = 64;
export const MC_TNT = 65;
// Fluids and the portal film are walk-through volumes with their own rules.
export const MC_WATER = 66;
export const MC_LAVA = 67;
export const MC_PORTAL = 68;
// Fake blocks (Source func_illusionary): rendered like the real material, but
// players, bots and bullets pass through them. Secret passages depend on them.
export const MC_GHOST_GRASS = 69;
export const MC_GHOST_PLANKS = 70;
export const MC_GHOST_STONE = 71;
export const MC_GHOST_WOOL_WHITE = 72;
export const MC_GHOST_GLOWSTONE = 73;
export const MC_GHOST_NETHERRACK = 74;
export const MC_GHOST_WOOL_RED = 75;
export const MC_GHOST_BOOKSHELF = 76;
export const MC_GHOST_DIRT = 77;
export const MC_GHOST_LOG = 78;

/** Ghost block -> the solid material it imitates (shared by textures and balance). */
export const MC_GHOST_SOLID = Object.freeze({
  [MC_GHOST_GRASS]: MC_GRASS, [MC_GHOST_PLANKS]: MC_PLANKS, [MC_GHOST_STONE]: MC_STONE,
  [MC_GHOST_WOOL_WHITE]: MC_WOOL_WHITE, [MC_GHOST_GLOWSTONE]: MC_GLOWSTONE,
  [MC_GHOST_NETHERRACK]: MC_NETHERRACK, [MC_GHOST_WOOL_RED]: MC_WOOL_RED,
  [MC_GHOST_BOOKSHELF]: MC_BOOKSHELF, [MC_GHOST_DIRT]: MC_DIRT, [MC_GHOST_LOG]: MC_LOG,
});
export const FLUID_BLOCKS = Object.freeze(new Set([MC_WATER, MC_LAVA]));
/** Block types that never collide with players, bots, bullets or projectiles. */
export const PASSABLE_BLOCKS = Object.freeze(new Set([
  AIR, MC_WATER, MC_LAVA, MC_PORTAL, ...Object.keys(MC_GHOST_SOLID).map(Number),
]));
export function isSolidBlock(type) {
  return !PASSABLE_BLOCKS.has(type);
}

const MC_BALANCE = Object.freeze({
  //            hp  hardness blast mining
  [MC_GRASS]: [100, 24, 20, 2], [MC_DIRT]: [100, 24, 24, 2], [MC_STONE]: [320, 90, 92, 6],
  [MC_COBBLE]: [300, 85, 90, 6], [MC_MOSSY]: [300, 85, 90, 6], [MC_SAND]: [70, 16, 16, 2],
  [MC_GRAVEL]: [80, 20, 18, 2], [MC_CLAY]: [120, 30, 30, 3], [MC_LOG]: [160, 40, 48, 4],
  [MC_LEAVES]: [10, 2, 8, 1], [MC_PLANKS]: [90, 30, 40, 3], [MC_GLASS]: [6, 5, 6, 1],
  [MC_BRICK]: [260, 70, 84, 5], [MC_BOOKSHELF]: [90, 30, 40, 3], [MC_WOOL_WHITE]: [40, 12, 20, 2],
  [MC_WOOL_RED]: [40, 12, 20, 2], [MC_IRON]: [600, 150, 160, 12], [MC_GOLD]: [500, 120, 140, 10],
  [MC_DIAMOND]: [700, 160, 180, 14], [MC_DIAMOND_ORE]: [400, 100, 110, 8],
  [MC_COAL_ORE]: [340, 90, 96, 7], [MC_OBSIDIAN]: [900, 200, 220, 20],
  [MC_NETHERRACK]: [200, 60, 60, 4], [MC_GLOWSTONE]: [60, 15, 24, 2], [MC_CLOUD]: [20, 1, 8, 1],
  [MC_CACTUS]: [40, 10, 16, 1], [MC_CHEST]: [90, 30, 40, 3], [MC_FURNACE]: [300, 90, 90, 6],
  [MC_CRAFTING]: [90, 30, 40, 3], [MC_TNT]: [60, 15, 20, 2],
});
const mcTable = (column) => Object.fromEntries([
  ...Object.entries(MC_BALANCE).map(([type, row]) => [type, row[column]]),
  ...Object.entries(MC_GHOST_SOLID).map(([ghost, solid]) => [ghost, MC_BALANCE[solid][column]]),
]);

/** Damage points required to break each destructible block type. */
export const BLOCK_HP = {
  [GRASS]: 100, [DIRT]: 100, [SAND]: 70, [WOOD]: 120,
  [STONE]: 320, [CONCRETE]: 420, [METAL]: 600, [PALE]: 320,
  [RUST]: 360, [BRICK]: 220, [ASPHALT]: 300, [ROOF]: 180,
  [BUS_YELLOW]: 420, [TRUCK_RED]: 420,
  [DUST_SANDSTONE]: 280, [DUST_PLASTER]: 220, [DUST_ROCK]: 380,
  [DUST_FLOOR]: 340, [DUST_TRIM]: 280, [DUST_TILE]: 200,
  [YELLOW_SIDING]: 45, [TEAL_SIDING]: 45,
  [GLASS]: 6,
  [LEAVES]: 10,
  [PLANK]: 30,
  [ACCENT]: 45,
  [DUST_CRATE]: 65,
  [DUST_WOOD]: 85,
  ...mcTable(0),
};

/** Penetration power spent crossing one voxel at normal incidence. */
export const BLOCK_HARDNESS = Object.freeze({
  [BEDROCK]: Infinity,
  [GRASS]: 24, [DIRT]: 24, [STONE]: 90, [SAND]: 16,
  [WOOD]: 32, [LEAVES]: 2, [CONCRETE]: 110, [METAL]: 150,
  [ACCENT]: 28, [PLANK]: 18, [GLASS]: 5, [PALE]: 90,
  [RUST]: 105, [BRICK]: 65, [YELLOW_SIDING]: 22, [TEAL_SIDING]: 22,
  [ASPHALT]: 85, [ROOF]: 50, [BUS_YELLOW]: 120, [TRUCK_RED]: 120,
  [DUST_SANDSTONE]: 75, [DUST_PLASTER]: 60, [DUST_ROCK]: 100,
  [DUST_FLOOR]: 95, [DUST_TRIM]: 75, [DUST_TILE]: 55,
  [DUST_CRATE]: 25, [DUST_WOOD]: 32,
  ...mcTable(1),
  [MC_WATER]: 8, [MC_LAVA]: 8, [MC_PORTAL]: 0,
});

/** Blast resistance. Finite entries can be removed by a close grenade blast. */
export const GRENADE_RESISTANCE = Object.freeze({
  [BEDROCK]: Infinity,
  [YELLOW_SIDING]: 52, [TEAL_SIDING]: 52, [ASPHALT]: 112,
  [ROOF]: 82, [BUS_YELLOW]: 160, [TRUCK_RED]: 160,
  [GRASS]: 20,
  [DIRT]: 24,
  [STONE]: 92,
  [SAND]: 16,
  [WOOD]: 42,
  [LEAVES]: 8,
  [CONCRETE]: 112,
  [METAL]: Infinity,
  [ACCENT]: 52,
  [PLANK]: 28,
  [GLASS]: 6,
  [PALE]: 94,
  [RUST]: 68,
  [BRICK]: 82,
  [DUST_SANDSTONE]: 100,
  [DUST_PLASTER]: 105,
  [DUST_ROCK]: 110,
  [DUST_FLOOR]: 112,
  [DUST_TRIM]: 100,
  [DUST_TILE]: 94,
  [DUST_CRATE]: 62,
  [DUST_WOOD]: 72,
  ...mcTable(2),
  [MC_WATER]: Infinity, [MC_LAVA]: Infinity, [MC_PORTAL]: Infinity,
});

export const SX = 128;
export const SZ = 96;
export const SY = 40;
export const GROUND = 14;
export const SEED = 20260826;

/** Convert an in-bounds voxel coordinate to the world's y/z/x byte layout. */
export const idx = (x, y, z) => ((y * SZ) + z) * SX + x;

/** Accepted pickaxe swings per block; independent of bullet damage. */
export const MINING_HITS = Object.freeze({
  [YELLOW_SIDING]: 4, [TEAL_SIDING]: 4, [ASPHALT]: 8,
  [ROOF]: 5, [BUS_YELLOW]: 10, [TRUCK_RED]: 10,
  [GLASS]: 1, [LEAVES]: 1, [SAND]: 2, [DIRT]: 2, [GRASS]: 2,
  [PLANK]: 3, [WOOD]: 4, [ACCENT]: 4, [BRICK]: 5,
  [STONE]: 6, [PALE]: 6, [RUST]: 7, [CONCRETE]: 8, [METAL]: 12,
  [DUST_SANDSTONE]: 7, [DUST_PLASTER]: 7, [DUST_ROCK]: 8,
  [DUST_FLOOR]: 8, [DUST_TRIM]: 7, [DUST_TILE]: 6,
  [DUST_CRATE]: 5, [DUST_WOOD]: 6,
  ...mcTable(3),
});
