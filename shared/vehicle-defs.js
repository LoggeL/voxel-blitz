/**
 * Vehicle registry for Conquest v2. Seat and mount order come from the frozen
 * contract topology; this module adds every number: handling rules, armour,
 * colliders, seat hips, mount anchors and limits, weapons, destruction,
 * countermeasures and lifecycle timers. Balance tuning edits data here only.
 *
 * Frames: metres, hull-local +X right, +Y up, forward is -Z. World yaw follows
 * vehicleDirection (yaw 0 faces -Z, positive yaw turns toward -X / left).
 */
import { VEHICLE_TOPOLOGY, VEHICLE_WEAPON_META, COUNTERMEASURES, VEHICLE_TYPE_IDS, vehicleMountOrder, seatWeaponList } from './conquest-contract.js';
import { JEEP_RULES } from './vehicle-handling/jeep.js';
import { TANK_RULES } from './vehicle-handling/tank.js';
import { HELICOPTER_RULES } from './vehicle-handling/helicopter.js';
import { TRANSPORT_RULES } from './vehicle-handling/transport.js';
import { PLANE_RULES } from './vehicle-handling/plane.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Damage-state, regen and repair rules shared by every hull (spec F4). */
export const VEHICLE_DAMAGE_RULES = freeze({
  disabledFraction: 0.25, disableHitFraction: 0.3,
  burnFractionPerSecond: 0.02, repairClearFraction: 0.3,
  regenDelaySeconds: 8, regenFractionPerSecond: 0.02, regenCapFraction: 0.6,
  disabledDrive: 0.4, disabledSlew: 0.5, disabledPower: 0.5,
  hitMergeMs: 100, repairEventMs: 500, assistWindowMs: 15000,
  fallDamageSpeed: 9, fallDamageScale: 25,
});

/** Hull lifecycle: wreck solidity, abandonment and spawn pads. */
export const VEHICLE_LIFECYCLE = freeze({
  wreckSolidSeconds: 12,
  abandonSeconds: 90, abandonDistance: 60, abandonUndamagedSeconds: 30,
  padNudgeSeconds: 10, padSwitchDistance: 30,
  exitNoCollideSeconds: 1,
  plainCollisionSafeSpeed: 15,
});

/** Hull mass in tonnes: momentum transfer when a hull shoves a wreck. */
export const VEHICLE_MASS = freeze({ jeep: 2.5, tank: 45, helicopter: 6, transport: 8, plane: 9 });

/**
 * Ground wrecks shoved by a driving hull (see VehicleSystem.pushWrecks). A
 * wreck drags on the ground at `friction`·g; a pusher keeps shoving it only
 * while its loaded `pushForce` (VEHICLE_RAM, t·m/s²) beats that drag. A hull
 * moves no wreck heavier than its `maxPushMass`; an impact shares momentum by
 * mass (perfectly inelastic) and never makes either hull faster.
 */
export const WRECK_PUSH_RULES = freeze({ friction: 1.2, gravity: 9.81, maxSpeed: 14, minSpeed: 0.05, minAlignment: 0.2 });

/**
 * Ground hulls driving into voxels. `classes` maps a RAM_CLASS (shared/world/
 * blocks.js) to the speed (m/s) needed to break it; a class missing here never
 * breaks for that hull. Each broken block costs `speedLoss`·hardness/mass m/s
 * and (hardness − `armor`)·`damage` hull points. At most `perTick` blocks per
 * server tick, drawn from a `burst` budget refilled at `refill` per second.
 */
export const VEHICLE_RAM = freeze({
  jeep: { pushForce: 0, maxPushMass: 3, classes: { brush: 2, wood: 8 }, armor: 12, perTick: 4, burst: 12, refill: 6 },
  tank: { pushForce: 600, maxPushMass: 60, classes: { brush: 1, wood: 2, thin: 3, masonry: 7 }, armor: 55, perTick: 8, burst: 40, refill: 16 },
});
/** A hit whose share into the wall is under `glancingNormal` (30°) scrapes along it and breaks only brush. */
export const RAM_RULES = freeze({ speedLoss: 0.15, damage: 0.5, glancingNormal: 0.5, flagGuardRadius: 5, baseGuardMargin: 0 });

/**
 * Lock-on sources (spec F4 locks). Cones are full half-angles in radians. The
 * Engineer's AX-9 STINGER is the only infantry locker; the RX-8 AT rocket is
 * dumb-fire. Only airborne enemy aircraft can be locked.
 */
export const LOCK_RULES = freeze({
  stinger: { range: 320, cone: 7 * Math.PI / 180, seconds: 1.4 },
  aaMissile: { range: 350, cone: 10 * Math.PI / 180, seconds: 1.5 },
  losIntervalMs: 100,
});

/** Countermeasure timings by kind. */
export const COUNTERMEASURE_RULES = freeze({
  flares: { cooldownSeconds: 18, durationSeconds: 3, decoyDrop: 6 },
  smoke: { cooldownSeconds: 25, durationSeconds: 12, fields: 3, distance: 6, spread: 0.5, radius: 4.5, height: 1.4 },
});

/**
 * Weapon numbers before the armour matrix (spec §5.2). `cooldown` is seconds
 * between shots; `magazine` rounds before `reloadSeconds`; `rearmSeconds`
 * refills one round per rail after each launch; heat weapons lock out for
 * `overheatSeconds` at heat 1 and cool by `coolPerSecond`.
 */
const weapon = (key, numbers) => ({ key, ...VEHICLE_WEAPON_META[key], ...numbers });
export const VEHICLE_WEAPONS = freeze({
  tankAP: weapon('tankAP', { cooldown: 3.5, sharedCooldown: 'main', damage: 400, splash: 60, splashRadius: 2.5, splashCls: 'at',
    terrainRadius: 2.5, terrainPower: 160, maxDestroyedBlocks: 40, lifetimeMs: 4000, knockback: 14 }),
  tankHE: weapon('tankHE', { cooldown: 3.5, sharedCooldown: 'main', damage: 160, splash: 120, splashRadius: 5.5, splashCls: 'he',
    terrainRadius: 4, terrainPower: 220, maxDestroyedBlocks: 140, lifetimeMs: 4000, knockback: 26 }),
  coaxMG: weapon('coaxMG', { cooldown: 1 / 10, damage: 14, heatPerShot: 0.05, coolPerSecond: 0.35, overheatSeconds: 3,
    range: 300, spreadDeg: 0.35, headMult: 1.4 }),
  hmg: weapon('hmg', { cooldown: 1 / 8, damage: 24, heatPerShot: 0.07, coolPerSecond: 0.35, overheatSeconds: 3,
    range: 350, spreadDeg: 0.6, headMult: 1.4 }),
  helicopterRocket: weapon('helicopterRocket', { cooldown: 0.2, magazine: 14, reloadSeconds: 6, damage: 70, splash: 80, splashRadius: 4,
    splashCls: 'he', terrainRadius: 2.5, terrainPower: 150, maxDestroyedBlocks: 60, lifetimeMs: 5000, knockback: 20, convergence: 120 }),
  chinCannon: weapon('chinCannon', { cooldown: 1 / 5, damage: 30, splash: 25, splashRadius: 2, splashCls: 'autocannon',
    heatPerShot: 0.06, coolPerSecond: 0.35, overheatSeconds: 3, terrainRadius: 1, terrainPower: 70, maxDestroyedBlocks: 6,
    lifetimeMs: 2500, knockback: 6 }),
  doorMinigun: weapon('doorMinigun', { cooldown: 1 / 18, damage: 13, heatPerShot: 0.04, coolPerSecond: 0.35, overheatSeconds: 3,
    range: 300, spreadDeg: 1, headMult: 1.4 }),
  planeCannon: weapon('planeCannon', { cooldown: 1 / 14, damage: 26, heatPerShot: 0.05, coolPerSecond: 0.35, overheatSeconds: 3,
    range: 350, spreadDeg: 0.5, headMult: 1.4 }),
  aaMissile: weapon('aaMissile', { cooldown: 1, magazine: 2, rearmSeconds: 15, damage: 300, splash: 40, splashRadius: 3, splashCls: 'aa',
    terrainRadius: 0, terrainPower: 0, maxDestroyedBlocks: 0, lifetimeMs: 6000, knockback: 10,
    turnRate: 2.4, navConstant: 4, proximity: 3 }),
});

/**
 * Infantry RX-8 rocket in Conquest: the Engineer's dumb-fire AT launcher. Hull
 * numbers at the AT class (a direct hit adds `hullDirect` to the full
 * `hullSplash`), so with the heavy facing zones a full tank takes 4 front hits
 * (380 x 0.75 = 285), 3 on the side and 2 in the rear (570, and the first rear
 * hit disables it). A jeep (light, 320 HP) dies to one hit, a helicopter
 * (air x0.8 = 304) to three. Infantry splash is scaled by 0.7.
 */
export const CONQUEST_ROCKET_PROFILE = freeze({ hullDirect: 320, hullSplash: 60, cls: 'at', infantrySplashScale: 0.7 });

/**
 * AX-9 STINGER missile (Engineer AA gadget). Launched only with a complete
 * lock; flies like the jet's AA missile (no gravity, proportional navigation,
 * proximity fuse) and is decoyed by flares. Hull damage is per airframe type
 * at the `aa` class: a helicopter or transport takes 2 hits, a jet 3. Ground
 * hulls are never locked; a decoyed or expired missile only splashes infantry.
 */
export const STINGER_RULES = freeze({
  key: 'stinger', label: 'AX-9 STINGER', kind: 'missile', cls: 'aa', presentation: 'aaMissile',
  speed: 120, gravity: 0, lifetimeMs: 6000, launchForward: 0.9,
  turnRate: 2.6, navConstant: 4, proximity: 3,
  hullDamage: { helicopter: 360, transport: 330, plane: 170 },
  // Infantry splash only (hulls take hullDamage on the fused target).
  damage: 0, splash: 35, splashRadius: 3, splashCls: 'aa', knockback: 8,
  terrainRadius: 0, terrainPower: 0, maxDestroyedBlocks: 0,
});

const seatHips = {
  jeep: { driver: [-0.4, 1.15, 0.13], gunner: [0, 1.55, 1.05], 'front-passenger': [0.4, 1.15, 0.13], 'rear-left': [-0.45, 1.205, 1.25] },
  tank: { driver: [-0.64, 0.9, -1.3], commander: [0.6, 2.2, 0.4] },
  helicopter: { driver: [-0.36, 1.4, -0.95], gunner: [0.36, 1.4, -0.95] },
  transport: { driver: [-0.36, 1.4, -0.95], 'door-left': [-0.95, 1.35, 0.4], 'door-right': [0.95, 1.35, 0.4], 'rear-left': [-0.45, 1.4, 1.2], 'rear-right': [0.45, 1.4, 1.2] },
  plane: { driver: [0, 1.4, -1.17] },
};
/** Seats whose hip anchor rides the turret ring (rotates with turretYaw). */
const turretSeats = { tank: ['commander'] };
const seatLabels = { driver: 'DRIVER', pilot: 'PILOT', gunner: 'GUNNER', passenger: 'PASSENGER' };
const seatNames = { commander: 'COMMANDER', 'door-left': 'LEFT DOOR', 'door-right': 'RIGHT DOOR', 'front-passenger': 'PASSENGER',
  'rear-left': 'REAR LEFT', 'rear-right': 'REAR RIGHT' };
/**
 * Per-seat camera profile (WP6 reads it). optic = RMB zoom factor. `views` is
 * the V-key cycle (the first entry is the default): chase, action (a close,
 * low chase), cockpit (first person from the seat's eye), flyby (aircraft
 * cinematic), or the seat's own mount / gimbal / passenger camera. `eye` is
 * the first-person eye in the hull frame, the turret frame (eyeFrame:'turret')
 * or the seat's first mount (eyeFrame:'mount': right, up, back of the pivot
 * along the gun's yaw); without it the eye sits above the seat hip.
 */
const DRIVE_VIEWS = ['chase', 'action', 'cockpit'], FLY_VIEWS = ['chase', 'action', 'cockpit', 'flyby'];
const seatCameras = {
  jeep: { driver: { mode: 'chase', distance: 7, height: 2.6, views: DRIVE_VIEWS, eye: [-0.4, 1.8, 0.12] },
    gunner: { mode: 'mount', distance: 4.5, height: 1.6, optic: 1.5, views: ['mount', 'cockpit'], eye: [-0.45, 0.32, 0.45], eyeFrame: 'mount' },
    'front-passenger': { mode: 'passenger', distance: 6, height: 2.2, views: ['passenger', 'cockpit'], eye: [0.4, 1.8, 0.12] } },
  tank: { driver: { mode: 'chase', distance: 9.5, height: 3.4, optic: 3, views: DRIVE_VIEWS, eye: [0, 3.35, 0.3], eyeFrame: 'turret' },
    commander: { mode: 'mount', distance: 5, height: 1.4, optic: 1.5, views: ['mount', 'cockpit'], eye: [-0.35, 0.35, 0.5], eyeFrame: 'mount' } },
  helicopter: { driver: { mode: 'chase', distance: 13, height: 3.6, views: FLY_VIEWS },
    gunner: { mode: 'gimbal', distance: 0, height: 0, optic: 4, views: ['gimbal', 'cockpit'] } },
  transport: { driver: { mode: 'chase', distance: 15, height: 4.2, views: FLY_VIEWS },
    'door-left': { mode: 'mount', distance: 2.5, height: 0.9, optic: 1.5, views: ['mount', 'cockpit'], eye: [-0.25, 0.35, 0.65], eyeFrame: 'mount' },
    'door-right': { mode: 'mount', distance: 2.5, height: 0.9, optic: 1.5, views: ['mount', 'cockpit'], eye: [0.25, 0.35, 0.65], eyeFrame: 'mount' } },
  plane: { driver: { mode: 'chase', distance: 17, height: 4.4, views: FLY_VIEWS } },
};
const defaultCamera = { mode: 'passenger', distance: 6, height: 2.2, views: ['passenger', 'cockpit'] };

/**
 * Mount anchors in the hull frame (or the turret frame for frame:'turret').
 * pivot = yaw/pitch pivot, muzzle = barrel length beyond it. A mount with
 * fixed:true always fires along the hull's nose. yawLimit is relative to hull
 * yaw ([centre, halfRange]); null means 360 degrees. pitchLimit is relative
 * to the hull slope along the aim.
 */
const T = TANK_RULES;
const mountAnchors = {
  jeep: { pintle: { pivot: [0, 2.15, 0.75], muzzle: 1, yawLimit: null, pitchLimit: [-0.3, 0.75], yawRate: 3, pitchRate: 2.4 } },
  tank: {
    main: { frame: 'turret', pivot: [0, T.gunPivotHeight, -T.turretForward - T.gunPivotForward], muzzle: T.barrelLength,
      yawLimit: null, pitchLimit: [T.turretMinPitch, T.turretMaxPitch], yawRate: T.turretRate, pitchRate: T.turretPitchRate, turret: true },
    coax: { frame: 'turret', pivot: [0.38, T.gunPivotHeight - 0.06, -T.turretForward - T.gunPivotForward], muzzle: 1.25,
      yawLimit: null, pitchLimit: [T.turretMinPitch, T.turretMaxPitch], yawRate: T.turretRate, pitchRate: T.turretPitchRate, slavedTo: 'main' },
    rws: { frame: 'turret', pivot: [0.75, 2.75, 0.45], muzzle: 1.1, yawLimit: null, pitchLimit: [-0.35, 0.9], yawRate: 2.2, pitchRate: 1.6 },
  },
  helicopter: {
    pods: { fixed: true, sides: [[-1.235, 1.13, -0.742], [1.235, 1.13, -0.742]], pivot: [0, 1.13, -0.742], muzzle: 0, yawRate: 0, pitchRate: 0 },
    chin: { pivot: [0, 0.55, -2.4], muzzle: 0.9, yawLimit: [0, 1.9], pitchLimit: [-1.05, 0.17], yawRate: 2.2, pitchRate: 1.8, gimbal: true },
  },
  transport: {
    'door-left': { pivot: [-1.25, 1.55, 0.1], muzzle: 1, yawLimit: [Math.PI / 2, 1.4], pitchLimit: [-1, 0.5], yawRate: 3, pitchRate: 2.4, gimbal: true },
    'door-right': { pivot: [1.25, 1.55, 0.1], muzzle: 1, yawLimit: [-Math.PI / 2, 1.4], pitchLimit: [-1, 0.5], yawRate: 3, pitchRate: 2.4, gimbal: true },
  },
  plane: {
    nose: { fixed: true, pivot: [0, 1, -5.05], muzzle: 0, yawRate: 0, pitchRate: 0 },
    rails: { fixed: true, sides: [[-2.6, 0.7, 0.6], [2.6, 0.7, 0.6]], pivot: [0, 0.7, 0.6], muzzle: 0, yawRate: 0, pitchRate: 0 },
  },
};

/** Compound boxes [[lo],[hi]] for aircraft; ground hulls use one box. */
const HELICOPTER_BOXES = [
  [[-.9, .55, -3.1], [.9, 2.7, 1.4]],
  [[-.34, 1.15, 1.05], [.34, 2.15, 3.65]],
  [[-.9, 1.9, 2.45], [.9, 2.99, 3.68]],
  [[-1.5, .84, -1.15], [1.5, 1.45, .6]],
  [[-1.13, 0, -2.66], [1.13, .3, 1.68]],
  [[-.7, .7, -1.38], [.7, .86, .55]],
  [[-.25, 2.65, -.25], [.25, 3.2, .25]],
];
const PLANE_BOXES = [
  [[-.5, .86, -5.05], [.5, 1.5, -2.55]],
  [[-.87, .83, -2.55], [.87, 2.55, 1.65]],
  [[-.87, .86, 1.65], [.87, 1.65, 3.55]],
  [[-.64, .96, 3.55], [.64, 1.58, 4.65]],
  [[-4.5, 1.15, -.94], [4.5, 1.35, 2.08]],
  [[-1.95, 1.36, 2.56], [1.95, 1.5, 4.28]],
  [[-.09, 1.48, 1.82], [.09, 2.8, 4.22]],
  [[-1.16, 0, .79], [1.16, 1.14, 1.46]],
  [[-.15, 0, -2.98], [.15, 1.14, -2.38]],
  [[-3.7, .53, .09], [3.7, 1.2, 2.04]],
];

const handlingRules = {
  jeep: { ...JEEP_RULES, hp: 320, respawnSeconds: 15, enterDistance: 4 },
  tank: { ...TANK_RULES, hp: 1000, respawnSeconds: 30, enterDistance: 4.5 },
  helicopter: { ...HELICOPTER_RULES, hp: 650, respawnSeconds: 35, enterDistance: 5.5 },
  transport: { ...TRANSPORT_RULES, hp: 600, respawnSeconds: 35, enterDistance: 6 },
  plane: { ...PLANE_RULES, hp: 450, respawnSeconds: 40, enterDistance: 7.5 },
};
/**
 * openCrew: the hull is an open cab (jeep) or open cabin (transport doors), so a
 * round may pass its collider face and still strike exposed crew inside it.
 * Closed hulls stop every round at the face: a turned-out tank commander is
 * only hit where his body rises above the armour.
 */
const shapes = {
  jeep: { handling: 'wheeled', armor: 'light', openCrew: true, collider: { halfWidth: 1.15, halfLength: 2.12 } },
  tank: { handling: 'tracked', armor: 'heavy', openCrew: false, collider: { halfWidth: 1.95, halfLength: 2.6 } },
  helicopter: { handling: 'rotor', armor: 'air', openCrew: false, collider: { halfWidth: 1.5, halfLength: 3.5 }, hullBoxes: HELICOPTER_BOXES },
  transport: { handling: 'rotor', armor: 'air', openCrew: true, collider: { halfWidth: 1.5, halfLength: 3.5 }, hullBoxes: HELICOPTER_BOXES },
  plane: { handling: 'fixedwing', armor: 'air', openCrew: false, collider: { halfWidth: 4.5, halfLength: 5 }, hullBoxes: PLANE_BOXES, gearBoxes: [7, 8] },
};
/** Wreck blasts keep terrain intact so cover survives chain reactions. */
const destruction = {
  jeep: { radius: 7, damage: 150, damageFalloffExponent: 1.22 },
  tank: { radius: 9, damage: 220, damageFalloffExponent: 1.22 },
  helicopter: { radius: 9, damage: 180, damageFalloffExponent: 1.22 },
  transport: { radius: 9, damage: 190, damageFalloffExponent: 1.22 },
  plane: { radius: 10, damage: 200, damageFalloffExponent: 1.22 },
};

function buildDef(type) {
  const rules = handlingRules[type];
  const seats = VEHICLE_TOPOLOGY[type].map((seat, index) => ({
    id: seat.id, index, role: seat.role, drives: seat.drives, exposed: seat.exposed, personalWeapons: seat.personalWeapons,
    mounts: seat.mounts.map(m => m.id), weapons: seat.mounts.length > 0,
    position: seatHips[type][seat.id],
    mount: (turretSeats[type] || []).includes(seat.id) ? 'turret' : 'hull',
    label: seatNames[seat.id] ?? seatLabels[seat.role] ?? seat.role.toUpperCase(),
    camera: seatCameras[type]?.[seat.id] ?? defaultCamera,
  }));
  const mounts = {};
  for (const seat of VEHICLE_TOPOLOGY[type]) for (const [order, mount] of seat.mounts.entries()) {
    const key = `${seat.id}:${mount.id}`;
    mounts[mount.id] = { id: mount.id, key, seatId: seat.id, order, index: vehicleMountOrder(type).indexOf(key),
      weapons: [...mount.weapons], frame: 'hull', fixed: false, slavedTo: null, ...mountAnchors[type][mount.id] };
  }
  return {
    type, ...shapes[type], hp: rules.hp, respawnSeconds: rules.respawnSeconds, rules,
    height: rules.height, radius: rules.radius,
    countermeasure: COUNTERMEASURES[type] ?? null,
    seats, mounts, mountOrder: vehicleMountOrder(type),
    destruction: destruction[type],
  };
}

export const VEHICLE_DEFS = freeze(Object.fromEntries(VEHICLE_TYPE_IDS.map(type => [type, buildDef(type)])));
export const VEHICLE_HANDLING = freeze(Object.fromEntries(VEHICLE_TYPE_IDS.map(type => [type, VEHICLE_DEFS[type].handling])));
export const VEHICLE_RULES = freeze(Object.fromEntries(VEHICLE_TYPE_IDS.map(type => [type, VEHICLE_DEFS[type].rules])));

const typeOf = value => typeof value === 'object' && value !== null ? value.type ?? value.kind : value;
/** Definition for a type string or any row/hull carrying `type` (or legacy `kind`). */
export function vehicleDef(value) {
  const type = typeOf(value);
  return typeof type === 'string' && Object.hasOwn(VEHICLE_DEFS, type) ? VEHICLE_DEFS[type] : null;
}
export const isAircraftType = value => ['rotor', 'fixedwing'].includes(vehicleDef(value)?.handling);
/** Maximum hull points for a row, hull or type. */
export const vehicleMaxHp = value => vehicleDef(value)?.hp ?? 0;
export const vehicleSeatList = value => vehicleDef(value)?.seats ?? [];
export const vehicleDriverSeatOf = value => vehicleSeatList(value).find(seat => seat.drives) ?? null;
/** Weapon list a seat cycles through; contract order. */
export const vehicleSeatWeapons = (value, seatId) => seatWeaponList(typeOf(value), seatId);
export const vehicleWeapon = key => Object.hasOwn(VEHICLE_WEAPONS, key) ? VEHICLE_WEAPONS[key] : null;

/** Apply the renderer's YXZ attitude to a physical local attachment. */
export function vehicleLocalPoint(vehicle, x, y, z) {
  const yaw = finite(vehicle.yaw), pitch = finite(vehicle.pitch), roll = finite(vehicle.roll);
  const cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const rx = x * cr - y * sr, ry = x * sr + y * cr;
  const py = ry * cp - z * sp, pz = ry * sp + z * cp;
  return [finite(vehicle.x) + rx * cy + pz * sy, finite(vehicle.y) + py, finite(vehicle.z) - rx * sy + pz * cy];
}
/** Inverse of vehicleLocalPoint: a world point in the hull's local frame. */
export function vehicleWorldToLocal(vehicle, point) {
  const yaw = finite(vehicle.yaw), pitch = finite(vehicle.pitch), roll = finite(vehicle.roll);
  const cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const dx = point[0] - finite(vehicle.x), dy = point[1] - finite(vehicle.y), dz = point[2] - finite(vehicle.z);
  const rx = dx * cy - dz * sy, pz = dx * sy + dz * cy, py = dy;
  const ry = py * cp + pz * sp, z = -py * sp + pz * cp;
  return [rx * cr + ry * sr, -rx * sr + ry * cr, z];
}
/** World direction of a hull-local direction (attitude only). */
export function vehicleLocalDirection(vehicle, x, y, z) {
  const origin = vehicleLocalPoint({ ...vehicle, x: 0, y: 0, z: 0 }, 0, 0, 0);
  const point = vehicleLocalPoint({ ...vehicle, x: 0, y: 0, z: 0 }, x, y, z);
  return [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
}
export function vehicleDirection(yaw, pitch = 0) {
  yaw = finite(yaw); pitch = finite(pitch);
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
const normalize = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** Elevation of the hull's deck plane along a horizontal world yaw. */
export function hullSlopeAlong(vehicle, worldYaw) {
  if (!finite(vehicle.pitch) && !finite(vehicle.roll)) return 0;
  const forward = vehicleLocalDirection(vehicle, 0, 0, -1), right = vehicleLocalDirection(vehicle, 1, 0, 0);
  const d = [-Math.sin(worldYaw), -Math.cos(worldYaw)];
  const fh = Math.hypot(forward[0], forward[2]) || 1, rh = Math.hypot(right[0], right[2]) || 1;
  const along = (d[0] * forward[0] + d[1] * forward[2]) / fh, across = (d[0] * right[0] + d[1] * right[2]) / rh;
  return Math.atan(along * forward[1] / fh + across * right[1] / rh);
}

/** Mount aim state [yaw, pitch] from a server hull (objects) or a snapshot row (arrays). */
export function mountAim(vehicle, mountId) {
  const def = vehicleDef(vehicle), mount = def?.mounts[mountId];
  if (!mount) return null;
  if (mount.fixed) return { yaw: finite(vehicle.yaw), pitch: finite(vehicle.pitch) };
  if (mount.slavedTo) return mountAim(vehicle, mount.slavedTo);
  if (mount.turret && Number.isFinite(vehicle.turretYaw)) return { yaw: vehicle.turretYaw, pitch: finite(vehicle.turretPitch) };
  const state = vehicle.mounts?.[mount.index];
  if (Array.isArray(state)) return { yaw: finite(state[0], finite(vehicle.yaw)), pitch: finite(state[1]) };
  if (state && typeof state === 'object') return { yaw: finite(state.yaw, finite(vehicle.yaw)), pitch: finite(state.pitch) };
  const centre = mount.yawLimit ? mount.yawLimit[0] : 0;
  return { yaw: wrap(finite(vehicle.yaw) + centre), pitch: 0 };
}

/** Hull-local point of a turret-frame anchor at the current turret rotation. */
export function turretLocal(vehicle, [x, y, z]) {
  const relative = finite(vehicle.turretYaw, finite(vehicle.yaw)) - finite(vehicle.yaw), c = Math.cos(relative), s = Math.sin(relative);
  const pivotZ = -TANK_RULES.turretForward, localZ = z - pivotZ;
  return [x * c + localZ * s, y, -x * s + localZ * c + pivotZ];
}

/**
 * Physical muzzle pose of one mount: { origin, dir } in world space. `side`
 * (0/1) selects the left/right rail or pod; the pods converge at the
 * weapon's convergence distance ahead of the nose.
 */
export function mountPose(vehicle, seatId, mountId, { side = 0 } = {}) {
  const def = vehicleDef(vehicle), mount = def?.mounts[mountId];
  if (!mount || mount.seatId !== seatId) return null;
  const local = mount.sides ? mount.sides[side % mount.sides.length] : mount.pivot;
  const pivot = mount.frame === 'turret' ? turretLocal(vehicle, local) : local;
  const base = vehicleLocalPoint(vehicle, ...pivot);
  let dir;
  if (mount.fixed) {
    dir = normalize(vehicleLocalDirection(vehicle, 0, 0, -1));
    const convergence = vehicleWeapon(mount.weapons[0])?.convergence;
    if (convergence && mount.sides) {
      const nose = vehicleLocalPoint(vehicle, ...mount.pivot);
      dir = normalize([nose[0] + dir[0] * convergence - base[0], nose[1] + dir[1] * convergence - base[1], nose[2] + dir[2] * convergence - base[2]]);
    }
  } else {
    const aim = mountAim(vehicle, mountId);
    dir = vehicleDirection(aim.yaw, aim.pitch);
  }
  const length = finite(mount.muzzle);
  return { origin: [base[0] + dir[0] * length, base[1] + dir[1] * length, base[2] + dir[2] * length], dir, pivot: base };
}

/** Clamp a desired world aim into a mount's limits for the hull's current attitude. */
export function clampMountAim(vehicle, mountId, yaw, pitch) {
  const mount = vehicleDef(vehicle)?.mounts[mountId];
  if (!mount) return { yaw: finite(yaw), pitch: finite(pitch) };
  let outYaw = wrap(finite(yaw, finite(vehicle.yaw)));
  if (mount.yawLimit) {
    const centre = wrap(finite(vehicle.yaw) + mount.yawLimit[0]);
    outYaw = wrap(centre + clamp(wrap(outYaw - centre), -mount.yawLimit[1], mount.yawLimit[1]));
  }
  const limit = mount.pitchLimit ?? [-Math.PI / 2, Math.PI / 2];
  const slope = mount.gimbal ? finite(vehicle.pitch) : hullSlopeAlong(vehicle, outYaw);
  return { yaw: outYaw, pitch: clamp(finite(pitch), limit[0] + slope, limit[1] + slope) };
}

export { vehicleMountOrder, seatWeaponList };
