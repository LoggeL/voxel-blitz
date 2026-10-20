// Bots and the Conquest map events (docs/conquest.md "Map events"; the server
// half is server/modes/conquest/map-events/).
//
// Tasks: every 2 Hz commander plan, each event's controller posts tasks per
// team (`botTasks(team)`: {id, kind, point, pointKey?, radius, priority,
// squad, range?, arrive?, until?}). `planMapEventTasks` books the nearest
// free bots for each task, highest priority first, up to its squad size:
// bots on foot that crew no hull, ride no hitch and are not bound by a human
// leader's order (unless the task's priority reaches HUMAN_ORDER_PRIORITY).
// A booked bot keeps its task while it stays posted. Kinds:
//   use     walk to the interaction point and hold the `use` intent (plant,
//           defuse, turn the wheel, claim the crate) through the bots' support
//           plumbing (server/bots.js, as a revive);
//   hold    stand inside `radius` of the point and fight from there (a relay);
//   attack  close on the point with the gun up (stop an enemy plant).
// Hazards: a bot inside a zone it should avoid (open or warned) runs out first
// (`hazardEscape`, before everything but the Iron Bridge's span escape), and
// every goal point inside one is pushed to the zone's edge (`avoidHazards`).
// Drivers: crossings an event closes join the Iron Bridge's in
// `closedCrossings` (server/bot-bridge.js), so road routes skip them.
import { MAP_EVENT_RULES, MAP_EVENT_SUPPORT, zoneContains, zoneExit } from '../shared/conquest-map-events.js';

/** A task at or above this priority may take bots out of a human-led squad's order. */
export const HUMAN_ORDER_PRIORITY = 10;
/** Default metres a bot walks for a task. */
export const TASK_RANGE = 220;
/** Extra metres of "distance" a Medic pays for a task (it is picked last; revives come first). */
const MEDIC_TASK_PENALTY = 80;
const EMPTY = Object.freeze({ active: false, tasks: { alpha: [], bravo: [] }, hazards: [], closed: new Set(), events: [] });

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** The policy's per-tick map event view (ConquestPolicy.conquestView().mapEvents), or an empty one. */
export function mapEventsView(game) {
  const policy = game?.mode?.policy;
  const view = typeof policy?.conquestView === 'function' ? policy.conquestView()?.mapEvents : null;
  return view?.active ? view : EMPTY;
}

/** Crossing ids the map events close for bot drivers now. */
export function eventClosedCrossings(game) { return mapEventsView(game).closed; }

/** Zones a bot of `team` keeps out of now. */
export function avoidZonesFor(game, team) {
  const zones = mapEventsView(game).hazards;
  return team ? zones.filter(z => !(z.spareTeam && z.byTeam && z.byTeam === team)) : zones;
}

/** The zone (avoided by `team`) containing a point, or null. */
export function hazardAt(game, point, team = null) {
  if (!point) return null;
  for (const zone of avoidZonesFor(game, team)) if (zoneContains(zone, point.x, point.y, point.z, 0.5)) return zone;
  return null;
}

/**
 * A bot standing in a zone it should avoid: the goal that runs it out (to the
 * zone's edge plus fleeMargin), else null.
 */
export function hazardEscape(game, p, team = null) {
  const zone = p?.vehicleId ? null : hazardAt(game, p, team);
  if (!zone) return null;
  const point = zoneExit(zone, { x: p.x, y: p.y, z: p.z }, MAP_EVENT_RULES.hazards.fleeMargin);
  return { kind: 'capture', target: null, interact: false, stance: 'attack', point, arrive: 1.5,
    lookYaw: Math.atan2(-(point.x - p.x), -(point.z - p.z)), hazard: zone.id };
}

/** A goal point inside an avoided zone moves to the zone's edge (the side of `from`); other points pass. */
export function avoidHazards(game, point, from = null, team = null) {
  const zone = hazardAt(game, point, team);
  if (!zone) return point;
  const side = from && !zoneContains(zone, from.x, from.y, from.z) ? from : point;
  const out = zoneExit(zone, { ...point, x: side.x, z: side.z }, MAP_EVENT_RULES.hazards.fleeMargin);
  return { ...point, x: out.x, z: out.z };
}

/** Rewrite a goal's point out of the avoided zones (never an escape, an event task or a vehicle goal). */
export function goalOutOfHazards(game, goal, p, team) {
  if (!goal?.point || goal.hazard || goal.event || goal.kind === 'vehicle' || p?.vehicleId) return goal;
  const point = avoidHazards(game, goal.point, p, team);
  return point === goal.point ? goal : { ...goal, point };
}

/**
 * Book bots for the team's posted tasks (part of the commander's 2 Hz plan).
 * Writes ts.eventTasks (task id -> task) and ts.eventAssign (bot id -> task id).
 */
export function planMapEventTasks(commander, ts, now) {
  const tasks = (mapEventsView(commander.game).tasks?.[ts.team] ?? []).slice().sort((a, b) => b.priority - a.priority);
  const prior = ts.eventAssign ?? new Map();
  ts.eventTasks = new Map(tasks.map(t => [t.id, t]));
  ts.eventAssign = new Map();
  if (!tasks.length) return;
  const humanSquads = new Set();
  for (const squad of ts.squads?.values?.() ?? []) if (squad.order?.human) humanSquads.add(squad.id);
  const eligible = (p, task) => {
    if (!p?.bot || p.state !== 'alive' || p.vehicleId) return false;
    const id = String(p.id);
    if (ts.crews?.has?.(id) || ts.hitches?.has?.(id)) return false;
    if (humanSquads.has(ts.memberSquad?.get(id)?.id) && task.priority < HUMAN_ORDER_PRIORITY) return false;
    return flat(p, task.point) <= (task.range ?? TASK_RANGE);
  };
  const bots = commander.teamBrains(ts.team).map(br => commander.game.entities.get(String(br.id))).filter(Boolean);
  const booked = new Set();
  for (const task of tasks) {
    const want = Math.max(1, task.squad | 0);
    const keep = bots.filter(p => prior.get(String(p.id)) === task.id && !booked.has(String(p.id)) && eligible(p, task)).slice(0, want);
    const fresh = bots.filter(p => !booked.has(String(p.id)) && !keep.includes(p) && eligible(p, task))
      .map(p => ({ p, d: flat(p, task.point) + (commander.kitOf(p) === 'medic' ? MEDIC_TASK_PENALTY : 0) }))
      .sort((a, b) => a.d - b.d).slice(0, Math.max(0, want - keep.length)).map(row => row.p);
    for (const p of [...keep, ...fresh]) { booked.add(String(p.id)); ts.eventAssign.set(String(p.id), task.id); }
  }
}

/** The task goal of a booked bot, or null. */
export function mapEventGoal(commander, p, ts) {
  const taskId = ts?.eventAssign?.get(String(p?.id));
  const task = taskId ? ts.eventTasks?.get(taskId) : null;
  if (!task || p.vehicleId) return null;
  const point = { x: task.point.x, y: task.point.y ?? p.y, z: task.point.z };
  const radius = Math.max(0.8, task.radius ?? 2);
  const lookYaw = Number.isFinite(task.lookYaw) ? task.lookYaw : Math.atan2(-(point.x - p.x), -(point.z - p.z));
  if (task.kind === 'use' && task.pointKey) {
    return { kind: 'capture', target: point, interact: false, stance: 'attack', role: 'support', point, event: task.id,
      arrive: Math.min(task.arrive ?? radius * 0.4, radius - 0.4), reach: radius - 0.3, lookYaw,
      support: { type: 'support', support: MAP_EVENT_SUPPORT, targetId: task.pointKey } };
  }
  return { kind: 'capture', target: point, interact: false, stance: task.kind === 'attack' ? 'attack' : 'defend', point, event: task.id,
    arrive: task.arrive ?? radius * 0.6, lookYaw };
}
