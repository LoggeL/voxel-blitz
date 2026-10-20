// The frozen Conquest plan of each battlefield (flags, HQs, river, crossings):
// FRONTIER_PLAN (shared/conquest-contract.js) and REDROCK_PLAN
// (shared/world/redrock-plan.js). Both are dependency-free data, so the
// client reads them without building any terrain.
import { FRONTIER_PLAN } from '../conquest-contract.js';
import { REDROCK_PLAN } from './redrock-plan.js';

const PLANS = Object.freeze({ frontier: FRONTIER_PLAN, redrock: REDROCK_PLAN });

/** The plan of a battlefield id; Frontier's for any other id (the default Conquest map). */
export const conquestPlanFor = mapId => PLANS[mapId] ?? FRONTIER_PLAN;
