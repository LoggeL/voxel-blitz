import { mulberry32 } from '../noise.js';
import {
  AIR,
  ACCENT,
  CONCRETE,
  GROUND,
  LEAVES,
  PALE,
  PLANK,
  STONE,
  SX,
  SZ,
} from './blocks.js';
import {
  fillBox,
  paintFloor,
  generateFlatBase,
} from './flatmaps.js';
import {
  addCitadelSetpieces,
  banner,
  masonry,
  merlonLineX,
  merlonLineZ,
  sconceX,
  sconceZ,
  slitX,
  slitZ,
  tree,
} from './setpiece-citadel.js';

// Spawn anchor cells from metadata.js — scatter keeps its distance.
const ANCHOR_CELLS = [
  [12, 8], [36, 8], [64, 9], [92, 8], [115, 18], [115, 77],
  [92, 87], [64, 86], [36, 87], [12, 77], [45, 47], [82, 48],
  [18, 87], [36, 87], [54, 87], [72, 87], [90, 87], [108, 87],
  [18, 8], [36, 8], [54, 8], [72, 8], [90, 8], [108, 8],
];

export function generateCitadelInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  buildCourtyard(world);
  buildBCompound(world);
  buildLaneMarkers(world);
  addCitadelSetpieces(world);
  polishCitadelGround(world);
}

// ---------------------------------------------------------------------------
// Ground dressing: approach paths, cobble scatter, shrubs, braziers.
// ---------------------------------------------------------------------------

function polishCitadelGround(world) {
  const T = GROUND;

  // Grand north/south approaches to the gatehouse, with inlaid diamonds.
  paintFloor(world, 61, 8, 66, 24, T, PALE);
  paintFloor(world, 61, 66, 66, 84, T, PALE);
  for (let z = 10; z <= 84; z += 6) {
    world.setBlock(63, T, z, ACCENT);
    world.setBlock(64, T, z, ACCENT);
  }
  // Braziers flanking the south approach.
  for (let z = 68; z <= 84; z += 6) {
    world.setBlock(59, T + 1, z, ACCENT);
    world.setBlock(68, T + 1, z, ACCENT);
  }

  // Cross-paths north and south of the keep link the rotation lanes.
  paintFloor(world, 44, 20, 83, 23, T, PALE);
  paintFloor(world, 44, 72, 83, 75, T, PALE);
  // Paths through the keep's west door corridor and east side.
  paintFloor(world, 44, 52, 59, 57, T, PALE);
  paintFloor(world, 68, 42, 83, 47, T, PALE);

  // Deterministic cobbles and shrubs break up the concrete aprons.
  const rng = mulberry32(20260828);
  const nearAnchor = (x, z) => ANCHOR_CELLS.some(
    ([ax, az]) => Math.max(Math.abs(x - ax), Math.abs(z - az)) <= 2,
  );
  for (let i = 0; i < 220; i++) {
    const x = 6 + ((rng() * (SX - 12)) | 0);
    const z = 6 + ((rng() * (SZ - 12)) | 0);
    if (world.getBlock(x, T, z) !== CONCRETE || nearAnchor(x, z)) continue;
    const kind = rng();
    if (kind < 0.7) {
      world.setBlock(x, T, z, STONE);
    } else if (kind < 0.92 && world.getBlock(x, T + 1, z) === AIR) {
      world.setBlock(x, T + 1, z, LEAVES);
    } else if (world.getBlock(x, T + 1, z) === AIR) {
      world.setBlock(x, T + 1, z, STONE); // rubble
    }
  }
}

// ---------------------------------------------------------------------------
// Site A: walled courtyard with gatehouse approaches, gardens and plaza.
// ---------------------------------------------------------------------------

function buildCourtyard(world) {
  const T = GROUND;

  // Curtain walls: 2-thick brick ring. Exits stay where the modes expect
  // them: south x25-32, east z24-29; the north gate is carved later.
  masonry(world, 13, T + 1, 11, 43, T + 4, 12);
  masonry(world, 13, T + 1, 13, 14, T + 4, 39);
  masonry(world, 13, T + 1, 40, 24, T + 4, 41);
  masonry(world, 33, T + 1, 40, 43, T + 4, 41);
  masonry(world, 42, T + 1, 13, 43, T + 4, 23);
  masonry(world, 42, T + 1, 30, 43, T + 4, 39);
  fillBox(world, 13, T + 4, 11, 43, T + 4, 12, CONCRETE);
  fillBox(world, 13, T + 4, 13, 14, T + 4, 39, CONCRETE);
  fillBox(world, 13, T + 4, 40, 24, T + 4, 41, CONCRETE);
  fillBox(world, 33, T + 4, 40, 43, T + 4, 41, CONCRETE);
  fillBox(world, 42, T + 4, 13, 43, T + 4, 23, CONCRETE);
  fillBox(world, 42, T + 4, 30, 43, T + 4, 39, CONCRETE);

  // Merlons on the outer edge only; the inner edge stays a clean wall-walk.
  merlonLineX(world, 11, T + 5, 13, 43);
  merlonLineX(world, 41, T + 5, 13, 24);
  merlonLineX(world, 41, T + 5, 33, 43);
  merlonLineZ(world, 13, T + 5, 11, 41);
  merlonLineZ(world, 43, T + 5, 11, 23);
  merlonLineZ(world, 43, T + 5, 30, 41);

  // Stone quoins: corners plus mid-wall strips.
  const quoin = (x0, z0, x1, z1) => fillBox(world, x0, T + 1, z0, x1, T + 4, z1, STONE);
  quoin(13, 11, 14, 12);
  quoin(42, 11, 43, 12);
  quoin(13, 40, 14, 41);
  quoin(42, 40, 43, 41);
  quoin(23, 11, 24, 12);
  quoin(33, 11, 34, 12);
  quoin(13, 20, 14, 21);
  quoin(13, 30, 14, 31);
  quoin(17, 40, 18, 41);
  quoin(38, 40, 39, 41);
  quoin(42, 17, 43, 18);
  quoin(42, 34, 43, 35);

  // Buttress bumps on the exterior faces (never on the north spawn corridor).
  const bump = (x, z) => {
    fillBox(world, x, T + 1, z, x, T + 2, z, STONE);
    world.setBlock(x, T + 3, z, CONCRETE);
  };
  for (const z of [17, 25, 33]) bump(12, z);
  for (const x of [17, 21, 35, 39]) bump(x, 42);
  for (const z of [17, 35]) bump(44, z);

  // GLASS arrow slits facing outward, ACCENT torches facing inward.
  slitX(world, 11, T + 3, 15, 40, 6, 3);
  slitZ(world, 13, T + 3, 14, 38, 6, 1);
  slitX(world, 41, T + 3, 14, 24, 5, 2);
  slitX(world, 41, T + 3, 34, 40, 5, 2);
  slitZ(world, 43, T + 3, 14, 22, 4, 1);
  slitZ(world, 43, T + 3, 31, 38, 4, 1);
  sconceX(world, 12, T + 2, 16, 40, 8, 1);
  sconceZ(world, 14, T + 2, 14, 38, 9, 4);
  sconceX(world, 40, T + 2, 16, 24, 8, 3);
  sconceX(world, 40, T + 2, 33, 40, 8, 3);
  sconceZ(world, 42, T + 2, 14, 22, 9, 2);
  sconceZ(world, 42, T + 2, 30, 38, 9, 2);

  // Wall-walk stairs: four 1-block steps up to the west battlement walk.
  fillBox(world, 15, T + 1, 17, 15, T + 1, 17, STONE);
  fillBox(world, 15, T + 1, 18, 15, T + 2, 18, STONE);
  fillBox(world, 15, T + 1, 19, 15, T + 3, 19, STONE);
  fillBox(world, 15, T + 1, 20, 15, T + 4, 20, STONE);

  // Pale pathways with ACCENT inlay threading the courtyard.
  paintFloor(world, 15, 13, 16, 39, T, PALE);
  paintFloor(world, 15, 13, 41, 14, T, PALE);
  paintFloor(world, 40, 13, 41, 39, T, PALE);
  paintFloor(world, 15, 38, 41, 39, T, PALE);
  paintFloor(world, 27, 13, 28, 17, T, PALE);
  paintFloor(world, 28, 31, 29, 39, T, PALE);
  paintFloor(world, 35, 26, 39, 27, T, PALE);
  for (let z = 16; z <= 36; z += 4) world.setBlock(16, T, z, ACCENT);
  for (let x = 19; x <= 39; x += 4) world.setBlock(x, T, 13, ACCENT);
  for (let x = 17; x <= 41; x += 4) world.setBlock(x, T, 39, ACCENT);
  for (let z = 17; z <= 37; z += 4) world.setBlock(41, T, z, ACCENT);

  // Site A plaza: flat plantable ground, painted only (no raised blocks).
  paintFloor(world, 21, 18, 34, 30, T, PALE);
  for (let x = 21; x <= 34; x++) {
    if ((x + 18) % 3 === 0) world.setBlock(x, T, 18, ACCENT);
    if ((x + 30) % 3 === 0) world.setBlock(x, T, 30, ACCENT);
  }
  for (let z = 19; z <= 29; z++) {
    if ((21 + z) % 3 === 0) world.setBlock(21, T, z, ACCENT);
    if ((34 + z) % 3 === 0) world.setBlock(34, T, z, ACCENT);
  }
  world.setBlock(27, T, 24, ACCENT);
  world.setBlock(28, T, 24, ACCENT);
  world.setBlock(27, T, 25, ACCENT);
  world.setBlock(28, T, 25, ACCENT);

  // Gardens: destructible LEAVES hedges and trees framing the plaza.
  for (let x = 17; x <= 25; x++) world.setBlock(x, T + 1, 16, LEAVES);
  for (let x = 30; x <= 39; x++) world.setBlock(x, T + 1, 16, LEAVES);
  for (let x = 17; x <= 26; x++) world.setBlock(x, T + 1, 36, LEAVES);
  for (let x = 31; x <= 39; x++) world.setBlock(x, T + 1, 36, LEAVES);
  for (let z = 15; z <= 22; z++) world.setBlock(39, T + 1, z, LEAVES);
  for (let z = 31; z <= 35; z++) world.setBlock(39, T + 1, z, LEAVES);
  tree(world, 19, 15);
  tree(world, 23, 15);
  tree(world, 32, 15);
  tree(world, 37, 15);
  tree(world, 19, 34);
  tree(world, 38, 33);
  tree(world, 36, 19);
  tree(world, 18, 30);
}

// ---------------------------------------------------------------------------
// Site B: raised eastern compound, brick-dressed, two PALE stair connectors.
// ---------------------------------------------------------------------------

function buildBCompound(world) {
  const T = GROUND;

  // Raised massif + the two PALE stair connectors (extents unchanged).
  fillBox(world, 88, T + 1, 34, 113, T + 3, 63, CONCRETE);
  buildRampX(world, 82, 87, 52, 58);
  buildRampZ(world, 64, 69, 102, 108);

  // Brick skirt recolours the cliff faces beneath the curtain walls.
  masonry(world, 88, T + 1, 34, 113, T + 3, 34);
  masonry(world, 88, T + 1, 63, 113, T + 3, 63);
  masonry(world, 88, T + 1, 35, 88, T + 3, 62);
  masonry(world, 113, T + 1, 35, 113, T + 3, 62);

  // Curtain walls on top: brick with stone dressing, ramp gaps preserved.
  masonry(world, 88, T + 4, 34, 113, T + 6, 35);
  masonry(world, 112, T + 4, 36, 113, T + 6, 61);
  masonry(world, 88, T + 4, 62, 101, T + 6, 63);
  masonry(world, 109, T + 4, 62, 113, T + 6, 63);
  masonry(world, 88, T + 4, 36, 89, T + 6, 51);
  masonry(world, 88, T + 4, 59, 89, T + 6, 61);
  fillBox(world, 88, T + 6, 34, 113, T + 6, 35, CONCRETE);
  fillBox(world, 112, T + 6, 36, 113, T + 6, 61, CONCRETE);
  fillBox(world, 88, T + 6, 62, 101, T + 6, 63, CONCRETE);
  fillBox(world, 109, T + 6, 62, 113, T + 6, 63, CONCRETE);
  fillBox(world, 88, T + 6, 36, 89, T + 6, 51, CONCRETE);
  fillBox(world, 88, T + 6, 59, 89, T + 6, 61, CONCRETE);
  merlonLineX(world, 34, T + 7, 88, 113);
  merlonLineX(world, 63, T + 7, 88, 101);
  merlonLineX(world, 63, T + 7, 109, 113);
  merlonLineZ(world, 88, T + 7, 34, 51);
  merlonLineZ(world, 88, T + 7, 59, 63);
  merlonLineZ(world, 113, T + 7, 34, 63);

  // Quoins: corners plus mid-wall strips.
  const quoin = (x0, z0, x1, z1) => fillBox(world, x0, T + 4, z0, x1, T + 6, z1, STONE);
  quoin(88, 34, 89, 35);
  quoin(112, 34, 113, 35);
  quoin(88, 62, 89, 63);
  quoin(112, 62, 113, 63);
  quoin(96, 34, 97, 35);
  quoin(105, 34, 106, 35);
  quoin(112, 44, 113, 45);
  quoin(112, 54, 113, 55);
  quoin(92, 62, 93, 63);
  quoin(110, 62, 111, 63);
  quoin(88, 40, 89, 41);
  quoin(88, 47, 89, 48);

  // Slits outward, torches inward.
  slitX(world, 34, T + 5, 90, 111, 6, 1);
  slitZ(world, 113, T + 5, 37, 60, 6, 1);
  slitX(world, 63, T + 5, 90, 100, 6, 2);
  slitZ(world, 88, T + 5, 38, 50, 6, 4);
  sconceX(world, 35, T + 5, 91, 110, 7, 3);
  sconceX(world, 62, T + 5, 90, 100, 7, 4);
  sconceZ(world, 89, T + 5, 38, 50, 7, 3);
  sconceZ(world, 111, T + 5, 38, 55, 7, 5);

  // Wall-walk stairs against the east curtain interior (1-block steps).
  fillBox(world, 111, T + 4, 57, 111, T + 4, 57, STONE);
  fillBox(world, 111, T + 4, 58, 111, T + 5, 58, STONE);
  fillBox(world, 111, T + 4, 59, 111, T + 6, 59, STONE);

  // Plaza + paths (floor recolors only; site deck height unchanged).
  paintFloor(world, 97, 42, 108, 54, T + 3, PALE);
  for (let x = 97; x <= 108; x++) {
    if ((x + 42) % 3 === 0) world.setBlock(x, T + 3, 42, ACCENT);
    if ((x + 54) % 3 === 0) world.setBlock(x, T + 3, 54, ACCENT);
  }
  for (let z = 43; z <= 53; z++) {
    if ((97 + z) % 3 === 0) world.setBlock(97, T + 3, z, ACCENT);
    if ((108 + z) % 3 === 0) world.setBlock(108, T + 3, z, ACCENT);
  }
  world.setBlock(102, T + 3, 47, ACCENT);
  world.setBlock(103, T + 3, 47, ACCENT);
  world.setBlock(102, T + 3, 48, ACCENT);
  world.setBlock(103, T + 3, 48, ACCENT);
  paintFloor(world, 90, 54, 96, 55, T + 3, PALE);
  paintFloor(world, 103, 56, 104, 61, T + 3, PALE);

  // Cover crates (destructible PLANK) and banner poles at the corners.
  world.setBlock(93, T + 4, 44, PLANK);
  world.setBlock(94, T + 4, 45, PLANK);
  world.setBlock(110, T + 4, 45, PLANK);
  world.setBlock(110, T + 4, 46, PLANK);
  banner(world, 91, T + 4, 37, 1, 0);
  banner(world, 110, T + 4, 37, -1, 0);
  banner(world, 91, T + 4, 60, 1, 0);
  banner(world, 110, T + 4, 60, -1, 0);
}

function buildLaneMarkers(world) {
  const T = GROUND;
  for (const [x, z] of [[45, 19], [63, 19], [81, 19], [45, 76], [63, 76], [81, 76]]) {
    banner(world, x, T + 1, z, 0, z < 48 ? 1 : -1);
  }
}

function buildRampX(world, x0, x1, z0, z1) {
  for (let x = x0; x <= x1; x++) {
    const top = GROUND + Math.floor((x - x0 + 1) / 2);
    fillBox(world, x, GROUND + 1, z0, x, top, z1, PALE);
  }
}

function buildRampZ(world, z0, z1, x0, x1) {
  for (let z = z0; z <= z1; z++) {
    const top = GROUND + Math.floor((z1 - z + 1) / 2);
    fillBox(world, x0, GROUND + 1, z, x1, top, z, PALE);
  }
}
