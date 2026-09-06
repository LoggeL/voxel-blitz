import { GUN_GAME_WEAPON_ORDER } from '../../../shared/modes.js';

export const MODE_TITLES = Object.freeze({
  chaos: 'CHAOS LAB',
  fun: 'FREE FOR ALL', tdm: 'TEAM DEATHMATCH', snd: 'SEARCH & DESTROY',
  gungame: 'GUN GAME', training: 'PRACTICE RANGE',
});

export function gunLevel(player) {
  return Math.min(GUN_GAME_WEAPON_ORDER.length, Math.max(1, (player?.score | 0) + 1));
}

export function rankPlayers(players, mode) {
  return [...players].sort((a, b) =>
    (mode === 'gungame' ? (b.score | 0) - (a.score | 0) : 0)
    || (b.kills | 0) - (a.kills | 0)
    || (a.deaths | 0) - (b.deaths | 0)
    || String(a.id).localeCompare(String(b.id)));
}
