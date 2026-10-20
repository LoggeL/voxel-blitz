// Titanfall contract (docs/titanfall.md §2, §3, §11.1, §12.5): the frozen,
// import-free titan contract, the additive conquest helpers, titan defs and
// weapons, armour, wire encodings, kill keys, and every WP0 module with its
// frozen export names. Node only, no audio, no browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Client modules touch `document` for canvas text measurement at import time.
globalThis.document ??= { createElement: () => ({ getContext: () => new Proxy({ measureText: () => ({ width: 60 }) }, { get: (o, k) => o[k] ?? (() => {}) }) }) };

const contract = await import('../shared/titan-contract.js');
const {
  TITANFALL_CONTRACT_VERSION, TITAN_TYPE_IDS, TITAN_CHASSIS, TITAN_TOPOLOGY, TITAN_WEAPON_META, TITAN_ABILITIES,
  TITAN_COMMON_ABILITIES, TITAN_KILL_KEYS, TITAN_ABILITY_SLOTS, TITAN_PILOT_PRIMARIES, TITAN_PILOT_AT, TITAN_PILOT_TACTICALS,
  TITAN_LOADOUT_DEFAULT, TITAN_LOADOUT_DEFAULT_PACKED, TITANFALL_DIGIT_ROLES, isTitanType, titanWeaponRole,
  packTitanLoadout, unpackTitanLoadout, encodeTitanfallPlayer, decodeTitanfallPlayer, encodeTitanfallSelf,
  decodeTitanfallSelf, encodeTitanRow, decodeTitanRow,
} = contract;
const {
  VEHICLE_TYPE_IDS, DEPLOYABLE_TYPE_IDS, VEHICLE_TOPOLOGY, VEHICLE_WEAPON_META, vehicleMountOrder, seatWeaponList, vehicleWeaponMeta,
} = await import('../shared/conquest-contract.js');
const {
  VEHICLE_DEFS, VEHICLE_RULES, VEHICLE_HANDLING, VEHICLE_WEAPONS, VEHICLE_MASS, LOCK_RULES, VEHICLE_LIFECYCLE,
  vehicleDef, vehicleDriverSeatOf, vehicleMaxHp, isWalkerType,
} = await import('../shared/vehicle-defs.js');
const { vehicleEnterDistance } = await import('../shared/vehicles.js');
const { vehicleDriverSeat, vehicleSeats } = await import('../shared/vehicle-seats.js');
const { VEHICLE_COLLIDERS, solidHull, solidWreck } = await import('../shared/vehicle-collision.js');
const { ARMOR_MATRIX, TITAN_ARMOR, TITAN_ZONES, armorMultiplier, isArmorClass, isDamageClass } = await import('../shared/vehicle-armor.js');
const { MODE_IDS, MODE_RULES, isTitanfall, modeHasVehicles, isCombinedArms, isModeMapCompatible } = await import('../shared/modes.js');
const { lobbyCapacity, hasLobbyTeams, modeAllowsBots } = await import('../shared/lobby-limits.js');
const protocol = await import('./lib/protocol-contract.mjs');
const { GameEngine } = await import('../server/game.js');
const { getMapMeta, createMapState } = await import('../shared/world/templates.js');
const { TICK_MS } = await import('../server/protocol/admission.js');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const deeplyFrozen = value => !value || typeof value !== 'object'
  || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
const hasExports = (mod, names, label) => {
  for (const name of names) ok(name in mod && mod[name] !== undefined, `${label} exports ${name}`);
};

/* ---------------------------------------------------------- import-free and frozen */
{
  const source = readFileSync(new URL('../shared/titan-contract.js', import.meta.url), 'utf8');
  ok(!/^\s*import\b/m.test(source) && !/\bimport\s*\(/.test(source) && !/\brequire\s*\(/.test(source), 'titan-contract.js has no imports');
  eq(TITANFALL_CONTRACT_VERSION, 1, 'contract version');
  for (const [name, value] of Object.entries(contract)) {
    if (value && typeof value === 'object') ok(deeplyFrozen(value), `${name} is deeply frozen`);
  }
  hasExports(contract, ['TITANFALL_CONTRACT_VERSION', 'TITAN_TYPE_IDS', 'TITAN_CHASSIS', 'TITAN_LABELS', 'TITAN_ARMOR_CLASS', 'TITAN_MV',
    'TITAN_ABILITY_SLOTS', 'TITAN_PHASE', 'TITAN_ABILITY_BITS', 'TITANFALL_PLAYER_FLAGS', 'TITAN_TOPOLOGY', 'TITAN_WEAPON_META',
    'TITAN_ABILITIES', 'TITAN_COMMON_ABILITIES', 'TITAN_KILL_KEYS', 'TITAN_PILOT_TACTICALS', 'TITAN_PILOT_PRIMARIES', 'TITAN_PILOT_AT',
    'TITAN_PILOT_SIDEARM', 'TITAN_PILOT_MELEE', 'isTitanType', 'titanWeaponRole', 'TITANFALL_DIGIT_ROLES', 'TITAN_LOADOUT_DEFAULT',
    'TITAN_LOADOUT_DEFAULT_PACKED', 'packTitanLoadout', 'unpackTitanLoadout', 'encodeTitanfallPlayer', 'decodeTitanfallPlayer',
    'encodeTitanfallSelf', 'decodeTitanfallSelf', 'encodeTitanRow', 'decodeTitanRow'], 'titan-contract');
}

/* ---------------------------------------------------------- ids, topology, META */
{
  eq([...TITAN_TYPE_IDS], ['titan_ion', 'titan_scorch', 'titan_northstar', 'titan_ronin', 'titan_legion'], 'titan type ids');
  ok(new Set(TITAN_TYPE_IDS).size === TITAN_TYPE_IDS.length, 'titan ids unique');
  ok(TITAN_TYPE_IDS.every(type => !VEHICLE_TYPE_IDS.includes(type)), 'titan ids disjoint from conquest');
  eq([...VEHICLE_TYPE_IDS], ['jeep', 'tank', 'helicopter', 'transport', 'plane', 'jeep_at', 'aa', 'boat'], 'VEHICLE_TYPE_IDS: conquest hulls only');
  eq(Object.keys(TITAN_TOPOLOGY), [...TITAN_TYPE_IDS], 'topology covers every titan');
  eq(Object.keys(TITAN_CHASSIS), [...TITAN_TYPE_IDS], 'chassis covers every titan');
  ok(isTitanType('titan_ion') && !isTitanType('tank') && !isTitanType('constructor') && !isTitanType(null), 'isTitanType');
  const seatKeys = Object.keys(VEHICLE_TOPOLOGY.tank[0]).sort().join();
  const mountKeys = Object.keys(VEHICLE_TOPOLOGY.tank[0].mounts[0]).sort().join();
  for (const type of TITAN_TYPE_IDS) {
    const seats = TITAN_TOPOLOGY[type];
    ok(seats.length === 1 && seats[0].id === 'driver' && seats[0].drives === true, `${type} single driver seat`);
    for (const seat of seats) {
      eq(Object.keys(seat).sort().join(), seatKeys, `${type} seat row has the S shape`);
      for (const mount of seat.mounts) eq(Object.keys(mount).sort().join(), mountKeys, `${type} mount row has the M shape`);
    }
  }
  eq(TITAN_TOPOLOGY.titan_legion[0].mounts.map(m => [...m.weapons]), [['predatorClose', 'predatorLong']], 'legion: one mount, two weapons');
  const titanWeaponKeys = Object.keys(TITAN_WEAPON_META);
  ok(titanWeaponKeys.every(key => !Object.hasOwn(VEHICLE_WEAPON_META, key)), 'titan META keys disjoint from conquest META');
  ok(Object.keys(VEHICLE_WEAPON_META).every(key => !key.startsWith('titan') && !Object.hasOwn(TITAN_WEAPON_META, key)), 'conquest META carries no titan keys');
  for (const key of Object.keys(VEHICLE_WEAPON_META)) ok(vehicleWeaponMeta(key) === VEHICLE_WEAPON_META[key], `conquest META ${key} resolves unchanged`);
  const metaKeys = Object.keys(VEHICLE_WEAPON_META.tankAP).sort();
  for (const key of titanWeaponKeys) {
    ok(vehicleWeaponMeta(key) === TITAN_WEAPON_META[key], `vehicleWeaponMeta(${key})`);
    ok(TITAN_WEAPON_META[key].cls === 'titan', `${key} cls titan`);
    for (const field of metaKeys) ok(field in TITAN_WEAPON_META[key], `${key} META has ${field}`);
  }
  ok(vehicleWeaponMeta('nope') === null, 'unknown META is null');
  for (const type of TITAN_TYPE_IDS) {
    for (const slot of TITAN_ABILITY_SLOTS) {
      const ability = TITAN_ABILITIES[type]?.[slot];
      ok(ability && ability.slot === slot && typeof ability.primitive === 'string' && Array.isArray(ability.anchor), `${type} ${slot} ability row`);
      ok(ability.key === null || Object.hasOwn(TITAN_KILL_KEYS, ability.key), `${type} ${slot} kill key`);
    }
  }
  for (const [slot, ability] of Object.entries(TITAN_COMMON_ABILITIES)) ok(ability.slot === slot && Object.hasOwn(TITAN_KILL_KEYS, ability.key), `common ${slot}`);
  for (const key of titanWeaponKeys) ok(Object.hasOwn(TITAN_KILL_KEYS, key), `${key} is a kill key`);
  for (const key of ['titanfall', 'titan_doom', 'titan_crush', 'rodeo', 'electricSmoke', 'thermite']) ok(Object.hasOwn(TITAN_KILL_KEYS, key), `kill key ${key}`);
}

/* ---------------------------------------------------------- resolution through the conquest helpers and defs */
{
  const weaponFields = ['cooldown', 'magazine', 'reloadSeconds', 'range', 'spreadDeg', 'lifetimeMs', 'speed', 'gravity', 'damage', 'infantryDamage', 'cls'];
  for (const type of TITAN_TYPE_IDS) {
    const order = vehicleMountOrder(type);
    eq(order, TITAN_TOPOLOGY[type].flatMap(seat => seat.mounts.map(m => `${seat.id}:${m.id}`)), `${type} mount order`);
    const weapons = seatWeaponList(type, 'driver');
    ok(weapons.length >= 1 && weapons.every(w => vehicleWeaponMeta(w.weapon)), `${type} seat weapons resolve`);
    const def = vehicleDef(type);
    ok(def && def.handling === 'walker' && def.armor === 'titan' && def.damageClass === 'titan' && def.openCrew === false, `${type} def`);
    ok(isWalkerType(type) && !isWalkerType('tank'), `${type} walker`);
    ok(vehicleDriverSeatOf(type)?.id === 'driver' && vehicleDriverSeat(type)?.id === 'driver' && vehicleSeats(type).length === 1, `${type} driver seat`);
    ok(def.rules === VEHICLE_RULES[type] && VEHICLE_HANDLING[type] === 'walker', `${type} rules + handling`);
    ok(VEHICLE_RULES[type].radius > 0 && VEHICLE_RULES[type].height > 0, `${type} radius/height`);
    eq(VEHICLE_RULES[type].enterDistance, 6, `${type} enter distance`);
    eq(vehicleEnterDistance(type), 6, `${type} vehicleEnterDistance`);
    ok(def.respawnSeconds === Infinity, `${type} ephemeral`);
    ok(def.destruction && def.destruction.radius === 6 && def.destruction.damage === 120, `${type} destruction blast`);
    ok(def.hullBoxes.length >= 6, `${type} hull boxes`);
    ok(VEHICLE_COLLIDERS[type], `${type} collider`);
    ok(VEHICLE_MASS[type] > 0, `${type} mass`);
    ok(def.seatCameras?.driver || def.seats[0].camera, `${type} driver camera`);
    for (const { weapon } of weapons) {
      const numbers = VEHICLE_WEAPONS[weapon];
      ok(numbers, `${type} VEHICLE_WEAPONS.${weapon}`);
      for (const field of weaponFields) ok(field in numbers, `${weapon}.${field}`);
      eq(numbers.cls, 'titan', `${weapon} cls`);
    }
    for (const key of order) ok(def.mounts[key.split(':')[1]], `${type} mount anchor ${key}`);
  }
  // Conquest registries: key order conquest first, conquest entries carry no titan data.
  eq(Object.keys(VEHICLE_DEFS), [...VEHICLE_TYPE_IDS, ...TITAN_TYPE_IDS, ...DEPLOYABLE_TYPE_IDS], 'VEHICLE_DEFS order (deployables last)');
  eq(Object.keys(VEHICLE_RULES), Object.keys(VEHICLE_DEFS), 'VEHICLE_RULES keys');
  for (const type of VEHICLE_TYPE_IDS) {
    const def = VEHICLE_DEFS[type];
    ok(def.handling !== 'walker' && def.armor !== 'titan', `${type} is not a walker`);
    ok(Object.values(def.mounts).every(m => m.weapons.every(w => Object.hasOwn(VEHICLE_WEAPON_META, w))), `${type} mounts use conquest weapons`);
  }
  ok(LOCK_RULES.archer && LOCK_RULES.archer.range === 180 && LOCK_RULES.archer.seconds === 1.2, 'LOCK_RULES.archer');
}

/* ---------------------------------------------------------- armour */
{
  eq({ ...TITAN_ARMOR }, { small: 0.06, mg: 0.08, hmg: 0.2, autocannon: 0.5, explosive: 0.35, he: 0.6, at: 1.0, aa: 0.3, fire: 0.6,
    titan: 1.0, melee: 1.0, titanfall: 1.0, rodeo: 1.0 }, 'TITAN_ARMOR');
  eq({ ...TITAN_ZONES }, { rear: 1.3, top: 1.15, front: 1.0, side: 1.0 }, 'TITAN_ZONES');
  ok(isArmorClass('titan') && !isDamageClass('titan'), 'titan is an armour class, not a damage class');
  ok(Object.values(ARMOR_MATRIX).every(row => !('titan' in row)) && !('titan' in ARMOR_MATRIX), 'ARMOR_MATRIX has no titan column/row');
  ok(Math.abs(armorMultiplier('small', 'titan', 'rear') - 0.06 * 1.3) < 1e-12, 'small vs titan rear');
  ok(armorMultiplier('titan', 'titan', 'front') === 1 && armorMultiplier('at', 'titan', 'top') === 1.15, 'titan class and zones');
  ok(armorMultiplier('nope', 'titan') === 0, 'unknown class does nothing to a titan');
}

/* ---------------------------------------------------------- loadout pack and kit roles */
{
  ok(TITAN_LOADOUT_DEFAULT_PACKED === packTitanLoadout(TITAN_LOADOUT_DEFAULT), 'default pack');
  eq(unpackTitanLoadout(TITAN_LOADOUT_DEFAULT_PACKED), { ...TITAN_LOADOUT_DEFAULT }, 'default round-trip');
  for (const primary of TITAN_PILOT_PRIMARIES) for (const at of TITAN_PILOT_AT) for (const tactical of TITAN_PILOT_TACTICALS)
    for (const titan of TITAN_TYPE_IDS) {
      const packed = packTitanLoadout({ primary, at, tactical, titan });
      assert.ok(Number.isInteger(packed) && packed >= 0 && packed <= 0xffff);
      assert.deepEqual(unpackTitanLoadout(packed), { primary, at, tactical, titan });
    }
  checks++;
  for (const bad of [-1, 1.5, NaN, 'x', null, undefined, 2 ** 60]) eq(unpackTitanLoadout(bad), { ...TITAN_LOADOUT_DEFAULT }, `invalid ${String(bad)} → defaults`);
  eq(unpackTitanLoadout(15 | 15 << 4 | 15 << 8 | 15 << 12), { ...TITAN_LOADOUT_DEFAULT }, 'out-of-range fields clamp to defaults');
  eq(packTitanLoadout({ primary: 'nope', at: 'rocket', tactical: 99, titan: 'tank' }), TITAN_LOADOUT_DEFAULT_PACKED, 'unknown names pack to defaults');
  for (const id of TITAN_PILOT_PRIMARIES) eq(titanWeaponRole(id), 'primary', `${id} role`);
  for (const id of TITAN_PILOT_AT) eq(titanWeaponRole(id), 'at', `${id} role`);
  eq(titanWeaponRole('revolver'), 'sidearm', 'revolver role');
  eq(titanWeaponRole('knife'), 'melee', 'knife role');
  eq(titanWeaponRole('flamethrower'), null, 'foreign id has no role');
  eq([...TITANFALL_DIGIT_ROLES], ['primary', 'sidearm', 'at', 'melee'], 'digit roles');
}

/* ---------------------------------------------------------- wire encodings */
{
  const tf = encodeTitanfallPlayer({ mv: 8, titanId: 'T3', loadout: 0x1213, flags: 33, meter: 0.456, rodeoVehicleId: null, grapple: [1.25, 2, -3], titanKills: 4 });
  eq(tf.length, protocol.TITANFALL_TF_LENGTH, 'tf length');
  eq(tf, [8, 'T3', 0x1213, 33, 45, 0, [13, 20, -30], 4], 'tf encoding (the meter rounds down)');
  const decoded = decodeTitanfallPlayer({ tf });
  ok(decoded.titanId === 'T3' && decoded.battery && decoded.oob && !decoded.cloaked && decoded.meter === 0.45 && decoded.titanKills === 4, 'tf decode');
  ok(decodeTitanfallPlayer({}) === null, 'no tf → null');
  eq(encodeTitanfallPlayer(null), [0, 0, 0, 0, 0, 0, 0, 0], 'empty tf');
  const d = encodeTitanfallSelf({ vx: 1.234, vy: -2, vz: 0, wallN: -2, wallT: 0.5, jumpsLeft: 1, slideT: 0.25, slideCd: 1, tacCharges: 2, tacReady: 0.5, jumpSeqAck: 300, lockProgress: 2, tacKind: 'stim' });
  eq(d.length, protocol.TITANFALL_TFS_LENGTH, 'tfs length');
  const self = decodeTitanfallSelf({ t: 'tfs', s: 99, d });
  ok(self.seq === 99 && self.vx === 1.23 && self.wallN === -2 && self.jumpSeqAck === 255 && self.lockProgress === 1 && self.tacKind === 'stim', 'tfs round-trip and clamps');
  eq(decodeTitanfallSelf(encodeTitanfallSelf({})).tacKind, null, 'unknown tactical → null');
  eq([encodeTitanfallSelf({ tacReady: 0.996 })[9], encodeTitanRow({ core: 0.9951 }).tw[2], encodeTitanRow({ dash: 0.963 }).tw[1]], [99, 99, 9], 'readiness rounds down');
  ok(decodeTitanfallSelf({ d: [1, 2] }) === null, 'short tfs → null');
  const row = encodeTitanRow({ shield: 99.2, dash: 1.55, core: 0.5, doomLeft: 3.21, bits: 17, phase: 6, owner: 'p1', def: 1, tac: 0.333, ord: 0, smoke: 2 });
  eq(Object.keys(row).sort().join(), protocol.TITAN_ROW_EXTRA_KEYS, 'titan row extra keys');
  eq(row.tw.length, protocol.TITAN_TW_LENGTH, 'tw length');
  eq(row.ab.length, protocol.TITAN_AB_LENGTH, 'ab length');
  const back = decodeTitanRow(row);
  ok(back.shield === 100 && back.doomed && back.batteryOut && back.coreActive && back.owner === 'p1' && back.smokeCharges === 2, 'tw/ab decode');
  ok(decodeTitanRow({ id: 'jeep-1' }) === null, 'conquest rows decode to null');
  // A titan that is still doomed never encodes doom 0 (the last tenth rounds up).
  for (const doomLeft of [0.001, 0.04, 0.05, 6.99]) {
    const doomRow = encodeTitanRow({ doomLeft, phase: 6 });
    ok(doomRow.tw[3] >= 1 && decodeTitanRow(doomRow).doomed, `doomLeft ${doomLeft} stays doomed`);
  }
  eq(encodeTitanRow({ doomLeft: 7, phase: 6 }).tw[3], 70, 'doom 7 s = 70 tenths');
  ok(encodeTitanRow({ doomLeft: 0, phase: 0 }).tw[3] === 0 && !decodeTitanRow(encodeTitanRow({ phase: 0 })).doomed, 'alive titan not doomed');
  ok(decodeTitanRow({ tw: [0, 0, 0, 0, 0, 6] }).doomed, 'phase 6 decodes as doomed');
  eq(protocol.TITANFALL_PLAYER_EXTRA_KEYS, 'tf', 'protocol tf key');
  eq(protocol.TITANFALL_SELF_KEYS, 'd,s,t', 'protocol tfs keys');
  eq(protocol.TITAN_MOUNT_TUPLE_LENGTH, 6, 'titan mount tuple length (WP3)');
  ok(protocol.TITANFALL_MATCH_KEYS.split(',').includes('titanfall') && !protocol.MATCH_KEYS.split(',').includes('titanfall'), 'match keys');
  ok(!protocol.PLAYER_KEYS.split(',').includes('tf'), 'PLAYER_KEYS stay exact');
}

/* ---------------------------------------------------------- modes and lobby limits */
{
  ok(MODE_IDS.at(-1) === 'titanfall' && MODE_RULES.titanfall.vehicles === 'titans', 'mode registered last');
  ok(isTitanfall('titanfall') && !isTitanfall('conquest'), 'isTitanfall');
  ok(modeHasVehicles('titanfall') && modeHasVehicles('conquest') && !modeHasVehicles('tdm'), 'modeHasVehicles');
  ok(isCombinedArms === modeHasVehicles, 'isCombinedArms');
  for (const map of ['frontier', 'harbor', 'canyon', 'ashfall']) {
    ok(isModeMapCompatible('titanfall', map), `titanfall on ${map}`);
    eq(lobbyCapacity('titanfall', map), 16, `${map} titanfall capacity`);
  }
  ok(!isModeMapCompatible('titanfall', 'foundry'), 'titanfall maps are exact');
  ok(hasLobbyTeams('titanfall') && modeAllowsBots('titanfall'), 'teams + bots');
}

/* ---------------------------------------------------------- kill-feed names and glyphs */
{
  const hud = await import('../public/js/ui/hud-support.js');
  const icons = await import('../public/js/ui/conquest/icons.js');
  for (const key of [...Object.keys(TITAN_WEAPON_META), ...Object.keys(TITAN_KILL_KEYS)]) {
    ok(hud.WEAPON_NAMES[key], `${key} has a kill-feed name`);
    ok(hud.isVehicleKillKey(key) && hud.VEHICLE_KILL_KEYS.includes(key), `${key} is a vehicle kill key`);
    ok(icons.ICON_PATHS[icons.KILL_KEY_ICONS[key]], `${key} has a glyph`);
  }
  eq(hud.MODE_LABELS.titanfall, 'TITANFALL', 'MODE_LABELS.titanfall');
  for (const key of Object.keys(VEHICLE_WEAPON_META)) ok(hud.WEAPON_NAMES[key] === VEHICLE_WEAPON_META[key].label, `${key} conquest name unchanged`);
}

/* ---------------------------------------------------------- WP0 modules and frozen export names */
{
  const modules = {
    '../shared/vehicle-handling/titan.js': ['TITAN_RULES', 'titanFrame', 'createTitanMove', 'TITAN_DEFS_INPUT', 'placeWalker', 'stepTitanWalk'],
    '../shared/vehicle-handling/titan-weapons.js': ['TITAN_WEAPONS'],
    '../shared/pilot-movement.js': ['PILOT_RULES', 'createPilotState', 'pilotSpeedFor', 'pilotPreStep', 'pilotAccel', 'pilotVertical',
      'pilotPostCollide', 'stepPilot', 'PILOT_STATE_KEYS'],
    '../server/sim/titans.js': ['TitanSystem', 'TITAN_WRECK_SECONDS'],
    '../server/modes/titanfall.js': ['TitanfallPolicy'],
    '../server/sim/titanfall/index.js': ['TitanfallProjectiles'],
    '../server/sim/titanfall/play-area.js': ['PLAY_AREA_RULES', 'titanfallPlayArea', 'inPlayArea', 'avoidSpawns', 'stepOutOfBounds'],
    '../server/sim/titanfall/perception.js': ['PERCEPTION_RULES', 'isCloaked', 'isPerceivable', 'noteExposure'],
    '../server/sim/titanfall/pilot-tacticals.js': ['usePilotTactical', 'stepPilotTacticals', 'pilotTacticalFlags', 'pilotTacticalStatus', 'resetPilotTactical'],
    '../server/sim/titanfall/titan-damage.js': ['applyTitanDamage', 'titanHitZone'],
    '../server/sim/titanfall/rodeo.js': ['rodeoAction', 'stepRodeo', 'rodeoRiderHit', 'releaseRider'],
    '../server/sim/titanfall/batteries.js': ['TitanBatteries'],
    '../server/sim/titanfall/meter.js': ['meterStep', 'meterCredit', 'meterReset'],
    '../server/sim/titanfall/titan-projectiles.js': ['stepTitanProjectile', 'launchTitanProjectile', 'explodeTitanProjectile'],
    '../server/sim/titanfall/titan-abilities.js': ['useTitanAbility', 'stepTitanAbilities', 'resetTitanAbilities', 'abilityReadiness', 'abilityFor'],
    '../server/sim/titanfall/pilot-projectiles.js': ['TF_PILOT_PROJECTILES', 'firePilotProjectile', 'stepPilotProjectile', 'launchPilotProjectile', 'explodePilotProjectile'],
    '../server/sim/titanfall/loadout.js': ['titanfallOwned', 'applyTitanfallLoadout'],
    '../public/js/titanfall/titanfall-client.js': ['create', 'TITANFALL_CLIENT_MODULES', 'TITANFALL_CLIENT_HOOKS', 'TITANFALL_CSS_ID', 'TITANFALL_CSS_HREF'],
    '../public/js/titanfall/projectile-views.js': ['titanfallProjectileViews', 'STOCK_PROJECTILE_TYPES'],
    '../public/js/titanfall/pilot-client.js': ['tick', 'frame', 'onEvent', 'dispose', 'avatarState'],
    '../public/js/titanfall/titan-predict.js': ['tick', 'frame', 'onEvent', 'dispose'],
    '../public/js/titanfall/titan-presentation.js': ['tick', 'frame', 'onEvent', 'dispose', 'createModel', 'update'],
    '../public/js/titanfall/titan-projectile-views.js': ['tick', 'frame', 'onEvent', 'dispose', 'PROJECTILE_VIEWS'],
    '../public/js/titanfall/titan-ui.js': ['tick', 'frame', 'onEvent', 'dispose', 'titanHold'],
    '../public/js/titanfall/pilot-projectile-views.js': ['tick', 'frame', 'onEvent', 'dispose', 'PROJECTILE_VIEWS'],
    '../public/js/vehicles/models/titan-placeholder.js': ['makeTitanPlaceholderModel', 'TITAN_PLACEHOLDER_RIG'],
  };
  for (const [path, names] of Object.entries(modules)) hasExports(await import(path), names, path.replace('../', ''));
  const { TitanSystem } = await import('../server/sim/titans.js');
  for (const method of ['reset', 'call', 'spawnDrop', 'ownedBy', 'canEnter', 'onExit', 'eject', 'advance', 'step', 'rowExtras', 'wreckDone',
    'onDestroyed', 'applyDamage', 'riderHit', 'ability', 'rodeo', 'killRiders', 'isDoomed', 'shieldOf', 'doomedBy', 'pickupBattery',
    'batteries', 'removeOwned']) ok(typeof TitanSystem.prototype[method] === 'function', `TitanSystem.${method}`);
  const { TitanfallPolicy } = await import('../server/modes/titanfall.js');
  for (const method of ['titanfallIntent', 'selfFrame', 'titanMeter', 'setTitanMeter', 'titanTypeFor', 'teamSpawnPool', 'beforeTick',
    'onVehicleEvent', 'canMove', 'canFire', 'chooseSpawn', 'spawnPoolFor', 'playerSnapshot', 'matchSnapshot']) {
    ok(typeof TitanfallPolicy.prototype[method] === 'function', `TitanfallPolicy.${method}`);
  }
  ok(!('fallDamage' in TitanfallPolicy.prototype), 'TitanfallPolicy has no fallDamage');
  const { TitanfallProjectiles } = await import('../server/sim/titanfall/index.js');
  ok(typeof TitanfallProjectiles.prototype.step === 'function' && typeof TitanfallProjectiles.prototype.launch === 'function', 'projectile router');
  {
    // The router (frozen, not a stub) owns expiry: fuse and out-of-world remove every tf projectile.
    const active = new Map(), router = new TitanfallProjectiles({ active });
    const ctx = { now: 1000, dimensions: { sx: 192, sy: 64, sz: 144 }, airLimit: 0 };
    const put = (id, tf, extra) => { const p = { id, tf, x: 10, y: 10, z: 10, explodeAt: 2000, ...extra }; active.set(id, p); return p; };
    for (const tf of ['titan:t203', 'archer']) {
      router.step(put('live', tf), 1 / 60, 1, ctx);
      ok(active.has('live'), `${tf}: live in-world projectile kept`);
      router.step(put('fuse', tf, { explodeAt: 1000 }), 1 / 60, 1, ctx);
      ok(!active.has('fuse'), `${tf}: removed at explodeAt`);
      router.step(put('out', tf, { x: 300 }), 1 / 60, 1, ctx);
      ok(!active.has('out'), `${tf}: removed outside the world`);
      router.step(put('nan', tf, { y: NaN }), 1 / 60, 1, ctx);
      ok(!active.has('nan'), `${tf}: removed at a non-finite position`);
      active.clear();
    }
    router.step(put('odd', 'nope'), 1 / 60, 1, ctx);
    ok(!active.has('odd'), 'unknown tf kind removed');
  }
  const pilot = await import('../shared/pilot-movement.js');
  const state = pilot.createPilotState();
  ok(pilot.PILOT_STATE_KEYS.every(key => key in state), 'pilot state keys');
  for (const hook of ['pilotSpeedFor', 'pilotPreStep', 'pilotAccel', 'pilotVertical', 'pilotPostCollide', 'stepPilot']) {
    ok(typeof pilot[hook] === 'function', `pilot hook ${hook}`);
  }
  const titanfallClient = await import('../public/js/titanfall/titanfall-client.js');
  for (const [name, mod] of titanfallClient.TITANFALL_CLIENT_MODULES) {
    for (const hook of titanfallClient.TITANFALL_CLIENT_HOOKS) ok(typeof mod[hook] === 'function', `${name}.${hook}`);
  }
  ok(!readFileSync(new URL('../public/js/boot/match-runtime.js', import.meta.url), 'utf8').match(/^import[^\n]*titanfall/m),
    'match-runtime loads the titanfall client lazily');
}

/* ---------------------------------------------------------- a live titan hull: rays, mounts, wreck, row bytes */
{
  const now0 = Date.now;
  let last = null;
  const engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('harbor'), world: createMapState('harbor'), broadcast: s => { last = s; } });
  engine.addClient('h1', 'Owner');
  engine.addClient('h2', 'Enemy');
  // §3.4 deploy: humans wait on the loadout screen; put both on the field like the old join spawn.
  for (const id of ['h1', 'h2']) engine.mode.policy.deployNow(id);
  const owner = engine.entities.get('h1'), enemy = engine.entities.get('h2');
  const titans = engine.vehicles.titans;
  ok(titans && engine.vehicles.combatProfile === 'titanfall', 'titan system on a titanfall engine');
  engine.step(TICK_MS);
  // Drop each titan type on free level ground near the owner and let it land.
  const placed = [];
  const { placeWalker } = await import('../shared/vehicle-handling/titan.js');
  const { isSolidBlock } = await import('../shared/worlddata.js');
  const sy = engine.world.dimensions.sy;
  const findPad = type => {
    for (let r = 12; r < 120; r += 4) for (let k = 0; k < 24; k++) {
      const x = Math.floor(owner.x + Math.cos(k * Math.PI / 12) * r) + 0.5, z = Math.floor(owner.z + Math.sin(k * Math.PI / 12) * r) + 0.5;
      if (placed.some(v => Math.hypot(v.x - x, v.z - z) < 14)) continue;
      let y = sy - 1;
      while (y > 0 && !isSolidBlock(engine.world.getBlock(Math.floor(x), y, Math.floor(z)))) y--;
      const probe = { type, x, y: y + 1, z, yaw: 0 };
      const support = placeWalker(probe, x, z, titans.world);
      if (Number.isFinite(support)) return { x, y: support, z };
    }
    return null;
  };
  for (const type of TITAN_TYPE_IDS) {
    const pad = findPad(type);
    ok(pad, `${type} finds a pad`);
    const v = titans.spawnDrop(owner, pad.x, pad.y, pad.z, type, 0);
    ok(v && v.dropping && !solidHull(v), `${type} dropping hull is not solid`);
    placed.push(v);
  }
  for (const v of placed) {
    ok(engine.vehicles.mounts && (() => { engine.vehicles.mounts.reset(v); return true; })(), `${v.type} mounts.reset`);
  }
  const rowSizes = [];
  const measure = () => {
    engine.step(TICK_MS);
    for (const row of last.vehicles) rowSizes.push(JSON.stringify(row).length);
  };
  measure();
  ok(last.vehicles.length === TITAN_TYPE_IDS.length && last.vehicles.every(row => row.tw[5] === 1), 'dropping rows (phase 1)');
  // Client prediction collides with these rows: a dropping row must be as non-solid as the server body.
  ok(last.vehicles.every(row => !solidHull(row) && solidHull(row) === solidHull(placed.find(v => v.id === row.id))), 'dropping row solidHull matches the server body');
  for (let i = 0; i < 200; i++) engine.step(TICK_MS);
  for (const v of placed) {
    if (!(v.hp > 0)) { titans.vehicles.vehicles.delete(v.id); continue; }
    ok(!v.dropping && solidHull(v), `${v.type} landed and solid`);
    const centre = [v.x, v.y + VEHICLE_RULES[v.type].height * 0.5, v.z];
    const origin = [centre[0], centre[1], centre[2] + 30];
    const ray = engine.vehicles.rayHit(origin, [0, 0, -1], 60);
    ok(ray && ray.id === v.id && ray.distance > 20 && ray.distance < 30, `${v.type} rayHit ${JSON.stringify(ray && { id: ray.id, d: ray.distance })}`);
    const shot = engine.vehicles.projectileHit(origin, [0, 0, -1], 60);
    ok(shot && shot.id === v.id && Array.isArray(shot.normal), `${v.type} projectileHit`);
  }
  measure();
  ok(last.vehicles.filter(row => row.hp > 0).every(row => row.tw[5] !== 1 && solidHull(row)), 'landed rows are solid on the client');
  // Piloted, damaged, doomed rows.
  const ion = placed[2];
  Object.assign(owner, { x: ion.x, y: ion.y, z: ion.z - 3 });
  ok(engine.vehicles.action(owner, { type: 'enter', vehicleId: ion.id }), 'owner embarks');
  for (let i = 0; i < 80; i++) engine.step(TICK_MS);
  ok(owner.vehicleId === ion.id && !(owner.embarkUntil > engine.now), 'piloting after the embark lock');
  measure();
  engine.vehicles.damage(placed[0].id, 300, enemy, { cls: 'at', point: [placed[0].x, placed[0].y + 3, placed[0].z] });
  engine.vehicles.damage(placed[1].id, 1e6, enemy, { cls: 'at' });
  ok(placed[1].doomed && placed[1].hp > 0, 'doomed titan');
  measure();
  engine.vehicles.damage(placed[1].id, 1e6, enemy, { cls: 'at' });
  ok(!(placed[1].hp > 0), 'doomed titan destroyed');
  measure();
  // A fresh titan wreck is solid like a ground wreck, then removed.
  const wreck = placed[1];
  ok(solidWreck(wreck) && solidHull(wreck), 'titan wreck is solid');
  ok(Object.keys(engine.vehicles.row(wreck, engine.now)).includes('tw'), 'wreck row keeps tw');
  for (let i = 0; i < 60 * (VEHICLE_LIFECYCLE.wreckSolidSeconds + 1); i++) engine.step(TICK_MS);
  ok(!engine.vehicles.vehicles.has(wreck.id), 'titan wreck removed');
  const titanRows = rowSizes;
  const average = titanRows.reduce((a, b) => a + b, 0) / titanRows.length;
  ok(average <= 280, `titan row average ${average.toFixed(1)} B ≤ 280`);
  ok(Math.max(...titanRows) <= 300, `titan row max ${Math.max(...titanRows)} B ≤ 300`);
  for (const row of last.vehicles) {
    ok(row.tw?.length === 6 && row.ab?.length === 4 && typeof row.own === 'string', `${row.id} carries tw/own/ab`);
    ok(vehicleMaxHp(row) > 0, `${row.id} max hp`);
  }
  engine.stop();
  Date.now = now0;
  console.log(`  titan rows: ${titanRows.length} measured, average ${average.toFixed(1)} B, max ${Math.max(...titanRows)} B`);
}

/* ---------------------------------------------------------- event kinds reach the titanfall client (§3.8) */
{
  const { TITANFALL_EVENT_KINDS } = contract;
  ok(Object.isFrozen(TITANFALL_EVENT_KINDS) && new Set(TITANFALL_EVENT_KINDS).size === TITANFALL_EVENT_KINDS.length, 'TITANFALL_EVENT_KINDS frozen, unique');
  // Every kind the titanfall server code emits is listed (team_score rides the match block, as in TDM).
  const { readdirSync } = await import('node:fs');
  const sources = ['server/sim/titans.js', 'server/modes/titanfall.js',
    ...readdirSync(new URL('../server/sim/titanfall/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `server/sim/titanfall/${f}`)];
  const emitted = new Set();
  for (const file of sources) {
    for (const m of readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').matchAll(/\b_?emit\(\s*'([a-zA-Z_]+)'/g)) emitted.add(m[1]);
  }
  emitted.delete('team_score');
  eq([...emitted].sort(), [...TITANFALL_EVENT_KINDS].sort(), 'TITANFALL_EVENT_KINDS == kinds the titanfall server emits');
  // The real Session subscription forwards each of them to onGameplayEvent (a direct onEvent call cannot catch an omission).
  const { Session } = await import('../public/js/session/session.js');
  const handlers = new Map(), net = { on(kind, fn) { handlers.set(kind, fn); return () => handlers.delete(kind); } };
  const delivered = [], session = Object.create(Session.prototype);
  Object.assign(session, { _pregame: { net }, _gameplayUnsubs: [], _gameplayEventsWired: false, _liveResourcesOwned: true,
    _tornDown: false, _phase: 'live', onGameplayEvent: event => delivered.push(event.kind) });
  session._attachGameplayListeners(net);
  for (const kind of TITANFALL_EVENT_KINDS) handlers.get(kind)?.({ kind });
  eq(delivered, [...TITANFALL_EVENT_KINDS], 'Session forwards every titanfall event kind');
  session._detachGameplayListeners();
}

console.log(`Titanfall contract: ${checks} checks passed (import-free frozen contract, topology/META/defs/weapons through the conquest helpers, armour, loadout pack, tf/tfs/tw/ab wire, kill keys and glyphs, WP0 module exports, rays/mounts/wreck and titan row bytes).`);
