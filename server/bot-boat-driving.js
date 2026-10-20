// River patrol boats for Conquest bots (docs/conquest.md, Patrol boat).
//
// The commander books one boat per team as a river patrol (driver and bow
// gunner, ranked after the attack helicopter and before the jet) when both
// seats fit under the ceil(bots / 3) crew cap, once the team fields
// BOAT_PATROL.minTeamBots bots (riverPatrolSlots and BotCommander.planCrews). The driver steers along the map's boat lane
// (mapMeta.conquest.waterways) to a station beside the river crossing
// nearest the team's focus flag, holds there bow toward the
// crossing so the gunner's .50 covers it, and moves to the station on the
// other side of the crossing every 8-14 s. Below 35 % hull it runs back to its
// mooring for an engineer. VehicleSystem stays authoritative: the bot sends
// the same throttle, steer and brake a human does.
import { vehicleSeatOccupantId } from '../shared/vehicle-seats.js';
import { vehicleMaxHp } from '../shared/vehicles.js';
import { BOAT_RULES } from '../shared/vehicle-handling/boat.js';
import { MC_WATER, isSolidBlock } from '../shared/world/blocks.js';

/**
 * True while a ford crossing has less water than BOAT_RULES.shallowDepth over
 * its bed (the hull scrapes), read from the voxels at the crossing, so a
 * flooded ford reads deep and a drained one shallow again.
 */
export function fordShallow(world, crossing, depth = BOAT_RULES.shallowDepth) {
  if (!world?.getBlock) return true;
  const x = Math.floor(crossing.x), z = Math.floor(crossing.z), top = world.dimensions?.sy ?? 80;
  let surface = null;
  for (let y = top - 1; y > 0; y--) {
    const b = world.getBlock(x, y, z);
    if (b === MC_WATER) { surface ??= y + 1; continue; }
    if (surface != null && isSolidBlock(b)) return surface - (y + 1) < depth;
  }
  return true;
}

/** Data, not code: tuning of the bot river patrol. */
export const BOAT_PATROL = Object.freeze({
  /** A team with fewer bots keeps every bot on land. */
  minTeamBots: 6,
  /**
   * A recalled boat this close to its mooring is home: the crew gets out (m).
   * Just past the `arrive` radius the helmsman brakes in, so the crew steps
   * out at the pad (a short jump from the bank), not 10 m out in the river.
   */
  moorRadius: 7,
  /** A living bot farther than this from the boat does not walk (or swim) to it. */
  walkMax: 30,
  /** Commander priorities of the boat seats: after the attack helicopter, before the jet. */
  driverPrio: 1.5, gunnerPrio: 1.6,
  /**
   * Stations sit this far along the lane either side of the crossing: clear
   * of a bridge and outside a flag zone on the crossing (Iron Bridge, 24 m),
   * so the boat supports the fight for the flag instead of sitting on it.
   */
  stationOffset: 32,
  /** Relocation between the two stations, ms. */
  moveMs: Object.freeze([8000, 14000]),
  /** Arrival radius of a station, m, and how long the boat pivots its bow onto the crossing there. */
  arrive: 6, faceMs: 3500,
  /**
   * Cruise on the open lane, through a narrows (the arches of a bridge within
   * 20 m), over a ford within `fordReach` m (one voxel of water: the hull
   * scrapes across at BOAT_RULES.shallowSpeed) and close to the station, m/s.
   */
  cruise: 15, narrows: 6, ford: 5, fordReach: 20, approach: 8,
  /**
   * In the narrows (a bridge within 20 m) a helmsman whose waypoint lies more
   * than `pivotError` rad off the bow stops and pivots instead of turning under
   * way, or backs onto it when it lies astern closer than `narrowsReverse` m
   * (under the arch there is no room to pivot either).
   */
  pivotError: 1.2, narrowsReverse: 16,
  /** Hull share that sends the boat home to its mooring, and the share that sends it back out. */
  retreatHp: 0.35, returnHp: 0.6,
  /**
   * Sortie duty cycle, ms: a crew patrols for `sortieMs` from its booking,
   * then the boat rests `restMs` (the crew is recalled to the mooring and goes
   * back to the flags on foot), so the river patrol is a recurring sortie
   * rather than two bots out of the infantry fight for the whole match.
   */
  sortieMs: 70000, restMs: 50000,
  /**
   * The patrol sails only for a focus flag within this many metres of the boat
   * lane (on Frontier the Iron Bridge, C; B and D lie 107 m off, A and E 145 m),
   * where the bow gun reaches the fight; otherwise the crew stays on foot.
   */
  focusReach: 80,
});

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const bearing = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z));

const LANES = new WeakMap();
/** The boat lane of a map as {points:[{x,y,z,s}], length} (s = arc length), or null. */
export function boatLane(game) {
  const meta = game.mapMeta;
  if (!meta) return null;
  if (LANES.has(meta)) return LANES.get(meta);
  const raw = meta.conquest?.waterways?.find(w => w.kind === 'boat-lane')?.points ?? [];
  let lane = null;
  if (raw.length >= 2) {
    const points = [];
    let s = 0;
    for (const [x, y, z] of raw) {
      if (points.length) s += flat(points.at(-1), { x, z });
      points.push({ x, y, z, s });
    }
    lane = { points, length: s };
  }
  LANES.set(meta, lane);
  return lane;
}

/** Arc length of the lane point nearest (x, z) (projected onto the nearest segment). */
export function laneProgress(lane, p) {
  let best = Infinity, at = 0;
  for (let i = 1; i < lane.points.length; i++) {
    const a = lane.points[i - 1], b = lane.points[i], dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
    const d = Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
    if (d < best) { best = d; at = a.s + (b.s - a.s) * t; }
  }
  return at;
}

/** The lane point at arc length s (clamped to the lane). */
export function lanePoint(lane, s) {
  s = Math.max(0, Math.min(lane.length, s));
  for (let i = 1; i < lane.points.length; i++) {
    const a = lane.points[i - 1], b = lane.points[i];
    if (s <= b.s || i === lane.points.length - 1) {
      const t = b.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y, z: a.z + (b.z - a.z) * t, s };
    }
  }
  return { ...lane.points.at(-1) };
}

/** The lane between two arc lengths as waypoints (lane vertices in between, then the end). */
export function laneRoute(lane, from, to) {
  const points = [];
  if (to >= from) { for (const p of lane.points) if (p.s > from + 1 && p.s < to - 1) points.push(p); }
  else for (let i = lane.points.length - 1; i >= 0; i--) { const p = lane.points[i]; if (p.s < from - 1 && p.s > to + 1) points.push(p); }
  points.push(lanePoint(lane, to));
  return points.map(p => ({ x: p.x, y: p.y, z: p.z }));
}

/**
 * Patrol stations for a focus flag: the river crossing nearest the flag, and
 * the two lane points `stationOffset` m up and down the lane from it, each
 * with the yaw that points the bow at the crossing.
 */
export function patrolStations(game, lane, flag) {
  const crossings = game.mapMeta?.conquest?.crossings ?? [];
  const crossing = crossings.length && flag ? crossings.reduce((a, b) => (flat(b, flag) < flat(a, flag) ? b : a)) : flag;
  if (!crossing) return [];
  const at = laneProgress(lane, crossing);
  return [-1, 1].map(side => {
    const point = lanePoint(lane, at + side * BOAT_PATROL.stationOffset);
    return { ...point, crossing: crossing.id ?? null, face: bearing(point, crossing) };
  });
}

/** Distance from (x, z) to the lane. */
export function laneDistance(lane, p) {
  return flat(lanePoint(lane, laneProgress(lane, p)), p);
}

/**
 * Commander slots of the river patrol: { slots, recall }. `slots` is the
 * team's live boat already manned by a bot, else the one moored nearest the
 * focus flag: its driver, then its bow gunner, at priorities after the attack
 * helicopter and before the jet, while the focus flag lies within
 * BOAT_PATROL.focusReach of the lane. The commander books both seats or
 * neither, only while they fit under the ceil(teamBots / 3) cap: on Frontier
 * (at most eight bots a side: budget 2, cap 3) the boat sails while the tank
 * or the helicopter is down, and then takes the budget slot the jet would get.
 * `recall` is a bot-crewed boat out on the river, for when the patrol is not
 * booked: its crew sails home and gets out at the mooring, never mid-river
 * (the recall may run past the cap while it lasts).
 */
export function riverPatrolSlots(game, hulls, teamBots, focus, hullSeatIds, isBot) {
  const none = { slots: [], recall: [] };
  if (!boatLane(game)) return none;
  const boats = hulls.filter(v => v.type === 'boat');
  if (!boats.length) return none;
  const botDriven = v => { const id = vehicleSeatOccupantId(v, hullSeatIds(v).driver); return id != null && isBot(id); };
  const humanDriven = v => { const id = vehicleSeatOccupantId(v, hullSeatIds(v).driver); return id != null && !isBot(id); };
  const crew = (v, recall) => {
    const seats = hullSeatIds(v);
    return [{ v, seat: seats.driver, prio: BOAT_PATROL.driverPrio, patrol: true, recall },
      ...(seats.gunner ? [{ v, seat: seats.gunner, prio: BOAT_PATROL.gunnerPrio, patrol: true, recall }] : [])];
  };
  const out = boats.find(v => botDriven(v) && v.spawn && flat(v, v.spawn) > BOAT_PATROL.moorRadius);
  const recall = out ? crew(out, true) : [];
  if (teamBots < BOAT_PATROL.minTeamBots || !focus || laneDistance(boatLane(game), focus) > BOAT_PATROL.focusReach) return { slots: [], recall };
  const pick = boats.filter(v => !humanDriven(v))
    .sort((a, b) => (botDriven(b) - botDriven(a)) || flat(a, focus) - flat(b, focus))[0];
  return { slots: pick ? crew(pick, false) : [], recall };
}

/**
 * Lane route state of a boat driver (reused while the target is unchanged).
 * Like a ground hull's route, each leg starts with no stuck recoveries: the
 * watchdog's MAX_RECOVERIES bail-out (abandon the hull, crew out) is for a
 * hull boxed in on one leg, not the sum of every scrape over a long patrol,
 * which would strand the boat mid-river and swim its crew ashore.
 */
function routeState(driving, br, v, lane, target, now) {
  const key = `boat:${Math.round(target.x)},${Math.round(target.z)}`;
  let state = driving.drivers.get(br.id);
  if (!state || state.vehicle !== v || state.key !== key) {
    const keep = state?.vehicle === v ? state : null;
    state = { vehicle: v, key, destination: target, points: laneRoute(lane, laneProgress(lane, v), laneProgress(lane, target)).concat([{ ...target }]),
      index: 0, watchAt: now, watchX: v.x, watchZ: v.z, watchYaw: v.yaw, recoveries: 0, reverseUntil: 0,
      probeAt: 0, detour: null, patrol: keep?.patrol ?? null };
    driving.drivers.set(br.id, state);
  }
  return state;
}

/** The river patrol driver (ConquestVehicleDriving.think dispatches every boat driver here). */
export function boatPatrol(driving, br, p, v, assignment, now, inp) {
  inp.vehicleThrottle = 0; inp.vehicleSteer = 0; inp.vehicleBrake = 1;
  const lane = boatLane(driving.game), flag = assignment?.flag;
  if (!lane) return;
  const hp = v.hp / (vehicleMaxHp(v) || 360);
  let state = driving.drivers.get(br.id);
  let patrol = state?.vehicle === v ? state.patrol : null;
  if (!patrol) patrol = { flagId: null, station: 0, settleAt: 0, moveAt: 0, retreat: false };
  if (hp < BOAT_PATROL.retreatHp || assignment?.recall) patrol.retreat = true;
  else if (hp >= BOAT_PATROL.returnHp) patrol.retreat = false;
  let target, face;
  if (patrol.retreat) {
    // Home to the mooring, bow out, and wait for an engineer on the bank.
    target = { x: v.spawn?.x ?? v.x, y: v.spawn?.y ?? v.y, z: v.spawn?.z ?? v.z };
    face = Number.isFinite(v.spawn?.yaw) ? v.spawn.yaw : v.yaw;
  } else {
    const stations = patrolStations(driving.game, lane, flag);
    if (!stations.length) return;
    if (patrol.flagId !== (flag?.id ?? null)) {
      // New focus: the nearer station first.
      patrol.flagId = flag?.id ?? null;
      patrol.station = flat(stations[0], v) <= flat(stations[1], v) ? 0 : 1;
      patrol.settleAt = 0; patrol.moveAt = 0;
    } else if (patrol.settleAt && now >= patrol.moveAt) {
      patrol.station = 1 - patrol.station;
      patrol.settleAt = 0; patrol.moveAt = 0;
    }
    ({ face } = stations[patrol.station]);
    target = stations[patrol.station];
  }
  state = routeState(driving, br, v, lane, target, now);
  state.patrol = patrol;
  const toGo = flat(v, target);
  // Slow through the narrows (the arches of a bridge within 20 m), over a ford and on the approach.
  const crossings = driving.game.mapMeta?.conquest?.crossings ?? [];
  const narrows = crossings.some(c => c.kind === 'bridge' && flat(c, v) < 20);
  // A flooded ford (the Frontier sluice weir) is deep water: no scrape, no slowdown.
  const ford = crossings.some(c => c.kind === 'ford' && flat(c, v) < BOAT_PATROL.fordReach && fordShallow(driving.game.world, c));
  const cruise = narrows ? BOAT_PATROL.narrows : ford ? BOAT_PATROL.ford : toGo < 30 ? BOAT_PATROL.approach : BOAT_PATROL.cruise;
  const remaining = driving.follow(br, v, state, now, inp, { arrive: BOAT_PATROL.arrive, cruise, narrows });
  if (remaining < BOAT_PATROL.arrive) {
    if (!patrol.retreat && !patrol.settleAt) {
      patrol.settleAt = now;
      patrol.moveAt = now + BOAT_PATROL.moveMs[0] + br.rng() * (BOAT_PATROL.moveMs[1] - BOAT_PATROL.moveMs[0]);
    }
    // Bow on the crossing (the gun covers it and both banks) for faceMs; a
    // pivot the banks block simply holds: the bow gun still traverses 135 degrees.
    if (Math.abs(v.speed) > 1 || (patrol.settleAt && now - patrol.settleAt > BOAT_PATROL.faceMs)) { inp.vehicleThrottle = 0; inp.vehicleBrake = 1; inp.vehicleSteer = 0; }
    else driving.faceThreat(v, face, inp);
    state.watchAt = now; state.watchX = v.x; state.watchZ = v.z; state.watchYaw = v.yaw;
  }
}
