import { GROUND } from './blocks.js';

const spawnRows = (rows) => rows.flatMap(z => [18, 40, 62, 84, 106, 128, 150, 172].map(x => [x, z, GROUND]));
const north = spawnRows([11, 19]);
const south = spawnRows([124, 132]);
export const LARGE_SPAWN_ANCHORS = Object.freeze({
  fun: [...north, ...south],
  tdm: { alpha: south, bravo: north },
  snd: { attackers: south, defenders: north },
});
export const LARGE_SITES = Object.freeze([
  { id: 'A', minX: 29, maxX: 42, minZ: 64, maxZ: 78, y: GROUND + 1.02 },
  { id: 'B', minX: 149, maxX: 162, minZ: 64, maxZ: 78, y: GROUND + 1.02 },
]);
export const LARGE_LANDMARKS = Object.freeze({
  harbor: [
    { id: 'dock-a', name: 'Dock A', x: 35, z: 71, floorY: GROUND },
    { id: 'gantry', name: 'Freight Gantry', x: 96, z: 72, floorY: GROUND },
    { id: 'dock-b', name: 'Dock B', x: 155, z: 71, floorY: GROUND },
  ],
  canyon: [
    { id: 'west-ruins', name: 'West Ruins', x: 35, z: 71, floorY: GROUND },
    { id: 'oasis', name: 'Dry River', x: 96, z: 72, floorY: GROUND },
    { id: 'east-ruins', name: 'East Ruins', x: 155, z: 71, floorY: GROUND },
  ],
});
