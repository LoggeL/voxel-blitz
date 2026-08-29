import { mulberry32 } from '../noise.js';
import {
  ACCENT,
  AIR,
  CONCRETE,
  GROUND,
  PALE,
  SAND,
  STONE,
  SX,
  SZ,
} from './blocks.js';
import { fillBox, generateFlatBase, paintFloor } from './flatmaps.js';
import { MAP_SPAWN_ANCHORS } from './metadata.js';
import { dressSolstice } from './setpiece-solstice.js';

const SPAWN_ANCHORS = [
  ...MAP_SPAWN_ANCHORS.solstice.fun,
  ...MAP_SPAWN_ANCHORS.solstice.tdm.alpha,
  ...MAP_SPAWN_ANCHORS.solstice.tdm.bravo,
];

function nearSpawn(x, z) {
  return SPAWN_ANCHORS.some(([sx, sz]) => Math.max(Math.abs(x - sx), Math.abs(z - sz)) <= 3);
}

function buildCanyonRim(world) {
  const T = GROUND;
  // Replace the generic metal containment slab with a varied sandstone skyline.
  // The boundary remains far taller than any legal jump but no longer reads as a box.
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const edge = Math.min(x, z, SX - 1 - x, SZ - 1 - z);
      if (edge > 8) continue;
      const ridge = Math.sin(x * 0.19) * 2.2 + Math.cos(z * 0.23) * 2.5;
      const height = Math.max(T + 7, Math.min(T + 21,
        Math.round(T + 19 - edge * 1.35 + ridge)));
      for (let y = T + 1; y < 40; y++) {
        world.setBlock(x, y, z, y <= height
          ? ((x + z + y) % 11 === 0 ? STONE : SAND)
          : AIR);
      }
    }
  }
  for (let inset = 3; inset <= 8; inset++) {
    const height = T + 10 - Math.floor((inset - 3) * 0.8);
    for (let x = inset; x < SX - inset; x++) {
      const type = x % 13 === 0 ? PALE : SAND;
      if (!nearSpawn(x, inset)) fillBox(world, x, T + 1, inset, x, height, inset, type);
      if (!nearSpawn(x, SZ - 1 - inset)) {
        fillBox(world, x, T + 1, SZ - 1 - inset, x, height, SZ - 1 - inset, type);
      }
    }
    for (let z = inset; z < SZ - inset; z++) {
      const type = z % 13 === 0 ? PALE : SAND;
      if (!nearSpawn(inset, z)) fillBox(world, inset, T + 1, z, inset, height, z, type);
      if (!nearSpawn(SX - 1 - inset, z)) {
        fillBox(world, SX - 1 - inset, T + 1, z, SX - 1 - inset, height, z, type);
      }
    }
  }
}

function buildLaneFoundation(world) {
  const T = GROUND;
  paintFloor(world, 3, 3, SX - 4, SZ - 4, T, SAND);

  // Three readable north/south lanes plus two full cross-rotations.
  paintFloor(world, 17, 8, 40, 87, T, CONCRETE);
  paintFloor(world, 56, 7, 72, 88, T, PALE);
  paintFloor(world, 87, 8, 112, 87, T, CONCRETE);
  paintFloor(world, 10, 17, 117, 23, T, PALE);
  paintFloor(world, 10, 72, 117, 78, T, PALE);
  paintFloor(world, 37, 44, 91, 52, T, CONCRETE);

  // Solar inlay guides navigation without adding collision.
  for (let z = 8; z <= 88; z += 4) {
    world.setBlock(63, T, z, ACCENT);
    world.setBlock(64, T, z, ACCENT);
  }
  for (let x = 12; x <= 116; x += 6) {
    world.setBlock(x, T, 20, ACCENT);
    world.setBlock(x, T, 75, ACCENT);
  }
}

function scatterErosion(world) {
  const T = GROUND;
  const rng = mulberry32(0x50157ce);
  for (let i = 0; i < 390; i++) {
    const x = 9 + ((rng() * (SX - 18)) | 0);
    const z = 7 + ((rng() * (SZ - 14)) | 0);
    if (nearSpawn(x, z) || world.getBlock(x, T, z) !== SAND) continue;
    if (rng() < 0.76) {
      world.setBlock(x, T, z, rng() < 0.72 ? STONE : PALE);
    } else if (world.getBlock(x, T + 1, z) === AIR) {
      world.setBlock(x, T + 1, z, STONE);
    }
  }
}

export function generateSolsticeInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  buildLaneFoundation(world);
  buildCanyonRim(world);
  dressSolstice(world);
  scatterErosion(world);
}
