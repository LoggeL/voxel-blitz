import assert from 'node:assert/strict';
import { lobbyCapacity } from '../shared/lobby-limits.js';
import { LobbyManager } from '../server/lobby.js';
import { parseAdmissionFrame } from '../server/protocol/admission.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';

const teamCounts = rows => rows.reduce((counts, row) => {
  if (row.team === 'alpha' || row.team === 'bravo') counts[row.team]++;
  return counts;
}, { alpha: 0, bravo: 0 });

assert.ok(parseAdmissionFrame({ t: 'create', name: 'Host', bots: 31, gameMode: 'tdm', map: 'foundry' }));
assert.equal(parseAdmissionFrame({ t: 'create', name: 'Host', bots: 32, gameMode: 'tdm', map: 'foundry' }), null);

// A friend can replace a planned bot in a full room without exceeding either team cap.
const manager = new LobbyManager({ sendJson() {}, sendFrame() {}, closeClient() {} });
try {
  for (const map of ['harbor', 'canyon', 'foundry', 'citadel']) {
    for (const gameMode of ['tdm', 'snd', 'chaos']) {
      const fullHost = { id: `spawn-${map}-${gameMode}` };
      assert.equal(await manager.create(fullHost, 'Spawn host', 31, gameMode, map), true);
      manager.ready(fullHost, true);
      assert.equal(manager.start(fullHost), true);
      const engine = fullHost.room.engine;
      engine.stop();
      const players = [...engine.entities.values()];
      assert.equal(players.length, lobbyCapacity(gameMode, map));
      for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
        assert.ok(Math.hypot(players[i].x - players[j].x, players[i].y - players[j].y,
          players[i].z - players[j].z) >= 1.0, `${map} ${gameMode}: all admitted players have separate spawn positions`);
      }
      manager.leave(fullHost);
    }
  }
  const host = { id: 'host' }, guest = { id: 'guest' };
  assert.equal(await manager.create(host, 'Host', 31, 'tdm', 'harbor'), true);
  assert.deepEqual(teamCounts(manager._stateFor(host.room).members), { alpha: 16, bravo: 16 });
  assert.equal(manager.setTeam(host, 'bot-0', 'alpha'), false, 'a full team rejects a seventeenth member');
  assert.equal(await manager.join(guest, 'Guest', host.room.code), true);
  assert.equal(host.room.bots, 30);
  assert.equal(manager._stateFor(host.room).members.length, 32);
  assert.deepEqual(teamCounts(manager._stateFor(host.room).members), { alpha: 16, bravo: 16 });
  assert.equal(manager.configure(host, { gameMode: 'tdm', map: 'harbor', bots: 31 }), false);

  const bombHost = { id: 'bomb-host' }, replacement = { id: 'bomb-replacement' };
  assert.equal(await manager.create(bombHost, 'Bomb host', 1, 'snd', 'foundry'), true);
  assert.equal(manager.setTeam(bombHost, bombHost.id, 'bravo'), true);
  assert.equal(manager.setTeam(bombHost, 'bot-0', 'alpha'), true);
  manager.ready(bombHost, true);
  assert.equal(manager.start(bombHost), true);
  bombHost.room.engine.stop();
  assert.equal(bombHost.room.engine.mode.bomb.carrierId, 'bot-0');
  assert.equal(await manager.join(replacement, 'Replacement', bombHost.room.code), true);
  assert.equal(bombHost.room.engine.mode.bomb.carrierId, replacement.id, 'live takeover transfers bomb ownership');
  assert.equal(bombHost.room.engine.mode.teamFor(replacement.id), 'alpha');
  assert.equal(bombHost.room.engine.entities.get(replacement.id).bomb, true);
} finally { manager.stop(); }

const server = startServer({ failureContext: 'large lobby acceptance' });
const clients = [];
try {
  const port = await server.port;
  function client(label) {
    const result = new Client(port, label);
    clients.push(result);
    return result;
  }
  const mapHost = client('rapid map host'), mapGuest = client('rapid map guest');
  const mapWelcome = await mapHost.join({ firstFrame: { t: 'create', name: 'Map host', bots: 31, gameMode: 'snd', map: 'canyon' } });
  await mapGuest.join({ firstFrame: { t: 'join', name: 'Map guest', lobby: mapWelcome.lobby.code } });
  const mapMarks = [mapHost.mark(), mapGuest.mark()];
  mapHost.send({ t: 'configure', gameMode: 'snd', map: 'harbor', bots: 30 });
  mapHost.send({ t: 'configure', gameMode: 'snd', map: 'canyon', bots: 30 });
  for (const [index, observer] of [mapHost, mapGuest].entries()) {
    const changed = await observer.waitForJson(m => m.t === 'lobbyState' && m.map === 'canyon', 'consecutive large map replacements', mapMarks[index]);
    assert.equal(changed.members.length, 32);
    assert.deepEqual(teamCounts(changed.members), { alpha: 16, bravo: 16 });
    assert.equal(observer.framesAfter(mapMarks[index]).filter(frame => frame.kind === 'binary').length, 2);
    assert.equal(observer.closeInfo, null, 'two complete large maps fit the bounded socket queue');
  }
  await mapHost.close(); await mapGuest.close();
  for (const mode of ['tdm', 'snd']) {
    const host = client(`${mode} asymmetric host`);
    const guest = client(`${mode} asymmetric guest`);
    const welcome = await host.join({ firstFrame: { t: 'create', name: 'Host', bots: 6, gameMode: mode, map: 'foundry' } });
    await guest.join({ firstFrame: { t: 'join', name: 'Guest', lobby: welcome.lobby.code } });
    const joined = await host.waitForJson(m => m.t === 'lobbyState' && m.members.length === 8, 'eight planned operators');
    assert.equal(joined.members.filter(row => row.bot).length, 6);
    const unauthorized = guest.mark();
    guest.send({ t: 'team', id: 'bot-0', team: 'alpha' });
    assert.match((await guest.waitForJson(m => m.t === 'error', 'bot assignment permission', unauthorized)).msg, /Only the host/);
    host.send({ t: 'team', id: host.id, team: 'alpha' });
    host.send({ t: 'team', id: guest.id, team: 'alpha' });
    for (let i = 0; i < 6; i++) host.send({ t: 'team', id: `bot-${i}`, team: 'bravo' });
    const chosen = await host.waitForJson(m => m.t === 'lobbyState' && m.members.length === 8
      && m.members.filter(row => !row.bot).every(row => row.team === 'alpha')
      && m.members.filter(row => row.bot).every(row => row.team === 'bravo'), '2 vs 6 roster');
    assert.deepEqual(teamCounts(chosen.members), { alpha: 2, bravo: 6 });
    const reconfigure = host.mark();
    host.send({ t: 'configure', gameMode: mode, map: 'citadel', bots: 6 });
    const preserved = await host.waitForJson(m => m.t === 'lobbyState' && m.map === 'citadel', 'map preserves teams', reconfigure);
    assert.deepEqual(preserved.members.map(row => [row.id, row.team]), chosen.members.map(row => [row.id, row.team]));
    host.send({ t: 'ready', value: true }); guest.send({ t: 'ready', value: true });
    await host.waitForJson(m => m.t === 'lobbyState' && m.members.every(row => row.ready), 'ready operators', reconfigure);
    const launch = host.mark();
    host.send({ t: 'start' });
    const tick = await host.waitForJson(m => m.t === 'tick' && m.players.length === 8, '2 vs 6 live launch', launch);
    assert.deepEqual(teamCounts(tick.players), { alpha: 2, bravo: 6 });
    for (const row of chosen.members) assert.equal(tick.players.find(p => p.id === row.id)?.team, row.team);
    if (mode === 'snd') assert.ok([host.id, guest.id].includes(tick.match.bomb.carrier), 'bomb belongs to an attacker');
    const locked = host.mark();
    host.send({ t: 'team', id: 'bot-0', team: 'alpha' });
    assert.match((await host.waitForJson(m => m.t === 'error', 'live teams locked', locked)).msg, /already started/);
    await host.close(); await guest.close();
    console.log(`${mode}: 2 humans vs 6 assigned bots launches intact after map change`);

    const full = client(`${mode} 16 vs 16`);
    await full.join({ firstFrame: { t: 'create', name: 'Host', bots: 31, gameMode: mode, map: 'harbor' } });
    const planned = await full.waitForJson(m => m.t === 'lobbyState' && m.members.length === 32, '32 operator waiting roster');
    assert.deepEqual(teamCounts(planned.members), { alpha: 16, bravo: 16 });
    const rejected = full.mark();
    full.send({ t: 'team', id: 'bot-0', team: 'alpha' });
    assert.match((await full.waitForJson(m => m.t === 'error', 'team capacity enforced', rejected)).msg, /16/);
    full.send({ t: 'ready', value: true });
    full.send({ t: 'start' });
    const fullTick = await full.waitForJson(m => m.t === 'tick' && m.players.length === 32, '16 vs 16 live launch');
    assert.deepEqual(teamCounts(fullTick.players), { alpha: 16, bravo: 16 });
    assert.equal(new Set(fullTick.players.map(row => row.id)).size, 32);
    const late = client(`${mode} live replacement`);
    await late.join({ firstFrame: { t: 'join', name: 'Late', lobby: full.welcome.lobby.code } });
    const liveRoster = await late.waitForJson(m => m.t === 'lobbyState' && m.bots === 30, 'human replaces live bot');
    assert.equal(liveRoster.members.length, 32);
    assert.deepEqual(teamCounts(liveRoster.members), { alpha: 16, bravo: 16 });
    await full.close(); await late.close();
    console.log(`${mode}: 16 vs 16 with 31 bots and live human replacement preserves 32 operators`);
  }

  // Thirty-two independent sockets receive admission and full authoritative frames.
  const humans = [];
  const host = client('capacity host'); humans.push(host);
  const welcome = await host.join({ firstFrame: { t: 'create', name: 'Host', bots: 0, gameMode: 'tdm', map: 'harbor' } });
  for (let i = 1; i < 32; i++) {
    const human = client(`human ${i}`); humans.push(human);
    await human.join({ firstFrame: { t: 'join', name: `Human ${i}`, lobby: welcome.lobby.code } });
  }
  const roster = await host.waitForJson(m => m.t === 'lobbyState' && m.members.length === 32, '32 human admission');
  assert.equal(roster.members.filter(row => !row.bot).length, 32);
  assert.deepEqual(teamCounts(roster.members), { alpha: 16, bravo: 16 });
  const listing = await (await fetch(`http://127.0.0.1:${port}/api/lobbies`)).json();
  const roomListing = listing.lobbies.find(room => room.code === welcome.lobby.code);
  assert.equal(roomListing.capacity, 32); assert.equal(roomListing.players, 32);
  const overflow = client('overflow');
  await overflow.connect({ t: 'join', name: 'Overflow', lobby: welcome.lobby.code });
  assert.match((await overflow.waitForJson(m => m.t === 'error', '33rd rejected')).msg, /full/);
  assert.equal((await overflow.waitForClose()).code, 4005);
  for (const human of humans) human.send({ t: 'ready', value: true });
  await host.waitForJson(m => m.t === 'lobbyState' && m.members.length === 32 && m.members.every(row => row.ready), '32 ready humans');
  host.send({ t: 'start' });
  const ticks = await Promise.all(humans.map(human => human.waitForJson(m => m.t === 'tick' && m.players.length === 32, '32 human gameplay')));
  for (const tick of ticks) assert.deepEqual(teamCounts(tick.players), { alpha: 16, bravo: 16 });
  console.log('32 real WebSocket players admitted and started; 33rd rejected with lobby-full code');
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
  await stopServer(server);
}

console.log('Large lobby acceptance passed.');
