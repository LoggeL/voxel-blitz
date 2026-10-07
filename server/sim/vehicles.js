import { hullFootprint, footprintCells, footprintsOverlap, vehicleHullParts, vehicleSupportOffset, hullBoxesOverlap, voxelHullBox, rayHullPartSpan, nearestHullPoint, solidHull, solidWreck } from '../../shared/vehicle-collision.js';
import { isSolidBlock } from '../../shared/worlddata.js';
import { VEHICLE_RULES, isAircraft, vehicleEnterDistance, vehicleDirection, vehicleSeatPose, vehicleLocalPoint } from '../../shared/vehicles.js';
import { vehicleSeats, vehicleSeatDefinition, vehicleSeatOccupantId, vehicleWeaponSeatId, vehicleDriverSeat } from '../../shared/vehicle-seats.js';
import { VEHICLE_DAMAGE_RULES, VEHICLE_LIFECYCLE, vehicleDef, vehicleMaxHp, mountPose as sharedMountPose } from '../../shared/vehicle-defs.js';
import { VEHICLE_STATUS } from '../../shared/conquest-contract.js';
import { groundAttitude } from '../../shared/vehicle-attitude.js';
import { playerHullContact, vehiclePlayerPush, infantryHeight } from '../../shared/player-vehicle-collision.js';
import { evHit } from '../protocol/events.js';
import { PHYSICS, boxCollides } from '../../shared/player-movement.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { vehicleDestructionBlast } from './vehicle-destruction.js';
import { VehicleDamageModel, occupantShielded as shieldedOccupant } from './vehicle-damage.js';
import { VehicleMounts } from './vehicle-mounts.js';
import { VehicleLocks } from './vehicle-locks.js';
import { stepJeepDrive } from '../../shared/vehicle-handling/jeep.js';
import { stepTankDrive } from '../../shared/vehicle-handling/tank.js';
import { stepHelicopterFlight } from '../../shared/vehicle-handling/helicopter.js';
import { stepPlaneFlight } from '../../shared/vehicle-handling/plane.js';
import { CHUTE, EJECTION } from '../../shared/parachute.js';
import { markLaunched } from './player.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const q = (value, scale) => Math.round(finite(value) * scale) / scale;
/** Handling dispatch: ground drive steppers and flight steppers by def.handling. */
const GROUND_STEPPERS = Object.freeze({ wheeled: stepJeepDrive, tracked: stepTankDrive });
const FLIGHT_STEPPERS = Object.freeze({
  rotor: (v, input, dt, def) => stepHelicopterFlight(v, input, dt, def.rules),
  fixedwing: (v, input, dt) => stepPlaneFlight(v, input, dt),
});
const flightRest = () => ({ pitch: 0, roll: 0, pitchRate: 0, rollRate: 0, rudderRate: 0, vx: 0, vy: 0, vz: 0, grounded: false, throttle: 0,
  rotorSpeed: 0, collective: 0, enginePower: 0, throttlePower: 0, airspeed: 0, stalled: false, gearDown: true });
const rest = v => Object.assign(v,{speed:0,yawRate:0,visualSteer:0,leftTrackSpeed:0,rightTrackSpeed:0,vx:0,vy:0,vz:0},isAircraft(v.type)?flightRest():{});
const angleDelta = (a,b) => Math.atan2(Math.sin(a-b),Math.cos(a-b));
const spawnRoutes = spawn => Object.fromEntries(['walkingRoute','exitRoute'].flatMap(key => {
  const route = spawn[key];
  return Array.isArray(route) && route.length <= 256 && route.every(point => point && [point.x,point.y,point.z].every(Number.isFinite))
    ? [[key, route.map(({x,y,z}) => ({x,y,z}))]] : [];
}));
const padAlternate = spawn => Number.isFinite(spawn.altX) && Number.isFinite(spawn.altZ)
  ? { x: spawn.altX, y: finite(spawn.altY, spawn.y), z: spawn.altZ, yaw: finite(spawn.altYaw, finite(spawn.yaw)) } : null;
/** A human who takes a driving seat of an airborne aircraft gets this long of
 * neutral stick (hold attitude, keep throttle) until their client's first
 * mounted control packet arrives, so the hull never lurches or drops. */
export const SEAT_TAKEOVER_GRACE_SECONDS = 1;
const TAKEOVER_HOLD_INPUT = Object.freeze({ keys: Object.freeze({}), vehicleThrottle: 0, vehicleSteer: 0, vehicleLift: 0, vehicleBrake: 0,
  vehiclePitchControl: 0, vehicleRollControl: 0, vehicleYawControl: 0 });
const EJECTION_TYPES = new Set(EJECTION.types);
export const RUNOVER_RULES = Object.freeze({ minSpeed: 5, maxDamage: 100, cooldownSeconds: 0.75, separateSeconds: 0.12 });
export const VEHICLE_MOMENTUM_RULES = Object.freeze({ driverCreditSeconds: 5, exitHorizontalSpeed: 16, ejectHorizontalSpeed: 36, ejectVerticalSpeed: 20 });
/** Heavy hulls below this speed shove a pinned body sideways instead of stopping. */
export const HEAVY_PUSH_RULES = Object.freeze({ maxSpeed: 6, reach: 4.5, step: 0.15 });
/** Wall contact keeps the tangential motion; scraping bleeds speed by the normal share. */
export const WALL_SLIDE_RULES = Object.freeze({ scrape: 1.6 });
/** Everything a ground hull's collision/support pass reads from or writes to the
 * hull after its drive stepper (see advanceGround's rest replay). */
const GROUND_REST_INPUTS = Object.freeze(['x','y','z','yaw','pitch','roll','gearDown','speed','yawRate','leftTrackSpeed','rightTrackSpeed',
  'vx','vy','vz','scraping','stuckFor','disabled']);
const GROUND_REST_OUTPUTS = Object.freeze(['x','y','z','yaw','speed','yawRate','leftTrackSpeed','rightTrackSpeed','vx','vy','vz','scraping','stuckFor']);
/** An aircraft wreck's sweep inputs and its outputs. */
const WRECK_REST_INPUTS = Object.freeze(['x','y','z','vx','vy','vz','yaw','pitch','roll','gearDown']);
const WRECK_REST_OUTPUTS = Object.freeze(['x','y','z','vx','vy','vz','speed','airspeed','grounded']);
const readFields = (v, fields) => { const values = new Array(fields.length); for (let i = 0; i < fields.length; i++) values[i] = v[fields[i]]; return values; };
const fieldsMatch = (v, fields, values) => { for (let i = 0; i < fields.length; i++) if (!Object.is(v[fields[i]], values[i])) return false; return true; };
const writeFields = (v, fields, values) => { for (let i = 0; i < fields.length; i++) if (values[i] !== undefined || Object.hasOwn(v, fields[i])) v[fields[i]] = values[i]; };
const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const byPoint = (a,b) => a[0]-b[0] || a[1]-b[1];
/** Monotone-chain hull of the contact points; true when (x, z) lies inside it. */
function balancedSupport(points, x, z) {
  const sorted = points.slice().sort(byPoint), n = sorted.length;
  if (n < 3) return false;
  const lower = [], upper = [];
  for (let i = 0; i < n; i++) {
    const p = sorted[i];
    while (lower.length > 1 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  for (let i = n - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length > 1 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  const polygon = lower; polygon.pop();
  for (let i = 0; i < upper.length - 1; i++) polygon.push(upper[i]);
  const count = polygon.length;
  if (count < 3) return false;
  for (let i = 0; i < count; i++) {
    const a = polygon[i], b = polygon[(i+1)%count];
    if (!((b[0]-a[0])*(z-a[1])-(b[1]-a[1])*(x-a[0]) >= -1e-8)) return false;
  }
  return true;
}
/** Support patches per footprint, aligned with footprintCells (read-only). */
const patchLists = new WeakMap();
function cellPatch(hull, cells, i) {
  let patches = patchLists.get(hull);
  if (!patches) patchLists.set(hull, patches = new Array(cells.length >> 1));
  return patches[i >> 1] ??= supportPatch(hull, cells[i], cells[i + 1]);
}
/** Clip the oriented footprint to one supporting voxel's actual top face. */
function supportPatch(hull, bx, bz) {
  let polygon = [hull.corners[0],hull.corners[1],hull.corners[3],hull.corners[2]];
  // Clip edges in order: x >= bx, x <= bx+1, z >= bz, z <= bz+1.
  for (let k = 0; k < 4; k++) {
    const axis = k < 2 ? 0 : 1, edge = k === 0 ? bx : k === 1 ? bx+1 : k === 2 ? bz : bz+1, sign = k & 1 ? -1 : 1;
    const next=[];
    for(let i=0;i<polygon.length;i++) {
      const a=polygon[i], b=polygon[(i+1)%polygon.length];
      const da=(a[axis]-edge)*sign, db=(b[axis]-edge)*sign;
      if(da>=0)next.push(a);
      if((da>=0)!==(db>=0)) {const t=da/(da-db);next.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}
    }
    polygon=next;
    if(!polygon.length)break;
  }
  return polygon;
}

/**
 * Conquest hulls: finite crew seats, per-seat mounts, the armour damage model,
 * locks and countermeasures, terrain-fitted ground attitude, wrecks, pads and
 * respawn. Dispatch goes through vehicleDef(type).handling; no type switches.
 */
/** Strictly inside one oriented hull box (a point on a face is outside). */
function insideHullPart(part, point, margin = 1e-6) {
  const delta = point.map((n, i) => n - part.center[i]);
  return part.axes.every((axis, i) => Math.abs(delta[0]*axis[0] + delta[1]*axis[1] + delta[2]*axis[2]) < part.half[i] - margin);
}
/** Outward normal of the box face a surface point lies on. */
function hullFaceNormal(part, point) {
  const delta = point.map((n, i) => n - part.center[i]);
  let best = 0, ratio = -Infinity, sign = 1;
  part.axes.forEach((axis, i) => {
    const local = delta[0]*axis[0] + delta[1]*axis[1] + delta[2]*axis[2], r = Math.abs(local) / Math.max(1e-9, part.half[i]);
    if (r > ratio) { ratio = r; best = i; sign = local < 0 ? -1 : 1; }
  });
  return part.axes[best].map(n => n * sign);
}

export class VehicleSystem {
  constructor(engine) {
    this.engine = engine; this.vehicles = new Map();
    this.damageModel = new VehicleDamageModel(this);
    this.mounts = new VehicleMounts(this);
    this.locks = new VehicleLocks(this);
    this.padOwners = new Map();
    this.contactClock = 0; this.clockAnchor = 0; this.anchoredNow = null;
    // Rest replay: a hull at rest whose collision pass would see exactly the
    // inputs of its last pass replays that pass's result (see advanceGround).
    this.restMemos = new WeakMap(); this.attitudeKeys = new WeakMap(); this.infantryTouches = 0;
    this.reset();
  }
  /** Simulation milliseconds: the engine clock plus substep progress within its tick. */
  nowMs() {
    const now = this.engine.now;
    if (!Number.isFinite(now)) return this.contactClock * 1000;
    if (now !== this.anchoredNow) { this.anchoredNow = now; this.clockAnchor = this.contactClock; }
    return now + (this.contactClock - this.clockAnchor) * 1000;
  }
  teamOf(p) { return p ? this.engine.mode?.teamFor?.(p) ?? p.team : null; }
  canOperate(p) { return !!p && p.state === 'alive' && (!this.engine.mode?.canFire || this.engine.mode.canFire(p)); }
  reset(spawns = this.engine.mapMeta?.conquest?.vehicleSpawns || []) {
    this.contactClock = 0; this.clockAnchor = 0; this.anchoredNow = null;
    this.infantryContacts = new Map();
    this.fallSpeeds = new Map();
    this.boundaryAvoidance = new Map();
    this.lastDrivers = new Map();
    this.destructionQueue = [];
    this.detonating = false;
    this.combatProfile = this.engine.mode?.mode === 'conquest' || spawns.length ? 'conquest' : null;
    for (const p of this.engine.entities.values()) if (p.vehicleId || p.vehicleSeatId) this.release(p);
    this.lastDrivers.clear();
    this.vehicles.clear();
    this.padOwners.clear();
    this.damageModel?.reset();
    this.locks?.reset();
    for (const s of spawns) {
      if (!s || !vehicleDef(s.type) || ![s.x, s.y, s.z].every(Number.isFinite) || typeof s.id !== 'string' || this.vehicles.has(s.id)) continue;
      if (typeof s.flag === 'string' && !this.padOwners.has(s.flag)) this.padOwners.set(s.flag, s.team ?? null);
      const yaw = Number.isFinite(s.yaw) ? s.yaw : 0, def = vehicleDef(s.type);
      const v = { id: s.id, type: s.type, team: s.team ?? null, x: s.x, y: s.y, z: s.z, yaw, pitch: 0, roll: 0,
        ...(isAircraft(s.type) ? flightRest() : {}),
        turretYaw: yaw, turretPitch: 0, speed: 0, yawRate: 0, visualSteer: 0, leftTrackSpeed: 0, rightTrackSpeed: 0, vx: 0, vy: 0, vz: 0,
        hp: def.hp, occupantId: null, seatOccupants: this.emptySeats(s.type),
        respawnIn: 0, engineOn: false, wreckAge: 0,
        spawn: { x: s.x, y: s.y, z: s.z, yaw, ...(typeof s.flag === 'string' ? { flag: s.flag } : {}),
          ...(padAlternate(s) ? { alt: padAlternate(s) } : {}), ...spawnRoutes(s) } };
      this.freshCondition(v);
      this.mounts.reset(v);
      if (v.spawn.flag && (s.team == null)) Object.assign(v, { hp: 0, padInactive: true, wreckAge: Infinity });
      this.vehicles.set(s.id, v);
    }
    for (const v of this.vehicles.values()) if (isAircraft(v.type) && v.hp > 0) {
      const floor = this.placement(v, v.x, v.z);
      v.grounded = floor != null && Math.abs(v.y - floor) < 0.08;
    }
  }
  freshCondition(v) {
    Object.assign(v, { disabled: false, burning: false, disabledBy: null, lastDamagedAt: -Infinity, damageLog: new Map(),
      lk: 0, spotted: {}, cmReadyAt: 0, flaresUntil: 0, smokeUntil: 0, crewlessFor: 0, padBlockedFor: 0, stuckFor: 0,
      scraping: false, padInactive: false, sleepRevision: null });
  }
  solid(x, y, z, aircraft = false) {
    const d = this.engine.world.dimensions;
    if (d && (x < 0 || z < 0 || x >= d.sx || z >= d.sz || y < 0)) return true;
    if (d && y >= d.sy) return !aircraft;
    return isSolidBlock(this.engine.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
  }
  ground(x, z, around, rise = 1, fall = 3) {
    const world = this.engine.world, d = world.dimensions;
    if (d && (x < 0 || z < 0 || x >= d.sx || z >= d.sz)) return null;
    // The column and every probed y are in bounds: solid() is isSolidBlock(getBlock()).
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let y = Math.floor(around + rise - 0.001); y >= Math.floor(around - fall); y--)
      if (y >= 0 && (!d || y < d.sy) && isSolidBlock(world.getBlock(bx, y, bz))) return y + 1;
    return null;
  }
  /** Other hulls a pose must avoid: live hulls and fresh ground wrecks. */
  obstacles(v) {
    const result = [];
    for (const other of this.vehicles.values()) if (other !== v && other.id !== v.id && solidHull(other)) result.push(other);
    return result;
  }
  clearHull(v, x, y, z, yaw = v.yaw) {
    if (isAircraft(v.type)) return this.clearAircraftHull(v,x,y,z,yaw);
    const h = VEHICLE_RULES[v.type].height, hull = hullFootprint(v.type, x, z, yaw);
    const d = this.engine.world.dimensions;
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(yaw))
      || (d && (hull.minX < 0 || hull.minZ < 0 || hull.maxX > d.sx || hull.maxZ > d.sz || y < 0 || y + h > d.sy))) return false;
    // Every probed voxel lies inside the bounds checked above (or the world has
    // none), where solid() is exactly isSolidBlock(getBlock()).
    const cells = footprintCells(hull), bottom = Math.floor(y + 0.03), top = Math.floor(y + h - 0.01), world = this.engine.world;
    for (let i = 0; i < cells.length; i += 2)
      for (let by = bottom; by <= top; by++)
        if (isSolidBlock(world.getBlock(cells[i], by, cells[i + 1]))) return false;
    for (const other of this.vehicles.values()) {
      if (other === v || other.id === v.id || !solidHull(other)) continue;
      if(Math.hypot(x-other.x,z-other.z)>VEHICLE_RULES[v.type].radius+VEHICLE_RULES[other.type].radius+VEHICLE_RULES[other.type].height)continue;
      if (isAircraft(other.type)) {
        const box=vehicleHullParts(v,x,y,z,yaw)[0];
        if(vehicleHullParts(other).some(part=>hullBoxesOverlap(box,part)))return false;
      } else if (y < other.y + VEHICLE_RULES[other.type].height && other.y < y + h && footprintsOverlap(hull, hullFootprint(other.type, other.x, other.z, other.yaw))) return false;
    }
    return true;
  }
  clearAircraftHull(v,x,y,z,yaw=v.yaw) {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(yaw)
      && Number.isFinite(v.pitch ?? 0) && Number.isFinite(v.roll ?? 0))) return false;
    const parts=vehicleHullParts(v,x,y,z,yaw),world=this.engine.world,d=world.dimensions;
    for(const part of parts) {
      const hull=part.hull;
      if(part.minY < -1e-7 || part.maxY > (VEHICLE_RULES[v.type].ceiling??180)+1e-7 || (d && (hull.minX<0||hull.maxX>d.sx||hull.minZ<0||hull.maxZ>d.sz)))return false;
      if(d&&part.minY>=d.sy)continue;
      const bottom=Math.floor(part.minY+1e-5),top=Math.min(Math.floor(part.maxY-1e-5),d?d.sy-1:Infinity);
      for(let bx=Math.floor(hull.minX);bx<Math.ceil(hull.maxX);bx++)
        for(let bz=Math.floor(hull.minZ);bz<Math.ceil(hull.maxZ);bz++)
          for(let by=bottom;by<=top;by++) {
            // In bounds by the checks above: solid() is isSolidBlock(getBlock()).
            if(isSolidBlock(world.getBlock(bx,by,bz))&&hullBoxesOverlap(part,voxelHullBox(bx,by,bz)))return false;
          }
    }
    for(const other of this.vehicles.values()) {
      if (other === v || other.id === v.id || !solidHull(other)) continue;
      if(Math.hypot(x-other.x,z-other.z)>VEHICLE_RULES[v.type].radius+VEHICLE_RULES[other.type].radius+VEHICLE_RULES[v.type].height+VEHICLE_RULES[other.type].height)continue;
      const otherParts=vehicleHullParts(other);
      for (const part of parts) for (const body of otherParts) if (hullBoxesOverlap(part,body)) return false;
    }
    return true;
  }
  placement(v, x, z) {
    const def = VEHICLE_RULES[v.type], hull = hullFootprint(v.type, x, z, v.yaw);
    const maxStep = def.maxStep ?? 0.25, maxSlope = def.maxSlope ?? 0.1;
    const offset = isAircraft(v.type) ? vehicleSupportOffset(v) : 0;
    const cells=footprintCells(hull), heights=[], patches=[];
    // A missing centre or corner is a hole, not proof that the whole chassis
    // lacks ground. Contact patches include both tracks/wheels at every yaw.
    let supportY=-Infinity;
    for(let i=0;i<cells.length;i+=2) {
      const height=this.ground(cells[i]+0.5,cells[i+1]+0.5,v.y+offset,maxStep);
      if(height==null)continue;
      heights.push(height); patches.push(cellPatch(hull,cells,i));
      supportY=Math.max(supportY,height);
    }
    if(!heights.length)return null;
    const y=supportY-offset;
    const slopeSpan=maxSlope*Math.min(hull.halfWidth,hull.halfLength)*2;
    // Deep pit floors do not bear load while the opposite rim bridges the gap.
    // If the remaining contact patches cannot balance the centre, it must fall.
    const points=[];
    for(let i=0;i<heights.length;i++) if(supportY-heights[i]<=slopeSpan) for(const point of patches[i]) points.push(point);
    if (!balancedSupport(points,x,z) || y-v.y>maxStep || !this.clearHull(v,x,y,z)) return null;
    return y;
  }
  /** Gravity for an unsupported ground hull. Landing above 9 m/s costs hp*(vy-9)/25. */
  settle(v, floor, dt) {
    if(floor!=null && floor>=v.y-1e-8) {this.landed(v);return floor;}
    const speed=Math.min(60,(this.fallSpeeds.get(v.id)||0)+PHYSICS.gravity*dt);
    this.fallSpeeds.set(v.id,speed);
    const destination=Math.max(floor??0,v.y-speed*dt), distance=v.y-destination;
    const steps=Math.max(1,Math.ceil(distance/0.1));
    let safe=v.y;
    for(let i=1;i<=steps;i++) {
      const y=v.y-distance*i/steps;
      if(!this.clearHull(v,v.x,y,v.z)) {
        let blocked=y;
        for(let j=0;j<20;j++) {const middle=(safe+blocked)/2;if(this.clearHull(v,v.x,middle,v.z))safe=middle;else blocked=middle;}
        this.landed(v,speed);return safe;
      }
      safe=y;
    }
    if(floor!=null && safe<=floor+1e-8)this.landed(v,speed);
    if(floor==null && safe<=1e-8) {
      const dir=vehicleDirection(v.yaw);
      this.damage(v.id,vehicleMaxHp(v),null,{cls:'collision',impactVelocity:{vx:dir[0]*v.speed,vy:-speed,vz:dir[2]*v.speed}});
    }
    return safe;
  }
  landed(v, speed = 0) {
    this.fallSpeeds.delete(v.id);
    const rules = VEHICLE_DAMAGE_RULES;
    if (speed > rules.fallDamageSpeed && v.hp > 0) {
      const dir = vehicleDirection(v.yaw);
      this.damage(v.id, vehicleMaxHp(v) * (speed - rules.fallDamageSpeed) / rules.fallDamageScale, null,
        { cls: 'collision', impactVelocity: { vx: dir[0] * v.speed, vy: -speed, vz: dir[2] * v.speed } });
    }
  }

  // ---- crew ---------------------------------------------------------------

  enter(p, id, requestedSeatId = null) {
    const v = this.vehicles.get(id);
    if (!p || this.engine.entities.get(String(p.id)) !== p || p.state !== 'alive' || p.vehicleId || !v || !(v.hp > 0) || v.padInactive
      || this.teamOf(p) !== v.team || Math.hypot(p.x-v.x,p.y-v.y,p.z-v.z) > vehicleEnterDistance(v.type)) return false;
    if (p.chute) { p.chute = CHUTE.none; p.chuteT = 0; }
    if (this.engine.mode?.canFire && !this.engine.mode.canFire(p)) return false;
    this.cleanCrew(v);
    const free = seat => vehicleSeatOccupantId(v, seat.id) == null;
    // A human takes a seat a bot holds (the requested one, else a free seat
    // first, then the first bot seat in F-key order); the bot is put out.
    const takeable = seat => !free(seat) && !!this.botTakeover(p, v, seat.id);
    const seats = vehicleSeats(v);
    const seat = requestedSeatId != null ? seats.find(item => item.id === requestedSeatId && (free(item) || takeable(item)))
      : seats.find(free) ?? seats.find(takeable);
    if (!seat) return false;
    const bot = free(seat) ? null : this.botTakeover(p, v, seat.id);
    if (bot) this.exit(bot);
    if (!free(seat)) return false;
    const airborne = isAircraft(v.type) && !v.grounded;
    v.seatOccupants[seat.id] = String(p.id);
    if (seat.drives) { this.lastDrivers.delete(v.id); v.occupantId = String(p.id); v.engineOn = true; this.takeoverGrace(p, v, airborne); }
    p.vehicleId = v.id; p.vehicleSeatId = seat.id; p.ghostVehicleId = null;
    this.sync(p,v); return true;
  }
  /** The bot a human `p` may put out of `seatId` (never a human, never for a bot), or null. */
  botTakeover(p, v, seatId) {
    if (!p || p.bot) return null;
    const occupant = this.seatOccupant(v, seatId);
    return occupant && occupant !== p && occupant.bot === true && this.teamOf(occupant) === this.teamOf(p) ? occupant : null;
  }
  /** Neutral controls for a human taking the stick of an airborne aircraft (see SEAT_TAKEOVER_GRACE_SECONDS). */
  takeoverGrace(p, v, airborne) {
    p.seatGraceUntil = airborne && !p.bot ? this.contactClock + SEAT_TAKEOVER_GRACE_SECONDS : 0;
    p.seatGraceVehicleId = v.id;
  }
  /** Move a seated player to another free seat of the same hull at once. */
  switchSeat(p, seatId) {
    const v = this.vehicles.get(p?.vehicleId), from = this.seatFor(p, v), to = v && vehicleSeatDefinition(v, seatId);
    if (!from || !to || from.id === to.id || !(v.hp > 0) || p.state !== 'alive') return false;
    // A bot in the wanted seat swaps into the human's seat instead of blocking it.
    const bot = vehicleSeatOccupantId(v, to.id) != null ? this.botTakeover(p, v, to.id) : null;
    if (vehicleSeatOccupantId(v, to.id) != null && !bot) return false;
    const airborne = isAircraft(v.type) && !v.grounded;
    v.seatOccupants[from.id] = null;
    if (from.drives) {
      if (!bot) this.lastDrivers.set(v.id, { player:p, team:this.teamOf(p), deaths:p.deaths, expires:this.contactClock + VEHICLE_MOMENTUM_RULES.driverCreditSeconds });
      v.occupantId = null; v.engineOn = false;
    }
    if (bot) {
      v.seatOccupants[from.id] = String(bot.id);
      bot.vehicleSeatId = from.id;
      if (from.drives) { v.occupantId = String(bot.id); v.engineOn = true; }
      this.clearSeatStance(bot);
    }
    v.seatOccupants[to.id] = String(p.id);
    if (to.drives) { this.lastDrivers.delete(v.id); v.occupantId = String(p.id); v.engineOn = true; this.takeoverGrace(p, v, airborne); }
    p.vehicleSeatId = to.id;
    this.clearSeatStance(p);
    this.sync(p, v);
    if (bot) this.sync(bot, v);
    return true;
  }
  /** Exit never fails: eight angles around the hull, then the roof, then a forced eject. */
  exit(p) {
    const v = this.vehicles.get(p?.vehicleId), seat = this.seatFor(p, v);
    if (!seat) return false;
    if (isAircraft(v.type) && (!v.grounded || v.speed > 4)) return this.eject(p, v);
    const spot = this.exitSpot(p, v, seat, false);
    const velocity = this.exitVelocity(v);
    this.release(p);
    Object.assign(p,{x:spot.x,y:spot.y,z:spot.z,...velocity,grounded:spot.grounded,coyote:0,jumpGroundY:null,vault:null,slide:null});
    if (spot.ghost) this.ghost(p, v);
    return true;
  }
  eject(p, v = this.vehicles.get(p?.vehicleId)) {
    const seat = this.seatFor(p, v);
    if (!seat) return false;
    if (seat.drives && EJECTION_TYPES.has(v.type) && !v.grounded) return this.ejectionSeat(p, v, seat);
    const spot = this.exitSpot(p, v, seat, true);
    this.release(p);
    Object.assign(p, { x: spot.x, y: spot.y, z: spot.z, ...this.exitVelocity(v, true), grounded: false, coyote: 0, jumpGroundY: null, vault: null, slide: null });
    // Clients adopt the inherited velocity at once (the impulse sequence).
    markLaunched(p);
    if (spot.ghost) this.ghost(p, v);
    return true;
  }
  /**
   * Jet ejection (shared/parachute.js EJECTION): the seat leaves the cockpit
   * along the airframe's up axis blended with world up, keeps part of the jet's
   * momentum, rides ballistic for EJECTION.seatSeconds and then opens the
   * canopy. The empty jet flies on without a pilot until it crashes.
   */
  ejectionSeat(p, v, seat) {
    const pose = vehicleSeatPose(v, seat.id);
    const origin = vehicleLocalPoint(v, 0, 0, 0), up = vehicleLocalPoint(v, 0, 1, 0);
    let ux = up[0] - origin[0], uy = up[1] - origin[1] + 1, uz = up[2] - origin[2];
    const length = Math.hypot(ux, uy, uz) || 1;
    ux /= length; uy /= length; uz /= length;
    const carry = EJECTION.carry, hx = finite(v.vx) * carry, hz = finite(v.vz) * carry, horizontal = Math.hypot(hx, hz);
    const scale = horizontal > EJECTION.maxCarry ? EJECTION.maxCarry / horizontal : 1;
    const velocity = { vx: hx * scale + ux * EJECTION.launchSpeed, vy: finite(v.vy) * carry + uy * EJECTION.launchSpeed, vz: hz * scale + uz * EJECTION.launchSpeed };
    this.release(p);
    Object.assign(p, { x: pose.x, y: pose.y, z: pose.z, ...velocity, grounded: false, coyote: 0, jumpGroundY: null, vault: null, slide: null,
      chute: CHUTE.seat, chuteT: EJECTION.seatSeconds });
    markLaunched(p);
    // The seat clears the canopy frame and the tail it climbs past.
    this.ghost(p, v);
    this.engine.tickEvents?.push({ t: 'ev', kind: 'ejection', id: String(p.id), vehicleId: v.id,
      pos: [q(pose.x, 100), q(pose.y, 100), q(pose.z, 100)], vel: [q(velocity.vx, 100), q(velocity.vy, 100), q(velocity.vz, 100)], yaw: q(v.yaw, 1000) });
    return true;
  }
  ghost(p, v) { p.ghostVehicleId = v.id; p.ghostUntil = this.contactClock + VEHICLE_LIFECYCLE.exitNoCollideSeconds; }
  bodyClear(x, y, z, aircraft = false) {
    for (let bx=Math.floor(x-PHYSICS.halfW);bx<=Math.floor(x+PHYSICS.halfW);bx++)
      for(let bz=Math.floor(z-PHYSICS.halfW);bz<=Math.floor(z+PHYSICS.halfW);bz++)
        for(let by=Math.floor(y+0.01);by<=Math.floor(y+PHYSICS.height-0.05);by++) if(this.solid(bx,by,bz,aircraft)) return false;
    return true;
  }
  /** Candidate dismount point: 8 angles (seat side first), the roof, then forced. */
  exitSpot(p, v, seat, airborne) {
    const def = vehicleDef(v), { halfWidth, halfLength } = def.collider, left = seat.position[0] < 0;
    const angles = left ? [-Math.PI/2, Math.PI/2, 0, Math.PI, -Math.PI/4, Math.PI/4, -3*Math.PI/4, 3*Math.PI/4]
      : [Math.PI/2, -Math.PI/2, 0, Math.PI, Math.PI/4, -Math.PI/4, 3*Math.PI/4, -3*Math.PI/4];
    const free = (x, y, z) => {
      const probe = { ...p, vehicleId: null, ghostVehicleId: null, state: 'alive', x, y, z, proneT: 0 };
      return this.bodyClear(x, y, z, airborne) && ![...this.vehicles.values()].some(other => playerHullContact(probe, other, PHYSICS.height));
    };
    const seatY = airborne ? v.y + (VEHICLE_RULES[v.type].seatHeight ?? 1.4) : null;
    for (const angle of angles) {
      const lx = Math.sin(angle), lz = Math.cos(angle);
      const reach = Math.min(Math.abs(lx) > 1e-6 ? halfWidth / Math.abs(lx) : Infinity, Math.abs(lz) > 1e-6 ? halfLength / Math.abs(lz) : Infinity);
      const r = reach + PHYSICS.halfW + 0.45, point = vehicleLocalPoint({ ...v, pitch: 0, roll: 0 }, lx * r, 0, lz * r);
      const x = point[0], z = point[2], y = airborne ? seatY : this.ground(x, z, v.y + 0.5, 1.5, 3);
      if (y == null || !free(x, y, z)) continue;
      return { x, y, z, grounded: !airborne };
    }
    const top = Math.max(...vehicleHullParts(v).map(part => part.maxY)) + 0.02;
    if (free(v.x, top, v.z)) return { x: v.x, y: top, z: v.z, grounded: !airborne };
    // Forced eject: the seat column, with a brief hull no-collide to walk clear.
    const pose = vehicleSeatPose(v, seat.id);
    const y = airborne ? pose.y : Math.max(v.y + 0.02, this.ground(pose.x, pose.z, v.y + 0.5, 1.5, 3) ?? v.y);
    return { x: pose.x, y, z: pose.z, grounded: !airborne, ghost: true };
  }
  exitVelocity(v, airborne = false) {
    const dir = vehicleDirection(v.yaw);
    let vx = isAircraft(v.type) ? v.vx : dir[0] * v.speed;
    let vz = isAircraft(v.type) ? v.vz : dir[2] * v.speed;
    const horizontal = Math.hypot(vx || 0, vz || 0), maximum = airborne ? VEHICLE_MOMENTUM_RULES.ejectHorizontalSpeed : VEHICLE_MOMENTUM_RULES.exitHorizontalSpeed;
    const scale = horizontal > maximum ? maximum / horizontal : 1;
    return { vx: (vx || 0) * scale, vy: airborne ? clamp(v.vy, -VEHICLE_MOMENTUM_RULES.ejectVerticalSpeed, VEHICLE_MOMENTUM_RULES.ejectVerticalSpeed) : 0, vz: (vz || 0) * scale };
  }
  clearSeatStance(p) {
    if (p?.seatCrouch) { p.crouch = false; p.seatCrouch = false; }
  }
  release(p) {
    const v = this.vehicles.get(p?.vehicleId);
    if(v && p) {
      if (!v.seatOccupants) v.seatOccupants = this.emptySeats(v.type);
      for (const seat of vehicleSeats(v)) if (vehicleSeatOccupantId(v, seat.id) === String(p.id)) {
        v.seatOccupants[seat.id] = null;
        if (seat.drives) {
          if(v.hp > 0 && p.state === 'alive') this.lastDrivers.set(v.id, { player:p, team:this.teamOf(p),
            deaths:p.deaths, expires:this.contactClock + VEHICLE_MOMENTUM_RULES.driverCreditSeconds });
          v.occupantId=null; v.engineOn=false;
        }
      }
    }
    if(p) { p.vehicleId=null; p.vehicleSeatId=null; p.vehicleSeatExposed=false; this.clearSeatStance(p); }
  }
  /** Bot takeover: the seats (and driver slot) follow the body to its new id, so the hull keeps its crew. */
  renameOccupant(priorId, nextId) {
    const prior = String(priorId), next = String(nextId);
    for (const v of this.vehicles.values()) {
      if (v.occupantId === prior) v.occupantId = next;
      for (const seatId of Object.keys(v.seatOccupants || {})) if (v.seatOccupants[seatId] === prior) v.seatOccupants[seatId] = next;
    }
  }
  emptySeats(type) { return Object.fromEntries(vehicleSeats(type).map(seat => [seat.id, null])); }
  seatFor(p, v = this.vehicles.get(p?.vehicleId)) {
    if (!p || !v || p.vehicleId !== v.id || typeof p.vehicleSeatId !== 'string') return null;
    const seat = vehicleSeatDefinition(v, p.vehicleSeatId);
    return seat && vehicleSeatOccupantId(v, seat.id) === String(p.id) ? seat : null;
  }
  seatOccupant(v, seatId) {
    const id = vehicleSeatOccupantId(v, seatId), p = id == null ? null : this.engine.entities.get(id);
    return this.seatFor(p, v)?.id === seatId ? p : null;
  }
  /** Clear invalid references individually, leaving every other crew member seated. */
  cleanCrew(v) {
    if (!v.seatOccupants) v.seatOccupants = this.emptySeats(v.type);
    const seen = new Set();
    for (const seat of vehicleSeats(v)) {
      const id = vehicleSeatOccupantId(v, seat.id), p = id == null ? null : this.engine.entities.get(id);
      if (id == null) continue;
      if (!p || seen.has(id) || p.state !== 'alive' || p.vehicleId !== v.id || p.vehicleSeatId !== seat.id || this.teamOf(p) !== v.team) {
        v.seatOccupants[seat.id] = null;
        if (p?.vehicleId === v.id && p.vehicleSeatId === seat.id) { p.vehicleId = null; p.vehicleSeatId = null; p.vehicleSeatExposed = false; this.clearSeatStance(p); }
      } else seen.add(id);
    }
    v.occupantId = vehicleSeatOccupantId(v, vehicleDriverSeat(v)?.id ?? 'driver');
    if (v.occupantId == null) v.engineOn = false;
  }
  /** Seated, valid crew in seat order (vehicleOccupiedSeats without its seat copies). */
  crew(v) {
    const result = [], occupants = v.seatOccupants;
    for (const seat of vehicleSeats(v)) {
      // vehicleSeatOccupantId for a seat of this hull's own list.
      const raw = occupants && Object.hasOwn(occupants, seat.id) ? occupants[seat.id] : seat.id === 'driver' ? v.occupantId : null;
      if (typeof raw !== 'string' && typeof raw !== 'number') continue;
      const id = String(raw);
      const p = this.engine.entities.get(id);
      if (this.seatFor(p, v)) result.push(p);
    }
    return result;
  }
  syncCrew(v) { for (const p of this.crew(v)) this.sync(p,v); }
  /** Legacy view: occupant of the primary mount's seat. */
  weaponOperator(v) {
    const seatId = vehicleWeaponSeatId(v);
    return seatId == null ? null : this.seatOccupant(v, seatId);
  }
  /** True when the player's seat owns at least one mount. */
  canUseWeapon(p,v) { return !!this.seatFor(p,v)?.mounts.length; }
  momentumDriver(v) {
    const current = this.seatOccupant(v, vehicleDriverSeat(v)?.id ?? 'driver');
    if(current && this.teamOf(current) === v.team) return current;
    const record = this.lastDrivers.get(v.id), p = record?.player;
    if(!p || record.expires < this.contactClock || this.engine.entities.get(String(p.id)) !== p || p.state !== 'alive'
      || (p.vehicleId && p.vehicleId !== v.id) || p.deaths !== record.deaths || this.teamOf(p) !== record.team || record.team !== v.team) {
      this.lastDrivers.delete(v.id); return null;
    }
    return p;
  }
  /** Vehicle actions: enter {vehicleId, seatId?} | exit | seat {seatId} | cm | weapon {index}. */
  action(p, a) {
    switch (a?.type) {
      case 'enter': return this.enter(p, a.vehicleId, a.seatId ?? null);
      case 'exit': return this.exit(p);
      case 'seat': return typeof a.seatId === 'string' && this.switchSeat(p, a.seatId);
      case 'cm': {
        const v = this.vehicles.get(p?.vehicleId);
        return !!(this.seatFor(p, v) && this.canOperate(p) && this.locks.countermeasure(v));
      }
      case 'weapon': {
        const v = this.vehicles.get(p?.vehicleId), seat = this.seatFor(p, v);
        return !!seat && this.mounts.select(v, seat.id, a.index);
      }
      default: return false;
    }
  }
  seatedPose(p) { const v=this.vehicles.get(p?.vehicleId), seat=this.seatFor(p,v); return seat ? vehicleSeatPose(v,seat.id) : null; }
  sync(p,v) {
    const seat = this.seatFor(p, v), pose = seat ? vehicleSeatPose(v, seat.id) : null;
    if (!pose) return;
    Object.assign(p,{x:pose.x,y:pose.y,z:pose.z,vx:0,vy:0,vz:0,grounded:isAircraft(v.type)?v.grounded:true});
    p.vehicleSeatExposed = !!seat.exposed;
    if (seat.exposed) { p.crouch = true; p.seatCrouch = true; }
  }
  /** Occupants of personal-weapon seats may fire infantry weapons within ±100° of hull yaw. */
  seatAllowsPersonalWeapons(p, yaw = p?.input?.yaw ?? p?.yaw) {
    const v = this.vehicles.get(p?.vehicleId), seat = this.seatFor(p, v);
    return !!seat?.personalWeapons && v.hp > 0 && Number.isFinite(yaw) && Math.abs(angleDelta(yaw, v.yaw)) <= PERSONAL_WEAPON_ARC;
  }
  occupantShielded(victim) { return shieldedOccupant(victim); }
  mountPose(v, seatId, mountId, options) { return sharedMountPose(v, seatId, mountId, options); }
  hullCenter(v) { return vehicleLocalPoint(v, 0, VEHICLE_RULES[v.type].height / 2, 0); }
  /** A credit-worthy player for delayed hull deaths (burning), or null. */
  creditablePlayer(p, v) {
    return p && this.engine.entities.get(String(p.id)) === p && this.teamOf(p) !== v.team ? p : null;
  }
  combatContext() {
    if (this.engine.contexts?.combat) return this.engine.contexts.combat;
    const engine = this.engine, system = this;
    return this.fallbackCombat ??= {
      get entities() { return engine.combatants || engine.entities; }, get now() { return system.nowMs(); },
      get vehicles() { return system; },
      solidAt: (x, y, z) => this.solid(x, y, z, true),
      getBlock: (x, y, z) => engine.world.getBlock(x, y, z), blockHp: new Map(),
      canDamage: (attacker, target) => engine.mode?.canDamage?.(attacker, target) ?? this.teamOf(attacker) !== this.teamOf(target),
      killPlayer: (victim, killer, weapon, headshot, markers) => engine.killPlayer?.(victim, killer, weapon, headshot, markers),
      pushEvent: event => engine.tickEvents?.push(event),
    };
  }
  projectileContext() { return this.engine.contexts?.projectiles ?? null; }

  // ---- respawn pads ---------------------------------------------------------

  /** Pad position for a team; flag C uses the bank nearer to the owner's HQ. */
  padPosition(v, team = v.team) {
    const spawn = v.spawn, primary = { x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw };
    if (!spawn.alt) return primary;
    const base = this.engine.mapMeta?.conquest?.bases?.[team];
    if (base && Number.isFinite(base.x) && Number.isFinite(base.z)) {
      const d = pad => Math.hypot(pad.x - base.x, pad.z - base.z);
      return d(spawn.alt) < d(primary) ? spawn.alt : primary;
    }
    return team === 'bravo' ? spawn.alt : primary;
  }
  /** The pad itself plus three alternates: either side, then behind. */
  padCandidates(v, pad) {
    const def = vehicleDef(v), side = def.collider.halfWidth * 2 + 1.5, back = def.collider.halfLength * 2 + 2;
    const at = (lx, lz) => { const point = vehicleLocalPoint({ x: pad.x, y: pad.y, z: pad.z, yaw: pad.yaw }, lx, 0, lz); return { x: point[0], y: pad.y, z: point[2], yaw: pad.yaw }; };
    return [pad, at(side, 0), at(-side, 0), at(0, back)];
  }
  /** Team owning the pad now, or undefined for a plain HQ pad (keeps hull team). */
  padTeam(v) {
    return v.spawn.flag ? this.padOwners.get(v.spawn.flag) ?? null : v.team;
  }
  canRespawn(v, pose = this.padPosition(v)) {
    const hull = { ...v, ...(isAircraft(v.type) ? flightRest() : {}), ...pose, pitch: 0, roll: 0, hp: vehicleMaxHp(v) };
    if (!this.clearHull(hull, hull.x, hull.y, hull.z, hull.yaw)) return false;
    if(this.placement(hull,hull.x,hull.z)==null)return false;
    for (const p of this.engine.entities.values()) if (p.state === 'alive' && !p.vehicleId && playerHullContact(p, hull)) return false;
    return true;
  }
  /** Place a fresh hull at a pad pose for a team; no events (quiet). */
  respawnAt(v, pose, team) {
    rest(v);
    Object.assign(v, { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, pitch: 0, roll: 0, team,
      hp: vehicleMaxHp(v), turretYaw: pose.yaw, turretPitch: 0, engineOn: false, wreckAge: 0, respawnIn: 0,
      occupantId: null, seatOccupants: this.emptySeats(v.type) });
    this.freshCondition(v);
    this.mounts.reset(v);
    this.lastDrivers.delete(v.id); this.fallSpeeds.delete(v.id); this.boundaryAvoidance.delete(v.id);
    if (isAircraft(v.type)) v.grounded = true;
  }
  /** Try the pad and its alternates; after a long block, nudge infantry off the pad. */
  tryRespawn(v, dt) {
    const team = this.padTeam(v);
    if (team == null) return false;
    const pad = this.padPosition(v, team);
    for (const pose of this.padCandidates(v, pad)) if (this.canRespawn(v, pose)) { this.respawnAt(v, pose, team); return true; }
    v.padBlockedFor = (v.padBlockedFor || 0) + dt;
    if (v.padBlockedFor >= VEHICLE_LIFECYCLE.padNudgeSeconds) this.nudgeFromPad(v, pad);
    return false;
  }
  nudgeFromPad(v, pad) {
    const hull = { ...v, ...(isAircraft(v.type) ? flightRest() : {}), ...pad, pitch: 0, roll: 0, hp: vehicleMaxHp(v) };
    const solidAt = (x, y, z) => this.solid(x, y, z), others = this.obstacles(v);
    for (const p of this.engine.entities.values()) {
      if (p.state !== 'alive' || p.vehicleId || !playerHullContact(p, hull)) continue;
      const push = vehiclePlayerPush(p, hull, solidAt, others);
      if (push && !push.blocked) { Object.assign(p, push.position, { vx: 0, vz: 0, vault: null, slide: null }); continue; }
      const alternate = this.alternatePush(p, hull, solidAt, others);
      if (alternate) Object.assign(p, alternate, { vx: 0, vz: 0, vault: null, slide: null });
    }
  }
  /** Flag pads follow the flag owner; called by the mode on capture and neutralize. */
  setPadOwner(flagId, team) {
    if (typeof flagId !== 'string') return false;
    const owner = team === 'alpha' || team === 'bravo' ? team : null;
    this.padOwners.set(flagId, owner);
    for (const v of this.vehicles.values()) {
      if (v.spawn.flag !== flagId) continue;
      if (v.padInactive) {
        if (owner) { v.team = owner; v.padInactive = false; v.respawnIn = 0; v.wreckAge = Infinity; }
        continue;
      }
      if (!owner || !(v.hp > 0) || this.crew(v).length) continue;
      const pad = this.padPosition(v, v.team);
      if (Math.hypot(v.x - pad.x, v.z - pad.z) <= VEHICLE_LIFECYCLE.padSwitchDistance) v.team = owner;
    }
    return true;
  }
  /** Mark a hull spotted for a team until `untilMs` (engine clock). */
  spot(vehicleId, team, untilMs) {
    const v = this.vehicles.get(vehicleId);
    if (!v || !(v.hp > 0) || typeof team !== 'string' || !Number.isFinite(untilMs)) return false;
    v.spotted[team] = Math.max(v.spotted[team] ?? 0, untilMs);
    return true;
  }
  repair(vehicleId, hp, byPlayer = null) { return this.damageModel.repair(this.vehicles.get(vehicleId), hp, byPlayer); }

  // ---- infantry contact -------------------------------------------------------

  /** Shove a pinned body sideways along the hull's axes, the nearest free way out. */
  alternatePush(body, v, solidAt, hulls) {
    const height = infantryHeight(body), dirs = [];
    for (const angle of [Math.PI / 2, -Math.PI / 2, 0, Math.PI]) {
      const dir = vehicleDirection(v.yaw + angle);
      dirs.push([dir[0], dir[2]]);
    }
    let best = null;
    for (const [nx, nz] of dirs) {
      let free = null;
      for (let d = HEAVY_PUSH_RULES.step; d <= HEAVY_PUSH_RULES.reach; d += HEAVY_PUSH_RULES.step) {
        const x = body.x + nx * d, z = body.z + nz * d;
        if (boxCollides(solidAt, x, body.y, z, height)) break;
        const probe = { ...body, x, z };
        if (hulls.some(other => other !== v && playerHullContact(probe, other, height))) break;
        if (!playerHullContact(probe, v, height)) { free = { x, y: body.y, z, d }; break; }
      }
      if (free && (!best || free.d < best.d)) best = free;
    }
    return best && { x: best.x, y: best.y, z: best.z };
  }
  /** The bodies resolveInfantry considers for a hull at its current pose. */
  infantryInReach(v, body) {
    return !(body.state !== 'alive' || body.vehicleId || body.ghostVehicleId === v.id || Math.hypot(body.x - v.x, body.z - v.z) > VEHICLE_RULES[v.type].radius + 2);
  }
  /** Plan every push before changing a body. A pinned pedestrian stops a light
   * chassis; a slow heavy hull shoves them sideways instead when it can. */
  resolveInfantry(v, previous, driver, dt) {
    const pushes = [], def = vehicleDef(v);
    const solidAt = (x,y,z) => this.solid(x,y,z,isAircraft(v.type));
    let blocked = false, hulls = null;
    for (const body of this.engine.entities.values()) {
      if (!this.infantryInReach(v, body)) continue;
      // Hull list as of the call: nothing changes before the first body in reach.
      hulls ??= [...this.vehicles.values()].filter(solidHull);
      this.infantryTouches++;
      const push = vehiclePlayerPush(body, v, solidAt, hulls);
      if (!push) continue;
      const { contact } = push;
      const yawSpeed = angleDelta(v.yaw, previous.yaw) / dt;
      // Yaw increases rotate the forward vector toward negative X.
      const vx = (v.x - previous.x) / dt + yawSpeed * (body.z - v.z);
      const vz = (v.z - previous.z) / dt - yawSpeed * (body.x - v.x);
      const impactSpeed = Math.max(0, vx * contact.nx + vz * contact.nz, isAircraft(v.type) ? -v.vy : 0);
      this.runover(v, body, driver, impactSpeed);
      if (body.state !== 'alive') continue;
      if (push.blocked && def.handling === 'tracked' && Math.abs(v.speed) < HEAVY_PUSH_RULES.maxSpeed) {
        const alternate = this.alternatePush(body, v, solidAt, hulls);
        if (alternate) { pushes.push({ body, position: alternate }); continue; }
      }
      blocked ||= push.blocked;
      if (!push.blocked) pushes.push({ body, position: push.position });
    }
    if (blocked) return false;
    for (const { body, position } of pushes) {
      Object.assign(body, position, { vx: 0, vz: 0, vault: null, slide: null });
      // Vehicles advance before foot movement; the next movement sample records
      // this pushed pose in the ordinary authoritative rewind trail.
    }
    return true;
  }

  // ---- flight -------------------------------------------------------------------

  /** A parked, crewless, grounded aircraft at rest skips its flight substeps
   * until terrain changes or someone boards (the profiled CPU hog). */
  asleep(v) {
    const resting = v.grounded && !v.occupantId && !vehicleSeats(v).some(seat => vehicleSeatOccupantId(v, seat.id) != null) && !(v.rotorSpeed > 1e-4) && !(v.enginePower > 1e-4)
      && !(v.throttle > 1e-4) && Math.abs(v.vx) < 1e-6 && Math.abs(v.vy) < 1e-6 && Math.abs(v.vz) < 1e-6 && !(Math.abs(v.speed) > 1e-6);
    if (!resting) { v.sleepRevision = null; return false; }
    const revision = this.engine.blockRevision ?? 0;
    if (v.sleepRevision === revision) return true;
    v.sleepRevision = revision;
    return false;
  }
  /** Aircraft move through the same voxel world, with sky above the voxel data.
   * Small spatial sweeps include descending roofs, wings and living hulls. */
  advanceAircraft(v, p, input, controls, dt) {
    const def = VEHICLE_RULES[v.type], handling = vehicleDef(v).handling, driver = this.momentumDriver(v);
    const fixedWing = handling === 'fixedwing';
    if (this.asleep(v)) return;
    const flightCeiling=def.ceiling??180,ceilingGap=1e-5;
    for (const axis of ['x','y','z']) if (!Number.isFinite(v[axis])) v[axis] = v.spawn[axis];
    for (const axis of ['yaw','pitch','roll','vx','vy','vz','pitchRate','rollRate','rudderRate','yawRate']) if (!Number.isFinite(v[axis])) v[axis] = 0;
    const floor = this.placement(v, v.x, v.z);
    v.grounded = floor != null && Math.abs(v.y - floor) < 0.08 && v.vy <= 0.2;
    if (v.grounded) v.y = floor;
    if(fixedWing) {
      const dataHeight=this.engine.world.dimensions?.sy??180;
      const terrain=this.ground(v.x,v.z,Math.min(v.y+0.01,dataHeight),0,dataHeight);
      const clearance=terrain==null?Infinity:v.y-terrain;
      const previousGear=v.gearDown;
      if(v.grounded||clearance<5&&v.vy<=1)v.gearDown=true;
      else if(clearance>5)v.gearDown=false;
      // Deployment adds wheels and struts below the stowed hull. Keep the
      // existing clear configuration until those real boxes fit at this pose.
      if(v.gearDown!==previousGear&&!this.clearHull(v,v.x,v.y,v.z))v.gearDown=previousGear;
    }
    const safeAttitude={yaw:v.yaw,pitch:v.pitch,roll:v.roll,y:v.y};
    const power = v.disabled ? VEHICLE_DAMAGE_RULES.disabledPower : 1;
    const lift = controls.allowed ? clamp(input.vehicleLift ?? ((input.keys?.jump ? 1 : 0) - (input.keys?.sprint ? 1 : 0)), -1, 1) : 0;
    const flightInput = { ...controls, throttle: controls.throttle * power, active: controls.allowed, grounded: v.grounded,
      lift: lift > 0 ? lift * power : lift,
      yaw: input.yaw ?? p?.yaw ?? v.yaw, pitch: input.pitch ?? p?.pitch ?? v.pitch };
    for (const axis of ['Pitch','Roll','Yaw']) {
      const field = `vehicle${axis}Control`;
      if (input[field] !== undefined) flightInput[`${axis.toLowerCase()}Control`] = controls.allowed ? clamp(input[field], -1, 1) : 0;
    }
    // Keep the recovery turn engaged until the flight path is safely inward.
    // Releasing on a single projected sample lets persistent mouse aim turn
    // back toward the edge before the aircraft has finished banking.
    const dimensions = this.engine.world.dimensions;
    if (dimensions && !v.grounded && controls.allowed) {
      const horizontal=Math.hypot(v.vx,v.vz), bank=Math.min(def.maxBank,1.05);
      const rate=fixedWing?Math.min(def.turn,def.gravity*Math.tan(bank)/Math.max(def.takeoffSpeed,horizontal)):def.turn;
      const radius=horizontal/Math.max(.1,rate);
      // Allow space for actual banking and momentum. Rotor tilt takes time to
      // stop a helicopter; a fixed-wing jet needs a speed-dependent turn arc.
      const stopping=horizontal*horizontal/(2*def.gravity*Math.tan(fixedWing?bank:Math.min(def.maxBank,.4)));
      const margin=Math.min(Math.min(dimensions.sx,dimensions.sz)*.43,
        fixedWing?Math.max(110,radius+horizontal*1.2+20):Math.max(30,stopping+horizontal*1.1+15));
      const lookahead = fixedWing ? 2 : 1.6;
      const futureX = v.x + v.vx * lookahead, futureZ = v.z + v.vz * lookahead;
      const threatened = futureX < margin && v.vx < -0.1 || futureX > dimensions.sx - margin && v.vx > 0.1
        || futureZ < margin && v.vz < -0.1 || futureZ > dimensions.sz - margin && v.vz > 0.1;
      let recovery = this.boundaryAvoidance.get(v.id);
      if(threatened&&!recovery) {
        const pathYaw=horizontal>1?Math.atan2(-v.vx,-v.vz):v.yaw;
        const clearance=sign=>{
          const cx=v.x-sign*Math.cos(pathYaw)*radius,cz=v.z+sign*Math.sin(pathYaw)*radius;
          return Math.min(cx-radius,dimensions.sx-cx-radius,cz-radius,dimensions.sz-cz-radius);
        };
        recovery={turnSense:clearance(1)>clearance(-1)?1:-1,turning:fixedWing,radius,
          altitude:clamp(v.y,Math.min(dimensions.sy+15,def.ceiling-40),def.ceiling-35)};
        this.boundaryAvoidance.set(v.id,recovery);
      }
      if(recovery) {
        const dx=dimensions.sx/2-v.x,dz=dimensions.sz/2-v.z,centerYaw=Math.atan2(-dx,-dz);
        // A jet hands back only on a course that clears the trigger margin too;
        // on a compact map a narrower release band re-engages on the next tick.
        const safeMargin=Math.min(Math.max(fixedWing?110:30,recovery.radius*.75+40,fixedWing?margin:0),Math.min(dimensions.sx,dimensions.sz)*.32);
        const inward=v.vx*dx+v.vz*dz>0;
        const inside=(x,z)=>x>safeMargin&&x<dimensions.sx-safeMargin&&z>safeMargin&&z<dimensions.sz-safeMargin;
        const interior=inside(v.x,v.z);
        // Include spool-up travel while a slow jet regains surface authority.
        const levelingTime=4.5,courseSpeed=Math.max(48,horizontal);
        const safeCourse=inside(v.x-Math.sin(v.yaw)*courseSpeed*levelingTime,v.z-Math.cos(v.yaw)*courseSpeed*levelingTime)
          &&inside(v.x+v.vx*levelingTime,v.z+v.vz*levelingTime);
        // A moving center target can sustain an orbit: the jet remains banked
        // while its target bearing turns at the same rate. Once the aircraft
        // is safely inward, hold that course and unwind the real control
        // surfaces before handing the pilot back their manual inputs.
        if(fixedWing&&recovery.heading===undefined&&interior&&inward&&safeCourse&&Math.abs(angleDelta(centerYaw,v.yaw))<1.35) {
          recovery.heading=v.yaw;recovery.turning=false;
        }
        if(recovery.heading!==undefined&&!safeCourse)delete recovery.heading;
        const targetYaw=recovery.heading??centerYaw,error=angleDelta(targetYaw,v.yaw);
        const leveled=recovery.heading!==undefined&&safeCourse&&Math.abs(error)<.3&&Math.abs(v.roll)<.2&&Math.abs(v.rollRate)<.3;
        const rotorAligned=!fixedWing&&inward&&Math.abs(error)<.55&&Math.abs(v.roll)<.4;
        if(interior&&(leveled||rotorAligned)) this.boundaryAvoidance.delete(v.id);
        else {
          // The safety pilot requests bounded attitudes through the same rate
          // controller and dynamics as a human. Explicit neutral manual axes
          // must not mask this temporary heading/altitude request.
          delete flightInput.pitchControl;delete flightInput.rollControl;delete flightInput.yawControl;
          if(Math.abs(error)<.25)recovery.turning=false;
          flightInput.yaw=targetYaw;
          flightInput.steer=recovery.turning?-recovery.turnSense*Math.min(1,Math.abs(error)/.6):0;
          if(fixedWing) {
            const desiredClimb=clamp((recovery.altitude-v.y)*.4,-6,8);
            const verticalAcceleration=clamp((desiredClimb-v.vy)*1.2,-3,5);
            const cosBank=Math.max(.4,Math.cos(v.roll));
            const pressure=(Math.max(def.takeoffSpeed,horizontal)/def.takeoffSpeed)**2;
            const coefficient=(def.gravity+verticalAcceleration)/(def.gravity*pressure*cosBank);
            const aoa=clamp((coefficient-def.liftIncidence)/def.liftSlope,-.12,.2);
            const flightPath=Math.atan2(v.vy,Math.max(1,horizontal));
            flightInput.pitch=clamp(flightPath+aoa/cosBank,def.minPitch,def.maxPitch);
            flightInput.lift=0;
            flightInput.throttle=v.speed>48?-1:v.speed<40?1:0;
            flightInput.brake=0;
          } else {
            flightInput.throttle=1;flightInput.lift=0;
            flightInput.pitch=0;
            flightInput.brake=Math.abs(error)>.5?1:0;
          }
        }
      }
    } else this.boundaryAvoidance.delete(v.id);
    FLIGHT_STEPPERS[handling](v, flightInput, dt, vehicleDef(v));
    if(v.grounded) {
      // Rotation is around the wheel contact, so raising the nose lifts the
      // aircraft root enough to keep its actual rear tire above the runway.
      if(fixedWing)v.pitch=controls.allowed?clamp(v.pitch,-0.08,0.16):0;
      v.roll=0;
      const pivotHeight=this.placement(v,v.x,v.z);
      if(pivotHeight!=null)v.y=pivotHeight;
    }
    v.throttle = clamp(fixedWing ? v.throttle : Math.abs(controls.throttle), 0, 1);
    if (handling === 'rotor') v.enginePower = v.rotorSpeed;
    v.airspeed = Math.max(0, Number.isFinite(v.airspeed) && fixedWing ? v.airspeed : Math.hypot(v.vx, v.vz));
    for (const field of ['yaw','pitch','roll','vx','vy','vz','speed','yawRate','pitchRate','rollRate','rudderRate','rotorSpeed','collective','enginePower','throttle','throttlePower','airspeed'])
      if (!Number.isFinite(v[field])) v[field] = 0;
    // A long wing or tail can pass through a voxel during a turn even when
    // both endpoint attitudes are clear. Sweep its actual compound boxes.
    const requestedAttitude = { yaw: v.yaw, pitch: v.pitch, roll: v.roll, y: v.y };
    const yawDelta = angleDelta(requestedAttitude.yaw, safeAttitude.yaw);
    const arc = Math.abs(yawDelta) + Math.abs(requestedAttitude.pitch-safeAttitude.pitch) + Math.abs(requestedAttitude.roll-safeAttitude.roll);
    const attitudeSteps = Math.max(1, Math.ceil(arc * (def.radius + def.height) * 2 / 0.12));
    // Hull boxes read only type, gear and pose: probe with those, not a copy of the hull.
    const probe = pose => ({ type: v.type, gearDown: v.gearDown, x: v.x, y: pose.y, z: v.z, yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll });
    const supportY = v.grounded ? safeAttitude.y + vehicleSupportOffset(probe(safeAttitude)) : null;
    const attitudeAt = t => {
      const pose = { yaw: safeAttitude.yaw + yawDelta*t,
        pitch: safeAttitude.pitch + (requestedAttitude.pitch-safeAttitude.pitch)*t,
        roll: safeAttitude.roll + (requestedAttitude.roll-safeAttitude.roll)*t,
        y: safeAttitude.y + (requestedAttitude.y-safeAttitude.y)*t };
      if (v.grounded) pose.y = supportY - vehicleSupportOffset(probe(pose));
      else if(pose.y+def.radius+def.height>=flightCeiling-ceilingGap) {
        // Ceiling contact constrains the root height, not all rotation. Sweep
        // the resulting downward pivot so terrain still blocks the airframe.
        const top=Math.max(...vehicleHullParts(probe(pose)).map(part=>part.maxY));
        pose.y-=Math.max(0,top-flightCeiling+ceilingGap);
      }
      return pose;
    };
    let safeFraction = 0;
    Object.assign(v, safeAttitude);
    for (let i=1;i<=attitudeSteps;i++) {
      const fraction=i/attitudeSteps, before={x:v.x,y:v.y,z:v.z,yaw:v.yaw}, pose=attitudeAt(fraction);
      Object.assign(v,pose);
      if (!this.clearHull(v,v.x,v.y,v.z)) {
        let low=safeFraction, high=fraction;
        for(let j=0;j<18;j++) {
          const middle=(low+high)/2;Object.assign(v,attitudeAt(middle));
          if(this.clearHull(v,v.x,v.y,v.z))low=middle;else high=middle;
        }
        Object.assign(v,attitudeAt(low));
        v.yawRate=v.pitchRate=v.rollRate=v.rudderRate=0;
        break;
      }
      if (!this.resolveInfantry(v,before,driver,dt/attitudeSteps)) {
        Object.assign(v,attitudeAt(safeFraction));v.yawRate=v.pitchRate=v.rollRate=v.rudderRate=0;
        break;
      }
      safeFraction=fraction;
    }
    const destination = { x: v.x + v.vx * dt, y: v.y + v.vy * dt, z: v.z + v.vz * dt };
    if(Math.max(v.y,destination.y)+def.radius+def.height>=flightCeiling-ceilingGap) {
      const hullTop=Math.max(...vehicleHullParts(v).map(part=>part.maxY));
      const ceilingRoot=v.y+flightCeiling-ceilingGap-hullTop;
      if(destination.y>ceilingRoot) {
        // Project only the blocked upward component. Tangential flight and
        // descending/elevator escape continue with the real current attitude.
        destination.y=ceilingRoot;v.vy=Math.min(0,v.vy);
        if(fixedWing)v.speed=v.airspeed=Math.hypot(v.vx,v.vy,v.vz);
      }
    }
    // Collide and slide. Each contact removes only the velocity along the
    // blocked axes (voxels are axis aligned), so a graze keeps its tangential
    // motion and only the closing speed into the obstacle counts as a crash.
    // A landing needs the vertical axis itself to have stopped a descent.
    const travel = Math.hypot(destination.x - v.x, destination.y - v.y, destination.z - v.z);
    const taxiing = fixedWing && v.grounded, blockedAxes = new Set(), closing = {}, approach = { vx: v.vx, vy: v.vy, vz: v.vz };
    let target = destination, contact = false, stopped = false, crashSquared = 0;
    for (let pass = 0; pass < 3 && !stopped; pass++) {
      const start = { x: v.x, y: v.y, z: v.z };
      const distance = Math.hypot(target.x - start.x, target.y - start.y, target.z - start.z);
      if (distance < 1e-9) break;
      const steps = Math.max(1, Math.ceil(distance / 0.18));
      let safe = start, hit = null;
      for (let i = 1; i <= steps; i++) {
        const point = { x: start.x + (target.x - start.x) * i / steps,
          y: start.y + (target.y - start.y) * i / steps, z: start.z + (target.z - start.z) * i / steps };
        if (!this.clearHull(v, point.x, point.y, point.z)) {
          let low = 0, high = 1;
          const from = safe;
          for (let j = 0; j < 18; j++) {
            const t = (low + high) / 2;
            if (this.clearHull(v, from.x + (point.x - from.x) * t, from.y + (point.y - from.y) * t, from.z + (point.z - from.z) * t)) low = t; else high = t;
          }
          safe = { x: from.x + (point.x - from.x) * low, y: from.y + (point.y - from.y) * low, z: from.z + (point.z - from.z) * low };
          Object.assign(v, safe);
          hit = point;
          break;
        }
        const before = { x: v.x, y: v.y, z: v.z, yaw: v.yaw };
        Object.assign(v, point);
        if (!this.resolveInfantry(v, before, driver, dt * distance / Math.max(travel, 1e-9) / steps)) {
          const impactVelocity={vx:v.vx,vy:v.vy,vz:v.vz}, speed = travel / dt;
          Object.assign(v, safe); v.vx = v.vy = v.vz = v.speed = v.airspeed = 0;
          // A taxiing jet nudged by a pedestrian never destroys itself.
          const safeTaxi = fixedWing && v.grounded && speed < VEHICLE_LIFECYCLE.plainCollisionSafeSpeed;
          if (speed > 8 && !safeTaxi) this.damage(v.id, def.hp * clamp((speed - 8) / 20, 0, 1), null, { cls: 'collision', impactVelocity });
          stopped = true;
          break;
        }
        safe = point;
      }
      if (stopped || !hit) break;
      contact = true;
      const collisionParts = vehicleHullParts(v, hit.x, hit.y, hit.z);
      const boundary = dimensions && collisionParts.some(({hull})=>hull.minX<0||hull.maxX>dimensions.sx||hull.minZ<0||hull.maxZ>dimensions.sz);
      const ceiling = collisionParts.some(part=>part.maxY>flightCeiling);
      // The contact normal is every axis whose own share of the blocked
      // remainder is obstructed; a pure edge/corner hit blocks all of them.
      const moving = ['x','y','z'].filter(axis => hit[axis] !== safe[axis]);
      let axes = moving.filter(axis => !this.clearHull(v, axis === 'x' ? hit.x : safe.x, axis === 'y' ? hit.y : safe.y, axis === 'z' ? hit.z : safe.z));
      if (!axes.length) axes = moving;
      for (const axis of axes) {
        const component = v[`v${axis}`];
        if (!blockedAxes.has(axis)) closing[axis] = component;
        blockedAxes.add(axis);
        // Map edges and the sky ceiling stop motion without crash damage.
        if (!boundary && !ceiling) crashSquared += component * component;
        v[`v${axis}`] = 0;
      }
      target = Object.fromEntries(['x','y','z'].map(axis => [axis, blockedAxes.has(axis) ? v[axis] : target[axis]]));
    }
    if (contact && !stopped) {
      const landingFloor = this.placement(v, v.x, v.z);
      const landing = blockedAxes.has('y') && closing.y <= 0 && landingFloor != null && Math.abs(landingFloor - v.y) < 0.2;
      const impact = Math.sqrt(crashSquared);
      const gentle = landing && impact <= (handling === 'rotor' ? 6.5 : 8) && Math.abs(v.pitch) < 0.4 && Math.abs(v.roll) < 0.5;
      if (landing) { v.y = landingFloor; v.vy = 0; v.grounded = true; }
      // A hard touchdown ends the run on the spot instead of rolling on.
      if (landing && !gentle) { v.vx = 0; v.vz = 0; }
      v.speed = v.airspeed = fixedWing ? Math.hypot(v.vx, v.vy, v.vz) : Math.hypot(v.vx, v.vz);
      // Taxi bumps below the pedestrian-nudge speed are scrapes, not crashes.
      const threshold = taxiing ? VEHICLE_LIFECYCLE.plainCollisionSafeSpeed : 4;
      if (!gentle && impact > threshold) this.damage(v.id, def.hp * clamp((impact - threshold) / 12, 0, 1), null,
        { cls: 'collision', impactVelocity: approach });
    }
    if (v.hp <= 0) return;
    const supported = this.placement(v, v.x, v.z);
    v.grounded = supported != null && Math.abs(v.y - supported) < 0.08 && v.vy <= 0.2;
    if (v.grounded) { v.y = supported; v.vy = Math.max(0, v.vy); }
    if (p) this.sync(p, v);
  }

  // ---- ground -------------------------------------------------------------------

  /** Blocked by a wall: keep the tangential axis motion (voxel walls are axis aligned). */
  wallSlide(v, x, z) {
    let best = null;
    for (const [cx, cz] of [[x, v.z], [v.x, z]]) {
      const length = Math.hypot(cx - v.x, cz - v.z);
      if (length < 1e-6) continue;
      const floor = this.placement(v, cx, cz);
      if (floor == null && !this.clearHull(v, cx, v.y, cz)) continue;
      if (!best || length > best.length) best = { x: cx, z: cz, floor, length };
    }
    return best;
  }
  advanceGround(v, p, controls, dt) {
    const def = VEHICLE_RULES[v.type], handling = vehicleDef(v).handling, driver = this.momentumDriver(v);
    const previous = { x: v.x, y: v.y, z: v.z, yaw: v.yaw };
    const drive = v.disabled ? VEHICLE_DAMAGE_RULES.disabledDrive : 1;
    GROUND_STEPPERS[handling](v, { throttle: controls.throttle * drive, steer: controls.steer, brake: controls.brake }, dt);
    // A driverless hull at rest with no body in reach: its collision pass is a
    // pure function of the fields, terrain and nearby hulls it reads, so when
    // they all equal the previous pass's inputs, that pass's result is reused.
    const restable = !p && controls.throttle === 0 && v.speed === 0 && !this.fallSpeeds.has(v.id) && !this.infantryNear(v);
    if (restable && this.replayRest(v, 'ground', previous, dt)) return;
    const memo = restable ? this.beginRest(v, 'ground', previous, dt) : null;
    this.moveGround(v, previous, controls, def, driver, dt);
    if (memo) this.endRest(v, memo);
    else this.restMemos.delete(v);
  }
  moveGround(v, previous, controls, def, driver, dt) {
    if (!this.clearHull(v,v.x,v.y,v.z)) { v.yaw=previous.yaw; v.yawRate=0; v.leftTrackSpeed=v.speed; v.rightTrackSpeed=v.speed; }
    const dir=vehicleDirection(v.yaw), x=v.x+dir[0]*v.speed*dt,z=v.z+dir[2]*v.speed*dt;
    const floor=this.placement(v,x,z);
    if(floor!=null || this.clearHull(v,x,v.y,z)) {
      Object.assign(v,{x,z});
      v.y=this.settle(v,floor,dt);
      v.scraping=false;
    } else {
      const travel = Math.abs(v.speed) * dt, slide = travel > 1e-6 ? this.wallSlide(v, x, z) : null;
      const impact=Math.abs(v.speed), threshold=Math.max(8,def.speed*0.55);
      if (slide) {
        const normal = Math.sqrt(Math.max(0, 1 - (slide.length / travel) ** 2)), normalImpact = impact * normal;
        Object.assign(v, { x: slide.x, z: slide.z });
        v.y = this.settle(v, slide.floor, dt);
        if (!v.scraping && normalImpact > threshold) this.damage(v.id, def.hp*clamp((normalImpact-threshold)/(def.speed-threshold),0,1), null, { cls: 'collision',
          impactVelocity: { vx: dir[0]*impact, vy: -(this.fallSpeeds.get(v.id)||0), vz: dir[2]*impact } });
        v.speed *= Math.exp(-WALL_SLIDE_RULES.scrape * normal * dt);
        v.scraping = true;
      } else {
        v.speed=0; v.leftTrackSpeed= -v.yawRate * (def.width || 0) / 2; v.rightTrackSpeed= v.yawRate * (def.width || 0) / 2;
        if(impact>threshold && !v.scraping)this.damage(v.id,def.hp*clamp((impact-threshold)/(def.speed-threshold),0,1),null,{cls:'collision',
          impactVelocity:{vx:dir[0]*impact,vy:-(this.fallSpeeds.get(v.id)||0),vz:dir[2]*impact}});
        v.scraping = false;
        v.y=this.settle(v,this.placement(v,v.x,v.z),dt);
      }
    }
    if(v.hp<=0)return;
    if (!this.resolveInfantry(v, previous, driver, dt)) {
      Object.assign(v, previous);
      rest(v);
      this.fallSpeeds.delete(v.id);
    }
    Object.assign(v,{vx:(v.x-previous.x)/dt,vy:(v.y-previous.y)/dt,vz:(v.z-previous.z)/dt});
    // A disabled hull that cannot move under throttle reports immobilized.
    if (v.disabled && Math.abs(controls.throttle) > 0.1 && Math.hypot(v.x - previous.x, v.z - previous.z) < 0.02 * dt) v.stuckFor += dt;
    else v.stuckFor = 0;
  }
  infantryNear(v) {
    for (const body of this.engine.entities.values()) if (this.infantryInReach(v, body)) return true;
    return false;
  }
  /** Solid hulls a resting hull's collision pass can touch, with their poses. */
  restNeighbors(v, list = null) {
    const own = VEHICLE_RULES[v.type], reach = own.radius + own.height + 2;
    let j = 0;
    for (const other of this.vehicles.values()) {
      if (other === v || other.id === v.id || !solidHull(other)) continue;
      const rules = VEHICLE_RULES[other.type];
      if (Math.hypot(v.x - other.x, v.z - other.z) > reach + rules.radius + rules.height) continue;
      if (!list) { (this.neighborScratch ??= []).push(other, other.x, other.y, other.z, other.yaw, other.pitch, other.roll, other.gearDown); continue; }
      if (list[j] !== other || !Object.is(list[j+1], other.x) || !Object.is(list[j+2], other.y) || !Object.is(list[j+3], other.z)
        || !Object.is(list[j+4], other.yaw) || !Object.is(list[j+5], other.pitch) || !Object.is(list[j+6], other.roll) || list[j+7] !== other.gearDown) return false;
      j += 8;
    }
    if (list) return j === list.length;
    const result = this.neighborScratch; this.neighborScratch = null;
    return result ?? [];
  }
  beginRest(v, kind, previous, dt) {
    const fields = kind === 'ground' ? GROUND_REST_INPUTS : WRECK_REST_INPUTS;
    return { kind, dt, world: this.engine.world, revision: this.engine.blockRevision ?? 0, hp: v.hp, touches: this.infantryTouches,
      pre: previous ? [previous.x, previous.y, previous.z, previous.yaw] : null, inputs: readFields(v, fields), neighbors: this.restNeighbors(v), outputs: null };
  }
  endRest(v, memo) {
    if (!Object.is(v.hp, memo.hp) || memo.touches !== this.infantryTouches || this.fallSpeeds.has(v.id)) { this.restMemos.delete(v); return; }
    memo.outputs = readFields(v, memo.kind === 'ground' ? GROUND_REST_OUTPUTS : WRECK_REST_OUTPUTS);
    this.restMemos.set(v, memo);
  }
  replayRest(v, kind, previous, dt) {
    const memo = this.restMemos.get(v);
    if (!memo || memo.kind !== kind || memo.dt !== dt || memo.world !== this.engine.world || memo.revision !== (this.engine.blockRevision ?? 0)) return false;
    if (previous && !(Object.is(memo.pre[0], previous.x) && Object.is(memo.pre[1], previous.y) && Object.is(memo.pre[2], previous.z) && Object.is(memo.pre[3], previous.yaw))) return false;
    if (!fieldsMatch(v, kind === 'ground' ? GROUND_REST_INPUTS : WRECK_REST_INPUTS, memo.inputs) || !this.restNeighbors(v, memo.neighbors)) return false;
    writeFields(v, kind === 'ground' ? GROUND_REST_OUTPUTS : WRECK_REST_OUTPUTS, memo.outputs);
    return true;
  }
  runover(v, victim, driver, impactSpeed) {
    const key = `${v.id}:${victim.id}`, prior = this.infantryContacts.get(key);
    const renewed = !prior || this.contactClock - prior.lastContact > RUNOVER_RULES.separateSeconds;
    const contact = prior || { vehicleId: v.id, playerId: String(victim.id), lastDamage: -Infinity };
    contact.lastContact = this.contactClock;
    this.infantryContacts.set(key, contact);
    if (!(impactSpeed >= RUNOVER_RULES.minSpeed) || !driver || driver === victim
        || driver.state !== 'alive' || this.engine.entities.get(String(driver.id)) !== driver
        || this.engine.mode?.canFire?.(driver) === false
        || this.teamOf(driver) === this.teamOf(victim)
        || this.engine.mode?.canDamage?.(driver, victim) === false
        || (!renewed && Number.isFinite(contact.lastDamage))
        || this.contactClock - contact.lastDamage < RUNOVER_RULES.cooldownSeconds
        || typeof victim.takeDamage !== 'function') return;
    const damage = Math.min(RUNOVER_RULES.maxDamage, 12 + (impactSpeed - RUNOVER_RULES.minSpeed) * 8);
    contact.lastDamage = this.contactClock;
    const lethal = victim.takeDamage(damage, false, driver, 'vehicle');
    this.engine.tickEvents?.push(evHit(driver.id, victim.id, damage, false,
      [victim.x, victim.y + 0.8, victim.z], victim.lastDamage));
    if (lethal) this.engine.killPlayer?.(victim, driver, 'vehicle', false);
  }

  // ---- tick ---------------------------------------------------------------------

  step(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.nowMs();
    // Fixed maximum substep prevents thin voxel walls being crossed at low rates.
    const duration=Math.min(dt,0.25), steps=Math.ceil(duration*120), h=duration/steps;
    for(let i=0;i<steps;i++) this.advance(h);
    for (const v of this.vehicles.values()) {
      if (!(v.hp > 0)) continue;
      this.updateAttitude(v, duration);
      this.mounts.step(v, duration);
      this.checkAbandoned(v, duration);
      if (v.hp > 0) this.syncCrew(v);
    }
    this.locks.step(duration);
    this.damageModel.flush();
    for (const p of this.engine.entities.values()) if (p.ghostVehicleId != null && !(p.ghostUntil > this.contactClock)) { p.ghostVehicleId = null; p.ghostUntil = 0; }
  }
  /** Ground hulls pitch and roll with the voxel support under them. */
  updateAttitude(v, dt) {
    if (isAircraft(v.type)) return;
    const revision = this.engine.blockRevision ?? 0, seen = this.attitudeKeys.get(v);
    // An identical pose and revision rebuild the identical key string.
    if (!(seen && seen.key === v.attitudeKey && Object.is(seen.x, v.x) && Object.is(seen.y, v.y) && Object.is(seen.z, v.z)
        && Object.is(seen.yaw, v.yaw) && seen.revision === revision)) {
      const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)},${v.yaw.toFixed(4)},${revision}`;
      if (key !== v.attitudeKey) {
        v.attitudeKey = key;
        v.attitudeTarget = groundAttitude((x, y, z) => this.engine.world.getBlock(x, y, z), v.type, v.x, v.z, v.yaw, v.y);
      }
      this.attitudeKeys.set(v, { key, x: v.x, y: v.y, z: v.z, yaw: v.yaw, revision });
    }
    const target = v.attitudeTarget ?? { pitch: 0, roll: 0 }, blend = Math.min(1, dt * 12);
    v.pitch = finite(v.pitch) + (target.pitch - finite(v.pitch)) * blend;
    v.roll = finite(v.roll) + (target.roll - finite(v.roll)) * blend;
    if (Math.abs(v.pitch - target.pitch) < 1e-4) v.pitch = target.pitch;
    if (Math.abs(v.roll - target.roll) < 1e-4) v.roll = target.roll;
  }
  /** Crewless hulls far from their pad, undamaged for a while, return to it quietly. */
  checkAbandoned(v, dt) {
    if (this.crew(v).length) { v.crewlessFor = 0; return; }
    v.crewlessFor = (v.crewlessFor || 0) + dt;
    const rules = VEHICLE_LIFECYCLE;
    if (v.crewlessFor < rules.abandonSeconds || this.nowMs() - (v.lastDamagedAt ?? -Infinity) < rules.abandonUndamagedSeconds * 1000) return;
    const team = this.padTeam(v);
    if (team == null) return;
    const pad = this.padPosition(v, team);
    if (Math.hypot(v.x - pad.x, v.z - pad.z) <= rules.abandonDistance) return;
    for (const pose of this.padCandidates(v, pad)) if (this.canRespawn(v, pose)) { this.respawnAt(v, pose, team); return; }
  }
  advanceWreck(v, dt) {
    v.wreckAge += dt;
    if(!isAircraft(v.type)) {
      // A ground wreck keeps the hull's gravity: one killed mid-air or over its
      // own crater falls until it rests, then sleeps until terrain changes.
      const revision = this.engine.blockRevision ?? 0;
      if (v.wreckRestRevision === revision) return;
      const y = v.y;
      v.y = this.settle(v, this.placement(v, v.x, v.z), dt);
      v.wreckRestRevision = v.y === y && !this.fallSpeeds.has(v.id) ? revision : null;
      return;
    }
    // A wreck at rest replays its last sweep while its inputs are unchanged.
    const restable = !v.vx && !v.vy && !v.vz;
    if (restable && this.replayRest(v, 'wreck', null, dt)) return;
    const memo = restable ? this.beginRest(v, 'wreck', null, dt) : null;
    this.moveWreck(v, dt);
    if (memo) this.endRest(v, memo);
    else this.restMemos.delete(v);
  }
  moveWreck(v, dt) {
    const def=VEHICLE_RULES[v.type];
    v.vx=(v.vx || 0)*Math.exp(-0.12*dt); v.vz=(v.vz || 0)*Math.exp(-0.12*dt);
    v.vy=Math.max(-60,(v.vy || 0)-(def.gravity || 9.81)*dt);
    const start={x:v.x,y:v.y,z:v.z}, destination={x:v.x+v.vx*dt,y:v.y+v.vy*dt,z:v.z+v.vz*dt};
    const distance=Math.hypot(destination.x-start.x,destination.y-start.y,destination.z-start.z), steps=Math.max(1,Math.ceil(distance/0.16));
    let safe=start;
    for(let i=1;i<=steps;i++) {
      const point={x:start.x+(destination.x-start.x)*i/steps,y:start.y+(destination.y-start.y)*i/steps,z:start.z+(destination.z-start.z)*i/steps};
      if(!this.clearHull(v,point.x,point.y,point.z)) {
        let low=0,high=1;
        for(let j=0;j<20;j++) {
          const t=(low+high)/2;
          if(this.clearHull(v,safe.x+(point.x-safe.x)*t,safe.y+(point.y-safe.y)*t,safe.z+(point.z-safe.z)*t))low=t;else high=t;
        }
        v.x=safe.x+(point.x-safe.x)*low; v.y=safe.y+(point.y-safe.y)*low; v.z=safe.z+(point.z-safe.z)*low;
        v.vx=v.vy=v.vz=v.speed=v.airspeed=0;
        const floor=this.placement(v,v.x,v.z);
        v.grounded=floor!=null&&Math.abs(v.y-floor)<0.08;
        return;
      }
      Object.assign(v,point);safe=point;
    }
    v.grounded=false;v.speed=v.airspeed=Math.hypot(v.vx,v.vy,v.vz);
  }
  advance(dt) {
    this.contactClock += dt;
    for (const v of this.vehicles.values()) this.cleanCrew(v);
    for (const p of this.engine.entities.values()) if ((p.vehicleId || p.vehicleSeatId) && !this.seatFor(p)) this.release(p);
    for (const [key, contact] of this.infantryContacts) {
      const body = this.engine.entities.get(contact.playerId), v = this.vehicles.get(contact.vehicleId);
      if (!body || body.state !== 'alive' || body.vehicleId || !v || v.hp <= 0
          || this.contactClock - contact.lastContact > RUNOVER_RULES.cooldownSeconds * 2) this.infantryContacts.delete(key);
    }
    for(const v of this.vehicles.values()) {
      if(!(v.hp>0)) {
        if (v.padInactive) continue;
        this.advanceWreck(v,dt);v.respawnIn=Math.max(0,v.respawnIn-dt);
        if(v.respawnIn===0) this.tryRespawn(v, dt);
        continue;
      }
      this.damageModel.step(v, dt);
      if (!(v.hp > 0)) continue;
      const p=this.seatOccupant(v, vehicleDriverSeat(v)?.id ?? 'driver');
      let input=p?.input || {};
      // A fresh human pilot of an airborne hull holds the stick neutral until
      // their client's first mounted packet (vehicleControlId) arrives.
      if (p && p.seatGraceUntil > this.contactClock && p.seatGraceVehicleId === v.id && input.vehicleControlId !== v.id) input = TAKEOVER_HOLD_INPUT;
      const k=input.keys || {};
      const allowed = this.canOperate(p);
      v.engineOn=allowed;
      const throttle=allowed ? clamp(input.vehicleThrottle ?? ((k.f?1:0)-(k.b?1:0)),-1,1) : 0;
      const handling = vehicleDef(v).handling;
      if (handling === 'rotor' || handling === 'fixedwing') {
        const steer = allowed ? clamp(input.vehicleSteer ?? ((k.r?1:0)-(k.l?1:0)),-1,1) : 0;
        this.advanceAircraft(v, p, input, { allowed, throttle, steer, brake: allowed ? clamp(input.vehicleBrake ?? (k.crouch ? 1 : 0), 0, 1) : 0 }, dt);
      } else {
        // An abandoned wheeled hull lets its steering unwind instead of snapping straight.
        const coastSteer = handling==='wheeled' ? clamp((v.visualSteer || 0)*Math.exp(-2.8*dt)/(0.43/(1+(Math.abs(v.speed)/15)**2)),-1,1) : 0;
        const steer=allowed ? clamp(input.vehicleSteer ?? ((k.r?1:0)-(k.l?1:0)),-1,1) : coastSteer;
        const brake = allowed ? clamp(input.vehicleBrake ?? (k.jump ? 1 : 0), 0, 1) : 0;
        this.advanceGround(v, p, { throttle, steer, brake }, dt);
      }
      if (v.hp > 0) this.syncCrew(v);
    }
  }

  // ---- damage -------------------------------------------------------------------

  /** Damage one hull. opts.cls is a contract damage class (or 'collision');
   * legacy callers pass explosive:true for unmitigated physical damage. */
  damage(id, amount, attacker, { explosive = false, cls = null, point = null, origin = null, impactVelocity = null, sourceTeam = null } = {}) {
    return this.damageModel.apply(this.vehicles.get(id), amount, attacker,
      { cls: cls ?? (explosive ? 'collision' : 'small'), point, origin, impactVelocity, sourceTeam });
  }
  /** Hull death: crew die once, events fire once, the wreck blast queues. */
  destroy(v, attacker, { sourceTeam = null } = {}) {
    const physicalImpact=v.impactVelocity;
    const killer=attacker || (sourceTeam==null && physicalImpact ? this.momentumDriver(v) : null), dir=vehicleDirection(v.yaw), velocity=physicalImpact ||
      (isAircraft(v.type) ? {vx:v.vx || 0,vy:v.vy || 0,vz:v.vz || 0} : {vx:dir[0]*v.speed,vy:-(this.fallSpeeds.get(v.id)||0),vz:dir[2]*v.speed});
    delete v.impactVelocity;
    // A ground hull killed mid-fall keeps its fall speed as a wreck.
    if (isAircraft(v.type)) this.fallSpeeds.delete(v.id);
    v.wreckRestRevision = null;
    this.boundaryAvoidance.delete(v.id);this.lastDrivers.delete(v.id);
    v.hp=0; v.respawnIn=vehicleDef(v).respawnSeconds;v.wreckAge=0;v.engineOn=false;
    if(isAircraft(v.type)) Object.assign(v,velocity,{throttle:0,enginePower:0,throttlePower:0,rotorSpeed:0,collective:0,yawRate:0,pitchRate:0,rollRate:0,rudderRate:0});
    else rest(v);
    const crew=this.crew(v);
    let crewKilled=0;
    // A hull lost to its own crash (no enemy behind it) kills its crew with the
    // kill key 'crash' and no killer, never a "roadkill" of the driver itself.
    const crashed = !attacker && sourceTeam == null && !!physicalImpact;
    for(const p of crew) {
      this.release(p);
      if(p.state==='alive') {
        const enemyKiller = killer && this.teamOf(killer) !== v.team ? killer : null;
        const crewKey = crashed && !enemyKiller ? 'crash' : 'vehicle';
        const crewKiller = crewKey === 'crash' ? null : killer && (killer === p || this.teamOf(killer) !== v.team) ? killer : null;
        if(typeof p.takeDamage==='function') {
          const crewDamage=Math.max(1,(Number.isFinite(p.hp)?p.hp:100)+(Number.isFinite(p.armor)?Math.max(0,p.armor):0));
          p.takeDamage(crewDamage,false,crewKiller,crewKey);
          this.engine.tickEvents?.push(evHit(crewKiller?.id || '',p.id,crewDamage,false,[p.x,p.y+0.8,p.z],p.lastDamage));
        }
        this.engine.killPlayer?.(p,crewKiller,crewKey,false);
        if (p.state !== 'alive') crewKilled++;
      }
    }
    v.occupantId=null; v.seatOccupants=this.emptySeats(v.type);
    const assists = this.damageModel.assists(v, killer);
    this.damageModel.flushVehicle(v);
    this.damageModel.emit('vehicle_destroyed', {t:'ev',kind:'vehicle_destroyed',vehicleId:v.id,vehicleType:v.type,type:v.type,team:v.team,
      pos:[q(v.x,100),q(v.y,100),q(v.z,100)],velocity:[q(velocity.vx,100),q(velocity.vy,100),q(velocity.vz,100)],blastRadius:vehicleDef(v).destruction.radius,
      attacker:killer?.id ?? null,assists,crewKilled}, v);
    Object.assign(v, { disabled: false, burning: false, disabledBy: null, lk: 0 });
    v.damageLog.clear();
    this.locks.breakLocks(v);
    this.destructionQueue.push({vehicle:v,attacker:killer,sourceTeam:sourceTeam ?? v.team});
    // Marking every hull dead before adding it to this queue prevents both
    // recursive call stacks and a chain returning to the original chassis.
    if(!this.detonating) {
      this.detonating=true;
      try { for(let i=0;i<this.destructionQueue.length;i++) {
        const blast=this.destructionQueue[i];vehicleDestructionBlast(this,blast.vehicle,blast.attacker,{sourceTeam:blast.sourceTeam});
      } } finally {this.destructionQueue.length=0;this.detonating=false;}
    }
  }
  /** Blast damage to every hull in reach with an unobstructed line; the zone
   * comes from the blast direction. */
  explosion(origin,radius,damage,attacker,{cls='explosive',sourceTeam=null,ignoreId=null}={}) {
    if(!Array.isArray(origin)||!origin.every(Number.isFinite)||!(radius>0)||!(damage>0))return;
    for(const v of this.vehicles.values()) {
      if(!(v.hp>0) || v.id===ignoreId || (!attacker && sourceTeam!=null && v.team===sourceTeam))continue;
      const points=vehicleHullParts(v).map(part=>nearestHullPoint(part,origin));
      let distance=Infinity;
      for(const point of points) {
        const delta=point.map((n,i)=>n-origin[i]),d=Math.hypot(...delta);
        if(d>=radius||d>=distance)continue;
        if(d>0.04&&raycastVoxels((x,y,z)=>this.solid(x,y,z,true),...origin,...delta,d-0.03))continue;
        distance=d;
      }
      if(distance<radius)this.damageModel.apply(v,damage*(1-distance/radius),attacker,{cls,origin,sourceTeam});
    }
  }
  /** Nearest hull (live or fresh ground wreck) along a ray. `exit` is where the
   * ray leaves an open hull's boxes (def.openCrew): exposed crew inside a jeep
   * or a transport cabin can still be struck. A closed hull's exit is its face. */
  rayHit(origin,dir,maxDistance,ignoreId = null) {
    if(!Array.isArray(origin)||origin.length!==3||!Array.isArray(dir)||dir.length!==3||![...origin,...dir].every(Number.isFinite)||!(maxDistance>=0))return null;
    let best=null;
    for(const v of this.vehicles.values()) {
      if(!solidHull(v) || v.id === ignoreId)continue;
      const reach=VEHICLE_RULES[v.type].radius+VEHICLE_RULES[v.type].height;
      const ox=v.x-origin[0],oy=v.y-origin[1],oz=v.z-origin[2],along=ox*dir[0]+oy*dir[1]+oz*dir[2];
      if(along<-reach||along>maxDistance+reach||ox*ox+oy*oy+oz*oz-along*along>(reach+1)*(reach+1))continue;
      let near=Infinity,exit=-Infinity;
      for(const part of vehicleHullParts(v)) {
        const span=rayHullPartSpan(part,origin,dir,maxDistance);
        if(span){near=Math.min(near,span.near);exit=Math.max(exit,span.far);}
      }
      if(near<Infinity&&(!best||near<best.distance))best={vehicle:v,id:v.id,distance:near,exit:vehicleDef(v).openCrew&&v.hp>0?exit:near,wreck:!(v.hp>0)};
    }return best;
  }
  /** Flying-projectile contact with a solid hull along a segment: the nearest
   * entry, where it leaves the hull's boxes, and the struck face's outward
   * normal. A hull the segment starts inside (a passenger's own seat, a hull
   * parked over a resting grenade) never catches it, so nothing is trapped. */
  projectileHit(origin,dir,maxDistance,ignoreId = null) {
    if(!Array.isArray(origin)||origin.length!==3||!Array.isArray(dir)||dir.length!==3||![...origin,...dir].every(Number.isFinite)||!(maxDistance>=0))return null;
    let best=null;
    for(const v of this.vehicles.values()) {
      if(!solidHull(v) || v.id === ignoreId)continue;
      const reach=VEHICLE_RULES[v.type].radius+VEHICLE_RULES[v.type].height;
      const ox=v.x-origin[0],oy=v.y-origin[1],oz=v.z-origin[2],along=ox*dir[0]+oy*dir[1]+oz*dir[2];
      if(along<-reach||along>maxDistance+reach||ox*ox+oy*oy+oz*oz-along*along>(reach+1)*(reach+1))continue;
      const parts=vehicleHullParts(v);
      if(parts.some(part=>insideHullPart(part,origin)))continue;
      let near=Infinity,exit=-Infinity,struck=null;
      for(const part of parts) {
        const span=rayHullPartSpan(part,origin,dir,maxDistance);
        if(!span)continue;
        exit=Math.max(exit,span.far);
        if(span.near<near){near=span.near;struck=part;}
      }
      if(near<Infinity&&(!best||near<best.distance)) {
        const point=origin.map((n,i)=>n+dir[i]*near);
        best={vehicle:v,id:v.id,distance:near,exit,point,normal:hullFaceNormal(struck,point),wreck:!(v.hp>0),open:!!vehicleDef(v).openCrew&&v.hp>0};
      }
    }
    return best;
  }
  /** Whether a point lies inside a solid hull other than ignoreId (grenade contact). */
  hullContains(x,y,z,ignoreId = null) {
    if(![x,y,z].every(Number.isFinite))return false;
    for(const v of this.vehicles.values()) {
      if(!solidHull(v) || v.id === ignoreId)continue;
      const reach=VEHICLE_RULES[v.type].radius+VEHICLE_RULES[v.type].height+1;
      if((x-v.x)**2+(y-v.y)**2+(z-v.z)**2>reach*reach)continue;
      if(vehicleHullParts(v).some(part=>insideHullPart(part,[x,y,z],0)))return true;
    }
    return false;
  }

  // ---- snapshot -------------------------------------------------------------------

  status(v, now) {
    const S = VEHICLE_STATUS;
    let st = 0;
    if (v.engineOn) st |= S.engine;
    if (v.disabled) st |= S.disabled;
    if (v.burning) st |= S.burning;
    if (v.stuckFor > 1) st |= S.immobilized;
    if (v.flaresUntil > now) st |= S.flares;
    if (v.smokeUntil > now) st |= S.smoke;
    if (isAircraft(v.type) ? v.grounded : !this.fallSpeeds.has(v.id)) st |= S.grounded;
    if (!(v.hp > 0)) st |= S.wreck;
    return st;
  }
  /**
   * Quantized rows (spec §3.3): positions/velocities 2 dp, angles 3 dp, hp
   * integer. Zero-valued presentation numbers and defaults are omitted
   * (readers default them to 0/null): engineOn appears only as false,
   * grounded only as false (aircraft in flight), vx/vy/vz only for aircraft
   * and only when non-zero, sel only for a non-default selection.
   * seatOccupants lists occupied seats only. lk/sp/st are omitted at 0; cmr
   * only for countermeasure hulls.
   */
  row(v, now) {
    const def = vehicleDef(v), air = isAircraft(v.type), handling = def.handling;
    const row = { id: v.id, type: v.type, team: v.team, x: q(v.x, 100), y: q(v.y, 100), z: q(v.z, 100), yaw: q(v.yaw, 1000),
      hp: v.hp > 0 ? Math.ceil(v.hp) : 0 };
    // Readers treat a missing engineOn as running (st carries the engine bit), so only a stopped engine is spelled out.
    if (!v.engineOn) row.engineOn = false;
    const put = (key, value, scale) => { const rounded = q(value, scale); if (rounded !== 0) row[key] = rounded; };
    put('pitch', v.pitch, 1000); put('roll', v.roll, 1000); put('speed', v.speed, 100);
    if (v.occupantId != null) row.occupantId = v.occupantId;
    row.seatOccupants = {};
    for (const [seatId, occupant] of Object.entries(v.seatOccupants || {})) if (occupant != null) row.seatOccupants[seatId] = occupant;
    if (handling === 'tracked') {
      row.turretYaw = q(v.turretYaw, 1000); put('turretPitch', v.turretPitch, 1000);
      put('leftTrackSpeed', v.leftTrackSpeed, 100); put('rightTrackSpeed', v.rightTrackSpeed, 100);
    }
    if (handling === 'wheeled') put('visualSteer', v.visualSteer, 1000);
    if (air) {
      put('vx', v.vx, 100); put('vy', v.vy, 100); put('vz', v.vz, 100);
      // Landed is the default (st grounded bit); flight is spelled out as grounded:false.
      if (!v.grounded) row.grounded = false;
      put('throttle', v.throttle, 100); put('enginePower', v.enginePower, 100);
      if (handling === 'rotor') { put('rotorSpeed', v.rotorSpeed, 100); put('collective', v.collective, 100); }
      else { put('airspeed', v.airspeed, 100); row.gearDown = v.gearDown !== false; if (v.stalled) row.stalled = true; }
    }
    if (v.mounts?.length) row.mounts = this.mounts.rows(v);
    // sel lists multi-weapon seats whose selection differs from the default index 0.
    for (const seat of def.seats) {
      if (seat.mounts.reduce((n, id) => n + def.mounts[id].weapons.length, 0) < 2) continue;
      const index = this.mounts.selectedIndex(v, seat.id);
      if (index > 0) (row.sel ??= {})[seat.id] = index;
    }
    const st = this.status(v, now); if (st) row.st = st;
    if (v.lk > 0) row.lk = v.lk;
    const enemy = v.team === 'alpha' ? 'bravo' : v.team === 'bravo' ? 'alpha' : null;
    if (enemy && v.spotted?.[enemy] > now) row.sp = 1;
    const cmr = this.locks.readiness(v); if (cmr != null) row.cmr = cmr;
    if (v.spawn.flag) row.flag = v.spawn.flag;
    if (!(v.hp > 0)) row.wreckAge = Number.isFinite(v.wreckAge) ? q(v.wreckAge, 10) : 0;
    return row;
  }
  snapshot() {
    const now = this.nowMs(), rows = [];
    for (const v of this.vehicles.values()) if (!v.padInactive) rows.push(this.row(v, now));
    return rows;
  }
}
/** Personal-weapon arc either side of the hull's nose. */
export const PERSONAL_WEAPON_ARC = 100 * Math.PI / 180;
export { solidWreck };
