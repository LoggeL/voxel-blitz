// Conquest lobby over the real server: configure, compressed map decode, 16
// roster slots, waiting admission and the v2 live snapshot (slim match.conquest,
// cq/cqs rows, fleet from the map metadata).
import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { deserializeBlocks } from '../shared/world/serialize.js';
import { CONQUEST_CONTRACT_VERSION, decodeConquestPlayer, decodeConquestStats, FLAG_STATES, KIT_IDS } from '../shared/conquest-contract.js';
import { decodeConquestMatch } from '../shared/conquest.js';
import {
  CONQUEST_CQ_LENGTH, CONQUEST_CQ_MAX_LENGTH, CONQUEST_CQS_LENGTH, CONQUEST_FLAG_TUPLE_LENGTH, CONQUEST_MATCH_BUDGET_BYTES, CONQUEST_MATCH_KEYS,
  CONQUEST_PLAYER_KEYS, CONQUEST_SQUAD_TUPLE_LENGTH, CONQUEST_STATE_KEYS,
} from './lib/protocol-contract.mjs';

const server = startServer();
const clients = [];
try {
  const port = await server.port;
  const host = new Client(port, 'Conquest host', { handshakeTimeout: 30000, frameTimeout: 30000 });
  clients.push(host);
  await host.connect({ t: 'create', name: 'Conquest host', bots: 0, gameMode: 'tdm', map: 'foundry', contract: CONQUEST_CONTRACT_VERSION });
  await host.waitForHandshake();
  const mark = host.sequence;
  host.send({ t: 'configure', gameMode: 'conquest', map: 'frontier', bots: 15 });
  const config = await host.waitForJsonFrame(m => m.t === 'lobbyConfig', 'configuration', mark, 30000);
  const welcome = config.value;
  const frame = await host.waitForFrame(f => f.kind === 'binary', 'replacement world', config.seq, 30000);
  assert.equal(welcome.gameMode, 'conquest');
  assert.equal(welcome.map, 'frontier');
  const bytes = new Uint8Array(frame.value);
  assert.equal(bytes[2], 2);
  assert.equal(bytes[3], 1, 'large map uses compressed RLE');
  const decoded = deserializeBlocks(bytes), expected = deserializeBlocks(createMapState('frontier').serializeWorld());
  assert.deepEqual(decoded.dimensions, expected.dimensions);
  assert.deepEqual(decoded.blocks, expected.blocks);
  const lobby = await host.waitForJson(m => m.t === 'lobbyState' && m.gameMode === 'conquest', 'Conquest lobby');
  assert.equal(lobby.bots + lobby.members.filter(p => !p.bot).length, 16);
  host.send({ t: 'input', vehicleAction: { type: 'enter', vehicleId: 'alpha-tank' }, wantFire: true, keys: { f: true } });
  host.send({ t: 'ready', value: true });
  host.send({ t: 'start' });
  const tick = await host.waitForJson(m => m.t === 'tick' && m.match?.mode === 'conquest', 'live Conquest');
  const meta = getMapMeta('frontier').conquest;
  assert.equal(tick.players.length, 16, 'human and bots share the 16 slots');
  // A flag-bound pad without a team (flag-C-tank) stays inactive and unlisted until its flag is first captured.
  const activePads = meta.vehicleSpawns.filter(s => !(typeof s.flag === 'string' && s.team == null));
  assert(activePads.length < meta.vehicleSpawns.length, 'the neutral flag pad starts inactive');
  assert.deepEqual(tick.vehicles.map(v => v.id).sort(), activePads.map(s => s.id).sort(), 'the fleet comes from the map metadata');
  for (const team of ['alpha', 'bravo']) {
    assert.deepEqual(tick.vehicles.filter(v => v.team === team).map(v => v.type).sort(),
      meta.vehicleSpawns.filter(s => s.team === team).map(s => s.type).sort(), `${team} hulls`);
  }
  assert.equal(tick.players.find(p => p.id === welcome.id).vehicleId, null, 'waiting input cannot seize a vehicle');

  const conquest = tick.match.conquest;
  assert.equal(conquest.v, 2);
  assert.equal(Object.keys(tick.match).sort().join(','), CONQUEST_MATCH_KEYS, 'match keys');
  assert.equal(Object.keys(conquest).sort().join(','), CONQUEST_STATE_KEYS, 'slim match.conquest');
  assert(Buffer.byteLength(JSON.stringify(conquest)) <= CONQUEST_MATCH_BUDGET_BYTES, 'match.conquest fits its 400 B budget');
  assert(conquest.flags.every(f => f.length === CONQUEST_FLAG_TUPLE_LENGTH));
  assert(conquest.squads.every(s => s.length === CONQUEST_SQUAD_TUPLE_LENGTH));
  assert.equal(conquest.flags.length, meta.flags.length);
  assert.deepEqual(conquest.tickets, tick.match.scores);
  assert(conquest.tickets.alpha > 0 && conquest.tickets.bravo > 0);
  assert(conquest.endsAt > tick.now, 'the time limit lies ahead');
  const rich = decodeConquestMatch(conquest, meta);
  for (const flag of rich.flags) {
    const source = meta.flags.find(f => f.id === flag.id);
    assert.equal(flag.x, source.x);
    assert(FLAG_STATES.includes(flag.state));
    assert.equal(flag.owner, source.home ?? null, `${flag.id} starts with its home owner`);
  }
  assert.equal(conquest.squads.length, 4, 'two squads of four per team');
  for (const row of tick.players) {
    const cq = decodeConquestPlayer(row);
    assert(cq && KIT_IDS.includes(cq.kit) && cq.squad > 0, `${row.id} carries cq`);
    assert.deepEqual(Object.keys(decodeConquestStats(row)), ['objective', 'vehicles', 'revives', 'captures']);
    // A grounded body has 7 cq entries; the optional 8th is the parachute state (1 or 2).
    assert((row.cq.length === CONQUEST_CQ_LENGTH || (row.cq.length === CONQUEST_CQ_MAX_LENGTH && [1, 2].includes(row.cq[7])))
      && row.cqs.length === CONQUEST_CQS_LENGTH);
    assert.equal(Object.keys(row).filter(k => k !== 'attachments').sort().join(','), CONQUEST_PLAYER_KEYS, `${row.id} carries the complete Conquest row`);
  }
  console.log('Conquest lobby: configure, compressed map decode, authoritative bytes, 16 roster slots, waiting admission and the v2 live snapshot (slim match.conquest within 400 B, home flags, squads, cq/cqs rows, metadata fleet) verified.');
} finally {
  await Promise.all(clients.map(c => c.close()));
  await stopServer(server);
}
