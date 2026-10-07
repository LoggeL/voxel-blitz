/** Frozen cross-package contract for Conquest v2. Edit only through the integrator (WP9). */
export const CONQUEST_CONTRACT_VERSION = 2;
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
});

export const FLAG_STATES = Object.freeze(['idle', 'capturing', 'neutralizing', 'contested', 'restoring']);

export const KIT_IDS = Object.freeze(['assault', 'engineer', 'support', 'recon']);
export const KITS = Object.freeze({
  assault:  Object.freeze({ label: 'ASSAULT',  ability: 'revive',   primaries: Object.freeze(['rifle', 'mgl']),     gadget: null,     grenades: Object.freeze({ frag: 2, smoke: 1 }) }),
  engineer: Object.freeze({ label: 'ENGINEER', ability: 'repair',   primaries: Object.freeze(['smg', 'shotgun']),   gadget: 'rocket', grenades: Object.freeze({ smoke: 1, frag: 1 }) }),
  support:  Object.freeze({ label: 'SUPPORT',  ability: 'resupply', primaries: Object.freeze(['lmg', 'minigun']),   gadget: null,     grenades: Object.freeze({ frag: 2, molotov: 1 }) }),
  recon:    Object.freeze({ label: 'RECON',    ability: 'spot',     primaries: Object.freeze(['sniper', 'longarc']), gadget: null,     grenades: Object.freeze({ limpet: 2, pulse: 1 }) }),
});
export const KIT_SIDEARM = 'revolver';

export const SCORE_POINTS = Object.freeze({
  kill: 100, headshot: 25, assist: 50 /* scaled 10..90 by damage share */, attacker_kill: 50, defender_kill: 50,
  capture: 250, neutralize: 150, capture_assist: 100, defend: 100,
  vehicle_destroyed: 200, vehicle_crew: 50, vehicle_disabled: 100, vehicle_damage: 50 /* scaled 10..150 */,
  driver_assist: 25, revive: 100, repair: 10, resupply: 10, spot_assist: 25, squad_spawn: 15,
});
export const SCORE_LABELS = Object.freeze({
  kill: 'KILL', headshot: 'HEADSHOT', assist: 'KILL ASSIST', attacker_kill: 'ATTACKER KILL', defender_kill: 'DEFENDER KILL',
  capture: 'FLAG CAPTURED', neutralize: 'FLAG NEUTRALIZED', capture_assist: 'CAPTURE ASSIST', defend: 'FLAG DEFENDED',
  vehicle_destroyed: 'VEHICLE DESTROYED', vehicle_crew: 'CREW KILL', vehicle_disabled: 'VEHICLE DISABLED', vehicle_damage: 'VEHICLE DAMAGE',
  driver_assist: 'DRIVER ASSIST', revive: 'REVIVE', repair: 'REPAIR', resupply: 'RESUPPLY', spot_assist: 'SPOT ASSIST', squad_spawn: 'SQUAD SPAWN',
});

/** Server -> client event kinds added by Conquest v2 (all `{t:'ev', kind, at, ...}`). */
export const CONQUEST_EVENT_KINDS = Object.freeze([
  'flag_state',        // {flag, state, team}            team = side currently moving control (or null)
  'flag_neutralized',  // {flag, team, prev}             team = neutralizing side, prev = old owner
  'flag_captured',     // {flag, team}
  'ticket_low',        // {team, tickets}
  'score',             // {id, pts, reason}
  'deploy_refused',    // {id, reason}                   reason: 'invalid'|'contested'|'enemy'|'busy'|'cooldown'|'seat'
  'revive',            // {id, by}
  'spot',              // {by, ids:[playerOrVehicleId]}
  'vehicle_hit',       // {vehicleId, attacker, dmg, zone, cls, eff:0|1, pos:[x,y,z]}  merged per attacker/hull/100ms
  'vehicle_disabled',  // {vehicleId, attacker}
  'vehicle_repaired',  // {vehicleId, by, hp}
  'countermeasure',    // {vehicleId, cm:'flares'|'smoke'}  (kind is the event discriminator)
  // existing kinds kept: 'vehicle_destroyed' gains {type, attacker, assists:[ids], crewKilled}; 'shoot' gains {vehicleId, mount, vehicleWeapon, tracer}
]);
export const REMOVED_EVENT_KINDS = Object.freeze(['flag_capture']);

/** Client -> server Conquest intent frame `{t:'conquest', ...}` (one field per frame is enough). */
export const CONQUEST_INTENT_SHAPE = Object.freeze({
  deploy: '{spawn:"hq"|"flag:A".."flag:E"|"squad:<playerId>"|"vehicle:<vehicleId>"|"vehicle:<vehicleId>:<seatId>", kit:KIT_ID, variant:0|1}',
  spot: '1',
  support: '{type:"revive"|"repair", targetId:string}',
});
/** input.vehicleAction types (parsed by parseVehicleAction). */
export const VEHICLE_ACTION_TYPES = Object.freeze(['enter', 'exit', 'seat', 'cm', 'weapon']);
// enter {vehicleId, seatId?} | exit {} | seat {seatId} | cm {} | weapon {index}

export const DAMAGE_CLASSES = Object.freeze(['small', 'mg', 'hmg', 'autocannon', 'explosive', 'he', 'at', 'aa', 'fire']);
export const ARMOR_CLASSES = Object.freeze(['light', 'heavy', 'air']);
export const HIT_ZONES = Object.freeze(['front', 'side', 'rear', 'top', 'bottom']);

export const VEHICLE_TYPE_IDS = Object.freeze(['jeep', 'tank', 'helicopter', 'transport', 'plane']);
export const VEHICLE_WEAPON_META = Object.freeze({
  tankAP:           Object.freeze({ label: '120MM AP',   kind: 'shell',   cls: 'at',         speed: 170, gravity: 6, rate: 1 / 3.5, presentation: 'rocket' }),
  tankHE:           Object.freeze({ label: '120MM HE',   kind: 'shell',   cls: 'he',         speed: 140, gravity: 6, rate: 1 / 3.5, presentation: 'rocket' }),
  coaxMG:           Object.freeze({ label: 'COAX 7.62',  kind: 'hitscan', cls: 'mg',         speed: 0,   gravity: 0, rate: 10,      presentation: 'lmg' }),
  hmg:              Object.freeze({ label: '.50 HMG',    kind: 'hitscan', cls: 'hmg',        speed: 0,   gravity: 0, rate: 8,       presentation: 'lmg' }),
  helicopterRocket: Object.freeze({ label: 'ROCKET POD', kind: 'rocket',  cls: 'he',         speed: 90,  gravity: 0, rate: 5,       presentation: 'rocket' }),
  chinCannon:       Object.freeze({ label: '25MM CHIN',  kind: 'shell',   cls: 'autocannon', speed: 260, gravity: 2, rate: 5,       presentation: 'mgl' }),
  doorMinigun:      Object.freeze({ label: 'DOOR GUN',   kind: 'hitscan', cls: 'mg',         speed: 0,   gravity: 0, rate: 18,      presentation: 'minigun' }),
  planeCannon:      Object.freeze({ label: '20MM CANNON',kind: 'hitscan', cls: 'autocannon', speed: 0,   gravity: 0, rate: 14,      presentation: 'minigun' }),
  aaMissile:        Object.freeze({ label: 'AA MISSILE', kind: 'missile', cls: 'aa',         speed: 150, gravity: 0, rate: 1 / 7.5, presentation: 'rocket' }),
});
export const COUNTERMEASURES = Object.freeze({ tank: 'smoke', helicopter: 'flares', transport: 'flares', plane: 'flares', jeep: null });

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
    S('gunner', 'gunner', false, false, false, [M('chin', ['chinCannon'])]),
  ]),
  transport: Object.freeze([
    S('driver', 'pilot', true, false, false, []),
    S('door-left', 'gunner', false, true, false, [M('door-left', ['doorMinigun'])]),
    S('door-right', 'gunner', false, true, false, [M('door-right', ['doorMinigun'])]),
    S('rear-left', 'passenger', false, false, false, []),
    S('rear-right', 'passenger', false, false, false, []),
  ]),
  plane: Object.freeze([
    S('driver', 'pilot', true, false, false, [M('nose', ['planeCannon']), M('rails', ['aaMissile'])]),
  ]),
});
/** Flattened mount order used by vehicle rows `mounts[]`. */
export const vehicleMountOrder = type => (VEHICLE_TOPOLOGY[type] || []).flatMap(seat => seat.mounts.map(m => `${seat.id}:${m.id}`));
/** Weapons a seat cycles through with `{type:'weapon', index}`; index into this list. */
export const seatWeaponList = (type, seatId) => ((VEHICLE_TOPOLOGY[type] || []).find(s => s.id === seatId)?.mounts || []).flatMap(m => m.weapons.map(w => ({ mount: m.id, weapon: w })));

/** Vehicle row status bitfield `st`. */
export const VEHICLE_STATUS = Object.freeze({ engine: 1, disabled: 2, burning: 4, immobilized: 8, flares: 16, smoke: 32, grounded: 64, wreck: 128 });
export const vehicleStatus = row => Object.fromEntries(Object.entries(VEHICLE_STATUS).map(([k, bit]) => [k, ((row?.st | 0) & bit) !== 0]));

/** Player row field `cq` (Conquest only): [kitIndex(-1 none), squadId(0 none), down(0/1), spotted(0/1), restrictedDs (tenths of s left, 0 none), lockProgress(0..100), actionProgress(0..100)] */
export const decodeConquestPlayer = row => {
  const cq = Array.isArray(row?.cq) ? row.cq : null;
  if (!cq) return null;
  return { kit: KIT_IDS[cq[0]] ?? null, squad: cq[1] | 0, down: cq[2] === 1, spotted: cq[3] === 1,
    restrictedMs: (cq[4] | 0) * 100, lockProgress: (cq[5] | 0) / 100, actionProgress: (cq[6] | 0) / 100 };
};
/** Player row field `cqs` (Conquest only, per-player counters): [objectiveScore, vehiclesDestroyed, revives, captures] */
export const decodeConquestStats = row => {
  const s = Array.isArray(row?.cqs) ? row.cqs : [0, 0, 0, 0];
  return { objective: s[0] | 0, vehicles: s[1] | 0, revives: s[2] | 0, captures: s[3] | 0 };
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
  river: Object.freeze({ points: Object.freeze([[384, 0], [396, 150], [384, 384], [372, 618], [384, 768]]), width: 12, depth: 3, surfaceY: 21 }),
  crossings: Object.freeze([
    Object.freeze({ id: 'bridge-north', kind: 'bridge', x: 396, z: 150, width: 8 }),
    Object.freeze({ id: 'ford-north',   kind: 'ford',   x: 392, z: 270, width: 14 }),
    Object.freeze({ id: 'iron-bridge',  kind: 'bridge', x: 384, z: 384, width: 10 }),
    Object.freeze({ id: 'ford-south',   kind: 'ford',   x: 376, z: 498, width: 14 }),
    Object.freeze({ id: 'bridge-south', kind: 'bridge', x: 372, z: 618, width: 8 }),
  ]),
  heights: Object.freeze({ bedrock: 0, waterSurface: 21, valleyMin: 24, valleyMax: 32, hqPlateau: 36, ridgeMax: 60, landmarkMax: 78 }),
});
