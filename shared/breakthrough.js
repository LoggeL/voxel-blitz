/**
 * Pure Breakthrough rules (docs/conquest.md, Breakthrough) shared by the
 * authoritative policy (server/modes/conquest/breakthrough.js), the bot
 * commander and the client HUD: the sector table and its wire form, the role
 * of every flag (captured, active, locked), the front lines on the HQ-to-HQ
 * axis that bound both sides, the spawn flags each side may use and the hull
 * list per side. Tuning lives in BREAKTHROUGH_RULES (shared/conquest-contract.js).
 */
import { BREAKTHROUGH_RULES, CONQUEST_TEAMS } from './conquest-contract.js';

const TEAM_SET = new Set(CONQUEST_TEAMS);
const other = team => (team === 'alpha' ? 'bravo' : 'alpha');
const finitePoint = p => Number.isFinite(p?.x) && Number.isFinite(p?.z);

/** Roles a flag plays in Breakthrough: taken by the attackers, in play, or not yet reachable. */
export const SECTOR_ROLES = Object.freeze(['captured', 'active', 'locked']);

/** Ordered sectors of a map (arrays of flag ids from the attackers' side), or null without a table. */
export function breakthroughSectors(mapId, rules = BREAKTHROUGH_RULES) {
  const table = rules?.sectors?.[mapId];
  return Array.isArray(table) && table.length ? table.map(sector => sector.slice()) : null;
}

/**
 * Wire form of the Breakthrough state, `match.conquest.bt` (a tuple, ~30 B):
 * `[attackers, active sector index (= sectors.length once broken through),
 *   'AB.C.DE' (flag ids per sector, '.' between sectors), grace end (engine ms) or 0, overtime 0|1]`.
 */
export function encodeBreakthrough({ attackers, sector, sectors, graceEndsAt = 0, overtime = false }) {
  return [attackers, sector | 0, sectors.map(s => s.join('')).join('.'),
    Number.isFinite(graceEndsAt) && graceEndsAt > 0 ? Math.round(graceEndsAt) : 0, overtime ? 1 : 0];
}

/** Rich view of `match.conquest.bt`, or null outside Breakthrough. */
export function decodeBreakthrough(raw) {
  if (!Array.isArray(raw)) return null;
  const [attackers, index, text, grace, overtime] = raw;
  if (!TEAM_SET.has(attackers) || typeof text !== 'string' || !text) return null;
  const sectors = text.split('.').map(ids => [...ids]);
  const sector = Math.max(0, Math.min(sectors.length, index | 0));
  return { attackers, defenders: other(attackers), sector, sectors, count: sectors.length,
    graceEndsAt: Number(grace) > 0 ? Number(grace) : null, overtime: overtime === 1, done: sector >= sectors.length };
}

/** Index of the sector holding `flagId`, or -1. */
export function sectorIndexOf(bt, flagId) {
  return (bt?.sectors ?? []).findIndex(sector => sector.includes(flagId));
}

/** 'captured' | 'active' | 'locked' for a flag, null for a flag outside every sector. */
export function sectorRole(bt, flagId) {
  const index = sectorIndexOf(bt, flagId);
  if (index < 0) return null;
  return index < bt.sector ? 'captured' : index === bt.sector ? 'active' : 'locked';
}

/** Flag ids of the active sector ([] once broken through). */
export const activeSectorFlags = bt => (bt && bt.sector < bt.sectors.length ? bt.sectors[bt.sector].slice() : []);

/** Unit axis from the attackers' HQ toward the defenders' HQ; `project(p)` is metres along it. */
export function breakthroughAxis(bases, attackers) {
  const from = bases?.[attackers], to = bases?.[other(attackers)];
  if (!finitePoint(from) || !finitePoint(to)) return null;
  const length = Math.hypot(to.x - from.x, to.z - from.z) || 1;
  const dx = (to.x - from.x) / length, dz = (to.z - from.z) / length;
  return { x: from.x, z: from.z, dx, dz, length, project: p => (p.x - from.x) * dx + (p.z - from.z) * dz };
}

/**
 * The front: lines square to the HQ axis between consecutive sectors, each
 * halfway between the nearer sector's farthest flag and the farther sector's
 * nearest one. `rear` (metres along the axis) is the line behind the active
 * sector: defenders behind it stand in lost ground. `lead` is the line ahead
 * of it plus `attackerLeadM`: attackers past it are out of bounds. Either is
 * null where there is no such line. `lines` lists every sector boundary.
 */
export function breakthroughFront(bt, flags, bases, rules = BREAKTHROUGH_RULES) {
  if (!bt) return null;
  const axis = breakthroughAxis(bases, bt.attackers);
  if (!axis) return null;
  const byId = new Map((flags ?? []).filter(f => finitePoint(f)).map(f => [f.id, f]));
  const spans = bt.sectors.map(ids => {
    const t = ids.map(id => byId.get(id)).filter(Boolean).map(axis.project);
    return t.length ? { min: Math.min(...t), max: Math.max(...t) } : null;
  });
  const lines = [];
  for (let i = 0; i + 1 < spans.length; i++) {
    lines.push(spans[i] && spans[i + 1] ? (spans[i].max + spans[i + 1].min) / 2 : null);
  }
  const rear = bt.sector > 0 ? lines[bt.sector - 1] ?? null : null;
  const ahead = bt.sector < lines.length ? lines[bt.sector] : null;
  const lead = Number.isFinite(ahead) ? ahead + (rules?.attackerLeadM ?? 0) : null;
  return { axis, lines, rear, lead };
}

/**
 * True when a body of `team` stands outside its side of the front: a defender
 * behind `rear`, an attacker past `lead`. The grace after a sector falls is
 * the caller's (the policy only enforces `rear` once it ran out).
 */
export function outsideFront(front, p, team, attackers, { rear = true } = {}) {
  if (!front || !finitePoint(p)) return false;
  const t = front.axis.project(p);
  if (team === attackers) return Number.isFinite(front.lead) && t > front.lead;
  return rear && Number.isFinite(front.rear) && t < front.rear;
}

/**
 * Flag ids whose spawn cells stand in for `team`'s HQ (the HQ moves with the
 * front), or null for the real HQ: the attackers' HQ is the sector they took
 * last, the defenders' the sector behind the active one. Round starts, the
 * deploy screen's HQ entry and the timeout fallback all use it.
 */
export function breakthroughHqFlags(bt, team) {
  if (!bt || bt.sector >= bt.sectors.length) return null;
  if (team === bt.attackers) return bt.sector > 0 ? bt.sectors[bt.sector - 1].slice() : null;
  return bt.sector + 1 < bt.sectors.length ? bt.sectors[bt.sector + 1].slice() : null;
}

/** Centre `{x, z}` of a team's moved HQ (breakthroughHqFlags) from flag rows, or null for the real HQ. */
export function breakthroughHqAnchor(bt, team, flags) {
  const ids = breakthroughHqFlags(bt, team);
  const rows = ids ? (flags ?? []).filter(f => ids.includes(f.id) && finitePoint(f)) : [];
  if (!rows.length) return null;
  return { x: rows.reduce((sum, f) => sum + f.x, 0) / rows.length, z: rows.reduce((sum, f) => sum + f.z, 0) / rows.length, flags: ids };
}

/**
 * Whether `team` may deploy on a flag it owns: the attackers on the active
 * sector and on the sector they took last (their forward base, `forward`),
 * the defenders on the active sector and every sector still locked behind it.
 */
export function breakthroughSpawnFlag(bt, flagId, team) {
  const index = sectorIndexOf(bt, flagId);
  if (index < 0) return { allowed: false, forward: false };
  if (team === bt.attackers) {
    const forward = index === bt.sector - 1;
    return { allowed: index === bt.sector || forward, forward };
  }
  return { allowed: index >= bt.sector, forward: false };
}

/**
 * The hull list of a Breakthrough match from the map's Conquest spawns: every
 * flag pad starts with the defenders (they hold every flag), the defenders'
 * HQ pads named in `retype` field another hull type, and the attackers' `add`
 * entries copy an HQ pad by a fixed offset (mirrored when bravo attacks).
 * Hull types marked 'kit' in `vehicles.types` (deployables) are dropped.
 */
export function breakthroughVehicleSpawns(spawns, rules = BREAKTHROUGH_RULES) {
  const attackers = TEAM_SET.has(rules?.attackers) ? rules.attackers : 'alpha', defenders = other(attackers);
  const retype = rules?.vehicles?.defender?.retype ?? {};
  const types = rules?.vehicles?.types ?? {};
  // A 'kit' hull (a deployable) is never a pad hull, whatever the map lists.
  const list = (Array.isArray(spawns) ? spawns : []).filter(s => types[s?.type] !== 'kit').map(s => {
    if (typeof s?.flag === 'string') return { ...s, team: defenders };
    const pad = typeof s?.id === 'string' && s.id.startsWith(`${defenders}-`) ? s.id.slice(defenders.length + 1) : null;
    return pad && retype[pad] ? { ...s, type: retype[pad] } : s;
  });
  const sign = attackers === 'alpha' ? 1 : -1;
  const shift = (p, dx, dz) => (finitePoint(p) ? { ...p, x: p.x + dx, z: p.z + dz } : p);
  for (const add of rules?.vehicles?.attacker?.add ?? []) {
    const source = list.find(s => s?.id === `${attackers}-${add.copy}`);
    const id = `${attackers}-${add.pad}`;
    if (!source || list.some(s => s?.id === id)) continue;
    const dx = sign * (add.dx ?? 0), dz = sign * (add.dz ?? 0);
    const copy = { ...shift(source, dx, dz), id, type: add.type ?? source.type };
    for (const key of ['walkingRoute', 'exitRoute']) {
      if (Array.isArray(source[key])) copy[key] = source[key].map(p => shift(p, dx, dz));
    }
    list.push(copy);
  }
  return list;
}

/** Points `{x, z}` of a map's boat lanes (`conquest.waterways` of kind 'boat-lane'). */
export function boatLanePoints(waterways) {
  return (Array.isArray(waterways) ? waterways : []).filter(w => w?.kind === 'boat-lane' && Array.isArray(w.points))
    .flatMap(w => w.points.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[2])).map(([x, , z]) => ({ x, z })));
}

/**
 * Ids of the pads held this sector: the 'lane' hull pads (vehicles.types) of a
 * side whose front keeps less than `vehicles.laneShare` of the boat lane
 * (`lanes`, boatLanePoints). Flag pads follow their flag instead; without a
 * front or a lane nothing is held.
 */
export function breakthroughHeldPads(spawns, { bt, front, lanes, rules = BREAKTHROUGH_RULES } = {}) {
  const held = new Set();
  const types = rules?.vehicles?.types ?? {};
  const share = Number.isFinite(rules?.vehicles?.laneShare) ? rules.vehicles.laneShare : 0;
  if (!bt || !front || !lanes?.length) return held;
  const open = {};
  for (const team of TEAM_SET) open[team] = lanes.filter(p => !outsideFront(front, p, team, bt.attackers, { rear: true })).length / lanes.length;
  for (const s of Array.isArray(spawns) ? spawns : []) {
    if (types[s?.type] !== 'lane' || typeof s.flag === 'string' || !TEAM_SET.has(s.team)) continue;
    // No lane in reach always holds; laneShare raises the bar.
    if (open[s.team] === 0 || open[s.team] < share) held.add(s.id);
  }
  return held;
}
