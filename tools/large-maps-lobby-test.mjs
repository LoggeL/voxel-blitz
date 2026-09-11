import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createMapState } from '../shared/worlddata.js';
import { boxCollides } from '../shared/player-movement.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';

const server = startServer({ cwd: fileURLToPath(new URL('..', import.meta.url)) });
const clients = [];
try {
  const port = await server.port;
  for (const map of ['harbor', 'canyon']) for (const mode of ['tdm', 'snd']) {
    const host = new Client(port, `${map}-${mode}`);
    clients.push(host);
    await host.connect({ t: 'create', name: host.name, map: 'foundry', gameMode: mode, bots: 31 });
    await host.waitForHandshake();
    const mark = host.mark();
    host.send({ t: 'configure', gameMode: mode, map, bots: 31 });
    const config = await host.waitForJsonFrame(m => m.t === 'lobbyConfig', 'large map configuration', mark);
    const binary = await host.waitForFrame(f => f.kind === 'binary', 'large map bytes', config.seq);
    const world = createMapState(map);
    assert.equal(binary.seq, config.seq + 1);
    assert.equal(config.value.mapBytes, binary.value.byteLength);
    assert.deepEqual(new Uint8Array(binary.value), world.serializeWorld());
    const readyMark = host.mark();
    host.send({ t: 'ready', value: true });
    await host.waitForJson(m => m.t === 'lobbyState' && m.members.some(p => p.id === host.id && p.ready), 'ready', readyMark);
    host.send({ t: 'start' });
    const tick = await host.waitForJson(m => m.t === 'tick' && m.players.length === 32, '32-player large match', readyMark);
    assert.equal(tick.match.map, map);
    assert.equal(tick.match.mode, mode);
    assert.equal(tick.players.filter(p => p.team === 'alpha').length, 16);
    assert.equal(tick.players.filter(p => p.team === 'bravo').length, 16);
    assert.equal(new Set(tick.players.map(p => `${p.x},${p.y},${p.z}`)).size, 32);
    for (const p of tick.players) {
      assert.ok(p.x >= 3 && p.x < 189 && p.z >= 3 && p.z < 141);
      assert.equal(boxCollides((x, y, z) => world.getBlock(x, y, z) !== 0, p.x, p.y, p.z), false);
    }
    assert.ok(tick.players.some(p => p.x > 128 || p.z > 96), 'players use the expanded area');
    await host.close();
    console.log(`${map} ${mode}: legacy-to-large map transfer and 16-vs-16 live admission passed.`);
  }
} finally {
  await Promise.all(clients.map(client => client.close()));
  await stopServer(server);
}
