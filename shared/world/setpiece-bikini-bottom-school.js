// Bikini Bottom R3 Mid, Boating School (x50-77, z34-61 plus the flume corridor).
// Original procedural voxel work inspired by the show; no copied assets.
// Writes y > GROUND only inside its own rectangle (map-spec §2) and, outside
// it, only on the flume trough footprint and its three stilt columns; floor
// paint (y <= GROUND) stays inside the rectangle.
//
// The school is a beached hull whose deck (y18, T+4) is the mid bridge and
// carries two power-up pads; the boat-bus (north) and the shake shack (south,
// its point twin) are roof bridges onto it. The flume starts at the deck's
// z56 gunwale gap and runs south-west over Jellyfish Trail into Goo Lagoon on
// meta.slides; every trough voxel sits at y >= 18, out of bot roam.
import {
  GROUND, AIR, ACCENT, ASPHALT, BUS_YELLOW, GLASS, GRASS, PALE, PLANK, POOL_TILE_BLUE, POOL_TILE_WHITE,
  SLIDE_BLUE, SLIDE_YELLOW, TEAL_SIDING, TRUCK_RED, WOOD, BB_CORAL, BB_HULL, BB_ROAD, BB_ROCK,
} from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';
import { BIKINI_BOTTOM_FLUME } from './bikini-bottom-data.js';

const T = GROUND;
const SALT = 20260925;
/** Per-voxel hash in [0, 1): clone of setpiece-caldera.js hashC with this file's salt. */
function hashBB(x, y, z) {
  let h = (SALT ^ Math.imul(x + 1013, 0x27d4eb2f) ^ Math.imul(y + 7919, 0x9e3779b1) ^ Math.imul(z + 31337, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Inclusive box, heights relative to GROUND (h0/h1 are "T+n"). */
const tbox = (w, x0, h0, z0, x1, h1, z1, m) => fillBox(w, Math.min(x0, x1), T + Math.min(h0, h1), Math.min(z0, z1),
  Math.max(x0, x1), T + Math.max(h0, h1), Math.max(z0, z1), m);
const P = (x, z) => [127 - x, 95 - z];
/** Single voxel at T+h. */
const tset = (w, x, h, z, m) => w.setBlock(x, T + h, z, m);

/** Stilt columns under the trough (R3 owns them at every height). */
export const BOATING_FLUME_STILTS = Object.freeze([[55, 60], [50, 68], [47, 75]].map(Object.freeze));

/**
 * Trough footprint of a slide path, as in map-spec §8.6 (and the reference
 * model's flume_cells): floor columns within 1.5 of the centreline and wall
 * columns at 2.0 / 2.2, minus the floor. Each sample also reports the cells of
 * its cross-section so gantries can span the trough on footprint cells only.
 */
export function boatingFlumeCells(path = BIKINI_BOTTOM_FLUME.path) {
  const floor = new Map();
  const wall = new Map();
  const samples = [];
  const cell = (x, z) => `${x},${z}`;
  for (let s = 0; s + 1 < path.length; s++) {
    const [ax, , az] = path[s];
    const [bx, , bz] = path[s + 1];
    const L = Math.hypot(bx - ax, bz - az);
    const hx = (bx - ax) / L, hz = (bz - az) / L;
    const px = -hz, pz = hx;
    const n = Math.floor(L / 0.2) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
      const cross = [];
      for (let o = -6; o <= 6; o++) {
        const off = o / 4;
        const x = Math.floor(cx + px * off), z = Math.floor(cz + pz * off);
        floor.set(cell(x, z), [x, z]);
        cross.push([x, z]);
      }
      const rails = [];
      for (const off of [-2.2, -2.0, 2.0, 2.2]) {
        const x = Math.floor(cx + px * off), z = Math.floor(cz + pz * off);
        wall.set(cell(x, z), [x, z]);
        rails.push([x, z]);
      }
      samples.push({ x: cx, z: cz, segment: s, cross, rails });
    }
  }
  for (const key of floor.keys()) wall.delete(key);
  return { floor: [...floor.values()], wall: [...wall.values()], samples };
}

export function buildBoatingSchool(world) {
  paintSchoolGrounds(world);
  buildHull(world);
  buildClassroom(world);
  buildWheelhouse(world);
  buildDeckStairs(world);
  buildBoatBus(world);
  buildShakeShack(world);
  buildFlume(world);
  dressSchoolYard(world);
}

// ---- Grounds (y = GROUND only, inside the rectangle).
// Side lanes of the driving course in blue-grey road paint with pale centre
// dashes and parking ticks; the classroom floor is a white/pale checker.
function paintSchoolGrounds(world) {
  for (const [x0, x1, dashX] of [[50, 53, 51], [74, 77, 76]]) {
    paintFloor(world, x0, 34, x1, 61, T, BB_ROAD);
    for (let z = 34; z <= 61; z++) {
      if (z % 4 < 2) world.setBlock(dashX, T, z, PALE);
    }
  }
  // Stop bars where the lanes meet the roads.
  paintFloor(world, 50, 34, 53, 34, T, PALE);
  paintFloor(world, 74, 61, 77, 61, T, PALE);
  for (let x = 55; x <= 72; x++) {
    for (let z = 40; z <= 55; z++) world.setBlock(x, T, z, (x + z) % 2 ? POOL_TILE_WHITE : PALE);
  }
}

// ---- Hull (x54-73, z39-56): walls h1-h3, deck slab h4, gunwale h5.
function buildHull(world) {
  for (let x = 54; x <= 73; x++) {
    for (let z = 39; z <= 56; z++) {
      const rim = x === 54 || x === 73 || z === 39 || z === 56;
      if (rim) {
        tset(world, x, 1, z, BB_HULL);
        tset(world, x, 2, z, PALE);
        tset(world, x, 3, z, TEAL_SIDING);
      }
      tset(world, x, 4, z, rim ? BB_HULL : PLANK);
      if (rim) tset(world, x, 5, z, PALE);
    }
  }
  // Chamfered corners.
  for (const [x, z] of [[54, 39], [73, 39], [54, 56], [73, 56]]) tbox(world, x, 1, z, x, 5, z, AIR);
  // Gunwale gaps: W stair, E stair, bus bridge, shack bridge, flume mouth.
  tbox(world, 54, 5, 51, 54, 5, 54, AIR);
  tbox(world, 73, 5, 41, 73, 5, 44, AIR);
  tbox(world, 61, 5, 39, 66, 5, 39, AIR);
  tbox(world, 61, 5, 56, 66, 5, 56, AIR);
  tbox(world, 55, 5, 56, 57, 5, 56, AIR);
  // Doors: W, E, N, S.
  tbox(world, 54, 1, 43, 54, 3, 45, AIR);
  tbox(world, 73, 1, 50, 73, 3, 52, AIR);
  tbox(world, 55, 1, 39, 57, 3, 39, AIR);
  tbox(world, 70, 1, 56, 72, 3, 56, AIR);
  // Portholes and the chalkboard.
  for (const x of [60, 64, 68]) tset(world, x, 2, 39, GLASS);
  for (const x of [59, 63, 67]) tset(world, x, 2, 56, GLASS);
  tbox(world, 54, 2, 47, 54, 3, 50, ASPHALT);
  // Life rings on the pale band (point twins) and a red boot-top stripe
  // under the teal sheer on hashed planks: material swaps only.
  for (const [x, z] of [[54, 41], [70, 39]]) {
    tset(world, x, 2, z, TRUCK_RED);
    const [px, pz] = P(x, z);
    tset(world, px, 2, pz, TRUCK_RED);
  }
  for (let x = 55; x <= 72; x++) {
    for (const z of [39, 56]) {
      if (world.getBlock(x, T + 1, z) === BB_HULL && hashBB(x, T + 1, z) < 0.18) tset(world, x, 1, z, TEAL_SIDING);
    }
  }
  // Flume mouth: an ACCENT chevron on the deck pointing into the trough.
  tset(world, 55, 4, 54, ACCENT);
  tset(world, 57, 4, 54, ACCENT);
  tset(world, 56, 4, 55, ACCENT);
}

// ---- Classroom under the deck.
function buildClassroom(world) {
  // Instructor desk kills the W-door to E-door diagonal.
  tbox(world, 62, 1, 46, 65, 1, 49, BB_HULL);
  tbox(world, 62, 2, 46, 65, 2, 49, PLANK);
  tbox(world, 59, 1, 44, 59, 3, 44, PALE);
  tbox(world, 68, 1, 51, 68, 3, 51, PALE);
  // Boat desks: four rows of student benches.
  for (const [x0, z] of [[57, 42], [57, 50], [67, 45], [67, 53]]) tbox(world, x0, 1, z, x0 + 3, 1, z, PLANK);
  // Each bench has a bright steering-wheel cap at its door end (a swap).
  for (const [x, z] of [[57, 42], [57, 50], [70, 45], [70, 53]]) tset(world, x, 1, z, ACCENT);
  // The desk top carries a red "exam" blotter.
  tbox(world, 63, 2, 47, 64, 2, 48, TRUCK_RED);
}

// ---- Wheelhouse (x61-66, z45-50) on the deck, BB_HULL roof at y24.
function buildWheelhouse(world) {
  tbox(world, 61, 5, 45, 66, 9, 50, PALE);
  tbox(world, 62, 5, 46, 65, 9, 49, AIR);
  for (let x = 62; x <= 65; x++) {
    for (const z of [45, 50]) tset(world, x, 6, z, GLASS);
  }
  for (let z = 46; z <= 49; z++) {
    for (const x of [61, 66]) tset(world, x, 6, z, GLASS);
  }
  tbox(world, 61, 5, 46, 61, 7, 47, AIR);
  tbox(world, 66, 5, 48, 66, 7, 49, AIR);
  tbox(world, 61, 10, 45, 66, 10, 50, BB_HULL);
  // Lamp, then a teal eave band under the roof edge (swap of PALE wall).
  tbox(world, 63, 11, 47, 64, 12, 48, GLASS);
  tbox(world, 63, 13, 47, 64, 13, 48, ACCENT);
  for (let x = 61; x <= 66; x++) {
    for (let z = 45; z <= 50; z++) if (world.getBlock(x, T + 9, z) === PALE) tset(world, x, 9, z, TEAL_SIDING);
  }
  // Helm console inside, against the north windows.
  tbox(world, 63, 5, 46, 64, 5, 46, WOOD);
  tset(world, 63, 6, 46, ACCENT);
  // Smokestack on the roof (NE corner): red, pale band, red rim.
  tbox(world, 65, 11, 45, 66, 12, 46, TRUCK_RED);
  tbox(world, 65, 13, 45, 66, 13, 46, PALE);
  tbox(world, 65, 14, 45, 66, 14, 46, TRUCK_RED);
}

// ---- Deck stairs: PALE fills with an ACCENT nosing on each top cell.
function buildDeckStairs(world) {
  for (let i = 0; i < 4; i++) {
    const west = 50 + i, east = 77 - i;
    tbox(world, west, 1, 51, west, i + 1, 54, PALE);
    tbox(world, west, i + 1, 51, west, i + 1, 54, ACCENT);
    tbox(world, east, 1, 41, east, i + 1, 44, PALE);
    tbox(world, east, i + 1, 41, east, i + 1, 44, ACCENT);
  }
}

// ---- Boat-bus (x58-68, z34-38): roof h3 bridges to the deck at z39.
function buildBoatBus(world) {
  tbox(world, 58, 1, 35, 58, 1, 37, PALE);
  tbox(world, 59, 1, 34, 60, 2, 38, BUS_YELLOW);
  tbox(world, 61, 1, 34, 68, 1, 38, BUS_YELLOW);
  tbox(world, 61, 2, 34, 68, 3, 38, POOL_TILE_BLUE);
  for (const x of [62, 64, 66]) {
    for (const z of [34, 38]) tset(world, x, 2, z, GLASS);
  }
  for (const x of [61, 68]) {
    for (const z of [34, 38]) tset(world, x, 1, z, BB_ROCK);
  }
  tbox(world, 56, 1, 36, 56, 5, 36, WOOD);
  // Swaps: headlights on the hood, tail lights, a yellow roof stripe and the
  // bus-stop sign plate on the pole top.
  tset(world, 59, 1, 35, ACCENT);
  tset(world, 59, 1, 37, ACCENT);
  tset(world, 68, 2, 35, TRUCK_RED);
  tset(world, 68, 2, 37, TRUCK_RED);
  tbox(world, 61, 3, 36, 68, 3, 36, BUS_YELLOW);
  tset(world, 56, 5, 36, TRUCK_RED);
}

// ---- Shake shack (x59-69, z57-61): the bus's point twin; roof bridges at z56.
function buildShakeShack(world) {
  tbox(world, 69, 1, 58, 69, 1, 60, PALE);
  tbox(world, 67, 1, 57, 68, 2, 61, BB_CORAL);
  tbox(world, 59, 1, 57, 66, 3, 61, BB_CORAL);
  tbox(world, 60, 2, 61, 65, 2, 61, GLASS);
  for (let x = 59; x <= 65; x += 2) tbox(world, x, 3, 57, x, 3, 61, PALE);
  // A pale counter sill under the serving window.
  tbox(world, 60, 1, 61, 65, 1, 61, PALE);
  // Giant milkshake on the roof's back corner (tops >= T+4, not a roam target):
  // coral cup, pale whipped top, red cherry and a leaning straw.
  tbox(world, 59, 4, 60, 60, 5, 61, BB_CORAL);
  tbox(world, 59, 6, 60, 60, 6, 61, PALE);
  tset(world, 60, 7, 61, TRUCK_RED);
  tset(world, 59, 7, 60, PALE);
  tset(world, 59, 8, 60, TRUCK_RED);
}

// ---- Boating School Flume (map-spec §8.6). The deck is the trough on
// z <= 56; from z57 on the trough is SLIDE_BLUE rails at y19 on a
// SLIDE_YELLOW floor at y18, on three coral stilts.
function buildFlume(world) {
  const { floor, wall, samples } = boatingFlumeCells();
  for (const [x, z] of wall) if (z >= 57) world.setBlock(x, 19, z, SLIDE_BLUE);
  for (const [x, z] of floor) if (z >= 57) world.setBlock(x, 18, z, SLIDE_YELLOW);
  for (const [x, z] of BOATING_FLUME_STILTS) fillBox(world, x, 15, z, x, 17, z, BB_CORAL);
  // Water-slide stripes: every third floor cell along the run is a pale
  // "wet" plank (a swap), so the chute reads as moving from afar.
  for (const [x, z] of floor) {
    if (z >= 57 && (x + z) % 3 === 0 && hashBB(x, 18, z) < 0.6) world.setBlock(x, 18, z, POOL_TILE_WHITE);
  }
  // Gantries: the start gate over the first trough row, a crossing gate over
  // Jellyfish Trail and the finish gate at the lip. Posts stand on the rail
  // cells (y20-21) and the lintel spans the cross-section at y22; the rider's
  // head stays under y20.5, so the gates never touch the ride.
  const total = samples.length;
  const gate = (sample, color) => {
    for (const [x, z] of sample.rails) fillBox(world, x, 20, z, x, 21, z, color);
    for (const [x, z] of [...sample.rails, ...sample.cross]) world.setBlock(x, 22, z, ACCENT);
  };
  const byZ = (z) => samples.find((s) => s.z >= z);
  gate(byZ(57.5), TRUCK_RED);
  gate(byZ(64.5), PALE);
  gate(samples[total - 4], TRUCK_RED);
}

// ---- Yard dressing inside the rectangle: slalom cones (T+1) and two traffic
// lights (tops >= T+4), placed as point twins off every door and stair.
function dressSchoolYard(world) {
  for (const [x, z] of [[51, 36], [52, 40], [51, 48], [52, 57]]) {
    tset(world, x, 1, z, TRUCK_RED);
    const [px, pz] = P(x, z);
    tset(world, px, 1, pz, TRUCK_RED);
  }
  for (const [x, z] of [[50, 34], P(50, 34)]) {
    tbox(world, x, 1, z, x, 4, z, PALE);
    tset(world, x, 5, z, GRASS);
    tset(world, x, 6, z, BUS_YELLOW);
    tset(world, x, 7, z, TRUCK_RED);
  }
}
