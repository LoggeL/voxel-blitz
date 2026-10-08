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
// LEITH WATERWORLD materials (ttt_waterworld replica, compiled by
// tools/compile-waterworld-reference.py): pool tiles, deck tiles and the flumes.
export const POOL_TILE_BLUE = 79;
export const POOL_TILE_WHITE = 80;
export const POOL_FLOOR = 81;
export const SLIDE_BLUE = 82;
export const SLIDE_YELLOW = 83;
export const POOL_PANEL = 84;
// Bastion fortifications (sandbag lines and barricade walls built between waves).
export const BARRICADE = 85;
// Bikini Bottom seafloor town: sand, coral, the pineapple rind and crown,
// kelp, moai stone, reef rock, boat hull planks, riveted chum steel and road.
export const BB_SAND = 86;
export const BB_CORAL = 87;
export const BB_PINEAPPLE = 88;
export const BB_PINE_LEAF = 89;
export const BB_KELP = 90;
export const BB_MOAI = 91;
export const BB_ROCK = 92;
export const BB_HULL = 93;
export const BB_CHUM = 94;
export const BB_ROAD = 95;
// Frontier v2 valley: meadow and field tops, river mud, scorched crater
// floors, gravel tracks, forest floor and foliage, and the village, farm and
// works facades (shared/world/frontier-sites/).
export const MEADOW = 96;
export const DRY_GRASS = 97;
export const FIELD_WHEAT = 98;
export const MUD = 99;
export const SCORCHED_EARTH = 100;
export const GRAVEL = 101;
export const PINE_NEEDLES = 102;
export const PINE_LEAVES = 103;
export const BIRCH_LOG = 104;
export const WHITE_PLASTER = 105;
export const TERRACOTTA_ROOF = 106;
export const COBBLE_WALL = 107;
export const TIMBER = 108;
export const CORRUGATED_STEEL = 109;
export const SOOT_BRICK = 110;

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
// Lookup table for the voxel ids a world stores (0..255): raycasts and
// collision ask this per crossed cell, so it avoids a Set lookup per voxel.
const SOLID_TABLE = new Uint8Array(256);
for (let id = 0; id < 256; id++) SOLID_TABLE[id] = PASSABLE_BLOCKS.has(id) ? 0 : 1;
export function isSolidBlock(type) {
  // Integer ids 0..255 read the table; anything else keeps the Set's answer.
  if ((type & 255) === type) return SOLID_TABLE[type] === 1;
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
const FRONTIER_BALANCE = Object.freeze({
  //                 hp  hardness blast mining
  [MEADOW]:          [100, 24, 20, 2], [DRY_GRASS]: [100, 24, 20, 2], [FIELD_WHEAT]: [90, 20, 18, 2],
  [MUD]:             [90, 20, 22, 2], [SCORCHED_EARTH]: [110, 26, 24, 2], [GRAVEL]: [80, 20, 18, 2],
  [PINE_NEEDLES]:    [100, 24, 20, 2], [PINE_LEAVES]: [10, 2, 8, 1], [BIRCH_LOG]: [120, 32, 42, 4],
  [WHITE_PLASTER]:   [220, 60, 90, 6], [TERRACOTTA_ROOF]: [180, 50, 82, 5], [COBBLE_WALL]: [300, 85, 96, 6],
  [TIMBER]:          [140, 32, 46, 4], [CORRUGATED_STEEL]: [300, 90, 70, 7], [SOOT_BRICK]: [240, 70, 84, 5],
});
const frontierTable = (column) => Object.fromEntries(Object.entries(FRONTIER_BALANCE).map(([type, row]) => [type, row[column]]));
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
  [POOL_TILE_BLUE]: 200, [POOL_TILE_WHITE]: 200, [POOL_FLOOR]: 240,
  [SLIDE_BLUE]: 90, [SLIDE_YELLOW]: 90, [POOL_PANEL]: 420,
  [BARRICADE]: 480,
  [BB_SAND]: 70, [BB_CORAL]: 220, [BB_PINEAPPLE]: 120, [BB_PINE_LEAF]: 30, [BB_KELP]: 10,
  [BB_MOAI]: 320, [BB_ROCK]: 380, [BB_HULL]: 110, [BB_CHUM]: 420, [BB_ROAD]: 300,
  ...frontierTable(0),
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
  [POOL_TILE_BLUE]: 55, [POOL_TILE_WHITE]: 55, [POOL_FLOOR]: 70, [SLIDE_BLUE]: 22, [SLIDE_YELLOW]: 22, [POOL_PANEL]: 110,
  [BARRICADE]: 120,
  [BB_SAND]: 16, [BB_CORAL]: 65, [BB_PINEAPPLE]: 32, [BB_PINE_LEAF]: 8, [BB_KELP]: 4,
  [BB_MOAI]: 90, [BB_ROCK]: 100, [BB_HULL]: 30, [BB_CHUM]: 110, [BB_ROAD]: 85,
  ...frontierTable(1),
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
  [POOL_TILE_BLUE]: 94, [POOL_TILE_WHITE]: 94, [POOL_FLOOR]: 100, [SLIDE_BLUE]: 40, [SLIDE_YELLOW]: 40, [POOL_PANEL]: 130,
  [BARRICADE]: 180,   // rockets (210) and pulse (200) carve it; frags (165) do not
  [BB_SAND]: 16, [BB_CORAL]: 82, [BB_PINEAPPLE]: 42, [BB_PINE_LEAF]: 10, [BB_KELP]: 6,
  [BB_MOAI]: 110, [BB_ROCK]: 120, [BB_HULL]: 40, [BB_ROAD]: 112,
  [BB_CHUM]: 140,     // rockets (210) and frags (165) breach the bucket
  // Grass-like ground (20-24) craters like GRASS; METAL stays infinite.
  ...frontierTable(2),
  ...mcTable(2),
  [MC_WATER]: Infinity, [MC_LAVA]: Infinity, [MC_PORTAL]: Infinity,
});

/**
 * What a ground hull can drive through (VEHICLE_RAM in shared/vehicle-defs.js
 * gives each hull's speed per class). Anything missing here never breaks by
 * ramming: terrain, stone, concrete, metal, sandbags, bedrock and bridges.
 */
export const RAM_CLASS = Object.freeze({
  // Hedges, foliage and glass.
  [LEAVES]: 'brush', [PINE_LEAVES]: 'brush', [MC_LEAVES]: 'brush', [BB_PINE_LEAF]: 'brush', [BB_KELP]: 'brush',
  [GLASS]: 'brush', [MC_GLASS]: 'brush',
  // Fences, planks, crates and wooden props.
  [PLANK]: 'wood', [MC_PLANKS]: 'wood', [TIMBER]: 'wood', [DUST_CRATE]: 'wood', [DUST_WOOD]: 'wood',
  [MC_BOOKSHELF]: 'wood', [MC_CHEST]: 'wood', [MC_CRAFTING]: 'wood', [BB_HULL]: 'wood',
  // Thin painted siding walls.
  [YELLOW_SIDING]: 'thin', [TEAL_SIDING]: 'thin', [ACCENT]: 'thin',
  // Plaster, brick and roof tiles (a tank at speed).
  [WHITE_PLASTER]: 'masonry', [DUST_PLASTER]: 'masonry', [BRICK]: 'masonry', [SOOT_BRICK]: 'masonry',
  [MC_BRICK]: 'masonry', [TERRACOTTA_ROOF]: 'masonry', [ROOF]: 'masonry',
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
  [POOL_TILE_BLUE]: 6, [POOL_TILE_WHITE]: 6, [POOL_FLOOR]: 7, [SLIDE_BLUE]: 3, [SLIDE_YELLOW]: 3, [POOL_PANEL]: 9,
  [BARRICADE]: 6,
  [BB_SAND]: 2, [BB_CORAL]: 5, [BB_PINEAPPLE]: 4, [BB_PINE_LEAF]: 1, [BB_KELP]: 1,
  [BB_MOAI]: 7, [BB_ROCK]: 8, [BB_HULL]: 3, [BB_CHUM]: 8, [BB_ROAD]: 8,
  ...frontierTable(3),
  ...mcTable(3),
});

/**
 * Structural integrity (docs/structural-physics.md). Natural ground is an
 * anchor: it never needs support and supports what rests on it. Every other
 * solid block draws support from the ground: losslessly straight up, and
 * losing one step per sideways (or hanging) block, so `span` is how many
 * blocks a material reaches out from the last supported block. Passable
 * blocks (air, fluids, ghosts) neither need nor give support.
 */
export const STRUCTURE_GROUND = Object.freeze(new Set([
  BEDROCK, GRASS, DIRT, STONE, SAND, DUST_ROCK,
  MC_GRASS, MC_DIRT, MC_STONE, MC_SAND, MC_GRAVEL, MC_CLAY, MC_NETHERRACK, MC_COAL_ORE, MC_DIAMOND_ORE,
  BB_SAND, BB_ROCK,
  MEADOW, DRY_GRASS, FIELD_WHEAT, MUD, SCORCHED_EARTH, GRAVEL, PINE_NEEDLES,
]));
/**
 * Structural material classes: `span` sideways/hanging blocks (0 = rests only
 * on the block below, like today's fragile glass), `density` for falling-chunk
 * mass (crush damage), `rubble` whether a landed chunk leaves blocks behind.
 */
export const STRUCTURE_MATERIALS = Object.freeze({
  glass: Object.freeze({ span: 0, density: 0.3, rubble: false }),
  foliage: Object.freeze({ span: 4, density: 0.1, rubble: false }),
  wood: Object.freeze({ span: 4, density: 0.5, rubble: true }),
  thin: Object.freeze({ span: 3, density: 0.4, rubble: true }),
  masonry: Object.freeze({ span: 6, density: 1, rubble: true }),
  heavy: Object.freeze({ span: 10, density: 1.5, rubble: true }),
});
/** Material class per structural block; unlisted solid non-ground blocks are masonry. */
export const STRUCTURE_CLASS = Object.freeze({
  [GLASS]: 'glass', [MC_GLASS]: 'glass',
  [LEAVES]: 'foliage', [PINE_LEAVES]: 'foliage', [MC_LEAVES]: 'foliage', [BB_PINE_LEAF]: 'foliage',
  [BB_KELP]: 'foliage', [MC_CACTUS]: 'foliage', [MC_CLOUD]: 'foliage',
  [WOOD]: 'wood', [PLANK]: 'wood', [DUST_WOOD]: 'wood', [DUST_CRATE]: 'wood', [MC_LOG]: 'wood',
  [MC_PLANKS]: 'wood', [MC_BOOKSHELF]: 'wood', [MC_CHEST]: 'wood', [MC_CRAFTING]: 'wood', [TIMBER]: 'wood',
  [BIRCH_LOG]: 'wood', [BB_HULL]: 'wood', [BB_PINEAPPLE]: 'wood', [SLIDE_BLUE]: 'wood', [SLIDE_YELLOW]: 'wood',
  [MC_WOOL_WHITE]: 'wood', [MC_WOOL_RED]: 'wood',
  [YELLOW_SIDING]: 'thin', [TEAL_SIDING]: 'thin', [ACCENT]: 'thin',
  [CONCRETE]: 'heavy', [METAL]: 'heavy', [RUST]: 'heavy', [ASPHALT]: 'heavy', [BUS_YELLOW]: 'heavy',
  [TRUCK_RED]: 'heavy', [POOL_FLOOR]: 'heavy', [POOL_PANEL]: 'heavy', [CORRUGATED_STEEL]: 'heavy',
  [BB_CHUM]: 'heavy', [BB_ROAD]: 'heavy', [MC_IRON]: 'heavy', [MC_GOLD]: 'heavy', [MC_DIAMOND]: 'heavy',
});
