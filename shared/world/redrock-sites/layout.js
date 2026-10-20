// Redrock Canyon layout and map metadata: the Redrock twin of
// shared/world/frontier-sites/layout.js. Pure data derived from REDROCK_PLAN,
// the terrain heightfield and the site modules; every y is read from the
// terrain (feet = top voxel + 1.02). No voxels are built here, so the server
// can publish mapMeta before allocating a world.
//
// The HQs (airfields, motor pools, HQ spawns) are Frontier's HQ_LAYOUT,
// point-mirrored for bravo exactly as on Frontier (the plateaus are the same
// rectangles; shared/world/battlefield-layout.js builds both); the flags,
// roads and places are mirror-symmetric about x = 384.

import { REDROCK_PLAN } from '../redrock-plan.js';
import { REDROCK_ROAD_PLAN, REDROCK_CROSSINGS, redrockTopY, redrockSurfaceY } from '../redrock-terrain.js';
import { OASIS_SITE } from './oasis.js';
import { MINE_SITE } from './mine.js';
import { DAM_SITE } from './dam.js';
import { RADAR_SITE } from './radar.js';
import { RAILHEAD_SITE } from './railhead.js';
import { REDROCK_LOCATIONS } from './locations.js';
import { battlefieldLayoutKit, battlefieldMetadata, battlefieldReservedCells, deepFreeze } from '../battlefield-layout.js';

export { redrockSurfaceY };

export const REDROCK_DIMENSIONS = REDROCK_PLAN.dimensions;
const LAYOUT = battlefieldLayoutKit({ dimensions: REDROCK_PLAN.dimensions, topY: redrockTopY });
/** Feet position on the terrain at continuous (x, z). */
export const feet = LAYOUT.feet;

/** Flag sites in A..E order. */
export const REDROCK_SITES = Object.freeze([OASIS_SITE, MINE_SITE, DAM_SITE, RADAR_SITE, RAILHEAD_SITE]);

// ------------------------------------------------------------ the bundle

let bundle = null;
function redrockBundle() {
  if (bundle) return bundle;
  const flags = LAYOUT.buildFlags(REDROCK_PLAN.flags, REDROCK_SITES);
  const bases = LAYOUT.buildBases(REDROCK_PLAN.hqs);
  const airfields = LAYOUT.buildAirfields();
  // The HQ pads (the mobile AA in the motor pool's south bay, as on Frontier), then each flag site's hull.
  const vehicleSpawns = [...LAYOUT.hqVehicleSpawns(airfields), ...LAYOUT.siteVehicleSpawns(REDROCK_SITES)];
  for (const field of airfields) delete field.routesByVehicle;
  const conquest = {
    version: 2,
    flags, bases,
    combatArea: { ...REDROCK_PLAN.combatArea },
    vehicleSpawns,
    airfields,
    roads: LAYOUT.buildRoads(REDROCK_ROAD_PLAN),
    crossings: LAYOUT.buildCrossings(REDROCK_CROSSINGS),
    weather: 'desert',
    dressing: [],
  };
  const ladders = airfields.map(f => f.tower.ladder);
  bundle = deepFreeze({ conquest, landmarks: LAYOUT.buildLandmarks(flags, REDROCK_SITES, REDROCK_LOCATIONS), ladders });
  return bundle;
}

/** Map metadata for Redrock Canyon. Static: no voxel world needed. */
export function createRedrockMetadata() {
  return battlefieldMetadata({
    id: 'redrock', name: 'Redrock Canyon', dimensions: REDROCK_DIMENSIONS, groundLevel: REDROCK_PLAN.heights.plainMin,
    spawnBounds: { minX: 24, maxX: 743, minZ: 24, maxZ: 743, minY: 18, maxY: 79 },
  }, redrockBundle());
}

/** Cells the generator must leave open after every set piece (battlefieldReservedCells). */
export function redrockReservedCells() {
  return battlefieldReservedCells(redrockBundle().conquest);
}
