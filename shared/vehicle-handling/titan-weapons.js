/**
 * Titan mount weapon numbers (docs/titanfall.md §5.4), owned and tuned by WP3.
 * Every entry carries each field the VehicleMounts and projectile readers use
 * unguarded (cooldown, magazine, reloadSeconds, range, spreadDeg, lifetimeMs,
 * speed, gravity, damage, infantryDamage, cls), plus the blast fields
 * launchVehicleProjectile reads, plus the titan-only fields the titan mount
 * branch (server/sim/titanfall/titan-mounts.js) and the titan projectiles
 * (server/sim/titanfall/titan-projectiles.js) read:
 *
 *   split          ION Splitter ADS: `beams` per shot in a `fanDeg` fan, each at `damageMul`, for `energy`
 *                  (1/3: the shot's damage is shared by its beams, a wider hit area at the same DPS)
 *   chargeSeconds  railgun charge time; damage/infantryDamage lerp to damageCharged/infantryDamageCharged;
 *                  `pierce` hulls/bodies per shot; cooldown runs after the shot
 *   spinUpSeconds  Predator spin-up (field 6 of the mount row); spinDownSeconds back to idle
 *   pellets        Leadwall projectiles per shot, each `ricochets` voxel bounces
 *   firePatch      T-203 thermite patch (MolotovFireSystem.ignite profile override)
 *   projectile     'titan:<kind>' router kind for the shell weapons
 *
 * spreadDeg is the half-angle of the shot cone (VehicleMounts' spreadDirection).
 * Sustained DPS vs a titan (reload included; tools/titanfall-titan-weapons-test.mjs
 * checks each within ±20 % of TITAN_WEAPON_DPS): splitter 1056 dmg / 5.55 s ≈ 190,
 * T-203 260 / 1.4 s ≈ 186, railgun 520 / 2.4 s ≈ 217, leadwall 780 / 3.9 s ≈ 200 (every pellet;
 * ≈ 187 measured at 16 m), Predator close 2000 / 10.04 s ≈ 199 and long 3400 / 15.98 s ≈ 213
 * (spin-up after each reload). A magazine cycle is (magazine − 1) × cooldown + reload.
 * Import-free apart from the dependency-free titan contract (no cycle with
 * shared/vehicle-defs.js, which spreads these into VEHICLE_WEAPONS).
 */
import { TITAN_WEAPON_META } from '../titan-contract.js';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};
const BASE = { cooldown: 1, magazine: Infinity, reloadSeconds: 0, range: 300, spreadDeg: 0, lifetimeMs: 3000, headMult: 1,
  damage: 0, infantryDamage: 0, splash: 0, splashRadius: 0.5, splashCls: 'titan', knockback: 0,
  terrainRadius: 0, terrainPower: 0, maxDestroyedBlocks: 0 };
const weapon = (key, numbers) => ({ ...BASE, key, ...TITAN_WEAPON_META[key], ...numbers });

export const TITAN_WEAPONS = deepFreeze({
  splitter: weapon('splitter', { cooldown: 0.15, magazine: 22, reloadSeconds: 2.4, range: 250, spreadDeg: 0.4, damage: 48, infantryDamage: 30,
    split: { beams: 3, fanDeg: 1.6, damageMul: 1 / 3, energy: 45 } }),
  t203: weapon('t203', { cooldown: 1, magazine: 1, reloadSeconds: 1.4, lifetimeMs: 4000, damage: 260, infantryDamage: 90,
    splash: 120, splashRadius: 4, splashCls: 'titan', infantrySplash: 60, knockback: 10, terrainRadius: 1.5, terrainPower: 80, maxDestroyedBlocks: 12,
    projectile: 'titan:t203', firePatch: { radius: 3, durationMs: 3000, damagePerSecond: 30, hullDamagePerSecond: 40 / 0.6, maxCells: 40 } }),
  railgun: weapon('railgun', { cooldown: 0.8, magazine: Infinity, range: 400, spreadDeg: 0, damage: 150, infantryDamage: 90,
    chargeSeconds: 1.6, damageCharged: 520, infantryDamageCharged: 200, pierce: 3, minReleaseCharge: 0.05 }),
  leadwall: weapon('leadwall', { cooldown: 0.65, magazine: 3, reloadSeconds: 2.6, range: 60, spreadDeg: 6, lifetimeMs: 600,
    damage: 26, infantryDamage: 25, pellets: 10, ricochets: 1, splash: 0, splashRadius: 0.5, projectile: 'titan:leadwall' }),
  predatorClose: weapon('predatorClose', { cooldown: 0.06, magazine: 100, reloadSeconds: 3.5, range: 200, spreadDeg: 1.6,
    damage: 20, infantryDamage: 18, spinUpSeconds: 0.6, spinDownSeconds: 1.2 }),
  predatorLong: weapon('predatorLong', { cooldown: 0.12, magazine: 100, reloadSeconds: 3.5, range: 300, spreadDeg: 0.3,
    damage: 34, infantryDamage: 22, spinUpSeconds: 0.6, spinDownSeconds: 1.2 }),
  titanMelee: weapon('titanMelee', { cooldown: 1.3, magazine: Infinity, range: 4.5, damage: 200, infantryDamage: 150, coneDeg: 50 }),
});

/** §5.4 table: sustained DPS vs a titan (reload included) each primary is tuned to (±20 %). */
export const TITAN_WEAPON_DPS = deepFreeze({ splitter: 185, t203: 190, railgun: 215, leadwall: 188, predatorClose: 198, predatorLong: 211 });
