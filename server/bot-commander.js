// Conquest bot commander: one per team, replanning at 2 Hz, cached per tick.
//
// It reads the authoritative objective state (policy.conquestView(), with a
// fallback for the pre-v2 policy), orders the flags along the frontline from
// the team's HQ toward the enemy's, and gives every squad one order:
//  - attack the first non-owned flag along that line, via a staging point
//    50-70 m out at +-50 degrees off the approach, then a synchronised push;
//  - defend an owned flag that is contested, being taken or has an enemy
//    within 60 m (cover nodes facing the threat); while it is being
//    neutralized or contested, or in an all-in home defence, the defenders
//    surge into the capture zone.
// Squads split roughly 60/40 between attack and defence, biased by the ticket
// delta; a home flag being lost pulls every squad back. Kits are mixed per
// squad (BOT_SQUAD_SLOTS: assault, medic, engineer, flex), vehicles get a crew
// budget of ceil(teamBots / 3) in priority order (tank > attack helicopter >
// plane), and squads ride jeeps or the transport toward their staging point.
// A hull a human drives or pilots takes nearby bots aboard (planHitches):
// the driver's squad mates first, gunner seats first. A bot driver or pilot
// holds for a human teammate running to its hull (planWaits / holdFor).
//
// The commander is the bot director of spec 3.5: goalFor(player) and
// deployFor(player). Everything it reads is authoritative mode, entity and
// vehicle state plus what the team's own bots have seen or heard.

import { CONQUEST_TEAMS, KIT_IDS, KITS, VEHICLE_TOPOLOGY } from '../shared/conquest-contract.js';
import { KIT_ROLE_RULES, botSquadKit } from '../shared/conquest-kits.js';
import { VEHICLE_RULES, vehicleMaxHp } from '../shared/vehicles.js';
import { vehicleSeats, vehicleSeatOccupantId } from '../shared/vehicle-seats.js';
import { CoverIndex, bearing } from './bot-cover.js';
import { surfaceNavigation } from './bot-surface-nav.js';

export const COMMANDER_PLAN_MS = 500;
export const STAGE_MIN = 50, STAGE_MAX = 70;
export const STAGE_ANGLE = 50 * Math.PI / 180;
export const DEFEND_ALERT_RADIUS = 60;
export const ATTACK_SHARE = 0.6;
export const REVIVE_RANGE = 25, REPAIR_RANGE = 30, REPAIR_BELOW = 0.7;
/** A revive walk ends this close (flat m) to the body; the intent goes out inside reviveRange less the slack (3D). */
const REVIVE_ARRIVE = 0.8, REVIVE_REACH_SLACK = 0.15;
/**
 * A revive or repair walk that gets no closer (by 1 m) for SUPPORT_STALL_MS
 * while still out of reach is given up, and that target is left to others
 * for SUPPORT_BLOCK_MS (a hull knocked under a deck, a body behind a crater).
 */
const SUPPORT_STALL_MS = 8000, SUPPORT_BLOCK_MS = 30000;
export const TRANSIT_MAX_MS = 40000;
/** One persistent crew seat per this many team bots (capped by ceil(teamBots / 3)). */
export const CREW_SHARE = 4;
const MAX_TEAM_RIDES = 1;
const STALEMATE_FLANK_MS = 20000; // a contested frontline flag this long sends a squad to back-cap
const ATTACK_STALL_MS = 40000;    // an attack with no ownership progress this long also counts as stalled
const SQUAD_SPAWN_PENALTY = 45;   // m a squad spawn must beat the best flag spawn by
const CREW_WALK_MAX = 200;        // m a living bot walks to man a hull (HQ spawns to runway)
const MEDIC_CREW_PENALTY = 1000;   // crew score added for a Medic (picked last for a seat)
const RIDE_COOLDOWN_MS = 60000;
const TRANSIT_BOARD_MS = 25000;  // a ride whose driver has not boarded by then is called off
const STAGE_GATHER_RADIUS = 20;
const STAGE_HOLD_MS = 3000;
const STAGE_TIMEOUT_MS = 35000;
const DEFEND_HOLD_MS = 20000;
const KNOWLEDGE_MS = 8000;
/**
 * Rides with humans (planHitches): bots fill the free seats of a hull a human
 * drives or pilots, gunner seats first. Squad mates of the driver come from
 * HITCH_SQUAD_RADIUS and are limited only by seats; other teammates come from
 * HITCH_RADIUS and at most ceil(teamBots / HITCH_TEAM_SHARE) of them ride with
 * humans at a time.
 */
export const HITCH_RADIUS = 45;
export const HITCH_SQUAD_RADIUS = 60;
export const HITCH_TEAM_SHARE = 4;
export const HITCH_BOARD_SPEED = 3;     // m/s: bots only head for a hull that is stopped or crawling
export const HITCH_BOARD_MS = 20000;    // a booked rider that has not boarded by then gives up
export const HITCH_DROP_PAD = 12;       // m beyond a wanted flag's radius where a stop drops the riders
export const HITCH_IDLE_MS = 30000;     // riders leave a hull that has stood still this long away from any flag
export const HITCH_COOLDOWN_MS = 30000; // a dropped rider walks a while before it hitches again
const HITCH_STOPPED = 0.8;              // m/s: same as the riders' own "stopped" (bot-vehicle-driving)
// Bot drivers wait for a human teammate running to their hull (planWaits).
export const WAIT_RADIUS = 50;          // m: humans closer than this who close in are waited for
export const WAIT_MS = 8000;            // longest wait for a teammate
export const WAIT_SQUAD_MS = 12000;     // longest wait for a squad mate of the driver
export const WAIT_COOLDOWN_MS = 30000;  // a human the hull gave up on is not waited for again this long
export const WAIT_DEPART_MAX = 10;      // m: a ground hull that has gone farther since it set off does not stop
export const WAIT_CLOSING = 1.2;        // m/s toward the hull that counts as approaching
const WAIT_REACH = 8;                   // m: a human this close counts as boarding even while standing
const WAIT_STALL_MS = 1500;             // a human not closing in (outside reach) this long is given up on
const WAIT_AWAY = -1;                   // m/s: walking away this fast ends the wait at once
const WAIT_FACING = 0.6;                // rad: look direction that counts as heading for the hull
/** A Medic bot with nothing to revive keeps this close behind its squad leader (heal aura reach 6 m). */
const MEDIC_FOLLOW_DIST = 4;
/**
 * A Medic bot with no body to revive walks to a teammate under this HP share within this
 * range (m) ... (most hurt bots survive a fight with 60-90 % HP, which 0.75 skipped).
 */
export const HEAL_SEEK_BELOW = 0.9, HEAL_SEEK_RANGE = 45;
/** m: the seek range of a Medic standing in a flag being taken or fought over (hurtMate). */
export const HEAL_ZONE_RANGE = 12;
/** ... and stops this close (flat m), well inside the heal aura (KIT_ROLE_RULES.healRadius). */
const HEAL_ARRIVE = 3;
/**
 * Engineer gadget mix: the share of a team's engineers that deploy with the
 * STINGER (gadget 1) by the number of enemy aircraft in play (crewed or
 * airborne). No enemy aircraft means every engineer carries the AT launcher.
 */
const AA_ENGINEER_SHARE = Object.freeze([0, 0.4, 0.6]);
const AIR_THREAT_CACHE_MS = 1000;
const opposite = team => (team === 'alpha' ? 'bravo' : 'alpha');
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.z);
const isAircraftType = type => type === 'helicopter' || type === 'plane' || type === 'transport';
const disabledHull = v => ((v?.st | 0) & 2) !== 0 || v?.disabled === true;
/** Ground hulls by their drive speed; aircraft only on the ground, by their horizontal speed. */
const hullStopped = (v, limit) => (isAircraftType(v.type)
  ? v.grounded !== false && Math.hypot(v.vx || 0, v.vz || 0) < limit
  : Math.abs(v.speed || 0) < limit);

/** Maximum hull HP from the shared registry. */
export function hullMaxHp(v) {
  return vehicleMaxHp(v?.type) || v?.maxHp || VEHICLE_RULES.helicopter.hp;
}

/** The Conquest roles system (WP8) behind the policy, when present. */
export const conquestRoles = game => game?.mode?.policy?.roles ?? null;

/** Authoritative kit id of a player: roles first, then the deploy choice. */
export function kitOfPlayer(game, p) {
  if (!p) return null;
  const policy = game?.mode?.policy;
  let kit = conquestRoles(game)?.kitOf?.(p);
  if (kit == null) { const chosen = policy?.kitFor?.(p); kit = typeof chosen === 'object' ? chosen?.kit : chosen; }
  if (typeof kit === 'string' && KIT_IDS.includes(kit)) return kit;
  if (Number.isInteger(kit) && KIT_IDS[kit]) return KIT_IDS[kit];
  return null;
}

/** Revivable body of a downed player ({x,y,z,until,team}), or null. */
export function downBody(game, p) {
  const roles = conquestRoles(game);
  if (!p || !roles?.isDown?.(p)) return null;
  return roles.downedBodies?.().find(body => String(body.id) === String(p.id)) ?? null;
}

/** Whether the authoritative spotting system currently marks this player. */
export const playerSpotted = (game, p) => !!conquestRoles(game)?.spotting?.isSpotted?.(p);

/** Seat ids by role for a hull: topology under the mount model, else legacy seats. */
export function hullSeatIds(v) {
  const seats = vehicleSeats(v);
  const ids = seats.map(seat => seat.id);
  const driver = seats.find(seat => seat.drives)?.id ?? 'driver';
  const topology = VEHICLE_TOPOLOGY[v.type] ?? [];
  const gunner = topology.find(seat => seat.role === 'gunner' && seat.mounts.length && ids.includes(seat.id))?.id
    ?? seats.find(seat => !seat.drives && seat.weapons)?.id ?? null;
  return { driver, gunner, all: ids };
}

/**
 * Normalised objective view: policy.conquestView() when the v2 mode provides
 * it, else derived from the legacy flag records. Flags carry
 * {id, x, y, z, radius, owner, control, state, home}.
 */
export function readConquestView(game) {
  const policy = game.mode?.policy;
  const meta = game.mapMeta?.conquest ?? {};
  const statics = new Map((meta.flags ?? []).map(f => [f.id, f]));
  const bases = meta.bases ?? {};
  const axis = homeAxis(bases);
  const homeOf = f => f.home !== undefined ? f.home : axis ? (axis.t(f) < 0.4 ? 'alpha' : axis.t(f) > 0.6 ? 'bravo' : null) : null;
  if (typeof policy?.conquestView === 'function') {
    const view = policy.conquestView();
    const flags = (view?.flags ?? []).map(f => {
      const s = statics.get(f.id) ?? {};
      const x = f.x ?? s.x, y = f.y ?? s.y, z = f.z ?? s.z;
      return { id: f.id, x, y, z, radius: f.radius ?? s.radius ?? 20, owner: f.owner ?? null,
        control: Number.isFinite(f.control) ? f.control : 0, state: f.state ?? 'idle', home: f.home ?? homeOf({ ...s, x, z }) };
    });
    return { flags, tickets: view?.tickets ?? { alpha: 0, bravo: 0 }, maxTickets: view?.maxTickets ?? policy.rules?.tickets ?? 300,
      squads: view?.squads instanceof Map ? view.squads : null,
      deployOptions: typeof view?.deployOptions === 'function' ? p => view.deployOptions(p) : null, bases };
  }
  const flags = (policy?.flags ?? meta.flags ?? []).map(f => {
    const sign = t => (t === 'alpha' ? 1 : t === 'bravo' ? -1 : 0);
    let control = sign(f.owner);
    let state = 'idle';
    if (f.contested) state = 'contested';
    else if (f.capturing) {
      state = f.owner ? 'neutralizing' : 'capturing';
      control = f.owner ? sign(f.owner) * (1 - (f.progress ?? 0)) : sign(f.capturing) * (f.progress ?? 0);
    }
    return { id: f.id, x: f.x, y: f.y, z: f.z, radius: f.radius ?? policy?.rules?.captureRadius ?? 20,
      owner: f.owner ?? null, control, state, home: homeOf(f) };
  });
  return { flags, tickets: { ...(policy?.tickets ?? { alpha: 0, bravo: 0 }) }, maxTickets: policy?.rules?.tickets ?? 300,
    squads: null, deployOptions: null, bases };
}

/** Projection onto the HQ-to-HQ axis: t = 0 at the alpha HQ, 1 at bravo's. */
export function homeAxis(bases) {
  const a = bases?.alpha, b = bases?.bravo;
  if (!finitePoint(a) || !finitePoint(b)) return null;
  const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
  return { a, b, t: p => ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2 };
}

/** Flags in frontline order from `team`'s HQ, grouped into tiers that sit level on the axis. */
export function frontlineTiers(flags, bases, team) {
  const axis = homeAxis(bases);
  if (!axis) return flags.map(f => [f]);
  const ordered = flags.map(f => ({ f, t: axis.t(f) })).sort((p, q) => team === 'alpha' ? p.t - q.t : q.t - p.t);
  const tiers = [];
  for (const entry of ordered) {
    const last = tiers.at(-1);
    if (last && Math.abs(last.t - entry.t) < 0.1) last.flags.push(entry.f);
    else tiers.push({ t: entry.t, flags: [entry.f] });
  }
  return tiers.map(tier => tier.flags);
}

function stableHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class BotCommander {
  /**
   * @param {object} game GameEngine
   * @param {{brains: Array}} manager the BotManager (for brains and their memory)
   */
  constructor(game, manager) {
    this.game = game;
    this.manager = manager;
    this.cover = new CoverIndex(game);
    this.teams = new Map(CONQUEST_TEAMS.map(team => [team, { team, squads: new Map(), crews: new Map(), transits: new Map(),
      hitches: new Map(), hitchCooldown: new Map(), waitCooldown: new Map(), departFrom: new Map(), knowledge: [] }]));
    this.waits = new Map();          // vehicle id -> wait record (planWaits); read per tick by holdFor
    this.view = null;
    this.viewAt = -1;
    this.nextPlanAt = 0;
    this.goalCache = new Map();
    this.goalAt = -1;
    this.roleClaims = new Map();
    this.supportTries = new Map();   // bot id -> { name, best, at }: progress of its revive/repair walk
    this.supportBlocked = new Map(); // `${bot id}|${name}` -> until: targets that bot gave up on
    this.supportReach = new Map();   // `${bot id}|${name}` -> { at, ok }: reachability, re-checked each second
    this.presence = new Map();
  }

  teamOf(p) { return this.game.mode.teamFor?.(p) ?? p?.team ?? null; }

  readView(now = this.game.now) {
    if (this.viewAt !== now || !this.view) { this.view = readConquestView(this.game); this.viewAt = now; }
    return this.view;
  }

  /** Attach time: precompute the per-flag cover sets from the objective layout. */
  prepare() {
    const view = this.readView(this.game.now);
    if (view.flags.length) this.cover.ensure(view.flags);
  }

  /** Called once per bot tick. */
  update(now) {
    if (this.game.mode.mode !== 'conquest') return;
    const view = this.readView(now);
    if (!this.cover.sets.size && view.flags.length) this.cover.ensure(view.flags);
    this.cover.refresh(now);
    if (now >= this.nextPlanAt) { this.plan(now); this.nextPlanAt = now + COMMANDER_PLAN_MS; }
  }

  /** Alive, counted bodies per team inside each flag radius. */
  computePresence(view) {
    this.presence.clear();
    for (const flag of view.flags) this.presence.set(flag.id, { alpha: 0, bravo: 0 });
    for (const p of this.game.entities.values()) {
      if (p.state !== 'alive' || p.npcRole) continue;
      const team = this.teamOf(p);
      if (team !== 'alpha' && team !== 'bravo') continue;
      const hull = p.vehicleId ? this.game.vehicles?.vehicles.get(p.vehicleId) : null;
      if (hull && isAircraftType(hull.type) && hull.grounded === false) continue;
      for (const flag of view.flags) {
        if (Math.abs(p.y - flag.y) <= 8 && flat(p, flag) <= flag.radius) this.presence.get(flag.id)[team]++;
      }
    }
  }

  /** Enemy positions this team knows: its bots' sightings, hearing, damage sources and spotted marks. */
  gatherKnowledge(team, now) {
    const known = [];
    for (const br of this.manager.brains) {
      const p = this.game.entities.get(br.id);
      if (!p || this.teamOf(p) !== team) continue;
      if (br.enemyId && br.noticeProgress >= 1) {
        const target = String(br.enemyId).startsWith('vehicle:')
          ? this.game.vehicles?.vehicles.get(String(br.enemyId).slice(8)) : this.game.entities.get(br.enemyId);
        if (target) known.push({ x: target.x, y: target.y, z: target.z, at: now, id: String(br.enemyId) });
      }
      if (br.lastSeen?.position) known.push({ ...br.lastSeen.position, at: now, id: br.lastSeen.id != null ? String(br.lastSeen.id) : null });
      if (br.damageFrom && Number.isFinite(br.damageFrom.x) && now - br.damageFrom.at < KNOWLEDGE_MS) {
        known.push({ x: br.damageFrom.x, y: br.damageFrom.y, z: br.damageFrom.z, at: br.damageFrom.at, id: br.damageFrom.id != null ? String(br.damageFrom.id) : null });
      }
    }
    for (const o of this.game.entities.values()) {
      if (o.state !== 'alive' || this.teamOf(o) === team || !playerSpotted(this.game, o)) continue;
      known.push({ x: o.x, y: o.y, z: o.z, at: now, id: String(o.id) });
    }
    for (const v of this.game.vehicles?.vehicles.values() ?? []) {
      if (!(v.hp > 0) || !v.team || v.team === team) continue;
      if ((v.spotted?.[team] ?? 0) > now) known.push({ x: v.x, y: v.y, z: v.z, at: now, id: `vehicle:${v.id}` });
    }
    return known;
  }

  /** Squads of a team: the mode's squads when published, else groups of four in join order. */
  squadsOf(team, view) {
    const players = [...this.game.entities.values()].filter(p => this.teamOf(p) === team && !p.npcRole);
    const groups = new Map();
    if (view.squads) {
      for (const p of players) {
        const entry = view.squads.get(String(p.id));
        if (!entry) continue;
        if (!groups.has(entry.squadId)) groups.set(entry.squadId, { id: entry.squadId, members: [], leaderId: entry.leaderId });
        groups.get(entry.squadId).members.push(String(p.id));
      }
    }
    const grouped = new Set([...groups.values()].flatMap(g => g.members));
    const loose = players.filter(p => !grouped.has(String(p.id)));
    let next = groups.size ? Math.max(...groups.keys()) + 1 : 1;
    for (let i = 0; i < loose.length; i += 4) {
      const members = loose.slice(i, i + 4).map(p => String(p.id));
      groups.set(next, { id: next, members, leaderId: members[0] });
      next++;
    }
    return [...groups.values()].sort((a, b) => a.id - b.id);
  }

  /** Where a team's squads and crews go next. */
  plan(now) {
    const view = this.readView(now);
    if (!view.flags.length) return;
    this.computePresence(view);
    for (const ts of this.teams.values()) this.planTeam(ts, view, now);
    this.goalAt = -1;
  }

  /** Squad table of a team from the mode's roster; standing orders carry over by squad id. */
  syncSquads(ts, view) {
    const live = new Map();
    for (const group of this.squadsOf(ts.team, view)) {
      const prior = ts.squads.get(group.id);
      live.set(group.id, { ...group, order: prior?.order ?? null });
    }
    ts.squads = live;
    ts.memberSquad = new Map();
    for (const squad of live.values()) for (const id of squad.members) ts.memberSquad.set(id, squad);
    return live;
  }

  planTeam(ts, view, now) {
    const team = ts.team, enemy = opposite(team);
    ts.knowledge = this.gatherKnowledge(team, now);
    const live = this.syncSquads(ts, view);
    const tiers = frontlineTiers(view.flags, view.bases, team);
    ts.tiers = tiers;
    const owned = f => f.owner === team;
    const presence = id => this.presence.get(id) ?? { alpha: 0, bravo: 0 };
    const knownNear = (flag, r) => ts.knowledge.some(k => flat(k, flag) <= r);
    // Threatened owned flags: contested, being taken, or enemies close.
    const threatened = view.flags.filter(f => owned(f) && (f.state === 'contested' || f.state === 'neutralizing'
      || presence(f.id)[enemy] > 0 || knownNear(f, DEFEND_ALERT_RADIUS)));
    const losing = view.flags.filter(f => owned(f) && f.home === team
      && presence(f.id)[enemy] > presence(f.id)[team] && (f.state === 'neutralizing' || presence(f.id)[enemy] > 0));
    const attackTier = tiers.find(tier => tier.some(f => !owned(f))) ?? [];
    const attackFlags = attackTier.filter(f => !owned(f));
    ts.attackFlags = attackFlags;
    ts.threatened = threatened;
    const lead = ((view.tickets?.[team] ?? 0) - (view.tickets?.[enemy] ?? 0)) / Math.max(1, view.maxTickets);
    const attackShare = Math.max(0.35, Math.min(0.85, ATTACK_SHARE - lead * 0.8));
    const squads = [...live.values()].filter(s => s.members.some(id => this.isBot(id)));
    const centroid = squad => this.squadCentroid(squad) ?? view.bases?.[team] ?? view.flags[0];
    const orders = new Map();
    if (losing.length) {
      // All-in defence of a home flag being lost.
      const flag = losing.sort((a, b) => presence(b.id)[enemy] - presence(a.id)[enemy])[0];
      for (const squad of squads) orders.set(squad.id, { stance: 'defend', flagId: flag.id, allIn: true });
    } else {
      let attackCount = attackFlags.length ? Math.max(1, Math.round(squads.length * attackShare)) : 0;
      let defendCount = threatened.length ? Math.max(squads.length >= 2 ? 1 : 0, squads.length - attackCount) : 0;
      if (attackCount + defendCount > squads.length) attackCount = squads.length - defendCount;
      const free = new Set(squads.map(s => s.id));
      // Defenders: nearest squads to the threatened flags, keeping prior defenders.
      const defendTargets = threatened.slice().sort((a, b) => presence(b.id)[enemy] - presence(a.id)[enemy]);
      for (let i = 0; i < defendCount && defendTargets.length; i++) {
        const flag = defendTargets[i % defendTargets.length];
        const pick = [...free].map(id => live.get(id)).sort((a, b) =>
          (a.order?.stance === 'defend' && a.order.flagId === flag.id ? -1000 : 0) + flat(centroid(a), flag)
          - ((b.order?.stance === 'defend' && b.order.flagId === flag.id ? -1000 : 0) + flat(centroid(b), flag)))[0];
        if (!pick) break;
        free.delete(pick.id);
        orders.set(pick.id, { stance: 'defend', flagId: flag.id });
      }
      // Attackers (and any reserve) spread over the attack tier, keeping prior targets.
      const targets = attackFlags.length ? attackFlags
        : tiers.at(-1)?.filter(owned) ?? view.flags.filter(owned);
      // A frontline flag locked in a stalemate sends one squad round the flank
      // to the weakest enemy flag behind it (a back-cap that forces the enemy
      // to peel defenders off the line).
      // Stalled: the line flag is fought over, or the same attack has made no
      // ownership progress for a long while.
      const attackKey = attackFlags.map(f => `${f.id}:${f.owner}`).join(',');
      if (attackKey !== ts.attackKey) { ts.attackKey = attackKey; ts.attackSince = now; }
      const contestedLine = attackFlags.length && attackFlags.every(f => f.state === 'contested'
        || ((this.presence.get(f.id)?.[enemy] ?? 0) > 0 && (this.presence.get(f.id)?.[team] ?? 0) > 0));
      const stalled = attackFlags.length && (contestedLine || now - ts.attackSince >= ATTACK_STALL_MS);
      if (contestedLine) ts.stalemateSince ??= now; else if (!stalled) ts.stalemateSince = null;
      if (stalled && !contestedLine) ts.stalemateSince = Math.min(ts.stalemateSince ?? now, ts.attackSince + ATTACK_STALL_MS - STALEMATE_FLANK_MS);
      const tierIndex = tiers.indexOf(attackTier);
      const behind = tierIndex >= 0 ? tiers.slice(tierIndex + 1).flat().filter(f => f.owner === enemy) : [];
      if (stalled && now - ts.stalemateSince >= STALEMATE_FLANK_MS && behind.length && free.size >= 2) {
        const flanker = [...free].sort((a, b) => b - a)[0];
        const target = behind.slice().sort((a, b) => this.defenders(a, ts) - this.defenders(b, ts)
          || flat(centroid(live.get(flanker)), a) - flat(centroid(live.get(flanker)), b))[0];
        // Keep the flank target only while the enemy still holds it: a squad
        // that took its back flag moves on to the next weak one.
        const prior = live.get(flanker).order;
        const keep = prior?.flank && behind.some(f => f.id === prior.flagId);
        orders.set(flanker, { stance: 'attack', flagId: keep ? prior.flagId : target.id, flank: true });
        free.delete(flanker);
      }
      let lane = 0;
      for (const id of [...free].sort((a, b) => a - b)) {
        const squad = live.get(id);
        const keep = squad.order && targets.some(f => f.id === squad.order.flagId)
          && (squad.order.stance === 'attack') === !!attackFlags.length ? squad.order.flagId : null;
        // Within the attack tier the weakest-held flag first, then the nearest.
        const cost = f => flat(centroid(squad), f) + (attackFlags.length ? this.defenders(f, ts) * 60 : 0);
        const flag = keep ? targets.find(f => f.id === keep)
          : targets.slice().sort((a, b) => cost(a) - cost(b))[lane++ % targets.length];
        if (!flag) continue;
        orders.set(id, { stance: attackFlags.length ? 'attack' : 'defend', flagId: flag.id });
      }
    }
    for (const squad of squads) {
      const want = orders.get(squad.id);
      if (!want) { squad.order = null; continue; }
      const prior = squad.order;
      const same = prior && prior.flagId === want.flagId && prior.stance === want.stance;
      // Defend orders hold for a while after the threat clears.
      if (prior?.stance === 'defend' && !same && prior.issuedAt + DEFEND_HOLD_MS > now && !want.allIn
          && view.flags.find(f => f.id === prior.flagId)?.owner === team && want.stance !== 'defend') continue;
      if (!same) squad.order = this.newOrder(squad, want, view, ts, now);
      else squad.order.allIn = !!want.allIn;
      this.advanceOrder(squad, view, ts, now);
    }
    this.planCrews(ts, view, now);
    this.planTransit(ts, view, now);
    this.planHitches(ts, view, now);
    this.planWaits(ts, now);
  }

  isBot(id) { return this.game.entities.get(id)?.bot === true; }

  squadCentroid(squad, { infantryOnly = true } = {}) {
    let x = 0, z = 0, y = 0, n = 0;
    for (const id of squad.members) {
      const p = this.game.entities.get(id);
      if (!p || p.state !== 'alive' || (infantryOnly && p.vehicleId)) continue;
      x += p.x; y += p.y; z += p.z; n++;
    }
    return n ? { x: x / n, y: y / n, z: z / n, n } : null;
  }

  newOrder(squad, want, view, ts, now) {
    const flag = view.flags.find(f => f.id === want.flagId);
    const order = { ...want, issuedAt: now, phase: 'push', staging: null, side: squad.id % 2 ? 1 : -1, arrivedAt: 0, pushAt: 0 };
    if (want.stance !== 'attack' || !flag) return order;
    const from = this.squadCentroid(squad) ?? view.bases?.[ts.team];
    // Stage only against a flag the team knows is held: an empty enemy flag is
    // taken at a run (back-capping), a defended one gets the staged push.
    const defended = this.defenders(flag, ts) > 0;
    if (!from || !defended || flat(from, flag) < STAGE_MAX + 15) return order;
    order.staging = this.stagingPoint(flag, from, order.side, squad.id);
    if (order.staging) order.phase = 'move';
    return order;
  }

  /**
   * Enemy bodies known at or inside a flag (presence plus team knowledge
   * within the alert radius). Several sightings, memories, damage sources or
   * spot marks of one enemy count once.
   */
  defenders(flag, ts) {
    const enemy = opposite(ts.team);
    const ids = new Set();
    let anonymous = 0;
    for (const k of ts.knowledge ?? []) {
      if (flat(k, flag) > DEFEND_ALERT_RADIUS) continue;
      if (k.id != null) ids.add(k.id); else anonymous++;
    }
    return Math.max(this.presence.get(flag.id)?.[enemy] ?? 0, ids.size + anonymous);
  }

  /** A walkable point 50-70 m from the flag, +-50 degrees off the squad's approach. */
  stagingPoint(flag, from, side, salt = 0) {
    const approach = Math.atan2(from.z - flag.z, from.x - flag.x);
    const radius = STAGE_MIN + (stableHash(`${flag.id}:${salt}`) % (STAGE_MAX - STAGE_MIN + 1));
    for (const extra of [0, 0.2, -0.2, 0.4, -0.4]) {
      const a = approach + side * STAGE_ANGLE + extra;
      for (const r of [radius, radius - 8, radius + 6]) {
        const point = this.walkablePoint({ x: flag.x + Math.cos(a) * r, y: flag.y, z: flag.z + Math.sin(a) * r });
        if (point) return point;
      }
    }
    return null;
  }

  /** Snap a point to standable ground (surface graph or a column scan). */
  walkablePoint(point) {
    const world = this.game.world;
    const { sx, sz } = world.dimensions ?? { sx: Infinity, sz: Infinity };
    if (!(point.x > 2 && point.z > 2 && point.x < sx - 2 && point.z < sz - 2)) return null;
    const nav = surfaceNavigation(world);
    if (nav) return nav.snap(point, 3);
    const feet = this.cover.floorAt(point.x, point.z, point.y ?? world.meta?.groundLevel ?? 10);
    if (Number.isFinite(feet)) return { x: Math.floor(point.x) + 0.5, y: feet + 0.02, z: Math.floor(point.z) + 0.5 };
    const floor = world.meta?.navigationFloor;
    return Number.isFinite(floor) ? { x: point.x, y: floor + 1.02, z: point.z } : null;
  }

  advanceOrder(squad, view, ts, now) {
    const order = squad.order;
    if (!order || order.phase === 'push' || !order.staging) return;
    const members = squad.members.map(id => this.game.entities.get(id))
      .filter(p => p?.state === 'alive' && p.bot && !p.vehicleId && !ts.crews.has(String(p.id)) && !ts.hitches.has(String(p.id)));
    if (members.length <= 1 && now - order.issuedAt > 4000) { order.phase = 'push'; order.pushAt = now; return; }
    const near = members.filter(p => flat(p, order.staging) <= STAGE_GATHER_RADIUS).length;
    if (order.phase === 'move' && members.length && near / members.length >= 0.6) { order.phase = 'stage'; order.arrivedAt = now; }
    if (order.phase === 'stage' && now - order.arrivedAt >= STAGE_HOLD_MS) { order.phase = 'push'; order.pushAt = now; }
    if (now - order.issuedAt > STAGE_TIMEOUT_MS) { order.phase = 'push'; order.pushAt = order.pushAt || now; }
  }

  // ---------------------------------------------------------------- crews --

  teamBrains(team) {
    return this.manager.brains.filter(br => this.teamOf(this.game.entities.get(br.id)) === team);
  }

  /**
   * Persistent crews within budget, in spec priority: tank driver > attack
   * helicopter pilot > (jeeps ride with squads, see planTransit) > plane pilot
   * (only with >= 6 bots) > a second tank > helicopter gunner > tank commander.
   * The budget is ceil(teamBots / 4), inside the spec's ceil(teamBots / 3)
   * cap, so most of the team stays on foot around the flags.
   */
  planCrews(ts, view, now) {
    const team = ts.team, brains = this.teamBrains(team);
    const budget = Math.min(Math.ceil(brains.length / 3), Math.ceil(brains.length / CREW_SHARE));
    const benched = id => this.manager?.vehicleDriving?.benched?.(id, now) || this.manager?.aircraftDriving?.benched?.(id, now);
    const hulls = [...this.game.vehicles?.vehicles.values() ?? []].filter(v => v.team === team && v.hp > 0 && !disabledHull(v) && !benched(v.id));
    const front = ts.attackFlags?.[0] ?? ts.threatened?.[0] ?? view.flags[0];
    // A hull a bot already drives (or is walking to) keeps its crew: a newly
    // spawned hull nearer the front (the flag-C tank after a capture) must not
    // pull a working crew out of its seat. Otherwise the hull nearest the front.
    const manned = v => {
      const driver = hullSeatIds(v).driver, occupant = vehicleSeatOccupantId(v, driver);
      if (occupant != null) return this.isBot(occupant) ? 1 : 0;
      for (const crew of ts.crews.values()) if (crew.vehicleId === v.id && crew.seatId === driver) return 1;
      return 0;
    };
    const byFront = (a, b) => (manned(b) - manned(a)) || flat(a, front) - flat(b, front);
    const slots = [];
    const push = (list, seatOf, prio) => list.sort(byFront).forEach(v => { const seat = seatOf(v); if (seat) slots.push({ v, seat, prio }); });
    const tanks = hulls.filter(v => v.type === 'tank').sort(byFront);
    push(tanks.slice(0, 1), v => hullSeatIds(v).driver, 0);
    push(hulls.filter(v => v.type === 'helicopter'), v => hullSeatIds(v).driver, 1);
    if (brains.length >= 6) push(hulls.filter(v => v.type === 'plane'), v => hullSeatIds(v).driver, 2);
    push(tanks.slice(1), v => hullSeatIds(v).driver, 3);
    push(hulls.filter(v => v.type === 'helicopter'), v => hullSeatIds(v).gunner, 4);
    push(hulls.filter(v => v.type === 'tank'), v => hullSeatIds(v).gunner, 5);
    slots.sort((a, b) => a.prio - b.prio);
    const chosen = [];
    // A bot flying an aircraft keeps it until it lands, dies or the hull goes
    // down: nobody bails out of a jet in the air. It still counts against the budget.
    // Only the pilot is protected: an airborne gunner without an order rides on
    // until landing, so it must not push a seated tank driver out of the budget.
    for (const slot of slots) {
      const occupant = vehicleSeatOccupantId(slot.v, slot.seat);
      if (occupant != null && this.isBot(occupant) && isAircraftType(slot.v.type) && slot.v.grounded === false
          && slot.seat === hullSeatIds(slot.v).driver) chosen.push(slot);
    }
    for (const slot of slots) {
      if (chosen.includes(slot)) continue;
      if (chosen.length >= budget) break;
      const occupant = vehicleSeatOccupantId(slot.v, slot.seat);
      const human = occupant != null && !this.isBot(occupant);
      if (human) continue;
      // A gunner seat is only worth a bot when its hull has (or will have) a driver.
      if (slot.prio >= 4 && !chosen.some(c => c.v === slot.v) && !vehicleSeatOccupantId(slot.v, hullSeatIds(slot.v).driver)) continue;
      chosen.push(slot);
    }
    const keyOf = slot => `${slot.v.id}:${slot.seat}`;
    const wanted = new Map(chosen.map(slot => [keyOf(slot), slot]));
    const crews = new Map();
    const transitIds = new Set([...ts.transits.values()].flatMap(t => [...t.seats.keys()]));
    // Keep bots already seated or assigned to a still-wanted slot.
    for (const [id, crew] of ts.crews) {
      const key = `${crew.vehicleId}:${crew.seatId}`;
      const p = this.game.entities.get(id);
      if (!p || this.teamOf(p) !== team || !wanted.has(key)) continue;
      crews.set(id, { ...crew, slot: wanted.get(key) });
      wanted.delete(key);
    }
    for (const [key, slot] of wanted) {
      const seated = vehicleSeatOccupantId(slot.v, slot.seat);
      if (seated != null && this.isBot(seated)) { crews.set(seated, { vehicleId: slot.v.id, seatId: slot.seat, prio: slot.prio, since: now, slot }); continue; }
      let best = null, bestScore = Infinity;
      for (const br of brains) {
        const id = br.id, p = this.game.entities.get(id);
        if (!p || crews.has(id) || transitIds.has(id) || ts.hitches.has(id)) continue;
        if (p.vehicleId && p.vehicleId !== slot.v.id) continue;
        // Dead bots deploy straight into the seat; living ones walk if close.
        let score;
        if (p.state !== 'alive') score = view.deployOptions ? 5 : 400 + flat(view.bases?.[team] ?? p, slot.v);
        else { const d = flat(p, slot.v); if (d > CREW_WALK_MAX) continue; score = d + (p.vehicleId === slot.v.id ? -50 : 0); }
        // Medics are the squads' revivers: they man a hull only when nobody else can.
        if (KITS[p.state === 'alive' ? this.kitOf(p) : this.kitFor(p)]?.ability === 'revive') score += MEDIC_CREW_PENALTY;
        if (score < bestScore) { bestScore = score; best = id; }
      }
      if (best) crews.set(best, { vehicleId: slot.v.id, seatId: slot.seat, prio: slot.prio, since: now, slot });
    }
    // A bot that ended up crewing (e.g. it took off in a jet) leaves any squad ride it was booked on.
    for (const transit of ts.transits.values()) for (const id of crews.keys()) transit.seats.delete(id);
    ts.crews = crews;
    ts.crewBudget = budget;
  }

  /** Squad rides: a free jeep or transport near a squad that has far to go. */
  planTransit(ts, view, now) {
    for (const [id, transit] of ts.transits) {
      const v = this.game.vehicles?.vehicles.get(transit.vehicleId);
      const squad = ts.squads.get(transit.squadId);
      // A human at the wheel (a seat takeover) ends the ride; its riders become
      // hitches of the human's ride (planHitches).
      if (!v || v.hp <= 0 || !squad || now > transit.until || transit.done || this.transitDriverLost(v, transit, ts, now)
          || this.humanAtWheel(v, ts.team)) ts.transits.delete(id);
    }
    const busy = new Set([...ts.transits.values()].map(t => t.vehicleId));
    for (const crew of ts.crews.values()) busy.add(crew.vehicleId);
    const hulls = [...this.game.vehicles?.vehicles.values() ?? []].filter(v => v.team === ts.team && v.hp > 0
      && !disabledHull(v) && (v.type === 'jeep' || v.type === 'transport') && !busy.has(v.id)
      && !vehicleSeats(v).some(seat => vehicleSeatOccupantId(v, seat.id) != null));
    ts.rideCooldown ??= new Map();
    for (const squad of ts.squads.values()) {
      // One squad ride per team at a time, and a squad that just rode walks
      // its next leg: rides shorten long hauls without parking the team in seats.
      if (ts.transits.size >= MAX_TEAM_RIDES) break;
      const order = squad.order;
      if (!order || order.stance !== 'attack' || [...ts.transits.values()].some(t => t.squadId === squad.id)) continue;
      if ((ts.rideCooldown.get(squad.id) ?? 0) > now) continue;
      const flag = view.flags.find(f => f.id === order.flagId);
      const destination = order.phase === 'move' && order.staging ? order.staging : flag;
      const riders = squad.members.map(m => this.game.entities.get(m))
        .filter(p => p?.state === 'alive' && p.bot && !p.vehicleId && !ts.crews.has(String(p.id)) && !ts.hitches.has(String(p.id)));
      if (riders.length < 2 || !destination) continue;
      const center = this.squadCentroid(squad);
      if (!center || flat(center, destination) < 140) continue;
      // Jeeps parked by the squad, or the transport on its pad within a short walk.
      const reach = v => (v.type === 'transport' ? 90 : 45);
      const hull = hulls.filter(v => flat(v, center) < reach(v) && flat(v, destination) > 100).sort((a, b) => flat(a, center) - flat(b, center))[0];
      if (!hull) continue;
      const seats = vehicleSeats(hull).map(seat => seat.id);
      const ordered = riders.sort((a, b) => flat(a, hull) - flat(b, hull)).slice(0, seats.length);
      const assignment = new Map();
      ordered.forEach((p, i) => assignment.set(String(p.id), seats[i]));
      // The driver seat must be filled for the ride to happen.
      if (![...assignment.values()].includes(hullSeatIds(hull).driver)) continue;
      ts.rideCooldown.set(squad.id, now + RIDE_COOLDOWN_MS);
      ts.transits.set(hull.id, { vehicleId: hull.id, squadId: squad.id, seats: assignment, destination: { ...destination },
        flagId: order.flagId, createdAt: now, departAt: 0, until: now + 15000 + TRANSIT_MAX_MS, done: false });
      hulls.splice(hulls.indexOf(hull), 1);
    }
  }

  /**
   * A ride that has not left yet can only start with its booked driver at the
   * wheel (only the driver's transitDrive departs it). It is called off when
   * that driver died, left the roster or the team, a human took the wheel, or
   * the driver has not boarded within the boarding window; the riders already
   * aboard then have no order for the hull and get out.
   */
  transitDriverLost(v, transit, ts, now) {
    if (transit.departAt) return false;
    const seat = hullSeatIds(v).driver;
    const occupant = vehicleSeatOccupantId(v, seat);
    const booked = [...transit.seats].find(([, seatId]) => seatId === seat)?.[0];
    if (booked == null) return true;
    if (occupant != null) return String(occupant) !== booked;
    const p = this.game.entities.get(booked);
    if (!p || p.state !== 'alive' || !p.bot || this.teamOf(p) !== ts.team) return true;
    return now - transit.createdAt > TRANSIT_BOARD_MS;
  }

  /**
   * Rides with humans (Battlefield "get in"): every friendly hull a living
   * human drives or pilots offers its free seats to nearby bots, gunner seats
   * first (tank commander, jeep HMG, chin gun, door guns), then passengers.
   * The driver's squad mates come first (HITCH_SQUAD_RADIUS, any number), then
   * the nearest other teammates (HITCH_RADIUS, at most ceil(teamBots /
   * HITCH_TEAM_SHARE) per team). Bots only set out for a hull that is stopped
   * or crawling (ground) or on the ground (aircraft); a bot capturing a flag,
   * holding a threatened one, crewing, riding a squad ride or busy with a
   * revive or repair stays where it is. Riders man their guns while the human
   * drives and are dropped (booking removed, so they get out once stopped)
   * when the hull stops at a flag they want, when it has stood still for
   * HITCH_IDLE_MS, or when the human leaves the driver seat. Bots never take
   * a seat a human holds: VehicleSystem.enter only gives a bot a free seat.
   * Runs inside the 2 Hz plan; the hull scan is O(hulls) and the bot scan only
   * runs for teams with a human at a wheel.
   */
  planHitches(ts, view, now) {
    const team = ts.team, vehicles = this.game.vehicles?.vehicles;
    for (const [id, until] of ts.hitchCooldown) if (until <= now) ts.hitchCooldown.delete(id);
    const humanDriver = v => this.humanAtWheel(v, team);
    const squadOf = id => ts.memberSquad?.get(String(id)) ?? null;
    const wants = (p, flag) => flag.owner !== team || ts.threatened?.includes(flag) || squadOf(p.id)?.order?.flagId === flag.id;
    const dropFlag = (v, p) => view.flags.find(f => flat(v, f) <= f.radius + HITCH_DROP_PAD && Math.abs(v.y - f.y) <= 12 && wants(p, f));
    const drop = (id, cooldown = HITCH_COOLDOWN_MS) => { ts.hitches.delete(id); ts.hitchCooldown.set(id, now + cooldown); };
    // Keep, update or drop the current bookings.
    for (const [id, hitch] of ts.hitches) {
      const p = this.game.entities.get(id), v = vehicles?.get(hitch.vehicleId);
      if (!p || p.state !== 'alive' || this.teamOf(p) !== team || ts.crews.has(id) || !humanDriver(v)) { ts.hitches.delete(id); continue; }
      if (p.vehicleId) {
        // Seated elsewhere, or swapped into the driver seat by the human: not a ride any more.
        if (p.vehicleId !== v.id || p.vehicleSeatId === hullSeatIds(v).driver) { drop(id); continue; }
        hitch.seatId = p.vehicleSeatId ?? hitch.seatId;
        hitch.boarded = true;
        if (!hullStopped(v, HITCH_STOPPED)) { hitch.stoppedSince = 0; continue; }
        hitch.stoppedSince ||= now;
        if (dropFlag(v, p)) drop(id);
        else if (now - hitch.stoppedSince >= HITCH_IDLE_MS) drop(id, HITCH_COOLDOWN_MS * 2);
        continue;
      }
      // Got out (or was put out) after boarding, gave up boarding, lost the
      // seat or the hull drove off: the booking ends.
      const occupant = vehicleSeatOccupantId(v, hitch.seatId);
      if (hitch.boarded || now - hitch.since > HITCH_BOARD_MS || (occupant != null && occupant !== id)
          || flat(p, v) > HITCH_SQUAD_RADIUS + 20 || this.hitchBusy(p, ts, view, now)) drop(id, hitch.boarded ? HITCH_COOLDOWN_MS : 10000);
    }
    const hulls = [];
    for (const v of vehicles?.values() ?? []) {
      const driver = humanDriver(v);
      if (driver && !(isAircraftType(v.type) && v.grounded === false)) hulls.push({ v, driver });
    }
    if (!hulls.length) return;
    const reserved = new Set();
    for (const crew of ts.crews.values()) reserved.add(`${crew.vehicleId}:${crew.seatId}`);
    for (const transit of ts.transits.values()) for (const seat of transit.seats.values()) reserved.add(`${transit.vehicleId}:${seat}`);
    for (const hitch of ts.hitches.values()) reserved.add(`${hitch.vehicleId}:${hitch.seatId}`);
    const brains = this.teamBrains(team);
    let strangers = [...ts.hitches.keys()].filter(id => !ts.hitches.get(id).squad).length;
    const strangerCap = Math.ceil(brains.length / HITCH_TEAM_SHARE);
    // Squad rides that have not left yet: the human driver's squad mates may
    // be taken off them (a human's squad rides with the human).
    const transitOf = new Map();
    for (const transit of ts.transits.values()) for (const id of transit.seats.keys()) transitOf.set(id, transit);
    for (const { v, driver } of hulls) {
      // Bots already aboard (a squad ride the human took over, a deploy into
      // the hull) ride with the human under the same rules.
      for (const seat of vehicleSeats(v)) {
        const id = vehicleSeatOccupantId(v, seat.id), p = id != null ? this.game.entities.get(id) : null;
        if (seat.drives || !p?.bot || p.state !== 'alive' || this.teamOf(p) !== team || ts.crews.has(id) || ts.hitches.has(id) || ts.hitchCooldown.has(id)) continue;
        transitOf.get(id)?.seats.delete(id);
        ts.hitches.set(id, { vehicleId: v.id, seatId: seat.id, driverId: String(driver.id), squad: true, since: now, boarded: true, stoppedSince: 0 });
      }
      if (!hullStopped(v, HITCH_BOARD_SPEED)) continue;
      const topology = VEHICLE_TOPOLOGY[v.type] ?? [];
      const role = seat => topology.find(t => t.id === seat.id)?.role;
      const seats = vehicleSeats(v).filter(seat => !seat.drives && vehicleSeatOccupantId(v, seat.id) == null && !reserved.has(`${v.id}:${seat.id}`))
        .sort((a, b) => (role(a) === 'gunner' ? 0 : 1) - (role(b) === 'gunner' ? 0 : 1));
      if (!seats.length) continue;
      const squad = squadOf(driver.id);
      const candidates = [];
      for (const br of brains) {
        const id = br.id, p = this.game.entities.get(id);
        if (!p || p.state !== 'alive' || p.vehicleId || ts.crews.has(id) || ts.hitches.has(id) || ts.hitchCooldown.has(id)) continue;
        const mate = !!squad && squad.members.includes(id);
        const transit = transitOf.get(id);
        if (transit && (!mate || transit.departAt)) continue;
        const d = flat(p, v);
        if (d > (mate ? HITCH_SQUAD_RADIUS : HITCH_RADIUS) || Math.abs(p.y - v.y) > 12) continue;
        if (dropFlag(v, p) || this.hitchBusy(p, ts, view, now)) continue;
        candidates.push({ id, mate, d });
      }
      candidates.sort((a, b) => (b.mate - a.mate) || a.d - b.d);
      for (const candidate of candidates) {
        if (!seats.length) break;
        if (!candidate.mate && strangers >= strangerCap) continue;
        const seat = seats.shift();
        transitOf.get(candidate.id)?.seats.delete(candidate.id);
        ts.hitches.set(candidate.id, { vehicleId: v.id, seatId: seat.id, driverId: String(driver.id), squad: candidate.mate,
          since: now, boarded: false, stoppedSince: 0 });
        reserved.add(`${v.id}:${seat.id}`);
        if (!candidate.mate) strangers++;
      }
    }
  }

  /**
   * Battlefield "wait for me": a bot driving or piloting a hull on an order
   * (a crew or a squad ride) holds for a living human teammate on foot who
   * runs toward it. Approaching: within WAIT_RADIUS, closing in at
   * WAIT_CLOSING or faster, and moving (or looking) toward the hull. Only a
   * hull with a seat the human may take (free or bot-held, besides the
   * driver's) waits; a ground hull only while stopped or within
   * WAIT_DEPART_MAX of where it set off, an aircraft only on the ground. One
   * wait per hull and per human, the driver's squad mates first. The wait
   * ends when the human boards (the hull leaves at once), dies, takes another
   * hull, stops closing in for WAIT_STALL_MS outside boarding reach, walks
   * away, or after WAIT_MS (WAIT_SQUAD_MS for a squad mate); a human given up
   * on is not waited for again for WAIT_COOLDOWN_MS. The drivers read the
   * result per tick through holdFor. Inside the 2 Hz plan, O(humans x hulls),
   * and nothing beyond one entity pass for a team without humans.
   */
  planWaits(ts, now) {
    const team = ts.team, vehicles = this.game.vehicles?.vehicles;
    if (!vehicles) return;
    for (const [id, until] of ts.waitCooldown) if (until <= now) ts.waitCooldown.delete(id);
    const roles = conquestRoles(this.game);
    const humans = [];
    for (const p of this.game.entities.values()) {
      if (!p.bot && !p.npcRole && p.state === 'alive' && !p.vehicleId && this.teamOf(p) === team && !roles?.isDown?.(p)) humans.push(p);
    }
    let waiting = 0;
    for (const wait of this.waits.values()) if (wait.team === team) waiting++;
    if (!humans.length && !waiting) { ts.departFrom.clear(); return; }
    // Hulls a bot drives on an order, and where each ground hull last stood still.
    const hulls = new Map();
    const departFrom = new Map();
    for (const v of vehicles.values()) {
      if (v.team !== team) continue;
      const air = isAircraftType(v.type);
      let from = null;
      if (!air) {
        // A hull first seen moving counts as long gone.
        from = Math.abs(v.speed || 0) < HITCH_STOPPED ? { x: v.x, z: v.z } : ts.departFrom.get(v.id) ?? { x: Infinity, z: Infinity };
        departFrom.set(v.id, from);
      }
      if (!(v.hp > 0) || disabledHull(v) || v.padInactive || (air && v.grounded === false)) continue;
      const seat = hullSeatIds(v).driver, driverId = vehicleSeatOccupantId(v, seat);
      if (driverId == null || !this.isBot(driverId)) continue;
      const crew = ts.crews.get(driverId);
      if (!((crew?.vehicleId === v.id && crew.seatId === seat) || ts.transits.get(v.id)?.seats.get(driverId) === seat)) continue;
      // Only a hull with a seat for the human: free, or a bot's (seat takeover).
      if (!vehicleSeats(v).some(s => { if (s.drives) return false; const id = vehicleSeatOccupantId(v, s.id); return id == null || this.isBot(id); })) continue;
      const startable = air ? Math.hypot(v.vx || 0, v.vz || 0) < HITCH_BOARD_SPEED : flat(v, from) < WAIT_DEPART_MAX;
      hulls.set(v.id, { v, driverId, startable });
    }
    ts.departFrom = departFrom;
    const approach = (p, v) => {
      const dx = v.x - p.x, dz = v.z - p.z, d = Math.hypot(dx, dz);
      const closing = d > 1e-6 ? ((p.vx || 0) * dx + (p.vz || 0) * dz) / d : 0;
      return { d, closing, speed: Math.hypot(p.vx || 0, p.vz || 0), facing: Math.abs(wrap(Math.atan2(-dx, -dz) - (p.yaw ?? 0))) };
    };
    // Keep or end the running waits.
    const waited = new Set();
    for (const [vehicleId, wait] of this.waits) {
      if (wait.team !== team) continue;
      const entry = hulls.get(vehicleId), p = this.game.entities.get(wait.humanId);
      let over = null; // 'done': ended without blame; 'cool': given up on, cooldown
      if (!entry || entry.driverId !== wait.driverId) over = 'done';
      else if (!p || p.state !== 'alive' || this.teamOf(p) !== team || roles?.isDown?.(p)) over = 'done';
      else if (p.vehicleId) over = p.vehicleId === vehicleId ? 'done' : 'cool';
      else if (now > wait.until) over = 'cool';
      else {
        const { d, closing } = approach(p, entry.v);
        if (d <= WAIT_REACH || closing >= WAIT_CLOSING * 0.5) wait.closingAt = now;
        if (d > WAIT_RADIUS + 10 || Math.abs(p.y - entry.v.y) > 16 || (d > WAIT_REACH && closing <= WAIT_AWAY)
            || now - wait.closingAt > WAIT_STALL_MS) over = 'cool';
      }
      if (!over) { waited.add(wait.humanId); continue; }
      this.waits.delete(vehicleId);
      if (over === 'cool') ts.waitCooldown.set(wait.humanId, now + WAIT_COOLDOWN_MS);
    }
    // New waits: every human heading for a hull that may still wait.
    const pairs = [];
    for (const p of humans) {
      const id = String(p.id);
      if (waited.has(id) || ts.waitCooldown.has(id)) continue;
      for (const [vehicleId, { v, driverId, startable }] of hulls) {
        if (!startable || this.waits.has(vehicleId) || Math.abs(p.y - v.y) > 12) continue;
        const { d, closing, speed, facing } = approach(p, v);
        if (d > WAIT_RADIUS || closing < WAIT_CLOSING || (closing < 0.6 * speed && facing > WAIT_FACING)) continue;
        const mate = !!ts.memberSquad?.get(String(driverId))?.members.includes(id);
        pairs.push({ id, vehicleId, driverId, d, mate });
      }
    }
    pairs.sort((a, b) => (b.mate - a.mate) || a.d - b.d);
    for (const pair of pairs) {
      if (waited.has(pair.id) || this.waits.has(pair.vehicleId)) continue;
      this.waits.set(pair.vehicleId, { vehicleId: pair.vehicleId, humanId: pair.id, driverId: String(pair.driverId), team,
        squad: pair.mate, since: now, until: now + (pair.mate ? WAIT_SQUAD_MS : WAIT_MS), closingAt: now });
      waited.add(pair.id);
    }
  }

  /**
   * The wait a bot driver of `v` holds for (planWaits), or null. Per tick and
   * O(1): a human who boarded, died or ran out of time releases it at once,
   * without waiting for the next plan.
   */
  holdFor(v, now = this.game.now) {
    const wait = v ? this.waits.get(v.id) : null;
    if (!wait || now > wait.until) return null;
    const p = this.game.entities.get(wait.humanId);
    return p && p.state === 'alive' && !p.vehicleId ? wait : null;
  }

  /** The living human of `team` in the driver or pilot seat of a usable friendly hull, or null. */
  humanAtWheel(v, team) {
    if (!v || !(v.hp > 0) || v.team !== team || v.padInactive || disabledHull(v)) return null;
    const occupant = vehicleSeatOccupantId(v, hullSeatIds(v).driver);
    const p = occupant != null ? this.game.entities.get(occupant) : null;
    return p && !p.bot && p.state === 'alive' && this.teamOf(p) === team ? p : null;
  }

  /**
   * A bot that must not leave for a ride: it stands in a flag it is taking or
   * that is being fought over, holds a threatened flag (its squad defends it,
   * or it stands inside it), or is running a revive or repair.
   */
  hitchBusy(p, ts, view, now) {
    const order = ts.memberSquad?.get(String(p.id))?.order;
    if (order?.allIn) return true;
    for (const flag of view.flags) {
      const d = flat(p, flag);
      const inside = d <= flag.radius && Math.abs(p.y - flag.y) <= 8;
      if (inside && (flag.owner !== ts.team || flag.state !== 'idle')) return true;
      if (ts.threatened?.includes(flag) && (inside || (order?.stance === 'defend' && order.flagId === flag.id && d <= DEFEND_ALERT_RADIUS))) return true;
    }
    const id = String(p.id);
    // A revive or repair walk keeps the bot; standing by a hurt mate (heal claims) does not.
    for (const [name, claim] of this.roleClaims) if (claim.id === id && claim.until > now && !name.startsWith('heal:')) return true;
    return false;
  }

  /** Vehicle assignment of a bot: {vehicleId, seatId, role:'crew'|'transit'|'hitch', ...} or null. */
  crewFor(id) {
    const p = this.game.entities.get(id);
    const ts = this.teams.get(this.teamOf(p));
    if (!ts) return null;
    const crew = ts.crews.get(String(id));
    if (crew) {
      const flag = this.focusFlag(ts);
      return { role: 'crew', vehicleId: crew.vehicleId, seatId: crew.seatId, prio: crew.prio, flag,
        friendlyYaw: flag ? bearing(flag, this.view?.bases?.[ts.team] ?? flag) : null };
    }
    for (const transit of ts.transits.values()) {
      const seatId = transit.seats.get(String(id));
      if (seatId) return { role: 'transit', vehicleId: transit.vehicleId, seatId, transit, destination: transit.destination };
    }
    const hitch = ts.hitches.get(String(id));
    if (hitch) return { role: 'hitch', vehicleId: hitch.vehicleId, seatId: hitch.seatId, driverId: hitch.driverId };
    return null;
  }

  /** The flag the team's armour and aircraft work: the defended flag when all-in, else the attack flag. */
  focusFlag(ts) {
    const allIn = [...ts.squads.values()].find(s => s.order?.allIn);
    const view = this.view;
    if (!view) return null;
    if (allIn) return view.flags.find(f => f.id === allIn.order.flagId) ?? null;
    return ts.attackFlags?.[0] ?? ts.threatened?.[0] ?? view.flags.find(f => f.owner !== ts.team) ?? view.flags[0] ?? null;
  }

  /** A rider got out (ride over, driver lost): it is no longer booked on that hull. */
  leaveTransit(vehicleId, id) {
    for (const ts of this.teams.values()) ts.transits.get(vehicleId)?.seats.delete(String(id));
  }

  markTransit(vehicleId, patch) {
    for (const ts of this.teams.values()) {
      const transit = ts.transits.get(vehicleId);
      if (transit) Object.assign(transit, patch);
    }
  }

  // ---------------------------------------------------------------- kits --

  slotOf(p) {
    const ts = this.teams.get(this.teamOf(p));
    const squad = ts?.memberSquad?.get(String(p.id));
    if (!squad) return { squadId: 0, slot: 0 };
    return { squadId: squad.id, slot: Math.max(0, squad.members.indexOf(String(p.id))) };
  }

  /** Squad slot kit (shared BOT_SQUAD_SLOTS): assault, medic, engineer, then a flex kit. */
  kitFor(p) {
    const { squadId } = this.slotOf(p);
    // Kit slots count bots only, so a squad a human joined still fields its Medic and Engineer bots.
    const ts = this.teams.get(this.teamOf(p));
    const members = ts?.memberSquad?.get(String(p.id))?.members ?? [];
    const bots = members.filter(id => id === String(p.id) || this.game.entities.get(id)?.bot);
    const slot = Math.max(0, bots.indexOf(String(p.id)));
    const kit = botSquadKit(slot, { team: this.teamOf(p) ?? '', squadId, seed: this.game?.mode?.policy?.kitSeed ?? 0 });
    return KIT_IDS.includes(kit) ? kit : 'assault';
  }

  /** Enemy aircraft in play for `team` (crewed or airborne), cached for a second. */
  enemyAirThreat(team) {
    const now = this.game.now;
    this._airThreat ??= new Map();
    const cached = this._airThreat.get(team);
    if (cached && now - cached.at < AIR_THREAT_CACHE_MS) return cached.count;
    let count = 0;
    for (const v of this.game.vehicles?.vehicles?.values?.() ?? []) {
      if (!(v.hp > 0) || v.padInactive || !isAircraftType(v.type) || v.team == null || v.team === team) continue;
      if (v.grounded === false || vehicleSeats(v).some(seat => vehicleSeatOccupantId(v, seat.id) != null)) count++;
    }
    this._airThreat.set(team, { at: now, count });
    return count;
  }

  /**
   * Gadget choice (spec: Engineer AT or STINGER). A stable share of the team's
   * engineers, ranked by id hash, takes the STINGER while enemy aircraft are in
   * play; the rest keep the AT launcher. Other kits have no choice (0).
   */
  gadgetFor(p) {
    if (this.kitFor(p) !== 'engineer') return 0;
    const team = this.teamOf(p);
    const share = AA_ENGINEER_SHARE[Math.min(AA_ENGINEER_SHARE.length - 1, this.enemyAirThreat(team))];
    if (!(share > 0)) return 0;
    const engineers = [];
    for (const o of this.game.entities.values()) {
      if (o.bot && this.teamOf(o) === team && this.kitFor(o) === 'engineer') engineers.push(String(o.id));
    }
    if (!engineers.includes(String(p.id))) engineers.push(String(p.id));
    engineers.sort((a, b) => stableHash(`${a}:aa`) - stableHash(`${b}:aa`) || (a < b ? -1 : 1));
    const aa = Math.max(1, Math.round(engineers.length * share));
    return engineers.indexOf(String(p.id)) < aa ? 1 : 0;
  }

  /**
   * Primary variant by a stable hash of id and kit, so every primary shows up
   * on bots. Pyro bots always carry the flamethrower (variant 0).
   */
  variantFor(p) {
    const kit = this.kitFor(p);
    if (kit === 'pyro') return 0;
    return stableHash(`${p.id}:${kit}`) % 2;
  }

  // ---------------------------------------------------------- director API --

  /** spec 3.5 deployFor: frontline flag > squad leader > vehicle seat > HQ. */
  deployFor(player) {
    const p = this.game.entities.get(String(player?.id ?? player)) ?? player;
    const view = this.readView();
    if (!this.teams.get(this.teamOf(p))?.memberSquad) this.plan(this.game.now);
    // A bot added since the last plan (every bot at match start) has no squad slot yet: refresh
    // the squad table only (no orders or crews), so its opening life carries its slot kit.
    const own = this.teams.get(this.teamOf(p));
    if (own?.memberSquad && !own.memberSquad.has(String(p.id))) this.syncSquads(own, view);
    const kit = this.kitFor(p), variant = this.variantFor(p), gadget = this.gadgetFor(p);
    // A downed bot a medic is already running to waits for the revive.
    const body = downBody(this.game, p);
    if (body && this.claimedByOther(`revive:${p.id}`, key(p), this.game.now) && body.until > this.game.now + 300) return null;
    const options = this.deployChoices(p, view);
    const crew = this.crewFor(p.id);
    if (crew?.role === 'crew') {
      const exact = `vehicle:${crew.vehicleId}:${crew.seatId}`;
      if (options.has(exact)) return { spawn: exact, kit, variant, gadget };
    }
    const target = this.objectivePoint(p) ?? view.bases?.[this.teamOf(p)];
    let best = { spawn: 'hq', score: Infinity };
    const base = view.bases?.[this.teamOf(p)];
    if (base && target) best.score = flat(base, target) + 5;
    for (const spawn of options) {
      let point = null, penalty = 0;
      if (spawn.startsWith('flag:')) point = view.flags.find(f => f.id === spawn.slice(5));
      // A squad spawn can still be refused at resolve time (no free cell behind
      // the mate) and a refused bot deploys at HQ: only take it when it clearly wins.
      else if (spawn.startsWith('squad:')) { point = this.game.entities.get(spawn.slice(6)); penalty = SQUAD_SPAWN_PENALTY; }
      else continue;
      if (!finitePoint(point) || !target) continue;
      const score = flat(point, target) + penalty;
      if (score < best.score) best = { spawn, score };
    }
    return { spawn: best.spawn, kit, variant, gadget };
  }

  deployChoices(p, view) {
    const set = new Set(['hq']);
    if (!view.deployOptions) return set;
    let options = [];
    try { options = view.deployOptions(p) ?? []; } catch { options = []; }
    const list = Array.isArray(options) ? options : options instanceof Set ? [...options] : Object.values(options);
    for (const option of list) {
      const spawn = typeof option === 'string' ? option : option?.spawn ?? option?.id;
      if (typeof spawn !== 'string' || option?.valid === false || option?.ok === false) continue;
      set.add(spawn);
      // Vehicle options list their free seats; each is a valid `vehicle:<id>:<seat>`.
      if (spawn.startsWith('vehicle:') && Array.isArray(option?.seats)) for (const seat of option.seats) set.add(`${spawn}:${seat}`);
    }
    return set;
  }

  /** The point a player's order is about (staging or flag). */
  objectivePoint(p) {
    const ts = this.teams.get(this.teamOf(p));
    const squad = ts?.memberSquad?.get(String(p.id));
    const order = squad?.order;
    const flag = order && this.view?.flags.find(f => f.id === order.flagId);
    if (!flag) return this.focusFlag(ts ?? { squads: new Map(), team: this.teamOf(p) });
    return order.phase !== 'push' && order.staging ? order.staging : flag;
  }

  /**
   * spec 3.5 goalFor: the bot goal shape {kind, target, interact} plus
   * {stance:'attack'|'defend'|'stage', point}. Bot-only extras: `role`
   * ('overwatch' recon hold, 'support' revive/repair), `arrive`, `lookYaw`,
   * `crouch`, and `support`/`reach` for the support intent. Cached per tick.
   */
  goalFor(player) {
    const p = this.game.entities.get(String(player?.id ?? player)) ?? player;
    const now = this.game.now;
    if (this.goalAt !== now) { this.goalCache.clear(); this.goalAt = now; }
    const key = String(p?.id);
    const cached = this.goalCache.get(key);
    if (cached) return cached;
    const goal = this.computeGoal(p, now);
    this.goalCache.set(key, goal);
    return goal;
  }

  computeGoal(p, now) {
    const spectate = { kind: 'spectate', target: null, interact: false };
    if (this.game.mode.phase !== 'live' || p?.state !== 'alive') return spectate;
    const view = this.readView(now);
    if (!view.flags.length) return spectate;
    if (!this.teams.get(this.teamOf(p))?.memberSquad) this.plan(now);
    const team = this.teamOf(p);
    const ts = this.teams.get(team);
    if (!ts) return spectate;
    const kit = this.kitOf(p);
    const role = this.roleGoal(p, kit, ts, now);
    if (role) return role;
    const squad = ts.memberSquad?.get(String(p.id));
    const order = squad?.order;
    let flag = order ? view.flags.find(f => f.id === order.flagId) : null;
    if (!flag) flag = this.focusFlag(ts);
    if (!flag) return spectate;
    const target = { id: flag.id, x: flag.x, y: flag.y, z: flag.z, radius: flag.radius, owner: flag.owner, state: flag.state };
    const slot = this.slotOf(p).slot;
    const stance = order?.stance ?? (flag.owner === team ? 'defend' : 'attack');
    const towardEnemy = this.enemyAxis(flag, team);
    // Defend surge: an owned flag being neutralized or fought over, or an
    // all-in home defence, pulls every defender into the capture zone. Only
    // bodies inside the radius stop a capture; the cover ring around it does not.
    const surge = stance === 'defend' && flag.owner === team
      && (flag.state === 'neutralizing' || flag.state === 'contested' || !!order?.allIn);
    if (kit === 'recon' && !surge) {
      const node = this.cover.overwatch(flag.id, p, wrap(towardEnemy + Math.PI), key(p), now);
      if (node && order?.phase !== 'move') {
        this.cover.claim(node, key(p), now);
        return { kind: 'capture', target, interact: false, stance: stance === 'defend' ? 'defend' : 'attack', role: 'overwatch',
          point: { x: node.x, y: node.y, z: node.z },
          arrive: 2, lookYaw: bearing(node, flag) };
      }
    }
    if (stance === 'attack' && order?.staging && order.phase !== 'push') {
      const a = slot * 1.9 + squad.id;
      const point = { x: order.staging.x + Math.cos(a) * (2 + slot), y: order.staging.y, z: order.staging.z + Math.sin(a) * (2 + slot) };
      return { kind: 'capture', target, interact: false, stance: 'stage', point: this.walkablePoint(point) ?? order.staging,
        arrive: order.phase === 'stage' ? 3 : 5, lookYaw: bearing(order.staging, flag) };
    }
    if (stance === 'defend') {
      const threat = this.threatOrigin(flag, ts);
      const threatYaw = bearing(flag, threat);
      // In a surge only cover inside the zone (bots.js counts 0.85 r as in) qualifies.
      const node = this.cover.cover(flag.id, p, threatYaw, key(p), now,
        surge ? { preferDist: flag.radius * 0.5, maxDist: flag.radius * 0.85 - 1.5, maxDy: 6 } : undefined);
      if (node) {
        this.cover.claim(node, key(p), now);
        return { kind: 'capture', target, interact: false, stance: 'defend', point: { x: node.x, y: node.y, z: node.z },
          arrive: 1.4, lookYaw: bearing(node, threat), crouch: node.peekMask !== 0 };
      }
    }
    // Push (or plain hold): spread inside the zone so the squad covers several angles.
    const angle = stableHash(`${p.id}`) % 360 * Math.PI / 180;
    const r = flag.radius * (0.2 + 0.25 * ((slot % 3) / 2));
    let point = this.walkablePoint({ x: flag.x + Math.cos(angle) * r, y: flag.y, z: flag.z + Math.sin(angle) * r }) ?? target;
    if (KITS[kit]?.aura === 'heal' && squad && !surge) {
      // Medic: no body to revive, so it stays on the squad leader to keep the heal aura on
      // someone, as long as that spot is still inside the zone it was sent to (pushers and
      // a defend surge go into the circle like everyone).
      const leader = squad.members[0] !== String(p.id) ? this.game.entities.get(squad.members[0]) : null;
      if (leader?.state === 'alive' && !leader.vehicleId && finitePoint(leader) && flat(leader, p) < 120) {
        const back = Number.isFinite(leader.yaw) ? leader.yaw : bearing(flag, leader);
        const follow = this.walkablePoint({ x: leader.x + Math.sin(back) * MEDIC_FOLLOW_DIST, y: leader.y,
          z: leader.z + Math.cos(back) * MEDIC_FOLLOW_DIST });
        if (follow && flat(follow, flag) <= flag.radius * 0.85) point = follow;
      }
    }
    if (kit === 'support' && stance === 'attack') {
      // Support trails the squad by a few metres, keeping the resupply aura on it.
      const centroid = squad ? this.squadCentroid(squad) : null;
      if (centroid && flat(centroid, flag) > flag.radius) {
        const back = bearing(flag, centroid);
        point = this.walkablePoint({ x: centroid.x - Math.sin(back) * 5, y: centroid.y, z: centroid.z - Math.cos(back) * 5 }) ?? point;
      }
    }
    return { kind: 'capture', target, interact: false, stance: stance === 'defend' ? 'defend' : 'attack', point,
      arrive: 2.5, lookYaw: towardEnemy };
  }

  kitOf(p) {
    return kitOfPlayer(this.game, p) ?? this.kitFor(p);
  }

  /** Bearing from a flag toward the enemy: the nearest enemy-owned flag, else the enemy HQ. */
  enemyAxis(flag, team) {
    const view = this.view;
    const enemyFlags = view.flags.filter(f => f.owner && f.owner !== team && f.id !== flag.id);
    const target = enemyFlags.sort((a, b) => flat(a, flag) - flat(b, flag))[0] ?? view.bases?.[opposite(team)];
    return target ? bearing(flag, target) : 0;
  }

  /** Where attackers of a flag come from: known enemies near it, else the enemy side. */
  threatOrigin(flag, ts) {
    const near = ts.knowledge.filter(k => flat(k, flag) <= DEFEND_ALERT_RADIUS * 1.5);
    if (near.length) {
      const x = near.reduce((s, k) => s + k.x, 0) / near.length, z = near.reduce((s, k) => s + k.z, 0) / near.length;
      if (Math.hypot(x - flag.x, z - flag.z) > 2) return { x, z };
    }
    const yaw = this.enemyAxis(flag, ts.team);
    return { x: flag.x - Math.sin(yaw) * 50, z: flag.z - Math.cos(yaw) * 50 };
  }

  /** A Medic (revive ability) revives a downed teammate in reach; an engineer repairs a damaged friendly hull. */
  roleGoal(p, kit, ts, now) {
    if (!this.game.mode.conquestIntent) return null;
    const id = key(p);
    if (KITS[kit]?.ability === 'revive') {
      let best = null;
      for (const body of conquestRoles(this.game)?.downedBodies?.(ts.team) ?? []) {
        if (String(body.id) === id || !(body.until > now + 600)) continue;
        // A body in the river or on a ledge no walker reaches is left alone.
        if (this.game.fluidAt(Math.floor(body.x), Math.floor(body.y + 0.3), Math.floor(body.z))) continue;
        const d = flat(body, p);
        if (d > REVIVE_RANGE || this.claimedByOther(`revive:${body.id}`, id, now) || this.supportGivenUp(id, `revive:${body.id}`, now)) continue;
        if (!this.supportReachable(p, body, `revive:${body.id}`, now)) continue;
        if (!best || d < best.d) best = { body, d };
      }
      // Reach is the server's 3D feet distance (KIT_ROLE_RULES.reviveRange): the walk ends on
      // top of the body, and a body the bot cannot get that close to stalls out like a far one.
      const reach3 = KIT_ROLE_RULES.reviveRange - REVIVE_REACH_SLACK;
      const d3 = best && Math.hypot(best.d, best.body.y - p.y);
      if (best && !this.supportStalled(id, `revive:${best.body.id}`, d3, reach3, now)) {
        this.claimRole(`revive:${best.body.id}`, id, now);
        const body = { x: best.body.x, y: best.body.y, z: best.body.z };
        return { kind: 'revive', target: body, interact: false, role: 'support', point: body, arrive: REVIVE_ARRIVE,
          support: { type: 'support', support: 'revive', targetId: String(best.body.id) }, reach: 1.8, reach3 };
      }
    }
    if (KITS[kit]?.aura === 'heal') {
      const mate = this.hurtMate(p, ts, now);
      if (mate) {
        // Stand next to the hurt mate so the heal aura (healRadius) covers it between fights.
        this.claimRole(`heal:${mate.id}`, id, now);
        const point = { x: mate.x, y: mate.y, z: mate.z };
        return { kind: 'heal', target: point, interact: false, role: 'support', point, arrive: HEAL_ARRIVE, healId: String(mate.id) };
      }
    }
    if (kit === 'engineer') {
      let best = null;
      for (const v of this.game.vehicles?.vehicles.values() ?? []) {
        if (v.team !== ts.team || !(v.hp > 0) || v.hp / hullMaxHp(v) >= REPAIR_BELOW) continue;
        if (Math.hypot(v.vx || 0, v.vz || 0) > 2 || (isAircraftType(v.type) && v.grounded === false)) continue;
        const d = flat(v, p);
        if (d > REPAIR_RANGE || this.claimedByOther(`repair:${v.id}`, id, now) || this.supportGivenUp(id, `repair:${v.id}`, now)) continue;
        // A hull in the river (or knocked under a deck) is out of a walker's reach.
        if (this.game.fluidAt(Math.floor(v.x), Math.floor(v.y + 0.5), Math.floor(v.z))) continue;
        if (!best || d < best.d) best = { v, d };
      }
      const repairPoint = best && (() => {
        const v = best.v, r = (VEHICLE_RULES[v.type]?.radius ?? 2.5) + 1;
        const side = bearing(v, p);
        return this.walkablePoint({ x: v.x - Math.sin(side) * r, y: v.y, z: v.z - Math.cos(side) * r })
          ?? { x: v.x - Math.sin(side) * r, y: p.y, z: v.z - Math.cos(side) * r };
      })();
      if (best && (!this.supportReachable(p, repairPoint, `repair:${best.v.id}`, now) || Math.abs(repairPoint.y - best.v.y) > 4)) {
        this.supportBlocked.set(`${id}|repair:${best.v.id}`, now + SUPPORT_BLOCK_MS);
        best = null;
      }
      if (best && !this.supportStalled(id, `repair:${best.v.id}`, flat(repairPoint, p), 2.5, now)) {
        this.claimRole(`repair:${best.v.id}`, id, now);
        const v = best.v, point = repairPoint;
        return { kind: 'repair', target: { x: v.x, y: v.y, z: v.z, id: v.id }, interact: false, role: 'support', point, arrive: 1.2,
          support: { type: 'support', support: 'repair', targetId: String(v.id) }, reach: 3.2 };
      }
    }
    return null;
  }

  /**
   * Medic heal target: the most hurt living, on-foot teammate (bot or human)
   * under HEAL_SEEK_BELOW of its maximum HP within HEAL_SEEK_RANGE that no
   * other Medic is already walking to, or null. A Medic standing in a flag that is
   * not its team's or is being fought over only looks HEAL_ZONE_RANGE around it,
   * so healing never pulls it off a capture.
   */
  hurtMate(p, ts, now) {
    const id = key(p);
    const inFight = (this.view?.flags ?? []).some(f => (f.owner !== ts.team || f.state !== 'idle')
      && flat(f, p) <= f.radius && Math.abs(f.y - p.y) <= 8);
    const range = inFight ? HEAL_ZONE_RANGE : HEAL_SEEK_RANGE;
    let best = null;
    for (const mate of this.game.entities.values()) {
      if (mate === p || String(mate.id) === id || mate.state !== 'alive' || mate.vehicleId || this.teamOf(mate) !== ts.team) continue;
      const max = Number.isFinite(mate.maxHp) && mate.maxHp > 0 ? mate.maxHp : 100;
      const share = Number.isFinite(mate.hp) ? mate.hp / max : 1;
      if (!(share < HEAL_SEEK_BELOW) || !finitePoint(mate) || Math.abs(mate.y - p.y) > 6) continue;
      const d = flat(mate, p);
      if (d > range || this.claimedByOther(`heal:${mate.id}`, id, now)) continue;
      const score = d + share * 30;
      if (!best || score < best.score) best = { mate, score };
    }
    return best?.mate ?? null;
  }

  /** Whether bot `id` gave up on support target `name` recently (supportStalled). */
  supportGivenUp(id, name, now) {
    const until = this.supportBlocked.get(`${id}|${name}`);
    if (until === undefined) return false;
    if (until > now) return true;
    this.supportBlocked.delete(`${id}|${name}`);
    return false;
  }

  /**
   * Track a revive/repair walk: true (and the target is blocked for this bot)
   * when it has not come 1 m closer for SUPPORT_STALL_MS while out of `reach`.
   */
  supportStalled(id, name, d, reach, now) {
    const tries = this.supportTries.get(id);
    if (!tries || tries.name !== name) { this.supportTries.set(id, { name, best: d, at: now }); return false; }
    if (d <= reach || d < tries.best - 1) { tries.best = Math.min(tries.best, d); tries.at = now; return false; }
    if (now - tries.at < SUPPORT_STALL_MS) return false;
    this.supportTries.delete(id);
    this.supportBlocked.set(`${id}|${name}`, now + SUPPORT_BLOCK_MS);
    return true;
  }

  /**
   * Surface maps: a support point a walker at `p` can reach, i.e. footing in
   * the same navigation region as the bot (a pit or a sealed ledge is not).
   */
  supportReachable(p, point, name, now) {
    const nav = surfaceNavigation(this.game.world);
    if (!nav || !point) return true;
    const key = `${p.id}|${name}`, cached = this.supportReach.get(key);
    if (cached && now - cached.at < 1000) return cached.ok;
    const from = nav.startNode(p), to = nav.nodeAt(point, 2);
    const ok = from >= 0 && to >= 0 && nav.component[from] === nav.component[to] && Math.abs(nav.height[to] - point.y) <= 3;
    if (this.supportReach.size > 256) this.supportReach.clear();
    this.supportReach.set(key, { at: now, ok });
    return ok;
  }

  claimedByOther(name, id, now) {
    const claim = this.roleClaims.get(name);
    return !!claim && claim.id !== id && claim.until > now;
  }
  claimRole(name, id, now) { this.roleClaims.set(name, { id, until: now + 1500 }); }

  /** Yaw a seated or idle crew should watch: fresh damage, known enemies, else the focus flag. */
  threatAxis(p) {
    const br = this.manager.brains.find(b => b.id === String(p.id));
    const now = this.game.now;
    if (br?.damageFrom && Number.isFinite(br.damageFrom.x) && now - br.damageFrom.at < 5000) return bearing(p, br.damageFrom);
    const ts = this.teams.get(this.teamOf(p));
    if (!ts) return null;
    const near = ts.knowledge.filter(k => flat(k, p) < 160).sort((a, b) => flat(a, p) - flat(b, p))[0];
    if (near) return bearing(p, near);
    const flag = this.focusFlag(ts);
    if (!flag) return null;
    return flat(p, flag) > flag.radius * 1.5 ? bearing(p, flag) : this.enemyAxis(flag, ts.team);
  }

  /**
   * Nearest enemy position the team knows (sightings, spotted marks, damage
   * sources) within `range` of a bot, or null. Bots turn their eyes toward
   * called-out contacts the way players react to spotted markers.
   */
  knownThreat(p, range) {
    const ts = this.teams.get(this.teamOf(p));
    if (!ts?.knowledge?.length) return null;
    let best = null, bestD = range;
    for (const k of ts.knowledge) {
      const d = flat(k, p);
      if (d < bestD && d > 3) { bestD = d; best = k; }
    }
    return best;
  }

  /** Cover close to a bot that shields it from a threat, or null. */
  coverFrom(p, threat, goal) {
    if (!finitePoint(threat)) return null;
    const now = this.game.now;
    const node = this.cover.coverNear(p, bearing(p, threat), key(p), now, 22);
    if (!node) return null;
    this.cover.claim(node, key(p), now, 5000);
    return { x: node.x, y: node.y, z: node.z };
  }

  /** Terrain changed: refresh cover around affected flags. */
  terrainChanged(columns, sx) { this.cover.markChanged(columns, sx); }
}

const key = p => String(p?.id);

/** Director object for ModeController.setBotDirector (spec 3.5). */
export function createBotDirector(commander) {
  return {
    goalFor: player => commander.goalFor(player),
    deployFor: player => commander.deployFor(player),
  };
}
