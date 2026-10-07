import assert from 'node:assert/strict';
import { VehicleSystem } from '../server/sim/vehicles.js';
import { hullFootprint, footprintsOverlap } from '../shared/vehicle-collision.js';
function fixture(type='tank', x=20.2, z=20.2) {
  const walls = new Set();
  const p={id:'p',state:'alive',team:0,x,y:1,z,input:{keys:{},vehicleSteer:1},yaw:0,pitch:0};
  const engine={entities:new Map([['p',p]]), world:{dimensions:{sx:1024,sy:30,sz:1024},getBlock(x,y,z){return y===0||walls.has(`${x},${y},${z}`)?3:0;}},mapMeta:{conquest:{vehicleSpawns:[{id:'v',type,team:0,x,y:1,z,yaw:0}]}},mode:{canFire:()=>true}};
  const system=new VehicleSystem(engine), v=system.vehicles.get('v');
  return {walls,p,engine,system,v};
}
{
  const {walls,system,v}=fixture(); v.yaw=Math.PI/4;
  walls.add('23,1,20');
  assert.equal(system.clearHull(v,v.x,v.y,v.z),false,'rotated tank corner beyond old radius intersects wall at fractional center');
  walls.clear();assert.equal(system.clearHull(v,v.x,v.y,v.z),true);
}
{
  const {walls,system,v}=fixture('tank',20,20);
  for(let z=15;z<=25;z++) { walls.add(`17,1,${z}`);walls.add(`22,1,${z}`); }
  assert.equal(system.placement(v,20,20),1,'axis aligned tank fits four metre gap');
  v.yaw=Math.PI/4; assert.equal(system.clearHull(v,20,1,20),false);
}
{
  const {walls,p,system,v}=fixture('tank',20.01,20);
  for(let z=15;z<=25;z++)walls.add(`22,1,${z}`);
  assert.equal(system.enter(p,'v'),true);
  for(let i=0;i<180;i++)system.step(1/60);
  assert.ok(v.yaw<0.03,'blocked stationary pivot cannot rotate through wall');
  assert.equal(v.speed,0);assert.equal(system.clearHull(v,v.x,v.y,v.z),true);
}
{
  const {walls,system,v}=fixture('tank',900.2,900.2);v.yaw=Math.PI/4;walls.add('903,1,900');
  assert.equal(system.clearHull(v,v.x,v.y,v.z),false,'large coordinates retain corner precision');
  walls.clear();assert.equal(system.placement(v,v.x,v.z),1);
  assert.equal(system.placement(v,1023,900),null,'hull cannot cross bounds');
  system.engine.world.getBlock=()=>0;assert.equal(system.placement(v,900,900),null,'void has no artificial ground');
}
{
  const {walls,system,v}=fixture('jeep',20,20);
  for(let x=18;x<=22;x++)for(let z=17;z<=23;z++)walls.add(`${x},1,${z}`);
  assert.equal(system.placement(v,20,20),2,'Jeep retains one voxel step clearance');
  assert.equal(system.placement(v,0.5,20),null);
  walls.clear();assert.equal(system.placement(v,20,20),1,'Jeep can return to valid ground');
}
{
  const a=hullFootprint('tank',20,20,Math.PI/4), b=hullFootprint('jeep',21,20,0);
  assert.equal(footprintsOverlap(a,b),true);
  const {system,v}=fixture(); v.yaw=Math.PI/4;
  system.vehicles.set('other',{id:'other',type:'jeep',hp:260,x:21,y:1,z:20,yaw:0});
  assert.equal(system.clearHull(v,v.x,v.y,v.z),false,'vehicle footprints cannot overlap');
  assert.equal(footprintsOverlap(a,hullFootprint('jeep',30,20,0)),false);
}
console.log('Vehicle collision: oriented corners, clearance, pivot, terrain, bounds and vehicle separation passed');
