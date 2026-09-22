import { GROUND } from './blocks.js';

const point = (x, z) => Object.freeze({ x, y: GROUND + 1.02, z });
const box = (minX, maxX, minZ, maxZ) => Object.freeze({ minX, maxX, minZ, maxZ });
const stage = (s) => Object.freeze({ ...s, objective: Object.freeze(s.objective), spawns: Object.freeze(s.spawns),
  defenders: Object.freeze(s.defenders), vehicleRoute: Object.freeze(s.vehicleRoute), waves: Object.freeze(s.waves) });

// Causeway: a 192 x 144 concrete dam crossing between two rock masses. The
// enemy pushes west from the East Gate to the Extraction Pad; every hold
// stage breaches from an alternating side chamber and drives its vehicles
// down the passage onto the road.
const layout = {
  id: 'causeway',
  bounds: box(8, 183, 44, 99),
  spawnBounds: Object.freeze({ minX: 8, maxX: 165, minZ: 44, maxZ: 99, minY: GROUND + 1, maxY: GROUND + 1.1 }),
  ingress: Object.freeze([ box(166, 188, 44, 100), box(128, 148, 4, 44), box(96, 116, 100, 140),
    box(56, 76, 4, 44), box(24, 44, 100, 140) ]),
  solids: Object.freeze([]),
  lanes: Object.freeze([
    Object.freeze({ id: 'east', name: 'EAST GATE', entry: point(165, 60) }),
    Object.freeze({ id: 'north-a', name: 'NORTH BREACH', entry: point(138, 42) }),
    Object.freeze({ id: 'south-a', name: 'SOUTH BREACH', entry: point(106, 101) }),
    Object.freeze({ id: 'north-b', name: 'NORTH BREACH B', entry: point(66, 42) }),
    Object.freeze({ id: 'south-b', name: 'SOUTH BREACH B', entry: point(34, 101) }),
  ]),
  stages: Object.freeze([
    stage({ id: 'gate', name: 'EAST GATE', kind: 'hold', lane: 'east',
      objective: { id: 'gate-generator', name: 'GATE GENERATOR', model: 'generator', ...point(146, 72), half: [1.2, 1.5, 1.2], hp: 800 },
      spawns: [point(179, 58), point(179, 72), point(179, 86)],
      defenders: [point(138, 66), point(138, 78), point(142, 60), point(142, 84)], supply: point(134, 72),
      buildZone: box(149, 163, 44, 99),
      vehicleRoute: [point(178, 60), point(170, 60), point(162, 60), point(154, 68)], waves: ['probe', 'push'] }),
    stage({ id: 'pump', name: 'PUMP HOUSE', kind: 'hold', lane: 'north-a',
      objective: { id: 'main-pump', name: 'MAIN PUMP', model: 'pump', ...point(112, 72), half: [1.6, 1.4, 1.6], hp: 900 },
      spawns: [point(130, 25), point(138, 25), point(145, 25)],
      defenders: [point(100, 66), point(100, 78), point(104, 60), point(104, 84)], supply: point(98, 72),
      buildZone: box(115, 133, 44, 99),
      vehicleRoute: [point(138, 31), point(138, 44), point(126, 58), point(122, 68)], waves: ['assault', 'siege'] }),
    stage({ id: 'sluice', name: 'SLUICE YARD', kind: 'hold', lane: 'south-a',
      objective: { id: 'sluice-control', name: 'SLUICE CONTROL', model: 'core', ...point(76, 72), half: [1.4, 1.8, 1.4], hp: 1000 },
      spawns: [point(98, 118), point(106, 118), point(113, 118)],
      defenders: [point(66, 60), point(66, 84), point(62, 66), point(62, 78)], supply: point(62, 72),
      buildZone: box(80, 101, 44, 99),
      vehicleRoute: [point(106, 112), point(106, 98), point(94, 82), point(86, 74)], waves: ['armor', 'onslaught'] }),
    stage({ id: 'tower', name: 'CONTROL TOWER', kind: 'hold', lane: 'north-b',
      objective: { id: 'uplink-tower', name: 'UPLINK TOWER', model: 'tower', ...point(42, 72), half: [1.2, 3.0, 1.2], hp: 1000 },
      spawns: [point(58, 25), point(66, 25), point(73, 25)],
      defenders: [point(34, 66), point(34, 78), point(38, 60), point(38, 84)], supply: point(30, 72),
      buildZone: box(46, 63, 44, 99),
      vehicleRoute: [point(66, 31), point(66, 44), point(56, 58), point(52, 68)], waves: ['breakthrough'] }),
    stage({ id: 'extract', name: 'EXTRACTION PAD', kind: 'extract', lane: 'south-b', holdMs: 150000, extractRadius: 8,
      objective: { id: 'beacon', name: 'EXTRACTION BEACON', model: 'beacon', ...point(16, 72), half: [0.8, 1.6, 0.8], hp: 600 },
      spawns: [point(26, 118), point(34, 118), point(41, 118)],
      defenders: [point(12, 66), point(12, 78), point(20, 62), point(20, 82)], supply: point(14, 60),
      buildZone: box(22, 37, 44, 99),
      vehicleRoute: [point(34, 112), point(34, 98), point(28, 86), point(26, 78)], waves: ['lastStand'], loop: 'lastStand' }),
  ]),
};
// Metadata alias: the free-for-all spawn anchors are the first stage's defender points.
layout.defenders = layout.stages[0].defenders;

export const CAUSEWAY_LAYOUT = Object.freeze(layout);
