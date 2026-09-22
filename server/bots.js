import { weaponTurnProfile } from '../shared/weapon-handling.js';
import { groundRoute, navigationWaypoint } from './bot-navigation.js';
import { canHopObstacle } from './bot-locomotion.js';
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
import { botDifficulty, DEFAULT_BOT_DIFFICULTY, isBotDifficulty } from '../shared/bot-difficulty.js';
import { BOT_PERSONALITIES, DEFAULT_BOT_PERSONALITY, isBotPersonality, rollBotPersonality } from '../shared/bot-personality.js';
import { cancelCharge } from './sim/combat.js';
import { wrapAngle } from './sim/player.js';
import { glaiveDef } from './sim/projectiles.js';

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
const URGENT_GOALS = new Set(['plant', 'recoverBomb', 'defuse']);
const ALL_WEAPON_SLOTS = Object.freeze(WEAPON_IDS.map((_, slot) => slot));
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
const MELEE_CLOSE = 1.3;          // m: stop pressing forward this close to the body
const MELEE_SPRINT_DIST = 1.7;    // m: sprint in until here so the swing shoves hard
const MELEE_HOP_DIST = 3.2;       // m: hop inside this so the swing lands falling (crit)
const MELEE_HOP_CD_MS = 1600;     // between crit hops (scaled by the personality's hop rate)
const MELEE_AIM_TOLERANCE = 0.3;  // rad: the 110-degree swing cone forgives loose aim
const MELEE_REACH_SLACK = 0.1;    // m inside the server's centre-distance reach
const MELEE_SWAP_DIST = 14;       // m: past this a pick holder draws any loaded gun it owns

function dist3(ax, ay, az, bx, by, bz) {
  return Math.hypot(bx - ax, by - ay, bz - az);
}

function standable(world, x, z, preferredY = null) {
  x |= 0; z |= 0;
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
    this._unhook = game.registerTickHook((dt) => this.tick(dt * 1000));
    this.setCount(n | 0);
  }
  dispose() {
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
      br.resetCombat();
      this.game.removeClient(br.id);
    }
    for (let i = this.brains.length; i < n; i++) {
      const pid = 'bot-' + i;
      this.game.addBot(pid);
      this.brains.push(new Brain(pid, i, mulberry32((BOT_SEED ^ Math.imul(i + 1, 2654435761)) >>> 0), this.difficulties.get(pid), this.personalitySeed));
    }
  }
  tick(dtMs) {
    const dtS = dtMs / 1000;
    const now = this.game.now;
    this.tickIndex++;
    for (let i = this.brains.length - 1; i >= 0; i--) {
      const br = this.brains[i];
      const p = this.game.entities.get(br.id);
      if (!p) { this.brains.splice(i, 1); continue; }
      this.watchStuck(br, p, now);
      this.game.applyInput(br.id, this.think(br, p, now, dtS));
    }
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
      br.roamTarget = randSpot(this.game.world, br.rng, p);
      br.roamDeadline = now + ROAM_TIMEOUT_MS;
      br.detourUntil = now + OBJECTIVE_DETOUR_MS;
      br.jumpCdUntil = now + JUMP_CD_MS;
      br.groundRoute = null;
      br.stuckSince = now;
    }
  }

  /** Nearest visible enemy; a held target must pass every sight check again. */
  pickTarget(p, br = null) {
    const heldId = br?.enemyId;
    const held = heldId ? this.game.entities.get(heldId) : null;
    const observe = target => observeBotTarget(p, target, this.solidAt,
      this.game.projectiles.smoke, this.game.now, target.id === heldId && br?.noticeProgress >= 1, br?.difficulty);
    if (held && held.state === 'alive' && this.game.mode.isEnemy(p, held)) {
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
      if (o === held || o.state !== 'alive' || !this.game.mode.isEnemy(p, o)) continue;
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
    if (this.game.mode.mode !== 'snd') return ownedSlots[br.index % ownedSlots.length];
    for (const id of BUY_PRIORITY) {
      const slot = WEAPON_IDS.indexOf(id);
      if (ownedSlots.includes(slot)) return slot;
    }
    return DEFAULT_WEAPON_SLOT;
  }

  think(br, p, now, dtS) {
    const profile = botDifficulty(br.difficulty);
    const pers = BOT_PERSONALITIES[br.personality] || BOT_PERSONALITIES[DEFAULT_BOT_PERSONALITY];
    const weaponTurnRate = weaponTurnProfile(p.def.handling).maxSpeed;
    const turnRate = Math.min(profile.turnRate, weaponTurnRate);
    const pitchTurnRate = Math.min(PITCH_TURN_RATE, weaponTurnRate);
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

    const goal = this.game.mode.botGoal(p);
    if (goal.kind !== br.goalKind) {
      br.goalKind = goal.kind;
      br.detourUntil = 0;
    }
    if (goal.kind === 'spectate') {
      br.intendsMove = false;
      br.resetCombat();
      return inp;
    }

    const objective = goalPoint(goal);
    const objectiveFlatDist = objective ? Math.hypot(objective.x - p.x, objective.z - p.z) : Infinity;
    const objectiveDist = objective
      ? dist3(p.x, p.y, p.z, objective.x, objective.y, objective.z)
      : Infinity;
    const objectiveArrived = !!objective && objectiveFlatDist <= goalArrivalDist(goal.kind);
    const interactionReady = !!goal.interact && (
      (goal.kind === 'plant' && objectiveFlatDist <= PLANT_READY_DIST
        && Math.abs(objective.y - p.y) <= 1.5)
      || (goal.kind === 'defuse' && objectiveDist <= DEFUSE_READY_DIST)
    );
    inp.keys.interact = interactionReady;

    const objectiveUrgent = !!objective && URGENT_GOALS.has(goal.kind);
    const combatAllowed = this.game.mode.canFire(p);
    const eye = eyeOf(p);
    if (!combatAllowed) br.resetCombat();
    const enemy = combatAllowed ? this.pickTarget(p, br) : null;

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
      if (br.noticeProgress >= 1) {
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
    if (enemy && !objectiveUrgent && p.hp <= RETREAT_HP * pers.retreatHp && now >= br.retreatReadyAt && !retreating) {
      const dx = enemy.x - p.x, dz = enemy.z - p.z;
      const pl = Math.hypot(dx, dz) || 1;
      const px = -dz / pl, pz = dx / pl;                    // perpendicular
      const cA = standable(this.game.world, (p.x + px * 8) | 0, (p.z + pz * 8) | 0, p.y);
      const cB = standable(this.game.world, (p.x - px * 8) | 0, (p.z - pz * 8) | 0, p.y);
      // Cover the enemy cannot see wins outright; distance breaks ties.
      const hidden = (s) => {
        const dx = s.x - enemy.x, dy = (s.y + 1.2) - enemy.eyeY, dz = s.z - enemy.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        return !!raycastVoxels(this.solidAt, enemy.x, enemy.eyeY, enemy.z, dx / len, dy / len, dz / len, len);
      };
      const score = (s) => (s ? (hidden(s) ? 1000 : 0) + dist3(s.x, s.y, s.z, enemy.x, enemy.y, enemy.z) : -1);
      br.roamTarget = score(cA) >= score(cB)
        ? (cA || cB || randSpot(this.game.world, br.rng, p))
        : (cB || cA || randSpot(this.game.world, br.rng, p));
      br.roamDeadline = now + RETREAT_MS;
      br.retreatUntil = now + RETREAT_MS;
      br.retreatReadyAt = now + RETREAT_MS + RETREAT_COOLDOWN_MS;
      br.resetCombat();
    }
    if (now < br.retreatUntil) br.state = 'retreat';
    else if (br.state === 'retreat') br.state = 'roam';

    // Swimmers head for the nearest dry footing instead of treading water.
    if (this.game.fluidAt(Math.floor(p.x), Math.floor(p.y + 0.55), Math.floor(p.z))) {
      const dry = nearestDry(this.game.world, p);
      if (dry) { br.roamTarget = dry; br.roamDeadline = now + 4000; }
    }

    // ----- navigation ------------------------------------------------------
    let takingDetour = !!objective && now < br.detourUntil;
    if (takingDetour && br.roamTarget
        && dist3(p.x, p.y, p.z, br.roamTarget.x, br.roamTarget.y, br.roamTarget.z) < ARRIVE_DIST) {
      br.detourUntil = 0;
      takingDetour = false;
    }

    if ((!objective || takingDetour)
        && (!br.roamTarget
          || now >= br.roamDeadline
          || dist3(p.x, p.y, p.z, br.roamTarget.x, br.roamTarget.y, br.roamTarget.z) < ARRIVE_DIST)) {
      br.roamTarget = randSpot(this.game.world, br.rng, p);
      br.roamDeadline = now + ROAM_TIMEOUT_MS;
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
    const combatMovement = br.state === 'fight' && enemy && !objectiveUrgent && !interactionReady;
    // IRON PICK: no magazine, reach-limited — it closes in instead of spacing.
    const melee = p.def.mode === 'melee' && !!p.def.melee;
    // Engage on damage permission, not fire permission: TTT prep lets the knife
    // "fire" but nobody can be hurt, and a live swing would only mine the wall.
    const meleeLive = melee && !!enemy && this.game.mode.canDamage(p, enemy);

    if (combatMovement) {
      // Combat motion: spacing + perpendicular wobble.
      const dx = enemy.x - p.x, dz = enemy.z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      moveYaw = Math.atan2(-dx, -dz);
      br.strafePhase += dtS * TAU * STRAFE_HZ * pers.strafeHz;
      const fx = -Math.sin(moveYaw), fz = -Math.cos(moveYaw);
      const wet = (x, z) => this.game.fluidAt(Math.floor(x), Math.floor(p.y + 0.55), Math.floor(z));
      let side = Math.sin(br.strafePhase) > 0;
      // Never strafe into open water when the other side is dry.
      if (wet(p.x + fz * (side ? 1.3 : -1.3), p.z - fx * (side ? 1.3 : -1.3))
        && !wet(p.x - fz * (side ? 1.3 : -1.3), p.z + fx * (side ? 1.3 : -1.3))) side = !side;
      inp.keys.l = side;
      inp.keys.r = !side;
      if (d > pers.far && !wet(p.x + fx * 1.5, p.z + fz * 1.5)) inp.keys.f = true;
      else if (d < pers.near && !wet(p.x - fx * 1.5, p.z - fz * 1.5)) inp.keys.b = true;
      inp.keys.crouch = br.crouchFight && d > 10;
      moving = true;
      sprint = false;
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
    } else if (searching && navDist <= ARRIVE_DIST) {
      // Check around the remembered spot. Do not turn toward hidden movement.
      const scanYaw = Math.atan2(-ndx, -ndz) + Math.sin(now / 350 + br.strafePhase) * 0.9;
      inp.yaw = br.aim.steer('yaw', p.yaw, scanYaw, turnRate, dtS);
    } else if (!objectiveArrived || takingDetour) {
      moveYaw = Math.atan2(-ndx, -ndz);
      // Turn before walking into a nearby graph corner. Sprinting toward a
      // two-metre waypoint while still turning produces tight endless circles.
      const turnError = Math.abs(wrapAngle(moveYaw - p.yaw));
      inp.keys.f = turnError < 0.6 && Math.hypot(ndx, ndz) > 0.35;
      moving = true;
      sprint = Math.hypot(ndx, ndz) > 7 && turnError < 0.3 && !retreating && !searching;
      inp.pitch = br.aim.steer('pitch', p.pitch, Math.atan2((waypoint.y + 1) - eye[1], navDist), pitchTurnRate, dtS);
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
    if (combatMovement) {
      br.engagedMs += engageMsDelta;

      // Aim at an actually exposed part of the current stance, led by the
      // target's horizontal motion in proportion to skill so the eased
      // steering does not trail a strafing enemy.
      // The RIPTIDE's disc is slow enough that the lead follows its flight time.
      const glaive = p.weapon === GLAIVE_SLOT && !!p.def.glaive;
      const glaiveRules = glaive ? glaiveDef(p).glaive : null;
      const [aimX, aimY, aimZ] = br.sighting.aimPoint;
      const lead = glaive
        ? projectileLead(enemy, dist3(eye[0], eye[1], eye[2], aimX, aimY, aimZ), glaiveRules.speedOut, br.skill)
        : [(enemy.vx || 0) * LEAD_S * br.skill, (enemy.vz || 0) * LEAD_S * br.skill];
      const aim = [aimX + lead[0], aimY, aimZ + lead[1]];
      const yawT = Math.atan2(-(aim[0] - p.x), -(aim[2] - p.z));
      const flat = Math.hypot(aim[0] - p.x, aim[2] - p.z) || 1;
      const pitchT = Math.atan2(aim[1] - eye[1], flat);
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
      inp.wantAds = flat > 28 && p.def.id === 'sniper';

      // Ammo logistics mid-fight: reload, else cycle to any loaded slot. The
      // RIPTIDE reloads by catching: with a disc still in the air it waits.
      if (melee) {
        // The pick never runs dry; it only gives way to a loaded gun for far targets.
        if (flat > MELEE_SWAP_DIST && inp.switchTo === undefined && !br.spawnSwitchPending) {
          const gun = ownedSlots.find(s => s !== p.weapon && WEAPONS[WEAPON_IDS[s]].mode !== 'melee' && p.mag[s] > 0);
          if (gun !== undefined) inp.switchTo = gun;
        }
      } else if (p.mag[p.weapon] === 0) {
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
      canShoot = br.noticeProgress >= 1
        && Math.abs(wrapAngle(baseYaw - intendedYaw)) < aimTolerance
        && Math.abs(basePitch - intendedPitch) < aimTolerance
        && !raycastVoxels(this.solidAt, ...eye,
          -Math.sin(inp.yaw) * Math.cos(inp.pitch), Math.sin(inp.pitch),
          -Math.cos(inp.yaw) * Math.cos(inp.pitch), aimDistance);
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
      // A held trigger swings the pick at its rpm cadence: no bursts, no magazine.
      if (melee) { if (combatAllowed && canShoot && meleeLive) inp.wantFire = true; }
      else if (combatAllowed && canShoot && p.mag[p.weapon] > 0) {
        if (now >= br.pauseUntil || lineUp) {
          if (!br.inBurst) {
            const shots = pers.burst[0] + Math.floor(br.rng() * (pers.burst[1] - pers.burst[0] + 1));
            br.burstEnd = now + shots * Math.round(60000 / p.def.rpm);
            br.inBurst = true;
          }
          if (now < br.burstEnd) {
            if (p.def.mode === 'charge') {
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
    } else {
      br.engagedMs = 0;
      br.aim.dropKick();
    }

    // A RIPTIDE bot parked on another slot (range swap, dry cycling) draws the
    // disc launcher again once a disc is seated and any target is in its band.
    if (GLAIVE_SLOT >= 0 && p.weapon !== GLAIVE_SLOT && p.mag[GLAIVE_SLOT] > 0
        && inp.switchTo === undefined && !br.spawnSwitchPending && now >= br.glaiveSwapAt
        && ownedSlots.includes(GLAIVE_SLOT) && this.preferredSlot(br, ownedSlots) === GLAIVE_SLOT) {
      const d = combatMovement ? dist3(eye[0], eye[1], eye[2], enemy.x, enemy.eyeY - 0.35, enemy.z) : null;
      if (d === null || (d >= GLAIVE_MIN_RANGE && d <= glaiveReach(glaiveDef(p).glaive))) {
        inp.switchTo = GLAIVE_SLOT;
        br.glaiveSwapAt = now + GLAIVE_SWAP_CD_MS;
      }
    }

    // Releasing an obscured charge would still shoot through cover. Discard
    // the capacitor through the combat system when visual fire permission ends.
    if (p.charging && !canShoot) cancelCharge(p);

    // ----- shared locomotion steering ---------------------------------------
    if (moving) {
      if (!combatMovement) inp.yaw = br.aim.steer('yaw', p.yaw, moveYaw, turnRate, dtS);
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

    br.intendsMove = moving && (inp.keys.f || inp.keys.b || inp.keys.l || inp.keys.r);

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
