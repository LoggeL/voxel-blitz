import assert from 'node:assert/strict';
import { VehicleSystem } from '../server/sim/vehicles.js';
import { hullFootprint } from '../shared/vehicle-collision.js';
import { VEHICLE_RULES, vehicleSeatPose } from '../shared/vehicles.js';
import { createMapState, isSolidBlock } from '../shared/worlddata.js';

function fixture(type='tank', yaw=0) {
  const removed=new Set(), added=new Set();
  const p={id:'driver',state:'alive',team:'alpha',x:30.5,y:11,z:30.5,yaw,pitch:0,input:{keys:{},vehicleThrottle:0,vehicleBrake:1}};
  const world={dimensions:{sx:128,sy:40,sz:128},getBlock(x,y,z){const key=`${x},${y},${z}`;return added.has(key)|| (y>=0&&y<=10&&!removed.has(key))?3:0;}};
  const engine={entities:new Map([[p.id,p]]),world,mapMeta:{conquest:{vehicleSpawns:[{id:'v',type,team:p.team,x:p.x,y:p.y,z:p.z,yaw}]}},mode:{canFire:()=>true},killPlayer(p){p.state='dead';}};
  const system=new VehicleSystem(engine),v=system.vehicles.get('v');
  assert(system.enter(p,v.id));
  const remove=(x0,x1,z0,z1,y0=0,y1=10)=>{for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++)for(let y=y0;y<=y1;y++)removed.add(`${x},${y},${z}`);};
  return {p,world,removed,added,system,v,remove};
}

for(const type of ['tank','jeep']) for(const yaw of [0,Math.PI/4,Math.PI/2]) {
  const f=fixture(type,yaw);
  f.remove(30,31,30,31);
  assert.equal(f.system.ground(f.v.x,f.v.z,f.v.y),null,'the centre sample really has no floor');
  assert.equal(f.system.placement(f.v,f.v.x,f.v.z),11,`${type} bridges a balanced two-voxel hole at yaw ${yaw}`);
  f.p.input={keys:{},vehicleThrottle:1,vehicleBrake:0};
  for(let i=0;i<60;i++)f.system.step(1/60);
  assert(Math.hypot(f.v.x-30.5,f.v.z-30.5)>0.4,'driver can leave the bridged hole');
  assert.equal(f.v.y,11); assert(f.system.clearHull(f.v,f.v.x,f.v.y,f.v.z));
}

// All five old probes can fail while real track contact patches still support.
{
  const f=fixture('tank',Math.PI/4),hull=hullFootprint('tank',f.v.x,f.v.z,f.v.yaw);
  const old=[[f.v.x,f.v.z],...hull.corners];
  for(const [x,z] of old)f.remove(Math.floor(x),Math.floor(x),Math.floor(z),Math.floor(z));
  assert(old.every(([x,z])=>f.system.ground(x,z,f.v.y)==null));
  assert.equal(f.system.placement(f.v,f.v.x,f.v.z),11,'swept footprint contacts survive missing centre/corners');
}

// Opposite corner contact balances the chassis; a single remote corner cannot.
{
  const f=fixture(),hull=hullFootprint('tank',f.v.x,f.v.z,0);
  f.remove(25,35,25,35);
  for(const corner of [hull.corners[0],hull.corners[3]])f.added.add(`${Math.floor(corner[0])},10,${Math.floor(corner[1])}`);
  assert.equal(f.system.placement(f.v,f.v.x,f.v.z),11);
  const corner=hull.corners[3];f.added.delete(`${Math.floor(corner[0])},10,${Math.floor(corner[1])}`);
  assert.equal(f.system.placement(f.v,f.v.x,f.v.z),null,'one offset corner cannot balance the whole hull');
}

// Whole footprint support removal causes gravity and a swept landing, not a snap.
for(const type of ['tank','jeep']) {
  const f=fixture(type); f.remove(25,35,25,35,7,10);
  assert.equal(f.system.placement(f.v,f.v.x,f.v.z),null,'floor four metres below is outside the initial support scan');
  f.system.step(1/60);
  assert(f.v.y<11&&f.v.y>10.95,'first fall step is small');
  for(let i=0;i<120;i++)f.system.step(1/60);
  assert(Math.abs(f.v.y-7)<1e-6,'chassis settles on the actual intact deep floor');
  assert(f.system.clearHull(f.v,f.v.x,f.v.y,f.v.z));
  assert.equal(f.p.y,vehicleSeatPose(f.v,f.p.vehicleSeatId).y,'seated operator follows gravity at its authored seat mount');
}

// A shallow full-width crater can be left using the existing one-voxel step.
{
  const f=fixture(); f.remove(25,35,25,35,10,10);
  for(let i=0;i<90;i++)f.system.step(1/60);
  assert.equal(f.v.y,10);
  f.p.input={keys:{},vehicleThrottle:1,vehicleBrake:0};
  for(let i=0;i<240;i++)f.system.step(1/60);
  assert(f.v.z<25 && f.v.y===11,'driver exits a shallow crater through a legal step');
}

// The reported Frontier shell crater has no old samples but retains real rims.
for(const throttle of [-1,1]) {
  const f=fixture('tank',-Math.PI/2);
  Object.assign(f.v,{x:468.5,z:512.5});
  f.world.dimensions={sx:1024,sy:48,sz:1024};
  f.remove(466,470,510,514,7,10);
  assert.equal(f.system.placement(f.v,f.v.x,f.v.z),11,'opposite crater rims balance the actual starting hull');
  f.p.input={keys:{},vehicleThrottle:throttle,vehicleBrake:0};
  for(let i=0;i<120;i++)f.system.step(1/60);
  assert((throttle>0?f.v.x>470.5:f.v.x<466.5)&&f.v.y===11,'tank drives forward/reverse out of the reported crater without climbing an invented ramp');
}

// Read/write the generated Frontier road itself, using ordinary driver inputs.
// The crater site comes from mapMeta.conquest.roads (a level stretch of the
// paved axis road), never from hard-coded map coordinates.
{
  const world=createMapState('frontier'),meta=world.meta,{sx,sy,sz}=meta.dimensions;
  const top=(x,z)=>{for(let y=sy-1;y>=0;y--)if(isSolidBlock(world.getBlock(x,y,z)))return y+1;return null;};
  const level=(x0,z0)=>{
    const s=top(x0,z0);
    if(s==null)return null;
    for(let dx=-9;dx<=9;dx++)for(let dz=-3;dz<=3;dz++) {
      if(top(x0+dx,z0+dz)!==s)return null;
      for(let y=s;y<=s+4;y++)if(world.getBlock(x0+dx,y,z0+dz)!==0)return null;
    }
    return s;
  };
  const road=meta.conquest.roads.find(r=>r.kind==='paved')??meta.conquest.roads[0];
  let site=null;
  for(const [px,,pz] of road.points) {
    const x=Math.round(px),z=Math.round(pz);
    if(x<20||z<20||x>sx-20||z>sz-20||Math.hypot(x-sx/2,z-sz/2)<40)continue;
    const s=level(x,z);
    if(s!=null&&s>5){site={x,z,s};break;}
  }
  assert(site,'the paved Frontier road has a level stretch for the crater fixture');
  const {x:cx,z:cz,s:surface}=site;
  assert.notEqual(world.getBlock(cx,surface-1,cz),0,'the crater site is a real authored road floor');
  for(let x=cx-2;x<=cx+2;x++)for(let z=cz-2;z<=cz+2;z++)for(let y=surface-4;y<=surface-1;y++)world.setBlock(x,y,z,0);
  for(const throttle of [-1,1]) {
    const p={id:'driver',state:'alive',team:'alpha',x:cx+0.5,y:surface,z:cz+0.5,yaw:-Math.PI/2,pitch:0,input:{keys:{},vehicleThrottle:throttle,vehicleBrake:0}};
    const engine={entities:new Map([[p.id,p]]),world,mapMeta:{conquest:{vehicleSpawns:[{id:'crater-tank',type:'tank',team:p.team,x:p.x,y:p.y,z:p.z,yaw:p.yaw}]}},mode:{canFire:()=>true}};
    const system=new VehicleSystem(engine),v=system.vehicles.get('crater-tank');
    assert(system.enter(p,v.id));
    assert.equal(system.ground(v.x,v.z,v.y),null,'the actual destroyed road has no centre support within three metres');
    assert.equal(system.placement(v,v.x,v.z),surface,'the crater rims carry the tank at road level');
    for(let i=0;i<120;i++)system.step(1/60);
    assert((v.x-(cx+0.5))*throttle>4,'normal forward/reverse inputs leave the real Frontier crater');
    assert.equal(v.y,surface);assert(system.clearHull(v,v.x,v.y,v.z));
  }
}

// Air cannot provide support; void falls destroy the chassis, and walls/bounds stay solid.
{
  const f=fixture();f.remove(0,127,0,127);
  assert.equal(f.system.placement(f.v,f.v.x,f.v.z),null);
  for(let i=0;i<180;i++)f.system.step(1/60);
  assert.equal(f.v.hp,0,'fully unsupported chassis falls out rather than floating');
  assert.equal(f.p.state,'dead');
}
{
  const f=fixture();
  assert.equal(f.system.placement(f.v,0.5,30),null);
  for(let x=25;x<=35;x++)for(let y=11;y<=15;y++)f.added.add(`${x},${y},26`);
  f.p.input={keys:{},vehicleThrottle:1,vehicleBrake:0};
  for(let i=0;i<120;i++)f.system.step(1/60);
  assert(f.v.z>=28.6 && f.v.y===11,'support scan cannot convert a tall wall into a ramp');
  assert(f.system.clearHull(f.v,f.v.x,f.v.y,f.v.z));
}
{
  const f=fixture();f.remove(25,29,25,35,5,10);
  assert.equal(f.system.placement(f.v,29.95,30.5),null,'six-metre floor disparity cannot become a supported flat slope');
}

console.log('Vehicle support: rotated two-voxel bridges, real track patches, balanced contacts, swept gravity/deep-floor landing, shallow crater recovery, Frontier crater, void, bounds and walls passed');
