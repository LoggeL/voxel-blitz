// Frontier v2 layout and map metadata (spec 3.2 and 4.4). Pure data derived
// from FRONTIER_PLAN, the terrain heightfield and the site modules: every y is
// read from the terrain (feet = top voxel + 1.02), never a constant. No voxels
// are built here, so the server can publish mapMeta before allocating a world.
// shared/world/frontier-layout.js re-exports this module.

import { FRONTIER_PLAN } from '../../conquest-contract.js';
import { FRONTIER_DIMENSIONS } from '../dimensions.js';
import {
  FRONTIER_ROAD_PLAN, FRONTIER_CROSSINGS, frontierTopY, frontierSurfaceY, frontierWaterY, riverCentreX,
} from '../frontier-terrain.js';
import { BOAT_RULES } from '../../vehicle-handling/boat.js';
import { FARM_SITE } from './farm.js';
import { VILLAGE_SITE } from './village.js';
import { BRIDGE_SITE } from './bridge.js';
import { BUNKERS_SITE, OBSERVATION_TOWER, observationTowerLadder } from './bunkers.js';
import { WORKS_SITE } from './works.js';
import { frontierWrecks } from './dressing.js';
import { FRONTIER_LOCATIONS } from './locations.js';
import { battlefieldLayoutKit, battlefieldMetadata, battlefieldReservedCells, deepFreeze, round2 } from '../battlefield-layout.js';

export { frontierSurfaceY };

const { sx: SX, sz: SZ } = FRONTIER_PLAN.dimensions;
const LAYOUT = battlefieldLayoutKit({ dimensions: FRONTIER_PLAN.dimensions, topY: frontierTopY });
const { mirrorYaw } = LAYOUT;
/** Feet position on the terrain at continuous (x, z). */
export const feet = LAYOUT.feet;

/** Flag sites in A..E order. */
export const FRONTIER_SITES = Object.freeze([FARM_SITE, VILLAGE_SITE, BRIDGE_SITE, BUNKERS_SITE, WORKS_SITE]);

const BASE_NAMES = { alpha: 'West HQ', bravo: 'East HQ' };

// ----------------------------------------------------------------- vehicles

/** The HQ pads, both teams' patrol boats on the river, then each flag site's hull. */
function buildVehicleSpawns(airfields) {
  const spawns = LAYOUT.hqVehicleSpawns(airfields);
  for (const pad of FRONTIER_BOAT_PADS) for (const team of ['alpha', 'bravo']) {
    const x = team === 'alpha' ? pad.x : SX - pad.x, z = team === 'alpha' ? pad.z : SZ - pad.z;
    // Named by where the mooring lies: the east boats' mirror swaps north and south.
    const side = z < SZ / 2 ? 'north' : 'south';
    spawns.push({ id: `${team}-boat-${side}`, team, type: 'boat', x, y: boatPadY(x, z), z, yaw: team === 'alpha' ? pad.yaw : mirrorYaw(pad.yaw) });
  }
  spawns.push(...LAYOUT.siteVehicleSpawns(FRONTIER_SITES));
  return spawns;
}

// ------------------------------------------------------------------ river

/**
 * West-bank patrol boat moorings (alpha frame; the east boats are the point
 * mirror). Each lies where a reach narrows toward a crossing, 5 m off the west
 * bank and 9 m beside the boat lane, with room for a full pivot and its bow
 * along the lane toward the Iron Bridge: the north one above ford-north, the
 * south one in the reach below the Iron Bridge.
 */
export const FRONTIER_BOAT_PADS = Object.freeze([
  Object.freeze({ id: 'north', x: 373, z: 236, yaw: -2.83 }),
  Object.freeze({ id: 'south', x: 361, z: 464, yaw: 0.28 }),
]);
/** Moored hull height: the water face, less the draft, plus the 0.02 m pad gap every hull has. */
const boatPadY = (x, z) => round2(frontierWaterY(x, z) + 1 - BOAT_RULES.draft + 0.02);

/**
 * The boat lane: the whole navigable river, from the north end of the combat
 * area to the south end, down the deep middle of the channel (the islands
 * stand 6 m or more off the centreline), over both fords and through one arch
 * of every bridge. Each bridge has its piers on the centreline, so the lane
 * swings `LANE_ARCH` m off it under a deck: east under bridge-north and the
 * Iron Bridge (its east arch, x 385-393, under the deck at y 24), west under
 * bridge-south. Away from the Iron Bridge the lane is its own point mirror.
 * Bots steer along it; it is not a rule (players may go anywhere afloat).
 */
const LANE_ENDS = Object.freeze([32, SZ - 32]);
const LANE_STEP = 8, LANE_ARCH = 5;
function laneArch(z) {
  let bias = 0;
  for (const c of FRONTIER_CROSSINGS) {
    if (c.kind !== 'bridge') continue;
    const d = Math.abs(z - c.z), side = c.z <= SZ / 2 ? 1 : -1;
    if (d < 30) bias += side * LANE_ARCH * (d <= 12 ? 1 : 1 - (d - 12) / 18);
  }
  return bias;
}
function buildWaterways() {
  const points = [];
  for (let z = LANE_ENDS[0]; z <= LANE_ENDS[1]; z += LANE_STEP) {
    const x = round2(riverCentreX(z) + laneArch(z));
    points.push([x, frontierWaterY(x, z) + 1, z]);
  }
  return [{ id: 'river', kind: 'boat-lane', width: 5, points }];
}

// -------------------------------------------------------------- dressing

function buildDressing() {
  return frontierWrecks().map(w => ({ id: w.id, kind: 'wreck', type: w.type, near: w.near, x: w.smokeX, y: w.y, z: w.smokeZ }));
}

// ------------------------------------------------------------ the bundle

let bundle = null;
function frontierBundle() {
  if (bundle) return bundle;
  const flags = LAYOUT.buildFlags(FRONTIER_PLAN.flags, FRONTIER_SITES);
  const bases = LAYOUT.buildBases(FRONTIER_PLAN.hqs, BASE_NAMES);
  const airfields = LAYOUT.buildAirfields();
  const vehicleSpawns = buildVehicleSpawns(airfields);
  for (const field of airfields) delete field.routesByVehicle;
  const conquest = {
    version: 2,
    flags, bases,
    combatArea: { ...FRONTIER_PLAN.combatArea },
    vehicleSpawns,
    airfields,
    roads: LAYOUT.buildRoads(FRONTIER_ROAD_PLAN),
    crossings: LAYOUT.buildCrossings(FRONTIER_CROSSINGS),
    waterways: buildWaterways(),
    weather: 'golden',
    dressing: buildDressing(),
  };
  const towerTop = frontierTopY(OBSERVATION_TOWER.x, OBSERVATION_TOWER.z);
  const ladders = [
    ...airfields.map(f => f.tower.ladder),
    observationTowerLadder(towerTop),
  ];
  bundle = deepFreeze({ conquest, landmarks: LAYOUT.buildLandmarks(flags, FRONTIER_SITES, FRONTIER_LOCATIONS), ladders });
  return bundle;
}

/** Road polylines `[[x, z], ...]` (authored control points). */
export const FRONTIER_ROADS = Object.freeze(FRONTIER_ROAD_PLAN.map(r => Object.freeze(r.points.map(p => Object.freeze([p[0], p[1]])))));

/** Lazily derived (terrain build on first use) but stable, frozen objects. */
export const FRONTIER_LAYOUT = Object.freeze({
  get conquest() { return frontierBundle().conquest; },
  get airfields() { return frontierBundle().conquest.airfields; },
  get landmarks() { return frontierBundle().landmarks; },
  get ladders() { return frontierBundle().ladders; },
});

/** Map metadata for Frontier v2 (spec 3.2). Static: no voxel world needed. */
export function createFrontierMetadata() {
  return battlefieldMetadata({
    id: 'frontier', name: 'Frontier', dimensions: FRONTIER_DIMENSIONS, groundLevel: FRONTIER_PLAN.heights.valleyMin,
    spawnBounds: { minX: 24, maxX: 743, minZ: 24, maxZ: 743, minY: 20, maxY: 79 },
  }, frontierBundle());
}

/** Cells the generator must leave open after every set piece (battlefieldReservedCells). */
export function frontierReservedCells() {
  return battlefieldReservedCells(frontierBundle().conquest);
}
