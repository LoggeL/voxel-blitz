import { placeClaymore } from './claymore-rules.js';
import { molotovFireProfile } from './molotov-rules.js';
import { smokeProfile } from './smoke-rules.js';
/**
 * Shared client/server contract for the throwable roster: five throwable types with
 * one inventory, one ready-grenade pouch model (remembered power steps plus a cook
 * measured from the pin pull), and one physics integrator.
 *
 * - `frag`    M-4 FRAG         timed fuse that starts at the pin pull (cookable), bounces.
 * - `limpet`  CLAYMORE         mounts on a nearby wall and detonates when its laser is
 *                              crossed; it never flies or sticks to players.
 * - `pulse`   PULSE SHOCK      detonates on impact; light damage, huge knockback, and a
 *                              concussion that slows and panics whoever it lands on.
 * - `molotov` MOLOTOV COCKTAIL shatters on impact and leaves a persistent ground fire.
 * - `smoke`   M-18 SMOKE       timed fuse, then an optical cloud that blocks sight only.
 */
export const GRENADE_TYPE_IDS = Object.freeze(['frag', 'limpet', 'pulse', 'molotov', 'smoke']);

/** Hold time (ms) that reaches full throw strength. Cooking continues beyond it. */
export const GRENADE_CHARGE_MS = 1200;
export const GRENADE_MIN_THROW_SPEED = 18;
export const GRENADE_MAX_THROW_SPEED = 36;
export const GRENADE_MIN_LIFT = 2.1;
export const GRENADE_MAX_LIFT = 3.5;
/** A cooked fuse never gets shorter than this once the grenade leaves the hand. */
export const GRENADE_MIN_AIR_MS = 180;

/** Release within this window is a quick throw at the type's remembered power. */
export const GRENADE_TAP_MS = 170;
/** The pin pulls this long into a hold; cooking starts here (throwable-hands arm time). */
export const GRENADE_PIN_MS = 240;
/** Holding the pouch key this long opens the pouch radial instead of stepping it. */
export const GRENADE_POUCH_HOLD_MS = 200;
/** Throw power steps (charge 0..1), stepped by the wheel and remembered per type. */
export const GRENADE_POWER_STEPS = Object.freeze([0.2, 0.4, 0.6, 0.8, 1.0]);
export const GRENADE_DEFAULT_POWER_INDEX = 2;
/** Authority minimum interval between two throws from one player. */
export const GRENADE_THROW_COOLDOWN_MS = 450;
/**
 * Client-only margin on top of the authority cooldown. The server measures it between
 * its own tick times, so jitter and tick quantization can shrink the gap it sees; the
 * client waits this much longer so it never predicts a throw the server would drop.
 */
export const GRENADE_THROW_COOLDOWN_CLIENT_SLACK_MS = 100;
/** HUD grouping, and the auto-ready fallback when the current type runs out. */
export const GRENADE_ROLES = Object.freeze({
  frag: 'lethal', molotov: 'lethal', pulse: 'tactical', smoke: 'tactical', limpet: 'gadget',
});

const FRAG_PHYSICS = Object.freeze({
  gravity: 18,
  bounce: 0.46,
  floorFriction: 0.82,
  wallDamping: 0.88,
  radius: 0.16,
});

export const GRENADE_TYPES = Object.freeze({
  smoke: Object.freeze({
    id: 'smoke', name: 'M-18 SMOKE', short: 'SMK', perLife: 1,
    fuseMs: 1800, cook: false, impact: false,
    damage: 0, damageRadius: 4, selfDamage: 0, knockback: 0,
    terrainRadius: 0, terrainPower: 0, maxDestroyedBlocks: 0,
    concussMs: 0, concussPanic: 0, color: '#c7d9db',
    physics: Object.freeze({ ...FRAG_PHYSICS, bounce: 0.24, floorFriction: 0.65 }),
  }),
  frag: Object.freeze({
    id: 'frag',
    name: 'M-4 FRAG',
    short: 'FRAG',
    perLife: 2,
    fuseMs: 2600,
    cook: true,
    impact: false,
    damage: 175,
    damageRadius: 7.5,
    selfDamage: 0.72,
    knockback: 8.5,
    terrainRadius: 3.9,
    terrainPower: 165,
    maxDestroyedBlocks: 130,
    concussMs: 0,
    concussPanic: 0,
    color: '#ffb347',
    physics: FRAG_PHYSICS,
  }),
  limpet: Object.freeze({
    id: 'limpet',
    name: 'CLAYMORE',
    short: 'CLAY',
    perLife: 1,
    wallMine: true,
    fuseMs: 0,
    cook: false,
    impact: false,
    damage: 175,
    damageRadius: 5.0,
    selfDamage: 0.72,
    knockback: 9.5,
    terrainRadius: 4.6,
    terrainPower: 200,
    maxDestroyedBlocks: 160,
    concussMs: 0,
    concussPanic: 0,
    color: '#ff5a3c',
    physics: Object.freeze({
      gravity: 16,
      bounce: 0,
      floorFriction: 0,
      wallDamping: 0,
      radius: 0.14,
    }),
  }),
  pulse: Object.freeze({
    id: 'pulse',
    name: 'PULSE SHOCK',
    short: 'PLS',
    perLife: 2,
    fuseMs: 1800,
    cook: false,
    impact: true,
    damage: 50,
    damageRadius: 7.2,
    selfDamage: 0.5,
    knockback: 42,
    selfKnockback: 48,
    knockbackFalloff: 0.65,
    terrainRadius: 0,
    terrainPower: 0,
    maxDestroyedBlocks: 0,
    /** Concussion: movement runs at 60% speed and panic spikes for this long. */
    concussMs: 2000,
    concussPanic: 0.55,
    color: '#59e8ff',
    physics: Object.freeze({
      gravity: 14,
      bounce: 0,
      floorFriction: 0,
      wallDamping: 0,
      radius: 0.15,
    }),
  }),
  molotov: Object.freeze({
    id: 'molotov',
    name: 'MOLOTOV COCKTAIL',
    short: 'MOL',
    perLife: 1,
    /** Flight failsafe; this bottle normally breaks on its first contact. */
    fuseMs: 5000,
    cook: false,
    impact: true,
    damage: 0,
    damageRadius: 3.2,
    selfDamage: 0.72,
    knockback: 0,
    terrainRadius: 0,
    terrainPower: 0,
    maxDestroyedBlocks: 0,
    concussMs: 0,
    concussPanic: 0,
    color: '#ff742b',
    physics: Object.freeze({
      gravity: 18,
      bounce: 0,
      floorFriction: 0,
      wallDamping: 0,
      radius: 0.16,
    }),
  }),
});

export const GRENADE_FUSE_MS = GRENADE_TYPES.frag.fuseMs;

/** Per-type inventory for a fresh life, in `GRENADE_TYPE_IDS` order. */
export function freshGrenadeLoadout() {
  return GRENADE_TYPE_IDS.map((id) => GRENADE_TYPES[id].perLife);
}

export function clampGrenadeCharge(value) {
  const charge = Number(value);
  return Number.isFinite(charge) ? Math.max(0, Math.min(1, charge)) : 0;
}

/** Type index clamped into the roster; anything unreadable is the first type. */
export function clampGrenadeType(value) {
  const index = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(GRENADE_TYPE_IDS.length - 1, index));
}

export function grenadeTypeAt(index) {
  return GRENADE_TYPES[GRENADE_TYPE_IDS[clampGrenadeType(index)]];
}

/**
 * Cooked milliseconds already burned off a timed fuse. Non-cookable types always report
 * zero; a cook at or beyond the fuse means the grenade detonates in the hand.
 */
export function clampGrenadeCook(value, type = GRENADE_TYPES.frag) {
  const profile = typeof type === 'string' ? GRENADE_TYPES[type] : type;
  if (!profile || !profile.cook) return 0;
  const cook = Number(value);
  if (!Number.isFinite(cook) || cook <= 0) return 0;
  return Math.min(profile.fuseMs, Math.round(cook));
}

/** Remaining fuse for a cook value; clamps so the grenade always clears the hand. */
export function grenadeFuseAfterCook(cookMs, type = GRENADE_TYPES.frag) {
  const profile = typeof type === 'string' ? GRENADE_TYPES[type] : type;
  if (!profile) return GRENADE_FUSE_MS;
  const cook = clampGrenadeCook(cookMs, profile);
  return Math.max(GRENADE_MIN_AIR_MS, profile.fuseMs - cook);
}

/** Fuse a thrown grenade leaves the hand with: cookable types burn off the cook. */
export function grenadeThrowFuseMs(type, cookMs = 0) {
  return type.cook ? grenadeFuseAfterCook(cookMs, type) : type.fuseMs;
}

/** Cook for a hold of `heldMs`: measured from the pin pull, zero for non-cook types. */
export function grenadeCookFromHold(heldMs, type) {
  const profile = typeof type === 'string' ? GRENADE_TYPES[type] : type;
  if (!profile || !profile.cook) return 0;
  const held = Number(heldMs);
  return Number.isFinite(held) ? Math.max(0, held - GRENADE_PIN_MS) : 0;
}

/** Throw charge for a power step index, clamped into `GRENADE_POWER_STEPS`. */
export function grenadePowerAt(index) {
  const last = GRENADE_POWER_STEPS.length - 1;
  const step = Number.isFinite(index) ? Math.trunc(index) : GRENADE_DEFAULT_POWER_INDEX;
  return GRENADE_POWER_STEPS[Math.max(0, Math.min(last, step))];
}

function stocked(counts, index) {
  return index >= 0 && Number(counts?.[index]) > 0;
}

/**
 * Next type index after `from` (in `dir` order, wrapping) with a count above zero.
 * `from` itself is never returned; -1 when no other type is stocked.
 */
export function nextStockedGrenade(counts, from, dir = 1) {
  const total = GRENADE_TYPE_IDS.length;
  const step = dir < 0 ? -1 : 1;
  // `from` outside the roster (nothing ready): the first stocked slot in `dir` order.
  const inRoster = Number.isInteger(from) && from >= 0 && from < total;
  const start = inRoster ? from : (step > 0 ? -1 : total);
  for (let i = 1; i <= (inRoster ? total - 1 : total); i++) {
    const index = (((start + step * i) % total) + total) % total;
    if (stocked(counts, index)) return index;
  }
  return -1;
}

/**
 * The type the pouch should have ready: `current` while stocked, then the last manual
 * pick `preferred`, then the first stocked type sharing current's role, then the first
 * stocked type in roster order. -1 when the pouch is empty.
 */
export function autoReadyGrenade(counts, current, preferred) {
  if (stocked(counts, current)) return current;
  if (stocked(counts, preferred)) return preferred;
  const role = GRENADE_ROLES[GRENADE_TYPE_IDS[current]];
  if (role) {
    const same = GRENADE_TYPE_IDS.findIndex((id, i) => GRENADE_ROLES[id] === role && stocked(counts, i));
    if (same >= 0) return same;
  }
  return GRENADE_TYPE_IDS.findIndex((_, i) => stocked(counts, i));
}

/** Radius (m) of the area a type affects, for landing-zone previews. */
export function grenadeEffectRadius(typeId, chaosLevel = 0) {
  if (typeId === 'molotov') return molotovFireProfile(chaosLevel).radius;
  if (typeId === 'smoke') return smokeProfile(chaosLevel).radius;
  return (GRENADE_TYPES[typeId] || GRENADE_TYPES.frag).damageRadius;
}

export function grenadeThrowProfile(value) {
  const charge = clampGrenadeCharge(value);
  return Object.freeze({
    charge,
    speed: GRENADE_MIN_THROW_SPEED
      + (GRENADE_MAX_THROW_SPEED - GRENADE_MIN_THROW_SPEED) * charge,
    lift: GRENADE_MIN_LIFT + (GRENADE_MAX_LIFT - GRENADE_MIN_LIFT) * charge,
  });
}

/**
 * Launch state for a throw: release point in front of the eye plus a velocity that
 * inherits part of the thrower's body velocity. `dir` is the unit look vector.
 * Returns plain numbers so both the server entity and client prediction can copy them.
 */
export function grenadeLaunch({ x, y, z, eyeY, vx = 0, vy = 0, vz = 0, dir, charge, type = 'frag', solidAt = null }) {
  if (type === 'limpet') return placeClaymore({ x, eyeY, z, dir }, solidAt);
  const profile = grenadeThrowProfile(charge);
  const d = dir || { x: 0, y: 0, z: -1 };
  const typeId = GRENADE_TYPES[type] ? type : 'frag';
  return {
    type: typeId,
    charge: profile.charge,
    x: x + d.x * 0.48,
    y: eyeY - 0.12 + d.y * 0.38,
    z: z + d.z * 0.48,
    vx: d.x * profile.speed + vx * 0.35,
    vy: d.y * profile.speed + profile.lift + vy * 0.2,
    vz: d.z * profile.speed + vz * 0.35,
  };
}

function physicsFor(grenade) {
  const profile = grenade && GRENADE_TYPES[grenade.type];
  return profile ? profile.physics : FRAG_PHYSICS;
}

function moveGrenadeAxis(grenade, axis, delta, isSolid, physics) {
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-8) return false;
  const radius = physics.radius;
  const next = grenade[axis] + delta;
  const x = axis === 'x' ? next + Math.sign(delta) * radius : grenade.x;
  const y = axis === 'y' ? next + Math.sign(delta) * radius : grenade.y;
  const z = axis === 'z' ? next + Math.sign(delta) * radius : grenade.z;
  const blocked = isSolid(x, y, z) || (axis !== 'y' && isSolid(x, y + radius, z));
  if (!blocked) {
    grenade[axis] = next;
    return false;
  }
  // Move up to the surface instead of bouncing early and hovering above it.
  let low = 0, high = 1;
  for (let i = 0; i < 8; i++) {
    const fraction = (low + high) / 2;
    const sample = grenade[axis] + delta * fraction + Math.sign(delta) * radius;
    const sx = axis === 'x' ? sample : grenade.x;
    const sy = axis === 'y' ? sample : grenade.y;
    const sz = axis === 'z' ? sample : grenade.z;
    if (isSolid(sx, sy, sz) || (axis !== 'y' && isSolid(sx, sy + radius, sz))) high = fraction;
    else low = fraction;
  }
  grenade[axis] += delta * low;
  grenade['v' + axis] *= -physics.bounce;
  if (axis !== 'y') grenade['v' + axis] *= physics.wallDamping;
  return true;
}

/**
 * Advance one grenade `{type?,x,y,z,vx,vy,vz}` by `dt` seconds against `isSolid(x,y,z)`
 * in world coordinates. Mutates and returns the grenade; `hitFloor` reports a floor
 * contact and `hitSolid` any contact at all (impact types read it).
 */
export function stepGrenade(grenade, dt, isSolid) {
  const duration = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
  const physics = physicsFor(grenade);
  grenade.hitFloor = false;
  grenade.hitSolid = false;
  if (grenade.type === 'limpet' || grenade.stuck || duration === 0) return grenade;
  // Small swept steps prevent fast throws from skipping thin voxel walls.
  const speed = Math.hypot(grenade.vx, grenade.vy, grenade.vz) + physics.gravity * duration;
  const count = Math.max(1, Math.ceil(Math.max(duration * 120, speed * duration / physics.radius)));
  const step = duration / count;
  for (let i = 0; i < count; i++) {
    grenade.vy -= physics.gravity * step;
    const falling = grenade.vy < 0;
    const hitX = moveGrenadeAxis(grenade, 'x', grenade.vx * step, isSolid, physics);
    const hitZ = moveGrenadeAxis(grenade, 'z', grenade.vz * step, isSolid, physics);
    const hitY = moveGrenadeAxis(grenade, 'y', grenade.vy * step, isSolid, physics);
    if (hitY && falling) {
      grenade.vx *= physics.floorFriction;
      grenade.vz *= physics.floorFriction;
      if (grenade.vy < 0.65) grenade.vy = 0;
      if (Math.hypot(grenade.vx, grenade.vz) < 0.15) grenade.vx = grenade.vz = 0;
    }
    grenade.hitFloor ||= hitY && falling;
    grenade.hitSolid ||= hitY || hitX || hitZ;
    if (grenade.hitSolid && GRENADE_TYPES[grenade.type]?.impact) {
      grenade.vx = grenade.vy = grenade.vz = 0;
      break;
    }
  }
  return grenade;
}

/**
 * Predicted flight path from a launch state until the fuse burns out. Returns
 * `{points:[[x,y,z],...], landing:[x,y,z], rests:boolean, bounces:[[x,y,z],...]}`;
 * `rests` is true when the grenade has effectively stopped before detonating (a settled,
 * readable landing spot). `bounces` marks each new contact the grenade survives.
 * Impact types stop at their first contact, which is where they detonate.
 */
export function predictGrenadePath(launch, isSolid, {
  fuseMs = null,
  stepSeconds = 1 / 40,
  maxPoints = 96,
} = {}) {
  const profile = GRENADE_TYPES[launch.type] || GRENADE_TYPES.frag;
  const horizon = Number.isFinite(fuseMs) ? fuseMs : grenadeThrowFuseMs(profile);
  const grenade = {
    type: profile.id,
    x: launch.x, y: launch.y, z: launch.z,
    vx: launch.vx, vy: launch.vy, vz: launch.vz,
  };
  const points = [[grenade.x, grenade.y, grenade.z]];
  const steps = Math.max(1, Math.ceil((horizon / 1000) / stepSeconds));
  const stride = Math.max(1, Math.ceil(steps / (maxPoints - 1)));
  const bounces = [];
  let contact = false;
  let touching = false;
  for (let i = 1; i <= steps; i++) {
    stepGrenade(grenade, Math.min(stepSeconds, horizon / 1000 - (i - 1) * stepSeconds), isSolid);
    if (profile.impact && grenade.hitSolid) {
      contact = true;
      points.push([grenade.x, grenade.y, grenade.z]);
      break;
    }
    // One mark per new contact; a grenade rolling or resting on the floor stays touching.
    if (grenade.hitSolid && !touching) bounces.push([grenade.x, grenade.y, grenade.z]);
    touching = grenade.hitSolid;
    if (i % stride === 0 || i === steps) points.push([grenade.x, grenade.y, grenade.z]);
  }
  const speed = Math.hypot(grenade.vx, grenade.vy, grenade.vz);
  return {
    points,
    landing: [grenade.x, grenade.y, grenade.z],
    rests: contact || speed < 1.5,
    bounces,
  };
}
