import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { fireOneShot } from '../server/sim/combat.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';
import { WEAPON_IDS } from '../shared/combatmath.js';

function fixture(type='jeep', extraSpawns=[]) {
  const walls=new Set(), frames=[], blockWrites=[];
  const dimensions={sx:512,sy:64,sz:512};
  const world={dimensions,getBlock:(x,y,z)=>y===0||walls.has(`${x},${y},${z}`)?3:0,
    findSpawns:()=>[{x:300,y:1,z:300}],setBlock(...args){blockWrites.push(args);return true;}};
  const game=new GameEngine({mode:'conquest',world,mapMeta:{id:'frontier',dimensions,
    spawns:{conquest:{alpha:[{x:300,y:1,z:300}],bravo:[{x:350,y:1,z:300}]}},
    conquest:{flags:[],bases:{},vehicleSpawns:[{id:'v',type,team:'alpha',x:100,y:1,z:100,yaw:0},...extraSpawns]}},
    broadcast:frame=>frames.push(frame)});
  for(const id of ['driver','attacker','victim','ally'])game.addClient(id,id);
  const [driver,attacker,victim,ally]=['driver','attacker','victim','ally'].map(id=>game.entities.get(id));
  for(const p of [driver,attacker,victim,ally])Object.assign(p,{x:300,y:1,z:300,hp:100,armor:0,spawnProtectedUntil:0,input:{keys:{},yaw:0,pitch:0}});
  assert.equal(driver.team,victim.team);assert.equal(attacker.team,ally.team);
  const v=game.vehicles.vehicles.get('v');
  const seat=()=>{Object.assign(driver,{x:v.x,y:v.y,z:v.z});assert(game.vehicles.enter(driver,v.id));};
  const events=()=>[...frames.flatMap(frame=>frame.events||[]),...game.tickEvents];
  const destructions=()=>events().filter(e=>e.kind==='vehicle_destroyed');
  const blasts=()=>events().filter(e=>e.kind==='explosion'&&e.type==='vehicle');
  return {game,walls,blockWrites,v,driver,attacker,victim,ally,seat,events,destructions,blasts};
}

// Real hitscan lethality detonates once and credits the seated crew correctly.
{
  const f=fixture();f.seat();f.v.hp=1;
  Object.assign(f.attacker,{x:100,y:1,z:120,yaw:0,pitch:0,weapon:WEAPON_IDS.indexOf('rifle')});
  fireOneShot(f.attacker,f.game.contexts.combat,1,{yaw:0,pitch:0});
  assert.equal(f.v.hp,0);assert.equal(f.driver.state,'dead');assert.equal(f.driver.vehicleId,null);
  assert.equal(f.v.occupantId,null);assert.equal(f.attacker.kills,1);
  assert(f.events().some(e=>e.kind==='kill'&&e.killer==='attacker'&&e.victim==='driver'&&e.w==='vehicle'));
  assert.equal(f.destructions().length,1);assert.equal(f.blasts().length,1);
  const destroyed=f.destructions()[0];
  assert.equal(destroyed.type,'jeep');assert.equal(destroyed.attacker,'attacker');assert.deepEqual(destroyed.assists,[]);assert.equal(destroyed.crewKilled,1);
  assert.equal(f.game.vehicles.damage(f.v.id,1000,f.attacker,{explosive:true}),false);
  assert.equal(f.destructions().length,1);assert.equal(f.blasts().length,1);
}

// Actual rocket flight and blast enter the same lethal vehicle route.
{
  const f=fixture();f.seat();f.v.hp=15;
  Object.assign(f.attacker,{x:100,y:1,z:118,yaw:0,pitch:0});
  const rocket=f.game.projectiles.launchRocket(f.attacker,f.game.contexts.projectiles,{x:0,y:0,z:-1});assert(rocket);
  for(let i=0;i<45&&f.v.hp>0;i++)f.game.projectiles.step(1/60,f.game.contexts.projectiles);
  assert.equal(f.v.hp,0);assert.equal(f.attacker.kills,1);
  assert.equal(f.destructions().length,1);assert.equal(f.blasts().length,1);
  assert(f.events().some(e=>e.kind==='projectileExplode'&&e.type==='rocket'));
}

// A severe physical ground impact destroys the real chassis without crossing a wall.
{
  const f=fixture();f.seat();Object.assign(f.v,{z:104,speed:24,hp:10});
  f.driver.input={keys:{},vehicleThrottle:1,vehicleSteer:0,vehicleBrake:0,yaw:0,pitch:0};
  for(let x=90;x<=110;x++)for(let y=1;y<=6;y++)f.walls.add(`${x},${y},100`);
  for(let i=0;i<90&&f.v.hp>0;i++)f.game.vehicles.step(1/60);
  assert.equal(f.v.hp,0);assert(f.v.z>102,'sweep retains the safe side of the wall');
  assert.equal(f.driver.state,'dead');assert.equal(f.driver.kills,0,'driver crash is a self death');
  assert.equal(f.destructions().length,1);assert.equal(f.blasts().length,1);
  assert(f.destructions()[0].velocity[2]<-20,'destruction retains preimpact velocity for debris');
}

// Cover survives and protects infantry and a second vehicle; attacker allies and spawn protection apply.
{
  const f=fixture('tank',[{id:'covered',type:'jeep',team:'alpha',x:110,y:1,z:100,yaw:0}]);f.seat();
  Object.assign(f.victim,{x:108,y:1,z:100});Object.assign(f.ally,{x:103,y:1,z:100});
  for(let z=85;z<=115;z++)for(let y=1;y<=8;y++)f.walls.add(`105,${y},${z}`);
  f.game.vehicles.damage(f.v.id,10000,f.attacker,{explosive:true});
  assert.equal(f.victim.hp,100);assert.equal(f.ally.hp,100);assert.equal(f.game.vehicles.vehicles.get('covered').hp,VEHICLE_RULES.jeep.hp);
  assert.equal(f.destructions().length,1);assert(f.walls.has('105,2,100'));
}
{
  const f=fixture('tank');f.seat();Object.assign(f.victim,{x:104,y:1,z:100,hp:5});
  Object.assign(f.ally,{x:103,y:1,z:100});
  f.game.vehicles.damage(f.v.id,10000,f.attacker,{explosive:true});
  assert.equal(f.victim.state,'dead');assert.equal(f.ally.hp,100);assert.equal(f.attacker.kills,2);
  assert.equal(f.events().filter(e=>e.kind==='kill'&&e.victim==='driver').length,1,'dead crew is never damaged twice');
}
{
  const f=fixture();Object.assign(f.victim,{x:103,y:1,z:100,spawnProtectedUntil:f.game.now+5000});
  f.game.vehicles.damage(f.v.id,10000,f.attacker,{explosive:true});assert.equal(f.victim.hp,100);
}

// A finite queue preserves original attacker credit through secondary wrecks.
{
  const spawns=Array.from({length:23},(_,i)=>({id:`chain${i}`,type:'jeep',team:'alpha',x:105+i*5,y:1,z:100,yaw:0}));
  spawns.push({id:'friendly',type:'jeep',team:'bravo',x:100,y:1,z:105,yaw:0});
  const f=fixture('jeep',spawns);f.seat();for(const v of f.game.vehicles.vehicles.values())v.hp=1;
  Object.assign(f.victim,{x:105,y:1,z:100});assert(f.game.vehicles.enter(f.victim,'chain0'));
  f.game.vehicles.damage('v',100,f.attacker,{explosive:true});
  assert.equal(f.destructions().length,24);assert.equal(f.blasts().length,24);
  assert.equal(new Set(f.destructions().map(e=>e.vehicleId)).size,24);
  assert(f.destructions().every(e=>e.attacker==='attacker'));
  assert.equal(f.game.vehicles.vehicles.get('friendly').hp,1);assert.equal(f.attacker.kills,2);
  assert.equal(f.game.vehicles.destructionQueue.length,0);assert.equal(f.game.vehicles.detonating,false);
  assert.equal(f.blockWrites.length,0,'wreck chain preserves all terrain cover');
}

// A true environmental blast has no invented enemy owner and protects its team's nearby bodies/hulls.
{
  const f=fixture();f.seat();Object.assign(f.ally,{x:103,y:1,z:100,hp:5});
  f.game.vehicles.explosion([100,2,100],7,10000,null);
  assert.equal(f.driver.state,'dead');assert.equal(f.ally.state,'dead');
  assert.equal(f.destructions()[0].attacker,null,'ownerless external splash cannot adopt its victim driver as attacker');
  assert.equal(f.events().find(e=>e.kind==='kill'&&e.victim==='ally').killer,'');
  assert.equal(f.driver.kills,0);
}
for(const crewState of ['on-foot','seated','recently-exited']) {
  const f=fixture('jeep',[{id:'same',type:'jeep',team:'alpha',x:105,y:1,z:100,yaw:0},
    {id:'hostile',type:'jeep',team:'bravo',x:100,y:1,z:105,yaw:0}]);
  Object.assign(f.victim,{x:103,y:1,z:100,hp:5});Object.assign(f.ally,{x:100,y:1,z:103,hp:5});
  if(crewState!=='on-foot') {
    assert(f.game.vehicles.enter(f.ally,'hostile'));
    if(crewState==='recently-exited')assert(f.game.vehicles.exit(f.ally));
  }
  f.game.vehicles.vehicles.get('hostile').hp=1;f.game.vehicles.damage('v',10000,null,{explosive:true});
  assert.equal(f.victim.hp,5);assert.equal(f.ally.state,'dead');assert.equal(f.game.vehicles.vehicles.get('same').hp,VEHICLE_RULES.jeep.hp);
  assert.equal(f.game.vehicles.vehicles.get('hostile').hp,0);
  assert.equal(f.events().find(e=>e.kind==='kill'&&e.victim==='ally').killer,'');
  assert(f.destructions().every(e=>e.attacker===null),`${crewState} secondary driver cannot adopt environmental chain ownership`);
}

// Air wrecks retain physical motion, fall under gravity, settle safely and respawn with a fresh engine state.
for(const type of ['helicopter','plane']) {
  const f=fixture(type);f.seat();Object.assign(f.v,{y:60,vx:3,vy:2,vz:-5,speed:6,pitch:.2,roll:.1,grounded:false,rotorSpeed:1,enginePower:1,throttle:1});
  f.game.vehicles.damage('v',10000,f.attacker,{explosive:true});
  assert.deepEqual([f.v.vx,f.v.vy,f.v.vz],[3,2,-5]);assert.equal(f.v.pitch,.2);assert.equal(f.v.engineOn,false);
  for(const field of ['throttle','enginePower','rotorSpeed','collective','pitchRate','rollRate','rudderRate'])assert.equal(f.v[field],0);
  for(let i=0;i<240;i++)f.game.vehicles.step(1/120);
  assert(f.v.y<48&&f.v.x>105,'wreck travels ballistically and falls from the actual altitude');
  for(let i=0;i<720;i++)f.game.vehicles.step(1/120);
  assert(f.v.y<5&&f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z),'wreck lands without penetrating terrain');
  assert.equal(f.destructions().length,1);assert.equal(f.blasts().length,1);
  f.v.respawnIn=0;f.game.vehicles.step(1/60);
  assert.equal(f.v.hp,VEHICLE_RULES[type].hp);assert.deepEqual([f.v.x,f.v.y,f.v.z],[100,1,100]);
  for(const field of ['vx','vy','vz','pitch','roll','pitchRate','rollRate','rudderRate','throttle','enginePower','rotorSpeed','wreckAge'])assert.equal(Math.abs(f.v[field]),0);
  assert.equal(f.v.occupantId,null);assert.equal(f.v.engineOn,false);
}

// Ground wrecks keep gravity: a hull killed mid-fall, or whose support is
// removed after death, drops to the ground instead of hanging solid in the air.
{
  const f=fixture();Object.assign(f.v,{y:15});
  for(let i=0;i<5;i++)f.game.vehicles.step(1/60);
  assert(f.v.y<15&&f.v.y>13,'the live jeep is falling');
  f.game.vehicles.damage(f.v.id,5000,f.attacker,{cls:'at'});
  assert.equal(f.v.hp,0);
  const deathY=f.v.y;
  for(let i=0;i<120;i++)f.game.vehicles.step(1/60);
  assert(Math.abs(f.v.y-1)<1e-6,`the wreck lands on the ground (${f.v.y})`);
  assert.equal(f.game.vehicles.rayHit([f.v.x-10,deathY+1,f.v.z],[1,0,0],20),null,'no solid wreck remains at the death height');
  assert.equal(f.game.vehicles.rayHit([f.v.x-10,2,f.v.z],[1,0,0],20)?.id,f.v.id,'the landed wreck is still a solid obstacle');
}
{
  const f=fixture();
  for(let x=95;x<=105;x++)for(let z=95;z<=105;z++)for(let y=1;y<=3;y++)f.walls.add(`${x},${y},${z}`);
  Object.assign(f.v,{y:4});
  f.game.vehicles.step(1/60);assert.equal(f.v.y,4,'the jeep rests on the platform');
  f.game.vehicles.damage(f.v.id,5000,f.attacker,{cls:'at'});
  for(let i=0;i<30;i++)f.game.vehicles.step(1/60);
  assert.equal(f.v.y,4,'a resting wreck stays on its support');
  for(const key of [...f.walls])f.walls.delete(key);f.game.blockRevision++;
  for(let i=0;i<120;i++)f.game.vehicles.step(1/60);
  assert(Math.abs(f.v.y-1)<1e-6,`a wreck whose support was destroyed falls into the crater (${f.v.y})`);
}

console.log('Vehicle destruction: actual bullets/rockets/crash, crew ownership, one-shot events, splash cover/team/protection, finite chains, environmental credit and ballistic air wreck respawn passed');
