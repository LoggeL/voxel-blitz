/**
 * Mobile AA (the `aa` hull, docs/conquest.md "Mobile AA"): the tank's running
 * gear on a lighter hull. It drives through stepTankDrive with these rules, a
 * little quicker than the tank and quicker to turn, and its twin 35 mm turret
 * slews and elevates far faster (to 77 degrees) so it can follow a helicopter.
 * The turret ring sits where the tank's does (turretForward), so the shared
 * turret-frame helpers (turretLocal, the commander's ring seat) hold.
 */
import { TANK_RULES } from './tank.js';

export const AA_RULES = Object.freeze({
  ...TANK_RULES,
  speed: 15, reverse: 6, acceleration: 4.4, brake: 8.5,
  turn: 0.95, turnAcceleration: 1.9, pivotTurn: 0.8,
  radius: 2.6, height: 2.7, length: 5.4, width: 3.4,
  turretRate: 1.6, turretPitchRate: 1.15,
  turretMinPitch: -0.12, turretMaxPitch: 1.35,
  // The guns' trunnion: on the turret's flanks, ahead of the ring centre.
  gunPivotHeight: 2.3, gunPivotForward: 0.35, gunSide: 1.2, barrelLength: 2.6,
});

/**
 * Search radar: what the AA crew's scope shows. Airborne aircraft (rotor and
 * fixed wing, grounded:false) within `range` m of the hull, both teams; ground
 * hulls and landed aircraft never show. `trackCone` (rad) is the half-angle
 * around the gun line inside which the nearest enemy contact becomes the
 * tracked target (TRK box and lead pipper); `sweepSeconds` is one turn of the
 * scope's sweep line (presentation only). Every number the scope draws comes
 * from snapshot rows, which reach every client.
 */
export const AA_RADAR = Object.freeze({ range: 400, trackCone: 0.35, sweepSeconds: 2.4, maxContacts: 8 });
