// Welcome and full lobby-state replacement factories. Returned frames retain no
// caller-owned objects or arrays.
import { copyBlockDamage } from './block-damage.js';

import {
  TICK_RATE_HZ,
  isRecord,
  normalizeLobbyCode,
  resolveModeMap,
  validBotCount,
} from './admission.js';

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
  blockDamage,
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
    blockDamage: copyBlockDamage(blockDamage),
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
