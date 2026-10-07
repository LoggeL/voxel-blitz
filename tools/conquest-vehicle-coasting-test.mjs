import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';
import { playerHullContact } from '../shared/player-vehicle-collision.js';

function fixture(type='jeep') {
  const walls=new Set(),dimensions={sx:512,sy:64,sz:512};
  const world={dimensions,getBlock:(x,y,z)=>y===0||walls.has(`${x},${y},${z}`)?3:0,findSpawns:()=>[{x:350,y:1,z:350}],setBlock(){}};
  const game=new GameEngine({mode:'conquest',world,mapMeta:{id:'frontier',dimensions,
    spawns:{conquest:{alpha:[{x:350,y:1,z:350}],bravo:[{x:400,y:1,z:350}]}},
    conquest:{flags:[],bases:{},vehicleSpawns:[{id:'v',type,team:'alpha',x:200,y:1,z:200,yaw:0}]}},broadcast(){}});
  for(const id of ['driver','enemy','replacement'])game.addClient(id,id);
  const driver=game.entities.get('driver'),enemy=game.entities.get('enemy'),replacement=game.entities.get('replacement'),v=game.vehicles.vehicles.get('v');
  for(const p of [driver,enemy,replacement])Object.assign(p,{x:350,y:1,z:350,hp:100,armor:0,spawnProtectedUntil:0,input:{keys:{},yaw:0,pitch:0}});
  Object.assign(driver,{x:200,y:1,z:200});assert(game.vehicles.enter(driver,'v'));
  return {game,walls,v,driver,enemy,replacement};
}

for(const type of ['jeep','tank']) {
  const f=fixture(type),maximum=VEHICLE_RULES[type].speed;
  Object.assign(f.v,{speed:maximum,yawRate:0,visualSteer:0});
  const origin={x:f.v.x,z:f.v.z};assert(f.game.vehicles.exit(f.driver));
  assert.equal(f.v.speed,maximum,'live seat detach retains velocity');assert.equal(f.v.engineOn,false);
  assert.equal(f.driver.vehicleId,null);assert.equal(f.v.occupantId,null);
  assert.equal(playerHullContact(f.driver,f.v),null,'exit remains outside the moving chassis');
  assert(Math.abs(f.driver.vz)<=16&&f.driver.vz<0,'pedestrian inherits bounded real forward velocity');
  let prior=f.v.speed;
  for(let i=0;i<120;i++) {f.game.vehicles.step(1/60);assert(f.v.speed>=0&&f.v.speed<=prior);prior=f.v.speed;}
  assert(Math.hypot(f.v.x-origin.x,f.v.z-origin.z)>10,'abandoned chassis visibly rolls beyond ten metres');
  assert(f.v.speed>0&&f.v.speed<maximum,'neutral rolling resistance decelerates over time');
  const row=f.game.vehicles.snapshot()[0];assert.equal(row.engineOn,false);assert.equal(row.occupantId??null,null,"quantized rows omit an empty driver");assert(Number.isFinite(row.speed)&&row.vz===undefined,"ground rows carry speed, not derived velocity");
  if(type==='tank')assert(row.leftTrackSpeed>0&&row.rightTrackSpeed>0,'coasting keeps authoritative track animation');
  for(let i=0;i<600;i++)f.game.vehicles.step(1/60);
  assert.equal(f.v.speed,0,'rolling friction eventually stops the chassis');
}

// Steering releases over time and re-entering a moving vehicle preserves its motion.
for(const type of ['jeep','tank']) {
  const f=fixture(type);Object.assign(f.v,{speed:10,yawRate:-.7,visualSteer:.2});
  assert(f.game.vehicles.exit(f.driver));const beforeYaw=f.v.yaw;
  f.game.vehicles.step(1/60);assert.notEqual(f.v.yaw,beforeYaw,'chassis rotation decays instead of snapping to zero');
  const currentRate=Math.abs(f.v.yawRate);f.game.vehicles.step(.25);
  assert(Math.abs(f.v.yawRate)<currentRate,'steering unwinds after release');
  Object.assign(f.replacement,{x:f.v.x,y:f.v.y,z:f.v.z});const speed=f.v.speed;
  assert(f.game.vehicles.enter(f.replacement,'v'));assert.equal(f.v.speed,speed);assert.equal(f.v.engineOn,true);
  assert.equal(f.game.vehicles.lastDrivers.has('v'),false,'new driver replaces recent momentum credit');
}

// Unoccupied coasting still stops at terrain rather than tunnelling through it.
for(const type of ['jeep','tank']) {
  const f=fixture(type);f.v.speed=VEHICLE_RULES[type].speed;assert(f.game.vehicles.exit(f.driver));
  for(let x=180;x<=220;x++)for(let y=1;y<=6;y++)f.walls.add(`${x},${y},180`);
  for(let i=0;i<300;i++)f.game.vehicles.step(1/60);
  assert(f.v.z>182&&f.v.z<200);assert.equal(f.v.speed,0);assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));
}

// Credible recent operators retain runover ownership after leaving a moving hull.
{
  const f=fixture();f.v.speed=14;assert(f.game.vehicles.exit(f.driver));
  Object.assign(f.enemy,{x:200,y:1,z:197.5,hp:5});f.game.vehicles.step(1/60);
  assert.equal(f.enemy.state,'dead');assert.equal(f.driver.kills,1);
  assert(f.game.tickEvents.some(e=>e.kind==='kill'&&e.killer==='driver'&&e.victim==='enemy'&&e.w==='vehicle'));
}
for(const invalidate of ['disconnect','expired','new-life','new-team']) {
  const f=fixture();f.v.speed=14;assert(f.game.vehicles.exit(f.driver));
  if(invalidate==='disconnect')f.game.removeClient('driver');
  if(invalidate==='expired')f.game.vehicles.contactClock+=6;
  if(invalidate==='new-life')f.driver.deaths++;
  if(invalidate==='new-team')f.game.mode.policy.setLobbyTeam(f.driver,'bravo');
  Object.assign(f.enemy,{x:200,y:1,z:197.5,hp:100});f.game.vehicles.step(1/60);
  assert.equal(f.enemy.hp,100,`${invalidate} operator cannot cause credited enemy damage`);
  assert(f.v.z<200&&f.v.speed>0,`${invalidate} detaches authority while preserving physical coast`);
  assert.equal(f.game.vehicles.lastDrivers.size,0);
}

// A round reset clears motion and prior driver credit as part of the authoritative lifecycle.
{
  const f=fixture();f.v.speed=14;assert(f.game.vehicles.exit(f.driver));
  assert.equal(f.game.vehicles.lastDrivers.size,1);f.game.vehicles.reset();
  const fresh=f.game.vehicles.vehicles.get('v');
  assert.equal(fresh.hp,VEHICLE_RULES.jeep.hp);assert.deepEqual([fresh.x,fresh.y,fresh.z],[200,1,200]);
  assert.equal(fresh.speed,0);assert.equal(fresh.yawRate,0);assert.equal(fresh.engineOn,false);
  assert.equal(f.game.vehicles.lastDrivers.size,0);assert.equal(f.game.vehicles.destructionQueue.length,0);
  assert.equal(f.driver.vehicleId,null);
}

console.log('Vehicle coasting: live release, neutral drag, bounded exit velocity, steering/track animation, terrain stops, re-entry, recent ownership and disconnect/life/team expiry passed');
