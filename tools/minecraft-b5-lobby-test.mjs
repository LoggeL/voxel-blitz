import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';
import { createMapState } from '../shared/worlddata.js';
const server = startServer();
const clients = [];
const template = createMapState('minecraft_b5').serializeWorld();
try {
  const port = await server.port;
  for (const mode of ['fun', 'chaos', 'tdm', 'gungame', 'ttt']) {
    const client = new Client(port, `Minecraft-${mode}`); clients.push(client);
    await client.connect({ t: 'create', name: `Minecraft-${mode}`, bots: 2, gameMode: mode, map: 'minecraft_b5' });
    const { welcome, map } = await client.waitForHandshake();
    assert.equal(welcome.map, 'minecraft_b5');
    assert.equal(welcome.gameMode, mode);
    assert.equal(map.byteLength, 6 + 128 * 88 * 96, 'the tall 128 x 96 x 88 world travels on the wire');
    assert.deepEqual(new Uint8Array(map), template, 'authoritative bytes equal the shared template');
    const state = await client.waitForJson((m) => m.t === 'lobbyState', 'lobby');
    assert.equal(state.map, 'minecraft_b5');
    client.send({ t: 'ready', value: true });
    client.send({ t: 'start' });
    const tick = await client.waitForJson((m) => m.t === 'tick', 'live match');
    const me = tick.players.find((p) => p.id === welcome.id);
    assert.ok(me, 'the host is in the live snapshot');
    assert.ok(tick.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)));
    assert.ok(me.y > 1 && me.y < 87, 'the host spawns inside the tall world');
    assert.equal(me.teleport, 0, 'no portal has fired at spawn');
    assert.equal(typeof me.swimming, 'boolean', 'swimming state is on the wire');
    console.log(`Minecraft B5 ${mode}: map bytes, admission and live match verified.`);
    await client.close();
  }
} finally { await Promise.all(clients.map((c) => c.close())); await stopServer(server); }
