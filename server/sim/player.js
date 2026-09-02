// Authoritative combatant state, loadouts, and aim helpers.

import { SX, SZ } from '../../shared/worlddata.js';
import {
  WEAPONS,
  WEAPON_IDS,
  CONDITION_RULES,
  GRAVITY,
  PLAYER_HALF,
  EYE_HEIGHT,
} from '../../shared/combatmath.js';
import { mulberry32 } from '../../shared/noise.js';
import { freshGrenadeLoadout } from '../../shared/grenade-rules.js';

const WALK_SPEED = 4.4;
const SPRINT_SPEED = 6.2;
const CROUCH_SPEED = 2.2;
const JUMP_VELOCITY = 8.2;
const ACCEL_GROUND = 10;
const ACCEL_AIR = ACCEL_GROUND * 0.3;
const EYE = EYE_HEIGHT;
const CROUCH_EYE = EYE * 0.58;
const CHEST_Y = 1.2;

/** Physics numbers mirrored from BUILD-CONTRACT "Physics constants". */
export const PHYSICS = {
  walk: WALK_SPEED,
  sprint: SPRINT_SPEED,
  crouch: CROUCH_SPEED,
  jump: JUMP_VELOCITY,
  gravity: GRAVITY,
  eye: EYE,
  crouchEye: CROUCH_EYE,
  accelGround: ACCEL_GROUND,
  accelAir: ACCEL_AIR,
  halfW: PLAYER_HALF.x,
  height: PLAYER_HALF.h * 2,
};

/** Direction vector from aim angles. yaw=0 faces -Z and pitch>0 looks up. */
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

export function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

export function clampWeaponSlot(value) {
  const slot = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(WEAPON_IDS.length - 1, slot));
}

export function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Deterministic per-shot RNG so authoritative spread is reproducible. */
export function shotRng(player) {
  return mulberry32(
    (seedFromString(player.id) ^ Math.imul(player.shotSeq + 1, 2654435761)) >>> 0,
  );
}

/** Return independent ammunition arrays for a fresh life. */
export function freshLoadout() {
  return {
    mag: WEAPON_IDS.map((key) => WEAPONS[key].magSize),
    // Kept as `reserve` on the wire for compatibility; each value is a count
    // of full spare magazines, never a loose-round pool.
    reserve: WEAPON_IDS.map((key) => WEAPONS[key].spareMags),
  };
}

/** One combatant. Humans and bots share the same simulation state. */
export class PlayerEntity {
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
    const centerAim = aimAngles(
      [this.x, this.y, this.z],
      [SX / 2, this.y + CHEST_Y, SZ / 2],
    );
    this.yaw = centerAim.yaw; this.pitch = 0;
    this.hp = 100;
    this.panic = 0;
    this.pain = 0;
    this.exhaustion = 0;
    this.state = 'alive';
    this.respawnAt = 0;
    this.spawnProtectedUntil = 0;
    this.spawnProtected = false;
    this.weapon = 0;
    const load = freshLoadout();
    this.mag = load.mag;
    this.reserve = load.reserve;
    this.reloading = false;
    this.reloadT = 0;
    this.reloadStage = null;
    this.reloadLoose = 0;
    this.deployT = WEAPONS[WEAPON_IDS[0]].deployTime;
    this.cooldown = 0;
    this.bloom = 0;
    this.ads = false;
    this.adsT = 0;
    this.hist = [];
    this.triggerPrev = false;
    this.fireEdgeQueued = false;
    this.grenadeEdgeQueued = false;
    this.grenadeChargeQueued = 0;
    this.grenadeTypeQueued = 0;
    this.grenadeCookQueued = 0;
    this.grenades = freshGrenadeLoadout();
    // Charge-mode weapons (LONGARC): hold time and the normalized wire charge.
    this.charging = false;
    this.chargeT = 0;
    this.charge = 0;
    // Pulse concussion deadline (server clock ms); movement slows until then.
    this.concussedUntil = 0;
    this.grounded = false;
    this.coyote = 0;
    this.crouch = false;
    this.sprint = false;
    this.lives++;
    this.lastSpawnIndex = spawn.index | 0;
    this.lastSpawnX = spawn.x;
    this.lastSpawnY = spawn.y;
    this.lastSpawnZ = spawn.z;
  }

  get def() { return WEAPONS[WEAPON_IDS[this.weapon]]; }
  get eyeY() { return this.y + (this.crouch ? CROUCH_EYE : EYE); }

  /** Return true when the hit is lethal. */
  takeDamage(dmg, headshot = false) {
    if (this.state !== 'alive') return false;
    const amount = Math.max(0, Number.isFinite(dmg) ? dmg : 0);
    this.hp -= amount;
    this.panic = clamp01(this.panic + amount * CONDITION_RULES.panicDamageGain +
      (headshot ? CONDITION_RULES.panicHeadshotGain : 0));
    this.pain = clamp01(this.pain + amount * CONDITION_RULES.painDamageGain +
      (headshot ? CONDITION_RULES.painHeadshotGain : 0));
    if (this.hp <= 0) { this.hp = 0; return true; }
    return false;
  }
}
