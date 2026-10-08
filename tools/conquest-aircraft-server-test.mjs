import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { VEHICLE_RULES, vehicleSeatPose, vehicleEnterDistance } from '../shared/vehicles.js';
import { VEHICLE_WEAPONS, mountPose } from '../shared/vehicle-defs.js';
import { hullFootprint, vehicleHullParts } from '../shared/vehicle-collision.js';
import { vehicleLocalPoint } from '../shared/vehicles.js';
import { fireOneShot } from '../server/sim/combat.js';
import { WEAPON_IDS } from '../shared/combatmath.js';

function fixture(type = 'helicopter') {
  const walls = new Set(), holes = new Set(), dimensions = { sx: 1024, sy: 32, sz: 1024 };
  let snapshot;
  const world = { dimensions, getBlock(x,y,z) {
    if (y >= dimensions.sy) return 0;
    if (x < 0 || z < 0 || x >= dimensions.sx || z >= dimensions.sz || y < 0) return 3;
    const key = `${x},${y},${z}`;
    return walls.has(key) || (y === 0 && !holes.has(key)) ? 3 : 0;
  }, setBlock(x,y,z,value) { const key = `${x},${y},${z}`; if (value === 0) { walls.delete(key); holes.add(key); } else walls.add(key); return true; },
  findSpawns: () => [{ x: 450, y: 1, z: 870 }] };
  const game = new GameEngine({ mode: 'conquest', world,
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{x:450,y:1,z:870}], bravo: [{x:750,y:1,z:850}] } },
      conquest: { flags: [{ id: 'A', x:450,y:1,z:850 }], bases: {}, vehicleSpawns: [
        { id:'air', team:'alpha', type, x:450,y:1,z:850,yaw:0 },
        { id:'enemy', team:'bravo', type:'jeep', x:750,y:1,z:850,yaw:0 },
      ] } }, broadcast: value => { snapshot = value; } });
  game.addClient('pilot','Pilot'); game.addClient('enemy-pilot','Enemy');
  const pilot = game.entities.get('pilot'), enemy = game.entities.get('enemy-pilot'), vehicle = game.vehicles.vehicles.get('air');
  Object.assign(pilot, { x: vehicle.x + (type === 'plane' ? 5 : 3), y: 1, z: vehicle.z });
  Object.assign(enemy, { x:750,y:1,z:870 });
  const enter = () => game.applyInput(pilot.id, { keys:{}, vehicleAction:{ type:'enter', vehicleId:vehicle.id }, yaw:vehicle.yaw,pitch:0 });
  enter(); assert.equal(pilot.vehicleId, vehicle.id, 'pilot boards from outside the physical aircraft footprint');
  const input = payload => game.applyInput(pilot.id, { keys:{}, yaw:vehicle.yaw,pitch:0,...payload });
  const ticks = count => { for (let i=0;i<count;i++) game.step(1000/60); };
  return { game, pilot, enemy, vehicle, walls, holes, input, ticks, snapshot:() => snapshot };
}

for (const type of ['helicopter','plane']) {
  const f = fixture(type), {vehicle:v,pilot:p} = f;
  assert.equal(vehicleEnterDistance(type), type === 'plane' ? 7.5 : 5.5);
  f.input({ vehicleThrottle:1,vehicleLift:1 });
  f.ticks(type === 'plane' ? 420 : 240);
  assert(v.y > 9 && !v.grounded && v.hp > 0, `${type} takes off using ordinary sanitized GameEngine input`);
  assert.equal(p.vehicleId,v.id); assert.deepEqual([p.x,p.y,p.z],Object.values(vehicleSeatPose(v)).slice(0,3));
  const row = f.snapshot().vehicles.find(row => row.id === v.id);
  // Quantized rows (spec 3.3): only aircraft carry velocity; zero-valued
  // presentation numbers are omitted and read back as 0.
  for (const field of ['x','y','z','yaw'])
    assert(Number.isFinite(row[field]), `${type} snapshot ${field} is present and finite`);
  assert(['vx','vy','vz'].some(field => Number.isFinite(row[field]) && row[field] !== 0), `${type} in flight publishes its velocity`);
  assert.equal(row.grounded, false, 'flight is spelled out as grounded:false');
  for (const field of ['vx','vy','vz','pitch','roll','speed','airspeed','throttle','enginePower','rotorSpeed','collective'])
    assert(row[field] === undefined || Number.isFinite(row[field]), `${type} snapshot ${field} is finite or omitted at zero`);
  for (const field of ['x','y','z','vx','vy','vz','speed']) if (row[field] !== undefined) assert.equal(row[field], Math.round(row[field] * 100) / 100, `${field} has two decimals`);
  for (const field of ['yaw','pitch','roll']) if (row[field] !== undefined) assert.equal(row[field], Math.round(row[field] * 1000) / 1000, `${field} has three decimals`);
  assert(Number.isFinite(type === 'plane' ? row.airspeed : row.rotorSpeed), `${type} reports its flight speed field in the air`);
  assert(row.stalled === undefined || row.stalled === true);
  if (type === 'plane') assert.equal(typeof row.gearDown,'boolean');
  for (const removed of ['seatCapacity','occupiedSeats','weaponSeatId','maxHp','cooldown']) assert.equal(row[removed], undefined, `${removed} is derived on the client`);
  assert(v.type === 'plane' ? v.z < 825 : v.z < 840, 'forward control moves through the air');
}

{
  const f = fixture(), v = f.vehicle;
  f.input({ vehicleLift:99,vehicleThrottle:-99,vehicleSteer:Infinity,vehicleBrake:NaN,x:Infinity,y:9999,vx:9999 });
  assert.equal(f.pilot.input.vehicleLift,1); assert.equal(f.pilot.input.vehicleThrottle,-1);
  assert.equal(f.pilot.input.vehicleSteer,undefined); assert.equal(f.pilot.input.vehicleBrake,undefined);
  f.input({ vehicleLift:NaN }); assert.equal(f.pilot.input.vehicleLift,undefined);
  f.input({ vehicleLift:-99 }); assert.equal(f.pilot.input.vehicleLift,-1);
  f.input({}); assert.equal(f.pilot.input.vehicleLift,undefined);
  Object.assign(v,{ y:175, grounded:false,rotorSpeed:1,vy:8 });
  f.input({ vehicleLift:1 }); f.ticks(180);
  assert(v.y > f.game.world.dimensions.sy && v.y + VEHICLE_RULES.helicopter.height <= 180 + 1e-6, 'the true flight ceiling is 180, above voxel data');
  assert(v.hp>0, 'reaching the sky ceiling causes no crash damage');
  assert.equal(f.game.vehicles.clearHull(v,v.x,120,v.z),true, 'aircraft see air above voxel height');
  const groundHull={...v,type:'jeep'}; assert.equal(f.game.vehicles.clearHull(groundHull,v.x,120,v.z),false, 'ground hull ceiling semantics stay unchanged');
}

for (const type of ['helicopter','plane']) {
  const f = fixture(type), v=f.vehicle;
  Object.assign(v,{x:450,y:18,z:600,vx:0,vy:0,vz:-35,speed:35,airspeed:35,enginePower:1,rotorSpeed:1,throttle:1,grounded:false});
  for(let x=442;x<=458;x++)for(let y=16;y<=25;y++)f.walls.add(`${x},${y},580`);
  f.input({vehicleThrottle:type==='plane'?0:1}); f.ticks(90);
  assert.equal(v.hp,0,`${type} high-speed swept collision with a thin voxel wall destroys the craft`);
  assert(v.z>580, 'collision prevents crossing the voxel wall');
  assert.equal(f.pilot.state,'dead'); assert.equal(f.pilot.vehicleId,null); assert.equal(v.occupantId,null);
}

{
  const f=fixture(),v=f.vehicle;
  Object.assign(v,{y:5,vy:-3,rotorSpeed:1,grounded:false});
  f.input({vehicleLift:-0.5,vehicleBrake:1}); f.ticks(100);
  assert(v.hp>0 && v.grounded && Math.abs(v.y-1)<1e-6,'a controlled helicopter descent lands safely');
  f.input({vehicleAction:{type:'exit'}}); assert.equal(f.pilot.vehicleId,null); assert.equal(f.pilot.grounded,true);
}

for (const type of ['helicopter','plane']) {
  const f=fixture(type),v=f.vehicle,p=f.pilot;
  Object.assign(v,{x:450,y:90,z:700,vx:4,vy:0,vz:-25,speed:25,airspeed:25,rotorSpeed:1,enginePower:1,throttle:1,grounded:false});
  f.input({vehicleAction:{type:'exit'}});
  assert.equal(p.vehicleId,null); assert.equal(v.occupantId,null); assert.equal(p.grounded,false);
  assert(p.y>89 && p.y<94,'airborne exit preserves real altitude');
  const startY=p.y,craftY=v.y; f.ticks(120);
  if (type==='plane') {
    // The jet pilot leaves on the ejection seat (shared/parachute.js): up, then the canopy opens.
    assert(p.y>startY+5 && !p.grounded && p.chute===1,'the jet pilot rides the ejection seat up and then hangs under the canopy');
  } else assert(p.y<startY-8 && !p.grounded,'the ejected operator falls using ordinary player gravity');
  assert(v.y<craftY-3, 'unsupported unoccupied aircraft lose altitude');
}

for (const type of ['helicopter','plane']) {
  const f=fixture(type),v=f.vehicle,ctx=f.game.contexts.projectiles;
  Object.assign(v,{y:100,grounded:false,rotorSpeed:1,enginePower:1,throttle:1});
  const magazine=f.pilot.mag.slice(), key=type==='plane'?'planeCannon':'helicopterRocket', weapon=VEHICLE_WEAPONS[key];
  // Projectile mounts: the pods, or the jet's AA rail (the nose gun is hitscan).
  const projectileKey=type==='plane'?'aaMissile':'helicopterRocket', pose=mountPose(v,'driver',type==='plane'?'rails':'pods');
  const shot={weapon:projectileKey,origin:pose.origin,dir:pose.dir,vehicleId:v.id};
  const before=f.game.projectiles.active.size;
  for(const payload of [{...shot,weapon:'planeCannon'},{...shot,weapon:'rifle'},{...shot,weapon:'constructor'},{...shot,dir:[NaN,0,-1]},
    {...shot,dir:[0,0,-2]},{...shot,origin:[1,2]},{...shot,origin:[Infinity,0,0]}])
    assert.equal(f.game.projectiles.launchVehicleProjectile(f.pilot,payload,ctx),null,'malformed mounted launch is rejected');
  assert.equal(f.game.projectiles.active.size,before);
  const projectile=f.game.projectiles.launchVehicleProjectile(f.pilot,shot,ctx); assert(projectile && projectile.ownerId===f.pilot.id);
  assert.equal(projectile.vehicleId,v.id); assert.equal(projectile.chaosLevel,0); assert.deepEqual(f.pilot.mag,magazine,'mounted launch keeps infantry ammunition');
  const target=f.game.vehicles.vehicles.get('enemy');
  Object.assign(target,{x:projectile.x,y:projectile.y-1,z:projectile.z-14});
  const hp=target.hp; for(let i=0;i<8;i++)f.game.projectiles.step(.05,ctx);
  assert(target.hp<hp,'mounted projectiles damage a hostile airborne hull through the regular combat pipeline');
  assert.equal(f.game.vehicles.damage(v.id,100,f.pilot,{explosive:true}),false,'friendly damage remains rejected');
  f.game.projectiles.clear(); Object.assign(target,{x:750,y:1,z:850});
  f.game.tickEvents.length=0; const events=[]; f.game.broadcast=s=>events.push(...s.events);
  f.input({wantFire:true}); f.ticks(120);
  const shots=events.filter(event=>event.kind==='shoot'&&event.vehicleWeapon===key&&event.vehicleId===v.id);
  const expected=Math.min(2/weapon.cooldown,weapon.magazine??Infinity);
  assert(shots.length>=Math.floor(expected)&&shots.length<=Math.ceil(expected)+1,`${type} mounted cadence remains authoritative (${shots.length} vs ${expected})`);
  if(weapon.kind!=='hitscan')assert.equal(events.filter(event=>event.kind==='projectileLaunch'&&event.vehicleWeapon===key).length,shots.length,'every launch is a shoot');
  assert.deepEqual(f.pilot.mag,magazine,'holding fire never consumes infantry magazines');
}

{
  const f=fixture('plane'),v=f.vehicle,enemy=f.game.vehicles.vehicles.get('enemy');
  Object.assign(v,{x:450,y:100,z:500}); Object.assign(enemy,{x:450,y:100,z:480});
  assert.equal(f.game.vehicles.rayHit([450,101,500],[0,0,-1],30,v.id).id,enemy.id,'own hull cannot mask a farther enemy in a swept segment');
  const hp=v.hp; Object.assign(f.enemy,{x:v.x,y:v.y+.5,z:v.z+20,yaw:0,pitch:0,weapon:WEAPON_IDS.indexOf('rifle')});
  f.enemy.input={keys:{},yaw:0,pitch:0}; fireOneShot(f.enemy,f.game.contexts.combat,1,{yaw:0,pitch:0});
  assert(v.hp<hp,'infantry rays hit an aircraft at its real altitude');
  Object.assign(v,{vx:12,vy:3,vz:-20,pitch:.1,roll:-.25});
  const ballistic=Object.fromEntries(['vx','vy','vz','pitch','roll'].map(field=>[field,v[field]]));
  f.game.vehicles.damage(v.id,10000,f.enemy,{explosive:true});
  assert.equal(v.hp,0); assert.equal(f.pilot.vehicleId,null);
  for(const field of ['vx','vy','vz','pitch','roll'])assert.equal(v[field],ballistic[field],'wreck retains the real impact attitude and momentum');
  for(const field of ['throttle','enginePower','rotorSpeed','pitchRate','rollRate','rudderRate','yawRate'])assert.equal(v[field],0,'wreck clears powered flight and angular controls');
  f.ticks(VEHICLE_RULES.plane.respawnSeconds*60+10); assert.equal(v.hp,VEHICLE_RULES.plane.hp); assert.equal(v.x,v.spawn.x);assert.equal(v.y,v.spawn.y);assert.equal(v.z,v.spawn.z);
  assert.equal(v.occupantId,null);assert.equal(v.grounded,true);
}

{
  const f=fixture('plane'),v=f.vehicle;
  Object.assign(v,{x:10,y:120,z:500,yaw:Math.PI/2,vx:-65,vy:0,vz:0,speed:65,airspeed:65,throttle:1,enginePower:1,grounded:false});
  f.input({yaw:Math.PI/2});f.ticks(150);
  const hull=hullFootprint(v.type,v.x,v.z,v.yaw);
  assert(hull.minX>=-1e-6&&hull.maxX<=1024+1e-6&&hull.minZ>=-1e-6&&hull.maxZ<=1024+1e-6,'boundary sweep prevents escaping through sky');
  assert(v.hp>0,'abstract map edges do not cause terrain crash damage');
}

{
  const f=fixture('plane'),v=f.vehicle;
  Object.assign(v,{y:2.5,pitch:-.55,roll:0,grounded:false});
  for(let x=440;x<=460;x++)for(let z=840;z<=860;z++)f.walls.add(`${x},1,${z}`);
  assert.equal(f.game.vehicles.clearHull(v,v.x,v.y,v.z),false,'a pitched nose cannot penetrate the runway');
  v.pitch=0;assert.equal(f.game.vehicles.clearHull(v,v.x,v.y,v.z),true,'the level fuselage clears the same runway');
  f.walls.clear();Object.assign(v,{y:25,roll:.75});
  const wing=vehicleLocalPoint(v,-4.43,1.27,1.14);
  f.walls.add(wing.map(Math.floor).join(','));
  assert.equal(f.game.vehicles.clearHull(v,v.x,v.y,v.z),false,'a banked low wing collides with terrain below the aircraft root');
  assert.equal(f.game.vehicles.rayHit([wing[0],wing[1],wing[2]+10],[0,0,-1],20)?.id,v.id,'direct rays hit the banked wing at its transformed altitude');
  f.walls.clear();Object.assign(v,{y:100,pitch:0,roll:0,yaw:Math.PI/4});
  assert.equal(f.game.vehicles.rayHit([v.x+6,110,v.z+6],[0,-1,0],20),null,'a yawed aircraft has no phantom collision at its world AABB corner');
  Object.assign(v,{yaw:0,gearDown:true});
  assert.equal(f.game.vehicles.rayHit([v.x,100.15,v.z-6],[0,0,1],5)?.id,v.id,'deployed nose gear is part of the physical hull');
  v.gearDown=false;
  assert.equal(f.game.vehicles.rayHit([v.x,100.15,v.z-6],[0,0,1],5),null,'stowed gear leaves no invisible ray target below the fuselage');
}

{
  const f=fixture(),v=f.vehicle;
  Object.assign(v,{x:101.5,y:20,z:100,pitch:0,roll:0});
  for(let z=92;z<=108;z++)for(let y=15;y<=26;y++)f.walls.add(`99,${y},${z}`);
  const hp=v.hp;f.game.vehicles.explosion([98,21.6,100],5,95,f.enemy);
  assert.equal(v.hp,hp,'solid cover blocks aircraft splash through the regular terrain visibility ray');
  f.walls.clear();f.game.vehicles.explosion([98,21.6,100],5,95,f.enemy);
  assert(v.hp<hp,'the same uncovered aircraft receives splash');
}

{
  const f=fixture(),v=f.vehicle,p=f.enemy;
  Object.assign(v,{x:450,y:70,z:600,pitch:0,roll:0});
  Object.assign(p,{x:450.85,y:70.9,z:600,vehicleId:null,spawnProtectedUntil:0});
  assert.equal(f.game.vehicles.resolveInfantry(v,{x:v.x,y:v.y,z:v.z,yaw:v.yaw},f.pilot,1/60),true,'open sky never pins an ejected pedestrian as if above-height air were rock');
}

{
  const f=fixture(),v=f.vehicle;
  Object.assign(v,{x:450,y:20,z:600,pitch:0,roll:0,rotorSpeed:1,grounded:false});
  f.walls.add('450,23,598');
  assert(f.game.vehicles.clearHull(v,v.x,v.y,v.z));
  f.input({pitch:.4,vehicleBrake:1});
  for(let i=0;i<60;i++){f.ticks(1);assert(f.game.vehicles.clearHull(v,v.x,v.y,v.z),'stationary pitch/roll cannot rotate the physical hull into a roof');}
  assert(v.pitch<.4&&v.hp>0,'blocked attitude stops at the last safe rotation without damaging a hovering craft');
}

{
  const f=fixture('plane'),v=f.vehicle;
  Object.assign(v,{y:176,vx:0,vy:15,vz:-55,speed:57,airspeed:57,pitch:.3,roll:0,enginePower:1,throttle:1,grounded:false});
  f.input({pitch:.3});f.ticks(120);
  assert(vehicleHullParts(v).every(part=>part.maxY<=180+1e-5),'a banked/pitched plane remains under the physical flight ceiling');
  assert(v.hp>0&&v.speed>20,'ceiling contact keeps forward airspeed for level recovery');
  assert.equal(f.game.mode.policy.flags[0].owner,null,'a high pilot cannot capture the flag below the aircraft');
}

for(const start of [{x:450,z:850},{x:176.5,z:438.5},{x:848.5,z:438.5}]) {
  const f=fixture('plane'),v=f.vehicle;
  Object.assign(v,start);f.input({yaw:0,vehicleThrottle:1,vehicleLift:1});f.ticks(360);
  assert(v.hp===VEHICLE_RULES.plane.hp&&v.y>10&&!v.grounded,'ordinary pilot takes off before the unattended flight');
  f.input({yaw:0,pitch:0,vehicleThrottle:0,vehicleLift:0});
  for(let i=0;i<5400;i++) {
    const before={x:v.x,y:v.y,z:v.z};f.ticks(1);
    assert.equal(v.hp,VEHICLE_RULES.plane.hp,'long fixed mouse heading remains a living full-health flight');
    assert(!v.grounded&&v.y>5&&v.speed>20,'automatic boundary recovery preserves airborne forward flight');
    assert(f.game.vehicles.clearHull(v,v.x,v.y,v.z),'the actual banked hull stays inside map bounds');
    assert(Math.hypot(v.x-before.x,v.y-before.y,v.z-before.z)<1.25,'boundary guidance never teleports the aircraft');
  }
}

{
  const f=fixture(),v=f.vehicle;
  Object.assign(v,{x:65,y:40,z:500,yaw:Math.PI/2,vx:-34,vy:0,vz:0,speed:34,rotorSpeed:1,grounded:false});
  // 34 m/s, 65 m from the west edge, the pilot holding W toward it: the edge
  // brake (and the safety pilot) stop the drift without damage; afterwards the
  // pilot keeps control and turning round flies back inward.
  f.input({yaw:Math.PI/2,vehicleThrottle:1});let recovered=false,braked=false;
  for(let i=0;i<1800;i++) {
    if(i===900)f.input({yaw:-Math.PI/2,vehicleThrottle:1});
    f.ticks(1);recovered ||= i>900&&v.x>120&&v.vx>0;braked ||= v.edgeSteer>0;
    assert(v.hp===VEHICLE_RULES.helicopter.hp&&!v.grounded&&f.game.vehicles.clearHull(v,v.x,v.y,v.z),'helicopter boundary braking and turn remain a clear full-health flight');
  }
  assert(braked,'the helicopter brakes at the map edge');
  assert(recovered,'the pilot keeps control: turning round flies back toward the interior');
}

// Collide and slide: a near-parallel graze removes only the closing speed into
// the wall. The craft keeps flying along it at full health instead of a
// full-velocity "head-on" crash killing the crew.
for (const type of ['helicopter','plane']) {
  const f=fixture(type),v=f.vehicle,hp=VEHICLE_RULES[type].hp,speed=type==='plane'?60:25;
  Object.assign(v,{x:450,y:18,z:640,yaw:0,pitch:0,roll:0,vx:0,vy:0,vz:-speed,speed,airspeed:speed,rotorSpeed:1,enginePower:1,throttle:1,grounded:false});
  const edge=()=>Math.max(...vehicleHullParts(v).flatMap(part=>part.corners.map(corner=>corner[0]))),wallX=Math.ceil(edge()+0.02);
  v.x+=wallX-0.1-edge();
  for(let z=540;z<=660;z++)for(let y=8;y<=30;y++)f.walls.add(`${wallX},${y},${z}`);
  v.vx=speed*Math.tan(0.03);
  f.input({vehicleThrottle:type==='plane'?0:1});
  let touched=false;
  for(let i=0;i<60;i++){f.ticks(1);touched ||= edge()>wallX-1e-3;}
  assert(touched,`${type} grazes the wall`);
  assert.equal(v.hp,hp,`${type} graze at cruise speed is a scrape, not a crash`);
  assert.equal(f.pilot.state,'alive');
  assert(v.z<640-speed*0.7,`${type} keeps its tangential speed along the wall`);
  assert(edge()<=wallX+1e-4,'the wall still stops the normal component');
}

// A skimming helicopter within 0.2 m of the floor flying into a building is a
// horizontal crash, exactly like the same hit higher up; it is no "landing".
{
  const f=fixture(),v=f.vehicle;
  Object.assign(v,{y:1.1,vx:0,vy:0,vz:-30,speed:30,airspeed:30,rotorSpeed:1,enginePower:1,throttle:1,grounded:false});
  const front=Math.min(...vehicleHullParts(v).map(part=>part.hull.minZ));
  for(let x=440;x<=460;x++)for(let y=1;y<=12;y++)f.walls.add(`${x},${y},${Math.floor(front)-2}`);
  f.input({vehicleThrottle:1});f.ticks(30);
  assert.equal(v.hp,0,'a 30 m/s skim into a wall destroys the helicopter');
  assert.equal(f.pilot.state,'dead');
}

// A grounded jet rams a wall: the hull stops at the wall, its speed does not
// keep integrating to a "parked" 67 m/s, and a fast hit costs hull points.
for (const [gap,fast] of [[6,false],[30,true]]) {
  const f=fixture('plane'),v=f.vehicle,hp=VEHICLE_RULES.plane.hp;
  assert(v.grounded);
  const front=Math.min(...vehicleHullParts(v).map(part=>part.hull.minZ)),wallZ=Math.floor(front-gap);
  for(let x=430;x<=470;x++)for(let y=1;y<=12;y++)f.walls.add(`${x},${y},${wallZ}`);
  f.input({vehicleThrottle:1});let peak=0;
  for(let i=0;i<600&&v.hp>0;i++){f.ticks(1);if(i>420)peak=Math.max(peak,v.speed,Math.hypot(v.vx,v.vz));}
  assert(Math.min(...vehicleHullParts(v).map(part=>part.hull.minZ))>=wallZ+1-1e-6,'the jet never passes the wall');
  if(fast) assert(v.hp<hp,`a ${gap} m run into a wall damages the jet`);
  else {
    assert.equal(v.hp,hp,'a slow taxi bump below the pedestrian-nudge speed is harmless');
    assert(peak<2,`a jet pressed against a wall reports no phantom airspeed (${peak})`);
    f.input({vehicleAction:{type:'exit'}});
    assert.equal(f.pilot.vehicleId,null);
    assert(Math.hypot(f.pilot.vx||0,f.pilot.vz||0)<4,'exiting a jet parked against a wall is no high-speed eject');
  }
}

console.log('Aircraft server: real input takeoff, finite flight snapshots, sky ceiling, swept crashes, landing/ejection, unoccupied gravity, mounted combat/cooldowns, ownership, hull rays, respawn and bounds passed');
