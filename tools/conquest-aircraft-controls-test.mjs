// Aircraft controls: manual flight axes from pointer and keys, ground
// regressions, entry distances, the Input flight bridge, and the aircraft
// chase cameras (profile distances, wall clearance, lagged level-horizon
// follow, boresight aim, free look, speed FOV) of the per-seat VehicleCamera.
// Touch buttons and HUD instruments are WP7's (conquest-vehicle-touch-test,
// conquest-ui-test).
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { Input } from '../public/js/engine/input.js';
import { VehicleController } from '../public/js/session/vehicle-controller.js';
import { VEHICLE_CAMERA, seatCameraProfile, aircraftBoresight } from '../public/js/session/vehicle-camera.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';

const self = {id:'pilot',state:'alive',hp:100,team:'alpha',x:100,y:11,z:100};
const base = Object.freeze({id:'heli',type:'helicopter',team:'alpha',x:100,y:11,z:100,yaw:.2,pitch:.1,roll:0,
  hp:650,occupantId:'pilot',seatOccupants:{driver:'pilot'},speed:12,rotorSpeed:.8,collective:.522,grounded:false});
const camera = new THREE.PerspectiveCamera(70, 16/9);
let obstruction = null;
const controller = new VehicleController({camera,eventTarget:null,raycast:()=>obstruction});
const seat = row => controller.sync({self:{...self,vehicleId:row.id},vehicles:[row],enabled:true});
seat(base);
assert.equal(controller.pitch,.1,'aircraft view seeds from flight attitude');
let command = controller.controls({forward:true,right:true,jump:true},null,true);
assert.equal(command.vehicleThrottle,1);assert.equal(command.vehicleSteer,1);
assert.equal(command.vehicleLift,1);assert.equal(command.vehicleBrake,0);assert.equal(command.wantFire,true);
assert.equal(command.vehicleRollControl,1,'D banks right');
assert.equal(command.vehiclePitchControl,0);assert.equal(command.vehicleYawControl,0);
assert.equal(controller.controls({sprint:true}).vehicleLift,-1);
assert.equal(controller.controls({jump:true,sprint:true}).vehicleLift,0);
assert.equal(controller.controls({flightDown:false,sprint:true}).vehicleLift,0,'explicit flight state ignores touch auto-sprint');
command=controller.controls({flightUp:true,flightBrake:true});
assert.equal(command.vehicleLift,1);assert.equal(command.vehicleBrake,1,'flight brake is independent of lift');
assert.equal(controller.controls({vehicleLift:50}).vehicleLift,1);
assert.equal(controller.controls({vehicleLift:-50}).vehicleLift,-1);
const flightAxes=['vehiclePitchControl','vehicleRollControl','vehicleYawControl'];
for(const type of ['helicopter','transport','plane']) {
  const row=Object.freeze({...base,id:type,type});seat(row);
  command=controller.controls({leanRight:true},{dx:.01,dy:-.01});
  assert(command.vehiclePitchControl>0,'upward pointer motion raises the nose');
  assert(command.vehicleRollControl>0,'rightward pointer motion banks right');
  assert.equal(command.vehicleYawControl,1,'E applies right rudder/pedal');
  assert(Math.abs(command.yaw-row.yaw)<1e-12);assert.equal(command.pitch,row.pitch,'aim reports actual hull attitude');
  assert.equal(controller.controls({leanLeft:true}).vehicleYawControl,-1);
  command=controller.controls({left:true,right:true,leanLeft:true,leanRight:true});
  for(const axis of flightAxes)assert.equal(command[axis],0,'opposing inputs cancel');
  for(const look of [null,{dx:Infinity,dy:NaN},{dx:1e-8,dy:-1e-8}]) {
    command=controller.controls({},look);
    for(const axis of flightAxes)assert.equal(command[axis],0,'idle and jitter send explicit neutral');
  }
  command=controller.controls({}, {dx:1e300,dy:1e300});
  assert.equal(command.vehiclePitchControl,-1);assert.equal(command.vehicleRollControl,1);
  command=controller.controls({right:true,leanRight:true,vehiclePitchControl:0,vehicleRollControl:0,vehicleYawControl:0},{dx:1,dy:-1});
  for(const axis of flightAxes)assert.equal(command[axis],0,'explicit axes override device fallback');
  for(const value of [-50,50,NaN,Infinity]) {
    command=controller.controls({vehiclePitchControl:value,vehicleRollControl:value,vehicleYawControl:value});
    for(const axis of flightAxes)assert(Number.isFinite(command[axis])&&Math.abs(command[axis])<=1);
  }
  command=controller.controls({right:true,leanRight:true,vehiclePitchControl:NaN,vehicleRollControl:Infinity,vehicleYawControl:-Infinity},{dx:1,dy:-1});
  for(const axis of flightAxes)assert.equal(command[axis],0,'malformed explicit axes cannot revive fallback stick motion');
  const rates=[1/30,1/60,1/144].map(dt=>controller.controls({}, {dx:dt*.8,dy:dt*-.8},false,dt));
  for(const axis of ['vehiclePitchControl','vehicleRollControl'])
    assert(Math.max(...rates.map(row=>row[axis]))-Math.min(...rates.map(row=>row[axis]))<1e-12,'constant pointer speed is independent of frame rate');
  assert.deepEqual({...row},{...base,id:type,type},'controls never mutate authoritative flight state');
}
assert(Object.values(controller.controls(null,{dx:NaN,dy:Infinity})).every(value=>typeof value==='boolean'||Number.isFinite(value)));


// Chase cameras: per-seat profile distance, wall clearance and recovery.
for(const type of ['helicopter','transport','plane']) {
  const row={...base,id:type,type,pitch:0};seat(row);
  controller.view.setView(type,'driver','chase',{remember:false}); // pilots start in COCKPIT
  controller.updateCamera(1/60);
  const maximum=seatCameraProfile(type,'driver').distance;
  assert.equal(maximum,{helicopter:13,transport:15,plane:17}[type]);
  assert(Math.abs(camera.position.distanceTo(controller._focus)-maximum)<1e-6,`${type} chase distance`);
  assert(camera.position.y>row.y+VEHICLE_RULES[type].height+.3);
  obstruction={t:3};controller.updateCamera(1/60);
  assert(Math.abs(camera.position.distanceTo(controller._focus)-(3-VEHICLE_CAMERA.clearance))<1e-6);
  obstruction=null;for(const dt of [NaN,Infinity,-1])controller.updateCamera(dt);
  assert([camera.position.x,camera.position.y,camera.position.z].every(Number.isFinite));
  controller.updateCamera(1/60);assert(camera.position.distanceTo(controller._focus)>2.7);
  seat({...row,id:`${type}-chase`});controller.updateCamera(1/60);
  const initialYaw=camera.rotation.y;
  controller.controls({right:true},{dx:.05,dy:-.05});controller.updateCamera(1/60);
  assert(Math.abs(camera.rotation.y-initialYaw)<1e-3,'camera waits for actual hull motion');
  const presented={...row,id:`${type}-chase`,yaw:1.2,pitch:.3,roll:-.5,x:120,y:30};
  controller.updateCamera(1/60,presented);
  assert(camera.rotation.y>initialYaw&&camera.rotation.y<presented.yaw,'chase heading follows the hull with finite lag');
  assert.equal(controller._focus.x,120);assert.equal(controller._focus.y,30+VEHICLE_RULES[type].height+.3);
  for(let i=0;i<180;i++)controller.updateCamera(1/60,presented);
  assert(Math.abs(camera.rotation.y-presented.yaw)<.03,'the rendered hull owns the chase heading');
  assert.equal(camera.rotation.z,0,'bank keeps a level camera horizon');
  // Pilots with a fixed gun look at its boresight point.
  const bore=aircraftBoresight(presented);
  if(bore){
    const aim=new THREE.Vector3(...bore.origin).addScaledVector(new THREE.Vector3(...bore.dir),VEHICLE_CAMERA.boresightRange).sub(camera.position).normalize();
    assert(camera.getWorldDirection(new THREE.Vector3()).dot(aim)>.9999,`${type} screen centre is the gun boresight`);
  } else assert.equal(type,'transport','the transport pilot has no fixed gun');
}
// Free look (C) turns the camera while the stick stays centred.
{
  const eventTarget={listeners:new Map(),addEventListener(type,fn){this.listeners.set(type,fn);},removeEventListener(type){this.listeners.delete(type);}};
  controller.view.end();camera.fov=70;camera.updateProjectionMatrix();
  const look=new VehicleController({camera,eventTarget,raycast:()=>null});
  look.sync({self:{...self,vehicleId:'heli'},vehicles:[base],enabled:true});
  eventTarget.listeners.get('keydown')({code:'KeyC',repeat:false,defaultPrevented:false,target:null,preventDefault(){}});
  const held=look.controls({},{dx:.2,dy:-.2});
  assert.equal(held.vehiclePitchControl,0);assert.equal(held.vehicleRollControl,0,'free look never steers');
  for(let i=0;i<5;i++)look.updateCamera(1/60,base);
  const turned=camera.rotation.y;
  eventTarget.listeners.get('keyup')({code:'KeyC'});
  for(let i=0;i<240;i++)look.updateCamera(1/60,base);
  assert(Math.abs(camera.rotation.y-turned)>.1,'free look springs back on release');
  // Speed FOV: a jet at full speed widens the view by 8 degrees.
  const baseFov=70;
  look.sync({self:{...self,vehicleId:'jet'},vehicles:[{...base,id:'jet',type:'plane',speed:72}],enabled:true});
  for(let i=0;i<180;i++)look.updateCamera(1/60,{...base,id:'jet',type:'plane',speed:72});
  assert(Math.abs(camera.fov-(baseFov+VEHICLE_CAMERA.speedFov))<.1,`speed FOV ${camera.fov}`);
  look.sync({self,vehicles:[],enabled:true});
  assert.equal(camera.fov,baseFov,'leaving restores the FOV');
  look.dispose();
}
seat({...base,id:'jet',type:'plane'});
command=controller.controls({}, {dy:-999});assert.equal(command.vehiclePitchControl,1);
for(const axis of flightAxes)assert.equal(controller.controls()[axis],0,'releasing the stick cannot retain a turn command');
seat({...base,id:'jeep',type:'jeep'});
command=controller.controls({jump:true,sprint:true},null,true);
assert.equal(command.vehicleBrake,1);assert.equal(command.vehicleLift,0);
for(const axis of flightAxes)assert(!(axis in command),'ground vehicles retain their existing control protocol');
seat({...base,id:'tank',type:'tank',turretYaw:.7,turretPitch:.1});
command=controller.controls({}, {dx:.3,dy:.2});
assert(Math.abs(command.yaw-.4)<1e-12);assert.equal(command.pitch,-.1,'ground turret still aims directly');
assert(controller.queueInteract());assert.deepEqual(controller.consumeAction(),{type:'exit'});
controller.sync({self,vehicles:[{...base,id:'jet',type:'plane',occupantId:null,seatOccupants:{},x:106.8}],enabled:true});
assert.equal(controller.nearest?.id,'jet','entry is reachable outside the jet collision hull');
controller.sync({self,vehicles:[{...base,id:'jeep',type:'jeep',occupantId:null,seatOccupants:{},x:104.1}],enabled:true});
assert.equal(controller.nearest,null,'ground entry distance remains four metres');
controller.dispose();assert.equal(controller.controls({jump:true}),null);

// The real Input bridge must distinguish a full-forward touch stick from Shift.
const input=new Input({});input.fallback=true;input._locked=true;
input._onTouchMove({x:.8,y:-1,magnitude:1});
assert(input.getKeys().sprint);assert.equal(input.getKeys().flightDown,false);
input._onTouchHold('flightUp',true);assert.equal(input.getKeys().flightUp,true);
input._onTouchHold('flightUp',false);input._onTouchHold('flightDown',true);
assert.equal(input.getKeys().flightDown,true);
input._onTouchHold('flightDown',false);input.keys.sprint=true;
assert.equal(input.getKeys().flightDown,true);input.keys.sprint=false;
input._onTouchHold('flightBrake',true);assert.equal(input.getKeys().flightBrake,true);
input._onTouchHold('flightBrake',false);
input.keys.leanLeft=true;assert.equal(input.getKeys().flightYawLeft,true);assert.equal(input.getKeys().flightYawRight,false);
input.keys.leanLeft=false;input.keys.leanRight=true;assert.equal(input.getKeys().flightYawRight,true);
input.clearTransient();assert.equal(input.getKeys().flightYawRight,false);input.dispose();

// Mouse aim: the chase camera looks along the pilot's aim with no hull lag
// (the HUD draws the nose marker apart from the centre aim circle), orbits
// behind the aim line a little above it, and keeps a level horizon.
{
  const aimCamera = new THREE.PerspectiveCamera(70, 16/9);
  const aimController = new VehicleController({camera:aimCamera,eventTarget:null,raycast:()=>null});
  aimController.setFlightOptions({mode:'aim',sensitivity:1,invertY:false});
  for(const type of ['plane','helicopter','transport']) {
    const row={...base,id:`aim-${type}`,type,yaw:.4,pitch:.05,roll:-.6};
    aimController.sync({self:{...self,vehicleId:row.id},vehicles:[row],enabled:true});
    aimController.view.setView(type,'driver','chase',{remember:false});
    aimController.controls({},{dx:-.5,dy:-.2,mouseDx:-.5,mouseDy:-.2},false,1/60);
    const aim=aimController.flightAim;
    assert(aim&&Math.abs(aim.yaw-.9)<1e-9,`${type}: the mouse moved the aim, not the hull`);
    aimController.updateCamera(1/60);
    const forward=aimCamera.getWorldDirection(new THREE.Vector3());
    const want=new THREE.Vector3(-Math.sin(aim.yaw)*Math.cos(aim.pitch),Math.sin(aim.pitch),-Math.cos(aim.yaw)*Math.cos(aim.pitch));
    assert(forward.dot(want)>.99999,`${type}: the screen centre is the aim, not the boresight`);
    assert.equal(aimCamera.rotation.z,0,`${type}: level horizon while the hull banks`);
    const offset=aimCamera.position.clone().sub(aimController._focus).normalize();
    assert(offset.dot(want)<-.95,`${type}: the camera sits behind the aim line`);
    assert(offset.y>-want.y+.05,`${type}: a little above it`);
    // No lag: a new aim is looked along on the very next frame.
    aimController.controls({},{dx:.3,dy:0,mouseDx:.3,mouseDy:0},false,1/60);aimController.updateCamera(1/60);
    const next=aimController.flightAim;
    assert(Math.abs(aimCamera.rotation.y-next.yaw)<1e-9,`${type}: the camera follows the aim without the hull lag`);
  }
  aimController.dispose();
}

// X (countermeasure) in a seat never toggles a prone that waits on exit.
{
  const keys=new Input({});keys.fallback=true;keys._locked=true;keys.setGameplayEnabled?.(true);
  const press=code=>{keys._onKeyDown({code,key:code,repeat:false,defaultPrevented:false,target:null,preventDefault(){}});
    keys._onKeyUp({code,key:code,repeat:false,defaultPrevented:false,target:null,preventDefault(){}});};
  keys.setTouchContext({vehicleSeated:true,vehicleRole:'driver',vehicleCanDrive:true,vehicleId:'jet',vehicleSeatId:'driver',vehicleType:'plane'});
  press('KeyX');
  assert.equal(keys.getKeys().prone,false,'seated X does not toggle prone');
  keys.setTouchContext({vehicleSeated:false});
  press('KeyX');
  assert.equal(keys.getKeys().prone,true,'on foot X still toggles prone');
  keys.dispose();
}

console.log('Aircraft manual flight axes, ground regressions, entry distances, Input flight bridge, aircraft chase cameras, mouse-aim chase camera and seated X passed');
