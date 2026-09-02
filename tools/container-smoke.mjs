import WebSocket from 'ws';
import {
  MATCH_KEYS as MATCH_KEY_LIST,
  PLAYER_KEYS as PLAYER_KEY_LIST,
} from './lib/protocol-contract.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8070';
const HARD_TIMEOUT_MS = 15_000;
const PLAYER_KEYS = PLAYER_KEY_LIST.split(',');
const MATCH_KEYS = MATCH_KEY_LIST.split(',');
const WELCOME_KEYS = [
  'gameMode', 'id', 'lobby', 'map', 'mapBytes', 'phase', 'spawn', 't',
  'tickRate',
];
const LOBBY_KEYS = [
  'bots', 'code', 'gameMode', 'host', 'map', 'members', 'phase', 't',
];
const TICK_KEYS = ['blocks', 'events', 'match', 'now', 'players', 't'];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function parseBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid BASE_URL: ${raw}`);
  }
  requireCondition(url.protocol === 'http:' || url.protocol === 'https:',
    'BASE_URL must use http: or https:');
  return url;
}

function endpoint(baseUrl, path) {
  return new URL(path, baseUrl).href;
}

async function fetchBytes(baseUrl, path, signal) {
  const response = await fetch(endpoint(baseUrl, path), {
    redirect: 'manual',
    signal,
  });
  const body = Buffer.from(await response.arrayBuffer());
  requireCondition(response.status >= 200 && response.status < 300,
    `${path} returned HTTP ${response.status}`);
  return {
    body,
    contentType: (response.headers.get('content-type') || '').toLowerCase(),
  };
}

async function checkHttp(baseUrl, signal) {
  const root = await fetchBytes(baseUrl, '/', signal);
  const headless = await fetchBytes(baseUrl, '/?headless=1', signal);
  const shared = await fetchBytes(baseUrl, '/shared/combatmath.js?v=smoke', signal);

  requireCondition(root.contentType.startsWith('text/html'),
    `/ has non-HTML content type ${JSON.stringify(root.contentType)}`);
  requireCondition(headless.contentType.startsWith('text/html'),
    `/?headless=1 has non-HTML content type ${JSON.stringify(headless.contentType)}`);
  requireCondition(root.body.equals(headless.body),
    '/ and /?headless=1 returned different bytes');
  requireCondition(/^(?:text|application)\/(?:java|ecma)script(?:;|$)/.test(shared.contentType),
    `/shared/combatmath.js?v=smoke has non-JavaScript content type ${JSON.stringify(shared.contentType)}`);

  return { htmlBytes: root.body.length, moduleBytes: shared.body.length };
}

function validateWelcome(message) {
  requireCondition(hasExactKeys(message, WELCOME_KEYS), 'welcome frame is incomplete');
  requireCondition(message.gameMode === 'fun' && ['foundry', 'depot', 'solstice', 'caldera'].includes(message.map),
    `welcome identity is ${JSON.stringify({ mode: message.gameMode, map: message.map })}`);
  requireCondition(typeof message.id === 'string' && message.id.length > 0,
    'welcome has no player id');
  requireCondition(Number.isInteger(message.mapBytes) && message.mapBytes > 0,
    `welcome has invalid mapBytes ${JSON.stringify(message.mapBytes)}`);
}

function validateLobby(message, playerId, expectedMap) {
  requireCondition(hasExactKeys(message, LOBBY_KEYS), 'lobby state is incomplete');
  requireCondition(message.gameMode === 'fun' && message.map === expectedMap,
    `lobby identity is ${JSON.stringify({ mode: message.gameMode, map: message.map })}`);
  requireCondition(Array.isArray(message.members), 'lobby members is not an array');
  requireCondition(message.members.every((member) =>
    hasExactKeys(member, ['bot', 'id', 'name', 'ready'])),
  'lobby contains an incomplete member');
  requireCondition(message.members.some((member) =>
    member.id === playerId && member.name === 'ContainerSmoke' && member.bot === false),
  'lobby does not contain ContainerSmoke');
}

function validateTick(message, playerId, expectedMap) {
  requireCondition(hasExactKeys(message, TICK_KEYS), 'tick frame is incomplete');
  requireCondition(hasExactKeys(message.match, MATCH_KEYS), 'tick match is incomplete');
  requireCondition(message.match.mode === 'fun' && message.match.map === expectedMap,
    `tick identity is ${JSON.stringify({ mode: message.match.mode, map: message.match.map })}`);
  requireCondition(Array.isArray(message.players) && message.players.length > 0,
    'tick has no players');
  requireCondition(message.players.every((player) => hasExactKeys(player, PLAYER_KEYS)),
    'tick contains an incomplete player');
  requireCondition(message.players.some((player) =>
    player.id === playerId && player.name === 'ContainerSmoke'),
  'tick does not contain ContainerSmoke');
  requireCondition(Array.isArray(message.blocks) && Array.isArray(message.events),
    'tick blocks/events are incomplete');
}

function exchangeFrames(ws, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let welcome = null;
    let lobby = null;
    let tick = null;
    let mapBytes = null;
    let binaryFrames = 0;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      ws.off('open', onOpen);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ welcome, mapBytes });
    };
    const inspectCompletion = () => {
      if (!welcome || mapBytes === null || !lobby || !tick) return;
      try {
        requireCondition(binaryFrames === 1,
          `received ${binaryFrames} binary map frames instead of one`);
        requireCondition(mapBytes === welcome.mapBytes,
          `binary map is ${mapBytes} bytes; welcome advertised ${welcome.mapBytes}`);
        validateLobby(lobby, welcome.id, welcome.map);
        validateTick(tick, welcome.id, welcome.map);
        finish();
      } catch (error) {
        finish(new Error(
          `server behavior error: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    };
    const onAbort = () => finish(signal.reason instanceof Error
      ? signal.reason
      : new Error('container smoke timed out'));
    const onOpen = () => {
      ws.send(JSON.stringify({
        t: 'join',
        name: 'ContainerSmoke',
      }), (error) => {
        if (error) finish(new Error(`join send failed: ${error.message}`));
      });
    };
    const onMessage = (data, isBinary) => {
      try {
        if (isBinary) {
          binaryFrames++;
          requireCondition(binaryFrames === 1, 'received more than one binary map frame');
          mapBytes = data.byteLength;
          inspectCompletion();
          return;
        }

        let message;
        try {
          message = JSON.parse(data.toString('utf8'));
        } catch {
          throw new Error('received a non-JSON text frame');
        }
        if (message?.t === 'error') {
          throw new Error(`server rejected smoke client: ${message.msg || 'unknown error'}`);
        }
        if (message?.t === 'welcome') {
          requireCondition(welcome === null, 'received more than one welcome frame');
          validateWelcome(message);
          welcome = message;
        } else if (message?.t === 'lobbyState') {
          lobby = message;
        } else if (message?.t === 'tick') {
          tick = message;
        }
        inspectCompletion();
      } catch (error) {
        finish(new Error(
          `server behavior error: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    };
    const onClose = (code, reason) => finish(new Error(
      `WebSocket transport closed before smoke completed (${code}${reason.length ? `: ${reason.toString()}` : ''})`,
    ));
    const onError = (error) => finish(new Error(`WebSocket transport error: ${error.message}`));

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    ws.on('open', onOpen);
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

function closeCleanly(ws, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      ws.off('close', onClose);
      ws.off('error', onError);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal.reason instanceof Error
      ? signal.reason
      : new Error('container smoke timed out during socket close'));
    const onClose = (code) => finish(code === 1000
      ? null
      : new Error(`WebSocket transport closed with code ${code} instead of 1000`));
    const onError = (error) => finish(new Error(`WebSocket transport close failed: ${error.message}`));

    if (signal.aborted) {
      onAbort();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      finish(new Error('socket was not open for clean shutdown'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    ws.on('close', onClose);
    ws.on('error', onError);
    ws.close(1000, 'container smoke complete');
  });
}

async function checkWebSocket(baseUrl, signal) {
  const wsUrl = new URL('/', baseUrl);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.search = '';
  wsUrl.hash = '';

  const ws = new WebSocket(wsUrl);
  ws.on('error', () => {});
  try {
    const result = await exchangeFrames(ws, signal);
    await closeCleanly(ws, signal);
    return result;
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) {
      try { ws.terminate(); } catch {}
    }
    ws.removeAllListeners();
  }
}

async function main() {
  const baseUrl = parseBaseUrl(process.env.BASE_URL || DEFAULT_BASE_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`hard timeout after ${HARD_TIMEOUT_MS}ms`));
  }, HARD_TIMEOUT_MS);

  try {
    const http = await checkHttp(baseUrl, controller.signal);
    const socket = await checkWebSocket(baseUrl, controller.signal);
    console.log(
      `container smoke ok: HTTP html=${http.htmlBytes}B shared=${http.moduleBytes}B; ` +
      `WS fun/${socket.welcome.map} map=${socket.mapBytes}B lobby+tick`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

try {
  await main();
} catch (error) {
  console.error(`container smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
