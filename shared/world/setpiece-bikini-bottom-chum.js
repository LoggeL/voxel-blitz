// Bikini Bottom R4 East downtown, Chum Bucket (site B) (x78-112, z34-61).
// Original procedural voxel work inspired by the show; no copied assets.
// Writes y > GROUND only inside its own rectangle (map-spec §2); floor
// paint (y <= GROUND) likewise.
//
// A riveted gunmetal plinth (deck top y17) carries a bucket ring with three
// doors, a gatehouse under the sign, a goo vat and a lab corner (site B);
// its handle arcs to y37 as the skyline read. The Chum Lab is a dead-end TTT
// hideout carved under the deck, with a GLASS periscope tile in the site
// floor. The B lot is the P-image of the R2 A lot.
import {
  GROUND, AIR, ACCENT, ASPHALT, BB_CHUM, BB_CORAL, BB_KELP, GLASS, MC_CHEST, MC_IRON, PALE, PLANK,
  POOL_TILE_BLUE, POOL_TILE_WHITE, RUST, TEAL_SIDING, TRUCK_RED,
} from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';

const T = GROUND;
const SALT = 20260926;
/** Per-voxel hash in [0, 1): clone of setpiece-caldera.js hashC with this file's salt. */
function hashBB(x, y, z) {
  let h = (SALT ^ Math.imul(x + 1013, 0x27d4eb2f) ^ Math.imul(y + 7919, 0x9e3779b1) ^ Math.imul(z + 31337, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Inclusive box, heights relative to GROUND (h0/h1 are "T+n"). */
const tbox = (w, x0, h0, z0, x1, h1, z1, m) => fillBox(w, Math.min(x0, x1), T + Math.min(h0, h1), Math.min(z0, z1),
  Math.max(x0, x1), T + Math.max(h0, h1), Math.max(z0, z1), m);
/** Absolute-y single voxel. */
const put = (w, x, y, z, m) => w.setBlock(x, y, z, m);

// Plinth x91-112, z37-58 (deck top y17); bucket centre (101.5, 47.5).
const PX0 = 91, PX1 = 112, PZ0 = 37, PZ1 = 58;
const CX = 101.5, CZ = 47.5;
const dist = (x, z) => Math.hypot(x - CX, z - CZ);
/** Bucket angle in degrees, [0, 360). */
const angle = (x, z) => ((Math.atan2(z - CZ, x - CX) * 180 / Math.PI) % 360 + 360) % 360;
const inSite = (x, z) => x >= 96 && x <= 107 && z >= 42 && z <= 53;
/** Stair landings on the deck edge keep their rail gaps. */
const landing = (x, z) => (z === PZ0 && x >= 100 && x <= 103) || (z === PZ1 && x >= 100 && x <= 103)
  || (z === PZ1 && x >= 107 && x <= 109) || x === PX0;

export function buildChumBucket(world) {
  buildPlinth(world);
  buildBucket(world);
  buildGatehouse(world);
  buildSiteB(world);
  buildChumLab(world);
  buildStairsAndOutside(world);
  buildBLot(world);
}

/** §7.1: riveted plinth, hazard deck edge, tiled site floor, rail posts. */
function buildPlinth(world) {
  paintFloor(world, 90, 36, 112, 36, T, ASPHALT);               // industrial apron
  paintFloor(world, 90, 59, 112, 59, T, ASPHALT);
  paintFloor(world, 90, 37, 90, 58, T, ASPHALT);
  tbox(world, PX0, 1, PZ0, PX1, 3, PZ1, BB_CHUM);
  for (let x = PX0; x <= PX1; x++) for (let z = PZ0; z <= PZ1; z++) {
    const edge = x === PX0 || x === PX1 || z === PZ0 || z === PZ1;
    if (!edge) continue;
    const along = x === PX0 || x === PX1 ? z : x;
    if (along % 3 === 0) tbox(world, x, 2, z, x, 2, z, RUST);   // rivets
    if ((x + z) % 2 === 0) tbox(world, x, 3, z, x, 3, z, ACCENT);  // hazard stripe
    if (along % 3 === 0 && !landing(x, z)) tbox(world, x, 4, z, x, 4, z, RUST);   // rail posts
  }
  // Site floor: white tiles, blue lab tiles out to the ring, ACCENT corner ticks.
  for (let x = PX0 + 1; x < PX1; x++) for (let z = PZ0 + 1; z < PZ1; z++) {
    if (inSite(x, z)) put(world, x, T + 3, z, POOL_TILE_WHITE);
    else if (dist(x, z) < 9) put(world, x, T + 3, z, POOL_TILE_BLUE);
  }
  for (const [x, z] of [[96, 42], [107, 42], [96, 53], [107, 53]]) put(world, x, T + 3, z, ACCENT);
  // Exhaust vents on the plinth corners outside the ring (lab air shafts).
  for (const [x, z] of [[93, 39], [110, 39], [93, 56], [110, 56]]) {
    tbox(world, x, 4, z, x, 5, z, RUST);
    tbox(world, x, 6, z, x, 6, z, PALE);
  }
}

/** §7.2: ring wall with hoops and three doors, lip, goo drips, portholes, handle. */
function buildBucket(world) {
  for (let x = 90; x <= 113; x++) for (let z = 36; z <= 59; z++) {
    const d = dist(x, z);
    if (d >= 9 && d < 10) {
      const a = angle(x, z);
      // West and south portals, each on the straight line from its stair to the
      // site centre (the gatehouse is the north one).
      const door = Math.abs(a - 180) < 17 || Math.abs(a - 90) < 15;
      for (let h = 4; h <= 12; h++) {
        if (h <= 6 && door) continue;
        tbox(world, x, h, z, x, h, z, h === 6 || h === 11 ? RUST : BB_CHUM);
      }
    }
    if (d >= 9.5 && d < 11) tbox(world, x, 13, z, x, 13, z, RUST);   // lip
    // Chum drips under the lip on the outside face (clear of the gatehouse and sign).
    if (d >= 10 && d < 11 && z > 39) {
      const r = hashBB(x, 0, z);
      if (r < 0.22) tbox(world, x, 12, z, x, 12, z, TRUCK_RED);
      if (r < 0.08) tbox(world, x, 11, z, x, 11, z, TRUCK_RED);
    }
  }
  // Pipe run inside the ring at h9, above every door and head.
  for (let x = 92; x <= 111; x++) for (let z = 38; z <= 57; z++) {
    const d = dist(x, z);
    if (d >= 8.5 && d < 9 && world.getBlock(x, T + 9, z) === AIR) tbox(world, x, 9, z, x, 9, z, RUST);
  }
  // East portholes: defenders watch B-Long through the ring.
  for (let z = 46; z <= 49; z++) {
    if (world.getBlock(111, T + 5, z) === BB_CHUM) tbox(world, 111, 5, z, 111, 6, z, GLASS);
  }
  // Handle hinge plates, then the RUST handle arc in the z47-48 plane (top y37).
  for (const x of [PX0, PX1]) fillBox(world, x, 26, 46, x, 28, 49, ACCENT);
  for (let x = 90; x <= 113; x++) for (let y = 27; y <= 38; y++) {
    if (Math.abs(Math.hypot(x - CX, y - 27) - 10.5) < 0.6) fillBox(world, x, y, 47, x, y, 48, RUST);
  }
}

/** §7.2 north door: 2-thick gatehouse sealing the ring, sign face at z38. */
function buildGatehouse(world) {
  tbox(world, 96, 4, 38, 107, 11, 39, BB_CHUM);
  tbox(world, 100, 4, 38, 103, 6, 39, AIR);
  tbox(world, 99, 4, 38, 99, 6, 39, RUST); tbox(world, 104, 4, 38, 104, 6, 39, RUST);   // door jambs
  tbox(world, 100, 7, 38, 103, 7, 39, ACCENT);                  // hazard lintel
  // Frame around CHUM BUCKET (backing x98-104 y22-23 z38, air at z37 stays open).
  fillBox(world, 97, 21, 37, 105, 21, 37, ACCENT); fillBox(world, 97, 24, 37, 105, 24, 37, ACCENT);
  fillBox(world, 97, 22, 37, 97, 23, 37, ACCENT); fillBox(world, 105, 22, 37, 105, 23, 37, ACCENT);
  for (const [x, y] of [[97, 21], [105, 21], [97, 24], [105, 24]]) put(world, x, y, 37, RUST);
  // Merlons, beacons and a dish antenna on the gatehouse roof (y25).
  for (let x = 96; x <= 107; x++) if (x % 2 === 0 || x === 107) fillBox(world, x, 26, 38, x, 26, 39, BB_CHUM);
  put(world, 96, 27, 38, ACCENT); put(world, 107, 27, 38, ACCENT);
  fillBox(world, 99, 26, 39, 99, 32, 39, MC_IRON);
  put(world, 99, 33, 39, ACCENT);
  fillBox(world, 100, 30, 39, 101, 31, 39, PALE);
}

/** §7.3: vat, wall computer, console, barrels, test tubes (floor y17). */
function buildSiteB(world) {
  tbox(world, 100, 4, 46, 103, 6, 49, RUST);
  for (const [x, z] of [[100, 46], [103, 46], [100, 49], [103, 49]]) tbox(world, x, 4, z, x, 6, z, AIR);
  tbox(world, 101, 6, 47, 102, 6, 48, TRUCK_RED);               // goo
  tbox(world, 104, 4, 43, 106, 6, 43, BB_CHUM); tbox(world, 105, 5, 43, 105, 6, 43, GLASS);
  tbox(world, 104, 5, 43, 104, 5, 43, POOL_TILE_BLUE); tbox(world, 106, 5, 43, 106, 5, 43, POOL_TILE_BLUE);
  tbox(world, 104, 4, 44, 106, 4, 44, PALE); tbox(world, 105, 4, 44, 105, 4, 44, TRUCK_RED);   // big red button
  for (const [x, z] of [[97, 44], [98, 44], [106, 51]]) tbox(world, x, 4, z, x, 4, z, RUST);
  tbox(world, 96, 4, 50, 97, 5, 51, RUST); tbox(world, 98, 4, 51, 98, 4, 51, RUST);
  tbox(world, 99, 4, 52, 99, 5, 52, GLASS); tbox(world, 104, 4, 42, 104, 5, 42, GLASS);
}

/** §7.5: dead-end lab under the deck, opening east onto B-Long. */
function buildChumLab(world) {
  tbox(world, 104, 1, 51, 110, 2, 56, AIR);
  tbox(world, 111, 1, 52, 112, 2, 53, AIR);
  paintFloor(world, 104, 51, 110, 56, T, POOL_TILE_WHITE);
  for (const z of [52, 53]) for (const x of [111, 112]) put(world, x, T, z, (x + z) % 2 ? ACCENT : PALE);
  // Partition: specimen room (west, under the periscope) and machine room (east).
  tbox(world, 107, 1, 51, 107, 2, 51, BB_CHUM); tbox(world, 107, 1, 54, 107, 2, 56, BB_CHUM);
  // Periscope: one GLASS tile in the site-B floor, ringed by a RUST collar.
  for (let x = 104; x <= 106; x++) for (let z = 51; z <= 53; z++) tbox(world, x, 3, z, x, 3, z, RUST);
  tbox(world, 105, 3, 52, 105, 3, 52, GLASS);
  // Raised collar lip: the cells around the hole put feet at y19, a 4-voxel
  // rise from the lab floor, so a shot-out periscope stays a peek hole only.
  for (let x = 104; x <= 106; x++) for (let z = 51; z <= 53; z++) if (x !== 105 || z !== 52) tbox(world, x, 4, z, x, 4, z, RUST);
  // Props: terminal, bench, strongbox, specimen tubes, machinery.
  tbox(world, 104, 1, 52, 104, 1, 53, PLANK); tbox(world, 104, 2, 52, 104, 2, 52, POOL_TILE_BLUE);
  tbox(world, 104, 1, 56, 106, 1, 56, PALE);
  tbox(world, 106, 1, 51, 106, 1, 51, MC_CHEST);
  for (const x of [108, 110]) { tbox(world, x, 1, 51, x, 1, 51, POOL_TILE_BLUE); tbox(world, x, 2, 51, x, 2, 51, GLASS); }
  tbox(world, 109, 1, 55, 110, 2, 56, MC_IRON);
  // Hazard frame around the corridor mouth in the east plinth face.
  tbox(world, 112, 1, 51, 112, 3, 51, RUST); tbox(world, 112, 1, 54, 112, 3, 54, RUST);
  tbox(world, 112, 3, 52, 112, 3, 53, RUST);
}

/** §7.4: west ramp, north, south and SE stairs (ACCENT nosing), table, barrels, spill. */
function buildStairsAndOutside(world) {
  for (let i = 0; i < 6; i++) {
    const x = 85 + i, h = 1 + (i >> 1);
    tbox(world, x, 1, 45, x, h, 50, BB_CHUM);
    if (i % 2 === 0) tbox(world, x, h, 45, x, h, 50, ACCENT);
  }
  for (let i = 0; i < 3; i++) {
    tbox(world, 100, 1, 34 + i, 103, 1 + i, 34 + i, BB_CHUM); tbox(world, 100, 1 + i, 34 + i, 103, 1 + i, 34 + i, ACCENT);
    tbox(world, 100, 1, 61 - i, 103, 1 + i, 61 - i, BB_CHUM); tbox(world, 100, 1 + i, 61 - i, 103, 1 + i, 61 - i, ACCENT);
    tbox(world, 107, 1, 61 - i, 109, 1 + i, 61 - i, BB_CHUM); tbox(world, 107, 1 + i, 61 - i, 109, 1 + i, 61 - i, ACCENT);
  }
  // Stepped plinth base (h1, h2) along the west, north and south faces, so a
  // body walking straight at the deck from the town can always climb it.
  for (let z = PZ0; z <= PZ1; z++) { tbox(world, 89, 1, z, 89, 1, z, BB_CHUM); tbox(world, 90, 1, z, 90, 2, z, BB_CHUM); }
  for (let x = 89; x <= PX1; x++) {
    if (x >= 100 && x <= 103) continue;
    for (const [z1, z2] of [[35, 36], [60, 59]]) {
      if (world.getBlock(x, T + 1, z1) === AIR) tbox(world, x, 1, z1, x, 1, z1, BB_CHUM);
      if (world.getBlock(x, T + 2, z2) === AIR) tbox(world, x, 1, z2, x, 2, z2, BB_CHUM);
    }
  }
  tbox(world, 95, 1, 34, 97, 1, 35, PLANK);
  // Chum spill around the south barrels.
  for (let x = 93; x <= 101; x++) for (let z = 60; z <= 61; z++) if (hashBB(x, T, z) < 0.4) put(world, x, T, z, TRUCK_RED);
  tbox(world, 97, 1, 60, 99, 2, 61, RUST); tbox(world, 96, 1, 60, 96, 1, 61, RUST);
}

/** §7.6 B lot: P-images of the R2 A lot (tops match their twins). */
function buildBLot(world) {
  paintFloor(world, 82, 55, 88, 55, T, PALE); paintFloor(world, 82, 51, 88, 51, T, PALE);
  paintFloor(world, 84, 40, 84, 46, T, PALE); paintFloor(world, 80, 40, 80, 46, T, PALE);
  // Boat-car (fin east, bumper and headlights west).
  tbox(world, 83, 1, 52, 87, 1, 54, TEAL_SIDING); tbox(world, 84, 2, 53, 86, 2, 53, GLASS);
  tbox(world, 87, 2, 53, 87, 2, 53, TEAL_SIDING);
  tbox(world, 83, 1, 52, 83, 1, 54, PALE); tbox(world, 83, 1, 52, 83, 1, 52, ACCENT); tbox(world, 83, 1, 54, 83, 1, 54, ACCENT);
  // Boat-car (fin north, bumper south).
  tbox(world, 81, 1, 41, 83, 1, 45, POOL_TILE_BLUE); tbox(world, 82, 2, 42, 82, 2, 44, GLASS);
  tbox(world, 82, 2, 41, 82, 2, 41, POOL_TILE_BLUE);
  tbox(world, 82, 1, 45, 82, 1, 45, PALE); tbox(world, 81, 1, 45, 81, 1, 45, ACCENT); tbox(world, 83, 1, 45, 83, 1, 45, ACCENT);
  tbox(world, 86, 1, 38, 88, 1, 40, BB_CORAL); tbox(world, 87, 2, 39, 87, 6, 39, BB_KELP);
  // Chum barrel pallet (twin of the A-lot delivery trap stack).
  tbox(world, 78, 1, 57, 80, 4, 58, RUST); tbox(world, 78, 4, 57, 80, 4, 58, TRUCK_RED);
  // Lamp posts flanking the west ramp (P-twins of the drive-thru lamps).
  for (const z of [44, 51]) {
    tbox(world, 88, 1, z, 88, 4, z, RUST);
    tbox(world, 88, 5, z, 88, 5, z, ACCENT);
  }
}
