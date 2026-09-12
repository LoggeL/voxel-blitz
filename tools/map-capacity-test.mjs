import assert from 'node:assert/strict';
import { LobbyManager } from '../server/lobby.js';
import { MAP_IDS, MODE_IDS, isModeMapCompatible } from '../shared/modes.js';
import { MAP_PLAYER_LIMITS, lobbyCapacity } from '../shared/lobby-limits.js';

const frames = [];
const manager = new LobbyManager({ sendJson(meta, frame) { frames.push({ id: meta.id, ...frame }); }, sendFrame() {}, closeClient() {} });
const counts = new Set();
try {
  assert.deepEqual(Object.keys(MAP_PLAYER_LIMITS).sort(), [...MAP_IDS].sort());
  for (const map of MAP_IDS) {
    counts.add(MAP_PLAYER_LIMITS[map]);
    for (const mode of MODE_IDS.filter(mode => isModeMapCompatible(mode, map))) {
      const host = { id: `${map}-${mode}` };
      assert.ok(await manager.create(host, 'Host', 31, mode, map));
      const capacity = lobbyCapacity(mode, map);
      const state = manager._stateFor(host.room);
      const noBots = ['duel', 'bastion', 'training'].includes(mode);
      assert.equal(state.members.length, noBots ? 1 : capacity, `${map}/${mode} creation clamps requested bots`);
      if (mode !== 'training') assert.equal(manager.list().find(room => room.code === host.room.code).capacity, capacity);
      if (mode === 'duel') assert.equal(capacity, 2);
      if (mode === 'bastion') assert.equal(capacity, 4);
      manager.leave(host);
    }
  }
  assert.ok(counts.size >= 5, 'maps have distinct population tiers');

  const host = { id: 'host' };
  assert.ok(await manager.create(host, 'Host', 31, 'tdm', 'harbor'));
  manager.setBotDifficulty(host, 'bot-0', 'hard');
  manager.ready(host, true);
  assert.ok(manager.configure(host, { gameMode: 'tdm', map: 'depot', bots: 31 }));
  assert.equal(host.room.bots, 7);
  assert.equal(manager._stateFor(host.room).members.length, 8);
  assert.equal(host.room.botDifficulties.get('bot-0'), 'hard');
  assert.equal(host.room.members.get(host.id).ready, false);
  assert.equal(manager.configure(host, { gameMode: 'tdm', map: 'depot', bots: 31 }), false);

  // Human admission replaces bots at the map cap, then fails without eviction.
  const guests = [];
  for (let i = 0; i < 7; i++) {
    const guest = { id: `guest-${i}` }; guests.push(guest);
    assert.ok(await manager.join(guest, guest.id, host.room.code));
    assert.equal(manager._stateFor(host.room).members.length, 8);
  }
  assert.equal(host.room.bots, 0);
  assert.equal(await manager.join({ id: 'overflow' }, 'Overflow', host.room.code), false);
  assert.ok(manager.configure(host, { gameMode: 'tdm', map: 'citadel', bots: 0 }));
  const ninth = { id: 'ninth' };
  assert.ok(await manager.join(ninth, 'Ninth', host.room.code));
  const engine = host.room.engine;
  const before = manager._stateFor(host.room);
  assert.equal(manager.configure(host, { gameMode: 'tdm', map: 'depot', bots: 0 }), false);
  assert.match(frames.at(-1).msg, /8 players.*9 human/);
  assert.equal(host.room.engine, engine, 'rejected shrink retains the engine');
  assert.deepEqual(manager._stateFor(host.room), before, 'rejected shrink retains map, humans, teams and readiness');
  manager.leave(ninth);
  for (const guest of guests) manager.leave(guest);
  manager.leave(host);

  // Quick-play uses each rotating arena's cap, including bot replenishment.
  for (let i = 0; i < 4; i++) {
    const quick = { id: `quick-${i}` };
    assert.ok(manager.quickPlay(quick, 'Quick', 31));
    quick.room.engine.stop();
    const limit = lobbyCapacity(quick.room.gameMode, quick.room.map);
    assert.equal(quick.room.engine.entities.size, limit);
    manager._syncBots(quick.room);
    assert.equal(quick.room.engine.entities.size, limit);
    manager.leave(quick);
  }
} finally { manager.stop(); }
console.log('Map capacity passed: every compatible mode/map, directory limits, bot trimming, difficulty preservation, human admission, rejected shrink, quick-play replenishment.');
