// voxel-blitz entrypoint: one HTTP port serving /public statically and hosting
// the authoritative game WebSocket. `node server/index.js` (PORT env, default 8070).
import http from 'node:http';
import { CareerService } from './career.js';
import { careerLevel } from '../shared/career.js';
import { allowedWeaponLoadout } from './weapon-loadouts.js';
import { masteryView } from './persistence/career-profile.js';
import { AccountService } from './accounts.js';
import { PostgresStore } from './persistence/postgres.js';
import { WebSocketServer, WebSocket } from 'ws';
import { staticHandler } from './static.js';
import { LobbyManager } from './lobby.js';
import { ServerDiagnostics } from './diagnostics.js';
import { createMapState, getMapDimensions, getMapMeta } from '../shared/worlddata.js';
import { MAP_IDS } from '../shared/modes.js';
import { prepareStructureTemplate, warmStructureTemplates } from './sim/structure.js';
import { afterRoomTick } from './game.js';
import { surfaceNavigation } from './bot-navigation.js';
import { roadGraph } from './bot-vehicle-driving.js';
import { coalesceTick, resetHeldTicks, tickSent, tickSettled } from './protocol/tick-backlog.js';
import { TICK_MS, parseAdmissionFrame, parseBuyFrame, parseConquestIntent, sanitizeName } from './protocol/admission.js';

const MAX_CONNECTIONS = 256;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_SECOND = 180;
// Allow two complete large-map replacements plus snapshots during host edits.
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
// Server-initiated closes that a rejoin would only repeat (bad join, ban, stale page).
const KICK_CLOSE_CODES = new Set([4002, 4003, 4010]);
// Consecutive snapshots repeat almost every byte, so a per-connection deflate
// context (window >= one full 20 kB snapshot) shrinks them 20-40x. Less data on
// the wire keeps home and mobile uplinks free of queueing delay, which is what
// players see as ping. Small frames (pings, lobby state) skip zlib entirely.
const COMPRESSION = {
  threshold: 1024,
  serverNoContextTakeover: false,
  clientNoContextTakeover: false,
  serverMaxWindowBits: 15,
  zlibDeflateOptions: { level: 1, memLevel: 8 },
  zlibInflateOptions: { chunkSize: 16 * 1024 },
  concurrencyLimit: 16,
};

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

  // Server-side drops name their cause once, so a reconnect loop can be traced.
  function terminateClient(c, reason = 'terminated') {
    if (!c.dropReason) {
      c.dropReason = reason;
      console.warn(`[voxel-blitz] dropping ${c.id} (${c.room?.code || 'no room'}): ${reason}, queued ${c.ws.bufferedAmount} B`);
    }
    try { c.ws.terminate(); } catch { /* already down */ }
  }

  function closeClient(c, code, reason) {
    try { c.ws.close(code, reason); } catch { /* already down */ }
  }

  function sendFrame(c, payload, settled = null) {
    const ws = c.ws;
    if (ws.readyState !== WebSocket.OPEN) return false;
    // A binary frame is a map: deltas held for the previous world are void.
    if (typeof payload !== 'string') resetHeldTicks(c);
    const frameBytes = typeof payload === 'string'
      ? Buffer.byteLength(payload)
      : payload.byteLength;
    if (!Number.isFinite(frameBytes) ||
        ws.bufferedAmount + frameBytes > MAX_QUEUED_BYTES) {
      terminateClient(c, Number.isFinite(frameBytes) ? 'send queue full' : 'unsendable frame');
      return false;
    }
    try {
      ws.send(payload, (err) => {
        settled?.(c);
        // A peer that closed mid-compression is a normal disconnect, not a drop.
        if (err && ws.readyState === WebSocket.OPEN) terminateClient(c, `send failed: ${err.message}`);
      });
      return true;
    } catch (err) {
      terminateClient(c, `send threw: ${err?.message}`);
      return false;
    }
  }

  // One tick snapshot reaches every member of a room; serialize it once.
  const payloadCache = new WeakMap();

  // `source` is the authoritative tick behind a per-recipient view (TTT hides
  // kill events from players); rewards are always observed on the full tick.
  function sendJson(c, obj, source = obj) {
    try {
      // Session revocation affects existing sockets immediately. A guest can
      // keep playing, but an old login or claimed guest token earns no XP.
      career.refreshClientIdentity(c);
      obj = career.decorateSnapshot(obj, clients);
      const saving = career.observe(c, source);
      // File persistence returns the updated profile; PostgreSQL returns a promise.
      saving?.catch?.(error => {
        if (!c.careerErrorLogged) console.error('[career] reward save failed:', error.message);
        c.careerErrorLogged = true;
      });
    } catch (error) {
      // Storage trouble must never interrupt the simulation's outgoing frames.
      if (!c.careerErrorLogged) console.error('[career] reward failed:', error.message);
      c.careerErrorLogged = true;
    }
    if (obj.t === 'welcome' || obj.t === 'lobbyConfig') resetHeldTicks(c);
    if (obj.t === 'tick') {
      // Backpressure: a client whose earlier snapshots are still in flight
      // skips this one; its deltas ride along with the next snapshot sent.
      const out = c.ws.readyState === WebSocket.OPEN ? coalesceTick(c, obj) : obj;
      if (out === null) return true;
      if (out !== obj) {
        let merged;
        try { merged = JSON.stringify(out); } catch { return false; }
        tickSent(c);
        if (sendFrame(c, merged, tickSettled)) return true;
        tickSettled(c);
        return false;
      }
    }
    let payload = payloadCache.get(obj);
    if (payload === undefined) {
      try { payload = JSON.stringify(obj); } catch { return false; }
      if (obj.t === 'tick') payloadCache.set(obj, payload);
    }
    if (obj.t !== 'tick') return sendFrame(c, payload);
    tickSent(c);
    if (sendFrame(c, payload, tickSettled)) return true;
    tickSettled(c);
    return false;
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
        // `healthy` already covers a lost writer and a failed reward save.
        const healthy = !store || store.healthy;
        const status = healthy ? 'ok' : store.rewardError ? 'saving failed' : store.active ? 'saving delayed' : 'unavailable';
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status, persistence }));
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
    perMessageDeflate: COMPRESSION,
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
      remoteAddress: req.socket?.remoteAddress || 'unknown',
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
          meta.weaponLoadout = allowedWeaponLoadout(profile);
          // V3 map frames for clients with a map cache (lobby.js mapFrameFor).
          meta.mapCache = admission.mapCache ? [...admission.mapCache] : null;
          // Conquest wire contract of the tab's code (0 = a tab from before the check).
          meta.clientContract = admission.contract ?? 0;
          meta.mastery = masteryView(profile?.mastery);
          // Authoritative level for the Conquest kit unlocks (guests without a career are level 1).
          meta.careerLevel = profile ? careerLevel(profile.xp) : 1;
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
              admission.directStart,
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
        if (msg.t === 'conquest') {
          manager.conquest(meta, parseConquestIntent(msg));
          return;
        }
        if (msg.t === 'chat') manager.chat(meta, msg.text);
      } catch { /* malformed game traffic must not kill sockets */ }
    });

    ws.on('close', (code, reason) => {
      meta.closed = true;
      clearTimeout(joinTimer);
      const room = meta.room?.code;
      // 1000/1001 are a normal goodbye or a closed tab; anything else is worth tracing.
      if (room && meta.joined && !meta.dropReason && code !== 1000 && code !== 1001) {
        console.warn(`[voxel-blitz] ${id} (${room}) disconnected: code ${code}${reason?.length ? ` ${reason}` : ''}`);
      }
      try {
        career.detachClient(meta);
        // Only a deliberate client goodbye (1000) or a kick closes the room for good;
        // every other drop leaves the 30 s window in which the player can rejoin.
        manager.leave(meta, { reconnectable: code !== 1000 && !KICK_CLOSE_CODES.has(code) });
      } catch (err) {
        console.error('[voxel-blitz] lobby leave:', err.message);
      }
      clients.delete(id);
    });
  });

  // Terminate silently-dead sockets every 30 s.
  const heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) { terminateClient(c, 'heartbeat timeout (no pong in 30 s)'); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { terminateClient(c, 'heartbeat ping failed'); }
    }
  }, 30000);
  heartbeat.unref();

  // Frontier's template, metadata, wire bytes, surface graph and road graph
  // are built on first use (~0.7 s of synchronous work). Build them before
  // accepting players, so the first Conquest room does not stall every match.
  const structural = process.env.VOXEL_STRUCTURAL !== '0';
  {
    const started = performance.now();
    const mapMeta = getMapMeta('frontier');
    const world = createMapState('frontier');
    world.serializeWorld();
    world.mapFrame();
    surfaceNavigation(world);
    roadGraph({ mapMeta });
    // Its structural template field too (~110 ms here, ~400 ms on the production host):
    // built at the first Frontier room's creation it stalled every running room.
    const fieldStarted = performance.now();
    if (structural) prepareStructureTemplate(world);
    console.log(`[voxel-blitz] Frontier prepared in ${Math.round(performance.now() - started)} ms`
      + (structural ? ` (structure field ${Math.round(performance.now() - fieldStarted)} ms)` : ''));
  }

  server.listen(port, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : port;
    console.log(`voxel-blitz listening on :${boundPort}`);
    // The other maps' structural template fields (2-50 ms each), smallest first,
    // in slices of at most 2 ms run right after a room tick (or at once while no
    // room ticks), so no running room waits for one and no first room on a map
    // builds its field inside its creation.
    if (structural && process.env.VOXEL_STRUCTURE_WARM !== '0') {
      const started = performance.now();
      const volume = (id) => { const d = getMapDimensions(id); return d.sx * d.sy * d.sz; };
      const maps = MAP_IDS.filter(id => id !== 'frontier').sort((a, b) => volume(a) - volume(b));
      void warmStructureTemplates(maps.map(id => () => createMapState(id)), {
        schedule: afterRoomTick, sliceMs: 2,
      }).then((timings) => {
        const failed = timings.filter(row => row.error);
        console.log(`[voxel-blitz] structure templates warmed: ${timings.length - failed.length} maps by ${Math.round(performance.now() - started)} ms`
          + ` after listening (work ${Math.round(timings.reduce((sum, row) => sum + row.ms, 0))} ms in ${timings.reduce((sum, row) => sum + row.slices, 0)}`
          + ` slices, longest slice ${(Math.max(0, ...timings.map(row => row.longest))).toFixed(1)} ms)`);
        for (const row of failed) console.error('[voxel-blitz] structure template warm failed:', row.error);
      });
    }
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
