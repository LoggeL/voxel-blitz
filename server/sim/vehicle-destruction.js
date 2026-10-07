import { combatDamage } from '../../shared/combat-balance.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { VEHICLE_DEFS, vehicleDef } from '../../shared/vehicle-defs.js';
import { isSolidBlock } from '../../shared/worlddata.js';
import { evHit } from '../protocol/events.js';
import { occupantShielded, occupantBodyCenter, occupantDamageScale } from './vehicle-damage.js';

/** Wreck blasts retain terrain, so cover remains effective through chain reactions. */
export const VEHICLE_DESTRUCTION_RULES = Object.freeze(Object.fromEntries(
  Object.entries(VEHICLE_DEFS).map(([type, def]) => [type, def.destruction])));
/** A wreck blast is high explosive against other hulls. */
export const VEHICLE_DESTRUCTION_CLASS = 'he';

/**
 * Called once by VehicleSystem's destruction queue after the wreck is dead and
 * its seat has been released. The caller has already validated attacker credit.
 * Vehicle splash queues further wrecks rather than recursively detonating them.
 * Bodies in other hulls' sealed seats are protected; exposed crew take 0.8x.
 */
export function vehicleDestructionBlast(system, vehicle, attacker = null, { sourceTeam: environmentalTeam = vehicle?.team } = {}) {
  const rules = VEHICLE_DESTRUCTION_RULES[vehicle?.type];
  const def = vehicleDef(vehicle);
  if (!rules || !def || ![vehicle.x, vehicle.y, vehicle.z].every(Number.isFinite)) return false;
  const engine = system.engine;
  const origin = [vehicle.x, vehicle.y + def.height * 0.5, vehicle.z];
  engine.tickEvents?.push({
    t: 'ev', kind: 'explosion', type: 'vehicle',
    vehicleId: vehicle.id, vehicleType: vehicle.type,
    pos: origin, r: rules.radius,
    x: origin[0], y: origin[1], z: origin[2], radius: rules.radius,
  });
  // Like projectile explosions, publish presentation even outside the live phase.
  if (engine.mode?.phase != null && engine.mode.phase !== 'live') return true;

  const sourceTeam = attacker
    ? engine.mode?.teamFor?.(attacker) ?? attacker.team
    : environmentalTeam;
  const solidAt = engine.solidAt || ((x, y, z) => isSolidBlock(engine.world.getBlock(x, y, z)));
  for (const victim of (engine.combatants || engine.entities).values()) {
    if (occupantShielded(victim) || victim.state !== 'alive' || typeof victim.takeDamage !== 'function'
        || victim.spawnProtectedUntil > engine.now) continue;
    const isSelf = !!attacker && String(victim.id) === String(attacker.id);
    if (!isSelf) {
      const victimTeam = engine.mode?.teamFor?.(victim) ?? victim.team;
      if (sourceTeam != null && victimTeam === sourceTeam) continue;
      if (engine.mode?.canDamage?.(attacker, victim) === false) continue;
    }
    const target = occupantBodyCenter(victim);
    const delta = target.map((value, index) => value - origin[index]);
    const distance = Math.hypot(...delta);
    if (!(distance < rules.radius)) continue;
    // Match the projectile blast's body-centre ray and small endpoint margin.
    if (distance > 0.18 && raycastVoxels(solidAt, ...origin, ...delta, distance - 0.18)) continue;
    const falloff = Math.pow(1 - distance / rules.radius, rules.damageFalloffExponent);
    const damage = combatDamage(Math.round(rules.damage * falloff * occupantDamageScale(victim) * 10) / 10);
    if (!(damage > 0)) continue;
    const lethal = victim.takeDamage(damage, false, attacker, 'vehicle');
    engine.tickEvents?.push(evHit(attacker?.id || '', victim.id, damage, false, target, victim.lastDamage));
    if (lethal) engine.killPlayer?.(victim, attacker, 'vehicle', false, null);
  }
  system.explosion(origin, rules.radius, rules.damage, attacker, {
    sourceTeam, ignoreId: vehicle.id, cls: VEHICLE_DESTRUCTION_CLASS,
  });
  return true;
}
