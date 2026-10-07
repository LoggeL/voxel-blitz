import assert from 'node:assert/strict';
import { VehicleSystem } from '../server/sim/vehicles.js';
import { GameEngine } from '../server/game.js';
import { groundAttitude } from '../shared/vehicle-attitude.js';
import { VEHICLE_DEFS, VEHICLE_LIFECYCLE, mountPose, vehicleMaxHp } from '../shared/vehicle-defs.js';
import { playerHullContact } from '../shared/player-vehicle-collision.js';
import { boxCollides } from '../shared/player-movement.js';
function fixture(type='jeep') {
 const walls=new Set(); const p={id:'p',state:'alive',team:0,x:20,y:1,z:20,yaw:0,pitch:0,input:{keys:{f:true}}};
 const enemy={...p,id:'e',team:1}; const other={...p,id:'o'};
 const engine={entities:new Map([[p.id,p],[enemy.id,enemy],[other.id,other]]),world:{dimensions:{sx:100,sy:30,sz:100},getBlock(x,y,z){return y===0||walls.has(`${x},${y},${z}`)?3:0;}},mapMeta:{conquest:{vehicleSpawns:[{id:'v',team:0,type,x:20,y:1,z:20,yaw:0}]}},mode:{canFire:()=>true},projectiles:{launchVehicleProjectile:(owner,shot)=>{engine.shots.push({owner,shot});return {id:engine.shots.length};}},shots:[],killPlayer(p){p.state='dead';}};
 return {p,enemy,other,engine,walls,system:new VehicleSystem(engine)};
}
{
 const f=fixture();assert.equal(f.system.enter(f.enemy,'v'),false); f.other.x=30;assert.equal(f.system.enter(f.other,'v'),false);
 assert.equal(f.system.enter(f.p,'v'),true);f.other.x=20;assert.equal(f.system.enter(f.other,'v'),true);assert.equal(f.other.vehicleSeatId,'gunner','next free seat in topology order');
 const third={...f.p,id:'t',vehicleId:null,vehicleSeatId:null};f.engine.entities.set('t',third);
 assert.equal(f.system.enter(third,'v','rear-left'),true);assert.equal(third.vehicleSeatId,'rear-left','requested free seat is honoured');
 assert.equal(f.system.action(third,{type:'seat',seatId:'gunner'}),false,'occupied seat refuses a switch');
 assert.equal(f.system.action(third,{type:'seat',seatId:'front-passenger'}),true);assert.equal(third.vehicleSeatId,'front-passenger');
 assert.equal(f.system.vehicles.get('v').seatOccupants['rear-left'],null);
 assert.equal(f.system.action(f.p,{type:'teleport',x:60}),false);f.system.step(1/60);assert.ok(f.system.seatedPose(f.p));
 assert.equal(f.system.exit(f.p),true);assert.equal(f.p.vehicleId,null);assert.equal(f.system.vehicles.get('v').occupantId,null);
}
{
 const a=fixture(),b=fixture();a.system.enter(a.p,'v');b.system.enter(b.p,'v');
 for(let i=0;i<120;i++)a.system.step(1/120);for(let i=0;i<30;i++)b.system.step(1/30);
 assert.ok(Math.abs(a.system.vehicles.get('v').z-b.system.vehicles.get('v').z)<0.02);
}
{
 const f=fixture();for(let x=15;x<=25;x++)for(let y=1;y<6;y++)f.walls.add(`${x},${y},15`);
 f.system.enter(f.p,'v');for(let i=0;i<240;i++)f.system.step(1/60);assert.ok(f.system.vehicles.get('v').z>17);
 f.p.input.keys={b:true};for(let i=0;i<100;i++)f.system.step(1/60);assert.ok(f.system.vehicles.get('v').z>20);
}
{
 const f=fixture('tank');f.system.enter(f.p,'v');f.p.input={yaw:1,pitch:0.1,wantFire:true,keys:{}};
 // The gun fires along the barrel as it slews; there is no alignment gate.
 f.system.step(1/60);const v=f.system.vehicles.get('v');assert.equal(f.engine.shots.length,1,'the main gun fires along the barrel at once');
 assert.ok(v.turretYaw>0 && v.turretYaw<0.02);assert.equal(f.engine.shots[0].shot.weapon,'tankAP');assert.equal(f.engine.shots[0].shot.vehicleId,'v');
 assert.ok(Math.abs(Math.atan2(-f.engine.shots[0].shot.dir[0],-f.engine.shots[0].shot.dir[2])-v.turretYaw)<1e-6,'shell leaves along the barrel');
 for(let i=0;i<60;i++)f.system.step(1/60);assert.equal(f.engine.shots.length,1,'3.5 s breech reload');assert.equal(f.engine.shots[0].owner,f.p);assert.equal(v.yaw,0);assert.ok(Math.abs(v.turretYaw-1)<1e-9);
 for(let i=0;i<150;i++)f.system.step(1/60);assert.equal(f.engine.shots.length,2);assert.ok(Math.abs(Math.atan2(-f.engine.shots[1].shot.dir[0],-f.engine.shots[1].shot.dir[2])-1)<1e-6);
 f.system.release(f.p);for(let i=0;i<300;i++)f.system.step(1/60);assert.equal(f.engine.shots.length,2,'an empty seat never fires');
 assert.equal(f.system.damage('v',1000,f.p,{explosive:true}),false);assert.equal(f.system.damage('v',1000,f.enemy,{explosive:true}),true);assert.equal(v.hp,0);
 for(let i=0;i<29*60;i++)f.system.step(1/60);assert.equal(v.hp,0,'tank respawns after 30 s');
 for(let i=0;i<2*60;i++)f.system.step(1/60);assert.equal(v.hp,1000);
 assert.equal(f.system.rayHit([20,2,30],[0,0,-1],30).id,'v');
}
{
 const f=fixture();f.system.enter(f.p,'v');for(let x=16;x<=24;x++)for(let z=16;z<=24;z++)for(let y=1;y<=3;y++)f.walls.add(`${x},${y},${z}`);
 assert.equal(f.system.exit(f.p),true,'exit never fails');assert.equal(f.p.vehicleId,null);assert.equal(f.p.ghostVehicleId,'v','forced eject ignores the hull briefly');
 for(let i=0;i<70;i++)f.system.step(1/60);assert.equal(f.p.ghostVehicleId,null,'no-collide lasts one second');
 assert.equal(f.system.enter(f.p,'v'),true);f.p.state='dead';f.system.step(1/60);assert.equal(f.p.vehicleId,null);
}
{
 const f=fixture(); for(let x=16;x<=24;x++)for(let z=14;z<=18;z++)f.walls.add(`${x},1,${z}`);
 f.system.enter(f.p,'v');for(let i=0;i<40;i++)f.system.step(1/60);
 assert.equal(f.system.vehicles.get('v').y,2,'vehicle follows a climbable one-block slope');
 f.engine.entities.delete(f.p.id);f.system.step(1/60);assert.equal(f.system.vehicles.get('v').occupantId,null);
}
{
 const f=fixture('tank');f.system.enter(f.p,'v');f.system.damage('v',1000,f.enemy,{explosive:true});
 assert.equal(f.p.state,'dead');assert.equal(f.p.vehicleId,null);assert.equal(f.system.vehicles.get('v').occupantId,null);
}
// ===================================================================== physics fixes and hull lifecycle
// (spec F4) through the real GameEngine: ground attitude, fall damage, wall
// slide, heavy push, safe taxi, abandoned hulls, flag pads, aircraft sleep, spotting.
const TICK = 1000 / 60;
function engineFixture(spawns, { bases = {} } = {}) {
  const dimensions = { sx: 384, sy: 64, sz: 384 }, blocks = new Set(), frames = [];
  const world = { dimensions, getBlock: (x, y, z) => y === 0 || blocks.has(`${x},${y},${z}`) ? 3 : 0,
    setBlock(x, y, z, value) { if (value) blocks.add(`${x},${y},${z}`); else blocks.delete(`${x},${y},${z}`); return true; },
    findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
      conquest: { flags: [], bases, vehicleSpawns: spawns } } });
  const player = (id, team, extra = {}) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    game.mode.policy.setLobbyTeam(p, team);
    Object.assign(p, { x: 20, y: 1, z: 20, hp: 100, armor: 0, spawnProtectedUntil: 0, spawnProtected: false, grounded: true, input: { keys: {}, yaw: 0, pitch: 0 }, ...extra });
    return p;
  };
  const vehicle = id => game.vehicles.vehicles.get(id);
  const board = (p, id, seatId = 'driver') => {
    const v = vehicle(id); Object.assign(p, { x: v.x, y: v.y, z: v.z });
    game.applyInput(p.id, { keys: {}, yaw: v.yaw, pitch: 0, vehicleAction: { type: 'enter', vehicleId: id, seatId } });
    assert.equal(p.vehicleSeatId, seatId); return p;
  };
  const wall = (x0, x1, z0, z1, y0 = 1, y1 = 4) => { for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) blocks.add(`${x},${y},${z}`); };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) game.step(TICK); };
  const events = kind => frames.flatMap(frame => frame.events).filter(event => event.kind === kind);
  const row = id => frames.at(-1)?.vehicles.find(r => r.id === id);
  return { game, blocks, frames, player, vehicle, board, wall, tick, events, row };
}

// A ground hull on a one-voxel step pitches 0.1-0.3 rad; colliders and mount poses follow.
{
  const f = engineFixture([{ id: 't', type: 'tank', team: 'alpha', x: 100.5, y: 2, z: 200, yaw: 0 }]);
  f.wall(80, 120, 170, 199, 1, 1);
  const t = f.vehicle('t'), flatMuzzle = mountPose({ ...t, pitch: 0, roll: 0 }, 'driver', 'main').origin;
  const fitted = groundAttitude((x, y, z) => f.game.world.getBlock(x, y, z), 'tank', t.x, t.z, t.yaw, t.y);
  assert(fitted.pitch >= 0.1 && fitted.pitch <= 0.3, `fitted step pitch ${fitted.pitch}`);
  assert(Math.abs(fitted.roll) < 1e-9, 'a step across the hull axis adds no roll');
  f.tick(60);
  assert(t.pitch >= 0.1 && t.pitch <= 0.3, `the tank reports pitch ${t.pitch} on a one-voxel step`);
  assert.equal(f.row('t').pitch, Math.round(t.pitch * 1000) / 1000, 'the row carries the quantized pitch');
  assert(mountPose(t, 'driver', 'main').origin[1] > flatMuzzle[1] + 0.3, 'the main gun pose follows the hull pitch');
  const sideways = groundAttitude((x, y, z) => f.game.world.getBlock(x, y, z), 'tank', t.x, t.z, Math.PI / 2, t.y);
  assert(Math.abs(sideways.pitch) < 1e-9 && sideways.roll > 0.1, 'turned across the step the hull rolls instead (right side up)');
  const flat = engineFixture([{ id: 't', type: 'tank', team: 'alpha', x: 100.5, y: 1, z: 200, yaw: 0.4 }]);
  flat.tick(10); assert.equal(flat.vehicle('t').pitch, 0); assert.equal(flat.vehicle('t').roll, 0);
}

// Ground fall damage hp*(vy-9)/25: a 15 m jeep drop hurts, a one-voxel drop does not.
for (const [height, hurt] of [[16, true], [2, false]]) {
  const f = engineFixture([{ id: 'j', type: 'jeep', team: 'alpha', x: 100.5, y: height, z: 100.5, yaw: 0 }]);
  const driver = f.board(f.player('d', 'alpha'), 'j');
  let landedAt = -1;
  for (let i = 0; i < 120 && landedAt < 0; i++) { f.tick(); if (f.vehicle('j').y === 1) landedAt = i; }
  assert(landedAt >= 0, `the jeep lands from ${height} m`);
  const hp = f.vehicle('j').hp, impact = Math.min(60, Math.sqrt(2 * 24 * (height - 1)));
  if (hurt) {
    assert(hp < 320 && hp > 0, `a ${height - 1} m drop damages the jeep (${hp})`);
    assert(Math.abs((320 - hp) - 320 * (impact - 9) / 25) < 320 * 0.06, 'damage follows hp*(vy-9)/25');
  } else assert.equal(hp, 320, 'a one-voxel drop is free');
  assert.equal(driver.state, 'alive');
}

// Diagonal wall contact keeps the tangential motion (>= 40%).
{
  const f = engineFixture([{ id: 'j', type: 'jeep', team: 'alpha', x: 100, y: 1, z: 150, yaw: -Math.PI / 4 }]);
  f.wall(106, 107, 60, 200);
  const driver = f.board(f.player('d', 'alpha'), 'j'), j = f.vehicle('j');
  f.game.applyInput(driver.id, { keys: {}, yaw: j.yaw, pitch: 0, vehicleThrottle: 1 });
  let before = null, contact = -1;
  const samples = [];
  for (let i = 0; i < 180; i++) {
    const x = j.x, z = j.z;
    f.tick();
    if (contact < 0 && j.x - x < 1e-4 && i > 2) { contact = i; }
    else if (contact < 0) before = Math.abs(j.z - z) * 60;
    else samples.push(Math.abs(j.z - z) * 60);
    if (samples.length >= 30) break;
  }
  assert(contact > 0 && before > 3, 'the jeep reaches the wall at speed');
  const after = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert(after >= 0.4 * before, `tangential speed kept: ${after.toFixed(2)} of ${before.toFixed(2)}`);
  assert(j.hp > 0);
}

// A slow heavy hull shoves a pinned body sideways instead of stopping.
{
  const f = engineFixture([{ id: 't', type: 'tank', team: 'alpha', x: 100.5, y: 1, z: 53.5, yaw: 0 }]);
  f.wall(80, 120, 49, 49);
  const driver = f.board(f.player('d', 'alpha'), 't'), friend = f.player('friend', 'alpha', { x: 100.5, y: 1, z: 50.6 });
  const t = f.vehicle('t'), z0 = t.z;
  f.game.applyInput(driver.id, { keys: {}, yaw: 0, pitch: 0, vehicleThrottle: 0.3 });
  f.tick(120);
  assert(t.z < z0 - 0.3, 'the slow tank keeps moving');
  assert(Math.abs(friend.x - 100.5) > 2, 'the pinned body was shoved sideways');
  assert.equal(playerHullContact(friend, t), null); assert.equal(boxCollides(f.game.solidAt, friend.x, friend.y, friend.z), false);
  assert.equal(friend.hp, 100, 'a slow shove never hurts');
}

// A taxiing jet nudged by a pinned pedestrian never self-destructs below 15 m/s.
for (const [speed, safe] of [[10, true], [22, false]]) {
  const f = engineFixture([{ id: 'p', type: 'plane', team: 'alpha', x: 100.5, y: 1, z: 150.5, yaw: 0 }]);
  const pilot = f.board(f.player('pilot', 'alpha'), 'p'), plane = f.vehicle('p');
  const nose = 150.5 - 5.05, friend = f.player('friend', 'alpha', { x: 100.5, y: 1, z: nose - 0.4 });
  f.wall(95, 106, Math.floor(nose - 0.4 - 0.32) - 1, Math.floor(nose - 0.4 - 0.32) - 1);
  Object.assign(plane, { vz: -speed, speed, airspeed: speed, throttle: 0.4, enginePower: 0.4 });
  f.game.applyInput(pilot.id, { keys: {}, yaw: 0, pitch: 0 });
  f.tick(3);
  if (safe) assert.equal(plane.hp, 450, 'a slow taxi bump is harmless');
  else assert(plane.hp < 450, 'a fast ground collision still costs hull');
  assert.equal(friend.hp, 100);
}

// Abandoned hulls (no crew 90 s, > 60 m from the pad, undamaged 30 s) quietly return to their pad.
{
  const f = engineFixture([{ id: 'j', type: 'jeep', team: 'alpha', x: 100.5, y: 1, z: 100.5, yaw: 0 }]);
  const j = f.vehicle('j');
  Object.assign(j, { x: 180.5, z: 100.5, crewlessFor: VEHICLE_LIFECYCLE.abandonSeconds - 0.05, lastDamagedAt: f.game.now - 10000 });
  f.tick(5);
  assert.equal(j.x, 180.5, 'recent damage keeps an abandoned hull in the field');
  j.lastDamagedAt = -Infinity;
  f.tick(5);
  assert.equal(j.x, 100.5); assert.equal(j.z, 100.5); assert.equal(j.hp, 320);
  assert.equal(f.events('vehicle_destroyed').length, 0, 'the return is quiet');
  const crewed = engineFixture([{ id: 'j', type: 'jeep', team: 'alpha', x: 100.5, y: 1, z: 100.5, yaw: 0 }]);
  crewed.board(crewed.player('d', 'alpha'), 'j');
  Object.assign(crewed.vehicle('j'), { x: 180.5, crewlessFor: 1000 });
  crewed.tick(5); assert.equal(crewed.vehicle('j').x, 180.5, 'a crewed hull is never abandoned');
}

// Flag pads: inactive while neutral, owner-bound respawn, bank pad for C, empty hulls switch team.
{
  const f = engineFixture([
    { id: 'flag-A-jeep', type: 'jeep', team: 'alpha', x: 100.5, y: 1, z: 100.5, yaw: 0, flag: 'A' },
    { id: 'flag-C-tank', type: 'tank', team: null, x: 160.5, y: 1, z: 190.5, yaw: 0, flag: 'C', altX: 220.5, altZ: 190.5 },
  ], { bases: { alpha: { id: 'alpha', x: 20, y: 1, z: 190 }, bravo: { id: 'bravo', x: 360, y: 1, z: 190 } } });
  f.tick();
  assert.equal(f.row('flag-C-tank'), undefined, 'the C tank does not exist while C is neutral');
  assert.equal(f.row('flag-A-jeep').flag, 'A', 'rows carry the pad flag');
  assert(f.game.vehicles.setPadOwner('C', 'bravo'));
  f.tick();
  const c = f.vehicle('flag-C-tank');
  assert.equal(c.team, 'bravo'); assert.equal(c.hp, 1000); assert.equal(c.x, 220.5, 'bravo gets the bank pad nearer its HQ');
  // An empty hull near its pad changes hands on capture; a crewed hull does not.
  f.game.vehicles.setPadOwner('C', 'alpha');
  assert.equal(c.team, 'alpha', 'the empty hull on its pad switches team');
  const a = f.vehicle('flag-A-jeep'), crew = f.board(f.player('crew', 'alpha'), 'flag-A-jeep');
  f.game.vehicles.setPadOwner('A', 'bravo');
  assert.equal(a.team, 'alpha', 'a crewed hull keeps its team');
  f.game.vehicles.release(crew); Object.assign(crew, { x: 20, z: 20 });
  // Neutral flag: a destroyed pad hull waits.
  f.game.vehicles.setPadOwner('A', null);
  f.game.vehicles.damage('flag-A-jeep', 5000, null, { cls: 'collision' });
  assert.equal(a.hp, 0);
  f.tick(Math.ceil(VEHICLE_DEFS.jeep.respawnSeconds * 60) + 30);
  assert.equal(a.hp, 0, 'no respawn while the flag is neutral');
  f.game.vehicles.setPadOwner('A', 'bravo'); f.tick(2);
  assert.equal(a.hp, 320); assert.equal(a.team, 'bravo', 'the pad respawns for the new owner');
}

// Parked aircraft sleep: no flight substeps with no crew, grounded and at rest.
{
  const f = engineFixture([{ id: 'h', type: 'helicopter', team: 'alpha', x: 100.5, y: 1, z: 100.5, yaw: 0 },
    { id: 'p', type: 'plane', team: 'alpha', x: 200.5, y: 1, z: 100.5, yaw: 0 }]);
  let calls = 0;
  const original = f.game.vehicles.clearAircraftHull.bind(f.game.vehicles);
  f.game.vehicles.clearAircraftHull = (...args) => { calls++; return original(...args); };
  f.tick(3); calls = 0; f.tick(30);
  assert.equal(calls, 0, 'parked aircraft cost no collision sweeps');
  f.game.pushBlockDelta(10, 5, 10, 3); f.tick(1);
  assert(calls > 0, 'a terrain change wakes them for one check'); calls = 0; f.tick(10);
  assert.equal(calls, 0, 'and they sleep again');
  f.board(f.player('pilot', 'alpha'), 'h'); f.tick(1);
  assert(calls > 0, 'a pilot wakes the helicopter');
  assert.equal(f.vehicle('h').hp, 650); assert.equal(f.vehicle('p').hp, 450);
}

// Spotting marks a hull for the spotting team (row sp) until the deadline.
{
  const f = engineFixture([{ id: 'j', type: 'jeep', team: 'alpha', x: 100.5, y: 1, z: 100.5, yaw: 0 }]);
  assert(f.game.spotVehicle('j', 'bravo', f.game.now + 1000));
  f.tick(); assert.equal(f.row('j').sp, 1, 'spotted by the enemy team');
  f.tick(65); assert.equal(f.row('j').sp, undefined, 'the mark expires');
  f.game.spotVehicle('j', 'alpha', f.game.now + 1000); f.tick();
  assert.equal(f.row('j').sp, undefined, 'own-team marks are not enemy spots');
  assert.equal(f.game.spotVehicle('missing', 'bravo', f.game.now + 1000), false);
}

// Quantized rows stay within the 260 B average budget for every hull type.
{
  const types = Object.keys(VEHICLE_DEFS);
  const f = engineFixture(types.map((type, i) => ({ id: `${type}-1`, type, team: i % 2 ? 'bravo' : 'alpha', x: 40 + i * 40, y: 1, z: 200, yaw: 0.3 })));
  for (const [i, type] of types.entries()) f.board(f.player(`p${i}`, i % 2 ? 'bravo' : 'alpha'), `${type}-1`);
  f.tick(5);
  const rows = f.frames.at(-1).vehicles, sizes = rows.map(row => JSON.stringify(row).length);
  const average = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  assert(average <= 260, `average vehicle row ${average.toFixed(1)} B`);
  for (const row of rows) {
    for (const key of ['x', 'y', 'z']) assert.equal(row[key], Math.round(row[key] * 100) / 100);
    assert.equal(row.hp, Math.round(row.hp)); assert.equal(row.hp, vehicleMaxHp(row));
    assert.equal(typeof row.st, 'number');
    if (!['helicopter', 'transport', 'plane'].includes(row.type)) assert.equal(row.vx ?? row.vy ?? row.vz, undefined, 'only aircraft carry velocity');
    assert.equal(row.engineOn, undefined, 'a running engine is the default (st engine bit)');
    assert(row.st & 1);
  }
  console.log(`vehicle rows: ${sizes.join(' ')} B (average ${average.toFixed(1)})`);
}

console.log('Conquest vehicles: authoritative movement, collisions, ownership, exits, combat and respawn, ground attitude, fall damage, wall slide, heavy push, safe taxi, abandoned hulls, flag pads, aircraft sleep, spotting and row budget passed');

{
 const f=fixture('tank');f.system.enter(f.p,'v');f.p.input={yaw:0,pitch:0,wantFire:true,keys:{}};
 // Wall outside chassis but intersecting the overhanging cannon barrel.
 for(let x=18;x<=22;x++)for(let y=1;y<=4;y++)f.walls.add(`${x},${y},16`);
 f.system.step(1/60);assert.equal(f.engine.shots.length,0,'barrel cannot launch through terrain outside hull');
 f.walls.clear();f.system.step(1/60);assert.equal(f.engine.shots.length,1,'unobstructed aligned barrel fires');
}
