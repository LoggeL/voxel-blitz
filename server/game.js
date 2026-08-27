// Authoritative fixed-step game simulation.
//
// Transport-agnostic: authoritative ticks flow through the injected
// broadcast callback. Welcome and map delivery stay with LobbyManager.
//
// Aim convention (must match clients): yaw=0 faces -Z, positive yaw turns
// toward -X (CCW seen from +Y); pitch>0 looks up, radians. Forward =
// (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch)).
//
// Every player — human or bot — runs through the exact same pipeline:
// applyInput -> clamp/sanitize -> integrate (collide & slide) -> fire resolve.

import {
  AIR, GLASS, LEAVES, BLOCK_HP,
  SX, SZ,
  createMapState, getMapMeta,
} from '../shared/worlddata.js';
import { DEFAULT_MAP_ID } from '../shared/modes.js';
import {
  WEAPONS, WEAPON_IDS, CONDITION_RULES,
  GRAVITY, PLAYER_HALF, EYE_HEIGHT, HEADSHOT_Y_FRAC,
  damageAtDistance, sampleSpreadDir, computeSpreadConeDeg,
} from '../shared/combatmath.js';
import { mulberry32 } from '../shared/noise.js';
import { raycastVoxels } from '../shared/raycast.js';
import {
  TICK_MS,
  makeSnapshot, evShoot, evHit, evKill, evBlock, evRespawn, evDie,
} from './protocol.js';
import { ModeController } from './modes.js';

export const SHOT_REACH = 120;          // weapon reach in world units
const MAX_PITCH = (89 * Math.PI) / 180;
const WALK_SPEED = 4.4;
const SPRINT_SPEED = 6.2;
const CROUCH_SPEED = 2.2;
const JUMP_VELOCITY = 8.2;
const ACCEL_GROUND = 10;                // 1/s lerp factor toward wish velocity
const ACCEL_AIR = ACCEL_GROUND * 0.3;   // 30% air control
const COYOTE_S = 0.08;

const HALF_W = PLAYER_HALF.x;           // 0.32
const P_HEIGHT = PLAYER_HALF.h * 2;     // authoritative full body height 1.9
const EYE = EYE_HEIGHT;                 // 1.62
const CROUCH_EYE = EYE * 0.58;          // ~0.94 while crouched
const CHEST_Y = 1.2;                    // chest above feet for hit events

const EPS = 1e-3;                       // post-resolution standoff
const SHRINK = 1e-4;                    // collision-test box shave vs float flip-flop
const MAX_STEP = 0.45;                  // max movement per sub-step (avoids tunneling)
const TERMINAL_VY = -60;
const DEAD_FALL_Y = -24;                // void safety net
const BLOCK_MIN_DMG = 12;               // flat per-pellet block damage floor
const REWIND_MS = 100;                  // client interp delay seen by human shooters
const HISTORY_WINDOW_MS = 500;          // max age a rewound sample may carry

/** Physics numbers mirrored from BUILD-CONTRACT "Physics constants". */
export const PHYSICS = {
  walk: WALK_SPEED, sprint: SPRINT_SPEED, crouch: CROUCH_SPEED,
  jump: JUMP_VELOCITY, gravity: GRAVITY, eye: EYE, crouchEye: CROUCH_EYE,
  accelGround: ACCEL_GROUND, accelAir: ACCEL_AIR,
  halfW: HALF_W, height: P_HEIGHT,
};

/** Direction vector from aim angles (see header convention). */
export function fwdFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Yaw/pitch that look from `from` toward `to` (positions may be arrays). */
export function aimAngles(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const planar = Math.hypot(dx, dz) || 1e-9;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, planar) };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

function clampWeaponSlot(value) {
  const slot = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(WEAPON_IDS.length - 1, slot));
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Deterministic per-shot RNG seed so spread sampling is reproducible. */
function shotRng(player) {
  return mulberry32((seedFromString(player.id) ^ Math.imul(player.shotSeq + 1, 2654435761)) >>> 0);
}

function freshLoadout() {
  return {
    mag: WEAPON_IDS.map((k) => WEAPONS[k].magSize),
    reserve: WEAPON_IDS.map((k) => WEAPONS[k].reserveMax),
  };
}

/** One combatant. Humans and bots are indistinguishable to the simulator
 *  apart from the `bot` flag (which only controls wiring, not behavior). */
class PlayerEntity {
  constructor(id, name, spawn, isBot) {
    this.id = id;
    this.name = name;
    this.bot = !!isBot;
    this.lives = 0;
    this.lastSpawnIndex = spawn.index | 0;
    this.score = 0;
    this.kills = 0;
    this.deaths = 0;
    this.shotSeq = 0;
    this.input = null;
    this.applySpawn(spawn);
  }

  /** Full reset onto a spawn point (fresh life). */
  applySpawn(spawn) {
    this.x = spawn.x; this.y = spawn.y; this.z = spawn.z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    // Face map center on arrival.
    const c = aimAngles([this.x, this.y, this.z], [SX / 2, this.y + CHEST_Y, SZ / 2]);
    this.yaw = c.yaw; this.pitch = 0;
    this.hp = 100;
    this.panic = 0;
    this.exhaustion = 0;
    this.state = 'alive';       // 'alive' | 'dead'
    this.respawnAt = 0;
    this.weapon = 0;
    const load = freshLoadout();
    this.mag = load.mag;
    this.reserve = load.reserve;
    this.reloading = false;
    this.reloadT = 0;
    this.deployT = WEAPONS[WEAPON_IDS[0]].deployTime;
    this.cooldown = 0;
    this.bloom = 0;
    this.ads = false;
    this.adsT = 0;
    this.hist = [];             // {x,y,z,t} ring for shooter-side lag compensation
    this.triggerPrev = false;
    this.fireEdgeQueued = false;
    this.grounded = false;
    this.coyote = 0;
    this.crouch = false;
    this.sprint = false;
    this.lives++;
    this.lastSpawnIndex = spawn.index | 0;
  }

  get def() { return WEAPONS[WEAPON_IDS[this.weapon]]; }
  get eyeY() { return this.y + (this.crouch ? CROUCH_EYE : EYE); }

  /** returns true when this hit was lethal */
  takeDamage(dmg, headshot = false) {
    if (this.state !== 'alive') return false;
    const amount = Math.max(0, Number.isFinite(dmg) ? dmg : 0);
    this.hp -= amount;
    this.panic = clamp01(this.panic + amount * CONDITION_RULES.panicDamageGain +
      (headshot ? CONDITION_RULES.panicHeadshotGain : 0));
    if (this.hp <= 0) { this.hp = 0; return true; }
    return false;
  }
}

export class GameEngine {
  /**
   * @param {{broadcast?:(obj:object)=>void,
   *          world?:object,
   *          mode?:string,
   *          mapMeta?:object}} callbacks
   */
  constructor(callbacks = {}) {
    this.broadcast = callbacks.broadcast || (() => {});
    const fallbackMapId = typeof callbacks.mapMeta?.id === 'string'
      ? callbacks.mapMeta.id
      : DEFAULT_MAP_ID;
    this.world = callbacks.world || createMapState(fallbackMapId);
    const mapMeta = callbacks.mapMeta || this.world.meta || getMapMeta(fallbackMapId);
    this.solidAt = (x, y, z) => this.world.getBlock(x, y, z) !== AIR;

    /** @type {Map<string, PlayerEntity>} every combatant incl. bots */
    this.entities = new Map();
    /** @type {Set<string>} connection ids of humans only */
    this.humanIds = new Set();

    this.spawnPoints = this.world.findSpawns(9); // generic fallback pool
    this.spawnCursor = 0;

    this.now = Date.now();            // engine clock, advances by tick interval
    this.tickNo = 0;
    this.intervalMs = TICK_MS;
    this.running = false;
    this.timer = null;

    this.blockHp = new Map();         // 'x,y,z' -> remaining hp (damaged-not-broken)
    this.tickBlocks = [];             // {i,v} deltas pending for the next snapshot
    this.tickEvents = [];             // wire-shaped events pending for the next snapshot
    this.tickHooks = [];              // extra steppers (BotManager registers here)
    this.mode = new ModeController(this, { mode: callbacks.mode, mapMeta });
  }

  // ------------------------------------------------------------ lifecycle

  start(tickRateMs = TICK_MS) {
    if (this.running) return this;
    this.intervalMs = tickRateMs;
    this.running = true;
    this.timer = setInterval(() => this.step(this.intervalMs), tickRateMs);
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    return this;
  }

  /** Remove queued pre-start events for an entity that left a waiting room. */
  discardPendingEventsFor(id) {
    const key = String(id);
    for (let i = this.tickEvents.length - 1; i >= 0; i--) {
      if (String(this.tickEvents[i]?.id ?? '') === key) this.tickEvents.splice(i, 1);
    }
  }

  registerTickHook(fn) {
    this.tickHooks.push(fn);
    return () => {
      const i = this.tickHooks.indexOf(fn);
      if (i >= 0) this.tickHooks.splice(i, 1);
    };
  }

  /** One fixed simulation step. Public so tests can drive manually. */
  step(intervalMs = this.intervalMs) {
    const dt = intervalMs / 1000;
    this.now += intervalMs;
    this.tickNo++;

    // AI decisions land first so their inputs integrate on this same tick.
    for (let i = 0; i < this.tickHooks.length; i++) {
      try { this.tickHooks[i](dt); } catch { /* a broken hook never kills the sim */ }
    }

    for (const p of this.entities.values()) this.updateTimers(p, dt);
    for (const p of this.entities.values()) { if (p.state === 'alive') this.integrate(p, dt); }
    for (const p of this.entities.values()) { if (p.state === 'alive') this.updateCondition(p, dt); }
    for (const p of this.entities.values()) {
      p.firing = false;
      if (p.state === 'alive') this.resolveWeaponIntent(p);
    }
    this.mode.tick();
    this.processRespawns();

    const players = Array.from(this.entities.values());
    for (const p of players) Object.assign(p, this.mode.playerSnapshot(p));
    const snapshot = makeSnapshot(
      players,
      this.tickBlocks,
      this.tickEvents,
      this.now,
      this.mode.matchSnapshot(),
    );

    // makeSnapshot owns defensive copies. Clear before invoking user code so
    // re-entrant external actions queue data for the following snapshot.
    this.tickBlocks.length = 0;
    this.tickEvents.length = 0;
    this.broadcast(snapshot);
  }

  // ------------------------------------------------------------ roster

  nextSpawnFor(_player, excludeIndex) {
    const n = this.spawnPoints.length;
    let idx = -1;
    for (let k = 0; k < n; k++) {
      const cand = this.spawnCursor++ % n;
      if (cand !== excludeIndex) { idx = cand; break; }
    }
    if (idx < 0) idx = this.spawnCursor++ % n;
    return { ...this.spawnPoints[idx], index: idx };
  }

  /** Register a human connection and return its welcome spawn info. */
  addClient(id, name) {
    const pid = String(id);
    const existing = this.entities.get(pid);
    if (!existing) {
      const nm = String(name || '').trim().slice(0, 24) || 'Player-' + pid.slice(-4);
      const p = new PlayerEntity(pid, nm, this.nextSpawnFor(null, -1), false);
      this.entities.set(pid, p);
      this.humanIds.add(pid);
      this.mode.onPlayerAdd(p);
    }
    return this.spawnInfoFor(this.entities.get(pid));
  }

  /** Direct room injection for bots — no sockets anywhere. */
  addBot(id, name) {
    const pid = String(id);
    let nm = name == null ? null : String(name).slice(0, 24);
    const existing = this.entities.get(pid);
    if (existing) return this.spawnInfoFor(existing);
    if (!nm) nm = 'BOT-' + pid.replace(/[^0-9]/g, '');
    const p = new PlayerEntity(pid, nm, this.nextSpawnFor(null, -1), true);
    this.entities.set(pid, p);
    this.mode.onPlayerAdd(p);
    return this.spawnInfoFor(p);
  }

  removeClient(id) {
    const pid = String(id);
    const player = this.entities.get(pid);
    if (player) this.mode.onPlayerRemove(player);
    this.entities.delete(pid);
    this.humanIds.delete(pid);
  }

  renameClient(id, name) {
    const p = this.entities.get(String(id));
    if (p) p.name = String(name || '').trim().slice(0, 24) || p.name;
    return p ? this.spawnInfoFor(p) : null;
  }

  spawnInfoFor(p) {
    return {
      id: p.id, name: p.name, bot: p.bot,
      spawn: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
      hp: p.hp, weapon: p.weapon, state: p.state,
      tickRate: Math.round(1000 / this.intervalMs),
    };
  }

  get count() { return this.humanIds.size; }
  get population() { return this.entities.size; }
  get players() { return Array.from(this.entities.values()); }
  get stats() {
    let bots = 0, alive = 0;
    for (const p of this.entities.values()) { if (p.bot) bots++; if (p.state === 'alive') alive++; }
    return { now: this.now, tick: this.tickNo, players: this.entities.size, humans: this.humanIds.size, bots, alive };
  }

  // ------------------------------------------------------------ input path

  /**
   * Store latest client intent; consumed by the next fixed step.
   * All fields are clamped here — nothing downstream trusts raw client data:
   * booleans coerced, angles finite+bounded, slots integer-clamped, and the
   * wish direction gets normalized at integration time so diagonal keys can
   * never exceed cap speed.
   */
  applyInput(id, msg) {
    const p = this.entities.get(String(id));
    if (!p || !msg || typeof msg !== 'object') return;
    const prev = p.input;
    const k = msg.keys || {};
    const inp = {
      seq: Number.isFinite(msg.seq) ? msg.seq | 0 : (prev ? prev.seq : 0),
      keys: {
        f: !!k.f, b: !!k.b, l: !!k.l, r: !!k.r,
        jump: !!k.jump, sprint: !!k.sprint, crouch: !!k.crouch,
        interact: !!k.interact,
      },
      wantFire: !!msg.wantFire,
      wantAds: !!msg.wantAds,
      reload: !!msg.reload,
      switchTo: undefined,
    };
    if (Number.isFinite(msg.yaw)) inp.yaw = wrapAngle(msg.yaw); else inp.yaw = prev ? prev.yaw : p.yaw;
    if (Number.isFinite(msg.pitch)) inp.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, msg.pitch));
    else inp.pitch = prev ? prev.pitch : p.pitch;
    const wRaw = msg.switchTo != null ? msg.switchTo : msg.weapon;
    if (Number.isFinite(wRaw)) inp.switchTo = clampWeaponSlot(wRaw);
    // Preserve a complete press/release that arrives between fixed simulation
    // steps. WebSocket ordering guarantees the rising edge is observed here
    // even when the latest sampled intent is already released.
    if (inp.wantFire && !(prev && prev.wantFire)) p.fireEdgeQueued = true;
    p.input = inp;
  }

  // ------------------------------------------------------------ timers

  updateTimers(p, dt) {
    p.cooldown = Math.max(-dt, p.cooldown - dt);
    if (p.deployT > 0) p.deployT = Math.max(0, p.deployT - dt);
    if (p.coyote > 0) p.coyote -= dt;
    const def = p.def;
    if (p.bloom > 0) p.bloom = Math.max(0, p.bloom - def.bloomRecover * dt);

    if (p.reloading) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) {
        p.reloading = false;
        const need = def.magSize - p.mag[p.weapon];
        const take = Math.min(need, p.reserve[p.weapon]);
        p.mag[p.weapon] += take;
        p.reserve[p.weapon] -= take;
      }
    }
  }

  updateCondition(p, dt) {
    const lowHealthFloor = (1 - clamp01(p.hp / 100)) * CONDITION_RULES.panicLowHpFloor;
    p.panic = clamp01(Math.max(lowHealthFloor, p.panic - CONDITION_RULES.panicDecayPerS * dt));
    const exhaustionRate = p.sprint
      ? CONDITION_RULES.exhaustionSprintPerS
      : -CONDITION_RULES.exhaustionRecoverPerS;
    p.exhaustion = clamp01(p.exhaustion + exhaustionRate * dt);
  }

  // ------------------------------------------------------------ movement

  boxCollides(px, py, pz) {
    const x0 = Math.floor(px - HALF_W + SHRINK), x1 = Math.floor(px + HALF_W - SHRINK);
    const y0 = Math.floor(py + SHRINK), y1 = Math.floor(py + P_HEIGHT - SHRINK);
    const z0 = Math.floor(pz - HALF_W + SHRINK), z1 = Math.floor(pz + HALF_W - SHRINK);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (this.world.getBlock(x, y, z) !== AIR) return true;
        }
      }
    }
    return false;
  }

  /** Grounded probe: any solid within a hair below the feet. */
  solidBelow(px, py, pz) {
    const yy = py - 0.06;
    if (Math.floor(yy) < 0) return true;
    const xs = [px - HALF_W + SHRINK, px + HALF_W - SHRINK];
    const zs = [pz - HALF_W + SHRINK, pz + HALF_W - SHRINK];
    const cellY = Math.floor(yy);
    for (const cx of xs) {
      for (const cz of zs) {
        if (this.world.getBlock(Math.floor(cx), cellY, Math.floor(cz)) !== AIR) return true;
      }
    }
    return false;
  }

  /**
   * Move along one axis in <=MAX_STEP sub-steps, sliding flush against the
   * first obstructing voxel face. Returns true when a collision occurred.
   */
  slideAxis(p, axis, total) {
    if (total === 0) return false;
    const sign = total < 0 ? -1 : 1;
    let collided = false;
    let rem = Math.abs(total);
    while (rem > 1e-9 && !collided) {
      const d = Math.min(MAX_STEP, rem) * sign;
      rem -= Math.abs(d);
      const before = p[axis];
      p[axis] = before + d;
      if (this.boxCollides(p.x, p.y, p.z)) {
        collided = true;
        if (axis === 'x') {
          const wallCell = sign > 0 ? Math.floor(p.x + HALF_W) : Math.floor(p.x - HALF_W);
          p.x = sign > 0 ? wallCell - HALF_W - EPS : wallCell + 1 + HALF_W + EPS;
        } else if (axis === 'z') {
          const wallCell = sign > 0 ? Math.floor(p.z + HALF_W) : Math.floor(p.z - HALF_W);
          p.z = sign > 0 ? wallCell - HALF_W - EPS : wallCell + 1 + HALF_W + EPS;
        } else {
          const cell = Math.floor(sign > 0 ? p.y + P_HEIGHT : p.y);
          p.y = sign > 0 ? cell - P_HEIGHT - EPS : cell + 1;
          if (sign < 0) { p.vy = 0; } else { p.vy = 0; }
        }
        if (this.boxCollides(p.x, p.y, p.z)) {
          // Corner degeneracy — fall back wholesale.
          p[axis] = before;
          if (axis === 'x') p.vx = 0;
          else if (axis === 'z') p.vz = 0;
          else p.vy = 0;
        } else if (axis === 'x') p.vx = 0;
        else if (axis === 'z') p.vz = 0;
        else p.vy = 0;
      }
    }
    return collided;
  }

  integrate(p, dt) {
    const inp = p.input || {
      seq: 0,
      keys: { f: 0, b: 0, l: 0, r: 0, jump: 0, sprint: 0, crouch: 0 },
      yaw: p.yaw, pitch: p.pitch, wantAds: false,
    };

    // NaN paranoia: corrupted state never propagates.
    if (![isFinite(p.x), isFinite(p.y), isFinite(p.z)].every(Boolean)) {
      this.forceRespawn(p);
      return;
    }

    p.yaw = inp.yaw; p.pitch = inp.pitch;
    p.ads = !!inp.wantAds;
    const adsStep = dt / Math.max(0.001, p.def.adsTime);
    p.adsT = Math.max(0, Math.min(1, p.adsT + (p.ads ? adsStep : -adsStep)));

    const kf = inp.keys;
    const fwdAmt = (kf.f ? 1 : 0) - (kf.b ? 1 : 0);
    const strafe = (kf.r ? 1 : 0) - (kf.l ? 1 : 0);
    p.crouch = !!kf.crouch;
    p.sprint = !!kf.sprint && fwdAmt > 0 && !p.crouch && !p.ads;

    // Normalized wish direction (kills the diagonal-speed exploit).
    let wx = 0, wz = 0;
    if (fwdAmt !== 0 || strafe !== 0) {
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      wx = -sy * fwdAmt + cy * strafe;
      wz = -cy * fwdAmt - sy * strafe;
      const l = Math.hypot(wx, wz);
      wx /= l; wz /= l;
    }
    const speed = p.crouch ? CROUCH_SPEED : (p.sprint ? SPRINT_SPEED : WALK_SPEED);
    const k = 1 - Math.exp(-(p.grounded ? ACCEL_GROUND : ACCEL_AIR) * dt);
    p.vx += (wx * speed - p.vx) * k;
    p.vz += (wz * speed - p.vz) * k;

    // Jump with a short coyote window.
    if (kf.jump && (p.grounded || p.coyote > 0) && p.vy <= 0.01) {
      p.vy = JUMP_VELOCITY;
      p.grounded = false;
      p.coyote = 0;
      p.exhaustion = clamp01(p.exhaustion + CONDITION_RULES.exhaustionJumpGain);
    }

    p.vy = Math.max(TERMINAL_VY, p.vy - GRAVITY * dt);

    // X, Z then Y — each axis separately with slide resolution.
    this.slideAxis(p, 'x', p.vx * dt);
    this.slideAxis(p, 'z', p.vz * dt);
    const dy = p.vy * dt;
    const hitY = this.slideAxis(p, 'y', dy);

    // Ground bookkeeping. Upward head impacts are not landings.
    if (hitY && dy < 0) {
      p.grounded = true;
    } else if (p.vy <= 0.001 && this.solidBelow(p.x, p.y, p.z)) {
      p.grounded = true;
      p.vy = 0;
    } else {
      if (p.grounded) p.coyote = COYOTE_S;
      p.grounded = false;
    }

    // Lag-compensation trail: keep a short window of authoritative positions
    // so human shots can be resolved against what the shooter actually saw.
    p.hist.push({ x: p.x, y: p.y, z: p.z, t: this.now });
    if (p.hist.length > 16) p.hist.shift();   // 16 ticks = 800 ms window

    if (p.y < DEAD_FALL_Y) this.killPlayer(p, null, 'world', false);
  }

  forceRespawn(p) {
    if (!p || typeof p !== 'object') return false;
    if (p.state === 'alive') this.killPlayer(p, null, 'world', false);
    if (!this.mode.canRespawn(p)) return false;
    this.respawnPlayer(p, this.mode.chooseSpawn(p, p.lastSpawnIndex));
    this.mode.onPlayerRespawn(p);
    return true;
  }

  // ------------------------------------------------------------ firing

  computeConeDeg(p) {
    return computeSpreadConeDeg(
      p.def, p.bloom, Math.hypot(p.vx, p.vz), p.adsT, p.panic, p.exhaustion,
    );
  }

  resolveWeaponIntent(p) {
    const inp = p.input;
    if (!inp) { p.triggerPrev = false; return; }

    // A new selection interrupts the current draw and starts the selected
    // weapon's full deploy timer, matching the client-side equip contract.
    if (inp.switchTo != null &&
        inp.switchTo !== p.weapon &&
        this.mode.canUseWeapon(p, inp.switchTo)) {
      this.switchWeapon(p, inp.switchTo);
    }

    const def = p.def;
    if (inp.reload && this.mode.canUseWeapon(p, p.weapon) &&
        !p.reloading && p.deployT <= 0 &&
        p.mag[p.weapon] < def.magSize && p.reserve[p.weapon] > 0) {
      p.reloading = true;
      p.reloadT = p.mag[p.weapon] > 0 ? def.tacTime : def.reloadTime;
    }

    const fireEdge = p.fireEdgeQueued;
    p.fireEdgeQueued = false;
    if ((inp.wantFire || fireEdge) && this.canFire(p, fireEdge)) this.fireOneShot(p);
    p.triggerPrev = inp.wantFire;
  }

  switchWeapon(p, slot) {
    p.weapon = clampWeaponSlot(slot);
    p.reloading = false;
    p.reloadT = 0;
    p.cooldown = Math.max(p.cooldown, 0);
    p.deployT = p.def.deployTime;
    p.ads = false;
    p.adsT = 0;
  }

  canFire(p, fireEdge = false) {
    const semi = p.def.mode !== 'auto';
    return this.mode.canFire(p) && !p.reloading && p.deployT <= 0 &&
      p.cooldown <= 0 && p.mag[p.weapon] > 0 &&
      !(semi && p.triggerPrev && !fireEdge);
  }

  /** Segment (array origin o, unit object direction d) vs victim AABB. */
  rayAABB(o, d, mnX, mnY, mnZ, mxX, mxY, mxZ) {
    let t0 = -Infinity, t1 = Infinity;
    const axes = [
      [o[0], d.x, mnX, mxX],
      [o[1], d.y, mnY, mxY],
      [o[2], d.z, mnZ, mxZ],
    ];
    for (let i = 0; i < 3; i++) {
      const ov = axes[i][0], dv = axes[i][1];
      if (Math.abs(dv) < 1e-9) {
        if (ov < axes[i][2] || ov > axes[i][3]) return null;
      } else {
        let ta = (axes[i][2] - ov) / dv;
        let tb = (axes[i][3] - ov) / dv;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
      }
    }
    if (t1 < t0 || t1 < 0) return null;
    return Math.max(t0, 0);
  }
  /** Victim position the SHOOTER actually saw. Human shooters see every remote
   *  player REWIND_MS in the past (client interpolation), so hits are resolved
   *  against the historical position; bot-native shots get none. */
  rewindVictim(v) {
    const h = v.hist;
    if (!h || !h.length) return v;
    const readAt = this.now - REWIND_MS;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t <= readAt || i === 0) {
        // Clamp: never use a sample older than the window start.
        if (readAt - h[i].t > HISTORY_WINDOW_MS) return v;
        return h[i];
      }
    }
    return v;
  }

  nearestVictim(shooter, o, d, limit) {
    let best = null, bestT = limit;
    const rewoundByShooter = !shooter.bot;
    for (const v of this.entities.values()) {
      if (v === shooter || v.state !== 'alive') continue;
      if (!this.mode.canDamage(shooter, v)) continue;
      const pos = rewoundByShooter ? this.rewindVictim(v) : v;
      const t = this.rayAABB(
        o, d,
        pos.x - PLAYER_HALF.x, pos.y, pos.z - PLAYER_HALF.x,
        pos.x + PLAYER_HALF.x, pos.y + P_HEIGHT, pos.z + PLAYER_HALF.x,
      );
      if (t != null && t < bestT) { bestT = t; best = { victim: v, x: pos.x, y: pos.y, z: pos.z }; }
    }
    if (!best) return null;
    return { victim: best.victim, t: bestT, rx: best.x, ry: best.y, rz: best.z };
  }

  fireOneShot(p) {
    const def = p.def;
    p.mag[p.weapon]--;
    p.cooldown += 60 / def.rpm;
    p.shotSeq++;
    p.firing = true;

    const rng = shotRng(p);
    const fwd = fwdFromYawPitch(p.yaw, p.pitch);
    const coneDeg = this.computeConeDeg(p);
    p.exhaustion = clamp01(p.exhaustion + CONDITION_RULES.exhaustionShotGain);
    p.bloom = Math.min(def.bloomMaxDeg, p.bloom + def.bloomDeg);
    const oEye = [p.x, p.eyeY, p.z];
    // Muzzle-ish origin reported to clients: eye dropped 0.15, nudged forward.
    const muzzle = [
      oEye[0] + fwd.x * 0.25,
      oEye[1] - 0.15 + fwd.y * 0.25,
      oEye[2] + fwd.z * 0.25,
    ];
    const solidAt = this.solidAt;

    const firstDir = sampleSpreadDir(fwd, rng, coneDeg);
    this.tickEvents.push(evShoot(
      p.id, muzzle, [fwd.x, fwd.y, fwd.z], def.id,
      [firstDir.x, firstDir.y, firstDir.z],
    ));
    for (let pellet = 0; pellet < def.pellets; pellet++) {
      const d = pellet === 0 ? firstDir : sampleSpreadDir(fwd, rng, coneDeg);

      const hit = raycastVoxels(solidAt, oEye[0], oEye[1], oEye[2], d.x, d.y, d.z, SHOT_REACH);
      const wallT = hit ? hit.t : SHOT_REACH;

      const tgt = this.nearestVictim(p, oEye, d, wallT);
      if (tgt) {
        const ix = oEye[0] + d.x * tgt.t;
        const iy = oEye[1] + d.y * tgt.t;
        const iz = oEye[2] + d.z * tgt.t;
        const hs = iy - tgt.ry > HEADSHOT_Y_FRAC * P_HEIGHT;
        let dmg = damageAtDistance(def, tgt.t) * (hs ? def.headMult : 1);
        dmg = Math.round(dmg * 10) / 10;
        const lethal = tgt.victim.takeDamage(dmg, hs);
        this.tickEvents.push(evHit(p.id, tgt.victim.id, dmg, hs, [ix, iy, iz]));
        if (lethal) this.killPlayer(tgt.victim, p, def.id, hs);
      } else if (hit) {
        const type = this.world.getBlock(hit.x, hit.y, hit.z);
        if (BLOCK_HP[type] != null) {
          const dmgB = Math.max(BLOCK_MIN_DMG, Math.round(damageAtDistance(def, hit.t)));
          this.damageBlock(hit.x, hit.y, hit.z, type, dmgB);
        }
        // Indestructible types simply terminate the tracer here.
      }
    }
  }

  blockKey(x, y, z) { return x + ',' + y + ',' + z; }

  damageBlock(x, y, z, type, dmg) {
    const key = this.blockKey(x, y, z);
    let hp = this.blockHp.has(key) ? this.blockHp.get(key) : BLOCK_HP[type];
    hp -= dmg;
    if (hp <= 0) this.destroyBlock(x, y, z, key);
    else this.blockHp.set(key, hp);
  }

  destroyBlock(x, y, z, key) {
    const from = this.world.getBlock(x, y, z);
    this.world.setBlock(x, y, z, AIR);
    if (key) this.blockHp.delete(key); else this.blockHp.delete(this.blockKey(x, y, z));
    this.pushBlockDelta(x, y, z, AIR);
    this.tickEvents.push(evBlock(x, y, z, AIR, from));
    // Fragile chain-support: GLASS/LEAVES stacked above collapse too.
    const above = this.world.getBlock(x, y + 1, z);
    if (above === GLASS || above === LEAVES) {
      this.destroyBlock(x, y + 1, z, null);
    }
  }

  pushBlockDelta(x, y, z, v) {
    this.tickBlocks.push({ i: ((y * SZ) + z) * SX + x, v });
  }

  // ------------------------------------------------------------ death / respawn

  killPlayer(victim, killer, wkey, hs) {
    if (victim.state !== 'alive') return;
    victim.hp = 0;
    victim.state = 'dead';
    victim.deaths++;
    victim.firing = false;
    victim.ads = false;
    victim.adsT = 0;
    victim.reloading = false;
    victim.bloom = 0;
    victim.vx = 0; victim.vy = 0; victim.vz = 0;
    if (killer && killer !== victim && killer.id !== victim.id) {
      killer.kills++;
      killer.score++;
    }
    this.mode.onPlayerDeath(victim, killer);
    this.tickEvents.push(evDie(victim.id));
    this.tickEvents.push(evKill(killer ? killer.id : '', victim.id, wkey || '', !!hs));
  }

  respawnPlayer(player, spawn = null, { emitEvent = true } = {}) {
    const entity = player && typeof player === 'object'
      ? player
      : this.entities.get(String(player));
    if (!entity) return false;
    const next = spawn || this.nextSpawnFor(entity, entity.lastSpawnIndex);
    entity.applySpawn(next);
    if (emitEvent) this.tickEvents.push(evRespawn(entity.id, entity.x, entity.y, entity.z));
    return true;
  }

  processRespawns() {
    for (const p of this.entities.values()) {
      if (p.state === 'dead' && this.now >= p.respawnAt && this.mode.canTimedRespawn(p)) {
        this.respawnPlayer(p, this.mode.chooseSpawn(p, p.lastSpawnIndex));
        this.mode.onPlayerRespawn(p);
      }
    }
  }
}

/** Test hook: advance the engine a number of ticks without any timer. */
export function _tickForTest(engine, ticks = 1) {
  for (let i = 0; i < ticks; i++) engine.step(engine.intervalMs);
  return engine;
}

GameEngine.prototype._tickForTest = function (ticks = 1) {
  return _tickForTest(this, ticks);
};
