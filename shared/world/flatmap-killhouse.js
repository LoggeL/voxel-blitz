import { ACCENT, CONCRETE, GROUND, PALE, STONE } from './blocks.js';
import { generateFlatBase, paintFloor } from './flatmaps.js';
import { addKillhouseSetpieces } from './setpiece-killhouse.js';
import { MAP_DUMMY_POSTS } from './metadata.js';

/** Flat, unobstructed training floors. All markings are inlays, never debris. */
export function generateKillhouseInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  const T = GROUND;
  paintFloor(world, 7, 26, 121, 91, T, STONE);
  paintFloor(world, 8, 48, 120, 54, T, CONCRETE);
  paintFloor(world, 10, 28, 117, 46, T, CONCRETE);
  paintFloor(world, 8, 84, 120, 89, T, CONCRETE);
  paintFloor(world, 8, 82, 120, 83, T, PALE);
  // A continuous orange route connects the firing gallery to the course door.
  paintFloor(world, 12, 48, 17, 81, T, ACCENT);
  paintFloor(world, 112, 34, 117, 42, T, ACCENT);
  for (const x of [18, 34, 54, 74, 94, 114]) {
    paintFloor(world, x, 57, x, 81, T, CONCRETE);
    paintFloor(world, x - 2, 84, x + 2, 85, T, ACCENT);
  }
  for (const z of [62, 70, 78]) {
    for (let x = 20; x <= 118; x += 4) paintFloor(world, x, z, x + 1, z, T, PALE);
  }
  for (const post of MAP_DUMMY_POSTS.killhouse) {
    paintFloor(world, post.x - 1, post.z - 1, post.x + 1, post.z + 1, T, PALE);
    world.setBlock(post.x, T, post.z, ACCENT);
  }
  addKillhouseSetpieces(world);
}
