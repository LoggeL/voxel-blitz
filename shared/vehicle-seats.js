/** Crew layouts derived from the frozen Conquest topology and shared/vehicle-defs.js.
 * Positions are hip anchors in metres, forward is -Z. Seat order is the F-key order. */
import { VEHICLE_DEFS, vehicleDef, vehicleMaxHp } from './vehicle-defs.js';

export const VEHICLE_SEATS = Object.freeze(Object.fromEntries(Object.entries(VEHICLE_DEFS).map(([type, def]) => [type, def.seats])));
const EMPTY_SEATS = Object.freeze([]);
export function vehicleSeats(type) {
  return vehicleDef(type)?.seats ?? EMPTY_SEATS;
}
export const vehicleSeatDefinition = (type, seatId = 'driver') => vehicleSeats(type).find(seat => seat.id === seatId) || null;
export const vehicleDriverSeat = type => vehicleSeats(type).find(seat => seat.drives) || null;
/** Legacy presentation rows may omit seatOccupants; occupantId always means driver. */
export function vehicleSeatOccupantId(vehicle, seatId = 'driver') {
  if (!vehicleSeatDefinition(vehicle, seatId)) return null;
  const id = vehicle?.seatOccupants && Object.hasOwn(vehicle.seatOccupants, seatId)
    ? vehicle.seatOccupants[seatId] : seatId === 'driver' ? vehicle?.occupantId : null;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}
/** Occupied definitions with their player ID, in deterministic boarding order. */
export const vehicleOccupiedSeats = vehicle => vehicleSeats(vehicle).flatMap(seat => {
  const occupantId = vehicleSeatOccupantId(vehicle, seat.id);
  return occupantId == null ? [] : [{ ...seat, occupantId }];
});
export const vehicleHasFreeSeat = vehicle => vehicleSeats(vehicle).some(seat => vehicleSeatOccupantId(vehicle, seat.id) == null);
/** The seat that owns the hull's primary mount (first entry of vehicleMountOrder). */
export function vehicleWeaponSeatId(vehicle) {
  const key = vehicleDef(vehicle)?.mountOrder[0];
  return key ? key.slice(0, key.indexOf(':')) : null;
}
export { vehicleMaxHp };
