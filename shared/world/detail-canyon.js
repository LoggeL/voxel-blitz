import { AIR, DUST_FLOOR, DUST_PLASTER, DUST_ROCK, DUST_SANDSTONE, DUST_TRIM,
  DUST_WOOD, GROUND, METAL, PALE, SAND, TEAL_SIDING } from './blocks.js';
import { fillBox } from './flatmaps.js';
import { addMapLightFixtures } from './large-map-lights.js';

function dressCliffWalls(world) {
  const { sx, sy, sz } = world.dimensions;
  const paint = (x, y, z, along) => {
    if (world.getBlock(x, y, z) !== METAL) return;
    const bend = Math.floor(Math.sin(along / 13) * 2);
    const layer = (y + bend) % 13;
    world.setBlock(x, y, z, layer < 2 ? DUST_TRIM : layer < 6 ? DUST_ROCK : layer < 11 ? DUST_SANDSTONE : SAND);
  };
  for (let y = GROUND; y < sy; y++) {
    const inset = y >= sy - 7 ? 0 : 2;
    for (let x = 3; x < sx - 3; x++) for (const z of [inset, sz - 1 - inset]) paint(x, y, z, x);
    for (let z = 3; z < sz - 3; z++) for (const x of [inset, sx - 1 - inset]) paint(x, y, z, z);
  }
}

function dressExpeditionFloors(world) {
  // Small pale survey paths and dusty erosion patches have no physical lip.
  for (const x of [44, 147]) for (let z = 29; z <= 114; z++) {
    if (world.getBlock(x, GROUND + 1, z) === AIR && z % 9 < 6)
      world.setBlock(x, GROUND, z, DUST_FLOOR);
  }
  for (let z = 28; z <= 115; z++) {
    const bend = Math.round(Math.sin(z / 18) * 8);
    for (const x of [83 + bend, 107 + bend]) {
      if (world.getBlock(x, GROUND + 1, z) !== AIR) continue;
      world.setBlock(x, GROUND, z, (x + z) % 5 === 0 ? PALE : DUST_SANDSTONE);
    }
  }
}

function surveyBoard(world, x, z) {
  // Board posts sit beyond the site edges; the complete assembly is destructible.
  for (let dx = 0; dx <= 6; dx++) for (let y = GROUND + 1; y <= GROUND + 7; y++)
    if (world.getBlock(x + dx, y, z) !== AIR) return;
  for (const px of [x, x + 6]) fillBox(world, px, GROUND + 1, z, px, GROUND + 7, z, DUST_WOOD);
  fillBox(world, x + 1, GROUND + 4, z, x + 5, GROUND + 6, z, TEAL_SIDING);
  fillBox(world, x, GROUND + 7, z, x + 6, GROUND + 7, z, DUST_TRIM);
  fillBox(world, x + 1, GROUND + 4, z, x + 5, GROUND + 4, z, DUST_PLASTER);
}

export function addCanyonDetails(world) {
  dressCliffWalls(world);
  dressExpeditionFloors(world);
  surveyBoard(world, 27, 61);
  surveyBoard(world, 158, 82);
  addMapLightFixtures(world, 'canyon');
}
