import { navigationWaypoint } from './bot-navigation.js';
// Direct-injection bots. They register with a GameEngine as pseudo-clients
// ('bot-<i>') and drive the exact same applyInput -> integrate -> fire
// pipeline humans use, so balance is identical. No sockets anywhere.
//
// Behavior: waypoint-free roaming to random surface spots, knee-high obstacle
// hopping via forward voxel probe, limited-field stance-aware voxel LOS,
// delayed recognition and a brief search of the last observed position,
// burst-fire combat (3-5 shots then a 300 ms breath), shrinking aim error as
// engagement time ramps skill, perpendicular strafing while fighting, panic
// retreat to a side-on cover spot under 30 hp, dry-mid-fight weapon cycling,
// and a stuck watchdog that reroutes anything wedged on geometry.

import {
  AIR, worldDimensions, GROUND,
} from '../shared/worlddata.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { DEFAULT_WEAPON_ID, WEAPON_PRICES } from '../shared/modes.js';
import { MAX_BOTS } from '../shared/lobby-limits.js';
import { mulberry32 } from '../shared/noise.js';
import { raycastVoxels } from '../shared/raycast.js';
import { DUST2_NAV_FLOORS, dust2FloorsAt } from '../shared/world/dust2-layout.js';
import { observeBotTarget } from './bot-perception.js';
import { cancelCharge } from './sim/combat.js';

const TAU = Math.PI * 2;
const TURN_RATE = 3.0;            // rad/s steering cap
const PITCH_TURN_RATE = 4.0;      // rad/s vertical tracking cap
const SEARCH_MS = 2400;          // remember only the last observed position
const AIM_TOLERANCE = 0.075;      // turn onto a target before pulling the trigger
const ARRIVE_DIST = 2.0;          // roam target reached
const ROAM_TIMEOUT_MS = 8000;     // forced re-target
const BURST_PAUSE_MS = 300;       // breath between bursts
const RETREAT_HP = 30;            // coward line
const RETREAT_MS = 4000;          // how long a retreat lasts
const RETREAT_COOLDOWN_MS = 2500; // before the next panic
const STRAFE_HZ = 1.5;            // perpendicular wobble while fighting
const KNEE_Y = 0.6;               // obstacle probe height above feet
const PROBE_AHEAD = 0.6;          // obstacle probe reach
const JUMP_CD_MS = 650;           // between hops
const STUCK_WINDOW_MS = 1000;     // displacement sample window
const STUCK_DIST = 0.35;          // less than this over the window == wedged
const BOT_SEED = 0x00B0755;
const DEFAULT_WEAPON_SLOT = WEAPON_IDS.indexOf(DEFAULT_WEAPON_ID);
const BUY_PRIORITY = Object.freeze(['sniper', 'lmg', 'rocket', 'longarc', 'lance', 'rifle', 'shotgun', 'smg']);
const URGENT_GOALS = new Set(['plant', 'recoverBomb', 'defuse']);
const ALL_WEAPON_SLOTS = Object.freeze(WEAPON_IDS.map((_, slot) => slot));
const PLANT_READY_DIST = 2.0;
const DEFUSE_READY_DIST = 1.6;
const RECOVER_READY_DIST = 0.8;
const DEFEND_ARRIVE_DIST = 4.0;
const OBJECTIVE_DETOUR_MS = 1600;

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function approachAngle(cur, target, maxStep) {
  let d = wrapAngle(target - cur);
  if (d > maxStep) d = maxStep;
  if (d < -maxStep) d = -maxStep;
  return wrapAngle(cur + d);
}

/** Cheap centered noise in [-1, 1] standing in for gaussian aim error. */
function gaussish(rng) {
  return ((rng() + rng() + rng()) - 1.5) * (2 / 3);
}

function dist3(ax, ay, az, bx, by, bz) {
  return Math.hypot(bx - ax, by - ay, bz - az);
}

function standable(world, x, z, preferredY = null) {
  x |= 0; z |= 0;
  if (world.mapId === 'dust2') {
    const floors = [...dust2FloorsAt(x, z)];
    if (preferredY !== null) floors.sort((a, b) => Math.abs(a + 1 - preferredY) - Math.abs(b + 1 - preferredY));
    for (const h of floors) {
      if (world.getBlock(x, h, z) !== AIR
        && world.getBlock(x, h + 1, z) === AIR && world.getBlock(x, h + 2, z) === AIR) {
        return { x: x + 0.5, y: h + 1.02, z: z + 0.5 };
      }
    }
    return null;
  }
  const h = world.meta?.navigationFloor ?? world.heightAt(x, z);
  if (h < GROUND - 1 || h > GROUND + 9) return null;
  if (world.getBlock(x, h, z) === AIR) return null;
  if (world.getBlock(x, h + 1, z) !== AIR || world.getBlock(x, h + 2, z) !== AIR) return null;
  return { x: x + 0.5, y: h + 1.02, z: z + 0.5 };
}

function randSpot(world, rng) {
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
    if (s) return s;
  }
  return { x: SX / 2, y: GROUND + 1.02, z: SZ / 2 };
}

function eyeOf(p) {
  return [p.x, p.eyeY, p.z];
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
  constructor(id, index, rng) {
    this.id = id;
    this.index = index;
    this.rng = rng;
    this.seq = 0;
    this.skill = 0.25 + rng() * 0.3;   // ramps toward 1 while fighting
    this.state = 'roam';               // 'roam' | 'fight' | 'search' | 'retreat'
    this.roamTarget = null;
    this.roamDeadline = 0;
    this.enemyId = null;
    this.sighting = null;
    this.noticeId = null;
    this.noticeProgress = 0;
    this.reactionScale = 0.9 + rng() * 0.2;
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
    this.watchY = 0;
    this.watchZ = 0;
  }

  /** Drop combat memory but keep navigation/skill continuity. */
  resetCombat() {
    this.enemyId = null;
    this.sighting = null;
    this.noticeId = null;
    this.noticeProgress = 0;
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
  constructor(game, n) {
    this.game = game;
    this.solidAt = (x, y, z) => this.game.world.getBlock(x, y, z) !== AIR;
    this.brains = [];
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
      this.brains.push(new Brain(pid, i, mulberry32((BOT_SEED ^ Math.imul(i + 1, 2654435761)) >>> 0)));
    }
  }
  tick(dtMs) {
    const dtS = dtMs / 1000;
    const now = this.game.now;
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
      br.watchX = p.x; br.watchY = p.y; br.watchZ = p.z;
      return;
    }
    if (br.watchX === null) {
      br.watchX = p.x; br.watchY = p.y; br.watchZ = p.z;
      return;
    }
    const moved = dist3(p.x, p.y, p.z, br.watchX, br.watchY, br.watchZ);
    if (moved >= STUCK_DIST) {
      br.watchX = p.x; br.watchY = p.y; br.watchZ = p.z;
      br.stuckSince = 0;
      return;
    }
    if (!br.stuckSince) { br.stuckSince = now; return; }
    if (now - br.stuckSince >= STUCK_WINDOW_MS) {
      // Wedged: new destination + immediate hop eligibility.
      br.roamTarget = randSpot(this.game.world, br.rng);
      br.roamDeadline = now + ROAM_TIMEOUT_MS;
      br.detourUntil = now + OBJECTIVE_DETOUR_MS;
      br.jumpCdUntil = 0;
      br.stuckSince = now;
    }
  }

  /** Nearest visible enemy; a held target must pass every sight check again. */
  pickTarget(p, br = null) {
    const heldId = br?.enemyId;
    const held = heldId ? this.game.entities.get(heldId) : null;
    const observe = target => observeBotTarget(p, target, this.solidAt,
      this.game.projectiles.smoke, this.game.now, target.id === heldId && br?.noticeProgress >= 1);
    if (held && held.state === 'alive' && this.game.mode.isEnemy(p, held)) {
      const sighting = observe(held);
      if (sighting) {
        br.sighting = sighting;
        return held;
      }
    }
    if (br) { br.enemyId = null; br.sighting = null; }
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

  /** Buy one durable S&D primary when needed and expose only legal slots. */
  prepareLoadout(br, p) {
    const mode = this.game.mode;
    if (mode.mode === 'gungame') {
      const owned = mode.playerSnapshot(p).owned;
      const slots = owned.map((id) => WEAPON_IDS.indexOf(id)).filter((slot) => slot >= 0);
      return slots.length ? slots : [DEFAULT_WEAPON_SLOT];
    }
    if (mode.mode !== 'snd') return ALL_WEAPON_SLOTS;

    let snapshot = mode.playerSnapshot(p);
    if (mode.phase === 'prep' && br.buyRound !== mode.round) {
      br.buyRound = mode.round;
      for (const id of BUY_PRIORITY) {
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
    // Respawn bookkeeping: a fresh life drops stale targeting/navigation.
    if (br.lastLives !== p.lives) {
      br.lastLives = p.lives;
      br.spawnSwitchPending = true;
      br.resetCombat();
      br.roamTarget = null;
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
        br.engagedMs = 0;
        br.inBurst = false;
      }
      br.noticeProgress = Math.min(1, br.noticeProgress
        + dtS * 1000 / (br.sighting.recognitionMs * br.reactionScale));
      if (br.noticeProgress >= 1) {
        br.lastSeen = { id: enemy.id, lives: enemy.lives, until: now + SEARCH_MS,
          position: { x: enemy.x, y: enemy.y, z: enemy.z } };
      }
    } else {
      br.noticeId = null;
      br.noticeProgress = 0;
      br.inBurst = false;
      br.engagedMs = 0;
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
      if (br.state !== 'fight') { br.state = 'fight'; br.strafePhase = br.rng() * TAU; }
      engageMsDelta = dtS * 1000;
    } else if (!retreating) {
      br.state = br.lastSeen ? 'search' : 'roam';
    }

    // Skill ramps during fights, cools off when alone.
    br.skill = Math.max(0.2, Math.min(1, br.skill + (enemy ? dtS * 0.09 : -dtS * 0.03)));

    // ----- panic retreat ---------------------------------------------------
    if (enemy && !objectiveUrgent && p.hp <= RETREAT_HP && now >= br.retreatReadyAt && !retreating) {
      const dx = enemy.x - p.x, dz = enemy.z - p.z;
      const pl = Math.hypot(dx, dz) || 1;
      const px = -dz / pl, pz = dx / pl;                    // perpendicular
      const cA = standable(this.game.world, (p.x + px * 8) | 0, (p.z + pz * 8) | 0, p.y);
      const cB = standable(this.game.world, (p.x - px * 8) | 0, (p.z - pz * 8) | 0, p.y);
      const farthest = (s) => (s ? dist3(s.x, s.y, s.z, enemy.x, enemy.y, enemy.z) : -1);
      br.roamTarget = farthest(cA) >= farthest(cB)
        ? (cA || cB || randSpot(this.game.world, br.rng))
        : (cB || cA || randSpot(this.game.world, br.rng));
      br.roamDeadline = now + RETREAT_MS;
      br.retreatUntil = now + RETREAT_MS;
      br.retreatReadyAt = now + RETREAT_MS + RETREAT_COOLDOWN_MS;
      br.resetCombat();
    }
    if (now < br.retreatUntil) br.state = 'retreat';
    else if (br.state === 'retreat') br.state = 'roam';

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
      br.roamTarget = randSpot(this.game.world, br.rng);
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

    if (combatMovement) {
      // Combat motion: spacing + perpendicular wobble.
      const dx = enemy.x - p.x, dz = enemy.z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      moveYaw = Math.atan2(-dx, -dz);
      br.strafePhase += dtS * TAU * STRAFE_HZ;
      const side = Math.sin(br.strafePhase) > 0;
      inp.keys.l = side;
      inp.keys.r = !side;
      if (d > 22) inp.keys.f = true;
      else if (d < 6) inp.keys.b = true;
      moving = true;
      sprint = false;
    } else if (searching && navDist <= ARRIVE_DIST) {
      // Check around the remembered spot. Do not turn toward hidden movement.
      const scanYaw = Math.atan2(-ndx, -ndz) + Math.sin(now / 350 + br.strafePhase) * 0.9;
      inp.yaw = approachAngle(p.yaw, scanYaw, TURN_RATE * dtS);
    } else if (!objectiveArrived || takingDetour) {
      moveYaw = Math.atan2(-ndx, -ndz);
      inp.keys.f = true;
      moving = true;
      sprint = navDist > 25 && !retreating && !searching;
      inp.pitch = approachAngle(inp.pitch, Math.atan2((waypoint.y + 1) - eye[1], navDist), PITCH_TURN_RATE * dtS);
    }
    inp.keys.sprint = !!sprint;

    // Aim error shrinks as the fight wears on.
    const errFactor = Math.max(0.55, 1 - br.engagedMs / 4000);

    let canShoot = false;
    if (combatMovement) {
      br.engagedMs += engageMsDelta;

      // Aim at an actually exposed part of the current stance.
      const aim = br.sighting.aimPoint;
      const yawT = Math.atan2(-(aim[0] - p.x), -(aim[2] - p.z));
      const flat = Math.hypot(aim[0] - p.x, aim[2] - p.z) || 1;
      const pitchT = Math.atan2(aim[1] - eye[1], flat);
      const sigmaDeg = (2.2 - 1.6 * br.skill) * errFactor + 0.3;
      const sigmaRad = sigmaDeg * Math.PI / 180;
      inp.yaw = approachAngle(p.yaw, wrapAngle(yawT + gaussish(br.rng) * sigmaRad), TURN_RATE * dtS);
      inp.pitch = approachAngle(p.pitch, Math.max(-1.4, Math.min(1.4, pitchT + gaussish(br.rng) * sigmaRad * 0.6)), PITCH_TURN_RATE * dtS);
      inp.wantAds = flat > 28 && p.def.id === 'sniper';

      // Ammo logistics mid-fight: reload, else cycle to any loaded slot.
      if (p.mag[p.weapon] === 0) {
        if (p.reserve[p.weapon] > 0) inp.reload = true;
        else {
          const cur = p.weapon;
          for (let k = 1; k <= WEAPON_IDS.length; k++) {
            const s = (cur + k) % WEAPON_IDS.length;
            if (!ownedSlots.includes(s)) continue;
            if (p.mag[s] > 0 || p.reserve[s] > 0) { inp.switchTo = s; break; }
          }
        }
      }

      // Burst discipline: 3-5 shots, then a breath.
      const aimDistance = Math.hypot(flat, aim[1] - eye[1]);
      canShoot = br.noticeProgress >= 1
        && Math.abs(wrapAngle(inp.yaw - yawT)) < AIM_TOLERANCE
        && Math.abs(inp.pitch - pitchT) < AIM_TOLERANCE
        && !raycastVoxels(this.solidAt, ...eye,
          -Math.sin(inp.yaw) * Math.cos(inp.pitch), Math.sin(inp.pitch),
          -Math.cos(inp.yaw) * Math.cos(inp.pitch), aimDistance);
      if (combatAllowed && canShoot && p.mag[p.weapon] > 0) {
        if (now >= br.pauseUntil) {
          if (!br.inBurst) {
            const shots = 3 + Math.floor(br.rng() * 3); // 3..5
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
          else { br.inBurst = false; br.pauseUntil = now + BURST_PAUSE_MS; }
        }
      }
    } else {
      br.engagedMs = 0;
    }

    // Releasing an obscured charge would still shoot through cover. Discard
    // the capacitor through the combat system when visual fire permission ends.
    if (p.charging && !canShoot) cancelCharge(p);

    // ----- shared locomotion steering ---------------------------------------
    if (moving) {
      inp.yaw = approachAngle(p.yaw, combatMovement ? inp.yaw : moveYaw, TURN_RATE * dtS);
      // Hop knee-high obstacles in our path.
      if (p.grounded && now >= br.jumpCdUntil) {
        const sy = Math.sin(inp.yaw), cy = Math.cos(inp.yaw);
        const fx = -sy, fz = -cy;
        const sx = p.x + fx * (PROBE_AHEAD * 0.57);
        const sz = p.z + fz * (PROBE_AHEAD * 0.57);
        const fl = Math.hypot(fx, fz) || 1;
        const hitProbe = raycastVoxels(this.solidAt, sx, p.y + KNEE_Y, sz, fx / fl, 0, fz / fl, PROBE_AHEAD + 0.25);
        if (hitProbe) {
          inp.keys.jump = true;
          br.jumpCdUntil = now + JUMP_CD_MS;
        }
      }
    } else if (br.state === 'retreat') {
      inp.keys.crouch = true; // hold low at the cover spot
    }

    br.intendsMove = moving;

    return inp;
  }
}

/**
 * Wire n bots straight into an engine room. Bots self-register on the engine's
 * tick loop.
 */
export function attachBots(engine, n) {
  return new BotManager(engine, n);
}
