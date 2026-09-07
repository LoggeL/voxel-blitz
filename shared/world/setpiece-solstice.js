import {
  ACCENT,
  AIR,
  BRICK,
  CONCRETE,
  DIRT,
  GLASS,
  GROUND,
  LEAVES,
  METAL,
  PALE,
  PLANK,
  RUST,
  SAND,
  STONE,
  WOOD,
} from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';

function ringVoxel(world, cx, cy, z, radius, thickness, type) {
  const outer = radius + thickness;
  const inner = Math.max(0, radius - thickness);
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance >= inner && distance <= outer) world.setBlock(x, y, z, type);
    }
  }
}

function crate(world, x, z, w = 2, d = 2, h = 2, type = PLANK) {
  fillBox(world, x, GROUND + 1, z, x + w - 1, GROUND + h, z + d - 1, type);
  for (let px = x; px < x + w; px++) {
    world.setBlock(px, GROUND + h, z, WOOD);
    world.setBlock(px, GROUND + h, z + d - 1, WOOD);
  }
  // Corner protectors and a shipping stamp belong to the existing crate volume.
  for (const px of [x, x + w - 1]) {
    world.setBlock(px, GROUND + 1, z, type === RUST ? METAL : WOOD);
    world.setBlock(px, GROUND + 1, z + d - 1, type === RUST ? METAL : WOOD);
  }
  if (w > 2) world.setBlock(x + 1, GROUND + h, z, PALE);
}

function desertTree(world, x, z) {
  const T = GROUND;
  // Mature specimen trees fill the greenhouse height with trunks, forked limbs
  // and overlapping crowns, while their ground footprint stays in the beds.
  fillBox(world, x, T + 1, z, x, T + 9, z, WOOD);
  fillBox(world, x - 2, T + 6, z, x + 2, T + 6, z, WOOD);
  fillBox(world, x - 2, T + 6, z, x - 2, T + 8, z, WOOD);
  fillBox(world, x + 2, T + 6, z, x + 2, T + 8, z, WOOD);
  fillBox(world, x, T + 7, z - 2, x, T + 7, z + 2, WOOD);
  for (const [cx, cy, cz, rx, ry, rz] of [
    [x - 2, T + 9, z, 3.8, 2.4, 3.2],
    [x + 2, T + 10, z + 1, 3.7, 2.7, 3.6],
    [x, T + 12, z - 1, 3.6, 2.2, 3.2],
  ]) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let pz = Math.floor(cz - rz); pz <= Math.ceil(cz + rz); pz++) {
        for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
          if (((px - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((pz - cz) / rz) ** 2 > 1) continue;
          if (world.getBlock(px, y, pz) === AIR) world.setBlock(px, y, pz, LEAVES);
        }
      }
    }
  }
}

function solarPanelX(world, x0, z0, width = 8, depth = 5, rise = 2, baseY = GROUND + 8) {
  for (let dz = 0; dz < depth; dz++) {
    const y = baseY + Math.round((dz / Math.max(1, depth - 1)) * rise);
    for (let x = x0; x < x0 + width; x++) {
      world.setBlock(x, y, z0 + dz, (x + dz) % 5 === 0 ? ACCENT : GLASS);
    }
  }
  for (const x of [x0, x0 + width - 1]) {
    fillBox(world, x, baseY - 2, z0 + 1, x, baseY - 1, z0 + 1, METAL);
    fillBox(world, x, baseY - 2, z0 + depth - 2, x, baseY, z0 + depth - 2, METAL);
  }
}

/** Monumental halo plus a sheltered, playable calibration court beneath it. */
function buildHeliostat(world) {
  const T = GROUND;
  paintFloor(world, 51, 31, 77, 62, T, PALE);
  paintFloor(world, 57, 25, 71, 70, T, CONCRETE);

  // Low plinth is interrupted on all four sides so the middle remains a rotation hub.
  fillBox(world, 52, T + 1, 35, 57, T + 2, 39, STONE);
  fillBox(world, 71, T + 1, 35, 76, T + 2, 39, STONE);
  fillBox(world, 52, T + 1, 55, 57, T + 2, 59, STONE);
  fillBox(world, 71, T + 1, 55, 76, T + 2, 59, STONE);
  for (const [x, z] of [[55, 37], [73, 37], [55, 57], [73, 57]]) {
    world.setBlock(x, T + 3, z, ACCENT);
  }

  // Two dark pylons carry the gold-rimmed glass halo. Its bottom stays above head height.
  fillBox(world, 52, T + 1, 42, 55, T + 11, 45, METAL);
  fillBox(world, 73, T + 1, 42, 76, T + 11, 45, METAL);
  fillBox(world, 53, T + 3, 41, 54, T + 8, 41, RUST);
  fillBox(world, 74, T + 3, 41, 75, T + 8, 41, RUST);
  for (const z of [42, 43]) {
    ringVoxel(world, 64, T + 14, z, 10.5, 1.15, ACCENT);
    ringVoxel(world, 64, T + 14, z + 1, 8.2, 0.72, GLASS);
  }

  // Fractured lower-right arc and off-axis calibration arm create the abandoned silhouette.
  fillBox(world, 70, T + 20, 41, 74, T + 21, 44, AIR);
  fillBox(world, 74, T + 8, 40, 82, T + 9, 41, RUST);
  fillBox(world, 80, T + 7, 40, 82, T + 10, 42, METAL);
  world.setBlock(81, T + 11, 41, ACCENT);

  // Shade canopies and calibration consoles keep sightlines short at ground level.
  fillBox(world, 58, T + 5, 33, 69, T + 5, 36, PALE);
  fillBox(world, 58, T + 1, 33, 58, T + 4, 33, METAL);
  fillBox(world, 69, T + 1, 33, 69, T + 4, 33, METAL);
  fillBox(world, 59, T + 1, 52, 62, T + 2, 54, RUST);
  fillBox(world, 66, T + 1, 45, 69, T + 2, 47, RUST);
  for (const [x, z] of [[55, 47], [73, 49], [63, 58], [65, 39]]) crate(world, x, z, 2, 2, 1, PLANK);

  // Staggered south-approach cover breaks the long spawn-to-ring angle while
  // leaving two clean side routes and grenade arcs over each waist-high pod.
  fillBox(world, 55, T + 1, 66, 61, T + 2, 69, CONCRETE);
  fillBox(world, 55, T + 2, 66, 55, T + 2, 69, ACCENT);
  fillBox(world, 67, T + 1, 73, 73, T + 2, 76, PALE);
  fillBox(world, 73, T + 2, 73, 73, T + 2, 76, ACCENT);
  crate(world, 62, 72, 2, 2, 2, RUST);
}

/** West close-quarters glass biome with shootable panes and vegetation. */
function buildBiodome(world) {
  const T = GROUND;
  paintFloor(world, 10, 25, 46, 70, T, PALE);
  paintFloor(world, 15, 30, 41, 65, T, CONCRETE);

  // Industrial frame. Wide doors exist north/south/east/west.
  for (const x of [12, 20, 28, 36, 44]) {
    fillBox(world, x, T + 1, 28, x, T + 7, 28, METAL);
    fillBox(world, x, T + 1, 67, x, T + 7, 67, METAL);
    fillBox(world, x, T + 7, 28, x, T + 8, 67, METAL);
  }
  for (const z of [28, 38, 48, 58, 67]) {
    fillBox(world, 12, T + 1, z, 12, T + 7, z, METAL);
    fillBox(world, 44, T + 1, z, 44, T + 7, z, METAL);
  }
  // Glass wall bands between posts, with explicit door gaps.
  fillBox(world, 13, T + 2, 28, 25, T + 5, 28, GLASS);
  fillBox(world, 33, T + 2, 28, 43, T + 5, 28, GLASS);
  fillBox(world, 13, T + 2, 67, 23, T + 5, 67, GLASS);
  fillBox(world, 32, T + 2, 67, 43, T + 5, 67, GLASS);
  fillBox(world, 12, T + 2, 29, 12, T + 5, 43, GLASS);
  fillBox(world, 12, T + 2, 52, 12, T + 5, 66, GLASS);
  fillBox(world, 44, T + 2, 29, 44, T + 5, 41, GLASS);
  fillBox(world, 44, T + 2, 54, 44, T + 5, 66, GLASS);

  // Ribbed partial roof leaves the central court open to the sky.
  for (const x of [16, 22, 34, 40]) {
    fillBox(world, x, T + 8, 30, x, T + 8, 65, GLASS);
  }
  fillBox(world, 13, T + 8, 30, 43, T + 8, 34, GLASS);
  fillBox(world, 13, T + 8, 61, 43, T + 8, 65, GLASS);

  // Site A: sunken garden court; planters create destructible close cover.
  paintFloor(world, 21, 43, 34, 54, T, SAND);
  for (let x = 21; x <= 34; x++) {
    if ((x & 1) === 0) {
      world.setBlock(x, T, 43, ACCENT);
      world.setBlock(x, T, 54, ACCENT);
    }
  }
  fillBox(world, 16, T + 1, 35, 20, T + 1, 37, BRICK);
  fillBox(world, 36, T + 1, 57, 40, T + 1, 59, BRICK);
  fillBox(world, 15, T + 1, 56, 19, T + 1, 58, BRICK);
  fillBox(world, 37, T + 1, 36, 41, T + 1, 38, BRICK);
  for (const [x, z] of [[18, 36], [38, 58], [17, 57], [39, 37]]) desertTree(world, x, z);
  fillBox(world, 24, T + 1, 34, 27, T + 2, 36, LEAVES);
  fillBox(world, 30, T + 1, 60, 34, T + 2, 62, LEAVES);
  crate(world, 19, 47, 2, 3, 2);
  crate(world, 38, 48, 2, 3, 2);
}

/** East machine hall: roofed side cells around an open turbine court. */
function buildTurbineHall(world) {
  const T = GROUND;
  paintFloor(world, 82, 25, 117, 70, T, CONCRETE);

  // North/south machine rooms with a wide open objective court between them.
  for (const [z0, z1] of [[27, 39], [57, 68]]) {
    fillBox(world, 85, T + 1, z0, 114, T + 6, z1, CONCRETE);
    fillBox(world, 87, T + 1, z0 + 1, 112, T + 5, z1 - 1, AIR);
    fillBox(world, 85, T + 2, z0, 114, T + 3, z0, RUST);
    fillBox(world, 85, T + 2, z1, 114, T + 3, z1, RUST);
    fillBox(world, 85, T + 6, z0, 114, T + 7, z1, METAL);
    for (const x of [88, 98, 108]) {
      fillBox(world, x, T + 2, z0, x + 3, T + 4, z0, GLASS);
      fillBox(world, x, T + 2, z1, x + 3, T + 4, z1, GLASS);
    }
  }
  // Copper service gantries visually connect the machine wings to the central array.
  fillBox(world, 79, T + 6, 31, 84, T + 7, 33, RUST);
  fillBox(world, 79, T + 6, 63, 84, T + 7, 65, RUST);
  for (const z of [31, 33, 63, 65]) {
    fillBox(world, 79, T + 1, z, 79, T + 5, z, METAL);
  }
  // Door cuts connect all three lanes and the site.
  for (const [x0, x1] of [[89, 94], [103, 108]]) {
    fillBox(world, x0, T + 1, 27, x1, T + 4, 28, AIR);
    fillBox(world, x0, T + 1, 38, x1, T + 4, 39, AIR);
    fillBox(world, x0, T + 1, 57, x1, T + 4, 58, AIR);
    fillBox(world, x0, T + 1, 67, x1, T + 4, 68, AIR);
  }

  // Twin exposed turbines become readable combat landmarks.
  for (const cx of [91, 108]) {
    ringVoxel(world, cx, T + 10, 39, 4.3, 0.75, ACCENT);
    fillBox(world, cx, T + 7, 38, cx, T + 13, 39, METAL);
    fillBox(world, cx - 3, T + 10, 38, cx + 3, T + 10, 39, METAL);
  }

  // Site B and waist-high machines produce a tight, defensible courtyard.
  paintFloor(world, 94, 42, 106, 54, T, PALE);
  for (let z = 42; z <= 54; z++) {
    if ((z & 1) === 0) {
      world.setBlock(94, T, z, ACCENT);
      world.setBlock(106, T, z, ACCENT);
    }
  }
  fillBox(world, 86, T + 1, 45, 91, T + 2, 49, RUST);
  fillBox(world, 109, T + 1, 48, 114, T + 2, 52, RUST);
  fillBox(world, 97, T + 1, 46, 99, T + 2, 48, METAL);
  fillBox(world, 102, T + 1, 51, 104, T + 2, 53, METAL);
  crate(world, 88, 53, 3, 2, 2);
  crate(world, 110, 42, 3, 2, 2);

  // Roof panel arrays carry the solar-station identity above the firefights.
  solarPanelX(world, 87, 29, 10, 6, 2);
  solarPanelX(world, 102, 29, 10, 6, 2);
  solarPanelX(world, 87, 59, 10, 6, 2);
  solarPanelX(world, 102, 59, 10, 6, 2);
}

export function dressSolstice(world) {
  buildHeliostat(world);
  buildBiodome(world);
  buildTurbineHall(world);

  // Spawn-side identity gates and scattered lane cover.
  for (const z of [12, 82]) {
    fillBox(world, 50, GROUND + 1, z, 52, GROUND + 6, z + 1, STONE);
    fillBox(world, 76, GROUND + 1, z, 78, GROUND + 6, z + 1, STONE);
    fillBox(world, 53, GROUND + 5, z, 75, GROUND + 6, z + 1, PALE);
    for (let x = 55; x <= 73; x += 4) world.setBlock(x, GROUND + 5, z, ACCENT);
  }
  for (const [x, z] of [[22, 18], [39, 19], [88, 18], [107, 19], [22, 77], [40, 78], [88, 77], [108, 78]]) {
    crate(world, x, z, 3, 2, 2, x > 64 ? RUST : PLANK);
  }
  dressCalibrationCourt(world);
  dressGreenhouse(world);
  dressMachineWings(world);
  buildReceiverDish(world);
  buildStationInteriors(world);
  buildGardenInfrastructure(world);
}

function buildReceiverDish(world) {
  const T = GROUND;
  // The south machine wing carries a full-scale tracking dish. Its curved bowl
  // faces the south approach, with an exposed yoke and suspended receiver feed.
  fillBox(world, 92, T + 8, 59, 106, T + 15, 66, AIR);
  fillBox(world, 96, T + 8, 60, 102, T + 10, 64, CONCRETE);
  fillBox(world, 98, T + 11, 60, 100, T + 16, 62, METAL);
  fillBox(world, 93, T + 15, 61, 105, T + 16, 62, RUST);
  for (const x of [93, 105]) fillBox(world, x, T + 16, 61, x, T + 19, 64, METAL);
  const cy = T + 17;
  for (let y = cy - 7; y <= cy + 7; y++) {
    for (let x = 92; x <= 106; x++) {
      const r = Math.hypot(x - 99, y - cy);
      if (r > 7.35) continue;
      const z = 62 + Math.round((r * r) / 13);
      world.setBlock(x, y, z, r > 6.35 ? METAL : PALE);
      world.setBlock(x, y, z - 1, r > 6.35 || x === 99 || y === cy ? METAL : CONCRETE);
    }
  }
  // Four spider struts hold the feed in front of the concave reflector.
  for (let n = 0; n <= 5; n++) {
    const z = 66 + Math.round(n * 0.6);
    for (const sign of [-1, 1]) {
      world.setBlock(99 + sign * (5 - n), cy, z, METAL);
      world.setBlock(99, cy + sign * (5 - n), z, METAL);
    }
  }
  fillBox(world, 98, cy - 1, 69, 100, cy + 1, 70, ACCENT);
  world.setBlock(99, cy, 71, GLASS);
  // Rooftop power cabinets flank the dish instead of floating equipment boxes.
  for (const x of [87, 110]) {
    fillBox(world, x, T + 8, 64, x + 2, T + 12, 66, PALE);
    fillBox(world, x + 1, T + 9, 67, x + 1, T + 11, 67, METAL);
    world.setBlock(x + 1, T + 11, 68, ACCENT);
  }
}

function buildStationInteriors(world) {
  const T = GROUND;
  for (const [z0, z1] of [[29, 36], [59, 65]]) {
    // Full-height plant cabinets line the outer walls, leaving the original wide
    // door-to-door passages through each machine room open.
    for (const x of [87, 111]) {
      fillBox(world, x, T + 1, z0, x + 1, T + 4, z1, METAL);
      for (let z = z0; z <= z1; z += 3) {
        fillBox(world, x, T + 2, z, x + 1, T + 3, z + 1, GLASS);
        world.setBlock(x, T + 4, z, ACCENT);
      }
    }
    // A central turbine service module has a thick casing, exposed axle and
    // separate gauges, with three- and four-block aisles beside both doors.
    fillBox(world, 98, T + 1, z0 + 1, 101, T + 3, z1 - 1, RUST);
    fillBox(world, 99, T + 4, z0 + 1, 100, T + 4, z1 - 1, PALE);
    for (const z of [z0 + 1, z1 - 1]) {
      fillBox(world, 98, T + 2, z, 101, T + 2, z, METAL);
      world.setBlock(99, T + 3, z, GLASS);
    }
    fillBox(world, 95, T + 5, z0 + 2, 104, T + 5, z0 + 2, RUST);
    for (const x of [95, 104]) fillBox(world, x, T + 4, z0 + 2, x, T + 5, z0 + 2, METAL);
  }
  // Two glazed service kiosks sit beside existing court cover, keeping the
  // central objective court and its north/south entrances clear.
  for (const [x0, z0] of [[85, 44], [109, 51]]) {
    fillBox(world, x0, T + 1, z0, x0 + 4, T + 5, z0 + 4, PALE);
    fillBox(world, x0 + 1, T + 1, z0 + 1, x0 + 3, T + 4, z0 + 3, AIR);
    fillBox(world, x0, T + 3, z0 + 1, x0, T + 4, z0 + 3, GLASS);
    fillBox(world, x0 + 4, T + 3, z0 + 1, x0 + 4, T + 4, z0 + 3, GLASS);
    fillBox(world, x0 + 1, T + 3, z0 + 4, x0 + 3, T + 4, z0 + 4, GLASS);
    fillBox(world, x0 + 1, T + 1, z0, x0 + 3, T + 3, z0, AIR);
    fillBox(world, x0, T + 6, z0, x0 + 4, T + 6, z0 + 4, METAL);
    fillBox(world, x0 + 1, T + 2, z0 + 3, x0 + 3, T + 2, z0 + 3, RUST);
    world.setBlock(x0 + 2, T + 3, z0 + 3, GLASS);
  }
}

function buildGardenInfrastructure(world) {
  const T = GROUND;
  // Proper raised grow tables and a tank/pump assembly turn the biome into a
  // working garden. Everything below crown height stays outside Site A.
  for (const [x0, z0] of [[24, 33], [30, 60]]) {
    fillBox(world, x0, T + 1, z0, x0 + 4, T + 1, z0 + 3, BRICK);
    fillBox(world, x0, T + 2, z0, x0 + 4, T + 2, z0 + 3, PALE);
    fillBox(world, x0 + 1, T + 2, z0 + 1, x0 + 3, T + 2, z0 + 2, DIRT);
    for (const x of [x0 + 1, x0 + 3]) fillBox(world, x, T + 3, z0 + 1, x, T + 3, z0 + 2, LEAVES);
  }
  for (const z of [40, 53]) {
    fillBox(world, 13, T + 1, z, 15, T + 5, z + 2, PALE);
    fillBox(world, 14, T + 2, z, 14, T + 4, z, GLASS);
    fillBox(world, 13, T + 6, z, 15, T + 6, z + 2, METAL);
    fillBox(world, 16, T + 1, z + 1, 17, T + 2, z + 2, RUST);
  }
  // Irrigation manifolds and high support trusses frame the mature trees.
  for (const x of [14, 42]) {
    fillBox(world, x, T + 6, 35, x, T + 6, 59, RUST);
    for (const z of [35, 59]) fillBox(world, x, T + 1, z, x, T + 6, z, METAL);
  }
  for (const z of [35, 59]) {
    fillBox(world, 14, T + 13, z, 42, T + 13, z, PALE);
    for (const x of [14, 42]) fillBox(world, x, T + 7, z, x, T + 12, z, METAL);
  }
}

function dressCalibrationCourt(world) {
  const T = GROUND;
  // Pale ceramic cheeks and copper joints make the supporting machinery legible.
  for (const x of [52, 76]) {
    fillBox(world, x, T + 3, 42, x, T + 9, 45, PALE);
    for (const y of [T + 4, T + 8]) fillBox(world, x, y, 42, x, y, 45, RUST);
  }
  for (const [x0, z0] of [[52, 35], [71, 35], [52, 55], [71, 55]]) {
    paintFloor(world, x0 + 1, z0 + 1, x0 + 4, z0 + 3, T + 2, PALE);
    world.setBlock(x0 + 2, T + 2, z0 + 2, METAL);
  }
  // Survey ticks are inset into the surviving halo, including its broken upper arc.
  for (let y = T + 3; y <= T + 25; y++) {
    for (let x = 52; x <= 76; x++) {
      if (world.getBlock(x, y, 43) !== ACCENT) continue;
      if (x === 64 || y === T + 14 || Math.abs(x - 64) === Math.abs(y - T - 14)) {
        world.setBlock(x, y, 43, PALE);
      }
    }
  }
  for (const [x0, z0, x1, z1] of [[59, 52, 62, 54], [66, 45, 69, 47]]) {
    paintFloor(world, x0, z0, x1, z0, T + 2, METAL);
    paintFloor(world, x0 + 1, z0 + 1, x1 - 1, z1, T + 2, GLASS);
    world.setBlock(x0, T + 2, z1, ACCENT);
  }
  // Calibration arcs and radial marks stay entirely underfoot.
  for (let x = 57; x <= 71; x++) {
    for (let z = 34; z <= 62; z++) {
      const radius = Math.hypot(x - 64, z - 48);
      if ((radius > 10.7 && radius < 11.3) || (radius > 5.8 && radius < 6.2)) {
        world.setBlock(x, T, z, STONE);
      }
    }
  }
  for (const z of [36, 60]) paintFloor(world, 62, z, 66, z, T, ACCENT);
  for (const [x0, z0, x1, z1] of [[55, 66, 61, 69], [67, 73, 73, 76]]) {
    for (let x = x0 + 1; x < x1; x += 2) {
      world.setBlock(x, T + 1, z0, METAL);
      world.setBlock(x, T + 1, z1, METAL);
    }
  }
}

function dressGreenhouse(world) {
  const T = GROUND;
  // A continuous south lintel ties the greenhouse ribs together above the doors.
  fillBox(world, 13, T + 7, 67, 43, T + 7, 67, PALE);
  // Irrigation channels join the existing growing beds without adding obstacles.
  for (const [x0, x1, z0, z1] of [[16, 20, 35, 37], [36, 40, 57, 59], [15, 19, 56, 58], [37, 41, 36, 38]]) {
    for (let x = x0 + 1; x < x1; x++) {
      for (let z = z0; z <= z1; z++) {
        if (world.getBlock(x, T + 1, z) === BRICK) world.setBlock(x, T + 1, z, DIRT);
      }
    }
    paintFloor(world, x0, z0 - 1, x1, z0 - 1, T, METAL);
    world.setBlock(x0, T, z0 - 1, ACCENT);
  }
  // White structural caps, dark footings and interrupted repair panels break the
  // repeated metal/glass bands while preserving every original door opening.
  for (const x of [12, 20, 28, 36, 44]) {
    for (const z of [28, 67]) {
      fillBox(world, x, T + 2, z, x, T + 5, z, PALE);
      world.setBlock(x, T + 6, z, ACCENT);
    }
    for (const z of [34, 61]) fillBox(world, x, T + 7, z, x, T + 8, z, PALE);
  }
  for (const [x0, z] of [[15, 28], [36, 67]]) {
    for (let x = x0; x < x0 + 4; x++) {
      world.setBlock(x, T + 2, z, PALE);
      world.setBlock(x, T + 5, z, PALE);
    }
  }
  // Low display beds keep their cover height; leaf/soil rows suggest cultivation.
  for (const [x0, x1, z] of [[24, 27, 34], [30, 34, 62]]) {
    for (let x = x0; x <= x1; x++) world.setBlock(x, T + 1, z, BRICK);
  }
}

function dressMachineWings(world) {
  const T = GROUND;
  for (const [z0, z1] of [[27, 39], [57, 68]]) {
    // Ceramic end ribs, copper roof gutters and inset service panels are all
    // replacements in existing wall/roof cells, never narrower doorways.
    for (const x of [85, 86, 113, 114]) {
      for (const z of [z0, z1]) fillBox(world, x, T + 1, z, x, T + 5, z, PALE);
    }
    for (const z of [z0, z1]) {
      fillBox(world, 87, T + 6, z, 112, T + 6, z, RUST);
      fillBox(world, 98, T + 1, z, 101, T + 1, z, METAL);
      world.setBlock(100, T + 4, z, ACCENT);
    }
    for (const x of [85, 114]) {
      fillBox(world, x, T + 2, z0 + 4, x, T + 4, z0 + 7, METAL);
      for (const z of [z0 + 4, z0 + 6]) fillBox(world, x, T + 3, z, x, T + 3, z, PALE);
    }
    // A narrow ventilation spine occupies the unused strip between roof arrays.
    fillBox(world, 99, T + 8, z0 + 3, 100, T + 9, z0 + 7, RUST);
    for (let z = z0 + 3; z <= z0 + 7; z += 2) fillBox(world, 99, T + 9, z, 100, T + 9, z, PALE);
  }
  for (const [x0, z0, x1, z1] of [[86, 45, 91, 49], [109, 48, 114, 52]]) {
    paintFloor(world, x0 + 1, z0 + 1, x1 - 1, z1 - 1, T + 2, METAL);
    for (let x = x0 + 1; x < x1; x += 2) world.setBlock(x, T + 1, z1, PALE);
    world.setBlock(x0, T + 2, z0, ACCENT);
  }
  for (const [x, z] of [[97, 46], [102, 51]]) {
    world.setBlock(x + 1, T + 2, z + 1, GLASS);
    world.setBlock(x, T + 2, z, ACCENT);
  }
  for (const x of [91, 108]) {
    fillBox(world, x, T + 9, 39, x, T + 11, 39, PALE);
    world.setBlock(x, T + 10, 39, RUST);
  }
}
