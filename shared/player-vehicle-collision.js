import { hullFootprint, rectangleFootprint, footprintContact, vehicleHullParts, hullBoxesOverlap, solidHull } from './vehicle-collision.js';
import { VEHICLE_RULES, isAircraft } from './vehicles.js';
import { PHYSICS, boxCollides } from './player-movement.js';
import { stanceHeight } from './player-stance.js';

const GAP = 1e-4;
export const infantryHeight = player => stanceHeight(PHYSICS.height, player.proneT || 0);
// Live hulls and fresh ground wrecks are solid (vehicle-collision solidHull).
const liveHull = v => solidHull(v) && VEHICLE_RULES[v.type]
  && [v.x, v.y, v.z, v.yaw].every(Number.isFinite);
/** A body forced out of a hull ignores that hull briefly (`ghostVehicleId`). */
const ghosted = (player, vehicle) => player?.ghostVehicleId != null && player.ghostVehicleId === vehicle?.id;
export function playerHullContact(player, vehicle, height = infantryHeight(player)) {
  if (ghosted(player, vehicle)) return null;
  if(isAircraft(vehicle?.type)) {
    if(!liveHull(vehicle)||player.vehicleId||player.state==='dead')return null;
    if(Math.hypot(player.x-vehicle.x,player.z-vehicle.z)>VEHICLE_RULES[vehicle.type].radius+VEHICLE_RULES[vehicle.type].height+PHYSICS.halfW)return null;
    const feet=rectangleFootprint(player.x,player.z,PHYSICS.halfW,PHYSICS.halfW),body={center:[player.x,player.y+height/2,player.z],half:[PHYSICS.halfW,height/2,PHYSICS.halfW],axes:[[1,0,0],[0,1,0],[0,0,1]]};
    let contact=null;
    for(const part of vehicleHullParts(vehicle)) {
      if(player.y>=part.maxY-GAP||player.y+height<=part.minY+GAP||!hullBoxesOverlap(part,body))continue;
      const candidate=footprintContact(part.hull,feet);
      if(candidate&&(!contact||candidate.depth<contact.depth))contact=candidate;
    }
    return contact;
  }
  if (!liveHull(vehicle) || player.vehicleId || player.state === 'dead'
      || player.y >= vehicle.y + VEHICLE_RULES[vehicle.type].height - GAP
      || player.y + height <= vehicle.y + GAP) return null;
  return footprintContact(hullFootprint(vehicle.type, vehicle.x, vehicle.z, vehicle.yaw),
    rectangleFootprint(player.x, player.z, PHYSICS.halfW, PHYSICS.halfW));
}

/** Clip one terrain-approved axis against live hulls, including roofs/undersides.
 * Substeps detect entry even when an entire hull fits inside the movement span.
 * A body already overlapped by a new snapshot may leave the hull freely.
 */
export function slidePlayerVehicleAxis(player, axis, start, vehicles, height = infantryHeight(player)) {
  const hulls = [...(vehicles || [])].filter(liveHull);
  const end = player[axis], amount = end - start;
  if (!amount || !hulls.length || player.vehicleId || player.state === 'dead') return false;
  const probe = { ...player, [axis]: start };
  const collides = pos => hulls.some(v => playerHullContact(pos, v, height));
  // Vehicle movement resolves authoritative overlaps. Prediction can receive
  // a hull before the corresponding body correction and must allow escape.
  if (collides(probe)) return false;
  const steps = Math.ceil(Math.abs(amount) / 0.2);
  let previous = start;
  for (let i = 1; i <= steps; i++) {
    probe[axis] = start + amount * i / steps;
    if (!collides(probe)) { previous = probe[axis]; continue; }
    let safe = previous, blocked = probe[axis];
    for (let j = 0; j < 24; j++) {
      probe[axis] = (safe + blocked) / 2;
      if (collides(probe)) blocked = probe[axis]; else safe = probe[axis];
    }
    player[axis] = safe;
    return true;
  }
  return false;
}

/** Resolve non-axis movement (vaults/slides) using the same swept hull test. */
export function constrainPlayerVehicleMotion(player, previous, vehicles, height = infantryHeight(player)) {
  const destination = { x: player.x, y: player.y, z: player.z };
  Object.assign(player, previous);
  let collided = false;
  for (const axis of ['x', 'z', 'y']) {
    const start = player[axis];
    player[axis] = destination[axis];
    collided = slidePlayerVehicleAxis(player, axis, start, vehicles, height) || collided;
  }
  return collided;
}

/** A vehicle push is all-or-nothing and checks the full swept player box.
 * No stepping or vaulting is induced by a bumper, so a wall cannot be crossed.
 */
export function vehiclePlayerPush(player, vehicle, solidAt, vehicles = []) {
  const height = infantryHeight(player), contact = playerHullContact(player, vehicle, height);
  if (!contact) return null;
  const distance = contact.depth + GAP * 2;
  const target = { x: player.x + contact.nx * distance, y: player.y, z: player.z + contact.nz * distance };
  const steps = Math.ceil(distance / 0.15);
  for (let i = 1; i <= steps; i++) {
    const x = player.x + (target.x - player.x) * i / steps;
    const z = player.z + (target.z - player.z) * i / steps;
    if (boxCollides(solidAt, x, player.y, z, height)) return { contact, blocked: true };
    const probe = { ...player, x, z };
    for (const other of vehicles) if (other !== vehicle && playerHullContact(probe, other, height)) return { contact, blocked: true };
  }
  // A separation along one SAT axis is sufficient, including rotated corners.
  return { contact, blocked: false, position: target };
}
