import {
  AIR,
  ACCENT,
  CONCRETE,
  GROUND,
  METAL,
  PALE,
  STONE,
  SX,
  SZ,
} from './blocks.js';

function fillBox(world, x0, y0, z0, x1, y1, z1, type) {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) world.setBlock(x, y, z, type);
    }
  }
}

function mirroredBox(world, x0, y0, z0, x1, y1, z1, type) {
  fillBox(world, x0, y0, z0, x1, y1, z1, type);
  fillBox(
    world,
    SX - 1 - x1,
    y0,
    SZ - 1 - z1,
    SX - 1 - x0,
    y1,
    SZ - 1 - z0,
    type,
  );
}

function addFloodlightPair(world, x, z) {
  mirroredBox(world, x, GROUND + 1, z, x + 1, GROUND + 8, z + 1, METAL);
  mirroredBox(world, x - 1, GROUND + 8, z - 1, x + 2, GROUND + 9, z + 2, ACCENT);
}

function addLoadingBayPair(world, x0, z0) {
  const x1 = x0 + 16;
  const z1 = z0 + 9;

  // Tall corner piers and a recessed roof read as a loading-bay facade while
  // leaving the full ground-level route and its spawn anchors unobstructed.
  mirroredBox(world, x0, GROUND + 1, z0, x0 + 2, GROUND + 9, z0 + 2, METAL);
  mirroredBox(world, x1 - 2, GROUND + 1, z0, x1, GROUND + 9, z0 + 2, METAL);
  mirroredBox(world, x0, GROUND + 8, z0, x1, GROUND + 9, z1, STONE);
  mirroredBox(world, x0 + 3, GROUND + 7, z0 + 1, x1 - 3, GROUND + 7, z0 + 2, ACCENT);

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
}

function addDepotCrane(world) {
  // Four legs and the overhead gantry are self-symmetric around the map
  // centre. The suspended load stays high enough to preserve the plaza route.
  for (const [x0, z0] of [[53, 38], [72, 38]]) {
    mirroredBox(world, x0, GROUND + 1, z0, x0 + 2, GROUND + 10, z0 + 2, METAL);
  }
  fillBox(world, 51, GROUND + 10, 44, 76, GROUND + 12, 51, METAL);
  fillBox(world, 61, GROUND + 9, 46, 66, GROUND + 10, 49, ACCENT);
  fillBox(world, 62, GROUND + 6, 46, 65, GROUND + 8, 49, METAL);

  // Open the beam's negative spaces so it reads as a truss instead of a slab.
  mirroredBox(world, 54, GROUND + 11, 46, 56, GROUND + 11, 49, AIR);
  mirroredBox(world, 59, GROUND + 11, 46, 61, GROUND + 11, 49, AIR);
}

/** Iconic, exactly point-symmetric freight-yard silhouettes for Depot. */
export function addDepotSetpieces(world) {
  addLoadingBayPair(world, 10, 28);
  addLoadingBayPair(world, 10, 58);
  addDepotCrane(world);
  addFloodlightPair(world, 41, 20);
  addFloodlightPair(world, 41, 74);

  // Route beacons carry the orange concept-art rhythm through the long lanes.
  for (const [x, z] of [[28, 47], [43, 34], [51, 61]]) {
    mirroredBox(world, x, GROUND + 1, z, x + 1, GROUND + 3, z + 1, ACCENT);
  }
}

function addCrenellations(world, x0, z0, x1, z1, y) {
  for (let x = x0; x <= x1; x += 3) {
    world.setBlock(x, y, z0, STONE);
    world.setBlock(x, y, z1, STONE);
  }
  for (let z = z0; z <= z1; z += 3) {
    world.setBlock(x0, y, z, STONE);
    world.setBlock(x1, y, z, STONE);
  }
}

function addKeepTower(world, x0, z0, x1, z1, height) {
  fillBox(world, x0, GROUND + 1, z0, x1, GROUND + height, z1, STONE);
  fillBox(world, x0 + 2, GROUND + 3, z0, x1 - 2, GROUND + height - 2, z0, METAL);
  for (let y = GROUND + 4; y <= GROUND + height - 2; y += 3) {
    world.setBlock(Math.floor((x0 + x1) / 2), y, z0, ACCENT);
  }
  addCrenellations(world, x0, z0, x1, z1, GROUND + height + 1);
}

function addGateApproach(world) {
  // The doorway enters a closed inner keep; it adds identity without opening
  // the A-to-B sightline that the mode contract relies on.
  fillBox(world, 60, GROUND + 1, 27, 66, GROUND + 5, 30, AIR);
  fillBox(world, 59, GROUND + 1, 25, 67, GROUND + 7, 26, METAL);
  fillBox(world, 61, GROUND + 2, 25, 65, GROUND + 5, 26, ACCENT);
  for (let step = 0; step < 4; step++) {
    fillBox(
      world,
      58 + step,
      GROUND + 1,
      21 + step,
      68 - step,
      GROUND + 1 + step,
      21 + step,
      PALE,
    );
  }
}

/** Strong keep/tower silhouettes for Citadel, built from existing materials. */
export function addCitadelSetpieces(world) {
  addKeepTower(world, 48, 25, 55, 34, 12);
  addKeepTower(world, 71, 25, 78, 34, 12);
  addKeepTower(world, 48, 58, 55, 67, 10);
  addKeepTower(world, 71, 58, 78, 67, 10);
  addGateApproach(world);

  // Battlement bridges visually connect the keep but stay overhead so both
  // ground rotations remain open and readable.
  fillBox(world, 55, GROUND + 8, 27, 71, GROUND + 9, 30, CONCRETE);
  fillBox(world, 55, GROUND + 8, 62, 71, GROUND + 9, 65, CONCRETE);
  for (let x = 56; x <= 70; x += 3) {
    world.setBlock(x, GROUND + 10, 27, STONE);
    world.setBlock(x, GROUND + 10, 65, STONE);
  }

  // Compact beacon pylons distinguish the long rotations at a glance.
  for (const [x, z] of [[44, 19], [63, 19], [82, 19], [44, 76], [63, 76], [82, 76]]) {
    fillBox(world, x, GROUND + 1, z, x + 1, GROUND + 5, z + 1, METAL);
    fillBox(world, x, GROUND + 4, z, x + 1, GROUND + 5, z + 1, ACCENT);
  }
}
