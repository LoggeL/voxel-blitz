import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { getMapMeta, createMapState, BARRICADE, AIR } from '../shared/worlddata.js';
import { GROUND, BEDROCK, isSolidBlock } from '../shared/world/blocks.js';
import { BASTION_RULES as R, BASTION_ROLES, BASTION_ENEMIES, BASTION_WAVES, BASTION_FACTORS, BASTION_VEHICLE_FACTORS,
  BASTION_CAPS, BASTION_SHOP, BASTION_RELOAD_MULT, bastionWeaponDef, bastionWave, bastionReward, bastionPurchaseId, parseBastionPurchase, bastionRepairAvailable,
  bastionRepairStatus } from '../shared/bastion.js';
import { BASTION_STRUCTURES, canPlaceStructure, structureFootprint } from '../shared/bastion-build.js';
import { bastionDefenderSolid, bastionPlannedWaves, bastionHoldWaves, bastionStageOfWave } from '../shared/world/bastion-layouts.js';
import { WEAPONS, WEAPON_IDS, damageAtDistance } from '../shared/combatmath.js';
import { playerHitboxes } from '../shared/player-hitboxes.js';
import { parseBuyFrame } from '../server/protocol/admission.js';
import { fireOneShot } from '../server/sim/combat.js';
import { aimAngles } from '../server/sim/player.js';
import { stepVehicle } from '../server/modes/bastion/vehicles.js';
import { TURRET_DEF } from '../server/modes/bastion/structures.js';

const G = GROUND, PVE = ['reactor', 'causeway'];
const layoutOf = map => getMapMeta(map).bastion;
const make = (count=1, mapId='reactor') => {
  let snapshot; const events=[];
  const e=new GameEngine({mode:'bastion',mapMeta:getMapMeta(mapId),broadcast:s=>{snapshot=s;events.push(...(s.events||[]));}});
  for(let i=0;i<count;i++)e.addClient(`p${i}`,`Defender ${i}`);
  return {e,p:e.entities.get('p0'),m:e.mode.policy,snapshot:()=>snapshot,events,seen:kind=>events.filter(ev=>ev.kind===kind)};
};
const advance=(e,ms)=>{for(let at=0;at<ms;at+=50)e.step(Math.min(50,ms-at));};
const buy=(h,action,item=null,id='p0',cell=null,facing=0)=>{const state=h.m.players.get(id);return h.e.mode.purchase(id,bastionPurchaseId(h.m,state.request+1,action,item,cell,facing));};
const expectedCounts=(rowId,n)=>BASTION_WAVES[rowId].map((c,i)=>Math.round(c*(BASTION_ENEMIES[BASTION_ROLES[i]].vehicle?BASTION_VEHICLE_FACTORS[n-1]:BASTION_FACTORS[n-1])));
const expectedCredits=layout=>{let c=R.startCredits;for(let w=1;w<=bastionHoldWaves(layout);w++)c+=bastionReward(w);return c+R.stageBonus*(layout.stages.length-1);};
const fwd=yaw=>({x:-Math.sin(yaw),z:-Math.cos(yaw)});
const seal=(e,cells,value=BARRICADE)=>{for(const [x,y,z] of cells){e.world.setBlock(x,y,z,value);e.pushBlockDelta(x,y,z,value);}};
const protect=p=>{p.spawnProtectedUntil=Infinity;return p;};
// `kind` is the event id on the wire; the structure/vehicle kind travels as `type` (BastionPolicy.emit) and the client reads it for banners.
const sawStructure=(h,id,type)=>h.seen('bastion_structure').some(ev=>ev.id===id&&ev.destroyed===true&&ev.type===type);
const sawVehicle=(h,id,phase,type)=>h.seen('bastion_vehicle').some(ev=>ev.id===id&&ev.phase===phase&&ev.type===type&&Array.isArray(ev.pos));
// The deterministic test shooter: every alive NPC dies this step. Peak is read before it fires.
const shooter=(h,peak)=>{const n=h.m.aliveEnemies().length;for(const npc of h.e.npcs.values())if(npc.state==='alive')h.e.killPlayer(npc,h.p,'rifle',false);return Math.max(peak,n);};

{
  assert.deepEqual(bastionWave('siege',4).counts,[26,5,3,3,0,2,0,0]);
  assert.deepEqual(bastionWave('siege',4).counts,expectedCounts('siege',4));
  assert.equal(bastionWave('probe',1).total,8);
  assert.deepEqual(bastionWave('lastStand',4).counts,[36,10,8,8,5,4,4,2]);
  for(const row of Object.keys(BASTION_WAVES))for(let n=1;n<=4;n++)assert.deepEqual(bastionWave(row,n).counts,expectedCounts(row,n));
  const infantry=BASTION_ROLES.filter(r=>!BASTION_ENEMIES[r].vehicle);
  for(let i=1;i<infantry.length;i++){
    assert(BASTION_ENEMIES[infantry[i]].scale>BASTION_ENEMIES[infantry[i-1]].scale,`${infantry[i]} is larger than ${infantry[i-1]}`);
    assert(BASTION_ENEMIES[infantry[i]].hp>BASTION_ENEMIES[infantry[i-1]].hp,`${infantry[i]} is tougher than ${infantry[i-1]}`);
  }
  assert(BASTION_ENEMIES.buggy.hp<BASTION_ENEMIES.apc.hp&&BASTION_ENEMIES.apc.hp<BASTION_ENEMIES.walker.hp);
  assert.equal(bastionPlannedWaves(layoutOf('reactor')),7);assert.equal(bastionPlannedWaves(layoutOf('causeway')),8);
  assert.equal(bastionHoldWaves(layoutOf('reactor')),5);assert.equal(bastionHoldWaves(layoutOf('causeway')),7);
  assert.equal(bastionStageOfWave(layoutOf('reactor'),3).index,1);
  assert.equal(expectedCredits(layoutOf('reactor')),3150);assert.equal(expectedCredits(layoutOf('causeway')),4900);
  console.log('ok: wave table, tier monotonicity and layout registry helpers');
}
{
  // Bloom overrides must use the WeaponDef keys fireOneShot reads.
  for(const role of BASTION_ROLES){
    const def=bastionWeaponDef({npcRole:role},WEAPONS[BASTION_ENEMIES[role].weapon]);
    assert.equal(def.bloomDeg,0.2,`${role} blooms 0.2 degrees per shot`);assert.equal(Object.hasOwn(def,'bloomPerShot'),false);
  }
  assert.equal(TURRET_DEF.bloomDeg,0);assert.equal(Object.hasOwn(TURRET_DEF,'bloomPerShot'),false);
  console.log('ok: NPC and sentry bloom overrides');
}
{
  const h=make(2), {e,m,p}=h;
  assert.equal(e.entities.size,2);assert.equal(e.npcs.size,0);
  assert.equal(m.canFire(p),false);assert.equal(m.canMove(p),true);assert.equal(m.canDamage(p,e.entities.get('p1')),false);
  const request=bastionPurchaseId(m,1,'armor');assert.equal(parseBuyFrame({t:'buy',weapon:request}),request);
  assert.equal(e.mode.purchase(p,request),true);assert.equal(e.mode.purchase(p,request),false);assert.equal(m.credits,200);
  assert.equal(buy(h,'armor'),false);assert([...e.entities.values()].every(p=>p.armor===100));
  assert.equal(buy(h,'loadout','sniper'),true);assert.deepEqual(p.owned,['sniper','revolver','knife']);
  assert.equal(m.canUseWeapon(p,WEAPON_IDS.indexOf('rocket')),false);
  const reserve=[...p.reserve];buy(h,'loadout','sniper');assert.deepEqual(p.reserve,reserve);
  // Build purchases round-trip through the shared grammar; malformed shapes never parse.
  const built=parseBastionPurchase(bastionPurchaseId(m,5,'build','wall',{x:64,y:15,z:44},1));
  assert.deepEqual(built.cell,{x:64,y:15,z:44});assert.equal(built.facing,1);assert.equal(built.item,'wall');assert.equal(built.action,'build');
  assert.equal(parseBastionPurchase(`bastion:${m.run}:${m.prep}:5:build:wall`),null);
  assert.equal(parseBastionPurchase(bastionPurchaseId(m,5,'armor',null,{x:64,y:15,z:44},1)),null);
  assert.equal(parseBastionPurchase(bastionPurchaseId(m,5,'build','tower',{x:64,y:15,z:44},1)),null);
  buy(h,'ready');buy(h,'ready',null,'p1');advance(e,R.minimumPrepMs-50);assert.equal(m.phase,'prep');e.step(50);assert.equal(m.phase,'live');
  assert.equal(e.mode.purchase(p,request),false);advance(e,R.warningMs);assert.equal(e.npcs.size,3);assert.equal(e.entities.size,2);
  assert(h.snapshot().players.some(p=>p.npcRole==='runner'));assert.equal(h.snapshot().players.filter(p=>!p.npcRole).length,2);
  const queued=m.queue.length;e.addClient('late','Late');assert.equal(e.entities.get('late').state,'dead');assert.equal(m.queue.length,queued);
  e.killPlayer(p,e.npcs.values().next().value,'smg',false);assert.equal(p.respawnAt,Infinity);
  // Remove every finite attacker, including delayed spawns, to exercise supply.
  for(let i=0;i<1000 && m.phase==='live';i++) { for(const npc of e.npcs.values())e.killPlayer(npc,e.entities.get('p1'),'rifle',false);e.step(50); }
  assert.equal(m.phase,'supply');assert.equal(m.credits,550);assert.equal(e.entities.get('late').state,'alive');assert.equal(p.state,'alive');assert.equal(p.armor,0);
  assert.equal(m.soloAvailable,false);assert.equal(buy(h,'reserve'),true);assert.equal(buy(h,'reserve'),false);
  m.core.hp=500;p.x=m.core.x+2;p.z=m.core.z;p.y=m.core.y;
  e.applyInput(p.id,{keys:{interact:true}});e.step(50);assert(m.repair);assert.equal(m.availableCredits(),0);
  e.applyInput(p.id,{keys:{interact:false}});e.step(50);assert.equal(m.repair,null);assert.equal(m.credits,150);
  e.applyInput(p.id,{keys:{interact:true}});advance(e,R.repairMs+100);assert.equal(m.core.hp,700);assert.equal(m.credits,0);assert.equal(m.repairs,1);
  e.stop();console.log('ok: preparation, atomic purchases, build grammar, ready gate, scaling, late join, supply, reserved repair');
}
{
  const h=make(),{e,m,p}=h;m.startWave();e.killPlayer(p,null,'world',false);assert(m.returnAt);advance(e,R.returnMs);assert.equal(p.state,'alive');assert.equal(p.armor,0);
  e.killPlayer(p,null,'world',false);e.step();assert.equal(m.phase,'post');assert.equal(m.reason,'team');
  advance(e,15000);assert.equal(m.phase,'post','post waits for the continuation vote');
  e.mode.approveContinuation(p.id,e.mode.matchSnapshot().continuation.id);
  advance(e,5000);assert.equal(m.phase,'prep');assert.equal(m.wave,0);assert.equal(m.credits,400);assert.equal(m.soloUsed,false);e.stop();
  console.log('ok: one solo return, defeat, approved fresh run');
}
{
  const {e,m,p}=make();m.startWave();m.core.hp=0;m.queue=[];e.npcs.clear();e.step();assert.equal(m.reason,'objective');assert.equal(m.matchWinner,'bravo');e.stop();
  console.log('ok: objective loss takes precedence over last enemy');
}
{
  // Building: shared placement rules on the server, world deltas, budgets, structure objectives and full restoration.
  const h=make(1),{e,m,p}=h;Object.assign(p,{x:64,y:G+1.02,z:48});
  const wallCells=structureFootprint('wall',{x:64,y:G+1,z:44},0);
  assert.equal(buy(h,'build','wall','p0',{x:64,y:G+1,z:44},0),true);assert.equal(m.credits,310);
  for(const c of wallCells)assert.equal(e.world.getBlock(c.x,c.y,c.z),BARRICADE,`barricade at ${c.x},${c.y},${c.z}`);
  assert.equal(e.changedBlocks.size,6);assert.equal(e.blockRevision,6);
  e.step(50);assert(h.snapshot().blocks.length>=6,'placed voxels stream as block deltas');
  assert.equal(m.matchSnapshot().bastion.budget.barricadeVoxels.used,6);
  const rejected=[[{x:64,y:G+1,z:20},'outside the build zone'],[{x:62,y:G+1,z:35},'on cover'],[{x:64,y:G+1,z:43},'inside the objective margin'],
    [{x:62,y:G+1,z:49},'on a defender spawn'],[{x:60,y:G+1,z:10},'inside an ingress gallery']];
  for(const [cell,why] of rejected){const credits=m.credits;assert.equal(buy(h,'build','wall','p0',cell,0),false,`wall ${why}`);assert.equal(m.credits,credits);}
  Object.assign(p,{x:30,y:G+1.02,z:20});assert.equal(buy(h,'build','wall','p0',{x:66,y:G+1,z:44},0),false,'out of reach');
  Object.assign(p,{x:64,y:G+1.02,z:48});m.credits=2000;
  assert.equal(buy(h,'build','turret','p0',{x:60,y:G+1,z:44},0),true);assert.equal(m.credits,1650);
  e.step(50);m.ai.nav.rebuild(e.blockRevision);assert.equal(m.ai.nav.walk[44*m.ai.nav.sx+60],0,'turret footprint is a navigation wall');assert.equal(m.ai.nav.breachWalk[44*m.ai.nav.sx+60],2,'turret footprint is breachable');
  let rows=m.matchSnapshot().bastion.structures;assert.equal(rows.length,1);assert(rows[0].id.startsWith('struct-'));assert(e.objectives.has(rows[0].id));
  const turret=e.objectives.get(rows[0].id);assert.equal(turret.structure,'turret');assert.equal(turret.hp,BASTION_STRUCTURES.turret.hp);
  assert.equal(buy(h,'build','crate','p0',{x:66,y:G+1,z:44},0),true);assert.equal(m.credits,1450);
  assert.equal(buy(h,'build','turret','p0',{x:62,y:G+1,z:44},0),true);assert.equal(m.credits,1100);
  assert.equal(buy(h,'build','turret','p0',{x:68,y:G+1,z:44},0),false,'third turret exceeds the stage budget');assert.equal(m.credits,1100);
  assert.equal(buy(h,'build','turret','p0',{x:60,y:G+1,z:44},0),false,'overlapping structure');
  rows=m.matchSnapshot().bastion.structures;assert.equal(rows.length,3);assert.equal(m.matchSnapshot().bastion.budget.turrets.used,2);assert.equal(m.matchSnapshot().bastion.budget.crates.used,1);
  m.startWave();m.queue=[];const npc=m.ai.spawn('runner',0,0);
  assert.equal(m.canDamage(npc,turret),true);assert.equal(m.canDamage(p,turret),false);assert.equal(m.canDamage(turret,npc),true);assert.equal(m.canDamage(turret,p),false);
  assert.equal(buy(h,'build','wall','p0',{x:64,y:G+1,z:42},0),false,'no building while live');
  m.finish(false,'team');e.step(50);e.mode.approveContinuation(p.id,e.mode.matchSnapshot().continuation.id);advance(e,5000);
  assert.equal(m.phase,'prep');for(const c of wallCells)assert.equal(e.world.getBlock(c.x,c.y,c.z),AIR);
  assert.equal(e.changedBlocks.size,0);assert.deepEqual(m.matchSnapshot().bastion.structures,[]);assert.equal(e.objectives.size,1);
  assert.equal(m.matchSnapshot().bastion.budget.barricadeVoxels.used,0);e.stop();
  console.log('ok: build placement rules, block deltas, structure objectives, per-stage budget and restoration');
}
{
  // Breach AI: a sealed gallery has no walking route, but the breach planner finds the barricade and chews through it.
  const h=make(),{e,m,p}=h;protect(p);Object.assign(p,{x:30,y:G+1.02,z:20});
  const sealed=[];for(let x=71;x<=81;x++)for(let y=G+1;y<=G+2;y++)sealed.push([x,y,20]);seal(e,sealed);
  m.startWave();m.queue=[];m.ai.nav.rebuild(e.blockRevision);
  const spawn=m.stage.spawns[0];
  assert.equal(m.ai.nav.next(spawn),null,'walking route is sealed');
  const breach=m.ai.nav.breachNext(spawn);assert(breach,'breach planner still reaches the objective');
  const npc=m.ai.spawn('runner',0,0);let breached=false;
  for(let i=0;i<1500&&m.phase==='live';i++){e.step(50);if(npc.npcAttack==='breach')breached=true;if(breached&&sealed.some(([x,y,z])=>e.world.getBlock(x,y,z)===AIR))break;}
  assert(breached,`runner switched to breach: ${JSON.stringify([npc.x,npc.z,npc.npcAttack])}`);
  assert(sealed.some(([x,y,z])=>e.world.getBlock(x,y,z)===AIR),'a sealed barricade cell was chewed through');
  m.ai.nav.rebuild(e.blockRevision);assert(m.ai.nav.next(spawn),'walking route reopens after the breach');
  assert(h.seen('bastion_breach').length>=1,'breach event announced');e.stop();
  console.log('ok: breach planner, barricade chewing and route recovery');
}
{
  // Breachers fire their rocket at the sealed cell instead of meleeing it.
  const h=make(),{e,m,p}=h;protect(p);Object.assign(p,{x:30,y:G+1.02,z:20});
  const sealed=[];for(let x=71;x<=81;x++)for(let y=G+1;y<=G+2;y++)sealed.push([x,y,20]);seal(e,sealed);
  m.startWave();m.queue=[];const spawn=m.stage.spawns[0];
  const npc=m.ai.spawn('breacher',0,0);let charged=false;
  for(let i=0;i<1500&&m.phase==='live';i++){e.step(50);if(npc.npcAttack==='charging')charged=true;if(sealed.some(([x,y,z])=>e.world.getBlock(x,y,z)===AIR))break;}
  assert(charged,`breacher wound up at the line: ${JSON.stringify([npc.x,npc.z,npc.npcAttack])}`);
  assert(h.seen('bastion_charge').some(ev=>ev.id===npc.id),'breacher windup tell');
  assert(h.seen('shoot').some(ev=>ev.id===npc.id&&ev.w==='rocket'),'breacher fired a rocket');
  assert(sealed.some(([x,y,z])=>e.world.getBlock(x,y,z)===AIR),'the rocket opened a sealed cell');
  m.ai.nav.rebuild(e.blockRevision);assert(m.ai.nav.next(spawn),'walking route reopens after the rocket breach');e.stop();
  console.log('ok: breacher rockets a sealed line open');
}
{
  // Sentry turret: autonomous fire at a hostile, ammo use, kill credit and destruction by a breacher rocket.
  const h=make(),{e,m,p}=h;protect(p);Object.assign(p,{x:64,y:G+1.02,z:48});m.credits=2000;
  assert.equal(buy(h,'build','turret','p0',{x:64,y:G+1,z:44},0),true);
  const turret=e.objectives.get(m.matchSnapshot().bastion.structures[0].id);
  Object.assign(p,{x:30,y:G+1.02,z:20});
  m.startWave();m.queue=[];
  const runner=m.ai.spawn('runner',0,0);Object.assign(runner,{x:64,y:G+1.02,z:38});
  const breacher=m.ai.spawn('breacher',0,1);breacher.npcSpeed=0;   // parked at its spawn, keeps the wave alive
  for(let i=0;i<120;i++)e.step(50);
  assert(runner.hp<80,'turret damaged the runner');assert(turret.ammo<BASTION_STRUCTURES.turret.ammo,'turret spent ammo');
  assert(h.seen('shoot').some(ev=>ev.id===turret.id),'turret shots are announced with its id');
  for(let i=0;i<400&&runner.state==='alive';i++)e.step(50);
  assert(h.seen('kill').some(ev=>ev.killer===turret.id),'turret kill is credited');
  assert.equal(m.phase,'live');
  assert.equal(turret.shooter.bloom,0,'the sentry never blooms (its shooter never runs bloom recovery)');
  turret.hp=1;assert.equal(turret.takeDamage(10,false,breacher,'rocket'),true);e.step(50);
  assert(sawStructure(h,turret.id,'turret'),'structure loss event');
  assert.equal(e.objectives.has(turret.id),false);
  assert.equal(m.ai.nav.walk[44*m.ai.nav.sx+64],1,'destroyed turret cell reopens for navigation');e.stop();
  console.log('ok: sentry turret fires, kills and dies');
}
{
  // Vehicles on both maps: locked mover, route following, ramming, small-arms factor, APC rockets and troop drop.
  const SCENES={
    reactor:{ move:{x:76,z:14}, seal:[75,76,77].flatMap(x=>[[x,G+1,22],[x,G+2,22]]), past:v=>v.z>23.5, apc:{stage:1,defender:{x:34,z:59}} },
    causeway:{ move:{x:174,z:60}, seal:[59,60,61].flatMap(z=>[[172,G+1,z],[172,G+2,z]]), past:v=>v.x<170.5, apc:{stage:0,defender:{x:150,z:60}} },
  };
  for(const map of PVE){
    const S=SCENES[map];
    {
      const h=make(1,map),{e,m,p}=h;protect(p);m.startWave();m.queue=[];
      const v=m.ai.spawn('buggy',0,0);const profile=BASTION_ENEMIES.buggy;
      assert.equal(v.npcVehicle,true);assert.deepEqual([...v.combatBox],[...profile.combatBox]);assert.equal(m.canMove(v),false);
      // Small arms from the front are reduced; the rear hit multiplies. Shots land before any
      // step so lag compensation has no older pose to rewind the hull to.
      Object.assign(v,{x:S.move.x,y:G+1.02,z:S.move.z});const f=fwd(v.yaw);
      p.weapon=WEAPON_IDS.indexOf('rifle');m.players.get(p.id).primary='rifle';
      const shoot=side=>{Object.assign(p,{x:v.x+f.x*3*side,y:G+1.02,z:v.z+f.z*3*side});p.deployT=0;p.cooldown=0;
        Object.assign(p,aimAngles([p.x,p.eyeY,p.z],[v.x,v.y+v.combatBox[1],v.z]));const hp=v.hp;fireOneShot(p,e.contexts.combat);return hp-v.hp;};
      const hook=v.beforeDamage;assert.equal(typeof hook,'function',`${map} buggy carries a damage hook`);
      v.beforeDamage=undefined;const base=shoot(1);v.beforeDamage=hook;
      assert(base>0&&Math.abs(base-damageAtDistance(WEAPONS.rifle,3))<=damageAtDistance(WEAPONS.rifle,3)*0.25,`${map} rifle base damage on the hull ${base}`);
      for(const [side,mult] of [[1,profile.smallArms],[-1,profile.smallArms*profile.rearMult]]){
        const dealt=shoot(side),expected=base*mult;
        assert(Math.abs(dealt-expected)<=1,`${map} buggy ${side>0?'front':'rear'} hit ${dealt} ~ ${expected}`);
      }
      e.step(50);const row=h.snapshot().players.find(r=>r.id===v.id);assert.equal(row.npcVehicle,true);assert.equal('npcScale' in row,false);
      assert(sawVehicle(h,v.id,'spawn','buggy'),`${map} vehicle spawn event`);
      Object.assign(p,{x:m.stage.defenders[0].x,y:G+1.02,z:m.stage.defenders[0].z});
      const route=m.stage.vehicleRoute,end=route[route.length-1];
      const before=Math.hypot(end.x-v.x,end.z-v.z);
      for(let i=0;i<300&&m.phase==='live';i++)e.step(50);
      assert(v.route.index>1,`${map} buggy advanced past its first waypoint`);
      assert(Math.hypot(end.x-v.x,end.z-v.z)<before,`${map} buggy closed on the route end`);
      assert(Math.abs(v.y-(G+1.02))<0.05,`${map} buggy stays on the road`);
      e.stop();
    }
    {
      const h=make(1,map),{e,m,p}=h;protect(p);seal(e,S.seal);m.startWave();m.queue=[];
      const v=m.ai.spawn('buggy',0,0);
      // The hull only rams what its footprint touches, then squeezes through the gap it made.
      for(let i=0;i<600&&!S.past(v)&&m.phase==='live';i++)e.step(50);
      const cleared=S.seal.filter(([x,y,z])=>e.world.getBlock(x,y,z)===AIR).length;
      assert(cleared>=2&&S.past(v),`${map} buggy rammed through the barricade: ${cleared} cells, ${JSON.stringify([v.x,v.z,v.npcAttack])}`);
      assert(h.seen('bastion_breach').length>=1,`${map} ram announced a breach`);e.stop();
    }
    {
      const h=make(1,map),{e,m,p}=h;protect(p);m.setStage(S.apc.stage);m.startWave();m.queue=[];
      Object.assign(p,{x:S.apc.defender.x,y:G+1.02,z:S.apc.defender.z});
      const apc=m.ai.spawn('apc',S.apc.stage,0);
      let shots=0,maxActive=0;
      for(let i=0;i<400&&m.phase==='live';i++){e.step(50);maxActive=Math.max(maxActive,e.projectiles.active.size);shots=h.seen('shoot').filter(ev=>ev.id===apc.id).length;if(maxActive>=2)break;}
      assert.equal(maxActive,2,`${map} apc launched two rockets after its windup (${shots} shots, attack ${apc.npcAttack})`);
      assert(h.seen('bastion_charge').some(ev=>ev.id===apc.id),'apc windup tell');
      e.killPlayer(apc,p,'rocket',false);e.step(50);
      const runners=[...e.npcs.values()].filter(n=>n.npcRole==='runner'&&n.state==='alive').length+m.queue.filter(r=>r==='runner').length;
      assert(runners>=BASTION_ENEMIES.apc.drop.count,`${map} apc dropped its troops (${runners})`);
      assert(sawVehicle(h,apc.id,'destroyed','apc'),`${map} vehicle destroyed event`);
      m.beginSupply();assert.equal(e.npcs.size,0);assert(e.tickEvents.some(ev=>ev.kind==='bastion_clear'));e.stop();
    }
  }
  console.log('ok: vehicles drive, ram, take reduced small arms, fire rockets and drop troops on both maps');
}
{
  // Objective damage generalises over every profile through objectiveHit.
  const {e,m}=make();m.startWave();m.queue=[];
  const hit=(role,damage,weapon,attack)=>{const npc=m.ai.spawn(role,0,0);if(attack)npc.npcAttack=attack;const hp=m.core.hp;m.core.takeDamage(damage,false,npc,weapon);return hp-m.core.hp;};
  assert.equal(hit('heavy',80,'lmg'),5);assert.equal(hit('juggernaut',50,'lmg'),6);assert.equal(hit('apc',60,'rocket'),60);
  assert.equal(hit('brute',25,undefined,'slam'),25);assert.equal(hit('walker',9,'lmg'),9);assert.equal(hit('walker',60,'rocket'),12);e.stop();
  console.log('ok: objective damage per profile');
}
{
  // Spawn protection holds against brute slams and hull contact, like every other damage path.
  const {e,m,p}=make();m.startWave();m.queue=[];
  const brute=m.ai.spawn('brute',0,0),f=fwd(brute.yaw);
  const health=()=>p.hp+p.armor;
  const slam=()=>{Object.assign(p,{x:brute.x+f.x*1.5,y:brute.y,z:brute.z+f.z*1.5,vx:0,vy:0,vz:0});brute.ai.slamAt=0;
    m.ai.slam(brute,BASTION_ENEMIES.brute,null,m.objective,Infinity,false);};
  p.spawnProtectedUntil=e.now+5000;const before=health();slam();
  assert.equal(health(),before,'a spawn-protected defender shrugs off the slam');
  p.spawnProtectedUntil=0;slam();
  assert(health()<before,'an unprotected defender in the arc takes the slam');
  const v=m.ai.spawn('buggy',0,0);Object.assign(p,{hp:100,armor:0});
  const ram=()=>{Object.assign(p,{x:v.x,y:v.y,z:v.z,vx:0,vy:0,vz:0});v.input={keys:{},wantFire:false,yaw:v.yaw,pitch:v.pitch};stepVehicle(e,m,v,0);};
  p.spawnProtectedUntil=e.now+5000;ram();
  assert.equal(health(),100,'a spawn-protected defender inside the hull takes no contact damage');
  p.spawnProtectedUntil=0;ram();
  assert(health()<100,'an unprotected defender inside the hull takes contact damage');e.stop();
  console.log('ok: spawn protection blocks slam and ram contact damage');
}
for(const map of PVE){
  // An end-to-end director run at production timings on each map; the test shooter removes spawned NPCs.
  const h=make(1,map),{e,m,p}=h,layout=layoutOf(map);
  const pristine=createMapState(map);let block=null;
  for(let z=layout.bounds.minZ;z<=layout.bounds.maxZ&&!block;z++)for(let x=layout.bounds.minX;x<=layout.bounds.maxX;x++){
    const v=pristine.getBlock(x,G+1,z);if(v!==AIR&&v!==BEDROCK){block=[x,G+1,z];break;}
  }
  const old=pristine.getBlock(...block);seal(e,[block],AIR);
  let peak=0,teleported=false;
  for(let i=0;i<20000&&m.phase!=='post';i++){
    if(m.phase!=='live')buy(h,'ready');
    if(m.stage.kind==='extract'&&!teleported){Object.assign(p,{x:m.objective.x+2,y:m.objective.y,z:m.objective.z});teleported=true;}
    protect(p);peak=shooter(h,peak);e.step(50);
  }
  assert.equal(m.phase,'post',`${map} run finished`);assert.equal(m.matchWinner,'alpha');assert.equal(m.reason,'extracted');
  assert.equal(m.stageIndex,layout.stages.length-1);assert(m.wave>=bastionPlannedWaves(layout),`${map} played every planned wave (${m.wave})`);
  assert.equal(m.credits,expectedCredits(layout),`${map} exact team rewards`);assert(peak<=BASTION_CAPS[0],`${map} population peak ${peak}`);
  assert.equal(h.snapshot().match.bastion.stage.index,layout.stages.length-1);
  const run=m.run;e.mode.approveContinuation(p.id,e.mode.matchSnapshot().continuation.id);advance(e,5000);assert.notEqual(m.run,run);
  assert.equal(e.world.getBlock(...block),old);assert.equal(e.changedBlocks.size,0);assert.equal(m.stageIndex,0);e.stop();
  console.log(`ok: ${map} full run, exact team rewards, bounded population, extraction and map restoration`);
}
{
  // Extraction: the hold timer, the endless last-stand loop, a missed shuttle and a destroyed beacon.
  const h=make(),{e,m,p}=h,layout=layoutOf('reactor');protect(p);
  m.setStage(layout.stages.length-1);m.startWave();
  assert(m.holdEndsAt>e.now);assert(h.seen('bastion_extract').length||e.tickEvents.some(ev=>ev.kind==='bastion_extract'));
  Object.assign(p,{x:30,y:G+1.02,z:20});
  for(let i=0;i<2500&&m.wave<2;i++){shooter(h,0);e.step(50);assert.equal(m.phase,'live');}
  assert(m.wave>=2,'extraction loop re-queues rows while the timer runs');
  e.now=m.holdEndsAt+R.extractGraceMs-50;shooter(h,0);e.step(50);
  assert.equal(m.phase,'post');assert.equal(m.reason,'missed');assert.equal(m.matchWinner,'bravo');e.stop();
  const b=make();b.m.setStage(layout.stages.length-1);b.m.startWave();b.m.objective.hp=0;b.e.step(50);assert.equal(b.m.reason,'objective');b.e.stop();
  console.log('ok: extraction timer, last-stand loop, missed shuttle and beacon loss');
}
{
  // Stage advance: clearing the first stage pays the bonus, regroups and rebuilds the objective and navigation goal.
  const h=make(2),{e,m,p}=h,p1=e.entities.get('p1'),layout=layoutOf('reactor');
  let killed=false;
  for(let i=0;i<4000&&!(m.stageIndex===1&&m.phase==='supply');i++){
    if(m.phase!=='live'){buy(h,'ready');buy(h,'ready',null,'p1');}
    if(m.phase==='live'&&m.wave===2&&!killed){e.killPlayer(p1,null,'world',false);killed=true;}
    shooter(h,0);e.step(50);
  }
  assert.equal(m.phase,'supply');assert.equal(m.stageIndex,1);
  const snap=m.matchSnapshot().bastion;assert.equal(snap.stage.transition,'regroup');assert.equal(snap.stage.index,1);assert.equal(snap.stage.id,layout.stages[1].id);
  assert.equal(m.credits,R.startCredits+bastionReward(1)+bastionReward(2)+R.stageBonus);
  assert.deepEqual([...e.objectives.keys()],[`bastion-${layout.stages[1].objective.id}`]);assert.equal(m.ai.nav.goal,m.objective);
  assert.equal(p1.state,'alive');assert(layout.stages[1].defenders.some(d=>Math.hypot(d.x-p1.x,d.z-p1.z)<0.6),'dead defender returns at a stage-1 point');
  assert(h.seen('bastion_regroup').some(ev=>ev.index===1));assert(h.seen('bastion_stage').some(ev=>ev.index===1));e.stop();
  console.log('ok: stage advance, regroup transition, stage bonus and objective swap');
}
{
  // Every spawn of every stage must reach and damage its objective with normal movement.
  const PARK={reactor:{x:30,y:G+1.02,z:20},causeway:{x:100,y:G+11.02,z:20}};
  for(const map of PVE)for(const i of layoutOf(map).stages.keys()){
    const {e,m,p}=make(1,map);protect(p);Object.assign(p,PARK[map]);
    m.setStage(i);m.startWave();m.queue=[];
    const npcs=[0,1,2].map(k=>m.ai.spawn('runner',i,k));let reached=false;
    for(let s=0;s<(map==='reactor'?2200:3000)&&m.phase==='live';s++){e.step(50);if(m.objective.hp<m.objective.maxHp){reached=true;break;}}
    assert(reached,`${map} stage ${i} reaches its objective: ${JSON.stringify(npcs.map(n=>[Math.round(n.x),Math.round(n.z),n.npcAttack]))}`);e.stop();
  }
  console.log('ok: real NPC movement and melee objective damage from every stage spawn on both maps');
}
{
  const {e,m,p}=make();m.startWave();m.queue=[];
  const npc=m.ai.spawn('runner',0,0);Object.assign(npc,{x:64,y:G+1.02,z:46});Object.assign(p,{x:64,y:G+1.02,z:40});
  p.weapon=WEAPON_IDS.indexOf('sniper');m.players.get(p.id).primary='sniper';p.deployT=0;p.cooldown=0;
  Object.assign(p,aimAngles([p.x,p.eyeY,p.z],[npc.x,npc.y+1.2*0.92,npc.z]));fireOneShot(p,e.contexts.combat);
  assert(npc.hp<80,'player hits the scaled runner through standard hitboxes');assert.equal(m.canDamage(p,m.core),false);
  assert.equal(m.canDamage(npc,npc),false);assert.equal(m.canDamage(p,p),true);
  const hp=m.core.hp;m.core.takeDamage(50,false,p);assert.equal(m.core.hp,hp);
  // Scaled bodies: the juggernaut's zones, eye height and pose history all carry bodyScale 1.4.
  const j=m.ai.spawn('juggernaut',0,1);Object.assign(j,{x:70,y:G+1.02,z:46,yaw:0,pitch:0});assert.equal(j.bodyScale,1.4);
  const base=playerHitboxes({x:0,y:0,z:0,yaw:0,pitch:0}).find(b=>b.zone==='head'),head=playerHitboxes(j).find(b=>b.zone==='head');
  assert(Math.abs(head.center[1]-(j.y+1.66*1.4))<0.05,`juggernaut head centre ${head.center[1]-j.y}`);
  for(let a=0;a<3;a++)assert(Math.abs(head.half[a]-base.half[a]*1.4)<1e-6,'head box scales with the body');
  assert(Math.abs((j.eyeY-j.y)-(npc.eyeY-npc.y)*1.4/0.92)<1e-6,'eye height scales with the body');
  Object.assign(p,{x:70,y:G+1.02,z:40});p.cooldown=0;
  Object.assign(p,aimAngles([p.x,p.eyeY,p.z],[j.x,j.y+1.2*1.4,j.z]));const armored=j.hp+j.armor;fireOneShot(p,e.contexts.combat);
  assert(j.hp+j.armor<armored,'sniper hits the scaled juggernaut (its plating absorbs first)');
  e.step(50);assert.equal(j.hist.at(-1).bodyScale,1.4,'pose history carries the scale for lag compensation');e.stop();
  console.log('ok: authoritative player hits, scaled bodies, friendly fire and objective immunity');
}
{
  const {e,m,p}=make();m.core.hp=m.core.maxHp-100;Object.assign(p,{x:m.core.x+2,y:m.core.y,z:m.core.z});
  assert(bastionRepairAvailable(m.matchSnapshot(),p),'keyboard and touch expose the same valid repair');
  p.y+=5;assert.equal(bastionRepairAvailable(m.matchSnapshot(),p),false,'cannot repair from roof');p.y-=5;
  m.repairs=R.repairLimit;assert.equal(bastionRepairStatus(m.matchSnapshot(),p),'limit','server refuses past the break limit');
  m.repairs=0;m.credits=R.repairPrice-1;assert.equal(bastionRepairStatus(m.matchSnapshot(),p),'credits','server refuses without the price');
  assert.equal(bastionRepairAvailable(m.matchSnapshot(),p),false);
  // Snapshot credits exclude the running repair's price; the repairer's own gate must not cancel it.
  m.credits=R.repairPrice+50;e.applyInput(p.id,{keys:{interact:true}});e.step(50);assert.equal(m.repair?.id,p.id);
  const repairing={...p,interaction:m.playerSnapshot(p).interaction};
  assert(m.matchSnapshot().bastion.credits<R.repairPrice&&bastionRepairAvailable(m.matchSnapshot(),repairing),'own repair stays gated open');
  e.applyInput(p.id,{keys:{interact:false}});e.step(50);assert.equal(m.repair,null);
  m.startWave();assert.equal(bastionRepairAvailable(m.matchSnapshot(),p),false);
  e.applyInput(p.id,{wantFire:true,throwGrenade:true,grenadeHandling:true,quickMelee:true});
  assert.equal(p.input.wantFire,false);assert.equal(p.input.throwGrenade,false);assert.equal(p.quickMeleeQueued,null);
  e.applyInput(p.id,{wantFire:false});e.applyInput(p.id,{wantFire:true});assert.equal(p.input.wantFire,true);
  e.removeClient(p.id);assert.equal(m.phase,'post');assert.equal(m.reason,'abandoned');e.stop();
  console.log('ok: repair input eligibility, held-input boundary and last defender disconnect');
}
{
  const {e,m,p}=make();m.setStage(1);m.startWave();m.queue=[];Object.assign(p,{x:30,y:G+1.02,z:20});
  const npc=m.ai.spawn('breacher',1,0);Object.assign(npc,{x:64,y:G+1.02,z:60,yaw:0,pitch:0});
  for(let i=0;i<22;i++){e.now+=50;m.ai.tick(.05);}
  assert.equal(npc.npcAttack,'charging');assert(npc.ai.windup>0);
  e.projectiles.smoke.deploy({id:'cancel',x:64,y:G+1,z:57},e.contexts.projectiles);
  e.now+=1000;m.ai.tick(.05);assert.equal(npc.ai.windup,0);assert.equal(e.projectiles.active.size,0);
  e.projectiles.smoke.clear();
  for(let i=0;i<65 && !e.projectiles.active.size;i++){e.now+=50;m.ai.tick(.05);}
  assert.equal(e.projectiles.active.size,1,'one rocket after fresh visible windup');
  e.killPlayer(npc,p,'rifle',false);e.npcs.delete(npc.id);
  for(let i=0;i<100&&e.projectiles.active.size;i++){e.now+=50;e.projectiles.step(.05,e.contexts.projectiles);}
  const damage=m.core.maxHp-m.core.hp;assert(damage>0&&damage<=80,`physical rocket retains NPC core damage after death: ${damage}`);
  const heavy=m.ai.spawn('heavy',1,0),before=m.core.hp;m.core.takeDamage(80,false,heavy,'lmg');assert.equal(before-m.core.hp,5);
  m.beginSupply();assert.equal(e.projectiles.active.size,0);assert.equal(e.projectiles.smoke.active.size,0);
  assert(e.tickEvents.some(ev=>ev.kind==='bastion_clear'));e.stop();
  console.log('ok: smoke cancels windup, fresh reacquisition, real rocket core hit after owner death, heavy cap and phase cleanup');
}
{
  // Layout contracts on both maps: containment, protected routes, door clearance and navigation from every spawn.
  const doorClear=(world,from,to)=>{
    const {sx,sz}=world.dimensions,key=(x,z)=>z*sx+x;
    const open=(x,z)=>{for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)for(let y=G+1;y<=G+3;y++)if(isSolidBlock(world.getBlock(x+dx,y,z+dz)))return false;return isSolidBlock(world.getBlock(x,G,z));};
    const goal=[Math.floor(to.x),Math.floor(to.z)],seen=new Uint8Array(sx*sz),q=[[Math.floor(from.x),Math.floor(from.z)]];seen[key(...q[0])]=1;
    for(let head=0;head<q.length;head++){const [x,z]=q[head];if(Math.max(Math.abs(x-goal[0]),Math.abs(z-goal[1]))<=4)return true;
      for(const [nx,nz] of [[x+1,z],[x-1,z],[x,z+1],[x,z-1]]){if(nx<1||nz<1||nx>=sx-1||nz>=sz-1||seen[key(nx,nz)])continue;seen[key(nx,nz)]=1;if(open(nx,nz))q.push([nx,nz]);}}
    return false;
  };
  for(const map of PVE){
    const layout=layoutOf(map),world=createMapState(map),{e,m}=make(1,map);
    for(const b of layout.ingress)assert(bastionDefenderSolid(layout,b.minX+1,G+1,b.minZ+1),`${map} ingress box is defender-solid`);
    for(const s of layout.stages){
      const o=s.objective;assert(bastionDefenderSolid(layout,Math.floor(o.x),G+2,Math.floor(o.z)),`${map} ${s.id} objective column is defender-solid`);
      for(const d of s.defenders)assert.equal(bastionDefenderSolid(layout,d.x,G+1,d.z),false,`${map} ${s.id} defender point is free`);
      const sb=layout.spawnBounds;
      for(const q of [...s.defenders,s.supply])assert(q.x>=sb.minX&&q.x<=sb.maxX&&q.z>=sb.minZ&&q.z<=sb.maxZ,`${map} ${s.id} point inside spawnBounds`);
      for(const b of layout.ingress){const z=s.buildZone;assert(z.maxX<b.minX||z.minX>=b.maxX||z.maxZ<b.minZ||z.minZ>=b.maxZ,`${map} ${s.id} build zone stays out of the galleries`);}
      const route=s.vehicleRoute;
      for(let k=0;k<route.length;k++){
        const samples=[route[k]];if(k+1<route.length)for(let t=1;t<8;t++)samples.push({x:route[k].x+(route[k+1].x-route[k].x)*t/8,z:route[k].z+(route[k+1].z-route[k].z)*t/8});
        for(const q of samples)for(let cx=Math.floor(q.x-1.4);cx<=Math.floor(q.x+1.4);cx++)for(let cz=Math.floor(q.z-1.4);cz<=Math.floor(q.z+1.4);cz++)
          if(Math.abs(cx+0.5-q.x)<=1.4&&Math.abs(cz+0.5-q.z)<=1.4)for(const y of [G+1,G+2])assert(!isSolidBlock(world.getBlock(cx,y,cz)),`${map} ${s.id} route clear at ${cx},${y},${cz}`);
      }
      const end=route[route.length-1];for(const d of s.defenders)assert(Math.hypot(end.x-d.x,end.z-d.z)>=3,`${map} ${s.id} route end keeps 3 m from defenders`);
      for(const sp of s.spawns)assert(doorClear(world,sp,s.objective),`${map} ${s.id} 3-wide door clearance from ${sp.x},${sp.z}`);
    }
    assert(bastionDefenderSolid(layout,64,G+2,54)===(map==='reactor'));
    for(const [i,s] of layout.stages.entries()){m.setStage(i);m.ai.nav.rebuild(0);for(const sp of s.spawns)assert(m.ai.nav.next(sp),`${map} ${s.id} navigation from ${sp.x},${sp.z}`);}
    if(map==='reactor'){
      for(const [x,z] of [[64,35],[39,54],[88,49]])for(let cx=x-3;cx<=x+3;cx++)for(let cz=z-3;cz<=z+3;cz++)for(let y=G+1;y<=G+5;y++)e.world.setBlock(cx,y,cz,AIR);
      for(const [i,s] of layout.stages.entries()){m.setStage(i);m.ai.nav.rebuild(1);for(const sp of s.spawns)assert(m.ai.nav.next(sp),'route remains after all breach cover is gone');}
    }
    e.stop();
  }
  // Idle defenders at their actual start must be attacked, including after NPC reloads.
  const h=make();for(let i=0;i<6000&&h.m.phase!=='post';i++)h.e.step(50);
  assert.equal(h.m.phase,'post');assert.equal(h.m.soloUsed,true);assert.equal(h.m.reason,'team');h.e.stop();
  console.log('ok: ingress containment, objective collision, protected routes, door clearance, routes after demolition and autonomous combat at player spawn');
}
{
  // Client construction: enemy looks, vehicle avatars, the shared placement predicate and the objective view.
  globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, { get: (object, key) => object[key] ?? (() => {}) }) }) };
  const THREE=await import('../public/js/vendor/three.module.js');
  const { makeAvatar, disposeAvatar }=await import('../public/js/avatar/avatar.js');
  const { updateBastionAvatar, ENEMY_LOOKS }=await import('../public/js/avatar/bastion-avatar.js');
  const { makeVehicleAvatar }=await import('../public/js/avatar/bastion-vehicle.js');
  const { BastionWorld }=await import('../public/js/engine/bastion-world.js');
  for(const role of BASTION_ROLES.filter(r=>!BASTION_ENEMIES[r].vehicle)){
    assert(ENEMY_LOOKS[role],`${role} has a look`);
    const av=makeAvatar(`npc-${role}`,role,'bravo');
    updateBastionAvatar(av,{npcRole:role,npcAttack:'advance',npcScale:BASTION_ENEMIES[role].scale});
    assert.equal(av.bodyScale,BASTION_ENEMIES[role].scale,`${role} body scale`);
    const layer=av._roleLayer;assert(layer&&layer.materials.size>0,`${role} role layer`);
    for(const mat of layer.materials){assert(av.fadeMaterials.includes(mat),`${role} layer material fades`);assert(av.flashMaterials.includes(mat),`${role} layer material flashes`);}
    updateBastionAvatar(av,{npcRole:role,npcAttack:'charging'});
    disposeAvatar(av);assert(!av._roleLayer||av._roleLayer.groups.length===0,`${role} layer cleared on dispose`);assert.equal(layer.groups.length,0);assert.equal(layer.materials.size,0);
  }
  for(const kind of ['buggy','apc','walker']){
    const av=makeVehicleAvatar(`v-${kind}`,kind);
    assert(av.group?.isObject3D);assert.equal(av.vehicle,true);assert.equal(av.kind,kind);
    assert(av.fadeMaterials.length>0&&av.fadeMaterials.length===av.flashMaterials.length,`${kind} materials`);
    assert.equal(av.limbStates.length,0);for(const part of ['head','torso','hips','lLeg','rLeg','lArm','rArm'])assert(av[part]?.isObject3D,`${kind} ${part}`);
    assert.equal(typeof av.updateHealth,'function');assert.equal(typeof av.update,'function');assert.equal(typeof av.dispose,'function');
    av.updateHealth(0.5);av.update(1/60,{npcAttack:'charging',moveSpeed:2,x:0,y:0,z:0,yaw:0});av.dispose();
  }
  const world=createMapState('reactor'),layout=layoutOf('reactor');
  const budget={barricadeVoxels:{used:0,max:R.build.barricadeVoxels},turrets:{used:0,max:R.build.turrets},crates:{used:0,max:R.build.crates}};
  const base={getBlock:(x,y,z)=>world.getBlock(x,y,z),layout,stageIndex:0,facing:0,player:{state:'alive',x:64,y:G+1.02,z:48},phase:'prep',budget,credits:400,structures:[],occupied:()=>false};
  const reason=(over)=>canPlaceStructure({...base,...over}).reason;
  assert.deepEqual(canPlaceStructure({...base,kind:'wall',cell:{x:64,y:G+1,z:44}}),{ok:true,reason:null});
  assert.equal(reason({kind:'turret',cell:{x:60,y:G+1,z:44}}),null);
  assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:20}}),'reach');assert.equal(reason({kind:'wall',cell:{x:62,y:G+1,z:35},player:{state:'alive',x:62,y:G+1.02,z:39}}),'air');
  assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:43}}),'objective');assert.equal(reason({kind:'wall',cell:{x:62,y:G+1,z:49}}),'zone');
  assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:46}}),'zone');assert.equal(reason({kind:'wall',cell:{x:60,y:G+1,z:10}}),'reach');
  assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:20},player:{state:'alive',x:64,y:G+1.02,z:24}}),'zone');
  assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:44},player:{state:'alive',x:30,y:G+1.02,z:20}}),'reach');
  assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:44},phase:'live'}),'phase');assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:44},player:{state:'dead',x:64,y:G+1.02,z:48}}),'alive');
  assert.equal(reason({kind:'tower',cell:{x:64,y:G+1,z:44}}),'kind');assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:44},credits:10}),'credits');
  assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:44},structures:[{x:64,y:G+1,z:44}]}),'structure');
  assert.equal(reason({kind:'turret',cell:{x:60,y:G+1,z:44},budget:{...budget,turrets:{used:2,max:2}}}),'budget');
  assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:44},budget:{...budget,barricadeVoxels:{used:45,max:48}}}),'budget');
  assert.equal(reason({kind:'wall',cell:{x:64,y:G+1,z:44},occupied:()=>true}),'occupied');
  const cw=createMapState('causeway'),cl=layoutOf('causeway');
  assert.deepEqual(canPlaceStructure({...base,getBlock:(x,y,z)=>cw.getBlock(x,y,z),layout:cl,kind:'sandbag',cell:{x:150,y:G+1,z:72},facing:1,player:{state:'alive',x:152,y:G+1.02,z:72}}),{ok:true,reason:null});
  assert.equal(canPlaceStructure({...base,getBlock:(x,y,z)=>cw.getBlock(x,y,z),layout:cl,stageIndex:1,kind:'sandbag',cell:{x:150,y:G+1,z:72},facing:1,player:{state:'alive',x:152,y:G+1.02,z:72}}).reason,'zone');
  for(const map of PVE){
    const L=layoutOf(map),scene=new THREE.Scene(),view=new BastionWorld(scene,L),s=L.stages[0],o=s.objective;
    const bastion={run:'r',prep:1,wave:1,waves:bastionPlannedWaves(L),
      stage:{index:0,count:L.stages.length,id:s.id,name:s.name,kind:s.kind,lane:s.lane,wave:1,waves:s.waves.length,transition:null,holdEndsAt:null,extractRadius:null,buildZone:{...s.buildZone},next:null},
      core:{id:`bastion-${o.id}`,name:o.name,model:o.model,x:o.x,y:o.y,z:o.z,half:[...o.half],hp:o.hp/3,maxHp:o.hp,lastHit:null},
      remaining:4,alive:2,total:8,killed:4,credits:400,supply:{...s.supply,active:false},lanes:[],structures:[],budget,vehicles:[]};
    view.sync({mode:'bastion',phase:'live',bastion});
    view.sync({mode:'bastion',phase:'prep',bastion:{...bastion,held:[s.id],lanes:[s.lane],stage:{...bastion.stage,index:1,kind:L.stages[1].kind}}});
    view.sync({mode:'bastion',phase:'supply',bastion:{...bastion,held:undefined,core:undefined}});
    if(typeof view.update==='function')view.update(1/60);
    if(typeof view.dispose==='function')view.dispose();
  }
  console.log('ok: client enemy looks, vehicle avatars, shared placement predicate and objective view on both layouts');
}
{
  // FAST RELOAD: the purchase text and every reload stage share one multiplier.
  const upgraded = { bastionUpgrades: { reload: true } };
  for (const id of ['rifle', 'shotgun']) {
    const base = WEAPONS[id], def = bastionWeaponDef(upgraded, base);
    assert.equal(def.reloadTime, base.reloadTime * BASTION_RELOAD_MULT);
    assert.equal(def.tacTime, base.tacTime * BASTION_RELOAD_MULT);
    if (base.reloadStages) for (const [key, seconds] of Object.entries(base.reloadStages))
      assert.equal(def.reloadStages[key], seconds * BASTION_RELOAD_MULT);
  }
  assert.equal(bastionWeaponDef({}, WEAPONS.rifle), WEAPONS.rifle);
  assert.ok(BASTION_SHOP.reload.description.startsWith(`${Math.round((1 - BASTION_RELOAD_MULT) * 100)}% faster`));
  console.log('ok: FAST RELOAD text and reload timings share BASTION_RELOAD_MULT');
}
console.log('Bastion tests passed');
