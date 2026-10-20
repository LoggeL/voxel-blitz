// Redrock Canyon terrain: a pure, deterministic heightfield for the
// 768 x 80 x 768 desert (docs/maps/redrock.md). It follows the Frontier
// pipeline (shared/world/frontier-terrain.js: relief, pads and plateaus,
// water, graded roads, the drivability clamp, cliffs, surfaces; the noise,
// chamfer relax and graded-road solve are Frontier's own) and returns
// the same arrays and cell kinds, so the site kit, the generator helpers, the
// map metadata, bot navigation and the far-terrain renderer read it the same
// way. Everything is derived from REDROCK_PLAN (shared/world/redrock-plan.js)
// plus the authored ground plan below, with one constant seed.
//
// Height convention (as Frontier): `heights[i]` is the y of the top solid
// terrain voxel of the column (river bed, ground, road, pad, bridge deck or
// dam crest). A player stands at `heights + 1`; redrockSurfaceY(x, z)
// returns that standing height. Set pieces (the dam body, buildings, the
// trestle, cacti) are added later by shared/world/redrock-sites/.
//
// The relief is mirror-symmetric about x = 384 (WEST <-> EAST). Only the
// river's meander is not, and it stays more than 100 m from every flag.

import { REDROCK_PLAN } from './redrock-plan.js';
import { valueNoise, fbm, polylineAt, polylineLength, relax, gradedRoadLevels, FRONTIER_CELL_KIND } from './frontier-terrain.js';
import {
  ASPHALT, CONCRETE, DIRT, DUST_ROCK, DUST_SANDSTONE, MC_WATER, MC_CLAY, SAND, MEADOW, DRY_GRASS, MUD,
  SCORCHED_EARTH, GRAVEL, DUST_FLOOR,
} from './blocks.js';

const { sx: SX, sz: SZ } = REDROCK_PLAN.dimensions;
const H = REDROCK_PLAN.heights;
const AREA = REDROCK_PLAN.combatArea;
/** Noise salts are offset so Redrock never repeats Frontier's relief. */
const SALT = 5000;
export const REDROCK_TERRAIN_SEED = 0x52445243;

/** Mirror about x = 384 (continuous) and its cell form. */
export const mirrorX = ([x, z]) => [SX - x, z];
export const mirrorCellX = (x, z) => [SX - 1 - x, z];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const noise = (x, z, salt) => valueNoise(x, z, salt + SALT);
const fractal = (x, z, octaves, salt) => fbm(x, z, octaves, salt + SALT);

function ridged(x, z, octaves, salt) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise(x * f + o * 5.1, z * f + o * 3.7, salt + o * 31));
    sum += n * n * amp; norm += amp; amp *= 0.5; f *= 2.1;
  }
  return sum / norm;
}

// ------------------------------------------------------------- the water

const RIVER = REDROCK_PLAN.river;
const RESERVOIR = RIVER.reservoir;
/** Water surfaces: the reservoir and the river above it (y26), the canyon stream below the dam (y19). */
export const NORTH_SURFACE = RESERVOIR.surfaceY;
export const SOUTH_SURFACE = RIVER.surfaceY;
/** The dam crest footprint (cells [x0, x1) x [z0, z1)); its body is built by the dam site. */
export const REDROCK_DAM = Object.freeze({ x0: 344, x1: 424, z0: 378, z1: 390, crestY: H.damCrest });
/** Canyon floor: one voxel over the stream (a floor flush with the water trapped swimmers on Frontier). */
export const CANYON_FLOOR = SOUTH_SURFACE + 1;
/** Water surface y of the river at continuous z. */
export const redrockSurfaceAt = z => (z < REDROCK_DAM.z1 ? NORTH_SURFACE : SOUTH_SURFACE);

/** 0 at a crossing, 1 on an open reach. */
export function riverReach(z) {
  let w = 1;
  for (const c of REDROCK_PLAN.crossings) w = Math.min(w, smoothstep(14, 40, Math.abs(z - c.z)));
  return w;
}

/** The reservoir's half width along z: narrow at its head, widest mid-lake, tapering to the dam. */
function lakeHalf(z) {
  const grow = smoothstep(RESERVOIR.z0 - 6, RESERVOIR.z0 + 70, z), taper = smoothstep(318, REDROCK_DAM.z0, z);
  return 8.5 + 40 * grow - 10 * taper + 2.4 * Math.sin(z / 17) * grow * (1 - taper);
}
function riverHalfExact(z) {
  if (z >= RESERVOIR.z0 && z < REDROCK_DAM.z0) return Math.max(6 + 2.5 * riverReach(z), lakeHalf(z));
  if (z >= REDROCK_DAM.z0 && z < REDROCK_DAM.z1) return 0;
  return 6 + 2.5 * riverReach(z);
}
const HALF_ROWS = Float64Array.from({ length: SZ + 1 }, (_, zi) => riverHalfExact(zi + 0.5));
/** Half width of the open water at continuous z (6 at every crossing, 0 under the dam). */
export function riverHalfAt(z) {
  const t = clamp(z - 0.5, 0, SZ), zi = Math.min(SZ - 1, Math.floor(t));
  return lerp(HALF_ROWS[zi], HALF_ROWS[zi + 1], t - zi);
}
/** Meander of each reach: [z0, z1, amplitude] (+ east). The reservoir and the dam stay straight. */
const MEANDER = [[0, 100, 6], [100, 178, -5], [178, 214, 3], [REDROCK_DAM.z1, 500, 10], [500, 640, -12], [640, SZ, 9]];
export function riverMeander(z) {
  for (const [a, b, amp] of MEANDER) if (z >= a && z <= b) return amp * Math.sin(Math.PI * (z - a) / (b - a)) ** 2;
  return 0;
}
const RIVER_X = new Float64Array(SZ + 1), RIVER_SLOPE = new Float64Array(SZ + 1);
for (let zi = 0; zi <= SZ; zi++) RIVER_X[zi] = RIVER.points[0][0] + riverMeander(Math.min(zi + 0.5, SZ));
for (let zi = 0; zi <= SZ; zi++) RIVER_SLOPE[zi] = (RIVER_X[Math.min(SZ, zi + 1)] - RIVER_X[Math.max(0, zi - 1)]) / (Math.min(SZ, zi + 1) - Math.max(0, zi - 1));
/** River centre x at continuous z. */
export function riverCentreX(z) {
  const zi = clamp(Math.floor(z - 0.5), 0, SZ - 1), t = clamp(z - 0.5 - zi, 0, 1);
  return lerp(RIVER_X[zi], RIVER_X[zi + 1], t);
}
/** Signed horizontal distance from the river centreline (positive east). */
export function riverOffset(x, z) {
  const zi = clamp(Math.floor(z), 0, SZ - 1);
  return (x - riverCentreX(z)) / Math.sqrt(1 + RIVER_SLOPE[zi] ** 2);
}

/**
 * The canyon below the dam: a dry floor 5.5-7 m either side of the stream,
 * then walls that rise `wallSlope` voxels per metre up to the plain. Walls
 * steeper than one voxel per metre are cliffs (stepped strata); the side
 * gullies are walkable 1:1 slopes out of the canyon, and around the wash ford
 * the walls open into a broad wash a vehicle can drive down.
 */
export const CANYON_GULLIES = Object.freeze([452, 590]);
export function canyonFloorHalf(z, side) {
  return riverHalfAt(z) + 8 + 1.6 * noise(z / 21, side > 0 ? 3 : 7, 411);
}
/**
 * Height of a canyon wall `e` metres beyond the floor edge: a lower cliff of
 * six voxels, a 4-7 m bench, then the upper cliff to the rim (one slope for
 * the gullies and the wash).
 */
export function canyonWallRise(e, k, z, side) {
  if (e <= 0) return 0;
  if (k <= 1.05) return k * e;
  const lower = 6, e1 = lower / k, bench = 5.5 + 1.5 * noise(z / 17, side > 0 ? 11 : 13, 413);
  if (e <= e1) return k * e;
  if (e <= e1 + bench) return lower;
  return lower + k * (e - e1 - bench);
}
export function wallSlope(z) {
  const wash = smoothstep(48, 18, Math.abs(z - 640));
  let k = lerp(2.4, 0.3, wash);
  for (const g of CANYON_GULLIES) k = Math.min(k, lerp(2.4, 1, smoothstep(9, 4, Math.abs(z - g))));
  return k;
}

// --------------------------------------------------------- authored plan

const rect = (minX, minZ, maxX, maxZ) => ({ minX, minZ, maxX, maxZ });
const mirrorRectX = r => rect(SX - r.maxX, r.minZ, SX - r.minX, r.maxZ);
const mirrorPolyX = points => points.map(mirrorX).reverse();

/** HQ plateaus at y36: Frontier's footprint, so the shared HQ airfield builder fits. */
const ALPHA_PLATEAU = { ...rect(26, 200, 146, 568), radius: 22 };
export const REDROCK_PLATEAUS = Object.freeze([
  Object.freeze({ team: 'alpha', y: H.hqPlateau, ...ALPHA_PLATEAU }),
  Object.freeze({ team: 'bravo', y: H.hqPlateau, ...mirrorRectX(ALPHA_PLATEAU), radius: ALPHA_PLATEAU.radius }),
]);
const ALPHA_RUNWAY = { team: 'alpha', x: 44, z0: 228, z1: 540, width: 26 };
export const REDROCK_RUNWAYS = Object.freeze([
  Object.freeze(ALPHA_RUNWAY),
  Object.freeze({ ...ALPHA_RUNWAY, team: 'bravo', x: SX - ALPHA_RUNWAY.x }),
]);

/** Flag pads: radius + 12 (the dam's abutments + 24), flat at the site's height, 20 m smoothstep falloff. */
const PAD_HEIGHTS = { oasis: 29, mine: 32, dam: H.damCrest, radar: 33, railhead: 31 };
export const REDROCK_PADS = Object.freeze(REDROCK_PLAN.flags.map(f => Object.freeze({
  flag: f.id, site: f.site, x: f.x, z: f.z, radius: f.radius + (f.site === 'dam' ? 16 : 12), y: PAD_HEIGHTS[f.site], falloff: 20,
})));

/**
 * Road network. Alpha-side roads are authored, bravo roads are their mirrors
 * about x = 384; the roads that cross the river are their own mirrors.
 * Junctions share exact vertices so the bot road graph links them.
 */
const ALPHA_ROADS = [
  { id: 'hq-west-a', kind: 'gravel', width: 7, points: [[150, 384], [176, 322], [206, 272], [236, 236]] },
  { id: 'hq-west-b', kind: 'gravel', width: 7, points: [[150, 384], [182, 446], [214, 498], [250, 540]] },
  { id: 'a-c', kind: 'gravel', width: 7, points: [[236, 236], [270, 290], [304, 340], [330, 384]] },
  { id: 'b-c', kind: 'gravel', width: 7, points: [[250, 540], [282, 486], [310, 432], [330, 384]] },
];
const MIRROR_IDS = { 'hq-west-a': 'hq-east-d', 'hq-west-b': 'hq-east-e', 'a-c': 'd-c', 'b-c': 'e-c' };
const selfMirrored = half => [...half, ...mirrorPolyX(half).slice(1)];
export const REDROCK_ROAD_PLAN = Object.freeze([
  Object.freeze({ id: 'axis', kind: 'paved', width: 10, points: Object.freeze(selfMirrored([[72, 384], [150, 384], [250, 384], [330, 384], [384, 384]])) }),
  ...ALPHA_ROADS.flatMap(r => [
    Object.freeze({ ...r, points: Object.freeze(r.points) }),
    Object.freeze({ ...r, id: MIRROR_IDS[r.id], points: Object.freeze(mirrorPolyX(r.points)) }),
  ]),
  // Over the river bridge north of the reservoir, round both HQs.
  Object.freeze({ id: 'north-loop', kind: 'gravel', width: 7,
    points: Object.freeze(selfMirrored([[150, 384], [150, 300], [162, 214], [214, 150], [296, 112], [384, 100]])) }),
  // A to D over the ford at the reservoir's head.
  Object.freeze({ id: 'a-d-ford', kind: 'gravel', width: 7, points: Object.freeze(selfMirrored([[236, 236], [292, 196], [384, 178]])) }),
  // B to E over the canyon trestle.
  Object.freeze({ id: 'b-e-trestle', kind: 'gravel', width: 7, points: Object.freeze(selfMirrored([[250, 540], [306, 512], [384, 500]])) }),
  // Round the south through the wash ford.
  Object.freeze({ id: 'south-loop', kind: 'gravel', width: 7,
    points: Object.freeze(selfMirrored([[150, 384], [150, 486], [168, 580], [222, 640], [300, 662], [384, 640]])) }),
]);

/** Bridge decks (top voxel y) and their half span along the road. */
const DECKS = { 'bridge-north': { y: 30, halfSpan: 12 }, 'redrock-dam': { y: H.damCrest, halfSpan: 40 }, trestle: { y: 32, halfSpan: 26 } };
const FORD_BED = { 'ford-north': NORTH_SURFACE - 1, 'wash-ford': SOUTH_SURFACE - 1 };
export const REDROCK_CROSSINGS = Object.freeze(REDROCK_PLAN.crossings.map(c => Object.freeze({
  ...c, deckY: c.kind === 'bridge' ? DECKS[c.id].y : null, bedY: c.kind === 'ford' ? FORD_BED[c.id] : null,
  surfaceY: redrockSurfaceAt(c.z),
  halfSpan: c.kind === 'bridge' ? DECKS[c.id].halfSpan : 8,
})));

/**
 * Mesas and buttes: flat-topped sandstone masses with cliff sides, the only
 * interior cliffs besides the canyon walls. Authored west and mirrored east.
 * `top` is the cap rock's top voxel y.
 */
const MESAS_WEST = [
  { id: 'anvil-mesa', name: 'Anvil Mesa', x: 128, z: 112, rx: 36, rz: 24, angle: 0.3, top: 50 },
  { id: 'saddle-butte', name: 'Saddle Butte', x: 300, z: 262, rx: 11, rz: 9, angle: 0.5, top: 44 },
  { id: 'broken-mesa', name: 'Broken Mesa', x: 196, z: 694, rx: 32, rz: 20, angle: -0.25, top: 46 },
  { id: 'needle', name: 'The Needle', x: 296, z: 600, rx: 5, rz: 5, angle: 0, top: 47 },
  { id: 'cairn-butte', name: 'Cairn Butte', x: 196, z: 470, rx: 8, rz: 6, angle: 0.8, top: 40 },
];
export const REDROCK_MESAS = Object.freeze([...MESAS_WEST, ...MESAS_WEST.map(m => ({ ...m, id: `${m.id}-east`, x: SX - m.x, angle: -m.angle }))]
  .map(m => Object.freeze(m)));

/** Points: within the combat area? */
export const insideCombatArea = (x, z) => x >= AREA.minX && x < AREA.maxX && z >= AREA.minZ && z < AREA.maxZ;

function inRoundedRect(x, z, r) {
  const cx = clamp(x, r.minX + r.radius, r.maxX - r.radius), cz = clamp(z, r.minZ + r.radius, r.maxZ - r.radius);
  return Math.hypot(x - cx, z - cz) - r.radius;
}

/** Normalised elliptical distance of (x, z) to a mesa centre (1 at the rim, noisy edge). */
export function mesaDistance(m, x, z) {
  const dx = x - m.x, dz = z - m.z, c = Math.cos(m.angle), s = Math.sin(m.angle);
  const u = (dx * c + dz * s) / m.rx, v = (-dx * s + dz * c) / m.rz;
  return Math.hypot(u, v) / (1 + 0.14 * noise(x / 9, z / 9, 451));
}

/** Desert scrub density 0..1 (sage, creosote, cacti): thicker by the water and in the washes. */
export function redrockScrubDensity(x, z) {
  if (x >= SX / 2) x = SX - x;
  const dr = Math.abs(x - SX / 2);
  const wet = 1 - smoothstep(30, 120, dr);
  return clamp(0.25 + 0.45 * fractal(x / 46, z / 46, 3, 31) + 0.35 * wet, 0, 1);
}

// ------------------------------------------------------------ base relief

/** Dune fields (west half; mirrored): low wind-ridged sand waves. */
const DUNES = [{ x: 262, z: 660, rx: 70, rz: 46 }, { x: 196, z: 340, rx: 34, rz: 26 }];

function canonicalHeight(x, z) {
  const ax = Math.abs(x - SX / 2);
  let h = 30 + 3 * fractal(x / 210, z / 210, 4, 11) + 1.3 * fractal(x / 52, z / 52, 3, 23);
  // The reservoir basin north of the dam, the high plain south of it.
  const north = 1 - smoothstep(350, 420, z);
  h -= 3.5 * (1 - smoothstep(30, 170, ax)) * north;
  h += 1.2 * smoothstep(380, 470, z);
  for (const d of DUNES) {
    const q = ((x - d.x) / d.rx) ** 2 + ((z - d.z) / d.rz) ** 2;
    if (q < 1) h += (1 - q) * 3.2 * ridged(x / 16, z / 34, 2, 61);
  }
  // The rim rises toward the restricted edge, then into broken red ranges.
  const e = Math.min(x, z, SX - x, SZ - z);
  h += 13 * (1 - smoothstep(AREA.minX, 120, e)) ** 2;
  if (e < AREA.minX) h += (AREA.minX - e) / AREA.minX * (14 + 18 * ridged(x / 66, z / 66, 4, 57));
  return clamp(h, H.plainMin - 3, H.ridgeMax);
}

// ------------------------------------------------------------ the builder

const INF = 1e9;
const SENTINEL = 30000;
const KIND = FRONTIER_CELL_KIND;
export const REDROCK_CELL_KIND = KIND;

/** The bridge-deck rectangle of a crossing: every cell the deck spans (roads run along x). */
function deckRect(c) {
  return rect(Math.floor(c.x - c.halfSpan), Math.floor(c.z - c.width / 2), Math.ceil(c.x + c.halfSpan) - 1, Math.ceil(c.z + c.width / 2) - 1);
}
export const redrockDeckRect = deckRect;

function buildTerrain() {
  const N = SX * SZ;
  const raw = new Float32Array(N);
  // 1. Base relief, mirror-symmetric about x = 384 by construction.
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX / 2; x++) {
    const v = Math.fround(canonicalHeight(x + 0.5, z + 0.5));
    raw[z * SX + x] = v; raw[z * SX + SX - 1 - x] = v;
  }

  const kind = new Uint8Array(N);
  const fixed = new Uint8Array(N);
  const fixedY = new Int16Array(N);
  const water = new Uint8Array(N);
  const roadIndex = new Uint8Array(N);
  const roadDist = new Float32Array(N).fill(INF);
  const ground = new Int16Array(N);

  // 2. Pads and plateaus blend the relief toward their level.
  const blendArea = (minX, minZ, maxX, maxZ, signed, y, falloff, cellKind) => {
    for (let z = Math.max(0, Math.floor(minZ - falloff)); z <= Math.min(SZ - 1, Math.ceil(maxZ + falloff)); z++) {
      for (let x = Math.max(0, Math.floor(minX - falloff)); x <= Math.min(SX - 1, Math.ceil(maxX + falloff)); x++) {
        const i = z * SX + x, d = signed(x + 0.5, z + 0.5);
        if (d <= 0) { kind[i] = cellKind; fixed[i] = 1; fixedY[i] = y; raw[i] = y; }
        else if (d < falloff && !fixed[i]) raw[i] = lerp(y, raw[i], smoothstep(0, falloff, d));
      }
    }
  };
  for (const pad of REDROCK_PADS) {
    blendArea(pad.x - pad.radius, pad.z - pad.radius, pad.x + pad.radius, pad.z + pad.radius,
      (px, pz) => Math.hypot(px - pad.x, pz - pad.z) - pad.radius, pad.y, pad.falloff, KIND.PAD);
  }
  for (const plateau of REDROCK_PLATEAUS) {
    blendArea(plateau.minX, plateau.minZ, plateau.maxX, plateau.maxZ, (px, pz) => inRoundedRect(px, pz, plateau), plateau.y, 20, KIND.PLATEAU);
  }
  // Runway approaches: level with the plateau for 90 m, then a 1:5 climb.
  for (const runway of REDROCK_RUNWAYS) {
    for (let z = 0; z < SZ; z++) {
      const pz = z + 0.5, beyond = pz < runway.z0 ? runway.z0 - pz : pz > runway.z1 ? pz - runway.z1 : 0;
      if (!beyond) continue;
      const cap = H.hqPlateau + Math.max(0, beyond - 90) / 5;
      for (let x = Math.floor(runway.x - 22); x <= Math.ceil(runway.x + 22); x++) {
        const i = z * SX + x;
        if (!fixed[i] && raw[i] > cap) raw[i] = cap;
      }
    }
  }

  // 3. Water. North of the dam: the river and the reservoir at y26 with
  // banks climbing a voxel per metre. Under the dam: the crest deck. South
  // of it: the canyon stream at y19 on a dry floor between cliff walls.
  const fords = REDROCK_CROSSINGS.filter(c => c.kind === 'ford');
  const cliffWall = new Uint8Array(N);
  for (let z = 0; z < SZ; z++) {
    const pz = z + 0.5, half = riverHalfAt(pz);
    const inDam = pz >= REDROCK_DAM.z0 && pz < REDROCK_DAM.z1;
    const south = pz >= REDROCK_DAM.z1, surface = redrockSurfaceAt(pz);
    const slope = south ? wallSlope(pz) : 1;
    for (let x = 0; x < SX; x++) {
      const i = z * SX + x, px = x + 0.5;
      if (inDam) {
        if (x >= REDROCK_DAM.x0 && x < REDROCK_DAM.x1) {
          kind[i] = KIND.BRIDGE; fixed[i] = 1; fixedY[i] = REDROCK_DAM.crestY; ground[i] = CANYON_FLOOR; raw[i] = REDROCK_DAM.crestY;
        }
        continue;
      }
      const offset = riverOffset(px, pz), dr = Math.abs(offset);
      if (dr <= half) {
        const ford = fords.find(f => Math.abs(pz - f.z) <= f.width / 2);
        water[i] = surface;
        if (ford) { kind[i] = KIND.FORD; fixed[i] = 1; fixedY[i] = ford.bedY; raw[i] = ford.bedY; continue; }
        kind[i] = KIND.RIVER; fixed[i] = 0;
        // Deep water down the middle of the reservoir; the stream is 2-3 deep.
        raw[i] = south ? (dr < half - 1.5 ? (half > 7.5 && dr < half * 0.45 ? surface - 4 : surface - 3) : surface - 2)
          : Math.round(surface - 2 - Math.min(4, Math.max(0, half - dr) / 5));
        continue;
      }
      if (!south) {
        const cap = surface + Math.max(0, dr - half);
        if (!fixed[i] && raw[i] > cap) raw[i] = cap;
        for (const ford of fords) {
          const along = Math.abs(pz - ford.z) - ford.width / 2;
          if (along < 10 && redrockSurfaceAt(ford.z) === surface) {
            const gentle = ford.bedY + 1 + Math.max(0, dr - half) / 2.5 + Math.max(0, along);
            if (!fixed[i] && raw[i] > gentle) raw[i] = gentle;
          }
        }
        continue;
      }
      // Canyon: the floor, then the walls; the canyon overrides pads (C's
      // abutments stand straight up from it).
      const floorHalf = canyonFloorHalf(pz, offset);
      const top = CANYON_FLOOR + canyonWallRise(dr - floorHalf, slope, pz, offset);
      if (top < raw[i] - 0.25) {
        raw[i] = top; fixed[i] = 0;
        if (kind[i] === KIND.PAD) kind[i] = KIND.GROUND;
        if (slope > 1.05 && dr > floorHalf) cliffWall[i] = 1;
      }
      // Wash ford banks: gentle ramps down to the bed.
      for (const ford of fords) {
        const along = Math.abs(pz - ford.z) - ford.width / 2;
        if (along < 10 && redrockSurfaceAt(ford.z) === surface) {
          const gentle = ford.bedY + 1 + Math.max(0, dr - half) / 2.5 + Math.max(0, along);
          if (!fixed[i] && raw[i] > gentle) raw[i] = gentle;
        }
      }
    }
  }
  // Bridge decks span the cells of their rectangle that lie below the deck.
  for (const c of REDROCK_CROSSINGS.filter(c => c.kind === 'bridge' && c.id !== 'redrock-dam')) {
    const r = deckRect(c);
    for (let z = r.minZ; z <= r.maxZ; z++) for (let x = r.minX; x <= r.maxX; x++) {
      const i = z * SX + x;
      if (raw[i] >= c.deckY - 0.5) continue;
      kind[i] = KIND.BRIDGE; fixed[i] = 1; fixedY[i] = c.deckY;
      ground[i] = Math.round(raw[i]);
      cliffWall[i] = 0;
    }
  }

  // 4. Roads: graded profiles (<= 1 per 3 m), pinned on decks, fords, pads,
  // plateaus and earlier roads, then rasterised as fixed cells.
  const roads = [];
  const grade = 1 / 3;
  REDROCK_ROAD_PLAN.forEach((plan, index) => {
    const length = polylineLength(plan.points), n = Math.max(2, Math.ceil(length) + 1);
    const target = new Float64Array(n), pin = new Float64Array(n).fill(NaN);
    for (let k = 0; k < n; k++) {
      const p = polylineAt(plan.points, k * length / (n - 1));
      const xi = clamp(Math.floor(p.x), 0, SX - 1), zi = clamp(Math.floor(p.z), 0, SZ - 1), i = zi * SX + xi;
      target[k] = raw[i];
      for (const c of REDROCK_CROSSINGS) {
        if (Math.abs(p.z - c.z) <= c.width / 2 + 2 && Math.abs(p.x - c.x) <= c.halfSpan) pin[k] = c.kind === 'bridge' ? c.deckY : c.bedY;
      }
      if (Number.isNaN(pin[k])) {
        if (roadIndex[i]) pin[k] = fixedY[i];
        else if (fixed[i] && kind[i] !== KIND.FORD) pin[k] = fixedY[i];
      }
    }
    const step = length / (n - 1);
    const level = gradedRoadLevels(target, pin, step, grade);
    const hw = plan.width / 2, shoulder = 5;
    for (let s = 1; s < plan.points.length; s++) {
      const a = plan.points[s - 1], b = plan.points[s];
      const before = polylineLength(plan.points.slice(0, s));
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const minX = Math.floor(Math.min(a[0], b[0]) - hw - shoulder), maxX = Math.ceil(Math.max(a[0], b[0]) + hw + shoulder);
      const minZ = Math.floor(Math.min(a[1], b[1]) - hw - shoulder), maxZ = Math.ceil(Math.max(a[1], b[1]) + hw + shoulder);
      for (let z = Math.max(0, minZ); z <= Math.min(SZ - 1, maxZ); z++) for (let x = Math.max(0, minX); x <= Math.min(SX - 1, maxX); x++) {
        const px = x + 0.5, pz = z + 0.5;
        const t = clamp(((px - a[0]) * (b[0] - a[0]) + (pz - a[1]) * (b[1] - a[1])) / (len * len), 0, 1);
        const d = Math.hypot(px - lerp(a[0], b[0], t), pz - lerp(a[1], b[1], t));
        const i = z * SX + x;
        if (d > hw + shoulder) continue;
        const k = clamp(Math.round((before + t * len) / step), 0, n - 1);
        if (d <= hw) {
          if (roadIndex[i] && roadIndex[i] !== index + 1) continue;
          if (roadIndex[i] === index + 1 && d >= roadDist[i]) continue;
          if (kind[i] === KIND.BRIDGE) { roadIndex[i] = index + 1; roadDist[i] = d; continue; }
          if (kind[i] === KIND.RIVER) continue;                 // only a deck or a ford carries a road over water
          roadIndex[i] = index + 1; roadDist[i] = d;
          if (kind[i] !== KIND.FORD && kind[i] !== KIND.PLATEAU && kind[i] !== KIND.PAD) kind[i] = KIND.ROAD;
          fixed[i] = 1; cliffWall[i] = 0;
          fixedY[i] = kind[i] === KIND.FORD ? fixedY[i] : level[k];
          raw[i] = fixedY[i];
        } else if (!fixed[i] && kind[i] !== KIND.RIVER) {
          raw[i] = lerp(level[k], raw[i], smoothstep(hw, hw + shoulder, d));
          cliffWall[i] = 0;
        }
      }
    }
    roads.push({ ...plan, index: index + 1, length, step, level });
  });

  // 5. Drivability clamp: neighbour steps <= 1 everywhere except the
  // mountains outside the combat area, the canyon cliffs and the mesas.
  const active = new Uint8Array(N);
  for (let i = 0; i < N; i++) active[i] = kind[i] === KIND.RIVER || kind[i] === KIND.BRIDGE || cliffWall[i] ? 0 : 1;
  const U = new Int16Array(N), L = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    U[i] = fixed[i] ? fixedY[i] : SENTINEL;
    L[i] = fixed[i] ? fixedY[i] : -SENTINEL;
  }
  relax(U, active, -1, SX, SZ);
  relax(L, active, 1, SX, SZ);
  const natural = raw;
  const heights = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    natural[i] = Math.round(raw[i]);
    heights[i] = fixed[i] ? fixedY[i] : clamp(natural[i], L[i], U[i]);
  }
  relax(heights, active, -1, SX, SZ);
  for (let i = 0; i < N; i++) {
    if (active[i]) heights[i] = Math.max(L[i], heights[i]);
    else if (kind[i] === KIND.BRIDGE) heights[i] = fixedY[i];
    else heights[i] = natural[i];
    if (cliffWall[i]) kind[i] = KIND.CLIFF;
  }
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const i = z * SX + x;
    if (!active[i] || fixed[i] || insideCombatArea(x + 0.5, z + 0.5)) continue;
    if (natural[i] > heights[i]) { heights[i] = natural[i]; kind[i] = KIND.CLIFF; }
  }
  // Mesas: cap rock flat at `top`, cliff sides with a short talus apron.
  for (const m of REDROCK_MESAS) {
    const reach = Math.max(m.rx, m.rz) * 1.3;
    for (let z = Math.floor(m.z - reach); z <= Math.ceil(m.z + reach); z++) for (let x = Math.floor(m.x - reach); x <= Math.ceil(m.x + reach); x++) {
      if (x < 0 || z < 0 || x >= SX || z >= SZ) continue;
      const i = z * SX + x;
      if (!active[i] || fixed[i] || kind[i] === KIND.FORD) continue;
      const d = mesaDistance(m, x + 0.5, z + 0.5);
      if (d >= 1.12) continue;
      const g = heights[i];
      // Inside the rim: the cap; the outer 12 % a steep talus of two-voxel steps.
      const y = d <= 1 ? m.top - (d > 0.9 ? Math.round((d - 0.9) * 20) : 0) : g + Math.max(0, Math.round((1.12 - d) / 0.12 * 3));
      if (y > g + 1) { heights[i] = y; kind[i] = KIND.CLIFF; }
    }
  }
  // Under the bridge decks the ground keeps its own level; elsewhere ground = heights.
  for (let i = 0; i < N; i++) if (kind[i] !== KIND.BRIDGE) ground[i] = heights[i];
  // Water finds its level: dry cells below a touching water surface flood too.
  const wet = [];
  for (let i = 0; i < N; i++) if (water[i] && kind[i] !== KIND.BRIDGE) wet.push(i);
  while (wet.length) {
    const i = wet.pop(), x = i % SX, level = water[i];
    for (const j of [x > 0 ? i - 1 : -1, x < SX - 1 ? i + 1 : -1, i - SX, i + SX]) {
      if (j < 0 || j >= N || water[j] || kind[j] === KIND.BRIDGE || heights[j] >= level) continue;
      water[j] = level;
      wet.push(j);
    }
  }

  // 6. Drivable cells: dry or fordable, every 8-neighbour within one voxel.
  const drivable = new Uint8Array(N);
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const i = z * SX + x;
    if (kind[i] === KIND.RIVER || kind[i] === KIND.CLIFF) continue;
    let ok = true;
    for (let dz = -1; dz <= 1 && ok; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, nz = z + dz;
      if ((!dx && !dz) || nx < 0 || nz < 0 || nx >= SX || nz >= SZ) continue;
      const j = nz * SX + nx;
      if (kind[j] === KIND.RIVER) continue;
      if (Math.abs(heights[j] - heights[i]) > 1) { ok = false; break; }
    }
    drivable[i] = ok ? 1 : 0;
  }

  // 7. Surfaces: desert sand, gravel pavement and scrub, strata on every
  // cliff, mud and reed grass at the water, hardstand on the plateaus.
  const surface = new Uint8Array(N);
  const padMask = new Uint8Array(N);
  REDROCK_PADS.forEach((p, n) => {
    for (let z = Math.floor(p.z - p.radius); z <= Math.ceil(p.z + p.radius); z++)
      for (let x = Math.floor(p.x - p.radius); x <= Math.ceil(p.x + p.radius); x++)
        if (Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) <= p.radius) padMask[z * SX + x] = n + 1;
  });
  const slopeAt = (x, z) => {
    const h = heights[z * SX + x];
    const stepTo = j => (kind[j] === KIND.RIVER ? 0 : Math.abs(heights[j] - h));
    return Math.max(stepTo(z * SX + Math.min(SX - 1, x + 1)), stepTo(z * SX + Math.max(0, x - 1)),
      stepTo(Math.min(SZ - 1, z + 1) * SX + x), stepTo(Math.max(0, z - 1) * SX + x));
  };
  const crater = new Uint8Array(N);
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const i = z * SX + x, px = x + 0.5, pz = z + 0.5, h = heights[i], k = kind[i];
    if (k === KIND.RIVER) { surface[i] = MC_WATER; continue; }
    if (k === KIND.BRIDGE) { surface[i] = CONCRETE; continue; }
    if (k === KIND.FORD || water[i]) { surface[i] = MC_WATER; continue; }
    if (roadIndex[i]) { surface[i] = roads[roadIndex[i] - 1].kind === 'paved' ? ASPHALT : GRAVEL; continue; }
    const slope = slopeAt(x, z);
    if (k === KIND.CLIFF || slope >= 2) { surface[i] = slope <= 1 ? DUST_SANDSTONE : strataAt(h); continue; }
    if (k === KIND.PAD && padMask[i]) { surface[i] = padSurface(REDROCK_PADS[padMask[i] - 1], px, pz); continue; }
    const dr = Math.abs(riverOffset(px, pz)), half = riverHalfAt(pz), south = pz >= REDROCK_DAM.z1;
    const level = redrockSurfaceAt(pz);
    if (south && h <= CANYON_FLOOR + 1 && dr <= canyonFloorHalf(pz, 1) + 3) {
      const n = noise(px / 6, pz / 6, 133);
      surface[i] = n > 0.25 ? GRAVEL : n > -0.35 ? SAND : MUD;
      continue;
    }
    if (!south && h <= level + 1 && dr <= half + 4) { surface[i] = noise(px / 7, pz / 7, 135) > 0 ? MUD : MC_CLAY; continue; }
    if (!south && dr <= half + 9 && h <= level + 4) {
      const n = noise(px / 8, pz / 8, 137);
      surface[i] = n > 0.2 ? MEADOW : n > -0.3 ? DRY_GRASS : SAND;
      continue;
    }
    if (!insideCombatArea(px, pz) || h >= 44) {
      const n = noise(px / 9, pz / 9, 139);
      surface[i] = n > 0.35 ? SAND : n < -0.3 ? DUST_SANDSTONE : strataAt(h);
      continue;
    }
    if (k === KIND.PLATEAU) {
      const n = noise(px / 18, pz / 18, 151);
      surface[i] = n > 0.35 ? GRAVEL : n < -0.4 ? DUST_FLOOR : n > -0.05 ? SAND : DIRT;
      continue;
    }
    // A few old shell scars around the dam's approaches.
    const scar = 1 - Math.hypot(Math.abs(px - SX / 2) - 70, pz - 384) / 60;
    if (scar > 0 && noise(px / 6, pz / 6, 167) > 0.7 - scar * 0.4) { surface[i] = SCORCHED_EARTH; continue; }
    const scrub = redrockScrubDensity(px, pz);
    const n = noise(px / 13, pz / 13, 173), g = noise(px / 31, pz / 31, 179);
    if (g > 0.55 && noise(px / 7, pz / 7, 183) > -0.2) { surface[i] = GRAVEL; continue; }   // desert pavement
    if (n > 0.62 || (slope === 1 && noise(px / 3, pz / 3, 163) > 0.8)) { surface[i] = DIRT; continue; }
    if (noise(px / 19, pz / 19, 187) > 0.6) { surface[i] = DUST_ROCK; continue; }          // bare slickrock
    surface[i] = scrub > 0.62 && noise(px / 5, pz / 5, 181) > 0.1 ? DRY_GRASS : SAND;
  }

  return {
    sx: SX, sz: SZ, heights, ground, surface, drivable, water, kind, roadIndex, crater,
    roads: roads.map(r => ({ id: r.id, kind: r.kind, width: r.width, index: r.index, points: r.points, length: r.length, step: r.step, level: r.level })),
  };
}

/** Rock strata by height: red sandstone with cream bands every few metres. */
export function strataAt(y) {
  const band = ((y % 7) + 7) % 7;
  return band === 3 || band === 4 ? DUST_SANDSTONE : DUST_ROCK;
}

function padSurface(pad, x, z) {
  const d = Math.hypot(x - pad.x, z - pad.z);
  const n = noise(x / 6, z / 6, 171);
  switch (pad.site) {
    case 'oasis': return d < 12 ? DIRT : n > 0.3 ? DRY_GRASS : n > -0.2 ? SAND : DIRT;
    case 'mine': return d < 16 ? GRAVEL : n > 0.15 ? DIRT : SAND;
    case 'dam': return n > 0.3 ? GRAVEL : n > -0.3 ? DUST_FLOOR : SAND;
    case 'radar': return d < 14 ? CONCRETE : n > 0.1 ? GRAVEL : SAND;
    case 'railhead': return d < 15 ? GRAVEL : n > 0 ? DIRT : SAND;
    default: return SAND;
  }
}

let built = null;
/** Memoised terrain build (pure: the same arrays on every call). */
export function redrockTerrain() {
  built ??= buildTerrain();
  return built;
}

const cellIndex = (x, z) => clamp(Math.floor(z), 0, SZ - 1) * SX + clamp(Math.floor(x), 0, SX - 1);
/** Standing height (y of the first free voxel above the terrain) at x, z. */
export function redrockSurfaceY(x, z) { return redrockTerrain().heights[cellIndex(x, z)] + 1; }
/** Top terrain voxel y at x, z (river bed, ground, road, bridge deck or dam crest). */
export function redrockTopY(x, z) { return redrockTerrain().heights[cellIndex(x, z)]; }
/** Block id of the terrain top at x, z (MC_WATER on open water and fords). */
export function redrockSurfaceBlock(x, z) { return redrockTerrain().surface[cellIndex(x, z)]; }
/** Water surface y at x, z, or 0 on dry ground. */
export function redrockWaterY(x, z) { return redrockTerrain().water[cellIndex(x, z)]; }
export function redrockDrivable(x, z) { return redrockTerrain().drivable[cellIndex(x, z)] === 1; }
