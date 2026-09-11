// End-to-end lobby protocol smoke harness. It observes only frames exchanged
// with a real WebSocket server; no server modules or test hooks are imported.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { pass as assertPass } from './lib/assert.mjs';
import { sleep, withTimeout } from './lib/async.mjs';
import { startServer as startManagedServer, stopServer as stopManagedServer } from './lib/server-process.mjs';
import { Client, SocketTracker } from './lib/ws-client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRAME_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 2_000;
const OVERALL_TIMEOUT_MS = 60_000;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
const MAP_HEADER_BYTES = 6;
const BREAKABLE_BLOCKS = new Set([6, 9, 10, 11]);
const SNIPER_SLOT = 3;
const AUTHORITATIVE_TICK_MS = 50;
const SNIPER_DEPLOY_MS = 1050;
const SNIPER_ADS_MS = 260;
const SNIPER_SPREAD_RAD = 0.02 * Math.PI / 180;
const FRAGILE_CHAIN_BLOCKS = new Set([6, 11]);
const WIRE_POSITION_TOLERANCE = 0.006;
const DEFAULT_GAME_MODE = 'fun';
const DEFAULT_MAP = 'foundry';

let checks = 0;
let activeServer = null;
const clients = new Set();
const socketTracker = new SocketTracker();

function pass(condition, name, detail = '') {
  assertPass(condition, name, detail, () => {
    checks++;
    console.log('OK ' + checks + ' - ' + name);
  });
}

function startServer() {
  return startManagedServer({
    cwd: ROOT,
    portTimeout: START_TIMEOUT_MS,
    portTimeoutMessage: 'server did not advertise its OS-assigned port',
    ringBuffer: 12_000,
    failureContext: 'lobby smoke',
    stopTimeout: STOP_TIMEOUT_MS,
  });
}

async function stopServer(server) {
  await stopManagedServer(server);
}

function makeClient(port, label) {
  const client = new Client(port, label, {
    tracker: socketTracker,
    closeReason: 'lobby smoke complete',
  });
  clients.add(client);
  return client;
}

function validMap(bytes, advertisedLength) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== advertisedLength || bytes.length < MAP_HEADER_BYTES) return false;
  const sx = bytes[3];
  const sz = bytes[4];
  const sy = bytes[5];
  return bytes[0] === 86 && bytes[1] === 66 && bytes[2] > 0 &&
    sx > 0 && sz > 0 && sy > 0 && bytes.length === MAP_HEADER_BYTES + sx * sz * sy;
}

async function admit(
  client,
  firstFrame,
  signal,
  selection = { gameMode: DEFAULT_GAME_MODE, map: DEFAULT_MAP },
) {
  await client.connect(firstFrame, signal);
  const welcomeFrame = await client.waitForFrame(
    (frame) => frame.kind === 'json' && frame.value?.t === 'welcome',
    'welcome frame',
    0,
    FRAME_TIMEOUT_MS,
    signal,
  );
  const mapFrame = await client.waitForFrame(
    (frame) => frame.kind === 'binary',
    'binary map frame',
    0,
    FRAME_TIMEOUT_MS,
    signal,
  );
  const stateFrame = await client.waitForFrame(
    (frame) => frame.kind === 'json' && frame.value?.t === 'lobbyState',
    'initial full lobby state',
    0,
    FRAME_TIMEOUT_MS,
    signal,
  );
  pass(welcomeFrame.seq < mapFrame.seq && mapFrame.seq < stateFrame.seq,
    `${client.label} receives welcome, then map, then lobby state`);
  assertWelcome(welcomeFrame.value, selection, `${client.label} welcome`);
  assertLobbyReplacementShape(stateFrame.value, selection, `${client.label} initial lobby state`);
  pass(validMap(mapFrame.value, welcomeFrame.value.mapBytes),
    `${client.label} receives the advertised complete map`);
  client.welcome = welcomeFrame.value;
  client.map = mapFrame.value;
  client.initialState = stateFrame.value;
  return client;
}

function assertWelcome(welcome, { gameMode = DEFAULT_GAME_MODE, map = DEFAULT_MAP } = {}, label) {
  const topKeys = Object.keys(welcome || {}).sort().join(',');
  const lobbyKeys = Object.keys(welcome?.lobby || {}).sort().join(',');
  const spawnKeys = Object.keys(welcome?.spawn || {}).sort().join(',');
  pass(welcome?.t === 'welcome' &&
    topKeys === 'blockDamage,gameMode,id,lobby,map,mapBytes,phase,spawn,t,tickRate' &&
    Array.isArray(welcome.blockDamage) &&
    lobbyKeys === 'code,role' &&
    spawnKeys === 'x,y,z',
  `${label} is a complete replacement frame`);
  pass(welcome.gameMode === gameMode && welcome.map === map,
    `${label} carries normalized mode and map`,
    `received ${JSON.stringify({ gameMode: welcome.gameMode, map: welcome.map })}`);
}

function assertLobbyReplacementShape(
  state,
  { gameMode = DEFAULT_GAME_MODE, map = DEFAULT_MAP } = {},
  label,
) {
  const topKeys = Object.keys(state || {}).sort().join(',');
  pass(state?.t === 'lobbyState' &&
    topKeys === 'bots,code,gameMode,host,map,members,phase,t',
  `${label} is a complete replacement frame`);
  pass(state.gameMode === gameMode && state.map === map,
    `${label} carries normalized mode and map`,
    `received ${JSON.stringify({ gameMode: state.gameMode, map: state.map })}`);
}

async function expectRejected(client, firstFrame, expectedCode, signal) {
  await client.connect(firstFrame, signal);
  const errorPromise = client.waitForJson(
    (message) => message?.t === 'error' && typeof message.msg === 'string',
    'protocol error frame',
    0,
    FRAME_TIMEOUT_MS,
    signal,
  );
  const closePromise = client.waitForClose(`close code ${expectedCode}`, FRAME_TIMEOUT_MS, signal);
  const [error, close] = await Promise.all([errorPromise, closePromise]);
  pass(close.code === expectedCode,
    `${client.label} closes with ${expectedCode}`,
    `received ${close.code} ${close.reason}`);
  return { error, close };
}

function humanRows(state) {
  return Array.isArray(state?.members) ? state.members.filter((member) => !member.bot) : [];
}

function assertLobbyState(
  state,
  {
    code,
    host,
    phase,
    bots,
    humans,
    botRows = null,
    gameMode = DEFAULT_GAME_MODE,
    map = DEFAULT_MAP,
  },
  label,
) {
  assertLobbyReplacementShape(state, { gameMode, map }, label);
  pass(state.code === code && state.host === host && state.phase === phase && state.bots === bots,
    `${label} carries the room identity, host, phase, and bot target`);
  const rows = humanRows(state);
  const expected = humans.map(({ client, ready }) => ({
    id: client.welcome.id,
    name: client.label,
    ready,
    bot: false,
    team: null,
  }));
  pass(JSON.stringify(rows.map(({ ping, ...row }) => row)) === JSON.stringify(expected),
    `${label} carries the exact human roster`,
    `received ${JSON.stringify(rows)}`);
  pass(state.members.every((member) => Object.keys(member).sort().join(',') === 'bot,id,name,ping,ready,team'),
    `${label} member rows are complete replacements`);
  if (botRows !== null) {
    const actualBots = state.members.filter((member) => member.bot);
    pass(actualBots.length === botRows && actualBots.every((member) => member.ready === false),
      `${label} carries ${botRows} non-ready bot row(s)`);
  }
}

async function nextLobbyState(client, mark, code, signal, predicate = () => true) {
  return client.waitForJson(
    (message) => message?.t === 'lobbyState' && message.code === code && predicate(message),
    `lobby state for ${code}`,
    mark,
    FRAME_TIMEOUT_MS,
    signal,
  );
}

async function nextTick(client, mark, predicate, description, signal) {
  return client.waitForJson(
    (message) => message?.t === 'tick' && predicate(message),
    description,
    mark,
    FRAME_TIMEOUT_MS,
    signal,
  );
}

function assertRoomScoped(client, code, foreignIds, label) {
  const states = client.frames
    .filter((frame) => frame.kind === 'json' && frame.value?.t === 'lobbyState')
    .map((frame) => frame.value);
  const ticks = client.frames
    .filter((frame) => frame.kind === 'json' && frame.value?.t === 'tick')
    .map((frame) => frame.value);
  pass(states.length > 0 && states.every((state) => state.code === code),
    `${label} receives lobby replacements only for ${code}`);
  pass(ticks.every((tick) => tick.players.every((row) => !foreignIds.has(row.id))),
    `${label} never receives foreign player ids`);
}

function mapView(bytes) {
  if (!validMap(bytes, bytes.length)) throw new Error('cannot inspect an invalid map frame');
  const sx = bytes[3];
  const sz = bytes[4];
  const sy = bytes[5];
  const index = (x, y, z) => ((y * sz) + z) * sx + x;
  const get = (x, y, z) => {
    if (x < 0 || z < 0 || y < 0 || x >= sx || z >= sz || y >= sy) return 255;
    return bytes[MAP_HEADER_BYTES + index(x, y, z)];
  };
  return { bytes, sx, sz, sy, index, get };
}

function firstSolid(map, origin, direction, limit) {
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);
  const stepX = Math.sign(direction.x);
  const stepY = Math.sign(direction.y);
  const stepZ = Math.sign(direction.z);
  const deltaX = stepX === 0 ? Infinity : Math.abs(1 / direction.x);
  const deltaY = stepY === 0 ? Infinity : Math.abs(1 / direction.y);
  const deltaZ = stepZ === 0 ? Infinity : Math.abs(1 / direction.z);
  let maxX = stepX === 0 ? Infinity : ((stepX > 0 ? x + 1 : x) - origin.x) / direction.x;
  let maxY = stepY === 0 ? Infinity : ((stepY > 0 ? y + 1 : y) - origin.y) / direction.y;
  let maxZ = stepZ === 0 ? Infinity : ((stepZ > 0 ? z + 1 : z) - origin.z) / direction.z;
  let distance = 0;

  for (let steps = 0; steps < 2_000 && distance <= limit; steps++) {
    if (maxX <= maxY && maxX <= maxZ) {
      x += stepX;
      distance = maxX;
      maxX += deltaX;
    } else if (maxY <= maxZ) {
      y += stepY;
      distance = maxY;
      maxY += deltaY;
    } else {
      z += stepZ;
      distance = maxZ;
      maxZ += deltaZ;
    }
    if (distance > limit) break;
    const value = map.get(x, y, z);
    if (value !== 0) return { x, y, z, value, index: map.index(x, y, z), distance };
  }
  return null;
}

// The first authoritative shot increments shotSeq before seeding its two spread
// samples, so its seed multiplier is 2 rather than 1.
function firstShotSpreadDirection(playerId, forward) {
  let seed = 2166136261 >>> 0;
  for (let i = 0; i < playerId.length; i++) {
    seed ^= playerId.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  let state = (seed ^ Math.imul(2, 2654435761)) | 0;
  const random = () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const angle = random() * Math.PI * 2;
  const radius = Math.sqrt(random()) * Math.tan(SNIPER_SPREAD_RAD);
  const basisUp = Math.abs(forward.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  let tx = forward.y * basisUp.z - forward.z * basisUp.y;
  let ty = forward.z * basisUp.x - forward.x * basisUp.z;
  let tz = forward.x * basisUp.y - forward.y * basisUp.x;
  const tangentLength = Math.hypot(tx, ty, tz) || 1;
  tx /= tangentLength;
  ty /= tangentLength;
  tz /= tangentLength;
  const bx = forward.y * tz - forward.z * ty;
  const by = forward.z * tx - forward.x * tz;
  const bz = forward.x * ty - forward.y * tx;
  const x = forward.x + tx * Math.cos(angle) * radius + bx * Math.sin(angle) * radius;
  const y = forward.y + ty * Math.cos(angle) * radius + by * Math.sin(angle) * radius;
  const z = forward.z + tz * Math.cos(angle) * radius + bz * Math.sin(angle) * radius;
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

function visibleBreakableTarget(bytes, player, blockers = []) {
  const map = mapView(bytes);
  const origin = { x: player.x, y: player.y + 1.62, z: player.z };
  const candidates = [];
  for (let y = 0; y < map.sy; y++) {
    for (let z = 0; z < map.sz; z++) {
      for (let x = 0; x < map.sx; x++) {
        const value = map.get(x, y, z);
        if (!BREAKABLE_BLOCKS.has(value)) continue;
        if (FRAGILE_CHAIN_BLOCKS.has(map.get(x, y + 1, z))) continue;
        const dx = x + 0.5 - origin.x;
        const dy = y + 0.5 - origin.y;
        const dz = z + 0.5 - origin.z;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq > 1 && distanceSq < 110 * 110) candidates.push({ x, y, z, value, distanceSq });
      }
    }
  }
  candidates.sort((a, b) => a.distanceSq - b.distanceSq);
  for (const candidate of candidates) {
    const distance = Math.sqrt(candidate.distanceSq);
    const direction = {
      x: (candidate.x + 0.5 - origin.x) / distance,
      y: (candidate.y + 0.5 - origin.y) / distance,
      z: (candidate.z + 0.5 - origin.z) / distance,
    };
    const playerOccludesTarget = blockers.some((blocker) => {
      const toPlayer = {
        x: blocker.x - origin.x,
        y: blocker.y + 0.95 - origin.y,
        z: blocker.z - origin.z,
      };
      const alongRay =
        toPlayer.x * direction.x +
        toPlayer.y * direction.y +
        toPlayer.z * direction.z;
      if (alongRay <= 0 || alongRay >= distance) return false;
      const perpendicularSq =
        toPlayer.x * toPlayer.x +
        toPlayer.y * toPlayer.y +
        toPlayer.z * toPlayer.z -
        alongRay * alongRay;
      // Deliberately exceed the authoritative player AABB so rounded wire
      // positions and the rewind window cannot turn a clear shot into a hit.
      return perpendicularSq < 4;
    });
    if (playerOccludesTarget) continue;
    const hit = firstSolid(map, origin, direction, distance + 0.01);
    if (!hit || hit.index !== map.index(candidate.x, candidate.y, candidate.z)) continue;
    const shotDirection = firstShotSpreadDirection(player.id, direction);
    let spreadPathIsStable = true;
    const nominalSpreadHit = firstSolid(map, origin, shotDirection, 120);
    if (!nominalSpreadHit || nominalSpreadHit.index !== hit.index) continue;
    for (const offsetX of [-WIRE_POSITION_TOLERANCE, WIRE_POSITION_TOLERANCE]) {
      for (const offsetY of [-WIRE_POSITION_TOLERANCE, WIRE_POSITION_TOLERANCE]) {
        for (const offsetZ of [-WIRE_POSITION_TOLERANCE, WIRE_POSITION_TOLERANCE]) {
          const spreadHit = firstSolid(map, {
            x: origin.x + offsetX,
            y: origin.y + offsetY,
            z: origin.z + offsetZ,
          }, shotDirection, 120);
          if (!spreadHit || spreadHit.index !== hit.index) spreadPathIsStable = false;
        }
      }
    }
    if (!spreadPathIsStable) continue;
    return {
      ...candidate,
      index: hit.index,
      direction,
      shotDirection,
      yaw: Math.atan2(-direction.x, -direction.z),
      pitch: Math.asin(direction.y),
    };
  }
  throw new Error('the behavior map exposed no visible breakable voxel from the player spawn');
}

async function readyAndStart(host, members, code, signal) {
  for (let i = 0; i < members.length; i++) {
    const mark = host.mark();
    members[i].send({ t: 'ready', value: true });
    const state = await nextLobbyState(host, mark, code, signal);
    assertLobbyState(state, {
      code,
      host: host.welcome.id,
      phase: 'waiting',
      bots: 0,
      humans: members.map((client, index) => ({ client, ready: index <= i })),
    }, `${code} readiness replacement ${i + 1}`);
  }
  const marks = new Map(members.map((client) => [client, client.mark()]));
  host.send({ t: 'start' });
  const liveStates = await Promise.all(members.map((client) =>
    nextLobbyState(client, marks.get(client), code, signal, (state) => state.phase === 'live')));
  for (let i = 0; i < liveStates.length; i++) {
    assertLobbyState(liveStates[i], {
      code,
      host: host.welcome.id,
      phase: 'live',
      bots: 0,
      humans: members.map((client) => ({ client, ready: true })),
      botRows: 0,
    }, `${members[i].label} live replacement`);
  }
}

async function runContracts(server, signal) {
  const port = await withTimeout(server.port, START_TIMEOUT_MS, 'server startup timeout', signal);
  pass(Number.isInteger(port) && port > 0, 'server binds an OS-assigned port');

  const directory = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/lobbies`);
    pass(response.ok && response.headers.get('cache-control') === 'no-store', 'directory is fresh JSON');
    return response.json();
  };
  pass((await directory()).lobbies.length === 0, 'empty directory reports no rooms');
  const secret = 'Room pass 42!';
  const protectedHost = await admit(makeClient(port, 'Protected-Host'),
    { t: 'create', name: 'Protected-Host', bots: 0, password: secret }, signal);
  const protectedCode = protectedHost.welcome.lobby.code;
  const listing = await directory();
  const listed = listing.lobbies.find((room) => room.code === protectedCode);
  pass(listed?.passwordRequired === true && listed.players === 1 && listed.host === 'Protected-Host'
    && listed.phase === 'waiting' && listed.capacity === 32, 'directory exposes joinable room metadata');
  pass(!JSON.stringify(listing).includes(secret) && !JSON.stringify(protectedHost.initialState).includes(secret)
    && Object.keys(listed).sort().join(',') === 'capacity,code,gameMode,host,map,passwordRequired,phase,players',
    'directory and lobby frames never expose password material');
  for (const password of [undefined, 'wrong', secret.toLowerCase()]) {
    const frame = { t: 'join', name: 'Password-Check', lobby: protectedCode };
    if (password !== undefined) frame.password = password;
    const rejection = await expectRejected(makeClient(port, 'Password-Check'), frame, 4003, signal);
    pass(/password/i.test(rejection.error.msg), 'missing or incorrect password rejects code-based admission');
  }
  for (const password of [42, 'x'.repeat(65)]) {
    await expectRejected(makeClient(port, 'Invalid-Password'),
      { t: 'create', name: 'Invalid-Password', bots: 0, password }, 4002, signal);
  }
  const protectedPeer = await admit(makeClient(port, 'Protected-Peer'),
    { t: 'join', name: 'Protected-Peer', lobby: protectedCode, password: secret }, signal);
  pass((await directory()).lobbies.find((room) => room.code === protectedCode)?.players === 2,
    'correct password admits a directory-selected player');
  await Promise.all([protectedPeer.close(), protectedHost.close()]);
  await sleep(100, signal);
  pass(!(await directory()).lobbies.some((room) => room.code === protectedCode), 'empty rooms disappear from directory');

  // Configure an already joinable room while peers are connected.
  const editor = await admit(makeClient(port, 'Editor'), { t: 'create', name: 'Editor', bots: 3 }, signal);
  const pingMark = editor.mark();
  editor.send({ t: 'ping', nonce: 1 });
  const pingState = await nextLobbyState(editor, pingMark, editor.welcome.lobby.code, signal, (msg) => msg.members?.some((member) => Number.isFinite(member.ping)));
  pass(pingState.members.some((member) => member.id === editor.welcome.id && member.ping >= 0), 'waiting lobby broadcasts measured player ping');
  const editCode = editor.welcome.lobby.code;
  const peer = await admit(makeClient(port, 'Editing-Peer'), { t: 'join', name: 'Editing-Peer', lobby: editCode }, signal);
  let editMark = peer.mark();
  peer.send({ t: 'configure', gameMode: 'tdm', map: 'depot', bots: 7 });
  await peer.waitForJson((msg) => msg.t === 'error' && /host/i.test(msg.msg), 'guest settings rejection', editMark, FRAME_TIMEOUT_MS, signal);
  pass(peer.ws.readyState === WebSocket.OPEN, 'only the host can edit without disconnecting a guest');
  editMark = editor.mark();
  peer.send({ t: 'ready', value: true });
  await nextLobbyState(editor, editMark, editCode, signal);
  const editorConfigMark = editor.mark();
  const peerConfigMark = peer.mark();
  editor.send({ t: 'configure', gameMode: 'tdm', map: 'depot', bots: 7 });
  for (const [client, from] of [[editor, editorConfigMark], [peer, peerConfigMark]]) {
    const header = await client.waitForFrame((frame) => frame.kind === 'json' && frame.value.t === 'lobbyConfig',
      'replacement arena header', from, FRAME_TIMEOUT_MS, signal);
    const bytes = await client.waitForFrame((frame) => frame.kind === 'binary',
      'replacement arena bytes', from, FRAME_TIMEOUT_MS, signal);
    const replacement = await nextLobbyState(client, from, editCode, signal, (state) => state.map === 'depot');
    pass(header.seq < bytes.seq && validMap(bytes.value, header.value.mapBytes)
      && header.value.map === 'depot' && replacement.gameMode === 'tdm'
      && replacement.host === editor.welcome.id && humanRows(replacement).length === 2
      && replacement.members.filter(row => row.bot).length === 7
      && humanRows(replacement).every((row) => !row.ready),
      `${client.label} keeps code and roster, replaces arena and resets readiness`);
  }
  const editingLate = await admit(makeClient(port, 'Editing-Late'),
    { t: 'join', name: 'Editing-Late', lobby: editCode }, signal, { gameMode: 'tdm', map: 'depot' });
  pass(editingLate.initialState.bots === 7, 'new arrivals receive current settings while the host configures');
  for (const client of [editor, peer, editingLate]) {
    const readyMark = editor.mark();
    client.send({ t: 'ready', value: true });
    await nextLobbyState(editor, readyMark, editCode, signal);
  }
  editor.send({ t: 'start' });
  await nextTick(editor, editorConfigMark, (tick) => tick.players.length === 10, 'configured match keeps seven bots alongside three humans', signal);
  const afterStartMark = editor.mark();
  editor.send({ t: 'configure', gameMode: 'fun', map: 'foundry', bots: 0 });
  await editor.waitForJson((msg) => msg.t === 'error' && /started/i.test(msg.msg), 'live edit rejection', afterStartMark, FRAME_TIMEOUT_MS, signal);
  const liveLate = await admit(makeClient(port, 'Live-Editing-Late'),
    { t: 'join', name: 'Live-Editing-Late', lobby: editCode }, signal, { gameMode: 'tdm', map: 'depot' });
  pass(liveLate.initialState.members.length === 10 && liveLate.initialState.bots === 6,
    'late private-match join takes a bot slot without increasing match population');
  await Promise.all([peer.close(), editingLate.close(), liveLate.close()]);
  await nextLobbyState(editor, afterStartMark, editCode, signal, (state) => humanRows(state).length === 1);
  editor.ws.terminate();
  await sleep(100, signal);
  const recovered = await admit(makeClient(port, 'Recovered-Editor'),
    { t: 'join', name: 'Editor', lobby: editCode }, signal, { gameMode: 'tdm', map: 'depot' });
  pass(recovered.welcome.phase === 'live' && recovered.initialState.host === recovered.welcome.id,
    'an abnormal last-player disconnect leaves the same live lobby available for recovery');
  await recovered.close();

  // Legacy direct joins must still rendezvous in one immediately-live quick room.
  const quickA = await admit(makeClient(port, 'Quick-A'), { t: 'join', name: 'Quick-A' }, signal);
  assertLobbyState(quickA.initialState, {
    code: quickA.welcome.lobby.code,
    host: quickA.welcome.id,
    phase: 'live',
    bots: 5,
    humans: [{ client: quickA, ready: false }],
    botRows: 5,
  }, 'fresh quick-room population');
  const initialQuickTick = await nextTick(
    quickA,
    0,
    (tick) => tick.players.filter((row) => String(row.id).startsWith('bot-')).length === 5,
    'quick-room tick with five starter bots',
    signal,
  );
  pass(initialQuickTick.players.some((row) => row.id === 'bot-4'),
    'fresh quick room owns the deterministic takeover bot slot');
  const quickB = await admit(makeClient(port, 'Quick-B'), { t: 'join', name: 'Quick-B' }, signal);
  pass(quickA.welcome.phase === 'live' && quickB.welcome.phase === 'live' &&
    quickA.welcome.lobby.code === quickB.welcome.lobby.code,
  'two legacy direct joins share one live quick room');
  pass([quickA, quickB].every((client) =>
    client.welcome.gameMode === DEFAULT_GAME_MODE &&
    client.welcome.map === DEFAULT_MAP &&
    client.initialState.gameMode === DEFAULT_GAME_MODE &&
    client.initialState.map === DEFAULT_MAP),
  'legacy quick rooms default welcome and lobby state to fun on foundry');
  assertLobbyState(quickB.initialState, {
    code: quickA.welcome.lobby.code,
    host: quickA.welcome.id,
    phase: 'live',
    bots: 4,
    humans: [
      { client: quickA, ready: false },
      { client: quickB, ready: false },
    ],
    botRows: 4,
  }, 'quick human takeover replacement');
  pass(!quickB.initialState.members.some((row) => row.id === 'bot-4')
    && quickB.initialState.members.some((row) => row.id === quickB.welcome.id),
  'joining human replaces the deterministic bot slot without growing the room');
  const quickTick = await nextTick(
    quickA,
    0,
    (tick) => [quickA.welcome.id, quickB.welcome.id].every((id) => tick.players.some((row) => row.id === id)),
    'quick-room tick containing both humans',
    signal,
  );
  pass(quickTick.players.length === 6
    && quickTick.players.some((row) => row.id === quickA.welcome.id)
    && quickTick.players.some((row) => row.id === quickB.welcome.id)
    && quickTick.players.filter((row) => String(row.id).startsWith('bot-')).length === 4,
  'quick-room behavior keeps six entities while humans replace bots');
  await Promise.all([quickA.close(), quickB.close()]);

  // Keep a second waiting room present while exercising every public-lobby gate.
  const gateHost = await admit(makeClient(port, 'Gate-Host'), { t: 'create', name: 'Gate-Host', bots: 2 }, signal);
  const gateCode = gateHost.welcome.lobby.code;
  pass(CODE_RE.test(gateCode) && gateHost.welcome.lobby.role === 'host' && gateHost.welcome.phase === 'waiting',
    'create returns a valid invite code and waiting host welcome');
  assertLobbyState(gateHost.initialState, {
    code: gateCode,
    host: gateHost.welcome.id,
    phase: 'waiting',
    bots: 2,
    humans: [{ client: gateHost, ready: false }],
  }, 'create replacement');
  pass(gateHost.welcome.gameMode === DEFAULT_GAME_MODE &&
    gateHost.welcome.map === DEFAULT_MAP &&
    gateHost.initialState.gameMode === DEFAULT_GAME_MODE &&
    gateHost.initialState.map === DEFAULT_MAP,
  'create defaults welcome and lobby state to fun on foundry');

  const roomBHost = await admit(makeClient(port, 'Room-B-Host'), { t: 'create', name: 'Room-B-Host', bots: 0 }, signal);
  const roomBCode = roomBHost.welcome.lobby.code;
  pass(CODE_RE.test(roomBCode) && roomBCode !== gateCode, 'concurrent public rooms receive distinct valid codes');
  const gateHostJoinMark = gateHost.mark();
  const roomBQuietMark = roomBHost.mark();
  const gateGuest = await admit(
    makeClient(port, 'Gate-Guest'),
    { t: 'join', name: 'Gate-Guest', lobby: gateCode.toLowerCase() },
    signal,
  );
  pass(gateGuest.welcome.lobby.code === gateCode && gateGuest.welcome.lobby.role === 'member',
    'invite joins are case-insensitive');
  const gateJoined = await nextLobbyState(gateHost, gateHostJoinMark, gateCode, signal);
  assertLobbyState(gateJoined, {
    code: gateCode,
    host: gateHost.welcome.id,
    phase: 'waiting',
    bots: 2,
    humans: [{ client: gateHost, ready: false }, { client: gateGuest, ready: false }],
  }, 'joined-room replacement');
  pass(gateGuest.welcome.gameMode === DEFAULT_GAME_MODE &&
    gateGuest.welcome.map === DEFAULT_MAP &&
    gateJoined.gameMode === DEFAULT_GAME_MODE &&
    gateJoined.map === DEFAULT_MAP,
  'invite join inherits fun on foundry in welcome and lobby state');
  pass(roomBHost.framesAfter(roomBQuietMark).every(
    (frame) => frame.kind !== 'json' || frame.value?.t !== 'lobbyState' || frame.value.code === roomBCode,
  ), 'a join replacement is scoped away from another room');

  const roomBHostJoinMark = roomBHost.mark();
  const roomBGuest = await admit(
    makeClient(port, 'Room-B-Guest'),
    { t: 'join', name: 'Room-B-Guest', lobby: roomBCode },
    signal,
  );
  const roomBJoined = await nextLobbyState(roomBHost, roomBHostJoinMark, roomBCode, signal);
  assertLobbyState(roomBJoined, {
    code: roomBCode,
    host: roomBHost.welcome.id,
    phase: 'waiting',
    bots: 0,
    humans: [{ client: roomBHost, ready: false }, { client: roomBGuest, ready: false }],
  }, 'second-room joined replacement');
  await sleep(150, signal);
  pass(!gateHost.frames.some((frame) => frame.kind === 'json' && frame.value?.t === 'lobbyState' && frame.value.code === roomBCode),
    'lobby state broadcasts never cross public-room codes');
  pass(!gateHost.frames.some((frame) => frame.kind === 'json' && frame.value?.t === 'tick') &&
    !roomBHost.frames.some((frame) => frame.kind === 'json' && frame.value?.t === 'tick'),
  'waiting public rooms emit no simulation ticks');

  let mark = gateHost.mark();
  gateGuest.send({ t: 'ready', value: true });
  let state = await nextLobbyState(gateHost, mark, gateCode, signal);
  assertLobbyState(state, {
    code: gateCode,
    host: gateHost.welcome.id,
    phase: 'waiting',
    bots: 2,
    humans: [{ client: gateHost, ready: false }, { client: gateGuest, ready: true }],
  }, 'guest-only readiness replacement');

  mark = gateHost.mark();
  gateHost.send({ t: 'start' });
  const hostNotReady = await gateHost.waitForJson(
    (message) => message?.t === 'error' && /ready/i.test(message.msg),
    'host-included readiness rejection',
    mark,
    FRAME_TIMEOUT_MS,
    signal,
  );
  pass(/every player/i.test(hostNotReady.msg) && gateHost.ws.readyState === WebSocket.OPEN,
    'the host is included in the all-human readiness gate');

  mark = gateHost.mark();
  gateHost.send({ t: 'ready', value: true });
  state = await nextLobbyState(gateHost, mark, gateCode, signal);
  assertLobbyState(state, {
    code: gateCode,
    host: gateHost.welcome.id,
    phase: 'waiting',
    bots: 2,
    humans: [{ client: gateHost, ready: true }, { client: gateGuest, ready: true }],
  }, 'all-human readiness replacement');

  mark = gateGuest.mark();
  gateGuest.send({ t: 'start' });
  const nonHostError = await gateGuest.waitForJson(
    (message) => message?.t === 'error' && /host/i.test(message.msg),
    'nonhost start rejection',
    mark,
    FRAME_TIMEOUT_MS,
    signal,
  );
  pass(/only the host/i.test(nonHostError.msg) && gateGuest.ws.readyState === WebSocket.OPEN,
    'nonhost start is rejected without disconnect');
  mark = gateHost.mark();
  gateGuest.send({ t: 'ready', value: false });
  state = await nextLobbyState(gateHost, mark, gateCode, signal);
  pass(humanRows(state).find((row) => row.id === gateGuest.welcome.id)?.ready === false,
    'a rejected nonhost can still update readiness');
  mark = gateHost.mark();
  gateGuest.send({ t: 'ready', value: true });
  await nextLobbyState(gateHost, mark, gateCode, signal);

  const gateHostLiveMark = gateHost.mark();
  const gateGuestLiveMark = gateGuest.mark();
  gateHost.send({ t: 'start' });
  const [gateHostLive, gateGuestLive] = await Promise.all([
    nextLobbyState(gateHost, gateHostLiveMark, gateCode, signal, (state) => state.phase === 'live'),
    nextLobbyState(gateGuest, gateGuestLiveMark, gateCode, signal, (state) => state.phase === 'live'),
  ]);
  for (const [client, live] of [[gateHost, gateHostLive], [gateGuest, gateGuestLive]]) {
    assertLobbyState(live, {
      code: gateCode,
      host: gateHost.welcome.id,
      phase: 'live',
      bots: 2,
      humans: [{ client: gateHost, ready: true }, { client: gateGuest, ready: true }],
      botRows: 2,
    }, `${client.label} started replacement`);
  }
  await nextTick(gateHost, gateHostLiveMark, (tick) => tick.players.length === 4, 'started tick with two humans and two bots', signal);
  pass(gateHostLive.members.filter((member) => member.bot).every((member) => member.ready === false),
    'bots are ignored by the start gate');
  pass(gateHost.framesAfter(gateHostLiveMark).some((frame) => frame.kind === 'json' && frame.value?.t === 'tick'),
    'host start begins authoritative ticks');

  // Observe the guest's departure before closing the host: close handshakes on
  // different sockets are not ordered with respect to one another.
  const gateDepartureMark = gateHost.mark();
  await gateGuest.close();
  const gateHostOnly = await nextLobbyState(gateHost, gateDepartureMark, gateCode, signal);
  pass(humanRows(gateHostOnly).length === 1 &&
    humanRows(gateHostOnly)[0].id === gateHost.welcome.id,
  'guest close is applied before last-human cleanup');
  await gateHost.close();
  const releasedGate = await expectRejected(
    makeClient(port, 'Released-Gate-Code'),
    { t: 'join', name: 'Released-Gate-Code', lobby: gateCode },
    4004,
    signal,
  );
  pass(/unknown lobby/i.test(releasedGate.error.msg), 'last-human cleanup invalidates the invite code');

  // A fresh no-bot room runs alongside Room B so world mutation can be queried
  // by live late joins in both rooms.
  const roomCHost = await admit(makeClient(port, 'Room-C-Host'), { t: 'create', name: 'Room-C-Host', bots: 0 }, signal);
  const roomCCode = roomCHost.welcome.lobby.code;
  const roomCHostJoinMark = roomCHost.mark();
  const roomCGuest = await admit(
    makeClient(port, 'Room-C-Guest'),
    { t: 'join', name: 'Room-C-Guest', lobby: roomCCode },
    signal,
  );
  await nextLobbyState(roomCHost, roomCHostJoinMark, roomCCode, signal);

  await readyAndStart(roomBHost, [roomBHost, roomBGuest], roomBCode, signal);
  await readyAndStart(roomCHost, [roomCHost, roomCGuest], roomCCode, signal);
  const bLiveMark = roomBHost.mark();
  const cLiveMark = roomCHost.mark();
  const [bTick, cTick] = await Promise.all([
    nextTick(roomBHost, bLiveMark, () => true, 'Room B live tick', signal),
    nextTick(roomCHost, cLiveMark, () => true, 'Room C live tick', signal),
  ]);
  const bIds = new Set([roomBHost.welcome.id, roomBGuest.welcome.id]);
  const cIds = new Set([roomCHost.welcome.id, roomCGuest.welcome.id]);
  pass(bTick.players.length === 2 && bTick.players.every((row) => bIds.has(row.id)),
    'Room B ticks contain only Room B ids');
  pass(cTick.players.length === 2 && cTick.players.every((row) => cIds.has(row.id)),
    'Room C ticks contain only Room C ids');
  assertRoomScoped(roomBHost, roomBCode, cIds, 'Room B host');
  assertRoomScoped(roomCHost, roomCCode, bIds, 'Room C host');
  assertRoomScoped(roomBGuest, roomBCode, cIds, 'Room B guest');
  assertRoomScoped(roomCGuest, roomCCode, bIds, 'Room C guest');
  pass(Buffer.compare(roomBHost.map, roomCHost.map) === 0,
    'independent rooms begin from the same behavior map');

  const initialShooter = bTick.players.find((row) => row.id === roomBHost.welcome.id);
  const equipMark = roomBHost.mark();
  roomBHost.input(1, {
    yaw: initialShooter.yaw,
    pitch: initialShooter.pitch,
    weapon: SNIPER_SLOT,
    ads: true,
  });
  const equipTick = await nextTick(
    roomBHost,
    equipMark,
    (tick) => tick.players.some((row) =>
      row.id === roomBHost.welcome.id && row.weapon === SNIPER_SLOT),
    'Room B sniper selection',
    signal,
  );
  const equippedAt = equipTick.now;
  const armedTick = await nextTick(
    roomBHost,
    equipMark,
    (tick) => tick.now >= equippedAt +
      (SNIPER_DEPLOY_MS + SNIPER_ADS_MS) +
      AUTHORITATIVE_TICK_MS &&
      tick.players.some((row) =>
        row.id === roomBHost.welcome.id &&
        row.weapon === SNIPER_SLOT &&
        row.ads &&
        row.state === 'alive'),
    'Room B deployed ADS sniper',
    signal,
  );
  const shooterRow = armedTick.players.find((row) => row.id === roomBHost.welcome.id);
  const target = visibleBreakableTarget(
    roomBHost.map,
    shooterRow,
    armedTick.players.filter((row) => row.id !== roomBHost.welcome.id),
  );
  const roomBMap = mapView(roomBHost.map);
  pass(roomBMap.get(target.x, target.y, target.z) === target.value &&
    BREAKABLE_BLOCKS.has(target.value) &&
    !FRAGILE_CHAIN_BLOCKS.has(roomBMap.get(target.x, target.y + 1, target.z)),
  'the map frame supplies one visible breakable mutation target without fragile chain support');

  const aimMark = roomBHost.mark();
  roomBHost.input(2, {
    yaw: target.yaw,
    pitch: target.pitch,
    weapon: SNIPER_SLOT,
    ads: true,
  });
  await nextTick(
    roomBHost,
    aimMark,
    (tick) => tick.players.some((row) =>
      row.id === roomBHost.welcome.id &&
      row.weapon === SNIPER_SLOT &&
      row.ads &&
      Math.abs(Math.atan2(Math.sin(row.yaw - target.yaw), Math.cos(row.yaw - target.yaw))) < 0.001 &&
      Math.abs(row.pitch - target.pitch) < 0.001),
    'Room B authoritative aim lock',
    signal,
  );

  const bBlockMark = roomBHost.mark();
  const bGuestBlockMark = roomBGuest.mark();
  const cHostBlockMark = roomCHost.mark();
  const cGuestBlockMark = roomCGuest.mark();
  roomBHost.input(3, {
    yaw: target.yaw,
    pitch: target.pitch,
    weapon: SNIPER_SLOT,
    ads: true,
    fire: true,
  });
  const [blockTick, peerBlockTick] = await Promise.all([
    nextTick(
      roomBHost,
      bBlockMark,
      (tick) => tick.blocks.some((block) => block.i === target.index && block.v === 0),
      'Room B voxel mutation',
      signal,
    ),
    nextTick(
      roomBGuest,
      bGuestBlockMark,
      (tick) => tick.blocks.some((block) => block.i === target.index && block.v === 0),
      'Room B peer voxel mutation',
      signal,
    ),
  ]);
  roomBHost.input(4, {
    yaw: target.yaw,
    pitch: target.pitch,
    weapon: SNIPER_SLOT,
    ads: true,
    fire: false,
  });

  const shot = blockTick.events.find((event) =>
    event?.kind === 'shoot' &&
    event.id === roomBHost.welcome.id &&
    event.w === 'sniper');
  const spreadLength = shot ? Math.hypot(...shot.spread) : 0;
  const spreadDot = spreadLength > 0
    ? (shot.spread[0] * target.shotDirection.x +
      shot.spread[1] * target.shotDirection.y +
      shot.spread[2] * target.shotDirection.z) / spreadLength
    : -1;
  const spreadAngle = Math.acos(Math.max(-1, Math.min(1, spreadDot)));
  pass(shot &&
    blockTick.players.some((row) => row.id === roomBHost.welcome.id && row.firing) &&
    spreadAngle <= 0.0015,
  'the deployed ADS input produces the authoritative sniper shot and bounded wire spread');
  // Penetrating sniper rounds can also break material behind the first target.
  // Every resulting delta must reach both peers, and the selected target appears once.
  const orderedDeltas = (tick) => [...tick.blocks].sort((a, b) => a.i - b.i);
  pass(blockTick.blocks.filter((block) => block.i === target.index && block.v === 0).length === 1 &&
    peerBlockTick.blocks.filter((block) => block.i === target.index && block.v === 0).length === 1 &&
    JSON.stringify(orderedDeltas(blockTick)) === JSON.stringify(orderedDeltas(peerBlockTick)),
  'target and penetration voxel mutations broadcast identically to both Room B sockets');

  const cHostFenceMark = roomCHost.mark();
  const cGuestFenceMark = roomCGuest.mark();
  await Promise.all([
    nextTick(roomCHost, cHostFenceMark, () => true, 'Room C host post-mutation fence', signal),
    nextTick(roomCGuest, cGuestFenceMark, () => true, 'Room C guest post-mutation fence', signal),
  ]);
  const roomCObservedTarget = (client, mark) => client.framesAfter(mark).some((frame) =>
    frame.kind === 'json' &&
    frame.value?.t === 'tick' &&
    frame.value.blocks.some((block) => block.i === target.index));
  pass(!roomCObservedTarget(roomCHost, cHostBlockMark) &&
    !roomCObservedTarget(roomCGuest, cGuestBlockMark),
  'Room B block state never broadcasts to either Room C socket');

  const lateBHostMark = roomBHost.mark();
  const lateB = await admit(
    makeClient(port, 'Room-B-Late'),
    { t: 'join', name: 'Room-B-Late', lobby: roomBCode.toLowerCase() },
    signal,
  );
  const lateBState = await nextLobbyState(roomBHost, lateBHostMark, roomBCode, signal);
  assertLobbyState(lateBState, {
    code: roomBCode,
    host: roomBHost.welcome.id,
    phase: 'live',
    bots: 0,
    humans: [roomBHost, roomBGuest, lateB].map((client) => ({ client, ready: client !== lateB })),
    botRows: 0,
  }, 'Room B live late-join replacement');
  pass(lateB.welcome.phase === 'live' && lateB.map[MAP_HEADER_BYTES + target.index] === 0,
    'live late join receives Room B current map');

  const lateCHostMark = roomCHost.mark();
  const lateC = await admit(
    makeClient(port, 'Room-C-Late'),
    { t: 'join', name: 'Room-C-Late', lobby: roomCCode },
    signal,
  );
  const lateCState = await nextLobbyState(roomCHost, lateCHostMark, roomCCode, signal);
  assertLobbyState(lateCState, {
    code: roomCCode,
    host: roomCHost.welcome.id,
    phase: 'live',
    bots: 0,
    humans: [roomCHost, roomCGuest, lateC].map((client) => ({ client, ready: client !== lateC })),
    botRows: 0,
  }, 'Room C live late-join replacement');
  const divergentVoxels = [];
  for (let offset = MAP_HEADER_BYTES; offset < lateB.map.length; offset++) {
    if (lateB.map[offset] !== lateC.map[offset]) divergentVoxels.push(offset - MAP_HEADER_BYTES);
  }
  pass(lateC.welcome.phase === 'live' &&
    lateC.map[MAP_HEADER_BYTES + target.index] === target.value &&
    JSON.stringify(divergentVoxels) === JSON.stringify(orderedDeltas(blockTick).map((block) => block.i)) &&
    blockTick.blocks.every((block) => lateB.map[MAP_HEADER_BYTES + block.i] === block.v),
  'late-join binary maps diverge exactly at the broadcast Room B mutations');
  pass(lateB.frames.filter((frame) => frame.kind === 'binary').length === 1 &&
    lateC.frames.filter((frame) => frame.kind === 'binary').length === 1,
  'each live late join receives exactly one binary map frame');

  // Prove a sustained, explicitly measured sub-limit input rate stays admitted.
  const politeTickMark = roomCHost.mark();
  for (let i = 0; i < 100; i++) {
    roomCHost.input(10_000 + i);
    await sleep(12, signal);
  }
  const observedRate = roomCHost.maxSentInOneSecond();
  await nextTick(roomCHost, politeTickMark, () => true, 'post-rate-input tick', signal);
  pass(observedRate < 180 && roomCHost.ws.readyState === WebSocket.OPEN,
    `polite input timing remains below 180 msg/s (${observedRate} observed)`);

  // The earliest remaining human becomes host without disturbing the live room.
  const migrationMark = roomBGuest.mark();
  await roomBHost.close();
  const migrated = await nextLobbyState(roomBGuest, migrationMark, roomBCode, signal);
  assertLobbyState(migrated, {
    code: roomBCode,
    host: roomBGuest.welcome.id,
    phase: 'live',
    bots: 0,
    humans: [roomBGuest, lateB].map((client) => ({ client, ready: client === roomBGuest })),
    botRows: 0,
  }, 'host-migration replacement');
  pass(migrated.host === roomBGuest.welcome.id, 'host disconnect promotes the earliest remaining human');

  // Fill Room B to its 32-human cap and require the room-specific close
  // while other active rooms continue on the same server.
  const roomBMembers = [roomBGuest, lateB];
  while (roomBMembers.length < 32) {
    const number = roomBMembers.length + 1;
    const joinMark = roomBGuest.mark();
    const member = await admit(
      makeClient(port, `Room-B-Cap-${number}`),
      { t: 'join', name: `Room-B-Cap-${number}`, lobby: roomBCode },
      signal,
    );
    roomBMembers.push(member);
    const replacement = await nextLobbyState(roomBGuest, joinMark, roomBCode, signal);
    pass(humanRows(replacement).length === roomBMembers.length,
      `room-cap join ${number} broadcasts the complete roster`);
  }
  const allBIds = new Set(roomBMembers.map((client) => client.welcome.id));
  const allCIds = new Set([roomCHost, roomCGuest, lateC].map((client) => client.welcome.id));
  assertRoomScoped(roomBGuest, roomBCode, allCIds, 'full Room B roster');
  assertRoomScoped(lateB, roomBCode, allCIds, 'Room B late join');
  assertRoomScoped(roomCHost, roomCCode, allBIds, 'full Room C roster');
  assertRoomScoped(roomCGuest, roomCCode, allBIds, 'Room C guest after late joins');
  assertRoomScoped(lateC, roomCCode, allBIds, 'Room C late join');
  const activeBeforeOverflow = socketTracker.openSocketCount();
  pass(activeBeforeOverflow < 256, `room-cap scenario remains under global socket cap (${activeBeforeOverflow} open)`);
  const overflow = await expectRejected(
    makeClient(port, 'Room-B-Overflow'),
    { t: 'join', name: 'Room-B-Overflow', lobby: roomBCode },
    4005,
    signal,
  );
  pass(/full/i.test(overflow.error.msg), 'the thirty-third human receives the room-full behavior error');

  const malformed = await expectRejected(
    makeClient(port, 'Malformed-Code'),
    { t: 'join', name: 'Malformed-Code', lobby: 'BAD!' },
    4002,
    signal,
  );
  pass(/malformed/i.test(malformed.error.msg), 'malformed invite codes receive behavior error 4002');

  const activeCodes = new Set([roomBCode, roomCCode, gateCode]);
  const unknownCode = ['AAAAA', 'BBBBB', 'CCCCC', 'DDDDD'].find((code) => !activeCodes.has(code));
  const unknown = await expectRejected(
    makeClient(port, 'Unknown-Code'),
    { t: 'join', name: 'Unknown-Code', lobby: unknownCode },
    4004,
    signal,
  );
  pass(/unknown lobby/i.test(unknown.error.msg), 'unknown valid invite codes receive behavior error 4004');

  const finalRoomBMember = roomBMembers[0];
  const finalRoomBMark = finalRoomBMember.mark();
  await Promise.all(roomBMembers.slice(1).map((client) => client.close()));
  const finalRoomBState = await nextLobbyState(
    finalRoomBMember,
    finalRoomBMark,
    roomBCode,
    signal,
    (candidate) => humanRows(candidate).length === 1,
  );
  pass(humanRows(finalRoomBState)[0]?.id === finalRoomBMember.welcome.id,
    'room-cap departures settle before the final close');
  await finalRoomBMember.close();
  const releasedRoomB = await expectRejected(
    makeClient(port, 'Released-Room-B'),
    { t: 'join', name: 'Released-Room-B', lobby: roomBCode },
    4004,
    signal,
  );
  pass(/unknown lobby/i.test(releasedRoomB.error.msg), 'last-human cleanup releases a live lobby code');

  await Promise.all([roomCHost.close(), roomCGuest.close(), lateC.close()]);
}

async function cleanup() {
  await Promise.allSettled(Array.from(clients, (client) => client.close()));
  clients.clear();
  await stopServer(activeServer);
}

async function main() {
  activeServer = startServer();
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error(`lobby smoke exceeded ${OVERALL_TIMEOUT_MS} ms`)),
    OVERALL_TIMEOUT_MS,
  );
  const onSigint = () => controller.abort(new Error('lobby smoke interrupted by SIGINT'));
  const onSigterm = () => controller.abort(new Error('lobby smoke interrupted by SIGTERM'));
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  let failure = null;
  try {
    await Promise.race([
      runContracts(activeServer, controller.signal),
      activeServer.unexpectedExit,
    ]);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    if (!controller.signal.aborted) controller.abort(failure);
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    try {
      await cleanup();
    } catch (cleanupError) {
      failure ||= cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
    }
  }
  if (failure) throw failure;
  console.log(`LOBBY SMOKE: ALL OK (${checks} checks)`);
}

main().catch((error) => {
  const serverOutput = activeServer && (activeServer.stderr.trim() || activeServer.stdout.trim());
  console.error(`LOBBY SMOKE: FAIL - ${error.message}`);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
});
