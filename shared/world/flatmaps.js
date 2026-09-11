import { AIR, CONCRETE, METAL, STONE, SX, SZ, SY, GROUND } from './blocks.js';

export function fillBox(world, x0, y0, z0, x1, y1, z1, type) {
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        world.setBlock(x, y, z, type);
}

export function paintFloor(world, x0, z0, x1, z1, y, type) {
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++)
      world.setBlock(x, y, z, type);
}

export function generateFlatBase(world, blocks, heights) {
  const { sx: SX, sy: SY, sz: SZ } = world.dimensions;
  blocks.fill(AIR);
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      heights[z * SX + x] = GROUND;
      for (let y = 0; y <= GROUND; y++)
        world.setBlock(x, y, z, y === GROUND ? CONCRETE : STONE);
      const edge = Math.min(x, z, SX - 1 - x, SZ - 1 - z);
      if (edge < 3) {
        const top = edge === 0 ? SY - 1 : SY - 8;
        for (let y = GROUND; y <= top; y++) world.setBlock(x, y, z, METAL);
      }
    }
  }
}

/** Place a box and its exact 180-degree rotated counterpart. */
export function mirroredBox(world, x0, y0, z0, x1, y1, z1, type) {
  const { sx: SX, sz: SZ } = world.dimensions;
  fillBox(world, x0, y0, z0, x1, y1, z1, type);
  fillBox(world, SX - 1 - x1, y0, SZ - 1 - z1, SX - 1 - x0, y1, SZ - 1 - z0, type);
}
