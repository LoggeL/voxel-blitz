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

/** Damage points required to break each destructible block type. */
export const BLOCK_HP = {
  [YELLOW_SIDING]: 45, [TEAL_SIDING]: 45,
  [GLASS]: 6,
  [LEAVES]: 10,
  [PLANK]: 30,
  [ACCENT]: 45,
  [DUST_CRATE]: 65,
  [DUST_WOOD]: 85,
};

/** Blast resistance. Finite entries can be removed by a close grenade blast. */
export const GRENADE_RESISTANCE = Object.freeze({
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
});
