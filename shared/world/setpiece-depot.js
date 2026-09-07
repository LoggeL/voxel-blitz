import { ACCENT, AIR, GROUND, METAL, PALE, PLANK, RUST, STONE, GLASS, WOOD, CONCRETE, SX, SZ, TRUCK_RED } from './blocks.js';
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

  // Underside joists and inset skylights give the broad canopy depth.
  for (let x = x0 + 4; x < x1 - 2; x += 4) {
    mirroredBox(world, x, GROUND + 7, z0 + 3, x, GROUND + 7, z1 - 1, RUST);
  }
  mirroredBox(world, x0 + 6, GROUND + 8, z0 + 4, x0 + 9, GROUND + 9, z0 + 6, GLASS);
  mirroredBox(world, x0 + 1, GROUND + 4, z0 + 2, x0 + 1, GROUND + 4, z0 + 2, PALE);
  mirroredBox(world, x1 - 1, GROUND + 4, z0 + 2, x1 - 1, GROUND + 4, z0 + 2, PALE);

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
  addFloodlightPair(world, 54, 17);
  addFloodlightPair(world, 41, 74);

  // Route beacons carry the orange concept-art rhythm through the long lanes.
  for (const [x, z] of [[28, 47], [43, 34], [51, 61]]) {
    mirroredBox(world, x, GROUND + 1, z, x + 1, GROUND + 3, z + 1, ACCENT);
  }
}


/** A parked forklift sits beside the siding crossing, clear of its portal. */
function addForkliftPair(world) {
  // Compact wheels/body make low cover; the glazed cab and open mast retain
  // visibility above it. Every part is shared, destructible voxel geometry.
  for (const x of [36, 39]) {
    for (const z of [58, 60]) mirroredBox(world, x, GROUND + 1, z, x, GROUND + 1, z, STONE);
  }
  mirroredBox(world, 37, GROUND + 1, 58, 38, GROUND + 2, 61, ACCENT);
  mirroredBox(world, 37, GROUND + 2, 61, 38, GROUND + 2, 61, RUST);
  for (const x of [37, 39]) {
    mirroredBox(world, x, GROUND + 1, 55, x, GROUND + 1, 57, METAL);
  }
  mirroredBox(world, 37, GROUND + 2, 57, 37, GROUND + 4, 57, METAL);
  mirroredBox(world, 39, GROUND + 2, 57, 39, GROUND + 4, 57, METAL);
  mirroredBox(world, 38, GROUND + 4, 57, 38, GROUND + 4, 57, RUST);
  mirroredBox(world, 37, GROUND + 3, 59, 38, GROUND + 3, 59, GLASS);
  mirroredBox(world, 37, GROUND + 3, 60, 37, GROUND + 3, 60, METAL);
  mirroredBox(world, 37, GROUND + 4, 59, 38, GROUND + 4, 60, METAL);
  mirroredBox(world, 38, GROUND + 4, 60, 38, GROUND + 4, 60, ACCENT);
}

function dressDepotBoundary(world) {
  // Panel only the exposed inner face; the indestructible outer shell stays
  // intact. Pairing each write keeps the cargo map exactly point-symmetric.
  for (let y = GROUND + 1; y <= GROUND + 16; y++) {
    const material = (along) => along % 10 === 0 ? METAL
      : y === GROUND + 7 ? PALE : y === GROUND + 8 ? RUST
        : y < GROUND + 7 ? CONCRETE : STONE;
    for (let x = 3; x < SX - 3; x++) {
      mirroredBox(world, x, y, 2, x, y, 2, material(x));
    }
    for (let z = 3; z < SZ - 3; z++) {
      mirroredBox(world, 2, y, z, 2, y, z, material(z));
    }
  }
  // Recessed loading-door panels and hazard lintels remain solid boundary.
  for (const x of [48, 70, 96]) {
    mirroredBox(world, x, GROUND + 1, 2, x + 5, GROUND + 5, 2, RUST);
    for (let dx = 0; dx <= 5; dx++) {
      mirroredBox(world, x + dx, GROUND + 6, 2, x + dx, GROUND + 6, 2, dx % 2 === 0 ? ACCENT : METAL);
    }
  }
}

/** Authored operational traces finish the yard without scattering route clutter. */
export function addDepotOperations(world) {
  dressDepotBoundary(world);
  addForkliftPair(world);
  // Forklift staging grid and paired tire tracks are flush floor paint.
  for (const z of [55, 62]) mirroredBox(world, 35, GROUND, z, 40, GROUND, z, PALE);
  for (const x of [35, 40]) mirroredBox(world, x, GROUND, 56, x, GROUND, 61, PALE);
  for (let z = 58; z <= 66; z++) {
    for (const x of [36, 39]) {
      if (z % 3 !== 0) mirroredBox(world, x, GROUND, z, x, GROUND, z, STONE);
    }
  }
  // Perimeter drain grates and lane service covers are inset, never raised.
  for (let x = 46; x <= 72; x += 4) {
    mirroredBox(world, x, GROUND, 7, x + 1, GROUND, 7, METAL);
  }
  for (const [x, z] of [[48, 37], [56, 54], [81, 25]]) {
    mirroredBox(world, x, GROUND, z, x + 1, GROUND, z + 1, METAL);
    mirroredBox(world, x, GROUND, z, x, GROUND, z, STONE);
  }
  // Crane-zone chevrons frame the hoist at ground level, with no new barrier.
  for (let x = 60; x <= 66; x += 2) {
    mirroredBox(world, x, GROUND, 43, x, GROUND, 44, ACCENT);
  }
  addFreightTruckPair(world);
  addRailFlatcarPair(world);
  addMaintenanceGaragePair(world);
}


/** Full tractor-trailer pair replaces the small north/south container stack. */
function addFreightTruckPair(world) {
  // The original container footprint is reused. The cab extends into the yard,
  // stopping four cells before the nearest spawn anchor at (49,20).
  mirroredBox(world, 26, GROUND + 1, 17, 45, GROUND + 11, 23, AIR);
  mirroredBox(world, 28, GROUND + 2, 18, 40, GROUND + 2, 22, METAL);
  mirroredBox(world, 29, GROUND + 3, 17, 40, GROUND + 3, 23, WOOD);
  for (const x of [30, 31, 37, 38, 42, 43]) {
    for (const z of [17, 23]) {
      mirroredBox(world, x, GROUND + 1, z, x, GROUND + 2, z, STONE);
    }
  }
  // A hollow, accessible cargo trailer, with a bright roof and corrugated sides.
  mirroredBox(world, 29, GROUND + 4, 17, 40, GROUND + 8, 23, PALE);
  mirroredBox(world, 30, GROUND + 4, 18, 39, GROUND + 7, 22, AIR);
  for (const x of [29, 33, 37, 40]) {
    for (const z of [17, 23]) {
      mirroredBox(world, x, GROUND + 4, z, x, GROUND + 7, z, METAL);
    }
  }
  mirroredBox(world, 29, GROUND + 4, 19, 29, GROUND + 6, 21, AIR);
  mirroredBox(world, 29, GROUND + 7, 18, 29, GROUND + 7, 22, ACCENT);
  // Rear loading ramp is three wide and reaches the true trailer floor.
  for (let step = 0; step < 3; step++) {
    mirroredBox(world, 26 + step, GROUND + 1, 19, 26 + step, GROUND + 1 + step, 21, PLANK);
  }
  mirroredBox(world, 34, GROUND + 4, 22, 36, GROUND + 5, 22, PLANK);
  mirroredBox(world, 38, GROUND + 4, 18, 39, GROUND + 6, 18, WOOD);
  // Roof rails and a paired side stripe keep the long white box legible.
  mirroredBox(world, 29, GROUND + 6, 17, 40, GROUND + 6, 17, TRUCK_RED);
  mirroredBox(world, 29, GROUND + 6, 23, 40, GROUND + 6, 23, TRUCK_RED);
  for (const z of [17, 23]) {
    mirroredBox(world, 29, GROUND + 8, z, 40, GROUND + 8, z, METAL);
  }
  // Distinct red tractor: low chassis, glazed cab, grille and pale headlamps.
  mirroredBox(world, 40, GROUND + 2, 18, 45, GROUND + 2, 22, METAL);
  mirroredBox(world, 41, GROUND + 3, 18, 45, GROUND + 6, 22, TRUCK_RED);
  mirroredBox(world, 42, GROUND + 4, 19, 44, GROUND + 5, 21, AIR);
  mirroredBox(world, 45, GROUND + 4, 19, 45, GROUND + 5, 21, GLASS);
  for (const z of [18, 22]) {
    mirroredBox(world, 42, GROUND + 5, z, 44, GROUND + 5, z, GLASS);
  }
  mirroredBox(world, 41, GROUND + 7, 18, 45, GROUND + 7, 22, METAL);
  mirroredBox(world, 45, GROUND + 3, 19, 45, GROUND + 3, 21, METAL);
  for (const z of [18, 22]) mirroredBox(world, 45, GROUND + 3, z, 45, GROUND + 3, z, PALE);
  mirroredBox(world, 40, GROUND + 4, 22, 40, GROUND + 8, 22, METAL);
}

/** Loaded rail wagons sit on the existing siding, outside the haul road. */
function addRailFlatcarPair(world) {
  // Full wagon underframe with paired bogies and couplers at either end.
  mirroredBox(world, 15, GROUND + 2, 52, 30, GROUND + 2, 56, METAL);
  mirroredBox(world, 15, GROUND + 3, 52, 30, GROUND + 3, 56, PLANK);
  for (const x of [18, 19, 26, 27]) {
    for (const z of [52, 56]) mirroredBox(world, x, GROUND + 1, z, x, GROUND + 1, z, STONE);
  }
  mirroredBox(world, 14, GROUND + 2, 54, 14, GROUND + 2, 54, METAL);
  mirroredBox(world, 31, GROUND + 2, 54, 31, GROUND + 2, 54, METAL);
  // Bundled I-beams leave open deck ends as partial cover and firing steps.
  for (const z of [53, 55]) {
    mirroredBox(world, 18, GROUND + 4, z, 27, GROUND + 4, z, RUST);
    mirroredBox(world, 18, GROUND + 5, z, 27, GROUND + 5, z, METAL);
    mirroredBox(world, 18, GROUND + 6, z, 27, GROUND + 6, z, RUST);
  }
  for (const x of [20, 25]) {
    mirroredBox(world, x, GROUND + 4, 52, x, GROUND + 6, 56, METAL);
    mirroredBox(world, x, GROUND + 7, 53, x, GROUND + 7, 55, METAL);
  }
  for (const x of [15, 30]) {
    mirroredBox(world, x, GROUND + 4, 52, x, GROUND + 4, 56, ACCENT);
  }
}

/** Two open workshops surround repair machinery beside the siding gantries. */
function addMaintenanceGaragePair(world) {
  // An open-front, drive-through workshop: x44..49 stays six wide through both
  // ends. It does not cross the east-west road or the siding portal at z53.
  mirroredBox(world, 40, GROUND + 1, 56, 53, GROUND + 8, 64, AIR);
  for (const x of [40, 53]) {
    mirroredBox(world, x, GROUND + 1, 56, x, GROUND + 7, 64, METAL);
    mirroredBox(world, x, GROUND + 3, 58, x, GROUND + 5, 62, PALE);
  }
  mirroredBox(world, 40, GROUND + 1, 64, 53, GROUND + 6, 64, CONCRETE);
  mirroredBox(world, 44, GROUND + 1, 64, 49, GROUND + 5, 64, AIR);
  // Heavy roof edge, recessed corrugated deck, three long skylights.
  mirroredBox(world, 40, GROUND + 7, 56, 53, GROUND + 7, 64, METAL);
  mirroredBox(world, 41, GROUND + 8, 57, 52, GROUND + 8, 63, PALE);
  for (const x of [43, 47, 51]) {
    mirroredBox(world, x, GROUND + 7, 58, x + 1, GROUND + 8, 62, GLASS);
  }
  mirroredBox(world, 40, GROUND + 6, 56, 53, GROUND + 6, 56, ACCENT);
  for (const x of [40, 43, 50, 53]) {
    mirroredBox(world, x, GROUND + 1, 56, x, GROUND + 6, 56, METAL);
  }
  // Hydraulic press to the left; a generator and tool cabinets to the right.
  mirroredBox(world, 41, GROUND + 1, 59, 43, GROUND + 1, 62, CONCRETE);
  for (const x of [41, 43]) {
    mirroredBox(world, x, GROUND + 2, 59, x, GROUND + 5, 62, METAL);
  }
  mirroredBox(world, 41, GROUND + 5, 59, 43, GROUND + 5, 62, RUST);
  mirroredBox(world, 42, GROUND + 2, 60, 42, GROUND + 3, 61, ACCENT);
  mirroredBox(world, 50, GROUND + 1, 59, 52, GROUND + 3, 61, METAL);
  mirroredBox(world, 50, GROUND + 2, 59, 50, GROUND + 2, 61, RUST);
  mirroredBox(world, 51, GROUND + 4, 60, 51, GROUND + 5, 60, METAL);
  mirroredBox(world, 50, GROUND + 1, 63, 52, GROUND + 2, 63, PLANK);
  // The garage joins the existing crane corner; retain the mast above its roof.
  mirroredBox(world, 53, GROUND + 8, 56, 53, GROUND + 10, 57, METAL);
  // Staging pallets by the rear corners leave the central return opening clear.
  mirroredBox(world, 41, GROUND + 1, 66, 43, GROUND + 2, 67, PLANK);
  mirroredBox(world, 50, GROUND + 1, 66, 52, GROUND + 1, 67, WOOD);
  mirroredBox(world, 44, GROUND + 1, 56, 49, GROUND + 2, 67, AIR);
}
