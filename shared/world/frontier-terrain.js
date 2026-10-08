// Frontier v2 terrain: a pure, deterministic heightfield for the 768 x 80 x 768
// river valley (spec section 4.2). Everything here is derived from FRONTIER_PLAN
// in the frozen Conquest contract plus the authored ground plan below, with one
// constant seed, so the server generator, the map metadata, bot navigation and
// the far-terrain renderer all read the same surface without building voxels.
//
// Height convention: `heights[i]` is the y of the top solid terrain voxel of the
// column (river bed, ground, road, pad or bridge deck). A player stands at
// `heights + 1`; frontierSurfaceY(x, z) returns that standing height.
// Set pieces (buildings, trenches, trees) are added later by
// shared/world/frontier-sites/ and are not part of this heightfield.

import { FRONTIER_PLAN } from '../conquest-contract.js';
import {
  ASPHALT, CONCRETE, DIRT, STONE, DUST_ROCK, MC_WATER, MC_CLAY, MC_COBBLE, SAND,
  MEADOW, DRY_GRASS, FIELD_WHEAT, MUD, SCORCHED_EARTH, GRAVEL, PINE_NEEDLES,
} from './blocks.js';

const { sx: SX, sz: SZ } = FRONTIER_PLAN.dimensions;
const H = FRONTIER_PLAN.heights;
const RIVER = FRONTIER_PLAN.river;
const AREA = FRONTIER_PLAN.combatArea;
export const FRONTIER_TERRAIN_SEED = 0x46524f4e;

/** Continuous point mirror about the map centre (384, 384). */
export const mirrorPoint = ([x, z]) => [SX - x, SZ - z];
/** Cell mirror: cell (x, z) covers [x, x+1); its point mirror is cell (767-x, 767-z). */
export const mirrorCell = (x, z) => [SX - 1 - x, SZ - 1 - z];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------ noise

function hash2(ix, iz, salt) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul((salt + FRONTIER_TERRAIN_SEED) | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in -1..1. */
export function valueNoise(x, z, salt) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(x0, z0, salt), b = hash2(x0 + 1, z0, salt);
  const c = hash2(x0, z0 + 1, salt), d = hash2(x0 + 1, z0 + 1, salt);
  const top = a + (b - a) * sx, bottom = c + (d - c) * sx;
  return (top + (bottom - top) * sz) * 2 - 1;
}

/** Fractal value noise normalised to -1..1. */
export function fbm(x, z, octaves, salt) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f + o * 17.31, z * f - o * 9.73, salt + o * 101) * amp;
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return sum / norm;
}

/** Ridged multifractal in 0..1: sharp crests where the base noise crosses zero. */
function ridged(x, z, octaves, salt) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * f + o * 5.1, z * f + o * 3.7, salt + o * 31));
    sum += n * n * amp; norm += amp; amp *= 0.5; f *= 2.1;
  }
  return sum / norm;
}

// ------------------------------------------------------------- the river

/**
 * The river keeps the plan's 12 m channel at the five crossings and widens
 * between them into a 24-30 m meandering river. `riverReach(z)` is 0 at a
 * crossing and 1 on an open reach; the Iron Bridge keeps its narrows longer
 * because its quays run 44 m up and down both banks.
 */
const NARROWS = Object.freeze({ 'iron-bridge': [46, 66] });
export function riverReach(z) {
  let w = 1;
  for (const c of FRONTIER_PLAN.crossings) {
    const [a, b] = NARROWS[c.id] ?? [20, 46];
    w = Math.min(w, smoothstep(a, b, Math.abs(z - c.z)));
  }
  return w;
}
function riverHalfExact(z) {
  return RIVER.width / 2 + 9 * riverReach(z) * (0.84 + 0.16 * Math.cos((z - SZ / 2) / 23));
}
/** riverHalfExact sampled at every cell centre z + 0.5 (exact there, linear between). */
const HALF_ROWS = Float64Array.from({ length: SZ + 1 }, (_, zi) => riverHalfExact(zi + 0.5));
/** Half width of the open water at continuous z (6 at every crossing). */
export function riverHalfAt(z) {
  const t = clamp(z - 0.5, 0, SZ), zi = Math.min(SZ - 1, Math.floor(t));
  return lerp(HALF_ROWS[zi], HALF_ROWS[zi + 1], t - zi);
}
/**
 * Meander of each reach north of the centre: [z0, z1, amplitude] (+ east).
 * South reaches are the point mirror, so the valley stays fair.
 */
const MEANDER = [[0, 150, 9], [150, 270, -15], [270, 384, 13]];
export function riverMeander(z) {
  if (z > SZ / 2) return -riverMeander(SZ - z);
  // sin^2 leaves every crossing square to the banks; the Iron Bridge quays
  // keep the channel straight for 48 m either side of the deck.
  const quays = smoothstep(48, 76, Math.abs(z - SZ / 2));
  for (const [a, b, amp] of MEANDER) if (z >= a && z <= b) return amp * Math.sin(Math.PI * (z - a) / (b - a)) ** 2 * quays;
  return 0;
}

/** Uniform Catmull-Rom through the plan's river points, densely sampled. */
function riverCentreline() {
  const pts = RIVER.points;
  const P = [pts[0], ...pts, pts.at(-1)];
  const samples = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let s = 0; s < 64; s++) {
      const t = s / 64, t2 = t * t, t3 = t2 * t;
      const c = k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      samples.push([c(0), c(1)]);
    }
  }
  samples.push(pts.at(-1));
  // The river runs north-south: resolve x as a function of z per voxel row.
  const xs = new Float64Array(SZ + 1), slope = new Float64Array(SZ + 1);
  let j = 0;
  for (let zi = 0; zi <= SZ; zi++) {
    const z = Math.min(zi + 0.5, SZ);
    while (j < samples.length - 2 && samples[j + 1][1] < z) j++;
    const a = samples[j], b = samples[j + 1];
    const t = b[1] === a[1] ? 0 : clamp((z - a[1]) / (b[1] - a[1]), 0, 1);
    xs[zi] = lerp(a[0], b[0], t) + riverMeander(z);
  }
  for (let zi = 0; zi <= SZ; zi++) slope[zi] = (xs[Math.min(SZ, zi + 1)] - xs[Math.max(0, zi - 1)]) / (Math.min(SZ, zi + 1) - Math.max(0, zi - 1));
  return { xs, slope };
}
const RIVER_LINE = riverCentreline();
/** River centre x at continuous z. */
export function riverCentreX(z) {
  const zi = clamp(Math.floor(z - 0.5), 0, SZ - 1), t = clamp(z - 0.5 - zi, 0, 1);
  return lerp(RIVER_LINE.xs[zi], RIVER_LINE.xs[zi + 1], t);
}
/** Signed horizontal distance from the river centreline (positive east). */
export function riverOffset(x, z) {
  const zi = clamp(Math.floor(z), 0, SZ - 1);
  return (x - riverCentreX(z)) / Math.sqrt(1 + RIVER_LINE.slope[zi] ** 2);
}
const RIVER_HALF = RIVER.width / 2;
const RIVER_BED = RIVER.surfaceY - RIVER.depth;              // 18
const FORD_BED = RIVER.surfaceY - 1;                         // 20, one voxel of water

/**
 * Gravel and reed islands in the open reaches: z, offset across the river
 * (+ east of the centreline), half length along z and half width across.
 * Authored north of the centre; the south reaches carry the point mirror.
 * None touches the centreline, so the main channel stays open water.
 */
const ISLANDS_NORTH = [
  { z: 92, o: -7, len: 11, wid: 3.2 },
  { z: 212, o: 7.5, len: 15, wid: 3.6 },
  { z: 318, o: -6, len: 9, wid: 2.6 },
];
export const FRONTIER_ISLANDS = Object.freeze([...ISLANDS_NORTH, ...ISLANDS_NORTH.map(s => ({ ...s, z: SZ - s.z, o: -s.o }))]
  .map(s => Object.freeze(s)));

// --------------------------------------------------------- authored plan

const mirrorPoly = points => points.map(mirrorPoint).reverse();
const rect = (minX, minZ, maxX, maxZ) => ({ minX, minZ, maxX, maxZ });
const mirrorRect = r => rect(SX - r.maxX, SZ - r.maxZ, SX - r.minX, SZ - r.minZ);

/**
 * HQ plateaus at y36 (rounded rectangles, continuous coordinates). Each
 * carries a 312 m runway along z at x 44 and the motor pool, helipads and
 * hangar between the runway and the valley rim.
 */
const ALPHA_PLATEAU = { ...rect(26, 200, 146, 568), radius: 22 };
export const FRONTIER_PLATEAUS = Object.freeze([
  Object.freeze({ team: 'alpha', y: H.hqPlateau, ...ALPHA_PLATEAU }),
  Object.freeze({ team: 'bravo', y: H.hqPlateau, ...mirrorRect(ALPHA_PLATEAU), radius: ALPHA_PLATEAU.radius }),
]);

/** HQ runways (312 m along z); the approach corridors stay below a glide slope. */
const ALPHA_RUNWAY = { team: 'alpha', x: 44, z0: 228, z1: 540, width: 26 };
export const FRONTIER_RUNWAYS = Object.freeze([
  Object.freeze(ALPHA_RUNWAY),
  Object.freeze({ ...ALPHA_RUNWAY, team: 'bravo', x: SX - ALPHA_RUNWAY.x, z0: SZ - ALPHA_RUNWAY.z1, z1: SZ - ALPHA_RUNWAY.z0 }),
]);

/** Flag pads: radius + 12, flat at the site's height, 20 m smoothstep falloff. */
const PAD_HEIGHTS = { farm: 27, village: 33, bridge: 25, bunkers: 33, works: 27 };
export const FRONTIER_PADS = Object.freeze(FRONTIER_PLAN.flags.map(f => Object.freeze({
  flag: f.id, site: f.site, x: f.x, z: f.z, radius: f.radius + 12, y: PAD_HEIGHTS[f.site], falloff: 20,
})));

/**
 * Road network. Junctions share exact vertices so the bot road graph links
 * them. Alpha-side roads are authored; bravo roads are their point mirrors.
 * The paved axis HQ-W -> C -> HQ-E is its own mirror.
 */
const ALPHA_ROADS = [
  { id: 'hq-west-a', kind: 'gravel', width: 7, points: [[150, 384], [180, 320], [212, 276], [232, 248]] },
  { id: 'hq-west-b', kind: 'gravel', width: 7, points: [[150, 384], [196, 446], [236, 490], [272, 520]] },
  { id: 'a-c', kind: 'gravel', width: 7, points: [[232, 248], [270, 286], [306, 330], [330, 384]] },
  { id: 'b-c', kind: 'gravel', width: 7, points: [[272, 520], [300, 474], [318, 430], [330, 384]] },
  { id: 'a-d-ford', kind: 'gravel', width: 7, points: [[232, 248], [300, 262], [360, 268], [392, 270], [424, 266], [460, 256], [496, 248]] },
  { id: 'north-loop', kind: 'gravel', width: 7, points: [[150, 384], [156, 300], [168, 222], [218, 164], [300, 142], [396, 150], [470, 140], [548, 148], [600, 172], [612, 250], [618, 384]] },
];
const MIRROR_IDS = { 'hq-west-a': 'hq-east-e', 'hq-west-b': 'hq-east-d', 'a-c': 'e-c', 'b-c': 'd-c', 'a-d-ford': 'e-b-ford', 'north-loop': 'south-loop' };
export const FRONTIER_ROAD_PLAN = Object.freeze([
  Object.freeze({ id: 'axis', kind: 'paved', width: 10, points: Object.freeze([[72, 384], [150, 384], [250, 384], [330, 384], [384, 384], [438, 384], [518, 384], [618, 384], [696, 384]]) }),
  ...ALPHA_ROADS.flatMap(r => [
    Object.freeze({ ...r, points: Object.freeze(r.points) }),
    Object.freeze({ ...r, id: MIRROR_IDS[r.id], points: Object.freeze(mirrorPoly(r.points)) }),
  ]),
]);

/** Bridge decks: top voxel y; deck spans the river plus 3 m abutments. */
const DECK_Y = { 'bridge-north': 24, 'iron-bridge': H.valleyMin + 1, 'bridge-south': 24 };
export const FRONTIER_CROSSINGS = Object.freeze(FRONTIER_PLAN.crossings.map(c => Object.freeze({
  ...c, deckY: c.kind === 'bridge' ? DECK_Y[c.id] : null, bedY: c.kind === 'ford' ? FORD_BED : null,
  halfSpan: c.kind === 'bridge' ? RIVER_HALF + 3 : RIVER_HALF + 1,
})));

/** Forests: Ashgrove (south-west) and its point mirror Blackwood (north-east). */
const ASHGROVE = { id: 'ashgrove', name: 'Ashgrove', x: 196, z: 660, rx: 118, rz: 64, angle: -0.18 };
export const FRONTIER_FORESTS = Object.freeze([
  Object.freeze(ASHGROVE),
  Object.freeze({ ...ASHGROVE, id: 'blackwood', name: 'Blackwood', x: SX - ASHGROVE.x, z: SZ - ASHGROVE.z }),
  // The burnt stand behind Ridge Bunkers: dead trunks on scorched ground.
  Object.freeze({ id: 'burnt-stand', name: 'Burnt stand', x: 548, z: 196, rx: 34, rz: 24, angle: 0.3, burnt: true }),
]);

/**
 * Woodland outlines on the west half (alpha frame). Each is point-mirrored
 * onto the east half: Ashgrove/Blackwood, the Kestrel upland pinewood and its
 * twin above Kessler Works, the copses between the roads and the slope woods
 * along the valley rim. The riverbank tree lines are added by
 * frontierWoodDensity() from the river itself.
 */
export const FRONTIER_WOODS = Object.freeze([
  ASHGROVE,
  { id: 'kestrel-upland', x: 126, z: 96, rx: 76, rz: 46, angle: 0.25 },
  { id: 'north-reach', x: 334, z: 206, rx: 22, rz: 40, angle: 0.15 },
  { id: 'hedge-copse', x: 286, z: 360, rx: 16, rz: 9, angle: 0.3 },
  { id: 'axis-copse', x: 228, z: 434, rx: 28, rz: 13, angle: -0.5 },
  { id: 'aldric-slope', x: 176, z: 540, rx: 22, rz: 30, angle: 0.2 },
  { id: 'rim-north', x: 214, z: 64, rx: 60, rz: 20, angle: -0.1 },
  { id: 'rim-north-east', x: 316, z: 50, rx: 40, rz: 16, angle: 0.1 },
  { id: 'ford-wood', x: 326, z: 300, rx: 14, rz: 24, angle: 0.5 },
  { id: 'south-reach', x: 346, z: 450, rx: 13, rz: 20, angle: -0.2 },
  { id: 'axis-north-copse', x: 206, z: 350, rx: 20, rz: 10, angle: 0.3 },
  { id: 'hq-west-slope', x: 172, z: 486, rx: 16, rz: 24, angle: 0.1 },
  { id: 'upland-south', x: 120, z: 174, rx: 32, rz: 16, angle: 0.1 },
  { id: 'axis-south-west', x: 180, z: 428, rx: 14, rz: 20, angle: 0.2 },
  { id: 'b-c-wood', x: 282, z: 452, rx: 16, rz: 11, angle: -0.9 },
  { id: 'kestrel-east', x: 296, z: 226, rx: 12, rz: 22, angle: 0.6 },
  { id: 'north-meadow-wood', x: 268, z: 160, rx: 22, rz: 9, angle: 0.25 },
].map(w => Object.freeze({ ...w })));

/** Value noise read in the alpha frame, so mirrored cells get the same value. */
function symNoise(x, z, salt) {
  return x < SX / 2 ? valueNoise(x, z, salt) : valueNoise(SX - x, SZ - z, salt);
}

/**
 * Woodland density 0..1 at a cell centre: the authored woods with soft,
 * clumpy edges plus tree lines along both river banks that break up into
 * stands and leave every crossing open. Point-symmetric by construction.
 */
export function frontierWoodDensity(x, z) {
  if (x >= SX / 2) { x = SX - x; z = SZ - z; }
  let d = 0;
  for (const w of FRONTIER_WOODS) {
    const weight = forestWeight(w, x, z);
    if (weight > 0) d = Math.max(d, smoothstep(0, 0.22, weight));
  }
  const offset = riverOffset(x, z), dr = Math.abs(offset);
  const fromBank = dr > 50 ? 99 : dr - riverHalfAt(z);
  const band = fromBank < 26 ? 10 + 10 * (valueNoise(z / 37, offset > 0 ? 3 : 5, 431) + 1) / 2 : 0;
  if (fromBank > 1.5 && fromBank < band + 6) {
    let crossing = 1;
    for (const c of FRONTIER_PLAN.crossings) crossing = Math.min(crossing, smoothstep(14, 26, Math.abs(z - c.z)));
    const stands = smoothstep(-0.8, -0.45, valueNoise(z / 24, x / 24, 433));
    d = Math.max(d, crossing * stands * smoothstep(1.5, 4, fromBank) * (1 - smoothstep(band, band + 6, fromBank)));
  }
  return d > 0 ? clamp(d * (0.7 + 0.45 * fbm(x / 38, z / 38, 2, 401)), 0, 1) : 0;
}

/**
 * Cultivated strips: wheat and ploughed land around Kestrel Farm and below
 * St. Aldric on the west bank, market gardens and fallow strips on the east.
 */
export const FRONTIER_FIELDS = Object.freeze([
  { x0: 150, z0: 170, x1: 214, z1: 226, rows: 'x', crop: 'wheat' },
  { x0: 252, z0: 176, x1: 318, z1: 226, rows: 'z', crop: 'wheat' },
  { x0: 168, z0: 268, x1: 206, z1: 318, rows: 'x', crop: 'plough' },
  { x0: 262, z0: 288, x1: 300, z1: 318, rows: 'z', crop: 'wheat' },
  { x0: 198, z0: 540, x1: 244, z1: 580, rows: 'x', crop: 'wheat' },
  { x0: 300, z0: 560, x1: 344, z1: 596, rows: 'z', crop: 'plough' },
  { x0: 236, z0: 80, x1: 330, z1: 130, rows: 'x', crop: 'wheat' },
  { x0: 166, z0: 450, x1: 226, z1: 492, rows: 'z', crop: 'wheat' },
  { x0: 300, z0: 618, x1: 354, z1: 676, rows: 'x', crop: 'wheat' },
  { x0: 440, z0: 92, x1: 520, z1: 140, rows: 'z', crop: 'wheat' },
  { x0: 560, z0: 300, x1: 618, z1: 350, rows: 'x', crop: 'plough' },
  { x0: 600, z0: 196, x1: 660, z1: 236, rows: 'z', crop: 'wheat' },
  { x0: 444, z0: 610, x1: 520, z1: 664, rows: 'x', crop: 'wheat' },
  { x0: 548, z0: 420, x1: 600, z1: 470, rows: 'z', crop: 'wheat' },
  // Golden strips on the open ground either side of the paved axis.
  { x0: 286, z0: 398, x1: 318, z1: 416, rows: 'z', crop: 'wheat' },
  { x0: 450, z0: 352, x1: 482, z1: 370, rows: 'z', crop: 'wheat' },
  { x0: 150, z0: 324, x1: 184, z1: 360, rows: 'x', crop: 'wheat' },
  { x0: 584, z0: 408, x1: 618, z1: 444, rows: 'x', crop: 'wheat' },
].map(f => Object.freeze(f)));

/** Pre-carved shell craters: C's approaches, D's slopes and the open middle. */
export const FRONTIER_CRATERS = Object.freeze([
  [350, 352, 4], [362, 420, 3], [410, 344, 3], [420, 412, 4], [400, 330, 3], [368, 446, 3],
  [470, 214, 4], [520, 226, 3], [532, 280, 4], [474, 290, 3], [508, 300, 3], [556, 248, 3],
  [440, 300, 3], [330, 470, 3], [300, 230, 3], [470, 540, 3], [250, 456, 3], [520, 330, 3],
  // Shell scars along the river and across the open middle: authored west,
  // mirrored east, kept 6 m off every road. They are scorched and churned but
  // not dug out: extra pits along the approaches made bots go to ground
  // instead of pushing the flags (conquest-action-test flag transitions).
  ...[
    [352, 300, 3], [340, 444, 3], [318, 266, 2.5], [300, 410, 3], [262, 378, 2.5], [356, 524, 3], [338, 606, 3],
    [352, 172, 3], [286, 458, 2.5], [324, 236, 3], [282, 302, 2.5], [364, 248, 3], [312, 560, 2.5], [196, 360, 2.5],
  ].filter(([x, z, r]) => roadEdgeDistance(x, z) - r >= 6).flatMap(([x, z, r]) => [[x, z, r, 1], [SX - x, SZ - z, r, 1]]),
].map(([x, z, r, scorch = 0]) => Object.freeze(scorch ? { x, z, r, scorch: true } : { x, z, r })));

/** Distance from (x, z) to the nearest planned road edge. */
function roadEdgeDistance(x, z) {
  let best = Infinity;
  for (const road of FRONTIER_ROAD_PLAN) for (let i = 1; i < road.points.length; i++) {
    const [ax, az] = road.points[i - 1], [bx, bz] = road.points[i], dx = bx - ax, dz = bz - az;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t) - road.width / 2);
  }
  return best;
}

/** Rocky outcrops inside the combat area: the only interior cliffs. */
const OUTCROPS = [[140, 640, 12, 7], [118, 150, 10, 6], [300, 600, 9, 5]];
export const FRONTIER_OUTCROPS = Object.freeze([...OUTCROPS, ...OUTCROPS.map(([x, z, r, h]) => [SX - x, SZ - z, r, h])]
  .map(([x, z, r, h]) => Object.freeze({ x, z, r, h })));

/** Points: within the combat area? */
export const insideCombatArea = (x, z) => x >= AREA.minX && x < AREA.maxX && z >= AREA.minZ && z < AREA.maxZ;

function inRoundedRect(x, z, r) {
  const cx = clamp(x, r.minX + r.radius, r.maxX - r.radius), cz = clamp(z, r.minZ + r.radius, r.maxZ - r.radius);
  return Math.hypot(x - cx, z - cz) - r.radius;            // signed distance (<= 0 inside)
}

export function forestWeight(forest, x, z) {
  const dx = x - forest.x, dz = z - forest.z, reach = Math.max(forest.rx, forest.rz) * 1.25;
  if (dx > reach || dx < -reach || dz > reach || dz < -reach) return -1;
  const c = Math.cos(forest.angle), s = Math.sin(forest.angle);
  const u = (dx * c + dz * s) / forest.rx, v = (-dx * s + dz * c) / forest.rz;
  const edge = 1 + 0.18 * valueNoise(x / 23, z / 23, 77);
  return 1 - Math.hypot(u, v) / edge;                        // > 0 inside
}

// ------------------------------------------------------------ base relief

/** Authored hill masses (canonical west half; the east half is mirrored). */
const HILLS = [
  // St. Aldric's hill; its mirror is the ridge under Ridge Bunkers.
  { x: 262, z: 534, rx: 96, rz: 70, h: 8.5, ridge: 0 },
  // Rolling upland north-west of Kestrel Farm and its southern shoulder.
  { x: 150, z: 128, rx: 110, rz: 70, h: 7, ridge: 6 },
  { x: 120, z: 664, rx: 96, rz: 84, h: 8, ridge: 7 },
  // Low saddle between the farm and the iron bridge.
  { x: 318, z: 300, rx: 40, rz: 46, h: 2.5, ridge: 0 },
];

function canonicalHeight(x, z) {
  const dr = Math.abs(riverOffset(x, z));
  let h = 24 + 9 * smoothstep(10, 200, dr);
  h += 6 * fbm(x / 220, z / 220, 4, 11);
  h += 1.6 * fbm(x / 54, z / 54, 3, 23);
  for (const hill of HILLS) {
    const q = ((x - hill.x) / hill.rx) ** 2 + ((z - hill.z) / hill.rz) ** 2;
    if (q >= 1) continue;
    const bump = (1 - q) * (1 - q);
    h += bump * hill.h + (hill.ridge ? bump * hill.ridge * ridged(x / 140, z / 140, 3, 41) ** 2 : 0);
  }
  // The valley rim rises toward the restricted edge, then into mountains.
  const e = Math.min(x, z, SX - x, SZ - z);
  h += 12 * (1 - smoothstep(AREA.minX, 120, e)) ** 2;
  if (e < AREA.minX) h += (AREA.minX - e) / AREA.minX * (13 + 16 * ridged(x / 70, z / 70, 4, 57));
  return clamp(h, H.valleyMin - 3, H.ridgeMax);
}

// ------------------------------------------------------------ the builder

const INF = 1e9;
/** Int16 stand-in for an unbounded envelope (far beyond any voxel height). */
const SENTINEL = 30000;
const KIND = Object.freeze({ GROUND: 0, RIVER: 1, FORD: 2, BRIDGE: 3, ROAD: 4, PAD: 5, PLATEAU: 6, CLIFF: 7 });
export const FRONTIER_CELL_KIND = KIND;

/**
 * Chamfer passes with Chebyshev unit cost over active cells until stable.
 * In-place forward then backward raster sweeps over the four already-visited
 * neighbours (unrolled: this runs three times on every Frontier load).
 */
function relax(values, active, mode) {
  const N = SX * SZ, last = SX - 1;
  // mode < 0 lowers a cell to (neighbour + 1); mode > 0 raises it to
  // (neighbour - 1): a candidate c improves v when (c - v) * step < 0.
  const step = mode < 0 ? 1 : -1;
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    for (let z = 0, i = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++, i++) {
        if (!active[i]) continue;
        const v0 = values[i];
        let v = v0, c;
        if (x > 0 && active[i - 1] && ((c = values[i - 1] + step) - v) * step < 0) v = c;
        if (z > 0) {
          const k = i - SX;
          if (x > 0 && active[k - 1] && ((c = values[k - 1] + step) - v) * step < 0) v = c;
          if (active[k] && ((c = values[k] + step) - v) * step < 0) v = c;
          if (x < last && active[k + 1] && ((c = values[k + 1] + step) - v) * step < 0) v = c;
        }
        if (v !== v0) { values[i] = v; changed = true; }
      }
    }
    for (let z = SZ - 1, i = N - 1; z >= 0; z--) {
      for (let x = last; x >= 0; x--, i--) {
        if (!active[i]) continue;
        const v0 = values[i];
        let v = v0, c;
        if (x < last && active[i + 1] && ((c = values[i + 1] + step) - v) * step < 0) v = c;
        if (z < SZ - 1) {
          const k = i + SX;
          if (x < last && active[k + 1] && ((c = values[k + 1] + step) - v) * step < 0) v = c;
          if (active[k] && ((c = values[k] + step) - v) * step < 0) v = c;
          if (x > 0 && active[k - 1] && ((c = values[k - 1] + step) - v) * step < 0) v = c;
        }
        if (v !== v0) { values[i] = v; changed = true; }
      }
    }
    if (!changed) break;
  }
}

function polylineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return length;
}
/** Point and tangent at arc length s along a polyline. */
export function polylineAt(points, s) {
  let rest = s;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (rest <= len || i === points.length - 1) {
      const t = len ? clamp(rest / len, 0, 1) : 0;
      return { x: lerp(a[0], b[0], t), z: lerp(a[1], b[1], t), dx: (b[0] - a[0]) / (len || 1), dz: (b[1] - a[1]) / (len || 1) };
    }
    rest -= len;
  }
  const p = points.at(-1);
  return { x: p[0], z: p[1], dx: 1, dz: 0 };
}

function buildTerrain() {
  const N = SX * SZ;
  // Transient arrays are kept few and narrow: a server process keeps freed
  // typed-array pages resident, so every scratch megabyte here is RSS.
  const raw = new Float32Array(N);
  // 1. Base relief, point-symmetric by construction: every canonical (west)
  // cell computes the blended value once and writes it to its mirror too.
  // Only the 28 m seam band blends with the mirrored relief.
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX / 2; x++) {
    const i = z * SX + x, [mx, mz] = mirrorCell(x, z), j = mz * SX + mx;
    const w = smoothstep(SX / 2 - 14, SX / 2 + 14, x + 0.5);
    const a = Math.fround(canonicalHeight(x + 0.5, z + 0.5));
    const v = w ? (1 - w) * a + w * Math.fround(canonicalHeight(mx + 0.5, mz + 0.5)) : a;
    raw[i] = v; raw[j] = v;
  }

  const kind = new Uint8Array(N);
  const fixed = new Uint8Array(N);
  const fixedY = new Int16Array(N);
  const water = new Uint8Array(N);
  const roadIndex = new Uint8Array(N);
  const roadDist = new Float32Array(N).fill(INF);

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
  for (const pad of FRONTIER_PADS) {
    blendArea(pad.x - pad.radius, pad.z - pad.radius, pad.x + pad.radius, pad.z + pad.radius,
      (px, pz) => Math.hypot(px - pad.x, pz - pad.z) - pad.radius, pad.y, pad.falloff, KIND.PAD);
  }
  for (const plateau of FRONTIER_PLATEAUS) {
    blendArea(plateau.minX, plateau.minZ, plateau.maxX, plateau.maxZ, (px, pz) => inRoundedRect(px, pz, plateau), plateau.y, 20, KIND.PLATEAU);
  }

  // Runway approaches: level with the plateau for 90 m, then a 1:5 climb.
  for (const runway of FRONTIER_RUNWAYS) {
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

  // 3. River: 12 m of water at the crossings widening to ~30 m on the open
  // reaches, over an 18/19 bed (17 down the middle of a wide reach); fords
  // lift the bed to 20. Gravel islands stand in the open reaches and the
  // inside of every bend carries a gravel beach at water level.
  const fords = FRONTIER_CROSSINGS.filter(c => c.kind === 'ford');
  const island = new Uint8Array(N);
  for (let z = 0; z < SZ; z++) {
    const pz = z + 0.5, half = riverHalfAt(pz), meander = riverMeander(pz);
    const beach = 7 * Math.min(1, Math.abs(meander) / 9);
    for (let x = 0; x < SX; x++) {
      const i = z * SX + x, px = x + 0.5;
      const offset = riverOffset(px, pz), dr = Math.abs(offset);
      if (dr <= half) {
        const ford = fords.find(f => Math.abs(pz - f.z) <= f.width / 2);
        water[i] = RIVER.surfaceY;
        if (ford) { kind[i] = KIND.FORD; fixed[i] = 1; fixedY[i] = FORD_BED; raw[i] = FORD_BED; continue; }
        kind[i] = KIND.RIVER; fixed[i] = 0;
        let bed = dr < half - 1.5 ? (half > 10 && dr < half * 0.45 ? RIVER_BED - 1 : RIVER_BED) : RIVER_BED + 1;
        for (const s of FRONTIER_ISLANDS) {
          const u = (pz - s.z) / s.len, v = (offset - s.o) / s.wid, q = u * u + v * v;
          if (q >= 1 + 0.3 * symNoise(px / 3, pz / 3, 197)) continue;
          island[i] = q < 0.4 ? 2 : 1;
          bed = q < 0.4 ? RIVER.surfaceY + 1 : RIVER.surfaceY;
          water[i] = 0;
        }
        raw[i] = bed;
      } else {
        // Banks climb one voxel per metre; a bend's inside keeps a low beach one
        // voxel over the water (a beach flush with the surface trapped swimmers).
        const inside = offset * meander < 0 ? beach : 0;
        const cap = inside > 0.5 ? RIVER.surfaceY + 1 + Math.max(0, dr - half - inside) : RIVER.surfaceY + Math.max(0, dr - half);
        if (!fixed[i] && raw[i] > cap) raw[i] = cap;
        // Fords keep gentle banks for wheels and boots alike.
        for (const ford of fords) {
          const along = Math.abs(pz - ford.z) - ford.width / 2;
          if (along < 10) {
            const gentle = FORD_BED + 1 + Math.max(0, dr - half) / 2.5 + Math.max(0, along);
            if (!fixed[i] && raw[i] > gentle) raw[i] = gentle;
          }
        }
      }
    }
  }

  // 4. Roads: graded profiles (<= 1 per 3 m), pinned on decks, fords, pads,
  // plateaus and earlier roads, then rasterised as fixed cells.
  const roads = [];
  const grade = 1 / 3;
  FRONTIER_ROAD_PLAN.forEach((plan, index) => {
    const length = polylineLength(plan.points), n = Math.max(2, Math.ceil(length) + 1);
    const target = new Float64Array(n), pin = new Float64Array(n).fill(NaN);
    for (let k = 0; k < n; k++) {
      const p = polylineAt(plan.points, k * length / (n - 1));
      const xi = clamp(Math.floor(p.x), 0, SX - 1), zi = clamp(Math.floor(p.z), 0, SZ - 1), i = zi * SX + xi;
      target[k] = raw[i];
      for (const c of FRONTIER_CROSSINGS) {
        if (Math.hypot(p.x - c.x, p.z - c.z) <= c.halfSpan) pin[k] = c.kind === 'bridge' ? c.deckY : FORD_BED;
      }
      if (Number.isNaN(pin[k])) {
        if (roadIndex[i]) pin[k] = fixedY[i];
        else if (fixed[i] && kind[i] !== KIND.FORD) pin[k] = fixedY[i];
      }
    }
    // Smooth the target over +-14 m so rolling relief does not ripple the grade.
    const smooth = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let sum = 0, count = 0;
      for (let m = Math.max(0, k - 14); m <= Math.min(n - 1, k + 14); m++) { sum += target[m]; count++; }
      smooth[k] = sum / count;
    }
    // A third under the limit: cells are rasterised from their own projection,
    // so two cells three metres apart can be up to 3 + sqrt(2) samples apart
    // and rounding to whole voxels must still never exceed one voxel.
    const step = length / (n - 1), lim = grade * step * 0.66;
    // Envelopes from pins keep every pin reachable at the limiting grade.
    const lo = new Float64Array(n).fill(-INF), hi = new Float64Array(n).fill(INF);
    for (let k = 0; k < n; k++) if (!Number.isNaN(pin[k])) { lo[k] = hi[k] = pin[k]; }
    for (let k = 1; k < n; k++) { lo[k] = Math.max(lo[k], lo[k - 1] - lim); hi[k] = Math.min(hi[k], hi[k - 1] + lim); }
    for (let k = n - 2; k >= 0; k--) { lo[k] = Math.max(lo[k], lo[k + 1] - lim); hi[k] = Math.min(hi[k], hi[k + 1] + lim); }
    const prof = new Float64Array(n);
    for (let k = 0; k < n; k++) prof[k] = Number.isNaN(pin[k]) ? clamp(smooth[k], lo[k], hi[k]) : pin[k];
    for (let iter = 0; iter < 8; iter++) {
      for (let k = 1; k < n; k++) prof[k] = clamp(prof[k], prof[k - 1] - lim, prof[k - 1] + lim);
      for (let k = n - 2; k >= 0; k--) prof[k] = clamp(prof[k], prof[k + 1] - lim, prof[k + 1] + lim);
    }
    // Integer grade: never more than one voxel per three metres.
    const level = new Int16Array(n);
    for (let k = 0; k < n; k++) level[k] = Number.isNaN(pin[k]) ? Math.round(prof[k]) : pin[k];
    // Rasterise: nearest centreline sample sets each cell inside the half width.
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
          if (roadIndex[i] && roadIndex[i] !== index + 1) continue;  // earlier road keeps its surface
          if (roadIndex[i] === index + 1 && d >= roadDist[i]) continue;
          if (kind[i] === KIND.RIVER || kind[i] === KIND.BRIDGE) {
            // Over open water only a bridge deck carries the road.
            const bridge = FRONTIER_CROSSINGS.find(c => c.kind === 'bridge' && Math.hypot(px - c.x, pz - c.z) <= c.halfSpan + hw);
            if (!bridge) continue;
            kind[i] = KIND.BRIDGE; fixedY[i] = bridge.deckY; roadIndex[i] = index + 1; roadDist[i] = d;
            continue;
          }
          roadIndex[i] = index + 1; roadDist[i] = d;
          if (kind[i] !== KIND.FORD && kind[i] !== KIND.PLATEAU && kind[i] !== KIND.PAD) kind[i] = KIND.ROAD;
          fixed[i] = 1;
          fixedY[i] = kind[i] === KIND.FORD ? FORD_BED : level[k];
          raw[i] = fixedY[i];
        } else if (!fixed[i] && kind[i] !== KIND.RIVER) {
          raw[i] = lerp(level[k], raw[i], smoothstep(hw, hw + shoulder, d));
        }
      }
    }
    roads.push({ ...plan, index: index + 1, length, step, level });
  });

  // 5. Drivability clamp: neighbour steps <= 1 everywhere except the
  // mountains outside the combat area and authored rock outcrops. All values
  // are whole voxels, so the envelopes live in Int16 with +-SENTINEL as
  // "unbounded" (relax never moves a sentinel: it only compares +-1 steps).
  const active = new Uint8Array(N);
  for (let i = 0; i < N; i++) active[i] = kind[i] === KIND.RIVER || kind[i] === KIND.BRIDGE ? 0 : 1;
  const U = new Int16Array(N), L = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    U[i] = fixed[i] ? fixedY[i] : SENTINEL;
    L[i] = fixed[i] ? fixedY[i] : -SENTINEL;
  }
  relax(U, active, -1);
  relax(L, active, 1);
  // `raw` now holds the rounded natural relief; `heights` doubles as the
  // clamped ground before the lower envelope is applied.
  const natural = raw;
  const heights = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    natural[i] = Math.round(raw[i]);
    heights[i] = fixed[i] ? fixedY[i] : clamp(natural[i], L[i], U[i]);
  }
  relax(heights, active, -1);
  for (let i = 0; i < N; i++) heights[i] = active[i] ? Math.max(L[i], heights[i]) : (kind[i] === KIND.BRIDGE ? fixedY[i] : natural[i]);
  // Cliffs: mountains beyond the combat area and the authored outcrops keep
  // their full relief; they are the only steps of two or more voxels.
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const i = z * SX + x;
    if (!active[i] || fixed[i] || insideCombatArea(x + 0.5, z + 0.5)) continue;
    if (natural[i] > heights[i]) { heights[i] = natural[i]; kind[i] = KIND.CLIFF; }
  }
  for (const o of FRONTIER_OUTCROPS) {
    for (let z = Math.floor(o.z - o.r); z <= Math.ceil(o.z + o.r); z++) for (let x = Math.floor(o.x - o.r); x <= Math.ceil(o.x + o.r); x++) {
      const i = z * SX + x, px = x + 0.5, pz = z + 0.5, d = Math.hypot(px - o.x, pz - o.z);
      if (d >= o.r || !active[i] || fixed[i]) continue;
      const crag = Math.round(o.h * (1 - (d / o.r) ** 2) * (0.75 + 0.25 * valueNoise(px / 4, pz / 4, 91)));
      if (crag > 0) { heights[i] += crag; kind[i] = KIND.CLIFF; }
    }
  }
  // Pre-carved craters: shallow bowls on free ground and one voxel on pads.
  const crater = new Uint8Array(N);
  for (const c of FRONTIER_CRATERS) {
    for (let z = Math.floor(c.z - c.r - 2); z <= c.z + c.r + 2; z++) for (let x = Math.floor(c.x - c.r - 2); x <= c.x + c.r + 2; x++) {
      if (x < 0 || z < 0 || x >= SX || z >= SZ) continue;
      const i = z * SX + x, d = Math.hypot(x + 0.5 - c.x, z + 0.5 - c.z);
      if (d > c.r + 1.5 || roadIndex[i] || !active[i] || kind[i] === KIND.FORD || kind[i] === KIND.CLIFF) continue;
      if (d <= c.r) {
        const depth = c.scorch ? 0 : kind[i] === KIND.PAD ? (d < c.r * 0.6 ? 1 : 0) : (d < c.r * 0.45 ? 2 : 1);
        heights[i] -= depth; crater[i] = d < c.r * 0.7 ? 2 : 1;
      } else crater[i] = Math.max(crater[i], 1);
    }
  }
  // Water finds its level: dry cells below the river surface that touch the
  // river (the clamp can grade a ford's bank or road shoulder down to the ford
  // bed) are flooded too, so no water face ever stands over open ground.
  const wet = [];
  for (let i = 0; i < N; i++) if (water[i] && kind[i] !== KIND.BRIDGE) wet.push(i);
  while (wet.length) {
    const i = wet.pop(), x = i % SX;
    for (const j of [x > 0 ? i - 1 : -1, x < SX - 1 ? i + 1 : -1, i - SX, i + SX]) {
      if (j < 0 || j >= N || water[j] || kind[j] === KIND.BRIDGE || heights[j] >= RIVER.surfaceY) continue;
      water[j] = RIVER.surfaceY;
      wet.push(j);
    }
  }
  // Keep the bed under bridge decks for the generator.
  const ground = new Int16Array(N);
  for (let i = 0; i < N; i++) ground[i] = kind[i] === KIND.BRIDGE ? natural[i] : heights[i];

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

  // 7. Surfaces by slope, height, moisture and masks.
  const surface = new Uint8Array(N);
  // Area masks: 1..n forest index (burnt stands included), fields by index.
  const forestMask = new Uint8Array(N), fieldMask = new Uint8Array(N), padMask = new Uint8Array(N);
  // Woodland floors come from frontierWoodDensity(); only the burnt stand is masked here.
  FRONTIER_FORESTS.forEach((f, n) => {
    if (!f.burnt) return;
    const r = Math.max(f.rx, f.rz) * 1.2;
    for (let z = Math.max(0, Math.floor(f.z - r)); z <= Math.min(SZ - 1, Math.ceil(f.z + r)); z++)
      for (let x = Math.max(0, Math.floor(f.x - r)); x <= Math.min(SX - 1, Math.ceil(f.x + r)); x++)
        if (forestWeight(f, x + 0.5, z + 0.5) > (f.burnt ? 0 : 0.04)) forestMask[z * SX + x] = n + 1;
  });
  FRONTIER_FIELDS.forEach((f, n) => {
    for (let z = f.z0; z < f.z1; z++) for (let x = f.x0; x < f.x1; x++) fieldMask[z * SX + x] = n + 1;
  });
  FRONTIER_PADS.forEach((p, n) => {
    for (let z = Math.floor(p.z - p.radius); z <= Math.ceil(p.z + p.radius); z++)
      for (let x = Math.floor(p.x - p.radius); x <= Math.ceil(p.x + p.radius); x++)
        if (Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) <= p.radius) padMask[z * SX + x] = n + 1;
  });
  // Woodland floor density on a 2 m lattice (point-symmetric: 768 is even).
  const woodBlocks = new Float32Array((SX / 2) * (SZ / 2)).fill(-1);
  const woodAt = (x, z) => {
    const b = (z >> 1) * (SX / 2) + (x >> 1);
    if (woodBlocks[b] < 0) woodBlocks[b] = frontierWoodDensity((x | 1), (z | 1));
    return woodBlocks[b];
  };
  const slopeAt = (x, z) => {
    const h = heights[z * SX + x];
    const step = j => (kind[j] === KIND.RIVER ? 0 : Math.abs(heights[j] - h));
    return Math.max(step(z * SX + Math.min(SX - 1, x + 1)), step(z * SX + Math.max(0, x - 1)),
      step(Math.min(SZ - 1, z + 1) * SX + x), step(Math.max(0, z - 1) * SX + x));
  };
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const i = z * SX + x, px = x + 0.5, pz = z + 0.5, h = heights[i];
    const k = kind[i];
    if (k === KIND.RIVER) {
      // Islands: gravel and sand rims around a grassy, reedy crown.
      const n = valueNoise(px / 4, pz / 4, 199);
      surface[i] = island[i] === 2 ? (n > 0.15 ? DRY_GRASS : MEADOW) : island[i] ? (n > 0 ? GRAVEL : SAND) : MC_WATER;
      continue;
    }
    if (k === KIND.BRIDGE) { surface[i] = CONCRETE; continue; }
    if (k === KIND.FORD || water[i]) { surface[i] = MC_WATER; continue; }
    if (roadIndex[i]) { surface[i] = roads[roadIndex[i] - 1].kind === 'paved' ? ASPHALT : GRAVEL; continue; }
    const slope = slopeAt(x, z);
    if (k === KIND.CLIFF || slope >= 2) { surface[i] = ((h / 3) | 0) % 2 ? STONE : DUST_ROCK; continue; }
    if (crater[i] === 2) { surface[i] = SCORCHED_EARTH; continue; }
    if (crater[i] === 1) { surface[i] = DIRT; continue; }
    if (k === KIND.PAD && padMask[i]) { surface[i] = padSurface(FRONTIER_PADS[padMask[i] - 1], px, pz); continue; }
    const dr = Math.abs(riverOffset(px, pz)), half = riverHalfAt(pz);
    if (h <= RIVER.surfaceY + 1 && dr <= half + 9) { surface[i] = valueNoise(px / 9, pz / 9, 133) > -0.1 ? GRAVEL : SAND; continue; }
    if (dr <= half + 2) { surface[i] = valueNoise(px / 8, pz / 8, 135) > 0.25 ? MC_CLAY : MUD; continue; }
    if (dr <= half + 6) {
      const n = valueNoise(px / 10, pz / 10, 131);
      surface[i] = n > 0.35 ? MC_CLAY : n > -0.2 ? MUD : MEADOW;
      continue;
    }
    if (!insideCombatArea(px, pz) || h >= 44) {
      // Restricted rim and mountains: bare rock, scree and windblown tufts.
      const n = valueNoise(px / 9, pz / 9, 137);
      surface[i] = n > 0.3 ? GRAVEL : n < -0.35 ? DUST_ROCK : n < -0.15 && h < 46 ? DRY_GRASS : STONE;
      continue;
    }
    if (forestMask[i]) { surface[i] = valueNoise(px / 6, pz / 6, 149) > -0.2 ? SCORCHED_EARTH : DRY_GRASS; continue; }
    const field = fieldMask[i] ? FRONTIER_FIELDS[fieldMask[i] - 1] : null;
    if (field) {
      const row = Math.floor((field.rows === 'x' ? pz - field.z0 : px - field.x0) / 6);
      surface[i] = field.crop === 'wheat' ? (row % 4 === 3 ? DIRT : FIELD_WHEAT) : (row % 2 ? DIRT : MUD);
      continue;
    }
    if (k !== KIND.PLATEAU && woodAt(x, z) > 0.4) {
      surface[i] = PINE_NEEDLES;
      continue;
    }
    if (k === KIND.PLATEAU) {
      // Hardstand gravel and worn earth between the grass of the airfield.
      const n = valueNoise(px / 18, pz / 18, 151);
      surface[i] = n > 0.4 ? GRAVEL : n < -0.45 ? DIRT : n > 0 ? DRY_GRASS : MEADOW;
      continue;
    }
    // Shell-churned ground in the contested middle around C and D.
    const shelled = Math.max(1 - Math.hypot(px - 384, pz - 384) / 110, 1 - Math.hypot(px - 486, pz - 262) / 70);
    if (shelled > 0) {
      const n = valueNoise(px / 7, pz / 7, 167);
      if (n > 0.62 - shelled * 0.5) { surface[i] = n > 0.8 - shelled * 0.3 ? SCORCHED_EARTH : MUD; continue; }
    }
    // Worn ground: cart tracks, bare patches and molehills.
    if (valueNoise(px / 11, pz / 11, 173) > 0.58 || (slope === 1 && valueNoise(px / 3, pz / 3, 163) > 0.72)) { surface[i] = DIRT; continue; }
    // Moist river meadows give way to sun-dried grass on the higher ground.
    const moisture = 0.85 - smoothstep(20, 170, dr) * 0.9 - (h - 26) * 0.07 + 0.55 * fbm(px / 70, pz / 70, 3, 157);
    surface[i] = moisture > -0.16 ? MEADOW : DRY_GRASS;
  }

  return {
    sx: SX, sz: SZ, heights, ground, surface, drivable, water, kind, roadIndex, crater,
    roads: roads.map(r => ({ id: r.id, kind: r.kind, width: r.width, index: r.index, points: r.points, length: r.length, step: r.step, level: r.level })),
  };
}

function padSurface(pad, x, z) {
  const d = Math.hypot(x - pad.x, z - pad.z);
  const n = valueNoise(x / 6, z / 6, 171);
  switch (pad.site) {
    case 'farm': return d < 14 ? DIRT : n > 0.25 ? DIRT : MEADOW;
    case 'village': return d < 15 ? MC_COBBLE : n > 0.3 ? GRAVEL : MEADOW;
    case 'bridge': return n > 0.35 ? GRAVEL : n > -0.2 ? DRY_GRASS : DIRT;
    case 'bunkers': return n > 0.2 ? DIRT : n > -0.3 ? MUD : DRY_GRASS;
    case 'works': return d < 16 ? CONCRETE : n > 0 ? GRAVEL : DIRT;
    default: return MEADOW;
  }
}

let built = null;
/** Memoised terrain build (pure: the same arrays on every call). */
export function frontierTerrain() {
  built ??= buildTerrain();
  return built;
}

/** Lazy view: the heightfield is built on first access, never at import. */
export const FRONTIER_TERRAIN = Object.freeze({
  get heights() { return frontierTerrain().heights; },
  get surface() { return frontierTerrain().surface; },
  get drivable() { return frontierTerrain().drivable; },
  get water() { return frontierTerrain().water; },
  get ground() { return frontierTerrain().ground; },
  get kind() { return frontierTerrain().kind; },
  get roads() { return frontierTerrain().roads; },
  sx: SX, sz: SZ,
});

const cellIndex = (x, z) => clamp(Math.floor(z), 0, SZ - 1) * SX + clamp(Math.floor(x), 0, SX - 1);

/** Standing height (y of the first free voxel above the terrain) at x, z. */
export function frontierSurfaceY(x, z) {
  return frontierTerrain().heights[cellIndex(x, z)] + 1;
}
/** Top terrain voxel y at x, z (river bed, ground, road or bridge deck). */
export function frontierTopY(x, z) {
  return frontierTerrain().heights[cellIndex(x, z)];
}
/** Block id of the terrain top at x, z (MC_WATER on open water and fords). */
export function frontierSurfaceBlock(x, z) {
  return frontierTerrain().surface[cellIndex(x, z)];
}
/** Water surface y at x, z, or 0 on dry ground. */
export function frontierWaterY(x, z) {
  return frontierTerrain().water[cellIndex(x, z)];
}
export function frontierDrivable(x, z) {
  return frontierTerrain().drivable[cellIndex(x, z)] === 1;
}
