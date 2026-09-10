import assert from 'node:assert/strict';
import { LobbyManager } from '../server/lobby.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';

const manager = new LobbyManager({ sendJson() {}, sendFrame() {}, closeClient() {} });
for (const gameMode of ['tdm', 'snd']) {
  const host = { id: `${gameMode}-host` }, guest = { id: `${gameMode}-guest` };
  assert.equal(await manager.create(host, 'Host', 2, gameMode, 'foundry'), true);
  assert.equal(await manager.join(guest, 'Guest', host.room.code), true);
  const room = host.room;
  manager.ready(host, true); manager.ready(guest, true);
  assert.equal(manager.setTeam(guest, guest.id, 'alpha'), false, 'members cannot change even their own team');
  assert.equal(manager.setTeam(host, guest.id, 'alpha'), true);
  assert.equal(room.engine.mode.teamFor(guest.id), 'alpha');
  assert.equal(room.engine.entities.get(guest.id).team, 'alpha');
  assert.ok([...room.members.values()].every(member => !member.ready));
  assert.equal(manager.setTeam(guest, host.id, 'bravo'), false, 'members cannot move others');
  assert.equal(manager.setTeam(host, guest.id, 'orange'), false);
  assert.equal(manager.setTeam(host, 'missing', 'bravo'), false);
  assert.equal(manager.setTeam(host, host.id, 'bravo'), true, 'host can rearrange both teams');
  if (gameMode === 'snd') {
    assert.equal(room.engine.mode.bomb.carrierId, guest.id, 'bomb follows the attacking team');
    assert.equal(room.engine.entities.get(host.id).bomb, false);
  }
  assert.equal(manager.configure(host, { gameMode, map: 'citadel', bots: 2 }), true);
  assert.equal(room.engine.mode.teamFor(host.id), 'bravo', 'map changes preserve selected teams');
  assert.equal(room.engine.mode.teamFor(guest.id), 'alpha');
  for (const id of [host.id, guest.id]) {
    const p = room.engine.entities.get(id);
    const pool = room.engine.mode.policy.spawnPoolFor(p);
    const distance = points => Math.min(...points.map(point => {
      const [x, , z] = Array.isArray(point) ? point : [point.x, point.y, point.z];
      return Math.hypot(p.x - x, p.z - z);
    }));
    const enemy = room.engine.entities.get(id === host.id ? guest.id : host.id);
    assert.ok(distance(pool) < distance(room.engine.mode.policy.spawnPoolFor(enemy)),
      'safe spawn stays closer to the selected team area');
  }
  manager.ready(host, true); manager.ready(guest, true);
  assert.equal(manager.start(host), true);
  room.engine.stop();
  assert.equal(room.engine.mode.teamFor(host.id), 'bravo', 'launch keeps human selections');
  const teams = [...room.engine.entities.values()].map(p => room.engine.mode.teamFor(p));
  assert.equal(teams.filter(team => team === 'alpha').length, 2);
  assert.equal(teams.filter(team => team === 'bravo').length, 2, 'bots fill the smaller teams');
  assert.equal(manager.setTeam(host, guest.id, 'bravo'), false, 'teams are locked after launch');
  manager.leave(host); manager.leave(guest);
}

// Real transport: only the host can assign teams, and every member receives changes.
const server = startServer({ failureContext: 'team selection' });
const clients = [];
try {
  const port = await server.port;
  for (const gameMode of ['tdm', 'snd']) {
    const host = new Client(port, `${gameMode} host`);
    const guest = new Client(port, `${gameMode} guest`);
    clients.push(host, guest);
    const welcome = await host.join({ firstFrame: { t: 'create', name: 'Host', bots: 0, gameMode, map: 'foundry' } });
    await guest.join({ firstFrame: { t: 'join', name: 'Guest', lobby: welcome.lobby.code } });
    await host.waitForJson(m => m.t === 'lobbyState' && m.members.length === 2, 'both joined');
    const since = host.frames.length;
    host.send({ t: 'team', id: guest.id, team: 'alpha' });
    const changed = await host.waitForJson(m => m.t === 'lobbyState' &&
      m.members.find(p => p.id === guest.id)?.team === 'alpha', 'host team selection broadcast', since);
    assert.equal(changed.members.find(p => p.id === host.id).team, 'alpha');
    const errorSince = guest.frames.length;
    guest.send({ t: 'team', id: host.id, team: 'bravo' });
    const rejected = await guest.waitForJson(m => m.t === 'error', 'unauthorized change', errorSince);
    assert.match(rejected.msg, /Only the host/);
    const selfErrorSince = guest.frames.length;
    guest.send({ t: 'team', id: guest.id, team: 'bravo' });
    const selfRejected = await guest.waitForJson(m => m.t === 'error', 'self change rejected', selfErrorSince);
    assert.match(selfRejected.msg, /Only the host/);
    const guestSince = guest.frames.length;
    host.send({ t: 'team', id: host.id, team: 'bravo' });
    await guest.waitForJson(m => m.t === 'lobbyState' &&
      m.members.find(p => p.id === host.id)?.team === 'bravo', 'host choice reaches guest', guestSince);
    host.send({ t: 'ready', value: true }); guest.send({ t: 'ready', value: true });
    await host.waitForJson(m => m.t === 'lobbyState' && m.members.every(p => p.ready), 'everyone ready');
    host.send({ t: 'start' });
    const tick = await host.waitForJson(m => m.t === 'tick', 'first authoritative frame');
    assert.equal(tick.players.find(p => p.id === host.id).team, 'bravo');
    assert.equal(tick.players.find(p => p.id === guest.id).team, 'alpha');
    for (const event of tick.events) {
      if (event.kind === 'team_assigned') {
        assert.equal(event.team, tick.players.find(p => p.id === event.id).team,
          'launch cannot replay an earlier lobby assignment');
      }
      if (event.kind === 'bomb_assigned') assert.equal(event.id, tick.match.bomb.carrier);
    }
    if (gameMode === 'snd') assert.equal(tick.match.bomb.carrier, guest.id);
    await host.close(); await guest.close();
  }
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
  await stopServer(server);
}
console.log('Team selection passed: permissions, readiness, map persistence, spawns, bomb ownership, bot balance and real WebSocket launch.');
