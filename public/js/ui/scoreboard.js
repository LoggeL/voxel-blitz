import { el, MAP_LABELS } from './hud-support.js';
import { GUN_GAME_WEAPON_ORDER, isTeamMode, isTrainingDummyId, MODE_RULES } from '../../../shared/modes.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { gunLevel, MODE_TITLES, rankPlayers } from './mode-presentation.js';

/** Mode-specific tables, separate from the always-visible match summary. */
export class Scoreboard {
  build(parent, { id = 'scoreboard', bodyId = 'scores', presentation = 'live' } = {}) {
    this.root?.remove();
    this.root = el('section', 'vb-mode-scoreboard', parent, id);
    this.root.setAttribute('aria-label', 'Scoreboard');
    this.resultPresentation = presentation === 'result';
    this.voteCells = new Map();
    this.root.style.display = 'none';
    const header = el('div', 'vb-scoreboard-heading', this.root);
    this.title = el('h2', '', header);
    this.context = el('span', '', header);
    this.body = el('div', '', this.root, bodyId);
    this.signature = '';
    this.update([], { mode: 'fun' });
    return this.root;
  }

  update(players, match = {}, selfId) {
    if (!this.root) return;
    match ??= {};
    const mode = match?.mode || 'fun';
    const roster = (players || []).filter((p) => p && !isTrainingDummyId(p.id));
    const signature = JSON.stringify([mode, match?.map, match?.scores, match?.attackers, selfId, match.continuation?.id,
      roster.map((p) => [p.id, p.name, p.team, p.bot, p.kills, p.deaths, p.score, p.state, p.bomb, p.local, p.ping])]);
    if (signature === this.signature) {
      this.updateVotes(match.continuation);
      return;
    }
    this.signature = signature;
    this.root.dataset.mode = mode;
    this.title.textContent = MODE_TITLES[mode] || MODE_TITLES.fun;
    this.context.textContent = MAP_LABELS[match?.map] || '';
    this.body.innerHTML = '';
    this.voteCells.clear();
    const ranked = rankPlayers(roster, mode);
    if (isTeamMode(mode)) {
      for (const team of ['alpha', 'bravo']) {
        const section = el('section', `vb-scoreboard-team vb-sb-${team}`, this.body);
        const heading = el('h3', `vb-sb-team-heading vb-badge-${team}`, section);
        const role = mode === 'snd' ? (match.attackers === team ? 'ATTACK' : 'DEFEND') : '';
        const teamPlayers = ranked.filter((p) => p.team === team);
        heading.textContent = this.resultPresentation ? team.toUpperCase() : `${team.toUpperCase()} ${match?.scores?.[team] ?? 0}`;
        el('span', '', heading).textContent = this.resultPresentation
          ? this.playerCounts(teamPlayers) : role || `FIRST TO ${MODE_RULES.tdm.scoreLimit}`;
        if (this.resultPresentation) this.resultGroup(section, teamPlayers, mode, selfId, team.toUpperCase());
        else this.table(section, teamPlayers, mode, selfId);
      }
    } else if (this.resultPresentation) {
      const section = el('section', 'vb-scoreboard-team vb-sb-solo', this.body);
      this.resultGroup(section, ranked, mode, selfId, 'Match');
    } else {
      this.table(this.body, ranked, mode, selfId);
    }
    this.updateVotes(match.continuation);
  }

  playerCounts(players) {
    const bots = players.filter(p => p.bot).length;
    const humans = players.length - bots;
    return `${humans} PLAYER${humans === 1 ? '' : 'S'}${bots ? ` + ${bots} BOT${bots === 1 ? '' : 'S'}` : ''}`;
  }

  resultGroup(parent, players, mode, selfId, label) {
    const humans = players.filter(p => !p.bot);
    const bots = players.filter(p => p.bot);
    const roster = el('div', 'vb-result-roster', parent);
    roster.tabIndex = 0;
    roster.setAttribute('role', 'region');
    roster.setAttribute('aria-label', `${label} players`);
    this.table(roster, humans, mode, selfId);
    if (!humans.length) el('p', 'vb-result-empty', roster).textContent = 'NO HUMAN PLAYERS';
    if (!bots.length) return;
    const group = el('details', 'vb-result-bots', parent);
    const summary = el('summary', '', group);
    el('span', '', summary).textContent = `${bots.length} BOT${bots.length === 1 ? '' : 'S'}`;
    const toggleLabel = el('span', 'vb-result-bot-toggle', summary);
    toggleLabel.textContent = 'SHOW';
    el('span', 'vb-result-no-vote', summary).textContent = 'NO VOTE';
    group.addEventListener('toggle', () => { toggleLabel.textContent = group.open ? 'HIDE' : 'SHOW'; });
    const botRoster = el('div', 'vb-result-bot-roster', group);
    botRoster.tabIndex = 0;
    botRoster.setAttribute('role', 'region');
    botRoster.setAttribute('aria-label', `${label} bots, cannot vote`);
    this.table(botRoster, bots, mode, selfId);
  }

  updateVotes(continuation) {
    if (!this.resultPresentation) return;
    const approved = new Set((continuation?.approved || []).map(String));
    for (const [id, { cell, bot }] of this.voteCells) {
      const voted = !bot && approved.has(id);
      const value = voted ? '✓' : '—';
      if (cell.textContent !== value) cell.textContent = value;
      cell.classList.toggle('is-approved', voted);
      cell.setAttribute('aria-label', bot ? 'Bot: cannot vote' : voted ? 'Approved' : 'Waiting for approval');
    }
  }

  table(parent, players, mode, selfId) {
    const table = el('table', '', parent);
    const head = el('tr', '', el('thead', '', table));
    const columns = this.resultPresentation
      ? ['#', 'PLAYER', ...(mode === 'gungame' ? ['WEAPON'] : ['K', 'D']), ...(mode === 'snd' ? ['STATUS'] : [])]
      : mode === 'training' ? ['PLAYER']
      : mode === 'gungame' ? ['#', 'PLAYER', 'WEAPON']
        : mode === 'snd' ? ['PLAYER', 'K', 'D', 'STATUS']
          : mode === 'tdm' ? ['PLAYER', 'KILLS', 'DEATHS']
            : ['#', 'PLAYER', 'KILLS', 'DEATHS'];
    columns.push('PING');
    if (this.resultPresentation) columns.push('VOTE');
    for (const column of columns) {
      const th = el('th', '', head);
      th.scope = 'col';
      th.textContent = column;
      if (column === 'K' || column === 'D') th.setAttribute('aria-label', column === 'K' ? 'Kills' : 'Deaths');
    }
    const body = el('tbody', '', table);
    for (const [index, player] of players.entries()) {
      const team = isTeamMode(mode) ? player.team : null;
      const self = player.local === true || (selfId != null && String(player.id) === String(selfId));
      const dead = mode === 'snd' && player.state === 'dead';
      const tr = el('tr', [self ? 'vb-me' : '', dead ? 'dead' : '', team ? `vb-team-${team}` : ''].filter(Boolean).join(' '), body);
      tr.dataset.pid = String(player.id);
      if (this.resultPresentation) tr.dataset.bot = String(!!player.bot);
      if (this.resultPresentation || (!isTeamMode(mode) && mode !== 'training')) el('td', 'vb-sb-rank', tr).textContent = String(index + 1);
      const name = el('td', 'vb-sb-name', tr);
      name.textContent = String(player.name || 'PLAYER');
      if (self) el('span', 'vb-sb-you', name).textContent = 'YOU';
      if (mode === 'snd' && player.bomb) el('span', 'vb-sb-bomb-badge', name).textContent = 'BOMB';
      if (mode === 'gungame') {
        const level = gunLevel(player);
        const cell = el('td', 'vb-sb-progress', tr);
        el('strong', '', cell).textContent = `${level}/${GUN_GAME_WEAPON_ORDER.length}`;
        el('span', '', cell).textContent = WEAPONS[GUN_GAME_WEAPON_ORDER[level - 1]]?.name || '';
      } else if (mode !== 'training') {
        el('td', 'vb-sb-number', tr).textContent = String(player.kills | 0);
        el('td', 'vb-sb-number', tr).textContent = String(player.deaths | 0);
        if (mode === 'snd') el('td', 'vb-sb-state', tr).textContent = dead ? 'OUT' : 'ALIVE';
      }
      el('td', 'vb-sb-number vb-sb-ping', tr).textContent = Number.isFinite(player.ping) && !player.bot
        ? `${Math.max(0, Math.round(player.ping))} ms` : '—';
      if (this.resultPresentation) {
        const cell = el('td', 'vb-sb-vote', tr);
        this.voteCells.set(String(player.id), { cell, bot: !!player.bot });
      }
    }
  }

  dispose() { this.root?.remove(); this.root = null; this.signature = ''; this.voteCells?.clear(); }
}
