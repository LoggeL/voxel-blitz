/** Frozen cross-package contract for Conquest v2. Edit only through the integrator (WP9). */
// Titanfall additive helpers (docs/titanfall.md §2.3): conquest types resolve first, titan types second.
import { TITAN_TOPOLOGY, TITAN_WEAPON_META } from './titan-contract.js';
export const CONQUEST_CONTRACT_VERSION = 8;
export const CONQUEST_TEAMS = Object.freeze(['alpha', 'bravo']);
export const TEAM_DISPLAY = Object.freeze({ alpha: 'WEST', bravo: 'EAST' });

export const CONQUEST_RULES = Object.freeze({
  tickets: 300,
  timeLimitMs: 20 * 60 * 1000,
  captureHalfMs: 8000,
  maxRateMult: 2.5,
  decayPerSec: 0.05,
  bleedMsByFlags: Object.freeze({ 3: 3000, 4: 2000, 5: 1000 }),
  deathTicketCost: 1,
  ticketLowFractions: Object.freeze([0.25, 0.1]),
  respawnMs: 6000,
  deployTimeoutMs: 15000,
  reviveWindowMs: 8000,
  reviveHoldMs: 1200,
  reviveHpFraction: 0.4,
  repairPerSecFraction: 0.08,
  repairHoldStartMs: 300,
  supportIntentStaleMs: 350,
  spawnProtectMs: 2000,
  squadSize: 4,
  squadSpawnDamageLockMs: 4000,
  squadSpawnCooldownMs: 10000,
  outOfBoundsMs: 10000,
  hqRestrictedMs: 10000,
  presenceDy: 8,
  spotMs: 5000, spotMsRecon: 8000,
  spotRange: 300, spotRangeRecon: 400,
  spotConeRad: 0.06, spotCooldownMs: 1500,
  autoSpotOnFireMs: 2000,
  // In-game menu RESPAWN (redeploy intent): at most one per this many ms per player.
  redeployCooldownMs: 10000,
});

/**
 * Conquest rule variants, picked in the lobby (`conquestVariant`). The mode id
 * stays 'conquest' for every variant: kits, vehicles, deploy, squads and bots
 * are shared; a variant only swaps the objective rules (server/modes/conquest/).
 */
export const CONQUEST_VARIANTS = Object.freeze(['conquest', 'breakthrough']);
export const DEFAULT_CONQUEST_VARIANT = CONQUEST_VARIANTS[0];
export const normalizeConquestVariant = value => (CONQUEST_VARIANTS.includes(value) ? value : DEFAULT_CONQUEST_VARIANT);

/**
 * Breakthrough (docs/conquest.md, Breakthrough): the attackers push an ordered
 * line of sectors toward the defenders' HQ. Only the active sector's flags can
 * change hands; holding all of them advances the front. The attackers spend a
 * ticket pool that each captured sector refills; the defenders have no
 * tickets. BreakthroughPolicy merges these over CONQUEST_RULES.
 */
export const BREAKTHROUGH_RULES = Object.freeze({
  attackers: 'alpha',
  tickets: 30,
  // Tickets each captured sector gives the attackers back, never above `tickets`.
  refillPerSector: 20,
  // Attackers out of tickets fight on while they still take or contest an active flag.
  overtime: true,
  timeLimitMs: 30 * 60 * 1000,
  bleedMsByFlags: Object.freeze({}),
  // Defenders behind a lost sector's line get this long to fall back before the out-of-bounds timer runs
  // (on Frontier about 100 m on foot from flag A to the C line; 15 s lost most bots to the timer).
  fallbackGraceMs: 25000,
  // Attackers may push this far past the line between the active and the next sector.
  attackerLeadM: 40,
  // Ordered sectors from the attackers' HQ to the defenders' (flag ids, 1-2 per sector), per map.
  sectors: Object.freeze({
    frontier: Object.freeze([Object.freeze(['A', 'B']), Object.freeze(['C']), Object.freeze(['D', 'E'])]),
    // Redrock Canyon mirrors Frontier's layout: oasis and mine, then the dam, then radar and railhead.
    redrock: Object.freeze([Object.freeze(['A', 'B']), Object.freeze(['C']), Object.freeze(['D', 'E'])]),
  }),
  // Hull changes per side, keyed by the HQ pad suffix of `<team>-<pad>` spawns: the attackers
  // bring a second tank (offset in metres in the attackers' frame, mirrored for bravo; 20 m
  // south of the HQ tank, past the mobile AA's bay at +9 m, just off the motor pool); the
  // defenders' HQ tank bay fields an AT jeep (their armour is the Iron Bridge tank while C holds).
  // `types`, per hull type: 'lane' hulls (the patrol boat) wait at their pads while less than
  // `laneShare` of the map's boat lane lies on their side of the front (Frontier's river runs through
  // the Iron Bridge sector: the attackers' boats launch once it is active, the defenders' are retired
  // once it falls; in sector 0 only the river's southern bend, ~10 %, reaches inside the attackers' push);
  // 'hq' hulls (the mobile AA) stay at both HQs, as each side faces the other's aircraft in every
  // sector; 'kit' hulls (the Support mortar, a deployable) never get a pad, and their operator obeys
  // the front like infantry. The HQ pads themselves never move with the front (docs/conquest.md).
  vehicles: Object.freeze({
    attacker: Object.freeze({ add: Object.freeze([Object.freeze({ pad: 'tank-2', copy: 'tank', dx: 0, dz: 20 })]) }),
    defender: Object.freeze({ retype: Object.freeze({ tank: 'jeep_at' }) }),
    types: Object.freeze({ boat: 'lane', aa: 'hq', mortar: 'kit' }),
    laneShare: 0.25,
  }),
  // Bot commander: share of squads sent at enemy-held active flags (for the defenders: retakes).
  botAttackShare: Object.freeze({ attacker: 0.8, defender: 0.3 }),
});

export const FLAG_STATES = Object.freeze(['idle', 'capturing', 'neutralizing', 'contested', 'restoring']);

/**
 * Wire order of the kits: `cq[0]` is an index into this list, so new kits are
 * only ever appended (0-3 keep their v2 meaning). The deploy screen shows them
 * in KIT_MENU_ORDER (shared/conquest-kits.js) instead.
 */
export const KIT_IDS = Object.freeze(['assault', 'engineer', 'support', 'recon', 'medic', 'pyro', 'grenadier', 'raider', 'marksman']);
/**
 * `gadget` is the default gadget (gadgets[0]); `gadgets` lists the deploy-screen
 * choices, picked by the deploy intent's `gadget` index (0 default). The
 * Engineer carries the RX-8 AT launcher (0) or the AX-9 STINGER AA launcher (1),
 * and AT MINES in the grenade pouch (`atmine`, shared/at-mine-rules.js). The
 * Recon's choices are pouch gadgets, not weapons (KIT_POUCH_GADGETS in
 * shared/conquest-kits.js): the SPAWN BEACON (0) or two MOTION SENSORS (1).
 * A gadget that is neither is a deployable (DEPLOYABLE_TYPE_IDS): the
 * Support picks no gadget (null, 0) or the MORTAR (1), placed with the
 * `mortar` intent (shared/mortar-rules.js). The Engineer's third choice (2) is
 * the FPV kamikaze drone, launched with the `fpv` intent (shared/fpv-rules.js):
 * no launcher, the AT mines stay.
 * `unlockLevel` is the career level that opens the kit (1: a base kit); the
 * server refuses a locked kit at deploy (`deploy_refused {reason:'locked'}`),
 * bots ignore it. `aura` marks a passive team aura (the Medic's heal).
 */
const KIT = (label, ability, primaries, gadgets, grenades, unlockLevel, extra = {}) => Object.freeze({
  label, ability, primaries: Object.freeze(primaries), gadget: gadgets[0] ?? null, gadgets: Object.freeze(gadgets),
  grenades: Object.freeze(grenades), unlockLevel, ...extra,
});
export const KITS = Object.freeze({
  assault:   KIT('ASSAULT',   'adrenaline', ['rifle', 'shotgun'],       [],                    { frag: 2, pulse: 1 },    1),
  engineer:  KIT('ENGINEER',  'repair',     ['smg', 'shotgun'],         ['rocket', 'stinger', 'fpv'], { smoke: 1, frag: 1, atmine: 3 }, 1),
  support:   KIT('SUPPORT',   'resupply',   ['lmg', 'minigun'],         [null, 'mortar'],      { frag: 2, molotov: 1 },  1),
  recon:     KIT('RECON',     'spot',       ['sniper', 'longarc'],      ['beacon', 'sensor'],  { limpet: 2, pulse: 1 },  1),
  medic:     KIT('MEDIC',     'revive',     ['smg', 'longarc'],         [],                    { smoke: 2, frag: 1 },    1, { aura: 'heal' }),
  pyro:      KIT('PYRO',      'fireproof',  ['flamethrower', 'shotgun'], [],                   { molotov: 2, smoke: 1 }, 3),
  grenadier: KIT('GRENADIER', 'ordnance',   ['mgl', 'bubble'],          [],                    { frag: 2, smoke: 1 },    5),
  raider:    KIT('RAIDER',    'ghost',      ['glaive', 'smg'],          [],                    { frag: 1, limpet: 1 },   7),
  marksman:  KIT('MARKSMAN',  'overwatch',  ['lance', 'longarc'],       [],                    { pulse: 1, smoke: 1 },   9),
});
export const KIT_SIDEARM = 'revolver';

export const SCORE_POINTS = Object.freeze({
  kill: 100, headshot: 25, assist: 50 /* scaled 10..90 by damage share */, attacker_kill: 50, defender_kill: 50,
  capture: 250, neutralize: 150, capture_assist: 100, defend: 100,
  vehicle_destroyed: 200, vehicle_crew: 50, vehicle_disabled: 100, vehicle_damage: 50 /* scaled 10..150 */,
  driver_assist: 25, revive: 100, heal: 10, repair: 10, resupply: 10, spot_assist: 25, squad_spawn: 15,
  // Squad orders (shared/conquest-comms.js): paid on top of `capture` / `defend` on the squad's order flag.
  order_capture: 100, order_defend: 50,
  // Recon gadgets (shared/recon-gadgets.js): a squad mate deployed on your beacon, an enemy beacon or sensor destroyed.
  beacon_spawn: 15, gadget_destroyed: 50,
  ribbon: 50 /* bonus for a ribbon earned (RIBBONS) */,
  bridge_destroyed: 200,
  // Map events (shared/conquest-map-events.js, contract v7): triggering or stopping one, scaled per action.
  map_event: 200,
});
export const SCORE_LABELS = Object.freeze({
  kill: 'KILL', headshot: 'HEADSHOT', assist: 'KILL ASSIST', attacker_kill: 'ATTACKER KILL', defender_kill: 'DEFENDER KILL',
  capture: 'FLAG CAPTURED', neutralize: 'FLAG NEUTRALIZED', capture_assist: 'CAPTURE ASSIST', defend: 'FLAG DEFENDED',
  vehicle_destroyed: 'VEHICLE DESTROYED', vehicle_crew: 'CREW KILL', vehicle_disabled: 'VEHICLE DISABLED', vehicle_damage: 'VEHICLE DAMAGE',
  driver_assist: 'DRIVER ASSIST', revive: 'REVIVE', heal: 'HEAL', repair: 'REPAIR', resupply: 'RESUPPLY', spot_assist: 'SPOT ASSIST', squad_spawn: 'SQUAD SPAWN',
  order_capture: 'ORDER CAPTURE', order_defend: 'ORDER DEFEND',
  beacon_spawn: 'BEACON SPAWN', gadget_destroyed: 'GADGET DESTROYED',
  ribbon: 'RIBBON',
  bridge_destroyed: 'BRIDGE DESTROYED',
  map_event: 'MAP OBJECTIVE',
});

/**
 * Score categories of the result screen's personal summary: results rows carry
 * `cqp`, the points per category in SCORE_CATEGORY_IDS order (decodeConquestResult).
 * A reason missing here counts as `combat`, so the categories always sum to the score.
 */
export const SCORE_CATEGORIES = Object.freeze({
  combat: Object.freeze(['kill', 'headshot', 'assist', 'attacker_kill', 'defender_kill', 'gadget_destroyed']),
  objective: Object.freeze(['capture', 'neutralize', 'capture_assist', 'defend', 'order_capture', 'order_defend', 'bridge_destroyed', 'map_event']),
  vehicles: Object.freeze(['vehicle_destroyed', 'vehicle_crew', 'vehicle_disabled', 'vehicle_damage', 'driver_assist']),
  support: Object.freeze(['revive', 'heal', 'repair', 'resupply', 'spot_assist', 'squad_spawn', 'beacon_spawn']),
  ribbons: Object.freeze(['ribbon']),
});
export const SCORE_CATEGORY_IDS = Object.freeze(Object.keys(SCORE_CATEGORIES));
const CATEGORY_OF = new Map(Object.entries(SCORE_CATEGORIES).flatMap(([id, reasons]) => reasons.map(r => [r, id])));
export const scoreCategory = reason => CATEGORY_OF.get(reason) ?? 'combat';

/**
 * Ribbons (server/modes/conquest/ribbons.js): mid-match awards for `count`
 * score events of one of `reasons`. A `life` ribbon counts since the last
 * death and is paid once per life; a `match` ribbon is paid again at every
 * multiple of `count` (5, 10, 15 revives). Each ribbon pays SCORE_POINTS.ribbon
 * and CAREER_REWARDS.conquestRibbon XP and emits `ribbon {id, ribbon, count, pts}`.
 * Wire order RIBBON_IDS (results row `cqr`): append only.
 */
const RIBBON = (label, detail, reasons, count, scope = 'match') => Object.freeze({ label, detail, reasons: Object.freeze(reasons), count, scope });
export const RIBBONS = Object.freeze({
  spree:        RIBBON('SPREE RIBBON',        '4 KILLS IN ONE LIFE',  ['kill'],              4, 'life'),
  medic:        RIBBON('MEDIC RIBBON',        '5 REVIVES',            ['revive'],            5),
  anti_vehicle: RIBBON('ANTI-VEHICLE RIBBON', '3 VEHICLES DESTROYED', ['vehicle_destroyed'], 3),
  conquest:     RIBBON('CONQUEST RIBBON',     '2 FLAGS CAPTURED',     ['capture'],           2),
  resupply:     RIBBON('RESUPPLY RIBBON',     '10 RESUPPLIES',        ['resupply'],          10),
  repair:       RIBBON('REPAIR RIBBON',       '5 REPAIRS',            ['repair'],            5),
  intel:        RIBBON('INTEL RIBBON',        '5 SPOT ASSISTS',       ['spot_assist'],       5),
  defender:     RIBBON('DEFENDER RIBBON',     '2 FLAG DEFENDS',       ['defend'],            2),
});
export const RIBBON_IDS = Object.freeze(Object.keys(RIBBONS));
/**
 * Medals, decided once at match end from the match's ribbons: `count` ribbons
 * of `ribbon` (null: of any kind). Each medal emits `medal {id, medal}` and pays
 * CAREER_REWARDS.conquestMedal XP. Wire order MEDAL_IDS (results row `cqm`): append only.
 */
const MEDAL = (label, ribbon, count) => Object.freeze({ label, ribbon, count });
export const MEDALS = Object.freeze({
  valor:         MEDAL('VALOR MEDAL',         'spree',        2),
  lifesaver:     MEDAL('LIFESAVER MEDAL',     'medic',        2),
  tank_hunter:   MEDAL('TANK HUNTER MEDAL',   'anti_vehicle', 2),
  conqueror:     MEDAL('CONQUEROR MEDAL',     'conquest',     2),
  quartermaster: MEDAL('QUARTERMASTER MEDAL', 'resupply',     2),
  mechanic:      MEDAL('MECHANIC MEDAL',      'repair',       2),
  pathfinder:    MEDAL('PATHFINDER MEDAL',    'intel',        2),
  guardian:      MEDAL('GUARDIAN MEDAL',      'defender',     2),
  service:       MEDAL('SERVICE MEDAL',       null,           5),
});
export const MEDAL_IDS = Object.freeze(Object.keys(MEDALS));

/** Server -> client event kinds added by Conquest v2 (all `{t:'ev', kind, at, ...}`). */
export const CONQUEST_EVENT_KINDS = Object.freeze([
  'flag_state',        // {flag, state, team}            team = side currently moving control (or null)
  'flag_neutralized',  // {flag, team, prev}             team = neutralizing side, prev = old owner
  'flag_captured',     // {flag, team}
  'ticket_low',        // {team, tickets}
  'score',             // {id, pts, reason}
  'deploy_refused',    // {id, reason}                   reason: 'invalid'|'contested'|'enemy'|'busy'|'cooldown'|'seat'|'locked' (+ kit, level; or vehicle, upgrade, level)|'tickets'
  'revive',            // {id, by}
  'heal',              // {id, by, hp}                   Medic aura pulse: `by` restored `hp` to `id` (one per pulse per mate)
  'kit_unlocks',       // {id, level, unlocked:[kit], newly:[kit]}  career level gate; on join and on a level-up that opens a kit
  'spot',              // {by, ids:[playerOrVehicleId]}
  'vehicle_hit',       // {vehicleId, attacker, dmg, zone, cls, eff:0|1, pos:[x,y,z], part?, res?:'rico'|'nopen', sys?:'tracks'|'engine'|'turret'}  merged per attacker/hull/100ms
  'vehicle_disabled',  // {vehicleId, attacker}
  'vehicle_repaired',  // {vehicleId, by, hp}
  'vehicle_hijacked',  // {vehicleId, type, by, from, to}  an empty enemy hull boarded: it now belongs to `to`
  'countermeasure',    // {vehicleId, cm:'flares'|'smoke'}  (kind is the event discriminator)
  'ejection',          // {id, vehicleId, pos:[x,y,z], vel:[vx,vy,vz], yaw}  jet pilot left on the ejection seat
  'squad_order',       // {team, squad, flag, by}       flag null clears; stance follows the flag owner (shared/conquest-comms.js orderStance)
  'comm',              // {team, by, comm, squad, seq?} a comm rose callout (`comm` in COMM_KINDS); a request's marker rides the requester's `cqc` player field
  'comm_answer',       // {team, seq, comm, by, responder}  a bot took request `seq` (medic heading over, driver on the way)
  'recon_gadget',      // {gadget:'beacon'|'sensor', id, owner, team, state:'placed'|'destroyed'|'removed'|'expired', pos:[x,y,z], by?}
  'mortar',            // {id, state:'placed'|'refused'|'lost', vehicleId?, reason?, waitMs?}  Support mortar (shared/mortar-rules.js)
  'ribbon',            // {id, ribbon, count, pts}         RIBBONS id earned mid-match; count = this ribbon's total this match, pts = SCORE_POINTS.ribbon paid
  'medal',             // {id, medal}                      MEDALS id awarded at match end (one event per medal)
  'weather_strike',    // {x, y, z}                      a lightning strike of the weather timeline (y = ground), shared/conquest-weather.js
  'bridge',            // {bridge, stage, integrity, fallAt?, by?}  Iron Bridge levolution stage change (shared/conquest-bridge.js; v6)
  'sector_captured',   // {sector, next, team, flags:[id], refill, tickets, graceEndsAt}  Breakthrough front advanced (next -1: none left)
  'sector_overtime',   // {team}                         Breakthrough attackers out of tickets fight on for an active flag
  'map_event',         // {event, phase, team?, by?, endsAt?, note?, data?}  a map event phase change or note (shared/conquest-map-events.js; v7)
  'fpv',               // {id, state:'launched'|'refused'|'cut'|'detonated'|'lost', vehicleId?, reason?, waitMs?, pos?}  Engineer FPV drone (shared/fpv-rules.js; v7)
  'ammo_pouch',        // {id, pouch, rounds}            `id` took ammo pouch `pouch` (one magazine, `rounds` reserve); the list rides match.conquest.pch (shared/ammo-pouches.js; v8)
  // existing kinds kept: 'vehicle_destroyed' gains {type, attacker, assists:[ids], crewKilled}; 'shoot' gains {vehicleId, mount, vehicleWeapon, tracer}
]);
export const REMOVED_EVENT_KINDS = Object.freeze(['flag_capture']);
/**
 * Conquest kill keys (`kill.w`) for deaths without a weapon: the restricted-area
 * timer, a hull (run over, or crew of a hull an enemy destroyed), a fall
 * (`fall`: killer is the enemy whose damage preceded the fall within
 * FALL_DAMAGE.creditMs, else '' for a self death) and a crash (`crash`: crew
 * of a hull wrecked by its own collision or fall, no killer) and a redeploy
 * (`redeploy`: the player chose RESPAWN in the in-game menu; killer is the
 * enemy whose damage preceded it within FALL_DAMAGE.creditMs, else '').
 */
export const CONQUEST_DEATH_KEYS = Object.freeze(['restricted', 'vehicle', 'fall', 'crash', 'redeploy']);

/** Client -> server Conquest intent frame `{t:'conquest', ...}` (one field per frame is enough). */
export const CONQUEST_INTENT_SHAPE = Object.freeze({
  // upgrades (v6): {<vehicle type>: <upgrade id>} from shared/vehicle-upgrades.js; a type left out drives stock.
  deploy: '{spawn:"hq"|"flag:A".."flag:E"|"squad:<playerId>"|"vehicle:<vehicleId>"|"vehicle:<vehicleId>:<seatId>"|"beacon:<beaconId>", kit:KIT_ID, variant:0|1, gadget?:0|1|2, upgrades?:{type:upgradeId}}',
  spot: '1',
  // `use` (v7): hold an interaction point of a map event, targetId `<eventId>:<pointIndex>` (shared/conquest-map-events.js).
  support: '{type:"revive"|"repair"|"use", targetId:string}',
  // In-game menu RESPAWN: die now (1 ticket, kill key `redeploy`) and open the deploy screen.
  redeploy: '1',
  // Comm rose pick (shared/conquest-comms.js COMM_KINDS); `order` names the flag under the crosshair.
  comm: '"medic"|"ammo"|"repair"|"ride"|"yes"|"no"|"spot"|"order"',
  // Squad leader order on a flag from the full map ("" clears).
  order: '"A".."E"|""',
  // Support with the MORTAR gadget: place the mortar ahead and man it (one per player).
  mortar: '1',
  // Engineer with the FPV gadget: launch a drone and fly it, or cut the link of the one in the air (v7).
  fpv: '1',
});
/** input.vehicleAction types (parsed by parseVehicleAction). */
export const VEHICLE_ACTION_TYPES = Object.freeze(['enter', 'exit', 'seat', 'cm', 'weapon']);
// enter {vehicleId, seatId?} | exit {} | seat {seatId} | cm {} | weapon {index}

export const DAMAGE_CLASSES = Object.freeze(['small', 'mg', 'hmg', 'autocannon', 'explosive', 'he', 'at', 'aa', 'fire']);
// `medium`: the mobile AA hull's armour, between the jeep's light and the tank's heavy.
// `drone`: the Engineer's FPV drone (v7), a frame any round or blast breaks.
export const ARMOR_CLASSES = Object.freeze(['light', 'heavy', 'air', 'medium', 'drone']);
export const HIT_ZONES = Object.freeze(['front', 'side', 'rear', 'top', 'bottom']);

export const VEHICLE_TYPE_IDS = Object.freeze(['jeep', 'tank', 'helicopter', 'transport', 'plane', 'jeep_at', 'aa', 'boat']);
/**
 * Hull variants: a type that shares another type's hull (handling, collider,
 * seats, model and sounds) but arms it differently. The AT jeep is the jeep
 * with a TOW launcher on the pintle. `vehicleHullType` answers "which hull is
 * this" for every per-hull table and check; weapons stay keyed by the type.
 * The mobile AA (`aa`) rides the tank's running gear (tracked drive, a turret
 * that carries the commander's seat, engine and track sounds, cook-off) but
 * fills every per-hull table of its own: HP, armour, collider, seats, mounts,
 * model (shared/vehicle-defs.js).
 */
/**
 * Deployables: hull types a player places in the match (never on a map pad,
 * never a deploy-screen spawn, never hijacked). They live in the hull tables
 * (topology, defs, rows) but stay out of VEHICLE_TYPE_IDS, the pad roster.
 */
export const DEPLOYABLE_TYPE_IDS = Object.freeze(['mortar', 'fpv']);
export const isDeployableType = type => typeof type === 'string' && DEPLOYABLE_TYPE_IDS.includes(type);
export const VEHICLE_HULL_VARIANTS = Object.freeze({ jeep_at: 'jeep', aa: 'tank' });
export const vehicleHullType = type => VEHICLE_HULL_VARIANTS[type] ?? type;
export const VEHICLE_WEAPON_META = Object.freeze({
  // Tank main gun: real cannon shells (`shell` presentation: tracer streak, no rocket
  // motor or smoke trail) with true ballistic drop (gravity 9.8 m/s^2). The AP sabot
  // is flat and fast; HE is slower with a visible arc (a faster HE made bot tanks
  // hold flags against infantry: see docs/conquest.md "Tank shells").
  tankAP:           Object.freeze({ label: '120MM AP',   kind: 'shell',   cls: 'at',         speed: 250, gravity: 9.8, rate: 1 / 3.5, presentation: 'shell' }),
  tankHE:           Object.freeze({ label: '120MM HE',   kind: 'shell',   cls: 'he',         speed: 160, gravity: 9.8, rate: 1 / 3.5, presentation: 'shell' }),
  coaxMG:           Object.freeze({ label: 'COAX 7.62',  kind: 'hitscan', cls: 'mg',         speed: 0,   gravity: 0, rate: 10,      presentation: 'lmg' }),
  hmg:              Object.freeze({ label: '.50 HMG',    kind: 'hitscan', cls: 'hmg',        speed: 0,   gravity: 0, rate: 8,       presentation: 'lmg' }),
  helicopterRocket: Object.freeze({ label: 'ROCKET POD', kind: 'rocket',  cls: 'he',         speed: 90,  gravity: 0, rate: 5,       presentation: 'rocket' }),
  chinCannon:       Object.freeze({ label: '25MM CHIN',  kind: 'shell',   cls: 'autocannon', speed: 260, gravity: 2, rate: 5,       presentation: 'mgl' }),
  doorMinigun:      Object.freeze({ label: 'DOOR GUN',   kind: 'hitscan', cls: 'mg',         speed: 0,   gravity: 0, rate: 18,      presentation: 'minigun' }),
  planeCannon:      Object.freeze({ label: '20MM CANNON',kind: 'hitscan', cls: 'autocannon', speed: 0,   gravity: 0, rate: 14,      presentation: 'minigun' }),
  aaMissile:        Object.freeze({ label: 'AA MISSILE', kind: 'missile', cls: 'aa',         speed: 150, gravity: 0, rate: 1 / 7.5, presentation: 'rocket' }),
  // Jet free-fall bomb (the inner `bombs` pylons): released with the airframe's
  // velocity (speed 0: no muzzle velocity of its own) and dropping under gravity.
  jetBomb:          Object.freeze({ label: 'BOMB',       kind: 'bomb',    cls: 'at',         speed: 0,   gravity: 9.8, rate: 1 / 10,  presentation: 'bomb' }),
  // Sight-guided AT missiles (SACLOS): no lock, the missile rides the gunner's
  // line of sight (the heli's chin gimbal, the AT jeep's launcher) while he
  // stays in the seat. Not IR: flares never decoy them.
  guidedMissile:    Object.freeze({ label: 'GUIDED MSL', kind: 'missile', cls: 'at',         speed: 75,  gravity: 0, rate: 1 / 1.5, presentation: 'rocket' }),
  towMissile:       Object.freeze({ label: 'TOW MSL',    kind: 'missile', cls: 'at',         speed: 65,  gravity: 0, rate: 1 / 2,   presentation: 'rocket' }),
  // Support mortar: a finned HE bomb (`bomb` presentation) lobbed on a high arc.
  mortarHE:         Object.freeze({ label: 'MORTAR HE',  kind: 'shell',   cls: 'he',         speed: 59,  gravity: 14, rate: 1 / 2,   presentation: 'bomb' }),
  // Mobile AA twin 35 mm: radar-proximity-fused flak shells (VEHICLE_WEAPONS.flak35.flak),
  // `aa` class (strong on aircraft, weak on ground armour), the left and right gun in turn.
  flak35:           Object.freeze({ label: '35MM FLAK',  kind: 'shell',   cls: 'aa',         speed: 320, gravity: 4, rate: 8,       presentation: 'mgl' }),
});
export const COUNTERMEASURES = Object.freeze({ tank: 'smoke', helicopter: 'flares', transport: 'flares', plane: 'flares', jeep: null, jeep_at: null, mortar: null, aa: 'smoke', boat: null, fpv: null });

/** Seat and mount topology. Order is significant (F1..F5, mounts[] in snapshot rows). Positions/anchors live in shared/vehicle-defs.js. */
const S = (id, role, drives, exposed, personalWeapons, mounts) => Object.freeze({ id, role, drives, exposed, personalWeapons, mounts: Object.freeze(mounts) });
const M = (id, weapons) => Object.freeze({ id, weapons: Object.freeze(weapons) });
export const VEHICLE_TOPOLOGY = Object.freeze({
  jeep: Object.freeze([
    S('driver', 'driver', true, true, false, []),
    S('gunner', 'gunner', false, true, false, [M('pintle', ['hmg'])]),
    S('front-passenger', 'passenger', false, true, true, []),
    S('rear-left', 'passenger', false, true, true, []),
  ]),
  tank: Object.freeze([
    S('driver', 'driver', true, false, false, [M('main', ['tankAP', 'tankHE']), M('coax', ['coaxMG'])]),
    S('commander', 'gunner', false, true, false, [M('rws', ['hmg'])]),
  ]),
  helicopter: Object.freeze([
    S('driver', 'pilot', true, false, false, [M('pods', ['helicopterRocket'])]),
    // The gunner cycles the chin cannon and the wingtip guided missiles; the
    // chin gimbal is his sight for both (VEHICLE_WEAPONS.guidedMissile.beam).
    S('gunner', 'gunner', false, false, false, [M('chin', ['chinCannon']), M('atgm', ['guidedMissile'])]),
  ]),
  transport: Object.freeze([
    S('driver', 'pilot', true, false, false, []),
    S('door-left', 'gunner', false, true, false, [M('door-left', ['doorMinigun'])]),
    S('door-right', 'gunner', false, true, false, [M('door-right', ['doorMinigun'])]),
    S('rear-left', 'passenger', false, false, false, []),
    S('rear-right', 'passenger', false, false, false, []),
  ]),
  plane: Object.freeze([
    // The jet carries both stores at once: AA missiles on the outer rails, bombs on the inner pylons.
    S('driver', 'pilot', true, false, false, [M('nose', ['planeCannon']), M('rails', ['aaMissile']), M('bombs', ['jetBomb'])]),
  ]),
  // The jeep's seats with a TOW launcher on the pintle instead of the .50.
  jeep_at: Object.freeze([
    S('driver', 'driver', true, true, false, []),
    S('gunner', 'gunner', false, true, false, [M('pintle', ['towMissile'])]),
    S('front-passenger', 'passenger', false, true, true, []),
    S('rear-left', 'passenger', false, true, true, []),
  ]),
  // Deployable (DEPLOYABLE_TYPE_IDS): the Support mortar, one exposed operator.
  mortar: Object.freeze([
    S('operator', 'gunner', false, true, false, [M('tube', ['mortarHE'])]),
  ]),
  // Mobile AA: the driver drives and fights the twin 35 mm turret (the tank's
  // driver-gunner seat); the commander works the .50 on the turret roof.
  aa: Object.freeze([
    S('driver', 'driver', true, false, false, [M('main', ['flak35'])]),
    S('commander', 'gunner', false, true, false, [M('rws', ['hmg'])]),
  ]),
  // River patrol boat (contract v6): a helmsman at the console, a .50 in the
  // bow tub and two passengers in the open aft cockpit; every seat is exposed.
  boat: Object.freeze([
    S('driver', 'driver', true, true, false, []),
    S('gunner', 'gunner', false, true, false, [M('bow', ['hmg'])]),
    S('rear-left', 'passenger', false, true, true, []),
    S('rear-right', 'passenger', false, true, true, []),
  ]),
  // Deployable (v7): the Engineer's FPV drone. No seat: its operator flies it
  // from where he crouches (server/sim/fpv-drones.js), so nobody boards it.
  fpv: Object.freeze([]),
});
/** Seat topology of a conquest or titan type (titan types: shared/titan-contract.js). */
const topologyOf = type => VEHICLE_TOPOLOGY[type] || TITAN_TOPOLOGY[type];
/** META row of a conquest or titan mount weapon, or null. */
export const vehicleWeaponMeta = key => VEHICLE_WEAPON_META[key] || TITAN_WEAPON_META[key] || null;
/** Flattened mount order used by vehicle rows `mounts[]`. */
export const vehicleMountOrder = type => (topologyOf(type) || []).flatMap(seat => seat.mounts.map(m => `${seat.id}:${m.id}`));
/** Weapons a seat cycles through with `{type:'weapon', index}`; index into this list. */
export const seatWeaponList = (type, seatId) => ((topologyOf(type) || []).find(s => s.id === seatId)?.mounts || []).flatMap(m => m.weapons.map(w => ({ mount: m.id, weapon: w })));

/** Vehicle row status bitfield `st`. */
export const VEHICLE_STATUS = Object.freeze({ engine: 1, disabled: 2, burning: 4, immobilized: 8, flares: 16, smoke: 32, grounded: 64, wreck: 128, repairing: 256,
  // Tank subsystems (shared/tank-armor.js TANK_SUBSYSTEMS): broken tracks, damaged engine, damaged turret ring.
  tracksHit: 512, engineHit: 1024, turretHit: 2048,
  // A forward service depot repairs and rearms the hull now (v7, shared/map-events/depot.js).
  servicing: 4096 });
export const vehicleStatus = row => Object.fromEntries(Object.entries(VEHICLE_STATUS).map(([k, bit]) => [k, ((row?.st | 0) & bit) !== 0]));

/** Player row field `cq` (Conquest only): [kitIndex(-1 none), squadId(0 none), down(0/1), spotted(0/1), restrictedDs (tenths of s left, 0 none), lockProgress(0..100), actionProgress(0..100), chute?]
 * The optional 8th entry is the parachute state (shared/parachute.js CHUTE: 1 canopy open, 2 ejection seat), omitted at 0. */
export const decodeConquestPlayer = row => {
  const cq = Array.isArray(row?.cq) ? row.cq : null;
  if (!cq) return null;
  return { kit: KIT_IDS[cq[0]] ?? null, squad: cq[1] | 0, down: cq[2] === 1, spotted: cq[3] === 1,
    restrictedMs: (cq[4] | 0) * 100, lockProgress: (cq[5] | 0) / 100, actionProgress: (cq[6] | 0) / 100, chute: cq[7] === 1 || cq[7] === 2 ? cq[7] : 0 };
};
/** Player row field `cqs` (Conquest only, per-player counters): [objectiveScore, vehiclesDestroyed, revives, captures] */
export const decodeConquestStats = row => {
  const s = Array.isArray(row?.cqs) ? row.cqs : [0, 0, 0, 0];
  return { objective: s[0] | 0, vehicles: s[1] | 0, revives: s[2] | 0, captures: s[3] | 0 };
};

/**
 * Post-match results row extras (contract v6, `match.results[]` only, never in live rows):
 * `cqr` ribbon counts in RIBBON_IDS order, `cqm` earned medals as MEDAL_IDS indices,
 * `cqp` points per SCORE_CATEGORY_IDS, `cxp` [careerXp, xpGainedThisMatch] (humans with a career only).
 */
export const decodeConquestResult = row => {
  const ribbons = {}, categories = {};
  RIBBON_IDS.forEach((id, i) => { ribbons[id] = Array.isArray(row?.cqr) ? Math.max(0, row.cqr[i] | 0) : 0; });
  SCORE_CATEGORY_IDS.forEach((id, i) => { categories[id] = Array.isArray(row?.cqp) ? Math.max(0, row.cqp[i] | 0) : 0; });
  const medals = (Array.isArray(row?.cqm) ? row.cqm : []).map(i => MEDAL_IDS[i]).filter(Boolean);
  const cxp = Array.isArray(row?.cxp) && row.cxp.length >= 2 && row.cxp.every(Number.isFinite)
    ? { xp: Math.max(0, Math.trunc(row.cxp[0])), gained: Math.max(0, Math.trunc(row.cxp[1])) } : null;
  return { ribbons, medals, categories, career: cxp };
};

/** Frontier v2 plan (voxel units). y comes from the terrain: frontierSurfaceY(x, z) in shared/world/frontier-terrain.js. */
export const FRONTIER_PLAN = Object.freeze({
  dimensions: Object.freeze({ sx: 768, sy: 80, sz: 768 }),
  center: Object.freeze([384, 384]),
  combatArea: Object.freeze({ minX: 24, maxX: 744, minZ: 24, maxZ: 744 }),
  hqs: Object.freeze({
    alpha: Object.freeze({ x: 72,  z: 384, radius: 56, name: 'West HQ' }),
    bravo: Object.freeze({ x: 696, z: 384, radius: 56, name: 'East HQ' }),
  }),
  flags: Object.freeze([
    Object.freeze({ id: 'A', name: 'Kestrel Farm',   site: 'farm',    x: 232, z: 248, radius: 22, home: 'alpha' }),
    Object.freeze({ id: 'B', name: 'St. Aldric',     site: 'village', x: 272, z: 520, radius: 20, home: 'alpha' }),
    Object.freeze({ id: 'C', name: 'Iron Bridge',    site: 'bridge',  x: 384, z: 384, radius: 24, home: null }),
    Object.freeze({ id: 'D', name: 'Ridge Bunkers',  site: 'bunkers', x: 496, z: 248, radius: 22, home: 'bravo' }),
    Object.freeze({ id: 'E', name: 'Kessler Works',  site: 'works',   x: 536, z: 520, radius: 22, home: 'bravo' }),
  ]),
  river: Object.freeze({ points: Object.freeze([[384, 0], [396, 150], [384, 384], [372, 618], [384, 768]]), width: 20, depth: 4.5, surfaceY: 21 }),
  crossings: Object.freeze([
    Object.freeze({ id: 'bridge-north', kind: 'bridge', x: 396, z: 150, width: 8 }),
    Object.freeze({ id: 'ford-north',   kind: 'ford',   x: 392, z: 270, width: 14 }),
    Object.freeze({ id: 'iron-bridge',  kind: 'bridge', x: 384, z: 384, width: 10 }),
    Object.freeze({ id: 'ford-south',   kind: 'ford',   x: 376, z: 498, width: 14 }),
    Object.freeze({ id: 'bridge-south', kind: 'bridge', x: 372, z: 618, width: 8 }),
  ]),
  heights: Object.freeze({ bedrock: 0, waterSurface: 21, valleyMin: 24, valleyMax: 32, hqPlateau: 36, ridgeMax: 60, landmarkMax: 78 }),
});
