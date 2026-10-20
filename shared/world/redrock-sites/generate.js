// Redrock Canyon generator: fills the 768 x 80 x 768 heightfield from
// shared/world/redrock-terrain.js (banded red strata in every cliff), then
// builds the five flag sites, the dam and the two crossings, the two HQ
// airfields (Frontier's builder: the plateaus are the same), the four places
// and the desert flora. Finally it re-opens every reserved cell (spawns,
// vehicle pads, roads) so no set piece can block an authoritative spawn or
// route (the Frontier passes, shared through frontier-sites/generate.js).

import {
  AIR, BEDROCK, STONE, DIRT, SAND, DUST_ROCK, DUST_SANDSTONE, MC_WATER, MC_GRAVEL, MC_CLAY, GRAVEL, MUD,
} from '../blocks.js';
import { redrockTerrain, REDROCK_CELL_KIND as KIND, strataAt } from '../redrock-terrain.js';
import { createSiteKit } from '../frontier-sites/kit.js';
import { buildAirfields } from '../frontier-sites/hq-airfield.js';
import { buildEntrances, reopenRoads, reopenReserved } from '../frontier-sites/generate.js';
import { buildOasis } from './oasis.js';
import { buildMine } from './mine.js';
import { buildDamSite } from './dam.js';
import { buildRadar } from './radar.js';
import { buildRailhead } from './railhead.js';
import { buildRedrockLocations } from './locations.js';
import { buildRedrockFlora } from './flora.js';
import { redrockReservedCells } from './layout.js';

/** Fill terrain columns: red strata in cliffs and rock, sand and dirt under the plains. */
export function fillRedrockTerrain(blocks, dimensions, terrain) {
  const { sx: SX, sy: SY, sz: SZ } = dimensions;
  const plane = SX * SZ;
  const { heights, ground, surface, kind, water } = terrain;
  blocks.fill(AIR);
  // Per-layer strata so cliff faces read as horizontal bands.
  const strata = Uint8Array.from({ length: SY }, (_, y) => strataAt(y));
  for (let y = 0; y < SY; y++) {
    const layer = y * plane, band = strata[y];
    for (let i = 0; i < plane; i++) {
      const k = kind[i];
      const top = k === KIND.BRIDGE ? ground[i] : heights[i];
      let m = AIR;
      if (y === 0) m = BEDROCK;
      else if (y < top - 4) m = y < 12 ? STONE : band;
      else if (y < top) {
        const s = surface[i];
        if (k === KIND.CLIFF || s === DUST_ROCK || s === DUST_SANDSTONE) m = band;
        else if (k === KIND.RIVER || k === KIND.BRIDGE || k === KIND.FORD) m = MC_CLAY;
        else if (s === SAND) m = y >= top - 2 ? SAND : DIRT;
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
 * Build the complete Redrock world into `blocks` (y/z/x order).
 * `heights` receives the top-solid height map (templates rebuild it again).
 */
export function generateRedrockInto(world, blocks, heights) {
  const dimensions = world.dimensions;
  const terrain = redrockTerrain();
  fillRedrockTerrain(blocks, dimensions, terrain);
  const kit = createSiteKit({ blocks, dimensions, terrain });
  buildOasis(kit);
  buildMine(kit);
  buildDamSite(kit);
  buildRadar(kit);
  buildRailhead(kit);
  buildAirfields(kit);
  buildRedrockLocations(kit);
  kit.flora = buildRedrockFlora(kit);
  buildEntrances(kit);
  reopenRoads(kit);
  reopenReserved(kit, [...redrockReservedCells(), ...kit.reserved]);
  if (heights) heights.set(terrain.heights);
  return kit;
}
