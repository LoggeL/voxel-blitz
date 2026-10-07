/** Vehicle constants shared by the authoritative simulation and renderer.
 * A derived shim over shared/vehicle-defs.js; existing imports keep working. */
import { VEHICLE_DEFS, VEHICLE_RULES, vehicleDef, isAircraftType, vehicleMaxHp, mountPose, mountAim,
  vehicleLocalPoint, vehicleDirection, vehicleWorldToLocal, vehicleLocalDirection } from './vehicle-defs.js';
import { vehicleSeatDefinition } from './vehicle-seats.js';

export { VEHICLE_DEFS, VEHICLE_RULES, vehicleDef, vehicleMaxHp, mountPose, mountAim, vehicleLocalPoint, vehicleDirection,
  vehicleWorldToLocal, vehicleLocalDirection };
export const VEHICLE_ENTER_DISTANCE = 4;
export const isAircraft = type => isAircraftType(type);
export function vehicleEnterDistance(type) {
  return VEHICLE_RULES[type]?.enterDistance ?? VEHICLE_ENTER_DISTANCE;
}
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const seatAttachment = (type, seatId, mountId) => {
  const def = VEHICLE_DEFS[type], seat = def.seats.find(item => item.id === seatId), mount = def.mounts[mountId];
  const muzzle = mount.sides ? mount.sides[0] : mount.pivot;
  return Object.freeze({ seatSide: seat.position[0], seatHeight: seat.position[1], seatForward: -seat.position[2],
    muzzleSide: muzzle[0], muzzleForward: -muzzle[2] + (mount.fixed ? 0 : mount.muzzle), muzzleHeight: muzzle[1] });
};
export const AIRCRAFT_ATTACHMENTS = Object.freeze({
  helicopter: seatAttachment('helicopter', 'driver', 'pods'),
  transport: seatAttachment('transport', 'driver', 'door-left'),
  plane: seatAttachment('plane', 'driver', 'nose'),
});

/** World pose of a seat's hip anchor. Seats owning a slewing mount look along it. */
export function vehicleSeatPose(vehicle, seatId = 'driver') {
  const seat = vehicleSeatDefinition(vehicle, seatId);
  if (!seat) return null;
  let [x, y, z] = seat.position;
  if (seat.mount === 'turret') {
    const yaw = finite(vehicle.turretYaw, finite(vehicle.yaw)) - finite(vehicle.yaw), c = Math.cos(yaw), s = Math.sin(yaw);
    const pivotZ = -VEHICLE_RULES[vehicle.type].turretForward, localZ = z - pivotZ;
    [x, z] = [x * c + localZ * s, -x * s + localZ * c + pivotZ];
  }
  const position = vehicleLocalPoint(vehicle, x, y, z);
  const def = vehicleDef(vehicle), primary = def.mounts[seat.mounts[0]];
  const aim = primary && !primary.fixed && !isAircraft(vehicle.type) ? mountAim(vehicle, primary.id) : null;
  return { x: position[0], y: position[1], z: position[2], yaw: finite(aim ? aim.yaw : vehicle.yaw),
    pitch: finite(isAircraft(vehicle.type) ? vehicle.pitch : aim ? aim.pitch : 0) };
}

/** Primary weapon muzzle: the first mount in contract order (tank main gun, pods, pintle, nose). */
export function vehicleMuzzlePose(vehicle) {
  const key = vehicleDef(vehicle)?.mountOrder[0];
  if (!key) return null;
  const [seatId, mountId] = key.split(':');
  const pose = mountPose(vehicle, seatId, mountId);
  return pose && { origin: pose.origin, dir: pose.dir };
}
