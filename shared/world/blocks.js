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

/** Damage points required to break each destructible block type. */
export const BLOCK_HP = {
  [GLASS]: 6,
  [LEAVES]: 10,
  [PLANK]: 30,
  [ACCENT]: 45,
};

/** Blast resistance. Finite entries can be removed by a close grenade blast. */
export const GRENADE_RESISTANCE = Object.freeze({
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
  [GLASS]: 1, [LEAVES]: 1, [SAND]: 2, [DIRT]: 2, [GRASS]: 2,
  [PLANK]: 3, [WOOD]: 4, [ACCENT]: 4, [BRICK]: 5,
  [STONE]: 6, [PALE]: 6, [RUST]: 7, [CONCRETE]: 8, [METAL]: 12,
});
