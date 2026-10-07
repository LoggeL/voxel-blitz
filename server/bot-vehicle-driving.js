// Ground vehicle crews for Conquest bots (jeep and tank).
//
// The commander (bot-commander.js) decides who crews what: persistent crews
// within the team budget (tank driver and commander) and squad rides (jeep
// driver, gunner and passengers to the squad's staging point). This module
// executes those assignments with the same inputs and seat actions humans
// send; VehicleSystem stays authoritative for every seat change and motion.
//
//  - Boarding: walk the hull's authored pickup route, enter the assigned seat.
//  - Tanks overwatch 40-80 m from the focus flag with line of sight, keep the
//    front armour toward the threat, move every 6-10 s, and reverse out
//    below 40 % HP to wait for an engineer.
//  - Jeeps carry the squad to the staging point and everybody gets out there.
//  - Routes follow mapMeta.conquest.roads joined at junctions and crossings;
//    the last leg runs cross-country with a placement-checked detour probe
//    at 4 Hz (or after the stuck watchdog).
//  - Reflexes: a lock warning (lk >= 2) pops smoke after the difficulty's
//    reaction time; a disabled hull with no engineer within 20 m is abandoned.

import { FRONTIER_ROADS } from '../shared/world/frontier-layout.js';
import { VEHICLE_RULES, vehicleEnterDistance, vehicleMaxHp } from '../shared/vehicles.js';
import { vehicleSeatOccupantId, vehicleSeatDefinition, vehicleSeats } from '../shared/vehicle-seats.js';
import { botDifficulty } from '../shared/bot-difficulty.js';
import { mountSystem, seatWeapons } from './bot-vehicle-combat.js';
import { kitOfPlayer } from './bot-commander.js';

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (a, lo, hi) => Math.max(lo, Math.min(hi, a));
const bearing = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z));
const GROUND = new Set(['jeep', 'tank']);
export const TANK_RETREAT_HP = 0.4;
export const BAIL_ENGINEER_RADIUS = 20;
const OVERWATCH_MOVE_MS = [6000, 10000];
const DETOUR_PROBE_MS = 250;
const UNLOAD_RADIUS = 12;
const MAX_RECOVERIES = 6;          // reverse-and-retry attempts before a boxed-in crew gives up
const ABANDON_BENCH_MS = 60000;

export const botVehicleSeat = (p, v) => {
  const id = p.vehicleSeatId ?? 'driver';
  return vehicleSeatOccupantId(v, id) === String(p.id) ? vehicleSeatDefinition(v, id) : null;
};
export const botVehicleDriver = v => vehicleSeatOccupantId(v, vehicleSeats(v).find(seat => seat.drives)?.id ?? 'driver');
export const vehicleDisabled = v => ((v?.st | 0) & 2) !== 0 || v?.disabled === true;
export const maxHullHp = v => vehicleMaxHp(v?.type) || v?.maxHp || 650;
/** Countermeasure off cooldown: the live hull's cmReadyAt (engine clock), or a snapshot row's cmr readiness. */
export const countermeasureReady = (v, now) => (Number.isFinite(v?.cmr) ? v.cmr >= 100 : !(v?.cmReadyAt > now));

export function botPassengerInput(inp) {
  for (const key of Object.keys(inp.keys)) inp.keys[key] = false;
  for (const key of ['vehicleThrottle', 'vehicleSteer', 'vehicleBrake', 'vehicleLift', 'vehiclePitchControl', 'vehicleRollControl', 'vehicleYawControl']) delete inp[key];
  inp.wantFire = false; inp.wantAds = false; inp.reload = false; inp.switchTo = undefined;
}

/**
 * Goal for an infantry bot walking to its assigned hull: the bot navigates
 * like to any objective (still fighting on the way) and asks for its seat once
 * inside enter reach. `enter` is the action to send, or null while out of
 * reach or while the seat is taken.
 */
export function boardingGoal(game, p, hull, seatId) {
  const reach = vehicleEnterDistance(hull.type) - 0.15;
  const inReach = Math.hypot(p.x - hull.x, p.y - hull.y, p.z - hull.z) <= reach;
  const free = vehicleSeatOccupantId(hull, seatId) == null;
  const next = vehicleSeats(hull).find(seat => vehicleSeatOccupantId(hull, seat.id) == null);
  const enter = inReach && free && (mountSystem(game) || next?.id === seatId)
    ? { type: 'enter', vehicleId: hull.id, seatId } : null;
  return { vehicleId: hull.id, seatId, type: hull.type, point: { x: hull.x, y: hull.y, z: hull.z },
    arrive: Math.max(1, reach - 0.6), inReach, enter };
}

// ------------------------------------------------------------------ roads --

const GRAPHS = new WeakMap();
const roadY = game => (Number.isFinite(game.mapMeta?.navigationFloor) ? game.mapMeta.navigationFloor + 1.02 : (game.mapMeta?.groundLevel ?? 10) + 1.02);

/** Road polylines as [{x,y,z}] lists: mapMeta.conquest.roads (v2) or the legacy FRONTIER_ROADS. */
export function roadPolylines(game) {
  const roads = game.mapMeta?.conquest?.roads;
  if (Array.isArray(roads) && roads.length) {
    return roads.map(road => (road.points ?? road).map(point => Array.isArray(point)
      ? (point.length >= 3 ? { x: point[0], y: point[1], z: point[2] } : { x: point[0], y: roadY(game), z: point[1] })
      : { x: point.x, y: point.y ?? roadY(game), z: point.z })).filter(line => line.length >= 2);
  }
  if (game.mapMeta?.id !== 'frontier') return [];
  const y = roadY(game);
  return FRONTIER_ROADS.map(line => line.map(([x, z]) => ({ x: x + 0.5, y, z: z + 0.5 })));
}

/** Road graph: polyline vertices, merged within 3 m, with junctions where a
 * road ends on another's segment and with every crossing tied in. */
export function roadGraph(game) {
  const key = game.mapMeta?.conquest ?? game.mapMeta ?? game;
  let graph = GRAPHS.get(key);
  if (graph) return graph;
  const nodes = [];
  const nodeAt = (point) => {
    for (const node of nodes) if (distance(node, point) < 3) return node;
    const node = { id: nodes.length, x: point.x, y: point.y, z: point.z, edges: new Map() };
    nodes.push(node);
    return node;
  };
  const link = (a, b) => { if (a !== b) { const d = distance(a, b); a.edges.set(b.id, d); b.edges.set(a.id, d); } };
  const lines = roadPolylines(game).map(line => line.map(nodeAt));
  for (const line of lines) for (let i = 1; i < line.length; i++) link(line[i - 1], line[i]);
  const segments = () => nodes.flatMap(a => [...a.edges.keys()].filter(id => id > a.id).map(id => [a, nodes[id]]));
  // A road end that stops on another road's segment joins it there.
  for (const line of lines) for (const end of [line[0], line.at(-1)]) {
    let best = null;
    for (const [a, b] of segments()) {
      if (a === end || b === end) continue;
      const projected = projection(end, a, b), d = distance(end, projected);
      if (d < 12 && (!best || d < best.d)) best = { a, b, projected, d };
    }
    if (!best) continue;
    const junction = nodeAt(best.projected);
    if (junction !== best.a && junction !== best.b) {
      best.a.edges.delete(best.b.id); best.b.edges.delete(best.a.id);
      link(best.a, junction); link(junction, best.b);
    }
    link(end, junction);
  }
  for (const crossing of game.mapMeta?.conquest?.crossings ?? []) {
    let best = null;
    for (const [a, b] of segments()) {
      const projected = projection(crossing, a, b), d = distance(crossing, projected);
      if (d < 10 && (!best || d < best.d)) best = { a, b, projected, d };
    }
    if (best) {
      const node = nodeAt(best.projected);
      if (node !== best.a && node !== best.b) {
        best.a.edges.delete(best.b.id); best.b.edges.delete(best.a.id);
        link(best.a, node); link(node, best.b);
      }
      node.crossing = crossing.id ?? true;
    }
  }
  graph = { nodes };
  GRAPHS.set(key, graph);
  return graph;
}

function projection(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return { x: a.x + dx * t, y: a.y + (b.y - a.y) * t, z: a.z + dz * t };
}

function shortestPath(graph, start, end) {
  const costs = new Map([[start.id, 0]]), parents = new Map(), open = new Set([start.id]), done = new Set();
  while (open.size) {
    let id = null, best = Infinity;
    for (const candidate of open) { const c = costs.get(candidate); if (c < best) { best = c; id = candidate; } }
    open.delete(id); done.add(id);
    if (id === end.id) break;
    for (const [next, length] of graph.nodes[id].edges) {
      if (done.has(next)) continue;
      const cost = best + length;
      if (cost < (costs.get(next) ?? Infinity)) { costs.set(next, cost); parents.set(next, id); open.add(next); }
    }
  }
  const path = [end];
  while (path[0].id !== start.id && parents.has(path[0].id)) path.unshift(graph.nodes[parents.get(path[0].id)]);
  return path[0].id === start.id ? path : [start, end];
}

/**
 * Road route for a hull to a goal: join the nearest road (or the authored pad
 * exit route), run the graph, leave at the road node nearest the goal, then
 * drive the last leg cross-country.
 */
export function vehicleRoute(game, vehicle, goal) {
  const graph = roadGraph(game);
  const prefix = [];
  const exit = vehicle.spawn?.exitRoute;
  let from = vehicle;
  if (Array.isArray(exit) && exit.length && distance(vehicle, vehicle.spawn) < 8) {
    prefix.push(...exit.map(p => ({ ...p })));
    from = prefix.at(-1);
  }
  if (!graph.nodes.length || distance(from, goal) < 60) return [...prefix, { x: goal.x, y: goal.y ?? vehicle.y, z: goal.z }];
  let join = null;
  for (const a of graph.nodes) for (const id of a.edges.keys()) {
    const b = graph.nodes[id], projected = projection(from, a, b), d = distance(from, projected);
    if (!join || d < join.d) join = { a, b, projected, d };
  }
  const start = distance(join.a, goal) < distance(join.b, goal) ? join.a : join.b;
  const end = graph.nodes.reduce((best, node) => distance(node, goal) < distance(best, goal) ? node : best, graph.nodes[0]);
  const path = shortestPath(graph, start, end);
  // Skip road travel that would lead away from a goal closer than the road.
  if (distance(from, goal) < distance(from, join.projected) + distance(end, goal)) return [...prefix, { x: goal.x, y: goal.y ?? vehicle.y, z: goal.z }];
  return [...prefix, join.projected, ...path, { x: goal.x, y: goal.y ?? vehicle.y, z: goal.z }]
    .filter((p, i, list) => !i || distance(p, list[i - 1]) > 0.5);
}

// ---------------------------------------------------------------- drivers --

export class ConquestVehicleDriving {
  constructor(game, manager = null) {
    this.game = game; this.manager = manager;
    this.drivers = new Map(); this.boarding = new Map(); this.reflex = new Map();
    // Hulls a crew gave up on (boxed in after bounded recoveries): not re-crewed for a while.
    this.abandoned = new Map();
  }
  get commander() { return this.manager?.commander ?? null; }
  /** True while a hull is benched after its crew abandoned it. */
  benched(vehicleId, now = this.game.now) { return (this.abandoned.get(vehicleId) ?? 0) > now; }
  release(id) { this.drivers.delete(id); this.boarding.delete(id); this.reflex.delete(id); }
  clear() { this.drivers.clear(); this.boarding.clear(); this.reflex.clear(); this.abandoned.clear(); }
  active() { return this.game.mode.mode === 'conquest' && this.game.mode.phase === 'live' && !!this.game.vehicles; }

  update(brains, now) {
    if (!this.active()) { this.clear(); return; }
    const ids = new Set(brains.map(br => br.id));
    for (const id of [...this.drivers.keys(), ...this.boarding.keys()]) {
      const p = this.game.entities.get(id);
      if (!ids.has(id) || p?.state !== 'alive') this.release(id);
    }
  }

  /** Countermeasure reflex shared with aircraft: fire after the difficulty's reaction time. */
  countermeasure(br, p, v, now, inp) {
    if ((v.lk | 0) < 2) { this.reflex.delete(br.id); return false; }
    let due = this.reflex.get(br.id);
    if (due == null) { due = now + botDifficulty(br.difficulty).countermeasureMs; this.reflex.set(br.id, due); }
    if (now >= due && !inp.vehicleAction && countermeasureReady(v, now)) {
      inp.vehicleAction = { type: 'cm' };
      this.reflex.set(br.id, now + 4000);
      return true;
    }
    return false;
  }

  /** A disabled hull with no friendly engineer close by is abandoned. */
  shouldBail(p, v) {
    if (!vehicleDisabled(v)) return false;
    const team = this.game.mode.teamFor?.(p) ?? p.team;
    for (const o of this.game.entities.values()) {
      if (o === p || o.state !== 'alive' || o.vehicleId || (this.game.mode.teamFor?.(o) ?? o.team) !== team) continue;
      if (kitOfPlayer(this.game, o) === 'engineer' && distance(o, v) <= BAIL_ENGINEER_RADIUS) return false;
    }
    return true;
  }

  think(br, p, goal, now, dtS, inp) {
    if (!this.active()) return null;
    const v = this.game.vehicles.vehicles.get(p.vehicleId);
    const seat = v && GROUND.has(v.type) ? botVehicleSeat(p, v) : null;
    const assignment = this.commander?.crewFor(p.id) ?? null;
    if (seat) {
      const mine = assignment?.vehicleId === v.id ? assignment : null;
      const weapons = seatWeapons(this.game, v, seat.id).length > 0;
      if (this.shouldBail(p, v) && Math.abs(v.speed) < 3) {
        inp.vehicleAction = { type: 'exit' }; this.release(br.id); br.intendsMove = false;
        return { vehicle: v, seatId: seat.id, weapon: false };
      }
      if (seat.drives) {
        this.countermeasure(br, p, v, now, inp);
        const stuck = this.drivers.get(br.id);
        if (stuck?.vehicle === v && stuck.recoveries >= MAX_RECOVERIES) {
          // Boxed in after bounded recoveries: stop, bench the hull, get out.
          inp.vehicleThrottle = 0; inp.vehicleSteer = 0; inp.vehicleBrake = 1;
          stuck.abandoned = true;
          this.abandoned.set(v.id, now + ABANDON_BENCH_MS);
          if (Math.abs(v.speed) < 0.6) { inp.vehicleAction = { type: 'exit' }; this.boarding.delete(br.id); }
          br.intendsMove = false;
          return { vehicle: v, seatId: seat.id, weapon: false };
        }
        if (!mine) this.park(br, p, v, now, inp);
        else if (mine.role === 'transit') this.transitDrive(br, p, v, mine, now, inp);
        else if (v.type === 'tank') this.overwatch(br, p, v, mine, now, inp);
        else this.transitDrive(br, p, v, { ...mine, destination: mine.flag ?? goal.target }, now, inp);
      } else {
        botPassengerInput(inp);
        const transit = mine?.transit ?? null;
        const driverId = botVehicleDriver(v);
        const stopped = Math.abs(v.speed) < 0.8;
        // Riders wait aboard while the squad boards (no driver yet is normal
        // then); they get out at the drop, when a departed ride lost its
        // driver, or when they have no order for this hull at all. A crew
        // gunner (tank commander) keeps its seat and guns while the driver
        // walks in or respawns: the commander only books it alongside a
        // driver, and dropping that booking unloads it via `!mine`.
        const waiting = transit && !transit.departAt && !transit.done;
        const crewGunner = mine?.role === 'crew';
        const unload = transit?.done || (!mine && stopped) || (!crewGunner && !waiting && !driverId && stopped);
        if (unload) { inp.vehicleAction = { type: 'exit' }; this.release(br.id); this.commander?.leaveTransit(v.id, p.id); }
      }
      br.intendsMove = false;
      return { vehicle: v, seatId: seat.id, weapon: weapons && !inp.vehicleAction };
    }
    if (!assignment) return null;
    const hull = this.game.vehicles.vehicles.get(assignment.vehicleId);
    if (!hull || !GROUND.has(hull.type) || hull.hp <= 0 || vehicleDisabled(hull)) return null;
    if (p.vehicleId) return null;
    let state = this.boarding.get(br.id);
    if (!state || state.vehicleId !== hull.id) { state = { vehicleId: hull.id, type: hull.type, since: now }; this.boarding.set(br.id, state); }
    // The infantry brain walks there (and keeps fighting); see boardingGoal.
    return { board: boardingGoal(this.game, p, hull, assignment.seatId) };
  }

  /** An unassigned bot at the wheel stops and gets out (a ride ended, a human took the crew slot). */
  park(br, p, v, now, inp) {
    inp.vehicleThrottle = 0; inp.vehicleSteer = 0; inp.vehicleBrake = 1;
    if (Math.abs(v.speed) < 0.6) { inp.vehicleAction = { type: 'exit' }; this.release(br.id); }
  }

  driverState(br, v, destination, now) {
    let state = this.drivers.get(br.id);
    const key = destination ? `${Math.round(destination.x)},${Math.round(destination.z)}` : '';
    if (!state || state.vehicle !== v || state.key !== key) {
      state = { vehicle: v, key, destination, points: destination ? vehicleRoute(this.game, v, destination) : [], index: 0,
        watchAt: now, watchX: v.x, watchZ: v.z, watchYaw: v.yaw, recoveries: 0, reverseUntil: 0,
        probeAt: 0, detour: null, spot: state?.vehicle === v ? state.spot : null, settleAt: state?.vehicle === v ? state.settleAt : 0,
        moveAt: state?.vehicle === v ? state.moveAt : 0, retreat: state?.vehicle === v ? state.retreat : null };
      this.drivers.set(br.id, state);
    }
    return state;
  }

  /** Drive along a route; returns the remaining distance to its end. */
  follow(br, v, state, now, inp, { arrive = 6, cruise = null } = {}) {
    inp.vehicleThrottle = 0; inp.vehicleSteer = 0; inp.vehicleBrake = 1;
    const goal = state.points.at(-1);
    if (!goal) return 0;
    const remaining = distance(v, goal);
    if (remaining < arrive) return remaining;
    if (state.reverseUntil > now) {
      inp.vehicleBrake = 0; inp.vehicleThrottle = -0.7;
      inp.vehicleSteer = state.recoveries % 2 ? 0.65 : -0.65;
      return remaining;
    }
    while (state.index < state.points.length - 1 && distance(v, state.points[state.index]) < 5) state.index++;
    let target = state.points[state.index];
    // Craters can remove the road surface: probe the real placement rules ahead
    // at 4 Hz (or right after a watchdog recovery) and take a lane around.
    // Probe only at 4 Hz, or at once after a watchdog recovery (probeAt = 0).
    const probeDue = now >= state.probeAt;
    if (!state.detour && probeDue && distance(v, target) > 30 && Math.abs(wrap(bearing(v, target) - v.yaw)) < 0.25) {
      state.probeAt = now + DETOUR_PROBE_MS;
      this.probes = (this.probes ?? 0) + 1;
      const dx = -Math.sin(v.yaw), dz = -Math.cos(v.yaw), sx = Math.cos(v.yaw), sz = -Math.sin(v.yaw);
      const ahead = { x: v.x + dx * 14, z: v.z + dz * 14 };
      if (!this.drivable(v, v, ahead)) for (const side of [1, -1]) {
        const detour = [[2, 6], [19, 6], [27, 0]].map(([forward, lateral]) => ({
          x: v.x + dx * forward + sx * lateral * side, y: v.y, z: v.z + dz * forward + sz * lateral * side,
        }));
        let from = v, y = v.y, clear = true;
        for (const to of detour) {
          y = this.drivable(v, { x: from.x, y, z: from.z }, to);
          if (y === false) { clear = false; break; }
          from = to;
        }
        if (clear) { state.detour = detour; break; }
      }
    }
    if (state.detour) {
      while (state.detour.length && distance(v, state.detour[0]) < 2.5) state.detour.shift();
      if (state.detour.length) target = state.detour[0]; else state.detour = null;
    }
    const desiredYaw = bearing(v, target);
    const error = wrap(desiredYaw - v.yaw), d = distance(v, target);
    const next = state.detour ? (state.detour[1] ?? state.points[state.index]) : state.points[state.index + 1];
    const corner = next ? Math.abs(wrap(bearing(target, next) - desiredYaw)) : 0;
    const reverse = v.type === 'jeep' && Math.abs(error) > 1.9 && d < 42;
    const steeringError = reverse ? wrap(error + Math.PI) : error;
    const rules = VEHICLE_RULES[v.type];
    inp.vehicleSteer = clamp(-steeringError * (v.type === 'tank' ? 2 : 2.5) * (reverse ? -1 : 1), -1, 1);
    let speed = cruise ?? rules.speed;
    if (Math.abs(steeringError) > 0.35) speed = Math.min(speed, v.type === 'tank' ? 5 : 6);
    if (corner > 0.4 && d < 24) speed = Math.min(speed, 5 + d * 0.2);
    if (v.type === 'tank' && Math.abs(error) > 0.6) speed = 0;
    if (remaining < 40) speed = Math.min(speed, Math.max(3, remaining * 0.35));
    inp.vehicleBrake = Math.abs(v.speed) > speed + 1 ? 0.8 : 0;
    inp.vehicleThrottle = reverse ? -0.8 : speed / rules.speed;
    if (now - state.watchAt > 2500) {
      const moved = Math.hypot(v.x - state.watchX, v.z - state.watchZ);
      const turned = Math.abs(wrap(v.yaw - (state.watchYaw ?? v.yaw)));
      if (moved < 1.5 && turned < 0.15 && (speed > 0 || Math.abs(error) > 0.6) && inp.vehicleBrake === 0) {
        state.recoveries++;
        state.reverseUntil = now + 1400;
        state.probeAt = 0;
        state.detour = null;
      }
      state.watchAt = now; state.watchX = v.x; state.watchZ = v.z; state.watchYaw = v.yaw;
    }
    return remaining;
  }

  /**
   * Whether the hull can drive the straight line from `from` to `to` under the
   * real placement rules, carrying its height sample to sample (slopes up to
   * the hull's step limit per sample). Returns the arrival y, or false.
   */
  drivable(v, from, to, step = 1.5) {
    const length = distance(from, to), samples = Math.max(1, Math.ceil(length / step));
    const yaw = bearing(from, to);
    let y = Number.isFinite(from.y) ? from.y : v.y;
    for (let i = 1; i <= samples; i++) {
      const x = from.x + (to.x - from.x) * i / samples, z = from.z + (to.z - from.z) * i / samples;
      const next = this.game.vehicles.placement({ ...v, y, yaw }, x, z);
      if (next == null) return false;
      y = next;
    }
    return y;
  }

  /** A hull can stand at a far point: its pose there under the placement rules. */
  standsAt(v, point) {
    const y = Number.isFinite(point.y) ? Math.floor(point.y + 0.01) : v.y;
    return this.game.vehicles.placement({ ...v, y }, point.x, point.z) != null;
  }

  /** Jeep (or unarmed ride) to a destination, wait for the squad to board, then unload there. */
  transitDrive(br, p, v, assignment, now, inp) {
    const transit = assignment.transit;
    const destination = assignment.destination ?? transit?.destination;
    inp.vehicleThrottle = 0; inp.vehicleSteer = 0; inp.vehicleBrake = 1;
    inp.yaw = v.turretYaw ?? v.yaw; inp.pitch = v.turretPitch ?? 0;
    if (!destination) return;
    if (transit && !transit.departAt) {
      const waiting = [...transit.seats].some(([id, seatId]) => {
        const rider = this.game.entities.get(id);
        return rider?.state === 'alive' && vehicleSeatOccupantId(v, seatId) !== id;
      });
      transit.boardingSince ??= now;
      if (waiting && now - transit.boardingSince < 12000) return;
      this.commander?.markTransit(v.id, { departAt: now });
    }
    const state = this.driverState(br, v, destination, now);
    const remaining = this.follow(br, v, state, now, inp, { arrive: UNLOAD_RADIUS });
    const late = transit && now - transit.departAt > 40000;
    if ((remaining < UNLOAD_RADIUS || late || state.recoveries >= 4) ) {
      inp.vehicleThrottle = 0; inp.vehicleBrake = 1;
      if (Math.abs(v.speed) < 0.5) {
        this.commander?.markTransit(v.id, { done: true });
        this.commander?.leaveTransit(v.id, p.id);
        inp.vehicleAction = { type: 'exit' };
        this.release(br.id);
      }
    }
  }

  /** Tank: hold an overwatch spot on the flag, front armour to the threat, relocate every 6-10 s. */
  overwatch(br, p, v, assignment, now, inp) {
    const commander = this.commander;
    const flag = assignment.flag;
    inp.vehicleThrottle = 0; inp.vehicleSteer = 0; inp.vehicleBrake = 1;
    if (!flag) return;
    const threatYaw = commander?.threatAxis(p) ?? bearing(v, flag);
    const hp = v.hp / maxHullHp(v);
    const own = commander?.view?.bases?.[this.game.mode.teamFor?.(p) ?? p.team] ?? v.spawn ?? v;
    let state = this.drivers.get(br.id);
    // Below 40 %: back out of the fight, guns still forward, and wait for repair.
    if (hp < TANK_RETREAT_HP && !(state?.retreat?.done && hp >= TANK_RETREAT_HP)) {
      if (!state?.retreat || state.retreat.flagId !== flag.id) {
        const away = bearing(v, own);
        const point = { x: v.x - Math.sin(away) * 35, y: v.y, z: v.z - Math.cos(away) * 35 };
        state = this.driverState(br, v, null, now);
        state.retreat = { point, flagId: flag.id, from: { x: v.x, z: v.z }, done: false };
      }
      const retreat = state.retreat;
      if (!retreat.done && distance(v, retreat.from) < 30) {
        // Reverse: the hull keeps facing the threat while it backs away.
        const back = wrap(bearing(v, retreat.point) + Math.PI);
        const error = wrap(back - v.yaw);
        inp.vehicleBrake = 0; inp.vehicleThrottle = -0.9;
        inp.vehicleSteer = clamp(error * 2, -1, 1);
        if (now - (state.watchAt ?? now) > 2500) {
          if (Math.hypot(v.x - state.watchX, v.z - state.watchZ) < 1) retreat.done = true;
          state.watchAt = now; state.watchX = v.x; state.watchZ = v.z;
        }
      } else retreat.done = true;
      if (retreat.done) this.faceThreat(v, threatYaw, inp);
      return;
    }
    if (state?.retreat && hp >= 0.55) state.retreat = null;
    // Choose (or rotate) the overwatch spot.
    const spots = commander?.cover?.armorSpots(flag.id, bearing(flag, own)) ?? [];
    const due = !state?.spot || state.spot.flagId !== flag.id || (state.settleAt && now >= state.moveAt);
    if (due) {
      const current = state?.spot;
      const choice = spots.filter(spot => !current || distance(spot, current) > 8)
        .filter(spot => this.standsAt(v, spot))
        .sort((a, b) => distance(a, v) - distance(b, v))[0];
      // Rotating with no other standable spot keeps the current one; a first
      // (or new-flag) assignment whose candidates all fail the hull footprint
      // drives to the fallback instead of parking on the pad.
      const rotating = current?.flagId === flag.id;
      const point = choice ?? (rotating ? null : this.fallbackSpot(v, flag, own));
      state = this.driverState(br, v, point ?? current ?? null, now);
      state.spot = point ? { ...point, flagId: flag.id } : current;
      state.settleAt = 0;
      state.moveAt = Infinity;
    }
    if (!state.spot) { this.faceThreat(v, threatYaw, inp); return; }
    if (!state.points.length || state.key !== `${Math.round(state.spot.x)},${Math.round(state.spot.z)}`) {
      state = this.driverState(br, v, state.spot, now);
    }
    const remaining = this.follow(br, v, state, now, inp, { arrive: 4, cruise: distance(v, state.spot) > 60 ? null : 7 });
    if (remaining < 4) {
      if (!state.settleAt) {
        state.settleAt = now;
        state.moveAt = now + OVERWATCH_MOVE_MS[0] + br.rng() * (OVERWATCH_MOVE_MS[1] - OVERWATCH_MOVE_MS[0]);
      }
      this.faceThreat(v, threatYaw, inp);
    }
  }

  /**
   * Without a usable precomputed spot: a point about 55 m short of the flag on
   * the friendly side, the first that the hull stands on under the placement
   * rules, else the plain 55 m point (the route still closes on it).
   */
  fallbackSpot(v, flag, own) {
    const base = bearing(flag, own);
    const at = (yaw, r) => ({ x: flag.x - Math.sin(yaw) * r, y: flag.y, z: flag.z - Math.cos(yaw) * r });
    for (const offset of [0, 0.25, -0.25, 0.5, -0.5]) for (const r of [55, 45, 65]) {
      const point = at(base + offset, r);
      if (this.standsAt(v, point)) return point;
    }
    return at(base, 55);
  }

  /** Pivot in place so the front plate points along the threat axis. */
  faceThreat(v, threatYaw, inp) {
    inp.vehicleThrottle = 0;
    const error = wrap(threatYaw - v.yaw);
    if (Math.abs(error) > 0.2) { inp.vehicleBrake = 0; inp.vehicleSteer = clamp(-error * 2.2, -1, 1); }
    else { inp.vehicleBrake = 1; inp.vehicleSteer = 0; }
  }
}

