// Bikini Bottom R5 South quarter (x15-112, z68-81).
// Original procedural voxel work inspired by the show; no copied assets.
// Writes y > GROUND only inside its own rectangle (map-spec §2); floor
// paint (y <= GROUND) likewise.
//
// West to east: Wreck Cove (the P-twin heightfield of the Anchor Yard), Goo
// Lagoon with its lifeguard hut and the flume splash pool, the Coral
// Pinnacle (the P-twin of the Moai House), the Treedome and the Jellyfish
// Fields. Nothing here rises above y14 in the flume corridor (x43-52,
// z68-77), which belongs to R3.
import {
  GROUND, AIR, ACCENT, BUS_YELLOW, DUST_CRATE, DUST_WOOD, GLASS, GRASS, LEAVES, MC_CHEST, MC_GOLD,
  MC_WATER, PALE, PLANK, POOL_TILE_BLUE, TEAL_SIDING, TRUCK_RED, WOOD,
  BB_CORAL, BB_HULL, BB_KELP, BB_PINE_LEAF, BB_ROCK, BB_SAND,
} from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';

const T = GROUND;
const SALT = 20260927;
/** Per-voxel hash in [0, 1): clone of setpiece-caldera.js hashC with this file's salt. */
function hashBB(x, y, z) {
  let h = (SALT ^ Math.imul(x + 1013, 0x27d4eb2f) ^ Math.imul(y + 7919, 0x9e3779b1) ^ Math.imul(z + 31337, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Inclusive box, heights relative to GROUND (h0/h1 are "T+n"). */
const tbox = (w, x0, h0, z0, x1, h1, z1, m) => fillBox(w, Math.min(x0, x1), T + Math.min(h0, h1), Math.min(z0, z1),
  Math.max(x0, x1), T + Math.max(h0, h1), Math.max(z0, z1), m);
/** One voxel at height T+h. */
const tset = (w, x, h, z, m) => w.setBlock(x, T + h, z, m);
const tget = (w, x, h, z) => w.getBlock(x, T + h, z);

export function buildSouthQuarter(world) {
  buildWreckCove(world);
  buildGooLagoon(world);
  buildCoralPinnacle(world);
  buildTreedome(world);
  buildJellyfishFields(world);
}

// Wreck Cove (x15-31): a keeled-over galleon hull, ribs, a broken mast with a
// tattered sail, spilled cargo and a rope coil. Heightfield = P(Anchor Yard).
function buildWreckCove(world) {
  tbox(world, 19, 1, 77, 29, 2, 78, BB_HULL);         // keel and hull
  for (let x = 19; x <= 29; x++) {
    // Gunwale trim along the north edge and the ends; barnacles low down.
    tset(world, x, 2, 77, DUST_WOOD);
    if (x === 19 || x === 29) tset(world, x, 2, 78, DUST_WOOD);
    for (const z of [77, 78]) if (hashBB(x, 1, z) < 0.14) tset(world, x, 1, z, BB_CORAL);
  }
  for (const x of [22, 25, 28]) tset(world, x, 1, 77, POOL_TILE_BLUE);   // portholes
  tbox(world, 30, 1, 74, 31, 1, 81, WOOD);            // ribs
  tbox(world, 30, 2, 74, 31, 2, 75, WOOD);            // stern and bow posts
  tbox(world, 30, 2, 80, 31, 2, 81, WOOD);
  tbox(world, 20, 1, 74, 21, 1, 76, WOOD);            // broken mast
  tbox(world, 20, 1, 79, 21, 1, 81, WOOD);
  tbox(world, 16, 1, 76, 18, 1, 79, DUST_WOOD);       // rope coil
  tbox(world, 17, 1, 77, 17, 1, 78, AIR);
  // Mooring line trailing from the coil (the twin of the anchor chain).
  tset(world, 17, 1, 75, DUST_WOOD);
  tset(world, 16, 1, 74, DUST_WOOD);
  tset(world, 17, 1, 73, DUST_WOOD);
  tbox(world, 16, 1, 70, 18, 2, 72, DUST_CRATE);      // cargo
  tset(world, 19, 1, 71, WOOD);                       // cargo step
  tset(world, 17, 2, 71, MC_CHEST);
  // Spilled doubloons around the cargo (paint only).
  for (const [x, z] of [[19, 69], [20, 72], [15, 73], [19, 73], [21, 70], [18, 69]]) world.setBlock(x, T, z, MC_GOLD);
  tbox(world, 24, 1, 78, 24, 6, 78, WOOD);            // mast stump
  for (const z of [79, 80]) {
    for (let h = 3; h <= 6; h++) if ((h + z) % 3) tset(world, 24, h, z, PALE);   // tattered sail
  }
  tbox(world, 24, 7, 78, 24, 7, 81, WOOD);            // yard the sail hangs from
}

// Goo Lagoon: a 2-deep MC_WATER ellipse flush with the seafloor (the flume
// lands here), a sandy beach, the lifeguard hut, umbrellas and beach toys.
function buildGooLagoon(world) {
  const inEllipse = (x, z, rx, rz) => ((x - 39) / rx) ** 2 + ((z - 75) / rz) ** 2 <= 1;
  for (let x = 30; x <= 49; x++) {
    for (let z = 68; z <= 82; z++) {
      if (inEllipse(x, z, 6.8, 5.8)) world.setBlock(x, T, z, BB_SAND);   // beach
    }
  }
  for (let x = 30; x <= 49; x++) {
    for (let z = 68; z <= 82; z++) {
      if (!inEllipse(x, z, 5, 4)) continue;
      world.setBlock(x, T - 2, z, BB_SAND);
      world.setBlock(x, T - 1, z, MC_WATER);
      world.setBlock(x, T, z, MC_WATER);
    }
  }
  // Striped towels (paint).
  for (const [x0, z0] of [[32, 77], [45, 71]]) {
    for (let z = z0; z <= z0 + 3; z++) paintFloor(world, x0, z, x0 + 1, z, T, z % 2 ? TRUCK_RED : BUS_YELLOW);
  }
  // Lifeguard hut: plank box with a teal band, roof platform, railing, chair,
  // a 2-wide stair from the east, a lifebuoy and a flag.
  tbox(world, 37, 1, 68, 39, 3, 70, PLANK);
  tbox(world, 37, 2, 68, 39, 2, 70, TEAL_SIDING);
  tset(world, 39, 2, 69, TRUCK_RED);                  // lifebuoy on the east wall
  tset(world, 39, 2, 70, PALE);
  tbox(world, 37, 4, 68, 39, 4, 70, PLANK);
  tbox(world, 37, 5, 69, 37, 5, 70, PALE);
  tbox(world, 38, 5, 70, 39, 5, 70, PALE);
  tbox(world, 37, 5, 68, 37, 6, 68, WOOD);
  tbox(world, 37, 6, 70, 37, 8, 70, WOOD);            // flag pole on the railing corner
  tbox(world, 37, 7, 69, 37, 8, 69, TRUCK_RED);       // flag
  tbox(world, 42, 1, 68, 42, 1, 69, PLANK);
  tbox(world, 41, 1, 68, 41, 2, 69, PLANK);
  tbox(world, 40, 1, 68, 40, 3, 69, PLANK);
  // Umbrellas with checkered coral/pale canopies at h5.
  for (const [x, z] of [[34, 71], [43, 80]]) {
    tbox(world, x, 1, z, x, 4, z, WOOD);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) tset(world, x + dx, 5, z + dz, (dx + dz) % 2 ? BB_CORAL : PALE);
    }
  }
  // Surfboards stuck upright in the sand (tops at T+4, never roam targets).
  tbox(world, 31, 1, 72, 31, 4, 72, BUS_YELLOW);
  tbox(world, 32, 1, 74, 32, 4, 74, TEAL_SIDING);
  tset(world, 33, 1, 76, POOL_TILE_BLUE);             // cooler by the towels
  tset(world, 35, 1, 80, TRUCK_RED);                  // beach ball
  // Sandcastle with corner towers, one row south of the flume corridor.
  tbox(world, 50, 1, 78, 52, 1, 80, BB_SAND);
  for (const [x, z] of [[50, 78], [52, 78], [50, 80], [52, 80]]) tset(world, x, 2, z, BB_SAND);
}

// Coral Pinnacle (x57-70, z69-81): a lumpy coral tower, the P-twin blocker of
// the Moai House; its nose-twin ledge shelters the front walk.
function buildCoralPinnacle(world) {
  tbox(world, 59, 1, 71, 68, 8, 81, BB_CORAL);
  for (const [lx, lz, r, top] of [[61, 73, 3.2, 14], [66, 77, 3.2, 17], [63, 76, 2.2, 12], [66, 72, 2.2, 11]]) {
    for (let x = 59; x <= 68; x++) {
      for (let z = 71; z <= 80; z++) {
        if (Math.hypot(x - lx, z - lz) <= r) tbox(world, x, 9, z, x, top, z, BB_CORAL);
      }
    }
  }
  tbox(world, 57, 9, 74, 58, 11, 76, BB_CORAL);       // arms
  tbox(world, 69, 12, 74, 70, 14, 76, BB_CORAL);
  tbox(world, 63, 5, 69, 64, 9, 70, BB_CORAL);        // ledge (nose twin)
  // Surface: rock roots at the base, pale polyp flecks, and 1-deep face pits
  // (h4..h7 only, so no column top changes, never on the ledge seam).
  const solid = (x, h, z) => tget(world, x, h, z) !== AIR;
  const pits = [];
  for (let x = 57; x <= 70; x++) {
    for (let z = 69; z <= 81; z++) {
      for (let h = 1; h <= 17; h++) {
        if (tget(world, x, h, z) !== BB_CORAL) continue;
        const r = hashBB(x, h, z);
        const face = !solid(x - 1, h, z) || !solid(x + 1, h, z) || !solid(x, h, z - 1) || !solid(x, h, z + 1);
        if (face && h >= 4 && h <= 7 && r < 0.07 && !(z === 71 && x >= 62 && x <= 65)
          && x >= 59 && x <= 68 && z >= 71) pits.push([x, h, z]);
        else if (h === 1 && r < 0.2) tset(world, x, h, z, BB_ROCK);
        else if (r < 0.1) tset(world, x, h, z, PALE);
      }
    }
  }
  for (const [x, h, z] of pits) tset(world, x, h, z, AIR);
  // Kelp streamers and a leafy anemone on the lump tops.
  tbox(world, 66, 18, 77, 66, 20, 77, BB_KELP);
  tbox(world, 61, 15, 73, 61, 16, 73, BB_KELP);
  for (const [x, z] of [[63, 76], [66, 72], [59, 78]]) {
    let h = 17;
    while (h > 1 && tget(world, x, h, z) === AIR) h--;
    tset(world, x, h + 1, z, BB_PINE_LEAF);
  }
}

// Treedome, centre (87, 74.5): a pale drum with an accent band, a glass
// hemisphere with pale meridian ribs (the drum is its zipper: shoot it and
// the glass above collapses), an oak on a plank platform, and a garden.
function buildTreedome(world) {
  const cx = 87, cz = 74.5;
  for (let x = 79; x <= 95; x++) {
    for (let z = 67; z <= 82; z++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d >= 7.3) continue;
      if (d >= 6.3) {
        tbox(world, x, 1, z, x, 3, z, PALE);
        tset(world, x, 4, z, ACCENT);
      } else {
        // Lawn with a scatter of flowers (paint only).
        const r = hashBB(x, T, z);
        world.setBlock(x, T, z, r < 0.05 ? BUS_YELLOW : r < 0.09 ? TRUCK_RED : GRASS);
      }
      for (let y = T + 5; y < world.dimensions.sy; y++) {
        if (Math.abs(Math.hypot(d, y - (T + 4)) - 7) >= 0.6) continue;
        const a = (((Math.atan2(z - cz, x - cx) * 180 / Math.PI) % 45) + 45) % 45;
        world.setBlock(x, y, z, a < 5 || a > 40 ? PALE : GLASS);
      }
    }
  }
  tbox(world, 86, 1, 68, 88, 3, 68, AIR);             // airlocks
  tbox(world, 86, 1, 81, 88, 3, 81, AIR);
  paintFloor(world, 86, 68, 88, 68, T, PALE);
  paintFloor(world, 86, 81, 88, 81, T, PALE);
  tbox(world, 86, 1, 74, 87, 9, 75, WOOD);            // oak trunk
  // Boughs reaching into the crown (placed before the leaves).
  for (const [x, z] of [[88, 74], [85, 75], [87, 76], [86, 73]]) tset(world, x, 8, z, WOOD);
  for (let x = 82; x <= 91; x++) {
    for (let z = 70; z <= 79; z++) {
      for (const y of [21, 22, 23]) {
        const rr = 3.5 * Math.sqrt(Math.max(0, 1 - ((y - 22) / 1.5) ** 2));
        if (Math.hypot(x + 0.5 - 87, z + 0.5 - 75) <= rr && world.getBlock(x, y, z) === AIR) world.setBlock(x, y, z, LEAVES);
      }
    }
  }
  // Tree platform with a railing (landing gap at x85 z73-74) and its stair:
  // Alpha's north-facing perch, the twin of the pineapple upper floor.
  for (let x = 85; x <= 89; x++) {
    for (let z = 72; z <= 77; z++) {
      if (tget(world, x, 4, z) === AIR) tset(world, x, 4, z, PLANK);
      if ((x === 85 || x === 89 || z === 72 || z === 77) && !(x === 85 && (z === 73 || z === 74))) tset(world, x, 5, z, PLANK);
    }
  }
  tbox(world, 82, 1, 73, 82, 1, 74, PLANK);
  tbox(world, 83, 1, 73, 83, 2, 74, PLANK);
  tbox(world, 84, 1, 73, 84, 3, 74, PLANK);
  // Picnic table on a checkered blanket, and a training dummy with arms.
  for (let x = 89; x <= 92; x++) {
    for (let z = 75; z <= 78; z++) world.setBlock(x, T, z, (x + z) % 2 ? TRUCK_RED : PALE);
  }
  tbox(world, 90, 1, 76, 91, 1, 77, PLANK);
  tbox(world, 82, 1, 78, 82, 5, 78, WOOD);
  tset(world, 82, 4, 77, WOOD);
  tset(world, 83, 4, 78, WOOD);
}

// Jellyfish Fields (x95-112): open meadow with sand patches, coral trees
// (the P-images of the Kelp Grove stalks), a boulder, anemones and a
// jellyfishing net rack. The jellies themselves are client-only.
function buildJellyfishFields(world) {
  for (let x = 95; x <= 112; x++) {
    for (let z = 68; z <= 81; z++) world.setBlock(x, T, z, hashBB(x, T, z) < 0.25 ? BB_SAND : GRASS);
  }
  for (const [x, z] of [[98, 79], [103, 79], [108, 79], [110, 76], [108, 72]]) {
    tbox(world, x, 1, z, x, 4, z, BB_CORAL);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx * dx + dz * dz <= 5) tset(world, x + dx, 5, z + dz, BB_PINE_LEAF);
        if (dx * dx + dz * dz <= 1) tset(world, x + dx, 6, z + dz, BB_CORAL);
      }
    }
  }
  tbox(world, 109, 1, 69, 109, 1, 71, BB_ROCK);       // boulder
  tbox(world, 110, 1, 69, 110, 2, 71, BB_ROCK);
  tbox(world, 111, 1, 69, 111, 3, 71, BB_ROCK);
  // Anemones: 1-high coral and pale knobs across the meadow.
  for (const [x, z] of [[97, 70], [106, 70], [96, 77], [105, 77], [100, 81], [112, 81], [104, 69]]) {
    tset(world, x, 1, z, hashBB(x, 1, z) < 0.5 ? PALE : BB_CORAL);
  }
  // Jellyfishing net rack: two posts under a pale net at T+4.
  tbox(world, 97, 1, 69, 97, 3, 69, WOOD);
  tbox(world, 99, 1, 69, 99, 3, 69, WOOD);
  tbox(world, 97, 4, 69, 99, 4, 69, PALE);
}
