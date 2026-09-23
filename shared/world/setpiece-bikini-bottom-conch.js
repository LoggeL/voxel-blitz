// Bikini Bottom R1 North, Conch Street houses (x15-112, z14-27).
// Original procedural voxel work inspired by the show; no copied assets.
// Writes y > GROUND only inside its own rectangle (map-spec §2); floor
// paint (y <= GROUND) likewise.
//
// West to east: the Kelp Grove, the enterable two-floor Pineapple, the solid
// Moai House blocking mid-north, the Rock Home terraces under a propped lid
// (Bravo's T+3 perch over the B lot) and the Anchor Yard, whose heightfield
// is the exact point twin of R5's Wreck Cove. Every free-standing column top
// is T+1, a stepped T+2..T+3, or >= T+4 (docs: map-spec §1.2).
import {
  GROUND, AIR, ACCENT, DUST_WOOD, GLASS, GRASS, MC_BOOKSHELF, MC_FURNACE, MC_MOSSY, PALE, PLANK,
  POOL_TILE_BLUE, RUST, STONE, TRUCK_RED, WOOD,
  BB_CORAL, BB_HULL, BB_KELP, BB_MOAI, BB_PINE_LEAF, BB_PINEAPPLE, BB_ROCK,
} from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';

const T = GROUND;
const SALT = 20260923;
/** Per-voxel hash in [0, 1): clone of setpiece-caldera.js hashC with this file's salt by default. */
function hashBB(x, y, z, salt = SALT) {
  let h = (salt ^ Math.imul(x + 1013, 0x27d4eb2f) ^ Math.imul(y + 7919, 0x9e3779b1) ^ Math.imul(z + 31337, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Inclusive box, heights relative to GROUND (h0/h1 are "T+n"). */
const tbox = (w, x0, h0, z0, x1, h1, z1, m) => fillBox(w, Math.min(x0, x1), T + Math.min(h0, h1), Math.min(z0, z1),
  Math.max(x0, x1), T + Math.max(h0, h1), Math.max(z0, z1), m);
/** One voxel at height T+h. */
const tset = (w, x, h, z, m) => w.setBlock(x, T + h, z, m);
const tget = (w, x, h, z) => w.getBlock(x, T + h, z);

export function buildConchStreetHouses(world) {
  buildKelpGrove(world);
  buildPineapple(world);
  buildMoaiHouse(world);
  // Yard hedges: 1-high coral rows either side of the Moai front yard, a few
  // pale polyp blooms swapped in.
  for (const x0 of [49, 74]) {
    for (let x = x0; x <= x0 + 4; x++) tset(world, x, 1, 26, hashBB(x, 1, 26) < 0.3 ? PALE : BB_CORAL);
  }
  buildRockHome(world);
  buildAnchorYard(world);
}

// Kelp Grove (x15-33): tall kelp stalks (the P-images of the Jellyfish Fields
// coral trees) with side fronds, sea-grass under them and a climbable boulder.
function buildKelpGrove(world) {
  for (const [x, z] of [[29, 16], [24, 16], [19, 16], [17, 19], [19, 23]]) {
    // Sea-grass tufts in a loose ring around each stalk (paint only).
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const gx = x + dx, gz = z + dz;
        if (gx < 15 || gz < 14 || dx * dx + dz * dz > 5) continue;
        if (hashBB(gx, T, gz) < 0.45) world.setBlock(gx, T, gz, GRASS);
      }
    }
    // Stalk heights use the core salt, matching the verified reference model.
    const h = 7 + Math.floor(hashBB(x, 1, z, 20260922) * 5);
    tbox(world, x, 1, z, x, h, z, BB_KELP);
    tset(world, x + 1, 5, z, BB_KELP);
    tset(world, x, h - 2, z - 1, BB_KELP);
  }
  // Coral boulder terraces, climbable from the east.
  tbox(world, 18, 1, 24, 18, 1, 26, BB_ROCK);
  tbox(world, 17, 1, 24, 17, 2, 26, BB_ROCK);
  tbox(world, 16, 1, 24, 16, 3, 26, BB_ROCK);
  for (let x = 16; x <= 18; x++) {
    for (let z = 24; z <= 26; z++) {
      for (let h = 1; h <= 3; h++) {
        if (tget(world, x, h, z) === BB_ROCK && hashBB(x, h, z) < 0.18) tset(world, x, h, z, h === 1 ? MC_MOSSY : BB_CORAL);
      }
    }
  }
  // Sea-anemone tufts: 1-high coral knobs, all T+1 (never sealed pockets).
  for (const [x, z] of [[32, 24], [31, 17], [21, 14], [27, 14]]) tset(world, x, 1, z, BB_CORAL);
}

// Pineapple, centre (40,21): a two-floor house with portholes, an eye-nub
// lattice, a leaf crown and a furnished interior. The cap and crown keep
// heightAt >= y29, so the inside is never a roam target or a spawn.
const PINE_R = { 1: 5.5, 2: 6.0, 10: 6.2, 11: 5.8, 12: 5.2, 13: 4.4, 14: 3.4, 15: 2.2 };
function buildPineapple(world) {
  const cx = 40, cz = 21;
  const isShell = (x, h, z) => {
    const b = tget(world, x, h, z);
    return b === BB_PINEAPPLE || b === DUST_WOOD;
  };
  // Floor paint first: plank boards inside, a red rug under the landmark.
  for (let x = 33; x <= 47; x++) {
    for (let z = 14; z <= 27; z++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d <= 2) world.setBlock(x, T, z, TRUCK_RED);
      else if (d <= 5.3) world.setBlock(x, T, z, (x + z) % 5 === 0 ? DUST_WOOD : PLANK);
    }
  }
  for (let h = 1; h <= 15; h++) {
    const r = PINE_R[h] ?? 6.5;
    for (let x = 33; x <= 47; x++) {
      for (let z = 14; z <= 27; z++) {
        const d = Math.hypot(x - cx, z - cz);
        if (h <= 10) {
          if (r - 1.2 < d && d <= r) {
            // Eye nubs: a diagonal lattice of darker knots round the rind.
            const k = Math.round(Math.atan2(z - cz, x - cx) * 16 / (2 * Math.PI));
            tset(world, x, h, z, (h + k) % 4 === 0 ? DUST_WOOD : BB_PINEAPPLE);
          } else if (h === 4 && d <= r - 1.2) {
            tset(world, x, h, z, PLANK);   // upper floor slab
          }
        } else if (d <= r) {
          tset(world, x, h, z, BB_PINEAPPLE);
        }
      }
    }
  }
  // Stair hole and a three-step plank stair along the east wall.
  tbox(world, 43, 4, 20, 44, 4, 22, AIR);
  tbox(world, 43, 1, 22, 44, 1, 22, PLANK);
  tbox(world, 43, 1, 21, 44, 2, 21, PLANK);
  tbox(world, 43, 1, 20, 44, 3, 20, PLANK);
  // North and south doors with wooden lintels; door thresholds painted.
  for (const [z0, z1] of [[14, 17], [25, 27]]) {
    for (let x = 39; x <= 41; x++) {
      for (let z = z0; z <= z1; z++) {
        tbox(world, x, 1, z, x, 3, z, AIR);
        if (isShell(x, 4, z)) tset(world, x, 4, z, WOOD);
        if (Math.hypot(x - cx, z - cz) > 5.3) world.setBlock(x, T, z, DUST_WOOD);
      }
    }
  }
  // Upper perch windows (south watches Conch Street and the A lot).
  for (const [x0, x1, z0, z1] of [[39, 41, 25, 27], [34, 35, 20, 22], [45, 46, 20, 22]]) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        for (const h of [6, 7]) if (isShell(x, h, z)) tset(world, x, h, z, GLASS);
      }
    }
  }
  // Ground portholes.
  for (const x of [34, 46]) {
    for (const z of [20, 21]) {
      for (const h of [2, 3]) if (isShell(x, h, z)) tset(world, x, h, z, GLASS);
    }
  }
  // Leaf crown: base tuft, a tall spike, 4 cardinal and 4 diagonal blades.
  tbox(world, 39, 16, 20, 41, 17, 22, BB_PINE_LEAF);
  tbox(world, 40, 16, 21, 40, 23, 21, BB_PINE_LEAF);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    [16, 17, 18, 18, 17].forEach((h, i) => tset(world, cx + dx * (i + 1), h, cz + dz * (i + 1), BB_PINE_LEAF));
  }
  for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    [16, 17, 17, 16].forEach((h, i) => tset(world, cx + dx * (i + 1), h, cz + dz * (i + 1), BB_PINE_LEAF));
  }
  // Ground room: TV, coral lamp, anchor armchair, a stove set into the north
  // wall and a little driftwood dining table (all clear of the door lanes
  // x39-41 and the stair x43-44 z19-23).
  tbox(world, 36, 1, 18, 37, 2, 18, PALE);
  tbox(world, 36, 1, 24, 36, 2, 24, BB_CORAL);
  tbox(world, 42, 1, 17, 43, 1, 17, RUST);
  tset(world, 38, 1, 17, MC_FURNACE);
  tbox(world, 36, 1, 21, 37, 1, 22, DUST_WOOD);
  // Upper room: boat bed with red covers, snail bowl, bookshelf, nightstand
  // with a foghorn clock.
  tbox(world, 37, 5, 18, 39, 5, 20, BB_HULL);
  tbox(world, 37, 5, 19, 39, 5, 19, TRUCK_RED);
  tset(world, 43, 5, 24, POOL_TILE_BLUE);
  tbox(world, 41, 5, 17, 42, 6, 17, MC_BOOKSHELF);
  tset(world, 36, 5, 20, DUST_WOOD);
  tset(world, 36, 6, 20, ACCENT);
  // Mailbox on the Conch Street apron.
  tbox(world, 44, 1, 27, 44, 4, 27, WOOD);
  tset(world, 44, 5, 27, BB_HULL);
}

// Moai House (x58-69, z14-26): solid stone head, the mid-north blocker. The
// brow, lips and nose leave h1..h3 open so the front yard stays walkable.
function buildMoaiHouse(world) {
  tbox(world, 59, 1, 14, 68, 12, 24, BB_MOAI);        // body
  tbox(world, 60, 13, 16, 67, 16, 23, BB_MOAI);       // head
  tbox(world, 60, 10, 25, 67, 11, 25, BB_MOAI);       // brow
  tbox(world, 61, 4, 25, 66, 4, 25, BB_MOAI);         // lips
  tbox(world, 63, 5, 25, 64, 9, 26, BB_MOAI);         // nose awning over the door
  tbox(world, 58, 6, 19, 58, 10, 21, BB_MOAI);        // ears
  tbox(world, 69, 6, 19, 69, 10, 21, BB_MOAI);
  // Weathering: stone mottling, moss creeping up the base and over the crown.
  for (let x = 58; x <= 69; x++) {
    for (let z = 14; z <= 26; z++) {
      for (let h = 1; h <= 16; h++) {
        if (tget(world, x, h, z) !== BB_MOAI) continue;
        const r = hashBB(x, h, z);
        if (h === 16 && r < 0.06) tset(world, x, h, z, MC_MOSSY);
        else if (h <= 2 && r < 0.14) tset(world, x, h, z, MC_MOSSY);
        else if (r < 0.12) tset(world, x, h, z, STONE);
      }
    }
  }
  tbox(world, 60, 7, 24, 61, 8, 24, GLASS);           // eyes, backed by solid body
  tbox(world, 66, 7, 24, 67, 8, 24, GLASS);
  tbox(world, 63, 1, 24, 64, 3, 24, DUST_WOOD);       // flush front door
  tset(world, 61, 1, 25, BB_CORAL);                   // tube-coral pots
  tset(world, 61, 2, 25, BB_CORAL);
  tset(world, 66, 1, 25, BB_CORAL);
  tset(world, 66, 2, 25, BB_CORAL);
  // A kelp sprig growing out of the crown.
  tbox(world, 63, 17, 20, 63, 18, 20, BB_KELP);
  tbox(world, 64, 17, 19, 64, 19, 19, BB_KELP);
  // Door step paint in the front yard.
  paintFloor(world, 63, 25, 64, 26, T, PALE);
}

// Rock Home, centre (88,21): climbable rock terraces (T+1..T+4) under a lid
// propped open toward Conch Street; Bravo's T+3 perch over the B lot.
function buildRockHome(world) {
  for (let x = 81; x <= 95; x++) {
    for (let z = 14; z <= 28; z++) {
      const d = Math.hypot(x - 88, z - 21);
      const h = d < 1.5 ? 4 : d < 3 ? 3 : d < 4.5 ? 2 : d < 6.3 ? 1 : 0;
      if (h) {
        for (let k = 1; k <= h; k++) tset(world, x, k, z, hashBB(x, k, z) < 0.1 ? BB_CORAL : BB_ROCK);
      } else if (d < 7.4 && z <= 27 && hashBB(x, T, z) < 0.5) {
        world.setBlock(x, T, z, BB_ROCK);   // pebble apron (paint)
      }
      if (Math.hypot(x - 88, z - 19) < 3.5) world.setBlock(x, z >= 19 ? 21 : 22, z, BB_ROCK);
    }
  }
  world.setBlock(89, 19, 22, WOOD);                   // prop stick
  world.setBlock(89, 20, 22, WOOD);
  fillBox(world, 88, 22, 19, 88, 25, 19, WOOD);       // weathervane
  world.setBlock(88, 26, 19, ACCENT);
  tbox(world, 86, 1, 27, 86, 4, 27, WOOD);            // mailbox
  tset(world, 86, 5, 27, BB_HULL);
}

// Anchor Yard (x96-112, z14-25): a giant anchor lying flat, its chain, and
// chum barrels. The exact point twin of the Wreck Cove heightfield.
function buildAnchorYard(world) {
  tbox(world, 98, 1, 17, 108, 2, 18, RUST);           // shank
  tbox(world, 96, 1, 14, 97, 1, 21, RUST);            // arms
  tbox(world, 96, 2, 14, 97, 2, 15, RUST);            // flukes
  tbox(world, 96, 2, 20, 97, 2, 21, RUST);
  tbox(world, 106, 1, 14, 107, 1, 16, DUST_WOOD);     // stock
  tbox(world, 106, 1, 19, 107, 1, 21, DUST_WOOD);
  tbox(world, 109, 1, 16, 111, 1, 19, RUST);          // eye ring
  tbox(world, 110, 1, 17, 110, 1, 18, AIR);
  // Barnacles on the iron (material swap only).
  for (let x = 96; x <= 111; x++) {
    for (let z = 14; z <= 21; z++) {
      for (let h = 1; h <= 2; h++) {
        if (tget(world, x, h, z) === RUST && hashBB(x, h, z) < 0.1) tset(world, x, h, z, BB_CORAL);
      }
    }
  }
  // Chain links trailing from the eye toward the barrels (twinned by the
  // Wreck Cove mooring line).
  tset(world, 110, 1, 20, RUST);
  tset(world, 111, 1, 21, RUST);
  tset(world, 110, 1, 22, RUST);
  tbox(world, 109, 1, 23, 111, 2, 25, RUST);          // chum barrels
  for (const [x, z] of [[109, 23], [111, 24], [110, 25]]) tset(world, x, 2, z, BB_HULL);   // barrel lids
  tset(world, 108, 1, 24, WOOD);                      // step
}
