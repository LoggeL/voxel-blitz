import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';
import { bastionPurchaseId } from '../shared/bastion.js';
const server=startServer({failureContext:'Bastion lobby'}), clients=[];
try {
  const port=await server.port;
  const host=new Client(port,'Bastion host');clients.push(host);
  const welcome=await host.join({firstFrame:{t:'create',name:'Bastion host',bots:7,gameMode:'bastion',map:'reactor'}});
  assert.equal(welcome.gameMode,'bastion');assert.equal(welcome.map,'reactor');
  const lobby=await host.waitForJson(m=>m.t==='lobbyState','waiting lobby');
  assert.equal(lobby.bots,0);assert.equal(lobby.members.length,1);
  host.send({t:'ready',value:true});host.send({t:'start'});
  const tick=await host.waitForJson(m=>m.t==='tick','first Bastion tick');
  assert.equal(tick.match.mode,'bastion');assert.equal(tick.match.phase,'prep');
  host.send({t:'buy',weapon:bastionPurchaseId(tick.match.bastion,1,'armor')});
  const bought=await host.waitForJson(m=>m.t==='tick'&&m.match.bastion.credits===200,'team armor purchase');
  assert.equal(bought.players.find(p=>p.id===host.id).armor,100);
  host.send({t:'buy',weapon:bastionPurchaseId(tick.match.bastion,2,'ready')});
  const live=await host.waitForJson(m=>m.t==='tick'&&m.match.phase==='live','ready wave',0,12000);
  assert.equal(live.match.bastion.total,8);
  for(let i=0;i<3;i++) {
    const client=new Client(port,`Late ${i}`);clients.push(client);
    await client.join({firstFrame:{t:'join',name:`Late ${i}`,lobby:welcome.lobby.code}});
    const state=await client.waitForJson(m=>m.t==='tick'&&m.players.some(p=>p.id===client.id),'late join snapshot');
    assert.equal(state.players.find(p=>p.id===client.id).state,'dead');
    assert.equal(state.match.bastion.total,8);
  }
  const fifth=new Client(port,'Fifth');clients.push(fifth);
  await fifth.connect({t:'join',name:'Fifth',lobby:welcome.lobby.code});
  const rejected=await fifth.waitForJson(m=>m.t==='error','capacity rejection');assert.match(rejected.msg,/full/i);
  const enemies=await host.waitForJson(m=>m.t==='tick'&&m.players.some(p=>p.npcRole),'NPC wire snapshot',0,10000);
  assert(enemies.players.some(p=>p.npcRole==='runner'));
  const listed=await host.waitForJson(m=>m.t==='lobbyState'&&m.members.length===4,'human-only roster');
  assert.equal(listed.members.some(p=>String(p.id).startsWith('npc-')),false);
  console.log('Bastion lobby passed: actual WS create/start/purchase, finite wave, three waiting late joiners, four-player cap and separate NPCs.');
} finally {
  await Promise.allSettled(clients.map(c=>c.close()));await stopServer(server);
}
