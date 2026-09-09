import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { getMapMeta, createMapState } from '../shared/worlddata.js';
import { BASTION_RULES as R, bastionWave, bastionPurchaseId, bastionRepairAvailable } from '../shared/bastion.js';
import { REACTOR_LAYOUT as L, REACTOR_INGRESS, reactorDefenderSolid } from '../shared/world/reactor-layout.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { parseBuyFrame } from '../server/protocol/admission.js';
import { fireOneShot } from '../server/sim/combat.js';
import { aimAngles } from '../server/sim/player.js';

const make = (count=1) => {
  let snapshot;
  const e=new GameEngine({mode:'bastion',mapMeta:getMapMeta('reactor'),broadcast:s=>{snapshot=s;}});
  for(let i=0;i<count;i++)e.addClient(`p${i}`,`Defender ${i}`);
  return {e,p:e.entities.get('p0'),m:e.mode.policy,snapshot:()=>snapshot};
};
const advance=(e,ms)=>{for(let at=0;at<ms;at+=50)e.step(Math.min(50,ms-at));};
const buy=(h,action,item,id='p0')=>{const state=h.m.players.get(id);return h.e.mode.purchase(id,bastionPurchaseId(h.m,state.request+1,action,item));};

assert.deepEqual(bastionWave(4,4).counts,[31,5,3]);
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
  buy(h,'ready');buy(h,'ready',null,'p1');advance(e,R.minimumPrepMs-50);assert.equal(m.phase,'prep');e.step(50);assert.equal(m.phase,'live');
  assert.equal(e.mode.purchase(p,request),false);advance(e,R.warningMs);assert.equal(e.npcs.size,3);assert.equal(e.entities.size,2);
  assert(h.snapshot().players.some(p=>p.npcRole==='runner'));assert.equal(h.snapshot().players.filter(p=>!p.npcRole).length,2);
  const queued=m.queue.length;e.addClient('late','Late');assert.equal(e.entities.get('late').state,'dead');assert.equal(m.queue.length,queued);
  e.killPlayer(p,e.npcs.values().next().value,'smg',false);assert.equal(p.respawnAt,Infinity);
  // Remove every finite attacker, including delayed spawns, to exercise supply.
  for(let i=0;i<1000 && m.phase==='live';i++) { for(const npc of e.npcs.values())e.killPlayer(npc,e.entities.get('p1'),'rifle',false);e.step(50); }
  assert.equal(m.phase,'supply');assert.equal(m.credits,550);assert.equal(e.entities.get('late').state,'alive');assert.equal(p.state,'alive');assert.equal(p.armor,0);
  assert.equal(m.soloAvailable,false);assert.equal(buy(h,'reserve'),true);assert.equal(buy(h,'reserve'),false);
  const before=m.core.hp;m.core.hp=500;p.x=m.core.x+2;p.z=m.core.z;p.y=m.core.y;
  e.applyInput(p.id,{keys:{interact:true}});e.step(50);assert(m.repair);assert.equal(m.availableCredits(),0);
  e.applyInput(p.id,{keys:{interact:false}});e.step(50);assert.equal(m.repair,null);assert.equal(m.credits,150);
  e.applyInput(p.id,{keys:{interact:true}});advance(e,R.repairMs+100);assert.equal(m.core.hp,700);assert.equal(m.credits,0);assert.equal(m.repairs,1);
  e.stop();console.log('ok: preparation, atomic purchases, ready gate, scaling, late join, supply, reserved repair');
}
{
  const h=make(),{e,m,p}=h;m.startWave();e.killPlayer(p,null,'world',false);assert(m.returnAt);advance(e,R.returnMs);assert.equal(p.state,'alive');assert.equal(p.armor,0);
  e.killPlayer(p,null,'world',false);e.step();assert.equal(m.phase,'post');assert.equal(m.reason,'team');
  advance(e,R.postMs);assert.equal(m.phase,'prep');assert.equal(m.wave,0);assert.equal(m.credits,400);assert.equal(m.soloUsed,false);e.stop();
  console.log('ok: one solo return, defeat, automatic fresh run');
}
{
  const {e,m,p}=make();m.startWave();m.core.hp=0;m.queue=[];e.npcs.clear();e.step();assert.equal(m.reason,'core');assert.equal(m.matchWinner,'bravo');e.stop();
  console.log('ok: reactor loss takes precedence over last enemy');
}
{
  const h=make(),{e,m,p}=h;
  // An end-to-end director run at production timings; a deterministic test
  // shooter removes spawned NPCs. Combat accuracy is tested separately below.
  let peak=0;const waves=new Set();
  const world=createMapState('reactor'); const block=[47,15,40], old=world.getBlock(...block);
  e.world.setBlock(...block,0);e.pushBlockDelta(...block,0);
  for(let i=0;i<14000&&m.phase!=='post';i++) {
    if(m.phase!=='live') { buy(h,'ready'); }
    waves.add(m.wave);peak=Math.max(peak,e.npcs.size);
    for(const npc of e.npcs.values())e.killPlayer(npc,p,'rifle',false);
    e.step(50);
  }
  assert.equal(m.phase,'post');assert.equal(m.wave,8);assert.equal(m.matchWinner,'alpha');assert.equal(m.credits,3900);assert(peak<=8);
  const run=m.run;advance(e,R.postMs);assert.notEqual(m.run,run);assert.equal(e.world.getBlock(...block),old);assert.equal(e.changedBlocks.size,0);e.stop();
  console.log('ok: all 8 finite waves, exact team rewards, bounded population, victory and map restoration');
}
{
  // Every entrance must actually reach and damage the core with normal movement.
  for(let lane=0;lane<3;lane++) {
    const {e,m,p}=make();m.startWave();m.queue=[];p.x=30;p.z=20;p.y=15;
    const npc=m.ai.spawn('runner',lane,0);let reached=false;
    for(let i=0;i<2200&&m.phase==='live';i++){e.step(50);if(m.core.hp<1000){reached=true;break;}}
    assert(reached,`lane ${lane} reaches core: ${JSON.stringify([npc.x,npc.y,npc.z,npc.npcAttack])}`);e.stop();
  }
  console.log('ok: real NPC movement and melee core damage from all three entrances');
}
{
  const {e,m,p}=make();m.startWave();m.queue=[];
  const npc=m.ai.spawn('runner',0,0);Object.assign(npc,{x:64,y:15,z:46});Object.assign(p,{x:64,y:15,z:40});
  p.weapon=WEAPON_IDS.indexOf('sniper');m.players.get(p.id).primary='sniper';p.deployT=0;p.cooldown=0;
  Object.assign(p,aimAngles([p.x,p.eyeY,p.z],[npc.x,npc.y+1.2,npc.z]));fireOneShot(p,e.contexts.combat);
  assert(npc.hp<80,'player hits NPC through standard hitboxes');assert.equal(m.canDamage(p,m.core),false);
  assert.equal(m.canDamage(npc,npc),false);assert.equal(m.canDamage(p,p),true);
  const hp=m.core.hp;m.core.takeDamage(50,false,p);assert.equal(m.core.hp,hp);e.stop();
  console.log('ok: authoritative player hits, friendly fire and objective immunity');
}

{
  const {e,m,p}=make();m.core.hp=800;Object.assign(p,{x:m.core.x+2,y:m.core.y,z:m.core.z});
  assert(bastionRepairAvailable(m.matchSnapshot(),p),'keyboard and touch expose the same valid repair');
  p.y+=5;assert.equal(bastionRepairAvailable(m.matchSnapshot(),p),false,'cannot repair from roof');p.y-=5;
  m.startWave();assert.equal(bastionRepairAvailable(m.matchSnapshot(),p),false);
  e.applyInput(p.id,{wantFire:true,throwGrenade:true,grenadeHandling:true,quickMelee:true});
  assert.equal(p.input.wantFire,false);assert.equal(p.input.throwGrenade,false);assert.equal(p.quickMeleeQueued,null);
  e.applyInput(p.id,{wantFire:false});e.applyInput(p.id,{wantFire:true});assert.equal(p.input.wantFire,true);
  e.removeClient(p.id);assert.equal(m.phase,'post');assert.equal(m.reason,'abandoned');e.stop();
  console.log('ok: repair input eligibility, held-input boundary and last defender disconnect');
}
{
  const {e,m,p}=make();m.startWave();m.queue=[];Object.assign(p,{x:30,y:15,z:20});
  const npc=m.ai.spawn('breacher',0,0);Object.assign(npc,{x:64,y:15,z:60,yaw:0,pitch:0});
  for(let i=0;i<22;i++){e.now+=50;m.ai.tick(.05);}
  assert.equal(npc.npcAttack,'charging');assert(npc.ai.windup>0);
  e.projectiles.smoke.deploy({id:'cancel',x:64,y:15,z:57},e.contexts.projectiles);
  e.now+=1000;m.ai.tick(.05);assert.equal(npc.ai.windup,0);assert.equal(e.projectiles.active.size,0);
  e.projectiles.smoke.clear();
  for(let i=0;i<65 && !e.projectiles.active.size;i++){e.now+=50;m.ai.tick(.05);}
  assert.equal(e.projectiles.active.size,1,'one rocket after fresh visible windup');
  e.killPlayer(npc,p,'rifle',false);e.npcs.delete(npc.id);
  for(let i=0;i<100&&e.projectiles.active.size;i++){e.now+=50;e.projectiles.step(.05,e.contexts.projectiles);}
  const damage=1000-m.core.hp;assert(damage>0&&damage<=80,`physical rocket retains NPC core damage after death: ${damage}`);
  const heavy=m.ai.spawn('heavy',1,0),before=m.core.hp;m.core.takeDamage(80,false,heavy);assert.equal(before-m.core.hp,5);
  m.beginSupply();assert.equal(e.projectiles.active.size,0);assert.equal(e.projectiles.smoke.active.size,0);
  assert(e.tickEvents.some(ev=>ev.kind==='bastion_clear'));e.stop();
  console.log('ok: smoke cancels windup, fresh reacquisition, real rocket core hit after owner death, heavy cap and phase cleanup');
}
{
  const {e,m,p}=make();
  for(const b of REACTOR_INGRESS) assert(reactorDefenderSolid(b.minX+1,15,b.minZ+1));
  assert(reactorDefenderSolid(64,16,54));assert.equal(reactorDefenderSolid(60,15,61),false);
  m.ai.nav.rebuild(0);
  for(const lane of L.lanes) for(const spawn of lane.spawns) assert(m.ai.nav.next(spawn));
  for(const lane of L.lanes) {
    const b=lane.breach;
    for(let x=b.x-3;x<=b.x+3;x++)for(let z=b.z-3;z<=b.z+3;z++)for(let y=15;y<=19;y++)e.world.setBlock(x,y,z,0);
  }
  m.ai.nav.rebuild(1);
  for(const lane of L.lanes) for(const spawn of lane.spawns) assert(m.ai.nav.next(spawn),'route remains after all breach cover is gone');
  e.stop();
  // Idle defenders at their actual start must be attacked, including after NPC reloads.
  const h=make();for(let i=0;i<5000&&h.m.phase!=='post';i++)h.e.step(50);
  assert.equal(h.m.phase,'post');assert.equal(h.m.soloUsed,true);assert.equal(h.m.reason,'team');h.e.stop();
  console.log('ok: ingress containment, core collision, routes after demolition and autonomous combat at player spawn');
}
console.log('Bastion tests passed');
