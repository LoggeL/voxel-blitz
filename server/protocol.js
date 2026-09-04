// Stable public facade for the wire protocol. The implementation is split by
// frame direction and responsibility under server/protocol/.

export {
  TICK_MS,
  LOBBY_CODE_ALPHABET,
  LOBBY_CODE_LENGTH,
  normalizeLobbyCode,
  parseAdmissionFrame,
  parseBuyFrame,
} from './protocol/admission.js';

export { makeWelcome, makeLobbyState } from './protocol/welcome.js';
export { makeSnapshot } from './protocol/snapshot.js';
export {
  evShoot,
  evHit,
  evKill,
  evBlock,
  evRespawn,
  evDie,
  evProjectileLaunch,
  evProjectileStick,
  evProjectileExplode,
} from './protocol/events.js';
