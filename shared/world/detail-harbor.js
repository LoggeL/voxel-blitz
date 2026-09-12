import { ACCENT, AIR, ASPHALT, CONCRETE, GROUND, METAL, PALE, RUST, TEAL_SIDING, WOOD } from './blocks.js';
import { fillBox } from './flatmaps.js';
import { addMapLightFixtures } from './large-map-lights.js';

function dressQuayWalls(world) {
  const { sx, sy, sz } = world.dimensions;
  const paint = (x, y, z, along) => {
    if (world.getBlock(x, y, z) !== METAL) return;
    const rib = along % 16 < 2;
    const band = y === GROUND + 3 || y === GROUND + 15;
    const color = rib ? METAL : band ? PALE : y < GROUND + 3 ? CONCRETE
      : y < GROUND + 8 ? RUST : y < GROUND + 15 ? TEAL_SIDING : CONCRETE;
    world.setBlock(x, y, z, color);
  };
  // Keep the sealed outer shell. Only its inward-facing existing blocks change.
  for (let y = GROUND; y < sy; y++) {
    const inset = y >= sy - 7 ? 0 : 2;
    for (let x = 3; x < sx - 3; x++) for (const z of [inset, sz - 1 - inset]) paint(x, y, z, x);
    for (let z = 3; z < sz - 3; z++) for (const x of [inset, sx - 1 - inset]) paint(x, y, z, z);
  }
}

function paintDockFloor(world) {
  // Inset cargo-hold stripes and drains never alter collision height.
  for (const x of [7, 22, 169, 184]) for (let z = 28; z <= 115; z++) {
    if (world.getBlock(x, GROUND + 1, z) !== AIR) continue;
    world.setBlock(x, GROUND, z, z % 12 < 7 ? PALE : ASPHALT);
  }
  for (const z of [27, 116]) for (let x = 27; x <= 164; x++) {
    if (world.getBlock(x, GROUND + 1, z) !== AIR) continue;
    world.setBlock(x, GROUND, z, x % 4 === 0 ? METAL : CONCRETE);
  }
  for (const [x, z] of [[24, 57], [163, 82], [72, 105], [115, 36]]) {
    for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 3; dz++) {
      if (world.getBlock(x + dx, GROUND + 1, z + dz) === AIR)
        world.setBlock(x + dx, GROUND, z + dz, (dx + dz) % 3 ? ACCENT : METAL);
    }
  }
}

function dressHall(world, x, z) {
  // Load boards are substantial metal boxes recessed into the solid fascia.
  for (const faceZ of [z, z + 18]) {
    const supported = [x + 10, x + 16, x + 22].every(px => world.getBlock(px, GROUND + 10, faceZ) !== AIR);
    if (!supported) continue;
    fillBox(world, x + 10, GROUND + 9, faceZ, x + 22, GROUND + 11, faceZ, METAL);
    fillBox(world, x + 11, GROUND + 10, faceZ, x + 21, GROUND + 10, faceZ, PALE);
  }
  // Roof plant and conduit stay on the existing rear corners, off ground lanes.
  for (const px of [x + 4, x + 27]) {
    if (world.getBlock(px, GROUND + 12, z + 4) === AIR) continue;
    fillBox(world, px, GROUND + 13, z + 3, px + 1, GROUND + 14, z + 5, METAL);
    fillBox(world, px, GROUND + 15, z + 3, px + 1, GROUND + 15, z + 5, PALE);
    world.setBlock(px, GROUND + 14, z + 2, RUST);
  }
  // Pallet stacks remain inside already occupied crate corners of each hall.
  for (const [px, pz] of [[x + 3, z + 3], [x + 26, z + 14]]) {
    if (world.getBlock(px, GROUND + 1, pz) !== WOOD) continue;
    world.setBlock(px, GROUND + 2, pz, RUST);
    world.setBlock(px + 1, GROUND + 2, pz, PALE);
  }
}

export function addHarborDetails(world) {
  dressQuayWalls(world);
  paintDockFloor(world);
  for (const [x, z] of [[28, 29], [132, 29], [28, 96], [132, 96]]) dressHall(world, x, z);
  addMapLightFixtures(world, 'harbor');
}
