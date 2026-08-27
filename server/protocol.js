// Wire protocol constants, strict frame parsers, snapshot builder and event
// factories. Pure data functions only — no engine state, no world access.
//
// Frame budget: ticks go out at TICK_RATE_HZ as JSON text frames:
//   { t:'tick', now, match:{...}, players:[...], blocks:[...], events:[...] }
// Effect and state-transition events ride inside tick.events and carry ev.kind
// so clients can dispatch them through the same event channel.

import { WEAPON_IDS } from '../shared/combatmath.js';
import {
  DEFAULT_MAP_ID,
  DEFAULT_MODE_ID,
  MAP_IDS,
  MAX_CREDITS,
  isMapId,
  isModeId,
  isModeMapCompatible,
  isTeamId,
  isWeaponId,
} from '../shared/modes.js';

/** Authoritative simulation rate. */
const TICK_RATE_HZ = 20;
/** Milliseconds per fixed step (50). */
export const TICK_MS = 1000 / TICK_RATE_HZ;

/** Invite-code alphabet excludes ambiguous glyphs (I, L, O, 0 and 1). */
export const LOBBY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LOBBY_CODE_LENGTH = 5;

/** Normalize an exact invite code without accepting whitespace or lookalikes. */
export function normalizeLobbyCode(raw) {
  if (typeof raw !== 'string' || raw.length !== LOBBY_CODE_LENGTH) return null;
  const code = raw.toUpperCase();
  if (code.length !== LOBBY_CODE_LENGTH) return null;
  for (let i = 0; i < code.length; i++) {
    if (!LOBBY_CODE_ALPHABET.includes(code[i])) return null;
  }
  return code;
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validBotCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 7;
}

function resolveModeMap(gameMode, map) {
  const resolvedMode = gameMode === undefined ? DEFAULT_MODE_ID : gameMode;
  const resolvedMap = map === undefined ? DEFAULT_MAP_ID : map;
  if (!isModeId(resolvedMode) ||
      !isMapId(resolvedMap) ||
      !isModeMapCompatible(resolvedMode, resolvedMap)) {
    throw new RangeError('invalid or incompatible game mode and map');
  }
  return { gameMode: resolvedMode, map: resolvedMap };
}

/**
 * Validate and normalize the first client frame. Null signals the transport's
 * "invalid join" path. Quick play and lobby joins deliberately reject mode/map
 * keys: only the room manager owns those choices.
 */
export function parseAdmissionFrame(raw) {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null;

  const hasBots = Object.prototype.hasOwnProperty.call(raw, 'bots');
  if (raw.t === 'join' &&
      !Object.prototype.hasOwnProperty.call(raw, 'lobby')) {
    const expected = hasBots ? ['t', 'name', 'bots'] : ['t', 'name'];
    if (!hasExactKeys(raw, expected) || (hasBots && !validBotCount(raw.bots))) return null;
    return {
      kind: 'quick',
      name: raw.name,
      bots: hasBots ? raw.bots : 0,
      gameMode: DEFAULT_MODE_ID,
      map: null,
      lobby: null,
    };
  }

  if (raw.t === 'create') {
    const hasMode = Object.prototype.hasOwnProperty.call(raw, 'gameMode');
    const hasMap = Object.prototype.hasOwnProperty.call(raw, 'map');
    const expected = ['t', 'name', 'bots'];
    if (hasMode) expected.push('gameMode');
    if (hasMap) expected.push('map');
    if (!hasExactKeys(raw, expected) || !validBotCount(raw.bots)) return null;
    if (hasMode && !isModeId(raw.gameMode)) return null;
    if (hasMap && !isMapId(raw.map)) return null;

    const gameMode = hasMode ? raw.gameMode : DEFAULT_MODE_ID;
    const map = hasMap
      ? raw.map
      : MAP_IDS.find((mapId) => isModeMapCompatible(gameMode, mapId));
    if (!map || !isModeMapCompatible(gameMode, map)) return null;
    return {
      kind: 'create',
      name: raw.name,
      bots: raw.bots,
      gameMode,
      map,
      lobby: null,
    };
  }

  if (raw.t === 'join' &&
      hasExactKeys(raw, ['t', 'name', 'lobby']) &&
      typeof raw.lobby === 'string') {
    const lobby = normalizeLobbyCode(raw.lobby);
    if (!lobby) return null;
    return {
      kind: 'join',
      name: raw.name,
      bots: 0,
      gameMode: null,
      map: null,
      lobby,
    };
  }

  return null;
}

/** Validate an exact authoritative purchase request. */
export function parseBuyFrame(raw) {
  return isRecord(raw) &&
    hasExactKeys(raw, ['t', 'weapon']) &&
    raw.t === 'buy' &&
    isWeaponId(raw.weapon)
    ? raw.weapon
    : null;
}

/**
 * Build the JSON frame paired with the following binary map frame. Missing
 * mode/map fields use Fun on Foundry; explicitly supplied invalid values are
 * rejected rather than silently normalized.
 */
export function makeWelcome({
  id,
  mapBytes,
  tickRate = TICK_RATE_HZ,
  spawn,
  lobby,
  phase,
  gameMode,
  map,
} = {}) {
  const selected = resolveModeMap(gameMode, map);
  const sourceSpawn = isRecord(spawn) ? spawn : {};
  const sourceLobby = isRecord(lobby) ? lobby : {};
  const normalizedTickRate = Number.isFinite(tickRate) ? Math.round(tickRate) : 0;
  return {
    t: 'welcome',
    id: typeof id === 'string' || Number.isFinite(id) ? id : '',
    mapBytes: Number.isFinite(mapBytes) ? Math.max(0, Math.trunc(mapBytes)) : 0,
    tickRate: normalizedTickRate > 0 ? normalizedTickRate : TICK_RATE_HZ,
    spawn: {
      x: Number.isFinite(sourceSpawn.x) ? sourceSpawn.x : 0,
      y: Number.isFinite(sourceSpawn.y) ? sourceSpawn.y : 0,
      z: Number.isFinite(sourceSpawn.z) ? sourceSpawn.z : 0,
    },
    lobby: {
      code: normalizeLobbyCode(sourceLobby.code),
      role: sourceLobby.role === 'host' ? 'host' : 'member',
    },
    phase: phase === 'live' ? 'live' : 'waiting',
    gameMode: selected.gameMode,
    map: selected.map,
  };
}

/**
 * Build a full lobby-state replacement without retaining caller-owned data.
 * Member ids may be finite numeric engine ids or strings; all other fields
 * retain only their contracted primitive type.
 */
export function makeLobbyState({
  code,
  host,
  phase,
  bots,
  members,
  gameMode,
  map,
} = {}) {
  const selected = resolveModeMap(gameMode, map);
  const rows = Array.isArray(members) ? members : [];
  return {
    t: 'lobbyState',
    code: normalizeLobbyCode(code),
    host: typeof host === 'string' || Number.isFinite(host) ? host : '',
    phase: phase === 'live' ? 'live' : 'waiting',
    bots: validBotCount(bots) ? bots : 0,
    gameMode: selected.gameMode,
    map: selected.map,
    members: rows.map((member) => {
      const source = member && typeof member === 'object' ? member : {};
      return {
        id: typeof source.id === 'string' || Number.isFinite(source.id) ? source.id : '',
        name: typeof source.name === 'string' ? source.name : '',
        ready: typeof source.ready === 'boolean' ? source.ready : false,
        bot: typeof source.bot === 'boolean' ? source.bot : false,
      };
    }),
  };
}

const D2 = 100, D3 = 1000;

function round(v, d) {
  return Number.isFinite(v) ? Math.round(v * d) / d : 0;
}

function ammoCopy(values) {
  const src = Array.isArray(values) ? values : [];
  return WEAPON_IDS.map((_, i) => {
    const value = src[i];
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  });
}

function weaponSlot(value) {
  const slot = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(WEAPON_IDS.length - 1, slot));
}

function ownedWeapons(values) {
  if (values === undefined) return WEAPON_IDS.slice();
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const owned = [];
  for (const value of values) {
    if (isWeaponId(value) && !seen.has(value)) {
      seen.add(value);
      owned.push(value);
    }
  }
  return owned;
}

function interactionCopy(value) {
  if (!isRecord(value) || (value.kind !== 'plant' && value.kind !== 'defuse')) return null;
  return {
    kind: value.kind,
    site: typeof value.site === 'string' ? value.site : null,
    progress: round(Math.max(0, Math.min(1, Number.isFinite(value.progress) ? value.progress : 0)), D3),
  };
}

function wireCopy(value, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = value.map((item) => wireCopy(item, seen));
    seen.delete(value);
    return copy;
  }
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = wireCopy(item, seen);
  seen.delete(value);
  return copy;
}

function defaultMatchSnapshot() {
  return {
    mode: DEFAULT_MODE_ID,
    map: null,
    phase: 'live',
    phaseEndsAt: null,
    scores: null,
    winner: null,
    round: null,
    roundWinner: null,
    attackers: null,
    defenders: null,
    bomb: null,
  };
}

/**
 * Build one wire snapshot from live engine data.
 * Player rows carry the exact contracted field set; positions are 2-decimal,
 * angles 3-decimal so payloads stay small and floats stay finite.
 */
export function makeSnapshot(playersArr, blockDeltas, eventsArr, nowMs, match = undefined) {
  const matchSnapshot = match === undefined
    ? defaultMatchSnapshot()
    : (isRecord(match) ? wireCopy(match) : defaultMatchSnapshot());
  return {
    t: 'tick',
    now: round(nowMs, 1),
    match: matchSnapshot,
    players: (playersArr || []).map((p) => ({
      id: String(p.id),
      name: String(p.name),
      x: round(p.x, D2),
      y: round(p.y, D2),
      z: round(p.z, D2),
      yaw: round(p.yaw, D3),
      pitch: round(p.pitch, D3),
      hp: round(p.hp, 1),
      panic: round(Math.max(0, Math.min(1, Number.isFinite(p.panic) ? p.panic : 0)), D3),
      pain: round(Math.max(0, Math.min(1, Number.isFinite(p.pain) ? p.pain : 0)), D3),
      exhaustion: round(Math.max(0, Math.min(1, Number.isFinite(p.exhaustion) ? p.exhaustion : 0)), D3),
      spawnProtected: !!p.spawnProtected,
      weapon: weaponSlot(p.weapon),
      score: p.score | 0,
      kills: p.kills | 0,
      deaths: p.deaths | 0,
      state: p.state === 'dead' ? 'dead' : 'alive',
      firing: !!p.firing,
      ads: !!p.ads,
      mag: ammoCopy(p.mag),
      reserve: ammoCopy(p.reserve),
      reloading: !!p.reloading,
      team: isTeamId(p.team) ? p.team : null,
      credits: Number.isFinite(p.credits)
        ? Math.max(0, Math.min(MAX_CREDITS, Math.trunc(p.credits)))
        : 0,
      owned: ownedWeapons(p.owned),
      bomb: !!p.bomb,
      interaction: interactionCopy(p.interaction),
    })),
    // Engines clear these scratch arrays after broadcasting, so snapshots must
    // not retain either source array.
    blocks: (blockDeltas || []).map((b) => ({ i: b.i | 0, v: b.v | 0 })),
    events: (eventsArr || []).slice(),
  };
}

/**
 * Accepted gunshot. `o` is the muzzle origin, `d` is the pre-spread aim
 * direction, and `spread` is the sampled first-pellet direction. Clients drive
 * tracers, muzzle flash, shells, and sound from this event only.
 */
export function evShoot(id, o, d, w, spread) {
  return {
    t: 'ev', kind: 'shoot', id: String(id), w: String(w),
    o: [round(o[0], D2), round(o[1], D2), round(o[2], D2)],
    d: [round(d[0], D3), round(d[1], D3), round(d[2], D3)],
    spread: [round(spread[0], D3), round(spread[1], D3), round(spread[2], D3)],
  };
}

/** Damage feedback. v = impact point (or victim chest). */
export function evHit(attacker, victim, dmg, hs, v) {
  return {
    t: 'ev', kind: 'hit',
    attacker: String(attacker), victim: String(victim),
    dmg: round(dmg, 1), hs: !!hs,
    vx: round(v[0], D2), vy: round(v[1], D2), vz: round(v[2], D2),
  };
}

/** Killfeed row. */
export function evKill(killer, victim, w, hs) {
  return { t: 'ev', kind: 'kill', killer: String(killer), victim: String(victim), w: String(w), hs: !!hs };
}

/** Block mutation; `from` is the pre-mutation block id. */
export function evBlock(x, y, z, v, from) {
  return {
    t: 'ev', kind: 'block',
    x: x | 0, y: y | 0, z: z | 0, v: v | 0, from: from | 0,
  };
}

/** State-transition events embedded in tick.events. */
export function evRespawn(id, x, y, z) {
  return {
    t: 'respawn', kind: 'respawn', id: String(id),
    x: round(x, D2), y: round(y, D2), z: round(z, D2),
  };
}

export function evDie(id) {
  return { t: 'die', kind: 'die', id: String(id) };
}
