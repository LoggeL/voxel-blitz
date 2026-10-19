// Conquest bots and the mobile AA (docs/conquest.md "Mobile AA").
//
// The commander books an AA crew only while the enemy flies: a crewed enemy
// aircraft makes the AA driver a high-priority slot (right after the attack
// helicopter pilot), a second one or an already bot-manned AA keeps it there;
// with no enemy aircraft crewed the AA stays parked for the humans. The crew
// holds an overwatch spot on the AA's cover flag: the team's own flag nearest
// the enemy aircraft (the sky it must deny), else the commander's focus flag.
// Its gunners search the sky to radar range in every direction and treat
// infantry as a poor target for the flak.

import { isAircraftType } from '../shared/vehicle-defs.js';
import { AA_RADAR } from '../shared/vehicle-handling/aa.js';
import { vehicleSeats, vehicleSeatOccupantId } from '../shared/vehicle-seats.js';

export const AA_BOT = Object.freeze({
  /** planCrews priorities: driver with an air threat, the commander's .50. */
  driverPrio: 1.5, gunnerPrio: 5,
  /** Gunners see airborne aircraft to radar range, all round. */
  airSightRange: AA_RADAR.range, airOmniRange: AA_RADAR.range,
  /** Flak against soft targets: worth a burst, never the first choice. */
  infantryEffect: 0.3,
});

/** True for a hull type whose seat weapons carry the flak fuse. */
export const isAaType = type => type === 'aa';

/** Live enemy aircraft with anyone aboard (parked or flying): the AA's reason to crew. */
export function enemyAirThreats(vehicles, team) {
  const out = [];
  for (const v of vehicles?.values?.() ?? []) {
    if (!(v.hp > 0) || v.team == null || v.team === team || !isAircraftType(v.type)) continue;
    if (!vehicleSeats(v).some(seat => vehicleSeatOccupantId(v, seat.id) != null)) continue;
    out.push(v);
  }
  return out;
}

/**
 * Cover flag for an AA crew: the own flag nearest the enemy aircraft (their
 * centroid), else `fallback` (the commander's focus flag).
 */
export function aaCoverFlag(flags, team, threats, fallback = null) {
  const own = (flags ?? []).filter(f => f.owner === team);
  if (!own.length || !threats.length) return fallback;
  const cx = threats.reduce((s, v) => s + v.x, 0) / threats.length, cz = threats.reduce((s, v) => s + v.z, 0) / threats.length;
  return own.reduce((best, f) => (Math.hypot(f.x - cx, f.z - cz) < Math.hypot(best.x - cx, best.z - cz) ? f : best));
}
