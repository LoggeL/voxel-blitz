import { REDROCK_PLAN } from './world/redrock-plan.js';
import { redrockSurfaceY } from './world/redrock-terrain.js';

// Redrock Canyon cameras for map-capture-shots.js, placed from REDROCK_PLAN
// anchors exactly like the Frontier ground shots: each end is [x, z, lift]
// and stands `lift` metres above the planned terrain (redrockSurfaceY), so
// the heightfield is only built when a Redrock shot is read.

const flag = (id) => REDROCK_PLAN.flags.find((entry) => entry.id === id);
const [A, B, C, D, E] = ['A', 'B', 'C', 'D', 'E'].map(flag);
const HQ = REDROCK_PLAN.hqs.alpha;

/** The planned surface the Redrock anchors stand on. */
export const redrockCaptureSurface = redrockSurfaceY;

export function redrockCaptureShots({ groundShot, overview }) {
  const shot = (id, from, to, fov, options) => groundShot(id, from, to, fov, { ...options, map: 'redrock', surface: 'redrock' });
  return [
    // West HQ plateau edge looking east across the mesas toward the dam towers.
    shot('vista', [HQ.x + 70, HQ.z - 18, 9], [C.x, C.z, 12], 62),
    // Palmera Oasis: the pool and palms, the adobe court behind.
    shot('oasis', [A.x + 10, A.z + 52, 7], [A.x - 6, A.z - 6, 3], 70),
    // Copperhead Mine: headframe and ore hoppers from the haul road.
    shot('mine', [B.x - 40, B.z - 30, 7], [B.x + 6, B.z + 4, 10], 68),
    // Redrock Dam from the canyon floor downstream: spillway, intake towers.
    shot('dam', [C.x - 4, C.z + 68, 2.6], [C.x, C.z + 2, 9], 72),
    // Along the dam crest road, east, the reservoir on the left.
    shot('dam-crest', [C.x - 44, C.z - 1, 3.4], [C.x + 30, C.z - 4, 2], 74),
    // Mesa Radar: the radome and dish tower on the east mesa.
    shot('radar', [D.x - 10, D.z + 52, 9], [D.x + 30, D.z + 18, 12], 66),
    // Sulphur Railhead: water tower, station and the yellow heaps.
    shot('railhead', [E.x - 44, E.z - 26, 8], [E.x + 14, E.z + 22, 10], 66),
    // The rail trestle over the south canyon, from the canyon floor below it.
    shot('trestle', [C.x + 4, 548, 2.6], [C.x, 500, 10], 70),
    // The reservoir from the north-west shore toward the dam.
    shot('reservoir', [C.x - 60, 250, 8], [C.x, C.z - 6, 4], 64),
    overview(),
  ];
}
