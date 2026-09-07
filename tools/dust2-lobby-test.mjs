import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createMapState } from '../shared/worlddata.js';
import { boxCollides } from '../shared/player-movement.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';

const combatModes = ['fun', 'chaos', 'tdm', 'snd', 'gungame'];
const dust2 = createMapState('dust2');
const templates = new Map(['dust2', 'foundry'].map(id => [id, createMapState(id).serializeWorld()]));
const server = startServer({ cwd: fileURLToPath(new URL('..', import.meta.url)) });
const clients = [];

function assertMapFrame(config, binary, mapId, mode) {
  assert.equal(config.map, mapId);
  assert.equal(config.gameMode, mode);
  assert.equal(config.mapBytes, binary.byteLength);
  assert.deepEqual(new Uint8Array(binary), templates.get(mapId), `${mapId} authoritative map bytes`);
}

async function configure(host, members, mapId, mode) {
  const marks = members.map(client => client.mark());
  host.send({ t: 'configure', gameMode: mode, map: mapId, bots: 2 });
  await Promise.all(members.map(async (client, i) => {
    const config = await client.waitForJsonFrame(m => m.t === 'lobbyConfig', 'map configuration', marks[i]);
    const binary = await client.waitForFrame(f => f.kind === 'binary', 'replacement map', config.seq);
    assert.equal(binary.seq, config.seq + 1, 'replacement map immediately follows its configuration');
    assertMapFrame(config.value, binary.value, mapId, mode);
    assert.equal(config.value.id, client.id, 'map changes preserve the player identity and socket');
    const state = await client.waitForJson(m => m.t === 'lobbyState', 'updated lobby', binary.seq);
    assert.equal(state.map, mapId);
    assert.equal(state.gameMode, mode);
    assert.equal(state.phase, 'waiting');
    assert.equal(state.bots, 2);
    assert.equal(state.members.length, members.length);
    assert.ok(state.members.every(member => !member.ready), 'map changes clear every human readiness');
  }));
}

try {
  const port = await server.port;
  for (const mode of combatModes) {
    const host = new Client(port, `Dust2-${mode}`);
    const guest = new Client(port, `Guest-${mode}`);
    clients.push(host, guest);
    await host.connect({ t: 'create', name: host.name, bots: 2, gameMode: mode, map: 'dust2' });
    const initial = await host.waitForHandshake();
    assertMapFrame(initial.welcome, initial.map, 'dust2', mode);
    assert.equal(initial.mapFrame.seq, initial.welcomeFrame.seq + 1);
    assert.equal(initial.welcome.phase, 'waiting');
    assert.equal(initial.welcome.lobby.role, 'host');

    await guest.connect({ t: 'join', name: guest.name, lobby: initial.welcome.lobby.code });
    const joined = await guest.waitForHandshake();
    assertMapFrame(joined.welcome, joined.map, 'dust2', mode);
    assert.equal(joined.welcome.lobby.role, 'member');
    assert.notEqual(host.id, guest.id);
    assert.equal(joined.welcome.lobby.code, initial.welcome.lobby.code);

    const readyMark = host.mark();
    host.send({ t: 'ready', value: true });
    guest.send({ t: 'ready', value: true });
    await host.waitForJson(m => m.t === 'lobbyState' && m.members.length === 2
      && m.members.every(member => member.ready), 'ready players', readyMark);
    await configure(host, [host, guest], 'foundry', mode);
    await configure(host, [host, guest], 'dust2', mode);

    const startMarks = [host.mark(), guest.mark()];
    host.send({ t: 'ready', value: true });
    guest.send({ t: 'ready', value: true });
    await host.waitForJson(m => m.t === 'lobbyState' && m.members.every(member => member.ready),
      'ready after map change', startMarks[0]);
    host.send({ t: 'start' });
    await Promise.all([host, guest].map(async (client, i) => {
      const state = await client.waitForJson(m => m.t === 'lobbyState' && m.phase === 'live',
        'live lobby', startMarks[i]);
      assert.equal(state.map, 'dust2');
      assert.equal(state.gameMode, mode);
      assert.equal(state.members.filter(member => member.bot).length, 2);
      const tick = await client.waitForJson(m => m.t === 'tick', 'live Dust 2 match', startMarks[i]);
      assert.equal(tick.match.map, 'dust2');
      assert.equal(tick.match.mode, mode);
      assert.equal(tick.players.length, 4, 'both humans and configured bots enter the match');
      assert.ok(tick.players.some(player => player.id === host.id));
      assert.ok(tick.players.some(player => player.id === guest.id));
      for (const player of tick.players) {
        assert.ok([player.x, player.y, player.z].every(Number.isFinite), 'finite live player position');
        const bounds = dust2.meta.spawnBounds;
        assert.ok(player.x >= bounds.minX && player.x <= bounds.maxX
          && player.z >= bounds.minZ && player.z <= bounds.maxZ, 'live spawn remains in the arena');
        assert.ok(!boxCollides((x, y, z) => dust2.getBlock(x, y, z) !== 0,
          player.x, player.y, player.z), 'live player has full body clearance');
        if (mode === 'tdm' || mode === 'snd') assert.ok(['alpha', 'bravo'].includes(player.team));
      }
      assert.equal(tick.match.bomb !== null, mode === 'snd', 'S&D objective follows the selected mode');
      assert.equal(client.jsonAfter().filter(m => m.t === 'error').length, 0, 'no protocol errors');
    }));
    console.log(`Dust 2 ${mode}: host/invite admission, map replacement, readiness and live humans/bots verified.`);
    await Promise.all([host.close(), guest.close()]);
  }
} finally {
  try { await Promise.all(clients.map(client => client.close())); }
  finally { await stopServer(server); }
}
