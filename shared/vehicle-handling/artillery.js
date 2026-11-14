/**
 * Rocket artillery truck: a 14 t 6x6 on the jeep's drive stepper
 * (stepJeepDrive with these rules). Quick for its size on a road, slow to
 * build speed and wide in the turn. Distances are metres, time seconds.
 */
import { JEEP_RULES } from './jeep.js';

export const ARTILLERY_TRUCK_RULES = Object.freeze({
  ...JEEP_RULES,
  // `height` is the cab roof (the hull's hit box): the hatch gunner's body rises above it, like the tank commander's.
  radius: 3.4, height: 2.85, seatHeight: 1.9,
  speed: 19, reverse: 6, acceleration: 6, brake: 16, drag: 2.6,
  turn: 0.9, wheelbase: 4.6, maxStep: 1, maxSlope: 0.95,
});
