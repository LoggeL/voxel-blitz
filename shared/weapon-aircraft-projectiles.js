import { ROCKET_RULES } from './rocket-rules.js';
import { VEHICLE_WEAPONS } from './vehicle-defs.js';

/** Hitscan mounts report this effective muzzle speed for lead estimates. */
export const HITSCAN_EFFECTIVE_SPEED = 2000;

/** Blast rules a projectile-firing vehicle weapon carries in flight (projectiles.js). */
export function vehicleWeaponBlast(weapon) {
  return Object.freeze({
    directDamage: weapon.damage ?? 0, damage: weapon.splash ?? 0, damageRadius: weapon.splashRadius ?? 0.5,
    damageFalloffExponent: ROCKET_RULES.damageFalloffExponent, selfDamage: 0,
    knockback: weapon.knockback ?? 0, selfKnockback: 0, knockbackRadius: weapon.splashRadius ?? 0.5,
    knockbackFalloff: ROCKET_RULES.knockbackFalloff,
    terrainRadius: weapon.terrainRadius ?? 0, terrainPower: weapon.terrainPower ?? 0, maxDestroyedBlocks: weapon.maxDestroyedBlocks ?? 0,
    concussMs: 0, concussPanic: 0,
    cls: weapon.cls, splashCls: weapon.splashCls ?? weapon.cls,
  });
}

const entry = (id, vehicleType) => {
  const weapon = VEHICLE_WEAPONS[id];
  return Object.freeze({
    id, vehicleType, presentationWeapon: weapon.presentation, kind: weapon.kind,
    fireSeconds: weapon.cooldown, speed: weapon.kind === 'hitscan' ? HITSCAN_EFFECTIVE_SPEED : weapon.speed,
    gravity: weapon.gravity ?? 0, lifetimeMs: weapon.lifetimeMs ?? 0,
    blast: weapon.kind === 'hitscan' ? null : vehicleWeaponBlast(weapon),
  });
};

/** Legacy aircraft weapon view derived from VEHICLE_WEAPONS (bot lead and old callers). */
export const AIRCRAFT_PROJECTILE_WEAPONS = Object.freeze({
  helicopterRocket: entry('helicopterRocket', 'helicopter'),
  chinCannon: entry('chinCannon', 'helicopter'),
  planeCannon: entry('planeCannon', 'plane'),
  aaMissile: entry('aaMissile', 'plane'),
});

export function aircraftProjectileWeapon(key) {
  return Object.hasOwn(AIRCRAFT_PROJECTILE_WEAPONS, key)
    ? AIRCRAFT_PROJECTILE_WEAPONS[key] : null;
}
