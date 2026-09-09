import { SUPPRESSION_RULES } from '../../shared/suppression-rules.js';
import { BreathHold } from '../../shared/conditions.js';
import { stanceEye } from '../../shared/player-stance.js';
import { chaosWeaponDef } from '../../shared/chaos.js';
import { bastionWeaponDef } from '../../shared/bastion.js';
// Authoritative combatant state, loadouts, and aim helpers.

import { SX, SZ } from '../../shared/worlddata.js';
import {
  WEAPONS,
  WEAPON_IDS,
  CONDITION_RULES,
} from '../../shared/combatmath.js';
import { mulberry32 } from '../../shared/noise.js';
import { freshGrenadeLoadout } from '../../shared/grenade-rules.js';
import { POWERUP_RULES } from '../../shared/powerups.js';

import { PHYSICS } from '../../shared/player-movement.js';

const CHEST_Y = 1.2;

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

function seedFromString(s) {
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
function freshLoadout() {
  return {
    mag: WEAPON_IDS.map((key) => WEAPONS[key].magSize),
    // Kept as `reserve` on the wire for compatibility; each value is a count
    // of spare shells for tube weapons, or full spare magazines otherwise.
    reserve: WEAPON_IDS.map((key) => (WEAPONS[key].spareRounds ?? WEAPONS[key].spareMags)),
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
    this.armor = 0;
    this.lastDamage = null;
    this.panic = 0;
    this.breath = new BreathHold();
    this.suppressionBudget = SUPPRESSION_RULES.budget;
    this.suppressionAt = null;
    this.suppressionGainAt = null;
    this.burn = null;
    this.burning = 0;
    this.molotovBurning = 0;
    this.pain = 0;
    this.exhaustion = 0;
    this.state = 'alive';
    this.respawnAt = 0;
    this.spawnProtectedUntil = 0;
    this.spawnProtected = false;
    this.weapon = Number.isInteger(this.weapon) && WEAPON_IDS[this.weapon] ? this.weapon : 0;
    const load = freshLoadout();
    this.mag = load.mag;
    this.reserve = load.reserve;
    this.infiniteMagazines = false;
    this.impulseSeq = 0;
    this.reloading = false;
    this.reloadState = null;
    this.reloadAck ??= 0;
    this.reloadT = 0;
    this.reloadPrev = false;
    this.vault = null;
    this.jumpGroundY = null;
    this.jumpWasHeld = false;
    this.reloadStage = null;
    this.reloadLoose = 0;
    this.deployT = WEAPONS[WEAPON_IDS[this.weapon]].deployTime;
    this.cooldown = 0;
    this.bloom = 0;
    this.ads = false;
    this.adsT = 0;
    this.hist = [];
    this.triggerPrev = false;
    this.fireEdgeQueued = false;
    this.fireAimQueued = null;
    this.quickMeleeQueued = null;
    this.quickMeleeT = 0;
    this.grenadeHandlingQueued = false;
    this.grenadeEdgeQueued = false;
    this.grenadeChargeQueued = 0;
    this.grenadeTypeQueued = 0;
    this.grenadeCookQueued = 0;
    this.grenadeAimQueued = null;
    this.grenades = freshGrenadeLoadout();
    // Charge-mode weapons (LONGARC): hold time and the normalized wire charge.
    this.charging = false;
    this.chargeT = 0;
    this.charge = 0;
    this.minigun = { heat: 0, spin: 0, overheated: false };
    // Pulse concussion deadline (server clock ms); movement slows until then.
    this.concussedUntil = 0;
    this.grounded = false;
    this.coyote = 0;
    this.crouch = false;
    this.proneT = 0;
    this.sprint = false;
    this.lives++;
    this.lastSpawnIndex = spawn.index | 0;
    this.lastSpawnX = spawn.x;
    this.lastSpawnY = spawn.y;
    this.lastSpawnZ = spawn.z;
  }

  get def() { return bastionWeaponDef(this, chaosWeaponDef(this, WEAPONS[WEAPON_IDS[this.weapon]])); }
  get eyeY() { return this.y + stanceEye(PHYSICS.eye, this.crouch, this.proneT); }

  /** Return true when the hit is lethal. */
  takeDamage(dmg, headshot = false) {
    if (this.state !== 'alive') return false;
    if (!Number.isFinite(dmg) || dmg <= 0) return false;
    const amount = dmg;
    const armor = Math.max(0, Math.min(POWERUP_RULES.maxArmor,
      Number.isFinite(this.armor) ? this.armor : 0));
    const absorbed = Math.min(armor, amount);
    const healthBefore = Math.max(0, this.hp);
    const healthDamage = amount - absorbed;
    const lethal = healthDamage >= healthBefore;
    this.lastDamage = { healthBefore, healthDamage, lethal,
      overkill: lethal ? Math.max(0, healthDamage - healthBefore) : 0 };
    this.armor = armor - absorbed;
    this.hp -= healthDamage;
    // Armor prevents wounds, while the incoming impact still shakes the player.
    this.panic = clamp01(this.panic + amount * CONDITION_RULES.panicDamageGain +
      (headshot ? CONDITION_RULES.panicHeadshotGain : 0));
    this.pain = clamp01(this.pain + healthDamage * CONDITION_RULES.painDamageGain +
      (headshot && healthDamage > 0 ? CONDITION_RULES.painHeadshotGain * (healthDamage / amount) : 0));
    if (this.hp <= 0) { this.hp = 0; return true; }
    return false;
  }
}
