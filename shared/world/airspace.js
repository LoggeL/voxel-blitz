// Airspace beyond the voxel map. Maps with aircraft (Frontier) let them fly
// past the map rectangle over an outer valley ("apron"): a deterministic,
// cell-terraced heightfield that the shared world state answers voxel queries
// from (state.js getBlock), so server physics, raycasts, cameras and the
// client's apron mesh all read the same ground. Infantry stay inside the map
// (the restricted-zone timer), aircraft inside the combat apron (their own
// out-of-bounds timer); `limit` is the physical edge of the world, where the
// voxel wall and the map-edge flight guidance take over.
//
// Distances are metres beyond the map rectangle (the Chebyshev gap, so the
// areas are rectangles with square corners). The apron is stored on an 8 m
// cell grid; past `fineBand` the cells pair up into 16 m terraces, so the far
// apron renders with a quarter of the faces.

import { AIR, DIRT, STONE, SAND, MC_WATER, MEADOW, DRY_GRASS, FIELD_WHEAT, PINE_NEEDLES, PINE_LEAVES, GRAVEL, DUST_ROCK } from './blocks.js';

export const AIRSPACE = Object.freeze({
  frontier: Object.freeze({
    /** Aircraft beyond this gap start the out-of-bounds countdown. */
    combat: 480,
    /** The voxel wall (and the hard flight guidance) stands at this gap. */
    limit: 800,
    /** Bots keep this far inside the combat apron. */
    botMargin: 120,
  }),
  // Redrock Canyon flies the same envelope over red desert badlands.
  redrock: Object.freeze({ combat: 480, limit: 800, botMargin: 120 }),
});

/** The airspace of a map, or null (no aircraft beyond the map). */
export function airspaceFor(mapId) {
  return AIRSPACE[mapId] ?? null;
}

/** Map rectangle grown by `gap` metres on every side. */
export function airspaceRect(dimensions, gap = 0) {
  return { minX: -gap, maxX: dimensions.sx + gap, minZ: -gap, maxZ: dimensions.sz + gap };
}

/** Chebyshev distance of x, z beyond the map rectangle (0 inside). */
export function gapBeyond(dimensions, x, z) {
  return Math.max(0, -x, x - dimensions.sx, -z, z - dimensions.sz);
}

const CELL = 8;
const FINE_BAND = 320;
/** The apron grid reaches this far past the limit (render margin under the mountains). */
const APRON_PAD = 64;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

function hash2(ix, iz, salt) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul((salt + 0x41505244) | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, z, salt) {
  const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(x0, z0, salt), b = hash2(x0 + 1, z0, salt), c = hash2(x0, z0 + 1, salt), d = hash2(x0 + 1, z0 + 1, salt);
  const top = a + (b - a) * sx, bottom = c + (d - c) * sx;
  return (top + (bottom - top) * sz) * 2 - 1;
}
function fbm(x, z, octaves, salt) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f + o * 17.31, z * f - o * 9.73, salt + o * 101) * amp;
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return sum / norm;
}

/** Apron surface kinds (render colours and the top voxel). */
export const APRON_KIND = Object.freeze({ MEADOW: 0, DRY: 1, FIELD: 2, FOREST: 3, ROCK: 4, SHORE: 5, WATER: 6, GRAVEL: 7, DESERT: 8, RED_ROCK: 9 });
const KIND_BLOCK = [MEADOW, DRY_GRASS, FIELD_WHEAT, PINE_LEAVES, STONE, SAND, SAND, GRAVEL, SAND, DUST_ROCK];

/**
 * Frontier's outer valley: the rim the map ends on (61 m) rolls down into a
 * highland of meadows, fields and pine woods around 45-75 m, cut by the river
 * that leaves the map north and south. Forest cells carry their canopy in the
 * ground height (solid, so a low pass through the woods is a crash).
 * `edge(x, z)` is the map's terrain top at the nearest edge cell.
 */
function frontierField(edge, river) {
  return (x, z, gap) => {
    let h = 54 + 13 * fbm(x / 310, z / 310, 4, 3) + 6 * fbm(x / 84, z / 84, 3, 7);
    const hill = fbm(x / 170, z / 170, 3, 11);
    if (hill > 0.15) h += (hill - 0.15) * 46;
    // The river leaves the map at both ends and keeps a broad valley.
    let water = 0, dr = Infinity;
    if (z < 0 || z > river.sz) {
      const out = z < 0 ? -z : z - river.sz;
      const centre = river.x + 46 * fbm(out / 260, z < 0 ? 1.5 : 7.5, 3, 19) * smooth(0, 160, out);
      dr = Math.abs(x - centre);
      const half = river.half + out * 0.03;
      const valley = smooth(half, half + 150, dr);
      h = river.bank + (h - river.bank) * valley;
      if (dr < half) { h = river.bed; water = river.surface; }
    }
    // Blend from the map's own edge into the outer valley.
    const top = edge(x, z) + 1, blend = smooth(0, 150, gap);
    h = top + (h - top) * blend;
    if (water && blend < 1) water = river.surface;
    h = Math.round(clamp(h, river.bed, 104));
    let kind;
    if (water && h < water) kind = APRON_KIND.WATER;
    else if (dr < river.half + 10 + gap * 0.03) kind = APRON_KIND.SHORE;
    else if (h > 86) kind = APRON_KIND.ROCK;
    else {
      const wood = fbm(x / 120, z / 120, 3, 29) + 0.25 * fbm(x / 30, z / 30, 2, 31);
      const farm = fbm(x / 150 + 40, z / 150, 2, 37);
      kind = wood > 0.12 && gap > 30 ? APRON_KIND.FOREST
        : farm > 0.3 && h < 70 ? APRON_KIND.FIELD
        : fbm(x / 60, z / 60, 2, 43) > 0.2 ? APRON_KIND.DRY : APRON_KIND.MEADOW;
    }
    // Canopy: 7-12 m of pine woods on the forest cells.
    const canopy = kind === APRON_KIND.FOREST ? 7 + Math.round(5 * (fbm(x / 22, z / 22, 2, 53) * 0.5 + 0.5)) : 0;
    return { h: h + canopy, kind, canopy, water: kind === APRON_KIND.WATER ? water : 0 };
  };
}

/**
 * Redrock Canyon's outer desert: the red rim the map ends on rolls out into
 * sand flats and gravel pavement around 45-60 m, broken by terraced mesas
 * (6 m benches, red rock) and cut by the river canyon that leaves the map
 * north (reservoir level) and south (stream level). No woods, no canopy.
 */
function redrockField(edge, river) {
  return (x, z, gap) => {
    let h = 48 + 9 * fbm(x / 290, z / 290, 4, 61) + 3 * fbm(x / 64, z / 64, 3, 67);
    const m = fbm(x / 180, z / 180, 3, 71) + 0.2 * fbm(x / 40, z / 40, 2, 73);
    let rock = false;
    if (m > 0.16) {
      const lift = Math.min(1, (m - 0.16) / 0.1);
      h += 38 * lift;
      h = Math.floor(h / 6) * 6 + Math.round(smooth(0.6, 1, (h % 6) / 6) * 6);
      rock = lift > 0.25;
    }
    let water = 0, dr = Infinity;
    if (z < 0 || z > river.sz) {
      const out = z < 0 ? -z : z - river.sz;
      const centre = river.x + 40 * fbm(out / 240, z < 0 ? 2.5 : 8.5, 3, 79) * smooth(0, 160, out);
      dr = Math.abs(x - centre);
      const half = river.half + out * 0.02;
      const surface = z < 0 ? river.north : river.south;
      // A canyon: steep red walls, the stream on a narrow floor.
      const wall = smooth(half + 4, half + 34, dr);
      if (wall < 1) { h = surface + 1 + (h - surface - 1) * wall; rock = rock || wall > 0.15; }
      if (dr < half) { h = surface - 2; water = surface; }
    }
    const top = edge(x, z) + 1, blend = smooth(0, 150, gap);
    h = top + (h - top) * blend;
    h = Math.round(clamp(h, river.bed, 104));
    let kind;
    if (water && h < water) kind = APRON_KIND.WATER;
    else if (dr < river.half + 6 + gap * 0.02) kind = APRON_KIND.SHORE;
    else if (rock || h > 82) kind = APRON_KIND.RED_ROCK;
    else {
      const n = fbm(x / 70, z / 70, 2, 83);
      kind = n > 0.28 ? APRON_KIND.GRAVEL : n < -0.3 ? APRON_KIND.DRY : APRON_KIND.DESERT;
    }
    return { h, kind, canopy: 0, water: kind === APRON_KIND.WATER ? water : 0 };
  };
}

const APRONS = new Map();

/**
 * The apron of `mapId` (memoised), or null. `edgeTop(x, z)` supplies the
 * map's terrain top at an in-map cell (Frontier: its pure terrain builder).
 * Returns { cell, origin, nx, nz, limit, combat, botMargin, top, height, kind, water, canopy,
 * groundAt(x, z), waterAt(x, z), kindAt(x, z), blockAt(x, y, z) } where
 * `height` is the first free y of each 8 m cell (canopy top on forest cells)
 * and `top` the highest of them.
 */
export function apronFor(mapId, dimensions, edgeTop) {
  const space = airspaceFor(mapId);
  if (!space || !dimensions || typeof edgeTop !== 'function') return null;
  const key = `${mapId}:${dimensions.sx}x${dimensions.sz}`;
  if (APRONS.has(key)) return APRONS.get(key);
  const { sx, sz } = dimensions;
  const reach = space.limit + APRON_PAD;
  const origin = -reach, nx = Math.ceil((sx + 2 * reach) / CELL), nz = Math.ceil((sz + 2 * reach) / CELL);
  const height = new Int16Array(nx * nz), kind = new Uint8Array(nx * nz), water = new Int16Array(nx * nz), canopy = new Uint8Array(nx * nz);
  const edge = (x, z) => edgeTop(clamp(Math.floor(x), 0, sx - 1), clamp(Math.floor(z), 0, sz - 1));
  const field = mapId === 'frontier'
    // Frontier's river leaves the map 38 m wide (riverHalfAt is 19 at both ends) over a
    // 4-5 m channel; `surface` is the first free y over the water, the map's water face (22).
    ? frontierField(edge, { x: sx / 2, sz, half: 19, bed: 17, surface: 22, bank: 30 })
    : mapId === 'redrock'
      ? redrockField(edge, { x: sx / 2, sz, half: 9, bed: 16, north: 26, south: 19 })
      : (x, z) => ({ h: edge(x, z) + 1, kind: APRON_KIND.MEADOW, canopy: 0, water: 0 });
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      let x0 = origin + ix * CELL, z0 = origin + iz * CELL;
      const gap = gapBeyond(dimensions, x0 + CELL / 2, z0 + CELL / 2);
      if (gap <= 0) continue;
      // Far cells pair into 16 m terraces: sample the pair's centre.
      let size = CELL;
      if (gap >= FINE_BAND) { size = CELL * 2; x0 = origin + Math.floor(ix / 2) * size; z0 = origin + Math.floor(iz / 2) * size; }
      const cx = x0 + size / 2, cz = z0 + size / 2;
      const cell = field(cx, cz, gapBeyond(dimensions, cx, cz));
      const i = iz * nx + ix;
      height[i] = cell.h; kind[i] = cell.kind; water[i] = cell.water; canopy[i] = cell.canopy;
    }
  }
  let top = 0;
  for (let i = 0; i < height.length; i++) if (height[i] > top) top = height[i];
  const index = (x, z) => {
    const ix = Math.floor((x - origin) / CELL), iz = Math.floor((z - origin) / CELL);
    return ix < 0 || iz < 0 || ix >= nx || iz >= nz ? -1 : iz * nx + ix;
  };
  const apron = {
    cell: CELL, fineBand: FINE_BAND, origin, nx, nz, limit: space.limit, combat: space.combat, botMargin: space.botMargin, top, height, kind, water, canopy,
    /** First free y of the apron ground at x, z (outside the map), or -1 off the grid. */
    groundAt(x, z) { const i = index(x, z); return i < 0 ? -1 : height[i]; },
    waterAt(x, z) { const i = index(x, z); return i < 0 ? 0 : water[i]; },
    kindAt(x, z) { const i = index(x, z); return i < 0 ? APRON_KIND.ROCK : kind[i]; },
    /** The voxel at an integer cell outside the map (inside the limit). */
    blockAt(x, y, z) {
      const i = index(x + 0.5, z + 0.5);
      if (i < 0) return STONE;
      const top = height[i];
      if (y >= top) return y < water[i] ? MC_WATER : AIR;
      const ground = top - canopy[i];
      if (y >= ground) return PINE_LEAVES;
      if (y === ground - 1) return canopy[i] ? PINE_NEEDLES : KIND_BLOCK[kind[i]];
      return y > ground - 4 ? DIRT : STONE;
    },
  };
  APRONS.set(key, apron);
  return apron;
}
