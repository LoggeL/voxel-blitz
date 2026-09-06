import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';
import { createMapState } from '../shared/worlddata.js';
const server=startServer({cwd:new URL('..',import.meta.url).pathname});
const clients=[];
try {
  const port=await server.port;
  for(const mode of ['fun','chaos','tdm','snd','gungame']) {
    const client=new Client(port,`Nuketown-${mode}`);clients.push(client);
    await client.connect({t:'create',name:`Nuketown-${mode}`,bots:2,gameMode:mode,map:'nuketown'});
    const {welcome,map}=await client.waitForHandshake();
    assert.equal(welcome.map,'nuketown');
    assert.equal(welcome.gameMode,mode);
    assert.deepEqual(new Uint8Array(map),createMapState('nuketown').serializeWorld());
    const state=await client.waitForJson(m=>m.t==='lobbyState','lobby');
    assert.equal(state.map,'nuketown');
    client.send({t:'ready',value:true});
    client.send({t:'start'});
    const tick=await client.waitForJson(m=>m.t==='tick','live match');
    assert.ok(tick.players.some(p=>p.id===welcome.id));
    assert.ok(tick.players.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.z)));
    console.log(`Nuketown ${mode}: map bytes, admission and live match verified.`);
    await client.close();
  }
} finally {await Promise.all(clients.map(c=>c.close()));await stopServer(server);}
