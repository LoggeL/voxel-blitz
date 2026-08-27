import {
  AIR,
  STONE,
  CONCRETE,
  METAL,
  ACCENT,
  PALE,
  SX,
  SZ,
  SY,
  GROUND,
} from './blocks.js';

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

export function addSymmetricBox(world, x0, y0, z0, x1, y1, z1, type) {
  fillBox(world, x0, y0, z0, x1, y1, z1, type);
  fillBox(world, SX - 1 - x1, y0, SZ - 1 - z1, SX - 1 - x0, y1, SZ - 1 - z0, type);
}

export function generateDepotInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);

  paintFloor(world, 52, 34, 75, 61, GROUND, PALE);
  for (let x = 55; x <= 72; x += 4) {
    world.setBlock(x, GROUND, 34, ACCENT);
    world.setBlock(SX - 1 - x, GROUND, 61, ACCENT);
  }

  // West/east loading bases and their exits are exact 180-degree counterparts.
  addSymmetricBox(world, 7, GROUND + 1, 25, 9, GROUND + 5, 42, METAL);
  addSymmetricBox(world, 7, GROUND + 1, 53, 9, GROUND + 5, 70, METAL);
  addSymmetricBox(world, 10, GROUND + 1, 25, 23, GROUND + 3, 27, STONE);
  addSymmetricBox(world, 10, GROUND + 1, 68, 23, GROUND + 3, 70, STONE);
  addSymmetricBox(world, 21, GROUND + 1, 38, 23, GROUND + 4, 44, ACCENT);

  buildSymmetricContainer(world, 29, 17, 39, 23);
  buildSymmetricContainer(world, 31, 68, 41, 75);
  buildSymmetricContainer(world, 44, 25, 52, 30, 2);
  buildSymmetricContainer(world, 43, 44, 50, 48, 2);

  // Low central monument: useful cover without sealing the plaza.
  fillBox(world, 61, GROUND + 1, 45, 66, GROUND + 2, 50, METAL);
  addSymmetricBox(world, 57, GROUND + 1, 39, 58, GROUND + 1, 40, ACCENT);
  addSymmetricBox(world, 69, GROUND + 1, 39, 70, GROUND + 1, 40, ACCENT);
}

export function generateCitadelInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);

  // Northwest A courtyard with offset south/east exits.
  fillBox(world, 13, GROUND + 1, 11, 43, GROUND + 4, 13, STONE);
  fillBox(world, 13, GROUND + 1, 11, 15, GROUND + 4, 41, STONE);
  fillBox(world, 13, GROUND + 1, 39, 24, GROUND + 4, 41, STONE);
  fillBox(world, 33, GROUND + 1, 39, 43, GROUND + 4, 41, STONE);
  fillBox(world, 41, GROUND + 1, 11, 43, GROUND + 4, 23, STONE);
  fillBox(world, 41, GROUND + 1, 30, 43, GROUND + 4, 41, STONE);
  paintFloor(world, 21, 18, 34, 30, GROUND, PALE);
  for (let x = 21; x <= 34; x += 3) world.setBlock(x, GROUND, 18, ACCENT);

  // The keep blocks the direct A-to-B angle. Its offset doors form a zigzag
  // connector, while open north and south rotations remain available.
  fillBox(world, 48, GROUND + 1, 27, 51, GROUND + 6, 51, METAL);
  fillBox(world, 48, GROUND + 1, 59, 51, GROUND + 6, 65, METAL);
  fillBox(world, 75, GROUND + 1, 27, 78, GROUND + 6, 34, METAL);
  fillBox(world, 75, GROUND + 1, 42, 78, GROUND + 6, 65, METAL);
  fillBox(world, 48, GROUND + 1, 27, 78, GROUND + 6, 30, STONE);
  fillBox(world, 48, GROUND + 1, 62, 78, GROUND + 6, 65, STONE);
  fillBox(world, 61, GROUND + 1, 30, 65, GROUND + 5, 52, CONCRETE);
  fillBox(world, 52, GROUND + 1, 42, 58, GROUND + 2, 45, ACCENT);
  fillBox(world, 68, GROUND + 1, 49, 74, GROUND + 2, 52, ACCENT);

  // B is a raised eastern compound with two stair connectors.
  fillBox(world, 88, GROUND + 1, 34, 113, GROUND + 3, 63, CONCRETE);
  fillBox(world, 88, GROUND + 4, 34, 90, GROUND + 7, 51, METAL);
  fillBox(world, 88, GROUND + 4, 59, 90, GROUND + 7, 63, METAL);
  fillBox(world, 88, GROUND + 4, 34, 113, GROUND + 6, 36, STONE);
  fillBox(world, 111, GROUND + 4, 34, 113, GROUND + 6, 63, STONE);
  fillBox(world, 88, GROUND + 4, 61, 101, GROUND + 6, 63, STONE);
  fillBox(world, 109, GROUND + 4, 61, 113, GROUND + 6, 63, STONE);
  paintFloor(world, 97, 42, 108, 54, GROUND + 3, PALE);
  for (let z = 42; z <= 54; z += 3) world.setBlock(108, GROUND + 3, z, ACCENT);
  buildRampX(world, 82, 87, 52, 58);
  buildRampZ(world, 64, 69, 102, 108);

  // Route markers make the long north/south connectors readable at speed.
  for (const [x, z] of [[45,19],[63,19],[81,19],[45,76],[63,76],[81,76]])
    fillBox(world, x, GROUND + 1, z, x, GROUND + 3, z, ACCENT);
}

function buildContainer(world, x0, z0, x1, z1, height = 3) {
  fillBox(world, x0, GROUND + 1, z0, x1, GROUND + height, z1, METAL);
  const stripeY = GROUND + Math.min(2, height);
  for (let x = x0; x <= x1; x++) {
    world.setBlock(x, stripeY, z0, ACCENT);
    world.setBlock(x, stripeY, z1, ACCENT);
  }
}

function buildSymmetricContainer(world, x0, z0, x1, z1, height = 3) {
  buildContainer(world, x0, z0, x1, z1, height);
  buildContainer(world, SX - 1 - x1, SZ - 1 - z1, SX - 1 - x0, SZ - 1 - z0, height);
}

function buildRampX(world, x0, x1, z0, z1) {
  for (let x = x0; x <= x1; x++) {
    const top = GROUND + Math.floor((x - x0 + 1) / 2);
    fillBox(world, x, GROUND + 1, z0, x, top, z1, PALE);
  }
}

function buildRampZ(world, z0, z1, x0, x1) {
  for (let z = z0; z <= z1; z++) {
    const top = GROUND + Math.floor((z1 - z + 1) / 2);
    fillBox(world, x0, GROUND + 1, z, x1, top, z, PALE);
  }
}
