/**
 * Pure Conquest rules shared by the authoritative server, its tests and the
 * client presentation: the flag control scalar, capture presence, deploy
 * options and the decoder that merges the slim per-tick `match.conquest` with
 * the static `mapMeta.conquest` sent once with the map.
 */
import {
  CONQUEST_RULES,
  CONQUEST_TEAMS,
  FLAG_STATES,
  VEHICLE_STATUS,
  VEHICLE_TOPOLOGY,
} from './conquest-contract.js';

export { CONQUEST_TEAMS };

const TEAM_SET = new Set(CONQUEST_TEAMS);
const STATE_SET = new Set(FLAG_STATES);
const EPSILON = 1e-9;
const DEFAULT_FLAG_RADIUS = 20;

/** Hull types whose crew only counts for capture once the hull is grounded. */
export const AIRCRAFT_TYPES = Object.freeze(['helicopter', 'transport', 'plane']);
const AIRCRAFT_SET = new Set(AIRCRAFT_TYPES);
export const isConquestAircraft = type => AIRCRAFT_SET.has(type);

/** Flag states that close a flag as a deploy target for its owner. */
export const FLAG_DEPLOY_BLOCKING_STATES = Object.freeze(['neutralizing', 'contested']);
const DEPLOY_BLOCKING = new Set(FLAG_DEPLOY_BLOCKING_STATES);

/** Strict deploy spawn grammar shared by the frame parser and the policy. */
export const SPAWN_CHOICE_PATTERN = /^(hq|flag:[A-E]|squad:[\w-]{1,64}|vehicle:[\w-]{1,64}(:[\w-]{1,32})?)$/;

export const isConquestTeam = team => TEAM_SET.has(team);
export function oppositeTeam(team) { return team === 'alpha' ? 'bravo' : 'alpha'; }
/** +1 for alpha, -1 for bravo, 0 for anything else (control is positive for alpha). */
export const teamSign = team => (team === 'alpha' ? 1 : team === 'bravo' ? -1 : 0);

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : 0));
/** Wire precision of positions (snapshot rows are rounded to 2 dp). */
const coord = value => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

/** Rate multiplier of a strict majority of `net` bodies: min(1 + 0.5(net-1), maxRateMult). */
export function captureRateMultiplier(net, rules = CONQUEST_RULES) {
  const n = Math.trunc(net);
  if (!(n > 0)) return 0;
  return Math.min(1 + 0.5 * (n - 1), rules.maxRateMult);
}

/**
 * Bodies that may hold a zone this tick, built once per tick and reused for
 * every flag. Counted: alive, non-NPC players on a team, on foot or seated in
 * any ground hull, or in an aircraft that is grounded. Excluded: down players
 * (they are dead bodies), and the crew of airborne aircraft.
 */
export function buildCapturePresence(entities, { teamFor, vehicleFor = () => null, isDown = () => false } = {}) {
  const presence = [];
  if (!entities || typeof teamFor !== 'function') return presence;
  for (const p of entities) {
    if (!p || p.state !== 'alive' || p.npcRole || isDown(p)) continue;
    const team = teamFor(p);
    if (!TEAM_SET.has(team) || ![p.x, p.y, p.z].every(Number.isFinite)) continue;
    if (p.vehicleId) {
      const vehicle = vehicleFor(p.vehicleId);
      if (vehicle && AIRCRAFT_SET.has(vehicle.type) && vehicle.grounded !== true) continue;
    }
    presence.push({ id: String(p.id), team, x: p.x, y: p.y, z: p.z });
  }
  return presence;
}

/** Per-team counts and ids of the presence list inside one flag zone. */
export function flagPresence(flag, presence, rules = CONQUEST_RULES) {
  const result = { alpha: 0, bravo: 0, ids: { alpha: [], bravo: [] } };
  if (!flag || !Array.isArray(presence)) return result;
  const radius = Number.isFinite(flag.radius) && flag.radius > 0 ? flag.radius : DEFAULT_FLAG_RADIUS;
  const dyLimit = Number.isFinite(rules?.presenceDy) ? rules.presenceDy : CONQUEST_RULES.presenceDy;
  for (const body of presence) {
    if (Math.abs(body.y - flag.y) > dyLimit) continue;
    if (Math.hypot(body.x - flag.x, body.z - flag.z) > radius) continue;
    result[body.team]++;
    result.ids[body.team].push(body.id);
  }
  return result;
}

/** Count API for callers that probe a few bodies against one zone. */
export function capturePresence(flag, entities, teamFor, radius = flag?.radius, { vehicleFor, presenceDy } = {}) {
  const zone = { ...flag, radius: Number.isFinite(radius) ? radius : flag?.radius };
  const counts = flagPresence(zone, buildCapturePresence(entities, { teamFor, vehicleFor }),
    { presenceDy: Number.isFinite(presenceDy) ? presenceDy : CONQUEST_RULES.presenceDy });
  return { alpha: counts.alpha, bravo: counts.bravo };
}

/**
 * Advance one flag's control scalar by `dtMs` and update its state machine.
 *
 * `flag` is mutated: `control` in [-1, 1] (positive = alpha), `owner`
 * ('alpha'|'bravo'|null), `state` (FLAG_STATES) and `mover` (the side moving
 * control, or null). A strict majority of `net` bodies moves control toward
 * its side at captureRateMultiplier(net) / captureHalfMs per ms; equal
 * non-zero counts freeze it (`contested`); an empty zone decays toward the
 * owner's side, or toward 0 while unowned, at decayPerSec. Crossing 0 against
 * the owner neutralizes the flag; reaching +-1 while unowned captures it.
 *
 * Returns the transitions in order: `{kind:'neutralized', team, prev}`,
 * `{kind:'captured', team}` and, when the (state, mover) pair changed,
 * `{kind:'state', state, team}`.
 */
export function advanceControl(flag, presence, dtMs, rules = CONQUEST_RULES) {
  const events = [];
  const a = Math.max(0, Math.trunc(presence?.alpha) || 0);
  const b = Math.max(0, Math.trunc(presence?.bravo) || 0);
  const dt = Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
  let control = clamp(flag.control, -1, 1);
  let owner = TEAM_SET.has(flag.owner) ? flag.owner : null;
  const prevState = STATE_SET.has(flag.state) ? flag.state : 'idle';
  const prevMover = TEAM_SET.has(flag.mover) ? flag.mover : null;
  let state;
  let mover = null;

  if (a > 0 && a === b) {
    state = 'contested';
  } else if (a !== b) {
    const team = a > b ? 'alpha' : 'bravo';
    const sign = teamSign(team);
    if (owner === team && control * sign >= 1 - EPSILON) {
      control = sign;
      state = 'idle';
    } else {
      mover = team;
      let next = control + sign * (captureRateMultiplier(Math.abs(a - b), rules) / rules.captureHalfMs) * dt;
      if (owner && owner !== team && next * teamSign(owner) <= EPSILON) {
        events.push({ kind: 'neutralized', team, prev: owner });
        owner = null;
        if (Math.abs(next) <= EPSILON) next = 0;
      }
      if (!owner && next * sign >= 1 - EPSILON) {
        next = sign;
        owner = team;
        events.push({ kind: 'captured', team });
      }
      control = clamp(next, -1, 1);
      if (owner === team && control * sign >= 1 - EPSILON) { control = sign; state = 'idle'; mover = null; }
      else state = owner === team ? 'restoring' : owner ? 'neutralizing' : 'capturing';
    }
  } else {
    const target = owner ? teamSign(owner) : 0;
    const step = (rules.decayPerSec / 1000) * dt;
    if (Math.abs(control - target) <= Math.max(step, EPSILON)) {
      control = target;
      state = 'idle';
    } else {
      control += control < target ? step : -step;
      state = 'restoring';
      mover = owner;
    }
  }

  flag.control = control;
  flag.owner = owner;
  flag.state = state;
  flag.mover = mover;
  if (state !== prevState || mover !== prevMover) events.push({ kind: 'state', state, team: mover });
  return events;
}

/** The side whose presence a flag tuple publishes as `def`. */
export function flagDefendingTeam(owner, control) {
  if (TEAM_SET.has(owner)) return owner;
  return control < 0 ? 'bravo' : 'alpha';
}

/** Wire tuple `[id, control100, owner, state, atk, def]` of one rich flag. */
export function encodeConquestFlag(flag) {
  // The side is picked from the rounded wire control, exactly as the decoder
  // sees it: a lean in (-0.005, 0) rounds to -0, which JSON sends as 0, and a
  // raw-control pick would publish bravo-relative counts the client reads as
  // alpha-relative (swapping the zone counts).
  const control100 = Math.round(clamp(flag.control, -1, 1) * 100) || 0;
  const owner = TEAM_SET.has(flag.owner) ? flag.owner : null;
  const defTeam = flagDefendingTeam(owner, control100);
  const counts = { alpha: flag.alpha | 0, bravo: flag.bravo | 0 };
  return [String(flag.id), control100, owner, STATE_SET.has(flag.state) ? flag.state : 'idle',
    counts[oppositeTeam(defTeam)], counts[defTeam]];
}

/**
 * Rich view of the slim snapshot: statics come from `mapMeta.conquest` and are
 * merged by flag id. `alpha`/`bravo` are the zone presence counts recovered
 * from atk/def; `atk` counts the side that does not own the flag (while
 * unowned, the side opposite the one control leans toward).
 */
export function decodeConquestMatch(matchConquest, metaConquest = null) {
  const match = matchConquest && typeof matchConquest === 'object' ? matchConquest : {};
  const statics = new Map((Array.isArray(metaConquest?.flags) ? metaConquest.flags : [])
    .filter(f => f && typeof f.id === 'string').map(f => [f.id, f]));
  const rows = Array.isArray(match.flags) ? match.flags : [];
  const flags = rows.filter(Array.isArray).map(([id, control100, owner, state, atk, def]) => {
    const meta = statics.get(id) || {};
    const control = clamp((Number(control100) || 0) / 100, -1, 1);
    const ownerTeam = TEAM_SET.has(owner) ? owner : null;
    const defTeam = flagDefendingTeam(ownerTeam, control);
    const counts = { [defTeam]: Math.max(0, def | 0), [oppositeTeam(defTeam)]: Math.max(0, atk | 0) };
    return {
      id: String(id), name: meta.name ?? String(id), site: meta.site ?? null,
      x: Number.isFinite(meta.x) ? meta.x : null, y: Number.isFinite(meta.y) ? meta.y : null,
      z: Number.isFinite(meta.z) ? meta.z : null,
      radius: Number.isFinite(meta.radius) ? meta.radius : DEFAULT_FLAG_RADIUS,
      home: TEAM_SET.has(meta.home) ? meta.home : null,
      spawns: Array.isArray(meta.spawns) ? meta.spawns : [],
      control, owner: ownerTeam, state: STATE_SET.has(state) ? state : 'idle',
      atk: Math.max(0, atk | 0), def: Math.max(0, def | 0), alpha: counts.alpha, bravo: counts.bravo,
    };
  });
  const tickets = { alpha: Math.max(0, match.tickets?.alpha | 0), bravo: Math.max(0, match.tickets?.bravo | 0) };
  return {
    version: match.v | 0,
    tickets,
    maxTickets: Number.isFinite(match.maxTickets) ? match.maxTickets : CONQUEST_RULES.tickets,
    bleed: { alpha: Math.max(0, match.bleed?.alpha | 0), bravo: Math.max(0, match.bleed?.bravo | 0) },
    endsAt: Number.isFinite(match.endsAt) ? match.endsAt : null,
    flags,
    squads: (Array.isArray(match.squads) ? match.squads : []).filter(Array.isArray)
      .map(([team, squadId, leaderId]) => ({ team, squadId: squadId | 0, leaderId: leaderId == null ? null : String(leaderId) })),
    bases: metaConquest?.bases ?? {},
    combatArea: metaConquest?.combatArea ?? null,
    ticketGraph: Array.isArray(match.ticketGraph) ? match.ticketGraph : null,
  };
}

/** `{kind, id?, seatId?}` of a deploy spawn string, or null. */
export function parseSpawnChoice(spawn) {
  if (typeof spawn !== 'string' || !SPAWN_CHOICE_PATTERN.test(spawn)) return null;
  if (spawn === 'hq') return { kind: 'hq' };
  const [kind, id, seatId] = spawn.split(':');
  if (kind === 'vehicle') return seatId ? { kind, id, seatId } : { kind, id };
  return { kind, id };
}

/**
 * Seat ids of a hull type in topology (F-key) order. Snapshot rows list only
 * occupied seats, so the contract topology is the source of truth; a type
 * outside the topology falls back to the row's own seat keys.
 */
export function vehicleSeatIds(row) {
  const topology = (VEHICLE_TOPOLOGY[row?.type] || []).map(seat => seat.id);
  const keys = row?.seatOccupants && typeof row.seatOccupants === 'object' ? Object.keys(row.seatOccupants) : [];
  for (const id of keys) if (!topology.includes(id)) topology.push(id);
  return topology;
}

/** Occupant of one seat; rows without that seat key fall back to `occupantId` for the driver. */
function seatOccupant(row, seatId) {
  const occupants = row?.seatOccupants && typeof row.seatOccupants === 'object' ? row.seatOccupants : null;
  if (occupants && Object.hasOwn(occupants, seatId)) return occupants[seatId] ?? null;
  return seatId === 'driver' ? row?.occupantId ?? null : null;
}

/** Free seat ids of a hull row, in topology order. */
export function vehicleFreeSeats(row) {
  return vehicleSeatIds(row).filter(id => seatOccupant(row, id) == null);
}

/** Server bot ids are `bot-<n>` (humans are `p<n>_…`); clients read bot seats from that. */
export const isBotId = id => typeof id === 'string' && /^bot-\d+$/.test(id);

/** Seat ids held by one of `botIds` (a Set of ids), in topology order: a human may take them. */
export function vehicleBotSeats(row, botIds) {
  if (!botIds?.size) return [];
  return vehicleSeatIds(row).filter(id => { const occupant = seatOccupant(row, id); return occupant != null && botIds.has(String(occupant)); });
}

const vehicleDisabled = row => row?.disabled === true || ((row?.st | 0) & VEHICLE_STATUS.disabled) !== 0
  || ((row?.st | 0) & VEHICLE_STATUS.wreck) !== 0;
const insideZone = (flag, p, rules) => Number.isFinite(flag?.x) && Number.isFinite(p?.x)
  && Math.hypot(p.x - flag.x, p.z - flag.z) <= (Number.isFinite(flag.radius) ? flag.radius : DEFAULT_FLAG_RADIUS)
  && (!Number.isFinite(flag.y) || !Number.isFinite(p.y) || Math.abs(p.y - flag.y) <= rules.presenceDy);

/**
 * Every deploy option of `self` from data both the server and the client own:
 *
 * view = { flags: [{id, x, y, z, radius, owner, state, alpha, bravo}],
 *          players: [{id, team, state, x, y, z, vehicleId, squad, bot?}],
 *          vehicles: [{id, type, team, hp, seatOccupants, st?, disabled?}] }
 * self = { id, team, squad, bot? }
 *
 * Returns `[{spawn, kind, id, ok, reason, x, z, seats?, takeover?}]`. `reason`
 * is a deploy_refused reason or null. A vehicle lists its free `seats` and,
 * for a human, the `takeover` seats a friendly bot holds: deploying there puts
 * the bot out. The server adds checks the client cannot see (squad damage lock
 * and cooldown, a flag cell clear of enemy sight).
 */
export function deployOptions(view, self, rules = CONQUEST_RULES) {
  const team = self?.team;
  if (!TEAM_SET.has(team)) return [];
  const selfId = self?.id == null ? null : String(self.id);
  const options = [{ spawn: 'hq', kind: 'hq', id: team, ok: true, reason: null, x: null, z: null }];
  const flags = Array.isArray(view?.flags) ? view.flags : [];
  for (const flag of flags) {
    if (flag?.owner !== team) continue;
    const enemies = flag[oppositeTeam(team)] | 0;
    const reason = DEPLOY_BLOCKING.has(flag.state) ? 'contested' : enemies > 0 ? 'enemy' : null;
    options.push({ spawn: `flag:${flag.id}`, kind: 'flag', id: String(flag.id), ok: !reason, reason,
      x: coord(flag.x), z: coord(flag.z) });
  }
  const vehicles = new Map((Array.isArray(view?.vehicles) ? view.vehicles : []).map(v => [String(v.id), v]));
  // Humans take seats from friendly bots (never the reverse, never from a human).
  const bots = self?.bot ? null : new Set((Array.isArray(view?.players) ? view.players : [])
    .filter(p => p && p.bot === true && p.team === team && p.state === 'alive').map(p => String(p.id)));
  const squad = self?.squad | 0;
  if (squad > 0) {
    for (const mate of Array.isArray(view?.players) ? view.players : []) {
      if (!mate || String(mate.id) === selfId || mate.team !== team || (mate.squad | 0) !== squad) continue;
      if (mate.state !== 'alive') continue;
      const hull = mate.vehicleId == null ? null : vehicles.get(String(mate.vehicleId));
      const threatened = flags.some(f => f && f.owner === team && f.state === 'neutralizing' && insideZone(f, mate, rules));
      // A mate in an aircraft: spawn into a seat of that aircraft (a free one,
      // else one a bot holds), BF style; with none left the mate is 'busy'.
      const aircraft = hull && AIRCRAFT_SET.has(hull.type);
      const seatId = aircraft && hull.team === team && hull.hp > 0 && !vehicleDisabled(hull)
        ? vehicleFreeSeats(hull)[0] ?? vehicleBotSeats(hull, bots)[0] ?? null : null;
      const reason = aircraft && !seatId ? 'busy' : threatened ? 'contested' : null;
      options.push({ spawn: `squad:${mate.id}`, kind: 'squad', id: String(mate.id), ok: !reason, reason,
        x: coord(mate.x), z: coord(mate.z), ...(seatId ? { vehicleId: String(hull.id), type: hull.type, seatId } : {}) });
    }
  }
  for (const hull of vehicles.values()) {
    if (hull.team !== team || !(hull.hp > 0) || ((hull.st | 0) & VEHICLE_STATUS.wreck)) continue;
    const seats = vehicleFreeSeats(hull);
    const takeover = vehicleBotSeats(hull, bots);
    const reason = vehicleDisabled(hull) ? 'busy' : seats.length || takeover.length ? null : 'seat';
    options.push({ spawn: `vehicle:${hull.id}`, kind: 'vehicle', id: String(hull.id), ok: !reason, reason,
      x: coord(hull.x), z: coord(hull.z), type: hull.type, seats, ...(takeover.length ? { takeover } : {}) });
  }
  return options;
}

/**
 * The option a spawn string selects, with seat resolution for vehicles:
 * `{ok, reason, option, seatId}`. A named seat must be free ('seat').
 */
export function resolveDeployChoice(options, spawn) {
  const choice = parseSpawnChoice(spawn);
  if (!choice) return { ok: false, reason: 'invalid', option: null, seatId: null };
  const key = choice.kind === 'hq' ? 'hq' : `${choice.kind}:${choice.id}`;
  const option = (options || []).find(o => o.spawn === key) || null;
  if (!option) return { ok: false, reason: 'invalid', option: null, seatId: null };
  if (!option.ok) return { ok: false, reason: option.reason || 'invalid', option, seatId: null };
  // A squad mate in an aircraft resolves to a seat of that aircraft.
  if (choice.kind !== 'vehicle') return { ok: true, reason: null, option, seatId: choice.kind === 'squad' ? option.seatId ?? null : null };
  // No named seat: a free one first, else the first seat a bot holds.
  const seatId = choice.seatId ?? option.seats?.[0] ?? option.takeover?.[0] ?? null;
  if (!seatId || !(option.seats?.includes(seatId) || option.takeover?.includes(seatId))) return { ok: false, reason: 'seat', option, seatId: null };
  return { ok: true, reason: null, option, seatId, ...(option.takeover?.includes(seatId) ? { takeover: true } : {}) };
}

/** Client-side view for deployOptions from a decoded match and snapshot rows. */
export function deployViewFromSnapshot(decodedMatch, players = [], vehicles = [], decodePlayer = null) {
  return {
    flags: (decodedMatch?.flags || []).map(f => ({ id: f.id, x: f.x, y: f.y, z: f.z, radius: f.radius,
      owner: f.owner, state: f.state, alpha: f.alpha, bravo: f.bravo })),
    players: (players || []).map(p => ({ id: String(p.id), team: p.team, state: p.state, x: p.x, y: p.y, z: p.z,
      vehicleId: p.vehicleId ?? null, squad: (decodePlayer ? decodePlayer(p)?.squad : p.squad) | 0,
      bot: p.bot === true || isBotId(String(p.id)) })),
    vehicles: (vehicles || []).map(v => ({ id: v.id, type: v.type, team: v.team, hp: v.hp, x: v.x, z: v.z,
      seatOccupants: v.seatOccupants, occupantId: v.occupantId, st: v.st, disabled: v.disabled })),
  };
}
