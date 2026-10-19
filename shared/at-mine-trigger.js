import { AT_MINE_RULES, AT_MINE_TRIGGER_HANDLING } from './at-mine-rules.js';
import { vehicleDef, vehicleWorldToLocal } from './vehicle-defs.js';

// The AT MINE hull trigger (docs/conquest.md "AT mines"). Kept apart from
// shared/at-mine-rules.js so the grenade roster on the client boot path never
// pulls the vehicle registry.

/**
 * True when live hull `vehicle` sets off `mine` ({x,y,z,team}): an enemy
 * ground hull whose collider footprint covers the mine at ground height.
 * A mine without a team (owner gone) never triggers.
 */
export function atMineTriggeredBy(mine, vehicle) {
  if (!mine || !vehicle || !(vehicle.hp > 0) || mine.team == null || vehicle.team == null || vehicle.team === mine.team) return false;
  const def = vehicleDef(vehicle);
  if (!def || !AT_MINE_TRIGGER_HANDLING.includes(def.handling)) return false;
  const r = AT_MINE_RULES, half = def.collider;
  if (Math.abs(vehicle.x - mine.x) > half.halfLength + half.halfWidth + 1
    || Math.abs(vehicle.z - mine.z) > half.halfLength + half.halfWidth + 1) return false;
  const local = vehicleWorldToLocal(vehicle, [mine.x, mine.y, mine.z]);
  return Math.abs(local[0]) <= half.halfWidth + r.footprintMargin
    && Math.abs(local[2]) <= half.halfLength + r.footprintMargin
    && local[1] >= r.triggerBelow && local[1] <= r.triggerAbove;
}
