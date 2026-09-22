import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';
import { bastionPurchaseId, bastionWave } from '../shared/bastion.js';
import { BARRICADE } from '../shared/world/blocks.js';
const server=startServer({failureContext:'Bastion lobby'}), clients=[];
const probeTotal=bastionWave('probe',1).total;
try {
  const port=await server.port;
  const host=new Client(port,'Bastion host');clients.push(host);
  const welcome=await host.join({firstFrame:{t:'create',name:'Bastion host',bots:7,gameMode:'bastion',map:'reactor'}});
  assert.equal(welcome.gameMode,'bastion');assert.equal(welcome.map,'reactor');
  const lobby=await host.waitForJson(m=>m.t==='lobbyState','waiting lobby');
  assert.equal(lobby.bots,0);assert.equal(lobby.members.length,1);
  host.send({t:'ready',value:true});host.send({t:'start'});
  const tick=await host.waitForJson(m=>m.t==='tick','first Bastion tick');
  assert.equal(tick.match.mode,'bastion');assert.equal(tick.match.phase,'prep');assert.equal(tick.match.map,'reactor');
  host.send({t:'buy',weapon:bastionPurchaseId(tick.match.bastion,1,'armor')});
  const bought=await host.waitForJson(m=>m.t==='tick'&&m.match.bastion.credits===200,'team armor purchase');
  assert.equal(bought.players.find(p=>p.id===host.id).armor,100);
  host.send({t:'buy',weapon:bastionPurchaseId(tick.match.bastion,2,'ready')});
  const live=await host.waitForJson(m=>m.t==='tick'&&m.match.phase==='live','ready wave',0,12000);
  assert.equal(live.match.bastion.total,probeTotal);
  assert.equal(live.match.bastion.stage.index,0);assert.equal(live.match.bastion.waves,7);
  assert(Array.isArray(live.match.bastion.structures));assert.equal(live.match.bastion.budget.turrets.max,2);
  for(let i=0;i<3;i++) {
    const client=new Client(port,`Late ${i}`);clients.push(client);
    await client.join({firstFrame:{t:'join',name:`Late ${i}`,lobby:welcome.lobby.code}});
    const state=await client.waitForJson(m=>m.t==='tick'&&m.players.some(p=>p.id===client.id),'late join snapshot');
    assert.equal(state.players.find(p=>p.id===client.id).state,'dead');
    assert.equal(state.match.bastion.total,probeTotal);
  }
  const fifth=new Client(port,'Fifth');clients.push(fifth);
  await fifth.connect({t:'join',name:'Fifth',lobby:welcome.lobby.code});
  const rejected=await fifth.waitForJson(m=>m.t==='error','capacity rejection');assert.match(rejected.msg,/full/i);
  const enemies=await host.waitForJson(m=>m.t==='tick'&&m.players.some(p=>p.npcRole),'NPC wire snapshot',0,10000);
  assert(enemies.players.some(p=>p.npcRole==='runner'));
  const listed=await host.waitForJson(m=>m.t==='lobbyState'&&m.members.length===4,'human-only roster');
  assert.equal(listed.members.some(p=>String(p.id).startsWith('npc-')),false);

  // Causeway: a second lobby on the linear map. The host walks east into the
  // stage-one build zone (its defender points start 7+ m west of it) and drops
  // a sandbag line through the ordinary buy frame during prep, no live wait.
  const host2=new Client(port,'Causeway host');clients.push(host2);
  const welcome2=await host2.join({firstFrame:{t:'create',name:'Causeway host',bots:0,gameMode:'bastion',map:'causeway'}});
  assert.equal(welcome2.gameMode,'bastion');assert.equal(welcome2.map,'causeway');
  await host2.waitForJson(m=>m.t==='lobbyState','causeway lobby');
  host2.send({t:'ready',value:true});host2.send({t:'start'});
  const first=await host2.waitForJson(m=>m.t==='tick','first Causeway tick');
  assert.equal(first.match.map,'causeway');assert.equal(first.match.phase,'prep');
  assert.equal(first.match.bastion.stage.name,'EAST GATE');assert.equal(first.match.bastion.stage.count,5);
  const me=m=>m.players?.find(p=>p.id===host2.id);
  let seq=0;const input=keys=>host2.send({t:'input',seq:++seq,keys,yaw:-Math.PI/2,pitch:0,weapon:0,wantFire:false});
  const walker=setInterval(()=>input({f:true}),66);   // the bot harness cadence; waiter predicates stay pure
  let walked;
  try { walked=await host2.waitForJson(m=>m.t==='tick'&&(me(m)?.x??0)>=151,'host walks into the build zone',host2.mark(),15000); }
  finally { clearInterval(walker); }
  input({});const settle=host2.mark();await host2.waitForJson(m=>m.t==='tick'&&m.players.length>0,'host settled',settle);
  const row=me(walked),cell={x:Math.min(154,Math.floor(row.x)+3),y:15,z:Math.floor(row.z)};
  host2.send({t:'buy',weapon:bastionPurchaseId(first.match.bastion,1,'build','sandbag',cell,0)});
  const built=await host2.waitForJson(m=>m.t==='tick'&&m.blocks?.some(b=>b.v===BARRICADE)&&m.match.bastion.credits===360,'sandbag line placed',0,5000);
  assert.equal(built.match.bastion.budget.barricadeVoxels.used,3);assert.equal(built.match.bastion.structures.length,0);
  assert.equal(built.match.phase,'prep');
  console.log('Bastion lobby passed: actual WS create/start/purchase, finite wave, three waiting late joiners, four-player cap, separate NPCs and a Causeway sandbag build.');
} finally {
  await Promise.allSettled(clients.map(c=>c.close()));await stopServer(server);
}
