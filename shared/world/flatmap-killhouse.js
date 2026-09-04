import { mulberry32 } from '../noise.js';
import {
  ACCENT,
  AIR,
  CONCRETE,
  GROUND,
  PALE,
  PLANK,
  RUST,
  STONE,
  SX,
} from './blocks.js';
import { generateFlatBase, paintFloor } from './flatmaps.js';
import {
  addKillhouseSetpieces,
  isKillhouseProtected,
} from './setpiece-killhouse.js';

export function generateKillhouseInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  buildRangeFloor(world);
  addKillhouseSetpieces(world);
  polishRangeFloor(world);
}

// ---------------------------------------------------------------------------
// Floor inlay: FLAT paint at T only, zero height delta. STONE yard with the
// ACCENT start pad, CONCRETE range hall + course floor, PALE firing-line
// band, ACCENT finish pad and distance stripes at z62/70/76.
// ---------------------------------------------------------------------------

const STRIPE_ZS = [62, 70, 76];

function buildRangeFloor(world) {
  const T = GROUND;
  paintFloor(world, 8, 48, 120, 53, T, STONE); // yard
  paintFloor(world, 12, 48, 17, 53, T, ACCENT); // start pad
  paintFloor(world, 8, 57, 120, 88, T, CONCRETE); // range hall + gallery
  paintFloor(world, 8, 82, 120, 83, T, PALE); // firing line
  paintFloor(world, 10, 28, 117, 46, T, CONCRETE); // course floor
  paintFloor(world, 112, 36, 116, 40, T, ACCENT); // finish pad
  for (const z of STRIPE_ZS) {
    for (let x = 12; x <= 116; x++) world.setBlock(x, T, z, ACCENT);
  }
}

// ---------------------------------------------------------------------------
// Polish LAST: deterministic wear + debris on the open range floor only
// (z57-81). Chebyshev nearSpawn guard via isKillhouseProtected skips every
// anchor cell (fun 12 + tdm alpha 6 + bravo 6), dummy post, pad, lane
// divider and the course interior. Grenade-soft dressing only, never
// heights[]. Salt 20260832 belongs to the setpiece dressing.
// ---------------------------------------------------------------------------

function polishRangeFloor(world) {
  const T = GROUND;
  const rng = mulberry32(20260831);
  for (let i = 0; i < 260; i++) {
    const x = 8 + ((rng() * 112) | 0);
    const z = 57 + ((rng() * 25) | 0);
    if (isKillhouseProtected(x, z)) continue;
    const floor = world.getBlock(x, T, z);
    if (floor !== CONCRETE && floor !== STONE) continue;
    if (world.getBlock(x, T + 1, z) !== AIR) continue;
    const kind = rng();
    if (kind < 0.55) {
      world.setBlock(x, T, z, rng() < 0.6 ? STONE : RUST); // worn floor
    } else if (kind < 0.8) {
      if (world.getBlock(x, T + 2, z) !== AIR) continue;
      world.setBlock(x, T + 1, z, ACCENT); // spent brass
    } else {
      if (world.getBlock(x, T + 2, z) !== AIR) continue;
      world.setBlock(x, T + 1, z, rng() < 0.5 ? PLANK : STONE); // debris
    }
  }
}
