import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { PlayerPhysics } from '../public/js/player-physics.js';
import { playerHullContact, slidePlayerVehicleAxis, vehiclePlayerPush } from '../shared/player-vehicle-collision.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';
import { PHYSICS, boxCollides } from '../shared/player-movement.js';

function fixture(type = 'jeep') {
  const walls = new Set();
  const frames = [];
  const world = { dimensions: { sx: 128, sy: 32, sz: 128 },
    getBlock: (x,y,z) => y === 0 || walls.has(`${x},${y},${z}`) ? 3 : 0,
    findSpawns: () => [{ x: 70, y: 1, z: 70 }], setBlock() {} };
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: {
    id: 'frontier', dimensions: world.dimensions,
    spawns: { conquest: { alpha: [{ x: 70, y: 1, z: 70 }], bravo: [{ x: 90, y: 1, z: 70 }] } },
    conquest: { flags: [], bases: {}, vehicleSpawns: [{ id: 'v', type, team: 'alpha', x: 20, y: 1, z: 20, yaw: 0 }] },
  }, broadcast(snapshot) { frames.push(snapshot); } });
  for (const id of ['driver','enemy','friend']) game.addClient(id, id);
  const driver = game.entities.get('driver'), enemy = game.entities.get('enemy'), friend = game.entities.get('friend');
  const v = game.vehicles.vehicles.get('v');
  // Conquest spawn protection would veto every damage route in these fixtures.
  for (const p of [driver,enemy,friend]) Object.assign(p, { input: { keys: {}, yaw: 0, pitch: 0 }, grounded: true, spawnProtectedUntil: 0, spawnProtected: false });
  assert.equal(driver.team, friend.team); assert.notEqual(driver.team, enemy.team);
  function seat() {
    Object.assign(driver, { x: v.x, y: v.y, z: v.z });
    assert(game.vehicles.enter(driver, v.id));
    driver.input = { keys: {}, vehicleThrottle: 1, vehicleBrake: 0, yaw: 0, pitch: 0 };
  }
  return { game, walls, world, driver, enemy, friend, v, seat, frames };
}

// Rotated chassis corners use the actual oriented footprint, not the old radius.
{
  const f = fixture('tank'); f.v.yaw = Math.PI / 4;
  const p = { x: 23.13, y: 1, z: 20.46, state: 'alive' };
  assert(playerHullContact(p, f.v), 'tank corner beyond radial collider touches infantry');
  const push = vehiclePlayerPush(p, f.v, f.game.solidAt, [f.v]);
  assert(push && !push.blocked);
  assert.equal(playerHullContact({ ...p, ...push.position }, f.v), null);
  assert.equal(playerHullContact({ ...p, x: 23.8, z: 23.8 }, f.v), null, 'rotated hull AABB corner remains clear');
}

// Low speed pushes a living body out of the proposed chassis, with no damage.
{
  const f = fixture(); f.seat();
  Object.assign(f.enemy, { x: 20, y: 1, z: 17.55 }); f.v.speed = 2;
  const oldZ = f.enemy.z; f.game.vehicles.step(1 / 60);
  assert(f.enemy.z < oldZ); assert.equal(f.enemy.hp, 100);
  assert.equal(playerHullContact(f.enemy, f.v), null);
  assert.equal(f.driver.vehicleId, f.v.id, 'seat occupant is excluded from chassis collision');
  assert.equal(f.driver.hp, 100);
}

// A pinned teammate stops the bumper without entering or crossing the wall.
{
  const f = fixture(); f.seat();
  Object.assign(f.friend, { x: 20, y: 1, z: 18.321 });
  Object.assign(f.v, { z: 20.78, speed: 2 });
  for (let x = 18; x <= 22; x++) for (let y = 1; y <= 4; y++) f.walls.add(`${x},${y},17`);
  const z = f.friend.z;
  for (let i = 0; i < 120; i++) f.game.vehicles.step(1 / 60);
  assert(f.v.z > 20.76, 'blocked body stops chassis near the first contact');
  assert(f.friend.z >= 18.32 && f.friend.z <= z);
  assert.equal(boxCollides(f.game.solidAt, f.friend.x, f.friend.y, f.friend.z), false);
  assert.equal(f.friend.hp, 100); assert.equal(f.v.speed, 0);
  assert.equal(playerHullContact(f.friend, f.v), null);
}

// Real GameEngine damage routes retain driver ownership, team policy and killfeed.
{
  const f = fixture(); f.seat(); f.enemy.hp = 10;
  Object.assign(f.enemy, { x: 20, y: 1, z: 17.55 }); f.v.speed = 14;
  f.game.step();
  assert.equal(f.enemy.state, 'dead'); assert.equal(f.driver.kills, 1);
  const events = f.frames.flatMap(frame => frame.events || []);
  const hit = events.find(e => e.kind === 'hit' && e.victim === 'enemy');
  assert(hit && hit.attacker === 'driver' && hit.dmg <= 100);
  assert(events.some(e => e.kind === 'kill' && e.killer === 'driver' && e.w === 'vehicle'));
}
{
  const f = fixture(); f.seat();
  Object.assign(f.friend, { x: 20, y: 1, z: 17.55 }); f.v.speed = 14;
  f.game.step(); assert.equal(f.friend.hp, 100); assert(f.friend.z < 17.55);
  assert.equal(f.frames.flatMap(frame => frame.events || []).filter(e => e.kind === 'hit' && e.victim === 'friend').length, 0);
}
{
  const f = fixture(); f.seat();
  Object.assign(f.enemy, { x: 20, y: 1, z: 17.55, hp: 1000 }); f.v.speed = 8;
  f.game.vehicles.step(1 / 60); const hp = f.enemy.hp;
  Object.assign(f.enemy, { x: 90, z: 90 }); f.game.vehicles.step(0.2);
  Object.assign(f.enemy, { x: f.v.x, z: f.v.z - 2.441 }); f.game.vehicles.step(1 / 60);
  assert.equal(f.enemy.hp, hp, 'separated impact inside the cooldown cannot deal more damage');
  assert.equal(f.game.tickEvents.filter(e => e.kind === 'hit').length, 1);
}
{
  const f = fixture(); f.seat();
  Object.assign(f.enemy, { x: 20, y: 1, z: 17.55, hp: 1000 }); f.v.speed = 8;
  for (let i = 0; i < 120; i++) f.game.vehicles.step(1 / 60);
  assert.equal(f.game.tickEvents.filter(e => e.kind === 'hit').length, 1, 'continuous bumper contact does not repeatedly damage every tick');
  const hp = f.enemy.hp;
  Object.assign(f.enemy, { x: 90, z: 90 });
  Object.assign(f.v, { x: 60, z: 60, speed: 8 }); f.game.vehicles.step(0.25);
  Object.assign(f.enemy, { x: f.v.x, z: f.v.z - 2.441 }); f.game.vehicles.step(1 / 60);
  assert(f.enemy.hp < hp, 'a separated new impact can damage after cooldown');
  const speedAtDisconnect=f.v.speed;
  f.game.removeClient('driver');
  assert.equal(f.v.occupantId, null); assert.equal(f.v.speed, speedAtDisconnect);
  const hpAfterDisconnect = f.enemy.hp; f.game.vehicles.step(1 / 60);
  assert(f.v.speed>=0 && f.v.speed<speedAtDisconnect,'disconnected operator leaves a naturally decelerating hull');
  assert.equal(f.enemy.hp, hpAfterDisconnect, 'disconnected driver cannot deal runover damage');
  f.game.removeClient('enemy'); f.game.vehicles.step(1 / 60);
  assert.equal(f.game.vehicles.infantryContacts.size, 0, 'departed bodies release contact bookkeeping');
}

// Server and prediction use the same movement seam against parked/live hulls.
for (const type of ['jeep', 'tank']) for (const yaw of [0, Math.PI / 4]) {
  const f = fixture(type); f.v.yaw = yaw;
  const p = f.enemy;
  Object.assign(p, { x: 25, y: 1, z: 20, yaw: 0, vx: 0, vy: 0, vz: 0,
    input: { keys: { l: true }, yaw: 0, pitch: 0 } });
  const physics = new PlayerPhysics();
  Object.assign(physics.pos, { x: p.x, y: p.y, z: p.z }); physics.grounded = true;
  physics._solidAt = f.game.solidAt; physics._fluidAt = () => false;
  physics.vehicleColliders = f.game.vehicles.snapshot();
  for (let i = 0; i < 180; i++) {
    f.game.integrate(p, 1 / 60);
    physics.step(1 / 60, { x: -1, z: 0 }, PHYSICS.walk, false);
  }
  assert(p.x > 20, `${type} walking entry is blocked`);
  // Rows are quantized (2 dp positions, 3 dp angles), so prediction agrees to millimetres.
  assert(Math.abs(p.x - physics.pos.x) < 0.005 && Math.abs(p.y - physics.pos.y) < 0.005, `${type} prediction parity`);
  assert.equal(playerHullContact(p, f.v), null);
}

// Roofs, ground beneath elevated chassis, prone clearance and wreck removal.
{
  const f = fixture('tank'), top = f.v.y + VEHICLE_RULES.tank.height;
  const p = { x: 20, y: top + 1, z: 20 };
  p.y = top - 1;
  assert(slidePlayerVehicleAxis(p, 'y', top + 1, [f.v]));
  assert(Math.abs(p.y - top) < 0.001, 'descending body lands on tank height');
  assert.equal(playerHullContact({ x: 20, y: top + 0.01, z: 20 }, f.v), null);
  assert.equal(playerHullContact({ x: 20, y: -1.5, z: 20 }, f.v), null, 'body below chassis floor remains clear');
  assert(playerHullContact({ x: 20, y: 1, z: 20, proneT: 1 }, f.v), 'prone body still collides with hull');
  assert.equal(playerHullContact({ x: 20, y: 1, z: 20, vehicleId: 'another-seat' }, f.v), null);
  assert.equal(playerHullContact({ x: 20, y: 1, z: 20, state: 'dead' }, f.v), null);
  f.v.hp = 0; f.v.wreckAge = 0;
  assert(playerHullContact({ x: 20, y: 1, z: 20 }, f.v), 'a fresh ground wreck stays solid');
  f.v.wreckAge = 12; assert.equal(playerHullContact({ x: 20, y: 1, z: 20 }, f.v), null, 'the wreck clears after 12 s');
}
{
  const f = fixture(), p = { x: 10, y: 1, z: 20 };
  p.x = 30;
  assert(slidePlayerVehicleAxis(p, 'x', 10, [f.v]), 'swept movement cannot tunnel through an entire parked hull');
  assert(p.x < 20);
}
{
  // A body on the pad: the hull takes one of the three alternate pad offsets.
  const f = fixture(); f.v.hp = 0; f.v.respawnIn = 0; f.v.wreckAge = 30;
  Object.assign(f.enemy, { x: 20, y: 1, z: 20 });
  f.game.vehicles.step(1 / 60);
  assert.equal(f.v.hp, VEHICLE_RULES.jeep.hp, 'an alternate pad offset respawns the hull');
  assert(Math.hypot(f.v.x - 20, f.v.z - 20) > 3, 'the hull moved to an alternate offset');
  assert.equal(playerHullContact(f.enemy, f.v), null, 'respawn never materializes around standing infantry');
}
{
  // Every offset blocked: infantry on the pad is nudged clear after 10 s.
  const f = fixture(); f.v.hp = 0; f.v.respawnIn = 0; f.v.wreckAge = 30;
  for (const [x, z] of [[24, 20], [16, 20], [20, 26]]) f.walls.add(`${x},1,${z}`);
  Object.assign(f.enemy, { x: 20, y: 1, z: 20 });
  for (let i = 0; i < 60 * 9; i++) f.game.vehicles.step(1 / 60);
  assert.equal(f.v.hp, 0, 'a fully blocked pad waits');
  assert.equal(f.enemy.x, 20, 'no nudge before 10 s');
  for (let i = 0; i < 60 * 2; i++) f.game.vehicles.step(1 / 60);
  assert.equal(f.v.hp, VEHICLE_RULES.jeep.hp, 'the pad respawns after the nudge');
  assert(Math.abs(f.v.x - 20) < 1e-9 && Math.abs(f.v.z - 20) < 1e-9, 'the primary pad pose is used');
  assert.equal(playerHullContact(f.enemy, f.v), null);
  assert.equal(boxCollides(f.game.solidAt, f.enemy.x, f.enemy.y, f.enemy.z), false, 'the nudge never pushes into terrain');
}

console.log('Vehicle infantry: rotated chassis, wall-safe push/stop, real driver damage/team/killfeed, contact cooldown, disconnect, server/client walking and vertical hull separation passed');
