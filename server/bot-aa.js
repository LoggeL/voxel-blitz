// Conquest bots and the mobile AA (docs/conquest.md "Mobile AA").
//
// The commander books an AA crew only while the enemy flies: a crewed enemy
// aircraft makes the AA driver a high-priority slot (right after the attack
// helicopter pilot). An AA a bot sits at the wheel of keeps its crew for `holdMs`
// after the last enemy aircraft went (shot down, landed, its pilot out), so a
// kill does not strand the hull wherever it stood; with no enemy aircraft
// crewed the AA stays parked for the humans. The crew holds an overwatch spot
// on the AA's cover flag: the team's own flag nearest the enemy aircraft (the
// sky it must deny), held for `coverHoldMs` so a jet crossing the map does not
// send the hull from flag to flag; else the commander's focus flag.
// Its gunners search the sky to radar range in every direction and treat
// infantry as a poor target for the flak.

import { isAircraftType } from '../shared/vehicle-defs.js';
import { AA_RADAR } from '../shared/vehicle-handling/aa.js';
import { vehicleSeats, vehicleSeatOccupantId } from '../shared/vehicle-seats.js';

export const AA_BOT = Object.freeze({
  /** planCrews priorities: driver with an air threat, the commander's .50. */
  driverPrio: 1.5, gunnerPrio: 5,
  /** An AA with a bot in the driver seat stays crewed this long (ms) after the last crewed enemy aircraft. */
  holdMs: 30000,
  /** A chosen cover flag is kept this long (ms) while the team still owns it. */
  coverHoldMs: 30000,
  /** Gunners see airborne aircraft to radar range, all round. */
  airSightRange: AA_RADAR.range, airOmniRange: AA_RADAR.range,
  /** Flak against soft targets: worth a burst, never the first choice. */
  infantryEffect: 0.3,
  /**
   * The driver's slot past the crew budget (planCrews headroom) opens only while
   * an enemy aircraft flies within this range (m) of the hull, well inside the
   * flak's reach, and a bot already at the wheel keeps it `headroomHoldMs` after
   * the last one: a crewed enemy aircraft anywhere on the map would keep that
   * extra bot off the flags all match (flag transitions in the action gate,
   * seeds 1-16: 5.4 before the headroom, 3.6 with it, 6.0 with this range).
   */
  headroomRange: 300, headroomHoldMs: 30000,
});

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

/** Whether one of `threats` (enemyAirThreats) is airborne within `range` m of the hull `aa`. */
export function airThreatNear(aa, threats, range = AA_BOT.headroomRange) {
  return threats.some(v => v.grounded === false && Math.hypot(v.x - aa.x, v.z - aa.z) <= range);
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

/**
 * Sticky cover flag for one AA hull. `held` is the previous choice
 * ({ flagId, until } or null); returns { flag, held } with the hold to store.
 * A held flag the team still owns is kept until `until`; otherwise the own
 * flag nearest the threats is chosen and held for AA_BOT.coverHoldMs. With
 * no threat and no live hold the result is `fallback` (the focus flag), unheld.
 */
export function stickyAaCover(held, flags, team, threats, now, fallback = null) {
  const kept = held && now < held.until ? (flags ?? []).find(f => f.id === held.flagId && f.owner === team) : null;
  if (kept) return { flag: kept, held };
  const flag = threats.length ? aaCoverFlag(flags, team, threats, null) : null;
  if (!flag) return { flag: fallback, held: null };
  return { flag, held: { flagId: flag.id, until: now + AA_BOT.coverHoldMs } };
}
