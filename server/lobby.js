import { randomInt } from 'node:crypto';

import { GameEngine } from './game.js';
import { attachBots } from './bots.js';
import {
  LOBBY_CODE_ALPHABET,
  LOBBY_CODE_LENGTH,
  TICK_MS,
  makeLobbyState,
  makeWelcome,
  normalizeLobbyCode,
} from './protocol.js';
import {
  DEFAULT_MAP_ID,
  DEFAULT_MODE_ID,
  isMapId,
  isModeId,
  isModeMapCompatible,
} from '../shared/modes.js';
import { createMapState, getMapMeta } from '../shared/worlddata.js';

const MAX_HUMANS = 8;
const MAX_ROOMS = 16;
const MAX_BOTS = 7;
const QUICK_MIN_BOTS = 5;

const QUICK_MAPS = Object.freeze(['foundry', 'depot', 'solstice', 'caldera']);

const CLOSE_MALFORMED = 4002;
const CLOSE_UNKNOWN = 4004;
const CLOSE_FULL = 4005;

function validBotCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_BOTS;
}

function memberId(meta) {
  if (!meta || (typeof meta.id !== 'string' && !Number.isFinite(meta.id))) return null;
  const id = String(meta.id);
  return id.length > 0 ? id : null;
}

/** Owns authoritative rooms and keeps every transport fan-out room-scoped. */
export class LobbyManager {
  constructor({ sendJson, sendFrame, closeClient, tickMs = TICK_MS } = {}) {
    if (typeof sendJson !== 'function' ||
        typeof sendFrame !== 'function' ||
        typeof closeClient !== 'function') {
      throw new TypeError('LobbyManager requires sendJson, sendFrame and closeClient callbacks');
    }

    this.sendJson = sendJson;
    this.sendFrame = sendFrame;
    this.closeClient = closeClient;
    this.tickMs = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : TICK_MS;
    this.rooms = new Map();
    this.stopped = false;

    const space = LOBBY_CODE_ALPHABET.length ** LOBBY_CODE_LENGTH;
    this.codeSpace = space;
    this.codeCursor = 0;
    this.quickMapCursor = 0;
  }

  quickPlay(meta, name, bots) {
    const count = bots === undefined ? 0 : bots;
    if (!this._validAdmission(meta, name) || !validBotCount(count)) {
      return this._reject(meta, 'Malformed quick-play request', CLOSE_MALFORMED, 'bad join');
    }
    if (this.stopped) return this._reject(meta, 'Server is shutting down', 1013, 'server shutdown');

    let room = null;
    for (const candidate of this.rooms.values()) {
      if (!candidate.destroyed &&
          candidate.quick &&
          candidate.phase === 'live' &&
          candidate.gameMode === DEFAULT_MODE_ID &&
          QUICK_MAPS.includes(candidate.map) &&
          candidate.members.size < MAX_HUMANS) {
        room = candidate;
        break;
      }
    }

    let created = false;
    try {
      if (!room) {
        if (this.rooms.size >= MAX_ROOMS) {
          return this._reject(meta, 'Server room capacity reached', CLOSE_FULL, 'rooms full');
        }
        const map = QUICK_MAPS[this.quickMapCursor];
        room = this._createRoom(true, Math.max(QUICK_MIN_BOTS, count), DEFAULT_MODE_ID, map);
        this.quickMapCursor = (this.quickMapCursor + 1) % QUICK_MAPS.length;
        created = true;
      }
      return this._admit(room, meta, name, created);
    } catch {
      if (created && room) this._destroyRoom(room);
      return this._reject(meta, 'Unable to join quick play', 1011, 'room admission failed');
    }
  }

  create(meta, name, bots, gameMode = DEFAULT_MODE_ID, map = DEFAULT_MAP_ID) {
    if (!this._validAdmission(meta, name) ||
        !validBotCount(bots) ||
        !this._validModeMap(gameMode, map)) {
      return this._reject(meta, 'Malformed lobby creation request', CLOSE_MALFORMED, 'bad create');
    }
    if (this.stopped) return this._reject(meta, 'Server is shutting down', 1013, 'server shutdown');
    if (this.rooms.size >= MAX_ROOMS) {
      return this._reject(meta, 'Server room capacity reached', CLOSE_FULL, 'rooms full');
    }

    let room = null;
    try {
      room = this._createRoom(false, bots, gameMode, map);
      return this._admit(room, meta, name, false);
    } catch {
      if (room) this._destroyRoom(room);
      return this._reject(meta, 'Unable to create lobby', 1011, 'room creation failed');
    }
  }

  join(meta, name, rawCode) {
    if (!this._validAdmission(meta, name)) {
      return this._reject(meta, 'Malformed lobby join request', CLOSE_MALFORMED, 'bad join');
    }
    if (this.stopped) return this._reject(meta, 'Server is shutting down', 1013, 'server shutdown');

    const code = normalizeLobbyCode(rawCode);
    if (!code) return this._reject(meta, 'Malformed lobby code', CLOSE_MALFORMED, 'bad lobby code');

    const room = this.rooms.get(code);
    if (!room || room.destroyed || room.quick) {
      return this._reject(meta, `Unknown lobby ${code}`, CLOSE_UNKNOWN, 'unknown lobby');
    }
    if (room.members.size >= MAX_HUMANS) {
      return this._reject(meta, `Lobby ${code} is full`, CLOSE_FULL, 'lobby full');
    }

    try {
      return this._admit(room, meta, name, false);
    } catch {
      return this._reject(meta, 'Unable to join lobby', 1011, 'room admission failed');
    }
  }

  ready(meta, value) {
    const found = this._memberFor(meta);
    if (!found) return this._error(meta, 'Not in a lobby');
    if (typeof value !== 'boolean') return this._error(meta, 'Ready value must be a boolean');

    const { room, member } = found;
    if (room.phase !== 'waiting') return this._error(meta, 'Lobby has already started');
    member.ready = value;
    this._broadcastLobbyState(room);
    return true;
  }

  start(meta) {
    const found = this._memberFor(meta);
    if (!found) return this._error(meta, 'Not in a lobby');

    const { room, member } = found;
    if (room.phase !== 'waiting') return this._error(meta, 'Lobby has already started');
    if (room.host !== member.id) return this._error(meta, 'Only the host can start the lobby');
    for (const human of room.members.values()) {
      if (!human.ready) return this._error(meta, 'Every player must be ready before starting');
    }

    try {
      this._startRoom(room);
    } catch {
      return this._error(meta, 'Unable to start lobby');
    }
    this._broadcastLobbyState(room);
    return true;
  }

  input(meta, msg) {
    const found = this._memberFor(meta);
    if (!found || found.room.phase !== 'live') return false;
    try {
      found.room.engine.applyInput(found.member.id, msg);
      return true;
    } catch {
      return false;
    }
  }

  buy(meta, weapon) {
    const found = this._memberFor(meta);
    if (!found || found.room.phase !== 'live') {
      return this._error(meta, 'Purchase unavailable');
    }
    try {
      if (found.room.engine.mode.purchase(found.member.id, weapon)) return true;
    } catch { /* rejection uses the behavior error below */ }
    return this._error(meta, 'Purchase unavailable');
  }

  chat(meta, text) {
    const found = this._memberFor(meta);
    if (!found || typeof text !== 'string') return false;
    const clean = text.slice(0, 120).trim();
    if (!clean) return false;

    this._broadcastJson(found.room, {
      t: 'chat',
      id: found.member.id,
      name: found.member.name,
      text: clean,
    });
    return true;
  }

  leave(meta) {
    const found = this._memberFor(meta);
    if (!found) {
      this._clearMeta(meta, meta && meta.room);
      return false;
    }

    const { room, member } = found;
    room.members.delete(member.id);
    try { room.engine.removeClient(member.id); } catch { /* cleanup continues */ }
    if (room.phase === 'waiting') room.engine.discardPendingEventsFor(member.id);
    this._clearMeta(meta, room);

    if (room.members.size === 0) {
      this._destroyRoom(room);
      return true;
    }

    if (room.host === member.id) room.host = room.members.keys().next().value;
    this._syncQuickBots(room);
    this._broadcastLobbyState(room);
    return true;
  }

  stop() {
    if (this.stopped && this.rooms.size === 0) return;
    this.stopped = true;
    for (const room of Array.from(this.rooms.values())) this._destroyRoom(room);
    this.rooms.clear();
  }

  _validAdmission(meta, name) {
    return memberId(meta) !== null && typeof name === 'string' && name.length > 0 &&
      !meta.joined && !meta.room;
  }

  _validModeMap(gameMode, map) {
    return isModeId(gameMode) && isMapId(map) && isModeMapCompatible(gameMode, map);
  }

  _createRoom(quick, bots, gameMode, map) {
    if (!this._validModeMap(gameMode, map)) {
      throw new RangeError('invalid or incompatible game mode and map');
    }
    const code = this._generateCode();
    const world = createMapState(map);
    const mapMeta = getMapMeta(map);
    const room = {
      code,
      quick,
      gameMode,
      map,
      phase: 'waiting',
      bots,
      quickPopulation: quick ? bots + 1 : null,
      host: '',
      members: new Map(),
      engine: null,
      botManager: null,
      destroyed: false,
    };

    room.engine = new GameEngine({
      broadcast: (obj) => this._broadcastJson(room, obj),
      world,
      mode: gameMode,
      mapMeta,
    });
    this.rooms.set(code, room);
    return room;
  }

  _admit(room, meta, name, startRoom) {
    const id = memberId(meta);
    if (!id || room.destroyed || room.members.has(id) || room.members.size >= MAX_HUMANS) {
      return this._reject(meta, 'Lobby is full or unavailable', CLOSE_FULL, 'lobby full');
    }

    const member = { id, name, ready: false, meta };
    let added = false;
    try {
      const spawnInfo = room.quick && room.phase === 'live' && room.botManager
        ? (room.botManager.takeover(id, name) || room.engine.addClient(id, name))
        : room.engine.addClient(id, name);
      added = true;
      room.members.set(id, member);
      if (!room.host) room.host = id;

      meta.room = room;
      meta.joined = true;

      if (startRoom) this._startRoom(room);
      else this._syncQuickBots(room);

      const worldBytes = room.engine.world.serializeWorld();
      const spawn = spawnInfo && spawnInfo.spawn ? spawnInfo.spawn : (spawnInfo || {});
      const welcome = makeWelcome({
        id,
        mapBytes: worldBytes.byteLength,
        tickRate: Math.round(1000 / this.tickMs),
        spawn,
        lobby: { code: room.code, role: room.host === id ? 'host' : 'member' },
        phase: room.phase,
        gameMode: room.gameMode,
        map: room.map,
      });

      if (this.sendJson(meta, welcome) === false) throw new Error('welcome send failed');
      if (this.sendFrame(meta, worldBytes) === false) throw new Error('world send failed');
      this._broadcastLobbyState(room);
      return true;
    } catch (err) {
      if (room.members.get(id) === member) room.members.delete(id);
      if (added) {
        try { room.engine.removeClient(id); } catch { /* retain admission failure */ }
      }
      if (room.phase === 'waiting') room.engine.discardPendingEventsFor(id);
      if (room.host === id) room.host = room.members.keys().next().value || '';
      this._syncQuickBots(room);
      this._clearMeta(meta, room);
      if (room.members.size === 0) this._destroyRoom(room);
      throw err;
    }
  }

  _startRoom(room) {
    if (room.destroyed) throw new Error('room destroyed');
    if (room.phase === 'live') return;

    let manager = null;
    try {
      if (room.gameMode === 'training') {
        // Training is self-populating: dummy targets are engine bots, so the
        // lobby never attaches a combat-bot manager.
        room.botManager = null;
        room.bots = 0;
      } else {
        manager = attachBots(room.engine, room.bots);
        room.botManager = manager;
      }
      room.engine.start(this.tickMs);
      room.phase = 'live';
    } catch (err) {
      try { room.engine.stop(); } catch { /* retain start failure */ }
      if (manager) {
        try { manager.dispose(); } catch { /* retain start failure */ }
      }
      room.botManager = null;
      throw err;
    }
  }

  _syncQuickBots(room) {
    if (!room?.quick || room.phase !== 'live' || !room.botManager) return;
    const targetPopulation = Number.isFinite(room.quickPopulation)
      ? room.quickPopulation
      : QUICK_MIN_BOTS + 1;
    const desired = Math.max(0, Math.min(MAX_BOTS, targetPopulation - room.members.size));
    room.botManager.setCount(desired);
    room.bots = desired;
  }

  _memberFor(meta) {
    if (!meta || !meta.room || !meta.joined) return null;
    const room = meta.room;
    if (room.destroyed || this.rooms.get(room.code) !== room) return null;
    const id = memberId(meta);
    if (!id) return null;
    const member = room.members.get(id);
    return member && member.meta === meta ? { room, member } : null;
  }

  _stateFor(room) {
    const members = [];
    for (const member of room.members.values()) {
      members.push({ id: member.id, name: member.name, ready: member.ready, bot: false });
    }
    if (room.phase === 'live') {
      for (const entity of room.engine.entities.values()) {
        if (entity.bot) members.push({ id: entity.id, name: entity.name, ready: false, bot: true });
      }
    }
    return makeLobbyState({
      code: room.code,
      host: room.host,
      phase: room.phase,
      bots: room.bots,
      members,
      gameMode: room.gameMode,
      map: room.map,
    });
  }

  _broadcastLobbyState(room) {
    if (!room.destroyed) this._broadcastJson(room, this._stateFor(room));
  }

  _broadcastJson(room, obj) {
    if (room.destroyed) return;
    for (const member of Array.from(room.members.values())) {
      if (room.destroyed || room.members.get(member.id) !== member) continue;
      try { this.sendJson(member.meta, obj); } catch { /* socket cleanup owns failures */ }
    }
  }

  _error(meta, message) {
    try { this.sendJson(meta, { t: 'error', msg: message }); } catch { /* best effort */ }
    return false;
  }

  _reject(meta, message, code, reason) {
    this._error(meta, message);
    try { this.closeClient(meta, code, reason); } catch { /* best effort */ }
    return false;
  }

  _clearMeta(meta, room) {
    if (!meta || typeof meta !== 'object') return;
    if (!room || meta.room === room) delete meta.room;
    meta.joined = false;
  }

  _destroyRoom(room) {
    if (!room || room.destroyed) return;
    room.destroyed = true;

    try { room.engine.stop(); } catch { /* cleanup continues */ }
    if (room.botManager) {
      try { room.botManager.dispose(); } catch { /* cleanup continues */ }
      room.botManager = null;
    }

    for (const member of room.members.values()) {
      try { room.engine.removeClient(member.id); } catch { /* cleanup continues */ }
      this._clearMeta(member.meta, room);
    }
    room.members.clear();
    room.host = '';
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
  }

  _generateCode() {
    for (let attempt = 0; attempt < 32; attempt++) {
      let value = randomInt(this.codeSpace);
      let code = '';
      for (let i = 0; i < LOBBY_CODE_LENGTH; i++) {
        code = LOBBY_CODE_ALPHABET[value % LOBBY_CODE_ALPHABET.length] + code;
        value = Math.floor(value / LOBBY_CODE_ALPHABET.length);
      }
      if (!this.rooms.has(code)) return code;
    }

    for (let attempt = 0; attempt <= MAX_ROOMS; attempt++) {
      let value = this.codeCursor;
      this.codeCursor = (this.codeCursor + 1) % this.codeSpace;
      let code = '';
      for (let i = 0; i < LOBBY_CODE_LENGTH; i++) {
        code = LOBBY_CODE_ALPHABET[value % LOBBY_CODE_ALPHABET.length] + code;
        value = Math.floor(value / LOBBY_CODE_ALPHABET.length);
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('lobby code space exhausted');
  }
}
