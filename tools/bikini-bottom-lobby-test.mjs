// Bikini Bottom through the real server: every compatible mode admits the
// map, ships the shared template bytes and reaches a live match on dry ground.
import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';
import { createMapState } from '../shared/worlddata.js';
const server = startServer({ cwd: new URL('..', import.meta.url).pathname });
const clients = [];
const template = createMapState('bikini_bottom').serializeWorld();
try {
  const port = await server.port;
  for (const mode of ['fun', 'ttt', 'duel', 'chaos', 'tdm', 'snd', 'gungame']) {
    const client = new Client(port, `BikiniBottom-${mode}`); clients.push(client);
    await client.connect({ t: 'create', name: `BikiniBottom-${mode}`, bots: mode === 'duel' ? 1 : 2,
      gameMode: mode, map: 'bikini_bottom' });
    const { welcome, map } = await client.waitForHandshake();
    assert.equal(welcome.map, 'bikini_bottom');
    assert.equal(welcome.gameMode, mode);
    assert.deepEqual(new Uint8Array(map), template, 'authoritative bytes equal the shared template');
    const state = await client.waitForJson((m) => m.t === 'lobbyState', 'lobby');
    assert.equal(state.map, 'bikini_bottom');
    let guest = null;
    if (mode === 'duel') {
      // A duel takes no bots: a second human completes the pair.
      guest = new Client(port, 'BikiniBottom-duel-guest'); clients.push(guest);
      await guest.connect({ t: 'join', name: 'BikiniBottom-duel-guest', lobby: welcome.lobby.code });
      const joined = await guest.waitForHandshake();
      assert.deepEqual(new Uint8Array(joined.map), template, 'the guest receives the same bytes');
      guest.send({ t: 'ready', value: true });
    }
    client.send({ t: 'ready', value: true });
    client.send({ t: 'start' });
    const tick = await client.waitForJson((m) => m.t === 'tick', 'live match');
    const me = tick.players.find((p) => p.id === welcome.id);
    assert.ok(me, 'the host is in the live snapshot');
    assert.ok(tick.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)));
    assert.ok(me.y > 14 && me.y < 20, 'the host spawns on the seafloor');
    assert.equal(me.swimming, false, 'the spawn is dry');
    console.log(`Bikini Bottom ${mode}: map bytes, admission and live match verified.`);
    await client.close();
    await guest?.close();
  }
} finally { await Promise.all(clients.map((c) => c.close())); await stopServer(server); }
