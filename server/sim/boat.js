// River patrol boat on the server (docs/conquest.md, Patrol boat). VehicleSystem
// dispatches every hull whose def.handling is 'boat' here: support on the
// water surface instead of the bed, the waterjet drive (shared/vehicle-
// handling/boat.js), the presentation attitude, exits into the water and the
// sinking wreck. Collisions reuse the ground hull's helpers (clearHull,
// wallSlide, hullCrash, resolveInfantry), so a boat meets banks, piers,
// islands, other hulls and swimmers exactly like a jeep meets walls.
import { MC_WATER } from '../../shared/world/blocks.js';
import { hullFootprint, footprintCells } from '../../shared/vehicle-collision.js';
import { VEHICLE_RULES, vehicleDirection } from '../../shared/vehicles.js';
import { VEHICLE_DAMAGE_RULES, WALL_CRASH_RULES, vehicleDef } from '../../shared/vehicle-defs.js';
import { stepBoatDrive, boatAttitude } from '../../shared/vehicle-handling/boat.js';
import { PHYSICS } from '../../shared/player-movement.js';
import { upgradeScale } from '../../shared/vehicle-upgrades.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
/** A swimmer leaving a boat in open water: feet this far under the surface (body centre in the water). */
export const BOAT_SWIM_EXIT_DEPTH = 1.2;

/** Top face of the highest water voxel of column (x, z) within reach of `around`, or null. */
export function waterSurfaceAt(world, x, z, around, up = 1.5, down = 2.5) {
  const bx = Math.floor(x), bz = Math.floor(z), d = world.dimensions;
  if (d && (bx < 0 || bz < 0 || bx >= d.sx || bz >= d.sz)) return null;
  const top = Math.min(d ? d.sy - 1 : Infinity, Math.floor(around + up)), bottom = Math.max(0, Math.floor(around - down));
  for (let y = top; y >= bottom; y--) if (world.getBlock(bx, y, bz) === MC_WATER) return y + 1;
  return null;
}

/**
 * Support of a boat footprint at (x, z): every cell's water surface and
 * solid top within the step reach. A live hull floats `draft` under the
 * highest water surface and rides up onto ground that lifts it (a ford bed,
 * the first flush bank row); ground more than `maxStep` above the hull blocks
 * it. `aground` is the share of cells whose ground lifts the hull, `wet` the
 * share of the stern third that has water under it and is not aground (the
 * waterjet's intake), `shallow` the share afloat over less than `shallowDepth`
 * of water (a ford). A wreck ignores the water and rests on the bed.
 */
export function boatSupport(system, v, x, z, yaw = v.yaw) {
  const rules = VEHICLE_RULES[v.type], world = system.engine.world, hull = hullFootprint(v.type, x, z, yaw);
  const cells = footprintCells(hull), live = v.hp > 0;
  const back = [hull.axes[1][0], hull.axes[1][1]];
  let surface = -Infinity, ground = -Infinity;
  const grounds = new Array(cells.length >> 1), sterns = new Array(cells.length >> 1), waters = new Array(cells.length >> 1);
  for (let i = 0, k = 0; i < cells.length; i += 2, k++) {
    const cx = cells[i] + 0.5, cz = cells[i + 1] + 0.5;
    const water = live ? waterSurfaceAt(world, cx, cz, v.y + rules.draft) : null;
    const g = system.ground(cx, cz, v.y, rules.maxStep, live ? 3 : 8);
    waters[k] = water; grounds[k] = g;
    sterns[k] = (cx - x) * back[0] + (cz - z) * back[1] > hull.halfLength / 3;
    if (water != null) surface = Math.max(surface, water);
    if (g != null) ground = Math.max(ground, g);
  }
  const float = surface > -Infinity ? surface - rules.draft : -Infinity;
  const y = Math.max(float, ground);
  if (!(y > -Infinity) || y - v.y > rules.maxStep) return null;
  let aground = 0, wet = 0, stern = 0, shallow = 0;
  for (let k = 0; k < grounds.length; k++) {
    const lifted = grounds[k] != null && grounds[k] >= y - 0.02;
    if (lifted) aground++;
    else if (waters[k] != null && grounds[k] != null && waters[k] - grounds[k] < rules.shallowDepth) shallow++;
    if (sterns[k]) { stern++; if (waters[k] != null && !lifted) wet++; }
  }
  const n = grounds.length;
  return { y, float: float > -Infinity ? float : null, aground: n ? aground / n : 1, wet: stern ? wet / stern : 0, shallow: n ? shallow / n : 0 };
}

/** VehicleSystem.placement for a boat: the support height when the hull pose there is clear, else null. */
export function boatPlacement(system, v, x, z) {
  const support = boatSupport(system, v, x, z);
  if (!support || !system.clearHull(v, x, support.y, z)) return null;
  return support.y;
}

/**
 * One substep of a live boat: drive, move along its course, collide like a
 * ground hull (a crash above max(8, 0.55 × top speed) costs up to
 * WALL_CRASH_RULES.boat of the hull, once per crashSeconds), settle onto the water and push swimmers.
 */
export function advanceBoat(system, v, p, controls, dt) {
  const def = VEHICLE_RULES[v.type], driver = system.momentumDriver(v);
  const previous = { x: v.x, y: v.y, z: v.z, yaw: v.yaw };
  // A crewless boat at rest on still water sleeps until terrain or a body changes.
  if (!p && controls.throttle === 0 && v.speed === 0 && v.yawRate === 0 && v.boatRest === (system.engine.blockRevision ?? 0)
    && !system.fallSpeeds.has(v.id) && !system.infantryNear(v)) return;
  const here = boatSupport(system, v, v.x, v.z) ?? { wet: 0, aground: 1, shallow: 0 };
  const drive = v.disabled ? VEHICLE_DAMAGE_RULES.disabledDrive : 1;
  // A waterjet upgrade on the driver's hull (shared/vehicle-upgrades.js) raises the top speed and the acceleration.
  stepBoatDrive(v, { throttle: controls.throttle * drive, steer: controls.steer, brake: controls.brake }, dt, here,
    { speed: upgradeScale(v, 'speed'), acceleration: upgradeScale(v, 'acceleration') });
  v.boatWet = here.wet; v.boatAground = here.aground; v.boatShallow = here.shallow;
  if (!system.clearHull(v, v.x, v.y, v.z)) { v.yaw = previous.yaw; v.course = previous.yaw; v.yawRate = 0; }
  const course = vehicleDirection(v.course ?? v.yaw), x = v.x + course[0] * v.speed * dt, z = v.z + course[2] * v.speed * dt;
  const floor = Math.abs(v.speed) * dt > 1e-9 ? boatPlacement(system, v, x, z) : null;
  if (floor != null) {
    Object.assign(v, { x, z });
    v.y = system.settle(v, floor, dt);
    v.scraping = false;
  } else if (Math.abs(v.speed) * dt > 1e-9) {
    const travel = Math.abs(v.speed) * dt, impact = Math.abs(v.speed), threshold = Math.max(8, def.speed * 0.55);
    const crash = WALL_CRASH_RULES[v.type], crashHp = def.hp * (crash?.maxShare ?? 1);
    // One bank strike per `crashSeconds`: a hull glancing off and back into the same bank pays once.
    const ready = !(system.contactClock - (v.boatCrashAt ?? -Infinity) < (crash?.crashSeconds ?? 0));
    const strike = share => { if (!ready || !(share > 0)) return; v.boatCrashAt = system.contactClock; system.damage(v.id, crashHp * share, null, { cls: 'collision', impactVelocity: velocity }); };
    const hullHit = system.hullCrash(v, x, z, course, driver);
    const slide = system.wallSlide(v, x, z);
    const velocity = { vx: course[0] * impact, vy: 0, vz: course[2] * impact };
    if (slide) {
      const normal = Math.sqrt(Math.max(0, 1 - (slide.length / travel) ** 2)), normalImpact = impact * normal;
      Object.assign(v, { x: slide.x, z: slide.z });
      v.y = system.settle(v, slide.floor, dt);
      if (!hullHit && !v.scraping && normalImpact > threshold) strike(clamp((normalImpact - threshold) / (def.speed - threshold), 0, 1));
      v.speed *= Math.exp(-1.6 * normal * dt);
      v.scraping = true;
    } else {
      const rebound = !hullHit && impact > threshold ? -v.speed * (crash?.bounce ?? 0) : 0;
      if (!hullHit && impact > threshold && !v.scraping) strike(clamp((impact - threshold) / (def.speed - threshold), 0, 1));
      v.speed = rebound; v.course = v.yaw;
      v.scraping = false;
      v.y = system.settle(v, boatPlacement(system, v, v.x, v.z), dt);
    }
  } else {
    v.y = system.settle(v, boatPlacement(system, v, v.x, v.z), dt);
  }
  if (!(v.hp > 0)) return;
  if (!system.resolveInfantry(v, previous, driver, dt)) {
    Object.assign(v, previous);
    v.speed = 0; v.yawRate = 0; v.course = v.yaw;
    system.fallSpeeds.delete(v.id);
  }
  Object.assign(v, { vx: (v.x - previous.x) / dt, vy: (v.y - previous.y) / dt, vz: (v.z - previous.z) / dt });
  if (v.disabled && Math.abs(controls.throttle) > 0.1 && Math.hypot(v.x - previous.x, v.z - previous.z) < 0.02 * dt) v.stuckFor += dt;
  else v.stuckFor = 0;
  const resting = !p && v.speed === 0 && v.yawRate === 0 && v.x === previous.x && v.z === previous.z && v.y === previous.y;
  v.boatRest = resting ? (system.engine.blockRevision ?? 0) : null;
}

/** Published attitude of a live boat (presentation only, clamped: it never capsizes). */
export function updateBoatAttitude(system, v, dt) {
  const accel = dt > 0 ? (finite(v.speed) - finite(v.attitudeSpeed, v.speed)) / dt : 0;
  v.attitudeSpeed = v.speed;
  const target = boatAttitude(v, accel);
  const blend = Math.min(1, dt * 6);
  // Settle exactly onto the target (a moored boat publishes a level hull, not a creeping one).
  const step = (from, to) => Math.abs(to - from) < 5e-4 ? to : from + (to - from) * blend;
  v.pitch = step(finite(v.pitch), target.pitch);
  v.roll = step(finite(v.roll), target.roll);
}

/** A boat wreck goes down: it sinks at `sinkRate` onto the bed, stern first and listing. */
export function sinkBoatWreck(system, v, dt) {
  const rules = VEHICLE_RULES[v.type];
  v.speed = 0; v.vx = v.vz = 0;
  const support = boatSupport(system, v, v.x, v.z);
  const bed = support?.y ?? null;
  const settled = bed != null && v.y <= bed + 1e-6;
  if (!settled) {
    const next = Math.max(bed ?? -Infinity, v.y - rules.sinkRate * dt);
    // Another hull below (a wreck already on the bed) stops the fall.
    if (system.clearHull(v, v.x, next, v.z)) v.y = Math.max(0, next);
  }
  const k = Math.min(1, dt * 0.8);
  v.pitch = finite(v.pitch) + (rules.wreckPitch - finite(v.pitch)) * k;
  v.roll = finite(v.roll) + (rules.wreckRoll - finite(v.roll)) * k;
  v.vy = settled ? 0 : -rules.sinkRate;
}

/**
 * Exit point for a seat of a boat in open water: beside the hull at the seat's
 * side (then the other side, the bow and the stern), feet BOAT_SWIM_EXIT_DEPTH
 * under the surface, where a body fits. Null when no water spot is free (the
 * ordinary exit search runs first and takes any bank or ford within reach).
 */
export function boatSwimExit(system, v, seat) {
  const def = VEHICLE_RULES[v.type], { halfWidth, halfLength } = vehicleDef(v).collider;
  const left = seat.position[0] < 0, world = system.engine.world;
  const spots = [[left ? -1 : 1, 0], [left ? 1 : -1, 0], [0, -1], [0, 1]];
  for (const [sx, sz] of spots) {
    const lx = sx * (halfWidth + PHYSICS.halfW + 0.45), lz = sz * (halfLength + PHYSICS.halfW + 0.45) + (sz ? 0 : seat.position[2]);
    const dir = vehicleDirection(v.yaw), right = [Math.cos(v.yaw), -Math.sin(v.yaw)];
    const x = v.x + right[0] * lx - dir[0] * lz, z = v.z + right[1] * lx - dir[2] * lz;
    const surface = waterSurfaceAt(world, x, z, v.y + def.draft);
    if (surface == null) continue;
    const y = surface - BOAT_SWIM_EXIT_DEPTH;
    if (system.bodyClear(x, y, z)) return { x, y, z, grounded: false };
  }
  return null;
}
