// Bot drivers and the forward service depots (docs/conquest.md "Forward
// service depots"; the depot itself is server/modes/conquest/map-events/depot.js).
//
//  - Return to base: an overwatch hull (tank, AT jeep, mobile AA) below
//    `rtbHp` of its HP whose own team holds a standing depot within
//    `rtbRoadM` metres of road route drives to its pump, brakes on the
//    forecourt and waits there until it is back to `rtbFullHp`, it is shot at
//    after it arrived, the depot falls or changes hands, or the trip runs out
//    (`rtbDriveMs` to get there, `rtbMaxMs` on the forecourt); then the crew
//    goes back to its overwatch spot. A trip that ended early waits
//    `rtbCooldownMs` before the next. Without a depot in reach the old reverse
//    out of the fight stays (server/bot-vehicle-driving.js, 40 %).
//  - Forecourt guard: a crewed mobile AA guards its own team's depot (parks
//    on the forecourt, where it is serviced too) while a crewed enemy hull or
//    aircraft is within `guardM` of the pump and the AA is within
//    `guardReachM` of it.
// Demolition of the enemy's depot is a map event task (the controller's
// botTasks: only on evidence of the enemy using it).
import { vehicleMaxHp } from '../shared/vehicles.js';

/** Route search cadence per hull, the extra trip timers and the guard's reach (ms, m). */
export const DEPOT_BOT = Object.freeze({ scanMs: 2000, rtbDriveMs: 60000, rtbCooldownMs: 20000, arrive: 6, guardReachM: 400 });

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** The standing depots of the match: [{id, controller, site, owner}] (owner: the side it serves now, null when neutral). */
export function depotsOf(game) {
  const instances = game?.mode?.policy?.mapEvents?.instances ?? [];
  const out = [];
  for (const instance of instances) {
    const c = instance.controller;
    if (typeof c?.needsService !== 'function' || !c.site || instance.phase !== 'idle') continue;
    out.push({ id: instance.id, controller: c, site: c.site, owner: c.owner() });
  }
  return out;
}

/** Metres along a road route (the points vehicleRoute returns, from the hull). */
export function routeLength(from, points) {
  let m = 0, at = from;
  for (const p of points ?? []) { m += flat(at, p); at = p; }
  return m;
}

/**
 * The trip of an overwatch hull to its team's depot: drives it there and
 * holds it on the forecourt. Returns true while the trip has the controls.
 * `driving` is the ConquestVehicleDriving instance (route, follow, hold).
 */
export function depotTrip(driving, br, p, v, now, inp, route) {
  const game = driving.game;
  const team = game.mode.teamFor?.(p) ?? p.team;
  const depots = depotsOf(game);
  let trip = br.depotTrip ?? null;
  if (trip && trip.vehicleId !== v.id) trip = br.depotTrip = null;
  if (!depots.length) { br.depotTrip = null; return false; }
  const T = depots[0].controller.T.bots;
  const hp = v.hp / Math.max(1, vehicleMaxHp(v));
  if (trip) {
    const depot = depots.find(d => d.id === trip.depotId);
    const shot = trip.arrivedAt > 0 && (v.lastDamagedAt ?? -Infinity) > trip.arrivedAt;
    const late = trip.arrivedAt > 0 ? now - trip.arrivedAt > T.rtbMaxMs : now - trip.startedAt > DEPOT_BOT.rtbDriveMs;
    const done = hp >= T.rtbFullHp && !depot?.controller.needsService(v, now);
    if (!depot || depot.owner !== team || done || shot || late) {
      br.depotTrip = null;
      if (!done) br.depotCoolUntil = now + DEPOT_BOT.rtbCooldownMs;
      return false;
    }
  } else {
    if (hp >= T.rtbHp || now < (br.depotCoolUntil ?? 0) || now < (br.depotScanAt ?? 0)) return false;
    br.depotScanAt = now + DEPOT_BOT.scanMs;
    let best = null;
    for (const d of depots) {
      if (d.owner !== team) continue;
      const m = routeLength(v, route(game, v, d.site.pump));
      if (m <= T.rtbRoadM && (!best || m < best.m)) best = { d, m };
    }
    if (!best) return false;
    trip = br.depotTrip = { vehicleId: v.id, depotId: best.d.id, point: { ...best.d.site.pump }, roadM: Math.round(best.m), startedAt: now, arrivedAt: 0 };
  }
  const state = driving.driverState(br, v, trip.point, now);
  const remaining = driving.follow(br, v, state, now, inp, { arrive: DEPOT_BOT.arrive - 1, cruise: flat(v, trip.point) > 40 ? null : 6 });
  if (remaining < DEPOT_BOT.arrive) {
    trip.arrivedAt ||= now;
    driving.hold(br, v, now, inp);
  }
  return true;
}

/**
 * The forecourt a crewed mobile AA should guard now: its team's standing
 * depot with a crewed enemy hull or aircraft within `guardM` of the pump, nearest
 * the AA within `guardReachM`; else null. Returns {point, threat}.
 */
export function depotGuard(game, v, team) {
  let best = null;
  for (const d of depotsOf(game)) {
    if (d.owner !== team || flat(v, d.site.pump) > DEPOT_BOT.guardReachM) continue;
    const R = d.controller.T.bots.guardM;
    let threat = null;
    for (const h of game.vehicles?.vehicles?.values?.() ?? []) {
      if (!(h.hp > 0) || h.padInactive || !h.team || h.team === team || !game.vehicles.crew?.(h)?.length) continue;
      const m = flat(h, d.site.pump);
      if (m <= R && (!threat || m < threat.m)) threat = { hull: h, m };
    }
    if (threat && (!best || flat(v, d.site.pump) < flat(v, best.point))) best = { point: { ...d.site.pump }, threat: threat.hull, depotId: d.id };
  }
  return best;
}
