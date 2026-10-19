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
  CONQUEST_PLAYER_KEYS, CONQUEST_SQUAD_TUPLE_LENGTH, CONQUEST_STATE_KEYS, CONQUEST_WEATHER_TUPLE_LENGTH,
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
  assert(Buffer.byteLength(JSON.stringify(conquest)) <= CONQUEST_MATCH_BUDGET_BYTES, 'match.conquest fits its 440 B budget');
  assert(conquest.flags.every(f => f.length === CONQUEST_FLAG_TUPLE_LENGTH));
  assert(conquest.squads.every(s => s.length === CONQUEST_SQUAD_TUPLE_LENGTH));
  assert.equal(conquest.wx.length, CONQUEST_WEATHER_TUPLE_LENGTH, 'the weather tuple rides every Conquest tick');
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

  // Deploy before the first spawn (ConquestPolicy.gateDeploy): a joining human waits unspawned on the
  // deploy screen while the bots spawn at once; DEPLOY spawns it at the chosen point, like after a death.
  const isBot = row => /^bot-\d+$/.test(row.id);
  const rowOf = (msg, id) => msg.players.find(p => p.id === id);
  const near = (row, cells, radius) => cells.some(c => Math.hypot(row.x - c.x, row.z - c.z) <= radius);
  const hostRow = rowOf(tick, welcome.id);
  assert.equal(hostRow.state, 'dead', 'the joining human waits on the deploy screen, unspawned');
  assert.equal(hostRow.deaths, 0, 'waiting to deploy is no death');
  assert(Number.isFinite(hostRow.respawnAt) && hostRow.respawnAt <= tick.now, 'the deploy screen may deploy at once');
  assert(tick.players.filter(isBot).length === 15 && tick.players.filter(isBot).every(p => p.state === 'alive'), 'bots spawn at once');
  const waited = await host.waitForJson(m => m.t === 'tick' && m.now >= tick.now + 1500, 'the human idles on the deploy screen', host.mark());
  assert.equal(rowOf(waited, welcome.id).state, 'dead', 'no spawn without a deploy');
  assert.equal(rowOf(waited, welcome.id).deaths, 0, 'waiting is still no death');
  const team = hostRow.team;
  const homeFlag = meta.flags.find(f => f.home === team);
  host.input(1);
  let at = host.mark();
  host.send({ t: 'conquest', deploy: { spawn: `flag:${homeFlag.id}`, kit: 'assault', variant: 0 } });
  const deployed = await host.waitForJson(m => m.t === 'tick' && rowOf(m, welcome.id)?.state === 'alive', 'the human deploys', at);
  const hostAlive = rowOf(deployed, welcome.id);
  assert(near(hostAlive, homeFlag.spawns.length ? homeFlag.spawns : [homeFlag], 8), `deployed at the chosen flag ${homeFlag.id}`);
  assert.equal(hostAlive.deaths, 0, 'the first deploy is no respawn after a death');

  // A mid-match join takes over a bot's slot and also starts on the deploy screen.
  const guest = new Client(port, 'Late joiner', { handshakeTimeout: 30000, frameTimeout: 30000 });
  clients.push(guest);
  const guestWelcome = await guest.join({ firstFrame: { t: 'join', name: 'Late joiner', lobby: welcome.lobby.code, contract: CONQUEST_CONTRACT_VERSION } });
  assert.equal(guestWelcome.phase, 'live');
  const guestTick = await guest.waitForJson(m => m.t === 'tick' && rowOf(m, guestWelcome.id), 'the late joiner in the match');
  assert.equal(guestTick.players.length, 16, 'the late joiner took over a bot slot');
  assert.equal(rowOf(guestTick, guestWelcome.id).state, 'dead', 'a mid-match join waits on the deploy screen');
  assert.equal(rowOf(guestTick, welcome.id).state, 'alive', 'a join leaves the deployed host alone');
  const guestTeam = rowOf(guestTick, guestWelcome.id).team;
  const hqCells = getMapMeta('frontier').spawns.conquest[guestTeam];
  guest.input(1);
  at = guest.mark();
  guest.send({ t: 'conquest', deploy: { spawn: 'hq', kit: 'assault', variant: 0 } });
  const guestDeployed = await guest.waitForJson(m => m.t === 'tick' && rowOf(m, guestWelcome.id)?.state === 'alive', 'the late joiner deploys', at);
  assert(near(rowOf(guestDeployed, guestWelcome.id), hqCells, 6), 'deployed at the chosen HQ');

  // A death still opens the deploy screen and DEPLOY spawns again after the respawn delay.
  at = guest.mark();
  await new Promise(resolve => setTimeout(resolve, 300));
  guest.send({ t: 'conquest', redeploy: 1 });
  const died = await guest.waitForJson(m => m.t === 'tick' && rowOf(m, guestWelcome.id)?.state === 'dead', 'the late joiner redeploys', at);
  assert.equal(rowOf(died, guestWelcome.id).deaths, 1, 'a redeploy is a death');
  at = guest.mark();
  guest.send({ t: 'conquest', deploy: { spawn: 'hq', kit: 'assault', variant: 0 } });
  const again = await guest.waitForJson(m => m.t === 'tick' && rowOf(m, guestWelcome.id)?.state === 'alive', 'the late joiner deploys again', at);
  assert(again.now >= rowOf(died, guestWelcome.id).respawnAt, 'the respawn delay still applies after a death');
  console.log('Conquest lobby: configure, compressed map decode, authoritative bytes, 16 roster slots, waiting admission and the v2 live snapshot (slim match.conquest within 440 B, home flags, squads, cq/cqs rows, metadata fleet), deploy before the first spawn (start and mid-match join wait unspawned, bots spawn at once, DEPLOY at the chosen flag / HQ, death and deploy again) verified.');
} finally {
  await Promise.all(clients.map(c => c.close()));
  await stopServer(server);
}
