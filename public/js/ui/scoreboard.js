import { el, MAP_LABELS } from './hud-support.js';
import { GUN_GAME_WEAPON_ORDER, isTeamMode, isTrainingDummyId, MODE_RULES } from '../../../shared/modes.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { gunLevel, MODE_TITLES, rankPlayers } from './mode-presentation.js';

/** Mode-specific tables, separate from the always-visible match summary. */
export class Scoreboard {
  build(parent) {
    this.root?.remove();
    this.root = el('section', 'vb-mode-scoreboard', parent, 'scoreboard');
    this.root.setAttribute('aria-label', 'Scoreboard');
    this.root.style.display = 'none';
    const header = el('div', 'vb-scoreboard-heading', this.root);
    this.title = el('h2', '', header);
    this.context = el('span', '', header);
    this.body = el('div', '', this.root, 'scores');
    this.signature = '';
    this.update([], { mode: 'fun' });
    return this.root;
  }

  update(players, match = {}, selfId) {
    if (!this.root) return;
    const mode = match?.mode || 'fun';
    const roster = (players || []).filter((p) => p && !isTrainingDummyId(p.id));
    const signature = JSON.stringify([mode, match?.map, match?.scores, match?.attackers, selfId,
      roster.map((p) => [p.id, p.name, p.team, p.kills, p.deaths, p.score, p.state, p.bomb, p.local])]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.root.dataset.mode = mode;
    this.title.textContent = MODE_TITLES[mode] || MODE_TITLES.fun;
    this.context.textContent = MAP_LABELS[match?.map] || '';
    this.body.innerHTML = '';
    const ranked = rankPlayers(roster, mode);
    if (isTeamMode(mode)) {
      for (const team of ['alpha', 'bravo']) {
        const section = el('section', `vb-scoreboard-team vb-sb-${team}`, this.body);
        const heading = el('h3', `vb-sb-team-heading vb-badge-${team}`, section);
        const role = mode === 'snd' ? (match.attackers === team ? 'ATTACK' : 'DEFEND') : '';
        heading.textContent = `${team.toUpperCase()} ${match?.scores?.[team] ?? 0}`;
        el('span', '', heading).textContent = role || `FIRST TO ${MODE_RULES.tdm.scoreLimit}`;
        this.table(section, ranked.filter((p) => p.team === team), mode, selfId);
      }
    } else {
      this.table(this.body, ranked, mode, selfId);
    }
  }

  table(parent, players, mode, selfId) {
    const table = el('table', '', parent);
    const head = el('tr', '', el('thead', '', table));
    const columns = mode === 'training' ? ['PLAYER']
      : mode === 'gungame' ? ['#', 'PLAYER', 'WEAPON']
        : mode === 'snd' ? ['PLAYER', 'K', 'D', 'STATUS']
          : mode === 'tdm' ? ['PLAYER', 'KILLS', 'DEATHS']
            : ['#', 'PLAYER', 'KILLS', 'DEATHS'];
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
      if (mode === 'fun' || mode === 'chaos' || mode === 'gungame') el('td', 'vb-sb-rank', tr).textContent = String(index + 1);
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
    }
  }

  dispose() { this.root?.remove(); this.root = null; this.signature = ''; }
}
