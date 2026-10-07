// Battlefield dressing between the sites (spec 4.3): five burnt-out wrecks on
// the approaches to C, D and B (two tanks, two trucks, a crashed helicopter),
// hedgerows and dry-stone walls across the open fields between the flags, and
// the pre-carved shell craters recorded for tests and metadata. Hedges and
// walls are authored for the west bank and point-mirrored onto the east bank.

import { FRONTIER_CRATERS, frontierTopY } from '../frontier-terrain.js';
import { mirroredKit } from './kit.js';
import { hedge, fieldWall, wreckTank, wreckTruck, wreckHelicopter } from './props.js';

/** Wreck props. `y` is the smoke anchor on top of the hulk (terrain derived). */
const WRECKS = [
  { id: 'wreck-tank-c-west', type: 'tank', x: 346, z: 348, alongX: true, near: 'C', rise: 4 },
  { id: 'wreck-truck-c-east', type: 'truck', x: 424, z: 420, alongX: false, near: 'C', rise: 4 },
  { id: 'wreck-tank-d-slope', type: 'tank', x: 460, z: 282, alongX: true, near: 'D', rise: 4 },
  { id: 'wreck-helicopter-d', type: 'helicopter', x: 528, z: 206, alongX: true, near: 'D', rise: 5 },
  { id: 'wreck-truck-b', type: 'truck', x: 246, z: 470, alongX: false, near: 'B', rise: 4 },
];

let wrecks = null;
export function frontierWrecks() {
  wrecks ??= Object.freeze(WRECKS.map(w => Object.freeze({ ...w, y: frontierTopY(w.x, w.z) + w.rise, smokeX: w.x + 0.5, smokeZ: w.z + 0.5 })));
  return wrecks;
}

/** West-bank hedgerows and walls; each is mirrored onto the east bank. */
export const DRESSING_HEDGES = Object.freeze([
  [[288, 246], [318, 262], [348, 300]],
  [[300, 418], [330, 440], [346, 468]],
  [[206, 330], [248, 348], [292, 358]],
  [[160, 300], [188, 318], [214, 322]],
  [[300, 596], [326, 610], [352, 612]],
  [[228, 140], [262, 156], [300, 158]],
].map(points => Object.freeze(points.map(p => Object.freeze(p)))));
export const DRESSING_WALLS = Object.freeze([
  [[200, 402], [238, 420], [262, 424]],
  [[328, 516], [338, 540], [340, 562]],
  [[312, 352], [332, 346]],
  [[260, 432], [286, 440]],
].map(points => Object.freeze(points.map(p => Object.freeze(p)))));

export function buildDressing(kit) {
  for (const w of frontierWrecks()) {
    if (w.type === 'tank') wreckTank(kit, w.x, w.z, w.alongX);
    else if (w.type === 'truck') wreckTruck(kit, w.x, w.z, w.alongX);
    else wreckHelicopter(kit, w.x, w.z);
  }
  for (const side of [kit, mirroredKit(kit)]) {
    for (const points of DRESSING_HEDGES) hedge(side, points, { gapEvery: 19 });
    for (const points of DRESSING_WALLS) fieldWall(side, points, { gapEvery: 17 });
  }
  for (const c of FRONTIER_CRATERS) kit.feature('crater', { x: c.x, z: c.z, r: c.r });
}
