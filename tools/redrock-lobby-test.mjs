// Redrock Canyon lobby over the real server: the host picks the second
// battlefield for Conquest (Frontier stays the default), the replacement world
// is Redrock's authoritative template, other modes refuse the Conquest-only
// map, and the live match runs on Redrock's metadata (map id, fleet, flags).
import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { deserializeBlocks } from '../shared/world/serialize.js';
import { CONQUEST_CONTRACT_VERSION } from '../shared/conquest-contract.js';
import { decodeConquestMatch } from '../shared/conquest.js';
import { mapForMode, isModeMapCompatible, MODE_IDS } from '../shared/modes.js';

// Lobby defaults: Frontier for Conquest, Redrock only when asked for, and only in Conquest.
assert.equal(mapForMode('conquest'), 'frontier', 'Frontier stays the default Conquest map');
assert.equal(mapForMode('conquest', 'foundry'), 'frontier');
assert.equal(mapForMode('conquest', 'redrock'), 'redrock');
for (const mode of MODE_IDS) assert.equal(isModeMapCompatible(mode, 'redrock'), mode === 'conquest', `${mode} on redrock`);
assert.notEqual(mapForMode('titanfall', 'redrock'), 'redrock');

const server = startServer();
const clients = [];
try {
  const port = await server.port;
  const host = new Client(port, 'Redrock host', { handshakeTimeout: 30000, frameTimeout: 30000 });
  clients.push(host);
  await host.connect({ t: 'create', name: 'Redrock host', bots: 0, gameMode: 'tdm', map: 'foundry', contract: CONQUEST_CONTRACT_VERSION });
  await host.waitForHandshake();

  // Other modes refuse the Conquest-only battlefield.
  for (const gameMode of ['tdm', 'titanfall', 'fun']) {
    const mark = host.sequence;
    host.send({ t: 'configure', gameMode, map: 'redrock', bots: 0 });
    const refused = await host.waitForJsonFrame(m => m.t === 'error', `${gameMode} on redrock is refused`, mark, 30000);
    assert.match(refused.value.msg, /Invalid lobby settings/);
  }

  let mark = host.sequence;
  host.send({ t: 'configure', gameMode: 'conquest', map: 'redrock', bots: 7 });
  const config = await host.waitForJsonFrame(m => m.t === 'lobbyConfig', 'Redrock configuration', mark, 60000);
  const welcome = config.value;
  assert.equal(welcome.gameMode, 'conquest');
  assert.equal(welcome.map, 'redrock');
  const frame = await host.waitForFrame(f => f.kind === 'binary', 'Redrock world', config.seq, 60000);
  const decoded = deserializeBlocks(new Uint8Array(frame.value));
  const expected = deserializeBlocks(createMapState('redrock').serializeWorld());
  assert.deepEqual(decoded.dimensions, { sx: 768, sy: 80, sz: 768 });
  assert.ok(Buffer.compare(Buffer.from(decoded.blocks), Buffer.from(expected.blocks)) === 0, 'the client receives Redrock\'s authoritative voxels');
  const lobby = await host.waitForJson(m => m.t === 'lobbyState' && m.gameMode === 'conquest' && m.map === 'redrock', 'Redrock lobby');
  assert.equal(lobby.bots, 7);

  host.send({ t: 'ready', value: true });
  host.send({ t: 'start' });
  const tick = await host.waitForJson(m => m.t === 'tick' && m.match?.mode === 'conquest', 'live Redrock match', undefined, 60000);
  const meta = getMapMeta('redrock').conquest;
  assert.equal(tick.match.map, 'redrock', 'the match snapshot names the battlefield');
  const activePads = meta.vehicleSpawns.filter(s => !(typeof s.flag === 'string' && s.team == null));
  assert.deepEqual(tick.vehicles.map(v => v.id).sort(), activePads.map(s => s.id).sort(), 'the fleet comes from Redrock\'s metadata');
  for (const v of tick.vehicles) {
    const pad = meta.vehicleSpawns.find(s => s.id === v.id);
    assert.ok(Math.hypot(v.x - pad.x, v.z - pad.z) < 4, `${v.id} starts on its Redrock pad`);
  }
  const rich = decodeConquestMatch(tick.match.conquest, meta);
  assert.deepEqual(rich.flags.map(f => [f.id, f.x, f.z, f.owner]), meta.flags.map(f => [f.id, f.x, f.z, f.home ?? null]), 'Redrock flags and home owners');
  console.log('Redrock lobby: Conquest-only map choice (Frontier default), refused in other modes, authoritative Redrock voxels, live match on Redrock\'s fleet and flags verified.');
} finally {
  await Promise.all(clients.map(c => c.close()));
  await stopServer(server);
}
