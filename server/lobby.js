import { DEFAULT_BOT_DIFFICULTY, isBotDifficulty } from '../shared/bot-difficulty.js';
import { randomInt, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { promisify } from 'node:util';

import { GameEngine } from './game.js';
import { attachBots } from './bots.js';
import {
  LOBBY_CODE_ALPHABET,
  LOBBY_CODE_LENGTH,
  TICK_MS,
  normalizeLobbyCode,
  validLobbyPassword,
  validBotCount,
} from './protocol/admission.js';
import { makeLobbyState, makeWelcome } from './protocol/welcome.js';
import {
  DUEL_KILL_LIMITS,
  DEFAULT_DUEL_KILL_LIMIT,
  mapForMode,
  DEFAULT_MODE_ID,
  isMapId,
  isModeId,
  isModeMapCompatible,
  isTeamId,
} from '../shared/modes.js';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { MAX_BOTS, MAX_TEAM_PLAYERS, lobbyCapacity, hasLobbyTeams } from '../shared/lobby-limits.js';

const derivePassword = promisify(scrypt);
const capacity = (room) => lobbyCapacity(room.gameMode, room.map);
const MAX_ROOMS = 16;
const QUICK_MIN_BOTS = 5;

const QUICK_MAPS = Object.freeze(['foundry', 'depot', 'solstice', 'caldera']);

const CLOSE_MALFORMED = 4002;
const CLOSE_UNKNOWN = 4004;
const CLOSE_FULL = 4005;

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
          candidate.members.size < capacity(candidate)) {
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

  async create(meta, name, bots, gameMode = DEFAULT_MODE_ID, map = mapForMode(gameMode), password = '') {
    if (!this._validAdmission(meta, name) || !validLobbyPassword(password) ||
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
      const passwordSalt = password ? randomBytes(16) : null;
      const passwordHash = password ? await derivePassword(password, passwordSalt, 32) : null;
      // Password work runs off the simulation thread. Recheck admission after it.
      if (!this._validAdmission(meta, name) || this.stopped) return false;
      if (this.rooms.size >= MAX_ROOMS) {
        return this._reject(meta, 'Server room capacity reached', CLOSE_FULL, 'rooms full');
      }
      room = this._createRoom(false, bots, gameMode, map);
      room.passwordSalt = passwordSalt;
      room.passwordHash = passwordHash;
      return this._admit(room, meta, name, false);
    } catch {
      if (room) this._destroyRoom(room);
      return this._reject(meta, 'Unable to create lobby', 1011, 'room creation failed');
    }
  }

  async join(meta, name, rawCode, password = '') {
    if (!this._validAdmission(meta, name) || !validLobbyPassword(password)) {
      return this._reject(meta, 'Malformed lobby join request', CLOSE_MALFORMED, 'bad join');
    }
    if (this.stopped) return this._reject(meta, 'Server is shutting down', 1013, 'server shutdown');

    const code = normalizeLobbyCode(rawCode);
    if (!code) return this._reject(meta, 'Malformed lobby code', CLOSE_MALFORMED, 'bad lobby code');

    const room = this.rooms.get(code);
    if (!room || room.destroyed || room.quick) {
      return this._reject(meta, `Unknown lobby ${code}`, CLOSE_UNKNOWN, 'unknown lobby');
    }
    if (room.passwordHash && (!password || !timingSafeEqual(
      await derivePassword(password, room.passwordSalt, 32), room.passwordHash,
    ))) {
      return this._reject(meta, 'Incorrect lobby password', 4003, 'incorrect password');
    }
    if (!this._validAdmission(meta, name) || this.stopped) return false;
    if (room.members.size >= capacity(room)) {
      return this._reject(meta, `Lobby ${code} is full`, CLOSE_FULL, 'lobby full');
    }

    try {
      return this._admit(room, meta, name, false);
    } catch {
      return this._reject(meta, 'Unable to join lobby', 1011, 'room admission failed');
    }
  }

  list() {
    if (this.stopped) return [];
    return [...this.rooms.values()]
      .filter((room) => !room.destroyed && !room.quick && room.gameMode !== 'training' && room.members.size > 0)
      .map((room) => ({
        code: room.code,
        host: room.members.get(room.host)?.name || 'PLAYER',
        gameMode: room.gameMode,
        map: room.map,
        phase: room.phase,
        players: room.members.size,
        capacity: capacity(room),
        passwordRequired: !!room.passwordHash,
      }));
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

  setTeam(meta, id, team) {
    const found = this._memberFor(meta);
    if (!found) return this._error(meta, 'Not in a lobby');
    const { room, member } = found;
    if (room.phase !== 'waiting') return this._error(meta, 'Lobby has already started');
    if (!hasLobbyTeams(room.gameMode)) return this._error(meta, 'This mode has no team selection');
    if (typeof id !== 'string' || (!room.members.has(id) && !room.botTeams.has(id)) || !isTeamId(team)) {
      return this._error(meta, 'Invalid team selection');
    }
    if (room.host !== member.id) {
      return this._error(meta, 'Only the host can assign teams');
    }
    const isBot = room.botTeams.has(id);
    if ((isBot ? room.botTeams.get(id) : room.engine.mode.teamFor(id)) === team) return true;
    if (this._teamCounts(room)[team] >= MAX_TEAM_PLAYERS) {
      return this._error(meta, `Each team allows up to ${MAX_TEAM_PLAYERS} players`);
    }
    if (isBot) room.botTeams.set(id, team);
    else if (!room.engine.mode.setLobbyTeam(id, team)) return this._error(meta, 'Unable to change team');
    for (const human of room.members.values()) human.ready = false;
    this._broadcastLobbyState(room);
    return true;
  }

  setBotDifficulty(meta, id, difficulty) {
    const found = this._memberFor(meta);
    if (!found) return this._error(meta, 'Not in a lobby');
    const { room, member } = found;
    if (room.phase !== 'waiting') return this._error(meta, 'Lobby has already started');
    if (room.host !== member.id) return this._error(meta, 'Only the host can set bot difficulty');
    if (!room.botDifficulties.has(id) || !isBotDifficulty(difficulty))
      return this._error(meta, 'Invalid bot difficulty');
    if (room.botDifficulties.get(id) === difficulty) return true;
    room.botDifficulties.set(id, difficulty);
    for (const human of room.members.values()) human.ready = false;
    this._broadcastLobbyState(room);
    return true;
  }

  start(meta) {
    const found = this._memberFor(meta);
    if (!found) return this._error(meta, 'Not in a lobby');

    const { room, member } = found;
    if (room.phase !== 'waiting') return this._error(meta, 'Lobby has already started');
    if (room.host !== member.id) return this._error(meta, 'Only the host can start the lobby');
    if (room.gameMode === 'duel' && room.members.size !== 2) return this._error(meta, '1v1 needs two players');
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

  configure(meta, { gameMode, map, bots, duelKillLimit } = {}) {
    const found = this._memberFor(meta);
    if (!found) return this._error(meta, 'Not in a lobby');
    const { room, member } = found;
    if (room.phase !== 'waiting') return this._error(meta, 'Lobby has already started');
    if (room.host !== member.id) return this._error(meta, 'Only the host can configure the lobby');
    if (!this._validModeMap(gameMode, map) || !validBotCount(bots)) {
      return this._error(meta, 'Invalid lobby settings');
    }
    if (gameMode === 'duel' && room.members.size > 2) return this._error(meta, '1v1 allows only two players');
    if (gameMode === 'bastion' && room.members.size > 4) return this._error(meta, 'Bastion allows up to four players');
    duelKillLimit ??= room.duelKillLimit;
    if (!DUEL_KILL_LIMITS.includes(duelKillLimit)) return this._error(meta, 'Invalid 1v1 kill target');
    bots = ['training', 'duel', 'bastion'].includes(gameMode) ? 0 : bots;
    const limit = lobbyCapacity(gameMode, map);
    if (room.members.size > limit) {
      return this._error(meta, `This map allows up to ${limit} players. There are ${room.members.size} human players in the lobby.`);
    }
    // Smaller arenas keep all humans and trim only planned bots. A bot-only
    // configuration above the current arena's limit remains an invalid request.
    if (map !== room.map || gameMode !== room.gameMode) {
      bots = Math.min(bots, limit - room.members.size);
    } else if (bots + room.members.size > limit) {
      return this._error(meta, `This lobby allows up to ${limit} players and bots in total`);
    }
    const arenaChanged = gameMode !== room.gameMode || map !== room.map;
    if (!arenaChanged && bots === room.bots && duelKillLimit === room.duelKillLimit) return true;
    if (arenaChanged) {
      // Build the replacement before changing the shared room. Sockets, ids and
      // the invite code stay attached to the same room throughout configuration.
      const engine = new GameEngine({
        broadcast: (obj) => this._broadcastJson(room, obj),
        world: createMapState(map), mode: gameMode, mapMeta: getMapMeta(map),
      });
      const spawns = new Map();
      try {
        for (const human of room.members.values()) {
          spawns.set(human.id, engine.addClient(human.id, human.name));
        }
        const preserveTeams = ['tdm', 'snd'].includes(room.gameMode) && ['tdm', 'snd'].includes(gameMode);
        for (const human of room.members.values()) {
          const team = room.engine.mode.teamFor(human.id);
          if (preserveTeams && isTeamId(team)) engine.mode.setLobbyTeam(human.id, team);
          spawns.set(human.id, engine.spawnInfoFor(engine.entities.get(human.id)));
        }
      } catch (error) { engine.stop(); throw error; }
      room.engine.stop();
      room.engine = engine;
      room.gameMode = gameMode;
      room.map = map;
      const bytes = engine.world.serializeWorld();
      for (const human of room.members.values()) {
        const spawn = spawns.get(human.id);
        this.sendJson(human.meta, {
          ...makeWelcome({ id: human.id, mapBytes: bytes.byteLength,
            tickRate: Math.round(1000 / this.tickMs), spawn: spawn.spawn || spawn,
            lobby: { code: room.code, role: room.host === human.id ? 'host' : 'member' },
            phase: 'waiting', gameMode, map,
            blockDamage: Array.from(engine.blockDamage.values()) }),
          t: 'lobbyConfig',
        });
        this.sendFrame(human.meta, bytes);
      }
    }
    room.duelKillLimit = duelKillLimit;
    if (gameMode === 'duel') room.engine.mode.rules.killLimit = duelKillLimit;
    room.bots = bots;
    this._syncWaitingBots(room);
    for (const human of room.members.values()) human.ready = false;
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

  leave(meta, { reconnectable = false } = {}) {
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
      if (reconnectable) {
        room.host = '';
        room.expiryTimer = setTimeout(() => this._destroyRoom(room), 30_000);
        room.expiryTimer.unref?.();
        return true;
      }
      this._destroyRoom(room);
      return true;
    }

    if (room.host === member.id) room.host = room.members.keys().next().value;
    this._syncBots(room);
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
      !meta.joined && !meta.room && !meta.closed;
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
      duelKillLimit: DEFAULT_DUEL_KILL_LIMIT,
      bots: ['training','duel','bastion'].includes(gameMode) ? 0 : Math.min(bots, lobbyCapacity(gameMode, map) - 1),
      botTeams: new Map(),
      botDifficulties: new Map(),
      quickPopulation: quick ? Math.min(bots + 1, lobbyCapacity(gameMode, map)) : null,
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
    if (!id || room.destroyed || room.members.has(id) || room.members.size >= capacity(room)) {
      return this._reject(meta, 'Lobby is full or unavailable', CLOSE_FULL, 'lobby full');
    }

    clearTimeout(room.expiryTimer);
    room.expiryTimer = null;
    const member = { id, name, ready: false, meta };
    let added = false;
    try {
      let spawnInfo = room.phase === 'live' && room.botManager
        ? (room.botManager.takeover(id, name) || room.engine.addClient(id, name))
        : room.engine.addClient(id, name);
      added = true;
      room.members.set(id, member);
      if (!room.host) room.host = id;

      if (room.phase === 'waiting') {
        this._syncWaitingBots(room, id);
        spawnInfo = room.engine.spawnInfoFor(room.engine.entities.get(id));
      }

      meta.room = room;
      meta.joined = true;

      if (startRoom) this._startRoom(room);
      else this._syncBots(room);

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
        blockDamage: Array.from(room.engine.blockDamage.values()),
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
      this._syncBots(room);
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
      if (['training','bastion'].includes(room.gameMode)) {
        // Training is self-populating: dummy targets are engine bots, so the
        // lobby never attaches a combat-bot manager.
        room.botManager = null;
        room.bots = 0;
      } else {
        this._syncWaitingBots(room);
        room.bots = Math.min(room.bots, capacity(room) - room.members.size);
        manager = attachBots(room.engine, room.bots, { difficulties: room.botDifficulties });
        room.botManager = manager;
        if (hasLobbyTeams(room.gameMode)) {
          for (const [id, team] of room.botTeams) room.engine.mode.setLobbyTeam(id, team);
        }
      }
      // Only final lobby assignments may reach the first gameplay tick.
      const assignments = new Set();
      for (let i = room.engine.tickEvents.length - 1; i >= 0; i--) {
        const event = room.engine.tickEvents[i];
        if (event.kind !== 'team_assigned' && event.kind !== 'bomb_assigned') continue;
        const key = event.kind === 'team_assigned' ? `team:${event.id}` : 'bomb';
        const current = event.kind === 'team_assigned'
          ? room.engine.mode.teamFor(event.id) === event.team
          : room.engine.mode.bomb?.carrierId === event.id;
        if (!current || assignments.has(key)) room.engine.tickEvents.splice(i, 1);
        else assignments.add(key);
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

  _syncBots(room) {
    if (!room) return;
    if (room.phase === 'waiting') return this._syncWaitingBots(room);
    if (!room.botManager) return;
    if (!room.quick) {
      room.bots = Math.min(room.botManager.brains.length, capacity(room) - room.members.size);
      room.botManager.setCount(room.bots);
      return;
    }
    const targetPopulation = Number.isFinite(room.quickPopulation)
      ? room.quickPopulation
      : QUICK_MIN_BOTS + 1;
    const desired = Math.max(0, Math.min(MAX_BOTS, capacity(room) - room.members.size, targetPopulation - room.members.size));
    room.botManager.setCount(desired);
    room.bots = desired;
  }

  _teamCounts(room, excludeId = null) {
    const counts = { alpha: 0, bravo: 0 };
    for (const human of room.members.values()) {
      const team = room.engine.mode.teamFor(human.id);
      if (human.id !== excludeId && isTeamId(team)) counts[team]++;
    }
    for (const [id, team] of room.botTeams) {
      if (id !== excludeId && isTeamId(team)) counts[team]++;
    }
    return counts;
  }

  /** Planned bot ids match the live manager, so host assignments survive launch. */
  _syncWaitingBots(room, joiningId = null) {
    room.bots = Math.min(room.bots, capacity(room) - room.members.size);
    const ids = new Set(Array.from({ length: room.bots }, (_, i) => `bot-${i}`));
    for (const id of room.botDifficulties.keys()) if (!ids.has(id)) room.botDifficulties.delete(id);
    for (const id of ids) if (!room.botDifficulties.has(id)) room.botDifficulties.set(id, DEFAULT_BOT_DIFFICULTY);
    for (const id of room.botTeams.keys()) {
      if (!ids.has(id) || !hasLobbyTeams(room.gameMode)) room.botTeams.delete(id);
    }
    if (!hasLobbyTeams(room.gameMode)) return;
    if (joiningId && room.botTeams.size) {
      const counts = this._teamCounts(room, joiningId);
      const team = counts.alpha <= counts.bravo ? 'alpha' : 'bravo';
      room.engine.mode.setLobbyTeam(joiningId, team);
    }
    const counts = this._teamCounts(room);
    for (const id of ids) {
      if (room.botTeams.has(id)) continue;
      const team = counts.alpha <= counts.bravo ? 'alpha' : 'bravo';
      room.botTeams.set(id, team);
      counts[team]++;
    }
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

  updatePing(meta) {
    const found = this._memberFor(meta);
    if (found?.room.phase === 'waiting') this._broadcastLobbyState(found.room);
  }

  _stateFor(room) {
    const members = [];
    for (const member of room.members.values()) {
      members.push({ id: member.id, name: member.name, ready: member.ready, bot: false, ping: member.meta.ping,
        team: room.engine.mode.teamFor(member.id) });
    }
    if (room.phase === 'live') {
      for (const entity of room.engine.entities.values()) {
        if (entity.bot) members.push({ id: entity.id, name: entity.name, ready: false, bot: true,
          difficulty: room.botDifficulties.get(entity.id) || DEFAULT_BOT_DIFFICULTY,
          team: room.engine.mode.teamFor(entity) });
      }
    } else {
      for (let i = 0; i < room.bots; i++) {
        const id = `bot-${i}`;
        members.push({ id, name: `TACTICAL BOT ${i + 1}`, ready: true, bot: true,
          difficulty: room.botDifficulties.get(id) || DEFAULT_BOT_DIFFICULTY,
          team: room.botTeams.get(id) || null });
      }
    }
    return makeLobbyState({
      code: room.code,
      host: room.host,
      phase: room.phase,
      bots: room.bots,
      members,
      duelKillLimit: room.duelKillLimit,
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
    clearTimeout(room.expiryTimer);

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
