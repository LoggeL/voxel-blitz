import { el } from './hud-support.js';
import { isTeamMode } from '../../../shared/modes.js';

function isAlive(player) {
  return player?.state !== 'dead' && player?.dead !== true && Number(player?.hp ?? 1) > 0;
}

function scoreOf(player) {
  return Number.isFinite(Number(player?.score)) ? Math.trunc(Number(player.score)) : 0;
}

function ordered(players) {
  return [...players].sort((left, right) => (
    Number(isAlive(right)) - Number(isAlive(left))
    || scoreOf(right) - scoreOf(left)
    || String(left?.name || left?.id).localeCompare(String(right?.name || right?.id))
  ));
}

/** Compact, always-visible roster presentation independent of the full scoreboard. */
export class PlayerStatusStrip {
  constructor() {
    this.root = null;
    this._signature = '';
  }

  build(hud) {
    this.dispose();
    this.root = el('div', 'vb-player-status-strip', hud, 'player-status-strip');
    this.root.setAttribute('aria-label', 'Player status');
    return this.root;
  }

  update(players, mode, selfId) {
    const root = this.root;
    if (!root) return;
    const roster = Array.isArray(players) ? players.filter(Boolean) : [];
    const teamMode = isTeamMode(mode);
    const signature = JSON.stringify([
      mode,
      selfId,
      ...roster.map((player) => [
        player?.id,
        player?.name,
        player?.team,
        isAlive(player),
        scoreOf(player),
        player?.local === true,
      ]),
    ]);
    if (signature === this._signature) return;
    this._signature = signature;
    root.innerHTML = '';
    root.className = `vb-player-status-strip ${teamMode ? 'is-team-mode' : 'is-free-for-all'}`;

    if (teamMode) {
      this._teamGroup(root, roster.filter((player) => player.team === 'alpha'), 'alpha', selfId);
      const versus = el('span', 'vb-player-status-versus', root);
      versus.textContent = 'VS';
      versus.setAttribute('aria-hidden', 'true');
      this._teamGroup(root, roster.filter((player) => player.team === 'bravo'), 'bravo', selfId);
      return;
    }

    const group = el('div', 'vb-player-status-group vb-player-team-neutral', root);
    const ranked = ordered(roster);
    for (const player of ranked) this._card(group, player, selfId);
  }

  _teamGroup(root, players, team, selfId) {
    const group = el('div', `vb-player-status-group vb-player-team-${team}`, root);
    const summary = el('div', 'vb-player-status-summary', group);
    const alive = players.filter(isAlive).length;
    summary.textContent = `${team.toUpperCase()} ${alive}/${players.length}`;
    for (const player of ordered(players)) this._card(group, player, selfId);
  }

  _card(group, player, selfId) {
    const alive = isAlive(player);
    const self = player?.local === true || String(player?.id) === String(selfId);
    const team = player?.team === 'alpha' || player?.team === 'bravo'
      ? player.team
      : 'neutral';
    const card = el('div', [
      'vb-player-status-card',
      `vb-player-team-${team}`,
      alive ? 'is-alive' : 'is-dead',
      self ? 'is-self' : '',
    ].filter(Boolean).join(' '), group);
    card.dataset.playerId = String(player?.id ?? '');
    card.setAttribute('aria-label', `${player?.name || player?.id || 'Player'}, ${alive ? 'alive' : 'dead'}, ${scoreOf(player)} points`);

    const dot = el('span', 'vb-player-status-dot', card);
    dot.textContent = alive ? '●' : '×';
    dot.setAttribute('aria-hidden', 'true');
    const name = el('span', 'vb-player-status-name', card);
    name.textContent = String(player?.name || player?.id || 'PLAYER').slice(0, 14);
    const score = el('span', 'vb-player-status-score', card);
    score.textContent = String(scoreOf(player));
    score.title = 'Points';
  }

  dispose() {
    this.root?.remove();
    this.root = null;
    this._signature = '';
  }
}
