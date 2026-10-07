/** Crew layouts derived from the frozen Conquest topology and shared/vehicle-defs.js.
 * Positions are hip anchors in metres, forward is -Z. Seat order is the F-key order. */
import { VEHICLE_DEFS, vehicleDef, vehicleMaxHp } from './vehicle-defs.js';

export const VEHICLE_SEATS = Object.freeze(Object.fromEntries(Object.entries(VEHICLE_DEFS).map(([type, def]) => [type, def.seats])));
const EMPTY_SEATS = Object.freeze([]);
export function vehicleSeats(type) {
  return vehicleDef(type)?.seats ?? EMPTY_SEATS;
}
// Seat lists are frozen per definition: index them once (first seat wins, as find does).
const seatIndex = new WeakMap();
function indexSeats(seats) {
  let index = seatIndex.get(seats);
  if (!index) {
    const byId = new Map();
    for (const seat of seats) if (!byId.has(seat.id)) byId.set(seat.id, seat);
    index = { byId, driver: seats.find(seat => seat.drives) || null };
    seatIndex.set(seats, index);
  }
  return index;
}
export const vehicleSeatDefinition = (type, seatId = 'driver') => indexSeats(vehicleSeats(type)).byId.get(seatId) || null;
export const vehicleDriverSeat = type => indexSeats(vehicleSeats(type)).driver;
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
