import { isTttRequest } from '../../shared/ttt.js';
import { parseBastionPurchase } from '../../shared/bastion.js';
import { parseChaosPurchase } from '../../shared/chaos.js';
import { MAX_BOTS } from '../../shared/lobby-limits.js';
import { KIT_IDS, KITS } from '../../shared/conquest-contract.js';
import { SPAWN_CHOICE_PATTERN } from '../../shared/conquest.js';
import { MAP_FINGERPRINT_PATTERN } from '../../shared/world/serialize.js';
// Wire protocol constants and strict client-frame parsers. Pure data
// functions only — no engine state or world access.

import {
  DEFAULT_MODE_ID,
  mapForMode,
  isMapId,
  isModeId,
  isModeMapCompatible,
  isWeaponId,
} from '../../shared/modes.js';

/** Authoritative simulation rate. */
export const TICK_RATE_HZ = 60;
/** Milliseconds per fixed step (16.67). */
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

// Controls, zero-widths and bidi overrides never reach other players' screens.
// eslint-disable-next-line no-control-regex
const INVISIBLE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
export const CHAT_MAX_LENGTH = 120;

/** Strip controls/zero-widths, collapse whitespace, clamp to 16 chars. */
export function sanitizeName(raw, ordinal) {
  const name = typeof raw === 'string' ? raw
    .replace(INVISIBLE_TEXT, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16) : '';
  const suffix = Number.isSafeInteger(ordinal) ? ordinal : '';
  return name.length > 0 ? name : 'Rookie' + suffix;
}

/** Room chat text: invisible characters stripped, then at most 120 trimmed characters. */
export function sanitizeChatText(raw) {
  return typeof raw === 'string' ? raw.replace(INVISIBLE_TEXT, '').slice(0, CHAT_MAX_LENGTH).trim() : '';
}

export function validLobbyPassword(value) {
  return typeof value === 'string' && value.length <= 64;
}

export function validBotCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_BOTS;
}

export function resolveModeMap(gameMode, map) {
  const resolvedMode = gameMode === undefined ? DEFAULT_MODE_ID : gameMode;
  const resolvedMap = map === undefined ? mapForMode(resolvedMode) : map;
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
/** Map templates a client may announce as cached (admission `mapCache`). */
export const MAX_ADMISSION_MAP_CACHE = 8;

/**
 * Optional admission field `mapCache`: the template fingerprints (16 hex
 * chars, see shared/world/serialize.js mapFingerprint) the client holds. Its
 * presence, even empty, opts the connection into V3 map frames.
 */
function parseMapCache(value) {
  if (!Array.isArray(value) || value.length > MAX_ADMISSION_MAP_CACHE) return null;
  if (!value.every(entry => typeof entry === 'string' && MAP_FINGERPRINT_PATTERN.test(entry))) return null;
  return [...new Set(value)];
}

/**
 * Optional admission field `contract`: the CONQUEST_CONTRACT_VERSION the
 * client's code was built against. Clients without it predate the check; the
 * lobby keeps both out of Conquest rooms (server/lobby.js staleConquestClient).
 */
function parseContract(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff ? value : null;
}

export function parseAdmissionFrame(raw) {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null;
  const hasMapCache = Object.prototype.hasOwnProperty.call(raw, 'mapCache');
  const mapCache = hasMapCache ? parseMapCache(raw.mapCache) : null;
  if (hasMapCache && !mapCache) return null;
  const hasContract = Object.prototype.hasOwnProperty.call(raw, 'contract');
  const contract = hasContract ? parseContract(raw.contract) : null;
  if (hasContract && contract === null) return null;
  const result = parseAdmissionFields(raw, hasMapCache, hasContract);
  if (!result) return null;
  return { ...result, ...(hasMapCache ? { mapCache } : {}), ...(hasContract ? { contract } : {}) };
}

function parseAdmissionFields(raw, hasMapCache, hasContract) {
  const keys = (list) => [...list, ...(hasMapCache ? ['mapCache'] : []), ...(hasContract ? ['contract'] : [])];

  const hasPassword = Object.prototype.hasOwnProperty.call(raw, 'password');
  if (hasPassword && !validLobbyPassword(raw.password)) return null;
  const hasBots = Object.prototype.hasOwnProperty.call(raw, 'bots');
  if (raw.t === 'join' &&
      !Object.prototype.hasOwnProperty.call(raw, 'lobby')) {
    const expected = keys(hasBots ? ['t', 'name', 'bots'] : ['t', 'name']);
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
    const hasDirectStart = Object.prototype.hasOwnProperty.call(raw, 'directStart');
    const expected = ['t', 'name', 'bots'];
    if (hasPassword) expected.push('password');
    if (hasMode) expected.push('gameMode');
    if (hasMap) expected.push('map');
    if (hasDirectStart) expected.push('directStart');
    if (!hasExactKeys(raw, keys(expected)) || !validBotCount(raw.bots)) return null;
    if (hasMode && !isModeId(raw.gameMode)) return null;
    if (hasMap && !isMapId(raw.map)) return null;

    const gameMode = hasMode ? raw.gameMode : DEFAULT_MODE_ID;
    const map = hasMap
      ? raw.map
      : mapForMode(gameMode);
    if (!map || !isModeMapCompatible(gameMode, map)) return null;
    if (hasDirectStart && (raw.directStart !== true || gameMode !== 'training'
      || map !== 'killhouse' || raw.bots !== 0 || hasPassword)) return null;
    return {
      kind: 'create',
      directStart: hasDirectStart,
      password: raw.password || '',
      name: raw.name,
      bots: raw.bots,
      gameMode,
      map,
      lobby: null,
    };
  }

  if (raw.t === 'join' &&
      hasExactKeys(raw, keys(hasPassword ? ['t', 'name', 'lobby', 'password'] : ['t', 'name', 'lobby'])) &&
      typeof raw.lobby === 'string') {
    const lobby = normalizeLobbyCode(raw.lobby);
    if (!lobby) return null;
    return {
      kind: 'join',
      password: raw.password || '',
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
    (isTttRequest(raw.weapon) || isWeaponId(raw.weapon) || parseChaosPurchase(raw.weapon) || parseBastionPurchase(raw.weapon))
    ? raw.weapon
    : null;
}

const isIdString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const VEHICLE_WEAPON_SLOTS = 4;

/**
 * Vehicle interaction identifiers never select arbitrary simulation
 * operations: enter {vehicleId, seatId?} | exit {} | seat {seatId} | cm {} |
 * weapon {index 0..3}. Anything else, including extra keys, is rejected.
 */
export function parseVehicleAction(raw) {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'exit':
      return hasExactKeys(raw, ['type']) ? { type: 'exit' } : null;
    case 'cm':
      return hasExactKeys(raw, ['type']) ? { type: 'cm' } : null;
    case 'enter': {
      const withSeat = Object.hasOwn(raw, 'seatId');
      if (!hasExactKeys(raw, withSeat ? ['type', 'vehicleId', 'seatId'] : ['type', 'vehicleId'])) return null;
      if (!isIdString(raw.vehicleId, 64) || (withSeat && !isIdString(raw.seatId, 32))) return null;
      return { type: 'enter', vehicleId: raw.vehicleId, ...(withSeat ? { seatId: raw.seatId } : {}) };
    }
    case 'seat':
      return hasExactKeys(raw, ['type', 'seatId']) && isIdString(raw.seatId, 32) ? { type: 'seat', seatId: raw.seatId } : null;
    case 'weapon':
      return hasExactKeys(raw, ['type', 'index']) && Number.isInteger(raw.index)
        && raw.index >= 0 && raw.index < VEHICLE_WEAPON_SLOTS ? { type: 'weapon', index: raw.index } : null;
    default:
      return null;
  }
}

const CONQUEST_INTENT_KEYS = Object.freeze(['deploy', 'spot', 'support', 'redeploy']);
const SUPPORT_TYPES = Object.freeze(['revive', 'repair']);

/**
 * Conquest intent frame `{t:'conquest', deploy | spot | support | redeploy}` with exactly
 * one intent field:
 * - deploy {spawn, kit?, variant?, gadget?}: spawn matches the strict spawn
 *   grammar, kit is a KIT_IDS id (default assault), variant is 0 or 1
 *   (default 0), gadget is 0 or an index into that kit's `gadgets` (default 0:
 *   the Engineer's AT launcher; 1 is the STINGER);
 * - spot: 1 (or true);
 * - support {type: 'revive'|'repair', targetId: string <= 64};
 * - redeploy: 1 (or true), the in-game menu RESPAWN.
 * Returns `{type:'deploy', spawn, kit, variant, gadget}`, `{type:'spot'}`,
 * `{type:'support', support, targetId}`, `{type:'redeploy'}` or null.
 */
export function parseConquestIntent(raw) {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  if (Object.hasOwn(raw, 't') && raw.t !== 'conquest') return null;
  const intents = keys.filter(key => key !== 't');
  if (intents.length !== 1 || !CONQUEST_INTENT_KEYS.includes(intents[0])) return null;
  const key = intents[0], value = raw[key];
  if (key === 'spot') return value === 1 || value === true ? { type: 'spot' } : null;
  if (key === 'redeploy') return value === 1 || value === true ? { type: 'redeploy' } : null;
  if (key === 'support') {
    if (!isRecord(value) || !hasExactKeys(value, ['type', 'targetId'])) return null;
    if (!SUPPORT_TYPES.includes(value.type) || !isIdString(value.targetId, 64)) return null;
    return { type: 'support', support: value.type, targetId: value.targetId };
  }
  if (!isRecord(value) || typeof value.spawn !== 'string') return null;
  if (Object.keys(value).some(k => k !== 'spawn' && k !== 'kit' && k !== 'variant' && k !== 'gadget')) return null;
  if (!SPAWN_CHOICE_PATTERN.test(value.spawn)) return null;
  if (Object.hasOwn(value, 'kit') && !KIT_IDS.includes(value.kit)) return null;
  if (Object.hasOwn(value, 'variant') && value.variant !== 0 && value.variant !== 1) return null;
  const kit = value.kit ?? KIT_IDS[0];
  if (Object.hasOwn(value, 'gadget') && value.gadget !== 0 && !(value.gadget === 1 && (KITS[kit].gadgets?.length ?? 0) > 1)) return null;
  return { type: 'deploy', spawn: value.spawn, kit, variant: value.variant ?? 0, gadget: value.gadget ?? 0 };
}
