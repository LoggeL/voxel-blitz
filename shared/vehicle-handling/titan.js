/**
 * Titan walker handling (docs/titanfall.md §5.1). Shared by the authoritative
 * TitanSystem (server/sim/titans.js) and the client's own-titan prediction
 * (public/js/titanfall/titan-predict.js), so it is pure and import-free:
 * frames, TITAN_RULES, the per-type def inputs vehicle-defs.js builds titan
 * definitions from, `stepTitanWalk` and `placeWalker`.
 *
 * Frames: metres, hull-local +X right, +Y up, forward is -Z; yaw 0 faces -Z and
 * positive yaw turns toward -X (vehicleDirection). WP0 ships a basic walker;
 * WP2 owns and refines the bodies (the export names and shapes are frozen).
 */
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

const frame = (hp, walk, sprint, strafe, back, legTurn, dashSpeed, pips, pipRegen, mass, hw, hl, height, eye, backY) =>
  ({ hp, walk, sprint, strafe, back, legTurn, dash: { speed: dashSpeed, seconds: 0.28 }, pips, pipRegen, mass, hw, hl, height, eye, backY });

export const TITAN_RULES = deepFreeze({
  frames: {
    atlas: frame(2500, 4.6, 6.6, 4.2, 3.4, 2.6, 16, 2, 5.5, 30, 1.35, 1.1, 7.0, 5.6, 4.6),
    ogre: frame(3200, 4.0, 5.8, 3.6, 3.0, 2.2, 14, 2, 7, 38, 1.55, 1.25, 7.4, 5.9, 4.8),
    stryder: frame(2000, 5.2, 7.6, 4.8, 3.8, 3.0, 18, 3, 5, 24, 1.15, 0.95, 7.6, 6.1, 5.0),
  },
  shieldMaxFrac: 0.35, dropShieldFrac: 0.25, batteryShieldFrac: 0.35,
  shieldDelay: 0, shieldRegen: 0,                // shields do not regen in Attrition
  doomPoolFrac: 0.2, doomSeconds: 7, ejectVyMax: 38, ejectCloak: 1.5,
  maxStep: 1.05, maxSlope: 0.75, accel: 18, decel: 22, gravity: 24,
  pitch: [-1.15, 0.7],                           // driver and mount pitch (blind spot < 2.5 m)
  legTwistLimit: 0.35,                           // legs/pelvis lag hull yaw by at most this (rig + auto-titan)
  melee: { damage: 200, infantryDamage: 150, range: 4.5, cooldown: 1.3 },
  smoke: { charges: 2, radius: 7, seconds: 6, riderDps: 250, pilotDps: 60, batteryRecharge: 1 },
  embark: { distance: 6, holdMs: 300, animMs: 1200 }, disembarkMs: 600,
  drop: { range: 160, markerMs: 2200, fallMs: 800, skyClearVoxels: 12, spawnClear: 30, spawnAvoid: 35,
    crushDamage: 1500, crushKey: 'titanfall' },
  crush: { minSpeed: 1.5, key: 'titan_crush' },  // walker leg-box crush
  fluid: { wallDepth: 2, lavaDps: 120 },
  auto: { range: 70, losIntervalMs: 200, aimNoise: 0.04, smokeAfterRiderMs: 1500 },
  rodeo: { reach: 2.2, ripMs: 1400, ripFrac: 0.15, insertMs: 1000, hatchMul: 4, hatchDpsCap: 150, maxEnemyRiders: 1,
    // Contact mount (rodeo feel pass, rodeoContact): body-to-upper-hull gap, upper hull floor above the feet of the hull,
    // grapple hook gap to the whole hull, hook memory after the rope lets go, no re-grab of the same hull after a
    // dismount / push-off, roof band.
    contact: 1.5, upperY: 2.5, hookReach: 2.6, hookMs: 400, remountMs: 900, pushMs: 700, topBand: 0.35 },
  battery: { pickupRadius: 1.6, lifeMs: 30000, max: 12 },
  meter: { passive: 0.009, pilotKill: 0.10, pilotDamagePerHp: 0.0005, titanDamagePerHp: 0.00008, titanKill: 0.15 },
  /** Ground probe below the feet per walker step before the hull counts as unsupported (falls). */
  fallProbe: 4,
  /** Half baseline (m) of the walkerSlope gradient probe a climbing step must keep under maxSlope. */
  slopeProbe: 1.5,
  /**
   * Walker voxel ram (server only, VehicleSystem.ramVoxels shape): a blocked
   * walking titan breaks light voxels (brush, wood, thin siding) at walking
   * speed, never masonry or terrain; a landing breaks them at the fall speed.
   */
  ram: { classes: { brush: 1, wood: 2, thin: 3 }, armor: 55, perTick: 6, burst: 24, refill: 12, pushForce: 0, maxPushMass: 0 },
  /** Landing: the whole light volume under the hull goes at once (no per-tick cap). */
  dropRam: { classes: { brush: 1, wood: 2, thin: 3 }, armor: 55, perTick: 256, burst: 256, refill: 0, pushForce: 0, maxPushMass: 0 },
  dropRamSpeed: 40,
});

const TYPE_CHASSIS = Object.freeze({ titan_ion: 'atlas', titan_scorch: 'ogre', titan_northstar: 'stryder', titan_ronin: 'stryder', titan_legion: 'ogre' });
/** Frame of a hull or type (chassis lookup by type). */
export function titanFrame(value, rules = TITAN_RULES) {
  const type = typeof value === 'string' ? value : value?.type;
  return rules.frames[TYPE_CHASSIS[type]] ?? null;
}

/**
 * Battery insert reach (playability pass): a friendly carrier inserts from the ground right
 * behind the hull. The chest-to-back-anchor gap ignores up to `BATTERY_INSERT_DROP` m of the
 * carrier's chest sitting below the anchor (a chest on the ground is 3.4..3.8 m under it), so
 * standing behind the titan is in `rodeo.reach`; the rodeo mount keeps the plain distance.
 * `dx, dy, dz` = carrier chest minus back anchor.
 */
export const BATTERY_INSERT_DROP = 4;
export function batteryInsertGap(dx, dy, dz) {
  const vertical = dy < 0 ? Math.min(0, dy + BATTERY_INSERT_DROP) : dy;
  return Math.hypot(dx, vertical, dz);
}

/** Pilot body box (PHYSICS.halfW, PHYSICS.height) and gravity; this module stays import-free. */
const RODEO_BODY = Object.freeze({ halfW: 0.32, height: 1.9, gravity: 24 });
const boxGap = (lo, hi, a, b) => Math.max(0, lo - b, a - hi);

/**
 * Rodeo contact (docs/titanfall.md §5.2 Mount, rodeo feel pass): the gap between a
 * pilot's body box (feet `body` = {x, y, z}) and a titan's upper hull box
 * (hull-local |x| ≤ hw, |z| ≤ hl, from `rodeo.upperY` above the hull's feet to its
 * top), `hookGap` to the whole hull box, and the zone of approach: 'top' (feet
 * within `topBand` of the top or above), 'front' (ahead of the front face, the
 * cockpit side), 'back' (behind the rear face) or 'side'. Null for a non-titan.
 */
export function rodeoContact(body, hull, rules = TITAN_RULES) {
  const f = titanFrame(hull, rules);
  if (!f || ![body?.x, body?.y, body?.z, hull?.x, hull?.y, hull?.z].every(Number.isFinite)) return null;
  const R = rules.rodeo, { halfW, height } = RODEO_BODY;
  const yaw = finite(hull.yaw), c = Math.cos(yaw), s = Math.sin(yaw), dx = body.x - hull.x, dz = body.z - hull.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c, feet = body.y - hull.y;
  const gx = boxGap(-f.hw, f.hw, lx - halfW, lx + halfW), gz = boxGap(-f.hl, f.hl, lz - halfW, lz + halfW);
  const gap = Math.hypot(gx, boxGap(R.upperY, f.height, feet, feet + height), gz);
  const hookGap = Math.hypot(gx, boxGap(0, f.height, feet, feet + height), gz);
  // Sector from the hull centre in footprint-normalised axes (a body under the cockpit overhang is still in front).
  const across = Math.abs(lx) / f.hw, along = lz / f.hl;
  const zone = feet >= f.height - R.topBand ? 'top' : -along > across ? 'front' : along > across ? 'back' : 'side';
  return { gap, hookGap, zone, lx, lz, feet };
}

/**
 * True when a contact mounts: back, side or top within `rodeo.contact` of the upper
 * hull (never across the front face below the top), or, `hooked` by a grapple on
 * this hull, within `rodeo.hookReach` of any part of it.
 */
export function rodeoContactMounts(contact, hooked = false, rules = TITAN_RULES) {
  if (!contact) return false;
  if (hooked && contact.hookGap <= rules.rodeo.hookReach) return true;
  return contact.zone !== 'front' && contact.gap <= rules.rodeo.contact;
}

/**
 * True when a jump now (vertical speed `vy`) carries a pilot into a mounting contact:
 * the ballistic arc from feet `body` with horizontal velocity `vel` = [vx, vz]
 * relative to a hull moving at `hullVel` = [vx, vz], sampled every 1/30 s until
 * the feet are `minRise` under the take-off height (at most `seconds`). Hull collision is
 * ignored, except that an arc into the plates without a grab (the front) ends there.
 */
export function rodeoArcMounts(body, vel, hull, hullVel = null, vy = 8.2, rules = TITAN_RULES, seconds = 1.2, minRise = 0) {
  if (!body || !hull) return false;
  const rvx = finite(vel?.[0]) - finite(hullVel?.[0]), rvz = finite(vel?.[1]) - finite(hullVel?.[1]);
  const at = { x: 0, y: 0, z: 0 }, step = 1 / 30;
  for (let t = 0; t <= seconds + 1e-9; t += step) {
    const rise = vy * t - 0.5 * RODEO_BODY.gravity * t * t;
    if (t > 0 && rise < minRise) return false;
    at.x = body.x + rvx * t; at.y = body.y + rise; at.z = body.z + rvz * t;
    const contact = rodeoContact(at, hull, rules);
    if (rodeoContactMounts(contact, false, rules)) return true;
    if (contact && contact.hookGap === 0) return false;   // into the plates without a grab (the front): it bounces off
  }
  return false;
}

/**
 * The hull movement-modifier block (§5.5, frozen): written only by
 * titan-abilities.js (WP3), read only by stepTitanWalk (WP2).
 */
export function createTitanMove() {
  return { speedMul: 1, hoverVy: null, rooted: false, phasedUntil: 0, pipRefill: false, damageTakenMul: 1 };
}

/** Hull-local boxes [[lo],[hi]]: legs (2), pelvis, torso, cockpit hatch (front), battery hatch (rear), head. */
function hullBoxes({ hw, hl, height: h }) {
  return [
    [[-hw, 0, -hl * 0.5], [-hw * 0.2, h * 0.46, hl * 0.5]],
    [[hw * 0.2, 0, -hl * 0.5], [hw, h * 0.46, hl * 0.5]],
    [[-hw * 0.85, h * 0.42, -hl * 0.65], [hw * 0.85, h * 0.56, hl * 0.65]],
    [[-hw, h * 0.56, -hl * 0.85], [hw, h * 0.9, hl * 0.85]],
    [[-hw * 0.6, h * 0.62, -hl], [hw * 0.6, h * 0.88, -hl * 0.85]],
    [[-hw * 0.45, h * 0.6, hl * 0.85], [hw * 0.45, h * 0.8, hl]],
    [[-hw * 0.4, h * 0.9, -hl * 0.45], [hw * 0.4, h, hl * 0.45]],
  ];
}
/** Primary mount on the right arm; the existing clampMountAim handles the ±0.35 rad twist. */
const primaryMount = ({ hw, height: h }, muzzle) => ({ pivot: [hw + 0.3, h * 0.6, -0.35], muzzle,
  yawLimit: [0, 0.35], pitchLimit: [-1.15, 0.7], yawRate: 8, pitchRate: 6 });
const MOUNT_MUZZLE = Object.freeze({ splitter: 2.2, t203: 2.0, railgun: 2.8, leadwall: 1.9, predator: 2.4 });
const PRIMARY_MOUNT = Object.freeze({ titan_ion: 'splitter', titan_scorch: 't203', titan_northstar: 'railgun', titan_ronin: 'leadwall', titan_legion: 'predator' });

function defInput(type) {
  const chassis = TYPE_CHASSIS[type], f = TITAN_RULES.frames[chassis], mount = PRIMARY_MOUNT[type];
  return {
    type, chassis, mass: f.mass,
    rules: { hp: f.hp, respawnSeconds: Infinity, enterDistance: 6, height: f.height, radius: Math.hypot(f.hw, f.hl),
      gravity: TITAN_RULES.gravity, seatHeight: f.eye - 0.6, ceiling: 80, maxStep: TITAN_RULES.maxStep, maxSlope: TITAN_RULES.maxSlope,
      chassis, eye: f.eye, backAnchor: [0, f.backY, f.hl + 0.3] },
    collider: { halfWidth: f.hw, halfLength: f.hl },
    hullBoxes: hullBoxes(f),
    seatHip: [0, f.eye - 1.62, -f.hl * 0.3],
    camera: { mode: 'chase', distance: 9, height: 3, views: ['cockpit', 'chase'], eye: [0, f.eye, -f.hl * 0.55], eyeFrame: 'hull' },
    mountAnchors: { [mount]: primaryMount(f, MOUNT_MUZZLE[mount]) },
    destruction: { radius: 6, damage: 120, damageFalloffExponent: 1.5 },
  };
}
/** Per-type inputs for vehicle-defs.js buildDef's titan branch (§2.5). */
export const TITAN_DEFS_INPUT = deepFreeze(Object.fromEntries(Object.keys(TYPE_CHASSIS).map(type => [type, defInput(type)])));

// ---- placement ------------------------------------------------------------------

/**
 * Support height for the hull standing at (x, z) at its current yaw, starting
 * from its current feet `v.y`: the highest ground under the footprint within
 * `maxStep` above the feet (a step-up) or down to `fallProbe` below them.
 * Returns null where the hull cannot stand (a wall or a step above maxStep, a
 * voxel inside the body, fluid deeper than fluid.wallDepth, outside the play
 * bounds) and -Infinity over a hole deeper than the probe (the hull falls).
 * Deep fluid is a wall however far below the feet its surface lies (a hole
 * over a river is not a way in); a hull that is already in deep fluid (fell
 * in: its feet are under the surface at its centre) wades until it is out.
 *
 * world = { solidAt(bx, by, bz) -> bool (integer voxel coords), fluidAt?(bx, by, bz) -> bool,
 *           bounds?: { minX, maxX, minZ, maxZ }, ceiling?: number (map height), revision?: any }
 */
export function placeWalker(v, x, z, world, rules = TITAN_RULES) {
  return probeWalker(v, x, z, world, rules, true);
}

/** True when `wallDepth` fluid voxels stand from the feet up in the column under (x, z). */
function inDeepFluid(fluid, x, z, feet, deep) {
  const bx = Math.floor(x), bz = Math.floor(z), by = Math.floor(feet + 0.05);
  for (let k = 0; k < deep; k++) if (!fluid(bx, by + k, bz)) return false;
  return true;
}

/**
 * placeWalker's body. `strict` false is the fallback for a hull whose own spot
 * has no stance (deep fluid under a falling hull, a voxel built into the
 * body): only the ground under the footprint, so it settles or falls instead
 * of hanging where it is.
 */
function probeWalker(v, x, z, world, rules, strict) {
  const f = titanFrame(v, rules);
  if (!f || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(v.y)) return null;
  const yaw = finite(v.yaw), c = Math.cos(yaw), s = Math.sin(yaw), ac = Math.abs(c), as = Math.abs(s);
  const ex = f.hw * ac + f.hl * as, ez = f.hw * as + f.hl * ac;
  const b = world.bounds;
  if (strict && b && (x - ex < b.minX || x + ex > b.maxX || z - ez < b.minZ || z + ez > b.maxZ)) return null;
  const solid = world.solidAt, axisPad = 0.5 * (ac + as) - 1e-9;
  const x0 = Math.floor(x - ex), x1 = Math.ceil(x + ex), z0 = Math.floor(z - ez), z1 = Math.ceil(z + ez);
  const top = Math.floor(v.y + rules.maxStep - 0.001), bottom = Math.floor(v.y - rules.fallProbe);
  const deep = rules.fluid.wallDepth;
  const fluid = strict && world.fluidAt && !inDeepFluid(world.fluidAt, finite(v.x, x), finite(v.z, z), v.y, deep) ? world.fluidAt : null;
  let support = -Infinity;
  for (let bx = x0; bx < x1; bx++) for (let bz = z0; bz < z1; bz++) {
    const dx = bx + 0.5 - x, dz = bz + 0.5 - z;
    // Exact separating-axis overlap of the unit cell with the oriented footprint.
    if (Math.abs(dx * c - dz * s) >= f.hw + axisPad || Math.abs(dx * s + dz * c) >= f.hl + axisPad) continue;
    // Down from the step-up height: the first solid voxel within the probe is
    // the column's ground. With a fluid probe the scan goes on below the probe
    // until something other than air: wallDepth stacked fluid voxels on the
    // way are a wall (§5.1), wherever the surface is.
    for (let by = top, run = 0; by >= 0; by--) {
      if (solid(bx, by, bz)) { if (by >= bottom && by + 1 > support) support = by + 1; break; }
      if (!fluid) { if (by <= bottom) break; continue; }
      if (fluid(bx, by, bz)) { if (++run >= deep) return null; } else if (run > 0) break;
    }
  }
  if (!strict) return support;
  if (support > v.y + rules.maxStep + 1e-6) return null;
  const base = Number.isFinite(support) ? support : v.y;
  const ceiling = world.ceiling;
  if (Number.isFinite(ceiling) && base + f.height > ceiling + 4) return null;
  const y0 = Math.floor(base + 0.03), y1 = Math.floor(base + f.height - 0.01);
  for (let bx = x0; bx < x1; bx++) for (let bz = z0; bz < z1; bz++) {
    const dx = bx + 0.5 - x, dz = bz + 0.5 - z;
    if (Math.abs(dx * c - dz * s) >= f.hw + axisPad || Math.abs(dx * s + dz * c) >= f.hl + axisPad) continue;
    for (let by = Math.max(0, y0); by <= y1; by++) if (solid(bx, by, bz)) return null;
  }
  return support;
}

/** Ground height (top solid voxel + 1) of one column between `fromY + rise` and `fromY - fall`, or null. */
function columnGround(world, x, z, fromY, rise, fall) {
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let by = Math.floor(fromY + rise - 0.001), bottom = Math.floor(fromY - fall); by >= bottom && by >= 0; by--) {
    if (world.solidAt(bx, by, bz)) return by + 1;
  }
  return null;
}

/**
 * Terrain gradient (rise over run) along the unit direction (dx, dz) through
 * (x, z): the ground `slopeProbe` metres ahead minus the ground as far behind,
 * over twice that distance. A single curb under a long footprint reads low; a
 * one-voxel-per-metre staircase reads 1. Null where a probe finds no ground.
 */
export function walkerSlope(v, x, z, dx, dz, world, rules = TITAN_RULES) {
  const reach = rules.slopeProbe ?? 1.5, rise = 3 * rules.maxStep;
  const ahead = columnGround(world, x + dx * reach, z + dz * reach, v.y, rise, rules.fallProbe);
  const behind = columnGround(world, x - dx * reach, z - dz * reach, v.y, rise, rules.fallProbe);
  return ahead === null || behind === null ? null : (ahead - behind) / (2 * reach);
}

// ---- walking --------------------------------------------------------------------

const NEUTRAL_MOVE = Object.freeze(createTitanMove());

/**
 * Try a horizontal destination; on success move there and return its support,
 * else null. A climbing move (support above the feet) is refused where the
 * terrain gradient along the move exceeds maxSlope.
 */
function tryMove(v, x, z, world, rules) {
  const support = placeWalker(v, x, z, world, rules);
  if (support === null) return null;
  if (support > v.y + 1e-3) {
    const dx = x - v.x, dz = z - v.z, len = Math.hypot(dx, dz);
    if (len > 1e-9) {
      const slope = walkerSlope(v, x, z, dx / len, dz / len, world, rules);
      if (slope !== null && slope > rules.maxSlope) return null;
    }
  }
  v.x = x; v.z = z;
  return support;
}

/**
 * One walker step. controls = { fwd, side (-1..1), aimYaw, aimPitch, sprint, dash, piloted }.
 * A piloted hull turns 1:1 with aimYaw; an auto-titan turns at the leg rate.
 * Reads `v.tfMove`; writes x, y, z, yaw, legYaw, vx, vy, vz, speed, grounded,
 * dash (pips), dashT, dashX, dashZ, walkRest. No allocations.
 */
export function stepTitanWalk(v, controls, dt, world, rules = TITAN_RULES) {
  const f = titanFrame(v, rules);
  dt = clamp(finite(dt), 0, 0.1);
  if (!f || !(dt > 0)) return v;
  const mv = v.tfMove || NEUTRAL_MOVE;
  const fwd = mv.rooted ? 0 : clamp(finite(controls?.fwd), -1, 1), side = mv.rooted ? 0 : clamp(finite(controls?.side), -1, 1);
  const oldYaw = finite(v.yaw);
  // Turning: 1:1 for a pilot, leg rate for an auto-titan; legs chase the hull.
  if (Number.isFinite(controls?.aimYaw)) {
    if (controls.piloted) v.yaw = wrap(controls.aimYaw);
    else { const turn = f.legTurn * dt; v.yaw = wrap(oldYaw + clamp(wrap(controls.aimYaw - oldYaw), -turn, turn)); }
  }
  if (v.yaw !== oldYaw && placeWalker(v, v.x, v.z, world, rules) === null) v.yaw = oldYaw;
  const legYaw = finite(v.legYaw, v.yaw), legTurn = f.legTurn * dt;
  let nextLeg = wrap(legYaw + clamp(wrap(v.yaw - legYaw), -legTurn, legTurn));
  const twist = wrap(v.yaw - nextLeg);
  if (Math.abs(twist) > rules.legTwistLimit) nextLeg = wrap(v.yaw - Math.sign(twist) * rules.legTwistLimit);
  v.legYaw = nextLeg;
  // Dash pips regenerate one pip per pipRegen seconds.
  v.dash = mv.pipRefill ? f.pips : Math.min(f.pips, finite(v.dash, f.pips) + dt / f.pipRegen);
  // Wish velocity in hull space: walk/sprint forward, back, strafe.
  const forwardSpeed = fwd > 0 ? (controls?.sprint && side === 0 ? f.sprint : f.walk) : f.back;
  let tf = fwd * forwardSpeed, ts = side * f.strafe;
  const mag = Math.hypot(tf, ts), cap = Math.max(Math.abs(tf), Math.abs(ts));
  if (mag > 1e-9) { const k = cap / mag * finite(mv.speedMul, 1); tf *= k; ts *= k; }
  const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
  const wishX = -sy * tf + cy * ts, wishZ = -cy * tf - sy * ts;
  const wishing = Math.abs(wishX) + Math.abs(wishZ) > 1e-9;
  let vx = finite(v.vx), vz = finite(v.vz);
  if (controls?.dash && v.dash >= 1 && !(v.dashT > 0) && v.grounded !== false && !mv.rooted) {
    v.dash -= 1; v.dashT = f.dash.seconds;
    const len = Math.hypot(wishX, wishZ);
    v.dashX = len > 1e-9 ? wishX / len : -sy; v.dashZ = len > 1e-9 ? wishZ / len : -cy;
  }
  if (v.dashT > 0) {
    vx = v.dashX * f.dash.speed; vz = v.dashZ * f.dash.speed;
    v.dashT = Math.max(0, v.dashT - dt);
  } else {
    // Accelerate toward the wish; brake (and blend back out of a dash) at the decel rate.
    const over = vx * vx + vz * vz > wishX * wishX + wishZ * wishZ + 1e-9;
    const dx = wishX - vx, dz = wishZ - vz, gap = Math.hypot(dx, dz), step = (wishing && !over ? rules.accel : rules.decel) * dt;
    if (gap <= step) { vx = wishX; vz = wishZ; } else { vx += dx / gap * step; vz += dz / gap * step; }
  }
  // At rest on unchanged terrain the probes would repeat their last answer.
  const resting = Math.abs(vx) < 1e-6 && Math.abs(vz) < 1e-6 && v.grounded === true && mv.hoverVy == null
    && v.yaw === oldYaw && world.revision !== undefined && v.walkRest === world.revision;
  if (resting) { v.vx = 0; v.vz = 0; v.vy = 0; v.speed = 0; return v; }
  // Horizontal move with step-up, then axis-separated wall slides.
  let support = null;
  const nx = v.x + vx * dt, nz = v.z + vz * dt;
  if (nx !== v.x || nz !== v.z) {
    support = tryMove(v, nx, nz, world, rules);
    if (support === null) {
      support = tryMove(v, nx, v.z, world, rules);
      if (support !== null) vz = 0;
      else { support = tryMove(v, v.x, nz, world, rules); if (support !== null) vx = 0; else { vx = 0; vz = 0; } }
    }
  }
  if (support === null) support = placeWalker(v, v.x, v.z, world, rules);
  // No stance on its own spot (deep fluid under a falling hull, a voxel built
  // into the body): settle on, or fall to, the ground under the footprint.
  if (support === null) support = probeWalker(v, v.x, v.z, world, rules, false);
  // Vertical: step up at once, fall under gravity (or hover) onto the support.
  let vy = finite(v.vy);
  if (mv.hoverVy != null) {
    vy = mv.hoverVy;
    v.y += vy * dt;
    if (Number.isFinite(world.ceiling)) v.y = Math.min(v.y, world.ceiling - f.height);
    if (v.y <= support) { v.y = support; vy = 0; v.grounded = true; } else v.grounded = false;
  } else if (support >= v.y - 1e-6) {
    v.y = support; vy = 0; v.grounded = true;
  } else {
    vy = Math.max(-60, vy - rules.gravity * dt);
    v.y += vy * dt;
    if (v.y <= support) { v.y = support; vy = 0; v.grounded = true; } else v.grounded = false;
    if (v.y < 0) { v.y = 0; vy = 0; v.grounded = true; }
  }
  v.vx = vx; v.vy = vy; v.vz = vz;
  v.speed = Math.hypot(vx, vz);
  v.walkRest = v.grounded && v.speed < 1e-6 ? world.revision : undefined;
  return v;
}
