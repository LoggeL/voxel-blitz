// Conquest vehicle upgrades (shared/vehicle-upgrades.js): the career gate on
// the deploy intent's `upgrades` map, the per-player choice and the hull sync
// that hands every live hull the upgrade of whoever drives or pilots it. The
// effects themselves live in the sim (server/sim/vehicle-upgrades.js and the
// hooks it names); this module only decides which upgrade a hull carries.

import { BOT_VEHICLE_UPGRADES, lockedUpgrades, normalizeUpgradeChoice, upgradeUnlocked, vehicleUpgrade } from '../../../shared/vehicle-upgrades.js';
import { vehicleDriverSeatOf } from '../../../shared/vehicle-defs.js';
import { setHullUpgrade } from '../../sim/vehicle-upgrades.js';
import { careerLevelOf } from './deploy.js';

export class ConquestUpgrades {
  /** `policy` is the owning ConquestPolicy (entities, vehicle system). */
  constructor(policy) {
    this.policy = policy;
  }

  /**
   * The first locked entry of a human's deploy `upgrades` (`{type, id, level}`),
   * or null when every pick is open at the career level the server holds.
   * Bots skip the gate like they skip the kit gate.
   */
  refusal(entity, upgrades) {
    if (!upgrades || !entity || entity.bot) return null;
    return lockedUpgrades(normalizeUpgradeChoice(upgrades), careerLevelOf(entity))[0] ?? null;
  }

  /**
   * An accepted deploy: its map replaces the stored choice (a type it leaves
   * out drives stock). A deploy without `upgrades` keeps the stored choice.
   */
  choose(entity, upgrades) {
    if (!entity || !upgrades) return false;
    entity.vehicleUpgrades = Object.freeze(normalizeUpgradeChoice(upgrades) ?? {});
    return true;
  }

  /**
   * Upgrade id an entity drives a hull type with: a bot the fixed
   * BOT_VEHICLE_UPGRADES pick, a human the stored pick while its career level
   * opens it, else null (stock).
   */
  upgradeFor(entity, type) {
    if (!entity) return null;
    const id = entity.bot ? BOT_VEHICLE_UPGRADES[type] : entity.vehicleUpgrades?.[type];
    if (!vehicleUpgrade(type, id)) return null;
    return entity.bot || upgradeUnlocked(type, id, careerLevelOf(entity)) ? id : null;
  }

  /** The living driver or pilot of a hull, or null. */
  driverOf(vehicle) {
    const seat = vehicleDriverSeatOf(vehicle);
    const id = seat ? vehicle.seatOccupants?.[seat.id] : null;
    const entity = id != null ? this.policy._entity?.(String(id)) : null;
    return entity && entity.state === 'alive' ? entity : null;
  }

  /** Once per tick: every live hull carries its driver's upgrade; an empty driver seat is stock. */
  tick() {
    const vehicles = this.policy.vehicleSystem?.vehicles;
    if (!vehicles || typeof vehicles.values !== 'function') return;
    for (const vehicle of vehicles.values()) {
      const next = vehicle.hp > 0 ? this.upgradeFor(this.driverOf(vehicle), vehicle.type) : null;
      if ((vehicle.upgrade ?? null) !== next) setHullUpgrade(vehicle, next);
    }
  }

  /** Round reset: every hull back to stock (the choices stay with the players). */
  reset() {
    const vehicles = this.policy.vehicleSystem?.vehicles;
    for (const vehicle of vehicles?.values?.() ?? []) setHullUpgrade(vehicle, null);
  }
}
