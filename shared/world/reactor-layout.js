import { GROUND } from './blocks.js';

export const REACTOR_FLOOR = GROUND;
const point = (x, z, floor = GROUND) => Object.freeze({ x, y: floor + 1.02, z });

// Dedicated PvE layout: northern turbine hall and two dog-leg loading tunnels.
export const REACTOR_LAYOUT = Object.freeze({
  core: Object.freeze({ ...point(64, 54), half: [1.4, 1.8, 1.4] }),
  supply: point(64, 78),
  defenders: Object.freeze([point(60, 61), point(68, 61), point(57, 54), point(71, 54)]),
  bounds: Object.freeze({ minX: 5, maxX: 122, minZ: 5, maxZ: 90 }),
  lanes: Object.freeze([
    Object.freeze({ id: 'north', name: 'TURBINE HALL',
      spawns: [point(60, 7), point(64, 7), point(68, 7)],
      entry: point(75, 25), route: [point(76, 8), point(76, 26), point(65, 34), point(64, 47)],
      breach: point(64, 35) }),
    Object.freeze({ id: 'west', name: 'WEST LOADING',
      spawns: [point(7, 43), point(7, 47), point(7, 51)],
      entry: point(25, 61), route: [point(8, 62), point(26, 62), point(37, 54), point(57, 54)],
      breach: point(39, 54) }),
    Object.freeze({ id: 'east', name: 'EAST COOLING',
      spawns: [point(120, 43), point(120, 47), point(120, 51)],
      entry: point(102, 39), route: [point(119, 33), point(101, 33), point(92, 48), point(71, 54)],
      breach: point(88, 49) }),
  ]),
});

// Defender-only containment volumes. NPCs emerge through visible energy gates.
export const REACTOR_INGRESS = Object.freeze([
  Object.freeze({minX:55,maxX:82,minZ:4,maxZ:21}),
  Object.freeze({minX:4,maxX:21,minZ:38,maxZ:69}),
  Object.freeze({minX:110,maxX:124,minZ:28,maxZ:59}),
]);
export function reactorDefenderSolid(x,y,z) {
  if(y <= GROUND) return false;
  if(REACTOR_INGRESS.some(b=>x>=b.minX&&x<b.maxX&&z>=b.minZ&&z<b.maxZ)) return true;
  return y<GROUND+5&&x>=63&&x<65&&z>=53&&z<55;
}
