// Bots and the Conquest map events (docs/conquest.md "Map events"; the server
// half is server/modes/conquest/map-events/).
//
// Tasks: every 2 Hz commander plan, each event's controller posts tasks per
// team (`botTasks(team)`: {id, kind, point, pointKey?, radius, priority,
// squad, range?, arrive?, until?, kits?}). `planMapEventTasks` books the nearest
// free bots for each task, highest priority first, up to its squad size:
// bots on foot that crew no hull, ride no hitch and are not bound by a human
// leader's order (unless the task's priority reaches HUMAN_ORDER_PRIORITY)
// and, for a task with `kits`, carry one of those kits.
// A booked bot keeps its task while it stays posted. Kinds:
//   use     walk to the interaction point and hold the `use` intent (plant,
//           defuse, turn the wheel, claim the crate) through the bots' support
//           plumbing (server/bots.js, as a revive);
//   hold    stand inside `radius` of the point and fight from there (a relay);
//   attack  close on the point with the gun up (stop an enemy plant);
//   shoot   fire a launcher at the point from where the bot stands (a fuel tank
//           with enemies around it): never booked by the commander and never a
//           movement goal; `mapEventShoot` (BotManager, per tick) picks it up for
//           a bot that carries one of `projectiles` within `minRange`..`range`
//           and sees the point (a voxel hit within `hitWithin` m of it counts).
// Hazards: a bot inside a zone it should avoid (open or warned) runs out first
// (`hazardEscape`, before everything but the Iron Bridge's span escape), and
// every goal point inside one is pushed to the zone's edge (`avoidHazards`).
// Drivers: crossings an event closes join the Iron Bridge's in
// `closedCrossings` (server/bot-bridge.js), so road routes skip them.
import { MAP_EVENT_RULES, MAP_EVENT_SUPPORT, zoneContains, zoneExit, zoneExitToward } from '../shared/conquest-map-events.js';
import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import { ROCKET_RULES } from '../shared/rocket-rules.js';
import { raycastVoxels } from '../shared/raycast.js';
import { ballisticAim } from './bot-vehicle-combat.js';

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

/**
 * A goal point inside an avoided zone moves to the zone's edge: the edge
 * nearest `from` when `from` stands outside it (the bot keeps out instead of
 * crossing), else the nearest edge; other points pass.
 */
export function avoidHazards(game, point, from = null, team = null) {
  const zone = hazardAt(game, point, team);
  if (!zone) return point;
  const margin = MAP_EVENT_RULES.hazards.fleeMargin;
  const out = from && !zoneContains(zone, from.x, from.y, from.z) ? zoneExitToward(zone, point, from, margin) : zoneExit(zone, point, margin);
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
  const tasks = (mapEventsView(commander.game).tasks?.[ts.team] ?? []).filter(t => t.kind !== 'shoot').sort((a, b) => b.priority - a.priority);
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
    if (Array.isArray(task.kits) && !task.kits.includes(commander.kitOf(p))) return false;
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
  if (!task || p.vehicleId || task.kind === 'shoot') return null;
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

/* ------------------------------------------------------------- shoot tasks */

/** Rescan cadence and how long a bot keeps one shoot task without firing. */
const SHOOT_SCAN_MS = 500, SHOOT_GIVE_UP_MS = 8000, SHOOT_FIRE_ERROR = 0.035;

/** An owned slot whose weapon fires one of `projectiles` and has a round, or undefined. */
function launcherSlot(p, ownedSlots, projectiles) {
  return ownedSlots.find(s => projectiles.includes(WEAPONS[WEAPON_IDS[s]]?.projectile) && (p.mag[s] > 0 || p.reserve[s] > 0));
}

/** The shoot task of `team` this bot can take now (range, launcher, a clear line), or null. */
function shootTaskFor(game, p, team, ownedSlots) {
  const tasks = (mapEventsView(game).tasks?.[team] ?? []).filter(t => t.kind === 'shoot');
  if (!tasks.length) return null;
  const eye = [p.x, p.eyeY ?? p.y + 1.6, p.z];
  let best = null;
  for (const task of tasks) {
    const pt = [task.point.x, task.point.y, task.point.z];
    const d = Math.hypot(pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]);
    if (d < (task.minRange ?? 25) || d > (task.range ?? 120)) continue;
    const slot = launcherSlot(p, ownedSlots, task.projectiles ?? ['rocket']);
    if (slot === undefined) continue;
    const hit = raycastVoxels(game.solidAt, ...eye, pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2], d);
    if (hit && hit.t < d - (task.hitWithin ?? 3)) continue;
    if (!best || task.priority > best.task.priority) best = { task, slot };
  }
  return best;
}

/**
 * BotManager hook (Conquest, every tick): a bot that can take a posted
 * `shoot` task raises the launcher and fires at the point (rocket drop and
 * flight time from ROCKET_RULES), over whatever fight it had. Returns true
 * while engaged; the caller then holds the legs still.
 */
export function mapEventShoot(game, br, p, inp, now, dtS, ownedSlots, turnRate, pitchTurnRate, team) {
  if (!p || p.vehicleId || !team) { if (br) br.eventShoot = null; return false; }
  let job = br.eventShoot;
  if (job && (now > job.giveUpAt || !(mapEventsView(game).tasks?.[team] ?? []).some(t => t.id === job.task.id))) job = br.eventShoot = null;
  if (!job && now >= (br.eventShootScanAt ?? 0)) {
    br.eventShootScanAt = now + SHOOT_SCAN_MS;
    const found = shootTaskFor(game, p, team, ownedSlots);
    if (found) job = br.eventShoot = { task: found.task, slot: found.slot, giveUpAt: now + SHOOT_GIVE_UP_MS };
  }
  if (!job) return false;
  if (p.weapon !== job.slot) {
    if (!(p.mag[job.slot] > 0 || p.reserve[job.slot] > 0)) { br.eventShoot = null; return false; }
    if (inp.switchTo === undefined) inp.switchTo = job.slot;
    return true;
  }
  const eye = [p.x, p.eyeY ?? p.y + 1.6, p.z];
  const point = [job.task.point.x, job.task.point.y, job.task.point.z];
  const aim = ballisticAim(eye, point, { vx: 0, vy: 0, vz: 0 }, { speed: ROCKET_RULES.speed, gravity: ROCKET_RULES.gravity,
    maxSeconds: ROCKET_RULES.lifetimeMs / 1000 });
  inp.yaw = br.aim.steer('yaw', p.yaw, aim.yaw, turnRate, dtS);
  inp.pitch = br.aim.steer('pitch', p.pitch, aim.pitch, pitchTurnRate, dtS);
  const error = Math.hypot(Math.atan2(Math.sin(inp.yaw - aim.yaw), Math.cos(inp.yaw - aim.yaw)), inp.pitch - aim.pitch);
  inp.wantAds = true;
  if (p.mag[p.weapon] === 0) { if (p.reserve[p.weapon] > 0) inp.reload = true; return true; }
  inp.wantFire = error < SHOOT_FIRE_ERROR && !p.triggerPrev && !p.reloading;
  return true;
}
