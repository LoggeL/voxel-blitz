// Bikini Bottom R2 West downtown, Krusty Krab (site A) (x15-49, z34-61).
// Original procedural voxel work inspired by the show; no copied assets.
// Writes y > GROUND only inside its own rectangle (map-spec §2); floor
// paint (y <= GROUND) likewise.
//
// A lobster-trap diner: hull-plank skirt, rail, lattice netting, a gable roof
// whose centre slots are open skylights over the dining floor (site A), a
// kitchen deck one step up, and the A lot of boat-cars outside the drive-thru.
// Every free-standing top is T+1, a 1-step T+2/T+3, or at least T+4
// (map-spec §1.2); detail above head height hangs from walls and roof.
import {
  GROUND, AIR, ACCENT, BB_CORAL, BB_HULL, BB_KELP, BUS_YELLOW, DUST_CRATE, DUST_WOOD, GLASS, MC_CHEST, MC_IRON,
  PALE, PLANK, ROOF, RUST, TRUCK_RED, WOOD,
} from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';

const T = GROUND;
const SALT = 20260924;
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

// Diner shell x15-36, z37-58; the gable roof runs z36-59 over x15-37.
const WX0 = 15, WX1 = 36, WZ0 = 37, WZ1 = 58;
/** Roof course y at row z: 24 at the eaves rising to 27 around the ridge. */
const roofY = (z) => 24 + Math.min(3, Math.floor((12 - Math.abs(z - 47.5)) / 3));
/** Skylight rows: odd z within 5 of the ridge are open (map-spec §6.2). */
const skylight = (z) => Math.abs(z - 47.5) < 5 && z % 2 === 1;

export function buildKrustyKrab(world) {
  buildWalls(world);
  buildRoof(world);
  buildInterior(world);
  buildOutside(world);
  buildALot(world);
}

/** §6.1: hull skirt, rail, lattice netting, three portals, portholes, sign backing. */
function buildWalls(world) {
  for (let x = WX0; x <= WX1; x++) for (let z = WZ0; z <= WZ1; z++) {
    if (x !== WX0 && x !== WX1 && z !== WZ0 && z !== WZ1) continue;
    tbox(world, x, 1, z, x, 3, z, BB_HULL);
    tbox(world, x, 4, z, x, 4, z, WOOD);
    const along = x === WX0 || x === WX1 ? z : x;
    for (let h = 5; h <= 9; h++) {
      tbox(world, x, h, z, x, h, z, along % 3 === 0 ? WOOD : h % 2 === 1 ? PLANK : GLASS);
    }
  }
  // Single-thickness PLANK gable panel behind THE KRUSTY KRAB sign (air at z59).
  tbox(world, 22, 5, 58, 28, 7, 58, PLANK);
  // Exactly three portals; the h4 rail stays as each lintel.
  tbox(world, 24, 1, 58, 27, 3, 58, AIR);                       // front (south)
  tbox(world, 23, 1, 58, 23, 3, 58, TRUCK_RED); tbox(world, 28, 1, 58, 28, 3, 58, TRUCK_RED);
  // Back door centred on the dining floor (x24-27, the front door's twin line)
  // so bots sliding along the north wall toward the site centre walk in.
  tbox(world, 24, 1, 37, 27, 3, 37, AIR);                       // back (north)
  tbox(world, 23, 1, 37, 23, 3, 37, WOOD); tbox(world, 28, 1, 37, 28, 3, 37, WOOD);
  tbox(world, 36, 1, 46, 36, 3, 49, AIR);                       // drive-thru (east)
  tbox(world, 36, 1, 45, 36, 3, 45, TRUCK_RED); tbox(world, 36, 1, 50, 36, 3, 50, TRUCK_RED);
  // West portholes: PALE rim, 2x2 GLASS pane.
  for (const z0 of [42, 47, 52]) {
    tbox(world, 15, 1, z0 - 1, 15, 4, z0 + 2, PALE);
    tbox(world, 15, 2, z0, 15, 3, z0 + 1, GLASS);
  }
  tbox(world, 36, 2, 52, 36, 3, 53, GLASS);                     // order window
}

/** §6.2: gable roof with skylight slots, ridge, chimney, mast, flag, plus trim. */
function buildRoof(world) {
  for (let z = 36; z <= 59; z++) {
    const y = roofY(z), centre = Math.abs(z - 47.5) < 5;
    for (let x = WX0; x <= 37; x++) {
      if (skylight(z)) continue;
      // Barnacle crusts on the shingles; the slatted centre stays plank.
      put(world, x, y, z, centre ? PLANK : hashBB(x, y, z) < 0.05 ? BB_CORAL : ROOF);
    }
    if (z < WZ0 || z > WZ1) continue;
    for (const x of [WX0, WX1]) for (let yy = 24; yy < y; yy++) put(world, x, yy, z, PLANK);   // gable infill
  }
  // Round gable portholes under the ridge on both ends.
  for (const x of [WX0, WX1]) {
    fillBox(world, x, 25, 46, x, 25, 49, PALE);
    fillBox(world, x, 24, 47, x, 26, 48, PALE);
    fillBox(world, x, 25, 47, x, 25, 48, GLASS);
  }
  fillBox(world, 15, 28, 47, 37, 28, 48, WOOD);                 // ridge
  for (const x of [15, 37]) fillBox(world, x, 28, 47, x, 28, 48, ACCENT);   // ridge caps
  fillBox(world, 31, 24, 38, 32, 33, 39, RUST);                 // chimney
  fillBox(world, 31, 34, 38, 32, 34, 39, ACCENT);
  fillBox(world, 25, 29, 47, 25, 36, 47, WOOD);                 // mast
  put(world, 25, 37, 47, ACCENT);                               // masthead
  fillBox(world, 26, 33, 47, 29, 35, 47, TRUCK_RED);            // voxel flag
  fillBox(world, 27, 34, 47, 28, 34, 47, PALE);
  // PALE rigging stays from the masthead down to the shingles, north and south.
  for (const dir of [-1, 1]) {
    for (let k = 0; ; k++) {
      const y = 35 - k, z = (dir < 0 ? 46 : 48) + dir * k;
      if (z < 36 || z > 59 || y <= roofY(z)) break;
      put(world, 25, y, z, PALE);
    }
  }
  // Lobster-trap corner buoys on the eaves.
  for (const [x, z] of [[15, 36], [37, 36], [15, 59], [37, 59]]) {
    fillBox(world, x, 25, z, x, 26, z, WOOD);
    put(world, x, 27, z, TRUCK_RED);
  }
}

/** §6.3: plank floor, kitchen deck, counter, register, site cover, office. */
function buildInterior(world) {
  // Staggered board seams in the plank floor, DUST_WOOD border, ACCENT site ticks.
  for (let z = 38; z <= 57; z++) for (let x = 16; x <= 35; x++) {
    const ring = x === 16 || x === 35 || z === 38 || z === 57;
    const seam = (x + 3 * (z % 2)) % 6 === 0 && hashBB(x, T, z) < 0.7;
    put(world, x, T, z, ring || seam ? DUST_WOOD : PLANK);
  }
  for (const [x, z] of [[20, 42], [31, 42], [20, 53], [31, 53]]) put(world, x, T, z, ACCENT);
  paintFloor(world, 24, 56, 27, 57, T, TRUCK_RED);              // welcome mat inside the front door

  // Kitchen deck one step up, grill under a hood, fryer, safe, supply shelf.
  tbox(world, 16, 1, 38, 35, 1, 40, PLANK);
  // Step well inside the back door: the deck step sits one voxel in, clear of
  // the h4 lintel, so walkers hop it with full headroom.
  tbox(world, 24, 1, 38, 27, 1, 38, AIR);
  paintFloor(world, 24, 38, 27, 38, T, DUST_WOOD);
  tbox(world, 18, 2, 38, 20, 2, 38, RUST); tbox(world, 19, 2, 38, 19, 2, 38, ACCENT);
  tbox(world, 29, 2, 38, 30, 2, 38, RUST);
  tbox(world, 33, 2, 38, 34, 3, 38, MC_IRON);
  tbox(world, 16, 2, 38, 17, 3, 38, PLANK);
  fillBox(world, 18, 20, 38, 20, 20, 39, RUST);                 // hood
  fillBox(world, 19, 21, 38, 19, roofY(38) - 1, 38, RUST);      // duct to the roof
  // Counter (the elevated A head-glitch) with two walk-through gaps.
  tbox(world, 16, 1, 41, 35, 1, 41, BB_HULL); tbox(world, 16, 2, 41, 35, 2, 41, PLANK);
  tbox(world, 22, 1, 41, 23, 2, 41, AIR); tbox(world, 30, 1, 41, 31, 2, 41, AIR);
  // Menu board hung above the counter, out of jump reach.
  fillBox(world, 24, 21, 41, 29, 22, 41, PALE);
  for (let x = 24; x <= 29; x++) put(world, x, x % 2 ? 22 : 21, 41, x % 2 ? ACCENT : TRUCK_RED);
  // Register boat and cash box.
  tbox(world, 26, 1, 42, 29, 1, 43, BB_HULL); tbox(world, 27, 2, 42, 27, 2, 42, ACCENT);

  // Site cover: three tables, the lobster tank, the east barrel stack.
  for (const [x, z] of [[21, 45], [21, 50], [29, 47]]) tbox(world, x, 1, z, x + 1, 1, z + 1, PLANK);
  for (const [x, z] of [[20, 45], [23, 46], [20, 50], [23, 51], [28, 48], [31, 47]]) {
    tbox(world, x, 1, z, x, 1, z, DUST_WOOD);                   // barrel stools
  }
  tbox(world, 25, 1, 49, 26, 2, 50, BB_HULL); tbox(world, 25, 3, 49, 26, 4, 50, GLASS);
  tbox(world, 32, 1, 44, 33, 2, 45, WOOD); tbox(world, 34, 1, 44, 34, 1, 44, WOOD);
  // Lanterns on chains from the roof boards over the tables, kitchen and vestibule.
  for (const [x, z] of [[22, 46], [22, 50], [30, 48], [25, 39], [28, 55]]) {
    put(world, x, 20, z, ACCENT);
    put(world, x, 21, z, PALE);
    fillBox(world, x, 22, z, x, roofY(z) - 1, z, WOOD);
  }
  // Ship's wheel on the west wall, life ring on the east wall (above head height).
  fillBox(world, 16, 19, 44, 16, 21, 46, WOOD); put(world, 16, 20, 45, ACCENT);
  for (const [y, z] of [[19, 56], [21, 56], [20, 55], [20, 57]]) put(world, 35, y, z, TRUCK_RED);
  for (const [y, z] of [[19, 55], [19, 57], [21, 55], [21, 57]]) put(world, 35, y, z, PALE);

  // Office behind a hull partition: desk, cash bag, strongbox.
  tbox(world, 22, 1, 54, 22, 4, 57, BB_HULL); tbox(world, 22, 1, 55, 22, 3, 56, AIR);
  tbox(world, 17, 1, 57, 19, 1, 57, PLANK); tbox(world, 17, 2, 57, 17, 2, 57, ACCENT);
  tbox(world, 16, 1, 54, 16, 1, 54, MC_CHEST);
  // Vestibule queue posts with a rope between them.
  tbox(world, 29, 1, 55, 29, 1, 55, WOOD); tbox(world, 32, 1, 55, 32, 1, 55, WOOD);
  tbox(world, 30, 1, 55, 31, 1, 55, TRUCK_RED);
}

/** §6.4 outside: boardwalks, grease barrels, dock pylons, patio, sign frame. */
function buildOutside(world) {
  paintFloor(world, 15, 34, 36, 36, T, DUST_WOOD);              // back dock boardwalk
  paintFloor(world, 15, 59, 36, 61, T, PLANK);                  // front patio boardwalk
  tbox(world, 28, 1, 34, 30, 2, 35, RUST); tbox(world, 31, 1, 34, 31, 1, 35, RUST);
  for (const x of [16, 35]) {
    tbox(world, x, 1, 35, x, 4, 35, WOOD);
    tbox(world, x, 3, 35, x, 3, 35, PALE);                      // rope band
  }
  tbox(world, 30, 1, 60, 32, 1, 61, PLANK);                     // picnic table
  tbox(world, 16, 1, 59, 16, 2, 60, DUST_CRATE); tbox(world, 17, 1, 59, 17, 1, 60, DUST_CRATE);
  tbox(world, 35, 1, 60, 35, 5, 60, RUST); tbox(world, 34, 1, 60, 36, 1, 60, RUST);   // leaning anchor
  // Driftwood frame around the sign; the painted cells x22-28 y19-21 z59 stay air.
  fillBox(world, 21, 18, 59, 29, 18, 59, WOOD);
  fillBox(world, 21, 22, 59, 29, 22, 59, WOOD);
  fillBox(world, 21, 19, 59, 21, 21, 59, WOOD); fillBox(world, 29, 19, 59, 29, 21, 59, WOOD);
  for (const [x, y] of [[21, 18], [29, 18], [21, 22], [29, 22]]) put(world, x, y, 59, ACCENT);
}

/** §6.4 A lot: boat-cars, planter, delivery trap stack; the R4 B lot is its P-image. */
function buildALot(world) {
  // Parking bays painted on the sand.
  paintFloor(world, 39, 40, 45, 40, T, PALE); paintFloor(world, 39, 44, 45, 44, T, PALE);
  paintFloor(world, 43, 49, 43, 55, T, PALE); paintFloor(world, 47, 49, 47, 55, T, PALE);
  // Boat-car 1 (tail fin west, bumper and headlights east).
  tbox(world, 40, 1, 41, 44, 1, 43, TRUCK_RED); tbox(world, 41, 2, 42, 43, 2, 42, GLASS);
  tbox(world, 40, 2, 42, 40, 2, 42, TRUCK_RED);
  tbox(world, 44, 1, 41, 44, 1, 43, PALE); tbox(world, 44, 1, 41, 44, 1, 41, ACCENT); tbox(world, 44, 1, 43, 44, 1, 43, ACCENT);
  // Boat-car 2 (tail fin south, bumper north).
  tbox(world, 44, 1, 50, 46, 1, 54, BUS_YELLOW); tbox(world, 45, 2, 51, 45, 2, 53, GLASS);
  tbox(world, 45, 2, 54, 45, 2, 54, BUS_YELLOW);
  tbox(world, 45, 1, 50, 45, 1, 50, PALE); tbox(world, 44, 1, 50, 44, 1, 50, ACCENT); tbox(world, 46, 1, 50, 46, 1, 50, ACCENT);
  // Coral planter with a kelp stalk.
  tbox(world, 39, 1, 55, 41, 1, 57, BB_CORAL); tbox(world, 40, 2, 56, 40, 6, 56, BB_KELP);
  // Delivery trap stack: cuts the x47-49 N-S line (twin of the R4 chum barrel pallet).
  tbox(world, 47, 1, 37, 49, 3, 38, DUST_CRATE); tbox(world, 47, 4, 37, 49, 4, 38, WOOD);
  // Lamp posts flanking the drive-thru (P-twins flank the R4 west ramp).
  for (const z of [44, 51]) {
    tbox(world, 38, 1, z, 38, 4, z, WOOD);
    tbox(world, 38, 5, z, 38, 5, z, ACCENT);
  }
}
