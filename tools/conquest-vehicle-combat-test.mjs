// Conquest v2 vehicle combat (spec F4, §5): armour matrix and zones, mounted
// weapons through the real GameEngine tick, disabled/burning/regen/repair,
// exposed crew, chaos isolation of vehicle rounds, shoot events for every
// mount, seat switching, never-failing exit and solid ground wrecks.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { fireOneShot } from '../server/sim/combat.js';
import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import { chaosLevel } from '../shared/chaos.js';
import { ARMOR_MATRIX, HEAVY_ZONE_MULTIPLIERS, armorMultiplier, armorEffective } from '../shared/vehicle-armor.js';
import { VEHICLE_DEFS, VEHICLE_WEAPONS, VEHICLE_DAMAGE_RULES, CONQUEST_ROCKET_PROFILE, vehicleLocalPoint, mountPose, seatWeaponList, vehicleMaxHp } from '../shared/vehicle-defs.js';
import { vehicleWeaponBlast } from '../shared/weapon-aircraft-projectiles.js';
import { vehicleSeats } from '../shared/vehicle-seats.js';
import { VEHICLE_STATUS, VEHICLE_TYPE_IDS, vehicleMountOrder } from '../shared/conquest-contract.js';
import { playerHullContact } from '../shared/player-vehicle-collision.js';

const TICK = 1000 / 60;
const metrics = {};

function fixture(spawns, { size = 384 } = {}) {
  const dimensions = { sx: size, sy: 64, sz: size }, blocks = new Set(), frames = [], hook = [];
  const world = { dimensions,
    getBlock: (x, y, z) => y === 0 || blocks.has(`${x},${y},${z}`) ? 3 : 0,
    setBlock(x, y, z, value) { if (value) blocks.add(`${x},${y},${z}`); else blocks.delete(`${x},${y},${z}`); return true; },
    findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: spawns } } });
  // The mode hook (spec F4): every hull event kind reaches onVehicleEvent.
  const original = game.mode.onVehicleEvent?.bind(game.mode);
  game.mode.onVehicleEvent = (kind, payload) => { hook.push({ ...payload, hookKind: kind }); return original?.(kind, payload); };
  const player = (id, team, extra = {}) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    game.mode.policy.setLobbyTeam(p, team);
    Object.assign(p, { x: 20, y: 1, z: 20, hp: 100, armor: 0, spawnProtectedUntil: 0, spawnProtected: false, grounded: true,
      input: { keys: {}, yaw: 0, pitch: 0 }, ...extra });
    return p;
  };
  const vehicle = id => game.vehicles.vehicles.get(id);
  const board = (p, vehicleId, seatId = null) => {
    const v = vehicle(vehicleId);
    Object.assign(p, { x: v.x, y: v.y, z: v.z });
    game.applyInput(p.id, { keys: {}, yaw: v.yaw, pitch: 0, vehicleAction: { type: 'enter', vehicleId, ...(seatId ? { seatId } : {}) } });
    assert.equal(p.vehicleId, vehicleId, `${p.id} boards ${vehicleId}`);
    if (seatId) assert.equal(p.vehicleSeatId, seatId);
    return p;
  };
  const events = kind => frames.flatMap(frame => frame.events).filter(event => event.kind === kind);
  const tick = (count = 1) => { for (let i = 0; i < count; i++) game.step(TICK); };
  const aim = (p, payload) => game.applyInput(p.id, { keys: {}, ...payload });
  return { game, blocks, frames, hook, player, vehicle, board, events, tick, aim };
}
const spawn = (id, type, team, x, z, yaw = 0) => ({ id, type, team, x, y: 1, z, yaw });
const lookAt = (from, to) => {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
};
const near = (a, b, tolerance, message) => assert(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

// ---------------------------------------------------------------- armour matrix
{
  const expected = {
    small: [0.2, 0, 0.08], mg: [0.6, 0, 0.3], hmg: [1, 0.03, 0.6], autocannon: [1, 0.12, 1], explosive: [0.8, 0.12, 0.5],
    he: [1, 0.35, 1], at: [1, 1, 0.8], aa: [0.3, 0.1, 1], fire: [0.3, 0, 0],
  };
  for (const [cls, [light, heavy, air]] of Object.entries(expected)) {
    assert.deepEqual(ARMOR_MATRIX[cls], { light, heavy, air }, `${cls} row matches spec 5.3`);
  }
  assert.deepEqual(HEAVY_ZONE_MULTIPLIERS, { front: 0.75, side: 1, rear: 1.5, top: 1.3, bottom: 1.5 });
  assert.equal(armorMultiplier('at', 'heavy', 'rear') / armorMultiplier('at', 'heavy', 'front'), 2);
  assert.equal(armorMultiplier('he', 'heavy', 'rear'), 0.35, 'only AT is zoned against heavy armour');
  assert.equal(armorEffective(armorMultiplier('small', 'heavy')), false);
  assert.equal(armorEffective(armorMultiplier('hmg', 'heavy')), false, 'eff = multiplier >= 0.1');
  assert.equal(armorEffective(armorMultiplier('autocannon', 'heavy')), true);
  assert.equal(armorMultiplier('bogus', 'light'), 0);
  for (const type of VEHICLE_TYPE_IDS) assert.equal(vehicleMaxHp({ type }), { jeep: 320, tank: 1000, helicopter: 650, transport: 600, plane: 450 }[type]);
}

// ------------------------------------------- a rifle magazine into the tank: 0 damage, eff:0
{
  const f = fixture([spawn('tank', 'tank', 'alpha', 100, 100)]);
  const rifleman = f.player('rifleman', 'bravo');
  const tank = f.vehicle('tank'), rifle = WEAPON_IDS.indexOf('rifle'), magazine = WEAPONS.rifle.magSize;
  Object.assign(rifleman, { x: 100, y: 1, z: 125, weapon: rifle, deployT: 0 });
  const target = vehicleLocalPoint(tank, 0, 1.2, 0), { yaw, pitch } = lookAt([rifleman.eyeX, rifleman.eyeY, rifleman.eyeZ], target);
  for (let i = 0; i < magazine; i++) { rifleman.cooldown = 0; fireOneShot(rifleman, f.game.contexts.combat, 1, { yaw, pitch }); }
  f.tick(12);
  assert.equal(tank.hp, 1000, 'a full rifle magazine does nothing to heavy armour');
  const hits = f.events('vehicle_hit').filter(event => event.vehicleId === 'tank');
  assert(hits.length >= 1, 'the sparks still produce vehicle_hit feedback');
  for (const hit of hits) { assert.equal(hit.eff, 0); assert.equal(hit.dmg, 0); assert.equal(hit.cls, 'small'); assert.equal(hit.attacker, 'rifleman'); }
  assert(hits.length < magazine, 'hits are merged per attacker and hull window');
  assert(f.hook.some(event => event.hookKind === 'vehicle_hit' && event.eff === 0 && event.type === 'tank'), 'the mode hook receives vehicle_hit');
}

// ------------------------------------------------ AP shell: rear = 2x front; kills and disables
function apDuel(targetYaw, shots) {
  const f = fixture([spawn('gun', 'tank', 'alpha', 100, 120), spawn('target', 'tank', 'bravo', 100, 80, targetYaw)]);
  const driver = f.board(f.player('driver', 'alpha'), 'gun', 'driver'), target = f.vehicle('target');
  const muzzle = mountPose(f.vehicle('gun'), 'driver', 'main').pivot;
  const { yaw, pitch } = lookAt(muzzle, vehicleLocalPoint(target, 0, 1.6, 0));
  f.aim(driver, { yaw, pitch, wantFire: true });
  const log = [];
  for (let i = 0; i < Math.ceil(shots * 3.5 * 60) + 60 && log.length < shots && target.hp > 0; i++) {
    const before = target.hp;
    f.tick();
    const after = target.hp;
    // Burning is applied before the projectile step; its share is 2%/s, far below a shell.
    if (before - after > 50) log.push({ dealt: before - after, disabled: target.disabled, hp: after });
  }
  return { f, driver, target, log };
}
{
  const rear = apDuel(0, 2), front = apDuel(Math.PI, 4);
  const rearHits = rear.f.events('vehicle_hit').filter(event => event.vehicleId === 'target');
  const frontHits = front.f.events('vehicle_hit').filter(event => event.vehicleId === 'target');
  assert.equal(rearHits[0].zone, 'rear'); assert.equal(rearHits[0].cls, 'at'); assert.equal(rearHits[0].eff, 1);
  assert.equal(frontHits[0].zone, 'front');
  metrics.apRear = rear.log[0].dealt; metrics.apFront = front.log[0].dealt; metrics.frontHitsToKillOrDisable = front.log.length;
  near(rear.log[0].dealt / front.log[0].dealt, 2, 0.02, 'an AP rear hit deals 2x a front hit');
  near(rear.log[0].dealt, (400 + 60) * 1.5, 1, 'AP rear: 400 direct + 60 splash at the AT class x1.5');
  assert(rear.log[0].disabled, 'one AT hit to the rear >= 30% of max disables the hull');
  assert.equal(rear.target.hp, 0, 'two rear AP hits kill a fresh tank');
  assert(rear.log.length <= 2);
  assert(front.target.hp === 0 || front.target.disabled, 'four front hits disable or kill a tank');
  assert(front.log.length <= 4);
  const destroyed = rear.f.events('vehicle_destroyed').find(event => event.vehicleId === 'target');
  assert.equal(destroyed.type, 'tank'); assert.equal(destroyed.attacker, 'driver'); assert.deepEqual(destroyed.assists, []);
  assert.equal(destroyed.crewKilled, 0);
  const shells = rear.f.events('shoot').filter(event => event.vehicleId === 'gun');
  assert(shells.length >= 2 && shells.every(event => event.mount === 'main' && event.vehicleWeapon === 'tankAP' && event.tracer === false));
  const launches = rear.f.events('projectileLaunch').filter(event => event.vehicleWeapon === 'tankAP');
  assert(launches.length >= 2 && launches.every(event => event.chaos === 0 && event.type === 'rocket' && event.g === 6));
}

// ------------------------------------------------------------- the HMG kills a jeep in < 4 s
{
  const f = fixture([spawn('own', 'jeep', 'alpha', 100, 110), spawn('enemy', 'jeep', 'bravo', 100, 84)]);
  const gunner = f.board(f.player('gunner', 'alpha'), 'own', 'gunner'), enemy = f.vehicle('enemy');
  const pivot = mountPose(f.vehicle('own'), 'gunner', 'pintle').pivot;
  f.aim(gunner, { ...lookAt(pivot, vehicleLocalPoint(enemy, 0, 1.1, 0)), wantFire: true });
  let ticks = 0;
  while (enemy.hp > 0 && ticks < 600) { f.tick(); ticks++; }
  metrics.hmgJeepSeconds = +(ticks / 60).toFixed(2);
  assert.equal(enemy.hp, 0); assert(ticks / 60 < 4, `the HMG kills a jeep in ${(ticks / 60).toFixed(2)} s`);
  const shots = f.events('shoot').filter(event => event.vehicleId === 'own');
  assert(shots.every(event => event.mount === 'pintle' && event.vehicleWeapon === 'hmg' && event.w === 'lmg'));
  assert.deepEqual(shots.slice(0, 7).map(event => event.tracer), [true, false, false, true, false, false, true], 'every third hitscan round is a tracer');
  assert(shots[0].paths?.[0]?.[0]?.end, 'hitscan shoot events carry the round path');
}

// --------------------------------------------- disabled: 24% burns out in ~12.5 s; drive and slew slowed
{
  const f = fixture([spawn('d', 'tank', 'alpha', 100, 100)]);
  const enemy = f.player('enemy', 'bravo'), tank = f.vehicle('d');
  const side = vehicleLocalPoint(tank, VEHICLE_DEFS.tank.collider.halfWidth, 1.3, 0);
  assert(f.game.vehicles.damage('d', 760, enemy, { cls: 'at', point: side }));
  near(tank.hp, 240, 1e-9, 'side AT damage is unscaled');
  assert(tank.disabled && tank.burning, 'HP at 24% disables the hull and sets it burning');
  f.tick();
  const row = f.frames.at(-1).vehicles.find(r => r.id === 'd');
  assert(row.st & VEHICLE_STATUS.disabled && row.st & VEHICLE_STATUS.burning, 'st carries disabled and burning');
  assert(f.hook.some(event => event.hookKind === 'vehicle_disabled' && event.attacker === 'enemy'));
  let seconds = 1 / 60, last = tank.hp;
  while (tank.hp > 0 && seconds < 30) {
    f.tick(); seconds += 1 / 60;
    assert(tank.hp <= last, 'regen never runs while disabled'); last = tank.hp;
  }
  metrics.burnOutSeconds = +seconds.toFixed(2);
  near(seconds, 12.5, 1, 'a disabled hull at 24% dies untouched');
  const destroyed = f.events('vehicle_destroyed').find(event => event.vehicleId === 'd');
  assert.equal(destroyed.attacker, 'enemy', 'the burn-out kill is credited to the disabling attacker');
  assert(f.hook.some(event => event.hookKind === 'vehicle_destroyed' && event.type === 'tank'));
}
{
  const f = fixture([spawn('h', 'tank', 'alpha', 60, 150), spawn('d', 'tank', 'alpha', 140, 150)]);
  const enemy = f.player('enemy', 'bravo');
  const healthy = f.board(f.player('a', 'alpha'), 'h', 'driver'), crippled = f.board(f.player('b', 'alpha'), 'd', 'driver');
  f.game.vehicles.damage('d', 760, enemy, { cls: 'at', point: vehicleLocalPoint(f.vehicle('d'), 1.95, 1.3, 0) });
  assert(f.vehicle('d').disabled);
  for (const p of [healthy, crippled]) f.aim(p, { yaw: 1.2, pitch: 0, vehicleThrottle: 1 });
  f.tick();
  const turn = id => Math.abs(Math.atan2(Math.sin(f.vehicle(id).turretYaw), Math.cos(f.vehicle(id).turretYaw)));
  near(turn('d') / turn('h'), VEHICLE_DAMAGE_RULES.disabledSlew, 0.05, 'a disabled turret slews at half rate');
  f.tick(299);
  near(f.vehicle('d').speed / f.vehicle('h').speed, VEHICLE_DAMAGE_RULES.disabledDrive, 0.03, 'a disabled hull drives at 0.4x');
}

// ------------------------------------------------------------ repair, regen and the repair event
{
  const f = fixture([spawn('d', 'tank', 'alpha', 100, 100)]);
  const enemy = f.player('enemy', 'bravo'), engineer = f.player('engineer', 'alpha'), tank = f.vehicle('d');
  f.game.vehicles.damage('d', 760, enemy, { cls: 'at', point: vehicleLocalPoint(tank, 1.95, 1.3, 0) });
  assert(tank.disabled);
  assert.equal(f.game.vehicles.repair('d', 50, enemy), 0, 'enemies cannot repair');
  assert.equal(f.game.vehicles.repair('d', 70, engineer), 70);
  near(tank.hp, 310, 1e-9, 'repaired to 31%');
  assert(!tank.disabled && !tank.burning, 'repair above 30% clears disabled and burning');
  assert.equal(f.game.vehicles.repair('d', 10, engineer), 10, 'a second repair inside the throttle window still adds HP');
  f.tick();
  let repaired = f.events('vehicle_repaired');
  assert.equal(repaired.length, 1, 'vehicle_repaired is throttled per repairer');
  assert.deepEqual([repaired[0].vehicleId, repaired[0].by, repaired[0].hp], ['d', 'engineer', 70]);
  f.tick(31);
  repaired = f.events('vehicle_repaired');
  assert.equal(repaired.length, 2); assert.equal(repaired[1].hp, 10, 'the throttled remainder is emitted after 500 ms');
  assert(f.hook.some(event => event.hookKind === 'vehicle_repaired' && event.by === 'engineer'));
  const missing = 1000 - tank.hp;
  assert.equal(f.game.vehicles.repair('d', 5000, engineer), missing, 'repair stops at max HP');
  assert.equal(tank.hp, 1000);
}
{
  const f = fixture([spawn('r', 'tank', 'alpha', 100, 100)]);
  const enemy = f.player('enemy', 'bravo'), tank = f.vehicle('r');
  f.game.vehicles.damage('r', 500, enemy, { cls: 'at', point: vehicleLocalPoint(tank, 1.95, 1.3, 0) });
  assert.equal(tank.hp, 500); assert(!tank.disabled, '50% from a side hit stays mobile');
  f.tick(Math.round(VEHICLE_DAMAGE_RULES.regenDelaySeconds * 60) - 2);
  assert.equal(tank.hp, 500, 'no regen inside the 8 s window');
  f.tick(60 * 4);
  assert(tank.hp > 500 && tank.hp < 600, 'regen runs after 8 s undamaged');
  f.tick(60 * 10);
  assert.equal(tank.hp, 600, 'regen stops at 60%');
}

// ------------------------------- vehicle_destroyed carries type, attacker, assists and crew killed
{
  const f = fixture([spawn('j', 'jeep', 'bravo', 100, 100)]);
  const crew = f.board(f.player('crew', 'bravo'), 'j', 'driver');
  const first = f.player('first', 'alpha'), second = f.player('second', 'alpha');
  f.game.vehicles.damage('j', 100, first, { cls: 'he', point: vehicleLocalPoint(f.vehicle('j'), 0, 1, -2) });
  f.game.vehicles.damage('j', 1000, second, { cls: 'at', point: vehicleLocalPoint(f.vehicle('j'), 0, 1, -2) });
  f.tick();
  const destroyed = f.events('vehicle_destroyed')[0];
  assert.deepEqual([destroyed.type, destroyed.attacker, destroyed.assists, destroyed.crewKilled], ['jeep', 'second', ['first'], 1]);
  assert.equal(crew.state, 'dead');
  const kinds = new Set(f.hook.map(event => event.hookKind));
  assert(kinds.has('vehicle_hit') && kinds.has('vehicle_destroyed'));
}

// ---------------------------------- exposed crew: the jeep gunner falls to rifle and splash, the tank driver does not
{
  const f = fixture([spawn('j', 'jeep', 'alpha', 100, 100), spawn('t', 'tank', 'alpha', 160, 100)]);
  const gunner = f.board(f.player('gunner', 'alpha'), 'j', 'gunner'), passenger = f.board(f.player('passenger', 'alpha'), 'j', 'rear-left');
  const driver = f.board(f.player('driver', 'alpha'), 't', 'driver');
  const rifleman = f.player('rifleman', 'bravo', { weapon: WEAPON_IDS.indexOf('rifle'), deployT: 0 });
  for (const [victim, expectDead] of [[gunner, true], [driver, false]]) {
    for (let i = 0; i < 20 && victim.state === 'alive'; i++) {
      Object.assign(rifleman, { x: victim.x + 8, y: 1, z: victim.z, cooldown: 0 });
      const { yaw, pitch } = lookAt([rifleman.eyeX, rifleman.eyeY, rifleman.eyeZ], [victim.x, victim.y + 0.3, victim.z]);
      fireOneShot(rifleman, f.game.contexts.combat, 1, { yaw, pitch });
    }
    assert.equal(victim.state === 'dead', expectDead, `${victim.vehicleSeatId ?? victim.id}: rifle outcome`);
  }
  assert.equal(driver.hp, 100, 'the tank driver is sealed');
  f.game.projectiles.chaosBlast(rifleman, [passenger.x + 1.5, 1.5, passenger.z], 'frag', 6, 150, 10, f.game.contexts.projectiles);
  assert(passenger.hp < 100, 'frag splash reaches an exposed passenger');
  f.game.projectiles.chaosBlast(rifleman, [driver.x + 1.5, 1.5, driver.z], 'frag', 6, 150, 10, f.game.contexts.projectiles);
  assert.equal(driver.hp, 100, 'frag splash never reaches the sealed tank driver');
}

// ----------------------------------------------- the tank shell ignores chaosLevel (no giant, no homing)
{
  const f = fixture([spawn('gun', 'tank', 'alpha', 100, 100)]);
  const driver = f.board(f.player('driver', 'alpha'), 'gun', 'driver');
  driver.chaosUpgrades = Object.fromEntries(['rocket', 'mgl', 'frag', 'pulse'].map(id => [id, 3]));
  assert.equal(chaosLevel(driver, 'rocket'), 3, 'the fixture really carries a level-3 rocket upgrade');
  f.aim(driver, { yaw: 0, pitch: 0.1, wantFire: true });
  let shell = null;
  for (let i = 0; i < 30 && !shell; i++) { f.tick(); shell = [...f.game.projectiles.active.values()].find(p => p.vehicleId === 'gun'); }
  assert(shell, 'the main gun fires');
  assert.equal(shell.chaosLevel, 0); assert.equal(shell.chaosHoming, false); assert.equal(shell.guidance, undefined);
  assert.deepEqual(shell.blastRules, vehicleWeaponBlast(VEHICLE_WEAPONS.tankAP), 'blast rules come from the weapon table');
  assert.equal(shell.blastRules.damageRadius, 2.5, 'no giant radius');
}

// ----------------------------------- every mount emits shoot {vehicleId, mount, vehicleWeapon}
for (const type of VEHICLE_TYPE_IDS) {
  const f = fixture([spawn('v', type, 'alpha', 150, 150)]);
  const seats = vehicleSeats(type), crew = seats.map(seat => f.board(f.player(`${type}-${seat.id}`, 'alpha'), 'v', seat.id));
  const covered = new Set();
  for (const [index, seat] of seats.entries()) {
    const list = seatWeaponList(type, seat.id), p = crew[index];
    for (const [weaponIndex, entry] of list.entries()) {
      if (list.length > 1) assert(f.game.vehicles.action(p, { type: 'weapon', index: weaponIndex }), 'weapon action selects');
      f.frames.length = 0;
      const look = lookAt([p.x, p.y, p.z], vehicleLocalPoint(f.vehicle('v'), seat.position[0] * 10, 1.5, -12));
      f.aim(p, { ...look, wantFire: true });
      let shot = null;
      for (let i = 0; i < 400 && !shot; i++) {
        f.tick();
        shot = f.events('shoot').find(event => event.id === p.id && event.mount === entry.mount && event.vehicleWeapon === entry.weapon);
      }
      assert(shot, `${type} ${seat.id} ${entry.mount}:${entry.weapon} emits shoot`);
      assert.equal(shot.vehicleId, 'v'); assert.equal(typeof shot.tracer, 'boolean');
      covered.add(`${seat.id}:${entry.mount}`);
      f.aim(p, { ...look, wantFire: false }); f.tick();
    }
  }
  assert.deepEqual([...covered].sort(), [...vehicleMountOrder(type)].sort(), `${type}: every mount fired`);
  const row = f.frames.at(-1).vehicles.find(r => r.id === 'v');
  assert.equal(row.mounts.length, vehicleMountOrder(type).length, 'mounts[] follows vehicleMountOrder');
  for (const mount of row.mounts) assert.equal(mount.length, 5);
}

// ------------------------------------------- a seat switch moves weapon control within one tick
{
  const f = fixture([spawn('j', 'jeep', 'alpha', 100, 100)]);
  const p = f.board(f.player('p', 'alpha'), 'j', 'driver');
  f.aim(p, { yaw: 0, pitch: 0, vehicleAction: { type: 'seat', seatId: 'gunner' } });
  assert.equal(p.vehicleSeatId, 'gunner'); assert.equal(f.vehicle('j').occupantId, null); assert.equal(f.vehicle('j').engineOn, false);
  f.aim(p, { yaw: 0, pitch: 0, wantFire: true }); f.tick();
  assert(f.events('shoot').some(event => event.id === p.id && event.mount === 'pintle'), 'the pintle fires on the very next tick');
}

// ---------------------------------- exit never fails: trench, wall, roof, forced eject with no-collide
{
  const wall = (f, x0, x1, z0, z1, y0 = 1, y1 = 4) => {
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) f.blocks.add(`${x},${y},${z}`);
  };
  const clearOfHull = (f, p) => {
    assert.equal(playerHullContact({ ...p, vehicleId: null, ghostVehicleId: null }, f.vehicle('j')), null, 'the exit spot is outside the hull');
    for (let x = Math.floor(p.x - 0.32); x <= Math.floor(p.x + 0.32); x++) for (let z = Math.floor(p.z - 0.32); z <= Math.floor(p.z + 0.32); z++)
      for (let y = Math.floor(p.y + 0.01); y <= Math.floor(p.y + 1.85); y++) assert(!f.blocks.has(`${x},${y},${z}`), 'the exit spot is free of voxels');
  };
  // A trench one hull wide: both sides blocked, the body leaves along the trench.
  {
    const f = fixture([spawn('j', 'jeep', 'alpha', 100.5, 100.5)]);
    wall(f, 98, 98, 80, 120); wall(f, 102, 102, 80, 120);
    const p = f.board(f.player('p', 'alpha'), 'j', 'driver');
    f.aim(p, { vehicleAction: { type: 'exit' } });
    assert.equal(p.vehicleId, null, 'exit succeeds inside a one-hull-wide trench');
    assert(Math.abs(p.z - 100.5) > 2, 'the body leaves through the trench ends'); assert.equal(p.y, 1);
    clearOfHull(f, p);
  }
  // Parked against a wall on the seat side: the body exits on the other side.
  {
    const f = fixture([spawn('j', 'jeep', 'alpha', 100.5, 100.5)]);
    wall(f, 98, 98, 80, 120);
    const p = f.board(f.player('p', 'alpha'), 'j', 'driver');
    f.aim(p, { vehicleAction: { type: 'exit' } });
    assert.equal(p.vehicleId, null); assert(p.x > 101.5, 'exit away from the wall');
    clearOfHull(f, p);
  }
  // Boxed in on all four sides: the roof.
  {
    const f = fixture([spawn('j', 'jeep', 'alpha', 100.5, 100.5)]);
    wall(f, 98, 98, 96, 104); wall(f, 102, 102, 96, 104); wall(f, 98, 102, 97, 97); wall(f, 98, 102, 103, 103);
    const p = f.board(f.player('p', 'alpha'), 'j', 'driver');
    f.aim(p, { vehicleAction: { type: 'exit' } });
    assert.equal(p.vehicleId, null, 'exit to the roof');
    assert(p.y >= 1 + 2.25 - 1e-6, 'the body stands on the roof');
    assert.equal(p.ghostVehicleId ?? null, null);
  }
  // Boxed in with a ceiling: a forced eject with one second of hull no-collide.
  {
    const f = fixture([spawn('j', 'jeep', 'alpha', 100.5, 100.5)]);
    wall(f, 98, 98, 96, 104); wall(f, 102, 102, 96, 104); wall(f, 98, 102, 97, 97); wall(f, 98, 102, 103, 103); wall(f, 98, 102, 96, 104, 4, 4);
    const p = f.board(f.player('p', 'alpha'), 'j', 'driver');
    f.aim(p, { vehicleAction: { type: 'exit' } });
    assert.equal(p.vehicleId, null, 'a forced eject never fails');
    assert.equal(p.ghostVehicleId, 'j');
    assert.equal(playerHullContact(p, f.vehicle('j')), null, 'the ejected body ignores the hull meanwhile');
    f.tick(30); assert.equal(p.ghostVehicleId, 'j');
    f.tick(35); assert.equal(p.ghostVehicleId, null, 'the no-collide window lasts one second');
  }
}

// ------------------------------------------------- a bullet stops at a ground wreck for 12 s
{
  const f = fixture([spawn('w', 'jeep', 'bravo', 100, 100)]);
  const shooter = f.player('shooter', 'alpha', { weapon: WEAPON_IDS.indexOf('rifle'), deployT: 0 });
  const victim = f.player('victim', 'bravo', { x: 100, y: 1, z: 92 });
  assert(f.game.vehicles.damage('w', 10000, shooter, { cls: 'at' }));
  assert.equal(f.vehicle('w').hp, 0);
  const fire = () => {
    Object.assign(shooter, { x: 100, y: 1, z: 112, cooldown: 0 }); Object.assign(victim, { x: 100, y: 1, z: 92 });
    const { yaw, pitch } = lookAt([shooter.eyeX, shooter.eyeY, shooter.eyeZ], [victim.x, victim.y + 1.2, victim.z]);
    fireOneShot(shooter, f.game.contexts.combat, 1, { yaw, pitch });
  };
  fire(); assert.equal(victim.hp, 100, 'a fresh ground wreck stops the round');
  assert(playerHullContact({ id: 'x', state: 'alive', x: 100, y: 1, z: 100 }, f.vehicle('w')), 'and blocks movement');
  f.tick(6 * 60); fire(); assert.equal(victim.hp, 100, 'still solid at 6 s');
  f.tick(Math.ceil(6.2 * 60)); assert(f.vehicle('w').wreckAge >= 12 && f.vehicle('w').hp === 0);
  fire(); assert(victim.hp < 100, 'after 12 s the wreck no longer stops rounds');
}

// ------------------------- a closed hull stops rounds at its face; an open cab does not
{
  const f = fixture([spawn('t', 'tank', 'alpha', 100, 100), spawn('j', 'jeep', 'alpha', 160, 100)]);
  const commander = f.board(f.player('commander', 'alpha'), 't', 'commander');
  const gunner = f.board(f.player('gunner', 'alpha'), 'j', 'gunner');
  const rifleman = f.player('rifleman', 'bravo', { weapon: WEAPON_IDS.indexOf('rifle'), deployT: 0 });
  // Level shots from 8 m off the right side (inside the rifle's spread for a head), aimed through a
  // seated body at a height above the hull origin.
  const shoot = (body, vehicleId, height) => {
    const target = [body.x, f.vehicle(vehicleId).y + height, body.z];
    Object.assign(rifleman, { x: target[0] + 8, y: target[1] - rifleman.eyeY + rifleman.y, z: target[2], cooldown: 0 });
    fireOneShot(rifleman, f.game.contexts.combat, 1, lookAt([rifleman.eyeX, rifleman.eyeY, rifleman.eyeZ], target));
  };
  assert.equal(commander.y - f.vehicle('t').y, 2.2, 'the commander sits on the turret roof');
  // Through the commander's legs and hips, well below the 2.65 m roof (rifle spread stays under it): armour takes it.
  for (const height of [1.7, 1.9, 2.05, 2.2]) {
    commander.hp = 100;
    for (let i = 0; i < 3; i++) shoot(commander, 't', height);
    assert.equal(commander.hp, 100, `rounds into the tank side at ${height} m never reach the commander`);
  }
  // Above the roof the turned-out commander's head is exposed (a few rounds cover the rifle's spread).
  for (const height of [2.8, 2.9]) {
    commander.hp = 100;
    for (let i = 0; i < 5 && commander.hp === 100; i++) shoot(commander, 't', height);
    assert(commander.hp < 100, `the commander is hit at ${height} m, above the armour`);
  }
  // The jeep is an open cab: a round through its side below the rail still finds the gunner's legs.
  gunner.hp = 100;
  for (let i = 0; i < 5 && gunner.hp === 100; i++) shoot(gunner, 'j', 1.2);
  assert(gunner.hp < 100, 'an open cab lets the round reach exposed crew');
}

// ------------------------------- the Conquest RX-8 AT launcher: 320 direct + 60 splash at the AT class
{
  const f = fixture([spawn('t', 'tank', 'bravo', 100, 100), spawn('j', 'jeep', 'bravo', 160, 100), spawn('h', 'helicopter', 'bravo', 220, 100)]);
  const engineer = f.player('engineer', 'alpha');
  const P = CONQUEST_ROCKET_PROFILE;
  const fire = (vehicleId, local, standoff) => {
    const v = f.vehicle(vehicleId), target = vehicleLocalPoint(v, ...local), before = v.hp;
    Object.assign(engineer, { x: target[0] + standoff[0], y: 1, z: target[2] + standoff[1] });
    const eye = [engineer.eyeX, engineer.eyeY, engineer.eyeZ], d = target.map((n, i) => n - eye[i]), l = Math.hypot(...d);
    const rocket = f.game.projectiles.launchRocket(engineer, f.game.contexts.projectiles, { x: d[0] / l, y: d[1] / l, z: d[2] / l });
    assert(rocket, 'the rocket launches');
    assert.deepEqual([rocket.hullDirect, rocket.hullSplash, rocket.hullCls, rocket.infantrySplashScale], [P.hullDirect, P.hullSplash, 'at', P.infantrySplashScale]);
    assert.equal(rocket.guidance, undefined, 'the AT rocket is dumb-fire: it never homes');
    for (let i = 0; i < 120 && f.game.projectiles.active.has(rocket.id); i++) f.tick();
    v.lastDamagedAt = -Infinity;
    return before - v.hp;
  };
  const hits = f.frames.length;
  const side = fire('t', [VEHICLE_DEFS.tank.collider.halfWidth, 1.2, 0], [12, 0]);
  near(side, P.hullDirect + P.hullSplash, 4, 'a side hit on the tank: 320 direct + 60 splash at AT x1.0');
  f.tick(8); // the 100 ms vehicle_hit merge window closes
  const hit = f.frames.slice(hits).flatMap(frame => frame.events).find(e => e.kind === 'vehicle_hit' && e.vehicleId === 't');
  assert.deepEqual([hit.cls, hit.eff, hit.zone], ['at', 1, 'side'], 'vehicle_hit reports an effective AT side hit');
  // Hits to kill a full tank: 4 from the front (x0.75), 3 on the side, 2 in the rear (x1.5).
  const toKill = (local, standoff) => {
    const tank = f.vehicle('t');
    Object.assign(tank, { hp: 1000, disabled: false, burning: false });
    let n = 0;
    while (tank.hp > 0 && n < 8) { fire('t', local, standoff); n++; tank.burning = false; }
    return n;
  };
  const front = toKill([0, 1.2, -VEHICLE_DEFS.tank.collider.halfLength], [0, -12]);
  const sides = toKill([VEHICLE_DEFS.tank.collider.halfWidth, 1.2, 0], [12, 0]);
  const rears = toKill([0, 1.2, VEHICLE_DEFS.tank.collider.halfLength], [0, 12]);
  assert.deepEqual([front, sides, rears], [4, 3, 2], `AT hits to kill a full tank front/side/rear (${front}/${sides}/${rears})`);
  // The first rear hit (>= 30 % of max HP) disables a fresh tank.
  const fresh = fixture([spawn('t2', 'tank', 'bravo', 100, 100)]);
  const eng2 = fresh.player('e2', 'alpha');
  {
    const v = fresh.vehicle('t2'), target = vehicleLocalPoint(v, 0, 1.2, VEHICLE_DEFS.tank.collider.halfLength);
    Object.assign(eng2, { x: target[0], y: 1, z: target[2] + 12 });
    const eye = [eng2.eyeX, eng2.eyeY, eng2.eyeZ], d = target.map((n, i) => n - eye[i]), l = Math.hypot(...d);
    const rocket = fresh.game.projectiles.launchRocket(eng2, fresh.game.contexts.projectiles, { x: d[0] / l, y: d[1] / l, z: d[2] / l });
    for (let i = 0; i < 120 && fresh.game.projectiles.active.has(rocket.id); i++) fresh.tick();
    for (let i = 0; i < 8; i++) fresh.tick();
    assert(v.disabled, 'one rear AT hit disables the tank');
    assert(fresh.frames.flatMap(frame => frame.events).some(e => e.kind === 'vehicle_disabled' && e.vehicleId === 't2' && e.attacker === 'e2'),
      'vehicle_disabled credits the engineer');
  }
  const jeep = fire('j', [VEHICLE_DEFS.jeep.collider.halfWidth, 1, 0], [12, 0]);
  near(jeep, VEHICLE_DEFS.jeep.hp, 1, 'one AT rocket destroys a jeep');
  // A landed helicopter takes AT x0.8: three hits.
  const heli = f.vehicle('h');
  const heliHit = fire('h', [1.5, 1.2, 0], [12, 0]);
  near(heliHit, (P.hullDirect + P.hullSplash) * 0.8, 6, 'AT vs air x0.8');
  assert(heli.hp > 0 && Math.ceil(VEHICLE_DEFS.helicopter.hp / heliHit) === 3, 'a helicopter needs three AT hits');
  metrics.rocketTankSide = Math.round(side); metrics.rocketTankFrontHits = front; metrics.rocketTankRearHits = rears;
}

// ------------------------------- infantry projectiles meet hulls, not just rockets
{
  const f = fixture([spawn('j', 'jeep', 'bravo', 160, 100), spawn('t', 'tank', 'bravo', 100, 100)]);
  const shooter = f.player('grenadier', 'alpha'), ctx = f.game.contexts.projectiles;
  const behind = f.player('behind', 'bravo');
  const aimAt = (target, from) => {
    Object.assign(shooter, { x: from[0], y: 1, z: from[1] });
    const eye = [shooter.eyeX, shooter.eyeY, shooter.eyeZ], d = target.map((n, i) => n - eye[i]), l = Math.hypot(...d);
    return { x: d[0] / l, y: d[1] / l, z: d[2] / l };
  };
  const fly = (projectile, ticks = 150) => { for (let i = 0; i < ticks && f.game.projectiles.active.has(projectile.id); i++) f.tick(); };
  // An armed SKIPJACK round detonates on the jeep's side as a direct hit.
  const jeep = f.vehicle('j'), side = VEHICLE_DEFS.jeep.collider.halfWidth;
  const round = f.game.projectiles.launchMgl(shooter, ctx, aimAt(vehicleLocalPoint(jeep, side, 1.4, 0), [jeep.x + side + 10, jeep.z]));
  assert(round, 'the MGL round launches');
  fly(round);
  const blast = f.events('projectileExplode').find(event => event.pid === round.id);
  assert(blast && Math.abs(blast.x - (jeep.x + side)) < 0.5, `the round explodes on the hull face, not behind it (${blast?.x})`);
  assert(jeep.hp < VEHICLE_DEFS.jeep.hp, 'the direct MGL hit damages the jeep');
  // A LONGARC bolt stops at the tank's face: the body behind the hull is covered.
  const tank = f.vehicle('t'), tankSide = VEHICLE_DEFS.tank.collider.halfWidth;
  Object.assign(behind, { x: tank.x - tankSide - 1.2, y: 1, z: tank.z, hp: 100, grounded: true });
  const bolt = f.game.projectiles.launchBolt(shooter, ctx, aimAt([behind.x, 2.2, behind.z], [tank.x + tankSide + 8, tank.z]), 1);
  assert(bolt, 'the bolt launches');
  fly(bolt);
  assert.equal(behind.hp, 100, 'a bolt never tunnels through a closed hull');
  assert(!f.game.projectiles.active.has(bolt.id), 'the bolt is spent on the hull');
  // A thrown frag bounces off a hull instead of rolling through it.
  const frag = f.game.projectiles.throw(shooter, ctx, 0.5, 0);
  assert(frag, 'the frag is thrown');
  Object.assign(frag, { x: tank.x + tankSide + 2, y: 1.6, z: tank.z, vx: -12, vy: 0, vz: 0, explodeAt: f.game.now + 5000 });
  for (let i = 0; i < 30; i++) {
    f.tick();
    assert(frag.x > tank.x + tankSide - 1e-6, `the frag never enters the tank hull (${frag.x})`);
  }
  assert(frag.vx > 0, 'the frag rebounds off the hull');
}

console.log(JSON.stringify(metrics));
console.log('Vehicle combat: armour matrix, rifle sparks (eff 0), AP rear = 2x front, HMG vs jeep, disabled/burning/slowed, repair and throttled events, regen cap, destroyed payload and mode hook, exposed vs sealed crew, chaos-free shells, shoot from every mount with tracers, seat switch, never-failing exit and solid wrecks passed');
