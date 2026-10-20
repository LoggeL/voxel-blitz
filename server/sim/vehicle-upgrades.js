/**
 * Hull side of the Conquest vehicle upgrades (shared/vehicle-upgrades.js).
 * A live hull carries `upgrade` (an upgrade id of its type, or null) set by
 * the mode while someone drives it (server/modes/conquest/upgrades.js); the
 * sim hooks (damage, mounts, locks, ground drive, spotting) read its effects
 * through the shared helpers. Other modes never set it, so every hull there
 * stays stock.
 */
import { VEHICLE_WEAPONS } from '../../shared/vehicle-defs.js';
import { upgradeMagazineBonus, upgradeMountScale, vehicleUpgrade } from '../../shared/vehicle-upgrades.js';

/** Magazine size of a mount state on its hull (stock + upgrade bonus), -1 for an unlimited weapon. */
export function mountMagazine(vehicle, state) {
  const weapon = VEHICLE_WEAPONS[state?.weapon];
  if (!weapon || !Number.isFinite(weapon.magazine)) return -1;
  return weapon.magazine + upgradeMagazineBonus(vehicle, state.mountId);
}

/** Seconds of a mount timer (`cooldown`, `reload` → reloadSeconds, `rearm` → rearmSeconds) on its hull. */
export function mountSeconds(vehicle, state, key) {
  const weapon = VEHICLE_WEAPONS[state?.weapon];
  const base = key === 'reload' ? weapon?.reloadSeconds : key === 'rearm' ? weapon?.rearmSeconds : weapon?.cooldown;
  return Number.isFinite(base) ? base * upgradeMountScale(vehicle, key, state.mountId) : 0;
}

/**
 * Give a hull the upgrade `id` (null: stock). Magazines follow the new size:
 * a shrunk magazine moves the rounds above it (loaded ones as 0, pending
 * re-arms with their time left) into the mount's `heldRearm`, which keeps
 * counting down (VehicleMounts.tickTimers); a grown one takes those held
 * rounds back first, is topped up at once when the stock rack was full and
 * idle with nothing held, and otherwise re-arms the missing rounds on the
 * mount's own timer. So hopping out and back in never refills a spent round.
 * Returns true when the upgrade changed.
 */
export function setHullUpgrade(vehicle, id) {
  if (!vehicle) return false;
  const next = id && vehicleUpgrade(vehicle.type, id) ? id : null;
  if ((vehicle.upgrade ?? null) === next) return false;
  const before = (vehicle.mounts || []).map(state => mountMagazine(vehicle, state));
  vehicle.upgrade = next;
  (vehicle.mounts || []).forEach((state, index) => {
    const cap = mountMagazine(vehicle, state), prior = before[index];
    if (cap < 0 || cap === prior || !Array.isArray(state.rearm)) return;
    if (cap < prior) {
      const held = state.heldRearm ??= [];
      while (state.ammo > cap) { state.ammo--; held.push(0); }
      const keep = Math.max(0, cap - state.ammo);
      if (state.rearm.length > keep) held.push(...state.rearm.splice(keep));
      if (!held.length) delete state.heldRearm;
      return;
    }
    const held = (state.heldRearm ?? []).sort((a, b) => a - b);
    delete state.heldRearm;
    if (!held.length && state.ammo >= prior && !state.rearm.length && !(state.reloadT > 0)) { state.ammo = cap; return; }
    let missing = cap - state.ammo - state.rearm.length;
    for (; missing > 0 && held.length; missing--) {
      const left = held.shift();
      if (left > 0) state.rearm.push(left); else state.ammo++;
    }
    const rearm = mountSeconds(vehicle, state, 'rearm');
    if (rearm > 0) for (; missing > 0; missing--) state.rearm.push(rearm);
    state.rearm.sort((a, b) => a - b);
  });
  return true;
}

/** Hitscan weapon row with a mount's `damage` upgrade applied (the row itself when stock). */
export function upgradedHitscan(vehicle, mountId, weapon) {
  const scale = upgradeMountScale(vehicle, 'damage', mountId);
  if (scale === 1) return weapon;
  return { ...weapon, damage: weapon.damage * scale, ...(Number.isFinite(weapon.infantryDamage) ? { infantryDamage: weapon.infantryDamage * scale } : {}) };
}
