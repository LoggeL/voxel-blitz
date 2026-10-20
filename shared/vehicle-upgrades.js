// Conquest vehicle upgrades: career-unlocked hull perks, one pick per hull
// type. Pure data and pure functions, shared by the server (gate, hull sync,
// the effect hooks in server/sim) and the client deploy screen and vehicle
// panel, so an upgrade always means the same numbers on both sides.
//
// The table is keyed by vehicle type name (not the wire index), so a hull
// type added later only adds a key (the mobile AA and the patrol boat did). Within a type the list
// order is the wire order of the vehicle row's `upg` (1-based, 0 stock):
// append new upgrades at the end of a type's list.

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

/**
 * Effect keys (every one optional; a missing key is the stock hull):
 * - `damageTaken` {cls|'all': scale}: hull damage taken per damage class
 *   (`collision` included); a class key beats `all`.
 * - `repair` scale: hull points restored by Engineers, crew repair and the
 *   self-regeneration.
 * - `cooldown` / `reload` / `rearm` / `damage` {mountId: scale}: the mount's
 *   time between shots, its magazine reload, its per-rail re-arm and (hitscan
 *   mounts only) its damage per round.
 * - `magazine` {mountId: +n}: extra rounds in the mount's magazine.
 * - `cmCharges` +n: extra countermeasure salvos, each on its own cooldown.
 * - `cmCooldown` scale: the countermeasure cooldown.
 * - `lockTime` scale: how long an enemy seeker needs to lock this hull.
 * - `speed` / `acceleration` scale: wheeled and boat drive top speed and acceleration.
 * - `spot` {range, ms, smoke}: manual spots by the hull's crew reach `range` m,
 *   last `ms` and (`smoke: true`) see through smoke.
 *
 * `unlockLevel` is the career level that opens an upgrade (the server refuses
 * a deploy that asks for a locked one, `deploy_refused {reason:'locked'}`).
 */
const U = (id, label, short, unlockLevel, hint, effects) => ({ id, label, short, unlockLevel, hint, effects });
export const VEHICLE_UPGRADES = freeze({
  jeep: [
    U('reinforced', 'REINFORCED CHASSIS', 'REINFORCED', 2, 'TAKES 25 % LESS DAMAGE FROM BULLETS, BLASTS, FIRE AND CRASHES · AT STILL KILLS',
      { damageTaken: { all: 0.75, at: 1 } }),
    U('turbo', 'TURBO', 'TURBO', 4, 'TOP SPEED 24 → 29 M/S · 25 % MORE ACCELERATION', { speed: 1.2, acceleration: 1.25 }),
  ],
  jeep_at: [
    U('reinforced', 'REINFORCED CHASSIS', 'REINFORCED', 2, 'TAKES 25 % LESS DAMAGE FROM BULLETS, BLASTS, FIRE AND CRASHES · AT STILL KILLS',
      { damageTaken: { all: 0.75, at: 1 } }),
    U('tow_reload', 'QUICK TOW RELOAD', 'TOW RELOAD', 6, 'TOW BOX RELOAD 12 → 7.2 S', { reload: { pintle: 0.6 } }),
  ],
  tank: [
    U('reactive', 'REACTIVE ARMOUR', 'REACTIVE', 2, 'AT HITS DEAL 15 % LESS (ROCKETS, SHELLS, MISSILES, MINES)', { damageTaken: { at: 0.85 } }),
    U('autoloader', 'AUTOLOADER', 'AUTOLOADER', 4, 'MAIN GUN RELOAD 3.5 → 2.8 S', { cooldown: { main: 0.8 } }),
    U('thermal', 'THERMAL OPTICS', 'THERMAL', 8, 'CREW SPOTS REACH 450 M, LAST 8 S AND SEE THROUGH SMOKE', { spot: { range: 450, ms: 8000, smoke: true } }),
  ],
  helicopter: [
    U('flare_reload', 'FLARE RELOAD', 'FLARE RELOAD', 3, 'FLARE COOLDOWN 18 → 10.8 S', { cmCooldown: 0.6 }),
    U('extra_missile', 'EXTRA MISSILE', 'EXTRA MSL', 6, 'GUNNER CARRIES 3 GUIDED MISSILES INSTEAD OF 2', { magazine: { atgm: 1 } }),
  ],
  transport: [
    U('field_repair', 'FIELD REPAIR', 'FIELD REPAIR', 2, 'REPAIRS AND SELF-REGENERATION RESTORE 50 % FASTER', { repair: 1.5 }),
    U('heavy_doorguns', 'HEAVY DOOR GUNS', 'HEAVY GUNS', 5, 'DOOR GUNS DEAL 30 % MORE DAMAGE', { damage: { 'door-left': 1.3, 'door-right': 1.3 } }),
  ],
  plane: [
    U('extra_flares', 'EXTRA FLARES', 'EXTRA FLARES', 3, 'TWO FLARE SALVOS, EACH ON ITS OWN 18 S COOLDOWN', { cmCharges: 1 }),
    U('ecm', 'ECM JAMMER', 'ECM', 6, 'ENEMY LOCKS TAKE 50 % LONGER (STINGER 1.4 → 2.1 S, AA MISSILE 1.5 → 2.25 S)', { lockTime: 1.5 }),
    U('quick_rearm', 'QUICK REARM', 'QUICK REARM', 8, 'AA MISSILES RE-ARM 15 → 9 S · BOMBS 10 → 6 S', { rearm: { rails: 0.6, bombs: 0.6 } }),
  ],
  aa: [
    U('reactive', 'REACTIVE ARMOUR', 'REACTIVE', 2, 'AT HITS DEAL 15 % LESS (ROCKETS, SHELLS, MISSILES, MINES)', { damageTaken: { at: 0.85 } }),
    U('search_radar', 'SEARCH RADAR', 'RADAR', 5, 'CREW SPOTS REACH 450 M IN ANY WEATHER AND LAST 8 S', { spot: { range: 450, ms: 8000 } }),
  ],
  boat: [
    U('reinforced', 'REINFORCED HULL', 'REINFORCED', 2, 'TAKES 25 % LESS DAMAGE FROM BULLETS, BLASTS, FIRE AND CRASHES · AT STILL KILLS',
      { damageTaken: { all: 0.75, at: 1 } }),
    U('waterjet', 'TUNED WATERJET', 'WATERJET', 4, 'TOP SPEED 20 → 24 M/S · 25 % MORE ACCELERATION', { speed: 1.2, acceleration: 1.25 }),
  ],
});

/**
 * Bots ignore the level gate and drive with this fixed upgrade per hull type
 * (null: stock). Defensive picks, so bot hulls do not out-gun human ones.
 */
export const BOT_VEHICLE_UPGRADES = freeze({
  jeep: 'reinforced', jeep_at: 'reinforced', tank: 'reactive', helicopter: 'flare_reload', transport: 'field_repair', plane: 'extra_flares',
  aa: 'reactive', boat: 'reinforced',
});

/** Deploy-screen order of the hull rows. Types missing here follow in table order. */
export const UPGRADE_MENU_ORDER = freeze(['jeep', 'jeep_at', 'tank', 'aa', 'helicopter', 'transport', 'plane', 'boat']);

/** Hull types that offer upgrades, in UPGRADE_MENU_ORDER. */
export function upgradeTypes() {
  const keys = Object.keys(VEHICLE_UPGRADES);
  return [...UPGRADE_MENU_ORDER.filter(type => keys.includes(type)), ...keys.filter(type => !UPGRADE_MENU_ORDER.includes(type))];
}

/** Upgrade list of a hull type ([] for a type without upgrades). */
export function upgradesFor(type) {
  return typeof type === 'string' && Object.hasOwn(VEHICLE_UPGRADES, type) ? VEHICLE_UPGRADES[type] : [];
}

/** Upgrade row of a hull type and id, or null. */
export function vehicleUpgrade(type, id) {
  return typeof id === 'string' ? upgradesFor(type).find(upgrade => upgrade.id === id) ?? null : null;
}

/** Career level that opens an upgrade (Infinity for an unknown one). */
export function upgradeUnlockLevel(type, id) {
  const upgrade = vehicleUpgrade(type, id);
  return upgrade ? Math.max(1, Math.trunc(upgrade.unlockLevel ?? 1)) : Infinity;
}

/** True when a player at career `level` may drive with upgrade `id` on `type`. */
export function upgradeUnlocked(type, id, level) {
  const lv = Number.isFinite(level) ? Math.max(1, Math.trunc(level)) : 1;
  return lv >= upgradeUnlockLevel(type, id);
}

/**
 * A choice map `{type: upgradeId}` reduced to known types and ids (stock
 * entries dropped). Returns null for anything that is not a plain object.
 */
export function normalizeUpgradeChoice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [type, id] of Object.entries(value)) if (vehicleUpgrade(type, id)) out[type] = id;
  return out;
}

/** The entries of a choice map that are locked at `level`, as `[{type, id, level}]`. */
export function lockedUpgrades(choice, level) {
  return Object.entries(choice || {}).filter(([type, id]) => vehicleUpgrade(type, id) && !upgradeUnlocked(type, id, level))
    .map(([type, id]) => ({ type, id, level: upgradeUnlockLevel(type, id) }));
}

/** Vehicle row `upg` code: 1 + the index in the type's list, 0 for stock. */
export function upgradeCode(type, id) {
  const index = upgradesFor(type).findIndex(upgrade => upgrade.id === id);
  return index < 0 ? 0 : index + 1;
}

/** Upgrade row from a vehicle row's `upg` code, or null for stock. */
export function upgradeFromCode(type, code) {
  const index = Number.isInteger(code) ? code - 1 : -1;
  return index >= 0 ? upgradesFor(type)[index] ?? null : null;
}

/** Effects of the upgrade a live hull or a row carries (`upgrade` id, else `upg` code), or null. */
export function hullUpgradeEffects(vehicle) {
  if (!vehicle) return null;
  const upgrade = typeof vehicle.upgrade === 'string' ? vehicleUpgrade(vehicle.type, vehicle.upgrade)
    : Number.isInteger(vehicle.upg) ? upgradeFromCode(vehicle.type, vehicle.upg) : null;
  return upgrade?.effects ?? null;
}

const scaleOf = value => Number.isFinite(value) && value > 0 ? value : 1;
/** Hull damage-taken scale for a damage class (1 stock). */
export function upgradeDamageTaken(vehicle, cls) {
  const table = hullUpgradeEffects(vehicle)?.damageTaken;
  if (!table) return 1;
  return scaleOf(Object.hasOwn(table, cls) ? table[cls] : table.all);
}
/** A per-mount scale (`cooldown`, `reload`, `rearm`, `damage`) of a hull (1 stock). */
export function upgradeMountScale(vehicle, key, mountId) {
  const table = hullUpgradeEffects(vehicle)?.[key];
  return table && Object.hasOwn(table, mountId) ? scaleOf(table[mountId]) : 1;
}
/** Extra magazine rounds of a mount (0 stock). */
export function upgradeMagazineBonus(vehicle, mountId) {
  const bonus = hullUpgradeEffects(vehicle)?.magazine?.[mountId];
  return Number.isInteger(bonus) && bonus > 0 ? bonus : 0;
}
/** A hull-wide scale effect (`repair`, `cmCooldown`, `lockTime`, `speed`, `acceleration`; 1 stock). */
export function upgradeScale(vehicle, key) {
  return scaleOf(hullUpgradeEffects(vehicle)?.[key]);
}
/** Countermeasure salvos of a hull (1 stock). */
export function upgradeCmCharges(vehicle) {
  const extra = hullUpgradeEffects(vehicle)?.cmCharges;
  return 1 + (Number.isInteger(extra) && extra > 0 ? extra : 0);
}
/** Crew spotting override `{range, ms, smoke}` of a hull, or null. */
export function upgradeSpot(vehicle) {
  return hullUpgradeEffects(vehicle)?.spot ?? null;
}
