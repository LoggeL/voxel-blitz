// Titanfall bots (docs/titanfall.md §9). Bots play as pilots through the
// combined-arms brain in bots.js (isCombinedArms: threat picking over pilots and
// hulls, AT weapon choice, the 25 m stand-off); this module adds what only a
// titanfall pilot does, with the same intents and inputs a human sends:
//
//  - loadout: one seeded random pick per bot (primary, AT weapon, stim or
//    cloak, titan), sent on the first live tick so the fresh life takes it;
//  - call: meter full, on the ground and out of combat for 1 s, the bot looks
//    at an open spot 8-20 m ahead inside the play area (botBounds) and calls;
//    a refused call tries another heading (4 tries, then a pause);
//  - embark: walk to the landed titan when no enemy is within 15 m and enter;
//  - drive: the seat fights through applyMountedCombat (titan option: cockpit
//    sight, railgun charge); afterMounted walks the hull (route, engagement
//    band, strafe, titan separation, footprint feelers round pilot-sized
//    doors, stuck recovery along the most open heading with a detour,
//    bounds) and fires the abilities on simple triggers; a doomed titan is
//    ejected from at doom start with a difficulty-scaled chance;
//  - stand-off: a pilot fighting a titan moves between firing spots 28-42 m
//    out (standoffSpot, used by bots.js); a pilot outside botBounds hops back in;
//  - rodeo: at normal difficulty and above a bot sometimes runs to an enemy
//    titan's back and jumps once the arc meets the upper hull (the server grabs
//    it on contact; a double jump only when the falling arc would miss), rips
//    the battery, then carries it to a friendly titan and inserts it;
//  - battery caches (Ashfall): a quiet pilot fetches a cached battery for a
//    friendly titan short of shield and carries it there;
//  - pilot tactical: stim or cloak while falling back or closing on a titan.
// Wallrun, grapple and slide are not used by bots (v1).

import { isTitanfall } from '../shared/modes.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { TITAN_TYPE_IDS, TITAN_PILOT_PRIMARIES, TITAN_PILOT_AT, isTitanType, packTitanLoadout } from '../shared/titan-contract.js';
import { TITAN_RULES, titanFrame, placeWalker, rodeoArcMounts } from '../shared/vehicle-handling/titan.js';
import { vehicleMaxHp } from '../shared/vehicle-defs.js';
import { vehicleLocalPoint } from '../shared/vehicles.js';
import { isSolidBlock } from '../shared/worlddata.js';
import { FLUID_BLOCKS } from '../shared/world/blocks.js';
import { raycastVoxels } from '../shared/raycast.js';
import { mulberry32 } from '../shared/noise.js';
import { botDifficulty } from '../shared/bot-difficulty.js';
import { insertDistance } from './sim/titanfall/rodeo.js';
import { abilityReadiness } from './sim/titanfall/titan-abilities.js';
import { PILOT_RULES } from '../shared/pilot-movement.js';
import { PHYSICS } from '../shared/player-movement.js';
import { WALKER, boardingGoal, walkerControls, walkerWaypoint } from './bot-vehicle-driving.js';
import { navigationWaypoint } from './bot-navigation.js';

const TAU = Math.PI * 2;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const bearing = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
const rotate = (x, z, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - z * s, x * s + z * c]; };
const hashSeed = text => { let h = 2166136261; for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h || 1; };

const LOADOUT_SEED = 0x7417a11;
const BOT_TACTICALS = Object.freeze(['stim', 'cloak']);
const DIFFICULTY_RANK = Object.freeze({ easy: 0, normal: 1, hard: 2 });
const CALL_QUIET_MS = 1000;        // out of combat this long before a call
const CALL_TRIES = 4;              // headings tried before a pause
const CALL_RETRY_MS = 3000;
const CALL_DISTANCES = Object.freeze([12, 16, 9, 20]);
const CALL_YAWS = Object.freeze([0, 0.9, -0.9, 1.8, -1.8, Math.PI, 2.6, -2.6]);
const CALL_INSET = 10;             // m inside the play area edge for a drop point
const EXIT_HEADINGS = 16;          // headings probed for a way out of a drop point (and of a jam)
const ESCAPE_STEPS = Object.freeze([0.5, 1, 2, 3, 4.5, 6]);  // m a stuck hull probes along each heading
const ESCAPE_YAWS = 8;             // hull yaws (from its own) a stuck hull tries those headings at
const EMBARK_CLEAR = 15;           // no enemy this close before walking to the titan
const BOUNDS_INSET = 14;           // titan destinations stay this far inside botBounds
const EDGE_PUSH = 9;               // a titan nearer the edge than this is pushed back in
const DEST_MS = 4000;              // titan destination refresh
const DEST_ARRIVE = 12;
const IDLE_TURN_RATE = 2.4;        // rad/s hull turn toward the travel heading
const WATCH_MS = 2000;             // titan stuck watchdog window
const STUCK_MOVE = 1.2;            // m moved inside a window below which the hull is stuck
const RECOVER_MS = 1300;
const DETOUR_MS = 8000;            // after repeated recoveries, roam elsewhere this long
const BREAKOUT_MS = 3500;          // ... first walking straight out along the most open heading
const SEPARATION = 7;              // m between hull centres below which titans steer apart
const FEELER_MS = 150;             // local avoidance re-probe interval
const FEELER_STEPS = Object.freeze([2, 4]);   // m ahead the footprint must fit
const FEELER_TURNS = Object.freeze([0.6, 1.2, 1.8]);
const STRAFE_HZ = 0.35;
const ABILITY_GAP_MS = 350;
const HURT_MS = 1500;
const DEFENSIVE_HP = 0.6;
const DEFENSIVE_HOLD_MS = 2500;
const CORE_RANGE = 50;
const MELEE_RANGE = 6;
const EJECT_CHANCE = Object.freeze({ easy: 0.7, normal: 0.8, hard: 0.9 });
const EJECT_REACTION_MS = Object.freeze({ easy: 900, normal: 650, hard: 450 });   // doom start to the eject
const EJECT_REACTION_JITTER_MS = 400;
const SMOKE_REACTION_JITTER_MS = 700;   // seeded per mount on top of the rider smoke delay
const RODEO_RANGE = 26;            // m to an enemy titan before a bot considers a rodeo
const RODEO_MIN_HP = 50;
const RODEO_HOP_MS = 300;          // pinned this long on a run: hop
const RODEO_COMMIT = 8;            // m from the back spot inside which a hurt pilot keeps going
const RODEO_STALL_MS = 2500;      // a run that gains no ground this long is given up
const RODEO_CHANCE = Object.freeze({ normal: 0.45, hard: 0.6 });
const RODEO_JUMP_DIST = 3;         // m from the back spot: a bot right there always goes for it
const RODEO_LEAD_S = 0.7;          // the run aims where the back spot will be, at most this far ahead
const RODEO_CENTRE = 0.5;          // × hull half-width: the lane behind the back the run keeps to
const RODEO_MAX_RISE = 2;          // m a hull may stand above the pilot's feet for a run to go on
const PILOT_JUMP_VY = PHYSICS.jump;  // ground jump speed (pilot rules keep the stock jump)
const RODEO_GIVE_UP_MS = 9000;
const RODEO_PAUSE_MS = 3000;       // a run given up (stalled, out of time) leaves that titan alone this long
const RIDE_MAX_MS = 9000;
const INSERT_RANGE = 80;
const STANDOFF_MIN = 28, STANDOFF_MAX = 42, STANDOFF_MS = 5000;
const RETURN_INSET = 6;            // m inside botBounds a stray pilot heads for
const TAC_GAP_MS = 1200;
// Rodeo perches (mapMeta.climbs, Ashfall §14): a quiet pilot now and then walks up
// the nearest free perch stair, holds the deck as overwatch, and leaps onto an enemy
// titan that walks into reach below.
const PERCH_ROLL_MS = 5000;        // between perch rolls of an idle pilot
const PERCH_CHANCE = 0.3;          // per roll
const PERCH_RANGE = 48;            // m (flat) to the stair foot of a perch worth walking to
const PERCH_QUIET_MS = 3000;       // out of combat this long before a perch trip starts
const PERCH_HOLD_MS = [8000, 12000];   // a hold plus a climb stays inside the 20 s stall watch
const PERCH_TRIP_MS = 30000;       // a trip that has not reached the deck by then is given up
const PERCH_EXIT_MS = 8000;        // after the hold: walk back down the stair for up to this long
const PERCH_STRAY = 3;             // m (flat) from a stair top or deck centre: a stray pilot up there walks down too
const PERCH_LEAP = 11;             // m (flat) from the back spot: a perched pilot leaps for it
const PERCH_ABOVE = 3;             // m above the street: the pilot stands on a perch
// Battery caches (mapMeta.batteryCaches, Ashfall §14): fetched for a friendly titan short of shield.
const CACHE_ROLL_MS = 4000;        // between cache checks of an idle pilot
const CACHE_RANGE = 40;            // m (flat) to a stocked cache worth walking to
const CACHE_QUIET_MS = 3000;       // out of combat this long before a cache trip starts
const CACHE_TRIP_MS = 25000;       // a trip that has not picked the battery up by then is given up
const HOLD = Object.freeze({ sprint: 1, defensive: 2 });
/** Tactical triggers per titan: the distance band [min, max] to the target in which it is used. */
const TACTICAL_BAND = Object.freeze({ titan_ion: [0, 30], titan_scorch: [0, 28], titan_northstar: [25, 120], titan_ronin: [0, 28] });

export class TitanfallBots {
  constructor(game, manager = null) {
    this.game = game;
    this.manager = manager;
    this.states = new Map();
  }

  get titans() { return this.game.vehicles?.titans ?? null; }
  active() { return isTitanfall(this.game.mode?.mode) && !!this.titans; }
  release(id) { this.states.delete(id); }
  clear() { this.states.clear(); }

  update(brains, now) {
    if (!this.active()) { if (this.states.size) this.clear(); return; }
    void now;
    const ids = new Set(brains.map(br => br.id));
    for (const id of this.states.keys()) if (!ids.has(id)) this.states.delete(id);
  }

  stateFor(br) {
    let s = this.states.get(br.id);
    if (!s) {
      const rng = mulberry32((hashSeed(br.id) ^ LOADOUT_SEED) >>> 0);
      const pick = list => list[Math.floor(rng() * list.length) % list.length];
      const primary = pick(TITAN_PILOT_PRIMARIES), at = pick(TITAN_PILOT_AT), tactical = pick(BOT_TACTICALS), titan = pick(TITAN_TYPE_IDS);
      s = { rng, lives: null, loadoutSent: false, combatAt: -Infinity, titanType: titan,
        loadout: packTitanLoadout({ primary, at, tactical, titan }),
        call: null, callTries: 0, callRetryAt: 0, rodeo: null, rolls: new Map(), rodeoPause: new Map(), jumpAt: 0, doubled: false,
        lastJump: false, titan: null, ride: null, tacAt: 0 };
      this.states.set(br.id, s);
    }
    return s;
  }

  /** A titanfall intent as the lobby would deliver it (bots skip the per-member rate gaps). */
  intent(p, type, value = null) { return this.game.titanfallIntent?.(p.id, { type, value }) === true; }
  teamOf(p) { return this.game.vehicles.teamOf(p) ?? p.team; }

  /**
   * Per-bot titanfall decisions before the infantry brain. Returns null (plain
   * pilot), `{ board }` (walk there, fighting on the way; `enter` when in reach),
   * `{ hold: true }` (inputs are set; skip the brain this tick) or the seated
   * `{ vehicle, seatId, weapon, titan, heading }` for the mounted path.
   */
  think(br, p, goal, now, dtS, inp) {
    if (!this.active() || this.game.mode.phase !== 'live' || p.state !== 'alive') return null;
    const s = this.stateFor(br);
    if (s.lives !== p.lives) {
      s.lives = p.lives; s.call = null; s.callTries = 0; s.rodeo = null; s.rolls.clear(); s.rodeoPause.clear(); s.ride = null; s.titan = null;
      s.perch = null; s.perchExit = null; s.cacheTrip = null;
    }
    if (!s.loadoutSent) { s.loadoutSent = true; this.intent(p, 'loadout', s.loadout); }
    if (br.enemyId || br.state === 'fight') s.combatAt = now;
    const vehicles = this.game.vehicles.vehicles;
    if (p.vehicleId) {
      const v = vehicles.get(p.vehicleId);
      return v && isTitanType(v.type) ? this.pilotTitan(br, p, v, s, now, inp) : null;
    }
    s.titan = null;
    if (p.rodeoVehicleId) { this.ride(br, p, s, now, inp); return { hold: true }; }
    s.ride = null;
    const intent = this.onFoot(br, p, s, now, inp);
    s.lastJump = !!inp.keys.jump;
    return intent;
  }

  // ---- pilot on foot ----------------------------------------------------------------

  onFoot(br, p, s, now, inp) {
    const titans = this.titans;
    if (this.returnToArea(p, inp)) return { hold: true };
    if (p.tfBattery) {
      const insert = this.insertGoal(br, p, inp);
      if (insert) return insert;
    }
    const own = titans.ownedBy(p.id);
    if (own && !own.dropping && own.hp > 0 && !own.doomed && !(own.landedUntil > now) && !this.enemyNear(p, EMBARK_CLEAR)) {
      s.call = null;
      return { board: { ...boardingGoal(this.game, p, own, 'driver'), rush: true } };
    }
    // Titanfall is called from the street: from a perch deck the eye ray finds roofs no pilot route reaches.
    if (!own && !this.perched(p) && this.callTitan(br, p, s, now, inp)) return { hold: true };
    if (this.rodeoRun(br, p, s, now, inp)) return { hold: true };
    this.pilotTactical(br, p, s, now);
    return this.cacheGoal(br, p, s, now) ?? this.perchGoal(br, p, s, now);
  }

  /**
   * Battery caches: `{ board }` toward a stocked cache while a quiet pilot fetches its
   * battery for a friendly titan whose shield is not full, otherwise null. One pilot
   * per cache; the pickup is automatic, and insertGoal carries the battery from there.
   */
  cacheGoal(br, p, s, now) {
    const caches = this.titans.bats?.caches;
    if (!caches?.length || p.tfBattery || s.perch || s.perchExit) { s.cacheTrip = null; return null; }
    if (s.cacheTrip && (now > s.cacheTrip.giveUpAt || !caches[s.cacheTrip.index]?.item)) s.cacheTrip = null;
    if (!s.cacheTrip) {
      if (now < (s.cacheRollAt ?? 0) || now - s.combatAt < CACHE_QUIET_MS) return null;
      s.cacheRollAt = now + CACHE_ROLL_MS;
      const team = this.teamOf(p), cap = v => TITAN_RULES.shieldMaxFrac * vehicleMaxHp(v);
      if (!this.titans.titans().some(v => v.team === team && v.hp > 0 && !v.dropping && !v.doomed && (v.shield ?? 0) < cap(v) - 1)) return null;
      const taken = new Set();
      for (const [id, o] of this.states) if (id !== br.id && o.cacheTrip) taken.add(o.cacheTrip.index);
      let best = null, bestD = CACHE_RANGE;
      for (const c of caches) {
        const d = flat(c, p);
        if (c.item && !taken.has(c.index) && d < bestD) { best = c; bestD = d; }
      }
      if (!best) return null;
      s.cacheTrip = { index: best.index, giveUpAt: now + CACHE_TRIP_MS };
    }
    const c = caches[s.cacheTrip.index];
    return { board: { vehicleId: null, point: { x: c.x, y: c.y, z: c.z }, arrive: 0.4, enter: null, rush: true } };
  }

  /** True while the pilot stands on an upper level (a perch deck) above the street. */
  perched(p) {
    const floor = this.game.world.meta?.navigationFloor;
    return Number.isFinite(floor) && p.grounded !== false && p.y > floor + 1 + PERCH_ABOVE;
  }

  /**
   * Rodeo perches: `{ perch: { point, arrive, lookYaw } }` while the pilot walks
   * to (and holds) its perch deck, otherwise null. A quiet pilot rolls now and
   * then for the nearest free perch whose stair foot is within PERCH_RANGE.
   */
  /** Send a pilot to the perch `id` now (the roll's pick; tests call it directly). */
  assignPerch(br, id, now) {
    const s = this.stateFor(br), climb = this.game.world.meta?.climbs?.find(c => c.id === id);
    s.perch = climb ? { id, climb, giveUpAt: now + PERCH_TRIP_MS, until: Infinity, holdUntil: 0 } : null;
    return s.perch;
  }

  perchGoal(br, p, s, now) {
    const climbs = this.game.world.meta?.climbs;
    if (!Array.isArray(climbs) || !climbs.length || p.tfBattery) { s.perch = null; return null; }
    let perch = s.perch;
    if (perch && (now > perch.until || (!perch.holdUntil && now > perch.giveUpAt))) {
      // A held deck is left down its own stair (a search for a shot heard under the deck
      // would otherwise keep the pilot scanning up there).
      if (perch.holdUntil) s.perchExit = { climb: perch.climb, until: now + PERCH_EXIT_MS };
      s.perch = perch = null; s.perchRollAt = now + PERCH_ROLL_MS * 2;
    }
    if (s.perchExit && (!this.perched(p) || now > s.perchExit.until)) s.perchExit = null;
    // A pilot that reached a deck or the stair top another way (a chase up the stair) has no
    // street route off it: send it down the nearest stair as well.
    if (!perch && !s.perchExit && this.perched(p)) {
      const climb = climbs.find(c => c.points.slice(1).some(q => flat(q, p) < PERCH_STRAY && Math.abs(p.y - q.y) < 1.5));
      if (climb) s.perchExit = { climb, until: now + PERCH_EXIT_MS };
    }
    if (!perch && s.perchExit) {
      const foot = s.perchExit.climb.points[0];
      return { perch: { point: { x: foot.x, y: foot.y, z: foot.z }, arrive: 1.4, lookYaw: s.perchExit.climb.look } };
    }
    if (!perch) {
      if (now < (s.perchRollAt ?? 0) || now - s.combatAt < PERCH_QUIET_MS) return null;
      s.perchRollAt = now + PERCH_ROLL_MS;
      if (s.rng() >= PERCH_CHANCE) return null;
      const taken = new Set();
      for (const [id, o] of this.states) if (id !== br.id && o.perch) taken.add(o.perch.id);
      let best = null, bestD = PERCH_RANGE;
      for (const c of climbs) {
        const d = flat(c.points[0], p);
        if (!taken.has(c.id) && d < bestD) { best = c; bestD = d; }
      }
      if (!best) return null;
      perch = this.assignPerch(br, best.id, now);
    }
    const deck = perch.climb.points[perch.climb.points.length - 1];
    const onDeck = flat(deck, p) < 1.6 && Math.abs(p.y - deck.y) < 1.2;
    if (onDeck && !perch.holdUntil) {
      perch.holdUntil = now + PERCH_HOLD_MS[0] + s.rng() * (PERCH_HOLD_MS[1] - PERCH_HOLD_MS[0]);
      perch.until = perch.holdUntil;
      s.perchedAt = now;
    }
    // Not on the deck yet (or knocked off it): never arrived (the street under the deck is not it);
    // on it, hold within reach of the centre.
    return { perch: { point: { x: deck.x, y: deck.y, z: deck.z }, arrive: onDeck ? 1.4 : -1, lookYaw: perch.climb.look } };
  }

  /**
   * Pilot vs titan (§9 "keep 25 m+"): a firing spot on a ring 28-42 m round the
   * hull, within ±40° of the current bearing, re-picked every 5-8 s so a pilot
   * duelling a parked or auto titan keeps moving. `standable(x, z, y)` returns
   * the ground point or null. Null when no spot is found.
   */
  standoffSpot(br, p, hull, now, standable) {
    const s = this.stateFor(br);
    const cached = s.standoff;
    if (cached && cached.id === hull.id && now < cached.until && flat(cached.point, p) > 2.5) return cached.point;
    const away = Math.atan2(p.x - hull.x, p.z - hull.z);
    const b = this.game.mode.policy?.botBounds?.() ?? null;
    let point = null;
    for (let i = 0; i < 4 && !point; i++) {
      const angle = away + (s.rng() - 0.5) * 1.4, radius = STANDOFF_MIN + s.rng() * (STANDOFF_MAX - STANDOFF_MIN);
      let x = hull.x + Math.sin(angle) * radius, z = hull.z + Math.cos(angle) * radius;
      if (b) { x = clamp(x, b.minX + CALL_INSET, b.maxX - CALL_INSET); z = clamp(z, b.minZ + CALL_INSET, b.maxZ - CALL_INSET); }
      point = standable(x, z, p.y);
    }
    s.standoff = point ? { id: hull.id, point, until: now + STANDOFF_MS + s.rng() * 3000 } : null;
    return point;
  }

  /**
   * A pilot outside botBounds (a spawn or an eject that lands past frontier's
   * edge) sprints straight back in before the out-of-bounds timer runs out.
   */
  returnToArea(p, inp) {
    const b = this.game.mode.policy?.botBounds?.();
    if (!b || (p.x >= b.minX + 1 && p.x <= b.maxX - 1 && p.z >= b.minZ + 1 && p.z <= b.maxZ - 1)) return false;
    const to = { x: clamp(p.x, b.minX + RETURN_INSET, b.maxX - RETURN_INSET), z: clamp(p.z, b.minZ + RETURN_INSET, b.maxZ - RETURN_INSET) };
    for (const key of Object.keys(inp.keys)) inp.keys[key] = false;
    inp.wantFire = false; inp.wantAds = false;
    inp.yaw = bearing(p, to); inp.pitch = 0;
    // Hop the whole way: a lip or a wall at the edge must not hold the pilot out there.
    inp.keys.f = true; inp.keys.sprint = true; inp.keys.jump = !!p.grounded;
    return true;
  }

  /** Any live enemy pilot on foot or enemy titan within `radius` (flat). */
  enemyNear(p, radius) {
    const team = this.teamOf(p);
    for (const o of this.game.entities.values()) {
      if (o.state !== 'alive' || o.vehicleId || !this.game.mode.isEnemy(p, o)) continue;
      if (flat(o, p) <= radius) return true;
    }
    for (const v of this.titans.titans()) {
      if (v.team !== team && v.hp > 0 && !v.dropping && flat(v, p) <= radius) return true;
    }
    return false;
  }

  /** Stim or cloak while falling back hurt or while closing on a titan for a rodeo. */
  pilotTactical(br, p, s, now) {
    const kind = p.pilotTac?.kind;
    if (kind !== 'stim' && kind !== 'cloak') return;
    if (now < s.tacAt || !(now < br.retreatUntil || s.rodeo)) return;
    s.tacAt = now + TAC_GAP_MS;
    this.intent(p, 'tac');
  }

  // ---- titanfall call -----------------------------------------------------------------

  /** Meter full, grounded, quiet for 1 s: aim at an open spot ahead, then call on the next tick. */
  callTitan(br, p, s, now, inp) {
    const policy = this.game.mode.policy, titans = this.titans;
    if (!(policy?.titanMeter?.(p) >= 1) || titans.holdsTitan(p.id)) { s.call = null; return false; }
    if (now < s.callRetryAt || !p.grounded || p.embarkUntil > now || now - s.combatAt < CALL_QUIET_MS) { s.call = null; return false; }
    const team = this.teamOf(p);
    // A slot per human teammate without a titan stays free (TitanSystem.humanReserve).
    if (titans.teamTitans(team) >= titans.bayCap(team) - (titans.humanReserve?.(team) ?? 0)) { s.call = null; return false; }
    if (s.call) {
      // The aim was applied by last tick's input: the server ray now runs along it.
      const input = p.input;
      if (input && Math.abs(wrap(input.yaw - s.call.yaw)) < 1e-6 && Math.abs(input.pitch - s.call.pitch) < 1e-6) {
        const ok = this.intent(p, 'call', 1);
        s.call = null;
        if (ok) { s.callTries = 0; return false; }
        if (++s.callTries >= CALL_TRIES) { s.callTries = 0; s.callRetryAt = now + CALL_RETRY_MS; return false; }
      } else if (now - s.call.at > 400) s.call = null;
    }
    if (!s.call) {
      const aim = this.callAim(p, s);
      if (!aim) { s.callTries = 0; s.callRetryAt = now + CALL_RETRY_MS; return false; }
      s.call = { ...aim, at: now };
    }
    for (const key of Object.keys(inp.keys)) inp.keys[key] = false;
    inp.yaw = s.call.yaw; inp.pitch = s.call.pitch;
    inp.wantFire = false; inp.wantAds = false;
    br.intendsMove = false;
    return true;
  }

  /**
   * A heading/pitch whose eye ray lands 8-20 m out on open, level, dry ground
   * inside the play area, from which the landed hull can walk out.
   */
  callAim(p, s) {
    const world = this.game.world, area = this.titans.area(), b = area?.bounds;
    const eye = [p.eyeX ?? p.x, p.eyeY ?? p.y + 1.62, p.eyeZ ?? p.z];
    const block = (x, y, z) => world.getBlock(x, y, z);
    const solid = (x, y, z) => { const v = block(x, y, z); return isSolidBlock(v) || FLUID_BLOCKS.has(v); };
    const sy = Number.isFinite(area?.sy) ? area.sy : world.dimensions?.sy ?? 80;
    const top = (x, z, from) => {
      for (let y = Math.min(sy - 1, Math.floor(from) + 4); y >= Math.max(0, Math.floor(from) - 8); y--) {
        const v = block(Math.floor(x), y, Math.floor(z));
        if (FLUID_BLOCKS.has(v)) return null;
        if (isSolidBlock(v)) return y + 1;
      }
      return null;
    };
    for (let k = 0; k < CALL_YAWS.length; k++) {
      const yaw = wrap(p.yaw + CALL_YAWS[(k + s.callTries * 2) % CALL_YAWS.length]);
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      for (const d of CALL_DISTANCES) {
        const x = p.x + fx * d, z = p.z + fz * d;
        if (b && (x < b.minX + CALL_INSET || x > b.maxX - CALL_INSET || z < b.minZ + CALL_INSET || z > b.maxZ - CALL_INSET)) continue;
        const y = top(x, z, p.y);
        if (y == null || !this.openGround(x, y, z)) continue;
        const dx = x - eye[0], dz = z - eye[2], dist = Math.hypot(dx, dz);
        const pitch = Math.atan2(y - eye[1], dist);
        const dy = Math.sin(pitch), c = Math.cos(pitch);
        const hit = raycastVoxels(solid, ...eye, fx * c, dy, fz * c, 160);
        if (!hit || FLUID_BLOCKS.has(block(hit.x, hit.y, hit.z))) continue;
        if (Math.hypot(eye[0] + fx * c * hit.t - x, eye[2] + fz * c * hit.t - z) > 2) continue;
        if (!this.wayOut(x, y, z, s.titanType)) continue;
        return { yaw, pitch };
      }
    }
    return null;
  }

  /** Level, dry ground with open sky over a titan footprint centred at (x, z). */
  openGround(x, y, z) {
    const world = this.game.world, clear = TITAN_RULES.drop.skyClearVoxels + 1;
    for (const [ox, oz] of [[0, 0], [-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) {
      const bx = Math.floor(x + ox), bz = Math.floor(z + oz);
      let ground = null;
      for (let gy = y + 1; gy >= y - 2; gy--) {
        const v = world.getBlock(bx, gy, bz);
        if (FLUID_BLOCKS.has(v)) return false;
        if (isSolidBlock(v)) { ground = gy + 1; break; }
      }
      if (ground == null || Math.abs(ground - y) > 1) return false;
      for (let gy = ground; gy < ground + clear; gy++) if (isSolidBlock(world.getBlock(bx, gy, bz))) return false;
    }
    return true;
  }

  /**
   * True when a `type` hull standing at (x, y, z) walks 10 m out on one of
   * 16 headings (TitanSystem.wayOut): open sky over the footprint is not
   * enough (on harbor a hull fits down through a 6-8 m gap in the roof grid,
   * then cannot pass under the beams round it). One lane out is enough: the
   * crate lanes there leave most open spots a single long heading.
   */
  wayOut(x, y, z, type) {
    // The same test TitanSystem.call() refuses 'enclosed' drops with.
    return this.titans.wayOut(type, x, y, z);
  }

  // ---- rodeo and batteries --------------------------------------------------------------

  /** Live, landed enemy titan with no rider and no electric smoke up: a rodeo candidate. */
  rodeoTarget(p, v) {
    return !!v && isTitanType(v.type) && v.hp > 0 && !v.dropping && !v.doomed && !v.riderId && v.team !== this.teamOf(p)
      && !(v.tfAbility?.smokeUntil > this.game.now);
  }

  /** Ground spot right behind a titan's back anchor (hull-local +Z is the rear). */
  backSpot(v, extra = 0.55) {
    const [x, , z] = vehicleLocalPoint({ x: v.x, y: v.y, z: v.z, yaw: v.yaw }, 0, 0, titanFrame(v).hl + extra);
    return { x, y: v.y, z };
  }

  /**
   * Normal difficulty and above: sometimes (once per titan and life) sprint to
   * an enemy titan's back (its own route, the gun down); within 3 m jump,
   * double-jump at the apex and mount once the chest is in reach of the back
   * anchor. Returns true while the run sets the inputs.
   */
  rodeoRun(br, p, s, now, inp) {
    const vehicles = this.game.vehicles.vehicles;
    let v = s.rodeo ? vehicles.get(s.rodeo.id) : null;
    // Hurt pilots do not start (or keep up) a run, unless already close to the back.
    const committed = !!v && flat(this.backSpot(v), p) < RODEO_COMMIT;
    if (p.tfBattery || !((DIFFICULTY_RANK[br.difficulty] ?? 0) >= 1) || (p.hp < RODEO_MIN_HP && !committed)) { s.rodeo = null; return false; }
    if (s.rodeo && (!this.rodeoTarget(p, v) || now > s.rodeo.until)) {
      // Out of time: this titan is left alone a while (a kept roll would restart the same run at once).
      if (v && now > s.rodeo.until) s.rodeoPause.set(v.id, now + RODEO_PAUSE_MS);
      s.rodeo = null; v = null;
    }
    const perched = this.perched(p);
    if (!v) {
      let best = null, bestD = perched ? PERCH_LEAP : RODEO_RANGE;
      for (const o of this.titans.titans()) {
        if (!this.rodeoTarget(p, o) || s.rodeoPause.get(o.id) > now) continue;
        const d = flat(o, p);
        if (d < bestD) { best = o; bestD = d; }
      }
      if (!best) return false;
      // Right at its back (spec: within 3 m) a bot always goes; farther out it rolls once per titan.
      const atBack = flat(this.backSpot(best), p) <= RODEO_JUMP_DIST || perched;
      if (!s.rolls.has(best.id) || atBack) s.rolls.set(best.id, atBack || s.rng() < (RODEO_CHANCE[br.difficulty] ?? 0));
      if (!s.rolls.get(best.id)) return false;
      v = best;
      s.rodeo = { id: v.id, until: now + RODEO_GIVE_UP_MS, nav: { index: br.index } };
    }
    const back = this.backSpot(v), d = flat(back, p);
    // No progress for a while (a route that fails, a body pinned on the hull): give up this titan.
    const run = s.rodeo;
    if (!(run.bestD <= d + 1)) { run.bestD = d; run.progressAt = now; }
    // Close below a hull on a ledge (its back anchor out of a double jump's reach): leave it.
    if (now - run.progressAt > RODEO_STALL_MS || (d < 6 && p.grounded && v.y - p.y > RODEO_MAX_RISE)) {
      s.rodeoPause.set(v.id, now + RODEO_PAUSE_MS); s.rodeo = null; return false;
    }
    // A walking hull outruns a pilot aimed at where its back is now: lead it by the time to get there.
    const hvx = Number.isFinite(v.vx) ? v.vx : 0, hvz = Number.isFinite(v.vz) ? v.vz : 0;
    const lead = Math.min(RODEO_LEAD_S, d / PILOT_RULES.sprint);
    const aim = { x: back.x + hvx * lead, y: back.y, z: back.z + hvz * lead };
    // From a perch the leap goes straight off the deck edge (the route would walk down the stair).
    let to = perched && d <= PERCH_LEAP + 2 ? aim
      : d > 6 ? navigationWaypoint(this.game.world, p, aim, run.nav, now) : this.aroundHull(v, p, aim, run, hvx * lead, hvz * lead);
    if (perched) run.fromPerch = true;
    if (Math.hypot(to.x - p.x, to.z - p.z) < 0.2) to = aim;
    for (const key of Object.keys(inp.keys)) inp.keys[key] = false;
    inp.wantFire = false; inp.wantAds = false;
    if (Math.hypot(to.x - p.x, to.z - p.z) > 0.2) {
      inp.yaw = bearing(p, to);
      inp.keys.f = true;
      // Sprint into the back: a walking titan (4-7.6 m/s) is only caught at sprint speed.
      inp.keys.sprint = d > 2 || (v.speed ?? 0) > 1;
    }
    inp.pitch = 0;
    // Jump once the arc from here (speed relative to the hull) meets the upper hull: the server grabs the pilot.
    this.rodeoJump(p, s, now, inp, v, [hvx, hvz]);
    // Pinned on the ground (a one-voxel lip, a body in the way) while running: hop.
    if (p.grounded && inp.keys.f && Math.hypot(p.vx ?? 0, p.vz ?? 0) < 1) {
      run.slowSince ??= now;
      if (now - run.slowSince > RODEO_HOP_MS) { inp.keys.jump = true; run.slowSince = null; }
    } else run.slowSince = null;
    this.pilotTactical(br, p, s, now);
    br.intendsMove = true;
    return true;
  }

  /** Hull-local position of a pilot (+Z is the rear). */
  hullLocal(v, p) {
    const c = Math.cos(v.yaw), sn = Math.sin(v.yaw), dx = p.x - v.x, dz = p.z - v.z;
    return [dx * c - dz * sn, dx * sn + dz * c];
  }

  /** True when the pilot stands in the hull's 120° front sector (hull-local -Z is forward). */
  inFront(v, p) {
    const [lx, lz] = this.hullLocal(v, p);
    return lz < 0 && Math.abs(lx) < -lz * 1.73;
  }


  /**
   * Close to a titan, the next point of the run, shifted by the run's lead
   * (ox, oz): the (led) back spot from the lane right behind it; from behind
   * but off that lane, a point on the lane 1.3 m behind the rear face (clear
   * of the legs); beside the hull its rear corner; in front of it a flank
   * spot out of the walking hull's path (not led). The side is kept for the run
   * (`run.side`), so a pilot right in front does not dither between them.
   */
  aroundHull(v, p, back, run, ox = 0, oz = 0) {
    const f = titanFrame(v), [lx, lz] = this.hullLocal(v, p), hull = { x: v.x, y: v.y, z: v.z, yaw: v.yaw };
    const at = (x, z, led = true) => { const [wx, , wz] = vehicleLocalPoint(hull, x, 0, z); return { x: wx + (led ? ox : 0), y: v.y, z: wz + (led ? oz : 0) }; };
    if (lz >= f.hl * 0.6 && Math.abs(lx) <= RODEO_CENTRE * f.hw) return back;
    if (lz >= f.hl + 0.8) return at(0, f.hl + 1.3);
    if (!run.side || Math.abs(lx) > f.hw + 0.5) run.side = lx < 0 ? -1 : 1;
    const ahead = lz < -f.hl * 0.2;
    // In front the flank spot is not led: a lead would pull it back into the hull's path.
    return ahead ? at(run.side * (f.hw + 2.2), 0, false) : at(run.side * (f.hw + 1.6), f.hl + 1.3);
  }

  /**
   * Ground jump once its arc meets the upper hull of `v` (moving at `hullVel`);
   * airborne, a fresh press for the double jump only when the falling arc would
   * miss and a double jump's would not (a hull that walked off the pilot).
   */
  rodeoJump(p, s, now, inp, v, hullVel) {
    const vel = [p.vx ?? 0, p.vz ?? 0];
    if (p.grounded) {
      if (now >= s.jumpAt && rodeoArcMounts(p, vel, v, hullVel, PILOT_JUMP_VY)) { inp.keys.jump = true; s.jumpAt = now + 650; s.doubled = false; }
    } else if (!s.doubled && !s.lastJump && now < s.jumpAt + 900
      && !rodeoArcMounts(p, vel, v, hullVel, p.vy ?? 0, TITAN_RULES, 1.2, -4)
      && rodeoArcMounts(p, vel, v, hullVel, PILOT_RULES.doubleJumpVy, TITAN_RULES, 1.2, -4)) {
      inp.keys.jump = true; s.doubled = true;
    }
  }

  /** On an enemy titan's back: rip the battery, shoot the hatch while it is out, get off with it or under smoke. */
  ride(br, p, s, now, inp) {
    const v = this.game.vehicles.vehicles.get(p.rodeoVehicleId);
    for (const key of Object.keys(inp.keys)) inp.keys[key] = false;
    inp.wantFire = false; inp.wantAds = false;
    br.intendsMove = false;
    if (!v) return;
    if (s.ride?.id !== v.id) s.ride = { id: v.id, since: now };
    if (v.tfAbility?.smokeUntil > now || now - s.ride.since > RIDE_MAX_MS) { this.intent(p, 'rodeo', 'dismount'); return; }
    if (!p.tfBattery && !p.tfRip && !v.batteryOut && !v.doomed) this.intent(p, 'rodeo', 'rip');
    if (p.tfBattery && !p.tfRip) { this.intent(p, 'rodeo', 'dismount'); return; }
    if (p.tfRip || !v.batteryOut) return;
    // The battery is out (someone else has it): the hatch takes primary and sidearm fire.
    const primary = WEAPON_IDS.indexOf(p.owned?.[0]);
    if (primary >= 0 && p.weapon !== primary) { inp.switchTo = primary; return; }
    const tx = v.x - p.x, ty = v.y + titanFrame(v).height * 0.75 - (p.eyeY ?? p.y + 1.6), tz = v.z - p.z;
    inp.yaw = Math.atan2(-tx, -tz);
    inp.pitch = clamp(Math.atan2(ty, Math.hypot(tx, tz)), -1.4, 1.4);
    if (p.mag[p.weapon] > 0) inp.wantFire = p.def.mode === 'auto' || !p.triggerPrev;
    else if (p.reserve[p.weapon] > 0) inp.reload = true;
  }

  /** A battery carrier walks to the nearest friendly titan whose shield is not full and inserts it. */
  insertGoal(br, p, inp) {
    const team = this.teamOf(p), cap = v => TITAN_RULES.shieldMaxFrac * vehicleMaxHp(v);
    let best = null, bestD = INSERT_RANGE;
    for (const v of this.titans.titans()) {
      if (v.team !== team || !(v.hp > 0) || v.dropping || v.doomed || !((v.shield ?? 0) < cap(v) - 1)) continue;
      const d = flat(v, p) - (v.owner === String(p.id) ? 20 : 0);
      if (d < bestD) { best = v; bestD = d; }
    }
    if (!best) return null;
    if (p.tfInsert) {
      for (const key of Object.keys(inp.keys)) inp.keys[key] = false;
      br.intendsMove = false;
      return { hold: true };
    }
    if (insertDistance(p, best) <= TITAN_RULES.rodeo.reach) this.intent(p, 'rodeo', 'insert');
    return { board: { vehicleId: best.id, point: this.backSpot(best, 0.7), arrive: 0.6, enter: null, rush: true } };
  }

  // ---- seated: drive and fight --------------------------------------------------------------

  pilotTitan(br, p, v, s, now, inp) {
    for (const key of Object.keys(inp.keys)) inp.keys[key] = false;
    inp.wantFire = false; inp.wantAds = false; inp.reload = false; inp.switchTo = undefined;
    br.intendsMove = false;
    let t = s.titan;
    if (!t || t.vehicleId !== v.id) {
      t = s.titan = { vehicleId: v.id, nav: { index: br.index }, dest: null, destUntil: 0, strafePhase: s.rng() * TAU,
        watchAt: now, watchX: v.x, watchZ: v.z, recoveries: 0, recoverUntil: 0, recoverWish: null,
        lastHp: v.hp + (v.shield ?? 0), hurtAt: -Infinity, abilityAt: 0, dodgeAt: 0, holdDefUntil: 0, doom: null, wish: null };
    }
    const seatId = p.vehicleSeatId ?? 'driver';
    // §9: eject at doom start (a doom often lasts well under a second under fire), with a
    // difficulty-scaled chance rolled once per hull (bot, hull and match seed).
    if (v.doomed && v.hp > 0) {
      if (!t.doom) {
        const roll = mulberry32(hashSeed(`${br.id}:${v.id}:${this.manager?.personalitySeed ?? 0}:eject`));
        // A human-like reaction before the (triple-tap) eject; the doom guard keeps the hull up for 2 s.
        t.doom = { eject: roll() < (EJECT_CHANCE[br.difficulty] ?? EJECT_CHANCE.easy),
          at: now + (EJECT_REACTION_MS[br.difficulty] ?? EJECT_REACTION_MS.easy) + Math.round(roll() * EJECT_REACTION_JITTER_MS) };
      }
      if (t.doom.eject && now >= t.doom.at && this.intent(p, 'eject')) { s.titan = null; return { hold: true }; }
    }
    if (p.embarkUntil > now || v.landedUntil > now) return { vehicle: v, seatId, weapon: false };
    const dest = this.titanDestination(br, p, v, t, now);
    return { vehicle: v, seatId, weapon: true, titan: true, heading: bearing(v, dest) };
  }

  /** Where an idle titan walks: the nearest enemy titan, else the nearest enemy pilot, else a roam spot; inside botBounds. */
  titanDestination(br, p, v, t, now) {
    if (t.dest && now < t.destUntil && flat(t.dest, v) > DEST_ARRIVE) return t.dest;
    // Boxed in on the route toward the enemy: roam somewhere else for a while.
    const detour = t.detourUntil > now;
    const team = this.teamOf(p);
    let best = null, bestD = Infinity;
    for (const o of this.titans.titans()) {
      if (o === v || o.team === team || !(o.hp > 0) || o.dropping) continue;
      const d = flat(o, v);
      if (d < bestD) { best = o; bestD = d; }
    }
    if (!best) {
      for (const o of this.game.entities.values()) {
        if (o.state !== 'alive' || o.vehicleId || !this.game.mode.isEnemy(p, o)) continue;
        const d = flat(o, v);
        if (d < bestD) { best = o; bestD = d; }
      }
    }
    let dest = !detour && best && bestD > DEST_ARRIVE ? { x: best.x, y: best.y, z: best.z }
      : this.manager?.roamSpot?.(br, { x: v.x, y: v.y, z: v.z, yaw: v.yaw }) ?? { x: v.x, y: v.y, z: v.z };
    const b = this.game.mode.policy?.botBounds?.() ?? this.titans.area()?.bounds ?? null;
    if (b) dest = { x: clamp(dest.x, b.minX + BOUNDS_INSET, b.maxX - BOUNDS_INSET), y: dest.y, z: clamp(dest.z, b.minZ + BOUNDS_INSET, b.maxZ - BOUNDS_INSET) };
    t.dest = dest;
    t.destUntil = now + DEST_MS;
    return dest;
  }

  /**
   * After applyMountedCombat set the aim (and trigger): walk the hull and use
   * the abilities. With no target the hull turns toward its travel heading.
   */
  afterMounted(br, p, v, engaged, now, dtS, inp) {
    const s = this.states.get(br.id), t = s?.titan;
    if (!t || t.vehicleId !== v.id || p.vehicleId !== v.id) return;
    const target = engaged?.target ?? null;
    const hp = v.hp + (v.shield ?? 0);
    if (hp < t.lastHp - 0.5) t.hurtAt = now;
    t.lastHp = hp;
    const dest = t.dest ?? { x: v.x, z: v.z };
    let wx = 0, wz = 0, sprint = false;
    if (target) {
      const band = WALKER[v.type] ?? WALKER.titan_ion;
      const dx = target.x - v.x, dz = target.z - v.z, d = Math.hypot(dx, dz) || 1, tx = dx / d, tz = dz / d;
      if (d > band.far) {
        const wp = walkerWaypoint(this.game, v, { x: target.x, y: target.y, z: target.z }, t.nav, now);
        const ex = wp.x - v.x, ez = wp.z - v.z, el = Math.hypot(ex, ez);
        // No route (it hands back the hull's own spot): head straight there, the feelers steer.
        if (el > 0.5) { wx = ex / el; wz = ez / el; } else { wx = tx; wz = tz; }
      } else if (d < band.near) { wx = -tx; wz = -tz; }
      t.strafePhase += dtS * TAU * STRAFE_HZ;
      const side = Math.sin(t.strafePhase) > 0 ? 0.8 : -0.8;
      wx += -tz * side; wz += tx * side;
    } else {
      const wantYaw = t.dest ? bearing(v, dest) : v.yaw;
      const breakout = t.breakout && now < t.breakout.until;
      if (breakout) {
        // Boxed in on the route: walk out along the open heading first (the route led in).
        [wx, wz] = t.breakout.dir;
      } else if (flat(dest, v) > DEST_ARRIVE * 0.5) {
        const wp = walkerWaypoint(this.game, v, dest, t.nav, now);
        const ex = wp.x - v.x, ez = wp.z - v.z, el = Math.hypot(ex, ez);
        const dd = flat(dest, v);
        if (el > 0.5) { wx = ex / el; wz = ez / el; } else { wx = (dest.x - v.x) / dd; wz = (dest.z - v.z) / dd; }
        sprint = flat(dest, v) > 30;
      }
      const heading = Math.hypot(wx, wz) > 0.1 ? Math.atan2(-wx, -wz) : wantYaw;
      const step = IDLE_TURN_RATE * dtS;
      // A breakout keeps the yaw its way out was found at (turning between posts can wedge).
      inp.yaw = breakout ? t.breakout.yaw : wrap(v.yaw + clamp(wrap(heading - v.yaw), -step, step));
      inp.pitch = 0;
    }
    // The route's own wish: the watchdog's "wanted to move" even when a neighbour's push cancels it.
    const routeWish = Math.hypot(wx, wz);
    if (routeWish > 0.01) t.routeDir = [wx / routeWish, wz / routeWish];
    // Titans (either side) closer than SEPARATION steer apart, so two hulls never jam nose to tail.
    for (const o of this.titans.titans()) {
      if (o === v || !(o.hp > 0) || o.dropping) continue;
      const ox = v.x - o.x, oz = v.z - o.z, od = Math.hypot(ox, oz);
      if (od < SEPARATION && od > 0.01) { const w = 1.2 * (SEPARATION - od) / SEPARATION; wx += ox / od * w; wz += oz / od * w; }
    }
    // Stay inside the play area: an edge pushes the wish back in.
    const b = this.game.mode.policy?.botBounds?.() ?? null;
    if (b) {
      if (v.x < b.minX + EDGE_PUSH) wx += 1.5; else if (v.x > b.maxX - EDGE_PUSH) wx -= 1.5;
      if (v.z < b.minZ + EDGE_PUSH) wz += 1.5; else if (v.z > b.maxZ - EDGE_PUSH) wz -= 1.5;
    }
    const len = Math.hypot(wx, wz);
    if (len > 1) { wx /= len; wz /= len; }
    // Local avoidance: the pilot route fits doors a hull does not, so the wish turns to the
    // nearest heading on which the footprint still stands 2 and 4 m ahead.
    if (len > 0.3 && !(t.recoverUntil > now)) [wx, wz] = this.feel(v, t, wx, wz, now);
    // Stuck watchdog: a hull that wanted to move and did not backs off at an angle, then re-plans.
    if (now - t.watchAt >= WATCH_MS) {
      const moved = Math.hypot(v.x - t.watchX, v.z - t.watchZ);
      if (moved < STUCK_MOVE && (t.want ?? 0) > 0.3 && !(t.recoverUntil > now)) {
        const turn = (t.recoveries % 2 ? 1.2 : -1.2) + Math.PI;
        const [ox, oz] = Math.hypot(...t.wish) > 0.3 ? t.wish : (t.routeDir ?? t.wish), c = Math.cos(turn), sn = Math.sin(turn);
        // Back off along the heading the footprint walks farthest on (a hull wedged under an
        // overhang or between posts has one or two), else at an angle away from the wish.
        const out = this.escapeHeading(v, t.routeDir);
        t.recoverYaw = out?.yaw ?? null;
        t.recoverWish = out?.dir ?? [ox * c - oz * sn, ox * sn + oz * c];
        t.recoverUntil = now + RECOVER_MS;
        t.recoveries++;
        t.nav = { index: br.index };
        if (t.recoveries % 2 === 0) {
          t.dest = null; t.detourUntil = now + DETOUR_MS;
          t.breakout = out ? { ...out, until: now + BREAKOUT_MS } : null;
        }
      } else if (moved > 4) t.recoveries = 0;
      t.watchAt = now; t.watchX = v.x; t.watchZ = v.z;
    }
    // Recovery backs off on the current heading: a hull that turns into a neighbour is put back whole.
    if (t.recoverUntil > now && t.recoverWish) { [wx, wz] = t.recoverWish; sprint = false; inp.yaw = t.recoverYaw ?? v.yaw; }
    t.wish = [wx, wz];
    t.want = Math.max(routeWish, Math.hypot(wx, wz));
    walkerControls(inp, inp.yaw, wx, wz);
    let hold = 0;
    if (sprint && !target && (inp.vehicleThrottle ?? 0) > 0.6) hold |= HOLD.sprint;
    if (now < t.holdDefUntil) hold |= HOLD.defensive;
    inp.titanHold = hold;
    this.abilities(br, p, v, t, target, engaged, now, inp);
  }

  /**
   * A way out for a stuck hull: `{ yaw, dir }`, the hull yaw (its own first,
   * then ESCAPE_YAWS - 1 others, which a piloted hull takes at once) and unit
   * heading [x, z] on which the footprint stands, from the hull's own spot, the
   * farthest along ESCAPE_STEPS (at least 3 m) out of EXIT_HEADINGS; ties go to
   * the heading nearest `prefer`. Null when none reaches 3 m. A hull wedged
   * between posts often fits only at another yaw (turning by steps is refused
   * there, each step's footprint overlapping a post). Other hulls count like
   * voxels (TitanSystem.hullBlocked refuses any move, turn included, that
   * overlaps one): a hull pressed nose to tail against a parked titan backs
   * away from it at its own yaw instead of pushing into it.
   */
  escapeHeading(v, prefer = null) {
    const titans = this.titans, world = titans.world, probe = { type: v.type, x: v.x, y: v.y, z: v.z, yaw: v.yaw };
    let best = null, bestScore = -Infinity;
    for (let j = 0; j < ESCAPE_YAWS; j++) {
      const yaw = wrap(v.yaw + j * TAU / ESCAPE_YAWS);
      probe.yaw = yaw; probe.x = v.x; probe.y = v.y; probe.z = v.z;
      if (!Number.isFinite(placeWalker(probe, v.x, v.z, world)) || (j > 0 && titans.hullBlocked(probe, v))) continue;
      for (let k = 0; k < EXIT_HEADINGS; k++) {
        const a = k * TAU / EXIT_HEADINGS, dx = -Math.sin(a), dz = -Math.cos(a);
        probe.y = v.y;
        let reach = 0;
        for (const d of ESCAPE_STEPS) {
          const support = placeWalker(probe, v.x + dx * d, v.z + dz * d, world);
          if (!Number.isFinite(support)) break;
          probe.x = v.x + dx * d; probe.z = v.z + dz * d;
          const clash = titans.hullBlocked(probe, v);
          probe.x = v.x; probe.z = v.z;
          if (clash) break;
          probe.y = support; reach = d;
        }
        if (reach < 3) continue;
        // Keeping the hull's own yaw is worth a little: no flick when it is not needed.
        const score = reach + (prefer ? 0.5 * (dx * prefer[0] + dz * prefer[1]) : 0) + (j === 0 ? 0.25 : 0);
        if (score > bestScore) { best = { yaw, dir: [dx, dz] }; bestScore = score; }
      }
    }
    return best;
  }

  /**
   * The wish (wx, wz) turned by the smallest FEELER_TURNS angle whose path the hull fits on.
   * A friendly hull (a parked auto-titan on the route) is felt like a wall; enemy titans are
   * the fight (melee range) and stay to the engagement band.
   */
  feel(v, t, wx, wz, now) {
    if (now < (t.feelAt ?? 0)) return rotate(wx, wz, t.feelTurn ?? 0);
    t.feelAt = now + FEELER_MS;
    const titans = this.titans, world = titans.world, probe = { type: v.type, x: v.x, y: v.y, z: v.z, yaw: v.yaw };
    const reach = FEELER_STEPS.at(-1) + 2 * Math.hypot(titanFrame(v).hw, titanFrame(v).hl) + 1;
    const friends = [];
    for (const o of titans.titans()) {
      if (o !== v && o.team === v.team && (o.hp > 0 || o.dropping) && flat(o, v) < reach) friends.push(o);
    }
    const fits = (x, z) => {
      const l = Math.hypot(x, z) || 1;
      for (const d of FEELER_STEPS) {
        const support = placeWalker(v, v.x + x / l * d, v.z + z / l * d, world);
        if (!Number.isFinite(support)) return false;
        probe.x = v.x + x / l * d; probe.z = v.z + z / l * d;
        for (const o of friends) if (titans.overlaps(probe, o)) return false;
      }
      return true;
    };
    let turn = 0;
    if (!fits(wx, wz)) {
      turn = null;
      const side = t.feelSide ?? 1;
      for (const a of FEELER_TURNS) {
        for (const sign of [side, -side]) {
          const [x, z] = rotate(wx, wz, a * sign);
          if (fits(x, z)) { turn = a * sign; t.feelSide = sign; break; }
        }
        if (turn !== null) break;
      }
      turn ??= 0;
    }
    t.feelTurn = turn;
    return rotate(wx, wz, turn);
  }

  /** Simple ability triggers (docs/titanfall.md §9 Fight). */
  abilities(br, p, v, t, target, engaged, now, inp) {
    const ab = v.tfAbility;
    if (!ab || now < t.abilityAt || v.landedUntil > now) return;
    const use = verb => {
      if (!this.intent(p, 'ability', verb)) return false;
      t.abilityAt = now + ABILITY_GAP_MS;
      return true;
    };
    const ready = abilityReadiness(this.titans, v, now);
    const hpFrac = v.hp / Math.max(1, vehicleMaxHp(v));
    const hurt = now - t.hurtAt < HURT_MS;
    const recognized = !!engaged?.recognized && !!target;
    const d = target ? Math.hypot(target.x - v.x, (target.y ?? v.y) - v.y, target.z - v.z) : Infinity;
    // Electric smoke with a rider on the back: the auto-titan's delay plus the crew's reflex
    // (a battery rip, 1.4 s, can beat it).
    if (v.riderId && ready.smoke >= 1 && !(ab.smokeUntil > now)
      && now - (v.riderSince ?? now) > TITAN_RULES.auto.smokeAfterRiderMs + botDifficulty(br.difficulty).countermeasureMs
        + Math.round(mulberry32(hashSeed(`${v.id}:${v.riderSince ?? 0}:smoke`))() * SMOKE_REACTION_JITTER_MS)
      && use('smoke')) return;
    // Dash out of an incoming lock (and sideways out of heavy fire when low).
    if (v.dash >= 1 && !(v.dashT > 0) && ((v.lk | 0) >= 2 || (hurt && hpFrac < 0.4 && recognized && d < 45 && now >= t.dodgeAt))) {
      if (Math.abs(inp.vehicleSteer ?? 0) < 0.5) inp.vehicleSteer = Math.sin(t.strafePhase) > 0 ? 1 : -1;
      if (use('dash')) { t.dodgeAt = now + 4000; return; }
    }
    if (!recognized || v.doomed) return;
    if (hpFrac < DEFENSIVE_HP && hurt && ready.def >= 1 && use('def')) { t.holdDefUntil = now + DEFENSIVE_HOLD_MS; inp.titanHold = (inp.titanHold | 0) | HOLD.defensive; return; }
    if (target.kind === 'hull' && d < MELEE_RANGE && use('melee')) return;
    // The core is saved for titans and pilots, not spent on an attrition minion (§10).
    if ((ab.core ?? 0) >= 1 && !(ab.coreUntil > now) && d < CORE_RANGE && !target.tfNpc && use('core')) return;
    // Ordnance on cooldown with line of sight; RONIN's Phase Dash is an escape, kept for low health.
    const ordnance = v.type === 'titan_ronin' ? hpFrac < 0.35 && hurt : !!engaged.fired || engaged.recognized && d < 90;
    if (ready.ord >= 1 && ordnance && use('ord')) return;
    const band = TACTICAL_BAND[v.type];
    if (band && ready.tac >= 1 && d >= band[0] && d <= band[1] && use('tac')) return;
  }
}
