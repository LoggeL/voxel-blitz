/** Shared roster limits for admission, bot slots, and lobby controls. */
export const MAX_PLAYERS = 32;
export const MAX_TEAM_PLAYERS = 16;
export const MAX_BOTS = MAX_PLAYERS - 1;

// Deliberate arena population limits, shared by admission and lobby controls.
// Harbor and Canyon have the largest authored footprints (192 x 144 voxels).
export const MAP_PLAYER_LIMITS = Object.freeze({
  depot: 8,
  nuketown: 12,
  solstice: 12,
  caldera: 12,
  foundry: 16,
  dust2: 16,
  citadel: 20,
  harbor: 32,
  canyon: 32,
  reactor: 4,
  killhouse: 4,
});

export function lobbyCapacity(gameMode, map = 'foundry') {
  const mapLimit = MAP_PLAYER_LIMITS[map] ?? MAP_PLAYER_LIMITS.foundry;
  return Math.min(mapLimit, gameMode === 'duel' ? 2 : gameMode === 'bastion' ? 4 : MAX_PLAYERS);
}

export function hasLobbyTeams(gameMode) {
  return gameMode === 'tdm' || gameMode === 'snd';
}
