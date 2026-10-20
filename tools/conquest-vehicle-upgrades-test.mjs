// Conquest vehicle upgrades (shared/vehicle-upgrades.js): the table, the
// deploy intent's `upgrades` map (parse, career gate, `deploy_refused
// {reason:'locked'}`), the hull sync (the driver's pick rides the hull while
// they drive, bots drive the fixed default, an empty driver seat is stock),
// the row's `upg`, every effect on the authoritative hull, and the client
// side: the deploy model, the VEHICLES tab of the deploy screen (fake DOM)
// and the vehicle panel badge.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { parseConquestIntent } from '../server/protocol/admission.js';
import {
  VEHICLE_UPGRADES, BOT_VEHICLE_UPGRADES, UPGRADE_MENU_ORDER, upgradeTypes, upgradesFor, vehicleUpgrade, upgradeUnlocked,
  upgradeCode, upgradeFromCode, lockedUpgrades, normalizeUpgradeChoice, upgradeDamageTaken, upgradeMountScale, upgradeScale,
} from '../shared/vehicle-upgrades.js';
import { CONQUEST_CONTRACT_VERSION, CONQUEST_INTENT_SHAPE, VEHICLE_TYPE_IDS } from '../shared/conquest-contract.js';
import { COUNTERMEASURE_RULES, LOCK_RULES, VEHICLE_WEAPONS, vehicleMaxHp } from '../shared/vehicle-defs.js';
import { JEEP_RULES, stepJeepDrive } from '../shared/vehicle-handling/jeep.js';
import { BOAT_RULES, stepBoatDrive } from '../shared/vehicle-handling/boat.js';
import { setHullUpgrade, upgradedHitscan } from '../server/sim/vehicle-upgrades.js';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';

const TICK = 1000 / 60;
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const near = (a, b, eps, message) => assert.ok(Math.abs(a - b) <= eps, `${message} (${a} vs ${b})`);

function fixture(spawns) {
  const dimensions = { sx: 640, sy: 64, sz: 640 }, frames = [];
  const world = { dimensions, getBlock: (x, y, z) => y === 0 ? 3 : 0, setBlock: () => true, findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: spawns } } });
  const policy = game.mode.policy;
  const player = (id, team, extra = {}) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    policy.setLobbyTeam(p, team);
    Object.assign(p, { hp: 100, armor: 0, spawnProtectedUntil: 0, spawnProtected: false, grounded: true, input: { keys: {}, yaw: 0, pitch: 0 }, ...extra });
    return p;
  };
  /** A human with a career level and stored upgrade picks (what an accepted deploy stores). */
  const human = (id, team, level, upgrades = {}) => {
    const p = player(id, team);
    policy.setCareerLevel(p, level);
    policy.upgrades.choose(p, upgrades);
    return p;
  };
  const vehicle = id => game.vehicles.vehicles.get(id);
  const board = (p, id, seatId) => {
    const v = vehicle(id);
    Object.assign(p, { x: v.x, y: v.y, z: v.z });
    game.applyInput(p.id, { keys: {}, yaw: v.yaw, pitch: 0, vehicleAction: { type: 'enter', vehicleId: id, seatId } });
    assert.equal(p.vehicleSeatId, seatId, `${p.id} boards ${id} as ${seatId}`);
    return p;
  };
  const leave = p => game.applyInput(p.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'exit' } });
  const step = (n = 1) => { for (let i = 0; i < n; i++) game.step(TICK); };
  const events = kind => frames.flatMap(frame => frame.events).filter(event => event.kind === kind);
  const row = id => frames.at(-1)?.vehicles.find(r => r.id === id);
  return { game, policy, frames, player, human, vehicle, board, leave, step, events, row };
}
const pad = (id, type, team = 'alpha', x = 300, z = 300) => ({ id, type, team, x, y: 1, z, yaw: 0 });

/* ------------------------------------------------------------- table */

await test('table: keyed by vehicle type, unique ids, career levels, bot defaults, row codes', () => {
  assert.deepEqual(upgradeTypes(), UPGRADE_MENU_ORDER, 'every hull type of the table is on the deploy screen');
  for (const [type, list] of Object.entries(VEHICLE_UPGRADES)) {
    assert.ok(VEHICLE_TYPE_IDS.includes(type), `${type} is a Conquest hull type`);
    assert.ok(list.length >= 2 && list.length <= 3, `${type} offers 2-3 upgrades`);
    assert.equal(new Set(list.map(u => u.id)).size, list.length, `${type} ids are unique`);
    for (const upgrade of list) {
      assert.ok(upgrade.unlockLevel >= 2, `${type}.${upgrade.id} is a career unlock`);
      assert.ok(upgrade.label && upgrade.short && upgrade.hint && Object.keys(upgrade.effects).length, `${type}.${upgrade.id} is complete`);
      assert.equal(upgradeFromCode(type, upgradeCode(type, upgrade.id)), upgrade, 'the row code round-trips');
    }
    assert.ok(vehicleUpgrade(type, BOT_VEHICLE_UPGRADES[type]), `bots drive a real ${type} upgrade`);
  }
  assert.equal(upgradeCode('tank', 'reactive'), 1); assert.equal(upgradeCode('tank', null), 0); assert.equal(upgradeFromCode('tank', 0), null);
  assert.deepEqual(upgradesFor('mortar'), [], 'a hull type without a table entry has no upgrades (added later by key)');
  for (const type of ['aa', 'boat']) assert.equal(upgradesFor(type).length, 2, `the ${type} hull offers two upgrades`);
  assert.ok(!upgradeUnlocked('tank', 'thermal', 7) && upgradeUnlocked('tank', 'thermal', 8), 'THERMAL OPTICS opens at LV 8');
  assert.deepEqual(normalizeUpgradeChoice({ tank: 'reactive', jeep: 'nope', boat: 'x' }), { tank: 'reactive' });
  assert.deepEqual(lockedUpgrades({ tank: 'thermal', jeep: 'reinforced' }, 4), [{ type: 'tank', id: 'thermal', level: 8 }]);
  assert.equal(CONQUEST_CONTRACT_VERSION, 7, 'the deploy intent and the vehicle row changed: contract v6');
  assert.ok(CONQUEST_INTENT_SHAPE.deploy.includes('upgrades'));
});

await test('table: the hint numbers match the hull rules they describe', () => {
  const hint = (type, id) => vehicleUpgrade(type, id).hint;
  const fx = (type, id) => vehicleUpgrade(type, id).effects;
  const s = n => String(Math.round(n * 100) / 100);
  assert.ok(hint('jeep', 'turbo').includes(`${s(JEEP_RULES.speed)} → ${Math.round(JEEP_RULES.speed * fx('jeep', 'turbo').speed)} M/S`));
  assert.ok(hint('jeep', 'turbo').includes(`${Math.round((fx('jeep', 'turbo').acceleration - 1) * 100)} % MORE ACCELERATION`));
  const tow = VEHICLE_WEAPONS.towMissile.reloadSeconds;
  assert.ok(hint('jeep_at', 'tow_reload').includes(`${s(tow)} → ${s(tow * fx('jeep_at', 'tow_reload').reload.pintle)} S`));
  const ap = VEHICLE_WEAPONS.tankAP.cooldown;
  assert.equal(VEHICLE_WEAPONS.tankHE.cooldown, ap, 'AP and HE share the main gun reload');
  assert.ok(hint('tank', 'autoloader').includes(`${s(ap)} → ${s(ap * fx('tank', 'autoloader').cooldown.main)} S`));
  assert.ok(hint('tank', 'reactive').includes(`${Math.round((1 - fx('tank', 'reactive').damageTaken.at) * 100)} % LESS`));
  assert.ok(hint('jeep', 'reinforced').includes(`${Math.round((1 - fx('jeep', 'reinforced').damageTaken.all) * 100)} % LESS`));
  const flare = COUNTERMEASURE_RULES.flares.cooldownSeconds;
  assert.ok(hint('helicopter', 'flare_reload').includes(`${s(flare)} → ${s(flare * fx('helicopter', 'flare_reload').cmCooldown)} S`));
  assert.ok(hint('helicopter', 'extra_missile').includes(`${VEHICLE_WEAPONS.guidedMissile.magazine + fx('helicopter', 'extra_missile').magazine.atgm} GUIDED MISSILES INSTEAD OF ${VEHICLE_WEAPONS.guidedMissile.magazine}`));
  assert.ok(hint('transport', 'field_repair').includes(`${Math.round((fx('transport', 'field_repair').repair - 1) * 100)} % FASTER`));
  assert.ok(hint('transport', 'heavy_doorguns').includes(`${Math.round((fx('transport', 'heavy_doorguns').damage['door-left'] - 1) * 100)} % MORE`));
  assert.ok(hint('plane', 'extra_flares').includes(`${s(flare)} S COOLDOWN`));
  const lock = fx('plane', 'ecm').lockTime;
  assert.ok(hint('plane', 'ecm').includes(`${Math.round((lock - 1) * 100)} % LONGER`));
  assert.ok(hint('plane', 'ecm').includes(`STINGER ${s(LOCK_RULES.stinger.seconds)} → ${s(LOCK_RULES.stinger.seconds * lock)} S`));
  assert.ok(hint('plane', 'ecm').includes(`AA MISSILE ${s(LOCK_RULES.aaMissile.seconds)} → ${s(LOCK_RULES.aaMissile.seconds * lock)} S`));
  const rearm = fx('plane', 'quick_rearm').rearm;
  assert.ok(hint('plane', 'quick_rearm').includes(`AA MISSILES RE-ARM ${s(VEHICLE_WEAPONS.aaMissile.rearmSeconds)} → ${s(VEHICLE_WEAPONS.aaMissile.rearmSeconds * rearm.rails)} S`));
  assert.ok(hint('plane', 'quick_rearm').includes(`BOMBS ${s(VEHICLE_WEAPONS.jetBomb.rearmSeconds)} → ${s(VEHICLE_WEAPONS.jetBomb.rearmSeconds * rearm.bombs)} S`));
  const thermal = fx('tank', 'thermal').spot;
  assert.ok(hint('tank', 'thermal').includes(`${thermal.range} M, LAST ${thermal.ms / 1000} S`));
  assert.ok(hint('aa', 'reactive').includes(`${Math.round((1 - fx('aa', 'reactive').damageTaken.at) * 100)} % LESS`));
  const radar = fx('aa', 'search_radar').spot;
  assert.ok(hint('aa', 'search_radar').includes(`${radar.range} M IN ANY WEATHER AND LAST ${radar.ms / 1000} S`) && !radar.smoke);
  assert.ok(hint('boat', 'reinforced').includes(`${Math.round((1 - fx('boat', 'reinforced').damageTaken.all) * 100)} % LESS`));
  assert.ok(hint('boat', 'waterjet').includes(`${s(BOAT_RULES.speed)} → ${Math.round(BOAT_RULES.speed * fx('boat', 'waterjet').speed)} M/S`));
  assert.ok(hint('boat', 'waterjet').includes(`${Math.round((fx('boat', 'waterjet').acceleration - 1) * 100)} % MORE ACCELERATION`));
});

await test('protocol: the deploy intent carries an exact upgrades map', () => {
  const deploy = upgrades => parseConquestIntent({ t: 'conquest', deploy: { spawn: 'hq', kit: 'assault', variant: 0, upgrades } });
  assert.deepEqual(deploy({ tank: 'reactive', plane: 'ecm' }).upgrades, { tank: 'reactive', plane: 'ecm' });
  assert.deepEqual(deploy({}).upgrades, {}, 'an empty map means every hull stock');
  assert.equal(parseConquestIntent({ t: 'conquest', deploy: { spawn: 'hq', kit: 'assault' } }).upgrades, undefined, 'older clients send none');
  assert.equal(deploy({ tank: 'turbo' }), null, 'an id of another hull is refused');
  assert.equal(deploy({ submarine: 'reactive' }), null, 'an unknown hull type is refused');
  assert.equal(deploy(['reactive']), null);
  assert.equal(deploy({ tank: 1 }), null);
});

/* -------------------------------------------------------------- gate */

await test('gate: a locked upgrade is refused like a locked kit; an accepted deploy stores the picks', () => {
  const f = fixture([]);
  const h = f.player('h', 'alpha'), foe = f.player('foe', 'bravo');
  f.policy.setCareerLevel(h, 3);
  f.step();
  h.takeDamage(500, false, foe, 'rifle'); f.game.killPlayer(h, foe, 'rifle', false);
  f.game.tickEvents.length = 0;
  const intent = upgrades => ({ type: 'deploy', spawn: 'hq', kit: 'assault', variant: 0, gadget: 0, upgrades });
  assert.equal(f.game.mode.conquestIntent(h, intent({ tank: 'autoloader' })), false, 'AUTOLOADER (LV 4) is refused at LV 3');
  const refusal = f.game.tickEvents.find(e => e.kind === 'deploy_refused' && e.id === 'h');
  assert.deepEqual([refusal?.reason, refusal?.vehicle, refusal?.upgrade, refusal?.level], ['locked', 'tank', 'autoloader', 4]);
  assert.equal(h.vehicleUpgrades, undefined, 'a refused deploy stores nothing');
  assert.equal(f.game.mode.conquestIntent(h, intent({ tank: 'reactive', helicopter: 'flare_reload' })), true, 'open picks deploy');
  assert.deepEqual({ ...h.vehicleUpgrades }, { tank: 'reactive', helicopter: 'flare_reload' });
  assert.equal(f.game.mode.conquestIntent(h, { type: 'deploy', spawn: 'hq', kit: 'medic', variant: 0, gadget: 0 }), true);
  assert.deepEqual({ ...h.vehicleUpgrades }, { tank: 'reactive', helicopter: 'flare_reload' }, 'a deploy without upgrades keeps the picks');
  assert.equal(f.game.mode.conquestIntent(h, intent({})), true);
  assert.deepEqual({ ...h.vehicleUpgrades }, {}, 'an empty map resets every hull to stock');
  // Bots skip the gate (they never send upgrades anyway).
  assert.equal(f.policy.upgrades.refusal({ bot: true, careerLevel: 1 }, { tank: 'thermal' }), null);
});

/* -------------------------------------------------------------- sync */

await test('sync: the driver\'s pick rides the hull while they drive; a gunner\'s pick never does', () => {
  const f = fixture([pad('tank', 'tank')]);
  const tank = f.vehicle('tank');
  const driver = f.human('d', 'alpha', 4, { tank: 'autoloader' }), gunner = f.human('g', 'alpha', 9, { tank: 'thermal' });
  f.step();
  assert.equal(tank.upgrade ?? null, null, 'an empty hull is stock');
  f.board(gunner, 'tank', 'commander'); f.step(2);
  assert.equal(tank.upgrade ?? null, null, 'the commander\'s pick does not apply');
  f.board(driver, 'tank', 'driver'); f.step(2);
  assert.equal(tank.upgrade, 'autoloader');
  assert.equal(f.row('tank').upg, upgradeCode('tank', 'autoloader'), 'the row carries the driver\'s upgrade');
  f.leave(driver); f.step(2);
  assert.equal(tank.upgrade, null, 'leaving the driver seat takes the upgrade with you');
  assert.equal(f.row('tank').upg, undefined, 'a stock row omits upg');
  // A pick above the level the server holds drives stock (defence in depth: levels never drop in play).
  const low = f.human('low', 'alpha', 2, {});
  low.vehicleUpgrades = { tank: 'thermal' };
  f.board(low, 'tank', 'driver'); f.step(2);
  assert.equal(tank.upgrade, null, 'a locked stored pick is never applied');
});

await test('sync: bots drive the fixed default upgrade', () => {
  const f = fixture([pad('tank', 'tank'), pad('jet', 'plane', 'alpha', 340, 300)]);
  const bot = f.player('bot-1', 'alpha'); bot.bot = true;
  const pilot = f.player('bot-2', 'alpha'); pilot.bot = true;
  f.board(bot, 'tank', 'driver'); f.board(pilot, 'jet', 'driver'); f.step(2);
  assert.equal(f.vehicle('tank').upgrade, BOT_VEHICLE_UPGRADES.tank);
  assert.equal(f.vehicle('jet').upgrade, BOT_VEHICLE_UPGRADES.plane);
});

/* ----------------------------------------------------------- effects */

await test('reactive armour: AT hits deal 15 % less; other classes unchanged', () => {
  const f = fixture([pad('a', 'tank', 'alpha', 300, 300), pad('b', 'tank', 'alpha', 340, 300)]);
  const foe = f.player('foe', 'bravo', { x: 320, y: 1, z: 360 });
  const d = f.human('d', 'alpha', 2, { tank: 'reactive' });
  f.board(d, 'a', 'driver'); f.step(2);
  const a = f.vehicle('a'), b = f.vehicle('b');
  const hit = v => { const before = v.hp; f.game.vehicles.damage(v.id, 300, foe, { cls: 'at', origin: [v.x, v.y + 1, v.z + 6] }); return before - v.hp; };
  const stock = hit(b), reactive = hit(a);
  near(reactive / stock, 0.85, 1e-6, 'reactive armour takes 0.85 of the stock AT hit');
  assert.equal(upgradeDamageTaken(a, 'he'), 1, 'HE is unchanged');
});

await test('reinforced chassis: 25 % less from bullets, blasts, fire and crashes; AT still kills', () => {
  const f = fixture([pad('a', 'jeep', 'alpha', 300, 300), pad('b', 'jeep', 'alpha', 340, 300)]);
  const foe = f.player('foe', 'bravo', { x: 320, y: 1, z: 360 });
  const d = f.human('d', 'alpha', 2, { jeep: 'reinforced' });
  f.board(d, 'a', 'driver'); f.step(2);
  const a = f.vehicle('a'), b = f.vehicle('b');
  const hit = (v, cls, amount) => { const before = v.hp; f.game.vehicles.damage(v.id, amount, foe, { cls, origin: [v.x, v.y + 1, v.z + 4] }); return before - v.hp; };
  near(hit(a, 'hmg', 40) / hit(b, 'hmg', 40), 0.75, 1e-6, 'an HMG burst');
  assert.equal(upgradeDamageTaken(a, 'collision'), 0.75, 'crash damage');
  assert.equal(upgradeDamageTaken(a, 'at'), 1, 'AT is unchanged');
  f.game.vehicles.damage('a', 400, foe, { cls: 'at', origin: [a.x, a.y + 1, a.z + 4] });
  assert.equal(a.hp, 0, 'an AT mine still kills the reinforced jeep');
});

await test('autoloader: the tank main gun reloads in 2.8 s', () => {
  const f = fixture([pad('tank', 'tank')]);
  const d = f.human('d', 'alpha', 4, { tank: 'autoloader' });
  f.board(d, 'tank', 'driver'); f.step(2);
  const tank = f.vehicle('tank'), main = f.game.vehicles.mounts.state(tank, 'main');
  assert.equal(f.game.vehicles.mounts.fire(tank, f.game.vehicles.seatFor(d, tank), d, 'main', 'tankAP'), true);
  near(main.cooldown, VEHICLE_WEAPONS.tankAP.cooldown * 0.8, 1e-9, 'AP reload 3.5 → 2.8 s');
  assert.equal(f.game.vehicles.mounts.rows(tank)[0][4], 100, 'the row reports a full reload bar against the upgraded time');
});

await test('quick TOW reload: the AT jeep\'s box reloads in 7.2 s', () => {
  const f = fixture([pad('atj', 'jeep_at')]);
  const d = f.human('d', 'alpha', 6, { jeep_at: 'tow_reload' }), g = f.player('g', 'alpha');
  f.board(d, 'atj', 'driver'); f.board(g, 'atj', 'gunner'); f.step(2);
  const v = f.vehicle('atj'), pintle = f.game.vehicles.mounts.state(v, 'pintle');
  Object.assign(pintle, { ammo: 1, cooldown: 0 });
  assert.equal(f.game.vehicles.mounts.fire(v, f.game.vehicles.seatFor(g, v), g, 'pintle', 'towMissile'), true);
  near(pintle.reloadT, VEHICLE_WEAPONS.towMissile.reloadSeconds * 0.6, 1e-9, 'box reload 12 → 7.2 s');
});

await test('extra missile: the attack heli carries 3 guided missiles while its pilot drives', () => {
  const f = fixture([pad('heli', 'helicopter')]);
  const heli = f.vehicle('heli'), atgm = () => f.game.vehicles.mounts.state(heli, 'atgm');
  assert.equal(atgm().ammo, VEHICLE_WEAPONS.guidedMissile.magazine);
  const pilot = f.human('p', 'alpha', 6, { helicopter: 'extra_missile' });
  f.board(pilot, 'heli', 'driver'); f.step(2);
  assert.equal(atgm().ammo, 3, 'a full stock rack is topped up at once');
  f.leave(pilot); f.step(2);
  assert.equal(atgm().ammo, 2, 'the extra round leaves with the pilot');
  assert.deepEqual(atgm().heldRearm, [0], 'and is held off the rack, loaded');
  f.board(pilot, 'heli', 'driver'); f.step(2);
  assert.equal(atgm().ammo, 3, 'the held round comes back with the pilot');
  // A partly spent rack grows by re-arming, never by a free round.
  const state = atgm();
  state.ammo = 1; state.rearm = [VEHICLE_WEAPONS.guidedMissile.rearmSeconds];
  setHullUpgrade(heli, null); delete state.heldRearm; setHullUpgrade(heli, 'extra_missile');
  assert.equal(state.ammo, 1); assert.equal(state.rearm.length, 2, 'the missing extra round re-arms on the rail timer');
  setHullUpgrade(heli, null);
  assert.ok(state.ammo + state.rearm.length <= 2, 'shrinking takes pending re-arms above the stock rack off the rack');
  // Hopping out and back in never refills a fired round: one shot from the full 3-rack
  // leaves 2 + a re-arm; the stock rack holds 2, so the re-arm waits off the rack.
  const rearm = VEHICLE_WEAPONS.guidedMissile.rearmSeconds;
  Object.assign(state, { ammo: 2, rearm: [rearm], reloadT: 0 }); delete state.heldRearm;
  heli.upgrade = 'extra_missile';
  setHullUpgrade(heli, null);
  assert.deepEqual([state.ammo, state.rearm.length, state.heldRearm?.length], [2, 0, 1], 'the pending re-arm is held, not dropped');
  f.game.vehicles.mounts.tickTimers(state, 2, heli);
  setHullUpgrade(heli, 'extra_missile');
  assert.equal(state.ammo, 2, 'no free round from hopping out and in');
  near(state.rearm[0], rearm - 2, 1e-9, 'the held re-arm resumes with its time left (it kept counting off the rack)');
  assert.equal(state.heldRearm, undefined);
});

await test('flare reload and extra flares: countermeasure cooldown and charges', () => {
  const f = fixture([pad('heli', 'helicopter'), pad('jet', 'plane', 'alpha', 360, 300)]);
  const heliPilot = f.human('hp', 'alpha', 3, { helicopter: 'flare_reload' }), jetPilot = f.human('jp', 'alpha', 3, { plane: 'extra_flares' });
  f.board(heliPilot, 'heli', 'driver'); f.board(jetPilot, 'jet', 'driver'); f.step(2);
  const locks = f.game.vehicles.locks, heli = f.vehicle('heli'), jet = f.vehicle('jet');
  const now = f.game.vehicles.nowMs();
  assert.equal(locks.countermeasure(heli), 'flares');
  near(heli.cmReadyAt - now, COUNTERMEASURE_RULES.flares.cooldownSeconds * 0.6 * 1000, 1, 'flare cooldown 18 → 10.8 s');
  assert.equal(locks.countermeasure(jet), 'flares', 'first salvo');
  assert.equal(locks.readiness(jet), 100, 'the second salvo is still in hand');
  assert.equal(locks.countermeasure(jet), 'flares', 'second salvo');
  assert.equal(locks.countermeasure(jet), null, 'both salvos spent');
  assert.ok(locks.readiness(jet) < 100);
  // Leaving and re-entering never refreshes a spent salvo.
  f.leave(jetPilot); f.step(2);
  assert.equal(jet.cmSlots.length, 1);
  f.board(jetPilot, 'jet', 'driver'); f.step(2);
  assert.equal(locks.countermeasure(jet), null, 'no free salvo from hopping out and in');
  // One salvo spent, one in hand: the hull keeps the ready one when the pilot hops out.
  delete jet.cmSlots; jet.cmReadyAt = 0;
  assert.equal(locks.countermeasure(jet), 'flares');
  f.leave(jetPilot); f.step(2);
  assert.equal(jet.upgrade, null);
  assert.equal(locks.readiness(jet), 100, 'the stock hull still has the unspent salvo');
  f.board(jetPilot, 'jet', 'driver'); f.step(2);
  assert.equal(locks.countermeasure(jet), 'flares', 'the unspent salvo');
  assert.equal(locks.countermeasure(jet), null, 'the spent one came back on its own cooldown, not refreshed');
});

await test('ECM jammer: an enemy AA lock on the jet takes 50 % longer', () => {
  const f = fixture([pad('own', 'plane', 'alpha', 200, 200), pad('foe', 'plane', 'bravo', 200, 420)]);
  const target = f.vehicle('foe');
  const ecm = f.human('ecm', 'bravo', 6, { plane: 'ecm' });
  f.board(ecm, 'foe', 'driver');
  const hunter = f.human('hunter', 'alpha', 1);
  f.board(hunter, 'own', 'driver');
  const own = f.vehicle('own');
  const fly = () => {
    Object.assign(own, { x: 200, y: 40, z: 200, yaw: Math.PI, pitch: 0, roll: 0, grounded: false, vx: 0, vy: 0, vz: 0 });
    Object.assign(target, { x: 200, y: 40, z: 420, yaw: Math.PI, pitch: 0, roll: 0, grounded: false, vx: 0, vy: 0, vz: 0 });
  };
  f.game.applyInput(hunter.id, { keys: {}, yaw: Math.PI, pitch: 0, vehicleAction: { type: 'weapon', index: 1 } });
  let lockedAt = -1, startAt = -1;
  for (let i = 0; i < 260 && lockedAt < 0; i++) {
    f.game.applyInput(hunter.id, { keys: {}, yaw: Math.PI, pitch: 0 });
    fly(); f.step();
    if (startAt < 0 && hunter.lockProgress > 0) startAt = i;
    if (f.game.vehicles.locks.lockedTarget(hunter, 'aaMissile') === 'foe') lockedAt = i;
  }
  assert.equal(target.upgrade, 'ecm');
  assert.ok(startAt >= 0 && lockedAt > startAt, 'the lock builds and completes');
  near((lockedAt - startAt + 1) / 60, LOCK_RULES.aaMissile.seconds * 1.5, 0.05, 'AA missile lock 1.5 → 2.25 s');
  assert.equal(upgradeScale(target, 'lockTime'), 1.5);
});

await test('quick rearm: the jet\'s AA missiles and bombs re-arm 40 % faster', () => {
  const f = fixture([pad('jet', 'plane')]);
  const pilot = f.human('p', 'alpha', 8, { plane: 'quick_rearm' });
  f.board(pilot, 'jet', 'driver'); f.step(2);
  const jet = f.vehicle('jet'), mounts = f.game.vehicles.mounts, seat = f.game.vehicles.seatFor(pilot, jet);
  Object.assign(jet, { y: 40, grounded: false, vx: 0, vy: 0, vz: -50 });
  assert.equal(mounts.fire(jet, seat, pilot, 'rails', 'aaMissile'), true);
  near(mounts.state(jet, 'rails').rearm[0], VEHICLE_WEAPONS.aaMissile.rearmSeconds * 0.6, 1e-9, 'AA missile 15 → 9 s');
  assert.equal(mounts.fire(jet, seat, pilot, 'bombs', 'jetBomb'), true);
  near(mounts.state(jet, 'bombs').rearm[0], VEHICLE_WEAPONS.jetBomb.rearmSeconds * 0.6, 1e-9, 'bomb 10 → 6 s');
});

await test('transport: field repair restores 50 % faster, heavy door guns hit 30 % harder', () => {
  const f = fixture([pad('t', 'transport'), pad('s', 'transport', 'alpha', 340, 300)]);
  const pilot = f.human('p', 'alpha', 5, { transport: 'field_repair' });
  f.board(pilot, 't', 'driver'); f.step(2);
  const t = f.vehicle('t'), s = f.vehicle('s');
  t.hp = s.hp = 300;
  assert.equal(f.game.vehicles.repair('t', 20, null), 30, 'an Engineer\'s 20 HP restore 30');
  assert.equal(f.game.vehicles.repair('s', 20, null), 20, 'stock');
  t.hp = s.hp = 200; t.lastDamagedAt = s.lastDamagedAt = -Infinity;
  f.game.vehicles.damageModel.step(t, 1); f.game.vehicles.damageModel.step(s, 1);
  near((t.hp - 200) / (s.hp - 200), 1.5, 1e-6, 'self-regeneration');
  policySwap(f, pilot, { transport: 'heavy_doorguns' });
  f.step(2);
  assert.equal(t.upgrade, 'heavy_doorguns');
  assert.equal(upgradeMountScale(t, 'damage', 'door-left'), 1.3);
  const gun = upgradedHitscan(t, 'door-right', VEHICLE_WEAPONS.doorMinigun);
  near(gun.damage, VEHICLE_WEAPONS.doorMinigun.damage * 1.3, 1e-9, 'door gun 13 → 16.9 per round');
  assert.equal(upgradedHitscan(s, 'door-right', VEHICLE_WEAPONS.doorMinigun), VEHICLE_WEAPONS.doorMinigun, 'stock hulls keep the shared row');
});
/** A changed pick applies at once to the hull the player already drives (the next deploy stores it the same way). */
function policySwap(f, p, upgrades) { f.policy.upgrades.choose(p, upgrades); }

await test('turbo: the jeep tops out at 28.8 m/s and accelerates faster', () => {
  const run = tune => { const s = { speed: 0, yaw: 0 }; for (let i = 0; i < 60 * 12; i++) stepJeepDrive(s, { throttle: 1 }, 1 / 60, tune); return s.speed; };
  near(run(null), JEEP_RULES.speed, 1e-6, 'stock top speed');
  near(run({ speed: 1.2, acceleration: 1.25 }), JEEP_RULES.speed * 1.2, 1e-6, 'turbo top speed');
  const two = tune => { const s = { speed: 0, yaw: 0 }; for (let i = 0; i < 120; i++) stepJeepDrive(s, { throttle: 1 }, 1 / 60, tune); return s.speed; };
  assert.ok(two({ speed: 1.2, acceleration: 1.25 }) > two(null) * 1.2, 'faster off the line');
  // On the server the turbo rides the driver.
  const f = fixture([pad('j', 'jeep')]);
  const d = f.human('d', 'alpha', 4, { jeep: 'turbo' });
  f.board(d, 'j', 'driver');
  const jeep = f.vehicle('j');
  for (let i = 0; i < 60 * 10; i++) { f.game.applyInput(d.id, { keys: {}, yaw: 0, pitch: 0, vehicleThrottle: 1 }); jeep.x = 300; jeep.z = 300; f.step(); }
  assert.ok(jeep.speed > JEEP_RULES.speed + 3, `the driven jeep passes the stock top speed (${jeep.speed.toFixed(1)} m/s)`);
});

await test('thermal optics: the tank crew spots at 450 m for 8 s and through smoke', () => {
  const f = fixture([pad('tank', 'tank')]);
  const d = f.human('d', 'alpha', 8, { tank: 'thermal' }), g = f.player('g', 'alpha');
  f.board(d, 'tank', 'driver'); f.board(g, 'tank', 'commander'); f.step(2);
  const spotting = f.policy.roles.spotting;
  assert.equal(spotting.rangeFor(d), 450); assert.equal(spotting.durationFor(g), 8000, 'every crew seat looks through the thermal sight');
  assert.equal(spotting.hullSpot(g)?.smoke, true, 'the thermal sight sees through smoke');
  const smoke = f.game.projectiles.smoke, blocks = smoke.blocksSight;
  smoke.blocksSight = () => true;
  const from = [300, 3, 300], to = [300, 3, 340];
  assert.equal(spotting.lineOfSight(from, to), false, 'smoke blocks a stock spotter');
  assert.equal(spotting.lineOfSight(from, to, { throughSmoke: true }), true, 'but not the thermal sight');
  smoke.blocksSight = blocks;
  f.leave(d); f.step(2);
  assert.equal(spotting.rangeFor(g), f.policy.rules.spotRange, 'stock again without the driver');
});

await test('mobile AA: reactive armour on the AA hull, the search radar spots at 450 m for 8 s (no smoke)', () => {
  const f = fixture([pad('aa', 'aa', 'alpha', 300, 300), pad('aa2', 'aa', 'alpha', 340, 300)]);
  const foe = f.player('foe', 'bravo', { x: 320, y: 1, z: 360 });
  const d = f.human('d', 'alpha', 5, { aa: 'reactive' });
  f.board(d, 'aa', 'driver'); f.step(2);
  const a = f.vehicle('aa'), b = f.vehicle('aa2');
  const hit = v => { const before = v.hp; f.game.vehicles.damage(v.id, 200, foe, { cls: 'at', origin: [v.x, v.y + 1, v.z + 6] }); return before - v.hp; };
  near(hit(a) / hit(b), 0.85, 1e-6, 'the AA takes 0.85 of the stock AT hit');
  policySwap(f, d, { aa: 'search_radar' });
  const g = f.player('g', 'alpha');
  f.board(g, 'aa', 'commander'); f.step(2);
  assert.equal(a.upgrade, 'search_radar');
  const spotting = f.policy.roles.spotting;
  assert.equal(spotting.rangeFor(g), 450); assert.equal(spotting.durationFor(d), 8000, 'both crew seats work the radar');
  assert.notEqual(spotting.hullSpot(g)?.smoke, true, 'radar spots never see through smoke');
  assert.equal(f.row('aa').upg, 2, 'the row carries the radar code');
});

await test('patrol boat: the waterjet tops out at 24 m/s; the reinforced hull takes 25 % less', () => {
  const run = tune => { const s = { speed: 0, yaw: 0 }; for (let i = 0; i < 60 * 20; i++) stepBoatDrive(s, { throttle: 1 }, 1 / 60, undefined, tune); return s.speed; };
  near(run(null), BOAT_RULES.speed, 1e-6, 'stock top speed');
  near(run({ speed: 1.2, acceleration: 1.25 }), BOAT_RULES.speed * 1.2, 1e-6, 'waterjet top speed');
  const two = tune => { const s = { speed: 0, yaw: 0 }; for (let i = 0; i < 120; i++) stepBoatDrive(s, { throttle: 1 }, 1 / 60, undefined, tune); return s.speed; };
  assert.ok(two({ speed: 1.2, acceleration: 1.25 }) > two(null), 'faster off the line');
  const f = fixture([pad('b1', 'boat', 'alpha', 300, 300), pad('b2', 'boat', 'alpha', 340, 300)]);
  const foe = f.player('foe', 'bravo', { x: 320, y: 1, z: 360 });
  const d = f.human('d', 'alpha', 4, { boat: 'reinforced' });
  f.board(d, 'b1', 'driver'); f.step(2);
  const a = f.vehicle('b1'), b = f.vehicle('b2');
  const hit = (v, cls, amount) => { const before = v.hp; f.game.vehicles.damage(v.id, amount, foe, { cls, origin: [v.x, v.y + 1, v.z + 4] }); return before - v.hp; };
  near(hit(a, 'hmg', 40) / hit(b, 'hmg', 40), 0.75, 1e-6, 'an HMG burst');
  assert.equal(upgradeDamageTaken(a, 'at'), 1, 'AT is unchanged');
  policySwap(f, d, { boat: 'waterjet' }); f.step(2);
  assert.equal(a.upgrade, 'waterjet');
  assert.equal(upgradeScale(a, 'speed'), 1.2, 'the waterjet rides the driven hull (server/sim/boat.js tunes the drive with it)');
});

/* ------------------------------------------------------------ client */

const dom = installFakeDom({ width: 1440, height: 900 });
const state = await import('../public/js/ui/conquest-hud-state.js');
const { DeployScreen } = await import('../public/js/ui/conquest/deploy-screen.js');
const { conquestHudFixtures, fixtureMapMeta, FIXTURE_NOW } = await import('../public/js/capture/conquest-hud-fixtures.js');
const fixtures = conquestHudFixtures(), mapMeta = fixtureMapMeta();
const vehiclesFixture = fixtures.find(x => x.id === 'deploy-vehicles');
const cqOf = x => state.readConquest(x.match, mapMeta);

await test('deploy model: hull cards from the table, picks gated by the announced level', () => {
  const model = state.deployModel({ cq: cqOf(vehiclesFixture), self: vehiclesFixture.self, players: vehiclesFixture.players, vehicles: vehiclesFixture.vehicles,
    nowMs: FIXTURE_NOW, selection: vehiclesFixture.selection, unlocks: { level: 4, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro'] } });
  assert.deepEqual(model.upgrades.map(c => c.type), UPGRADE_MENU_ORDER);
  assert.deepEqual(model.choice.upgrades, { tank: 'reactive', jeep: 'turbo', plane: 'extra_flares', aa: 'reactive' }, 'a stored LV 6 pick (EXTRA MISSILE) drives stock at LV 4');
  const tank = model.upgrades.find(c => c.type === 'tank');
  assert.equal(tank.spawn, true, 'the tank spawn marks the tank card');
  assert.deepEqual(tank.options.map(o => [o.id, o.unlocked, o.selected]), [[null, true, false], ['reactive', true, true], ['autoloader', true, false], ['thermal', false, false]]);
  assert.equal(tank.options[3].lockText, 'LV 8');
  const refused = state.deployModel({ cq: cqOf(vehiclesFixture), self: vehiclesFixture.self, players: vehiclesFixture.players, vehicles: vehiclesFixture.vehicles,
    nowMs: FIXTURE_NOW, selection: vehiclesFixture.selection, refused: { reason: 'locked', level: 8, vehicle: 'tank', upgrade: 'thermal' } });
  assert.equal(refused.refused.text, 'TANK THERMAL OPTICS LOCKED · LV 8');
  const low = state.deployModel({ cq: cqOf(vehiclesFixture), self: vehiclesFixture.self, players: vehiclesFixture.players, vehicles: vehiclesFixture.vehicles,
    nowMs: FIXTURE_NOW, selection: vehiclesFixture.selection });
  assert.deepEqual(low.choice.upgrades, {}, 'without an announced level (LV 1) every hull is stock');
});

await test('deploy screen: VEHICLES tab, chip picks are stored and ride the deploy intent', () => {
  dom.storage.clear();
  const sent = [];
  const screen = new DeployScreen(dom.document.body, { onDeploy: choice => { sent.push(choice); return true; } });
  screen.setUnlocks({ level: 4, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro'] });
  screen.selection = { ...screen.selection, upgrades: {} };
  screen.setOpen(true);
  const args = { cq: cqOf(vehiclesFixture), self: vehiclesFixture.self, players: vehiclesFixture.players, vehicles: vehiclesFixture.vehicles, nowMs: FIXTURE_NOW };
  screen.update(args);
  assert.ok(screen.kits.querySelector('.cq-kit-row-base'), 'the CLASSES tab opens by default');
  assert.equal(screen.tabLevel.textContent, 'LV 4', 'the tab pair names the server-announced level');
  screen.tabButtons.vehicles.click();
  screen.update(args);
  assert.equal(screen.kits.querySelectorAll('.cq-upg-hull').length, UPGRADE_MENU_ORDER.length, 'one card per hull type');
  assert.equal(screen.kits.querySelector('.cq-kit-row-base'), null, 'the class rows give way');
  const chip = (type, id) => screen.kits.querySelector(`.cq-upg-hull[data-type="${type}"] .cq-upg-option[data-upgrade="${id}"]`);
  chip('tank', 'reactive').click();
  assert.equal(chip('tank', 'reactive').classList.contains('is-selected'), true);
  assert.equal(JSON.parse(dom.storage.getItem('vb-conquest-vehicle-upgrades')).tank, 'reactive', 'the pick is remembered');
  chip('tank', 'thermal').click();
  assert.equal(chip('tank', 'reactive').classList.contains('is-selected'), true, 'a locked chip selects nothing');
  assert.ok(screen.kitInfo.textContent.includes('THERMAL OPTICS UNLOCKS AT LV 8'), 'and says when it opens');
  chip('jeep', 'turbo').click();
  chip('jeep', 'stock').click();
  screen.update({ ...args, nowMs: FIXTURE_NOW + 4000 });
  assert.ok(screen.deploy(), 'deploy');
  assert.deepEqual(sent.at(-1).upgrades, { tank: 'reactive' }, 'the intent carries the open picks (STOCK drops the jeep entry)');
  assert.equal(dom.storage.getItem('vb-conquest-deploy-tab'), 'vehicles', 'the tab is remembered');
});

await test('deploy screen: the VEHICLES tab works from a gamepad and the keyboard', async () => {
  dom.storage.clear();
  const sent = [];
  const screen = new DeployScreen(dom.document.body, { onDeploy: choice => { sent.push(choice); return true; } });
  screen.setUnlocks({ level: 4, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro'] });
  screen.selection = { ...screen.selection, spawn: vehiclesFixture.selection.spawn, upgrades: {} };
  screen.setOpen(true);
  const args = { cq: cqOf(vehiclesFixture), self: vehiclesFixture.self, players: vehiclesFixture.players, vehicles: vehiclesFixture.vehicles, nowMs: FIXTURE_NOW };
  screen.update(args);
  assert.equal(screen.step('hull', 1), false, 'no hull focus on the CLASSES tab');
  assert.equal(screen.step('tab', 1), true); assert.equal(screen.tab, 'vehicles', 'the tab step flips to VEHICLES');
  const focused = () => [...screen.kits.querySelectorAll('.cq-upg-hull')].filter(n => n.classList.contains('is-focus')).map(n => n.dataset.type);
  assert.deepEqual(focused(), [], 'no focus ring before the first step');
  screen.step('upgrade', 1);
  assert.deepEqual(focused(), ['tank'], 'the first step focuses the hull the picked spawn seats you in');
  assert.deepEqual(screen.selection.upgrades, { tank: 'reactive' }, 'and steps its pick off STOCK');
  screen.step('upgrade', 1); screen.step('upgrade', 1);
  assert.deepEqual(screen.selection.upgrades, {}, 'the locked THERMAL OPTICS (LV 8) is skipped: AUTOLOADER, then STOCK again');
  screen.step('upgrade', -1);
  assert.equal(screen.selection.upgrades.tank, 'autoloader', 'backwards wraps to the last open upgrade');
  assert.ok(screen.kitInfo.textContent.startsWith('TANK · AUTOLOADER'), `the info line follows the pad pick (${screen.kitInfo.textContent})`);
  const order = upgradeTypes(), tankAt = order.indexOf('tank');
  screen.step('hull', 1);
  assert.deepEqual(focused(), [order[tankAt + 1]], 'the hull step moves to the next card');
  screen.step('hull', -1); screen.step('hull', -1);
  assert.deepEqual(focused(), [order[tankAt - 1]]);
  for (let i = 0; i < order.length; i++) screen.step('hull', 1);
  assert.deepEqual(focused(), [order[tankAt - 1]], 'the hull focus wraps');
  assert.ok(screen.deploy(), 'deploy');
  assert.deepEqual(sent.at(-1).upgrades, { tank: 'autoloader' }, 'the pad pick rides the deploy intent');
  screen.setOpen(false); screen.setOpen(true); screen.update(args);
  assert.deepEqual(focused(), [], 'a fresh deploy screen drops the focus ring');
  screen.root.remove?.();

  // The HUD maps the pad (Y, LB / RB, LT / RT) and the keys (C / V, arrows, Q / E) onto those steps.
  const { ConquestHud } = await import('../public/js/ui/conquest-hud.js');
  const hud = new ConquestHud(dom.document.body, { eventTarget: dom.window, onDeploy: () => true });
  hud.deploy.setUnlocks({ level: 4, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro'] });
  hud.deploy.selection = { ...hud.deploy.selection, spawn: vehiclesFixture.selection.spawn, upgrades: {} };
  hud.deploy.setTab('class');
  const hudArgs = { match: vehiclesFixture.match, mapMeta, self: vehiclesFixture.self, players: vehiclesFixture.players, vehicles: vehiclesFixture.vehicles, nowMs: FIXTURE_NOW };
  hud.update(hudArgs); hud.setDead(true, null); hud.update(hudArgs);
  assert.equal(hud.deploy.open, true, 'the deploy screen is open');
  const kit = hud.deploy.selection.kit;
  hud.padInput({ pressed: { weapon: true } });
  assert.equal(hud.deploy.tab, 'vehicles', 'pad Y flips to VEHICLES');
  hud.padInput({ pressed: { grenade: true } });
  assert.equal(hud.deploy.selection.upgrades.tank, 'reactive', 'RB steps the focused hull\'s upgrade');
  assert.equal(hud.deploy.selection.kit, kit, 'not the class');
  hud.padInput({ pressed: { fire: true } });
  assert.equal(hud.deploy.padHull, order[tankAt + 1], 'RT moves the hull focus');
  hud.padInput({ pressed: { ads: true } });
  const key = (code, k = '') => dom.window.dispatchEvent({ type: 'keydown', code, key: k, repeat: false, target: dom.document.body });
  key('ArrowRight', 'ArrowRight');
  assert.equal(hud.deploy.selection.upgrades.tank, 'autoloader', 'the right arrow steps it as well');
  key('KeyE', 'e');
  assert.equal(hud.deploy.padHull, order[tankAt + 1], 'E moves the hull focus');
  key('KeyC', 'c');
  assert.equal(hud.deploy.tab, 'class', 'C opens CLASSES');
  key('ArrowRight', 'ArrowRight');
  assert.notEqual(hud.deploy.selection.kit, kit, 'on CLASSES the arrows step the class');
  key('KeyV', 'v');
  assert.equal(hud.deploy.tab, 'vehicles', 'V opens VEHICLES');
  hud.padInput({ pressed: { weapon: true } });
  assert.equal(hud.deploy.tab, 'class', 'Y flips back');
  hud.dispose();
});

await test('vehicle panel: the driver\'s upgrade badge from the row', () => {
  const commander = fixtures.find(x => x.id === 'tank-commander');
  const row = commander.vehicles.find(v => v.id === 'alpha-tank');
  const model = state.vehiclePanelModel({ row, seat: { id: 'commander', role: 'gunner', drives: false } }, { selfId: 'me', players: commander.players });
  assert.deepEqual(model.badges[0], { key: 'upgrade:reactive', label: 'REACTIVE', tone: 'upgrade', title: 'REACTIVE ARMOUR' });
  const stock = state.vehiclePanelModel({ row: { ...row, upg: undefined }, seat: { id: 'commander', role: 'gunner', drives: false } }, { selfId: 'me' });
  assert.ok(!stock.badges.some(b => b.tone === 'upgrade'));
  assert.equal(vehicleMaxHp(row), 1000, 'no upgrade changes the hull HP');
});

console.log(`conquest vehicle upgrades: ${passed} tests passed`);
