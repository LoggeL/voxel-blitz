import {
  ACCENT, AIR, BRICK, CONCRETE, GLASS, GRASS, GROUND, METAL, PALE, PLANK,
  RUST, SAND, STONE, SX, SZ,
} from './blocks.js';
import { fillBox } from './flatmaps.js';

/** Retaining panels stay inside the existing cliff silhouette and metal shell. */
function dressFoundryBoundary(world) {
  const panel = (x, y, z, along) => {
    if (world.getBlock(x, y, z) !== METAL) return;
    const rib = along % 12 === 0 || along % 12 === 11;
    const material = rib ? METAL : y === GROUND + 9 ? RUST
      : y === GROUND + 16 ? PALE : y < GROUND + 9 ? CONCRETE : STONE;
    world.setBlock(x, y, z, material);
    if (y === GROUND + 10 && along % 12 >= 4 && along % 12 <= 6) {
      world.setBlock(x, y, z, ACCENT);
    }
  };
  for (let y = 5; y <= GROUND + 16; y++) {
    for (let x = 3; x < SX - 3; x++) {
      panel(x, y, 2, x);
      panel(x, y, SZ - 3, x);
    }
    for (let z = 3; z < SZ - 3; z++) {
      panel(2, y, z, z);
      panel(SX - 3, y, z, z);
    }
  }
}

/** Gravel follows the existing terrain, giving the work yard readable routes. */
function dressWorkPaths(world, heights) {
  const paths = [
    [[18, 48], [31, 44], [47, 46], [65, 48], [85, 46], [108, 48]],
    [[60, 18], [68, 32], [65, 48], [64, 63], [64, 82]],
    [[50, 72], [56, 64], [64, 63]],
    [[80, 24], [77, 34], [68, 38]],
    [[22, 25], [26, 34], [31, 44]],
    [[29, 73], [34, 65], [40, 61]],
    [[97, 29], [93, 37], [85, 46]],
    [[99, 69], [94, 60], [85, 46]],
  ];
  for (const route of paths) {
    for (let i = 1; i < route.length; i++) {
      const [ax, az] = route[i - 1];
      const [bx, bz] = route[i];
      const steps = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
      for (let step = 0; step <= steps; step++) {
        const cx = Math.round(ax + (bx - ax) * step / steps);
        const cz = Math.round(az + (bz - az) * step / steps);
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx * dx + dz * dz > 5) continue;
            const x = cx + dx, z = cz + dz;
            const y = heights[z * SX + x];
            const existing = world.getBlock(x, y, z);
            if (existing !== GRASS && existing !== SAND) continue;
            const edge = dx * dx + dz * dz > 2;
            world.setBlock(x, y, z, edge ? SAND : (x + z * 3) % 7 === 0 ? CONCRETE : STONE);
          }
        }
      }
    }
  }
}

function dressServiceHouse(world, { cx, cz, w, d }) {
  const x0 = cx - (w >> 1), x1 = x0 + w - 1;
  const z0 = cz - (d >> 1), z1 = z0 + d - 1;
  // The roof slab is the top PLANK cell at the centre; use the authored floor,
  // not heightAt, which still contains the original rolling terrain here.
  let roof = GROUND + 10;
  while (roof > 0 && world.getBlock(cx, roof, cz) !== PLANK) roof--;
  const floor = roof - 5;
  for (const x of [x0, x1]) {
    for (const z of [z0, z1]) {
      fillBox(world, x, floor + 1, z, x, roof, z, METAL);
    }
  }
  // A concrete plinth and steel transom make these read as workshops.
  for (let x = x0 + 1; x < x1; x++) {
    for (const z of [z0, z1]) {
      if (world.getBlock(x, floor + 1, z) === PLANK) world.setBlock(x, floor + 1, z, CONCRETE);
      world.setBlock(x, roof - 1, z, RUST);
    }
  }
  for (let z = z0 + 1; z < z1; z++) {
    for (const x of [x0, x1]) {
      if (world.getBlock(x, floor + 1, z) === PLANK) world.setBlock(x, floor + 1, z, CONCRETE);
    }
  }
  // Extraction stack and capped vent, on the rear half away from roof stairs.
  fillBox(world, x1 - 2, roof + 1, z1 - 2, x1 - 1, roof + 3, z1 - 1, RUST);
  fillBox(world, x1 - 2, roof + 4, z1 - 2, x1 - 1, roof + 4, z1 - 1, METAL);
  fillBox(world, cx, roof + 1, z1 - 2, cx + 1, roof + 1, z1 - 1, METAL);
  world.setBlock(cx, roof + 1, z1 - 2, PALE);
  // Low workbenches hug the back wall. Both doorway axes remain empty.
  fillBox(world, x0 + 1, floor + 1, z1 - 1, x0 + 3, floor + 1, z1 - 1, PLANK);
  world.setBlock(x0 + 2, floor + 2, z1 - 1, METAL);
  fillBox(world, x1 - 2, floor + 1, z1 - 1, x1 - 1, floor + 2, z1 - 1, RUST);
  world.setBlock(x1 - 1, floor + 2, z1 - 1, ACCENT);
  // Control panel is inset into the solid rear wall.
  world.setBlock(cx + 1, floor + 2, z1, METAL);
  world.setBlock(cx + 1, floor + 3, z1, GLASS);
}

function dressTower(world, heights, { cx, cz }, index) {
  const base = heights[cz * SX + cx];
  const top = base + 11;
  // Stripe each tower differently to make the four corners easier to call out.
  for (let dx = -2; dx <= 2; dx++) {
    for (const z of [cz - 3, cz + 3]) {
      for (const y of [base + 3, base + 7, base + 10]) {
        if (world.getBlock(cx + dx, y, z) !== AIR) {
          world.setBlock(cx + dx, y, z, y === base + 10 ? PALE : RUST);
        }
      }
    }
  }
  for (let tick = 0; tick <= index; tick++) {
    world.setBlock(cx - 2 + tick, base + 8, cz + 3, PALE);
  }
  // West-face conduit and junction box stay in the occupied tower wall.
  for (let y = base + 1; y < top; y++) {
    if (world.getBlock(cx - 3, y, cz + 1) !== AIR) world.setBlock(cx - 3, y, cz + 1, RUST);
  }
  world.setBlock(cx - 3, base + 3, cz + 1, ACCENT);
  // One rear corner beacon, leaving the deck, entrance and ladder clear.
  fillBox(world, cx - 3, top + 1, cz + 3, cx - 3, top + 2, cz + 3, METAL);
  world.setBlock(cx - 3, top + 3, cz + 3, ACCENT);
}

function dressCrane(world, heights, top) {
  // An open truss sits above the existing beam. Clearance below is unchanged.
  fillBox(world, 61, top + 2, 46, 69, top + 2, 46, METAL);
  for (const x of [61, 63, 67, 69]) world.setBlock(x, top + 1, 46, RUST);
  fillBox(world, 64, top + 1, 46, 66, top + 1, 47, METAL);
  world.setBlock(65, top - 1, 49, METAL);
  world.setBlock(65, top - 2, 49, RUST);
  world.setBlock(66, top - 2, 49, ACCENT);
  // Footplates and hazard bands reuse each mast footprint.
  for (const x of [61, 69]) {
    const base = heights[46 * SX + x];
    world.setBlock(x, base + 1, 46, CONCRETE);
    world.setBlock(x, base + 2, 46, ACCENT);
    world.setBlock(x, base + 4, 46, RUST);
  }
}

function dressSites(world, sites) {
  for (const site of sites) {
    const floor = Math.floor(site.y) - 1;
    for (const x of [site.minX, site.maxX]) {
      for (let z = site.minZ; z <= site.maxZ; z++) {
        world.setBlock(x, floor, z, (z - site.minZ) % 2 === 0 ? ACCENT : METAL);
      }
    }
    // Flush inset sockets read as a heavy-load pad while staying plantable.
    for (const x of [site.minX + 2, site.maxX - 2]) {
      for (const z of [site.minZ + 2, site.maxZ - 2]) world.setBlock(x, floor, z, METAL);
    }
  }
}

export function addFoundryDetails(world, heights, { towers, houses, sites, craneTop }) {
  dressFoundryBoundary(world);
  dressWorkPaths(world, heights);
  towers.forEach((tower, index) => dressTower(world, heights, tower, index));
  houses.forEach((house) => dressServiceHouse(world, house));
  dressCrane(world, heights, craneTop);
  dressSites(world, sites);
  addFurnaceWorks(world, heights);
  addProcessTankYard(world, heights);
  addTurbinePlant(world, heights);
}


/** Level only the footprint of an authored machine; access routes stay outside. */
function machinePad(world, heights, x0, z0, x1, z1, floor, ceiling) {
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const terrain = heights[z * SX + x];
      fillBox(world, x, terrain + 1, z, x, floor, z, CONCRETE);
      world.setBlock(x, floor, z, CONCRETE);
      fillBox(world, x, floor + 1, z, x, ceiling, z, AIR);
    }
  }
}

/** Large casting furnace, hot-face doors, twin stacks and a service catwalk. */
function addFurnaceWorks(world, heights) {
  const floor = GROUND + 1;
  machinePad(world, heights, 73, 31, 90, 40, floor, 36);

  // Brick hot-blast furnace. Its recessed orange hot face gives the yard a
  // readable industrial centrepiece without a new light or damage mechanic.
  fillBox(world, 73, floor + 1, 33, 79, floor + 8, 40, BRICK);
  for (const x of [73, 79]) {
    fillBox(world, x, floor + 1, 33, x, floor + 9, 33, METAL);
    fillBox(world, x, floor + 1, 40, x, floor + 9, 40, METAL);
  }
  fillBox(world, 73, floor + 4, 40, 79, floor + 4, 40, METAL);
  fillBox(world, 73, floor + 8, 33, 79, floor + 8, 40, METAL);
  fillBox(world, 74, floor + 1, 40, 78, floor + 4, 40, METAL);
  fillBox(world, 75, floor + 1, 40, 77, floor + 3, 40, AIR);
  fillBox(world, 75, floor + 1, 39, 77, floor + 3, 39, ACCENT);
  fillBox(world, 75, floor + 2, 39, 77, floor + 2, 39, RUST);
  // A loading lip, a hot-metal spill trough and a separate control cabinet.
  fillBox(world, 74, floor, 40, 78, floor, 40, METAL);
  fillBox(world, 74, floor + 1, 31, 76, floor + 2, 32, RUST);
  fillBox(world, 78, floor + 1, 31, 79, floor + 3, 31, METAL);
  world.setBlock(79, floor + 3, 31, GLASS);

  // Tall stepped smokestack, hollow at the top with a substantial concrete cap.
  fillBox(world, 74, floor + 9, 34, 78, 34, 38, BRICK);
  fillBox(world, 75, floor + 10, 35, 77, 36, 37, AIR);
  fillBox(world, 74, 29, 34, 78, 29, 38, PALE);
  fillBox(world, 75, 29, 35, 77, 29, 37, AIR);
  fillBox(world, 73, 35, 33, 79, 35, 39, METAL);
  fillBox(world, 74, 36, 34, 78, 36, 38, PALE);
  fillBox(world, 75, 35, 35, 77, 36, 37, AIR);

  // The separate round blast vessel keeps a four-wide ground aisle, x80..83.
  const cx = 87, cz = 36;
  for (let y = floor + 1; y <= floor + 10; y++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d = dx * dx + dz * dz;
        if (d > 11 || (d < 5 && y > floor + 1 && y < floor + 10)) continue;
        const band = y === floor + 2 || y === floor + 7 || y === floor + 10;
        world.setBlock(cx + dx, y, cz + dz, band ? METAL : PALE);
      }
    }
  }
  fillBox(world, 86, floor + 11, 35, 88, 33, 37, RUST);
  fillBox(world, 86, 31, 35, 88, 31, 37, METAL);
  world.setBlock(87, 33, 36, AIR);
  // Hot-blast transfer duct spans well above standing headroom in the aisle.
  fillBox(world, 78, floor + 11, 35, 86, floor + 12, 36, RUST);
  fillBox(world, 80, floor + 11, 35, 80, floor + 12, 36, METAL);
  fillBox(world, 84, floor + 11, 35, 84, floor + 12, 36, METAL);
  fillBox(world, 89, floor + 2, 37, 90, floor + 4, 39, METAL);
  world.setBlock(90, floor + 3, 39, ACCENT);

  // A real stair gives the furnace's lower roof a reachable tactical perch.
  // It leaves x68..70 as a three-wide lane beside the north workshop.
  for (let step = 0; step < 8; step++) {
    const z = 40 - step;
    fillBox(world, 71, heights[z * SX + 71] + 1, z, 72, floor + step + 1, z, PALE);
  }
  fillBox(world, 72, floor + 8, 32, 79, floor + 8, 32, METAL);
  for (const x of [73, 75, 77, 79]) world.setBlock(x, floor + 9, 32, METAL);
  fillBox(world, 73, floor + 10, 32, 79, floor + 10, 32, METAL);
}

/** Two banded process tanks, header pipe and pumps beside objective A. */
function addProcessTankYard(world, heights) {
  const floor = GROUND;
  machinePad(world, heights, 41, 58, 53, 64, floor, floor + 10);
  // The centre aisle runs directly into the site approach, never through a tank.
  machinePad(world, heights, 46, 65, 48, 67, floor, floor + 3);
  for (const cx of [43, 51]) {
    const cz = 61;
    for (let y = floor + 1; y <= floor + 8; y++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = dx * dx + dz * dz;
          if (d > 5 || (d < 2 && y > floor + 1 && y < floor + 8)) continue;
          const band = y === floor + 2 || y === floor + 6;
          world.setBlock(cx + dx, y, cz + dz, band ? METAL : PALE);
        }
      }
    }
    fillBox(world, cx - 1, floor + 9, cz - 1, cx + 1, floor + 9, cz + 1, METAL);
    world.setBlock(cx, floor + 10, cz, RUST);
    fillBox(world, cx, floor + 2, 58, cx, floor + 7, 58, RUST);
    world.setBlock(cx, floor + 3, 58, ACCENT);
    // Three-dimensional pump casing at the front of each tank.
    fillBox(world, cx - 1, floor + 1, 64, cx + 1, floor + 2, 64, METAL);
    world.setBlock(cx, floor + 3, 64, RUST);
  }
  fillBox(world, 43, floor + 9, 61, 51, floor + 9, 61, RUST);
  fillBox(world, 47, floor + 9, 60, 47, floor + 9, 62, METAL);
  for (let z = 58; z <= 67; z += 3) {
    world.setBlock(46, floor, z, PALE);
    world.setBlock(48, floor, z, PALE);
  }
}

/** A horizontal turbine, motor housing and outlet stack fill the east work yard. */
function addTurbinePlant(world, heights) {
  const floor = GROUND - 1;
  machinePad(world, heights, 84, 57, 98, 65, floor, 30);
  for (const x of [87, 95]) {
    fillBox(world, x - 1, floor + 1, 58, x + 1, floor + 2, 64, CONCRETE);
  }
  // Long drum with raised steel retaining bands and recessed end rotors.
  for (let x = 87; x <= 96; x++) {
    for (let y = floor + 1; y <= floor + 7; y++) {
      for (let z = 58; z <= 64; z++) {
        const dy = y - (floor + 4), dz = z - 61;
        const d = dy * dy + dz * dz;
        if (d > 11 || (d < 5 && x > 87 && x < 96)) continue;
        world.setBlock(x, y, z, x === 89 || x === 94 || x === 87 || x === 96 ? METAL : PALE);
      }
    }
  }
  fillBox(world, 84, floor + 1, 59, 86, floor + 4, 63, METAL);
  fillBox(world, 84, floor + 2, 59, 84, floor + 3, 63, RUST);
  fillBox(world, 84, floor + 3, 60, 84, floor + 3, 62, GLASS);
  for (let offset = -2; offset <= 2; offset++) {
    world.setBlock(96, floor + 4 + offset, 61, RUST);
    world.setBlock(96, floor + 4, 61 + offset, RUST);
  }
  world.setBlock(96, floor + 4, 61, ACCENT);
  // Outlet elbow and high exhaust make the machinery legible from the centre.
  fillBox(world, 92, floor + 7, 60, 98, floor + 8, 62, METAL);
  fillBox(world, 97, floor + 8, 60, 98, floor + 15, 62, RUST);
  fillBox(world, 96, floor + 15, 59, 98, floor + 15, 63, METAL);
  fillBox(world, 97, floor + 13, 60, 98, floor + 13, 62, PALE);
}
