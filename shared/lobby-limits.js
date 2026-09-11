/** Shared roster limits for admission, bot slots, and lobby controls. */
export const MAX_PLAYERS = 32;
export const MAX_TEAM_PLAYERS = 16;
export const MAX_BOTS = MAX_PLAYERS - 1;

export function lobbyCapacity(gameMode) {
  return gameMode === 'duel' ? 2 : gameMode === 'bastion' ? 4 : MAX_PLAYERS;
}

export function hasLobbyTeams(gameMode) {
  return gameMode === 'tdm' || gameMode === 'snd';
}
