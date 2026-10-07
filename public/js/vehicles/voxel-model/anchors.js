// Seat and mount anchors the voxel models are built to. Every number comes
// from shared/vehicle-defs.js (seat hips, mount pivots, muzzle lengths, pod
// and rail sides), so the rendered barrels, the crew and the server's
// mountPose/vehicleSeatPose can never drift apart.
import { VEHICLE_TOPOLOGY, vehicleMountOrder } from '../../../../shared/conquest-contract.js';
import { VEHICLE_DEFS, vehicleDef, vehicleMaxHp } from '../../../../shared/vehicle-defs.js';

/** Tank turret ring: yaw pivot at the shared turretForward, ring height of the model. */
export const TANK_TURRET_PIVOT = Object.freeze([0, 1.66, -(VEHICLE_DEFS.tank.rules.turretForward ?? 0.19)]);

const typeOf = value => typeof value === 'object' && value !== null ? value.type ?? value.kind : value;

/** Every seat of a type in F-key order with its hip, frame and flags. */
export function modelSeats(type) {
  return (vehicleDef(type)?.seats || []).map(seat => ({
    id: seat.id, position: [...seat.position], frame: seat.mount === 'turret' ? 'turret' : 'hull',
    exposed: !!seat.exposed, drives: !!seat.drives, role: seat.role, camera: seat.camera,
  }));
}

/** Contract mounts ('seat:mount' keys) with their anchors for one type. */
export function mountAnchors(type) {
  const def = vehicleDef(type);
  return vehicleMountOrder(type).map(key => {
    const [seatId, mountId] = key.split(':');
    const mount = def?.mounts?.[mountId] || {};
    return { key, seatId, mountId, pivot: mount.pivot, muzzle: mount.muzzle ?? 0, sides: mount.sides || null,
      frame: mount.frame || 'hull', fixed: !!mount.fixed, slavedTo: mount.slavedTo || null,
      yawLimit: mount.yawLimit ?? null, pitchLimit: mount.pitchLimit ?? null, weapons: mount.weapons || [] };
  });
}

/** Resolve a mount id or 'seat:mount' key to the canonical key for a type. */
export function canonicalMountKey(type, mount) {
  if (typeof mount !== 'string' || !mount) return null;
  const order = vehicleMountOrder(typeOf(type));
  if (order.includes(mount)) return mount;
  return order.find(key => key.endsWith(`:${mount}`)) || null;
}

/** Index of a mount in a snapshot row's mounts[] array, or -1. */
export function mountIndex(type, mount) {
  const key = canonicalMountKey(type, mount);
  return key ? vehicleMountOrder(typeOf(type)).indexOf(key) : -1;
}

/** Handling rules of a type (transport carries its own heavier constants). */
export const vehicleRules = type => vehicleDef(type)?.rules ?? null;

/** Maximum hull HP for a row (derived from the def; rows no longer carry maxHp). */
export function rowMaxHp(row) {
  const hp = vehicleMaxHp(row);
  return hp > 0 ? hp : Number.isFinite(row?.maxHp) && row.maxHp > 0 ? row.maxHp : 100;
}

export const VEHICLE_TYPES = Object.freeze(Object.keys(VEHICLE_TOPOLOGY));
export const isAircraftType = type => ['rotor', 'fixedwing'].includes(vehicleDef(type)?.handling);
export const isRotorType = type => vehicleDef(type)?.handling === 'rotor';
export const isGroundType = type => ['wheeled', 'tracked'].includes(vehicleDef(type)?.handling);
