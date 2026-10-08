import { weaponTurnProfile } from '../shared/weapon-handling.js';
import { groundRoute, groundSegmentClear, navigationWaypoint, surfaceNavigation } from './bot-navigation.js';
import { canHopObstacle } from './bot-locomotion.js';
import { boxCollides, findVault, solidBelow } from '../shared/player-movement.js';
import { AimSteering } from './bot-aim.js';
import { hearNoise } from './bot-hearing.js';
// Direct-injection bots. They register with a GameEngine as pseudo-clients
// ('bot-<i>') and drive the exact same applyInput -> integrate -> fire
// pipeline humans use, so balance is identical. No sockets anywhere.
//
// Behavior: roaming to surface spots with ground routes on supported maps,
// clearance-checked obstacle hops elsewhere, limited-field stance-aware voxel LOS,
// delayed recognition and a brief search of the last observed position,
// burst-fire combat (3-5 shots then a 300 ms breath), shrinking aim error as
// engagement time ramps skill, velocity-continuous aim curves with
// time-correlated wander, skill-scaled lead on moving targets and a simulated
// view kick the bot pulls against (see bot-aim.js), hearing of gunshots and
// hurried footsteps that sends an idle bot to investigate (see bot-hearing.js),
// perpendicular strafing while fighting, panic retreat to a cover spot the
// enemy cannot see, dry-mid-fight weapon cycling, and a stuck watchdog that
// reroutes anything wedged on geometry. RIPTIDE holders lead the disc by its
// flight time, throw only inside its reach, press R to turn a disc that just
// cut someone (or a far one while both are out) and fall back to the revolver
// outside the disc's range band. IRON PICK (melee) holders close in, sprint
// into the swing for the knockback hit and hop so it lands on the fall as a crit.

import {
  AIR, FLUID_BLOCKS, worldDimensions, GROUND,
} from '../shared/worlddata.js';
import { WEAPON_IDS, WEAPONS, PLAYER_HALF, computeRecoilKickDeg } from '../shared/combatmath.js';
import { DEFAULT_WEAPON_ID, WEAPON_PRICES } from '../shared/modes.js';
import { MAX_BOTS } from '../shared/lobby-limits.js';
import { mulberry32 } from '../shared/noise.js';
import { raycastVoxels } from '../shared/raycast.js';
import { DUST2_NAV_FLOORS, dust2FloorsAt } from '../shared/world/dust2-layout.js';
import { observeBotTarget, recognitionThreshold } from './bot-perception.js';
import { botDifficulty, DEFAULT_BOT_DIFFICULTY, isBotDifficulty, BOT_AIRCRAFT_SIGHT_RANGE } from '../shared/bot-difficulty.js';
import { BOT_PERSONALITIES, DEFAULT_BOT_PERSONALITY, isBotPersonality, rollBotPersonality } from '../shared/bot-personality.js';
import { cancelCharge } from './sim/combat.js';
import { wrapAngle } from './sim/player.js';
import { glaiveDef } from './sim/projectiles.js';
import { BUBBLE_RULES, bubbleFlight, bubbleProfile } from '../shared/bubble-rules.js';
import { MGL_RULES } from '../shared/mgl-rules.js';
import { FLAME_RULES } from '../shared/flame-rules.js';
import { ConquestVehicleDriving } from './bot-vehicle-driving.js';
import { BotCommander, createBotDirector } from './bot-commander.js';
import { ConquestAircraftDriving } from './bot-aircraft.js';
import { applyConquestVehicleCombat, applyMountedCombat, ballisticAim, bestWeaponFor, clearFlight, infantryArmorEffect, pickBotThreat, vehicleHullRules, STINGER_ENGAGE_RANGE } from './bot-vehicle-combat.js';
import { CONQUEST_RULES } from '../shared/conquest-contract.js';
import { KIT_ROLE_RULES } from '../shared/conquest-kits.js';
import { TerrainWatch } from './bot-surface-nav.js';
import { isAircraft } from '../shared/vehicles.js';
import { ROCKET_RULES } from '../shared/rocket-rules.js';
import { ballisticIntercept, ballisticProfile } from '../shared/bullet-ballistics.js';

const TAU = Math.PI * 2;
const PITCH_TURN_RATE = 4.0;      // rad/s vertical tracking cap
const AIM_TOLERANCE = 0.075;      // turn onto a target before pulling the trigger
const ARRIVE_DIST = 2.0;          // roam target reached
const ROAM_TIMEOUT_MS = 8000;     // forced re-target
const RETREAT_HP = 30;            // coward line
const RETREAT_MS = 4000;          // how long a retreat lasts
const RETREAT_COOLDOWN_MS = 2500; // before the next panic
const STRAFE_HZ = 1.5;            // perpendicular wobble while fighting
const LEAD_S = 0.08;              // seconds of target motion a fully skilled bot leads
const SCAN_EVERY = 2;             // idle bots look for new targets every n ticks
const LISTEN_EVERY = 3;           // ... and listen every n ticks
const HEARD_STEP_MS = 2500;       // how long footsteps stay worth a look
const RECOIL_RESET_DEFAULT_MS = 280;
const JUMP_CD_MS = 650;           // between hops
const STUCK_WINDOW_MS = 1000;     // displacement sample window
const STUCK_DIST = 0.35;          // less than this over the window == wedged
const BOT_SEED = 0x00B0755;
const DEFAULT_WEAPON_SLOT = WEAPON_IDS.indexOf(DEFAULT_WEAPON_ID);
const BUY_PRIORITY = Object.freeze(['sniper', 'lmg', 'rocket', 'longarc', 'lance', 'glaive', 'rifle', 'shotgun', 'smg']);
// Capturing a flag is not urgent: bots inside a zone keep hearing, retreating
// and, above all, shooting while they hold it (Conquest P0).
const URGENT_GOALS = new Set(['plant', 'recoverBomb', 'defuse']);
const ADVANCE_FIGHT_DIST = 16;    // m: farther enemies are fought while still walking the route
const CLOSE_IN_MAX = 75;          // m: attackers close infantry contacts nearer than this
const CLOSE_IN_SLACK = 8;         // m beyond the personality's duel range before closing in
// Held points: the director's defend/stage stances and the recon overwatch role.
const HOLD_STANCES = new Set(['defend', 'overwatch', 'stage']);
/** Bot-side stance of a director goal: its role (overwatch, support) when it has one. */
const goalStance = goal => goal?.role ?? goal?.stance ?? null;
const TRAVEL_LOOK_RANGE = 60;     // m: known contacts nearer than this turn a travelling bot's eyes
const ADS_RANGE = 18;             // m: Conquest bots aim down sights beyond this
const STOP_AND_POP_RANGE = 30;    // m: ranged bursts are fired standing
const ZONE_EDGE = 0.72;           // fraction of the flag radius where zone strafing turns inward
const LOOK_SWEEP = 70 * Math.PI / 180; // idle look-around half-width
const DAMAGE_MEMORY_MS = 4000;    // how long the last damage direction draws the eye
const HULL_EVADE_DIST = 38;       // m: an untouchable hull this close sends the bot to cover
const SPOT_MIN_INTERVAL_MS = 1600;
const SUPPORT_INTENT_MS = 150;    // revive/repair intents re-sent faster than the 350 ms staleness
const UNSTICK_MS = 450;           // jump/vault window after the stuck watchdog fires
const TRAP_RADIUS = 8;            // m: a body that leaves this circle is making progress
const TRAP_MS = 12000;            // ms boxed inside it (swimming, or wedged again and again) before a redeploy
const TRAP_SWIM_MS = 10000;       // ... of which this long treading water marks a swimmer as trapped
const TRAP_WEDGES = 6;            // stuck-watchdog firings inside the circle that mark a dry body as trapped
const LEDGE_PROBE = 0.9;          // m: a walker's next step is checked this far ahead for a fall
const LEDGE_MAX_DROP = 3;         // voxels: deeper unsupported drops (the surface graph's limit) are ledges
// Key sets as [forward, side]: the ledge guard picks the closest safe one.
const KEY_DIRS = Object.freeze([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]);
const TERRAIN_POLL_MS = 250;      // surface graph and cover refresh from the changed-block log
const FLANK_RANGE = 40;           // m: engineers work armour from the side at this stand-off
const RELOAD_COVER_DIST = 45;     // m: a dry magazine this close to an enemy sends the bot to cover
// Free rosters never hold kit-only gadgets (the Conquest STINGER).
const ALL_WEAPON_SLOTS = Object.freeze(WEAPON_IDS.map((_, slot) => slot).filter(slot => !WEAPONS[WEAPON_IDS[slot]]?.gadgetOnly));
const PLANT_READY_DIST = 2.0;
const DEFUSE_READY_DIST = 1.6;
const RECOVER_READY_DIST = 0.8;
const DEFEND_ARRIVE_DIST = 4.0;
const OBJECTIVE_DETOUR_MS = 1600;
const GLAIVE_SLOT = WEAPON_IDS.indexOf('glaive');
const GLAIVE_MIN_RANGE = 4;       // m: closer and the disc's out leg is wasted
const GLAIVE_MAX_RANGE = 18;      // m: the out leg's reach without Long tether
const GLAIVE_BAND_SLACK = 1;      // m of hysteresis before swapping away
const GLAIVE_SWAP_CD_MS = 1200;   // between range-band weapon swaps
const GLAIVE_RETURN_HIT_MS = 250; // R turns a disc this soon after its out-hit
const GLAIVE_RETURN_FAR = 12;     // ... or once it is this far out with no disc seated
const GLAIVE_RETURN_MIN_AGE_MS = 300; // never while a fresh disc is still leaving the hand
const GLAIVE_LINEUP_COS = Math.cos(15 * Math.PI / 180);
const BUBBLE_SLOT = WEAPON_IDS.indexOf('bubble');
const STINGER_SLOT = WEAPON_IDS.indexOf('stinger');
const BUBBLE_MAX_RANGE = 24;      // m: Soap Shots still connect (the lifetime pops them at ~27 m)
const BUBBLE_DRAW_RANGE = 12;     // m: redraw the launcher / blow a Big Bubble inside this
const BUBBLE_GROUP_DIST = 3.5;    // m: a second enemy this close to the target earns a Big Bubble
const BUBBLE_SWAP_CD_MS = 2500;   // between SUDSBLASTER range swaps
const MGL_MAX_RANGE = 52;          // reliable lower-arc reach with room for lead and aim error
const SUPPORT_HOLD_MARGIN = 0.4;  // m: a revive/repair hold stops the legs this far inside the 3D reach ...
const SUPPORT_HOLD_FLAT = 1.2;    // m: ... or this close on the flat (a body on a step above)
const MEDKIT_BOT_HP = 50;         // Conquest bots patch up with the medkit (J) below this HP ...
const MEDKIT_QUIET_MS = 2000;     // ... once no contact has been seen this long
const FLAME_SLOT = WEAPON_IDS.indexOf('flamethrower');
// F-4 FIRESTORM bands (hysteresis): any packet that lands sets the target alight, so a
// Pyro bot burns out to the stream's reach and only gives way to the revolver well past it.
export const FLAME_FIRE_RANGE = FLAME_RULES.range - 1;   // m: open up inside this (aim distance)
export const FLAME_DRAW_RANGE = FLAME_RULES.range - 2;   // m: redraw the flamethrower inside this
export const FLAME_SWAP_RANGE = FLAME_RULES.range + 6;   // m: past this a contact gets the revolver
export const PYRO_PRESS_RANGE = 55;       // m: a Pyro closes contacts nearer than this flamethrower first, sprinting
const MELEE_CLOSE = 1.3;          // m: stop pressing forward this close to the body
const MELEE_SPRINT_DIST = 1.7;    // m: sprint in until here so the swing shoves hard
const MELEE_HOP_DIST = 3.2;       // m: hop inside this so the swing lands falling (crit)
const MELEE_HOP_CD_MS = 1600;     // between crit hops (scaled by the personality's hop rate)
const MELEE_AIM_TOLERANCE = 0.3;  // rad: the 110-degree swing cone forgives loose aim
const MELEE_REACH_SLACK = 0.1;    // m inside the server's centre-distance reach
const MELEE_SWAP_DIST = 14;       // m: past this a pick holder draws any loaded gun it owns

const enemyFlatEarly = (enemy, p) => Math.hypot(enemy.x - p.x, enemy.z - p.z);

function dist3(ax, ay, az, bx, by, bz) {
  return Math.hypot(bx - ax, by - ay, bz - az);
}

function standable(world, x, z, preferredY = null) {
  x |= 0; z |= 0;
  const surface = surfaceNavigation(world);
  if (surface) {
    // Heightfield maps: the dry floor nearest the preferred (or graph) height.
    const ref = Number.isFinite(preferredY) ? Math.round(preferredY)
      : surface.snap({ x: x + 0.5, z: z + 0.5 }, 1)?.y;
    if (!Number.isFinite(ref)) return null;
    const feet = surface.floorNear(x + 0.5, z + 0.5, Math.round(ref), 2, 4);
    if (!Number.isFinite(feet) || FLUID_BLOCKS.has(world.getBlock(x, feet, z))) return null;
    return { x: x + 0.5, y: feet + 0.02, z: z + 0.5 };
  }
  if (world.mapId === 'dust2') {
    const floors = [...dust2FloorsAt(x, z)];
    if (preferredY !== null) floors.sort((a, b) => Math.abs(a + 1 - preferredY) - Math.abs(b + 1 - preferredY));
    for (const h of floors) {
      if (world.getBlock(x, h, z) !== AIR && !FLUID_BLOCKS.has(world.getBlock(x, h, z))
        && world.getBlock(x, h + 1, z) === AIR && world.getBlock(x, h + 2, z) === AIR) {
        return { x: x + 0.5, y: h + 1.02, z: z + 0.5 };
      }
    }
    return null;
  }
  const h = world.meta?.navigationFloor ?? world.heightAt(x, z);
  const [lowest, highest] = world.meta?.standHeights || [GROUND - 1, GROUND + 9];
  if (h < lowest || h > highest) return null;
  if (world.getBlock(x, h, z) === AIR) return null;
  if (world.getBlock(x, h + 1, z) !== AIR || world.getBlock(x, h + 2, z) !== AIR) return null;
  if (FLUID_BLOCKS.has(world.getBlock(x, h, z))) return null;
  return { x: x + 0.5, y: h + 1.02, z: z + 0.5 };
}

function randSpot(world, rng, from) {
  const { sx: SX, sz: SZ } = worldDimensions(world);
  const surface = surfaceNavigation(world);
  if (surface) return surface.randomSpot(from, rng) ?? { x: from.x, y: from.y, z: from.z };
  if (world.mapId === 'dust2') {
    const count = DUST2_NAV_FLOORS.length / 3;
    const start = Math.floor(rng() * count);
    for (let n = 0; n < count; n++) {
      const i = ((start + n) % count) * 3;
      const spot = standable(world, DUST2_NAV_FLOORS[i], DUST2_NAV_FLOORS[i + 1], DUST2_NAV_FLOORS[i + 2] + 1);
      if (spot) return spot;
    }
    return { ...world.meta.spawns.fun[0] };
  }
  for (let i = 0; i < 14; i++) {
    const s = standable(world, (8 + rng() * (SX - 16)) | 0, (8 + rng() * (SZ - 16)) | 0);
    if (s && (!Number.isFinite(world.meta?.navigationFloor) || groundRoute(world, from, s).length)) return s;
  }
  if (Number.isFinite(world.meta?.navigationFloor)) return { x: from.x, y: from.y, z: from.z };
  return { x: SX / 2, y: (world.meta?.groundLevel ?? GROUND) + 1.02, z: SZ / 2 };
}
/** Spiral out from a swimmer to the closest dry, standable footing. */
function nearestDry(world, from) {
  for (let r = 2; r <= 12; r += 2) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const spot = standable(world, from.x + Math.cos(a) * r, from.z + Math.sin(a) * r, from.y);
      if (spot) return spot;
    }
  }
  return null;
}

function eyeOf(p) {
  return [p.x, p.eyeY, p.z];
}

/**
 * Where a projectile of `speed` m/s meets a target moving on the ground:
 * horizontal velocity times flight time, scaled by skill. Returns [dx, dz].
 */
function projectileLead(target, dist, speed, skill = 1) {
  const t = (dist / speed) * skill;
  return [(target.vx || 0) * t, (target.vz || 0) * t];
}

/** Low-arc launch angle for a stationary target at horizontal distance and height. */
function mglAimPitch(horizontal, vertical) {
  const x = Math.max(0.35, horizontal);
  const speed2 = MGL_RULES.speed ** 2;
  const discriminant = speed2 ** 2 - MGL_RULES.gravity
    * (MGL_RULES.gravity * x ** 2 + 2 * vertical * speed2);
  if (discriminant < 0) return null;
  return Math.atan((speed2 - Math.sqrt(discriminant)) / (MGL_RULES.gravity * x));
}

/** The RIPTIDE's engagement reach: 18 m, stretched by Long tether's longer out leg. */
function glaiveReach(rules) {
  return GLAIVE_MAX_RANGE * rules.outMs / WEAPONS.glaive.glaive.outMs;
}

function goalPoint(goal) {
  const target = goal?.target;
  return target
    && Number.isFinite(target.x)
    && Number.isFinite(target.y)
    && Number.isFinite(target.z)
    ? target
    : null;
}

function goalArrivalDist(kind) {
  if (kind === 'plant') return PLANT_READY_DIST;
  if (kind === 'defuse') return DEFUSE_READY_DIST;
  if (kind === 'recoverBomb') return RECOVER_READY_DIST;
  return DEFEND_ARRIVE_DIST;
}

class Brain {
  constructor(id, index, rng, difficulty = DEFAULT_BOT_DIFFICULTY, personalitySeed = 0) {
    this.difficulty = isBotDifficulty(difficulty) ? difficulty : DEFAULT_BOT_DIFFICULTY;
    this.id = id;
    this.index = index;
    this.rng = rng;
    // One roll per slot per game on an isolated stream: gameplay rng stays untouched.
    const roll = mulberry32(((personalitySeed ^ Math.imul(index + 1, 2654435761)) >>> 0) || 1);
    this.personality = rollBotPersonality(roll);
    if (!isBotPersonality(this.personality)) this.personality = DEFAULT_BOT_PERSONALITY;
    this.seq = 0;
    this.skill = 0.25 + rng() * 0.3;   // ramps toward 1 while fighting
    this.aim = new AimSteering();      // eased yaw/pitch curves + correlated wander + kick
    this.lastShotSeq = -1;
    this.lastShotAt = 0;
    this.recoilIndex = 0;
    this.shotSeqHeard = new Map();     // entity id -> shotSeq at the last listen
    this.lastListenTick = -Infinity;   // manager tick of the last listen
    this.state = 'roam';               // 'roam' | 'fight' | 'search' | 'retreat'
    this.roamTarget = null;
    this.roamDeadline = 0;
    this.enemyId = null;
    this.sighting = null;
    this.noticeId = null;
    this.noticeProgress = 0;
    this.noticeElapsed = 0;
    this.noticeEvidence = 0;
    this.noticeThreshold = 1;
    const pers = BOT_PERSONALITIES[this.personality];
    this.reactionScale = (0.9 + rng() * 0.2) * pers.reaction;
    this.hopCdMs = JUMP_CD_MS / pers.hop;
    this.crouchFight = false;
    this.lastSeen = null;
    this.engagedMs = 0;
    this.strafePhase = rng() * TAU;
    this.jumpCdUntil = 0;
    this.burstEnd = 0;
    this.pauseUntil = 0;
    this.inBurst = false;
    this.retreatUntil = 0;
    this.retreatReadyAt = 0;
    this.lastLives = -1;
    this.spawnSwitchPending = false;
    this.buyRound = null;
    this.goalKind = null;
    this.detourUntil = 0;
    // Stuck watchdog (positions latched lazily on first tick).
    this.intendsMove = false;
    this.stuckSince = 0;
    this.watchX = null;
    this.watchZ = 0;
    this.glaiveSwapAt = 0;           // earliest next RIPTIDE range-band swap
    this.bubbleSwapAt = 0;           // earliest next SUDSBLASTER range swap
    this.bubbleBig = false;          // the current trigger pull blows a Big Bubble
    this.critHopAt = 0;              // earliest next IRON PICK crit hop
  }

  /** Drop combat memory but keep navigation/skill continuity. */
  resetCombat() {
    this.enemyId = null;
    this.sighting = null;
    this.noticeId = null;
    this.noticeProgress = 0;
    this.noticeElapsed = 0;
    this.noticeEvidence = 0;
    this.noticeThreshold = 1;
    this.lastSeen = null;
    this.inBurst = false;
    this.burstEnd = 0;
    this.pauseUntil = 0;
    this.engagedMs = 0;
    if (this.state === 'fight' || this.state === 'search') this.state = 'roam';
  }
}

class BotManager {
  /**
   * @param {object} game GameEngine instance (world/addBot/entities/applyInput/
   *        now/registerTickHook/removeClient)
   * @param {number} n bot count
   */
  constructor(game, n, { difficulties = new Map(), personalitySeed = 0 } = {}) {
    this.difficulties = new Map(difficulties);
    this.personalitySeed = personalitySeed >>> 0;
    this.game = game;
    this.solidAt = this.game.solidAt;
    this.brains = [];
    this.tickIndex = 0;                 // staggers idle scans and listening across bots
    this.vehicleDriving = new ConquestVehicleDriving(game, this);
    this.aircraftDriving = new ConquestAircraftDriving(game, this);
    // Heightfield maps: build the 2.5D surface graph from the world now (spec:
    // at attach time, not inside the first tick). The change-log cursor lives
    // with the cached graph, so a later manager on the same world resumes it.
    const surface = surfaceNavigation(game.world);
    if (surface && surface.watch?.game !== game) surface.watch = new TerrainWatch(game);
    // Conquest: one commander for both teams, registered as the mode's bot director.
    this.commander = null;
    this.director = null;
    this.attachCommander();
    this._unhook = game.registerTickHook((dt) => this.tick(dt * 1000));
    this.setCount(n | 0);
  }
  /** Conquest only: build the commander and register it with the mode (spec 3.5). */
  attachCommander() {
    if (this.game.mode?.mode !== 'conquest' || this.commander) return;
    this.commander = new BotCommander(this.game, this);
    this.director = this.commander;
    // Per-flag cover sets are precomputed at attach as well.
    this.commander.prepare();
    this.game.mode.setBotDirector?.(createBotDirector(this.commander));
  }

  dispose() {
    if (this.commander) { this.game.mode.setBotDirector?.(null); this.commander = null; this.director = null; }
    this.vehicleDriving.clear();
    this.aircraftDriving.clear();
    if (this._unhook) { this._unhook(); this._unhook = null; }
    for (const br of this.brains) this.game.removeClient(br.id);
    this.brains = [];
  }

  /** Hand the newest bot's complete live entity state to a human player. */
  takeover(humanId, name) {
    const brain = this.brains.at(-1);
    if (!brain) return null;
    const spawnInfo = this.game.takeoverBot(brain.id, humanId, name);
    if (!spawnInfo) return null;
    brain.resetCombat();
    this.vehicleDriving.release(brain.id);
    this.aircraftDriving.release(brain.id);
    this.brains.pop();
    return spawnInfo;
  }

  /** Live roster resize to n bots. Identity is SLOT-STABLE: bot i always has
   *  entity id 'bot-<i>', so repeated resizes can never duplicate or multiply
   *  entities. Stale bot entities from an earlier manager are pruned first. */
  setCount(n) {
    n = Math.max(0, Math.min(MAX_BOTS, n | 0));
    const owned = new Set(this.brains.map((b) => b.id));
    for (const pid of Array.from(this.game.entities.keys())) {
      if (/^bot-\d+$/.test(pid) && !owned.has(pid)) this.game.removeClient(pid);
    }
    while (this.brains.length > n) {
      const br = this.brains.pop();
      this.vehicleDriving.release(br.id);
      this.aircraftDriving.release(br.id);
      br.resetCombat();
      this.game.removeClient(br.id);
    }
    for (let i = this.brains.length; i < n; i++) {
      const pid = 'bot-' + i;
      this.game.addBot(pid);
      this.brains.push(new Brain(pid, i, mulberry32((BOT_SEED ^ Math.imul(i + 1, 2654435761)) >>> 0), this.difficulties.get(pid), this.personalitySeed));
    }
    // Conquest: with the roster complete, freshly spawned bots take their final squad slot kit.
    this.game.mode.policy?.reseedFreshBots?.();
  }
  tick(dtMs) {
    const dtS = dtMs / 1000;
    const now = this.game.now;
    this.tickIndex++;
    this.pollTerrain(now);
    if (this.game.mode.mode === 'conquest') {
      this.attachCommander();
      if (this.game.mode.phase === 'live') this.commander?.update(now);
    }
    this.vehicleDriving.update(this.brains, now);
    this.aircraftDriving.update(this.brains, now);
    for (let i = this.brains.length - 1; i >= 0; i--) {
      const br = this.brains[i];
      const p = this.game.entities.get(br.id);
      if (!p) { this.brains.splice(i, 1); continue; }
      this.watchStuck(br, p, now);
      this.game.applyInput(br.id, this.think(br, p, now, dtS));
    }
  }

  /**
   * Craters and rebuilt voxels reach the 2.5D surface graph and the per-flag
   * cover sets incrementally (4 Hz), never by a wholesale rebuild mid-match.
   */
  pollTerrain(now) {
    const nav = surfaceNavigation(this.game.world);
    if (!nav || now < (this.terrainPollAt ?? 0)) return;
    this.terrainPollAt = now + TERRAIN_POLL_MS;
    if (nav.watch?.game !== this.game) nav.watch = new TerrainWatch(this.game);
    const columns = nav.watch.poll();
    const { sx } = worldDimensions(this.game.world);
    if (columns === null) {
      // The log cannot locate the changes (world restore): every column may
      // have changed. Rebuild the graph (a copy when the map is pristine
      // again); cover sets refresh one flag at a time.
      nav.rebuild();
      nav.revision++;
      this.commander?.cover.markAllChanged();
      return;
    }
    if (!columns.size) return;
    nav.applyChanges(columns);
    this.commander?.terrainChanged(columns, sx);
  }

  /**
   * A firing point on a tank's flank: 40 m out, square to the side nearer the
   * bot (side plate 1.0x, rear 1.5x versus front 0.75x), snapped to cover
   * shielding the tank's bearing when the flag's cover set has one there.
   */
  flankPoint(br, p, tank, now) {
    const cached = br.flank;
    if (cached && cached.id === tank.id && now < cached.until) return cached.point;
    const hull = this.game.vehicles?.vehicles.get(tank.vehicleId);
    if (!hull) return null;
    const toBot = Math.atan2(-(p.x - hull.x), -(p.z - hull.z));
    const side = wrapAngle(toBot - hull.yaw) > 0 ? 1 : -1;
    const yaw = hull.yaw + side * Math.PI * 0.55;
    const raw = { x: hull.x - Math.sin(yaw) * FLANK_RANGE, y: p.y, z: hull.z - Math.cos(yaw) * FLANK_RANGE };
    const covered = this.commander?.cover.coverNear(raw, Math.atan2(-(hull.x - raw.x), -(hull.z - raw.z)), String(p.id), now, 12);
    const point = covered ? { x: covered.x, y: covered.y, z: covered.z }
      : standable(this.game.world, raw.x, raw.z, p.y) ?? null;
    if (covered) this.commander.cover.claim(covered, String(p.id), now, 4000);
    br.flank = { id: tank.id, until: now + 2500, point };
    return point;
  }

  /**
   * Last resort for a body no route gets out of (a shell pit under a bridge
   * deck, the river between quays): after TRAP_MS inside a TRAP_RADIUS circle
   * while swimming, or while the stuck watchdog keeps firing, the bot uses the
   * in-game RESPAWN like a stranded human would (an ordinary death: 1 ticket).
   * Holding a capture zone, or a seat, is never a trap.
   */
  watchTrapped(br, p, now, wet, holding) {
    const trap = br.trap;
    if (!trap || holding || Math.hypot(p.x - trap.x, p.z - trap.z) > TRAP_RADIUS) {
      br.trap = { x: p.x, z: p.z, since: now, wedges: 0, wet: 0 };
      return;
    }
    if (wet) trap.wet = trap.wet || now;
    else trap.wet = 0;
    if (now - trap.since < TRAP_MS) return;
    const swimming = trap.wet && now - trap.wet >= TRAP_SWIM_MS;
    if (!swimming && trap.wedges < TRAP_WEDGES) return;
    br.trap = null;
    this.game.mode.conquestIntent?.(p, { type: 'redeploy' });
  }

  /**
   * A swimmer pulls itself out where a bank is within arm's reach: of the
   * eight key directions, the one closest to the route's next point whose
   * swim exit (the physics' own ledge grab, jump held) lands on dry footing.
   * Normally only exits roughly toward the route count (a planned river
   * crossing keeps swimming); a swimmer that has stopped making progress
   * takes any exit that is not straight back. Checked every third tick.
   */
  swimExit(br, p, inp, toward) {
    if ((this.tickIndex + br.index) % 3 === 0) {
      const sin = Math.sin(inp.yaw), cos = Math.cos(inp.yaw);
      let wx = (toward?.x ?? p.x) - p.x, wz = (toward?.z ?? p.z) - p.z;
      const length = Math.hypot(wx, wz);
      if (length > 0.2) { wx /= length; wz /= length; } else { wx = -sin; wz = -cos; }
      const stalled = !!br.stuckSince || (br.trap?.wedges ?? 0) > 0;
      let best = null, bestDot = stalled ? -0.5 : 0.3;
      for (const [fw, sd] of KEY_DIRS) {
        const l = Math.hypot(fw, sd), dx = (-sin * fw + cos * sd) / l, dz = (-cos * fw - sin * sd) / l;
        const dot = dx * wx + dz * wz;
        if (dot <= bestDot) continue;
        const vault = findVault(this.solidAt, p, { x: dx, z: dz }, p.y, null, 0);
        if (!vault || this.game.fluidAt(Math.floor(vault.to.x), Math.floor(vault.to.y + 0.05), Math.floor(vault.to.z))) continue;
        best = [fw, sd]; bestDot = dot;
      }
      br.swimKeys = best;
    }
    const best = br.swimKeys;
    if (!best) return;
    inp.keys.f = best[0] > 0; inp.keys.b = best[0] < 0;
    inp.keys.r = best[1] > 0; inp.keys.l = best[1] < 0;
    inp.keys.jump = true; inp.keys.crouch = false;
  }

  /**
   * Whether a walker's feet at (x, z), at the body's current height, would go
   * over a ledge: no support under the footprint, no wall or step there, and
   * open water or more than LEDGE_MAX_DROP voxels of air below the centre.
   */
  ledgeAt(p, x, z) {
    const solid = this.solidAt;
    if (solidBelow(solid, x, p.y, z) || boxCollides(solid, x, p.y + 0.05, z)) return false;
    const cx = Math.floor(x), cz = Math.floor(z), feet = Math.floor(p.y + 0.05);
    for (let y = feet - 1; y >= feet - 1 - LEDGE_MAX_DROP; y--) {
      if (this.game.fluidAt(cx, y, cz)) return true;
      if (solid(cx, y, cz)) return false;
    }
    return true;
  }

  /**
   * Surface maps: a grounded walker never steps off a quay, a bridge end or a
   * crater lip by accident (the river banks are too steep to climb back).
   * Movement keys whose world step leads over a ledge are swapped for the
   * closest safe key set (none when every useful direction falls). When the
   * straight step is blocked (a rail, a post), the wall slide follows one axis
   * of the wish, so each axis component is checked as well. A route that
   * swims on purpose (its next node is open water) is left alone.
   */
  guardLedges(br, p, inp) {
    const keys = inp.keys;
    const f = (keys.f ? 1 : 0) - (keys.b ? 1 : 0), s = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
    if (!f && !s) return;
    const next = br.surfaceRoute?.points?.[0];
    if (next && this.game.fluidAt(Math.floor(next.x), Math.floor(next.y + 0.55), Math.floor(next.z))) return;
    const sin = Math.sin(inp.yaw), cos = Math.cos(inp.yaw);
    const world = (fw, sd) => {
      const l = Math.hypot(fw, sd);
      return [(-sin * fw + cos * sd) / l, (-cos * fw - sin * sd) / l];
    };
    const unsafe = ([dx, dz]) => {
      const x = p.x + dx * LEDGE_PROBE, z = p.z + dz * LEDGE_PROBE;
      if (this.ledgeAt(p, x, z)) return true;
      if (!boxCollides(this.solidAt, x, p.y + 0.05, z)) return false;
      return (Math.abs(dx) > 0.2 && this.ledgeAt(p, x, p.z)) || (Math.abs(dz) > 0.2 && this.ledgeAt(p, p.x, z));
    };
    const want = world(f, s);
    if (!unsafe(want)) return;
    let best = null, bestDot = 0.1;
    for (const [fw, sd] of KEY_DIRS) {
      const d = world(fw, sd), dot = d[0] * want[0] + d[1] * want[1];
      if (dot > bestDot && !unsafe(d)) { best = [fw, sd]; bestDot = dot; }
    }
    keys.f = best?.[0] > 0; keys.b = best?.[0] < 0;
    keys.r = best?.[1] > 0; keys.l = best?.[1] < 0;
    if (!best) keys.sprint = false;
  }

  /** Drop dance keys whose world direction has no walkable footing within 1.3 m. */
  guardDanceKeys(p, inp) {
    const sin = Math.sin(inp.yaw), cos = Math.cos(inp.yaw);
    const step = (fx, fz) => groundSegmentClear(this.game.world, p, { x: p.x + fx * 1.3, y: p.y, z: p.z + fz * 1.3 });
    const forward = [-sin, -cos], right = [cos, -sin];
    if (inp.keys.f && !step(forward[0], forward[1])) inp.keys.f = false;
    if (inp.keys.b && !step(-forward[0], -forward[1])) inp.keys.b = false;
    if (inp.keys.r && !step(right[0], right[1])) { inp.keys.r = false; if (step(-right[0], -right[1])) inp.keys.l = true; }
    else if (inp.keys.l && !step(-right[0], -right[1])) { inp.keys.l = false; if (step(right[0], right[1])) inp.keys.r = true; }
  }

  /**
   * Whether the body's current (authoritative) view puts a target inside the
   * server's spot cone: the cone widened by the target's angular radius, as
   * the spotting system measures it. The intent casts from the view the body
   * has now, not from the aim this tick's input is still turning toward.
   */
  spotInView(p, target) {
    const hull = target?.kind === 'hull';
    const ty = hull ? target.eyeY : target.y + 1.15;
    const eyeY = p.eyeY ?? p.y + 1.6;
    const dx = target.x - p.x, dy = ty - eyeY, dz = target.z - p.z, d = Math.hypot(dx, dy, dz);
    if (!(d > 0.01)) return false;
    const yaw = p.yaw, pitch = p.pitch || 0, cp = Math.cos(pitch);
    const cos = (dx * -Math.sin(yaw) * cp + dy * Math.sin(pitch) + dz * -Math.cos(yaw) * cp) / d;
    const radius = hull ? vehicleHullRules(target.type).radius : KIT_ROLE_RULES.spotPlayerRadius;
    return Math.acos(Math.max(-1, Math.min(1, cos))) - Math.atan2(radius, d) <= CONQUEST_RULES.spotConeRad;
  }

  /** Call a recognised contact out to the team (spec F3 spotting), rate-limited. */
  callSpot(br, p, target, now, profile) {
    if (!target || now < (br.spotAt ?? 0) + SPOT_MIN_INTERVAL_MS) return;
    if (br.spottedId === target.id && now < (br.spotAt ?? 0) + profile.spotMs) return;
    // Only a call the spotting cone can confirm spends the rate limit.
    if (!this.spotInView(p, target)) return;
    br.spotAt = now; br.spottedId = target.id;
    this.game.mode.conquestIntent?.(p, { type: 'spot' });
  }

  /** Reroute anything that intended to move but made no progress recently. */
  watchStuck(br, p, now) {
    if (p.state !== 'alive' || !br.intendsMove) {
      br.stuckSince = 0;
      br.watchX = p.x; br.watchZ = p.z;
      return;
    }
    if (br.watchX === null) {
      br.watchX = p.x; br.watchZ = p.z;
      return;
    }
    // Jumping in place is not progress toward a route around an obstacle.
    const moved = Math.hypot(p.x - br.watchX, p.z - br.watchZ);
    if (moved >= STUCK_DIST) {
      br.watchX = p.x; br.watchZ = p.z;
      br.stuckSince = 0;
      return;
    }
    if (!br.stuckSince) { br.stuckSince = now; return; }
    if (now - br.stuckSince >= STUCK_WINDOW_MS) {
      // Replan from the current position without restarting a failed hop.
      // Surface maps side-step a few metres around whatever pins the body (a
      // hull, a wreck, a crater lip) instead of walking off to a random spot.
      br.roamTarget = (surfaceNavigation(this.game.world) && this.sidestepSpot(br, p)) || randSpot(this.game.world, br.rng, p);
      br.roamDeadline = now + ROAM_TIMEOUT_MS;
      br.detourUntil = now + OBJECTIVE_DETOUR_MS;
      br.jumpCdUntil = now + JUMP_CD_MS;
      br.groundRoute = null;
      // Surface maps: replan from where the body really is (craters change the
      // graph under it) and try a jump/vault out of a lip the walk cannot step.
      br.surfaceRoute = null; br.approachNav = null;
      br.unstickUntil = now + UNSTICK_MS;
      br.stuckSince = now;
      if (br.trap) br.trap.wedges++;
    }
  }

  /**
   * A walkable spot 3-6 m to the side of a wedged bot, clear of hulls, on the
   * side that keeps it heading toward its route; alternates sides on repeats.
   */
  sidestepSpot(br, p) {
    const world = this.game.world;
    const heading = br.surfaceRoute?.points?.[0] ?? br.roamTarget ?? null;
    const base = heading ? Math.atan2(-(heading.x - p.x), -(heading.z - p.z)) : p.yaw;
    br.sidestepFlip = !br.sidestepFlip;
    const sides = br.sidestepFlip ? [1, -1] : [-1, 1];
    const hulls = [...this.game.vehicles?.vehicles.values() ?? []].filter(v => v.hp > 0 || v.wreckAge != null);
    for (const r of [4, 6, 3]) for (const side of sides) for (const turn of [Math.PI / 2, Math.PI / 3, Math.PI * 2 / 3]) {
      const yaw = base + side * turn;
      const spot = { x: p.x - Math.sin(yaw) * r, y: p.y, z: p.z - Math.cos(yaw) * r };
      if (hulls.some(v => Math.hypot(v.x - spot.x, v.z - spot.z) < 3.5)) continue;
      if (!groundSegmentClear(world, p, spot)) continue;
      return { x: spot.x, y: p.y, z: spot.z };
    }
    return null;
  }

  /** Nearest visible enemy; a held target must pass every sight check again. */
  pickTarget(p, br = null) {
    const heldId = br?.enemyId;
    const held = heldId ? this.game.entities.get(heldId) : null;
    const observe = target => observeBotTarget(p, target, this.solidAt,
      this.game.projectiles.smoke, this.game.now, target.id === heldId && br?.noticeProgress >= 1, br?.difficulty);
    if (held && held.state === 'alive' && !held.vehicleId && this.game.mode.isEnemy(p, held)) {
      const sighting = observe(held);
      if (sighting) {
        br.sighting = sighting;
        return held;
      }
    }
    if (br) { br.enemyId = null; br.sighting = null; }
    // Nothing held: a fresh sweep costs five raycasts per candidate, so idle
    // bots take turns. First contact moves by at most one skipped tick.
    if (br && (this.tickIndex + br.index) % SCAN_EVERY) return null;
    let best = null, bestSighting = null, bestD = Infinity;
    for (const o of this.game.entities.values()) {
      if (o === held || o.state !== 'alive' || o.vehicleId || !this.game.mode.isEnemy(p, o)) continue;
      const sighting = observe(o);
      if (sighting && sighting.distance < bestD) {
        best = o; bestSighting = sighting; bestD = sighting.distance;
      }
    }
    if (best && br) { br.enemyId = best.id; br.sighting = bestSighting; }
    return best;
  }

  /**
   * R on the RIPTIDE: true when an out-leg disc cut someone within the last
   * quarter second (the back leg finishes them), or when nothing is seated and
   * a disc is far out. R turns every out-leg disc, so it waits while a freshly
   * thrown one is still short of the target. Bots read the discs directly.
   */
  glaiveReturnWanted(p, now) {
    const seated = p.mag[GLAIVE_SLOT] > 0;
    const out = [...this.game.projectiles.active.values()]
      .filter((disc) => disc.type === 'glaive' && disc.owner === p && disc.phase === 'out');
    if (out.some((disc) => now - disc.launchedAt < GLAIVE_RETURN_MIN_AGE_MS)) return false;
    for (const disc of out) {
      if (now - disc.lastOutHitAt < GLAIVE_RETURN_HIT_MS) return true;
      if (!seated && dist3(p.x, p.eyeY, p.z, disc.x, disc.y, disc.z) > GLAIVE_RETURN_FAR) return true;
    }
    return false;
  }

  /** Enemies inside a 15 degree cone of the aim, within `reach` and in clear sight. */
  glaiveLineUp(p, eye, yaw, pitch, reach) {
    const dx = -Math.sin(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = -Math.cos(yaw) * Math.cos(pitch);
    let count = 0;
    for (const o of this.game.entities.values()) {
      if (o === p || o.state !== 'alive' || !this.game.mode.isEnemy(p, o)) continue;
      const tx = o.x - eye[0], ty = (o.eyeY - 0.35) - eye[1], tz = o.z - eye[2];
      const d = Math.hypot(tx, ty, tz);
      if (d < 1e-6 || d > reach || (tx * dx + ty * dy + tz * dz) / d < GLAIVE_LINEUP_COS) continue;
      if (raycastVoxels(this.solidAt, ...eye, tx / d, ty / d, tz / d, d)) continue;
      count++;
    }
    return count;
  }

  /**
   * A Big Bubble pays off against a group or an S&D plant/defuse: the target is close
   * and another enemy stands next to it, or it is holding an objective interaction.
   */
  wantsBigBubble(p, enemy, distance) {
    if (!enemy || !(distance <= BUBBLE_DRAW_RANGE)) return false;
    if (this.game.mode.mode === 'snd' && enemy.interaction) return true;
    for (const o of this.game.entities.values()) {
      if (o === p || o === enemy || o.state !== 'alive' || !this.game.mode.isEnemy(p, o)) continue;
      if (dist3(o.x, o.y, o.z, enemy.x, enemy.y, enemy.z) <= BUBBLE_GROUP_DIST) return true;
    }
    return false;
  }

  /** Loudest enemy noise this bot can hear right now, or null. */
  listen(br, p, profile) {
    const rangeScale = profile.sightRange / 120;
    // Listens skipped while fighting or on an urgent objective leave a stale
    // shotSeq baseline: re-baseline then instead of hearing those old shots.
    const fresh = this.tickIndex - br.lastListenTick <= LISTEN_EVERY;
    br.lastListenTick = this.tickIndex;
    let best = null;
    for (const o of this.game.entities.values()) {
      if (o === p) continue;
      const seen = br.shotSeqHeard.get(o.id);
      br.shotSeqHeard.set(o.id, o.shotSeq);
      if (o.state !== 'alive' || !this.game.mode.isEnemy(p, o)) continue;
      const fired = fresh && seen !== undefined && seen !== o.shotSeq;
      const noise = hearNoise(p, o, fired, this.solidAt, rangeScale);
      if (!noise) continue;
      const rank = (noise.kind === 'shot' ? 10 : 0) + noise.loudness;
      if (!best || rank > best.rank) best = { ...noise, rank, id: o.id, lives: o.lives };
    }
    return best;
  }

  /** Buy one durable S&D primary when needed and expose only legal slots. */
  prepareLoadout(br, p) {
    const mode = this.game.mode;
    if (mode.mode === 'gungame' || mode.mode === 'ttt') {
      const owned = mode.playerSnapshot(p).owned;
      const slots = owned.map((id) => WEAPON_IDS.indexOf(id)).filter((slot) => slot >= 0);
      return slots.length ? slots : [DEFAULT_WEAPON_SLOT];
    }
    if (mode.mode === 'conquest') {
      // Kits narrow the arsenal (WP8 roles set p.owned on every spawn).
      if (!Array.isArray(p.owned)) return ALL_WEAPON_SLOTS;
      const slots = p.owned.map(id => WEAPON_IDS.indexOf(id)).filter(slot => slot >= 0);
      return slots.length ? slots : [DEFAULT_WEAPON_SLOT];
    }
    if (mode.mode !== 'snd') return ALL_WEAPON_SLOTS;

    let snapshot = mode.playerSnapshot(p);
    if (mode.phase === 'prep' && br.buyRound !== mode.round) {
      br.buyRound = mode.round;
      for (const id of BUY_PRIORITY) {
        // A survivor already holding this tier or better keeps its credits.
        if (snapshot.owned.includes(id)) break;
        if (snapshot.credits >= WEAPON_PRICES[id] && mode.purchase(p, id)) {
          snapshot = mode.playerSnapshot(p);
          break;
        }
      }
    }

    const slots = [];
    for (let slot = 0; slot < WEAPON_IDS.length; slot++) {
      if (snapshot.owned.includes(WEAPON_IDS[slot])) slots.push(slot);
    }
    if (!slots.length) slots.push(DEFAULT_WEAPON_SLOT);
    return slots;
  }

  preferredSlot(br, ownedSlots) {
    if (this.game.mode.mode === 'gungame') return ownedSlots[0];
    if (this.game.mode.mode === 'conquest') {
      // The kit primary: the first owned gun that is neither the AT launcher,
      // the sidearm nor a melee tool.
      const primary = ownedSlots.find(slot => {
        const def = WEAPONS[WEAPON_IDS[slot]];
        return def && def.mode !== 'melee' && def.projectile !== 'rocket' && def.projectile !== 'stinger' && WEAPON_IDS[slot] !== 'revolver';
      });
      return primary ?? ownedSlots[0];
    }
    if (this.game.mode.mode !== 'snd') return ownedSlots[br.index % ownedSlots.length];
    for (const id of BUY_PRIORITY) {
      const slot = WEAPON_IDS.indexOf(id);
      if (ownedSlots.includes(slot)) return slot;
    }
    return DEFAULT_WEAPON_SLOT;
  }

  /** The objective for a bot: the Conquest director when attached, else the mode's own goal. */
  goalFor(p) {
    return this.director?.goalFor(p) ?? this.game.mode.botGoal(p);
  }

  /** Conquest: nearest visible threat over infantry, exposed crew and hulls, scored by danger and armour effect. */
  pickThreat(p, br, ownedSlots, now) {
    // A held target is re-checked every tick; full sweeps (five raycasts per
    // candidate, infantry and hulls) take turns like pickTarget's idle scan.
    // An idle bot off its turn keeps the last sweep's danger and waits a tick.
    const scan = !((this.tickIndex + br.index) % SCAN_EVERY);
    if (!scan && !br.enemyId) return null;
    // An Engineer carrying a loaded STINGER scans the sky out to its lock range.
    const stinger = STINGER_SLOT >= 0 && ownedSlots.includes(STINGER_SLOT) && (p.mag[STINGER_SLOT] > 0 || p.reserve[STINGER_SLOT] > 0);
    const result = pickBotThreat(this.game, p, br, {
      scan, now, airSightRange: stinger ? STINGER_ENGAGE_RANGE : null,
      effectFor: (target, distance) => target.kind === 'hull'
        ? infantryArmorEffect(p, ownedSlots, target, distance) : 1,
    });
    if (result?.target) { br.enemyId = result.target.id; br.sighting = result.sighting; br.enemyKind = result.kind; }
    else { br.enemyId = null; br.sighting = null; br.enemyKind = null; }
    br.danger = result?.danger ?? null;
    return result?.target ?? null;
  }

  /** Remember where the last damage came from: the enemy whose aim points at this body. */
  trackDamage(br, p, now) {
    if (br.hpLives !== p.lives || !Number.isFinite(br.lastHp)) { br.hpLives = p.lives; br.lastHp = p.hp; return; }
    if (p.hp < br.lastHp - 0.01) {
      let best = null;
      for (const o of this.game.entities.values()) {
        if (o === p || o.state !== 'alive' || !this.game.mode.isEnemy(p, o)) continue;
        const dx = p.x - o.x, dy = (p.y + 1.1) - (o.eyeY ?? o.y + 1.6), dz = p.z - o.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > 320 || d < 0.01) continue;
        const yaw = o.input?.yaw ?? o.yaw, pitch = o.input?.pitch ?? o.pitch ?? 0;
        const fx = -Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = -Math.cos(yaw) * Math.cos(pitch);
        const angle = Math.acos(Math.max(-1, Math.min(1, (fx * dx + fy * dy + fz * dz) / d)));
        const recent = br.shotSeqHeard.get(o.id) !== o.shotSeq ? 0.6 : 1;
        const score = angle * recent + d * 0.0006;
        if (angle < 0.35 && (!best || score < best.score)) best = { o, score };
      }
      if (best) {
        const o = best.o, hull = o.vehicleId && this.game.vehicles?.vehicles.get(o.vehicleId);
        br.damageFrom = { id: o.vehicleId && hull ? `vehicle:${o.vehicleId}` : o.id, occupantId: o.id,
          x: hull?.x ?? o.x, y: hull?.y ?? o.y, z: hull?.z ?? o.z, at: now };
      } else br.damageFrom = { id: null, x: null, y: null, z: null, at: now, unknown: true };
      br.hurtAt = now;
    }
    br.lastHp = p.hp;
  }

  /** Where an idle Conquest bot looks: fresh damage, then the director's threat axis with a sweep. */
  idleLookYaw(br, p, goal, now, holding) {
    const hurt = br.damageFrom && now - br.damageFrom.at < DAMAGE_MEMORY_MS && Number.isFinite(br.damageFrom.x);
    if (hurt) return Math.atan2(-(br.damageFrom.x - p.x), -(br.damageFrom.z - p.z));
    const heard = br.lastSeen?.position;
    if (heard && Math.hypot(heard.x - p.x, heard.z - p.z) > 2) return Math.atan2(-(heard.x - p.x), -(heard.z - p.z));
    // Contacts the team called out (spotted marks, teammates' sightings).
    const known = this.commander?.knownThreat(p, holding ? botDifficulty(br.difficulty).sightRange : TRAVEL_LOOK_RANGE);
    if (known) return wrapAngle(Math.atan2(-(known.x - p.x), -(known.z - p.z)) + Math.sin(now / 900 + br.strafePhase) * 0.12);
    if (!holding) return null;
    let axis = Number.isFinite(goal?.lookYaw) ? goal.lookYaw : null;
    if (axis === null) {
      const flag = goal?.target;
      axis = flag && Math.hypot(flag.x - p.x, flag.z - p.z) > 3
        ? Math.atan2(-(flag.x - p.x), -(flag.z - p.z)) : p.yaw;
    }
    return wrapAngle(axis + Math.sin(now / 1400 + br.strafePhase) * LOOK_SWEEP);
  }

  think(br, p, now, dtS) {
    const profile = botDifficulty(br.difficulty);
    const pers = BOT_PERSONALITIES[br.personality] || BOT_PERSONALITIES[DEFAULT_BOT_PERSONALITY];
    const weaponTurnRate = weaponTurnProfile(p.def.handling).maxSpeed;
    const turnRate = Math.min(profile.turnRate, weaponTurnRate);
    const pitchTurnRate = Math.min(PITCH_TURN_RATE, weaponTurnRate);
    const cq = this.game.mode.mode === 'conquest';
    // Respawn bookkeeping: a fresh life drops stale targeting/navigation.
    if (br.lastLives !== p.lives) {
      br.lastLives = p.lives;
      br.spawnSwitchPending = true;
      br.resetCombat();
      br.aim.reset();
      br.roamTarget = null;
      br.groundRoute = null;
      br.retreatUntil = 0;
      br.stuckSince = 0;
      br.damageFrom = null;
      br.danger = null;
    }

    const inp = {
      seq: ++br.seq,
      keys: {
        f: false, b: false, l: false, r: false,
        jump: false, sprint: false, crouch: false, interact: false,
      },
      yaw: p.yaw,
      pitch: p.pitch,
      wantFire: false,
      wantAds: false,
      reload: false,
      switchTo: undefined,
    };
    if (p.state !== 'alive') {
      br.intendsMove = false;
      br.resetCombat();
      return inp;
    }

    const ownedSlots = this.prepareLoadout(br, p);

    // Spread fresh Fun/TDM lives across the canonical roster. S&D always
    // selects the strongest owned primary and never probes an unowned slot.
    if (br.spawnSwitchPending) {
      const preferred = this.preferredSlot(br, ownedSlots);
      if (p.weapon === preferred) br.spawnSwitchPending = false;
      else inp.switchTo = preferred;
    }

    let goal = this.goalFor(p);
    if (goal.kind !== br.goalKind) {
      br.goalKind = goal.kind;
      br.detourUntil = 0;
    }
    if (goal.kind === 'spectate') {
      br.intendsMove = false;
      br.resetCombat();
      return inp;
    }
    if (cq) this.trackDamage(br, p, now);

    const vehicleIntent = this.aircraftDriving.think(br, p, goal, now, dtS, inp)
      ?? this.vehicleDriving.think(br, p, goal, now, dtS, inp);
    if (vehicleIntent?.board) {
      // Walking to an assigned seat is an ordinary objective: route, look and
      // fight on the way, then ask for the seat inside enter reach.
      const board = vehicleIntent.board;
      if (board.enter && !inp.vehicleAction) inp.vehicleAction = board.enter;
      goal = { kind: 'board', target: board.point, point: board.point, interact: false, arrive: board.arrive,
        vehicleId: board.vehicleId, lookYaw: goal.lookYaw };
    } else if (vehicleIntent) {
      const v = vehicleIntent.vehicle;
      if (v && vehicleIntent.weapon && inp.vehicleAction?.type !== 'exit') {
        // Every seat that owns mounts fights: tank main gun and coax, the
        // commander RWS, the jeep pintle, door guns and the chin gun.
        const threatAxis = this.director?.threatAxis(p) ?? null;
        const aircraft = isAircraft(v.type);
        const engaged = v.type === 'tank' && vehicleIntent.seatId === 'driver'
          ? applyConquestVehicleCombat(this.game, br, p, now, dtS, inp, ownedSlots, { tank: v, threatAxis })
          : applyMountedCombat(this.game, br, p, v, vehicleIntent.seatId, now, dtS, inp,
            { threatAxis, aircraft, sightRange: aircraft ? BOT_AIRCRAFT_SIGHT_RANGE : undefined });
        if (engaged?.target && engaged.recognized) this.callSpot(br, p, engaged.target, now, profile);
      } else { br.vehicleCombat = null; br.mounted = null; }
      return inp;
    }

    const objective = (cq && goalPoint({ target: goal.point })) || goalPoint(goal);
    const objectiveFlatDist = objective ? Math.hypot(objective.x - p.x, objective.z - p.z) : Infinity;
    const objectiveDist = objective
      ? dist3(p.x, p.y, p.z, objective.x, objective.y, objective.z)
      : Infinity;
    const flag = cq && Number.isFinite(goal.target?.radius) ? goal.target : null;
    const arriveDist = cq && Number.isFinite(goal.arrive) ? goal.arrive
      : cq && flag && !goal.point ? Math.max(DEFEND_ARRIVE_DIST, flag.radius * 0.5)
        : goalArrivalDist(goal.kind);
    // Medic revives and engineer repairs: walk in, then hold the support
    // intent (re-sent well inside its staleness window) while in reach.
    // A revive goal carries the server's 3D reach (reach3): a body a step below or above
    // the feet is only in reach once that distance closes, never from the ledge above it.
    const supportInReach = !!goal.support && !!objective && (Number.isFinite(goal.reach3) ? objectiveDist <= goal.reach3
      : objectiveFlatDist <= (goal.reach ?? 2) && Math.abs(objective.y - p.y) <= 2.5);
    // Well inside reach counts as arrived: the legs stop there with room to spare, so the
    // hold is never walked (or drifted) out of range circling onto the body's exact spot
    // (the server drops a session the moment it is out of reach).
    const objectiveArrived = !!objective && (objectiveFlatDist <= arriveDist || (cq && supportInReach
      && (objectiveDist <= goal.reach3 - SUPPORT_HOLD_MARGIN || objectiveFlatDist <= SUPPORT_HOLD_FLAT)));
    const interactionReady = !!goal.interact && (
      (goal.kind === 'plant' && objectiveFlatDist <= PLANT_READY_DIST
        && Math.abs(objective.y - p.y) <= 1.5)
      || (goal.kind === 'defuse' && objectiveDist <= DEFUSE_READY_DIST)
    );
    inp.keys.interact = interactionReady;
    if (cq && supportInReach && now >= (br.supportAt ?? 0)) {
      br.supportAt = now + SUPPORT_INTENT_MS;
      this.game.mode.conquestIntent?.(p, goal.support);
    }

    const objectiveUrgent = !!objective && URGENT_GOALS.has(goal.kind);
    const combatAllowed = this.game.mode.canFire(p);
    const eye = eyeOf(p);
    if (!combatAllowed) { br.resetCombat(); br.danger = null; }
    const enemy = !combatAllowed ? null : cq ? this.pickThreat(p, br, ownedSlots, now) : this.pickTarget(p, br);
    const hullTarget = enemy?.kind === 'hull';

    if (enemy) {
      if (br.noticeId !== enemy.id) {
        br.noticeId = enemy.id;
        br.noticeProgress = 0;
        br.noticeElapsed = 0;
        br.noticeEvidence = 0;
        br.noticeThreshold = recognitionThreshold(br.rng());
        br.engagedMs = 0;
        br.inBurst = false;
      }
      const previousElapsed = br.noticeElapsed;
      br.noticeElapsed += dtS * 1000;
      const reactionMs = br.sighting.reactionMs * br.reactionScale;
      if (br.noticeElapsed >= reactionMs) {
        const observedSeconds = (Math.max(0, br.noticeElapsed - reactionMs)
          - Math.max(0, previousElapsed - reactionMs)) / 1000;
        br.noticeEvidence += observedSeconds * br.sighting.detectionRate;
        br.noticeProgress = Math.min(1, br.noticeEvidence / Math.max(1e-9, br.noticeThreshold));
      }
      if (br.noticeProgress >= 1 && !hullTarget) {
        br.lastSeen = { id: enemy.id, lives: enemy.lives, until: now + profile.searchMs,
          position: { x: enemy.x, y: enemy.y, z: enemy.z } };
      }
    } else {
      br.noticeId = null;
      br.noticeProgress = 0;
      br.noticeElapsed = 0;
      br.noticeEvidence = 0;
      br.inBurst = false;
      br.engagedMs = 0;
    }
    // Ears fill in when the eyes have nothing: a heard position becomes a
    // remembered one. Sight memory of the same body is refreshed, a gunshot
    // outranks footsteps, and footsteps never overwrite a fresh sighting.
    if (!enemy && combatAllowed && !objectiveUrgent && (this.tickIndex + br.index) % LISTEN_EVERY === 0) {
      const heard = this.listen(br, p, profile);
      if (heard && (!br.lastSeen || br.lastSeen.id === heard.id || br.lastSeen.heard || heard.kind === 'shot')) {
        br.lastSeen = { id: heard.id, lives: heard.lives, heard: true,
          until: now + (heard.kind === 'shot' ? profile.searchMs : HEARD_STEP_MS),
          position: heard.position };
      }
    }
    const remembered = br.lastSeen && this.game.entities.get(br.lastSeen.id);
    if (br.lastSeen && (now >= br.lastSeen.until || remembered?.state !== 'alive'
        || remembered.lives !== br.lastSeen.lives || !this.game.mode.isEnemy(p, remembered))) {
      br.lastSeen = null;
    }

    // ----- state selection -------------------------------------------------
    const retreating = now < br.retreatUntil && !objectiveUrgent;

    let engageMsDelta = 0;
    if (enemy) {
      if (br.state !== 'fight') { br.state = 'fight'; br.strafePhase = br.rng() * TAU; br.crouchFight = br.rng() < pers.crouchFire; }
      engageMsDelta = dtS * 1000;
    } else if (!retreating) {
      br.state = br.lastSeen ? 'search' : 'roam';
    }

    // Skill ramps during fights, cools off when alone.
    br.skill = Math.max(0.2, Math.min(profile.skillCeiling, br.skill + (enemy ? dtS * 0.09 : -dtS * 0.03)));

    // ----- panic retreat ---------------------------------------------------
    // Conquest also backs off from a hull nothing in the loadout can hurt.
    const evadeHull = cq && !enemy && br.danger?.sighting && br.danger.sighting.distance < HULL_EVADE_DIST
      && (br.danger.target.type === 'tank' || br.danger.target.type === 'helicopter') ? br.danger.target : null;
    // Low HP and a dry magazine (Conquest) both fall back to cover.
    const dryNearEnemy = cq && enemy && !hullTarget && p.mag[p.weapon] === 0 && p.reserve[p.weapon] > 0
      && enemyFlatEarly(enemy, p) < RELOAD_COVER_DIST;
    const panicFrom = enemy && (p.hp <= RETREAT_HP * pers.retreatHp || dryNearEnemy) ? enemy : evadeHull;
    // A Medic holding a revive in reach finishes it (1.2 s) before falling back.
    const supportHold = cq && supportInReach && goal.kind === 'revive';
    if (panicFrom && !objectiveUrgent && !supportHold && now >= br.retreatReadyAt && !retreating) {
      const cover = cq ? this.director?.coverFrom(p, panicFrom, goal) : null;
      if (cover) {
        br.roamTarget = cover;
      } else {
        const dx = panicFrom.x - p.x, dz = panicFrom.z - p.z;
        const pl = Math.hypot(dx, dz) || 1;
        const px = -dz / pl, pz = dx / pl;                    // perpendicular
        const cA = standable(this.game.world, (p.x + px * 8) | 0, (p.z + pz * 8) | 0, p.y);
        const cB = standable(this.game.world, (p.x - px * 8) | 0, (p.z - pz * 8) | 0, p.y);
        // Cover the enemy cannot see wins outright; distance breaks ties.
        const eyeY = panicFrom.eyeY ?? panicFrom.y + 1.6;
        const hidden = (s) => {
          const dx = s.x - panicFrom.x, dy = (s.y + 1.2) - eyeY, dz = s.z - panicFrom.z;
          const len = Math.hypot(dx, dy, dz) || 1;
          return !!raycastVoxels(this.solidAt, panicFrom.x, eyeY, panicFrom.z, dx / len, dy / len, dz / len, len);
        };
        const score = (s) => (s ? (hidden(s) ? 1000 : 0) + dist3(s.x, s.y, s.z, panicFrom.x, panicFrom.y, panicFrom.z) : -1);
        br.roamTarget = score(cA) >= score(cB)
          ? (cA || cB || randSpot(this.game.world, br.rng, p))
          : (cB || cA || randSpot(this.game.world, br.rng, p));
      }
      br.roamDeadline = now + RETREAT_MS;
      br.retreatUntil = now + RETREAT_MS;
      br.retreatReadyAt = now + RETREAT_MS + RETREAT_COOLDOWN_MS;
      br.groundRoute = null;
      // Conquest keeps shooting while it falls back; other modes drop the fight.
      if (!cq) br.resetCombat();
    }
    if (now < br.retreatUntil) br.state = enemy && cq ? 'fight' : 'retreat';
    else if (br.state === 'retreat') br.state = 'roam';
    const fallingBack = now < br.retreatUntil && !supportHold;

    // Swimmers head for the nearest dry footing instead of treading water
    // (Conquest also holds the swim-up stroke below).
    const inFluid = this.game.fluidAt(Math.floor(p.x), Math.floor(p.y + 0.55), Math.floor(p.z));
    if (inFluid) {
      const dry = nearestDry(this.game.world, p);
      if (dry) { br.roamTarget = dry; br.roamDeadline = now + 4000; }
    }
    const swimming = cq && inFluid;

    // ----- navigation ------------------------------------------------------
    let takingDetour = !!objective && now < br.detourUntil;
    if (takingDetour && br.roamTarget
        && dist3(p.x, p.y, p.z, br.roamTarget.x, br.roamTarget.y, br.roamTarget.z) < ARRIVE_DIST) {
      br.detourUntil = 0;
      takingDetour = false;
    }
    if (cq && fallingBack) takingDetour = true;

    if ((!objective || takingDetour)
        && (!br.roamTarget
          || now >= br.roamDeadline
          || dist3(p.x, p.y, p.z, br.roamTarget.x, br.roamTarget.y, br.roamTarget.z) < ARRIVE_DIST)) {
      if (!(cq && fallingBack)) {
        br.roamTarget = randSpot(this.game.world, br.rng, p);
        br.roamDeadline = now + ROAM_TIMEOUT_MS;
      }
    }
    const searching = br.state === 'search' && br.lastSeen && !objective;
    const nav = searching ? br.lastSeen.position
      : objective && !takingDetour ? objective : br.roamTarget;
    const waypoint = navigationWaypoint(this.game.world, p, nav, br, now);
    const ndx = waypoint.x - p.x, ndz = waypoint.z - p.z;
    const navDist = Math.hypot(nav.x - p.x, nav.z - p.z) || 1;

    let moveYaw = p.yaw;
    let moving = false;
    let sprint = false;
    const flagDist = flag ? Math.hypot(flag.x - p.x, flag.z - p.z) : Infinity;
    const inZone = !!flag && goal.kind === 'capture' && flagDist <= flag.radius * 0.85
      && Math.abs(p.y - flag.y) <= 8;
    const enemyFlat = enemy ? Math.hypot(enemy.x - p.x, enemy.z - p.z) : Infinity;
    // Conquest: an infantry contact beyond close-in range does not stop a bot
    // on its way (it keeps running the route and calls the contact out); held
    // points, zones and hulls are always fought.
    const farContact = cq && !!enemy && !hullTarget && enemyFlat > CLOSE_IN_MAX && !!objective && !objectiveArrived
      && !inZone && !(objectiveFlatDist < 30 && HOLD_STANCES.has(goalStance(goal)));
    if (farContact && br.noticeProgress >= 1) this.callSpot(br, p, enemy, now, profile);
    const combatAim = br.state === 'fight' && !!enemy && !interactionReady && !farContact;
    // Conquest fights on the move: the trigger never waits for the legs.
    // Conquest motion while the gun is up:
    //  travel   walk the route on (falling back, or the contact is out of reach)
    //  hold     stay on an arrived cover/overwatch/staging/support point and peek
    //  zone     strafe inside the capture circle
    //  approach close a far infantry contact along the surface route
    //  combat   the duel dance (spacing, perpendicular strafe)
    let cqMotion = null;
    // Pyro (a kit flamethrower with fuel): its duel range is the stream's reach, whatever is drawn now.
    const pyroBot = cq && FLAME_SLOT >= 0 && ownedSlots.includes(FLAME_SLOT) && (p.mag[FLAME_SLOT] > 0 || p.reserve[FLAME_SLOT] > 0);
    const duelFar = pyroBot ? FLAME_FIRE_RANGE * 0.6 : pers.far;
    if (cq && combatAim && !objectiveUrgent) {
      // Support goals (revive/repair intents, a Medic standing by a hurt mate) hold their spot.
      const supportGoal = !!goal.support || goal.kind === 'heal';
      const holdPoint = objectiveArrived && (HOLD_STANCES.has(goalStance(goal)) || supportGoal);
      if (fallingBack) cqMotion = 'travel';
      else if (hullTarget) cqMotion = 'combat';
      else if (inZone) cqMotion = 'zone';
      else if (holdPoint) cqMotion = 'hold';
      // A revive or repair not yet in reach walks in shooting on the move: holding still a few
      // metres short (or duelling first) left bodies unrevived next to their Medic.
      else if (goal.support && objective) cqMotion = 'travel';
      else if (supportGoal && objectiveFlatDist < 8) cqMotion = 'hold';
      else if (objective && !objectiveArrived && enemyFlat > CLOSE_IN_MAX) cqMotion = 'travel';
      else if (enemyFlat > duelFar + CLOSE_IN_SLACK && goalStance(goal) !== 'defend') cqMotion = 'approach';
      else if (objective && !objectiveArrived && enemyFlat > ADVANCE_FIGHT_DIST) cqMotion = 'travel';
      else cqMotion = 'combat';
    }
    // Pyro press: an infantry contact inside PYRO_PRESS_RANGE being closed on keeps the
    // flamethrower out (no revolver duel on the way in) and sprints until the stream reaches.
    const pyroPress = pyroBot && !hullTarget && cqMotion === 'approach' && enemyFlat <= PYRO_PRESS_RANGE;
    const combatMovement = cq ? cqMotion === 'combat' || cqMotion === 'zone'
      : br.state === 'fight' && enemy && !objectiveUrgent && !interactionReady;
    // IRON PICK: no magazine, reach-limited — it closes in instead of spacing.
    const melee = p.def.mode === 'melee' && !!p.def.melee;
    // Engage on damage permission, not fire permission: TTT prep lets the knife
    // "fire" but nobody can be hurt, and a live swing would only mine the wall.
    const meleeLive = melee && !!enemy && !hullTarget && this.game.mode.canDamage(p, enemy);
    const wet = (x, z) => this.game.fluidAt(Math.floor(x), Math.floor(p.y + 0.55), Math.floor(z));

    if (combatMovement && cqMotion === 'zone') {
      // Hold the flag: strafe across the line of fire, turning back inward
      // before the circle's edge so the body keeps counting for the capture.
      br.strafePhase += dtS * TAU * STRAFE_HZ * pers.strafeHz;
      const side = Math.sin(br.strafePhase) > 0;
      const dx = enemy.x - p.x, dz = enemy.z - p.z, d = Math.hypot(dx, dz) || 1;
      let wx = (side ? -dz : dz) / d, wz = (side ? dx : -dx) / d;
      if (flagDist > flag.radius * ZONE_EDGE) {
        const ix = (flag.x - p.x) / (flagDist || 1), iz = (flag.z - p.z) / (flagDist || 1);
        wx = wx * 0.35 + ix; wz = wz * 0.35 + iz;
      }
      // Strafe only into open, dry footing: try the wish, its mirror, then
      // straight inward; a body boxed in on all sides holds still and shoots.
      const len = Math.hypot(wx, wz) || 1;
      wx /= len; wz /= len;
      const routed = !!surfaceNavigation(this.game.world) || Number.isFinite(this.game.world.meta?.navigationFloor);
      const open = (x, z) => !wet(p.x + x * 1.3, p.z + z * 1.3)
        && (!routed || groundSegmentClear(this.game.world, p, { x: p.x + x * 1.3, y: p.y, z: p.z + z * 1.3 }));
      const ix = (flag.x - p.x) / (flagDist || 1), iz = (flag.z - p.z) / (flagDist || 1);
      const choice = [[wx, wz], [-wx, -wz], [ix, iz]].find(([x, z]) => open(x, z));
      if (choice) {
        if (choice[0] !== wx) br.strafePhase += Math.PI; // keep the new side for a while
        br.moveWish = { x: choice[0], z: choice[1] };
        moving = true;
      }
      inp.keys.crouch = br.crouchFight && d > 14;
    } else if (combatMovement) {
      // Combat motion: spacing + perpendicular wobble.
      const dx = enemy.x - p.x, dz = enemy.z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      moveYaw = Math.atan2(-dx, -dz);
      br.strafePhase += dtS * TAU * STRAFE_HZ * pers.strafeHz;
      const fx = -Math.sin(moveYaw), fz = -Math.cos(moveYaw);
      let side = Math.sin(br.strafePhase) > 0;
      // Never strafe into open water when the other side is dry.
      if (wet(p.x + fz * (side ? 1.3 : -1.3), p.z - fx * (side ? 1.3 : -1.3))
        && !wet(p.x - fz * (side ? 1.3 : -1.3), p.z + fx * (side ? 1.3 : -1.3))) side = !side;
      inp.keys.l = side;
      inp.keys.r = !side;
      // Anti-armour fire wants a stand-off band rather than a duel range.
      // A drawn flamethrower closes to the stream's reach instead of a duel range.
      const flamer = pyroBot && !hullTarget;
      const far = cq && hullTarget ? 60 : flamer ? duelFar : pers.far;
      const near = cq && hullTarget ? 25 : flamer ? 4 : pers.near;
      if (d > far && !wet(p.x + fx * 1.5, p.z + fz * 1.5)) inp.keys.f = true;
      else if (d < near && !wet(p.x - fx * 1.5, p.z - fz * 1.5)) inp.keys.b = true;
      inp.keys.crouch = br.crouchFight && d > 10;
      moving = true;
      sprint = false;
      // Heavy armour: work round to its side plate at 25-60 m, to cover there when any.
      if (cq && hullTarget && enemy.armor === 'heavy') {
        const flank = this.flankPoint(br, p, enemy, now);
        if (flank) {
          const wp = navigationWaypoint(this.game.world, p, flank, br, now);
          const wx = wp.x - p.x, wz = wp.z - p.z, wl = Math.hypot(wx, wz);
          if (Math.hypot(flank.x - p.x, flank.z - p.z) > 2.5 && wl > 0.3) br.moveWish = { x: wx / wl, z: wz / wl };
          else inp.keys.crouch = now < br.pauseUntil;
        }
      }
      if (melee) {
        // Run straight in (sprinting, so the hit knocks back), circle-strafe only
        // once inside the reach, and hop there so the swing falls as a crit (a
        // sprinting fall stays a knockback hit). No sprint-in or hop unless live.
        const wetAhead = wet(p.x + fx * 1.5, p.z + fz * 1.5);
        inp.keys.f = d > MELEE_CLOSE && !wetAhead;
        inp.keys.b = false;
        inp.keys.crouch = false;
        if (d > MELEE_HOP_DIST) inp.keys.l = inp.keys.r = false;
        sprint = meleeLive && inp.keys.f && d > MELEE_SPRINT_DIST;
        if (d <= MELEE_HOP_DIST && p.grounded && now >= br.critHopAt && meleeLive) {
          inp.keys.jump = true;
          br.critHopAt = now + MELEE_HOP_CD_MS / pers.hop;
        }
      }
    } else if (cqMotion === 'travel') {
      // Walk the route while the aim stays on the enemy: world-space wish.
      const d = Math.hypot(ndx, ndz);
      if (d > 0.35) { br.moveWish = { x: ndx / d, z: ndz / d }; moving = true; }
    } else if (cqMotion === 'approach') {
      // Close a far contact along the surface route (its own route cache, so
      // the objective route survives), weaving a little while the aim holds.
      br.approachNav ??= { index: br.index };
      const wp = navigationWaypoint(this.game.world, p, { x: enemy.x, y: enemy.y, z: enemy.z }, br.approachNav, now);
      let wx = wp.x - p.x, wz = wp.z - p.z;
      const d = Math.hypot(wx, wz);
      if (d > 0.35) {
        br.strafePhase += dtS * TAU * STRAFE_HZ * pers.strafeHz * 0.5;
        const weave = Math.sin(br.strafePhase) * 0.35;
        wx /= d; wz /= d;
        br.moveWish = { x: wx - wz * weave, z: wz + wx * weave };
        moving = true;
        if (pyroPress && p.weapon === FLAME_SLOT && enemyFlat > FLAME_FIRE_RANGE * 0.85) sprint = true;
      }
    } else if (cqMotion === 'hold') {
      // Arrived on a held point: no legs, the peek logic below ducks between bursts.
      moving = false;
    } else if (searching && navDist <= ARRIVE_DIST) {
      // Check around the remembered spot. Do not turn toward hidden movement.
      const scanYaw = Math.atan2(-ndx, -ndz) + Math.sin(now / 350 + br.strafePhase) * 0.9;
      inp.yaw = br.aim.steer('yaw', p.yaw, scanYaw, turnRate, dtS);
    } else if (!objectiveArrived || takingDetour) {
      moveYaw = Math.atan2(-ndx, -ndz);
      // Conquest: near the objective the eyes already sweep its threat axis
      // while the legs finish the walk, so contacts are seen before arrival.
      const nearObjective = cq && !!flag && (inZone || objectiveFlatDist < 30 || flagDist < flag.radius + 15);
      const lookYaw = cq ? this.idleLookYaw(br, p, goal, now, nearObjective) : null;
      if (lookYaw !== null && Math.hypot(ndx, ndz) > 0.35) {
        // Hurt on the move: face the shooter, keep walking the route.
        const d = Math.hypot(ndx, ndz);
        br.moveWish = { x: ndx / d, z: ndz / d };
        inp.yaw = br.aim.steer('yaw', p.yaw, lookYaw, turnRate, dtS);
        moving = true;
      } else {
        // Turn before walking into a nearby graph corner. Sprinting toward a
        // two-metre waypoint while still turning produces tight endless circles.
        const turnError = Math.abs(wrapAngle(moveYaw - p.yaw));
        inp.keys.f = turnError < 0.6 && Math.hypot(ndx, ndz) > 0.35;
        moving = true;
        sprint = Math.hypot(ndx, ndz) > 7 && turnError < 0.3 && !retreating && !searching;
        inp.pitch = br.aim.steer('pitch', p.pitch, Math.atan2((waypoint.y + 1) - eye[1], navDist), pitchTurnRate, dtS);
      }
    } else if (cq && !combatAim) {
      // Holding the objective: look along the threat axis with a sweep.
      const lookYaw = this.idleLookYaw(br, p, goal, now, true);
      inp.yaw = br.aim.steer('yaw', p.yaw, lookYaw, turnRate, dtS);
      inp.pitch = br.aim.steer('pitch', p.pitch, -0.03, pitchTurnRate, dtS);
      // Waist-high cover: duck most of the time, rise to look over it.
      inp.keys.crouch = !!goal.crouch && Math.sin(now / 1700 + br.strafePhase) < 0.35;
    }
    inp.keys.sprint = !!sprint;

    // Aim error shrinks as the fight wears on.
    const errFactor = Math.max(0.55, 1 - br.engagedMs / 4000);

    // Every accepted shot kicks the view the way the client kicks a human's.
    if (p.shotSeq !== br.lastShotSeq) {
      if (br.lastShotSeq >= 0 && p.def.recoil) {
        if (now - br.lastShotAt > (p.def.recoil.resetMs || RECOIL_RESET_DEFAULT_MS)) br.recoilIndex = 0;
        const kick = computeRecoilKickDeg(p.def, br.recoilIndex++, p.adsT, br.rng());
        br.aim.kick(kick.yaw, kick.pitch);
      }
      br.lastShotSeq = p.shotSeq;
      br.lastShotAt = now;
    }
    const recoil = br.aim.recoil(dtS, br.skill);

    let canShoot = false;
    const fightNow = cq ? combatAim && !objectiveUrgent : combatMovement;
    if (fightNow) {
      br.engagedMs += engageMsDelta;

      // Conquest: bring the weapon that hurts this target (the rocket for
      // armour), and put the rocket away again for close infantry.
      let weaponPending = false;
      if (cq && inp.switchTo === undefined) {
        const dist = Math.hypot(enemyFlat, enemy.y - p.y);
        let wanted = hullTarget ? bestWeaponFor(p, ownedSlots, enemy, dist) : null;
        // Launchers give way to a gun for infantry: the AT rocket up close, the STINGER always.
        if (!hullTarget && (p.def.projectile === 'rocket' && dist < 30 || p.def.projectile === 'stinger')) {
          wanted = ownedSlots.find(s => s !== p.weapon && WEAPONS[WEAPON_IDS[s]]?.mode !== 'melee'
            && WEAPONS[WEAPON_IDS[s]]?.projectile !== 'rocket' && WEAPONS[WEAPON_IDS[s]]?.projectile !== 'stinger'
            && (p.mag[s] > 0 || p.reserve[s] > 0)) ?? null;
        }
        if (wanted !== null && wanted !== p.weapon) { inp.switchTo = wanted; weaponPending = true; }
      }

      // Aim at an actually exposed part of the current stance, led by the
      // target's horizontal motion in proportion to skill so the eased
      // steering does not trail a strafing enemy.
      // The RIPTIDE's disc is slow enough that the lead follows its flight time.
      const glaive = p.weapon === GLAIVE_SLOT && !!p.def.glaive;
      const glaiveRules = glaive ? glaiveDef(p).glaive : null;
      const [aimX, aimY, aimZ] = br.sighting.aimPoint;
      // SUDSBLASTER bubbles hook upward: lead by the closed-form flight time and aim
      // under the target by the rise (low skill under-compensates, so misses float over).
      const bubble = p.def.projectile === 'bubble';
      const mgl = p.def.projectile === 'mgl';
      const rocket = cq && p.def.projectile === 'rocket';
      // STINGER: hold the seeker on the hull centre; the missile does the leading.
      const stingerAim = cq && p.def.projectile === 'stinger';
      const mglFlat = mgl ? Math.max(0.35, Math.hypot(aimX - p.x, aimZ - p.z) - MGL_RULES.muzzleForward) : 0;
      const bubbleFlat = bubble ? Math.hypot(aimX - p.x, aimZ - p.z) : 0;
      // Only a Big Bubble actually being blown aims on the Big Bubble profile: a stale
      // flag from the last hold must not null the flight (and so the shot) at 12.5-18 m.
      if (bubble && !p.charging) br.bubbleBig = false;
      const flight = bubble ? bubbleFlight(bubbleProfile(p.charging && br.bubbleBig ? 1 : 0), bubbleFlat) : null;
      const rocketAim = rocket ? ballisticAim(eye, br.sighting.aimPoint, enemy, { speed: ROCKET_RULES.speed,
        gravity: ROCKET_RULES.gravity, maxSeconds: ROCKET_RULES.lifetimeMs / 1000, leadSkill: 0.8 + 0.2 * br.skill }) : null;
      // A flying sniper round: hold over for the drop and lead by its flight time
      // (skill trims the lead a little), on top of the usual steering lead.
      const ballistic = !p.def.projectile ? ballisticProfile(p.def) : null;
      const roundAim = ballistic ? ballisticIntercept(ballistic, eye,
        [aimX + (enemy.vx || 0) * LEAD_S * br.skill, aimY, aimZ + (enemy.vz || 0) * LEAD_S * br.skill],
        [enemy.vx || 0, 0, enemy.vz || 0], 0.8 + 0.2 * br.skill) : null;
      const lead = rocketAim ? [rocketAim.point[0] - aimX, rocketAim.point[2] - aimZ]
        : roundAim ? [roundAim.point[0] - aimX, roundAim.point[2] - aimZ]
        : stingerAim ? [0, 0]
        : glaive
          ? projectileLead(enemy, dist3(eye[0], eye[1], eye[2], aimX, aimY, aimZ), glaiveRules.speedOut, br.skill)
          : mgl ? projectileLead(enemy, mglFlat, MGL_RULES.speed, br.skill)
            : flight ? (flight.t > 0 ? projectileLead(enemy, bubbleFlat, bubbleFlat / flight.t, br.skill) : [0, 0])
              // The FIRESTORM stream flies at FLAME_RULES.speed: lead by its flight time.
              : p.def.flame ? projectileLead(enemy, dist3(eye[0], eye[1], eye[2], aimX, aimY, aimZ), FLAME_RULES.speed, br.skill)
                : [(enemy.vx || 0) * LEAD_S * br.skill, (enemy.vz || 0) * LEAD_S * br.skill];
      const aim = [aimX + lead[0], (rocketAim ? rocketAim.point[1] : aimY) - (flight ? (flight.rise - BUBBLE_RULES.muzzleDrop) * br.skill : 0), aimZ + lead[1]];
      const yawT = Math.atan2(-(aim[0] - p.x), -(aim[2] - p.z));
      const flat = Math.hypot(aim[0] - p.x, aim[2] - p.z) || 1;
      const mglPitch = mgl ? mglAimPitch(Math.max(0.35, flat - MGL_RULES.muzzleForward),
        aim[1] - (eye[1] - MGL_RULES.muzzleDrop)) : null;
      const pitchT = rocketAim ? rocketAim.pitch : roundAim?.pitch != null ? roundAim.pitch : mgl && mglPitch !== null
        ? mglPitch : Math.atan2(aim[1] - eye[1], flat);
      const sigmaDeg = ((2.2 - 1.6 * br.skill) * errFactor + 0.3) * profile.aimError * pers.aimError;
      const sigmaRad = sigmaDeg * Math.PI / 180;
      // Correlated wander drifts the intended point; the eased steering
      // follows it, so the crosshair moves in curves rather than tick jitter.
      // The view kick rides on top: strip last tick's residual, steer the
      // clean aim, add this tick's residual back.
      const wander = br.aim.wander(dtS, sigmaRad, 0.6, br.rng);
      const intendedYaw = wrapAngle(yawT + wander.yaw);
      const intendedPitch = Math.max(-1.4, Math.min(1.4, pitchT + wander.pitch));
      const baseYaw = br.aim.steer('yaw', wrapAngle(p.yaw - recoil.prev.yaw), intendedYaw, turnRate, dtS);
      const basePitch = br.aim.steer('pitch', p.pitch - recoil.prev.pitch, intendedPitch, pitchTurnRate, dtS);
      inp.yaw = wrapAngle(baseYaw + recoil.yaw);
      inp.pitch = Math.max(-1.5, Math.min(1.5, basePitch + recoil.pitch));
      inp.wantAds = (flat > 28 && p.def.id === 'sniper') || (rocket && (enemy.armor === 'air' || flat > 20)) || stingerAim
        // Conquest ranges: aim down sights with any hitscan gun whose sight tightens the cone.
        || (cq && !melee && !p.def.projectile && flat > ADS_RANGE && p.def.spreadDeg?.ads < p.def.spreadDeg?.hip * 0.7);

      // Ammo logistics mid-fight: reload, else cycle to any loaded slot. The
      // RIPTIDE reloads by catching: with a disc still in the air it waits.
      if (melee) {
        // The pick never runs dry; it only gives way to a loaded gun for far targets.
        if (flat > MELEE_SWAP_DIST && inp.switchTo === undefined && !br.spawnSwitchPending) {
          const gun = ownedSlots.find(s => s !== p.weapon && WEAPONS[WEAPON_IDS[s]].mode !== 'melee' && p.mag[s] > 0);
          if (gun !== undefined) inp.switchTo = gun;
        }
      } else if (p.mag[p.weapon] === 0 && !weaponPending) {
        if (p.reserve[p.weapon] > 0) inp.reload = true;
        else if (glaive && this.game.projectiles.glaiveInFlight(p) > 0) { /* catch pending */ }
        else {
          const cur = p.weapon;
          for (let k = 1; k <= WEAPON_IDS.length; k++) {
            const s = (cur + k) % WEAPON_IDS.length;
            if (!ownedSlots.includes(s)) continue;
            if (p.mag[s] > 0 || p.reserve[s] > 0) { inp.switchTo = s; break; }
          }
        }
      }

      // Burst discipline: 3-5 shots, then a breath. The trigger waits for
      // the steering to settle on where the bot believes the target is; the
      // wander and any uncorrected kick then land as misses, not hesitation.
      const aimDistance = Math.hypot(flat, aim[1] - eye[1]);
      const aimTolerance = melee ? MELEE_AIM_TOLERANCE : AIM_TOLERANCE;
      const aimDir = [-Math.sin(inp.yaw) * Math.cos(inp.pitch), Math.sin(inp.pitch), -Math.cos(inp.yaw) * Math.cos(inp.pitch)];
      canShoot = br.noticeProgress >= 1 && !weaponPending
        && Math.abs(wrapAngle(baseYaw - intendedYaw)) < aimTolerance
        && Math.abs(basePitch - intendedPitch) < aimTolerance
        && (rocket || stingerAim ? clearFlight(this.game, p, enemy, eye, aimDir, aimDistance)
          : hullTarget ? clearFlight(this.game, p, enemy, eye, aimDir, aimDistance, { explosive: false })
            : (mgl || !raycastVoxels(this.solidAt, ...eye, ...aimDir, aimDistance)));
      // The STINGER only releases on a complete lock (the server refuses it otherwise).
      if (stingerAim) canShoot &&= hullTarget && (p.lockProgress ?? 0) >= 0.99;
      if (cq && hullTarget && WEAPONS[WEAPON_IDS[p.weapon]] && bestWeaponFor(p, [p.weapon], enemy, aimDistance) === null) canShoot = false;
      // Call the contact out to the team once the crosshair is on it.
      if (cq && br.noticeProgress >= 1 && Math.abs(wrapAngle(baseYaw - intendedYaw)) < 0.12) this.callSpot(br, p, enemy, now, profile);
      // The swing reaches the body centre (server meleeSwing); while a hop still
      // rises the pick waits for the fall, where the hit crits.
      if (melee) canShoot &&= dist3(eye[0], eye[1], eye[2], enemy.x, enemy.y + PLAYER_HALF.h, enemy.z)
        <= p.def.melee.reach + PLAYER_HALF.x - MELEE_REACH_SLACK && !(!p.grounded && p.vy > 0);

      // RIPTIDE: throw only inside its reach, swap to the revolver outside the
      // band, and press R to bring a disc back through the target.
      let lineUp = false;
      if (glaive) {
        const reach = glaiveReach(glaiveRules);
        const inBand = aimDistance >= GLAIVE_MIN_RANGE && aimDistance <= reach;
        const outsideBand = aimDistance < GLAIVE_MIN_RANGE - GLAIVE_BAND_SLACK / 2
          || aimDistance > reach + GLAIVE_BAND_SLACK;
        if (outsideBand && p.mag[p.weapon] > 0 && inp.switchTo === undefined && !br.spawnSwitchPending
            && now >= br.glaiveSwapAt && ownedSlots.includes(DEFAULT_WEAPON_SLOT)) {
          inp.switchTo = DEFAULT_WEAPON_SLOT;
          br.glaiveSwapAt = now + GLAIVE_SWAP_CD_MS;
        }
        if (!inBand || !this.game.projectiles.canThrowGlaive(p)) canShoot = false;
        else lineUp = this.glaiveLineUp(p, eye, inp.yaw, inp.pitch, reach) >= 2;
        if (this.glaiveReturnWanted(p, now)) inp.reload = true;
      }
      // SUDSBLASTER: hold fire past the bubble's reach and swap to the revolver when
      // the target is well out of it. A bubble-only loadout (Gun Game) fires whenever
      // a bubble can still reach.
      if (bubble) {
        const others = ownedSlots.some((slot) => slot !== p.weapon);
        if (!flight || (others && aimDistance > BUBBLE_MAX_RANGE)) canShoot = false;
        if (aimDistance > BUBBLE_MAX_RANGE + 2 && p.mag[DEFAULT_WEAPON_SLOT] > 0 && inp.switchTo === undefined
            && !br.spawnSwitchPending && now >= br.bubbleSwapAt && ownedSlots.includes(DEFAULT_WEAPON_SLOT)) {
          inp.switchTo = DEFAULT_WEAPON_SLOT;
          br.bubbleSwapAt = now + BUBBLE_SWAP_CD_MS;
        }
      }
      // F-4 FIRESTORM (Conquest Pyro): only burn inside the stream's reach, swap
      // to the revolver for far contacts (same hysteresis clock as the RIPTIDE).
      if (FLAME_SLOT >= 0 && p.weapon === FLAME_SLOT) {
        if (aimDistance > FLAME_FIRE_RANGE) canShoot = false;
        if (aimDistance > FLAME_SWAP_RANGE && !pyroPress && ownedSlots.includes(DEFAULT_WEAPON_SLOT) && p.mag[DEFAULT_WEAPON_SLOT] > 0
            && inp.switchTo === undefined && !br.spawnSwitchPending && now >= br.glaiveSwapAt) {
          inp.switchTo = DEFAULT_WEAPON_SLOT;
          br.glaiveSwapAt = now + GLAIVE_SWAP_CD_MS;
        }
      }
      if (mgl) {
        const others = ownedSlots.some((slot) => slot !== p.weapon);
        if (mglPitch === null || aimDistance > MGL_MAX_RANGE) canShoot = false;
        if (aimDistance > MGL_MAX_RANGE + 2 && others && p.mag[DEFAULT_WEAPON_SLOT] > 0
            && inp.switchTo === undefined && !br.spawnSwitchPending) inp.switchTo = DEFAULT_WEAPON_SLOT;
      }
      // A held trigger swings the pick at its rpm cadence: no bursts, no magazine.
      if (melee) { if (combatAllowed && canShoot && meleeLive) inp.wantFire = true; }
      else if (combatAllowed && canShoot && p.mag[p.weapon] > 0) {
        if (now >= br.pauseUntil || lineUp) {
          if (!br.inBurst) {
            const shots = pers.burst[0] + Math.floor(br.rng() * (pers.burst[1] - pers.burst[0] + 1));
            // The FIRESTORM sweeps a stream (0.6-1.2 s), not a 3-5 packet tap at 20 packets/s.
            br.burstEnd = now + (p.weapon === FLAME_SLOT ? 600 + Math.round(br.rng() * 600) : shots * Math.round(60000 / p.def.rpm));
            br.inBurst = true;
          }
          // A Big Bubble hold outlasts a short burst: finish blowing it first.
          if (bubble && p.charging) br.burstEnd = Math.max(br.burstEnd, now + 1);
          if (now < br.burstEnd) {
            if (bubble) {
              // Taps press one tick and release the next; a Big Bubble holds ~95% charge.
              if (!p.charging && !p.triggerPrev) br.bubbleBig = this.wantsBigBubble(p, enemy, aimDistance);
              const holdMs = br.bubbleBig ? 0.95 * p.def.charge.ms : 0;
              inp.wantFire = p.charging ? p.chargeT < holdMs : !p.triggerPrev;
            } else if (p.def.mode === 'charge') {
              // Charge weapons release near full power.
              const chargeMs = p.def.charge?.ms || 850;
              inp.wantFire = p.charging ? p.chargeT < chargeMs * 0.95 : !p.triggerPrev;
            } else {
              inp.wantFire = p.def.mode === 'auto' || !p.triggerPrev;
            }
          }
          else { br.inBurst = false; br.pauseUntil = now + profile.burstPauseMs * pers.burstPause; }
        }
      }
      // Stop and pop: a ranged burst is fired standing still (movement spread
      // dwarfs the aimed cone), then the legs resume between bursts.
      if (cq && br.inBurst && aimDistance > STOP_AND_POP_RANGE && cqMotion && cqMotion !== 'zone' && cqMotion !== 'hold') {
        moving = false; br.moveWish = null;
        inp.keys.f = inp.keys.b = inp.keys.l = inp.keys.r = false;
        inp.keys.sprint = false;
        inp.keys.crouch = br.crouchFight;
      }
    } else {
      br.engagedMs = 0;
      br.aim.dropKick();
    }

    // A RIPTIDE bot parked on another slot (range swap, dry cycling) draws the
    // disc launcher again once a disc is seated and any target is in its band.
    if (GLAIVE_SLOT >= 0 && p.weapon !== GLAIVE_SLOT && p.mag[GLAIVE_SLOT] > 0
        && inp.switchTo === undefined && !br.spawnSwitchPending && now >= br.glaiveSwapAt
        && ownedSlots.includes(GLAIVE_SLOT) && this.preferredSlot(br, ownedSlots) === GLAIVE_SLOT) {
      const d = fightNow ? dist3(eye[0], eye[1], eye[2], enemy.x, enemy.eyeY - 0.35, enemy.z) : null;
      if (d === null || (d >= GLAIVE_MIN_RANGE && d <= glaiveReach(glaiveDef(p).glaive))) {
        inp.switchTo = GLAIVE_SLOT;
        br.glaiveSwapAt = now + GLAIVE_SWAP_CD_MS;
      }
    }

    // Pyro: the flamethrower comes back out once a contact is inside the stream's reach.
    if (FLAME_SLOT >= 0 && p.weapon !== FLAME_SLOT && (p.mag[FLAME_SLOT] > 0 || p.reserve[FLAME_SLOT] > 0)
        && inp.switchTo === undefined && !br.spawnSwitchPending && now >= br.glaiveSwapAt
        && ownedSlots.includes(FLAME_SLOT) && this.preferredSlot(br, ownedSlots) === FLAME_SLOT) {
      const d = fightNow ? dist3(eye[0], eye[1], eye[2], enemy.x, enemy.eyeY - 0.35, enemy.z) : null;
      if (d === null || d <= FLAME_DRAW_RANGE || pyroPress) {
        inp.switchTo = FLAME_SLOT;
        br.glaiveSwapAt = now + GLAIVE_SWAP_CD_MS;
      }
    }

    // Same for the SUDSBLASTER: redraw it once seated and a target is inside its reach.
    if (BUBBLE_SLOT >= 0 && p.weapon !== BUBBLE_SLOT && p.mag[BUBBLE_SLOT] > 0
        && inp.switchTo === undefined && !br.spawnSwitchPending && now >= br.bubbleSwapAt
        && ownedSlots.includes(BUBBLE_SLOT) && this.preferredSlot(br, ownedSlots) === BUBBLE_SLOT) {
      const d = fightNow ? dist3(eye[0], eye[1], eye[2], enemy.x, enemy.eyeY - 0.35, enemy.z) : null;
      if (d === null || d <= BUBBLE_DRAW_RANGE) {
        inp.switchTo = BUBBLE_SLOT;
        br.bubbleSwapAt = now + BUBBLE_SWAP_CD_MS;
      }
    }

    // Waist-high cover: stand to shoot, duck between bursts and to reload.
    if (cq && (goal.crouch || cqMotion === 'hold') && objectiveArrived && fightNow) {
      inp.keys.crouch = !inp.wantFire && (now < br.pauseUntil || !!p.reloading || p.mag[p.weapon] === 0);
    }

    // Releasing an obscured charge would still shoot through cover. Discard
    // the capacitor through the combat system when visual fire permission ends.
    if (p.charging && !canShoot) cancelCharge(p);

    // ----- shared locomotion steering ---------------------------------------
    if (moving) {
      if (br.moveWish && cq && (cqMotion || (!combatMovement && inp.keys.f === false && !sprint))) {
        // Decoupled legs: map the world-space wish onto keys relative to the aim.
        const sin = Math.sin(inp.yaw), cos = Math.cos(inp.yaw);
        const forward = -sin * br.moveWish.x - cos * br.moveWish.z;
        const side = cos * br.moveWish.x - sin * br.moveWish.z;
        inp.keys.f = forward > 0.38; inp.keys.b = forward < -0.38;
        inp.keys.r = side > 0.38; inp.keys.l = side < -0.38;
        inp.keys.sprint = false;
      } else if (!combatMovement) inp.yaw = br.aim.steer('yaw', p.yaw, moveYaw, turnRate, dtS);
      // The duel dance steers by keys, not by the route: on surface maps keep
      // it off ledges, out of the river and away from walls it would grind into.
      if (cq && cqMotion === 'combat' && surfaceNavigation(this.game.world)) this.guardDanceKeys(p, inp);
      // Ground routes go around cover. Legacy terrain routes may hop only
      // toward a supported, body-clear landing in the actual input direction.
      if (!Number.isFinite(this.game.world.meta?.navigationFloor)
          && p.grounded && now >= br.jumpCdUntil && canHopObstacle(this.solidAt, p, inp)) {
        inp.keys.jump = true;
        br.jumpCdUntil = now + br.hopCdMs;
      }
    } else if (br.state === 'retreat') {
      inp.keys.crouch = true; // hold low at the cover spot
    }
    br.moveWish = null;
    if (cq && moving && p.grounded && !inFluid && surfaceNavigation(this.game.world)) this.guardLedges(br, p, inp);
    if (swimming) this.swimExit(br, p, inp, waypoint); else br.swimKeys = null;
    // Bobbing at the surface lifts the body centre out of the water now and then.
    const wetBody = !!inFluid || this.game.fluidAt(Math.floor(p.x), Math.floor(p.y + 0.05), Math.floor(p.z));
    if (cq) this.watchTrapped(br, p, now, wetBody, inZone || cqMotion === 'hold');
    if (cq && now < (br.unstickUntil ?? 0) && moving && p.grounded) { inp.keys.jump = true; inp.keys.crouch = false; }
    // In water the jump key is the swim-up stroke: keep the head above the
    // surface and climb out over the bank (never tread water into drowning).
    if (swimming) inp.keys.jump = true;

    // Medkit (J): below half HP and out of contact, stand still and use it until it
    // finishes or a fight starts again. Assault ADRENALINE kills and the Medic aura's
    // restock hand a spent one back, so every kit's bots patch up between fights.
    if (cq && enemy) br.contactAt = now;
    if (cq && !p.vehicleId && p.medkit && !enemy && !objectiveUrgent && !swimming
        && (p.medkit.active || (p.medkit.remaining === 1 && p.hp < MEDKIT_BOT_HP && p.grounded
          && now - (br.contactAt ?? -Infinity) >= MEDKIT_QUIET_MS))) {
      for (const key of ['f', 'b', 'l', 'r', 'jump', 'sprint', 'crouch', 'prone', 'interact']) inp.keys[key] = false;
      inp.wantFire = false; inp.wantAds = false; inp.reload = false; inp.switchTo = undefined;
      moving = false; br.moveWish = null;
      if (!p.medkit.active) p.medkitRequest = Math.max(p.medkitRequest || 0, (p.medkit.ack || 0) + 1);
    }

    br.intendsMove = moving && (inp.keys.f || inp.keys.b || inp.keys.l || inp.keys.r);
    br.motion = cqMotion ?? (moving ? (searching ? 'search' : 'walk') : 'idle');

    return inp;
  }
}

/**
 * Wire n bots straight into an engine room. Bots self-register on the engine's
 * tick loop.
 */
export function attachBots(engine, n, options) {
  return new BotManager(engine, n, options);
}
