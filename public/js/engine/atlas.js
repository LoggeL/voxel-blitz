// Procedural block-texture atlas: 256x256 canvas, 16x16 grid of 16px tiles.
// Every pixel is a pure function of its tile-local coordinates driven by
// integer-hash wobble (no Math.random anywhere) so the sheet is bit-identical
// on every boot and fully testable headless without a canvas.

import * as THREE from '../vendor/three.module.js';
import {
  AIR, BEDROCK, GRASS, DIRT, STONE, SAND, WOOD, LEAVES,
  CONCRETE, METAL, ACCENT, PLANK, GLASS, PALE, RUST, BRICK,
  YELLOW_SIDING, TEAL_SIDING, ASPHALT, ROOF, BUS_YELLOW, TRUCK_RED,
  DUST_SANDSTONE, DUST_PLASTER, DUST_ROCK, DUST_FLOOR,
  DUST_TRIM, DUST_TILE, DUST_CRATE, DUST_WOOD,
  MC_GRASS, MC_DIRT, MC_STONE, MC_COBBLE, MC_MOSSY, MC_SAND, MC_GRAVEL, MC_CLAY,
  MC_LOG, MC_LEAVES, MC_PLANKS, MC_GLASS, MC_BRICK, MC_BOOKSHELF, MC_WOOL_WHITE,
  MC_WOOL_RED, MC_IRON, MC_GOLD, MC_DIAMOND, MC_DIAMOND_ORE, MC_COAL_ORE,
  MC_OBSIDIAN, MC_NETHERRACK, MC_GLOWSTONE, MC_CLOUD, MC_CACTUS, MC_CHEST,
  MC_FURNACE, MC_CRAFTING, MC_TNT, MC_WATER, MC_LAVA, MC_PORTAL, MC_GHOST_SOLID,
  POOL_TILE_BLUE, POOL_TILE_WHITE, POOL_FLOOR, SLIDE_BLUE, SLIDE_YELLOW, POOL_PANEL,
  BARRICADE,
  BB_SAND, BB_CORAL, BB_PINEAPPLE, BB_PINE_LEAF, BB_KELP, BB_MOAI, BB_ROCK, BB_HULL, BB_CHUM, BB_ROAD,
} from '../../../shared/worlddata.js';

export const ATLAS_SIZE = 256;
export const TILE_PX = 16;
export const GRID = ATLAS_SIZE / TILE_PX;

/** Stable slot indices on the sheet. Face maps elsewhere reference these names. */
export const TILE = {
  YELLOW_SIDING: 17, TEAL_SIDING: 18, ASPHALT: 19, ROOF: 20, BUS_YELLOW: 21, TRUCK_RED: 22,
  BEDROCK: 31,
  AIR_DEBUG: 0, GRASS_TOP: 1, GRASS_SIDE: 2, DIRT: 3, STONE: 4, SAND: 5,
  WOOD_BARK: 6, WOOD_RINGS: 7, LEAVES: 8, CONCRETE: 9, METAL: 10,
  ACCENT: 11, PLANK: 12, GLASS: 13, PALE: 14, RUST: 15, BRICK: 16,
  DUST_SANDSTONE: 23, DUST_PLASTER: 24, DUST_ROCK: 25, DUST_FLOOR: 26,
  DUST_TRIM: 27, DUST_TILE: 28, DUST_CRATE: 29, DUST_WOOD: 30,
  // Minecraft B5 block faces (slots 32 to 37 belonged to the retired Substation).
  MC_GRASS_TOP: 32, MC_GRASS_SIDE: 33, MC_DIRT: 34, MC_STONE: 35, MC_COBBLE: 36, MC_MOSSY: 37,
  MC_SAND: 38, MC_GRAVEL: 39, MC_CLAY: 40, MC_LOG_SIDE: 41, MC_LOG_TOP: 42, MC_LEAVES: 43,
  MC_PLANKS: 44, MC_GLASS: 45, MC_BRICK: 46, MC_BOOKSHELF: 47, MC_WOOL_WHITE: 48, MC_WOOL_RED: 49,
  MC_IRON: 50, MC_GOLD: 51, MC_DIAMOND: 52, MC_DIAMOND_ORE: 53, MC_COAL_ORE: 54, MC_OBSIDIAN: 55,
  MC_NETHERRACK: 56, MC_GLOWSTONE: 57, MC_CLOUD: 58, MC_CACTUS_SIDE: 59, MC_CACTUS_TOP: 60,
  MC_CHEST_SIDE: 61, MC_CHEST_TOP: 62, MC_FURNACE_SIDE: 63, MC_FURNACE_TOP: 64, MC_CRAFT_SIDE: 65,
  MC_CRAFT_TOP: 66, MC_TNT_SIDE: 67, MC_TNT_TOP: 68, MC_WATER: 69, MC_LAVA: 70, MC_PORTAL: 71,
  // Leith Waterworld finishes.
  POOL_TILE_BLUE: 72, POOL_TILE_WHITE: 73, POOL_FLOOR: 74, SLIDE_BLUE: 75, SLIDE_YELLOW: 76, POOL_PANEL: 77,
  // Bastion sandbag barricade (walls and sandbag lines share one block).
  BARRICADE: 78,
  // Per-map surfaces: lighter armoured concrete for BEDROCK streets and walls,
  // and the boundary skin (ribbed cladding, steel pilasters, hazard kick band).
  ARMOR_CONCRETE: 79, FACADE_PANEL: 80, FACADE_JOINT: 81, FACADE_PILLAR: 82, FACADE_BASE: 83,
  // Bikini Bottom cartoon seafloor materials.
  BB_SAND: 84, BB_CORAL: 85, BB_PINEAPPLE: 86, BB_PINE_LEAF: 87, BB_KELP: 88,
  BB_MOAI: 89, BB_ROCK: 90, BB_HULL: 91, BB_CHUM: 92, BB_ROAD: 93,
  // Bikini Bottom's per-map GLASS remap: a clean pane with no diagonal streaks.
  BB_DOME_GLASS: 94,
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

// Tile-local hash and smooth value noise. The lattice wraps at the tile edge,
// so low-frequency mottling never shows a seam where two blocks meet.
function grain(x, y, salt, range) {
  let value = Math.imul(x + 17, 374761393) ^ Math.imul(y + 29, 668265263) ^ Math.imul(salt, 1274126177);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) % range;
}

function tileNoise(x, y, cell, salt) {
  const period = TILE_PX / cell;
  const gx = x / cell, gy = y / cell;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const at = (ix, iy) => grain(((ix % period) + period) % period, ((iy % period) + period) % period, salt, 1024) / 1023;
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** Two octaves of tile-wrapped mottle in -1..1. */
function mottle(x, y, salt) {
  return (tileNoise(x, y, 8, salt) - 0.5) * 1.3 + (tileNoise(x, y, 4, salt + 1) - 0.5) * 0.7;
}

function grassTop(x, y) {
  const m = mottle(x, y, 1);
  const g = grain(x, y, 2, 17) - 8;
  let r = 78 + m * 10 + (g >> 1);
  let gr = 140 + m * 14 + g;
  let b = 47 + m * 6 + (g >> 2);
  if (grain(x, y, 3, 29) < 2) { r *= 0.8; gr *= 0.84; b *= 0.78; }                 // damp shade
  if (grain(x, y, 4, 23) < 2) { r = 118 + m * 8; gr = 184 + m * 8; b = 80; }        // blade flecks
  return [clamp255(r), clamp255(gr), clamp255(b), 255];
}

function dirtPix(x, y) {
  const m = mottle(x, y, 5);
  const g = grain(x, y, 6, 19) - 9;
  let r = 120 + m * 12 + g;
  let gr = 86 + m * 9 + (g * 0.7);
  let b = 58 + m * 6 + (g >> 1);
  if (grain(x, y, 7, 37) < 2) { r = 146; gr = 134; b = 120; }  // pebbles
  return [clamp255(r), clamp255(gr), clamp255(b), 255];
}

/** Grass side = dirt with a ragged green lip drooping over the top edge. */
function grassSide(x, y) {
  const lip = 3 + grain(x, 0, 9, 3);         // fringe depth 3..5 per column
  if (y < lip - 1) {
    const p = grassTop(x, y);
    return [p[0] * 0.92 | 0, p[1] * 0.94 | 0, p[2] * 0.9 | 0, 255];
  }
  if (y < lip) return [60, 106, 42, 255];    // dark fringe underside
  return dirtPix(x, y);
}

function stone(x, y) {
  const m = mottle(x, y, 7);
  let v = 124 + m * 14 + (grain(x, y, 8, 13) - 6);
  if (tileNoise(x, y, 2, 10) > 0.86) v -= 12;             // darker flecks
  if (grain(x, y, 9, 97) === 0) v -= 24;                   // hairline pits
  return [clamp255(v), clamp255(v + 2), clamp255(v + 5), 255];
}

// Dense charcoal strata with pale mineral seams distinguish the world foundation.
function bedrock(x, y) {
  const band = (y + ((x >> 2) & 1)) % 6;
  const g = grain(x, y, 93, 15);
  const seam = band === 0;
  const value = seam ? 80 + g : 30 + g + (band === 1 ? 10 : 0) + mottle(x, y, 94) * 6;
  return [clamp255(value), clamp255(value + 5), clamp255(value + 12), 255];
}

function sand(x, y) {
  const m = mottle(x, y, 11);
  const g = grain(x, y, 12, 13) - 6;
  let r = 214 + m * 9 + g;
  let gr = 198 + m * 8 + g;
  let b = 154 + m * 6 + (g >> 1);
  if (grain(x, y, 13, 31) < 2) { r += 14; gr += 14; b += 12; }   // sparkle
  if (grain(x, y, 14, 43) < 2) { r -= 22; gr -= 20; b -= 18; }   // grit
  return [clamp255(r), clamp255(gr), clamp255(b), 255];
}

function woodBark(x, y) {
  const streak = grain(x, 0, 14, 8);
  let r = 104 + streak * 4 + mottle(x, y, 15) * 6;
  let g = 74 + streak * 3;
  let b = 46 + (streak & 3) * 3;
  if (((y * 5 + grain(x, y, 15, 3)) % 16) < 1) { r -= 26; g -= 20; b -= 14; } // broken rings
  if (grain(x, y, 16, 67) < 2) { r = 62; g = 42; b = 26; }                    // knots
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

function woodRings(x, y) {
  const dx = x - 7.5, dy = y - 7.5;
  const d = Math.sqrt(dx * dx + dy * dy) + grain(x, y, 17, 5) * 0.08;
  const ring = d * 1.9 | 0;
  const dark = ring & 1;
  let r = dark ? 148 : 174;
  let g = dark ? 108 : 132;
  let b = dark ? 64 : 82;
  if (d < 1.2) { r = 96; g = 68; b = 40; }       // centre pith
  if (ring > 13) { r = 120; g = 88; b = 54; }    // bark rim
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

/** Mottled leaf clusters with scattered holes, without repeating diagonal bands. */
function leaves(x, y) {
  // An invertible byte shuffle distributes exactly 38 cutouts over the tile.
  let grain = x + y * 16;
  grain ^= grain >> 4;
  grain = (grain * 157) & 255;
  grain ^= grain >> 3;
  grain = (grain * 109) & 255;
  if (grain < 38) return [0, 0, 0, 0];
  const cluster = ((x >> 1) * 13 ^ (y >> 1) * 23 ^ ((x + y) >> 2) * 7) % 3;
  const shade = (grain % 15) - 7;
  const base = [[42, 94, 35], [55, 114, 43], [70, 134, 51]][cluster];
  return [base[0] + shade, base[1] + shade, base[2] + (shade >> 1), 255];
}

// Poured concrete reads as one continuous slab: cloudy mottle, fine aggregate
// and the odd pore, with no painted bevel. Convex block edges get their
// highlight from the terrain shader instead, so flat floors carry no grid.
function concrete(x, y) {
  const m = mottle(x, y, 22);
  let v = 170 + m * 11 + (grain(x, y, 23, 9) - 4);
  if (grain(x, y, 24, 61) === 0) v -= 16;        // pores
  if (tileNoise(x, y, 2, 25) > 0.9) v += 7;      // lighter aggregate
  return [clamp255(v), clamp255(v + 2), clamp255(v + 4), 255];
}

function metal(x, y) {
  const panel = ((x >> 3) + (y >> 3)) & 1;
  const m = mottle(x, y, 26) * 4;
  let r = 106 + panel * 7 + m, g = 121 + panel * 8 + m, b = 138 + panel * 9 + m;
  const lx = x & 7, ly = y & 7;
  if (lx === 0 || ly === 0) { r = 62; g = 72; b = 86; }          // cross seams
  else if (lx === 1 || ly === 1) { r += 14; g += 14; b += 14; }  // seam catch-light
  if (Math.abs(lx - 6) <= 1 && Math.abs(ly - 2) <= 1) {          // corner bolt per panel
    if (Math.abs(lx - 6) === 1 || Math.abs(ly - 2) === 1) { r = 52; g = 60; b = 74; }
    else { r = 186; g = 198; b = 212; }
  }
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

function accent(x, y) {
  let r = 224, g = 122, b = 30;
  if ((((x + y) >> 2) & 1) === 0) { r -= 12; g -= 6; b -= 3; }   // subtle hazard stripes
  const m = mottle(x, y, 27) * 8;
  const g2 = grain(x, y, 28, 7) - 3;
  r += m + g2; g += m * 0.6 + g2; b += m * 0.3;
  if (grain(x, y, 29, 53) === 0) { r -= 40; g -= 26; b -= 10; }  // paint chips
  if (x === 0 || y === 0) { r += 10; g += 6; b += 3; }
  if (x === 15 || y === 15) { r -= 14; g -= 9; b -= 5; }
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

function plank(x, y) {
  const board = (y >> 2) & 3;
  const tone = grain(board, 0, 25, 11);
  let r = 168 + tone * 4 - (board & 1) * 10;
  let g = 122 + tone * 3 - (board & 1) * 8;
  let b = 78 + tone * 2;
  if ((y & 3) === 3) { r = 104; g = 72; b = 44; }                // board seam gap
  else {
    const fiber = tileNoise(x, y * 4 + board * 5, 4, 26) - 0.5;  // stretched grain
    r += fiber * 22 + grain(x, y, 27, 7) - 3;
    g += fiber * 16;
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
  const m = mottle(x, y, 28);
  let v = 208 + m * 9 + (grain(x, y, 29, 7) - 3);
  if (grain(x, y, 30, 73) < 2) v -= 18;          // worn scuffs
  return [clamp255(v), clamp255(v + 1), clamp255(v + 2), 255];
}

/** Weathered corrugated steel: vertical ridges every 4px, orange-brown rust, dark seams. */
function rust(x, y) {
  const ridge = x & 3;
  let r = 122, g = 112, b = 118;
  if (ridge === 0) { r -= 34; g -= 30; b -= 28; }        // ridge valley shadow
  else if (ridge === 1) { r += 22; g += 22; b += 24; }   // ridge catch-light
  const bloom = tileNoise(x, y, 4, 31);
  if (bloom > 0.7) {                                     // rust bloom clusters
    const k = (bloom - 0.7) / 0.3;
    r += (160 - r) * k; g += (88 - g) * k; b += (40 - b) * k;
  } else if (bloom > 0.55) {                             // fading rust tint
    r += 20; g -= 6; b -= 12;
  }
  const g2 = grain(x, y, 32, 13) - 6;
  r += g2; g += g2; b += g2 >> 1;
  if (y === 15) { r -= 18; g -= 16; b -= 14; }           // lower seam edge
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

/** Stacked hessian sandbags: 4-row bags with a dark stitched seam and a bulge highlight. */
function barricade(x, y) {
  const fiber = grain(x, y, 44, 11) - 5 + mottle(x, y, 45) * 5;
  let r = 122 + fiber, g = 108 + fiber, b = 74 + fiber * 0.5;
  if (y % 4 === 3) { r = 96; g = 84; b = 58; }
  else if (y % 4 === 1) { r += 16; g += 16; b += 16; }
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

/**
 * Armoured concrete: the indestructible street and wall mass of Reactor and
 * Causeway. Mid grey with a cool cast, dense aggregate and the odd tie pore,
 * light enough to take sun and shade instead of reading as a black void.
 */
function armorConcrete(x, y) {
  const m = mottle(x, y, 150);
  let v = 112 + m * 9 + (grain(x, y, 151, 9) - 4);
  if (tileNoise(x, y, 2, 152) > 0.86) v += 9;             // pale aggregate
  if (grain(x, y, 153, 67) === 0) v -= 18;                // pores
  return [clamp255(v - 2), clamp255(v + 1), clamp255(v + 6), 255];
}

/**
 * Boundary cladding: vertical ribs every 8px (half a block), so the rib
 * rhythm hides the voxel grid on long perimeter walls. No horizontal seams;
 * weathering streaks run down each rib column.
 */
function facadePanel(x, y) {
  const lx = x & 7;
  const rib = lx === 0 ? -22 : lx === 1 ? 12 : lx === 2 ? 5 : lx === 7 ? -7 : 0;
  const streak = (grain(x, 0, 154, 9) - 4) + (tileNoise(x, y, 4, 155) - 0.5) * 8;
  const v = 150 + rib + streak + (grain(x, y, 156, 5) - 2);
  return [clamp255(v - 4), clamp255(v), clamp255(v + 6), 255];
}

/** Cladding with a recessed horizontal panel joint along the block's lower edge. */
function facadeJoint(x, y) {
  const c = facadePanel(x, y);
  const k = y === 15 ? -32 : y === 14 ? -10 : 0;
  return [clamp255(c[0] + k), clamp255(c[1] + k), clamp255(c[2] + k), 255];
}

/** Dark steel pilaster: two broad vertical plates with seam and catch-light. */
function facadePillar(x, y) {
  const lx = x & 7;
  const seam = lx === 0 ? -26 : lx === 1 ? 18 : lx === 6 ? -6 : 0;
  const streak = (grain(x, 0, 157, 7) - 3) + mottle(x, y, 158) * 4;
  const v = 96 + seam + streak;
  return [clamp255(v - 6), clamp255(v + 2), clamp255(v + 14), 255];
}

/** Cladding over a muted amber/graphite hazard kick band at the wall foot. */
function facadeBase(x, y) {
  if (y < 9) return facadePanel(x, y);
  if (y === 9) return [58, 60, 64, 255];                  // kick-plate lip shadow
  const wear = grain(x, y, 159, 7) - 3 + (grain(x, y, 160, 29) === 0 ? -20 : 0);
  // Diagonal stripes with an 8px period stay continuous across block seams.
  return (((x + y) >> 2) & 1)
    ? [clamp255(186 + wear), clamp255(138 + wear), clamp255(54 + wear), 255]
    : [clamp255(50 + wear), clamp255(52 + wear), clamp255(56 + wear), 255];
}

/** Running-bond red masonry: offset mortar lines every 4-row course, per-brick variance. */
function brick(x, y) {
  const course = (y >> 2) & 7;
  const headOff = (course & 1) * 4;                     // half-brick stagger per course
  const mortar = (y & 3) === 3 || ((x + headOff) & 7) === 0;
  if (mortar) {
    const m = grain(x, y, 33, 9) - 4;
    return [clamp255(170 + m), clamp255(166 + m), clamp255(160 + m), 255];
  }
  // Per-brick identity: course row + staggered column bucket drives hue/value.
  const brickCol = ((x + headOff) >> 3) & 1;
  const tone = grain(brickCol, course, 34, 13);
  let r = 148 + tone * 3, g = 66 + tone * 2, b = 52;
  const fleck = grain(x, y, 35, 13) - 6 + mottle(x, y, 36) * 5;
  r += fleck; g += fleck * 0.5; b += fleck * 0.5;
  if ((y & 3) === 0) { r -= 14; g -= 8; b -= 6; }         // shadow under mortar above
  return [clamp255(r), clamp255(g), clamp255(b), 255];
}

function siding(base, x, y) {
  const n = grain(x, y, 40, 7) - 3 + mottle(x, y, 41) * 5;
  const shade = y % 8 === 7 ? -35 : y % 8 === 0 ? 15 : 0;
  return [...base.map(v => clamp255(v + n + shade)), 255];
}

function asphalt(x, y) {
  const n = grain(x, y, 41, 11) - 5 + mottle(x, y, 42) * 6 + (grain(x, y, 43, 29) === 0 ? 14 : 0);
  return [clamp255(52 + n), clamp255(55 + n), clamp255(58 + n), 255];
}

function roof(x, y) {
  const seam = y % 4 === 3 || (x + (Math.floor(y / 4) % 2) * 8) % 16 === 0;
  const n = seam ? -14 : grain(x, y, 42, 9) - 4 + mottle(x, y, 46) * 6;
  return [clamp255(91 + n), clamp255(74 + n), clamp255(62 + n), 255];
}

// Dust II's Kasbah stone and sun-faded plaster have soft mineral variation.
// Keep them separate from the existing industrial tiles: their visible faces
// have no artificial bevel or dark ring around every voxel.
function dustGrain(x, y, salt, range) {
  let value = Math.imul(x + 17, 374761393) ^ Math.imul(y + 29, 668265263) ^ Math.imul(salt, 1274126177);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) % range;
}

function dustColor(base, shade) {
  return [clamp255(base[0] + shade), clamp255(base[1] + shade), clamp255(base[2] + shade), 255];
}

function dustSandstone(x, y) {
  const course = y >> 3;
  const jointX = (x + course * 8) & 15;
  const joint = (y & 7) === 7 || jointX === 0;
  let shade = dustGrain(x, y, 51, 11) - 5;
  shade += dustGrain(x >> 2, y >> 1, 52, 7) - 3;
  if (joint) return dustColor([162, 139, 104], shade >> 1);
  // Slightly eroded, rounded stone courses, without embossed block outlines.
  if ((y & 7) === 6 && dustGrain(x, y, 53, 5) === 0) shade -= 9;
  return dustColor([188, 163, 122], shade);
}

function dustPlaster(x, y) {
  const grain = dustGrain(x, y, 54, 9) - 4;
  const mottle = dustGrain(x >> 2, y >> 2, 55, 7) - 3;
  const pore = dustGrain(x, y, 56, 71) === 0 ? -12 : 0;
  return dustColor([205, 187, 155], grain + mottle + pore);
}

function dustRock(x, y) {
  const drift = [0, 0, 1, 1, 0, 0, -1, -1][x >> 1];
  const layer = (y + drift + 16) & 7;
  const strata = [3, 7, 4, -2, -7, -4, 0, 2][layer];
  const grain = dustGrain(x, y, 57, 15) - 7;
  return dustColor([160, 132, 90], strata + grain);
}

function dustFloor(x, y) {
  const grain = dustGrain(x, y, 58, 11) - 5;
  const mottle = dustGrain(x >> 2, y >> 2, 59, 9) - 4;
  // Fine aggregate under a film of dust, without a tile-size paving grid.
  const aggregate = dustGrain(x, y, 60, 83) === 0 ? -13 : 0;
  return dustColor([172, 160, 138], grain + mottle + aggregate);
}

function dustTrim(x, y) {
  const grain = dustGrain(x, y, 61, 7) - 3;
  const pore = dustGrain(x, y, 62, 101) === 0 ? -10 : 0;
  return dustColor([220, 209, 180], grain + pore);
}

function dustTile(x, y) {
  const grout = (x & 7) === 7 || (y & 7) === 7;
  const grain = dustGrain(x, y, 63, 7) - 3;
  if (grout) return dustColor([171, 175, 155], grain);
  const glaze = dustGrain(x >> 3, y >> 3, 64, 9) - 4;
  return dustColor([77, 119, 137], grain + glaze);
}

function dustCrate(x, y) {
  const grain = dustGrain(x, y, 65, 9) - 4;
  const slat = x === 2 || x === 13 || y === 2 || y === 13;
  const joint = (y & 3) === 3;
  const worn = dustGrain(x, y, 66, 59) === 0 ? 15 : 0;
  if ((x === 2 || x === 13) && (y === 3 || y === 12)) return [71, 72, 53, 255];
  return dustColor(slat ? [124, 123, 80] : [104, 106, 69], grain + worn - (joint && !slat ? 11 : 0));
}

function dustWood(x, y) {
  const grain = dustGrain(x, y >> 2, 67, 13) - 6;
  if (y === 4 || y === 11) {
    if (x === 2 || x === 13) return [103, 95, 74, 255];
    return dustColor([60, 58, 47], grain >> 1);
  }
  const seam = (x & 3) === 3 ? -17 : 0;
  const scratch = dustGrain(x, y, 68, 67) === 0 ? 18 : 0;
  return dustColor([91, 73, 49], grain + seam + scratch);
}

// MINECRAFT B5 tiles: flat 16px pixel-art materials in the spirit of the
// original block set, drawn from the same deterministic grain as Dust II so
// the sheet stays bit-identical without any texture download.
function mcNoise(base, x, y, salt, range) {
  return dustColor(base, dustGrain(x, y, salt, range) - (range >> 1));
}

function mcGrassTop(x, y) {
  const shade = dustGrain(x, y, 70, 25) - 12 + (dustGrain(x >> 1, y >> 1, 71, 9) - 4);
  return dustColor([104, 158, 66], shade);
}

function mcDirt(x, y) {
  const pebble = dustGrain(x, y, 72, 23) === 0 ? 18 : 0;
  return dustColor([121, 88, 60], dustGrain(x, y, 73, 21) - 10 + pebble);
}

function mcGrassSide(x, y) {
  const fringe = 3 + dustGrain(x, 0, 74, 3);
  if (y < fringe - 1) return mcGrassTop(x, y);
  if (y < fringe) return dustGrain(x, 0, 75, 2) ? mcGrassTop(x, y) : mcDirt(x, y);
  return mcDirt(x, y);
}

function mcStone(x, y) {
  const patch = dustGrain(x >> 1, y >> 1, 76, 13) - 6;
  return dustColor([125, 125, 125], dustGrain(x, y, 77, 11) - 5 + patch);
}

function mcCobble(x, y) {
  // Rounded stones separated by a dark mortar web.
  const cx = (x + (y >> 3) * 4) & 7, cy = y & 7;
  const rim = cx === 0 || cy === 0 || (cx === 7 && cy > 3) || (cy === 7 && cx > 3);
  if (rim) return dustColor([74, 74, 74], dustGrain(x, y, 78, 9) - 4);
  return dustColor([132, 132, 132], dustGrain(x, y, 79, 19) - 9 + (cx === 1 || cy === 1 ? 10 : 0));
}

function mcMossy(x, y) {
  const moss = dustGrain(x >> 1, y >> 1, 80, 7) < 3;
  const base = mcCobble(x, y);
  if (!moss) return base;
  return [base[0] * 0.55 | 0, base[1] * 0.85 | 0, base[2] * 0.4 | 0, 255];
}

function mcSand(x, y) {
  return dustColor([219, 210, 160], dustGrain(x, y, 81, 15) - 7 + (dustGrain(x >> 2, y >> 2, 82, 7) - 3));
}

function mcGravel(x, y) {
  const pebble = dustGrain(x >> 1, y >> 1, 83, 5);
  return dustColor([132, 126, 124], pebble * 9 - 18 + dustGrain(x, y, 84, 9) - 4);
}

function mcClay(x, y) {
  return dustColor([158, 164, 176], dustGrain(x >> 1, y >> 1, 85, 11) - 5);
}

function mcLogSide(x, y) {
  const streak = dustGrain(x, 0, 86, 7) - 3;
  const knot = dustGrain(x, y, 87, 53) === 0 ? -18 : 0;
  return dustColor([104, 82, 50], streak * 4 + (dustGrain(x, y >> 2, 88, 7) - 3) + knot);
}

function mcLogTop(x, y) {
  const dx = x - 7.5, dy = y - 7.5;
  const ring = Math.sqrt(dx * dx + dy * dy) * 1.5 | 0;
  if (x === 0 || y === 0 || x === 15 || y === 15) return dustColor([104, 82, 50], dustGrain(x, y, 89, 9) - 4);
  return dustColor(ring & 1 ? [168, 138, 84] : [190, 158, 100], dustGrain(x, y, 90, 7) - 3);
}

function mcLeaves(x, y) {
  let grain = x + y * 16;
  grain ^= grain >> 4;
  grain = (grain * 173) & 255;
  grain ^= grain >> 3;
  grain = (grain * 97) & 255;
  if (grain < 44) return [0, 0, 0, 0];
  return dustColor([46, 110, 32], (grain % 21) - 10);
}

function mcPlanks(x, y) {
  const board = (y >> 2) & 3;
  const seam = (y & 3) === 3 || ((x + board * 5) & 15) === 0;
  if (seam) return dustColor([96, 72, 42], dustGrain(x, y, 91, 7) - 3);
  return dustColor([173, 138, 84], dustGrain(x, y >> 1, 92, 13) - 6 + (board & 1 ? -6 : 0));
}

function mcGlass(x, y) {
  if (x === 0 || x === 15 || y === 0 || y === 15) return [220, 236, 244, 240];
  const streak = ((x + y) & 15) < 2 || ((x + y + 8) & 15) < 1;
  return streak ? [232, 244, 250, 190] : [182, 212, 228, 88];
}

function mcBrick(x, y) {
  const course = y >> 2;
  const mortar = (y & 3) === 3 || ((x + (course & 1) * 4) & 7) === 7;
  if (mortar) return dustColor([170, 168, 160], dustGrain(x, y, 93, 7) - 3);
  return dustColor([150, 72, 58], dustGrain(x >> 2, course, 94, 15) - 7 + dustGrain(x, y, 95, 5) - 2);
}

function mcBookshelf(x, y) {
  if (y < 2 || y > 13 || (y > 5 && y < 10)) return mcPlanks(x, y);
  const slot = (x + (y > 7 ? 3 : 0)) % 5;
  const palette = [[168, 48, 44], [58, 92, 160], [72, 134, 70], [190, 160, 70], [120, 76, 130]];
  const spine = x % 3 === 0 ? -22 : 0;
  return dustColor(palette[slot], spine + dustGrain(x, y, 96, 9) - 4);
}

function mcWool(base, x, y) {
  const weave = ((x + y) & 3) === 0 ? -10 : ((x - y) & 3) === 0 ? 6 : 0;
  return dustColor(base, weave + dustGrain(x >> 1, y >> 1, 97, 7) - 3);
}

function mcMetal(base, x, y, salt) {
  if (x === 0 || y === 0) return dustColor(base, 34);
  if (x === 15 || y === 15) return dustColor(base, -42);
  const panel = (x > 2 && x < 13 && y > 2 && y < 13) ? 0 : -12;
  return dustColor(base, panel + dustGrain(x, y, salt, 9) - 4);
}

function mcOre(gem, x, y, salt) {
  // Four small crystals embedded in stone.
  const cx = x & 7, cy = y & 7, cluster = ((x >> 3) + (y >> 3) * 2 + salt) & 3;
  const ox = 2 + (cluster & 1) * 2, oy = 2 + (cluster >> 1) * 2;
  if (cx >= ox && cx < ox + 3 && cy >= oy && cy < oy + 3 && !(cx === ox && cy === oy) && !(cx === ox + 2 && cy === oy + 2)) {
    return dustColor(gem, (cx - ox) * 12 - 12);
  }
  return mcStone(x, y);
}

function mcObsidian(x, y) {
  return dustColor([24, 14, 36], dustGrain(x >> 1, y >> 1, 98, 13) - 6 + (dustGrain(x, y, 99, 41) === 0 ? 14 : 0));
}

function mcNetherrack(x, y) {
  const vein = dustGrain(x >> 1, y >> 1, 100, 9) < 3 ? -22 : 0;
  return dustColor([116, 52, 48], vein + dustGrain(x, y, 101, 13) - 6);
}

function mcGlowstone(x, y) {
  const cell = dustGrain(x >> 2, y >> 2, 102, 11) - 5;
  const spark = dustGrain(x, y, 103, 13) < 3 ? 26 : 0;
  return dustColor([232, 190, 92], cell * 3 + spark);
}

function mcCloud(x, y) {
  return dustColor([246, 248, 252], dustGrain(x >> 2, y >> 2, 104, 5) - 2);
}

function mcCactusSide(x, y) {
  if (x === 0 || x === 15) return dustColor([82, 128, 46], -8);
  const spine = (x & 3) === 1 && (y & 3) === 2 ? -40 : 0;
  return dustColor([94, 148, 54], spine + dustGrain(x, y >> 1, 105, 9) - 4);
}

function mcCactusTop(x, y) {
  if (x === 0 || x === 15 || y === 0 || y === 15) return dustColor([82, 128, 46], -8);
  return dustColor([132, 176, 78], dustGrain(x, y, 106, 9) - 4 + (((x ^ y) & 3) === 0 ? -10 : 0));
}

function mcChestSide(x, y) {
  if (x === 0 || x === 15 || y === 0 || y === 15) return dustColor([62, 44, 24], 0);
  if (y === 6 || y === 7) return dustColor([54, 38, 20], dustGrain(x, 0, 107, 5) - 2);
  if (x >= 6 && x <= 9 && y >= 5 && y <= 9) return dustColor([170, 170, 178], (x === 6 || y === 5) ? 20 : -14);
  return dustColor([152, 106, 52], dustGrain(x, y >> 1, 108, 9) - 4);
}

function mcChestTop(x, y) {
  if (x === 0 || x === 15 || y === 0 || y === 15) return dustColor([62, 44, 24], 0);
  return dustColor([152, 106, 52], dustGrain(x, y >> 1, 109, 9) - 4);
}

function mcFurnaceSide(x, y) {
  return mcCobble(x, y);
}

function mcFurnaceTop(x, y) {
  if (x >= 4 && x <= 11 && y >= 8 && y <= 13) return y === 8 ? dustColor([40, 40, 40], 0) : dustColor([18, 18, 18], dustGrain(x, y, 110, 7));
  return mcCobble(x, y);
}

function mcCraftTop(x, y) {
  if (x === 7 || x === 8 || y === 7 || y === 8) return dustColor([84, 62, 40], 0);
  return dustColor([132, 100, 62], dustGrain(x, y, 111, 11) - 5);
}

function mcCraftSide(x, y) {
  if (y >= 8) return mcPlanks(x, y);
  if ((x > 1 && x < 6 && y > 1 && y < 6) || (x > 9 && x < 14 && y > 1 && y < 6)) return dustColor([168, 172, 176], (x & 1) ? 12 : -8);
  return dustColor([150, 112, 66], dustGrain(x, y, 112, 9) - 4);
}

function mcTntSide(x, y) {
  if (y < 3 || y > 12) return dustColor([196, 46, 40], dustGrain(x, y, 113, 11) - 5);
  if (y >= 6 && y <= 9) {
    const letter = (x >= 2 && x <= 4 && (y === 6 || x === 3)) || (x >= 6 && x <= 9 && (x === 6 || x === 9 || y === 6))
      || (x >= 11 && x <= 13 && (y === 6 || x === 12));
    return letter ? [24, 20, 18, 255] : dustColor([224, 220, 208], 0);
  }
  return dustColor([224, 220, 208], dustGrain(x, y, 114, 7) - 3);
}

function mcTntTop(x, y) {
  const fuse = (x & 3) === 1 && (y & 3) === 1;
  return fuse ? [40, 34, 30, 255] : dustColor([196, 46, 40], dustGrain(x, y, 115, 11) - 5);
}

function mcWater(x, y) {
  const ripple = ((x + (y << 1)) & 7) < 2 ? 18 : 0;
  const [r, g, b] = dustColor([46, 88, 190], ripple + dustGrain(x >> 1, y >> 1, 116, 11) - 5);
  return [r, g, b, 176];
}

function mcLava(x, y) {
  const crust = dustGrain(x >> 1, y >> 1, 117, 9) < 3;
  return crust ? dustColor([176, 62, 18], dustGrain(x, y, 118, 9) - 4) : dustColor([242, 150, 36], dustGrain(x, y, 119, 21) - 10);
}

function mcPortal(x, y) {
  const swirl = (x * 3 + y * 5 + (dustGrain(x, y, 120, 5))) & 7;
  const [r, g, b] = dustColor([112, 42, 186], swirl < 2 ? 40 : swirl > 5 ? -30 : 0);
  return [r, g, b, 196];
}

/** Tile-id -> painter registry. Keys are TILE slot values. */
// Leith Waterworld: glazed pool tiles, small white deck tiles, beige ceramic
// floors and the glossy plastic flumes.
function poolTileBlue(x, y) {
  const grout = (x & 7) === 7 || (y & 7) === 7;
  if (grout) return dustColor([196, 210, 220], dustGrain(x, y, 131, 7) - 3);
  const sheen = (x & 7) === 0 || (y & 7) === 0 ? 14 : 0;
  return dustColor([84, 158, 214], sheen + dustGrain(x >> 1, y >> 1, 132, 11) - 5);
}
function poolTileWhite(x, y) {
  const grout = (x & 3) === 3 || (y & 3) === 3;
  if (grout) return dustColor([198, 202, 206], dustGrain(x, y, 133, 5) - 2);
  return dustColor([233, 236, 238], dustGrain(x >> 2, y >> 2, 134, 9) - 4);
}
function poolFloor(x, y) {
  const grout = (x & 7) === 7 || (y & 7) === 7;
  if (grout) return dustColor([146, 142, 132], dustGrain(x, y, 135, 7) - 3);
  return dustColor([194, 184, 166], dustGrain(x >> 1, y >> 1, 136, 13) - 6);
}
function poolPanel(x, y) {
  // Painted steel cladding: wide pale panels, a shadowed seam and a dark foot rail.
  if (y === 7 || y === 15) return dustColor([118, 128, 138], dustGrain(x, y, 139, 5) - 2);
  if (x === 0) return dustColor([206, 214, 222], 0);
  return dustColor([174, 184, 194], (y > 7 ? -6 : 0) + dustGrain(x >> 2, y >> 1, 140, 7) - 3);
}
function slidePlastic(base, x, y, salt) {
  const highlight = y < 2 ? 34 : y === 2 ? 12 : y > 13 ? -26 : 0;
  return dustColor(base, highlight + dustGrain(x, y >> 2, salt, 5) - 2);
}

// Bikini Bottom: flat cartoon colours with few grain levels, like the
// Waterworld finishes. Flecks, pits and chips come from a pure pixel hash.
const bbHash = (x, y, salt) => dustGrain(x, y, salt, 1000) / 1000;
/**
 * Coral pores: one candidate per 4px cell on a staggered grid, kept by hash
 * (about 60%) and nudged +-1px, so faces never knit into a regular checker.
 */
function bbCoralPore(x, y) {
  const cy = y >> 2, cx = (x + (cy & 1) * 2) >> 2;
  if (bbHash(cx, cy, 149) >= 0.6) return false;
  const jitter = dustGrain(cx, cy, 150, 9);
  const px = ((cx << 2) - (cy & 1) * 2 + 1 + (jitter % 3) - 1 + 16) & 15;
  const py = ((cy << 2) + 1 + ((jitter / 3) | 0) - 1 + 16) & 15;
  return x === px && y === py;
}
function bbSand(x, y) {
  // Every voxel repeats this tile, so shell flecks stay faint (a tint, not a
  // dot) and sparse enough never to line up into a visible lattice.
  const ripple = Math.round(4 * Math.sin((x + y) * 0.4));
  const base = [232, 220, 176], shade = ripple + dustGrain(x >> 1, y >> 1, 142, 7) - 3;
  const fleck = bbHash(x >> 1, y >> 1, 141);
  const shell = fleck < 0.02 ? [206, 216, 206] : fleck < 0.04 ? [238, 208, 192] : null;
  return dustColor(shell ?? base, shell ? 0 : shade);
}
function bbCoral(x, y) {
  if (bbCoralPore(x, y)) return dustColor([184, 86, 106], 0);
  if (bbCoralPore(x, y + 1)) return dustColor([246, 160, 174], 0);  // rim above the pore
  return dustColor([232, 122, 140], dustGrain(x >> 2, y >> 1, 151, 5) - 2);
}
function bbPineapple(x, y) {
  const a = (x + y) % 8;
  const b = (x - y + 16) % 8;
  if (a === 4 && b === 4) return dustColor([255, 241, 191], 0);
  if (a === 0 || b === 0) return dustColor([201, 122, 28], 0);
  return dustColor([240, 160, 48], 0);
}
function bbPineLeaf(x, y) {
  const lane = x % 4;
  if ((lane !== 1 && lane !== 2) || y < (x * 7) % 5) return [0, 0, 0, 0];   // ragged tips
  return lane === 2 ? dustColor([108, 192, 112], 0) : dustColor([63, 154, 74], 0);
}
function bbKelp(x, y) {
  const off = Math.abs(x - 7.5 - 2 * Math.sin(y * 0.8));
  if (off >= 4.5) return [0, 0, 0, 0];
  if (off < 1) return y % 8 === 3 ? dustColor([201, 180, 74], 0) : dustColor([79, 154, 90], 0);
  return dustColor([47, 111, 58], 0);
}
function bbMoai(x, y) {
  if (bbHash(x, y, 143) < 0.06) return dustColor([95, 115, 133], 0);
  return dustColor([125, 147, 166], dustGrain(x, y, 144, 17) - 8);
}
const BB_ROCK_TONES = [[128, 84, 56], [138, 90, 60], [148, 98, 66]];
function bbRock(x, y) {
  // Short hash-placed cracks inside the tile (never touching its edges).
  if (x > 1 && x < 14 && y > 1 && y < 14 && bbHash(x >> 2, y >> 2, 148) < 0.08
    && (x & 3) === ((y + (bbHash(x >> 2, y >> 2, 152) < 0.5 ? 0 : 2)) & 3)) return dustColor([94, 59, 39], 0);
  if (bbHash(x >> 1, y, 145) < 0.05) return dustColor([168, 118, 79], 0);   // 2x1 pebbles
  return dustColor(BB_ROCK_TONES[dustGrain(x >> 2, y >> 1, 145, 3)], 0);
}
function bbHull(x, y) {
  if (x % 8 === 1 && y % 4 === 2) return dustColor([46, 36, 26], 0);   // nails
  if (y % 8 === 2) return dustColor([63, 143, 138], 0);                // teal stripe
  if (y % 4 === 0) return dustColor([74, 56, 38], 0);                  // plank seam
  return dustColor([107, 82, 56], 0);
}
function bbChum(x, y) {
  if ((x === 2 || x === 13) && (y === 2 || y === 13)) return dustColor([201, 210, 214], 0);   // rivets
  if (x === 15 || y === 15) return dustColor([62, 72, 76], 0);
  if (x === 0 || y === 0) return dustColor([122, 138, 144], 0);
  return dustColor([93, 107, 112], 0);
}
function bbRoad(x, y) {
  // Warm blue-grey tarmac with sparse dark grit, clearly not ice.
  if (bbHash(x, y, 146) < 0.02) return dustColor([112, 124, 136], 0);
  return dustColor([132, 146, 160], dustGrain(x, y, 147, 13) - 6);
}
/** Clean pane for the Treedome and windows: faint cyan, no streaks, 1px top/left frame. */
function bbDomeGlass(x, y) {
  if (x === 0 || y === 0) return [214, 240, 248, 170];
  return [clamp255(190 + dustGrain(x >> 2, y >> 2, 153, 5)), 228, 240, 120];
}

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
  [TILE.YELLOW_SIDING]: (x,y) => siding([226,190,87],x,y),
  [TILE.TEAL_SIDING]: (x,y) => siding([93,177,156],x,y),
  [TILE.ASPHALT]: asphalt,
  [TILE.ROOF]: roof,
  [TILE.BUS_YELLOW]: (x,y) => siding([242,177,38],x,y),
  [TILE.TRUCK_RED]: (x,y) => siding([167,52,42],x,y),
  [TILE.DUST_SANDSTONE]: dustSandstone,
  [TILE.DUST_PLASTER]: dustPlaster,
  [TILE.DUST_ROCK]: dustRock,
  [TILE.DUST_FLOOR]: dustFloor,
  [TILE.DUST_TRIM]: dustTrim,
  [TILE.DUST_TILE]: dustTile,
  [TILE.DUST_CRATE]: dustCrate,
  [TILE.DUST_WOOD]: dustWood,
  [TILE.MC_GRASS_TOP]: mcGrassTop,
  [TILE.MC_GRASS_SIDE]: mcGrassSide,
  [TILE.MC_DIRT]: mcDirt,
  [TILE.MC_STONE]: mcStone,
  [TILE.MC_COBBLE]: mcCobble,
  [TILE.MC_MOSSY]: mcMossy,
  [TILE.MC_SAND]: mcSand,
  [TILE.MC_GRAVEL]: mcGravel,
  [TILE.MC_CLAY]: mcClay,
  [TILE.MC_LOG_SIDE]: mcLogSide,
  [TILE.MC_LOG_TOP]: mcLogTop,
  [TILE.MC_LEAVES]: mcLeaves,
  [TILE.MC_PLANKS]: mcPlanks,
  [TILE.MC_GLASS]: mcGlass,
  [TILE.MC_BRICK]: mcBrick,
  [TILE.MC_BOOKSHELF]: mcBookshelf,
  [TILE.MC_WOOL_WHITE]: (x, y) => mcWool([228, 228, 228], x, y),
  [TILE.MC_WOOL_RED]: (x, y) => mcWool([176, 46, 40], x, y),
  [TILE.MC_IRON]: (x, y) => mcMetal([214, 214, 214], x, y, 121),
  [TILE.MC_GOLD]: (x, y) => mcMetal([246, 206, 62], x, y, 122),
  [TILE.MC_DIAMOND]: (x, y) => mcMetal([96, 222, 214], x, y, 123),
  [TILE.MC_DIAMOND_ORE]: (x, y) => mcOre([98, 226, 220], x, y, 1),
  [TILE.MC_COAL_ORE]: (x, y) => mcOre([34, 34, 34], x, y, 2),
  [TILE.MC_OBSIDIAN]: mcObsidian,
  [TILE.MC_NETHERRACK]: mcNetherrack,
  [TILE.MC_GLOWSTONE]: mcGlowstone,
  [TILE.MC_CLOUD]: mcCloud,
  [TILE.MC_CACTUS_SIDE]: mcCactusSide,
  [TILE.MC_CACTUS_TOP]: mcCactusTop,
  [TILE.MC_CHEST_SIDE]: mcChestSide,
  [TILE.MC_CHEST_TOP]: mcChestTop,
  [TILE.MC_FURNACE_SIDE]: mcFurnaceSide,
  [TILE.MC_FURNACE_TOP]: mcFurnaceTop,
  [TILE.MC_CRAFT_SIDE]: mcCraftSide,
  [TILE.MC_CRAFT_TOP]: mcCraftTop,
  [TILE.MC_TNT_SIDE]: mcTntSide,
  [TILE.MC_TNT_TOP]: mcTntTop,
  [TILE.MC_WATER]: mcWater,
  [TILE.MC_LAVA]: mcLava,
  [TILE.MC_PORTAL]: mcPortal,
  [TILE.POOL_TILE_BLUE]: poolTileBlue,
  [TILE.POOL_TILE_WHITE]: poolTileWhite,
  [TILE.POOL_FLOOR]: poolFloor,
  [TILE.SLIDE_BLUE]: (x, y) => slidePlastic([40, 118, 226], x, y, 137),
  [TILE.SLIDE_YELLOW]: (x, y) => slidePlastic([244, 198, 42], x, y, 138),
  [TILE.POOL_PANEL]: poolPanel,
  [TILE.BARRICADE]: barricade,
  [TILE.BEDROCK]: bedrock,
  [TILE.ARMOR_CONCRETE]: armorConcrete,
  [TILE.FACADE_PANEL]: facadePanel,
  [TILE.FACADE_JOINT]: facadeJoint,
  [TILE.FACADE_PILLAR]: facadePillar,
  [TILE.FACADE_BASE]: facadeBase,
  [TILE.BB_SAND]: bbSand,
  [TILE.BB_CORAL]: bbCoral,
  [TILE.BB_PINEAPPLE]: bbPineapple,
  [TILE.BB_PINE_LEAF]: bbPineLeaf,
  [TILE.BB_KELP]: bbKelp,
  [TILE.BB_MOAI]: bbMoai,
  [TILE.BB_ROCK]: bbRock,
  [TILE.BB_HULL]: bbHull,
  [TILE.BB_CHUM]: bbChum,
  [TILE.BB_ROAD]: bbRoad,
  [TILE.BB_DOME_GLASS]: bbDomeGlass,
});

// ------------------------------------------------------------- face mapping

const MC_BLOCK_TILES = Object.freeze({
  [MC_GRASS]: { top: TILE.MC_GRASS_TOP, bottom: TILE.MC_DIRT, side: TILE.MC_GRASS_SIDE },
  [MC_DIRT]: { all: TILE.MC_DIRT },
  [MC_STONE]: { all: TILE.MC_STONE },
  [MC_COBBLE]: { all: TILE.MC_COBBLE },
  [MC_MOSSY]: { all: TILE.MC_MOSSY },
  [MC_SAND]: { all: TILE.MC_SAND },
  [MC_GRAVEL]: { all: TILE.MC_GRAVEL },
  [MC_CLAY]: { all: TILE.MC_CLAY },
  [MC_LOG]: { top: TILE.MC_LOG_TOP, bottom: TILE.MC_LOG_TOP, side: TILE.MC_LOG_SIDE },
  [MC_LEAVES]: { all: TILE.MC_LEAVES },
  [MC_PLANKS]: { all: TILE.MC_PLANKS },
  [MC_GLASS]: { all: TILE.MC_GLASS },
  [MC_BRICK]: { all: TILE.MC_BRICK },
  [MC_BOOKSHELF]: { top: TILE.MC_PLANKS, bottom: TILE.MC_PLANKS, side: TILE.MC_BOOKSHELF },
  [MC_WOOL_WHITE]: { all: TILE.MC_WOOL_WHITE },
  [MC_WOOL_RED]: { all: TILE.MC_WOOL_RED },
  [MC_IRON]: { all: TILE.MC_IRON },
  [MC_GOLD]: { all: TILE.MC_GOLD },
  [MC_DIAMOND]: { all: TILE.MC_DIAMOND },
  [MC_DIAMOND_ORE]: { all: TILE.MC_DIAMOND_ORE },
  [MC_COAL_ORE]: { all: TILE.MC_COAL_ORE },
  [MC_OBSIDIAN]: { all: TILE.MC_OBSIDIAN },
  [MC_NETHERRACK]: { all: TILE.MC_NETHERRACK },
  [MC_GLOWSTONE]: { all: TILE.MC_GLOWSTONE },
  [MC_CLOUD]: { all: TILE.MC_CLOUD },
  [MC_CACTUS]: { top: TILE.MC_CACTUS_TOP, bottom: TILE.MC_CACTUS_TOP, side: TILE.MC_CACTUS_SIDE },
  [MC_CHEST]: { top: TILE.MC_CHEST_TOP, bottom: TILE.MC_CHEST_TOP, side: TILE.MC_CHEST_SIDE },
  [MC_FURNACE]: { top: TILE.MC_FURNACE_TOP, bottom: TILE.MC_FURNACE_SIDE, side: TILE.MC_FURNACE_SIDE },
  [MC_CRAFTING]: { top: TILE.MC_CRAFT_TOP, bottom: TILE.MC_PLANKS, side: TILE.MC_CRAFT_SIDE },
  [MC_TNT]: { top: TILE.MC_TNT_TOP, bottom: TILE.MC_TNT_TOP, side: TILE.MC_TNT_SIDE },
  [MC_WATER]: { all: TILE.MC_WATER },
  [MC_LAVA]: { all: TILE.MC_LAVA },
  [MC_PORTAL]: { all: TILE.MC_PORTAL },
});

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
  [YELLOW_SIDING]: { all: TILE.YELLOW_SIDING },
  [TEAL_SIDING]: { all: TILE.TEAL_SIDING },
  [ASPHALT]: { all: TILE.ASPHALT },
  [ROOF]: { all: TILE.ROOF },
  [BUS_YELLOW]: { all: TILE.BUS_YELLOW },
  [TRUCK_RED]: { all: TILE.TRUCK_RED },
  [DUST_SANDSTONE]: { all: TILE.DUST_SANDSTONE },
  [DUST_PLASTER]: { all: TILE.DUST_PLASTER },
  [DUST_ROCK]: { all: TILE.DUST_ROCK },
  [DUST_FLOOR]: { all: TILE.DUST_FLOOR },
  [DUST_TRIM]: { all: TILE.DUST_TRIM },
  [DUST_TILE]: { all: TILE.DUST_TILE },
  [DUST_CRATE]: { all: TILE.DUST_CRATE },
  [DUST_WOOD]: { all: TILE.DUST_WOOD },
  [BEDROCK]: { all: TILE.BEDROCK },
  [POOL_TILE_BLUE]: { all: TILE.POOL_TILE_BLUE },
  [POOL_TILE_WHITE]: { all: TILE.POOL_TILE_WHITE },
  [POOL_FLOOR]: { all: TILE.POOL_FLOOR },
  [SLIDE_BLUE]: { all: TILE.SLIDE_BLUE },
  [SLIDE_YELLOW]: { all: TILE.SLIDE_YELLOW },
  [POOL_PANEL]: { all: TILE.POOL_PANEL },
  [BARRICADE]: { all: TILE.BARRICADE },
  [BB_SAND]: { all: TILE.BB_SAND },
  [BB_CORAL]: { all: TILE.BB_CORAL },
  [BB_PINEAPPLE]: { all: TILE.BB_PINEAPPLE },
  [BB_PINE_LEAF]: { all: TILE.BB_PINE_LEAF },
  [BB_KELP]: { all: TILE.BB_KELP },
  [BB_MOAI]: { all: TILE.BB_MOAI },
  [BB_ROCK]: { all: TILE.BB_ROCK },
  [BB_HULL]: { all: TILE.BB_HULL },
  [BB_CHUM]: { all: TILE.BB_CHUM },
  [BB_ROAD]: { all: TILE.BB_ROAD },
  ...MC_BLOCK_TILES,
  // Ghost blocks look exactly like the material they imitate.
  ...Object.fromEntries(Object.entries(MC_GHOST_SOLID).map(([ghost, solid]) => [ghost, MC_BLOCK_TILES[solid]])),
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

/**
 * Per-map surface treatment, applied by the chunk mesher on top of faceTile:
 * `remap` swaps whole tiles (for example the near-black BEDROCK streets of
 * Reactor and Causeway), `boundary` opts the map into boundary skins on its
 * tall perimeter shell. Maps without an entry render the default tiles.
 */
export const MAP_SURFACES = Object.freeze({
  reactor: Object.freeze({ remap: Object.freeze({ [TILE.BEDROCK]: TILE.ARMOR_CONCRETE }), boundary: true, pilasterEvery: 8 }),
  causeway: Object.freeze({ remap: Object.freeze({ [TILE.BEDROCK]: TILE.ARMOR_CONCRETE }), boundary: true, pilasterEvery: 8 }),
  killhouse: Object.freeze({ remap: null, boundary: true, pilasterEvery: 0 }),
  caldera: Object.freeze({ remap: null, boundary: true, pilasterEvery: 0 }),
  // The METAL shell (parapet and the cells behind wall kelp) reads as reef
  // rock; GLASS drops the global streaked pane for a clean one. Safe while the
  // map authors no METAL inside the reef (tools/bikini-bottom-test.mjs).
  bikini_bottom: Object.freeze({
    remap: Object.freeze({ [TILE.METAL]: TILE.BB_ROCK, [TILE.GLASS]: TILE.BB_DOME_GLASS }), boundary: false, pilasterEvery: 0,
  }),
});
const NO_SURFACE = Object.freeze({ remap: null, boundary: false, pilasterEvery: 0 });

export function mapSurface(mapId) {
  return MAP_SURFACES[mapId] || NO_SURFACE;
}

/**
 * Boundary skin by resolved side tile. Only the plain grey shell materials
 * are reclad; authored trims (ACCENT bands, BRICK, RUST, numerals) keep their
 * own tiles, so a map's perimeter design survives the skin.
 */
export const BOUNDARY_SKIN = Object.freeze({
  [TILE.CONCRETE]: TILE.FACADE_PANEL,
  [TILE.STONE]: TILE.FACADE_PANEL,
  [TILE.BEDROCK]: TILE.FACADE_PANEL,
  [TILE.ARMOR_CONCRETE]: TILE.FACADE_PANEL,
  [TILE.METAL]: TILE.FACADE_PILLAR,
});

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

/** These tiles supply their own seams or deliberately have a seamless surface. */
const NO_RING_DARKEN = new Set([
  TILE.AIR_DEBUG, TILE.GLASS,
  TILE.ASPHALT, TILE.SAND, TILE.DIRT, TILE.GRASS_TOP, TILE.BEDROCK, TILE.RUST,
  TILE.DUST_SANDSTONE, TILE.DUST_PLASTER, TILE.DUST_ROCK, TILE.DUST_FLOOR,
  TILE.DUST_TRIM, TILE.DUST_TILE, TILE.DUST_CRATE, TILE.DUST_WOOD,
  TILE.FACADE_PANEL, TILE.FACADE_JOINT, TILE.FACADE_PILLAR, TILE.FACADE_BASE,
  // Cutout blades read as foliage; seafloor sand and road stay seamless like SAND/ASPHALT.
  TILE.BB_PINE_LEAF, TILE.BB_KELP, TILE.BB_SAND, TILE.BB_ROAD, TILE.BB_DOME_GLASS,
  ...Object.entries(TILE).filter(([name]) => name.startsWith('MC_')).map(([, slot]) => slot),
]);
const RING_DARKEN = 0.9;
/**
 * Poured and cut stone keep a faint block rhythm, enough to read wall courses
 * and distances, too weak to draw graph paper across a floor.
 */
const SOFT_RING = new Map([[TILE.CONCRETE, 0.95], [TILE.PALE, 0.95], [TILE.STONE, 0.94], [TILE.ARMOR_CONCRETE, 0.95],
  [TILE.BB_ROCK, 0.96], [TILE.BB_CORAL, 0.96]]);

/** Paint one tile, ring darkening included, through write(px, py, rgba). */
function paintTile(tile, write) {
  const paint = TILE_PAINTERS[tile];
  const ring = NO_RING_DARKEN.has(tile) ? 1 : SOFT_RING.get(tile) ?? RING_DARKEN;
  for (let py = 0; py < TILE_PX; py++) {
    for (let px = 0; px < TILE_PX; px++) {
      const c = paint(px, py);
      if (ring < 1 && (px === 0 || py === 0 || px === TILE_PX - 1 || py === TILE_PX - 1)) {
        write(px, py, [c[0] * ring, c[1] * ring, c[2] * ring, c[3]]);
      } else write(px, py, c);
    }
  }
}

function paintSheet(data) {
  for (const key of Object.keys(TILE_PAINTERS)) {
    const tile = Number(key);
    const col = (tile % GRID) * TILE_PX;
    const row = ((tile / GRID) | 0) * TILE_PX;
    paintTile(tile, (px, py, c) => {
      const i = ((row + py) * ATLAS_SIZE + col + px) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3];
    });
  }
}

/** One texture-array layer per TILE slot; the mesher's layer index is the slot. */
export const TERRAIN_LAYERS = Math.max(...Object.values(TILE)) + 1;

/** RGBA8 layers, top image row first, for a DataArrayTexture. */
export function paintTerrainLayers() {
  const data = new Uint8Array(TILE_PX * TILE_PX * 4 * TERRAIN_LAYERS);
  for (const key of Object.keys(TILE_PAINTERS)) {
    const tile = Number(key);
    const base = tile * TILE_PX * TILE_PX * 4;
    paintTile(tile, (px, py, c) => {
      const i = base + (py * TILE_PX + px) * 4;
      data[i] = clamp255(c[0]); data[i + 1] = clamp255(c[1]); data[i + 2] = clamp255(c[2]); data[i + 3] = clamp255(c[3]);
    });
  }
  return data;
}

/**
 * Tangent-space pixel normals from each layer's luminance: mortar, seams and
 * rivets read as relief under grazing sun. Sobel samples wrap inside the tile,
 * so neighbouring blocks never disagree at a seam. +X follows u, +Y follows
 * the image rows downward (the mesher's t coordinate).
 */
export function paintTerrainNormals(albedo, strength = 1.0) {
  const data = new Uint8Array(albedo.length);
  const lum = (layer, x, y) => {
    const i = layer * TILE_PX * TILE_PX * 4 + (((y + TILE_PX) % TILE_PX) * TILE_PX + ((x + TILE_PX) % TILE_PX)) * 4;
    return (albedo[i] * 0.299 + albedo[i + 1] * 0.587 + albedo[i + 2] * 0.114) / 255;
  };
  for (let layer = 0; layer < TERRAIN_LAYERS; layer++) {
    for (let y = 0; y < TILE_PX; y++) {
      for (let x = 0; x < TILE_PX; x++) {
        const dx = (lum(layer, x + 1, y - 1) + 2 * lum(layer, x + 1, y) + lum(layer, x + 1, y + 1))
          - (lum(layer, x - 1, y - 1) + 2 * lum(layer, x - 1, y) + lum(layer, x - 1, y + 1));
        const dy = (lum(layer, x - 1, y + 1) + 2 * lum(layer, x, y + 1) + lum(layer, x + 1, y + 1))
          - (lum(layer, x - 1, y - 1) + 2 * lum(layer, x, y - 1) + lum(layer, x + 1, y - 1));
        let nx = -dx * strength, ny = -dy * strength, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        const i = layer * TILE_PX * TILE_PX * 4 + (y * TILE_PX + x) * 4;
        data[i] = Math.round((nx * 0.5 + 0.5) * 255);
        data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        data[i + 3] = 255;
      }
    }
  }
  return data;
}

function arrayTexture(data, colorSpace, anisotropy) {
  const texture = new THREE.DataArrayTexture(data, TILE_PX, TILE_PX, TERRAIN_LAYERS);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.colorSpace = colorSpace;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Terrain texture arrays: every tile is its own layer, so mip levels never
 * bleed across neighbouring tiles and anisotropic filtering stays clean at
 * grazing angles. The 2D sheet remains for fluids, debris and detail props.
 */
export function buildTerrainTextures({ anisotropy = 4, normals = false } = {}) {
  const albedo = paintTerrainLayers();
  const map = arrayTexture(albedo, THREE.SRGBColorSpace, anisotropy);
  map.name = 'terrain-albedo';
  const normalMap = normals ? arrayTexture(paintTerrainNormals(albedo), THREE.NoColorSpace, anisotropy) : null;
  if (normalMap) {
    normalMap.name = 'terrain-normals';
    normalMap.magFilter = THREE.LinearFilter;
    normalMap.minFilter = THREE.LinearMipmapLinearFilter;
  }
  return { map, normalMap };
}

/**
 * Paint every tile into a fresh canvas, wrap it in a THREE.CanvasTexture and
 * hand back the accessor surface the mesher/renderer needs.
 */
export function buildAtlas({ anisotropy = 4, normals = false } = {}) {
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
  let terrain = null;

  return {
    canvas,
    /** THREE.CanvasTexture configured for crisp voxel texels under minification. */
    texture() { return tex; },
    /** Lazily built texture arrays for the chunk mesher's terrain material. */
    terrainTextures() {
      terrain ??= buildTerrainTextures({ anisotropy, normals });
      return terrain;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      tex.dispose();
      terrain?.map.dispose();
      terrain?.normalMap?.dispose();
    },
    tileRect,
    faceTile,
  };
}
