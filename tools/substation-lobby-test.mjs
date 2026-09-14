import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';
import { createMapState } from '../shared/worlddata.js';
import { isTrainingDummyId } from '../shared/modes.js';
const server = startServer({ cwd: new URL('..', import.meta.url).pathname });
const clients = [];
const template = createMapState('substation').serializeWorld();
try {
  const port = await server.port;
  for (const mode of ['fun', 'chaos', 'tdm', 'gungame', 'ttt', 'training']) {
    const client = new Client(port, `Substation-${mode}`); clients.push(client);
    await client.connect({ t: 'create', name: `Substation-${mode}`, bots: 2, gameMode: mode, map: 'substation' });
    const { welcome, map } = await client.waitForHandshake();
    assert.equal(welcome.map, 'substation');
    assert.equal(welcome.gameMode, mode);
    assert.deepEqual(new Uint8Array(map), template, 'authoritative bytes equal the shared template');
    const state = await client.waitForJson((m) => m.t === 'lobbyState', 'lobby');
    assert.equal(state.map, 'substation');
    assert.equal(state.bots, mode === 'training' ? 0 : 2, 'training seats no combat bots');
    client.send({ t: 'ready', value: true });
    client.send({ t: 'start' });
    const tick = await client.waitForJson((m) => m.t === 'tick', 'live match');
    assert.ok(tick.players.some((p) => p.id === welcome.id));
    assert.ok(tick.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)));
    if (mode === 'training') {
      const dummies = tick.players.filter((p) => isTrainingDummyId(p.id));
      assert.equal(dummies.length, 10, 'all ten range dummies are live on the switchyard');
      assert.ok(dummies.every((p) => Math.floor(p.y) === 15), 'dummies stand on the yard floor');
    }
    console.log(`Substation ${mode}: map bytes, admission and live match verified.`);
    await client.close();
  }
} finally { await Promise.all(clients.map((c) => c.close())); await stopServer(server); }
