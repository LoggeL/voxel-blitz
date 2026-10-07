import assert from 'node:assert/strict';
import { Input } from '../public/js/engine/input.js';
import { VehicleController } from '../public/js/session/vehicle-controller.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { ConquestPolicy } from '../server/modes/conquest.js';
import { MODE_RULES } from '../shared/modes.js';
import { createStateApi } from '../shared/world/state.js';
import { AIR, METAL } from '../shared/world/blocks.js';
import { GameEngine } from '../server/game.js';

// The device bridge must distinguish intentional descent from automatic sprint.
const input = new Input({});
input.fallback = true;
try {
  input._onTouchMove({x:0,y:-1,magnitude:1});
  assert.equal(input.getKeys().forward,true);
  assert.equal(input.getKeys().flightDown,false,'full forward joystick never descends the aircraft');
  input._onTouchHold('flightUp',true);
  assert.equal(input.getKeys().flightUp,true);
  input._onTouchHold('flightUp',false);
  input._onTouchHold('flightDown',true);
  assert.equal(input.getKeys().flightDown,true);
  input._onTouchHold('flightBrake',true);
  assert.equal(input.getKeys().flightBrake,true);
  input.clearTransient();
  assert.equal(input.getKeys().flightDown,false);
  assert.equal(input.getKeys().flightBrake,false);
  input._padAds=true;
  assert.equal(input.getKeys().flightDown,true,'left gamepad trigger deliberately descends');
  input._padAds=false;
  input.keys.jump=true;
  input.keys.sprint=true;
  assert.equal(input.getKeys().flightUp,true,'keyboard Space reaches lift');
  assert.equal(input.getKeys().flightDown,true,'keyboard Shift reaches descent');
  input.clearTransient();
  input.keys.leanRight=true;
  assert.equal(input.getKeys().flightYawRight,true,'keyboard E reaches rudder/pedal');
  input.keys.leanRight=false;
  input.keys.leanLeft=true;
  assert.equal(input.getKeys().flightYawLeft,true,'keyboard Q reaches rudder/pedal');
  input.clearTransient();
  const controller=new VehicleController({eventTarget:null});
  controller.sync({self:{id:'pilot',state:'alive',vehicleId:'plane'},enabled:true,
    vehicles:[{id:'plane',type:'plane',hp:450,occupantId:'pilot',yaw:.2,pitch:.1}]});
  const pad={id:'flight-pad',mapping:'standard',connected:true,axes:[0,-1,.6,-.5],buttons:[]};
  let connected=true;
  input._pad.navigator={getGamepads:()=>connected?[pad]:[]};
  const axes=['vehiclePitchControl','vehicleRollControl','vehicleYawControl'];
  const commands=[];
  for(const dt of [1/30,1/60,1/144]) {
    input.poll(1000,dt);
    commands.push(controller.controls(input.getKeys(),input.consumeDelta(),false,dt));
  }
  assert(commands.every(command=>command.vehiclePitchControl>0&&command.vehicleRollControl>0));
  assert(commands.every(command=>command.vehicleThrottle===1&&command.vehicleLift===0),'pad full forward does not apply descent');
  for(const axis of axes)assert(Math.max(...commands.map(row=>row[axis]))-Math.min(...commands.map(row=>row[axis]))<1e-12,'held pad axis is frame rate independent');
  pad.axes=[0,0,.04,-.03];input.poll(1010,1/60);
  let command=controller.controls(input.getKeys(),input.consumeDelta());
  for(const axis of axes)assert.equal(command[axis],0,'pad deadzone returns explicit neutral');
  connected=false;input.poll(1020,1/60);
  command=controller.controls(input.getKeys(),input.consumeDelta());
  for(const axis of axes)assert.equal(command[axis],0,'disconnect cannot keep a stale flight command');
  input._onTouchLook(3,-3);
  command=controller.controls(input.getKeys(),input.consumeDelta());
  assert(command.vehiclePitchControl>0&&command.vehicleRollControl>0,'touch drag raises nose and banks right');
  input.invertY=true;input._onTouchLook(0,-3);
  assert(controller.controls(input.getKeys(),input.consumeDelta()).vehiclePitchControl<0,'flight stick respects inverted vertical input');
  input.clearTransient();
  for(const axis of axes)assert.equal(controller.controls(input.getKeys(),input.consumeDelta())[axis],0);
  controller.dispose();
} finally { input.dispose(); }

const net = new NetClient(), sent=[];
net.ws={readyState:1,send:frame=>sent.push(JSON.parse(frame))};
for (const lift of [-2,2,NaN,Infinity]) net.sendInput({keys:{},vehicleLift:lift});
assert.equal(sent[0].vehicleLift,-1);
assert.equal(sent[1].vehicleLift,1);
assert(!('vehicleLift' in sent[2]));
assert(!('vehicleLift' in sent[3]));
const manualAxes=['vehiclePitchControl','vehicleRollControl','vehicleYawControl'];
for(const value of [-2,0,2]) {
  net.sendInput({keys:{},vehiclePitchControl:value,vehicleRollControl:-value,vehicleYawControl:value});
  const frame=sent.at(-1);
  for(const field of manualAxes)assert(Object.hasOwn(frame,field),'manual flight axes travel as a complete vector including neutral');
  assert.equal(frame.vehiclePitchControl,Math.max(-1,Math.min(1,value)));
  assert.equal(frame.vehicleRollControl,value===0?0:Math.max(-1,Math.min(1,-value)));
  assert.equal(frame.vehicleYawControl,Math.max(-1,Math.min(1,value)));
}
net.sendInput({keys:{},vehiclePitchControl:NaN,vehicleRollControl:Infinity,vehicleYawControl:-Infinity});
for(const field of manualAxes)assert.equal(sent.at(-1)[field],0,'malformed explicit axes remain manual neutral');
net.sendInput({keys:{}});
for(const field of manualAxes)assert(!Object.hasOwn(sent.at(-1),field),'legacy inputs keep axes absent');
net.id='pilot';
const vehicle={id:'aircraft',type:'helicopter',x:40,y:50,z:40,yaw:.2,pitch:.1,roll:-.3,
  vx:3,vy:2,vz:-4,speed:5,rotorSpeed:.9,collective:.8,grounded:false,hp:550,occupantId:'pilot'};
net._onTick({now:1000,players:[{id:'pilot',state:'alive',vehicleId:vehicle.id}],vehicles:[vehicle],match:{mode:'conquest'}});
const received=net.latestSnapshots.at(-1).vehicles[0];
for (const field of ['pitch','roll','vx','vy','vz','rotorSpeed','collective','grounded']) {
  assert.equal(received[field],vehicle[field],`${field} survives authoritative delivery`);
}
assert(Object.isFrozen(received));

// Low hover is still airborne even inside the flag's existing vertical range.
for (const type of ['helicopter','plane']) {
  let now=0;
  const pilot={id:'pilot',state:'alive',weapon:0,grenades:[]};
  const entities=new Map([[pilot.id,pilot]]);
  const hull={id:'aircraft',type,grounded:false};
  const policy=new ConquestPolicy({rules:MODE_RULES.conquest,now:()=>now,entities,
    vehicleFor:id=>id===hull.id?hull:null,emit:()=>{},chooseSpawn:pool=>pool[0],
    respawn:(p,s)=>Object.assign(p,s,{state:'alive'}),
    mapMeta:{id:'frontier',conquest:{flags:[{id:'B',x:40,y:11,z:40,radius:24}],bases:{}},
      spawns:{conquest:{alpha:[{x:40,y:11,z:40}],bravo:[{x:100,y:11,z:100}]}}}});
  policy.onPlayerAdd(pilot);
  Object.assign(pilot,{team:'alpha',vehicleId:hull.id,x:40,y:12.7,z:40});
  now=10000;policy.tick();
  assert.equal(policy.flags[0].owner,null,`${type} cannot capture while hovering or flying`);
  hull.grounded=true;
  now+=10000;policy.tick();
  assert.equal(policy.flags[0].owner,'alpha',`${type} can capture after a real landing`);
}
console.log('Aircraft device bridge, signed network lift, flight snapshot fields and grounded capture checks passed.');

// Ejected players share the terrain API on client and server. Sky inside the
// map is air, but horizontal map boundaries remain solid above voxel height.
{
  const dimensions={sx:128,sy:32,sz:128},spawn={x:2,y:2,z:64};
  const blocks=new Uint8Array(128*32*128);blocks.fill(METAL,0,128*128*2);
  const world=createStateApi(blocks,new Uint8Array(128*128).fill(1),[spawn],'frontier',null,dimensions);
  assert.equal(world.getBlock(1,80,64),AIR);
  assert.equal(world.getBlock(-1,80,64),METAL);
  assert.equal(world.getBlock(128,80,64),METAL);
  const game=new GameEngine({mode:'conquest',world,mapMeta:{id:'frontier',dimensions,
    spawns:{conquest:{alpha:[spawn],bravo:[spawn]}},conquest:{flags:[],bases:{},vehicleSpawns:[]}}});
  game.addClient('ejected','Ejected');
  const p=game.entities.get('ejected');
  Object.assign(p,{x:1.5,y:80,z:64,vx:0,vy:0,vz:0,grounded:false});
  game.applyInput(p.id,{seq:1,keys:{l:true},yaw:0,pitch:0});
  for(let i=0;i<300;i++)game.step();
  assert(p.x>=0.3,'ejected pilot cannot leave the map in the sky');
  assert(p.y<32,'ejected pilot falls into the real world, not an exterior sky shelf');
}
console.log('Ejected-player sky boundary and ordinary-gravity authority checks passed.');
