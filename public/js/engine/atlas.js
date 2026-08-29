// Procedural block-texture atlas: 256x256 canvas, 16x16 grid of 16px tiles.
// Every pixel is a pure function of its tile-local coordinates driven by
// integer-hash wobble (no Math.random anywhere) so the sheet is bit-identical
// on every boot and fully testable headless without a canvas.

import * as THREE from '../vendor/three.module.js';
import {
  AIR, GRASS, DIRT, STONE, SAND, WOOD, LEAVES,
  CONCRETE, METAL, ACCENT, PLANK, GLASS, PALE, RUST, BRICK,
} from '../../../shared/worlddata.js';

export const ATLAS_SIZE = 256;
export const TILE_PX = 16;
export const GRID = ATLAS_SIZE / TILE_PX;

/** Stable slot indices on the sheet. Face maps elsewhere reference these names. */
export const TILE = {
  AIR_DEBUG: 0, GRASS_TOP: 1, GRASS_SIDE: 2, DIRT: 3, STONE: 4, SAND: 5,
  WOOD_BARK: 6, WOOD_RINGS: 7, LEAVES: 8, CONCRETE: 9, METAL: 10,
  ACCENT: 11, PLANK: 12, GLASS: 13, PALE: 14, RUST: 15, BRICK: 16,
};

/** Deterministic integer wobble -> 0..k-1. The atlas' only "randomness". */
export function wob(x, y, salt, k) {
  const v = (x * 7 + y * 13 + salt * 31) % k;
  return v < 0 ? v + k : v;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

// ------------------------------------------------------------------ painters
// Each painter is a pure (x, y) -> [r, g, b, a] over one 16px tile.

function airDebug(x, y) {
  return (((x >> 2) + (y >> 2)) & 1) ? [34, 34, 38, 255] : [255, 0, 222, 255];
}

function grassTop(x, y) {
  const n1 = wob(x, y, 1, 31);
  const n2 = wob(x, y, 2, 17);
  let r = 74 + (n1 & 15);
  let g = 134 + (n2 & 15) + ((n1 >> 2) & 7);
  let b = 44 + (n1 & 7);
  if (wob(x, y, 3, 53) < 4) { r = r * 0.82 | 0; g = g * 0.85 | 0; b = b * 0.8 | 0; } // damp patches
  if (wob(x, y, 4, 37) < 3) { r = 122; g = 188; b = 84; }                            // blade flecks
  return [r, g, b, 255];
}

function dirtPix(x, y) {
  const n = wob(x, y, 5, 43);
  let r = 116 + (n & 19);
  let g = 82 + ((n >> 1) & 13);
  let b = 56 + (n & 7);
  if (wob(x, y, 6, 41) < 3) { r = 148; g = 136; b = 122; }  // pebbles
  if (((x + y) & 1) === 0) { r -= 6; g -= 5; b -= 4; }      // fine grain
  return [r, g, b, 255];
}

/** Grass side = dirt with a ragged green lip drooping over the top edge. */
function grassSide(x, y) {
  const lip = 3 + wob(x, 0, 9, 3);           // fringe depth 3..5 per column
  if (y < lip - 1) {
    const p = grassTop(x, y);
    return [p[0] * 0.92 | 0, p[1] * 0.94 | 0, p[2] * 0.9 | 0, 255];
  }
  if (y < lip) return [56, 104, 40, 255];    // dark fringe underside
  return dirtPix(x, y);
}

function stone(x, y) {
  const n = wob(x >> 1, y >> 1, 7, 71) + wob(x, y, 8, 47);
  let v = 106 + (n / 118 * 42) | 0;
  if (wob(x, 0, 10, 23) < 2) v -= 12;        // faint vertical banding
  if (wob(x, y, 9, 191) === 0) v -= 34;      // hairline cracks
  return [v, v + 2, v + 5, 255];
}

function sand(x, y) {
  const n = wob(x, y, 11, 29);
  let r = 210 + (n & 15);
  let g = 194 + ((n >> 1) & 13);
  let b = 150 + (n & 9);
  if (((x ^ y) & 1) === 0 && wob(x, y, 12, 7) < 2) { r = 230; g = 214; b = 172; } // dither sparkle
  if (wob(x, y, 13, 59) < 3) { r -= 24; g -= 22; b -= 20; }
  return [r, g, b, 255];
}

function woodBark(x, y) {
  const streak = wob(x, 0, 14, 13);
  let r = 104 + (streak & 7) * 4;
  let g = 74 + (streak & 7) * 3;
  let b = 46 + (streak & 3) * 3;
  if (((y * 5 + wob(x, y, 15, 3)) % 16) < 1) { r -= 26; g -= 20; b -= 14; } // broken rings
  if (wob(x, y, 16, 67) < 2) { r = 62; g = 42; b = 26; }                    // knots
  return [r, g, b, 255];
}

function woodRings(x, y) {
  const dx = x - 7.5, dy = y - 7.5;
  const d = Math.sqrt(dx * dx + dy * dy) + wob(x, y, 17, 5) * 0.08;
  const ring = d * 1.9 | 0;
  const dark = ring & 1;
  let r = dark ? 148 : 174;
  let g = dark ? 108 : 132;
  let b = dark ? 64 : 82;
  if (d < 1.2) { r = 96; g = 68; b = 40; }       // centre pith
  if (ring > 13) { r = 120; g = 88; b = 54; }    // bark rim
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

/** Two-green clusters, strong per-pixel variance, ~15% alpha-0 punch-through. */
function leaves(x, y) {
  if (wob(x, y, 19, 100) < 15) return [0, 0, 0, 0];
  const cluster = wob(x >> 2, y >> 2, 20, 7) & 1;
  const v = wob(x, y, 21, 61) - 30;              // +/-30 swing
  const base = cluster ? [44, 108, 36] : [80, 148, 56];
  return [
    clamp255(base[0] + v),
    clamp255(base[1] + (v >> 1)),
    clamp255(base[2] + (v >> 2)),
    255,
  ];
}

function concrete(x, y) {
  const m = wob(x >> 1, y >> 1, 22, 37) - 18;    // coarse mottle
  let v = 168 + m + (wob(x, y, 23, 11) - 5);
  if (x === 0 || y === 0) v += 34;               // bevel highlight top/left
  if (x === 15 || y === 15) v -= 38;             // bevel shadow bottom/right
  return [clamp255(v), clamp255(v + 2), clamp255(v + 4), 255];
}

function metal(x, y) {
  const panel = ((x >> 3) + (y >> 3)) & 1;
  let r = 106 + panel * 7, g = 121 + panel * 8, b = 138 + panel * 9;
  const lx = x & 7, ly = y & 7;
  if (lx === 0 || ly === 0) { r = 62; g = 72; b = 86; }          // cross seams
  else if (lx === 1 || ly === 1) { r += 14; g += 14; b += 14; }  // seam catch-light
  if (Math.abs(lx - 6) <= 1 && Math.abs(ly - 2) <= 1) {          // corner bolt per panel
    if (Math.abs(lx - 6) === 1 || Math.abs(ly - 2) === 1) { r = 52; g = 60; b = 74; }
    else { r = 186; g = 198; b = 212; }
  }
  return [r, g, b, 255];
}

function accent(x, y) {
  let r = 224, g = 122, b = 30;
  if ((((x + y) >> 2) & 1) === 0) { r -= 16; g -= 8; b -= 4; }   // subtle hazard stripes
  const m = wob(x >> 1, y >> 1, 24, 21) - 10;
  r += m >> 1; g += m >> 1; b += m >> 2;
  if (x === 0 || y === 0) { r += 22; g += 14; b += 6; }
  if (x === 15 || y === 15) { r -= 30; g -= 18; b -= 10; }
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

function plank(x, y) {
  const board = (y >> 2) & 3;
  const tone = wob(board, 0, 25, 11);
  let r = 168 + tone * 4 - (board & 1) * 10;
  let g = 122 + tone * 3 - (board & 1) * 8;
  let b = 78 + tone * 2;
  if ((y & 3) === 3) { r = 104; g = 72; b = 44; }                // board seam gap
  else {
    r += wob(x, y, 26, 17) - 8;                                  // fiber grain
    g += wob(x, y, 27, 13) - 6;
  }
  if ((x === 2 || x === 13) && ((y + board * 3) % 9) === 2) { r = 150; g = 150; b = 154; } // nails
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

/** Clear bluish pane: uniform alpha 200 base, diagonal shine streaks, bright frame. */
function glass(x, y) {
  if (x === 0 || x === 15 || y === 0 || y === 15) return [222, 240, 250, 235];
  let r = 165, g = 202, b = 224;
  let a = 200;
  const d = (x + y) % 16;
  if (d < 3) { r += 55; g += 45; b += 32; a = Math.min(255, a + 30); }     // shine streak
  else if ((d + 6) % 16 < 2) { r += 30; g += 24; b += 16; }                // echo streak
  return [clamp255(r), clamp255(g), clamp255(b), a];
}

function pale(x, y) {
  const m = wob(x >> 1, y >> 1, 28, 29) - 14;
  let v = 206 + m + (wob(x, y, 29, 9) - 4);
  if (wob(x, y, 30, 73) < 2) v -= 26;            // worn scuffs
  if (x === 0 || y === 0) v += 18;
  if (x === 15 || y === 15) v -= 24;
  return [clamp255(v), clamp255(v + 1), clamp255(v + 2), 255];
}

/** Weathered corrugated steel: vertical ridges every 4px, orange-brown rust, dark seams. */
function rust(x, y) {
  const ridge = x & 3;
  let r = 122, g = 112, b = 118;
  if (ridge === 0) { r -= 34; g -= 30; b -= 28; }        // ridge valley shadow
  else if (ridge === 1) { r += 22; g += 22; b += 24; }   // ridge catch-light
  const patch = wob(x >> 2, y >> 2, 31, 19);
  if (patch < 5) {                                       // rust bloom clusters
    r = 158 + patch * 6; g = 86 + patch * 4; b = 38;
  } else if (patch < 8) {                                // fading rust tint
    r += 26; g -= 8; b -= 14;
  }
  const grain = wob(x, y, 32, 15) - 7;
  r += grain; g += grain; b += grain >> 1;
  if (x === 0 || y === 0) { r += 12; g += 10; b += 10; }
  if (x === 15 || y === 15) { r -= 26; g -= 24; b -= 22; } // darker seam edge
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

/** Running-bond red masonry: offset mortar lines every 4-row course, per-brick variance. */
function brick(x, y) {
  const course = (y >> 2) & 7;
  const headOff = (course & 1) * 4;                     // half-brick stagger per course
  const mortar = (y & 3) === 3 || ((x + headOff) & 7) === 0;
  if (mortar) {
    const m = wob(x, y, 33, 9) - 4;
    return [clamp255(178 + m), clamp255(174 + m), clamp255(168 + m), 255];
  }
  // Per-brick identity: course row + staggered column bucket drives hue/value.
  const brickCol = ((x + headOff) >> 3) & 1;
  const tone = wob(brickCol, course, 34, 13);
  let r = 148 + tone * 3, g = 66 + tone * 2, b = 52;
  const grain = wob(x, y, 35, 13) - 6;
  r += grain; g += grain >> 1; b += grain >> 1;
  if ((y & 3) === 0) { r -= 18; g -= 10; b -= 8; }        // shadow under mortar above
  if (x === 0 || y === 0) { r += 10; g += 6; b += 4; }
  if (x === 15 || y === 15) { r -= 22; g -= 12; b -= 10; }
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

/** Tile-id -> painter registry. Keys are TILE slot values. */
export const TILE_PAINTERS = Object.freeze({
  [TILE.AIR_DEBUG]: airDebug,
  [TILE.GRASS_TOP]: grassTop,
  [TILE.GRASS_SIDE]: grassSide,
  [TILE.DIRT]: dirtPix,
  [TILE.STONE]: stone,
  [TILE.SAND]: sand,
  [TILE.WOOD_BARK]: woodBark,
  [TILE.WOOD_RINGS]: woodRings,
  [TILE.LEAVES]: leaves,
  [TILE.CONCRETE]: concrete,
  [TILE.METAL]: metal,
  [TILE.ACCENT]: accent,
  [TILE.PLANK]: plank,
  [TILE.GLASS]: glass,
  [TILE.PALE]: pale,
  [TILE.RUST]: rust,
  [TILE.BRICK]: brick,
});

// ------------------------------------------------------------- face mapping

/** Default blockId -> face-tile table. chunks.js consumes this exact table. */
export const DEFAULT_BLOCK_TILES = Object.freeze({
  [AIR]: { all: TILE.AIR_DEBUG },
  [GRASS]: { top: TILE.GRASS_TOP, bottom: TILE.DIRT, side: TILE.GRASS_SIDE },
  [DIRT]: { all: TILE.DIRT },
  [STONE]: { all: TILE.STONE },
  [SAND]: { all: TILE.SAND },
  [WOOD]: { top: TILE.WOOD_RINGS, bottom: TILE.WOOD_RINGS, side: TILE.WOOD_BARK },
  [LEAVES]: { all: TILE.LEAVES },
  [CONCRETE]: { all: TILE.CONCRETE },
  [METAL]: { all: TILE.METAL },
  [ACCENT]: { all: TILE.ACCENT },
  [PLANK]: { all: TILE.PLANK },
  [GLASS]: { all: TILE.GLASS },
  [PALE]: { all: TILE.PALE },
  [RUST]: { all: TILE.RUST },
  [BRICK]: { all: TILE.BRICK },
});

/**
 * Resolve the sheet tile for a block face.
 * face codes match chunks.js FACES order: 0:+X 1:-X 2:+Y(top) 3:-Y(bottom) 4:+Z 5:-Z.
 */
export function faceTile(blockId, face) {
  const m = DEFAULT_BLOCK_TILES[blockId] || DEFAULT_BLOCK_TILES[AIR];
  if (m.all !== undefined) return m.all;
  if (face === 2) return m.top;
  if (face === 3) return m.bottom !== undefined ? m.bottom : m.top;
  return m.side;
}

// --------------------------------------------------------------------- UVs

const EDGE_INSET = 0.5;                // atlas pixels; normalized exactly once below
const rectCache = new Array(GRID * GRID);

/**
 * Pure UV-space rect for a tile, half-texel-inset.
 * Returns {u0,v0,u1,v1} where v0 corresponds to the tile image TOP row and
 * u grows rightwards (callers map world-up faces onto v0).
 */
export function tileRect(tile) {
  let r = rectCache[tile];
  if (r !== undefined) return r;
  const pu0 = (tile % GRID) * TILE_PX;
  const pv0 = ((tile / GRID) | 0) * TILE_PX;
  const u0 = (pu0 + EDGE_INSET) / ATLAS_SIZE;
  const u1 = (pu0 + TILE_PX - EDGE_INSET) / ATLAS_SIZE;
  const vTopPx = pv0 + EDGE_INSET;
  const vBotPx = pv0 + TILE_PX - EDGE_INSET;
  r = { u0, u1, v0: 1 - vTopPx / ATLAS_SIZE, v1: 1 - vBotPx / ATLAS_SIZE };
  rectCache[tile] = r;
  return r;
}

// ---------------------------------------------------------------- assembly

/** Tiles excluded from the universal 1px darken ring (their own border IS the look). */
const NO_RING_DARKEN = new Set([TILE.AIR_DEBUG, TILE.GLASS]);
const RING_DARKEN = 0.78;

function paintSheet(data) {
  for (const key of Object.keys(TILE_PAINTERS)) {
    const tile = Number(key);
    const paint = TILE_PAINTERS[key];
    const col = (tile % GRID) * TILE_PX;
    const row = ((tile / GRID) | 0) * TILE_PX;
    for (let py = 0; py < TILE_PX; py++) {
      for (let px = 0; px < TILE_PX; px++) {
        const c = paint(px, py);
        const i = ((row + py) * ATLAS_SIZE + col + px) * 4;
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3];
      }
    }
    if (!NO_RING_DARKEN.has(tile)) {
      for (let p = 0; p < TILE_PX; p++) {
        darkenEdge(data, col + p, row); darkenEdge(data, col + p, row + TILE_PX - 1);
        darkenEdge(data, col, row + p); darkenEdge(data, col + TILE_PX - 1, row + p);
      }
    }
  }
}

function darkenEdge(data, px, py) {
  const i = (py * ATLAS_SIZE + px) * 4;
  data[i] *= RING_DARKEN; data[i + 1] *= RING_DARKEN; data[i + 2] *= RING_DARKEN;
}

/**
 * Paint every tile into a fresh canvas, wrap it in a THREE.CanvasTexture and
 * hand back the accessor surface the mesher/renderer needs.
 */
export function buildAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE);
  paintSheet(img.data);
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  let disposed = false;

  return {
    canvas,
    /** THREE.CanvasTexture configured for crisp voxel texels under minification. */
    texture() { return tex; },
    dispose() {
      if (disposed) return;
      disposed = true;
      tex.dispose();
    },
    /**
     * uvRect(tileIndex) -> sheet rect; uvRect(blockId, face) -> resolved face rect.
     * chunks.js passes TILE indices through its own FACE_MAP (aliases DEFAULT_BLOCK_TILES).
     */
    uvRect(blockIdOrTile, face) {
      return face === undefined
        ? tileRect(blockIdOrTile)
        : tileRect(faceTile(blockIdOrTile, face));
    },
    tileRect,
    faceTile,
  };
}
