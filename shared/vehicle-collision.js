/** Driving chassis dimensions include model wheels/tracks, excluding the gun.
 * Colliders come from shared/vehicle-defs.js; the transport reuses the helicopter's. */
import { VEHICLE_DEFS, VEHICLE_LIFECYCLE } from './vehicle-defs.js';
import { VEHICLE_RULES, isAircraft, vehicleLocalPoint } from './vehicles.js';
export const VEHICLE_COLLIDERS = Object.freeze({
  ...Object.fromEntries(Object.entries(VEHICLE_DEFS).map(([type, def]) => [type, def.collider])),
  voxel: Object.freeze({ halfWidth: 0.5, halfLength: 0.5 }),
});
/** A destroyed ground hull stays a solid obstacle for movement and rays for a while. */
export function solidWreck(vehicle) {
  return !!vehicle && !(vehicle.hp > 0) && !vehicle.padInactive && !isAircraft(vehicle.type) && !!VEHICLE_RULES[vehicle.type]
    && Number.isFinite(vehicle.wreckAge) && vehicle.wreckAge < VEHICLE_LIFECYCLE.wreckSolidSeconds;
}
/** Live hulls and solid ground wrecks block bodies, hulls and rays. */
export const solidHull = vehicle => !!vehicle && (vehicle.hp > 0 || solidWreck(vehicle));

// Pose caches. Footprints and hull boxes are pure functions of the hull type
// and pose, and every caller treats them as read-only, so one computed shape
// is shared by all queries at that exact pose (Object.is on every input).
const RING_SIZE = 8;
const footprintRings = new Map();
const ringFor = (rings, type) => {
  let ring = rings.get(type);
  if (!ring) rings.set(type, ring = { next: 0, slots: [] });
  return ring;
};
export function hullFootprint(type, x, z, yaw = 0) {
  const ring = ringFor(footprintRings, type), slots = ring.slots;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (Object.is(s.x, x) && Object.is(s.z, z) && Object.is(s.yaw, yaw)) return s.footprint;
  }
  const { halfWidth, halfLength } = VEHICLE_COLLIDERS[type];
  const footprint = rectangleFootprint(x, z, halfWidth, halfLength, yaw);
  const slot = { x, z, yaw, footprint };
  if (slots.length < RING_SIZE) slots.push(slot); else { slots[ring.next] = slot; ring.next = (ring.next + 1) % RING_SIZE; }
  return footprint;
}
export function rectangleFootprint(x, z, halfWidth, halfLength, yaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw), axes = [[c,-s],[s,c]];
  const corners = [[-1,-1],[-1,1],[1,-1],[1,1]].map(([w,l]) => [x + w*halfWidth*c + l*halfLength*s, z - w*halfWidth*s + l*halfLength*c]);
  return { x,z,halfWidth,halfLength,axes,corners,
    minX: Math.min(corners[0][0],corners[1][0],corners[2][0],corners[3][0]), maxX: Math.max(corners[0][0],corners[1][0],corners[2][0],corners[3][0]),
    minZ: Math.min(corners[0][1],corners[1][1],corners[2][1],corners[3][1]), maxZ: Math.max(corners[0][1],corners[1][1],corners[2][1],corners[3][1]) };
}
/** Minimum translation of b out of a, on the same axes as the overlap test. */
export function footprintContact(a, b) {
  let contact = null;
  for (let k = 0; k < 4; k++) {
    const axis = k < 2 ? a.axes[k] : b.axes[k - 2], ax = axis[0], az = axis[1];
    const pa = a.halfWidth * Math.abs(ax * a.axes[0][0] + az * a.axes[0][1]) + a.halfLength * Math.abs(ax * a.axes[1][0] + az * a.axes[1][1]);
    const pb = b.halfWidth * Math.abs(ax * b.axes[0][0] + az * b.axes[0][1]) + b.halfLength * Math.abs(ax * b.axes[1][0] + az * b.axes[1][1]);
    const distance = (b.x - a.x) * ax + (b.z - a.z) * az;
    const depth = pa + pb - Math.abs(distance);
    if (depth <= 1e-9) return null;
    if (!contact || depth < contact.depth) {
      const sign = distance < 0 ? -1 : 1;
      contact = { depth, nx: ax * sign, nz: az * sign };
    }
  }
  return contact;
}
/** Separating-axis test, allowing exact edge contact without penetration. */
export function footprintsOverlap(a,b) {
  for (let k = 0; k < 4; k++) {
    const axis = k < 2 ? a.axes[k] : b.axes[k - 2], ax = axis[0], az = axis[1];
    const pa = a.halfWidth*Math.abs(ax*a.axes[0][0]+az*a.axes[0][1]) + a.halfLength*Math.abs(ax*a.axes[1][0]+az*a.axes[1][1]);
    const pb = b.halfWidth*Math.abs(ax*b.axes[0][0]+az*b.axes[0][1]) + b.halfLength*Math.abs(ax*b.axes[1][0]+az*b.axes[1][1]);
    if (Math.abs((a.x-b.x)*ax+(a.z-b.z)*az) >= pa+pb-1e-9) return false;
  }
  return true;
}
// The unit voxel footprint hullFootprint('voxel', bx + 0.5, bz + 0.5, 0) has
// axes [[1,-0],[0,1]]; its projections below repeat footprintsOverlap's exact
// arithmetic, so the cell list equals the per-cell overlap test bit for bit.
const VOXEL_AXES = [[Math.cos(0), -Math.sin(0)], [Math.sin(0), Math.cos(0)]];
const footprintCellLists = new WeakMap();
/**
 * Voxel columns a footprint overlaps, as a flat [bx, bz, ...] list in
 * x-major order, identical to testing footprintsOverlap(hull,
 * hullFootprint('voxel', bx + 0.5, bz + 0.5, 0)) for every column of the
 * footprint's bounds. Cached per footprint object (treat as read-only).
 */
export function footprintCells(hull) {
  let cells = footprintCellLists.get(hull);
  if (cells) return cells;
  const thresholds = [], axesX = [], axesZ = [];
  for (let k = 0; k < 4; k++) {
    const axis = k < 2 ? hull.axes[k] : VOXEL_AXES[k - 2], ax = axis[0], az = axis[1];
    const pa = hull.halfWidth*Math.abs(ax*hull.axes[0][0]+az*hull.axes[0][1]) + hull.halfLength*Math.abs(ax*hull.axes[1][0]+az*hull.axes[1][1]);
    const pb = 0.5*Math.abs(ax*VOXEL_AXES[0][0]+az*VOXEL_AXES[0][1]) + 0.5*Math.abs(ax*VOXEL_AXES[1][0]+az*VOXEL_AXES[1][1]);
    thresholds.push(pa+pb-1e-9); axesX.push(ax); axesZ.push(az);
  }
  cells = [];
  const hx = hull.x, hz = hull.z;
  for (let bx = Math.floor(hull.minX); bx < Math.ceil(hull.maxX); bx++)
    for (let bz = Math.floor(hull.minZ); bz < Math.ceil(hull.maxZ); bz++) {
      const cx = bx + 0.5, cz = bz + 0.5;
      let overlap = true;
      for (let k = 0; k < 4; k++) if (Math.abs((hx-cx)*axesX[k]+(hz-cz)*axesZ[k]) >= thresholds[k]) { overlap = false; break; }
      if (overlap) cells.push(bx, bz);
    }
  footprintCellLists.set(hull, cells);
  return cells;
}

const dot3 = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub3 = (a,b) => a.map((n,i)=>n-b[i]);
const cross3 = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const WORLD_AXES = [[1,0,0],[0,1,0],[0,0,1]];
const partsRings = new Map();
const partsByVehicle = new WeakMap();
const finiteOr0 = n => Number.isFinite(n) ? n : 0;
export function vehicleHullParts(vehicle, x=vehicle.x, y=vehicle.y, z=vehicle.z, yaw=vehicle.yaw) {
  const type = vehicle.type, pitch = finiteOr0(vehicle.pitch), roll = finiteOr0(vehicle.roll), gear = vehicle.gearDown !== false;
  const same = s => Object.is(s.x, x) && Object.is(s.y, y) && Object.is(s.z, z) && Object.is(s.yaw, yaw)
    && Object.is(s.pitch, pitch) && Object.is(s.roll, roll) && s.gear === gear && s.type === type;
  // The hull's own pose is queried by every system each tick; other poses
  // (sweeps, probes) share a small per-type ring.
  const own = Object.is(x, vehicle.x) && Object.is(y, vehicle.y) && Object.is(z, vehicle.z) && Object.is(yaw, vehicle.yaw) && typeof vehicle === 'object';
  if (own) { const s = partsByVehicle.get(vehicle); if (s && same(s)) return s.parts; }
  const ring = ringFor(partsRings, type), slots = ring.slots;
  for (let i = 0; i < slots.length; i++) if (same(slots[i])) {
    if (own) partsByVehicle.set(vehicle, slots[i]);
    return slots[i].parts;
  }
  const parts = computeHullParts(vehicle, x, y, z, yaw);
  const slot = { type, x, y, z, yaw, pitch, roll, gear, parts };
  if (own) partsByVehicle.set(vehicle, slot);
  else if (slots.length < RING_SIZE) slots.push(slot); else { slots[ring.next] = slot; ring.next = (ring.next + 1) % RING_SIZE; }
  return parts;
}
const localBoxes = new Map();
/** The hull's local boxes ([lo, hi] pairs of the def), per type and gear state. */
function hullLocalBoxes(type, gear) {
  const key = gear ? type : `${type}|stowed`;
  let local = localBoxes.get(key);
  if (!local) {
    const def = VEHICLE_DEFS[type], shape = def.collider;
    local = def.hullBoxes ? def.hullBoxes.filter((_,index)=>gear||!def.gearBoxes?.includes(index))
      : [[[-shape.halfWidth,0,-shape.halfLength],[shape.halfWidth,def.height,shape.halfLength]]];
    localBoxes.set(key, local);
  }
  return local;
}
/**
 * Oriented boxes of a hull at a pose. The arithmetic is vehicleLocalPoint's,
 * term for term (same operands, same order), so every coordinate is the one
 * the per-point helper produces; only the intermediate arrays are gone.
 */
function computeHullParts(vehicle, x, y, z, yaw) {
  const local = hullLocalBoxes(vehicle.type, vehicle.gearDown !== false);
  // Ground hulls carry the fitted terrain attitude, so rays meet the tilted chassis.
  const pitch = finiteOr0(vehicle.pitch), roll = finiteOr0(vehicle.roll), poseYaw = finiteOr0(yaw);
  const X = finiteOr0(x), Y = finiteOr0(y), Z = finiteOr0(z);
  const cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch), cyaw = Math.cos(poseYaw), syaw = Math.sin(poseYaw);
  const point = (lx, ly, lz) => {
    const rx = lx * cr - ly * sr, ry = lx * sr + ly * cr;
    const py = ry * cp - lz * sp, pz = ry * sp + lz * cp;
    return [X + rx * cyaw + pz * syaw, Y + py, Z - rx * syaw + pz * cyaw];
  };
  const origin = point(0,0,0), ex = point(1,0,0), ey = point(0,1,0), ez = point(0,0,1);
  const axes = [[ex[0]-origin[0],ex[1]-origin[1],ex[2]-origin[2]],[ey[0]-origin[0],ey[1]-origin[1],ey[2]-origin[2]],[ez[0]-origin[0],ez[1]-origin[1],ez[2]-origin[2]]];
  const [a0, a1, a2] = axes;
  const cy=Math.cos(yaw),sy=Math.sin(yaw);
  const parts = new Array(local.length);
  for (let k = 0; k < local.length; k++) {
    const [lo, hi] = local[k];
    const center = point((lo[0]+hi[0])/2, (lo[1]+hi[1])/2, (lo[2]+hi[2])/2), half = [(hi[0]-lo[0])/2, (hi[1]-lo[1])/2, (hi[2]-lo[2])/2];
    const corners = [];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const a of [-1,1]) for (const b of [-1,1]) for (const c of [-1,1]) {
      const corner = [
        center[0]+a0[0]*half[0]*a+a1[0]*half[1]*b+a2[0]*half[2]*c,
        center[1]+a0[1]*half[0]*a+a1[1]*half[1]*b+a2[1]*half[2]*c,
        center[2]+a0[2]*half[0]*a+a1[2]*half[1]*b+a2[2]*half[2]*c];
      corners.push(corner);
      const fx = corner[0]*cy-corner[2]*sy, fz = corner[0]*sy+corner[2]*cy;
      x0 = Math.min(x0, fx); x1 = Math.max(x1, fx); z0 = Math.min(z0, fz); z1 = Math.max(z1, fz);
      minY = Math.min(minY, corner[1]); maxY = Math.max(maxY, corner[1]);
    }
    const mx=(x0+x1)/2,mz=(z0+z1)/2;
    parts[k] = {center,half,axes,corners,lo,hi, minY,maxY,
      hull:rectangleFootprint(mx*cy+mz*sy,-mx*sy+mz*cy,(x1-x0)/2,(z1-z0)/2,yaw)};
  }
  return parts;
}
export function vehicleSupportOffset(vehicle) {
  const parts = vehicleHullParts(vehicle);
  let minY = Infinity;
  for (const part of parts) minY = Math.min(minY, part.minY);
  return minY-vehicle.y;
}
/** Exact separating axes for two oriented boxes, including the nine edge axes. */
export function hullBoxesOverlap(a,b) {
  const ac = a.center, bc = b.center, d0 = bc[0]-ac[0], d1 = bc[1]-ac[1], d2 = bc[2]-ac[2];
  const A = a.axes, B = b.axes, ah = a.half, bh = b.half;
  for (let k = 0; k < 15; k++) {
    let x, y, z;
    if (k < 3) { x = A[k][0]; y = A[k][1]; z = A[k][2]; }
    else if (k < 6) { x = B[k-3][0]; y = B[k-3][1]; z = B[k-3][2]; }
    else {
      const p = A[((k-6)/3)|0], q = B[(k-6)%3];
      x = p[1]*q[2]-p[2]*q[1]; y = p[2]*q[0]-p[0]*q[2]; z = p[0]*q[1]-p[1]*q[0];
    }
    if (x*x+y*y+z*z < 1e-12) continue;
    let ra = 0, rb = 0;
    for (let i = 0; i < 3; i++) ra = ra + ah[i]*Math.abs(x*A[i][0]+y*A[i][1]+z*A[i][2]);
    for (let i = 0; i < 3; i++) rb = rb + bh[i]*Math.abs(x*B[i][0]+y*B[i][1]+z*B[i][2]);
    if (Math.abs(d0*x+d1*y+d2*z) >= ra+rb-1e-7) return false;
  }
  return true;
}
export function voxelHullBox(x,y,z) {return {center:[x+.5,y+.5,z+.5],half:[.5,.5,.5],axes:WORLD_AXES};}
export function rayHullPart(part,origin,dir,maxDistance) {
  return rayHullPartSpan(part,origin,dir,maxDistance)?.near ?? null;
}
/** Entry and exit distances of a ray through one oriented box (exit unclamped by maxDistance). */
export function rayHullPartSpan(part,origin,dir,maxDistance) {
  const offset=sub3(origin,part.center);let near=0,far=Infinity;
  for(let i=0;i<3;i++) {
    const o=dot3(offset,part.axes[i]),d=dot3(dir,part.axes[i]);
    if(Math.abs(d)<1e-9){if(Math.abs(o)>part.half[i])return null;continue;}
    const a=(-part.half[i]-o)/d,b=(part.half[i]-o)/d;near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));
    if(near>far)return null;
  }
  return near<=maxDistance ? {near,far} : null;
}
export function nearestHullPoint(part,point) {
  const delta=sub3(point,part.center),local=part.axes.map((axis,i)=>Math.max(-part.half[i],Math.min(part.half[i],dot3(delta,axis))));
  return part.center.map((n,i)=>n+local.reduce((sum,value,j)=>sum+value*part.axes[j][i],0));
}
