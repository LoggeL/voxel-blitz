// The frozen Conquest plan of each battlefield (flags, HQs, river, crossings):
// FRONTIER_PLAN (shared/conquest-contract.js) and REDROCK_PLAN
// (shared/world/redrock-plan.js). Both are dependency-free data, so the
// client reads them without building any terrain.
import { FRONTIER_PLAN } from '../conquest-contract.js';
import { REDROCK_PLAN } from './redrock-plan.js';

const PLANS = Object.freeze({ frontier: FRONTIER_PLAN, redrock: REDROCK_PLAN });

/** The plan of a battlefield id; Frontier's for any other id (the default Conquest map). */
export const conquestPlanFor = mapId => PLANS[mapId] ?? FRONTIER_PLAN;

/**
 * Water surface y of a plan river at z: Redrock's upper pool (`river.reservoir`,
 * held back by the dam at reservoir.z1) stands over the whole reach north of the
 * dam (y26), the river south of it at river.surfaceY (y19); Frontier's river has
 * one level. Matches redrockSurfaceAt in shared/world/redrock-terrain.js.
 */
export function riverSurfaceAt(river, z) {
  const pool = river?.reservoir;
  return pool && Number.isFinite(pool.surfaceY) && Number.isFinite(pool.z1) && z < pool.z1 ? pool.surfaceY : river?.surfaceY;
}
