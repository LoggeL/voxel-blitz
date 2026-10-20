// Bots and the Conquest map events (docs/conquest.md "Map events"; the server
// half is server/modes/conquest/map-events/).
//
// Tasks: every 2 Hz commander plan, each event's controller posts tasks per
// team (`botTasks(team)`: {id, kind, point, pointKey?, radius, priority,
// squad, range?, arrive?, until?, kits?}). `planMapEventTasks` books the nearest
// free bots for each task, highest priority first, up to its squad size:
// bots on foot within TASK_RANGE (120 m) of the point that crew no hull, ride no hitch, are not bound by a human
// leader's order and are not taking a flag (standing in a zone their team
// is turning, or passing an undefended one: bot-flag-flow.js committedFlag /
// passingFlag; both unless the task's priority reaches HUMAN_ORDER_PRIORITY)
// and, for a task with `kits`, carry one of those kits (without `kits`, a
// Medic takes only `use` tasks: it trails its squad, it holds no ground).
// A booked bot's class job at hand (revive, comm answer, heal, repair;
// BotCommander.roleGoal) comes before its task.
// A booked bot keeps its task while it stays posted. Kinds:
//   use     walk to the interaction point and hold the `use` intent (plant,
//           defuse a charge) through the bots' support plumbing (server/bots.js,
//           as a revive);
//   hold    stand inside `radius` of the point and fight from there;
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
// Structures (the Iron Bridge and every levolution event): one number,
// `crossingDenialValue`, says what closing (or opening) a crossing is worth
// to a side in road metres. Above DEMOLISH_RULES.minValue the side posts a
// `demolish` task on the structure (two launcher bots and one hull or
// aircraft crew fire on its supports); below -minValue it holds the
// bridgeheads instead (see "Structures" below).
import { MAP_EVENT_RULES, MAP_EVENT_SUPPORT, zoneContains, zoneExit, zoneExitToward } from '../shared/conquest-map-events.js';
import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import { ROCKET_RULES } from '../shared/rocket-rules.js';
import { raycastVoxels } from '../shared/raycast.js';
import { IRON_BRIDGE_RULES } from '../shared/conquest-bridge.js';
import { vehicleWeaponMeta } from '../shared/conquest-contract.js';
import { VEHICLE_WEAPONS } from '../shared/vehicle-defs.js';
import { ballisticAim, seatWeapons } from './bot-vehicle-combat.js';
import { committedFlag, passingFlag } from './bot-flag-flow.js';
import { roadGraph } from './bot-vehicle-driving.js';
import { closedCrossings } from './bot-bridge.js';

/** A task at or above this priority may take bots out of a human-led squad's order. */
export const HUMAN_ORDER_PRIORITY = 10;
/**
 * Booking radius: only bots within this many metres (flat) of a task's point
 * are booked for it, whatever the task asks (`range` may only narrow it), so
 * an event takes the bots already fighting there, never a walk across the map.
 */
export const TASK_RANGE = 120;
/** Extra metres of "distance" a Medic pays for a task (it is picked last; revives come first). */
const MEDIC_TASK_PENALTY = 80;
const EMPTY = Object.freeze({ active: false, tasks: { alpha: [], bravo: [] }, hazards: [], closed: new Set(), structures: [], events: [] });

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
export function planMapEventTasks(commander, ts, now, view = commander.view) {
  const posted = [...(mapEventsView(commander.game).tasks?.[ts.team] ?? []), ...planStructureTasks(commander, ts, now)];
  const tasks = posted.filter(t => t.kind !== 'shoot').sort((a, b) => b.priority - a.priority);
  const prior = ts.eventAssign ?? new Map();
  ts.eventTasks = new Map(tasks.map(t => [t.id, t]));
  ts.eventAssign = new Map();
  bookStructureHulls(commander, ts, tasks);
  if (!tasks.length) return;
  const humanSquads = new Set();
  for (const squad of ts.squads?.values?.() ?? []) if (squad.order?.human) humanSquads.add(squad.id);
  // A bot taking a flag (in a zone its team is turning, or passing an undefended one) stays on it.
  const taking = new Map();
  const takingFlag = (p, order) => {
    const id = String(p.id);
    if (!view?.flags) return false;
    if (!taking.has(id)) taking.set(id, !!(committedFlag(commander, p, ts.team, view, order)
      ?? (order?.stance === 'defend' || order?.human ? null : passingFlag(commander, p, ts, view, null))));
    return taking.get(id);
  };
  const eligible = (p, task) => {
    if (!p?.bot || p.state !== 'alive' || p.vehicleId) return false;
    const id = String(p.id);
    if (ts.crews?.has?.(id) || ts.hitches?.has?.(id)) return false;
    const squad = ts.memberSquad?.get(id);
    if (task.priority < HUMAN_ORDER_PRIORITY && humanSquads.has(squad?.id)) return false;
    if (task.priority < HUMAN_ORDER_PRIORITY && takingFlag(p, squad?.order ?? null)) return false;
    const kit = commander.kitOf(p);
    if (Array.isArray(task.kits) ? !task.kits.includes(kit) : kit === 'medic' && task.kind !== 'use') return false;
    if (task.launchers && !carriesLauncher(p, task.launchers)) return false;
    return flat(p, task.point) <= Math.min(task.range ?? TASK_RANGE, TASK_RANGE);
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
  if (task.kind === 'demolish' && task.aim) {
    // Stand off on the own side and face the aimed support: mapEventShoot fires the launcher from there.
    return { kind: 'capture', target: point, interact: false, stance: 'attack', point, event: task.id, arrive: task.arrive ?? radius * 0.6,
      lookYaw: Math.atan2(-(task.aim.x - p.x), -(task.aim.z - p.z)) };
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

/**
 * The shoot targets open to this bot: the events' posted `shoot` tasks, plus
 * the support of the `demolish` task its commander booked it for (as a shoot
 * task under the demolish task's id).
 */
function shootTasks(game, p, team, commander = null) {
  const tasks = (mapEventsView(game).tasks?.[team] ?? []).filter(t => t.kind === 'shoot');
  const ts = commander?.teams?.get?.(team);
  const booked = ts?.eventTasks?.get(ts.eventAssign?.get(String(p.id)));
  if (booked?.kind === 'demolish' && booked.shoot) tasks.push({ ...booked.shoot, id: booked.id, priority: booked.priority });
  return tasks;
}

/** The shoot task of `team` this bot can take now (range, launcher, a clear line), or null. */
function shootTaskFor(game, p, team, ownedSlots, commander = null) {
  const tasks = shootTasks(game, p, team, commander);
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
export function mapEventShoot(game, br, p, inp, now, dtS, ownedSlots, turnRate, pitchTurnRate, team, commander = null) {
  if (!p || p.vehicleId || !team) { if (br) br.eventShoot = null; return false; }
  let job = br.eventShoot;
  if (job && (now > job.giveUpAt || !shootTasks(game, p, team, commander).some(t => t.id === job.task.id))) job = br.eventShoot = null;
  if (!job && now >= (br.eventShootScanAt ?? 0)) {
    br.eventShootScanAt = now + SHOOT_SCAN_MS;
    const found = shootTaskFor(game, p, team, ownedSlots, commander);
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

/* -------------------------------------------------------------- structures */

/**
 * Structure decisions (the Iron Bridge, every levolution event):
 *  minValue     road metres: a side posts `demolish` on a standing structure
 *               whose crossing it gains more than this by closing
 *               (crossingDenialValue > minValue), and holds the bridgeheads of
 *               one it would lose this much by (value < -minValue)
 *  cacheMs      a value is reused this long while flag ownership, the closed
 *               crossings and the hull counts stay the same
 *  unreachableM a route the closure cuts entirely counts as this many metres
 *  infantry / hulls  the demolish task's squad: launcher bots on foot and one
 *               hull or aircraft crew (both booked within TASK_RANGE)
 *  standoff     the infantry fire from this far off the aimed support, toward
 *               their own HQ (inside the RX-8's 25..120 m shoot band)
 *  hold         the defenders' bridgehead posts: one bot each within `radius`
 *  hullFire     per hull type, in booking preference (a tank's HE and a jet's
 *               bombs first, the helicopter's rockets last): the weapons that
 *               wear supports down (the most supportDamage first) and the fire
 *               band in metres; jets drop bombs that land within `bombWithin`
 *               m of the support
 */
export const DEMOLISH_RULES = Object.freeze({
  minValue: 100,
  cacheMs: 10000,
  unreachableM: 600,
  infantry: 2,
  hulls: 1,
  priority: 6,
  standoff: 40,
  hold: Object.freeze({ radius: 12, squad: 1, priority: 5 }),
  shoot: Object.freeze({ minRange: 25, range: 120, hitWithin: 3, projectiles: Object.freeze(['rocket']) }),
  hullFire: Object.freeze({
    tank: Object.freeze({ weapons: Object.freeze(['tankHE', 'tankAP']), min: 40, max: 200 }),
    plane: Object.freeze({ weapons: Object.freeze(['jetBomb']), min: 0, max: 400, bombWithin: 7 }),
    jeep_at: Object.freeze({ weapons: Object.freeze(['towMissile']), min: 30, max: 200 }),
    helicopter: Object.freeze({ weapons: Object.freeze(['guidedMissile', 'helicopterRocket']), min: 30, max: 220 }),
  }),
  aimTolerance: 0.02,
  selectMs: 450,
});

/** Ground hulls whose routes the value weighs (boats and aircraft never use a road crossing). */
const ROAD_HULLS = new Set(['jeep', 'jeep_at', 'tank', 'aa']);
const TEAMS = ['alpha', 'bravo'];
const otherTeam = team => (team === 'alpha' ? 'bravo' : 'alpha');

/** Every structure bots may blow down or defend: the Iron Bridge's view, then the levolution events'. */
export function structureViews(game) {
  const list = [];
  const bridge = game?.mode?.policy?.bridge;
  if (bridge?.active && typeof bridge.structureView === 'function') list.push(bridge.structureView());
  for (const s of mapEventsView(game).structures ?? []) list.push(s);
  return list;
}

/** A launcher with a round among the body's kit weapons (projectile types, e.g. ['rocket']). */
function carriesLauncher(p, projectiles) {
  const owned = Array.isArray(p.owned) ? p.owned : WEAPON_IDS;
  return owned.some(id => {
    const slot = WEAPON_IDS.indexOf(id);
    return slot >= 0 && projectiles.includes(WEAPONS[id]?.projectile) && (p.mag?.[slot] > 0 || p.reserve?.[slot] > 0);
  });
}

/** Road costs (m) from one graph node to every node, never driving through a node of a closed crossing (one may end on it). */
function roadCosts(graph, start, closed) {
  const costs = new Float64Array(graph.nodes.length).fill(Infinity);
  const done = new Uint8Array(graph.nodes.length);
  costs[start.id] = 0;
  for (;;) {
    let id = -1, best = Infinity;
    for (let i = 0; i < costs.length; i++) if (!done[i] && costs[i] < best) { best = costs[i]; id = i; }
    if (id < 0) break;
    done[id] = 1;
    if (id !== start.id && closed.size && closed.has(graph.nodes[id].crossing)) continue;
    for (const [next, length] of graph.nodes[id].edges) if (!done[next] && best + length < costs[next]) costs[next] = best + length;
  }
  return costs;
}

const nearestNode = (graph, point) => graph.nodes.reduce((best, n) => (!best || flat(n, point) < flat(best, point) ? n : best), null);
const DENIAL_CACHE = new WeakMap(), COST_CACHE = new WeakMap();

/** roadCosts, shared by both sides and every structure for cacheMs (keyed by start node and closed set). */
function cachedCosts(graph, start, closed, now, ttl) {
  let cache = COST_CACHE.get(graph);
  if (!cache) COST_CACHE.set(graph, cache = new Map());
  const key = `${start.id}|${[...closed].sort().join(',')}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl && now >= hit.at) return hit.costs;
  const costs = roadCosts(graph, start, closed);
  cache.set(key, { at: now, costs });
  if (cache.size > 96) cache.delete(cache.keys().next().value);
  return costs;
}

/**
 * What closing (`close`) or reopening (`open`) road crossings is worth to
 * `team` now, in road metres, with the parts it is made of:
 *
 *   routes   a side's routes run from where its hulls spawn (its HQ and
 *            every flag it holds; the nearest road node) to every flag: the
 *            attacks and the reinforcement of its own flags. Each route's
 *            road cost changes against the crossings closed today (a route
 *            the change cuts counts unreachableM), summed over the side
 *   weight   each side's living ground hulls against the mean fleet
 *            (equal fleets: 1 each; a side without hulls: 0)
 *   value    enemy weight x enemy sum - own weight x own sum
 *
 * Road costs are symmetric, so a route between the two sides' holdings
 * costs both the same and cancels: what is left is each side's own supply
 * across the closure (a flag held over the river, a forward pad cut off
 * from its HQ) and the fleet gap. A positive value means the closure costs
 * the enemy's vehicles more road than the side's own: worth blowing the
 * structure. Mirrored holdings with equal fleets give 0 on point-symmetric
 * Frontier. Values are cached for DEMOLISH_RULES.cacheMs while ownership,
 * closures and fleets stay the same.
 * Returns {value, own: {routes, sum, mean, hulls, weight}, enemy: {...}}.
 */
export function crossingDenial(game, team, { close = [], open = [] } = {}, rules = DEMOLISH_RULES) {
  const none = { value: 0, own: null, enemy: null };
  const graph = game?.mapMeta ? roadGraph(game) : null;
  const flags = game?.mode?.policy?.conquestView?.()?.flags ?? null;
  const bases = game?.mapMeta?.conquest?.bases;
  if (!graph?.nodes.length || !flags || !bases || !TEAMS.includes(team)) return none;
  const toList = v => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);
  const base = new Set(closedCrossings(game));
  const scenario = new Set([...base, ...toList(close)]);
  for (const id of toList(open)) scenario.delete(id);
  const hulls = { alpha: 0, bravo: 0 };
  for (const v of game.vehicles?.vehicles?.values?.() ?? []) if (v.hp > 0 && ROAD_HULLS.has(v.type) && v.team in hulls) hulls[v.team]++;
  const key = [team, [...scenario].sort().join(','), [...base].sort().join(','), hulls.alpha, hulls.bravo,
    flags.map(f => `${f.id}${f.owner ?? '-'}`).join('')].join('|');
  let cache = DENIAL_CACHE.get(game);
  if (!cache) DENIAL_CACHE.set(game, cache = new Map());
  const now = game.now ?? 0;
  const hit = cache.get(key);
  if (hit && now - hit.at < rules.cacheMs) return hit.result;
  const side = s => {
    const sources = [bases[s], ...flags.filter(f => f.owner === s)].filter(Boolean);
    let sum = 0, routes = 0;
    for (const src of sources) {
      const from = nearestNode(graph, src);
      const before = cachedCosts(graph, from, base, now, rules.cacheMs), after = cachedCosts(graph, from, scenario, now, rules.cacheMs);
      for (const f of flags) {
        if (f === src) continue;
        const to = nearestNode(graph, f).id;
        if (!Number.isFinite(before[to])) continue;
        sum += Number.isFinite(after[to]) ? after[to] - before[to] : rules.unreachableM;
        routes++;
      }
    }
    return { routes, sum, mean: routes ? sum / routes : 0, hulls: hulls[s] };
  };
  const own = side(team), enemy = side(otherTeam(team));
  const fleet = (hulls.alpha + hulls.bravo) / 2;
  own.weight = fleet > 0 ? own.hulls / fleet : 0;
  enemy.weight = fleet > 0 ? enemy.hulls / fleet : 0;
  const result = { value: Math.round(enemy.weight * enemy.sum - own.weight * own.sum), own, enemy };
  cache.set(key, { at: now, result });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return result;
}

/** Road metres between two points (their nearest road nodes) with `closed` crossings shut (default: today's); Infinity when cut. */
export function roadMetres(game, from, to, closed = closedCrossings(game)) {
  const graph = roadGraph(game);
  if (!graph.nodes.length) return Infinity;
  return roadCosts(graph, nearestNode(graph, from), new Set(closed))[nearestNode(graph, to).id];
}

/** crossingDenial's value alone: road metres closing `close` (or opening `open`) is worth to `team`. */
export const crossingDenialValue = (game, team, scenario = {}, rules = DEMOLISH_RULES) => crossingDenial(game, team, scenario, rules).value;

/** Ground height (first open cell over the live column) at x, z. */
function groundAt(game, x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let y = game.world?.heightAt?.(ix, iz);
  if (!Number.isFinite(y)) return game.mapMeta?.groundLevel ?? 20;
  while (y > 0 && !game.solidAt(ix, y, iz) && !game.fluidAt?.(ix, y, iz)) y--;
  return y + 1;
}

/** A support's aim point: the middle of its top block row (a pier or foot stands mostly below its bank's edge). */
const boxCentre = b => ({ x: (b.x0 + b.x1 + 1) / 2, y: b.y1 + 0.5, z: (b.z0 + b.z1 + 1) / 2 });

/** The support a side aims at (the one nearest `from`, flat) as its aim point. */
function aimSupport(structure, from) {
  let best = null;
  for (const b of structure.supports ?? []) {
    const c = boxCentre(b);
    if (!best || flat(c, from) < flat(best, from)) best = { ...c, support: b.id ?? null };
  }
  return best;
}

/**
 * The structure tasks of `ts.team` (part of planMapEventTasks; kept on
 * `ts.structureTasks`, the values on `ts.structureValues`): per standing
 * structure with a road crossing, `demolish` when closing it is worth more
 * than minValue, else a `hold` on each bridgehead when it is worth less than
 * -minValue.
 */
export function planStructureTasks(commander, ts, now, rules = DEMOLISH_RULES) {
  const game = commander.game, team = ts.team;
  const tasks = [];
  ts.structureValues = new Map();
  const base = game.mapMeta?.conquest?.bases?.[team];
  for (const s of structureViews(game)) {
    if (!s?.standing || !s.crossing || !base) continue;
    const value = crossingDenialValue(game, team, { close: s.crossing }, rules);
    ts.structureValues.set(s.id, value);
    if (value > rules.minValue) {
      const aim = aimSupport(s, base);
      if (!aim) continue;
      const d = Math.max(1, flat(base, aim)), k = Math.min(rules.standoff, d) / d;
      const x = aim.x + (base.x - aim.x) * k, z = aim.z + (base.z - aim.z) * k;
      const point = { x: aim.x, y: aim.y, z: aim.z };
      tasks.push({ id: `demolish:${s.id}`, kind: 'demolish', structure: s.id, value,
        point: { x, y: groundAt(game, x, z), z }, radius: 8, squad: rules.infantry, priority: rules.priority,
        launchers: rules.shoot.projectiles, aim: point, support: aim.support, hulls: rules.hulls,
        shoot: { kind: 'shoot', point, minRange: rules.shoot.minRange, range: rules.shoot.range,
          hitWithin: rules.shoot.hitWithin, projectiles: rules.shoot.projectiles } });
    } else if (value < -rules.minValue) {
      (s.heads ?? []).forEach((head, i) => tasks.push({ id: `hold:${s.id}:${i}`, kind: 'hold', structure: s.id, value,
        point: { x: head.x, y: head.y, z: head.z }, radius: rules.hold.radius, squad: rules.hold.squad, priority: rules.hold.priority }));
    }
  }
  ts.structureTasks = tasks;
  return tasks;
}

/**
 * Book one hull or aircraft crew per demolish task (`ts.eventHulls`: hull
 * id -> task id): the team's bot-crewed hulls whose type has a structure
 * weapon within TASK_RANGE of the aimed support (an aircraft also counts
 * from the team's focus flag, the area it works over), by the hullFire
 * preference, then nearest. A booked hull keeps its task while it stays
 * eligible.
 */
export function bookStructureHulls(commander, ts, tasks, rules = DEMOLISH_RULES) {
  const prior = ts.eventHulls ?? new Map();
  ts.eventHulls = new Map();
  const demolish = tasks.filter(t => t.kind === 'demolish' && t.hulls > 0);
  if (!demolish.length) return;
  const game = commander.game;
  const crewed = new Set();
  for (const crew of ts.crews?.values?.() ?? []) crewed.add(String(crew.vehicleId));
  const focus = commander.focusFlag?.(ts) ?? null;
  const reach = (v, task) => {
    const d = flat(v, task.aim);
    return (v.type === 'plane' || v.type === 'helicopter') && focus ? Math.min(d, flat(focus, task.aim)) : d;
  };
  const hulls = [...(game.vehicles?.vehicles?.values?.() ?? [])]
    .filter(v => v.hp > 0 && v.team === ts.team && rules.hullFire[v.type] && crewed.has(String(v.id)));
  for (const task of demolish) {
    const fits = hulls.filter(v => !ts.eventHulls.has(v.id) && reach(v, task) <= TASK_RANGE);
    const kept = fits.filter(v => prior.get(v.id) === task.id);
    const order = Object.keys(rules.hullFire), rank = v => order.indexOf(v.type) * 1000 + reach(v, task);
    const pick = [...kept, ...fits.filter(v => !kept.includes(v)).sort((a, b) => rank(a) - rank(b))].slice(0, task.hulls);
    for (const v of pick) ts.eventHulls.set(v.id, task.id);
  }
}

/** The demolish order of a hull its commander booked: {task, point, rules}, or null. */
export function structureFireOrder(commander, v) {
  if (!commander || !v) return null;
  for (const ts of commander.teams?.values?.() ?? []) {
    const taskId = ts.eventHulls?.get(v.id);
    const task = taskId ? ts.eventTasks?.get(taskId) : null;
    if (task?.aim) return { task, point: task.aim, rules: DEMOLISH_RULES.hullFire[v.type] ?? null };
  }
  return null;
}

/**
 * True when a round fired from `origin` along `dir` at `speed` (with
 * `gravity` drop) meets its first voxel within `within` m of `point`: the
 * line to the support is clear, a near miss on the structure counts.
 */
export function arcReaches(game, origin, dir, speed, gravity, point, within) {
  const at = t => [origin[0] + dir[0] * speed * t, origin[1] + dir[1] * speed * t - gravity * t * t / 2, origin[2] + dir[2] * speed * t];
  const total = Math.hypot(point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]);
  const seconds = speed > 0 ? total / speed * 1.25 + 0.2 : 0;
  const step = Math.max(0.01, 6 / Math.max(1, speed));
  let from = origin;
  for (let t = step; t <= seconds + 1e-9; t += step) {
    const to = at(t), d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], len = Math.hypot(d[0], d[1], d[2]);
    const hit = raycastVoxels(game.solidAt, from[0], from[1], from[2], d[0], d[1], d[2], len);
    if (hit) {
      const q = [from[0] + d[0] / len * hit.t, from[1] + d[1] / len * hit.t, from[2] + d[2] / len * hit.t];
      return Math.hypot(q[0] - point[0], q[1] - point[1], q[2] - point[2]) <= within;
    }
    if (Math.hypot(to[0] - point[0], to[1] - point[1], to[2] - point[2]) <= within) return true;
    from = to;
  }
  return false;
}

/**
 * A booked hull's weapon seat with no threat in sight fires on the
 * structure (BotManager, after applyMountedCombat found nothing): the
 * seat's structure weapon with the most supportDamage, aimed with its drop
 * at the support and fired once the authoritative mount sits on the aim and
 * the arc reaches the support. Returns true while engaged.
 */
export function hullStructureFire(game, br, p, v, seatId, order, now, inp, rules = DEMOLISH_RULES) {
  const fire = order?.rules;
  if (!fire || v.type === 'plane' || typeof game.vehicles?.mountPose !== 'function') return false;
  let pick = null;
  seatWeapons(game, v, seatId).forEach((w, index) => {
    if (!fire.weapons.includes(w.weapon)) return;
    const value = IRON_BRIDGE_RULES.supportDamage[w.weapon] ?? 0;
    if (!pick || value > pick.value) pick = { ...w, index, value };
  });
  if (!pick) return false;
  const pose = game.vehicles.mountPose(v, seatId, pick.mount);
  if (!pose?.origin || !pose.dir) return false;
  const point = [order.point.x, order.point.y, order.point.z];
  const distance = Math.hypot(point[0] - pose.origin[0], point[1] - pose.origin[1], point[2] - pose.origin[2]);
  if (distance < fire.min || distance > fire.max) return false;
  const meta = vehicleWeaponMeta(pick.weapon) ?? {};
  // A sight-guided missile flies down the sight line: aim straight at the support.
  const beam = !!VEHICLE_WEAPONS[pick.weapon]?.beam;
  const speed = meta.speed > 0 ? meta.speed : 2000, gravity = beam ? 0 : meta.gravity ?? 0;
  const aim = ballisticAim(pose.origin, point, { vx: 0, vy: 0, vz: 0 }, { speed, gravity, maxSeconds: 6, leadSkill: 0 });
  const selected = Number.isInteger(v.sel?.[seatId]) ? v.sel[seatId] : 0;
  if (selected !== pick.index && !inp.vehicleAction && now >= (br.structureSelAt ?? 0)) {
    inp.vehicleAction = { type: 'weapon', index: pick.index };
    br.structureSelAt = now + rules.selectMs;
  }
  inp.yaw = aim.yaw; inp.pitch = Math.max(-1.4, Math.min(1.4, aim.pitch));
  inp.wantFire = false;
  if (selected !== pick.index) return true;
  const want = [-Math.sin(aim.yaw) * Math.cos(aim.pitch), Math.sin(aim.pitch), -Math.cos(aim.yaw) * Math.cos(aim.pitch)];
  const dir = pose.dir, error = Math.acos(Math.max(-1, Math.min(1, dir[0] * want[0] + dir[1] * want[1] + dir[2] * want[2])));
  const tolerance = Math.max(rules.aimTolerance, Math.min(0.05, 1.2 / Math.max(1, distance)));
  if (error < tolerance && arcReaches(game, pose.origin, dir, speed, gravity, point, rules.shoot.hitWithin + 1)) inp.wantFire = true;
  return true;
}

/**
 * A booked jet's bomb release: true once a bomb dropped now (the airframe's
 * velocity plus the pylon's kick, then free fall) lands within `within` m
 * of the support. Pure prediction (bot-aircraft.js releases on it).
 */
export function bombLandsOn(v, point, within = DEMOLISH_RULES.hullFire.plane.bombWithin, gravity = 9.8) {
  const eject = VEHICLE_WEAPONS.jetBomb?.eject ?? 0;
  const vy = (v.vy || 0) - eject, h = v.y - point.y;
  if (!(h > 0)) return false;
  const t = (vy + Math.sqrt(vy * vy + 2 * gravity * h)) / gravity;
  return Math.hypot(v.x + (v.vx || 0) * t - point.x, v.z + (v.vz || 0) * t - point.z) <= within;
}
