// Sight-guided AT missiles (SACLOS): the attack helicopter gunner's wingtip
// GUIDED MSL (cycled with the chin cannon, steered by the chin gimbal) and the
// AT jeep's TOW on the pintle. The missile leaves along the launcher, then
// rides the gunner's live sight ray; it flies straight on once the gunner
// leaves the seat, and flares (an IR decoy) never touch it.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { VEHICLE_WEAPONS, VEHICLE_DEFS, vehicleMaxHp } from '../shared/vehicle-defs.js';
import { CONQUEST_CONTRACT_VERSION, VEHICLE_TYPE_IDS, seatWeaponList, vehicleHullType, vehicleMountOrder } from '../shared/conquest-contract.js';

const TICK = 1000 / 60;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

function fixture(spawns) {
  const dimensions = { sx: 640, sy: 64, sz: 640 }, frames = [];
  const world = { dimensions, getBlock: (x, y, z) => y === 0 ? 3 : 0, setBlock: () => true, findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: spawns } } });
  const player = (id, team, extra = {}) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    game.mode.policy.setLobbyTeam(p, team);
    Object.assign(p, { hp: 100, armor: 0, spawnProtectedUntil: 0, spawnProtected: false, grounded: true, input: { keys: {}, yaw: 0, pitch: 0 }, ...extra });
    return p;
  };
  const vehicle = id => game.vehicles.vehicles.get(id);
  const board = (p, id, seatId) => {
    const v = vehicle(id);
    Object.assign(p, { x: v.x, y: v.y, z: v.z });
    game.applyInput(p.id, { keys: {}, yaw: v.yaw, pitch: 0, vehicleAction: { type: 'enter', vehicleId: id, seatId } });
    assert.equal(p.vehicleSeatId, seatId);
    return p;
  };
  const events = kind => frames.flatMap(frame => frame.events).filter(event => event.kind === kind);
  return { game, frames, player, vehicle, board, events };
}
/** World aim from a mount's pivot to a point. */
const aimAt = (f, v, seatId, mountId, point) => {
  const o = f.game.vehicles.mountPose(v, seatId, mountId).pivot, d = point.map((n, i) => n - o[i]);
  return { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) };
};
const missiles = f => [...f.game.projectiles.active.values()].filter(r => r.weaponKey === 'guidedMissile' || r.weaponKey === 'towMissile');
/** Hold the gunner's aim on `aim()` for `ticks`, optionally pulling the trigger on the first. */
function hold(f, p, aim, ticks, { fire = false } = {}) {
  for (let i = 0; i < ticks; i++) {
    f.game.applyInput(p.id, { keys: {}, ...aim(), wantFire: fire && i === 0 });
    f.game.step(TICK);
  }
}
const heliSpawns = extra => [{ id: 'heli', type: 'helicopter', team: 'alpha', x: 300, y: 1, z: 400, yaw: 0 }, ...extra];

test('contract: version 6, the gunner cycles chin cannon and guided missile, the AT jeep is a jeep hull with a TOW', () => {
  assert.equal(CONQUEST_CONTRACT_VERSION, 6);
  assert.deepEqual(seatWeaponList('helicopter', 'gunner'), [{ mount: 'chin', weapon: 'chinCannon' }, { mount: 'atgm', weapon: 'guidedMissile' }]);
  assert.deepEqual(vehicleMountOrder('helicopter'), ['driver:pods', 'gunner:chin', 'gunner:atgm'], 'the new mount is appended');
  assert.ok(VEHICLE_TYPE_IDS.includes('jeep_at'));
  assert.equal(vehicleHullType('jeep_at'), 'jeep');
  assert.deepEqual(seatWeaponList('jeep_at', 'gunner'), [{ mount: 'pintle', weapon: 'towMissile' }]);
  const jeep = VEHICLE_DEFS.jeep, at = VEHICLE_DEFS.jeep_at;
  assert.deepEqual([at.handling, at.armor, at.hp, at.collider], [jeep.handling, jeep.armor, jeep.hp, jeep.collider]);
  assert.deepEqual(at.seats.map(s => [s.id, s.position]), jeep.seats.map(s => [s.id, s.position]));
  assert.equal(VEHICLE_DEFS.helicopter.mounts.atgm.sight, 'chin');
  for (const key of ['guidedMissile', 'towMissile']) {
    const w = VEHICLE_WEAPONS[key];
    assert.equal(w.cls, 'at'); assert.equal(w.kind, 'missile'); assert.ok(w.beam?.turnRate > 0 && w.beam.lead > 0);
    // One missile kills a jeep; a tank takes four on the front plate (x0.75..0.85), three on the side.
    assert.ok(w.damage + w.splash >= vehicleMaxHp('jeep'));
    assert.ok((w.damage + w.splash) * 0.85 * 3 < vehicleMaxHp('tank') && (w.damage + w.splash) * 0.75 * 4 > vehicleMaxHp('tank') * 0.95);
  }
});

test('the heli gunner selects the guided missile and it curves onto a tank off the nose when the sight moves onto it', () => {
  const tankAt = [300 + 90, 1, 400 - 130];
  const f = fixture(heliSpawns([{ id: 'tank', type: 'tank', team: 'bravo', x: tankAt[0], y: tankAt[1], z: tankAt[2], yaw: 0 }]));
  const heli = f.vehicle('heli'), tank = f.vehicle('tank');
  const gunner = f.board(f.player('gunner', 'alpha'), 'heli', 'gunner');
  f.game.applyInput(gunner.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'weapon', index: 1 } });
  f.game.step(TICK);
  assert.equal(heli.sel.gunner, 1, 'weapon index 1 is the guided missile');
  assert.equal(f.game.vehicles.mounts.selected(heli, 'gunner').weapon, 'guidedMissile');
  const ahead = () => ({ yaw: heli.yaw, pitch: -0.02 });
  hold(f, gunner, ahead, 40);
  hold(f, gunner, ahead, 1, { fire: true });
  const [missile] = missiles(f);
  assert.ok(missile, 'the missile launches');
  assert.ok(missile.beam && !missile.guidance, 'sight guidance, no lock');
  const launch = f.events('projectileLaunch').find(e => e.pid === missile.id);
  assert.equal(launch.vehicleWeapon, 'guidedMissile'); assert.equal(launch.beam, 1);
  assert.ok(launch.v[2] < -70 && Math.abs(launch.v[0]) < 1, 'it leaves the rail along the hull nose');
  const shot = f.events('shoot').find(e => e.vehicleWeapon === 'guidedMissile');
  assert.equal(shot.mount, 'atgm');
  const atgm = f.game.vehicles.mounts.state(heli, 'atgm');
  assert.equal(atgm.ammo, 1, 'one of two rails spent'); assert.equal(atgm.rearm.length, 1);
  // Fly 0.35 s along the nose, then swing the sight onto the tank (~35 degrees right).
  hold(f, gunner, ahead, 21);
  const hp = tank.hp;
  const target = () => aimAt(f, heli, 'gunner', 'chin', [tank.x, tank.y + 1.4, tank.z]);
  let updates = 0;
  for (let i = 0; i < 300 && f.game.projectiles.active.has(missile.id); i++) hold(f, gunner, target, 1);
  updates = f.events('projectileUpdate').filter(e => e.pid === missile.id).length;
  assert.ok(!f.game.projectiles.active.has(missile.id), 'the missile detonated');
  assert.ok(hp - tank.hp > 200, `the guided missile hits the tank off the initial heading (${hp - tank.hp})`);
  assert.ok(updates >= 5, `clients receive 100 ms path corrections (${updates})`);
  for (let i = 0; i < 8; i++) f.game.step(TICK);
  const hit = f.events('vehicle_hit').find(e => e.vehicleId === 'tank');
  assert.equal(hit.cls, 'at'); assert.equal(hit.attacker, 'gunner');
});

test('guidance ends when the gunner leaves the seat: the missile flies straight on', () => {
  const tankAt = [300 + 90, 1, 400 - 130];
  const f = fixture(heliSpawns([{ id: 'tank', type: 'tank', team: 'bravo', x: tankAt[0], y: tankAt[1], z: tankAt[2], yaw: 0 }]));
  const heli = f.vehicle('heli'), tank = f.vehicle('tank');
  const gunner = f.board(f.player('gunner', 'alpha'), 'heli', 'gunner');
  f.game.applyInput(gunner.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'weapon', index: 1 } });
  const ahead = () => ({ yaw: heli.yaw, pitch: -0.02 });
  hold(f, gunner, ahead, 40);
  hold(f, gunner, ahead, 1, { fire: true });
  const [missile] = missiles(f);
  hold(f, gunner, ahead, 6);
  f.game.applyInput(gunner.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'exit' } });
  f.game.step(TICK);
  assert.equal(gunner.vehicleId, null, 'the gunner got out');
  for (let i = 0; i < 20; i++) f.game.step(TICK);
  assert.equal(missile.beam, null, 'guidance is gone');
  const v0 = [missile.vx, missile.vy, missile.vz];
  for (let i = 0; i < 30 && f.game.projectiles.active.has(missile.id); i++) f.game.step(TICK);
  assert.deepEqual([missile.vx, missile.vy, missile.vz].map(n => Math.round(n * 1e6)), v0.map(n => Math.round(n * 1e6)), 'it keeps its heading');
  for (let i = 0; i < 400 && f.game.projectiles.active.has(missile.id); i++) f.game.step(TICK);
  assert.equal(tank.hp, vehicleMaxHp('tank'), 'the unguided missile misses the tank off its heading');
});

test('flares do not decoy a sight-guided missile', () => {
  const f = fixture(heliSpawns([{ id: 'enemy', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 220, yaw: 0 }]));
  const heli = f.vehicle('heli'), enemy = f.vehicle('enemy');
  const pilot = f.board(f.player('pilot', 'bravo'), 'enemy', 'driver');
  const gunner = f.board(f.player('gunner', 'alpha'), 'heli', 'gunner');
  const pin = () => Object.assign(enemy, { x: 300, y: 12, z: 220, vx: 0, vy: 0, vz: 0, speed: 0, grounded: false, rotorSpeed: 1, pitch: 0, roll: 0 });
  pin();
  f.game.applyInput(gunner.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'weapon', index: 1 } });
  const target = () => { pin(); return aimAt(f, heli, 'gunner', 'chin', f.game.vehicles.hullCenter(enemy)); };
  hold(f, gunner, target, 40);
  hold(f, gunner, target, 1, { fire: true });
  const [missile] = missiles(f);
  hold(f, gunner, target, 20);
  f.game.applyInput(pilot.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'cm' } });
  pin(); f.game.step(TICK);
  assert.deepEqual(f.events('countermeasure').map(e => [e.vehicleId, e.cm]), [['enemy', 'flares']]);
  assert.ok(missile.beam && !missile.guidance, 'still riding the sight after the flares');
  const hp = enemy.hp;
  for (let i = 0; i < 400 && f.game.projectiles.active.has(missile.id); i++) hold(f, gunner, target, 1);
  assert.ok(hp - enemy.hp > 200, `the flared helicopter is hit (${hp - enemy.hp})`);
});

test('the AT jeep gunner fires the TOW from the pintle; it rides the launcher sight and the box reloads after three', () => {
  const f = fixture([{ id: 'atj', type: 'jeep_at', team: 'alpha', x: 300, y: 1, z: 400, yaw: 0 },
    { id: 'tank', type: 'tank', team: 'bravo', x: 420, y: 1, z: 330, yaw: 0 },
    { id: 'jeep', type: 'jeep', team: 'bravo', x: 220, y: 1, z: 300, yaw: 0 }]);
  const atj = f.vehicle('atj'), tank = f.vehicle('tank'), jeep = f.vehicle('jeep');
  const gunner = f.board(f.player('gunner', 'alpha'), 'atj', 'gunner');
  assert.equal(f.game.vehicles.mounts.selected(atj, 'gunner').weapon, 'towMissile');
  const pintle = () => f.game.vehicles.mounts.state(atj, 'pintle');
  assert.equal(pintle().ammo, 3);
  const onTank = () => aimAt(f, atj, 'gunner', 'pintle', [tank.x, tank.y + 1.4, tank.z]);
  hold(f, gunner, onTank, 90);
  hold(f, gunner, onTank, 1, { fire: true });
  const [missile] = missiles(f);
  assert.ok(missile?.beam, 'the TOW launches sight-guided');
  assert.equal(missile.weaponKey, 'towMissile'); assert.equal(pintle().ammo, 2);
  const hp = tank.hp;
  for (let i = 0; i < 500 && f.game.projectiles.active.has(missile.id); i++) hold(f, gunner, onTank, 1);
  assert.ok(hp - tank.hp > 200, `the TOW hits the tank (${hp - tank.hp})`);
  // A light hull dies to one TOW.
  const onJeep = () => aimAt(f, atj, 'gunner', 'pintle', [jeep.x, jeep.y + 1, jeep.z]);
  hold(f, gunner, onJeep, 150);
  hold(f, gunner, onJeep, 1, { fire: true });
  const second = missiles(f)[0];
  for (let i = 0; i < 500 && f.game.projectiles.active.has(second.id); i++) hold(f, gunner, onJeep, 1);
  assert.ok(!(jeep.hp > 0), 'one TOW destroys a jeep');
  hold(f, gunner, onTank, 200);
  hold(f, gunner, onTank, 1, { fire: true });
  assert.equal(pintle().ammo, 0);
  assert.ok(pintle().reloadT > 11, 'the empty box reloads');
  const row = f.frames.at(-1).vehicles.find(r => r.id === 'atj');
  assert.equal(row.type, 'jeep_at'); assert.equal(row.mounts.length, 1);
});

console.log(`conquest guided missile test: ${passed} passed`);
