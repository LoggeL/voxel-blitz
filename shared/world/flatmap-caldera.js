import { mulberry32 } from '../noise.js';
import {
  ACCENT,
  AIR,
  BRICK,
  CONCRETE,
  GROUND,
  METAL,
  PALE,
  RUST,
  STONE,
  SX,
  SZ,
} from './blocks.js';
import { fillBox, generateFlatBase, paintFloor } from './flatmaps.js';
import { MAP_SPAWN_ANCHORS } from './metadata.js';
import { addCalderaSetpieces } from './setpiece-caldera.js';

// Fixed contract anchors (shared/world contract): fun + tdm.alpha/snd.attackers
// + tdm.bravo/snd.defenders. Scatter keeps every anchor cell + r2 ring clear.
const FALLBACK_ANCHORS = [
  [12, 8], [36, 8], [64, 9], [92, 8], [115, 18], [115, 77],
  [92, 87], [64, 86], [36, 87], [12, 77], [45, 47], [82, 48],
  [18, 87], [36, 87], [54, 87], [72, 87], [90, 87], [108, 87],
  [18, 8], [36, 8], [54, 8], [72, 8], [90, 8], [108, 8],
];

const _calderaAnchors = MAP_SPAWN_ANCHORS.caldera;
const ANCHOR_CELLS = _calderaAnchors
  ? [
    ..._calderaAnchors.fun,
    ..._calderaAnchors.tdm.alpha,
    ..._calderaAnchors.tdm.bravo,
  ]
  : FALLBACK_ANCHORS;

export function generateCalderaInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  buildLavaCrustFloor(world);
  buildWestGate(world);
  buildRefineryMassif(world);
  buildAqueduct(world);
  buildLaneMarkers(world);
  addCalderaSetpieces(world);
  polishCalderaGround(world);
}

// ---------------------------------------------------------------------------
// Lava-crust floor inlay: FLAT paint at T only, zero height delta.
// Basalt CONCRETE lanes, RUST/ACCENT/BRICK ember checker around the vent
// (x56-72 z40-56), ACCENT lane guides.
// ---------------------------------------------------------------------------

function buildLavaCrustFloor(world) {
  const T = GROUND;
  // Dark basalt field first; light CONCRETE lanes read as guides on top.
  paintFloor(world, 3, 3, SX - 4, SZ - 4, T, STONE);
  paintFloor(world, 22, 8, 32, 88, T, CONCRETE);
  paintFloor(world, 59, 8, 69, 88, T, CONCRETE);
  paintFloor(world, 96, 8, 106, 33, T, CONCRETE);
  paintFloor(world, 96, 64, 106, 88, T, CONCRETE);
  // East/west bands (mid band runs beneath the aqueduct).
  paintFloor(world, 8, 20, 119, 26, T, CONCRETE);
  paintFloor(world, 8, 70, 119, 76, T, CONCRETE);
  paintFloor(world, 8, 44, 87, 52, T, CONCRETE);

  // Ember checker around the central vent.
  for (let z = 40; z <= 56; z++) {
    for (let x = 56; x <= 72; x++) {
      const m = (x + z) % 4;
      if (m === 0) world.setBlock(x, T, z, ACCENT);
      else if (m === 1) world.setBlock(x, T, z, RUST);
      else if (m === 2) world.setBlock(x, T, z, BRICK);
    }
  }

  // ACCENT lane-guide dashes down the west/east lane centers.
  for (let z = 10; z <= 86; z += 4) {
    if (z >= 39 && z <= 57) continue; // keep the vent checker legible
    world.setBlock(27, T, z, ACCENT);
    if (z < 34 || z > 63) world.setBlock(101, T, z, ACCENT);
  }
  // East/west guide ticks along the north/south bands.
  for (let x = 12; x <= 116; x += 6) {
    world.setBlock(x, T, 23, ACCENT);
    world.setBlock(x, T, 73, ACCENT);
  }
}

// ---------------------------------------------------------------------------
// Site A (x19-32 z41-54): low BRICK/STONE perimeter walls strictly outside
// the site rect, gate pillars at the corners, no roof — every site cell
// stays walkable (T+1/T+2 AIR).
// ---------------------------------------------------------------------------

function buildWestGate(world) {
  const T = GROUND;
  // North/south flanking walls (1-thick, 2-high).
  fillBox(world, 18, T + 1, 40, 33, T + 2, 40, BRICK);
  fillBox(world, 18, T + 1, 55, 33, T + 2, 55, BRICK);
  // West wall in STONE with a 2-wide entry gap at z47-48.
  fillBox(world, 18, T + 1, 41, 18, T + 2, 46, STONE);
  fillBox(world, 18, T + 1, 49, 18, T + 2, 54, STONE);
  // East side stays open toward mid; short BRICK returns mark the line.
  fillBox(world, 33, T + 1, 41, 33, T + 2, 43, BRICK);
  fillBox(world, 33, T + 1, 52, 33, T + 2, 54, BRICK);

  // Gate pillars: BRICK stacks with STONE caps at the four corners.
  for (const [px, pz] of [[18, 40], [33, 40], [18, 55], [33, 55]]) {
    fillBox(world, px, T + 1, pz, px, T + 3, pz, BRICK);
    world.setBlock(px, T + 4, pz, STONE);
  }

  // Site floor: explicit basalt + ACCENT corner ticks (flat, walkable).
  paintFloor(world, 19, 41, 32, 54, T, CONCRETE);
  world.setBlock(19, T, 41, ACCENT);
  world.setBlock(32, T, 41, ACCENT);
  world.setBlock(19, T, 54, ACCENT);
  world.setBlock(32, T, 54, ACCENT);
}

// ---------------------------------------------------------------------------
// Site B: solid CONCRETE massif x88-113 z34-63 T+1..T+3 with BRICK cliff
// skirt, PALE deck plaza at T+3, and two PALE block-step stairs on the west
// face (x82-87, z42-48 and z52-58, 1-block steps, 7-wide rungs).
// ---------------------------------------------------------------------------

function buildRefineryMassif(world) {
  const T = GROUND;
  // Solid massif; deck top surface is T+3 (site B y = GROUND + 4.02).
  fillBox(world, 88, T + 1, 34, 113, T + 3, 63, CONCRETE);
  // BRICK skirt recolours the cliff faces.
  fillBox(world, 88, T + 1, 34, 88, T + 3, 63, BRICK);
  fillBox(world, 113, T + 1, 34, 113, T + 3, 63, BRICK);
  fillBox(world, 89, T + 1, 34, 112, T + 3, 34, BRICK);
  fillBox(world, 89, T + 1, 63, 112, T + 3, 63, BRICK);

  // West-face stairs climbing to T+3 (solid PALE fills, 1-block steps).
  buildRampX(world, 82, 87, 42, 48);
  buildRampX(world, 82, 87, 52, 58);

  // Deck plaza + site B paint (flat recolors at T+3; height unchanged).
  paintFloor(world, 96, 41, 109, 54, T + 3, PALE);
  for (let x = 96; x <= 109; x++) {
    if ((x - 96) % 3 === 0) {
      world.setBlock(x, T + 3, 41, ACCENT);
      world.setBlock(x, T + 3, 54, ACCENT);
    }
  }
  for (let z = 42; z <= 53; z++) {
    if ((z - 42) % 3 === 0) {
      world.setBlock(96, T + 3, z, ACCENT);
      world.setBlock(109, T + 3, z, ACCENT);
    }
  }
}

function buildRampX(world, x0, x1, z0, z1) {
  for (let x = x0; x <= x1; x++) {
    const top = GROUND + Math.min(3, Math.floor((x - x0 + 2) / 2));
    fillBox(world, x, GROUND + 1, z0, x, top, z1, PALE);
  }
}

// ---------------------------------------------------------------------------
// Aqueduct: east-west deck at z46-50, slab at T+5 (3-high clearance
// beneath), METAL pillars at x40/64/88, STONE side rails at T+6.
// ---------------------------------------------------------------------------

function buildAqueduct(world) {
  const T = GROUND;
  // Free-standing pillars (2x2, T+1..T+4); the x88 pillar lands inside the
  // massif face and reads as its engaged support.
  for (const px of [40, 64, 88]) {
    fillBox(world, px, T + 1, 47, px + 1, T + 4, 48, METAL);
  }
  // Deck slab + PALE walk strip.
  fillBox(world, 14, T + 5, 46, 88, T + 5, 50, CONCRETE);
  paintFloor(world, 14, 47, 88, 48, T + 5, PALE);
  // Low side rails.
  fillBox(world, 14, T + 6, 46, 88, T + 6, 46, STONE);
  fillBox(world, 14, T + 6, 50, 88, T + 6, 50, STONE);
}

// ---------------------------------------------------------------------------
// Lane marker inlays: flat ACCENT diamonds where lanes meet the cross
// bands. No collision, no headroom touched.
// ---------------------------------------------------------------------------

function buildLaneMarkers(world) {
  const T = GROUND;
  const diamond = (cx, cz) => {
    world.setBlock(cx, T, cz, ACCENT);
    world.setBlock(cx - 1, T, cz, ACCENT);
    world.setBlock(cx + 1, T, cz, ACCENT);
    world.setBlock(cx, T, cz - 1, ACCENT);
    world.setBlock(cx, T, cz + 1, ACCENT);
  };
  diamond(27, 23);
  diamond(27, 73);
  diamond(101, 23);
  diamond(101, 73);
  diamond(45, 48);
  diamond(82, 23);
  diamond(82, 73);
}

// ---------------------------------------------------------------------------
// Polish LAST: deterministic RUST/STONE floor patching + ACCENT ember and
// STONE rubble dressing. Skips every anchor cell + r3 guard, only touches
// untouched CONCRETE floor with AIR headroom. Grenade-soft dressing only.
// ---------------------------------------------------------------------------

function polishCalderaGround(world) {
  const T = GROUND;
  const rng = mulberry32(20260829);
  const nearSpawn = (x, z) => ANCHOR_CELLS.some(
    ([ax, az]) => Math.max(Math.abs(x - ax), Math.abs(z - az)) <= 3,
  );
  for (let i = 0; i < 240; i++) {
    const x = 6 + ((rng() * (SX - 12)) | 0);
    const z = 6 + ((rng() * (SZ - 12)) | 0);
    if (nearSpawn(x, z)) continue;
    if (world.getBlock(x, T, z) !== CONCRETE && world.getBlock(x, T, z) !== STONE) continue;
    if (world.getBlock(x, T + 1, z) !== AIR) continue;
    const kind = rng();
    if (kind < 0.62) {
      world.setBlock(x, T, z, rng() < 0.55 ? STONE : RUST);
    } else if (kind < 0.9) {
      if (world.getBlock(x, T + 2, z) !== AIR) continue;
      world.setBlock(x, T + 1, z, ACCENT); // ember
    } else {
      if (world.getBlock(x, T + 2, z) !== AIR) continue;
      world.setBlock(x, T + 1, z, STONE); // rubble
    }
  }
}
