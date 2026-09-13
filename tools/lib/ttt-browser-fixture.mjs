import { GameEngine } from '../../server/game.js';
let engine;
const start=GameEngine.prototype.start;
GameEngine.prototype.start=function(...args){engine=this;return start.apply(this,args);};
process.on('message',({requestId,command})=>{
 try {
  if(!engine?.running)throw new Error('No live engine');
  const p=[...engine.entities.values()].find(p=>!p.bot), policy=engine.mode.policy;
  if(command==='stage') {
   const item=[...policy.pickups.values()][0];
   Object.assign(p,{x:item.x,y:item.y,z:item.z,vx:0,vy:0,vz:0,input:null});
   // Keep bots still so UI checks do not end the round mid-capture.
   engine.tickHooks.length=0;
   for(const b of engine.entities.values())b.input=null;
   process.send({requestId,result:{item,id:p.id}});
  } else if(command==='reveal') {
   engine.now=policy.phaseEndsAt;engine.mode.tick();
   const prior=policy.roles.get(p.id);
   if(prior!=='traitor') {
    const t=[...policy.roles].find(([,r])=>r==='traitor')[0];
    policy.roles.set(t,'innocent');policy.wallets.set(t,0);
    policy.roles.set(p.id,'traitor');policy.wallets.set(p.id,2);
   }
   process.send({requestId,result:true});
  } else if(command==='grenade') {
   const item=[...policy.pickups.values()].find(item=>item.grenade==='smoke');
   Object.assign(p,{x:item.x,y:item.y,z:item.z,input:null,vx:0,vy:0,vz:0});
   process.send({requestId,result:item});
  } else if(command==='ally') {
   const ally=[...engine.entities.values()].find(p=>p.bot);
   policy.roles.set(ally.id,'traitor');
   const dx=p.x>50?-12:12;
   Object.assign(ally,{x:p.x+dx,y:p.y,z:p.z,input:null,vx:0,vy:0,vz:0});
   for(let y=Math.floor(p.y);y<Math.floor(p.y)+4;y++)engine.world.setBlock(Math.floor(p.x+dx/2),y,Math.floor(p.z),1);
   process.send({requestId,result:{name:ally.name,id:ally.id}});
  } else if(command==='corpse') {
   const victim=[...engine.entities.values()].find(p=>p.bot);
   policy.roles.set(victim.id,'traitor');
   Object.assign(victim,{x:p.x+1,y:p.y,z:p.z,vx:0,vy:0,vz:0});
   engine.killPlayer(victim,p,'rifle',false);
   process.send({requestId,result:{name:victim.name,id:victim.id}});
  } else if(command==='finish') {
   for(const victim of engine.entities.values())if(victim.state==='alive'&&policy.roles.get(victim.id)==='innocent')engine.killPlayer(victim,p,'rifle',false);
   engine.mode.tick();
   process.send({requestId,result:true});
  } else if(command==='radar-target-move') {
   const target=[...engine.entities.values()].find(p=>p.bot);
   target.x+=5;
   process.send({requestId,result:{x:target.x}});
  } else if(command==='radar-scan') {
   const radar=policy.privateState(p.id).radar;
   engine.now=radar.nextScanAt;policy.equipment.tick();
   process.send({requestId,result:true});
  } else if(command==='teleporter-stage'||command==='teleporter-away') {
   if(command==='teleporter-stage'){policy.equipment.clear();policy.wallets.set(p.id,2);}
   const mark=engine.spawnPoints.find(s=>policy.equipment.validMark(s,p)&&Math.hypot(s.x-p.x,s.z-p.z)>10);
   if(!mark)throw new Error('No free distant teleport pad');
   Object.assign(p,{x:mark.x,y:mark.y,z:mark.z,vx:0,vy:0,vz:0,input:null,grounded:true});
   process.send({requestId,result:mark});
  } else if(command==='innocent') {
   policy.roles.set(p.id,'innocent');policy.wallets.set(p.id,0);
   const b=[...engine.entities.values()].find(p=>p.bot);policy.roles.set(b.id,'traitor');
   process.send({requestId,result:true});
  } else throw new Error('Unknown command');
 } catch(error){process.send({requestId,error:error.message});}
});
await import('../../server/index.js');
