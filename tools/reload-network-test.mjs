import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';
import { WEAPONS } from '../shared/combatmath.js';

const server = startServer();
let client;
try {
  client = new Client(await server.port, 'ReloadWire');
  await client.join();
  const row = message => message?.players?.find(p => p.id === client.id);
  let seq = 0;
  const send = overrides => client.send({ t: 'input', seq: ++seq, keys: {},
    yaw: 0, pitch: 1, weapon: 0, wantFire: false, ...overrides });
  send({ wantFire: true });
  await client.waitForJson(m => row(m)?.mag[0] < WEAPONS.rifle.magSize, 'a fired round');
  const mark = client.mark();
  send({ reload: true, reloadId: 1 });
  const active = row(await client.waitForJson(m => row(m)?.reloading && row(m)?.reloadAck === 1,
    'identified reload acceptance', mark));
  assert(active.reloadState.seconds > 0);
  assert(active.reloadState.elapsed >= 0);
  assert.equal(active.mag[0], 0);
  const done = row(await client.waitForJson(m => row(m)?.reloadAck === 1 && !row(m)?.reloading,
    'identified reload completion', client.mark()));
  assert.equal(done.mag[0], WEAPONS.rifle.magSize);
  assert.equal(done.reserve[0], WEAPONS.rifle.spareMags - 1);
  assert.equal(done.reloadState, null);
  // The same held ID remains inert even after another shot makes room.
  send({ wantFire: true, reload: true, reloadId: 1 });
  const shot = row(await client.waitForJson(m => row(m)?.mag[0] < WEAPONS.rifle.magSize,
    'shot after reload', client.mark()));
  assert.equal(shot.reloading, false);
  send({ reload: true, reloadId: 2 });
  const again = row(await client.waitForJson(m => row(m)?.reloadAck === 2,
    'second distinct request', client.mark()));
  assert.equal(again.reloading, true);
  console.log('Reload wire: real server accepts IDs, publishes timing and completion, ignores repeated IDs and accepts the next request.');
} finally {
  await client?.close();
  await stopServer(server);
}
