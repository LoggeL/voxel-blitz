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
export function hullFootprint(type, x, z, yaw = 0) {
  const { halfWidth, halfLength } = VEHICLE_COLLIDERS[type];
  return rectangleFootprint(x, z, halfWidth, halfLength, yaw);
}
export function rectangleFootprint(x, z, halfWidth, halfLength, yaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw), axes = [[c,-s],[s,c]];
  const corners = [[-1,-1],[-1,1],[1,-1],[1,1]].map(([w,l]) => [x + w*halfWidth*c + l*halfLength*s, z - w*halfWidth*s + l*halfLength*c]);
  return { x,z,halfWidth,halfLength,axes,corners,
    minX: Math.min(...corners.map(p=>p[0])), maxX: Math.max(...corners.map(p=>p[0])),
    minZ: Math.min(...corners.map(p=>p[1])), maxZ: Math.max(...corners.map(p=>p[1])) };
}
/** Minimum translation of b out of a, on the same axes as the overlap test. */
export function footprintContact(a, b) {
  let contact = null;
  for (const [ax, az] of [...a.axes, ...b.axes]) {
    const project = hull => hull.halfWidth * Math.abs(ax * hull.axes[0][0] + az * hull.axes[0][1])
      + hull.halfLength * Math.abs(ax * hull.axes[1][0] + az * hull.axes[1][1]);
    const distance = (b.x - a.x) * ax + (b.z - a.z) * az;
    const depth = project(a) + project(b) - Math.abs(distance);
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
  for (const [ax,az] of [...a.axes,...b.axes]) {
    const project = hull => hull.halfWidth*Math.abs(ax*hull.axes[0][0]+az*hull.axes[0][1]) + hull.halfLength*Math.abs(ax*hull.axes[1][0]+az*hull.axes[1][1]);
    if (Math.abs((a.x-b.x)*ax+(a.z-b.z)*az) >= project(a)+project(b)-1e-9) return false;
  }
  return true;
}

const dot3 = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub3 = (a,b) => a.map((n,i)=>n-b[i]);
const cross3 = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const WORLD_AXES = [[1,0,0],[0,1,0],[0,0,1]];
export function vehicleHullParts(vehicle, x=vehicle.x, y=vehicle.y, z=vehicle.z, yaw=vehicle.yaw) {
  const def = VEHICLE_DEFS[vehicle.type], shape = def.collider;
  const local = def.hullBoxes ? def.hullBoxes.filter((_,index)=>vehicle.gearDown!==false||!def.gearBoxes?.includes(index))
    : [[[-shape.halfWidth,0,-shape.halfLength],[shape.halfWidth,def.height,shape.halfLength]]];
  // Ground hulls carry the fitted terrain attitude, so rays meet the tilted chassis.
  const pose = { ...vehicle,x,y,z,yaw,pitch:Number.isFinite(vehicle.pitch)?vehicle.pitch:0,roll:Number.isFinite(vehicle.roll)?vehicle.roll:0 };
  const origin = vehicleLocalPoint(pose,0,0,0);
  const axes = WORLD_AXES.map(axis=>sub3(vehicleLocalPoint(pose,...axis),origin));
  const cy=Math.cos(yaw),sy=Math.sin(yaw);
  return local.map(([lo,hi])=>{
    const center=vehicleLocalPoint(pose,...lo.map((n,i)=>(n+hi[i])/2)),half=lo.map((n,i)=>(hi[i]-n)/2);
    const corners=[];
    for(const a of [-1,1])for(const b of [-1,1])for(const c of [-1,1])corners.push(center.map((n,i)=>n+axes[0][i]*half[0]*a+axes[1][i]*half[1]*b+axes[2][i]*half[2]*c));
    const flat=corners.map(point=>[point[0]*cy-point[2]*sy,point[0]*sy+point[2]*cy]);
    const x0=Math.min(...flat.map(p=>p[0])),x1=Math.max(...flat.map(p=>p[0])),z0=Math.min(...flat.map(p=>p[1])),z1=Math.max(...flat.map(p=>p[1]));
    const mx=(x0+x1)/2,mz=(z0+z1)/2;
    return {center,half,axes,corners,lo,hi, minY:Math.min(...corners.map(p=>p[1])),maxY:Math.max(...corners.map(p=>p[1])),
      hull:rectangleFootprint(mx*cy+mz*sy,-mx*sy+mz*cy,(x1-x0)/2,(z1-z0)/2,yaw)};
  });
}
export function vehicleSupportOffset(vehicle) {
  return Math.min(...vehicleHullParts(vehicle).map(part=>part.minY))-vehicle.y;
}
/** Exact separating axes for two oriented boxes, including the nine edge axes. */
export function hullBoxesOverlap(a,b) {
  const delta=sub3(b.center,a.center);
  for(const axis of [...a.axes,...b.axes,...a.axes.flatMap(x=>b.axes.map(y=>cross3(x,y)))]) {
    if(dot3(axis,axis)<1e-12)continue;
    const radius=box=>box.half.reduce((sum,n,i)=>sum+n*Math.abs(dot3(axis,box.axes[i])),0);
    if(Math.abs(dot3(delta,axis))>=radius(a)+radius(b)-1e-7)return false;
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
