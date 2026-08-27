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

/** Damage points required to break each destructible block type. */
export const BLOCK_HP = {
  [GLASS]: 6,
  [LEAVES]: 10,
  [PLANK]: 30,
  [ACCENT]: 45,
};

export const SX = 128;
export const SZ = 96;
export const SY = 40;
export const GROUND = 14;
export const SEED = 20260826;

/** Convert an in-bounds voxel coordinate to the world's y/z/x byte layout. */
export const idx = (x, y, z) => ((y * SZ) + z) * SX + x;
