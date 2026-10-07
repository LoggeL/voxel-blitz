// Frontier v2 generator: fills the 768 x 80 x 768 heightfield from
// shared/world/frontier-terrain.js, then builds the five flag sites, the two
// HQ airfields, the forests, the battlefield dressing and the roadside
// dressing on top of it.
// Finally it re-opens every reserved cell (spawns, vehicle pads, roads) so no
// set piece can ever block an authoritative spawn or route.

import {
  AIR, BEDROCK, STONE, DIRT, DUST_ROCK, MC_WATER, MC_GRAVEL, MC_CLAY, GRAVEL, MUD, COBBLE_WALL,
  MEADOW, DRY_GRASS, FIELD_WHEAT, SCORCHED_EARTH, PINE_NEEDLES,
} from '../blocks.js';
import { frontierTerrain, FRONTIER_CELL_KIND as KIND } from '../frontier-terrain.js';
import { createSiteKit } from './kit.js';
import { buildFarm } from './farm.js';
import { buildVillage } from './village.js';
import { buildBridgeSite } from './bridge.js';
import { buildBunkers } from './bunkers.js';
import { buildWorks } from './works.js';
import { buildAirfields } from './hq-airfield.js';
import { buildForests } from './forest.js';
import { buildDressing } from './dressing.js';
import { buildRoadside } from './roadside.js';
import { frontierReservedCells } from './layout.js';

/** Fill terrain columns. Deep subsoil is single-material to keep runs low. */
export function fillFrontierTerrain(blocks, dimensions, terrain) {
  const { sx: SX, sy: SY, sz: SZ } = dimensions;
  const plane = SX * SZ;
  const { heights, ground, surface, kind, water } = terrain;
  blocks.fill(AIR);
  // Column-major fill would thrash the y/z/x layout; walk layer by layer.
  for (let y = 0; y < SY; y++) {
    const layer = y * plane;
    for (let i = 0; i < plane; i++) {
      const k = kind[i];
      const top = k === KIND.BRIDGE ? ground[i] : heights[i];
      let m = AIR;
      if (y === 0) m = BEDROCK;
      else if (y < top - 3) m = STONE;
      else if (y < top) {
        if (k === KIND.CLIFF || surface[i] === STONE || surface[i] === DUST_ROCK) m = ((y / 3) | 0) % 2 ? STONE : DUST_ROCK;
        else if (k === KIND.RIVER || k === KIND.BRIDGE) m = MC_CLAY;
        else m = DIRT;
      } else if (y === top) {
        if (k === KIND.RIVER || k === KIND.BRIDGE) m = top <= 18 ? MC_GRAVEL : MUD;
        else if (k === KIND.FORD) m = GRAVEL;
        else m = surface[i];
      } else if (water[i] && y <= water[i]) m = MC_WATER;
      if (m !== AIR) blocks[layer + i] = m;
    }
  }
}

/**
 * Build the complete Frontier world into `blocks` (y/z/x order).
 * `heights` receives the top-solid height map (templates rebuild it again).
 */
export function generateFrontierV2Into(world, blocks, heights) {
  const dimensions = world.dimensions;
  const terrain = frontierTerrain();
  fillFrontierTerrain(blocks, dimensions, terrain);
  const kit = createSiteKit({ blocks, dimensions, terrain });
  buildForests(kit);
  buildDressing(kit);
  buildFarm(kit);
  buildVillage(kit);
  buildBridgeSite(kit);
  buildBunkers(kit);
  buildWorks(kit);
  buildAirfields(kit);
  // Roadside dressing last among the set pieces: it only builds on ground no site claimed.
  kit.roadside = buildRoadside(kit);
  buildEntrances(kit);
  reopenRoads(kit);
  reopenReserved(kit, [...frontierReservedCells(), ...kit.reserved]);
  if (heights) heights.set(terrain.heights);
  return kit;
}

/**
 * Entrance steps. A building on a slope sits on a level foundation at the
 * highest ground of its footprint, so a doorway on the downhill side can open
 * two or more voxels above the ground outside it. Every doorway cell (two
 * clear voxels above the floor in the outer wall ring) gets a flight of
 * one-voxel steps running straight out until it meets the ground, so every
 * enterable building can be walked into from any of its doors.
 */
const GROUND_TOPS = new Set([DIRT, STONE, DUST_ROCK, GRAVEL, MUD, MC_CLAY, MC_GRAVEL, MEADOW, DRY_GRASS, FIELD_WHEAT, SCORCHED_EARTH, PINE_NEEDLES]);
export function buildEntrances(kit, maxRun = 10) {
  const { roadIndex, kind } = kit.terrain;
  const cell = (x, z) => z * kit.SX + x;
  /** Standable top at or below `limit` in a column (first solid voxel scanning down). */
  const groundBelow = (x, z, limit) => {
    for (let y = limit; y > 0; y--) if (kit.solid(x, y, z)) return y;
    return 0;
  };
  for (const b of kit.features.filter(f => f.kind === 'building' && f.enterable && !f.open)) {
    const f = b.floorY;
    const ring = [];
    for (let x = b.minX; x <= b.maxX; x++) { ring.push([x, b.minZ, 0, -1]); ring.push([x, b.maxZ, 0, 1]); }
    for (let z = b.minZ + 1; z < b.maxZ; z++) { ring.push([b.minX, z, -1, 0]); ring.push([b.maxX, z, 1, 0]); }
    for (const [x, z, nx, nz] of ring) {
      if (kit.solid(x, f + 1, z) || kit.solid(x, f + 2, z) || !kit.solid(x, f, z)) continue;     // not a doorway
      // Steps in the foundation's masonry; plain ground under the sill gets field stone.
      const under = kit.get(x, f - 1, z);
      const material = kit.solid(x, f - 1, z) && !GROUND_TOPS.has(under) ? under : COBBLE_WALL;
      let steps = 0;
      for (let k = 1; k <= maxRun; k++) {
        const cx = x + nx * k, cz = z + nz * k;
        if (cx < 0 || cz < 0 || cx >= kit.SX || cz >= kit.SZ) break;
        const top = f - (k - 1);                      // landing level with the floor, then one down per cell
        const g = groundBelow(cx, cz, top + 1);
        if (g >= top) break;                          // ground reaches the stair line: one step up from here
        if (roadIndex[cell(cx, cz)] || kind[cell(cx, cz)] === KIND.RIVER || kind[cell(cx, cz)] === KIND.FORD) break;
        let blocked = false;
        for (let y = g + 1; y <= top + 2 && !blocked; y++) {
          const v = kit.get(cx, y, cz);
          if (v !== AIR && v !== MC_WATER) blocked = true;
        }
        if (blocked) break;                           // never cut through another structure
        kit.box(cx, g + 1, cz, cx, top, cz, material);
        steps++;
      }
      if (steps) kit.feature('entrance', { building: b.id ?? `${b.minX},${b.minZ}`, x, z, nx, nz, floorY: f, steps });
    }
  }
}

/** Five voxels of headroom over every road and ford cell: no prop seals a route. */
export function reopenRoads(kit, headroom = 5) {
  const { roadIndex, heights, kind } = kit.terrain;
  for (let z = 0; z < kit.SZ; z++) for (let x = 0; x < kit.SX; x++) {
    const i = z * kit.SX + x;
    if (!roadIndex[i] && kind[i] !== KIND.FORD) continue;
    const top = heights[i];
    for (let y = top + 1; y <= top + headroom; y++) {
      const b = kit.get(x, y, z);
      if (b !== AIR && b !== MC_WATER) kit.set(x, y, z, AIR);
    }
  }
}

/** Air above every reserved footprint and a solid, dry floor under it. */
export function reopenReserved(kit, reserved) {
  for (const r of reserved) {
    for (let z = r.minZ; z <= r.maxZ; z++) for (let x = r.minX; x <= r.maxX; x++) {
      const floor = r.floorY ?? kit.top(x, z);
      if (!kit.solid(x, floor, z)) kit.set(x, floor, z, r.floor ?? DIRT);
      kit.box(x, floor + 1, z, x, floor + r.height, z, AIR);
    }
  }
}
