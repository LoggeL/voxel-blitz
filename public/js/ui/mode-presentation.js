import { GUN_GAME_WEAPON_ORDER } from '../../../shared/modes.js';

export const MODE_TITLES = Object.freeze({
  ttt: 'TROUBLE IN TERRORIST TOWN',
  chaos: 'CHAOS LAB',
  duel: '1V1 DUEL', bastion: 'BASTION',
  fun: 'FREE FOR ALL', tdm: 'TEAM DEATHMATCH', snd: 'SEARCH & DESTROY',
  gungame: 'GUN GAME', training: 'PRACTICE RANGE',
});

export function gunLevel(player) {
  return Math.min(GUN_GAME_WEAPON_ORDER.length, Math.max(1, (player?.score | 0) + 1));
}

export function rankPlayers(players, mode) {
  // TTT order must not reveal who has killed or who died unseen.
  if (mode === 'ttt') return [...players].sort((a, b) =>
    String(a.name ?? '').localeCompare(String(b.name ?? '')) || String(a.id).localeCompare(String(b.id)));
  return [...players].sort((a, b) =>
    (mode === 'gungame' ? (b.score | 0) - (a.score | 0) : 0)
    || (b.kills | 0) - (a.kills | 0)
    || (a.deaths | 0) - (b.deaths | 0)
    || String(a.id).localeCompare(String(b.id)));
}
