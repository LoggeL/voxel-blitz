// Bounded end-to-end coverage for selected mode/map lobbies. The harness
// observes only frames exchanged with a real WebSocket server.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';
import { AIR, createMapState } from '../shared/worlddata.js';
import { raycastVoxels } from '../shared/raycast.js';
import { PHYSICS } from '../server/game.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRAME_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 2_000;
const OVERALL_TIMEOUT_MS = 60_000;
const SND_PHASE_TIMEOUT_MS = 15_000;
const MAP_HEADER_BYTES = 6;
const REVOLVER_SLOT = 5;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
const PLAYER_KEYS = 'ads,bomb,credits,deaths,exhaustion,firing,hp,id,interaction,kills,mag,name,owned,pain,panic,pitch,reloading,reserve,score,spawnProtected,state,team,weapon,x,y,yaw,z';
const MATCH_KEYS = 'attackers,bomb,defenders,map,mode,phase,phaseEndsAt,round,roundWinner,scores,winner';

let checks = 0;
let activeServer = null;
let peakOpenSockets = 0;
const clients = new Set();

function pass(condition, name, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  checks++;
  console.log(`OK ${checks} - ${name}`);
}

function abortError(signal, fallback) {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function sleep(ms, signal) {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      rejectSleep(abortError(signal, 'operation aborted'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => finish(null), ms);
    const onAbort = () => finish(abortError(signal, 'operation aborted'));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) rejectSleep(error);
      else resolveSleep();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withTimeout(promise, ms, label, signal) {
  return new Promise((resolveWait, rejectWait) => {
    if (signal?.aborted) {
      rejectWait(abortError(signal, label));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => finish(new Error(label)), ms);
    const onAbort = () => finish(abortError(signal, label));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) rejectWait(error);
      else resolveWait(value);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(null, value),
      (error) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function serverFailure(server, info) {
  const reason = info.error
    ? info.error.message
    : `code=${String(info.code)} signal=${info.signal || 'none'}`;
  const output = server.stderr.trim() || server.stdout.trim();
  return new Error(`server exited before mode lobby smoke completed (${reason})${output ? `\n${output}` : ''}`);
}

function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = {
    child,
    stopping: false,
    stdout: '',
    stderr: '',
    readyPort: null,
  };

  let resolveExit;
  let exited = false;
  server.exit = new Promise((resolvePromise) => { resolveExit = resolvePromise; });
  const settleExit = (info) => {
    if (exited) return;
    exited = true;
    resolveExit(info);
  };
  child.once('error', (error) => settleExit({ error, code: null, signal: null }));
  child.once('exit', (code, signal) => settleExit({ error: null, code, signal }));

  let resolvePort;
  let rejectPort;
  let portSettled = false;
  server.port = new Promise((resolvePromise, rejectPromise) => {
    resolvePort = resolvePromise;
    rejectPort = rejectPromise;
  });
  server.port.catch(() => {});
  server.readyTimer = setTimeout(() => {
    if (portSettled) return;
    portSettled = true;
    rejectPort(new Error('server did not advertise its OS-assigned port'));
  }, START_TIMEOUT_MS);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    server.stdout = (server.stdout + chunk).slice(-12_000);
    const match = server.stdout.match(/voxel-blitz listening on :(\d+)\b/);
    if (!match || portSettled) return;
    portSettled = true;
    clearTimeout(server.readyTimer);
    server.readyPort = Number(match[1]);
    resolvePort(server.readyPort);
  });
  child.stderr.on('data', (chunk) => {
    server.stderr = (server.stderr + chunk).slice(-12_000);
  });
  server.exit.then((info) => {
    if (portSettled) return;
    portSettled = true;
    clearTimeout(server.readyTimer);
    rejectPort(serverFailure(server, info));
  });

  server.failIfUnexpected = async () => {
    const info = await server.exit;
    if (!server.stopping) throw serverFailure(server, info);
  };
  return server;
}

async function stopServer(server) {
  if (!server) return;
  server.stopping = true;
  const child = server.child;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGTERM'); } catch {}
  }
  try {
    await withTimeout(server.exit, STOP_TIMEOUT_MS, 'server did not stop after SIGTERM');
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    await withTimeout(server.exit, STOP_TIMEOUT_MS, 'server did not stop after SIGKILL');
  } finally {
    clearTimeout(server.readyTimer);
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}

function openSocketCount() {
  let count = 0;
  for (const client of clients) {
    if (client.ws?.readyState === WebSocket.OPEN) count++;
  }
  return count;
}

class Client {
  constructor(port, label) {
    this.port = port;
    this.label = label;
    this.ws = null;
    this.frames = [];
    this.sentAt = [];
    this.sequence = 0;
    this.closeInfo = null;
    this.socketError = null;
    this.waiters = new Set();
    clients.add(this);
  }

  mark() {
    return this.sequence;
  }

  framesAfter(mark = 0) {
    return this.frames.filter((frame) => frame.seq > mark);
  }

  recordFrame(frame) {
    frame.seq = ++this.sequence;
    frame.at = Date.now();
    this.frames.push(frame);
    for (const waiter of Array.from(this.waiters)) waiter();
  }

  async connect(firstFrame, signal) {
    if (this.ws) throw new Error(`${this.label} was connected twice`);
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.recordFrame({ kind: 'binary', value: Buffer.from(data) });
        return;
      }
      let value;
      try { value = JSON.parse(String(data)); } catch { value = null; }
      this.recordFrame({ kind: value === null ? 'invalid-json' : 'json', value, raw: String(data) });
    });
    ws.on('error', (error) => {
      this.socketError = error;
      for (const waiter of Array.from(this.waiters)) waiter();
    });
    ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: String(reason) };
      for (const waiter of Array.from(this.waiters)) waiter();
    });

    await this.waitForOpen(signal);
    peakOpenSockets = Math.max(peakOpenSockets, openSocketCount());
    if (typeof firstFrame === 'string' || Buffer.isBuffer(firstFrame)) this.sendRaw(firstFrame);
    else this.send(firstFrame);
    return this;
  }

  waitForOpen(signal) {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolveOpen, rejectOpen) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`${this.label} open timeout`)), FRAME_TIMEOUT_MS);
      const onOpen = () => finish(null);
      const onError = (error) => finish(new Error(`${this.label} failed to open: ${error.message}`));
      const onClose = (code, reason) => finish(new Error(`${this.label} closed before open (${code} ${String(reason)})`));
      const onAbort = () => finish(abortError(signal, `${this.label} open aborted`));
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.ws?.removeListener('open', onOpen);
        this.ws?.removeListener('error', onError);
        this.ws?.removeListener('close', onClose);
        if (error) rejectOpen(error);
        else resolveOpen();
      };
      this.ws.once('open', onOpen);
      this.ws.once('error', onError);
      this.ws.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  sendRaw(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error(`${this.label} socket is not open`);
    this.sentAt.push(Date.now());
    this.ws.send(payload);
  }

  send(value) {
    this.sendRaw(JSON.stringify(value));
  }

  input(seq, overrides = {}) {
    this.send({
      t: 'input',
      seq,
      keys: {
        f: !!overrides.forward,
        b: !!overrides.back,
        l: !!overrides.left,
        r: !!overrides.right,
        jump: !!overrides.jump,
        sprint: !!overrides.sprint,
        crouch: !!overrides.crouch,
        interact: !!overrides.interact,
      },
      yaw: overrides.yaw ?? 0,
      pitch: overrides.pitch ?? 0,
      weapon: overrides.weapon ?? 0,
      wantFire: !!overrides.fire,
      wantAds: !!overrides.ads,
      reload: !!overrides.reload,
    });
  }

  findFrame(predicate, after) {
    return this.frames.find((frame) => frame.seq > after && predicate(frame));
  }

  waitForFrame(predicate, description, after = 0, timeoutMs = FRAME_TIMEOUT_MS, signal) {
    const existing = this.findFrame(predicate, after);
    if (existing) return Promise.resolve(existing);
    if (this.closeInfo) {
      return Promise.reject(new Error(`${this.label} closed before ${description} (${this.closeInfo.code} ${this.closeInfo.reason})`));
    }
    return new Promise((resolveFrame, rejectFrame) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`${this.label} timeout waiting for ${description}`)), timeoutMs);
      const onAbort = () => finish(abortError(signal, `${this.label} wait aborted`));
      const inspect = () => {
        const frame = this.findFrame(predicate, after);
        if (frame) {
          finish(null, frame);
          return;
        }
        if (this.closeInfo) {
          finish(new Error(`${this.label} closed before ${description} (${this.closeInfo.code} ${this.closeInfo.reason})`));
        }
      };
      const finish = (error, frame) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(inspect);
        if (error) rejectFrame(error);
        else resolveFrame(frame);
      };
      this.waiters.add(inspect);
      signal?.addEventListener('abort', onAbort, { once: true });
      inspect();
    });
  }

  waitForJsonFrame(predicate, description, after = 0, timeoutMs = FRAME_TIMEOUT_MS, signal) {
    return this.waitForFrame(
      (frame) => frame.kind === 'json' && predicate(frame.value),
      description,
      after,
      timeoutMs,
      signal,
    );
  }

  async waitForJson(predicate, description, after = 0, timeoutMs = FRAME_TIMEOUT_MS, signal) {
    const frame = await this.waitForJsonFrame(predicate, description, after, timeoutMs, signal);
    return frame.value;
  }

  waitForClose(description = 'socket close', timeoutMs = FRAME_TIMEOUT_MS, signal) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolveClose, rejectClose) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`${this.label} timeout waiting for ${description}`)), timeoutMs);
      const onAbort = () => finish(abortError(signal, `${this.label} close wait aborted`));
      const inspect = () => {
        if (this.closeInfo) finish(null, this.closeInfo);
      };
      const finish = (error, info) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(inspect);
        if (error) rejectClose(error);
        else resolveClose(info);
      };
      this.waiters.add(inspect);
      signal?.addEventListener('abort', onAbort, { once: true });
      inspect();
    });
  }

  maxSentInOneSecond() {
    let max = 0;
    let left = 0;
    for (let right = 0; right < this.sentAt.length; right++) {
      while (left < right && this.sentAt[right] - this.sentAt[left] >= 1_000) left++;
      max = Math.max(max, right - left + 1);
    }
    return max;
  }

  async close() {
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) {
      ws.removeAllListeners();
      this.waiters.clear();
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.close(1000, 'mode lobby smoke complete'); } catch {}
    } else if (ws.readyState === WebSocket.CONNECTING) {
      try { ws.terminate(); } catch {}
    }
    try {
      await this.waitForClose('cleanup close', 750);
    } catch {
      try { ws.terminate(); } catch {}
      try { await this.waitForClose('terminated cleanup close', 750); } catch {}
    }
    ws.removeAllListeners();
    this.waiters.clear();
  }
}

function makeClient(port, label) {
  return new Client(port, label);
}

async function closeRoomClients(clientsInRoom, label) {
  await Promise.all(clientsInRoom.map((client) => client.close()));
  const incomplete = clientsInRoom.filter((client) =>
    client.ws?.readyState !== WebSocket.CLOSED || !client.closeInfo);
  pass(incomplete.length === 0 && openSocketCount() === 0,
    `${label} sockets close before the next room starts`,
    `open=${openSocketCount()} incomplete=${incomplete.map((client) =>
      `${client.label}:${client.ws?.readyState ?? 'none'}`).join(',') || 'none'}`);
}

function validMap(bytes, advertisedLength) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== advertisedLength || bytes.length < MAP_HEADER_BYTES) return false;
  const sx = bytes[3];
  const sz = bytes[4];
  const sy = bytes[5];
  return bytes[0] === 86 && bytes[1] === 66 && bytes[2] > 0 &&
    sx > 0 && sz > 0 && sy > 0 && bytes.length === MAP_HEADER_BYTES + sx * sz * sy;
}

function assertWelcome(welcome, selection, label) {
  pass(welcome?.t === 'welcome' &&
    Object.keys(welcome).sort().join(',') === 'gameMode,id,lobby,map,mapBytes,phase,spawn,t,tickRate' &&
    Object.keys(welcome.lobby || {}).sort().join(',') === 'code,role' &&
    Object.keys(welcome.spawn || {}).sort().join(',') === 'x,y,z',
  `${label} is a complete welcome replacement`);
  pass(welcome.gameMode === selection.gameMode && welcome.map === selection.map,
    `${label} carries ${selection.gameMode} on ${selection.map}`,
    `received ${JSON.stringify({ gameMode: welcome.gameMode, map: welcome.map })}`);
  pass(CODE_RE.test(welcome.lobby.code), `${label} carries a valid room code`);
}

function assertLobbyShape(state, selection, label) {
  pass(state?.t === 'lobbyState' &&
    Object.keys(state).sort().join(',') === 'bots,code,gameMode,host,map,members,phase,t' &&
    Array.isArray(state.members) &&
    state.members.every((member) => Object.keys(member).sort().join(',') === 'bot,id,name,ready'),
  `${label} is a complete lobby replacement`);
  pass(state.gameMode === selection.gameMode && state.map === selection.map,
    `${label} retains ${selection.gameMode} on ${selection.map}`,
    `received ${JSON.stringify({ gameMode: state.gameMode, map: state.map })}`);
}

async function admit(client, firstFrame, selection, signal) {
  await client.connect(firstFrame, signal);
  const welcomeFrame = await client.waitForJsonFrame(
    (message) => message?.t === 'welcome',
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
  const stateFrame = await client.waitForJsonFrame(
    (message) => message?.t === 'lobbyState',
    'initial lobby state',
    0,
    FRAME_TIMEOUT_MS,
    signal,
  );
  pass(welcomeFrame.seq < mapFrame.seq && mapFrame.seq < stateFrame.seq,
    `${client.label} receives welcome, map, then lobby state`);
  assertWelcome(welcomeFrame.value, selection, `${client.label} welcome`);
  assertLobbyShape(stateFrame.value, selection, `${client.label} initial state`);
  pass(validMap(mapFrame.value, welcomeFrame.value.mapBytes),
    `${client.label} receives its advertised complete map`);
  client.welcome = welcomeFrame.value;
  client.map = mapFrame.value;
  client.initialState = stateFrame.value;
  return client;
}

function expectedRoster(members, ready = new Set()) {
  return members.map((client) => ({
    id: client.welcome.id,
    name: client.label,
    ready: ready.has(client),
    bot: false,
  }));
}

function assertLobbyState(state, { selection, code, host, phase, members, ready = new Set() }, label) {
  assertLobbyShape(state, selection, label);
  pass(state.code === code && state.host === host.welcome.id && state.phase === phase && state.bots === 0,
    `${label} carries exact room identity and phase`);
  const expected = expectedRoster(members, ready);
  pass(JSON.stringify(state.members) === JSON.stringify(expected),
    `${label} carries the exact ordered human roster`,
    `received ${JSON.stringify(state.members)}`);
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
  return error;
}

function nextLobbyState(client, mark, code, predicate, description, signal) {
  return client.waitForJson(
    (message) => message?.t === 'lobbyState' && message.code === code && predicate(message),
    description,
    mark,
    FRAME_TIMEOUT_MS,
    signal,
  );
}

function nextTickFrame(client, mark, predicate, description, signal, timeoutMs = FRAME_TIMEOUT_MS) {
  return client.waitForJsonFrame(
    (message) => message?.t === 'tick' && predicate(message),
    description,
    mark,
    timeoutMs,
    signal,
  );
}

async function nextTick(client, mark, predicate, description, signal, timeoutMs = FRAME_TIMEOUT_MS) {
  return (await nextTickFrame(client, mark, predicate, description, signal, timeoutMs)).value;
}

function playerRow(tick, client) {
  return tick?.players?.find((row) => row.id === client.welcome.id);
}

function assertPlayerRows(tick, clientsInRoom, label) {
  const expectedIds = clientsInRoom.map((client) => client.welcome.id);
  pass(Array.isArray(tick?.players) && tick.players.length === expectedIds.length &&
    tick.players.every((row) => Object.keys(row).sort().join(',') === PLAYER_KEYS &&
      Number.isFinite(row.pain) && row.pain >= 0 && row.pain <= 1 &&
      Number(row.pain.toFixed(3)) === row.pain && typeof row.spawnProtected === 'boolean') &&
    expectedIds.every((id) => tick.players.some((row) => row.id === id)),
  `${label} carries exact player identities, normalized pain, and complete mode rows`);
}

function assertMatchShape(tick, selection, label) {
  pass(tick?.t === 'tick' && tick.match && Object.keys(tick.match).sort().join(',') === MATCH_KEYS,
    `${label} carries the complete match replacement`);
  pass(tick.match.mode === selection.gameMode && tick.match.map === selection.map,
    `${label} carries exact match mode and map`);
}

function assertTeamScores(scores, alpha, bravo, label) {
  pass(scores && Object.keys(scores).sort().join(',') === 'alpha,bravo' &&
    scores.alpha === alpha && scores.bravo === bravo,
  label,
  `received ${JSON.stringify(scores)}`);
}

async function readyAndStart(host, members, selection, signal) {
  const code = host.welcome.lobby.code;
  const readyMarks = new Map(members.map((client) => [client, client.mark()]));
  for (const member of members) member.send({ t: 'ready', value: true });
  const readySet = new Set(members);
  const readyStates = await Promise.all(members.map((client) => nextLobbyState(
    client,
    readyMarks.get(client),
    code,
    (state) => state.phase === 'waiting' && state.members.length === members.length &&
      state.members.every((row) => row.ready),
    `${client.label} all-ready replacement`,
    signal,
  )));
  for (let i = 0; i < members.length; i++) {
    assertLobbyState(readyStates[i], {
      selection,
      code,
      host,
      phase: 'waiting',
      members,
      ready: readySet,
    }, `${members[i].label} all-ready state`);
  }

  const liveMarks = new Map(members.map((client) => [client, client.mark()]));
  host.send({ t: 'start' });
  const liveStates = await Promise.all(members.map((client) => nextLobbyState(
    client,
    liveMarks.get(client),
    code,
    (state) => state.phase === 'live',
    `${client.label} live replacement`,
    signal,
  )));
  for (let i = 0; i < members.length; i++) {
    assertLobbyState(liveStates[i], {
      selection,
      code,
      host,
      phase: 'live',
      members,
      ready: readySet,
    }, `${members[i].label} live state`);
  }
  return liveMarks;
}

function createShotGeometry(mapId, bytes) {
  if (!validMap(bytes, bytes.length)) throw new Error(`cannot inspect invalid ${mapId} map bytes`);
  const world = createMapState(mapId, bytes);
  return {
    world,
    sx: bytes[3],
    sz: bytes[4],
    solidAt: (x, y, z) => world.getBlock(x, y, z) !== AIR,
  };
}

function aimAngles(shooter, target) {
  const dx = target.x - shooter.x;
  const dy = (target.y + 0.95) - (shooter.y + 1.62);
  const dz = target.z - shooter.z;
  return {
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, Math.hypot(dx, dz) || 1e-9),
  };
}

function angleDistance(left, right) {
  return Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
}

function shotRay(geometry, shooter, target) {
  if (!shooter || !target) return { clear: false, distance: NaN, hit: null };
  const start = { x: shooter.x, y: shooter.y + 1.62, z: shooter.z };
  const end = { x: target.x, y: target.y + 0.95, z: target.z };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!(distance > 0.2)) return { clear: false, distance, hit: null };
  const hit = raycastVoxels(
    geometry.solidAt,
    start.x,
    start.y,
    start.z,
    dx,
    dy,
    dz,
    distance - 0.15,
  );
  return { clear: hit === null, distance, hit };
}


function occupancyBlockers(geometry, x, y, z) {
  const shave = 1e-4;
  const x0 = Math.floor(x - PHYSICS.halfW + shave);
  const x1 = Math.floor(x + PHYSICS.halfW - shave);
  const y0 = Math.floor(y + shave);
  const y1 = Math.floor(y + PHYSICS.height - shave);
  const z0 = Math.floor(z - PHYSICS.halfW + shave);
  const z1 = Math.floor(z + PHYSICS.halfW - shave);
  const blockers = [];
  for (let yy = y0; yy <= y1; yy++) {
    for (let zz = z0; zz <= z1; zz++) {
      for (let xx = x0; xx <= x1; xx++) {
        if (geometry.solidAt(xx, yy, zz)) blockers.push(`voxel(${xx},${yy},${zz})`);
      }
    }
  }
  const floorY = Math.floor(y - 0.06);
  const supported = [x0, x1].some((xx) =>
    [z0, z1].some((zz) => geometry.solidAt(xx, floorY, zz)));
  if (!supported) blockers.push(`unsupported(y=${floorY})`);
  return blockers;
}

function routeBlocker(geometry, row, target) {
  if (!row) return { at: null, blockers: ['missing-authoritative-row'] };
  const dx = target.x - row.x;
  const dz = target.z - row.z;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.25));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const at = { x: row.x + dx * t, y: row.y, z: row.z + dz * t };
    const blockers = occupancyBlockers(geometry, at.x, at.y, at.z);
    if (blockers.length > 0) return { at, blockers };
  }
  return null;
}

function findWestLanePlan(geometry, hostRow, guestRow) {
  if (!hostRow || !guestRow) throw new Error('cannot stage S&D without both authoritative player rows');
  const centerZ = (hostRow.z + guestRow.z) / 2;
  const hostGoalZ = centerZ + 5;
  const guestGoalZ = centerZ - 5;
  const rejected = [];
  const firstCandidate = Math.floor(Math.min(hostRow.x, guestRow.x)) - 0.5;
  for (let laneX = firstCandidate; laneX >= 3.5; laneX--) {
    const hostEntry = routeBlocker(geometry, hostRow, { x: laneX, z: hostRow.z });
    const guestEntry = routeBlocker(geometry, guestRow, { x: laneX, z: guestRow.z });
    const northZ = Math.min(hostRow.z, guestRow.z);
    const southZ = Math.max(hostRow.z, guestRow.z);
    const hostCorridor = routeBlocker(
      geometry,
      { ...hostRow, x: laneX, z: northZ },
      { x: laneX, z: southZ },
    );
    const guestCorridor = routeBlocker(
      geometry,
      { ...guestRow, x: laneX, z: northZ },
      { x: laneX, z: southZ },
    );
    const projectedHost = { ...hostRow, x: laneX, z: hostGoalZ };
    const projectedGuest = { ...guestRow, x: laneX, z: guestGoalZ };
    const shot = shotRay(geometry, projectedHost, projectedGuest);
    if (!hostEntry && !guestEntry && !hostCorridor && !guestCorridor && shot.clear) {
      return { laneX, hostGoalZ, guestGoalZ };
    }
    if (rejected.length < 4) {
      const reason = hostEntry || guestEntry || hostCorridor || guestCorridor;
      rejected.push(`x=${laneX}:${reason
        ? reason.blockers.join('|')
        : `shot=${JSON.stringify(shot.hit)}`}`);
    }
  }
  throw new Error(
    `Citadel has no map-clear west staging lane from ` +
    `host=(${hostRow.x.toFixed(2)},${hostRow.y.toFixed(2)},${hostRow.z.toFixed(2)}) ` +
    `guest=(${guestRow.x.toFixed(2)},${guestRow.y.toFixed(2)},${guestRow.z.toFixed(2)}) ` +
    `(${rejected.join('; ')})`,
  );
}

function latestAuthoritativeTick(client) {
  for (let i = client.frames.length - 1; i >= 0; i--) {
    const frame = client.frames[i];
    if (frame.kind === 'json' && frame.value?.t === 'tick') return frame.value;
  }
  return null;
}

function stagingTimeoutMs(distance) {
  const travelMs = (Math.max(0, distance) / PHYSICS.walk) * 1_000;
  return Math.ceil(2_000 + travelMs * 2.5);
}

function stagingFailure(error, label, host, participants, geometry, targets) {
  const tick = latestAuthoritativeTick(host);
  const positions = participants.map((client) => {
    const row = playerRow(tick, client);
    return `${client.label}=${row
      ? `(${row.x.toFixed(2)},${row.y.toFixed(2)},${row.z.toFixed(2)} ${row.state})`
      : 'missing'}`;
  }).join(' ');
  const blockers = participants.map((client) => {
    const row = playerRow(tick, client);
    const target = targets.get(client) || (row && { x: row.x, z: row.z });
    const blocked = target ? routeBlocker(geometry, row, target) : null;
    return `${client.label}=${blocked
      ? `${blocked.blockers.join('|')}@${blocked.at
        ? `${blocked.at.x.toFixed(2)},${blocked.at.y.toFixed(2)},${blocked.at.z.toFixed(2)}`
        : 'unknown'}`
      : 'none-on-remaining-route'}`;
  }).join(' ');
  const [hostRow, guestRow] = participants.map((client) => playerRow(tick, client));
  const shot = shotRay(geometry, hostRow, guestRow);
  return new Error(
    `${label} failed: ${error.message}; authoritative now=${tick?.now ?? 'none'} ` +
    `positions ${positions}; blockers ${blockers}; firing-lane=${shot.clear
      ? `clear/${shot.distance.toFixed(2)}`
      : JSON.stringify(shot.hit)}`,
    { cause: error },
  );
}

async function waitForSndStage(
  host,
  participants,
  geometry,
  targets,
  mark,
  predicate,
  label,
  signal,
  timeoutMs,
) {
  try {
    return await nextTick(host, mark, predicate, label, signal, timeoutMs);
  } catch (error) {
    throw stagingFailure(error, label, host, participants, geometry, targets);
  }
}

async function settleMovementInputs(
  host,
  participants,
  geometry,
  tick,
  seq,
  headings,
  label,
  signal,
) {
  const mark = host.mark();
  const targets = new Map();
  const previous = new Map();
  for (const client of participants) {
    const row = playerRow(tick, client);
    targets.set(client, { x: row.x, z: row.z });
    previous.set(client, { x: row.x, z: row.z });
    client.input(seq, { yaw: headings.get(client), weapon: REVOLVER_SLOT });
  }
  let stableSamples = 0;
  return waitForSndStage(
    host,
    participants,
    geometry,
    targets,
    mark,
    (next) => {
      let maxStep = 0;
      for (const client of participants) {
        const row = playerRow(next, client);
        const prior = previous.get(client);
        if (!row || angleDistance(row.yaw, headings.get(client)) >= 0.002) {
          stableSamples = 0;
          return false;
        }
        maxStep = Math.max(maxStep, Math.hypot(row.x - prior.x, row.z - prior.z));
        previous.set(client, { x: row.x, z: row.z });
      }
      stableSamples = maxStep <= 0.03 ? stableSamples + 1 : 0;
      return stableSamples >= 2;
    },
    label,
    signal,
    FRAME_TIMEOUT_MS,
  );
}

async function stageSndWestLane(host, guest, initialTick, geometry, signal) {
  const participants = [host, guest];
  const headingsWest = new Map([[host, Math.PI / 2], [guest, Math.PI / 2]]);
  const plan = findWestLanePlan(
    geometry,
    playerRow(initialTick, host),
    playerRow(initialTick, guest),
  );
  let tick = await settleMovementInputs(
    host,
    participants,
    geometry,
    initialTick,
    10,
    headingsWest,
    'S&D staging movement reset',
    signal,
  );

  let mark = host.mark();
  const entryTargets = new Map(participants.map((client) => [
    client,
    { x: plan.laneX, z: playerRow(tick, client).z },
  ]));
  const entryDistance = Math.max(...participants.map((client) =>
    Math.abs(playerRow(tick, client).x - plan.laneX)));
  for (const client of participants) {
    client.input(11, {
      yaw: Math.PI / 2,
      weapon: REVOLVER_SLOT,
      forward: true,
      sprint: true,
    });
  }
  tick = await waitForSndStage(
    host,
    participants,
    geometry,
    entryTargets,
    mark,
    (next) => participants.every((client) => playerRow(next, client)?.x <= plan.laneX),
    'S&D players enter the map-clear west lane',
    signal,
    stagingTimeoutMs(entryDistance),
  );

  const headingsLongitudinal = new Map([[host, 0], [guest, Math.PI]]);
  tick = await settleMovementInputs(
    host,
    participants,
    geometry,
    tick,
    12,
    headingsLongitudinal,
    'S&D west-lane turn reset',
    signal,
  );

  mark = host.mark();
  const convergenceTargets = new Map([
    [host, { x: plan.laneX, z: plan.hostGoalZ }],
    [guest, { x: plan.laneX, z: plan.guestGoalZ }],
  ]);
  const convergenceDistance = Math.max(
    Math.abs(playerRow(tick, host).z - plan.hostGoalZ),
    Math.abs(playerRow(tick, guest).z - plan.guestGoalZ),
  );
  host.input(13, { yaw: 0, weapon: REVOLVER_SLOT, forward: true, sprint: true });
  guest.input(13, { yaw: Math.PI, weapon: REVOLVER_SLOT, forward: true, sprint: true });
  tick = await waitForSndStage(
    host,
    participants,
    geometry,
    convergenceTargets,
    mark,
    (next) => playerRow(next, host)?.z <= plan.hostGoalZ &&
      playerRow(next, guest)?.z >= plan.guestGoalZ,
    'S&D players converge in the map-clear west lane',
    signal,
    stagingTimeoutMs(convergenceDistance),
  );

  tick = await settleMovementInputs(
    host,
    participants,
    geometry,
    tick,
    14,
    headingsLongitudinal,
    'S&D west-lane combat input reset',
    signal,
  );
  const finalShot = shotRay(geometry, playerRow(tick, host), playerRow(tick, guest));
  pass(finalShot.clear,
    'Citadel binary map confirms a clear active-opponent firing lane',
    `positions ${host.label}=(${playerRow(tick, host).x.toFixed(2)},${playerRow(tick, host).z.toFixed(2)}) ` +
    `${guest.label}=(${playerRow(tick, guest).x.toFixed(2)},${playerRow(tick, guest).z.toFixed(2)}) ` +
    `blocker=${JSON.stringify(finalShot.hit)}`);
  return tick;
}


async function settleAim(client, seq, tick, target, weapon, label, signal) {
  const angles = aimAngles(playerRow(tick, client), playerRow(tick, target));
  const aimMark = client.mark();
  client.input(seq, { yaw: angles.yaw, pitch: angles.pitch, weapon, ads: true });
  const aimed = await nextTick(
    client,
    aimMark,
    (next) => {
      const row = playerRow(next, client);
      return row?.ads && angleDistance(row.yaw, angles.yaw) < 0.002 &&
        Math.abs(row.pitch - angles.pitch) < 0.002;
    },
    `${label} aim lock`,
    signal,
  );
  return nextTick(
    client,
    client.mark(),
    (next) => next.now >= aimed.now + 250,
    `${label} ADS settle`,
    signal,
  );
}

function eventsBetween(client, after, through) {
  return client.frames
    .filter((frame) => frame.seq > after && frame.seq <= through && frame.kind === 'json' && frame.value?.t === 'tick')
    .flatMap((frame) => frame.value.events || []);
}

function assertInitialTeamAssignments(events, rows, label) {
  const assignments = events.filter((event) => event?.kind === 'team_assigned');
  const teamsById = new Map(rows.map((row) => [row.id, row.team]));
  pass(assignments.length === 0 || (
    assignments.length === rows.length &&
    new Set(assignments.map((event) => event.id)).size === assignments.length &&
    assignments.every((event) => teamsById.has(event.id) && teamsById.get(event.id) === event.team)
  ), label, `received ${JSON.stringify(assignments)}`);
}

async function fireOne(client, seq, target, signal) {
  const shooterRow = target.tick.players.find((row) => row.id === client.welcome.id);
  const victimRow = target.tick.players.find((row) => row.id === target.client.welcome.id);
  const angles = aimAngles(shooterRow, victimRow);
  const mark = client.mark();
  client.input(seq, { yaw: angles.yaw, pitch: angles.pitch, weapon: target.weapon, ads: true, fire: true });
  const shotFrame = await nextTickFrame(
    client,
    mark,
    (tick) => tick.events.some((event) => event?.kind === 'shoot' && event.id === client.welcome.id),
    `${client.label} authoritative shot`,
    signal,
  );
  client.input(seq + 1, { yaw: angles.yaw, pitch: angles.pitch, weapon: target.weapon, ads: true });
  return shotFrame;
}

async function runQuickRotation(port, signal) {
  const foundry = { gameMode: 'fun', map: 'foundry' };
  const depot = { gameMode: 'fun', map: 'depot' };
  const quickA = await admit(
    makeClient(port, 'Quick-Foundry-A'),
    { t: 'join', name: 'Quick-Foundry-A' },
    foundry,
    signal,
  );
  const quickB = await admit(
    makeClient(port, 'Quick-Foundry-B'),
    { t: 'join', name: 'Quick-Foundry-B' },
    foundry,
    signal,
  );
  pass(quickA.welcome.phase === 'live' && quickB.welcome.phase === 'live' &&
    quickA.welcome.lobby.code === quickB.welcome.lobby.code,
  'quick joins mix into the existing live room without rotating its map');
  assertLobbyState(quickB.initialState, {
    selection: foundry,
    code: quickA.welcome.lobby.code,
    host: quickA,
    phase: 'live',
    members: [quickA, quickB],
  }, 'existing quick-room state');
  pass(Buffer.compare(quickA.map, quickB.map) === 0,
    'clients mixed into one quick room receive identical Foundry bytes');
  const foundryBytes = Buffer.from(quickA.map);

  await Promise.all([quickA.close(), quickB.close()]);
  await sleep(100, signal);

  const quickDepot = await admit(
    makeClient(port, 'Quick-Depot'),
    { t: 'join', name: 'Quick-Depot' },
    depot,
    signal,
  );
  pass(quickDepot.welcome.phase === 'live' && CODE_RE.test(quickDepot.welcome.lobby.code),
    'the next fresh quick room rotates to Depot as a live room');
  assertLobbyState(quickDepot.initialState, {
    selection: depot,
    code: quickDepot.welcome.lobby.code,
    host: quickDepot,
    phase: 'live',
    members: [quickDepot],
  }, 'fresh rotated quick-room state');
  pass(foundryBytes.length === quickDepot.map.length && Buffer.compare(foundryBytes, quickDepot.map) !== 0,
    'Foundry and Depot use equally complete but byte-distinct map payloads');
  const depotBytes = Buffer.from(quickDepot.map);
  await quickDepot.close();
  return { foundryBytes, depotBytes };
}

async function runTdmDepot(port, quickDepotBytes, signal) {
  const selection = { gameMode: 'tdm', map: 'depot' };
  const host = await admit(
    makeClient(port, 'TDM-Host'),
    { t: 'create', name: 'TDM-Host', bots: 0, gameMode: 'tdm', map: 'depot' },
    selection,
    signal,
  );
  pass(host.welcome.phase === 'waiting' && host.welcome.lobby.role === 'host',
    'selected TDM Depot create returns a waiting host identity');
  const members = [host];
  for (const label of ['TDM-Bravo-1', 'TDM-Alpha-2', 'TDM-Bravo-2', 'TDM-Alpha-3', 'TDM-Bravo-3']) {
    const member = await admit(
      makeClient(port, label),
      { t: 'join', name: label, lobby: host.welcome.lobby.code.toLowerCase() },
      selection,
      signal,
    );
    members.push(member);
    pass(member.welcome.lobby.code === host.welcome.lobby.code && member.welcome.lobby.role === 'member',
      `${label} inherits the exact invite identity`);
    assertLobbyState(member.initialState, {
      selection,
      code: host.welcome.lobby.code,
      host,
      phase: 'waiting',
      members,
    }, `${label} inherited TDM Depot state`);
    pass(Buffer.compare(host.map, member.map) === 0,
      `${label} inherits the exact Depot map bytes`);
  }
  pass(new Set(members.map((client) => client.welcome.id)).size === members.length,
    'TDM lobby assigns six distinct wire player identities');
  pass(Buffer.compare(host.map, quickDepotBytes) === 0,
    'selected TDM Depot and fresh Fun Depot start from the same Depot template');

  const liveMarks = await readyAndStart(host, members, selection, signal);
  const firstTickFrame = await nextTickFrame(
    host,
    liveMarks.get(host),
    (tick) => members.every((client) => tick.players.some((row) => row.id === client.welcome.id)),
    'first complete TDM tick',
    signal,
  );
  const firstTick = firstTickFrame.value;
  assertPlayerRows(firstTick, members, 'TDM tick');
  assertMatchShape(firstTick, selection, 'TDM tick');
  pass(firstTick.match.phase === 'live' && firstTick.match.phaseEndsAt === null &&
    firstTick.match.winner === null && firstTick.match.round === null &&
    firstTick.match.roundWinner === null && firstTick.match.attackers === null &&
    firstTick.match.defenders === null && firstTick.match.bomb === null,
  'TDM match fields expose the exact initial live state');
  assertTeamScores(firstTick.match.scores, 0, 0, 'TDM starts with exact zeroed team scores');

  const expectedTeams = new Map(firstTick.players.map((row) => [row.id, row.team]));
  const assignedTeams = new Set(expectedTeams.values());
  pass(expectedTeams.size === members.length &&
    assignedTeams.size === 2 && assignedTeams.has('alpha') && assignedTeams.has('bravo'),
  'first TDM tick rows establish complete authoritative alpha/bravo assignments');
  assertInitialTeamAssignments(
    eventsBetween(host, liveMarks.get(host), firstTickFrame.seq),
    firstTick.players,
    'initial TDM team assignment events, when present, exactly match authoritative rows',
  );
  const firstTickFence = await nextTickFrame(
    host,
    firstTickFrame.seq,
    () => true,
    'TDM initial team assignment replay fence',
    signal,
  );
  pass(!eventsBetween(host, firstTickFrame.seq, firstTickFence.seq)
    .some((event) => event?.kind === 'team_assigned'),
  'initial TDM team assignment events are not replayed on the next tick');

  const armedMark = host.mark();
  const armedTick = await nextTick(
    host,
    armedMark,
    (tick) => tick.now >= firstTick.now + 650,
    'deployed TDM loadouts',
    signal,
  );
  assertPlayerRows(armedTick, members, 'subsequent TDM tick');
  assertMatchShape(armedTick, selection, 'subsequent TDM tick');
  pass(armedTick.players.every((row) => row.team === expectedTeams.get(row.id)),
    'subsequent TDM tick preserves the exact player-to-team mapping');
  assertTeamScores(armedTick.match.scores, 0, 0,
    'subsequent TDM tick keeps both scores zero before any enemy kill');
  pass(members.every((client) => client.frames.every((frame) => {
    if (frame.kind !== 'json') return true;
    if (frame.value?.t === 'welcome') {
      return frame.value.id === client.welcome.id &&
        frame.value.lobby?.code === host.welcome.lobby.code;
    }
    return frame.value?.t !== 'lobbyState' ||
      (frame.value.code === host.welcome.lobby.code &&
        frame.value.host === host.welcome.id);
  })), 'TDM lobby and client identities remain stable through subsequent ticks');

  await closeRoomClients(members, 'TDM room');
}

async function runSndCitadel(port, depotBytes, signal) {
  const selection = { gameMode: 'snd', map: 'citadel' };
  const host = await admit(
    makeClient(port, 'SND-Host'),
    { t: 'create', name: 'SND-Host', bots: 0, gameMode: 'snd', map: 'citadel' },
    selection,
    signal,
  );
  const guest = await admit(
    makeClient(port, 'SND-Guest'),
    { t: 'join', name: 'SND-Guest', lobby: host.welcome.lobby.code },
    selection,
    signal,
  );
  const members = [host, guest];
  pass(guest.welcome.lobby.code === host.welcome.lobby.code && guest.welcome.lobby.role === 'member',
    'S&D invite join inherits the exact Citadel room identity');
  assertLobbyState(guest.initialState, {
    selection,
    code: host.welcome.lobby.code,
    host,
    phase: 'waiting',
    members,
  }, 'S&D invite inherited state');
  pass(Buffer.compare(host.map, guest.map) === 0,
    'S&D invite join inherits the exact Citadel binary map');
  pass(host.map.length === depotBytes.length && Buffer.compare(host.map, depotBytes) !== 0,
    'Citadel and Depot use equally complete but byte-distinct map payloads');
  const citadelGeometry = createShotGeometry('citadel', host.map);

  const liveMarks = await readyAndStart(host, members, selection, signal);
  const prepTickFrame = await nextTickFrame(
    host,
    liveMarks.get(host),
    (tick) => tick.match?.phase === 'prep' && members.every((client) =>
      tick.players.some((row) => row.id === client.welcome.id)),
    'initial S&D preparation tick',
    signal,
  );
  const prepTick = prepTickFrame.value;
  assertPlayerRows(prepTick, members, 'S&D prep tick');
  assertMatchShape(prepTick, selection, 'S&D prep tick');
  assertTeamScores(prepTick.match.scores, 0, 0, 'S&D starts with exact zeroed round scores');
  pass(prepTick.match.phase === 'prep' && Number.isFinite(prepTick.match.phaseEndsAt) &&
    prepTick.match.phaseEndsAt > prepTick.now && prepTick.match.round === 1 &&
    prepTick.match.roundWinner === null && prepTick.match.winner === null &&
    prepTick.match.attackers === 'alpha' && prepTick.match.defenders === 'bravo',
  'S&D prep tick exposes round, timer, and exact attacker/defender roles');
  const hostPrep = playerRow(prepTick, host);
  const guestPrep = playerRow(prepTick, guest);
  pass(hostPrep?.team === 'alpha' && guestPrep?.team === 'bravo' &&
    hostPrep.credits === 800 && guestPrep.credits === 800 &&
    JSON.stringify(hostPrep.owned) === '["revolver"]' &&
    JSON.stringify(guestPrep.owned) === '["revolver"]' &&
    hostPrep.weapon === REVOLVER_SLOT && guestPrep.weapon === REVOLVER_SLOT &&
    hostPrep.spawnProtected === false && guestPrep.spawnProtected === false,
  'S&D prep rows expose exact roles, credits, revolver-only loadouts, and no timed protection');
  pass(prepTick.match.bomb &&
    Object.keys(prepTick.match.bomb).sort().join(',') === 'carrier,explodeAt,site,state,x,y,z' &&
    prepTick.match.bomb.state === 'carried' && prepTick.match.bomb.carrier === host.welcome.id &&
    hostPrep.bomb === true && guestPrep.bomb === false,
  'S&D bomb snapshot and player flag identify the exact attacker carrier');
  const prepTeams = new Map(prepTick.players.map((row) => [row.id, row.team]));
  pass(prepTeams.size === members.length &&
    new Set(prepTeams.values()).size === 2 &&
    prepTeams.get(host.welcome.id) === prepTick.match.attackers &&
    prepTeams.get(guest.welcome.id) === prepTick.match.defenders,
  'S&D prep rows map both exact player identities to their match roles');
  assertInitialTeamAssignments(
    eventsBetween(host, liveMarks.get(host), prepTickFrame.seq),
    prepTick.players,
    'initial S&D team assignment events, when present, exactly match authoritative rows',
  );

  const stablePrepFrame = await nextTickFrame(
    host,
    prepTickFrame.seq,
    (tick) => tick.match?.phase === 'prep' && tick.now > prepTick.now,
    'subsequent S&D preparation tick',
    signal,
  );
  const stablePrepTick = stablePrepFrame.value;
  assertPlayerRows(stablePrepTick, members, 'subsequent S&D prep tick');
  assertMatchShape(stablePrepTick, selection, 'subsequent S&D prep tick');
  const stablePrepTeams = new Map(stablePrepTick.players.map((row) => [row.id, row.team]));
  pass(stablePrepTeams.size === prepTeams.size &&
    [...prepTeams].every(([id, team]) => stablePrepTeams.get(id) === team) &&
    stablePrepTeams.get(host.welcome.id) === stablePrepTick.match.attackers &&
    stablePrepTeams.get(guest.welcome.id) === stablePrepTick.match.defenders &&
    stablePrepTick.match.attackers === prepTick.match.attackers &&
    stablePrepTick.match.defenders === prepTick.match.defenders &&
    stablePrepTick.match.round === prepTick.match.round &&
    stablePrepTick.match.bomb?.carrier === prepTick.match.bomb.carrier &&
    playerRow(stablePrepTick, host)?.bomb === true &&
    playerRow(stablePrepTick, guest)?.bomb === false,
  'subsequent S&D prep tick preserves team mapping, roles, round, and bomb carrier');
  pass(!eventsBetween(host, prepTickFrame.seq, stablePrepFrame.seq)
    .some((event) => event?.kind === 'team_assigned'),
  'initial S&D team assignment events are not replayed on the next tick');
  pass(members.every((client) => client.frames.every((frame) => {
    if (frame.kind !== 'json') return true;
    if (frame.value?.t === 'welcome') {
      return frame.value.id === client.welcome.id &&
        frame.value.lobby?.code === client.welcome.lobby.code &&
        frame.value.lobby?.role === client.welcome.lobby.role;
    }
    return frame.value?.t !== 'lobbyState' ||
      (frame.value.code === host.welcome.lobby.code &&
        frame.value.host === host.welcome.id);
  })), 'S&D welcome and lobby identities remain stable through subsequent prep ticks');

  let mark = host.mark();
  host.send({ t: 'buy', weapon: 'revolver' });
  const purchaseFrame = await nextTickFrame(
    host,
    mark,
    (tick) => tick.events.some((event) => event?.kind === 'purchase' &&
      event.id === host.welcome.id && event.weapon === 'revolver'),
    'valid S&D purchase event',
    signal,
  );
  const purchaseTick = purchaseFrame.value;
  const purchaseEvents = eventsBetween(host, mark, purchaseFrame.seq)
    .filter((event) => event?.kind === 'purchase');
  const [purchase] = purchaseEvents;
  const purchasedHost = playerRow(purchaseTick, host);
  pass(purchasedHost.credits === 800 && purchasedHost.weapon === REVOLVER_SLOT &&
    JSON.stringify(purchasedHost.owned) === '["revolver"]' && purchasedHost.mag[REVOLVER_SLOT] === 6,
  'valid prep purchase succeeds in the authoritative player snapshot');
  pass(purchaseEvents.length === 1 && purchase.id === host.welcome.id &&
    purchase.weapon === 'revolver' && purchase.price === 0 &&
    purchase.credits === purchasedHost.credits && purchasedHost.owned.includes(purchase.weapon),
  'valid prep purchase exposes exactly one event matching the authoritative player snapshot');
  const purchaseReplayFence = await nextTickFrame(
    host,
    purchaseFrame.seq,
    () => true,
    'valid S&D purchase replay fence tick',
    signal,
  );
  pass(!eventsBetween(host, purchaseFrame.seq, purchaseReplayFence.seq)
    .some((event) => event?.kind === 'purchase'),
  'valid prep purchase event is not replayed on the next tick');

  mark = host.mark();
  host.send({ t: 'buy', weapon: 'rifle' });
  const [buyError, rejectedBuyFence] = await Promise.all([
    host.waitForJson(
      (message) => message?.t === 'error' && /purchase unavailable/i.test(message.msg),
      'unaffordable purchase error',
      mark,
      FRAME_TIMEOUT_MS,
      signal,
    ),
    nextTickFrame(host, mark, () => true, 'unaffordable purchase fence tick', signal),
  ]);
  const rejectedHost = playerRow(rejectedBuyFence.value, host);
  pass(/purchase unavailable/i.test(buyError.msg) && rejectedHost.credits === 800 &&
    rejectedHost.weapon === REVOLVER_SLOT && JSON.stringify(rejectedHost.owned) === '["revolver"]' &&
    !eventsBetween(host, mark, rejectedBuyFence.seq).some((event) => event?.kind === 'purchase'),
  'unaffordable buy returns an error without mutating credits, ownership, or events');

  const deployMark = host.mark();
  const deployed = await nextTick(
    host,
    deployMark,
    (tick) => tick.now >= purchaseTick.now + 400 && tick.match.phase === 'prep',
    'deployed prep revolver',
    signal,
  );
  const prepFireMark = host.mark();
  host.input(1, { yaw: playerRow(deployed, host).yaw, pitch: 0, weapon: REVOLVER_SLOT, fire: true });
  await nextTickFrame(host, prepFireMark, () => true, 'blocked prep fire tick', signal);
  const prepReleaseMark = host.mark();
  host.input(2, { yaw: playerRow(deployed, host).yaw, pitch: 0, weapon: REVOLVER_SLOT });
  const prepFireFence = await nextTickFrame(host, prepReleaseMark, () => true, 'prep fire release fence', signal);
  const fireRows = host.frames
    .filter((frame) => frame.seq > prepFireMark && frame.seq <= prepFireFence.seq &&
      frame.kind === 'json' && frame.value?.t === 'tick')
    .map((frame) => playerRow(frame.value, host));
  pass(fireRows.length >= 2 && fireRows.every((row) => row?.firing === false && row.mag[REVOLVER_SLOT] === 6) &&
    !eventsBetween(host, prepFireMark, prepFireFence.seq).some((event) =>
      event?.kind === 'shoot' || event?.kind === 'hit' || event?.kind === 'kill'),
  'S&D prep fire is blocked in snapshots, ammo, and behavior events');

  const liveTransitionMark = host.mark();

  // Stage against the authoritative Citadel bytes and positions while prep
  // runs; movement deadlines scale with the two real route legs.
  await stageSndWestLane(host, guest, deployed, citadelGeometry, signal);

  const liveTickFrame = await nextTickFrame(
    host,
    liveTransitionMark,
    (tick) => tick.match?.phase === 'live' && tick.match.round === 1,
    'S&D round-one live transition',
    signal,
    SND_PHASE_TIMEOUT_MS,
  );
  const liveTick = liveTickFrame.value;
  const livePhaseEvents = eventsBetween(host, liveTransitionMark, liveTickFrame.seq)
    .filter((event) => event?.kind === 'phase' && event.phase === 'live' && event.round === 1);
  assertMatchShape(liveTick, selection, 'S&D live tick');
  pass(Number.isFinite(liveTick.match.phaseEndsAt) && liveTick.match.phaseEndsAt > liveTick.now &&
    livePhaseEvents.length === 1 && livePhaseEvents[0].endsAt === liveTick.match.phaseEndsAt,
  'S&D live transition exposes one phase event with its exact deadline');
  const liveReplayFence = await nextTickFrame(
    host,
    liveTickFrame.seq,
    () => true,
    'S&D live phase replay fence tick',
    signal,
  );
  pass(!eventsBetween(host, liveTickFrame.seq, liveReplayFence.seq)
    .some((event) => event?.kind === 'phase' && event.phase === 'live' && event.round === 1),
  'S&D live phase event is not replayed on the next tick');

  const late = await admit(
    makeClient(port, 'SND-Late'),
    { t: 'join', name: 'SND-Late', lobby: host.welcome.lobby.code.toLowerCase() },
    selection,
    signal,
  );
  const allMembers = [host, guest, late];
  pass(late.welcome.phase === 'live' && late.welcome.lobby.code === host.welcome.lobby.code &&
    Buffer.compare(late.map, host.map) === 0,
  'S&D live late join inherits exact identity and current Citadel bytes');
  assertLobbyState(late.initialState, {
    selection,
    code: host.welcome.lobby.code,
    host,
    phase: 'live',
    members: allMembers,
    ready: new Set([host, guest]),
  }, 'S&D live late-join state');
  const lateTickFrame = await nextTickFrame(
    late,
    0,
    (tick) => tick.match?.phase === 'live' && tick.players.some((row) => row.id === late.welcome.id),
    'late spectator tick',
    signal,
  );
  const lateRow = playerRow(lateTickFrame.value, late);
  assertPlayerRows(lateTickFrame.value, allMembers, 'S&D late-join tick');
  pass(lateRow?.team === 'alpha' && lateRow.state === 'dead' && lateRow.hp === 0 &&
    lateRow.firing === false && lateRow.credits === 800 &&
    JSON.stringify(lateRow.owned) === '["revolver"]' && lateRow.bomb === false,
  'late live join receives a balanced team but remains a dead round spectator');
  pass(lateTickFrame.value.events.some((event) => event?.kind === 'team_assigned' &&
    event.id === late.welcome.id && event.team === 'alpha'),
  'late spectator team assignment is visible on the wire');

  const latestCombatTick = await nextTick(
    host,
    host.mark(),
    (tick) => tick.match.phase === 'live' && playerRow(tick, host)?.state === 'alive' &&
      playerRow(tick, guest)?.state === 'alive',
    'stable live combat tick',
    signal,
  );
  const combatAngles = aimAngles(playerRow(latestCombatTick, host), playerRow(latestCombatTick, guest));
  mark = host.mark();
  host.input(100, { yaw: combatAngles.yaw, pitch: combatAngles.pitch, weapon: REVOLVER_SLOT, ads: true });
  const aimedTick = await nextTick(
    host,
    mark,
    (tick) => {
      const row = playerRow(tick, host);
      return row?.ads && angleDistance(row.yaw, combatAngles.yaw) < 0.002 &&
        Math.abs(row.pitch - combatAngles.pitch) < 0.002;
    },
    'S&D live ADS aim lock',
    signal,
  );
  const settledMark = host.mark();
  const settledCombat = await nextTick(
    host,
    settledMark,
    (tick) => tick.now >= aimedTick.now + 250,
    'S&D live ADS settle',
    signal,
  );

  const firstShotFrame = await fireOne(host, 101, {
    tick: settledCombat,
    client: guest,
    weapon: REVOLVER_SLOT,
  }, signal);
  const firstShot = firstShotFrame.value;
  const firstHit = firstShot.events.find((event) => event?.kind === 'hit' &&
    event.attacker === host.welcome.id && event.victim === guest.welcome.id);
  pass(firstHit && firstHit.dmg > 0 && firstHit.hs === false &&
    playerRow(firstShot, guest)?.state === 'alive' && playerRow(firstShot, guest).hp < 100,
  'first live revolver shot damages only the active enemy on the wire');

  const cooldownMark = host.mark();
  const cooldownTick = await nextTick(
    host,
    cooldownMark,
    (tick) => tick.now >= firstShot.now + 250 && playerRow(tick, guest)?.state === 'alive',
    'S&D revolver cooldown and release',
    signal,
  );
  const secondShotFrame = await fireOne(host, 103, {
    tick: cooldownTick,
    client: guest,
    weapon: REVOLVER_SLOT,
  }, signal);
  const roundEnd = secondShotFrame.value;
  pass(roundEnd.events.some((event) => event?.kind === 'hit' &&
    event.attacker === host.welcome.id && event.victim === guest.welcome.id) &&
    roundEnd.events.some((event) => event?.kind === 'kill' &&
      event.killer === host.welcome.id && event.victim === guest.welcome.id && event.w === 'revolver'),
  'second live revolver shot exposes the enemy elimination');
  pass(roundEnd.match.phase === 'post' && roundEnd.match.round === 1 &&
    roundEnd.match.roundWinner === 'alpha' && roundEnd.match.winner === null &&
    roundEnd.events.some((event) => event?.kind === 'round_end' &&
      event.winner === 'alpha' && event.reason === 'elimination'),
  'enemy elimination advances S&D to the exact round-one post state');
  assertTeamScores(roundEnd.match.scores, 1, 0, 'S&D elimination increments only the attacker round score');

  const latePostFrame = await nextTickFrame(
    late,
    lateTickFrame.seq,
    (tick) => tick.match?.phase === 'post' && tick.match.round === 1,
    'late spectator post-round tick',
    signal,
  );
  const nextRoundFrame = await nextTickFrame(
    late,
    latePostFrame.seq,
    (tick) => tick.match?.phase === 'prep' && tick.match.round === 2 &&
      playerRow(tick, late)?.state === 'alive',
    'late player round-two activation',
    signal,
    SND_PHASE_TIMEOUT_MS,
  );
  const spectatorTicks = late.frames
    .filter((frame) => frame.seq >= lateTickFrame.seq && frame.seq < nextRoundFrame.seq &&
      frame.kind === 'json' && frame.value?.t === 'tick' &&
      frame.value.players.some((row) => row.id === late.welcome.id));
  pass(spectatorTicks.length >= 2 && spectatorTicks.every((frame) => {
    const row = playerRow(frame.value, late);
    return row.state === 'dead' && row.hp === 0 && row.firing === false;
  }), 'late live join remains a spectator through live and post ticks');

  const roundTwo = nextRoundFrame.value;
  const lateRoundTwo = playerRow(roundTwo, late);
  assertPlayerRows(roundTwo, allMembers, 'S&D round-two tick');
  assertMatchShape(roundTwo, selection, 'S&D round-two tick');
  pass(lateRoundTwo.team === 'alpha' && lateRoundTwo.state === 'alive' && lateRoundTwo.hp === 100 &&
    lateRoundTwo.weapon === REVOLVER_SLOT && JSON.stringify(lateRoundTwo.owned) === '["revolver"]' &&
    roundTwo.players.every((row) => row.spawnProtected === false) &&
    roundTwo.events.some((event) => event?.kind === 'round_start' && event.round === 2),
  'S&D round respawns preserve exact roles and revolvers without timed-respawn protection');
  const carrierRows = roundTwo.players.filter((row) => row.bomb);
  pass(roundTwo.match.attackers === 'alpha' && roundTwo.match.defenders === 'bravo' &&
    roundTwo.match.bomb?.state === 'carried' && carrierRows.length === 1 &&
    carrierRows[0].team === roundTwo.match.attackers &&
    carrierRows[0].id === roundTwo.match.bomb.carrier,
  'round two keeps exact roles and one matching attacker bomb carrier');

  await Promise.all(allMembers.map((client) => client.close()));
}

async function runContracts(server, signal) {
  const port = await withTimeout(server.port, START_TIMEOUT_MS, 'server startup timeout', signal);
  pass(Number.isInteger(port) && port > 0, 'server binds an OS-assigned port');

  const badPair = await expectRejected(
    makeClient(port, 'Bad-SND-Depot'),
    { t: 'create', name: 'Bad-SND-Depot', bots: 0, gameMode: 'snd', map: 'depot' },
    4002,
    signal,
  );
  pass(/malformed/i.test(badPair.msg), 'incompatible S&D Depot is rejected as malformed');
  const badMode = await expectRejected(
    makeClient(port, 'Bad-Mode'),
    { t: 'create', name: 'Bad-Mode', bots: 0, gameMode: 'TDM', map: 'depot' },
    4002,
    signal,
  );
  pass(/malformed/i.test(badMode.msg), 'malformed mode identity is rejected');
  const badMap = await expectRejected(
    makeClient(port, 'Bad-Map'),
    { t: 'create', name: 'Bad-Map', bots: 0, gameMode: 'tdm', map: 'DEPOT' },
    4002,
    signal,
  );
  pass(/malformed/i.test(badMap.msg), 'malformed map identity is rejected');

  const maps = await runQuickRotation(port, signal);
  await runTdmDepot(port, maps.depotBytes, signal);
  await runSndCitadel(port, maps.depotBytes, signal);

  const observedRate = Math.max(...Array.from(clients, (client) => client.maxSentInOneSecond()));
  pass(peakOpenSockets < 8 && peakOpenSockets < 32,
    `all scenarios remain below room and global socket caps (${peakOpenSockets} peak)`);
  pass(observedRate < 180,
    `all clients remain below the server message-rate limit (${observedRate} msg/s peak)`);
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
    () => controller.abort(new Error(`mode lobby smoke exceeded ${OVERALL_TIMEOUT_MS} ms`)),
    OVERALL_TIMEOUT_MS,
  );
  const onSigint = () => controller.abort(new Error('mode lobby smoke interrupted by SIGINT'));
  const onSigterm = () => controller.abort(new Error('mode lobby smoke interrupted by SIGTERM'));
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  let failure = null;
  try {
    await Promise.race([
      runContracts(activeServer, controller.signal),
      activeServer.failIfUnexpected(),
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
  console.log(`MODE LOBBY SMOKE: ALL OK (${checks} checks)`);
}

main().catch((error) => {
  const serverOutput = activeServer && (activeServer.stderr.trim() || activeServer.stdout.trim());
  console.error(`MODE LOBBY SMOKE: FAIL - ${error.message}`);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
});
