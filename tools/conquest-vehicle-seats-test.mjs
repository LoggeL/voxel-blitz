import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { fireOneShot } from '../server/sim/combat.js';
import { parseVehicleAction } from '../server/protocol/admission.js';
import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import { VEHICLE_RULES, vehicleLocalPoint, vehicleSeatPose } from '../shared/vehicles.js';
import { VEHICLE_SEATS, vehicleSeats, vehicleOccupiedSeats, vehicleWeaponSeatId, vehicleDriverSeat } from '../shared/vehicle-seats.js';
import { VEHICLE_TOPOLOGY } from '../shared/conquest-contract.js';

function fixture(type = 'jeep') {
  const frames = [], dimensions = {sx:512,sy:64,sz:512};
  const world = {dimensions,getBlock:(_x,y)=>y===0?3:0,findSpawns:()=>[{x:400,y:1,z:400}],setBlock(){}};
  const game = new GameEngine({mode:'conquest',world,mapMeta:{id:'frontier',dimensions,
    spawns:{conquest:{alpha:[{x:400,y:1,z:400}],bravo:[{x:440,y:1,z:400}]}},
    conquest:{flags:[],bases:{},vehicleSpawns:[{id:'v',type,team:'alpha',x:200,y:1,z:200,yaw:0}]}},broadcast:frame=>frames.push(frame)});
  for(let i=0;i<6;i++)game.addClient(`crew${i}`,`Crew ${i}`);
  game.addClient('enemy','Enemy');
  const people=Array.from({length:6},(_,i)=>game.entities.get(`crew${i}`)),enemy=game.entities.get('enemy');
  for(const p of people) game.mode.policy.setLobbyTeam(p,'alpha');
  game.mode.policy.setLobbyTeam(enemy,'bravo');
  for(const p of [...people,enemy])Object.assign(p,{x:400,y:1,z:400,hp:100,armor:0,spawnProtectedUntil:0,input:{keys:{},yaw:0,pitch:0}});
  const v=game.vehicles.vehicles.get('v');
  const board=(p,seatId)=>{
    Object.assign(p,{x:v.x,y:v.y,z:v.z});
    game.applyInput(p.id,{keys:{},yaw:0,pitch:0,wantFire:false,vehicleAction:{type:'enter',vehicleId:'v',...(seatId?{seatId}:{})}});
    return p.vehicleId==='v';
  };
  return {game,people,enemy,v,board,frames};
}
const near=(a,b,message)=>assert(Math.abs(a-b)<1e-7,message);

assert(Object.isFrozen(VEHICLE_SEATS));
assert.equal(vehicleSeats('constructor').length,0);assert.equal(vehicleSeats(null).length,0);
assert.deepEqual(Object.fromEntries(Object.entries(VEHICLE_SEATS).map(([type,seats])=>[type,seats.length])),{jeep:4,tank:2,helicopter:2,transport:5,plane:1});
for(const [type,seats] of Object.entries(VEHICLE_SEATS)) {
  assert(Object.isFrozen(seats));
  assert.deepEqual(seats.map(seat=>seat.id),VEHICLE_TOPOLOGY[type].map(seat=>seat.id),`${type} seat order is the contract F-key order`);
  for(const seat of seats) {
    assert(Object.isFrozen(seat));assert(Object.isFrozen(seat.position));
    assert.match(seat.label,/^[A-Z ]+$/,'seat labels are English HUD text');
  }
  assert.equal(vehicleDriverSeat(type).id,'driver');
}
assert.equal(vehicleWeaponSeatId({type:'tank'}),'driver','the primary mount belongs to the first seat owning a mount');
assert.equal(vehicleWeaponSeatId({type:'jeep'}),'gunner');assert.equal(vehicleWeaponSeatId({type:'transport'}),'door-left');
assert.deepEqual(parseVehicleAction({type:'enter',vehicleId:'v',seatId:'gunner'}),{type:'enter',vehicleId:'v',seatId:'gunner'});
assert.deepEqual(parseVehicleAction({type:'seat',seatId:'commander'}),{type:'seat',seatId:'commander'});
assert.deepEqual(parseVehicleAction({type:'cm'}),{type:'cm'});assert.deepEqual(parseVehicleAction({type:'weapon',index:1}),{type:'weapon',index:1});
for(const action of [{type:'enter',vehicleId:'v',seatId:null},{type:'enter',vehicleId:'v',seatId:''},
  {type:'enter',vehicleId:'v',seatId:'driver',hp:10},{type:'exit',seatId:'driver'}])assert.equal(parseVehicleAction(action),null);

// A requested free seat is honoured; plain entrants then fill the remaining
// seats in topology order, capacity is finite and nobody holds two seats.
for(const type of Object.keys(VEHICLE_SEATS)) {
  const f=fixture(type),seats=vehicleSeats(type),last=seats.at(-1);
  assert(f.board(f.people[0],last.id),'a requested free seat is honoured');
  assert.equal(f.people[0].vehicleSeatId,last.id);
  assert.equal(f.board(f.people[1],last.id),false,'an occupied seat request is refused');
  Object.assign(f.people[1],{x:400,y:1,z:400});
  Object.assign(f.enemy,{x:f.v.x,y:f.v.y,z:f.v.z});
  assert.equal(f.game.vehicles.enter(f.enemy,'v'),false,'enemies cannot board');
  assert.equal(f.game.vehicles.enter(f.people[1],'v'),false,'distant entry is refused');
  const rest=seats.slice(0,-1);
  for(const [i,seat] of rest.entries()) {
    const p=f.people[i+1];
    assert(f.board(p));assert.equal(p.vehicleSeatId,seat.id,'plain entry takes the first free seat in topology order');
    assert.equal(f.game.vehicles.enter(p,'v'),false,'a seated player cannot claim a second seat');
  }
  assert.equal(f.board(f.people[seats.length]),false,'capacity is finite');
  const driver=seats.length===1?f.people[0]:f.people[1];
  assert.equal(f.v.occupantId,driver.id,'legacy occupant is exclusively the driver');
  assert.equal(new Set(vehicleOccupiedSeats(f.v).map(seat=>seat.occupantId)).size,seats.length);
  f.game.step();
  const row=f.frames.at(-1).vehicles[0];
  for(const removed of ['seatCapacity','occupiedSeats','weaponSeatId','maxHp','cooldown'])assert.equal(row[removed],undefined,`${removed} is derived on the client`);
  assert.equal(vehicleSeats(row).length,seats.length);assert.equal(vehicleOccupiedSeats(row).length,seats.length);
  for(const p of f.people.slice(0,seats.length))assert.equal(f.frames.at(-1).players.find(r=>r.id===p.id).vehicleSeatId,p.vehicleSeatId);
  row.seatOccupants.driver='forged';
  assert.equal(f.v.seatOccupants.driver,driver.id,'snapshot cannot mutate server seats');
  for(const p of f.people.slice(0,seats.length))f.game.vehicles.release(p);
  assert.equal(vehicleOccupiedSeats(f.v).length,0);
}

// Each passenger is tied to its physical local mount through yaw, pitch, and roll.
for(const type of ['jeep','helicopter','transport','plane']) {
  const f=fixture(type),seats=vehicleSeats(type);
  for(let i=0;i<seats.length;i++)assert(f.board(f.people[i]));
  Object.assign(f.v,{yaw:.8,pitch:type==='jeep'?0:.19,roll:type==='jeep'?0:-.13});
  f.game.vehicles.syncCrew(f.v);
  for(let i=0;i<seats.length;i++) {
    const expected=vehicleLocalPoint(f.v,...seats[i].position),p=f.people[i];
    for(const [axis,j] of [['x',0],['y',1],['z',2]])near(p[axis],expected[j],`${type} ${seats[i].id} mount ${axis}`);
    assert.deepEqual(f.game.vehicles.seatedPose(p),vehicleSeatPose(f.v,seats[i].id));
  }
  assert.equal(new Set(f.people.slice(0,seats.length).map(p=>[p.x,p.y,p.z].join(','))).size,seats.length);
}

// Passenger input cannot steer, brake, alter flight axes, fire mounted weapons
// or (outside the personal-weapon arc) consume infantry ammo.
for(const type of ['jeep','transport']) {
  const f=fixture(type),control=fixture(type),seats=vehicleSeats(type);
  for(let i=0;i<seats.length;i++) {assert(f.board(f.people[i]));assert(control.board(control.people[i]));}
  const index=seats.findIndex(seat=>seat.role==='passenger'),passenger=f.people[index],mag=passenger.mag.slice();
  f.game.applyInput(passenger.id,{keys:{f:true,r:true,jump:true},vehicleThrottle:1,vehicleSteer:1,vehicleBrake:1,
    vehicleLift:1,vehiclePitchControl:1,vehicleRollControl:1,vehicleYawControl:1,yaw:Math.PI,pitch:.5,wantFire:true,reload:true,throwGrenade:true});
  for(const axis of ['vehiclePitchControl','vehicleRollControl','vehicleYawControl'])assert.equal(passenger.input[axis],1);
  for(let i=0;i<60;i++) {f.game.step();control.game.step();}
  for(const key of ['x','y','z','yaw','pitch','roll','speed'])near(f.v[key]||0,control.v[key]||0,`${type} passenger cannot alter ${key}`);
  assert.deepEqual(passenger.mag,mag);assert.equal(f.game.projectiles.active.size,0);
  assert.equal(f.frames.flatMap(frame=>frame.events).filter(e=>e.kind==='shoot'&&e.id===passenger.id).length,0,'a passenger fires nothing');
  assert.equal(f.game.vehicles.canUseWeapon(passenger,f.v),false,'passenger seats own no mount');
}

// Passenger lifecycle never clears the driver, engine state, rolling velocity or credit.
for(const type of ['jeep','tank','helicopter'])for(const method of ['release','exit','disconnect','death','stale','team']) {
  const f=fixture(type),driver=f.people[0],passenger=f.people[1];assert(f.board(driver));assert(f.board(passenger));
  Object.assign(f.v,{speed:10,vx:2,vy:0,vz:-10,engineOn:true});
  const before=[f.v.speed,f.v.vx,f.v.vy,f.v.vz];
  if(method==='release')f.game.vehicles.release(passenger);
  if(method==='exit')assert(f.game.vehicles.exit(passenger));
  if(method==='disconnect')f.game.removeClient(passenger.id);
  if(method==='death')f.game.killPlayer(passenger,f.enemy,'rifle',false);
  if(method==='stale') {f.game.entities.delete(passenger.id);f.game.vehicles.cleanCrew(f.v);}
  if(method==='team') {f.game.mode.policy.setLobbyTeam(passenger,'bravo');f.game.vehicles.cleanCrew(f.v);}
  assert.equal(f.v.occupantId,driver.id);assert.equal(f.v.engineOn,true);assert.equal(driver.vehicleSeatId,'driver');
  assert.deepEqual([f.v.speed,f.v.vx,f.v.vy,f.v.vz],before);assert.equal(f.game.vehicles.lastDrivers.has('v'),false);
  assert.equal(vehicleOccupiedSeats(f.v).length,1);
  if(method!=='stale') {assert.equal(passenger.vehicleId,null);assert.equal(passenger.vehicleSeatId,null);}
}
{
  const f=fixture(),driver=f.people[0],passenger=f.people[1];assert(f.board(driver));assert(f.board(passenger));
  f.v.speed=12;f.game.vehicles.release(driver);
  assert.equal(f.v.engineOn,false);assert.equal(f.v.speed,12);assert.equal(passenger.vehicleSeatId,'gunner');
  assert.equal(f.v.seatOccupants.gunner,passenger.id);
  assert(f.board(f.people[2],'rear-left'),'a requested rear seat is honoured while the driving seat is vacant');
  assert.equal(f.v.occupantId,null,'a passenger entry never takes the vacated driving seat');
  assert(f.board(f.people[3],'driver'));assert.equal(f.v.seatOccupants.gunner,passenger.id);assert.equal(f.v.occupantId,f.people[3].id);
  assert.equal(f.game.vehicles.lastDrivers.has('v'),false);
}
{
  const f=fixture(),driver=f.people[0],passenger=f.people[1];assert(f.board(driver));assert(f.board(passenger));
  passenger.vehicleSeatId='driver';
  assert.equal(f.game.vehicles.seatedPose(passenger),null,'mismatched seat identity never adopts another crew position');
  f.game.vehicles.step(1/60);
  assert.equal(passenger.vehicleId,null);assert.equal(passenger.vehicleSeatId,null);
  assert.equal(f.v.occupantId,driver.id);assert.equal(f.v.seatOccupants['front-passenger'],null);
  assert.equal(driver.vehicleSeatId,'driver');
}

// The tank driver owns the main gun and coax while driving; the commander owns
// the RWS and aims it independently. A seat switch hands mount control over
// within one tick, and the weapon action cycles the seat's weapon list.
{
  const f=fixture('tank'),driver=f.people[0],commander=f.people[1];assert(f.board(driver));assert(f.board(commander));
  assert.equal(commander.vehicleSeatId,'commander');
  const mags=[driver.mag.slice(),commander.mag.slice()];
  f.game.applyInput(driver.id,{keys:{},vehicleThrottle:1,vehicleSteer:.6,yaw:-1,pitch:-.05,wantFire:true});
  f.game.applyInput(commander.id,{keys:{f:true,r:true},vehicleThrottle:-1,vehicleSteer:-1,vehicleBrake:1,yaw:.7,pitch:.1,wantFire:true});
  let projectile;
  for(let i=0;i<90&&!projectile;i++) {f.game.step();projectile=[...f.game.projectiles.active.values()].find(p=>p.vehicleId==='v');}
  assert(projectile,'the driver fires the main gun through the mount system');assert.equal(projectile.ownerId,driver.id);
  assert.equal(projectile.vehicleWeapon,'tankAP');assert.equal(projectile.chaosLevel,0);
  for(let i=0;i<60;i++)f.game.step();
  assert(f.v.speed>0&&f.v.z<200,'the driver keeps forward motion and steering while firing');
  const rws=f.v.mounts[f.v.mounts.findIndex(m=>m.mountId==='rws')];
  assert(Math.abs(Math.atan2(Math.sin(rws.yaw-.7),Math.cos(rws.yaw-.7)))<.02,'the commander slews the RWS to their own aim');
  assert(Math.abs(Math.atan2(Math.sin(f.v.turretYaw+1),Math.cos(f.v.turretYaw+1)))<.05,'the turret follows the driver aim');
  const shots=f.frames.flatMap(frame=>frame.events).filter(e=>e.kind==='shoot'&&e.vehicleId==='v');
  assert(shots.some(e=>e.id===driver.id&&e.mount==='main'&&e.vehicleWeapon==='tankAP'),'the main gun emits shoot');
  assert(shots.some(e=>e.id===commander.id&&e.mount==='rws'&&e.vehicleWeapon==='hmg'),'the RWS emits shoot');
  assert(!shots.some(e=>e.id===commander.id&&e.mount!=='rws'),'the commander never fires the driver mounts');
  assert.deepEqual(driver.mag,mags[0]);assert.deepEqual(commander.mag,mags[1]);
  // Weapon cycling: index 2 of the driver's list is the coax.
  f.game.applyInput(driver.id,{keys:{},yaw:-1,pitch:-.05,wantFire:false,vehicleAction:{type:'weapon',index:2}});
  assert.equal(f.v.sel.driver,2);
  f.frames.length=0;f.game.applyInput(driver.id,{keys:{},yaw:-1,pitch:-.05,wantFire:true});f.game.step();
  assert(f.frames.flatMap(frame=>frame.events).some(e=>e.kind==='shoot'&&e.mount==='coax'&&e.vehicleWeapon==='coaxMG'),'the weapon action selects the coax');
  assert.equal(f.frames.at(-1).vehicles[0].sel.driver,2,'the selection is published in the row');
  // Seat switch: the commander takes the vacated driving seat and the main gun next tick.
  f.game.vehicles.release(driver);
  f.game.applyInput(commander.id,{keys:{},yaw:.2,pitch:0,wantFire:false,vehicleAction:{type:'seat',seatId:'driver'}});
  assert.equal(commander.vehicleSeatId,'driver');assert.equal(f.v.occupantId,commander.id);assert.equal(f.v.engineOn,true);
  assert.equal(f.v.seatOccupants.commander,null);
  const error=()=>Math.abs(Math.atan2(Math.sin(f.v.turretYaw-.2),Math.cos(f.v.turretYaw-.2)));
  const before=error();
  f.frames.length=0;f.game.applyInput(commander.id,{keys:{},yaw:.2,pitch:0,wantFire:true});f.game.step();
  assert(error()<before-.01,'the turret answers the new driver within one tick');
  for(let i=0;i<10&&!f.frames.flatMap(frame=>frame.events).some(e=>e.kind==='shoot'&&e.id===commander.id);i++)f.game.step();
  assert(f.frames.flatMap(frame=>frame.events).some(e=>e.kind==='shoot'&&e.id===commander.id&&e.mount==='coax'),'the new driver fires the selected coax once it has cycled');
  assert.equal(f.game.vehicles.action(commander,{type:'seat',seatId:'driver'}),false,'switching to the own seat is refused');
  assert.equal(f.game.vehicles.action(commander,{type:'seat',seatId:'nope'}),false,'unknown seats are refused');
}

// Hull interception protects every seat through ordinary infantry rays.
// A successful exit and delayed mounted packets cannot become infantry fire.
for(const type of Object.keys(VEHICLE_SEATS))for(const [index,seat] of vehicleSeats(type).entries()) {
  const f=fixture(type),p=f.people[index],rifle=WEAPON_IDS.indexOf('rifle');
  for(let i=0;i<=index;i++)assert(f.board(f.people[i]));
  Object.assign(p,{weapon:rifle,deployT:0,cooldown:0});
  const mag=p.mag[rifle],grenades=p.grenades.slice(),context={vehicleControlId:'v',vehicleControlSeatId:seat.id};
  // Personal-weapon seats may use the rifle only within the arc; aim behind the hull here.
  const lookYaw=seat.personalWeapons?Math.PI:0;
  f.game.applyInput(p.id,{seq:10,keys:{},wantFire:true,yaw:lookYaw,pitch:0,...context});f.game.step();
  assert.equal(p.mag[rifle],mag,'mounted trigger never consumes infantry ammo');
  f.game.applyInput(p.id,{seq:11,keys:{},wantFire:true,yaw:.6,pitch:.12,vehicleAction:{type:'exit'}});
  assert.equal(p.vehicleId,null,`${type} ${seat.id} actually exits`);assert.equal(p.input.seq,11);
  near(p.input.yaw,.6,'exit preserves look yaw');near(p.input.pitch,.12,'exit preserves look pitch');
  assert.equal(p.input.wantFire,false,'legacy successful exit packet drops the old trigger');
  for(let i=0;i<3;i++)f.game.step();
  assert.equal(p.mag[rifle],mag,'exit packet does not shoot before another input arrives');
  f.game.applyInput(p.id,{seq:12,keys:{},wantFire:true,yaw:.4,pitch:.1,...context});f.game.step();
  assert.equal(p.input.wantFire,false);assert.equal(p.mag[rifle],mag,'late actionless mounted trigger remains suppressed');
  f.game.applyInput(p.id,{seq:13,keys:{},wantFire:true,quickMelee:true,reload:true,reloadId:77,
    wantAds:true,throwGrenade:true,grenadeHandling:true,grenadeCharge:1,grenadeCook:1000,switchTo:WEAPON_IDS.indexOf('knife'),...context});
  for(const flag of ['wantFire','quickMelee','reload','wantAds','throwGrenade','grenadeHandling'])assert.equal(p.input[flag],false);
  assert.equal(p.input.switchTo,undefined);f.game.step();
  assert.equal(p.weapon,rifle);assert.equal(p.mag[rifle],mag);assert.deepEqual(p.grenades,grenades);
  assert.equal(p.reloading,false);assert.equal(p.reloadAck,0);
  assert.equal(f.frames.flatMap(frame=>frame.events).filter(e=>e.kind==='shoot'&&e.id===p.id&&e.w==='rifle').length,0);
  f.game.applyInput(p.id,{seq:14,keys:{},wantFire:true,yaw:0,pitch:0});f.game.step();
  assert.equal(p.mag[rifle],mag-1,'fresh on-foot packet fires normally after the server handoff');
}

// Stale or malformed mount context cannot control a different role or reuse old driving axes.
for(const context of [{vehicleControlId:'old',vehicleControlSeatId:'driver'},
  {vehicleControlId:'v',vehicleControlSeatId:'gunner'}, {vehicleControlId:'v'},
  {vehicleControlId:'',vehicleControlSeatId:'driver'}, {vehicleControlId:'v',vehicleControlSeatId:null},
  {vehicleControlId:'x'.repeat(65),vehicleControlSeatId:'driver'}]) {
  const f=fixture(),p=f.people[0];assert(f.board(p));
  f.game.applyInput(p.id,{seq:20,keys:{f:true,r:true},wantFire:true,vehicleThrottle:1,vehicleSteer:1,vehicleLift:1,
    vehicleBrake:1,vehiclePitchControl:1,vehicleRollControl:1,vehicleYawControl:1,...context});
  assert.equal(p.input.wantFire,false);
  for(const axis of ['vehicleThrottle','vehicleSteer','vehicleLift','vehicleBrake','vehiclePitchControl','vehicleRollControl','vehicleYawControl'])assert.equal(p.input[axis],0);
  f.game.step();assert.equal(f.v.speed,0);assert.equal(f.v.yaw,0);
}
{
  const f=fixture('tank'),commander=f.people[1];assert(f.board(f.people[0]));assert(f.board(commander));
  f.game.applyInput(commander.id,{keys:{},yaw:0,pitch:0,wantFire:true,vehicleControlId:'v',vehicleControlSeatId:'driver'});f.game.step();
  const rws=()=>f.frames.flatMap(frame=>frame.events).filter(e=>e.kind==='shoot'&&e.id===commander.id&&e.mount==='rws');
  assert.equal(rws().length,0,'stale seat context cannot fire a mount');
  f.game.applyInput(commander.id,{keys:{},yaw:0,pitch:0,wantFire:true,vehicleControlId:'v',vehicleControlSeatId:'commander'});f.game.step();
  assert(rws().length>0,'matching mounted context retains normal RWS fire');
}
// Personal weapons: a jeep passenger fires the rifle within 100 degrees of the hull nose only.
{
  const f=fixture('jeep'),people=f.people.slice(0,3);for(const p of people)assert(f.board(p));
  const p=people[2],rifle=WEAPON_IDS.indexOf('rifle');assert.equal(p.vehicleSeatId,'front-passenger');
  Object.assign(p,{weapon:rifle,deployT:0,cooldown:0});const mag=p.mag[rifle];
  f.game.applyInput(p.id,{keys:{},wantFire:true,yaw:2,pitch:0});f.game.step();
  assert.equal(p.mag[rifle],mag,'outside the arc the personal weapon is blocked');
  f.game.applyInput(p.id,{keys:{},wantFire:false,yaw:1.2,pitch:0});f.game.step();
  f.game.applyInput(p.id,{keys:{},wantFire:true,yaw:1.2,pitch:0});f.game.step();
  assert.equal(p.mag[rifle],mag-1,'inside the arc the passenger fires the rifle');
  near(p.yaw,1.2,'the seated body aims with the passenger look');
  assert.equal(f.game.vehicles.seatAllowsPersonalWeapons(people[0]),false,'the driver seat has no personal weapons');
  assert.equal(f.game.vehicles.seatAllowsPersonalWeapons(people[1]),false,'the gunner seat has no personal weapons');
}

// Entry drops a real charged shot, and exit discards all delayed infantry intent without resetting paid timers.
{
  const f=fixture('tank'),p=f.people[0],lance=WEAPON_IDS.indexOf('lance');
  // Conquest kits narrow the arsenal; this charge-weapon fixture adds the lance.
  if(Array.isArray(p.owned))p.owned=[...p.owned,'lance'];
  p.mag[lance]=Math.max(1,WEAPONS.lance.magSize|0);
  Object.assign(p,{weapon:lance,deployT:0,cooldown:0});
  f.game.applyInput(p.id,{keys:{},wantFire:true,yaw:0,pitch:0});for(let i=0;i<10;i++)f.game.step();
  assert.equal(p.charging,true);const mag=p.mag[lance];assert(f.board(p));
  assert.equal(p.charging,false);assert.equal(p.chargeT,0);assert.equal(p.charge,0);
  Object.assign(p,{charging:true,chargeT:700,charge:.5,ads:true,adsT:1,triggerPrev:true,reloadPrev:true,mining:{x:1},
    fireEdgeQueued:true,fireAimQueued:{yaw:0,pitch:0},quickMeleeQueued:{yaw:0,pitch:0},
    grenadeHandlingQueued:true,grenadeEdgeQueued:true,grenadeChargeQueued:1,grenadeCookQueued:1000,
    grenadeAimQueued:{yaw:0,pitch:0},nextThrowAt:12345});
  Object.assign(p.minigun,{spin:1,heat:.4,overheated:true});const grenades=p.grenades.slice();
  f.game.applyInput(p.id,{seq:31,keys:{},wantFire:true,reload:true,quickMelee:true,throwGrenade:true,grenadeHandling:true,
    wantAds:true,switchTo:WEAPON_IDS.indexOf('knife'),vehicleAction:{type:'exit'}});
  assert.equal(p.charging,false);assert.equal(p.chargeT,0);assert.equal(p.charge,0);
  assert.equal(p.ads,false);assert.equal(p.adsT,0);assert.equal(p.triggerPrev,false);assert.equal(p.reloadPrev,false);
  assert.equal(p.mining,null);assert.equal(p.minigun.spin,0);assert.equal(p.minigun.heat,.4);assert.equal(p.minigun.overheated,true);
  assert.equal(p.nextThrowAt,12345);
  for(const flag of ['fireEdgeQueued','grenadeEdgeQueued','grenadeHandlingQueued'])assert.equal(p[flag],false);
  for(const field of ['fireAimQueued','quickMeleeQueued','grenadeAimQueued'])assert.equal(p[field],null);
  f.game.step();assert.equal(p.mag[lance],mag,'neutralized exit cannot release a stored capacitor shot');assert.deepEqual(p.grenades,grenades);
  Object.assign(p,{weapon:WEAPON_IDS.indexOf('rifle'),deployT:0,cooldown:0});p.mag[p.weapon]=10;
  f.game.applyInput(p.id,{keys:{},reload:true});f.game.step();assert.equal(p.reloading,true,'fresh legacy reload remains usable after resetting the handoff latch');
}
{
  const f=fixture(),p=f.people[0];Object.assign(p,{weapon:WEAPON_IDS.indexOf('rifle'),deployT:0,cooldown:0});const mag=p.mag[p.weapon];
  f.game.applyInput(p.id,{keys:{},wantFire:true,vehicleAction:{type:'exit'}});f.game.step();
  assert.equal(p.mag[p.weapon],mag-1,'failed exit action does not suppress ordinary infantry fire');
}

// Hull interception protects every sealed seat through ordinary infantry rays.
for(const type of ['jeep','tank','helicopter','transport','plane']) {
  const f=fixture(type),crew=f.people.slice(0,vehicleSeats(type).length);
  for(const p of crew)assert(f.board(p));
  Object.assign(f.enemy,{x:200,y:1,z:215,yaw:0,pitch:0,weapon:WEAPON_IDS.indexOf('rifle'),input:{keys:{},yaw:0,pitch:0}});
  const hullHp=f.v.hp,center=f.v.y+VEHICLE_RULES[type].height*.2,pitch=Math.atan2(center-f.enemy.eyeY,15);
  fireOneShot(f.enemy,f.game.contexts.combat,1,{yaw:0,pitch});
  const exposed=p=>vehicleSeats(type).find(seat=>seat.id===p.vehicleSeatId).exposed;
  // The round stops at the hull, or at an open-seat crew member inside its box.
  f.game.vehicles.damageModel.flush(f.game.vehicles.nowMs()+1000);
  const hullHit=f.game.tickEvents.some(e=>e.kind==='vehicle_hit'&&e.vehicleId==='v');
  assert(hullHit||crew.some(p=>exposed(p)&&p.hp<100),`${type} infantry ray intercepts hull`);
  if(type==='tank')assert(hullHit&&f.v.hp===hullHp,'small arms spark off heavy armour');
  for(const p of crew)if(!exposed(p))assert.equal(p.hp,100,`${type} shields ${p.vehicleSeatId}`);
}

// Destruction kills each crew member once, preserves enemy attribution, then clears all lifecycle state.
{
  const f=fixture('tank'),driver=f.people[0],gunner=f.people[1];assert(f.board(driver));assert(f.board(gunner));
  f.game.vehicles.damage('v',10000,null,{explosive:true,impactVelocity:{vx:10,vy:-10,vz:0}});
  assert.equal(driver.state,'dead');assert.equal(gunner.state,'dead');assert.equal(driver.kills,0,'crashing cannot award friendly crew kills');
  assert.equal(f.game.tickEvents.find(e=>e.kind==='kill'&&e.victim===gunner.id).killer,'');
  assert.equal(f.game.tickEvents.find(e=>e.kind==='vehicle_destroyed').attacker,driver.id,'physical driver attribution remains intact');
}
for(const type of ['jeep','tank','helicopter','transport','plane']) {
  const f=fixture(type),crew=f.people.slice(0,vehicleSeats(type).length);
  for(const p of crew) {assert(f.board(p));p.armor=100;}
  assert.equal(f.game.vehicles.damage('v',10000,crew[0],{explosive:true}),false,'friendly hull damage refused');
  assert(f.game.vehicles.damage('v',10000,f.enemy,{explosive:true}));
  assert.equal(f.enemy.kills,crew.length);
  for(const p of crew) {
    assert.equal(p.state,'dead');assert.equal(p.vehicleId,null);assert.equal(p.vehicleSeatId,null);assert.equal(p.deaths,1);
    assert.equal(f.game.tickEvents.filter(e=>e.kind==='kill'&&e.victim===p.id).length,1);
  }
  assert.equal(f.game.tickEvents.filter(e=>e.kind==='vehicle_destroyed').length,1);
  assert.equal(f.game.tickEvents.filter(e=>e.kind==='explosion'&&e.type==='vehicle').length,1);
  assert.equal(f.game.vehicles.damage('v',10000,f.enemy,{explosive:true}),false);
  assert.equal(vehicleOccupiedSeats(f.v).length,0);assert.equal(f.v.occupantId,null);
  for(const p of crew)f.game.respawnPlayer(p);
  f.v.respawnIn=0;f.game.vehicles.step(1/60);
  assert.equal(f.v.hp,VEHICLE_RULES[type].hp);assert.equal(vehicleOccupiedSeats(f.v).length,0);
  for(const p of crew)assert(f.board(p));
  f.game.vehicles.reset();
  for(const p of crew) {assert.equal(p.vehicleId,null);assert.equal(p.vehicleSeatId,null);}
  assert.equal(vehicleOccupiedSeats(f.game.vehicles.vehicles.get('v')).length,0);
}
// A human taking over a seated bot keeps the seat: the aircraft keeps its pilot
// instead of dropping the body mid-air, and ground hulls keep their driver.
for(const type of ['helicopter','tank']) {
  const f=fixture(type),aircraft=type==='helicopter';
  f.game.addBot('bot-seat','Seated Bot');
  const bot=f.game.entities.get('bot-seat');f.game.mode.policy.setLobbyTeam(bot,'alpha');
  Object.assign(bot,{x:f.v.x,y:f.v.y,z:f.v.z,hp:100,spawnProtectedUntil:0});
  assert(f.game.vehicles.enter(bot,'v'),'the bot boards');
  const seatId=bot.vehicleSeatId,hp=f.v.hp;
  if(aircraft)Object.assign(f.v,{y:40,grounded:false});
  f.game.step();
  assert(f.game.takeoverBot('bot-seat','human-seat','Human'),'a human takes over the seated bot');
  for(let i=0;i<30;i++)f.game.step();
  const human=f.game.entities.get('human-seat');
  assert.equal(human,bot,'the same body continues');
  assert.equal(human.vehicleId,'v',`${type}: the human stays seated`);assert.equal(human.vehicleSeatId,seatId);
  assert.equal(f.v.seatOccupants[seatId],'human-seat','the seat is re-keyed to the human id');
  assert.equal(Object.values(f.v.seatOccupants).includes('bot-seat'),false,'no seat is left under the bot id');
  if(f.game.vehicles.vehicles.get('v').occupantId!=null)assert.equal(f.v.occupantId,'human-seat');
  assert.equal(f.v.hp,hp,'the hull is untouched');assert.equal(human.hp,100,'the body is untouched');
  if(aircraft)assert(f.v.y>30&&human.y>30,'the aircraft keeps flying with its pilot on board');
}
console.log('Vehicle seats: contract topology, requested seats, wire state, physical mounts, passenger isolation, driver/commander mounts, seat switch, weapon cycling, personal weapons, sealed seats and complete lifecycle passed');
