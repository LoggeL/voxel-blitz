import { GROUND } from './blocks.js';

const point = (x, z, floor = GROUND) => Object.freeze({ x, y: floor + 1.02, z });
const deepFreeze = o => { for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); return Object.freeze(o); };

// Dedicated PvE layout (Reactor 9): three staged objectives, each fed by one of
// the northern turbine hall and the two dog-leg loading tunnels. Enemies enter
// through the ingress gates; defenders hold the stage's build zone.
const layout = {
  id: 'reactor',
  bounds: { minX: 5, maxX: 122, minZ: 5, maxZ: 90 },
  spawnBounds: { minX: 52, maxX: 76, minZ: 40, maxZ: 84, minY: GROUND + 1, maxY: GROUND + 1.1 },
  // Defender-only containment volumes (max exclusive). NPCs emerge through visible energy gates.
  ingress: [ { minX: 55, maxX: 82, minZ: 4, maxZ: 21 }, { minX: 4, maxX: 21, minZ: 38, maxZ: 69 }, { minX: 110, maxX: 124, minZ: 28, maxZ: 59 } ],
  solids: [],
  lanes: [ { id: 'north', name: 'TURBINE HALL', entry: point(75, 25) },
           { id: 'west',  name: 'WEST LOADING', entry: point(25, 61) },
           { id: 'east',  name: 'EAST COOLING', entry: point(102, 39) } ],
  stages: [
    { id: 'gate', name: 'NORTH GATE', kind: 'hold', lane: 'north',
      objective: { id: 'coolant-pump', name: 'COOLANT PUMP', model: 'pump', ...point(64, 41), half: [1.2, 1.5, 1.2], hp: 800 },
      spawns: [point(60, 7), point(64, 7), point(68, 7)],
      defenders: [point(58, 47), point(70, 47), point(62, 49), point(66, 49)],
      supply: point(64, 47),
      buildZone: { minX: 54, maxX: 74, minZ: 32, maxZ: 45 },
      vehicleRoute: [point(76, 8), point(76, 26), point(72, 33), point(66, 38)],
      waves: ['probe', 'push'] },
    { id: 'core', name: 'REACTOR CORE', kind: 'hold', lane: 'west',
      objective: { id: 'core', name: 'REACTOR CORE', model: 'core', ...point(64, 54), half: [1.4, 1.8, 1.4], hp: 1000 },
      spawns: [point(7, 43), point(7, 47), point(7, 51)],
      defenders: [point(60, 61), point(68, 61), point(66, 50), point(71, 56)],
      supply: point(64, 64),
      buildZone: { minX: 40, maxX: 60, minZ: 46, maxZ: 64 },
      vehicleRoute: [point(8, 62), point(26, 62), point(34, 59), point(44, 59), point(50, 55), point(54, 54)],
      waves: ['assault', 'siege', 'armor'] },
    { id: 'extract', name: 'SERVICE BAY', kind: 'extract', lane: 'east', holdMs: 150000, extractRadius: 8,
      objective: { id: 'beacon', name: 'EXTRACTION BEACON', model: 'beacon', ...point(64, 78), half: [0.8, 1.6, 0.8], hp: 600 },
      spawns: [point(120, 43), point(120, 47), point(120, 51)],
      defenders: [point(60, 74), point(68, 74), point(58, 80), point(70, 80)],
      supply: point(64, 83),
      buildZone: { minX: 56, maxX: 84, minZ: 62, maxZ: 75 },
      vehicleRoute: [point(119, 33), point(101, 33), point(92, 48), point(82, 60), point(74, 70)],
      waves: ['onslaught', 'breakthrough'], loop: 'lastStand' },
  ],
};
layout.defenders = layout.stages[0].defenders;   // metadata alias (spawn anchors)
export const REACTOR_LAYOUT = deepFreeze(layout);

