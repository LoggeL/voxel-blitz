// voxel-blitz entrypoint: one HTTP port serving /public statically and hosting
// the authoritative game WebSocket. `node server/index.js` (PORT env, default 8070).
import http from 'node:http';
import { CareerService } from './career.js';
import { normalizeWeaponLoadout } from '../shared/weapon-attachments.js';
import { AccountService } from './accounts.js';
import { PostgresStore } from './persistence/postgres.js';
import { WebSocketServer, WebSocket } from 'ws';
import { staticHandler } from './static.js';
import { LobbyManager } from './lobby.js';
import { ServerDiagnostics } from './diagnostics.js';
import { TICK_MS, parseAdmissionFrame, parseBuyFrame } from './protocol/admission.js';

const MAX_CONNECTIONS = 256;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_SECOND = 180;
// Allow two complete large-map replacements plus snapshots during host edits.
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

// One flaky socket must never take the arena down: log and keep serving.
process.on('uncaughtException', (err) => {
  console.error('[voxel-blitz] uncaught:', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[voxel-blitz] unhandled rejection:', err && err.stack || err);
});

function resolvePort() {
  const v = Number.parseInt(process.env.PORT, 10);
  return Number.isInteger(v) && v >= 0 && v <= 65535 ? v : 8070;
}

/** Strip controls/zero-widths, collapse whitespace, clamp to 16 chars. */
export function sanitizeName(raw, ordinal) {
  let name = typeof raw === 'string' ? raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16) : '';
  const suffix = Number.isSafeInteger(ordinal) ? ordinal : '';
  return name.length > 0 ? name : 'Rookie' + suffix;
}

async function main() {
  const port = resolvePort();

  const clients = new Map();   // id -> connection metadata
  const diagnostics = new ServerDiagnostics();
  const persistence = process.env.VB_PERSISTENCE || (process.env.DATABASE_URL ? 'postgres' : 'file');
  if (!['postgres', 'file'].includes(persistence)) throw new Error('VB_PERSISTENCE must be postgres or file');
  if (persistence === 'file') console.warn('[persistence] legacy JSON storage active; configure PostgreSQL and run db:import-json to migrate existing progress');
  const store = persistence === 'postgres' ? await PostgresStore.open({ onLost() {
    console.error('[persistence] database connection and writer lease lost; restart required');
    process.exit(1);
  } }) : null;
  const accounts = await AccountService.create({ store,
    onRegistering(req) { return career.prepareGuest(req); },
    onRegistered(req, user, context) { return career.adoptGuest(req, user, context); },
  });
  const career = await CareerService.create({ accounts, store });
  let connCounter = 0;

  function terminateClient(c) {
    try { c.ws.terminate(); } catch { /* already down */ }
  }

  function closeClient(c, code, reason) {
    try { c.ws.close(code, reason); } catch { /* already down */ }
  }

  function sendFrame(c, payload) {
    const ws = c.ws;
    if (ws.readyState !== WebSocket.OPEN) return false;
    const frameBytes = typeof payload === 'string'
      ? Buffer.byteLength(payload)
      : payload.byteLength;
    if (!Number.isFinite(frameBytes) ||
        ws.bufferedAmount + frameBytes > MAX_QUEUED_BYTES) {
      terminateClient(c);
      return false;
    }
    try {
      ws.send(payload, (err) => {
        if (err) terminateClient(c);
      });
      return true;
    } catch {
      terminateClient(c);
      return false;
    }
  }

  function sendJson(c, obj) {
    try {
      // Session revocation affects existing sockets immediately. A guest can
      // keep playing, but an old login or claimed guest token earns no XP.
      if (c.authRequest) {
        const current = career.identity(c.authRequest);
        c.profileId = current === c.admittedProfileId ? current : null;
      }
      obj = career.decorateSnapshot(obj, clients);
      const saving = career.observe(c, obj);
      saving?.catch(error => {
        if (!c.careerErrorLogged) console.error('[career] reward save failed:', error.message);
        c.careerErrorLogged = true;
      });
    } catch (error) {
      // Storage trouble must never interrupt the simulation's outgoing frames.
      if (!c.careerErrorLogged) console.error('[career] reward failed:', error.message);
      c.careerErrorLogged = true;
    }
    let payload;
    try { payload = JSON.stringify(obj); } catch { return false; }
    return sendFrame(c, payload);
  }

  const manager = new LobbyManager({
    sendJson,
    sendFrame,
    closeClient,
    tickMs: TICK_MS,
  });

  const server = http.createServer(async (req, res) => {
    try {
      try {
        if (decodeURIComponent(req.url || '/').includes('\0')) throw new URIError('NUL');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ t: 'error', msg: 'bad request' }));
        return;
      }
      if (await accounts.handleHttp(req, res)) return;
      if (await career.handleHttp(req, res)) return;
      if ((req.url || '').split('?')[0] === '/healthz' && req.method === 'GET') {
        store?.assertAvailable();
        const healthy = !store || store.healthy;
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: healthy ? 'ok' : 'saving delayed', persistence }));
        return;
      }
      if ((req.url || '').split('?')[0] === '/api/lobbies' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ lobbies: manager.list() }));
        return;
      }
      // Pass the original target through: staticHandler owns decoding and root
      // validation. Decoding it here as well can turn encoded filenames into paths.
      if (await staticHandler(req, res)) return;
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ t: 'error', msg: 'not found' }));
    } catch (err) {
      console.error('[voxel-blitz] http error:', err.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ t: 'error', msg: 'internal error' }));
    }
  });

  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: (info, accept) => {
      // Browser sockets share account cookies, so only our own page may open
      // them. Headless protocol clients without an Origin remain supported.
      const origin = info.req.headers.origin;
      if (origin) {
        try {
          const source = new URL(origin);
          if (!['http:', 'https:'].includes(source.protocol) || source.host !== info.req.headers.host) {
            accept(false, 403, 'Origin not allowed'); return;
          }
        } catch { accept(false, 403, 'Origin not allowed'); return; }
      }
      if (wss.clients.size >= MAX_CONNECTIONS) {
        accept(false, 503, 'Arena full');
        return;
      }
      accept(true);
    },
  });
  wss.on('connection', (ws, req) => {
    // Defense in depth for custom WebSocketServer implementations that skip
    // verifyClient; reject before allocating arena metadata or a player id.
    if (clients.size >= MAX_CONNECTIONS) {
      try { ws.close(1013, 'arena full'); } catch { /* already down */ }
      return;
    }

    const n = ++connCounter;
    const id = 'p' + n + '_' + Math.random().toString(36).slice(2, 8);
    let admittedProfileId = null;
    try { admittedProfileId = career.identity(req); }
    catch (error) { console.error('[career] player profile unavailable:', error.message); }
    const meta = {
      id,
      ws,
      joined: false,
      authRequest: { headers: { cookie: req.headers.cookie } },
      admittedProfileId,
      profileId: admittedProfileId,
      alive: true,
      messageTokens: MAX_MESSAGES_PER_SECOND,
      messageRefillAt: Date.now(),
      rateLimited: false,
    };
    clients.set(id, meta);
    // Load once on admission; HTTP equipment changes and accepted rewards keep
    // the server-owned cosmetic cache fresh without database reads in ticks.
    if (admittedProfileId) Promise.resolve().then(() => career.readProfile(admittedProfileId)).catch(error => {
      career.loadouts.delete(admittedProfileId);
      console.error('[career] cosmetic profile unavailable:', error.message);
    });

    ws.on('pong', (payload) => {
      meta.alive = true;
      if (meta.pingSentAt != null && payload.toString() === meta.pingPayload) {
        const player = meta.room?.engine?.entities.get(meta.id);
        meta.ping = Math.max(0, Math.round(performance.now() - meta.pingSentAt));
        meta.pingMeasuredAt = performance.now();
        meta.pingSequence = (meta.pingSequence || 0) + 1;
        if (player) player.ping = meta.ping;
        manager.updatePing(meta);
        meta.pingSentAt = null;
      }
    });
    ws.on('error', () => { /* 'close' always follows */ });

    const joinTimer = setTimeout(() => {
      if (!meta.joined) {
        try { ws.close(4008, 'join timeout'); } catch { /* already down */ }
      }
    }, 10000);
    ws.on('message', async (data, isBinary) => {
      if (meta.rateLimited || ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      const elapsed = now - meta.messageRefillAt;
      meta.messageTokens = elapsed < 0
        ? MAX_MESSAGES_PER_SECOND
        : Math.min(
          MAX_MESSAGES_PER_SECOND,
          meta.messageTokens + elapsed * MAX_MESSAGES_PER_SECOND / 1000,
        );
      meta.messageRefillAt = now;
      if (meta.messageTokens < 1) {
        meta.rateLimited = true;
        try { ws.close(4009, 'message rate exceeded'); } catch { /* already down */ }
        return;
      }
      meta.messageTokens--;

      if (!meta.joined) {
        if (meta.admitting) return;
        if (isBinary) return;                       // binaries from clients are ignored
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch { msg = null; }

        const admission = parseAdmissionFrame(msg);
        if (!admission) {
          let error = 'invalid join';
          if (msg && typeof msg === 'object') {
            if (msg.t === 'create') {
              error = 'Malformed lobby creation request';
            } else if (msg.t === 'join') {
              error = Object.prototype.hasOwnProperty.call(msg, 'lobby')
                ? 'Malformed lobby join request'
                : 'Malformed quick-play request';
            }
          }
          sendJson(meta, { t: 'error', msg: error });
          closeClient(meta, 4002, 'bad join');
          return;
        }

        const name = accounts.identity(req)?.username || sanitizeName(admission.name, n);
        let admitted = false;
        meta.admitting = true;
        try {
          // Career outages must not prevent gameplay; both peers receive factory gear.
          let profile = null;
          try {
            const profileId = career.identity(req);
            if (profileId) profile = await career.readProfile(profileId);
            if (career.identity(req) !== profileId) profile = null;
          } catch { profile = null; }
          meta.weaponLoadout = normalizeWeaponLoadout(profile?.equipped?.weaponAttachments);
          if (admission.kind === 'quick') {
            admitted = manager.quickPlay(meta, name, admission.bots);
          } else if (admission.kind === 'create') {
            admitted = await manager.create(
              meta,
              name,
              admission.bots,
              admission.gameMode,
              admission.map,
              admission.password,
            );
          } else {
            admitted = await manager.join(meta, name, admission.lobby, admission.password);
          }
        } catch (err) {
          console.error('[voxel-blitz] join failed for', id, err.message);
          try { manager.leave(meta); } catch { /* retain original failure */ }
          closeClient(meta, 1011, 'internal error');
          return;
        } finally {
          meta.admitting = false;
        }

        if (admitted) clearTimeout(joinTimer);
        return;
      }

      if (isBinary) return;                         // binaries from clients are ignored
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;

      try {
        if (msg.t === 'ping') {
          if (Number.isSafeInteger(msg.nonce)) {
            const pong = { t: 'pong', nonce: msg.nonce };
            const at = performance.now();
            if (msg.diagnostics === true && (meta.lastDiagnosticsAt == null || at - meta.lastDiagnosticsAt >= 1000)) {
              pong.diagnostics = diagnostics.read(meta, at);
              meta.lastDiagnosticsAt = at;
            }
            sendJson(meta, pong);
            if (meta.pingSentAt == null) {
              meta.pingSentAt = performance.now();
              meta.pingPayload = String(msg.nonce);
              ws.ping(meta.pingPayload);
            }
          }
          return;
        }
        if (msg.t === 'configure') {
          manager.configure(meta, msg);
          return;
        }
        if (msg.t === 'botDifficulty') {
          manager.setBotDifficulty(meta, msg.id, msg.difficulty);
          return;
        }
        if (msg.t === 'team') {
          manager.setTeam(meta, msg.id, msg.team);
          return;
        }
        if (msg.t === 'ready') {
          manager.ready(meta, msg.value);
          return;
        }
        if (msg.t === 'start') {
          manager.start(meta);
          return;
        }
        if (msg.t === 'continue') {
          manager.approveContinuation(meta, msg.roundId);
          return;
        }
        if (msg.t === 'input') {
          manager.input(meta, msg);
          return;
        }
        if (msg.t === 'buy') {
          manager.buy(meta, parseBuyFrame(msg));
          return;
        }
        if (msg.t === 'chat') {
          const text = String(typeof msg.text === 'string' ? msg.text : '').slice(0, 120).trim();
          if (text) manager.chat(meta, text);
        }
      } catch { /* malformed game traffic must not kill sockets */ }
    });

    ws.on('close', (code) => {
      meta.closed = true;
      clearTimeout(joinTimer);
      try {
        career.detachClient(meta);
        manager.leave(meta, { reconnectable: code === 1006 || code === 1001 });
      } catch (err) {
        console.error('[voxel-blitz] lobby leave:', err.message);
      }
      clients.delete(id);
    });
  });

  // Terminate silently-dead sockets every 30 s.
  const heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) { terminateClient(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { terminateClient(c); }
    }
  }, 30000);
  heartbeat.unref();

  server.listen(port, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : port;
    console.log(`voxel-blitz listening on :${boundPort}`);
  });
  server.on('error', (err) => {
    console.error('[voxel-blitz] server error:', err.message);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[voxel-blitz] ${sig} received, shutting down`);
    clearInterval(heartbeat);
    diagnostics.dispose();
    try { manager.stop(); } catch (err) { console.error('[voxel-blitz] lobby stop:', err.message); }
    for (const c of clients.values()) {
      try { c.ws.close(1001, 'server shutdown'); } catch { /* gone */ }
    }
    wss.close(() => {});
    const stopped = new Promise(resolve => server.close(resolve));
    const deadline = setTimeout(() => { console.error('[persistence] shutdown timed out'); process.exit(1); }, 10000);
    deadline.unref();
    try {
      await accounts.dispose();
      await career.dispose();
      await store?.close();
      await stopped;
      clearTimeout(deadline);
      process.exit(0);
    } catch { console.error('[persistence] shutdown save failed'); process.exit(1); }
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[voxel-blitz] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
