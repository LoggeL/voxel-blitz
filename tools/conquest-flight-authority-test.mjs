import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';
import { vehicleHullParts } from '../shared/vehicle-collision.js';
import { createMapState, getMapMeta } from '../shared/world/templates.js';

function fixture(type='plane') {
  const dimensions={sx:1024,sy:32,sz:1024},walls=new Set();
  const world={dimensions,getBlock:(x,y,z)=>walls.has(`${x},${y},${z}`)||y===0?3:0,
    findSpawns:()=>[{x:450,y:1,z:870}],setBlock:()=>true};
  const game=new GameEngine({mode:'conquest',world,mapMeta:{id:'frontier',dimensions,
    spawns:{conquest:{alpha:[{x:450,y:1,z:870}],bravo:[{x:750,y:1,z:850}]}},
    conquest:{flags:[],bases:{},vehicleSpawns:[{id:'air',team:'alpha',type,x:450,y:1,z:850,yaw:0}]}}});
  game.addClient('pilot','Pilot');
  const p=game.entities.get('pilot'),v=game.vehicles.vehicles.get('air');
  Object.assign(p,{x:v.x+5,y:1,z:v.z});
  game.applyInput(p.id,{keys:{},vehicleAction:{type:'enter',vehicleId:v.id}});
  assert.equal(p.vehicleId,v.id);
  const input=payload=>game.applyInput(p.id,{keys:{},yaw:0,pitch:0,...payload});
  const fly=(seconds,observe=()=>{})=>{for(let i=0;i<Math.round(seconds*60);i++){game.vehicles.step(1/60);observe();}};
  const airborne=(extra={})=>Object.assign(v,{x:450,y:90,z:650,yaw:0,pitch:0,roll:0,grounded:false,
    vx:0,vy:0,vz:type==='plane'?-50:0,speed:type==='plane'?50:0,airspeed:type==='plane'?50:0,
    enginePower:1,throttle:1,rotorSpeed:1,pitchRate:0,rollRate:0,rudderRate:0,yawRate:0,...extra});
  return {game,p,v,walls,input,fly,airborne};
}

const neutral={vehiclePitchControl:0,vehicleRollControl:0,vehicleYawControl:0};
for(const type of ['plane','helicopter']) {
  const f=fixture(type);
  for(const field of Object.keys(neutral)) {
    f.input({[field]:99});assert.equal(f.p.input[field],1);
    f.input({[field]:-99});assert.equal(f.p.input[field],-1);
    f.input({[field]:0});assert.equal(f.p.input[field],0);
    for(const value of [NaN,Infinity,-Infinity,null,'right']) {
      f.input({[field]:value});assert.equal(f.p.input[field],0,'explicit invalid axis is manual neutral');
    }
    f.input({});assert.equal(f.p.input[field],undefined,'omitted axis preserves the legacy controller');
  }
  f.airborne();f.input({...neutral,yaw:2,pitch:.5,vehicleSteer:1});f.fly(.1);
  assert.equal(f.v.pitch,0,'explicit zero suppresses legacy desired pitch');
  assert.equal(f.v.roll,0,'explicit zero suppresses legacy steer');
  assert.equal(f.v.yaw,0,'explicit zero suppresses legacy desired heading');
  f.input({...neutral,vehiclePitchControl:1,vehicleRollControl:1,vehicleYawControl:1});f.fly(.2);
  assert(f.v.pitch>0,'positive elevator raises the authoritative nose');
  assert(f.v.roll<0,'positive aileron/cyclic banks the authoritative hull right');
  assert(f.v.yaw<0,'positive rudder turns the authoritative heading right');
  const r=VEHICLE_RULES[type];
  assert(Math.abs(f.v.pitchRate)<=r.pitchRate+1e-9);
  assert(Math.abs(f.v.rollRate)<=(r.bankRate??r.rollRate)+1e-9);
  assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));
}

{
  const f=fixture('plane');f.airborne({roll:-.35});
  f.input({...neutral});f.fly(.6);
  assert(Math.abs(f.v.roll+.35)<1e-9,'released aileron retains the real bank');
  assert(f.v.yaw<-.025,'held bank turns through real wing lift after control release');
}

// Endpoint clearance alone misses a tail sweeping through this single voxel.
{
  const f=fixture('helicopter');
  f.airborne({x:450,y:20,z:600.3,yawRate:1.1,collective:9.81/18.81});
  f.walls.add('449,21,604');
  assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));
  f.v.yaw=.1375;assert(!f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));
  f.v.yaw=.275;assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));f.v.yaw=0;
  f.game.vehicles.advanceAircraft(f.v,f.p,{keys:{},yaw:2,pitch:0},{allowed:true,throttle:0,steer:0,brake:0},.25);
  assert(f.v.yaw<.1375,'compound hull sweep stops at the first angular contact');
  assert.equal(f.v.yawRate,0);assert.equal(f.v.pitchRate,0);assert.equal(f.v.rollRate,0);
  assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));
  assert.equal(f.v.hp,VEHICLE_RULES.helicopter.hp,'a stationary attitude contact is not a high-speed crash');
}

// Ground rotation pivots on the actual rear wheel support at every sample.
{
  const f=fixture('plane');
  Object.assign(f.v,{speed:30,airspeed:30,vz:-30,throttle:1,enginePower:1});
  f.input({...neutral,vehiclePitchControl:1});
  f.fly(.3,()=>assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z)));
  assert(f.v.pitch>.05&&f.v.y>1,'nose rotation raises the root above the transformed tires');
  assert.equal(f.v.hp,VEHICLE_RULES.plane.hp);
}

// Automatic deployment cannot add a wheel/strut inside adjacent terrain.
{
  const f=fixture('plane');
  f.airborne({x:500,y:4.5,z:500,gearDown:false,vx:0,vy:0,vz:0,speed:0,airspeed:0,
    enginePower:.5,throttle:.5});
  f.walls.add('501,4,501');
  f.input({...neutral});
  assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z),'stowed jet clears the side obstacle');
  f.fly(1/60);
  assert.equal(f.v.gearDown,false,'blocked automatic gear deployment is deferred');
  assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z),'deferred deployment leaves a legal compound hull');
  assert.equal(f.v.hp,VEHICLE_RULES.plane.hp);
  f.walls.delete('501,4,501');f.fly(1/60);
  assert.equal(f.v.gearDown,true,'automatic deployment resumes when its boxes fit');
  assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));
}

// The ordinary control route must retain horizontal flight at ceiling contact.
{
  const f=fixture('plane'),tick=()=>f.game.step(1000/60);
  f.input({...neutral,vehicleThrottle:1,vehicleLift:1});
  for(let i=0;i<300;i++)tick();
  assert(f.v.y>10&&!f.v.grounded,'ordinary W and Space take off');
  f.input({...neutral});
  let touched=false;
  for(let i=0;i<3600;i++) {
    const before={x:f.v.x,z:f.v.z};tick();
    const top=Math.max(...vehicleHullParts(f.v).map(part=>part.maxY));
    assert(top<=180+1e-7,'the actual banked hull remains under the ceiling');
    assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));
    if(top>179.9) {
      touched=true;
      assert(Math.hypot(f.v.x-before.x,f.v.z-before.z)>.05,'ceiling contact preserves tangential aircraft movement');
      assert(Math.abs(f.v.speed-Math.hypot(f.v.vx,f.v.vy,f.v.vz))<1e-6,'reported speed matches the constrained velocity');
    }
    if(touched&&i>900)break;
  }
  assert(touched,'normal takeoff and released controls reach physical ceiling contact');
  const ceilingY=f.v.y,pitch=f.v.pitch;
  f.input({...neutral,vehicleLift:-1});
  for(let i=0;i<210;i++)tick();
  assert(f.v.y<ceilingY-1||f.v.pitch<pitch-.1,'Shift permits a descending or nose-down escape');
  assert.equal(f.v.hp,VEHICLE_RULES.plane.hp);
  assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));
}

// Also exercise the banked contact pose captured in the live browser failure.
{
  const f=fixture('plane');
  f.airborne({x:180.3965,y:175.7671737,z:168.8893,yaw:-.260955,pitch:.649999994,
    roll:-1.077188,vx:23.98,vy:0,vz:-41.27,speed:47.73,airspeed:47.73});
  const top=Math.max(...vehicleHullParts(f.v).map(part=>part.maxY));
  f.v.y+=180-1e-8-top;
  f.input({...neutral,vehicleLift:-1});
  const before={x:f.v.x,y:f.v.y,z:f.v.z};
  for(let i=0;i<210;i++) {
    f.game.step(1000/60);
    assert(Math.max(...vehicleHullParts(f.v).map(part=>part.maxY))<=180+1e-7);
    assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));
  }
  assert(Math.hypot(f.v.x-before.x,f.v.z-before.z)>10,'ceiling projection retains horizontal travel');
  assert(f.v.y<before.y-1||f.v.pitch<.55,'the captured ceiling pose can descend or lower the nose');
  assert.equal(f.v.hp,VEHICLE_RULES.plane.hp);
}

for(const type of ['helicopter','plane']) {
  const f=fixture(type);
  f.airborne(type==='plane'?{x:450,y:90,z:850,vz:-65,speed:65,airspeed:65}:
    {x:160,y:70,z:500,yaw:Math.PI/2,vx:-34,vz:0,speed:34});
  f.input({...neutral,vehicleThrottle:type==='helicopter'?1:0});
  let recovering=false,returned=false;
  f.fly(60,()=>{
    // The soft edge steer or the hard safety pilot, whichever the approach needs.
    recovering ||= f.game.vehicles.boundaryAvoidance.has(f.v.id)||f.v.edgeSteer>0;
    returned ||= recovering&&f.v.x>220&&f.v.x<800&&f.v.z>220&&f.v.z<800;
    assert(f.v.x>0&&f.v.x<1024&&f.v.z>0&&f.v.z<1024);
    assert.equal(f.v.hp,VEHICLE_RULES[type].hp,`${type} boundary recovery keeps full hull health`);
    assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z),`${type} actual tilted compound hull remains legal`);
    assert(f.v.y>5&&!f.v.grounded,`${type} recovery keeps safe airborne altitude`);
    assert(vehicleHullParts(f.v).every(part=>part.minY>=0&&part.maxY<=VEHICLE_RULES[type].ceiling+1e-5));
    for(const field of ['x','y','z','yaw','pitch','roll','vx','vy','vz','speed','yawRate','pitchRate','rollRate','rudderRate','airspeed'])
      assert(Number.isFinite(f.v[field]),`${type} ${field} stays finite`);
  });
  if(type==='plane') assert(recovering&&returned,`${type} edge guidance steers neutral manual controls and returns inward`);
  else {
    // The pilot holds W toward the edge: the edge brake holds the helicopter
    // off it; letting go of W settles into a hover.
    assert(recovering,`${type} edge guidance brakes at the map edge`);
    f.input({...neutral});f.fly(8);
    assert(f.v.speed<1&&f.v.x>3,`${type} hovers inside the map once W is released (${f.v.speed.toFixed(2)} m/s at x ${f.v.x.toFixed(1)})`);
  }
}

{
  const f=fixture('helicopter');
  f.airborne({x:65,y:70,z:500,yaw:Math.PI/2,vx:-34,vz:0,speed:34,airspeed:34,
    rotorSpeed:1,collective:9.81/18.81});
  f.input({...neutral,vehicleBrake:1,vehicleLift:1});
  let recovering=false,released=false,ticks=0;
  while(!released&&ticks++<1200) {
    f.fly(1/60);const active=f.game.vehicles.boundaryAvoidance.has(f.v.id);
    recovering ||= active;released=recovering&&!active;
    assert.equal(f.v.hp,VEHICLE_RULES.helicopter.hp);
    assert(f.game.vehicles.clearHull(f.v,f.v.x,f.v.y,f.v.z));
  }
  assert(released,'held hover brake cannot pin helicopter recovery at the map border');
  const altitude=f.v.y;f.fly(3);
  assert(f.v.y>altitude+5,'held collective resumes climbing after the safety handoff');
  assert.equal(f.p.input.vehicleBrake,1,'the safety maneuver retains the pilot brake command');
  assert.equal(f.p.input.vehicleLift,1,'the safety maneuver retains the pilot lift command');
}

// The actual Frontier layout also exposed a center-pursuit orbit. A temporary
// safety turn must level and return authority, rather than keep orbiting while
// silently discarding every manual surface and throttle command.
{
  const world=createMapState('frontier'),mapMeta=getMapMeta('frontier');
  const frontier=()=>{
    const game=new GameEngine({mode:'conquest',world,mapMeta});game.addClient('pilot','Pilot');
    const p=game.entities.get('pilot'),v=game.vehicles.vehicles.get('alpha-plane');
    // Stand beside the jet on the authored pad; the height comes from mapMeta, not a constant.
    Object.assign(p,{x:v.x+5,y:v.y,z:v.z});
    game.applyInput(p.id,{keys:{},vehicleAction:{type:'enter',vehicleId:v.id}});
    assert.equal(p.vehicleId,v.id);
    const input=payload=>game.applyInput(p.id,{keys:{},yaw:0,pitch:0,...neutral,vehicleThrottle:0,vehicleLift:0,...payload});
    const tick=()=>{
      game.vehicles.step(1/60);
      assert.equal(v.hp,VEHICLE_RULES.plane.hp,'Frontier recovery preserves hull health');
      assert(game.vehicles.clearHull(v,v.x,v.y,v.z),'Frontier recovery keeps the actual compound hull legal');
      assert(!v.grounded&&v.y>35,'boundary guidance keeps the jet above Frontier roofs');
      assert(v.speed>5,'boundary guidance retains physical travel');
    };
    return {game,p,v,input,tick};
  };
  const liveOrbit={x:526.0709373859804,y:148.87096245723504,z:694.4638597639732,yaw:67.97888891727025,
    pitch:.10294816069191128,roll:1.1,pitchRate:-6.490882825739887e-7,rollRate:0,rudderRate:0,
    vx:41.9112638795888,vy:.00011947670563981833,vz:-18.521189167773446,grounded:false,
    throttle:.4570833333333275,enginePower:.4570833333333275,airspeed:45.821266767596555,
    speed:45.821266767596555,stalled:false,gearDown:false,yawRate:.4225210937275495};
  for(const turning of [true,false]) {
    const f=frontier();Object.assign(f.v,liveOrbit);
    f.game.vehicles.boundaryAvoidance.set(f.v.id,{turnSense:1,turning,radius:130,altitude:145});f.input({});
    let ticks=0;
    while(f.game.vehicles.boundaryAvoidance.has(f.v.id)&&ticks++<600)f.tick();
    assert(ticks<600,'the captured center orbit hands control back within ten seconds');
    assert(Math.abs(f.v.roll)<.3,'handoff physically levels the wings with bounded residual roll rate');
    const before={pitch:f.v.pitch,roll:f.v.roll,throttle:f.v.throttle};
    f.input({vehicleLift:1,vehicleRollControl:1,vehicleThrottle:1});
    for(let i=0;i<30;i++)f.tick();
    assert(!f.game.vehicles.boundaryAvoidance.has(f.v.id),'clear interior flight retains manual authority');
    assert(f.v.pitch>before.pitch+.08,'Space raises the nose after recovery');
    assert(f.v.roll<before.roll-.15,'manual banking works after recovery');
    assert(f.v.throttle>before.throttle+.2,'W raises throttle after recovery');
  }

  // Center-inward alone is insufficient near a side: this course still points
  // west out of the map. Guidance must keep turning before it levels.
  {
    const f=frontier();Object.assign(f.v,liveOrbit,{x:150,y:170,z:245,yaw:78.12773101549638,
      vx:-19,vy:-2,vz:44,speed:48,airspeed:48});
    f.game.vehicles.boundaryAvoidance.set(f.v.id,{turnSense:1,turning:true,radius:124,altitude:145});f.input({});
    f.tick();
    assert.equal(f.game.vehicles.boundaryAvoidance.get(f.v.id)?.heading,undefined,'an outward side course is not fixed in place');
    for(let i=0;i<1800;i++)f.tick();
  }

  // Two minutes of ordinary flight on the compact 768 m map: the pilot holds
  // a cruise altitude with the elevator and never touches the bank. The soft
  // edge steer turns the jet at the edges; the hard safety pilot (which takes
  // the controls) stays brief and the jet never leaves the map or gets hurt.
  for(const mode of ['stick','aim']) {
    const f=frontier();f.input({vehicleThrottle:1,vehicleLift:1});
    for(let i=0;i<300;i++)f.game.vehicles.step(1/60);
    assert(!f.v.grounded&&f.v.y>20,'ordinary W and Space leave the authored Frontier runway');
    let currentEpisode=0,maxEpisode=0,recoveries=0,previous=false,softTicks=0,activeTicks=0;
    const outward=Math.atan2(-1,0); // due +x: a mouse-aim pilot keeps aiming out of the map
    for(let i=0;i<7200;i++) {
      if(i%3===0) {
        if(mode==='aim') f.game.applyInput(f.p.id,{keys:{},yaw:outward,pitch:Math.max(-.2,Math.min(.3,(140-f.v.y)*.01)),vehicleThrottle:0,vehicleLift:0});
        else f.input({vehiclePitchControl:Math.max(-1,Math.min(1,(140-f.v.y)*.01-f.v.vy*.08-(f.v.pitchRate||0)*.8))});
      }
      f.tick();const active=f.game.vehicles.boundaryAvoidance.has(f.v.id);
      if(f.v.edgeSteer>0&&!active)softTicks++;if(active)activeTicks++;
      assert(f.v.x>0&&f.v.x<768&&f.v.z>0&&f.v.z<768,'the jet stays inside the map');
      currentEpisode=active?currentEpisode+1:0;maxEpisode=Math.max(maxEpisode,currentEpisode);
      if(!previous&&active)recoveries++;previous=active;
    }
    assert(softTicks>0,`${mode}: the soft edge steer did the turning`);
    assert(activeTicks<7200*.25,`${mode}: the safety pilot holds the controls only briefly (${(activeTicks/60).toFixed(1)} s)`);
    assert(maxEpisode<12*60,`${mode}: no boundary recovery becomes a permanent center orbit`);
    console.log(`Frontier edge guidance (${mode}): soft steer ${(softTicks/60).toFixed(1)} s, ${recoveries} hard recoveries `
      +`(${(activeTicks/60).toFixed(1)} s, longest ${(maxEpisode/60).toFixed(2)} s) in 120 seconds.`);
  }

  // From the middle of Frontier the full-speed jet keeps its controls in every
  // direction (the old guard counted any heading as threatened there and took
  // over). Diagonal headings are left alone; only head-on toward an edge 5 s
  // away at 72 m/s does the soft steer (never a takeover) start to blend in.
  for(let k=0;k<8;k++) {
    const f=frontier(),yaw=k*Math.PI/4;
    Object.assign(f.v,{x:384,y:140,z:384,yaw,pitch:0,roll:0,grounded:false,gearDown:false,vx:-Math.sin(yaw)*72,vy:0,vz:-Math.cos(yaw)*72,
      speed:72,airspeed:72,throttle:1,enginePower:1,pitchRate:0,rollRate:0,rudderRate:0,yawRate:0});
    f.input({});
    for(let i=0;i<30;i++){f.tick();assert(!f.game.vehicles.boundaryAvoidance.has(f.v.id),'no hard takeover from the map centre');}
    if(k%2) assert.equal(f.v.edgeSteer,0,`heading ${yaw.toFixed(2)}: no steer from the centre`);
    else assert(f.v.edgeSteer<1,`heading ${yaw.toFixed(2)}: a soft steer at most (${f.v.edgeSteer.toFixed(2)})`);
  }
}

console.log('Flight authority: normalized wire controls, neutral precedence, real banking, compound angular sweeps, runway pivot, physical boundary recovery and bounded manual handoff passed.');
