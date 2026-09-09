import { parseChaosPurchase } from '../../../shared/chaos.js';
import { SX, SY, SZ } from '../../../shared/world/blocks.js';
import {
  mapForMode,
  isWeaponId,
  normalizeModeId,
} from '../../../shared/modes.js';
import {
  clampGrenadeCharge,
  clampGrenadeCook,
  clampGrenadeType,
  grenadeTypeAt,
} from '../../../shared/grenade-rules.js';
import { NetworkTiming } from './network-timing.js';
import {
  findSnapshotWindow,
  sampleRemoteTransform,
} from './snapshot-smoothing.js';

// Voxel Blitz — WebSocket client + snapshot interpolation layer.
//
// Transport: JSON text frames; binary frames carry the serialized map
// pushed by the server immediately after {t:'welcome'} (paired by arrival
// order on this socket), or after a waiting-room lobbyConfig update.
//
// Snapshot interpolation lives in snapshot-smoothing.js. Event draining below
// tracks delivered sequence numbers across frames.

const INTERP_SPAN = 65536;        // events-per-snapshot domain for composite ids
const SEEN_SOFT_CAP = 8192;       // dedupe set size before pruning oldest half
const RING_LEN = 32;

/** JSON-wire copy with every retained object/array made immutable. */
const immutableWireCopy = (value) => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableWireCopy(item)));
  }
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, immutableWireCopy(item)]),
    ));
  }
  return value;
};

/** Timestamp seam: performance.now() when present, Date.now() otherwise. */
const now = () =>
  (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();

/**
 * Drains every event living in snapshots whose `.now <= upTo`, in arrival
 * order, emitting each event EXACTLY ONCE across repeated calls thanks to
 * shared monotonic-id dedupe state.
 *
 * Event identity prefers the server-supplied `ev.seq` when finite ("per-event
 * monotonic seq counter"); otherwise it falls back to a deterministic
 * composite of owning snapshot identity (`snapSeq`, or integer `now` for bare
 * fake arrays) plus event index — stable across calls given identical arrays,
 * which is all repeated-frame rendering requires.
 *
 * Pure apart from mutating the optional `state` bag
 * ({ seen:Set, seq:number, snapSeq:number }).
 * @param {Array<{now:number,snapSeq?:number,events?:Array}>} snapshotList
 * @param {number} upTo inclusive gate compared against snap.now
 * @param {{seen?:Set<string>,seq?:number,snapSeq?:number}} [state] cross-call dedupe memory
 * @returns {Array<object>} newly-visible events in chronological order
 */
export function drainEventsWithDedupe(snapshotList, upTo, state) {
  const out = [];
  if (!Array.isArray(snapshotList)) return out;
  const ownState = state || {};
  const seen = ownState.seen instanceof Set ? ownState.seen : new Set();
  let watermark = Number.isFinite(ownState.seq) ? ownState.seq : -1;
  let snapWatermark = Number.isFinite(ownState.snapSeq) ? ownState.snapSeq : -1;
  for (let si = 0; si < snapshotList.length; si++) {
    const snap = snapshotList[si];
    if (!snap || typeof snap.now !== 'number' || snap.now > upTo) continue;
    const ownedSnapSeq = Number.isFinite(snap.snapSeq) ? snap.snapSeq : null;
    if (ownedSnapSeq !== null && ownedSnapSeq <= snapWatermark) continue;
    const events = Array.isArray(snap.events) ? snap.events : [];
    const baseId = ownedSnapSeq !== null
      ? ownedSnapSeq * INTERP_SPAN
      : Math.floor(Math.abs(snap.now)) * INTERP_SPAN;
    for (let ei = 0; ei < events.length; ei++) {
      const ev = events[ei];
      if (!ev || typeof ev !== 'object') continue;
      const hasEventSeq = Number.isFinite(ev.seq);
      const mono = hasEventSeq ? ev.seq : baseId + ei;
      const key = (hasEventSeq ? 's' : 'f') + mono;
      if (seen.has(key)) continue;
      seen.add(key);
      if (mono > watermark) watermark = mono;
      out.push(ev);
    }
    if (ownedSnapSeq !== null && ownedSnapSeq > snapWatermark) {
      snapWatermark = ownedSnapSeq;
    }
  }
  if (state) {
    state.seen = seen;
    state.seq = watermark;
    state.snapSeq = snapWatermark;
    // Bound memory: live frames never need more than the freshest window.
    if (seen.size > SEEN_SOFT_CAP) {
      let n = SEEN_SOFT_CAP >> 1;
      for (const k of seen) {
        seen.delete(k);
        if (--n === 0) break;
      }
    }
  }
  return out;
}

/** Newest-row fields retained alongside interpolated transforms. */
const PASSTHROUGH_FIELDS = [
  'name', 'hp', 'armor', 'team', 'weapon', 'score', 'kills', 'deaths', 'ping',
  'state', 'firing', 'ads', 'crouch', 'grounded', 'vaulting', 'proneT', 'moveSpeed', 'mag', 'reserve', 'reloading', 'reloadAck', 'reloadState',
  'burning', 'panic', 'exhaustion', 'pain', 'spawnProtected', 'respawnAt',
  'breathReserve', 'breathExhausted', 'breathReleasedFor',
  'credits', 'owned', 'bomb', 'interaction', 'chaosUpgrades',
  'grenades', 'charge', 'minigun', 'impulse',
];

export class NetClient {
  constructor() {
    this.ws = null;
    this._sessionGeneration = 0;
    this._connectAbort = null;
    this._pendingLobbyConfig = null;
    this.welcome = null;         // frozen welcome payload (also connect()'s resolve value)
    this.id = null;
    this.mapBytes = 0;
    this.tickRate = 20;
    this.spawn = null;
    this.dirty = false;          // true once the connection died post-welcome
    this._timing = new NetworkTiming({ tickRate: this.tickRate });
    this._playerIndexes = new WeakMap();
    this._snapshotWindow = [null, null];
    this._pingNonce = 0;

    /** Newest-last ring buffer (max RING_LEN) of raw tick snapshots. */
    this.latestSnapshots = [];
    /** Immutable events returned by the most recent interpolate() call. */
    this.latestEvents = Object.freeze([]);
    /** Newest full waiting/live lobby replacement, or null outside a lobby. */
    this.latestLobbyState = null;
    /** Newest immutable authoritative match snapshot. */
    this.latestMatch = null;
    /** Authoritative persistent damage, keyed by "x,y,z". */
    this.blockDamage = new Map();

    /** Called with map bytes right before connect()'s promise resolves. */
    this.onMap = null;

    this._listeners = new Map();
    this._seq = 0;               // outgoing input sequence
    this._snapSeq = 1;           // monotonic id for received snapshots
    this._drainState = { seen: new Set(), seq: -1, snapSeq: -1 };
    this._pingTimer = null;
  }

  /** Backward-compatible measured round-trip time in milliseconds. */
  get ping() { return this._timing.rttMs; }
  get networkStats() { return this._timing.readModel; }

  getBlockDamage(x, y, z) {
    return this.blockDamage.get(`${x},${y},${z}`)?.progress || 0;
  }

  _applyBlockDamage(rows, replace = false) {
    if (replace) this.blockDamage.clear();
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || !Number.isInteger(row.x) || row.x < 0 || row.x >= SX ||
          !Number.isInteger(row.y) || row.y < 0 || row.y >= SY ||
          !Number.isInteger(row.z) || row.z < 0 || row.z >= SZ ||
          !Number.isInteger(row.v) || row.v < 0 || !Number.isFinite(row.progress)) continue;
      const key = `${row.x},${row.y},${row.z}`;
      if (row.progress <= 0 || row.v === 0) this.blockDamage.delete(key);
      else this.blockDamage.set(key, Object.freeze({ x: row.x, y: row.y, z: row.z,
        v: row.v, progress: Math.min(1, row.progress) }));
    }
  }

  /**
   * Register a callback. Types: 'open', 'close', 'welcome', 'tick', 'chat',
   * plus server event kinds ('shoot','hit','kill','block','respawn','die').
   * @param {string} type @param {(payload:any)=>void} fn
   * @returns {()=>void} unregister function
   */
  on(type, fn) {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const set = this._listeners.get(type);
    if (set) {
      set.delete(fn);
      if (set.size === 0) this._listeners.delete(type);
    }
  }

  _emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        // A listener bug must never take down the net loop.
        if (typeof console !== 'undefined') console.error(err);
      }
    }
  }

  /** True while a socket exists and is open (readyState 1). */
  isOpen() {
    return !!this.ws && this.ws.readyState === 1;
  }

  /** Clear all socket-owned state without touching caller-owned listeners. */
  _resetSessionState(dirty) {
    this._stopPing();
    this._pendingLobbyConfig = null;
    this.welcome = null;
    this.id = null;
    this.mapBytes = 0;
    this.tickRate = 20;
    this.spawn = null;
    this.latestLobbyState = null;
    this.latestMatch = null;
    this.blockDamage.clear();
    this.latestEvents = Object.freeze([]);
    this.latestSnapshots.length = 0;
    this._drainState.seen.clear();
    this._drainState.seq = -1;
    this._drainState.snapSeq = -1;
    this._timing.reset(this.tickRate);
    this._playerIndexes = new WeakMap();
    this._pingNonce = 0;
    this._seq = 0;
    this._snapSeq = 1;
    this.dirty = !!dirty;
  }

  _detachSocket(ws) {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
  }

  /**
   * Connects, sends the selected admission frame, waits for {t:'welcome'},
   * then for the single following binary map frame — handed to this.onMap
   * first — and resolves with the welcome object. Rejects on error/close
   * before pairing completes. A previous session's buffers are cleared so
   * reconnects start clean. Omitting opts.mode preserves quick play.
   * @param {string} url ws(s)://… endpoint @param {string} name display name
   * @param {{mode?:'quick'|'create'|'join',bots?:number,lobby?:string,password?:string,
   *          gameMode?:string,map?:string}} [opts]
   * @returns {Promise<object>} welcome payload
   */
  connect(url, name, opts = null) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const bots = (Number(options.bots) | 0) || 0;
    let initialFrame;
    if (options.mode === 'create') {
      const gameMode = normalizeModeId(options.gameMode);
      const map = mapForMode(gameMode, options.map);
      initialFrame = { t: 'create', name, bots, gameMode, map };
      if (options.password) initialFrame.password = options.password;
    } else if (options.mode === 'join') {
      initialFrame = { t: 'join', name, lobby: options.lobby };
      if (options.password) initialFrame.password = options.password;
    } else {
      initialFrame = { t: 'join', name, bots };
    }
    if (this.ws !== null || this._connectAbort !== null) {
      return Promise.reject(new Error('already connected'));
    }

    const generation = ++this._sessionGeneration;
    this._resetSessionState(false);
    const WSCtor = typeof WebSocket !== 'undefined'
      ? WebSocket
      : (typeof globalThis !== 'undefined' ? globalThis.WebSocket : null);
    if (!WSCtor) return Promise.reject(new Error('WebSocket unavailable'));

    return new Promise((resolve, reject) => {
      let settled = false;
      let pairedWelcome = null;
      const pendingBinaries = [];
      const ws = new WSCtor(url);
      this.ws = ws;
      const isCurrent = () =>
        this.ws === ws && this._sessionGeneration === generation;
      const detach = () => this._detachSocket(ws);
      const rejectConnect = (err) => {
        if (settled) return;
        settled = true;
        pendingBinaries.length = 0;
        const wasCurrent = isCurrent();
        detach();
        if (this._connectAbort === rejectConnect) this._connectAbort = null;
        if (wasCurrent) {
          this.ws = null;
          ++this._sessionGeneration;
          this._resetSessionState(true);
        }
        if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
          try {
            ws.close(1000, 'connection failed');
          } catch { /* socket already failed */ }
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const finishPairing = () => {
        if (settled || !isCurrent() || pairedWelcome === null ||
            pendingBinaries.length === 0) {
          return;
        }
        const mapBytes = pendingBinaries.shift();
        pendingBinaries.length = 0;
        const expectedBytes = Number(pairedWelcome.mapBytes);
        if (Number.isFinite(expectedBytes) && expectedBytes >= 0 &&
            mapBytes.byteLength !== expectedBytes) {
          rejectConnect(new Error('map frame length does not match welcome'));
          return;
        }
        try {
          if (this.onMap) this.onMap(mapBytes);
        } catch (err) {
          rejectConnect(err);
          return;
        }
        // onMap is caller code and may have synchronously closed this session.
        if (settled || !isCurrent()) return;
        settled = true;
        if (this._connectAbort === rejectConnect) this._connectAbort = null;
        this._reattach(ws, generation);
        this.dirty = false;
        resolve(pairedWelcome);
      };

      this._connectAbort = rejectConnect;
      try {
        ws.binaryType = 'arraybuffer';
      } catch {
        /* exotic shims: data still arrives as ArrayBuffer-or-String */
      }
      ws.onclose = () => {
        if (isCurrent()) rejectConnect(new Error('closed before welcome/map'));
      };
      ws.onerror = () => {
        if (isCurrent()) rejectConnect(new Error('connection failed before welcome/map'));
      };
      ws.onopen = () => {
        if (!isCurrent() || settled) return;
        this._emit('open');
        if (!isCurrent() || settled) return;
        try {
          ws.send(JSON.stringify(initialFrame));
        } catch (err) {
          rejectConnect(err);
        }
      };
      ws.onmessage = (m) => {
        if (!isCurrent() || settled) return;
        if (typeof m.data === 'string') {
          const type = this._onText(m.data);
          if (!isCurrent() || settled) return;
          if (type === 'error') {
            rejectConnect(new Error('server rejected connection'));
            return;
          }
          if (type === 'welcome') {
            if (pairedWelcome !== null) {
              rejectConnect(new Error('duplicate welcome before map'));
              return;
            }
            pairedWelcome = this.welcome;
            finishPairing();
          }
          return;
        }
        try {
          const bytes = m.data instanceof ArrayBuffer
            ? new Uint8Array(m.data)
            : Uint8Array.from(m.data);
          pendingBinaries.push(bytes);
          finishPairing();
        } catch {
          rejectConnect(new Error('invalid map frame'));
        }
      };
    });
  }

  _reattach(ws, generation) {
    const isCurrent = () =>
      this.ws === ws && this._sessionGeneration === generation;
    ws.onmessage = (m) => {
      if (!isCurrent()) return;
      if (typeof m.data === 'string') this._onText(m.data, false);
      else this._onTickData(m.data);
    };
    ws.onerror = () => {
      if (isCurrent()) this.dirty = true;
    };
    ws.onclose = () => {
      if (!isCurrent()) return;
      this.ws = null;
      ++this._sessionGeneration;
      this._detachSocket(ws);
      this._resetSessionState(true);
      this._emit('close');
    };
  }

  /**
   * Send one input sample at the caller's cadence (~60/s per contract).
   * Movement accepts short ({f,b,l,r}) or verbose
   * ({forward,back,left,right}) names and is renamed onto the wire contract.
   * Interaction is always the fixed nested keys.interact boolean; switchTo is
   * only wired when integer.
   * @param {{keys?:{f?:boolean,b?:boolean,l?:boolean,r?:boolean,
   *          forward?:boolean,back?:boolean,left?:boolean,right?:boolean,
   *          jump?:boolean,sprint?:boolean,crouch?:boolean,interact?:boolean},
   *          yaw:number,pitch:number,weapon:number,wantFire:boolean,
   *          wantAds:boolean,reload:boolean,throwGrenade?:boolean,grenadeCharge?:number,
   *          grenadeType?:number,grenadeCook?:number,grenadeAim?:{yaw:number,pitch:number},switchTo?:number}} input
   * @returns {boolean} true only when the frame was handed to the socket
   */
  sendInput(input) {
    if (!this.isOpen()) return false;
    const k = input.keys || {};
    const msg = {
      t: 'input',
      seq: ++this._seq,
      keys: {
        f: !!(k.f !== undefined ? k.f : k.forward),
        b: !!(k.b !== undefined ? k.b : k.back),
        l: !!(k.l !== undefined ? k.l : k.left),
        r: !!(k.r !== undefined ? k.r : k.right),
        jump: !!k.jump,
        sprint: !!k.sprint,
        crouch: !!k.crouch,
        prone: !!k.prone,
        interact: !!k.interact,
      },
      yaw: input.yaw,
      pitch: input.pitch,
      weapon: input.weapon | 0,
      wantFire: !!input.wantFire,
      wantAds: !!input.wantAds,
      reload: !!input.reload,
      reloadId: input.reloadId || 0,
      viewAge: Math.round(this._timing.interpolationDelayMs + this._timing.rttMs),
    };
    if (input.grenadeHandling) msg.grenadeHandling = true;
    if (input.throwGrenade) {
      msg.throwGrenade = true;
      msg.grenadeCharge = Math.round(clampGrenadeCharge(input.grenadeCharge) * 1000) / 1000;
      msg.grenadeType = clampGrenadeType(input.grenadeType);
      msg.grenadeCook = clampGrenadeCook(input.grenadeCook, grenadeTypeAt(msg.grenadeType));
      if (Number.isFinite(input.grenadeAim?.yaw) && Number.isFinite(input.grenadeAim?.pitch)) {
        msg.grenadeAim = { yaw: input.grenadeAim.yaw, pitch: input.grenadeAim.pitch };
      }
    }
    if (Number.isInteger(input.switchTo)) msg.switchTo = input.switchTo;
    if (Number.isFinite(input.viewYaw)) msg.viewYaw = input.viewYaw;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Set this human's waiting-lobby readiness. */
  setReady(value) {
    if (!this.isOpen()) return false;
    try {
      this.ws.send(JSON.stringify({ t: 'ready', value: !!value }));
      return true;
    } catch {
      return false;
    }
  }

  configureLobby({ gameMode, map, bots, duelKillLimit }) {
    if (!this.isOpen()) return false;
    try {
      this.ws.send(JSON.stringify({ t: 'configure', gameMode, map, bots, duelKillLimit }));
      return true;
    } catch { return false; }
  }

  /** Buy one exact shared-contract weapon id. */
  buyWeapon(id) {
    if ((!isWeaponId(id) && !parseChaosPurchase(id)) || !this.isOpen()) return false;
    try {
      this.ws.send(JSON.stringify({ t: 'buy', weapon: id }));
      return true;
    } catch {
      return false;
    }
  }

  /** Ask the server to start this waiting lobby as its host. */
  requestStart() {
    if (!this.isOpen()) return false;
    try {
      this.ws.send(JSON.stringify({ t: 'start' }));
      return true;
    } catch {
      return false;
    }
  }

  /** Politely disconnects. Idempotent; no auto-reconnect follows. */
  close() {
    const abort = this._connectAbort;
    if (abort) {
      abort(new Error('closed before welcome/map'));
      this._emit('close');
      return;
    }

    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ++this._sessionGeneration;
    this._detachSocket(ws);
    this._resetSessionState(true);
    if (typeof ws.close === 'function' &&
        (ws.readyState === 0 || ws.readyState === 1)) {
      try {
        ws.close(1000, 'bye');
      } catch { /* already closing */ }
    }
    this._emit('close');
  }

  /**
   * Advance the view clock. Interpolates remote players between the two
   * snapshots surrounding `renderNowMs - delayMs` on the server-time-mapped
   * local clock
   * and drains every newly-visible event exactly once — returned
   * AND dispatched through on(kind,…). Rows exclude the local player id.
   * @param {number} renderNowMs performance.now()-based frame time
   * @param {number} [delayMs] optional interpolation buffer override
   * @returns {{players:Map<string,object>,events:Array<object>,match:object|null}}
   */
  interpolate(renderNowMs, delayMs = this._timing.interpolationDelayMs) {
    const snaps = this.latestSnapshots;
    // All snapshots now live on the local performance clock (see _onTick).
    const target = renderNowMs - delayMs;
    const players = new Map();
    let match = this.latestMatch;

    findSnapshotWindow(snaps, target, this._snapshotWindow);
    const a = this._snapshotWindow[0];
    const b = this._snapshotWindow[1];

    if (a !== null && b !== null) {
      const oldRows = a !== b ? this._playerIndexes.get(a) : null;
      match = b.match || match;
      const rows = Array.isArray(b.players) ? b.players : [];
      for (let i = 0; i < rows.length; i++) {
        const incoming = rows[i];
        if (!incoming || incoming.id === this.id) continue;
        const prev = oldRows ? oldRows.get(incoming.id) : null;
        // Death/respawn must become visible with their events. Starting a death
        // from the future bracket consumes its one gore burst before the hit's
        // overkill arrives; a future respawn also moves the old corpse too soon.
        if (!prev && incoming.state === 'dead' && target < b.now) continue;
        const cur = prev && prev.state !== incoming.state && target < b.now ? prev : incoming;
        const row = { id: cur.id };
        for (let f = 0; f < PASSTHROUGH_FIELDS.length; f++) {
          const field = PASSTHROUGH_FIELDS[f];
          // Snapshot rows are already recursively frozen. Reusing nested
          // references here avoids cloning loadouts and mode metadata at FPS.
          row[field] = cur[field];
        }
        if (prev) {
          sampleRemoteTransform(prev, cur, target, a.now, b.now, row);
          const stanceT = Math.max(0, Math.min(1, (target - a.now) / Math.max(1, b.now - a.now)));
          row.proneT = (prev.proneT || 0) + ((cur.proneT || 0) - (prev.proneT || 0)) * stanceT;
        } else {
          row.x = cur.x;
          row.y = cur.y;
          row.z = cur.z;
          row.yaw = cur.yaw;
          row.pitch = cur.pitch;
        }
        players.set(cur.id, Object.freeze(row));
      }
    }

    // Effect events have one authoritative source: their owning tick snapshot.
    const events = Object.freeze(
      drainEventsWithDedupe(this.latestSnapshots, target, this._drainState),
    );
    this.latestEvents = events;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev && ev.kind) this._emit(ev.kind, ev);
    }
    return { players, events, match };
  }

  // ----- internal message plumbing -----

  _onText(text, acceptWelcome = true) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return null; // malformed frame: ignore, keep the socket alive
    }
    if (!msg || typeof msg !== 'object') return null;
    switch (msg.t) {
      case 'welcome': {
        if (!acceptWelcome) return null;
        const w = immutableWireCopy({
          id: msg.id,
          name: msg.name,
          mapBytes: msg.mapBytes,
          tickRate: msg.tickRate,
          spawn: msg.spawn && typeof msg.spawn === 'object' ? msg.spawn : null,
          lobby: msg.lobby && typeof msg.lobby === 'object' ? msg.lobby : null,
          gameMode: msg.gameMode,
          map: msg.map,
          phase: msg.phase,
          blockDamage: Array.isArray(msg.blockDamage) ? msg.blockDamage : [],
        });
        this.welcome = w;
        this.id = w.id;
        this.mapBytes = w.mapBytes || 0;
        this.tickRate = w.tickRate || 20;
        this._timing.reset(this.tickRate);
        this.spawn = w.spawn;
        this._applyBlockDamage(w.blockDamage, true);
        this._startPing(this.ws, this._sessionGeneration);
        this._emit('welcome', w);
        break;
      }
      case 'lobbyConfig': {
        if (this.latestLobbyState?.phase !== 'waiting' || msg.id !== this.id) break;
        this._pendingLobbyConfig = immutableWireCopy(msg);
        break;
      }
      case 'lobbyState': {
        const members = Array.isArray(msg.members)
          ? msg.members.filter((member) => member && typeof member === 'object')
          : [];
        const state = immutableWireCopy({
          code: msg.code,
          host: msg.host,
          phase: msg.phase,
          bots: msg.bots,
          duelKillLimit: msg.duelKillLimit,
          gameMode: msg.gameMode,
          map: msg.map,
          members,
          selfId: this.id,
        });
        this.latestLobbyState = state;
        this._emit('lobby', state);
        break;
      }
      case 'error':
        this._emit('serverError', immutableWireCopy({ msg: msg.msg }));
        break;
      case 'tick':
        this._onTick(msg);
        break;
      case 'pong':
        this._timing.resolvePong(msg.nonce, now());
        break;
      case 'chat':
        this._emit('chat', immutableWireCopy({
          id: msg.id,
          name: msg.name,
          text: msg.text,
        }));
        break;
      default:
        break; // unknown types tolerated forward-compatibly
    }
    return msg.t;
  }

  _onTickData(data) {
    const config = this._pendingLobbyConfig;
    if (!config) return;
    this._pendingLobbyConfig = null;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
    if (bytes.byteLength !== config.mapBytes) {
      this._emit('serverError', { msg: 'Lobby map transfer failed. Please rejoin.' });
      this.close();
      return;
    }
    this.welcome = config;
    this.mapBytes = config.mapBytes;
    this.spawn = config.spawn;
    this._applyBlockDamage(config.blockDamage, true);
    if (this.onMap) this.onMap(bytes);
  }

  _onTick(msg) {
    const recvLocal = now();
    // Single-timeline rule: bracket search, blending and event draining live
    // on the local performance clock. The room's fixed-step `msg.now` is
    // mapped into that clock without inheriting packet-arrival compression.
    this._timing.recordArrival(recvLocal);

    const rows = Array.isArray(msg.players) ? msg.players : [];
    const serverNow = Number(msg.now);
    const mappedNow = this._timing.mapServerTime(serverNow, recvLocal);
    const snapshot = immutableWireCopy({
      ...msg,
      serverNow: Number.isFinite(serverNow) ? serverNow : null,
      now: mappedNow,
      players: rows.filter((row) => row && typeof row === 'object'),
      match: msg.match && typeof msg.match === 'object' ? msg.match : null,
      recvLocalMs: recvLocal,
      snapSeq: this._snapSeq++,
    });
    this.latestMatch = snapshot.match;
    // Terrain replacements invalidate old damage even when a peer omits the
    // corresponding zero row. Apply newer damage after replacements.
    for (const delta of Array.isArray(snapshot.blocks) ? snapshot.blocks : []) {
      const i = delta?.i;
      if (!Number.isInteger(i) || i < 0 || i >= SX * SY * SZ) continue;
      this.blockDamage.delete(`${i % SX},${Math.floor(i / (SX * SZ))},${Math.floor(i / SX) % SZ}`);
    }
    this._applyBlockDamage(snapshot.blockDamage);
    this._playerIndexes.set(snapshot, indexById(snapshot.players));
    this.latestSnapshots.push(snapshot);
    if (this.latestSnapshots.length > RING_LEN) this.latestSnapshots.shift();
    this._emit('tick', snapshot);
  }


  _startPing(ws = this.ws, generation = this._sessionGeneration) {
    this._stopPing();
    const sendPing = () => {
      // A queued callback from an old interval must never target its successor.
      if (!ws || this.ws !== ws || this._sessionGeneration !== generation ||
          ws.readyState !== 1) {
        return;
      }
      try {
        const nonce = ++this._pingNonce;
        const sentAt = now();
        this._timing.beginPing(nonce, sentAt);
        ws.send(JSON.stringify({ t: 'ping', nonce }));
      } catch { /* socket raced shut; next session re-arms */ }
    };
    sendPing();
    this._pingTimer = setInterval(sendPing, 1500);
    if (typeof this._pingTimer.unref === 'function') this._pingTimer.unref();
  }

  _stopPing() {
    if (this._pingTimer !== null) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }
}


/** Player-row lookup by id for the interpolation source snapshot. */
const indexById = (rows) => {
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row && row.id !== undefined) map.set(row.id, row);
  }
  return map;
};
