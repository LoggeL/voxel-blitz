import { ACCENT, AIR, GROUND, METAL, PALE, PLANK, RUST, STONE, GLASS, WOOD } from './blocks.js';
import { fillBox, mirroredBox } from './flatmaps.js';

/** Floodlight mast: lattice legs, RUST braces, ACCENT lamp head. */
function addFloodlightPair(world, x, z) {
  // Two lattice columns with AIR notches every other row.
  for (const dx of [0, 1]) {
    mirroredBox(world, x + dx, GROUND + 1, z, x + dx, GROUND + 9, z + 1, METAL);
  }
  for (let y = GROUND + 3; y <= GROUND + 8; y += 2) {
    mirroredBox(world, x, y, z, x + 1, y, z + 1, AIR);
    mirroredBox(world, x, y - 1, z + 1, x + 1, y - 1, z + 1, ACCENT);
  }
  // Cross braces and the lamp head.
  mirroredBox(world, x - 1, GROUND + 8, z - 1, x + 2, GROUND + 9, z + 2, ACCENT);
  mirroredBox(world, x - 1, GROUND + 6, z - 1, x + 2, GROUND + 6, z - 1, RUST);
  mirroredBox(world, x - 1, GROUND + 4, z + 2, x + 2, GROUND + 4, z + 2, RUST);
}

/** Loading-bay facade: piers, GLASS office band, RUST gutter, step shelf. */
function addLoadingBayPair(world, x0, z0) {
  const x1 = x0 + 16;
  const z1 = z0 + 9;

  // Tall corner piers and a recessed roof read as a loading-bay facade while
  // leaving the full ground-level route and its spawn anchors unobstructed.
  mirroredBox(world, x0, GROUND + 1, z0, x0 + 2, GROUND + 9, z0 + 2, METAL);
  mirroredBox(world, x1 - 2, GROUND + 1, z0, x1, GROUND + 9, z0 + 2, METAL);
  mirroredBox(world, x0, GROUND + 8, z0, x1, GROUND + 9, z1, STONE);
  mirroredBox(world, x0 + 3, GROUND + 7, z0 + 1, x1 - 3, GROUND + 7, z0 + 2, ACCENT);

  // GLASS clerestory windows between the piers.
  mirroredBox(world, x0 + 4, GROUND + 5, z0, x1 - 4, GROUND + 6, z0, GLASS);
  // RUST rain gutter and downspouts on the piers.
  mirroredBox(world, x0 + 3, GROUND + 6, z0, x1 - 3, GROUND + 6, z0, RUST);
  mirroredBox(world, x0 + 2, GROUND + 1, z0 + 1, x0 + 2, GROUND + 3, z0 + 1, RUST);
  mirroredBox(world, x1 - 2, GROUND + 1, z0 + 1, x1 - 2, GROUND + 3, z0 + 1, RUST);

  // Block stairs provide a readable elevated firing shelf without adding a
  // new movement rule or ladder seam.
  for (let step = 0; step < 4; step++) {
    mirroredBox(
      world,
      x0 + 2 + step,
      GROUND + 1,
      z1 + step,
      x1 - 2 - step,
      GROUND + 1 + step,
      z1 + step,
      PALE,
    );
  }
  // WOOD pallet + PLANK crate props at the base of each bay.
  mirroredBox(world, x0 + 4, GROUND + 1, z1 + 1, x0 + 5, GROUND + 1, z1 + 1, WOOD);
  mirroredBox(world, x1 - 5, GROUND + 1, z1 + 1, x1 - 4, GROUND + 2, z1 + 1, PLANK);
}

/** Gantry crane: braced legs, truss beam, RUST load, ACCENT cab. */
function addDepotCrane(world) {
  // Four legs and the overhead gantry are self-symmetric around the map
  // centre. The suspended load stays high enough to preserve the plaza route.
  for (const [x0, z0] of [[53, 38], [72, 38]]) {
    // Leg frames with AIR lattice windows and RUST diagonal braces.
    mirroredBox(world, x0, GROUND + 1, z0, x0 + 2, GROUND + 10, z0 + 2, METAL);
    mirroredBox(world, x0 + 1, GROUND + 2, z0 + 1, x0 + 1, GROUND + 9, z0 + 1, AIR);
    for (let y = GROUND + 3; y <= GROUND + 9; y += 2) {
      mirroredBox(world, x0, y, z0 + 1, x0, y, z0 + 1, RUST);
      mirroredBox(world, x0 + 2, y + 1, z0 + 1, x0 + 2, y + 1, z0 + 1, RUST);
    }
  }

  // Truss beam: top and bottom chords with cutout negative space.
  fillBox(world, 51, GROUND + 10, 44, 76, GROUND + 12, 51, METAL);
  mirroredBox(world, 54, GROUND + 11, 46, 56, GROUND + 11, 49, AIR);
  mirroredBox(world, 59, GROUND + 11, 46, 61, GROUND + 11, 49, AIR);
  mirroredBox(world, 66, GROUND + 11, 46, 68, GROUND + 11, 49, AIR);
  mirroredBox(world, 71, GROUND + 11, 46, 73, GROUND + 11, 49, AIR);
  // Vertical truss posts between chords.
  for (let x = 53; x <= 74; x += 3) {
    fillBox(world, x, GROUND + 11, 47, x, GROUND + 11, 48, METAL);
  }
  // ACCENT warning stripes on the beam ends.
  fillBox(world, 51, GROUND + 10, 44, 52, GROUND + 12, 45, ACCENT);
  fillBox(world, 75, GROUND + 10, 50, 76, GROUND + 12, 51, ACCENT);

  // Operator cab: GLASS face, ACCENT body, METAL hook column.
  mirroredBox(world, 67, GROUND + 9, 51, 69, GROUND + 11, 52, ACCENT);
  mirroredBox(world, 67, GROUND + 9, 53, 69, GROUND + 10, 53, GLASS);

  // Suspended RUST load hanging from the trolley, clear of the plaza floor.
  fillBox(world, 61, GROUND + 9, 46, 66, GROUND + 10, 49, METAL);
  fillBox(world, 62, GROUND + 6, 46, 65, GROUND + 8, 49, RUST);
  fillBox(world, 62, GROUND + 6, 46, 65, GROUND + 6, 49, PLANK);
  fillBox(world, 63, GROUND + 8, 47, 64, GROUND + 8, 48, ACCENT);
}

/** Depot-specific landmark: maintenance gantry over the rail siding. */
function addSidingGantry(world) {
  // Portal frame straddling the south rail siding, plus its mirror.
  for (const [x0, z0] of [[34, 53], [50, 53]]) {
    mirroredBox(world, x0, GROUND + 1, z0, x0 + 1, GROUND + 7, z0 + 1, METAL);
  }
  mirroredBox(world, 34, GROUND + 7, 53, 51, GROUND + 8, 54, RUST);
  mirroredBox(world, 38, GROUND + 6, 53, 47, GROUND + 6, 54, ACCENT);
  mirroredBox(world, 41, GROUND + 1, 53, 44, GROUND + 5, 54, AIR);
  // WOOD signal post beside the gantry.
  mirroredBox(world, 33, GROUND + 1, 56, 33, GROUND + 4, 56, WOOD);
  mirroredBox(world, 33, GROUND + 4, 56, 33, GROUND + 4, 56, ACCENT);
}

/** Iconic, exactly point-symmetric freight-yard silhouettes for Depot. */
export function addDepotSetpieces(world) {
  addLoadingBayPair(world, 10, 28);
  addLoadingBayPair(world, 10, 58);
  addDepotCrane(world);
  addSidingGantry(world);
  addFloodlightPair(world, 41, 20);
  addFloodlightPair(world, 41, 74);

  // Route beacons carry the orange concept-art rhythm through the long lanes.
  for (const [x, z] of [[28, 47], [43, 34], [51, 61]]) {
    mirroredBox(world, x, GROUND + 1, z, x + 1, GROUND + 3, z + 1, ACCENT);
  }
}
