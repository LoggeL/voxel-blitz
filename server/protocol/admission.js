// Wire protocol constants and strict client-frame parsers. Pure data
// functions only — no engine state or world access.

import {
  DEFAULT_MAP_ID,
  DEFAULT_MODE_ID,
  MAP_IDS,
  isMapId,
  isModeId,
  isModeMapCompatible,
  isWeaponId,
} from '../../shared/modes.js';

/** Authoritative simulation rate. */
export const TICK_RATE_HZ = 20;
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

export function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function validBotCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 7;
}

export function resolveModeMap(gameMode, map) {
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
