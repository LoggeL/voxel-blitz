import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { LobbyManager } from '../server/lobby.js';
import { makeLobbyState } from '../server/protocol/welcome.js';
import { tttTraitorCount } from '../shared/ttt.js';

assert.equal(tttTraitorCount(1, 50), 0);
assert.equal(tttTraitorCount(2, 10), 1);
assert.equal(tttTraitorCount(7, 25), 1);
assert.equal(tttTraitorCount(8, 50), 4);
const engine = new GameEngine({mode:'ttt'});
for (let i=0;i<8;i++) engine.addClient(String(i), String(i));
const host={id:'0',ready:true}, room={phase:'waiting',host:'0',gameMode:'ttt',map:'foundry',
  members:new Map([['0',host]]),bots:7,duelKillLimit:10,traitorPercent:25,engine};
const manager={_memberFor:()=>({room,member:host}),_validModeMap:()=>true,
  _error:()=>false,_syncWaitingBots:()=>{},_broadcastLobbyState:()=>{}};
const configure = percent => LobbyManager.prototype.configure.call(manager,{},{
  gameMode:'ttt',map:'foundry',bots:7,duelKillLimit:10,traitorPercent:percent});
assert.equal(configure(50),true);
assert.equal(host.ready,false);
assert.equal(configure(99),false);
assert.equal(room.traitorPercent,50);
const state=makeLobbyState({...room,members:[...engine.entities.values()]});
assert.equal(state.traitorCount,4);
engine.now=engine.mode.policy.phaseEndsAt;
engine.mode.tick();
assert.equal([...engine.mode.policy.roles.values()].filter(r=>r==='traitor').length,state.traitorCount);
console.log('TTT lobby share: validated setting, readiness reset, count preview and role assignment agree.');
