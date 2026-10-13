import {
  ACCENT, AIR, ASPHALT, BRICK, BUS_YELLOW, CONCRETE, CORRUGATED_STEEL, DUST_PLASTER, DUST_ROCK, DUST_SANDSTONE, GLASS,
  GRAVEL, GROUND, MC_LAVA, METAL, PALE, PLANK, ROOF, RUST, SCORCHED_EARTH, SLIDE_BLUE, SOOT_BRICK, TEAL_SIDING,
  TRUCK_RED, WOOD, YELLOW_SIDING,
} from './blocks.js';
import { fillBox as box, generateFlatBase, mirroredBox as pair } from './flatmaps.js';
import { addMapLightFixtures } from './large-map-lights.js';
import {
  ASHFALL_ARENA, ASHFALL_ARENA_COVER, ASHFALL_BILLBOARDS, ASHFALL_BLAST_WALLS, ASHFALL_CENTER, ASHFALL_CRANE, ASHFALL_HIGH_DECK, ASHFALL_LANE_COVER,
  ASHFALL_MEDIAN_WRECKS, ASHFALL_MIRROR, ASHFALL_PERCHES, ASHFALL_POUR, ASHFALL_POUR_LINE, ASHFALL_SLAG_CARS, ASHFALL_TITAN_LANES,
  PERCH_TOP,
} from './ashfall-layout.js';

// Ashfall (docs/titanfall.md §14, shared/world/ashfall-layout.js for the band
// plan). Everything outside the arena is authored for the north/west half and
// placed twice through `pair` (the 180-degree rotation); the arena is built
// from functions of radius and angle mod pi, so it is symmetric by
// construction. Heights: GROUND is the street, storeys are 4 voxels (slab +
// 3 m of air), so a slab at T + 4f carries floor f and pilots stand on T + 4f + 1.

const T = GROUND;
const MX = ASHFALL_MIRROR.x, MZ = ASHFALL_MIRROR.z;
const STOREY = 4;
const WEST = 0, EAST = 1;
const TEAM_ROOF = [SLIDE_BLUE, ACCENT];
const HIGH = T + ASHFALL_HIGH_DECK;   // the high line: every pilot bridge deck

/** Deterministic hash of a cell, identical for a cell and its rotated twin. */
function hash(x, z, salt = 0) {
  const west = x <= 111;
  const cx = west ? x : MX - x, cz = west ? z : MZ - z;
  let h = Math.imul(cx * 374761393 + cz * 668265263 + salt * 2246822519, 3266489917) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/** One voxel and its rotated twin. */
function pset(world, x, y, z, type) {
  world.setBlock(x, y, z, type);
  world.setBlock(MX - x, y, MZ - z, type);
}

/** A box on one team's side: authored for the west team, rotated for the east one. */
function teamBox(world, side, x0, y0, z0, x1, y1, z1, type) {
  if (side === WEST) box(world, x0, y0, z0, x1, y1, z1, type);
  else box(world, MX - x1, y0, MZ - z1, MX - x0, y1, MZ - z0, type);
}

/** Paint the street surface (y = GROUND) of a rectangle and its twin. */
const paint = (world, x0, z0, x1, z1, type) => pair(world, x0, T, z0, x1, T, z1, type);

/** Four walls of a rectangle at one height band (facade bands, parapets, rails). */
function ring(world, x0, z0, x1, z1, y0, y1, type) {
  pair(world, x0, y0, z0, x1, y1, z0, type);
  pair(world, x0, y0, z1, x1, y1, z1, type);
  pair(world, x0, y0, z0, x0, y1, z1, type);
  pair(world, x1, y0, z0, x1, y1, z1, type);
}

/** Every colony block of this build (west/north copies), for the dressing pass at the end. */
const BLOCKS = [];

/**
 * A multi-storey colony block (paired). Shell, slabs, a parapeted roof,
 * window rows on the facades named in `windows` (n/s/w/e; the others stay
 * unbroken for wallruns), ground doors (pilot sized: 3 wide, 3 high, so no
 * titan fits) and a stair per floor up to the roof hatch. `divider` puts a
 * waist-high crate row across the ground floor so the street-level route
 * graph never treats the building as a shortcut between two streets.
 * Shutters, balconies, AC units, sign boards and the furniture come later
 * (dressBlocks), once every bridge, breach and ruin has cut its openings.
 */
function building(world, x0, z0, x1, z1, o) {
  BLOCKS.push({ x0, z0, x1, z1, o });
  const top = T + STOREY * o.floors;
  pair(world, x0, T + 1, z0, x1, top, z1, o.wall);
  pair(world, x0 + 1, T + 1, z0 + 1, x1 - 1, top - 1, z1 - 1, AIR);
  for (let f = 1; f < o.floors; f++) pair(world, x0 + 1, T + STOREY * f, z0 + 1, x1 - 1, T + STOREY * f, z1 - 1, o.slab ?? CONCRETE);
  for (let f = 1; f < o.floors; f++) ring(world, x0, z0, x1, z1, T + STOREY * f, T + STOREY * f, o.band);
  if (o.plinth) ring(world, x0, z0, x1, z1, T + 1, T + 1, o.plinth);
  pair(world, x0, top, z0, x1, top, z1, o.band);
  pair(world, x0 + 1, top, z0 + 1, x1 - 1, top, z1 - 1, o.roof ?? ROOF);
  ring(world, x0, z0, x1, z1, top + 1, top + 1, o.trim ?? o.band);
  const windows = o.windows ?? '';
  for (let f = 0; f < o.floors; f++) {
    const y = T + STOREY * f + 2;
    // Open, glazed or (one pane in seven) shuttered.
    const pane = (k) => {
      const h = hash(k, f, x0 + z0);
      return o.glass === false || h % 3 === 0 ? AIR : h % 7 === 1 ? CORRUGATED_STEEL : GLASS;
    };
    if (windows.includes('n') || windows.includes('s')) {
      for (let x = x0 + 2, k = 0; x + 1 <= x1 - 2; x += 4, k++) {
        if (windows.includes('n')) pair(world, x, y, z0, x + 1, y + 1, z0, pane(k));
        if (windows.includes('s')) pair(world, x, y, z1, x + 1, y + 1, z1, pane(k + 7));
      }
    }
    if (windows.includes('w') || windows.includes('e')) {
      for (let z = z0 + 2, k = 0; z + 1 <= z1 - 2; z += 4, k++) {
        if (windows.includes('w')) pair(world, x0, y, z, x0, y + 1, z + 1, pane(k + 13));
        if (windows.includes('e')) pair(world, x1, y, z, x1, y + 1, z + 1, pane(k + 19));
      }
    }
  }
  for (const [side, at] of o.doors ?? []) {
    if (side === 'w') pair(world, x0, T + 1, at, x0, T + 3, at + 2, AIR);
    if (side === 'e') pair(world, x1, T + 1, at, x1, T + 3, at + 2, AIR);
    if (side === 'n') pair(world, at, T + 1, z0, at + 2, T + 3, z0, AIR);
    if (side === 's') pair(world, at, T + 1, z1, at + 2, T + 3, z1, AIR);
  }
  // Straight four-step stairs along the north wall on even floors, the south wall on odd ones.
  for (let f = 0; f < o.floors; f++) {
    const base = T + STOREY * f, sz = f % 2 === 0 ? z0 + 1 : z1 - 2, sx = x0 + 2;
    pair(world, sx, base + STOREY, sz, sx + 2, base + STOREY, sz + 1, AIR);
    for (let i = 0; i < STOREY; i++) pair(world, sx + i, base + 1, sz, sx + i, base + 1 + i, sz + 1, o.stair ?? METAL);
  }
  if (o.divider) {
    const { axis, at } = o.divider;
    if (axis === 'x') pair(world, at, T + 1, z0 + 1, at, T + 1, z1 - 1, WOOD);
    else pair(world, x0 + 1, T + 1, at, x1 - 1, T + 1, at, WOOD);
  }
  // Roof plant: vents and a tank on the far corner from the hatch.
  pair(world, x1 - 3, top + 1, z1 - 3, x1 - 2, top + 2, z1 - 2, METAL);
  pair(world, x1 - 3, top + 3, z1 - 3, x1 - 2, top + 3, z1 - 2, RUST);
}

/** A ribbed 3 x 3 cargo box along x or z, optionally stacked `level` boxes up (paired). */
function container(world, x, z, length, axis, color, level = 0) {
  const y0 = T + 1 + level * 3, y1 = y0 + 2;
  const [x1, z1] = axis === 'x' ? [x + length - 1, z + 2] : [x + 2, z + length - 1];
  pair(world, x, y0, z, x1, y1, z1, color);
  for (let d = 0; d < length; d += 3) {
    if (axis === 'x') pair(world, x + d, y0, z, x + d, y1, z1, METAL);
    else pair(world, x, y0, z + d, x1, y1, z + d, METAL);
  }
  if (axis === 'x') { pair(world, x1, y0, z, x1, y1, z1, METAL); pair(world, x, y1, z + 1, x1, y1, z + 1, PALE); }
  else { pair(world, x, y0, z1, x1, y1, z1, METAL); pair(world, x + 1, y1, z, x + 1, y1, z1, PALE); }
}

/** Upright fuel tank: a stepped disc of `r`, `h` tall, banded (paired). */
function tank(world, cx, cz, r, h, shell = PALE) {
  for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      if (Math.hypot(dx, dz) > r) continue;
      pair(world, cx + dx, T + 1, cz + dz, cx + dx, T + 1, cz + dz, CONCRETE);
      for (let y = T + 2; y <= T + 1 + h; y++) pair(world, cx + dx, y, cz + dz, cx + dx, y, cz + dz, (y - T) % 4 === 0 ? RUST : shell);
    }
  }
  pair(world, cx, T + 2 + h, cz, cx, T + 3 + h, cz, METAL);
}

/** A two-high jersey barrier line: no titan steps it, every titan gun breaks it. */
function barrier(world, x0, z0, x1, z1) {
  pair(world, x0, T + 1, z0, x1, T + 1, z1, CONCRETE);
  pair(world, x0, T + 2, z0, x1, T + 2, z1, PALE);
}

// ------------------------------------------------------------------ ground --

function groundPlan(world) {
  paint(world, 3, 3, 220, 19, GRAVEL);
  paint(world, 3, 20, 29, 155, CONCRETE);                 // team yards
  paint(world, 30, 20, 193, 33, ASPHALT);                 // boulevards
  paint(world, 30, 20, 43, 155, ASPHALT);                 // ring roads
  paint(world, 44, 34, 179, 69, CONCRETE);                // block band pavements
  paint(world, 44, 70, 111, 105, CONCRETE);               // approach yards (and the centre of the plan)
  paint(world, 70, 34, 81, 69, ASPHALT);                  // cross streets
  paint(world, 142, 34, 153, 69, ASPHALT);
  paint(world, 106, 34, 117, 57, ASPHALT);                // centre street
  // Lane markings: dashed centre lines and yard grid lines.
  for (let x = 32; x <= 191; x += 6) paint(world, x, 26, x + 2, 27, PALE);
  for (let z = 22; z <= 153; z += 6) paint(world, 36, z, 37, z + 2, PALE);
  for (let z = 36; z <= 66; z += 6) { paint(world, 75, z, 76, z + 2, PALE); paint(world, 147, z, 148, z + 2, PALE); paint(world, 111, z, 112, z + 2, PALE); }
  for (let z = 29; z <= 146; z += 9) paint(world, 4, z, 28, z, PALE);
  // Cracked slabs and soot across the approach yards (paint only: collision stays flat).
  for (let z = 70; z <= 105; z++) {
    for (let x = 44; x <= 111; x++) {
      const h = hash(x, z, 5) % 97;
      if (h < 7) pset(world, x, T, z, GRAVEL);
      else if (h < 11) pset(world, x, T, z, SCORCHED_EARTH);
      else if ((x + z) % 9 === 0 && h < 30) pset(world, x, T, z, ASPHALT);
    }
  }
  // Team yards: a coloured kerb stripe and a painted drop pad.
  for (const side of [WEST, EAST]) {
    teamBox(world, side, 29, T, 20, 29, T, 155, TEAM_ROOF[side]);
    for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
      const r = Math.hypot(dx, dz);
      if (r > 6.4) continue;
      const type = r > 5.2 ? TEAM_ROOF[side] : r < 1.5 ? PALE : CONCRETE;
      teamBox(world, side, 20 + dx, T, 88 + dz, 20 + dx, T, 88 + dz, type);
    }
  }
}

// ------------------------------------------------------------------- arena --

/** Ring wall height by angle; a function of angle mod pi keeps the ring point-symmetric. */
const RING_STEPS = [10, 14, 18, 15, 11, 8, 9, 13, 17, 20, 16, 12, 9, 8, 11, 15, 19, 13];
function ringHeight(angle) {
  const a = ((angle % Math.PI) + Math.PI) % Math.PI;
  return RING_STEPS[Math.min(RING_STEPS.length - 1, Math.floor(a / Math.PI * RING_STEPS.length))];
}
function inRingGap(angle) {
  const a = ((angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  return Math.abs(a - Math.PI / 4) < ASHFALL_ARENA.gapHalfAngle;
}

function arena(world) {
  const { x: cx, z: cz } = ASHFALL_CENTER, R = ASHFALL_ARENA.radius, P = ASHFALL_POUR;
  for (let z = Math.floor(cz - R - 1); z <= Math.ceil(cz + R + 1); z++) {
    for (let x = Math.floor(cx - R - 1); x <= Math.ceil(cx + R + 1); x++) {
      const dx = x + 0.5 - cx, dz = z + 0.5 - cz, r = Math.hypot(dx, dz), angle = Math.atan2(dz, dx);
      if (r > R + 0.5) continue;
      // Floor: a pale kerb, an asphalt ring road (dashed centre line at 25.5 m) round the tower
      // footing, a cast concrete floor inside the ring, scorched round the crucible.
      const h = hash(x, z, 9) % 100;
      let floor = r > R - 1.2 ? PALE : r > R - 2.4 ? CONCRETE : ASPHALT;
      if (Math.abs(r - 25.5) < 0.5 && (((angle + 2 * Math.PI) % Math.PI) * 25.5) % 4 < 2) floor = PALE;
      if (r < ASHFALL_ARENA.ringOuter + 2) floor = h < 6 ? SOOT_BRICK : h < 10 ? SCORCHED_EARTH : CONCRETE;
      if (r < P.rim + 1.5 + (h % 3) * 0.5) floor = h < 45 ? SCORCHED_EARTH : SOOT_BRICK;
      world.setBlock(x, T, z, floor);
      // The Pour Line crosses the north and south arcs (|dx| < 3): the ring is broken down to its rack.
      const underRack = Math.abs(dx) < 3;
      // The broken cooling-tower ring: two voxels thick, four diagonal breaches for titans.
      if (r >= ASHFALL_ARENA.ringInner && r < ASHFALL_ARENA.ringOuter && !inRingGap(angle)) {
        const top = Math.min(T + ringHeight(angle) - (h < 12 ? 1 : 0), underRack ? T + 10 : Infinity);
        for (let y = T + 1; y <= top; y++) {
          const band = (y - T) % 5 === 0;
          const soot = y > top - 2 && h < 55;
          world.setBlock(x, y, z, soot ? SOOT_BRICK : band ? PALE : CONCRETE);
        }
        if (h % 7 === 0 && !underRack) world.setBlock(x, top + 1, z, RUST);            // exposed rebar
      }
      // Buttress ribs on the outer face every ~22 degrees: hand holds and wallrun breaks.
      const rib = Math.abs(((angle * 8 / Math.PI) % 1 + 1) % 1 - 0.5) < 0.06;
      if (rib && !underRack && r >= ASHFALL_ARENA.ringOuter && r < ASHFALL_ARENA.ringOuter + 1 && !inRingGap(angle)) {
        const top = T + Math.max(4, ringHeight(angle) - 3);
        for (let y = T + 1; y <= top; y++) world.setBlock(x, y, z, CONCRETE);
      }
      // The Pour: a slag pool one voxel up inside a 2 m crucible rim; the runners leave
      // it through culverts in the rim, run one voxel deep across the inner ring floor,
      // through 2 m culverts in the ring wall and end in slag pits just outside it.
      const runner = P.runner.includes(x);
      if (r < P.pool) {
        world.setBlock(x, T, z, CONCRETE);
        world.setBlock(x, T + 1, z, MC_LAVA);
      } else if (r < P.rim) {
        for (let y = T + 1; y <= T + P.rimHeight; y++) world.setBlock(x, y, z, y === T + P.rimHeight ? RUST : h < 50 ? METAL : SOOT_BRICK);
        if (runner) { world.setBlock(x, T, z, MC_LAVA); world.setBlock(x, T + 1, z, MC_LAVA); }
      } else if (r < P.runOut && (runner || (Math.abs(dx) < 2 && r >= ASHFALL_ARENA.ringOuter))) {
        world.setBlock(x, T, z, MC_LAVA);
        if (runner && r >= ASHFALL_ARENA.ringInner) for (let y = T + 1; y <= T + 2; y++) world.setBlock(x, y, z, AIR);
      } else if (r < ASHFALL_ARENA.ringInner && Math.abs(dx) < 2) {
        world.setBlock(x, T, z, h < 50 ? METAL : RUST);                  // runner kerbs
      }
    }
  }
  // Out in the field, only on the cardinal sectors behind the arcs (the diagonal
  // breach corridors stay clear): a toppled ring segment west (and east), a
  // wrecked ore hauler across the centre-street mouth north (and south).
  pair(world, 84, T + 1, 82, 86, T + 3, 93, CONCRETE);
  pair(world, 84, T + 4, 84, 86, T + 4, 90, PALE);
  pair(world, 85, T + 1, 85, 85, T + 2, 87, AIR);
  pair(world, 106, T + 1, 61, 113, T + 3, 64, TRUCK_RED);
  pair(world, 107, T + 2, 61, 112, T + 3, 64, AIR);
  pair(world, 107, T + 1, 62, 112, T + 2, 63, GRAVEL);
  pair(world, 114, T + 1, 61, 116, T + 2, 64, METAL);
  // Titan cover inside the ring, west of the Pour (and east): a stack of cast
  // ingots (6 m, a titan crouches behind it) and a cold crucible tipped on its side.
  pair(world, 99, T + 1, 82, 102, T + 6, 84, RUST);
  for (let y = T + 2; y <= T + 6; y += 2) pair(world, 99, y, 82, 102, y, 84, PALE);
  pair(world, 100, T + 6, 83, 101, T + 6, 83, SOOT_BRICK);
  pair(world, 98, T + 1, 90, 101, T + 4, 93, RUST);
  for (const [x, y, z] of [[98, T + 1, 90], [98, T + 4, 93], [101, T + 1, 90], [101, T + 4, 93]]) pair(world, x, y, z, x, y, z, AIR);
  pair(world, 98, T + 2, 91, 98, T + 3, 92, SOOT_BRICK);
  arenaCover(world);
}

// -------------------------------------------------------------- the pour --

/**
 * The Pour Line (ashfall-layout.js ASHFALL_POUR_LINE): a pipe-rack walkway on the
 * high line from the north band's centre skybridge over the centre street, the
 * hauler, the broken ring and the Pour to the south band. Pipes along both edges
 * are a pilot's low cover; a slag main hangs under it outside the Pour (9 m of
 * titan clearance); bents stand at the street edges and inside the ring (with
 * ladders, mapMeta.ladders); two ladles hang over the pool and pour slag into it.
 */
function pourLine(world) {
  const { x0, x1, z0, z1 } = ASHFALL_POUR_LINE;
  for (let z = z0; z <= (z0 + z1) >> 1; z++) {
    pair(world, x0, HIGH, z, x1, HIGH, z, CONCRETE);
    pair(world, x0, HIGH, z, x0, HIGH, z, RUST);
    pair(world, x1, HIGH, z, x1, HIGH, z, RUST);
    pair(world, x0, HIGH - 1, z, x0, HIGH - 1, z, RUST);
    pair(world, x1, HIGH - 1, z, x1, HIGH - 1, z, RUST);
    // Edge pipes, broken every 10 m for hopping on and off sideways.
    if ((z - z0) % 10 < 8) { pair(world, x0, HIGH + 1, z, x0, HIGH + 1, z, RUST); pair(world, x1, HIGH + 1, z, x1, HIGH + 1, z, RUST); }
    if ((z - z0) % 4 === 0) { pair(world, x0, HIGH + 1, z, x0, HIGH + 1, z, METAL); pair(world, x1, HIGH + 1, z, x1, HIGH + 1, z, METAL); }
    // The slag main under the deck, up to the ladles.
    if (z <= 78) pair(world, x0 + 1, HIGH - 2, z, x1 - 1, HIGH - 1, z, (z % 6) ? RUST : METAL);
  }
  // Bents: a portal over the centre street (legs on its kerbs) and one inside the ring.
  const bent = (z, lx0, lx1) => {
    pair(world, lx0, T + 1, z, lx0, HIGH - 1, z + 1, METAL);
    pair(world, lx1, T + 1, z, lx1, HIGH - 1, z + 1, METAL);
    pair(world, lx0, HIGH - 1, z, lx1, HIGH - 1, z + 1, RUST);
    pair(world, lx0, HIGH, z, lx1, HIGH, z + 1, CONCRETE);
    for (let y = T + 3; y < HIGH - 1; y += 3) { pair(world, lx0, y, z, lx0, y, z, RUST); pair(world, lx1, y, z, lx1, y, z, RUST); }
  };
  const [street, ring] = ASHFALL_POUR_LINE.bents;
  bent(street, 105, 118);
  bent(ring, 107, 116);
  // Ladles over the pool: a rust bowl with a molten top on two hangers, tipped
  // toward the centre so its spout pours a slag column into the pool.
  pair(world, x0, T + 7, 80, x1, T + 10, 83, RUST);
  pair(world, x0 + 1, T + 10, 81, x1 - 1, T + 10, 82, MC_LAVA);
  pair(world, x0, T + 9, 80, x1, T + 9, 83, SOOT_BRICK);
  pair(world, x0, T + 7, 80, x0, T + 7, 80, AIR);
  pair(world, x1, T + 7, 80, x1, T + 7, 80, AIR);
  pair(world, x0, HIGH - 1, 81, x0, HIGH - 1, 82, METAL);
  pair(world, x1, HIGH - 1, 81, x1, HIGH - 1, 82, METAL);
  pair(world, 112, T + 8, 84, 112, T + 9, 84, RUST);
  pair(world, 112, T + 2, 85, 112, T + 8, 85, MC_LAVA);
}

// -------------------------------------------------------------- team yards --

function teamYard(world, side) {
  const roof = TEAM_ROOF[side];
  // Four spawn canopies over the inner spawn column.
  for (const [z0, z1] of [[40, 54], [60, 74], [101, 115], [121, 135]]) {
    for (const x of [5, 14]) for (const z of [z0, z1]) teamBox(world, side, x, T + 1, z, x, T + 6, z, METAL);
    teamBox(world, side, 5, T + 7, z0, 14, T + 7, z1, roof);
    teamBox(world, side, 5, T + 7, z0, 14, T + 7, z0, RUST);
    teamBox(world, side, 5, T + 7, z1, 14, T + 7, z1, RUST);
    teamBox(world, side, 9, T + 7, z0 + 2, 10, T + 7, z1 - 2, GLASS);
  }
  // Barracks against the back wall: two storeys, team roof, doors onto the yard.
  teamBox(world, side, 3, T + 1, 80, 8, T + 8, 95, SOOT_BRICK);
  teamBox(world, side, 3, T + 1, 81, 7, T + 3, 94, AIR);
  teamBox(world, side, 3, T + 4, 81, 7, T + 4, 94, CONCRETE);
  teamBox(world, side, 3, T + 5, 81, 7, T + 7, 94, AIR);
  teamBox(world, side, 3, T + 8, 80, 8, T + 8, 95, roof);
  teamBox(world, side, 8, T + 1, 84, 8, T + 3, 86, AIR);
  teamBox(world, side, 8, T + 1, 89, 8, T + 3, 91, AIR);
  for (const z of [82, 92]) teamBox(world, side, 8, T + 6, z, 8, T + 6, z + 1, GLASS);
  teamBox(world, side, 3, T + 4, 81, 6, T + 4, 82, AIR);
  for (let i = 0; i < 4; i++) teamBox(world, side, 4 + i, T + 1, 81, 4 + i, T + 1 + i, 82, METAL);
  // Comms mast and a supply stack at each yard end.
  for (const z of [24, 151]) {
    for (const [dx, dz] of [[0, 0], [2, 0], [0, 2], [2, 2]]) teamBox(world, side, 5 + dx, T + 1, z + dz, 5 + dx, T + 20, z + dz, METAL);
    for (let y = T + 4; y <= T + 20; y += 4) teamBox(world, side, 5, y, z, 7, y, z + 2, RUST);
    teamBox(world, side, 6, T + 21, z + 1, 6, T + 24, z + 1, METAL);
    teamBox(world, side, 6, T + 25, z + 1, 6, T + 25, z + 1, roof);
  }
  for (const [x, z] of [[23, 36], [23, 138]]) {
    teamBox(world, side, x, T + 1, z, x + 3, T + 2, z + 2, PLANK);
    teamBox(world, side, x + 1, T + 3, z, x + 2, T + 3, z + 1, WOOD);
  }
  // Titan cover on the apron either side of the drop ring: two 5 m revetments with the team stripe.
  for (const z of [76, 97]) {
    teamBox(world, side, 24, T + 1, z, 27, T + 5, z + 2, CONCRETE);
    teamBox(world, side, 24, T + 4, z, 27, T + 4, z + 2, roof);
    teamBox(world, side, 24, T + 5, z, 27, T + 5, z + 2, SOOT_BRICK);
  }
  // Parked supply truck facing the ring road.
  teamBox(world, side, 18, T + 1, 22, 26, T + 1, 25, METAL);
  teamBox(world, side, 18, T + 2, 22, 23, T + 4, 25, side === WEST ? TEAL_SIDING : YELLOW_SIDING);
  teamBox(world, side, 24, T + 2, 22, 26, T + 3, 25, TRUCK_RED);
  teamBox(world, side, 26, T + 3, 23, 26, T + 3, 24, GLASS);
}

/** Ring of cells at Chebyshev distance `d` about a centre, in the relay tower's spiral order. */
function squareLoop(d) {
  const loop = [];
  for (let k = -d; k < d; k++) loop.push([k, d]);
  for (let k = d; k > -d; k--) loop.push([d, k]);
  for (let k = d; k > -d; k--) loop.push([k, -d]);
  for (let k = -d; k < d; k++) loop.push([-d, k]);
  return loop;
}

/**
 * Yard towers (ASHFALL_YARD_TOWERS) and their gantries (ASHFALL_GANTRIES): a
 * steel stair tower at the yard's inner edge climbs to a 7 x 7 deck on the high
 * line, and a gantry over the ring road (11 m of titan clearance) enters the
 * nearest outer block through a floor-3 door, so a pilot leaves the yard on the
 * high line. Built neutral and paired; teamYard paints the team colours.
 */
function yardTowers(world) {
  const steps = ASHFALL_HIGH_DECK, loop = squareLoop(2);
  for (const cz of [56, 119]) {
    const cx = 26;
    pair(world, cx - 1, T + 1, cz - 1, cx + 1, HIGH, cz + 1, CONCRETE);
    for (let y = T + 3; y < HIGH; y += 4) pair(world, cx - 1, y, cz - 1, cx + 1, y, cz + 1, METAL);
    for (let k = 0; k < steps; k++) {
      const [dx, dz] = loop[k % loop.length];
      pair(world, cx + dx, T + k, cz + dz, cx + dx, T + 1 + k, cz + dz, METAL);
    }
    // Deck on the 7 x 7, open above the last spiral steps (headroom for the climb).
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      const k = loop.findIndex(([lx, lz]) => lx === dx && lz === dz);
      if (Math.max(Math.abs(dx), Math.abs(dz)) <= 1 || (k >= steps - 3 && k < steps)) continue;
      pair(world, cx + dx, HIGH, cz + dz, cx + dx, HIGH, cz + dz, Math.max(Math.abs(dx), Math.abs(dz)) === 3 ? RUST : METAL);
    }
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
      pair(world, cx + dx, T + 1, cz + dz, cx + dx, HIGH - 1, cz + dz, METAL);
      pair(world, cx + dx, HIGH + 1, cz + dz, cx + dx, HIGH + 3, cz + dz, METAL);
    }
    // Clad on the yard side and both flanks from 5 m up, open toward the ring road: a pilot on
    // the upper spiral (of either team) never sees down into the yard's spawns.
    pair(world, cx - 3, T + 5, cz - 3, cx - 3, HIGH - 1, cz + 3, CORRUGATED_STEEL);
    for (const z of [cz - 3, cz + 3]) pair(world, cx - 3, T + 5, z, cx + 2, HIGH - 1, z, CORRUGATED_STEEL);
    for (let y = T + 4; y < HIGH; y += 4) ring(world, cx - 3, cz - 3, cx + 3, cz + 3, y, y, RUST);
    // A booth on the deck: 3 m steel walls on the same three sides up to the canopy, open only
    // toward the gantry, so the deck sees no spawn either; a rust kick plate along the flanks.
    pair(world, cx - 3, HIGH + 1, cz - 3, cx - 3, HIGH + 3, cz + 3, CORRUGATED_STEEL);
    for (const z of [cz - 3, cz + 3]) {
      pair(world, cx - 3, HIGH + 1, z, cx + 2, HIGH + 3, z, CORRUGATED_STEEL);
      pair(world, cx - 2, HIGH + 1, z, cx + 2, HIGH + 1, z, RUST);
    }
    // Gantry over the ring road into the block's floor-3 door: an enclosed gallery (steel walls
    // and a roof on a 5 m deck, a 3 m walk inside), so no one on it looks down into the yard.
    const z0 = cz - 2, z1 = cz + 2;
    pair(world, cx + 4, HIGH, z0, 44, HIGH, z1, CONCRETE);
    pair(world, cx + 4, HIGH - 1, z0, 44, HIGH - 1, z0, RUST);
    pair(world, cx + 4, HIGH - 1, z1, 44, HIGH - 1, z1, RUST);
    for (const z of [z0, z1]) {
      pair(world, cx + 4, HIGH, z, 44, HIGH + 3, z, CORRUGATED_STEEL);
      pair(world, cx + 4, HIGH + 1, z, 44, HIGH + 1, z, RUST);
      for (let x = cx + 4; x <= 44; x += 4) pair(world, x, HIGH, z, x, HIGH + 3, z, METAL);
    }
    pair(world, cx + 4, HIGH + 4, z0, 44, HIGH + 4, z1, ROOF);
    pair(world, cx + 4, HIGH + 4, z0, 44, HIGH + 4, z0, RUST);
    pair(world, cx + 4, HIGH + 4, z1, 44, HIGH + 4, z1, RUST);
    pair(world, 45, HIGH + 1, z0 + 1, 45, HIGH + 3, z1 - 1, AIR);
    // Shutters on the block's top-floor windows over the gallery roof (nobody steps out onto it).
    pair(world, 45, HIGH + 6, z0, 45, HIGH + 7, z1 + 1, CORRUGATED_STEEL);
    // Team colours: a core band and the canopy, blue in the west yard and orange in the east one.
    for (const side of [WEST, EAST]) {
      teamBox(world, side, cx - 1, T + 6, cz - 1, cx + 1, T + 6, cz + 1, TEAM_ROOF[side]);
      teamBox(world, side, cx - 3, HIGH + 4, cz - 3, cx + 3, HIGH + 4, cz + 3, TEAM_ROOF[side]);
      teamBox(world, side, cx - 2, HIGH + 4, cz - 2, cx + 2, HIGH + 4, cz + 2, GLASS);
    }
  }
}

// --------------------------------------------------------------- outskirts --

function outskirts(world) {
  // Slag heaps in the corners: stepped mounds of spoil pilots can climb.
  for (const [hx, x0, x1] of [[9, 3, 43], [214, 180, 220]]) {
    for (let z = 3; z <= 19; z++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot((x - hx) * 0.8, z - 8), h = Math.floor(7 - d / 2.4 + (hash(x, z, 3) % 3) * 0.4);
        for (let y = T + 1; y <= T + h; y++) pset(world, x, y, z, y > T + h - 1 ? GRAVEL : y > T + 3 ? SCORCHED_EARTH : DUST_ROCK);
      }
    }
  }
  // Pipeline behind the north sheds: a 2 x 2 main on legs and a high feeder line.
  pair(world, 46, T + 3, 7, 177, T + 4, 8, RUST);
  for (let x = 46; x <= 177; x += 4) pair(world, x, T + 3, 7, x, T + 4, 8, METAL);
  for (let x = 48; x <= 176; x += 12) pair(world, x, T + 1, 7, x, T + 2, 8, CONCRETE);
  pair(world, 46, T + 7, 11, 177, T + 7, 11, METAL);
  for (let x = 52; x <= 172; x += 24) pair(world, x, T + 1, 11, x, T + 6, 11, METAL);
  // Sheds between the pipeline and the boulevard.
  pair(world, 50, T + 1, 12, 61, T + 5, 18, CORRUGATED_STEEL);
  pair(world, 51, T + 1, 13, 60, T + 4, 17, AIR);
  pair(world, 54, T + 1, 18, 56, T + 3, 18, AIR);
  pair(world, 50, T + 6, 12, 61, T + 6, 18, RUST);
  building(world, 86, 10, 97, 18, { floors: 2, wall: BRICK, band: SOOT_BRICK, windows: 's', doors: [['s', 90]] });
  pair(world, 125, T + 1, 12, 134, T + 5, 18, CORRUGATED_STEEL);
  pair(world, 126, T + 1, 13, 133, T + 4, 17, AIR);
  pair(world, 128, T + 1, 18, 130, T + 3, 18, AIR);
  pair(world, 125, T + 6, 12, 134, T + 6, 18, ROOF);
  building(world, 160, 10, 171, 18, { floors: 2, wall: SOOT_BRICK, band: RUST, windows: 's', doors: [['s', 164]] });
  tank(world, 110, 12, 3.2, 8, PALE);
  tank(world, 117, 13, 2.3, 6, PALE);
}

// -------------------------------------------------------------- north band --

/** Hab Stack: two habitat towers split by a wallrun alley that titans cannot enter. */
function habStack(world) {
  building(world, 45, 36, 55, 67, { floors: 5, wall: CONCRETE, band: PALE, plinth: SOOT_BRICK, roof: ROOF,
    windows: 'nsw', doors: [['w', 40], ['w', 60]], divider: { axis: 'z', at: 51 } });
  building(world, 60, 36, 68, 53, { floors: 4, wall: DUST_PLASTER, band: RUST, plinth: SOOT_BRICK,
    windows: 'ne', doors: [['e', 46]] });
  building(world, 60, 54, 68, 67, { floors: 2, wall: DUST_PLASTER, band: RUST, plinth: SOOT_BRICK,
    windows: 'se', doors: [['e', 60]] });
  paint(world, 56, 34, 59, 67, ASPHALT);
  // Battery cache inside the annex's street door (ashfall-layout.js ASHFALL_BATTERY_CACHES): a charging rack.
  pair(world, 65, T + 1, 60, 65, T + 2, 62, METAL);
  pair(world, 65, T + 3, 60, 65, T + 3, 62, BUS_YELLOW);
  // Low skybridges at both alley mouths (4 m clearance) and a high one between the third floors.
  for (const z of [36, 66]) { pair(world, 56, T + 5, z, 59, T + 5, z + 1, METAL); pair(world, 56, T + 6, z, 59, T + 6, z, RUST); }
  pair(world, 56, T + 12, 50, 59, T + 12, 51, CONCRETE);
  pair(world, 55, T + 13, 50, 55, T + 15, 51, AIR);
  pair(world, 60, T + 13, 50, 60, T + 15, 51, AIR);
  // Kerb at the south mouth: the alley is a dead end for the street-level route graph.
  pair(world, 56, T + 1, 64, 59, T + 1, 64, PALE);
  // Hanging cables and an awning along the alley.
  for (const z of [42, 57]) pair(world, 56, T + 9, z, 59, T + 9, z, RUST);
}

/** Smelter Hall: a tall corrugated hall with a mezzanine U at the bridge level. */
function smelterHall(world) {
  const x0 = 83, z0 = 36, x1 = 104, z1 = 55, top = T + 16;
  pair(world, x0, T + 1, z0, x1, top - 1, z1, RUST);
  pair(world, x0 + 1, T + 1, z0 + 1, x1 - 1, top - 1, z1 - 1, AIR);
  ring(world, x0, z0, x1, z1, T + 1, T + 3, SOOT_BRICK);
  ring(world, x0, z0, x1, z1, T + 8, T + 8, PALE);
  for (let x = x0 + 3; x <= x1 - 4; x += 4) {
    pair(world, x, T + 10, z0, x + 1, T + 12, z0, GLASS);
    pair(world, x, T + 10, z1, x + 1, T + 12, z1, GLASS);
  }
  for (let x = x0; x <= x1; x += 7) { pair(world, x, T + 1, z0, x, top - 1, z0, METAL); pair(world, x, T + 1, z1, x, top - 1, z1, METAL); }
  // Sawtooth roof with skylights.
  pair(world, x0, top, z0, x1, top, z1, ROOF);
  for (let z = z0 + 2; z <= z1 - 3; z += 5) {
    pair(world, x0 + 1, top + 1, z, x1 - 1, top + 1, z + 1, ROOF);
    pair(world, x0 + 1, top + 2, z + 1, x1 - 1, top + 2, z + 1, PALE);
    pair(world, x0 + 2, top, z + 2, x1 - 2, top, z + 2, GLASS);
  }
  // Mezzanine U at y = T + 12: west and east arms, north gallery, rails.
  pair(world, x0 + 1, T + 12, z0 + 1, x0 + 3, T + 12, z1 - 1, CONCRETE);
  pair(world, x1 - 3, T + 12, z0 + 1, x1 - 1, T + 12, z1 - 1, CONCRETE);
  pair(world, x0 + 1, T + 12, z0 + 1, x1 - 1, T + 12, z0 + 3, CONCRETE);
  pair(world, x0 + 4, T + 13, z0 + 4, x0 + 4, T + 13, z1 - 1, METAL);
  pair(world, x1 - 4, T + 13, z0 + 4, x1 - 4, T + 13, z1 - 1, METAL);
  pair(world, x0 + 4, T + 13, z0 + 4, x1 - 4, T + 13, z0 + 4, METAL);
  // Stair to the west arm: twelve steps along x0 + 4..5 from the south end northwards.
  for (let i = 0; i < 12; i++) pair(world, x0 + 4, T + 1, z1 - 1 - i, x0 + 5, T + 1 + i, z1 - 1 - i, METAL);
  pair(world, x0 + 4, T + 13, z1 - 12, x0 + 4, T + 13, z1 - 1, AIR);
  // Ladle on its cradle, a crane beam and a crate row splitting the floor (route graph).
  pair(world, 96, T + 1, 44, 100, T + 1, 48, CONCRETE);
  pair(world, 96, T + 2, 44, 100, T + 5, 48, RUST);
  pair(world, 97, T + 3, 45, 99, T + 5, 47, SOOT_BRICK);
  pair(world, x0 + 1, T + 10, 45, x1 - 1, T + 10, 46, METAL);
  pair(world, 93, T + 1, z0 + 1, 93, T + 1, z1 - 1, WOOD);
  // Doors: west onto the cross street, east onto the centre street, south onto the arena apron.
  pair(world, x0, T + 1, 44, x0, T + 3, 46, AIR);
  pair(world, x1, T + 1, 44, x1, T + 3, 46, AIR);
  pair(world, 96, T + 1, z1, 98, T + 3, z1, AIR);
  // Bridge mouths in the end walls at the mezzanine level.
  pair(world, x0, T + 13, 44, x0, T + 15, 46, AIR);
  pair(world, x1, T + 13, 40, x1, T + 15, 42, AIR);
  // Smokestack against the north wall.
  pair(world, 97, T + 1, 34, 100, top + 8, 35, SOOT_BRICK);
  pair(world, 97, top + 9, 34, 100, top + 9, 35, RUST);
  pair(world, 98, top + 9, 34, 99, top + 9, 35, AIR);
}

/** Relay Block: a three-storey admin block and a spiral-stair relay tower. */
function relayBlock(world) {
  building(world, 119, 36, 132, 55, { floors: 3, wall: PALE, band: TEAL_SIDING, plinth: CONCRETE,
    windows: 'nse', doors: [['w', 47], ['s', 124]] });
  pair(world, 119, T + 13, 40, 119, T + 13, 42, AIR);             // parapet gap for the hall bridge
  pair(world, 132, T + 13, 40, 132, T + 13, 42, AIR);             // and toward the relay deck
  // Relay tower about (137, 41): solid core, a spiral stair on the 5 x 5 ring, decks on the 7 x 7 ring.
  const cx = 137, cz = 41;
  pair(world, cx - 1, T + 1, cz - 1, cx + 1, T + 22, cz + 1, CONCRETE);
  for (let y = T + 4; y <= T + 22; y += 6) pair(world, cx - 1, y, cz - 1, cx + 1, y, cz + 1, ACCENT);
  const loop = [];
  for (let d = -2; d < 2; d++) loop.push([d, 2]);
  for (let d = 2; d > -2; d--) loop.push([2, d]);
  for (let d = 2; d > -2; d--) loop.push([d, -2]);
  for (let d = -2; d < 2; d++) loop.push([-2, d]);
  for (let k = 0; k < 20; k++) {
    const [dx, dz] = loop[k % loop.length];
    pair(world, cx + dx, T + k, cz + dz, cx + dx, T + 1 + k, cz + dz, METAL);
  }
  for (const y of [T + 12, T + 20]) {
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === 3) pair(world, cx + dx, y, cz + dz, cx + dx, y, cz + dz, METAL);
    }
  }
  for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    pair(world, cx + dx, T + 1, cz + dz, cx + dx, T + 11, cz + dz, METAL);
    pair(world, cx + dx, T + 13, cz + dz, cx + dx, T + 19, cz + dz, METAL);
    pair(world, cx + dx, T + 21, cz + dz, cx + dx, T + 23, cz + dz, METAL);
  }
  pair(world, cx, T + 23, cz, cx, T + 24, cz, METAL);
  pair(world, cx, T + 25, cz, cx, T + 25, cz, ACCENT);
  pair(world, 133, T + 12, 39, 133, T + 12, 43, CONCRETE);        // step from the admin roof
}

/** Tenements: brick walk-ups around an L of alleys, the tallest block against the ring road. */
function tenements(world) {
  building(world, 155, 36, 166, 51, { floors: 4, wall: SOOT_BRICK, band: BRICK, plinth: CONCRETE,
    windows: 'nw', doors: [['w', 45]] });
  building(world, 155, 56, 166, 67, { floors: 2, wall: DUST_PLASTER, band: BRICK, plinth: SOOT_BRICK,
    windows: 'sw', doors: [['s', 159]] });
  building(world, 171, 36, 178, 67, { floors: 5, wall: CORRUGATED_STEEL, band: YELLOW_SIDING, plinth: SOOT_BRICK,
    windows: 'nse', doors: [['e', 44], ['e', 58]], divider: { axis: 'z', at: 52 } });
  paint(world, 155, 52, 170, 55, ASPHALT);
  paint(world, 167, 34, 170, 67, ASPHALT);
  for (const z of [36, 66]) { pair(world, 167, T + 5, z, 170, T + 5, z + 1, METAL); pair(world, 167, T + 6, z, 170, T + 6, z, RUST); }
  pair(world, 167, T + 12, 44, 170, T + 12, 45, CONCRETE);
  pair(world, 166, T + 13, 44, 166, T + 15, 45, AIR);
  pair(world, 171, T + 13, 44, 171, T + 15, 45, AIR);
  pair(world, 155, T + 1, 52, 155, T + 1, 55, PALE);              // kerb: the E-W alley is a dead end
  pair(world, 155, T + 5, 52, 156, T + 5, 55, METAL);             // low skybridge over the E-W alley mouth
  pair(world, 155, T + 6, 52, 155, T + 6, 55, RUST);
  pair(world, 167, T + 1, 64, 170, T + 1, 64, PALE);              // and so is the N-S one
  pair(world, 155, T + 5, 52, 166, T + 5, 52, RUST);              // awning
  for (const x of [158, 163]) pair(world, x, T + 9, 52, x, T + 9, 55, METAL);
}

/** High bridges (deck at T + 12, 11 m clearance: titans walk under, pilots cross the band). */
function skybridges(world) {
  const deck = (x0, x1, z0, z1) => {
    pair(world, x0, T + 12, z0, x1, T + 12, z1, CONCRETE);
    pair(world, x0, T + 12, z0, x1, T + 12, z0, RUST);
    pair(world, x0, T + 12, z1, x1, T + 12, z1, RUST);
    for (let x = x0; x <= x1; x += 3) { pair(world, x, T + 13, z0, x, T + 13, z0, METAL); pair(world, x, T + 13, z1, x, T + 13, z1, METAL); }
    pair(world, x0, T + 11, z0, x1, T + 11, z0, RUST);
    pair(world, x0, T + 11, z1, x1, T + 11, z1, RUST);
  };
  deck(69, 82, 43, 47);                                   // Hab Stack -> Smelter Hall
  pair(world, 68, T + 13, 44, 68, T + 15, 46, AIR);
  deck(105, 118, 39, 43);                                 // Smelter Hall -> admin roof
  deck(141, 154, 39, 43);                                 // relay deck -> tenements
  pair(world, 140, T + 13, 40, 140, T + 13, 42, AIR);
  pair(world, 155, T + 13, 40, 155, T + 15, 42, AIR);
}

// --------------------------------------------------------- approach yards --

/** An 8 m blast wall [x0..x1] at z, 1 thick (paired): titan cover and a wallrun panel. */
function blastWall(world, x0, z, x1) {
  pair(world, x0, T + 1, z, x1, T + 8, z, CONCRETE);
  for (let x = x0; x <= x1; x++) pair(world, x, T + 1, z, x, T + 2, z, (x - x0) % 2 ? SOOT_BRICK : PALE);
  pair(world, x0, T + 5, z, x1, T + 5, z, BUS_YELLOW);
  pair(world, x0, T + 8, z, x1, T + 8, z, RUST);
  if ((x1 - x0) % 2 === 0) pair(world, (x0 + x1) >> 1, T + 8, z, (x0 + x1) >> 1, T + 8, z, SOOT_BRICK);
}

/**
 * A rodeo perch (ASHFALL_PERCHES): a 3 x 3 steel deck at T + PERCH_TOP on four
 * legs (a work lamp on one corner), and the straight two-wide stair bots walk up.
 */
function perch(world, { deck: [x0, z0, x1, z1], stair: [sx0, sz0, sx1, sz1, dir] }) {
  const top = T + PERCH_TOP, alongX = dir[1] === 'x', up = dir[0] === '+' ? 1 : -1;
  pair(world, x0, top, z0, x1, top, z1, METAL);
  pair(world, x0, top - 1, z0, x1, top - 1, z1, RUST);
  // Legs only: a one-voxel stanchion on the deck corner is a ledge a pilot can wedge on.
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) pair(world, x, T + 1, z, x, top - 2, z, METAL);
  const first = alongX ? (up > 0 ? sx0 : sx1) : (up > 0 ? sz0 : sz1);
  for (let i = 0; i < PERCH_TOP; i++) {
    const t = first + up * i;
    if (alongX) pair(world, t, T + 1 + i, sz0, t, T + 1 + i, sz1, i % 2 ? RUST : METAL);
    else pair(world, sx0, T + 1 + i, t, sx1, T + 1 + i, t, i % 2 ? RUST : METAL);
  }
  // Scaffold frame on both sides: posts every other tread under a level top rail at the deck's
  // rail height. A titan's footprint (wider than the stair) cannot cross the frame line, and its
  // level top gives no stair profile a hull could step up beside the treads.
  for (let i = 0; i < PERCH_TOP; i++) {
    const t = first + up * i, post = i % 2 === 0 || i === PERCH_TOP - 1;
    for (const side of [-1, 1]) {
      const c = alongX ? (side < 0 ? sz0 - 1 : sz1 + 1) : (side < 0 ? sx0 - 1 : sx1 + 1);
      const [ax, az] = alongX ? [t, c] : [c, t];
      pair(world, ax, top + 1, az, ax, top + 1, az, METAL);
      if (post) pair(world, ax, T + 1, az, ax, top, az, RUST);
    }
  }
  // Closed stringer box under the treads: an open underside let a bot walk in under the stair
  // and wedge against a frame post (soak seed 4).
  for (let i = 1; i < PERCH_TOP; i++) {
    const t = first + up * i;
    if (alongX) pair(world, t, T + 1, sz0, t, T + i, sz1, METAL);
    else pair(world, sx0, T + 1, t, sx1, T + i, t, METAL);
  }
}

/**
 * West approach yard (x 44-82, z 70-105; the east one is its rotation): the ore
 * dock (a 3 m titan platform with ramps, a hull-down parapet toward the arena and
 * a battery cache nook under it), the blast-wall slalom and the ring-road perch.
 */
function approachYard(world) {
  for (const [x0, z, x1] of ASHFALL_BLAST_WALLS) if (x0 < MX / 2) blastWall(world, x0, z, x1);
  // Ore dock: x 50-68, z 84-95, top T + 3; ramps of 2 m steps west (z 85-91, clear of the perch stair) and south (x 56-62).
  pair(world, 50, T + 1, 84, 68, T + 3, 95, CONCRETE);
  pair(world, 50, T + 1, 84, 68, T + 1, 95, SOOT_BRICK);
  ring(world, 50, 84, 68, 95, T + 3, T + 3, PALE);
  pair(world, 48, T + 1, 85, 49, T + 2, 91, CONCRETE);
  pair(world, 46, T + 1, 85, 47, T + 1, 91, CONCRETE);
  pair(world, 56, T + 1, 96, 62, T + 2, 97, CONCRETE);
  pair(world, 56, T + 1, 98, 62, T + 1, 99, CONCRETE);
  for (let z = 85; z <= 91; z += 2) pair(world, 46, T + 1, z, 49, T + 1, z, GRAVEL);
  // Ore bins on the deck and the hull-down parapet on the arena edge.
  pair(world, 68, T + 4, 84, 68, T + 5, 87, CONCRETE);
  pair(world, 68, T + 4, 93, 68, T + 5, 95, CONCRETE);
  pair(world, 68, T + 5, 84, 68, T + 5, 87, SOOT_BRICK);
  pair(world, 68, T + 5, 93, 68, T + 5, 95, SOOT_BRICK);
  pair(world, 58, T + 4, 84, 63, T + 4, 84, PALE);
  pair(world, 52, T + 4, 92, 54, T + 6, 94, RUST);
  pair(world, 53, T + 6, 93, 53, T + 6, 93, GRAVEL);
  // Battery cache nook in the dock's arena face: 3 wide, 2 high, 4 deep (no hull enters).
  pair(world, 65, T + 1, 89, 68, T + 2, 91, AIR);
  pair(world, 65, T + 1, 89, 65, T + 2, 89, METAL);
  pair(world, 65, T + 1, 91, 65, T + 2, 91, METAL);
  pair(world, 65, T + 2, 90, 65, T + 2, 90, PALE);
  pair(world, 64, T + 1, 90, 64, T + 1, 90, AIR);
  // Containers and low barriers for pilots along the south strip, a fuel tank on the arena side.
  container(world, 52, 101, 9, 'x', RUST);
  container(world, 53, 101, 6, 'x', TEAL_SIDING, 1);
  tank(world, 78, 99, 2.6, 7);
  barrier(world, 47, 80, 51, 80);
  barrier(world, 71, 88, 71, 92);
  barrier(world, 64, 104, 70, 104);
  for (const p of ASHFALL_PERCHES) if (p.deck[0] < MX / 2) perch(world, p);
}

// ----------------------------------------------------------------- medians --

/**
 * A derailed slag-pot car [x0..x1, z0..z1] on a median line (paired): a flatcar
 * and a 5 m pot whose crust still glows (a 7 m sightline breaker between the
 * two carriageways of a boulevard or ring road).
 */
function slagCar(world, x0, z0, x1, z1) {
  const alongX = x1 - x0 >= z1 - z0;
  pair(world, x0, T + 1, z0, x1, T + 1, z1, SOOT_BRICK);
  pair(world, x0, T + 2, z0, x1, T + 2, z1, METAL);
  const [px0, pz0, px1, pz1] = alongX ? [x0 + 1, z0, x1 - 1, z1] : [x0, z0 + 1, x1, z1 - 1];
  pair(world, px0, T + 3, pz0, px1, T + 7, pz1, RUST);
  pair(world, px0, T + 5, pz0, px1, T + 5, pz1, SOOT_BRICK);
  if (alongX) pair(world, px0 + 1, T + 7, pz0, px1 - 1, T + 7, pz1, MC_LAVA);
  else pair(world, px0, T + 7, pz0 + 1, px1, T + 7, pz1 - 1, MC_LAVA);
}

function medians(world) {
  for (const [x0, z0, x1, z1] of ASHFALL_SLAG_CARS) slagCar(world, x0, z0, x1, z1);
  ASHFALL_MEDIAN_WRECKS.forEach(([x0, z0, x1, z1], i) => wreck(world, x0, z0, x1 - x0 > z1 - z0 ? 'x' : 'z', [TRUCK_RED, CORRUGATED_STEEL, YELLOW_SIDING, TEAL_SIDING][i]));
  // The first half of ASHFALL_LANE_COVER is the authored north boulevard and west ring road.
  ASHFALL_LANE_COVER.slice(0, ASHFALL_LANE_COVER.length / 2).forEach((rect, i) => laneCover(world, rect, i));
}

/**
 * One lane cover piece (ASHFALL_LANE_COVER, paired): a whole carriageway wide, 5 m
 * long and at least 7 m tall (a titan's eye is 5.6-6.1 m over its feet). Three kinds
 * in turn: a stack of dropped cargo boxes (two high, a third on one side and a crate
 * row on the other), a banded concrete revetment and a pile of cast ingots.
 */
function laneCover(world, [x0, z0, x1, z1], i) {
  // A boulevard piece spans the carriageway's six cells in z, a ring-road piece in x.
  const alongX = z1 - z0 === 5, len = alongX ? x1 - x0 + 1 : z1 - z0 + 1;
  const kind = i % 3;
  if (kind === 0) {
    // Two side by side on the street, two on top (crosswise colours).
    const colors = [[RUST, TEAL_SIDING], [CORRUGATED_STEEL, TRUCK_RED]][(i >> 1) % 2];
    for (const [level, side] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const color = colors[(level + side) % 2];
      if (alongX) container(world, x0, z0 + side * 3, len, 'x', color, level);
      else container(world, x0 + side * 3, z0, len, 'z', color, level);
    }
    const top = (i >> 1) % 2;
    if (alongX) { container(world, x0, z0 + top * 3, len, 'x', colors[0], 2); pair(world, x0, T + 7, z0 + (1 - top) * 3, x1, T + 7, z0 + (1 - top) * 3 + 2, WOOD); }
    else { container(world, x0 + top * 3, z0, len, 'z', colors[0], 2); pair(world, x0 + (1 - top) * 3, T + 7, z0, x0 + (1 - top) * 3 + 2, T + 7, z1, WOOD); }
  } else if (kind === 1) {
    pair(world, x0, T + 1, z0, x1, T + 7, z1, CONCRETE);
    pair(world, x0, T + 1, z0, x1, T + 1, z1, SOOT_BRICK);
    pair(world, x0, T + 4, z0, x1, T + 4, z1, BUS_YELLOW);
    pair(world, x0, T + 7, z0, x1, T + 7, z1, PALE);
    // Lifting lugs on the top and a scorch down one end.
    for (const [x, z] of [[x0 + 1, z0 + 1], [x1 - 1, z1 - 1]]) pair(world, x, T + 8, z, x, T + 8, z, RUST);
    if (alongX) pair(world, x0, T + 2, z0, x0, T + 6, z1, SOOT_BRICK);
    else pair(world, x0, T + 2, z0, x1, T + 6, z0, SOOT_BRICK);
  } else {
    pair(world, x0, T + 1, z0, x1, T + 7, z1, RUST);
    for (let y = T + 2; y <= T + 6; y += 2) pair(world, x0, y, z0, x1, y, z1, PALE);
    // A slumped top course: one ingot gone on alternate corners.
    pair(world, x0, T + 7, z0, x0, T + 7, z0, AIR);
    pair(world, x1, T + 7, z1, x1, T + 7, z1, AIR);
  }
}

/**
 * Billboards (paired): the cross-street gantry (ASHFALL_BILLBOARDS), a beam across the
 * west cross street at T + 17 on the Hab annex and Smelter Hall parapets with three
 * boards hanging from it, and the roof boards over the yard galleries.
 */
function billboardGantry(world) {
  const { xs, z0, z1, y0, y1 } = ASHFALL_BILLBOARDS;
  pair(world, 68, T + 17, 51, 83, T + 17, 52, METAL);
  pair(world, 68, T + 18, 51, 83, T + 18, 51, RUST);
  // Roof boards on the yard edge of the Hab tower and the steel walk-up, over the gallery doors:
  // a 5 m screen no one walks past off the roof onto the gallery roof (it would look into the yard).
  for (const x of [45, 178]) {
    pair(world, x, T + 21, 52, x, T + 25, 60, BUS_YELLOW);
    pair(world, x, T + 21, 52, x, T + 21, 60, METAL);
    pair(world, x, T + 25, 52, x, T + 25, 60, METAL);
    for (let z = 53; z <= 59; z++) if (hash(x, z, 59) % 3) pair(world, x, T + 23, z, x, T + 23, z, SOOT_BRICK);
  }
  xs.forEach((x, i) => {
    const face = [TRUCK_RED, BUS_YELLOW, TEAL_SIDING][i];
    pair(world, x, T + y0, z0, x, T + y1, z1, face);
    // Frame and two lines of "lettering".
    pair(world, x, T + y0, z0, x, T + y0, z1, METAL);
    pair(world, x, T + y1, z0, x, T + y1, z1, METAL);
    for (let z = z0 + 1; z < z1; z++) {
      if (hash(x, z, 47) % 3) pair(world, x, T + 14, z, x, T + 14, z, PALE);
      if (hash(x, z, 53) % 2) pair(world, x, T + 12, z, x, T + 12, z, PALE);
    }
  });
}

// ------------------------------------------------------------------- crane --

/**
 * The toppled ladle crane (ASHFALL_CRANE): its lattice tower stands in the
 * outskirts, its jib fell across the boulevard and rests on the relay deck (the
 * high line), sloping from T + top0 to T + top1, at least 11 m over the lane.
 */
function crane(world) {
  const { x0, x1, z0, z1, top0, top1, tower: [tx, tz] } = ASHFALL_CRANE;
  const topAt = z => T + Math.round(top0 - (z - z0) * (top0 - top1) / (z1 - z0));
  // Tower: four legs with braces, the cab on top, the stub of the counter-jib.
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) pair(world, tx + dx, T + 1, tz + dz, tx + dx, T + top0 - 1, tz + dz, TRUCK_RED);
  for (let y = T + 3; y < T + top0; y += 3) {
    ring(world, tx - 2, tz - 2, tx + 2, tz + 2, y, y, RUST);
    pair(world, tx - 2, y - 1, tz - 2 + (y % 2), tx - 2, y - 1, tz - 2 + (y % 2), METAL);
  }
  pair(world, tx - 2, T + top0, tz - 2, tx + 2, T + top0, tz + 2, METAL);
  pair(world, tx - 1, T + top0 + 1, tz - 1, tx + 1, T + top0 + 3, tz + 1, TRUCK_RED);
  pair(world, tx - 1, T + top0 + 2, tz + 1, tx + 1, T + top0 + 2, tz + 1, GLASS);
  pair(world, tx - 1, T + top0, tz - 4, tx + 1, T + top0, tz - 3, TRUCK_RED);
  pair(world, tx + 3, T + 1, tz - 3, tx + 5, T + 3, tz - 2, CONCRETE);              // fallen counterweight
  // Jib: a 3 m walkway on a lattice of side chords, 3 m deep.
  for (let z = z0; z <= z1; z++) {
    const y = topAt(z);
    pair(world, x0, y, z, x1, y, z, METAL);
    pair(world, x0, y - 3, z, x0, y - 3, z, TRUCK_RED);
    pair(world, x1, y - 3, z, x1, y - 3, z, TRUCK_RED);
    pair(world, x0, y - 1 - (z % 2), z, x0, y - 1 - (z % 2), z, TRUCK_RED);
    pair(world, x1, y - 2 + (z % 2), z, x1, y - 2 + (z % 2), z, TRUCK_RED);
    if (z % 4 === 0) { pair(world, x0, y - 3, z, x1, y - 3, z, RUST); pair(world, x0, y + 1, z, x0, y + 1, z, TRUCK_RED); }
  }
  // The hook block hangs off the jib over the outskirts kerb, clear of the lane.
  pair(world, x0 + 1, T + 6, 18, x0 + 1, topAt(18) - 4, 18, METAL);
  pair(world, x0, T + 4, 18, x1, T + 5, 19, RUST);
}

// ---------------------------------------------------------- pilot breaches --

/**
 * Blown-out wall breaches (3 x 3) and ledges that make run-and-jump lines
 * through the blocks: Hab tower to annex across the alley on floor 2, the
 * tenements' north block onto the low block's roof across the E-W alley, the
 * Smelter Hall mezzanine out to the arena perch, and a floor-2 balcony along
 * the Hab tower's south face over the approach yard.
 */
function breaches(world) {
  pair(world, 55, T + 9, 44, 55, T + 11, 46, AIR);
  pair(world, 60, T + 9, 44, 60, T + 11, 46, AIR);
  pair(world, 159, T + 9, 51, 161, T + 11, 51, AIR);
  pair(world, 158, T + 9, 56, 162, T + 9, 56, AIR);
  pair(world, 84, T + 13, 55, 86, T + 15, 55, AIR);
  // Scorched lips round the breaches.
  for (const [x, z] of [[55, 43], [55, 47], [60, 43], [60, 47]]) pair(world, x, T + 9, z, x, T + 11, z, SOOT_BRICK);
  // Hab tower balcony: door on floor 2 of the south face, a 1 m ledge with stanchions.
  pair(world, 51, T + 9, 67, 52, T + 11, 67, AIR);
  pair(world, 46, T + 8, 68, 54, T + 8, 68, CONCRETE);
  for (let x = 46; x <= 54; x += 4) pair(world, x, T + 9, 68, x, T + 9, 68, RUST);
}

// ------------------------------------------------------------------- ruins --

/** A rubble mound of radius `r` and peak `h` (paired); the cells stay ground-hugging. */
function rubble(world, cx, cz, r, h) {
  for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      const d = Math.hypot(dx, dz);
      if (d > r) continue;
      const top = Math.round(h * (1 - d / (r + 0.6))) + (hash(cx + dx, cz + dz, 13) % 2);
      for (let y = T + 1; y <= T + top; y++) {
        const k = hash(cx + dx, cz + dz, y);
        pair(world, cx + dx, y, cz + dz, cx + dx, y, cz + dz, k % 5 === 0 ? RUST : k % 3 === 0 ? SOOT_BRICK : k % 2 ? CONCRETE : GRAVEL);
      }
    }
  }
}

/**
 * A storey-deep bite out of a roof corner (paired): the wedge steps down away
 * from the corner (cx, cz) toward (cx + sx * w, cz + sz * w), exposing the
 * floors inside. `top` is the highest voxel of the building (its parapet).
 */
function collapseCorner(world, cx, cz, dirX, dirZ, w, depth, top) {
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < w; j++) {
      const bite = depth - Math.max(i, j) - (hash(cx + i, cz + j, 17) % 2);
      if (bite <= 0) continue;
      const x = cx + dirX * i, z = cz + dirZ * j;
      pair(world, x, top - bite + 1, z, x, top + 4, z, AIR);
    }
  }
}

/** A burnt-out colony runabout: 4 x 2 body, cab glass, 2 high (paired). */
function wreck(world, x, z, axis, color) {
  const [x1, z1] = axis === 'x' ? [x + 3, z + 1] : [x + 1, z + 3];
  pair(world, x, T + 1, z, x1, T + 1, z1, color);
  if (axis === 'x') { pair(world, x + 1, T + 2, z, x + 2, T + 2, z1, SOOT_BRICK); pair(world, x + 3, T + 2, z, x + 3, T + 2, z1, GLASS); }
  else { pair(world, x, T + 2, z + 1, x1, T + 2, z + 2, SOOT_BRICK); pair(world, x, T + 2, z + 3, x1, T + 2, z + 3, GLASS); }
}

/** A rooftop water tank on four legs (paired). */
function roofTank(world, x, z, roofTop) {
  for (const [dx, dz] of [[0, 0], [3, 0], [0, 3], [3, 3]]) pair(world, x + dx, roofTop + 1, z + dz, x + dx, roofTop + 2, z + dz, METAL);
  pair(world, x, roofTop + 3, z, x + 3, roofTop + 4, z + 3, RUST);
  pair(world, x + 1, roofTop + 4, z + 1, x + 2, roofTop + 4, z + 2, PALE);
}

function ruins(world) {
  // Shelled corners: the Hab Stack's north-west crown, the tenements' boulevard corner and
  // the steel walk-up over the ring road, each with its spill on the pavement below.
  collapseCorner(world, 45, 36, 1, 1, 6, 8, T + 21);
  rubble(world, 48, 36, 2, 2);
  collapseCorner(world, 166, 36, -1, 1, 5, 6, T + 17);
  rubble(world, 167, 35, 1.8, 2);
  collapseCorner(world, 178, 67, -1, -1, 5, 9, T + 21);
  rubble(world, 177, 70, 2, 3);
  // Rubble in the Hab alley mouth.
  rubble(world, 57, 35, 1.4, 1);
  // Scorch and crack decals on the streets (paint only).
  for (const [x, z, r] of [[66, 28, 3], [101, 24, 2.5], [140, 29, 3], [36, 78, 2.5], [37, 128, 3], [76, 52, 2.5], [111, 44, 2]]) {
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      if (Math.hypot(dx, dz) <= r && hash(x + dx, z + dz, 23) % 3) pset(world, x + dx, T, z + dz, hash(x + dx, z + dz, 29) % 2 ? SCORCHED_EARTH : GRAVEL);
    }
  }
  // Roof silhouettes: water tanks and a mast.
  roofTank(world, 47, 58, T + 20);
  roofTank(world, 173, 40, T + 20);
  pair(world, 158, T + 17, 40, 158, T + 24, 40, METAL);
  pair(world, 158, T + 25, 40, 158, T + 25, 40, ACCENT);
}

// ---------------------------------------------------------------- dressing --

const inLane = (x, z) => ASHFALL_TITAN_LANES.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
const SIGN_BOARDS = [TRUCK_RED, BUS_YELLOW, TEAL_SIDING, YELLOW_SIDING];

/**
 * Facade and interior dressing of every colony block (paired, hash-varied; it
 * runs after every bridge, breach and ruin has cut its openings). Outside, on
 * the window facades: a sign board in the wall row over the street storey, and
 * under some floor-1 and floor-2 windows a balcony (a 2 m ledge with a rail) or
 * an AC unit, only where the air outside is open and two cells clear of a titan
 * lane. Inside, from floor 1 up: crates, lockers and machinery against the walls,
 * never in a stair run, in front of an opening at foot height or beside one.
 */
function dressBlocks(world) {
  const at = (x, y, z) => world.getBlock(x, y, z);
  const open = (x, y, z) => at(x, y, z) === AIR;
  const wall = (x, y, z) => { const b = at(x, y, z); return b !== AIR && b !== GLASS; };
  for (const { x0, z0, x1, z1, o } of BLOCKS) {
    const sides = (o.windows ?? '').split('');
    // Facade line, the outward step and the window columns of a side.
    const facade = side => {
      const alongX = side === 'n' || side === 's';
      const line = { n: z0, s: z1, w: x0, e: x1 }[side], out = side === 'n' || side === 'w' ? -1 : 1;
      const from = (alongX ? x0 : z0) + 2, to = (alongX ? x1 : z1) - 2;
      const cell = (t, k = 0) => (alongX ? [t, line + out * k] : [line + out * k, t]);
      return { alongX, from, to, cell };
    };
    if (sides.length && o.floors >= 2) {
      const side = sides[hash(x0, z0, 61) % sides.length], { from, to, cell } = facade(side);
      const mid = (from + to) >> 1, board = SIGN_BOARDS[hash(x1, z1, 67) % SIGN_BOARDS.length];
      for (let t = mid - 3; t <= mid + 3; t++) {
        const [x, z] = cell(t);
        if (at(x, T + 5, z) === o.wall) pair(world, x, T + 5, z, x, T + 5, z, Math.abs(t - mid) === 3 ? METAL : (t - mid) % 2 ? PALE : board);
      }
    }
    for (const side of sides) {
      const { from, to, cell } = facade(side);
      for (let f = 1; f <= Math.min(2, o.floors - 1); f++) {
        const base = T + STOREY * f;
        for (let t = from; t + 1 <= to; t += 4) {
          const roll = hash(t, f, x0 * 3 + z0 + side.charCodeAt(0)) % 10;
          if (roll < 2) {
            // Balcony: a ledge two cells out at the slab line under the window pair, a rail on its edge.
            const cells = [0, 1].flatMap(dt => [1, 2, 3].map(k => cell(t + dt, k)));
            const clear = cells.every(([x, z]) => !inLane(x, z) && [0, 1, 2, 3].every(dy => open(x, base + dy, z)))
              && [0, 1].every(dt => !inLane(...cell(t + dt, 4)));
            if (!clear) continue;
            for (const dt of [0, 1]) {
              for (const k of [1, 2]) { const [x, z] = cell(t + dt, k); pair(world, x, base, z, x, base, z, CONCRETE); }
              const [rx, rz] = cell(t + dt, 2);
              pair(world, rx, base + 1, rz, rx, base + 1, rz, RUST);
            }
          } else if (roll < 4) {
            const [x, z] = cell(t + (roll & 1), 1);
            if (!inLane(x, z) && !inLane(...cell(t, 2)) && open(x, base + 1, z) && open(x, base, z) && open(x, base + 2, z)) {
              pair(world, x, base + 1, z, x, base + 1, z, METAL);
            }
          }
        }
      }
    }
    // Furniture against the inner walls of floors 1 and up.
    const stairRun = (x, z) => x <= x0 + 7 && (z <= z0 + 3 || z >= z1 - 3);
    for (let f = 1; f < o.floors; f++) {
      const base = T + STOREY * f;
      const spots = [];
      for (let x = x0 + 1; x <= x1 - 1; x++) { spots.push([x, z0 + 1, 0, -1]); spots.push([x, z1 - 1, 0, 1]); }
      for (let z = z0 + 2; z <= z1 - 2; z++) { spots.push([x0 + 1, z, -1, 0]); spots.push([x1 - 1, z, 1, 0]); }
      for (const [x, z, nx, nz] of spots) {
        if (stairRun(x, z) || hash(x, z, 71 + f) % 100 >= 28) continue;
        const [wx, wz] = [x + nx, z + nz], [ix, iz] = [x - nx, z - nz];
        const [sx, sz] = [Math.abs(nz), Math.abs(nx)];   // along the wall
        if (open(x, base, z) || ![1, 2, 3].every(dy => open(x, base + dy, z)) || ![1, 2].every(dy => open(ix, base + dy, iz))) continue;
        if (![-1, 0, 1].every(d => wall(wx + d * sx, base + 1, wz + d * sz))) continue;
        let kind = hash(x, z, 79 + f) % 4;
        if (kind > 0 && !wall(wx, base + 2, wz)) kind = 0;
        const [lo, hi] = [[WOOD, WOOD], [WOOD, PLANK], [METAL, METAL], [RUST, METAL]][kind];
        pair(world, x, base + 1, z, x, base + 1, z, lo);
        if (kind > 0) pair(world, x, base + 2, z, x, base + 2, z, hi);
      }
    }
  }
}

/**
 * Hull-down ingot stacks in the arena's outer band (ASHFALL_ARENA_COVER, paired):
 * 5 x 3, 5 m tall (a titan's chest), long side along the band.
 */
function arenaCover(world) {
  const { x: cx, z: cz } = ASHFALL_CENTER;
  for (const [deg, radius] of ASHFALL_ARENA_COVER) {
    const a = deg * Math.PI / 180, px = Math.floor(cx + radius * Math.cos(a)), pz = Math.floor(cz + radius * Math.sin(a));
    const alongX = Math.abs(Math.sin(a)) > Math.abs(Math.cos(a));
    const [hx, hz] = alongX ? [2, 1] : [1, 2];
    pair(world, px - hx, T + 1, pz - hz, px + hx, T + 5, pz + hz, RUST);
    for (let y = T + 2; y <= T + 4; y += 2) pair(world, px - hx, y, pz - hz, px + hx, y, pz + hz, PALE);
    pair(world, px - hx, T + 5, pz - hz, px + hx, T + 5, pz + hz, SOOT_BRICK);
    pair(world, px + hx, T + 5, pz + hz, px + hx, T + 5, pz + hz, AIR);
  }
}

// ------------------------------------------------------------------- shell --

/**
 * The sealed perimeter shell as a canyon rim: banded rock with a jagged crest
 * (the inner rings step down to 26-32, the outer ring stays at 32 or more, so
 * the map stays closed) and rock outcrops along the outskirts walls. The crest
 * is keyed on the distance along the wall from the matching corner, so the
 * rotated twin wall gets the same profile.
 */
function canyonRim(world) {
  const { sx, sy, sz } = world.dimensions;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const edge = Math.min(x, z, sx - 1 - x, sz - 1 - z);
      if (edge >= 3) continue;
      const northSouth = z < 3 || z > sz - 4;
      const along = northSouth ? (z < 3 ? x : MX - x) : (x < 3 ? z : MZ - z);
      const seg = Math.floor(along / 3), salt = northSouth ? 31 : 37;
      const drop = [0, 1, 3, 5][hash(Math.floor(along / 7), 0, salt) % 4] + [0, 0, 1, 2][hash(Math.floor(along / 2), 4, salt) % 4];
      const top = edge === 0 ? sy - 1 - Math.min(7, drop) : sy - 8 - drop;
      const wobble = hash(seg, 1, salt) % 3;
      for (let y = T; y < sy; y++) {
        if (y > top) { world.setBlock(x, y, z, AIR); continue; }
        const band = (y + wobble - T) % 9;
        world.setBlock(x, y, z, y <= T + 2 ? SOOT_BRICK : y > top - 1 ? SCORCHED_EARTH
          : band < 4 ? DUST_ROCK : band < 6 ? DUST_SANDSTONE : band < 7 ? SCORCHED_EARTH : DUST_ROCK);
      }
    }
  }
  // Outcrops at the foot of the north wall (and the south one): slumped rock spurs.
  for (let x = 44; x <= 179; x++) {
    const seg = Math.floor(x / 4), h = hash(seg, 2, 41) % 5;
    if (h < 2) continue;
    const depth = h === 4 ? 2 : 1, height = 3 + (hash(seg, 3, 41) % 9);
    for (let dz = 0; dz < depth; dz++) {
      for (let y = T + 1; y <= T + height - dz * 3; y++) pset(world, x, y, 3 + dz, y > T + height - dz * 3 - 1 ? GRAVEL : DUST_ROCK);
    }
  }
}

export function generateAshfallInto(world, blocks, heights) {
  BLOCKS.length = 0;
  generateFlatBase(world, blocks, heights);
  canyonRim(world);
  groundPlan(world);
  outskirts(world);
  teamYard(world, WEST);
  teamYard(world, EAST);
  habStack(world);
  smelterHall(world);
  relayBlock(world);
  tenements(world);
  skybridges(world);
  yardTowers(world);
  approachYard(world);
  medians(world);
  crane(world);
  breaches(world);
  ruins(world);
  billboardGantry(world);
  dressBlocks(world);
  arena(world);
  pourLine(world);
  addMapLightFixtures(world, 'ashfall');
}
