import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';
import { createMapState } from '../shared/worlddata.js';
const server = startServer({ cwd: new URL('..', import.meta.url).pathname });
const clients = [];
const template = createMapState('waterworld').serializeWorld();
try {
  const port = await server.port;
  for (const mode of ['ttt', 'tdm', 'fun']) {
    const client = new Client(port, `Waterworld-${mode}`); clients.push(client);
    await client.connect({ t: 'create', name: `Waterworld-${mode}`, bots: 2, gameMode: mode, map: 'waterworld' });
    const { welcome, map } = await client.waitForHandshake();
    assert.equal(welcome.map, 'waterworld');
    assert.equal(welcome.gameMode, mode);
    assert.equal(map.byteLength, 6 + 200 * 36 * 188, 'the wide 200 x 188 x 36 world travels on the wire');
    assert.deepEqual(new Uint8Array(map), template, 'authoritative bytes equal the shared template');
    const state = await client.waitForJson((m) => m.t === 'lobbyState', 'lobby');
    assert.equal(state.map, 'waterworld');
    client.send({ t: 'ready', value: true });
    client.send({ t: 'start' });
    const tick = await client.waitForJson((m) => m.t === 'tick', 'live match');
    const me = tick.players.find((p) => p.id === welcome.id);
    assert.ok(me, 'the host is in the live snapshot');
    assert.ok(tick.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)));
    assert.ok(me.y > 8 && me.y < 35, 'the host spawns on the foyer floor');
    assert.equal(me.teleport, 0, 'no teleport has fired at spawn');
    assert.equal(me.swimming, false, 'the foyer spawn is dry');
    console.log(`Waterworld ${mode}: map bytes, admission and live match verified.`);
    await client.close();
  }
} finally { await Promise.all(clients.map((c) => c.close())); await stopServer(server); }
