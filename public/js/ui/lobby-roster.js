import { BOT_DIFFICULTIES, botDifficulty, DEFAULT_BOT_DIFFICULTY } from '../../../shared/bot-difficulty.js';
import { MAX_TEAM_PLAYERS, hasLobbyTeams, lobbyCapacity } from '../../../shared/lobby-limits.js';
import { el, loadPref, savePref } from './hud-support.js';

/** Three presentations of the same authoritative roster; filters never affect the game. */
export class LobbyRoster {
  constructor(parent, callbacks = {}) {
    Object.assign(this, callbacks);
    this.root = parent;
    this.view = loadPref('vb-roster-view', 'overview');
    if (!['overview', 'list', 'teams'].includes(this.view)) this.view = 'overview';
    this.filter = 'all';
    this.query = '';
    this.header = el('div', 'vb-roster-header', parent);
    el('h3', 'vb-label', this.header).textContent = 'OPERATORS';
    this.count = el('span', 'vb-ready-count', this.header, 'lobby-ready-count');
    this.summary = el('div', 'vb-roster-summary', parent);
    const toolbar = el('div', 'vb-roster-toolbar', parent);
    const views = el('div', 'vb-roster-views', toolbar);
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', 'Operator view');
    this.viewButtons = {};
    for (const view of ['overview', 'list', 'teams']) {
      const button = el('button', 'vb-roster-view', views, `lobby-view-${view}`);
      button.type = 'button';
      button.textContent = view.toUpperCase();
      button.setAttribute('aria-controls', 'lobby-roster');
      button.addEventListener('click', () => this.setView(view));
      this.viewButtons[view] = button;
    }
    this.search = el('input', 'vb-roster-search', toolbar);
    this.search.type = 'search';
    this.search.placeholder = 'Search operators...';
    this.search.setAttribute('aria-label', 'Search operators');
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.update(this.state);
    });
    const filters = el('div', 'vb-roster-filters', parent);
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Filter operators');
    this.filterButtons = {};
    for (const filter of ['all', 'humans', 'bots', 'waiting']) {
      const button = el('button', '', filters);
      button.type = 'button';
      button.addEventListener('click', () => { this.filter = filter; this.update(this.state); });
      this.filterButtons[filter] = button;
    }
    this.results = el('span', 'vb-roster-results', filters);
    this.results.setAttribute('role', 'status');
    this.list = el('div', 'vb-roster-list', parent, 'lobby-roster');
    this.list.tabIndex = 0;
    this.list.setAttribute('aria-label', 'Operators');
    this.hint = el('p', 'vb-lobby-team-hint', parent);
  }

  setView(view) {
    this.view = view;
    savePref('vb-roster-view', view);
    this.update(this.state);
  }

  update(state) {
    if (!state) return;
    this.state = state;
    const members = Array.isArray(state.members) ? state.members : [];
    const teams = hasLobbyTeams(state.gameMode);
    const humans = members.filter(member => !member.bot);
    const ready = humans.filter(member => member.ready).length;
    const counts = { all: members.length, humans: humans.length, bots: members.length - humans.length, waiting: humans.length - ready };
    const teamCounts = { alpha: 0, bravo: 0 };
    for (const member of members) if (member.team in teamCounts) teamCounts[member.team]++;
    const selfIsHost = state.selfId != null && String(state.selfId) === String(state.host);
    const limit = lobbyCapacity(state.gameMode, state.map);
    this.count.textContent = `${members.length}/${limit} OPERATORS · ${ready}/${humans.length} READY${teams ? ` · ALPHA ${teamCounts.alpha} : ${teamCounts.bravo} BRAVO` : ''}`;
    this.summary.textContent = `${humans.length} ${humans.length === 1 ? 'HUMAN' : 'HUMANS'} · ${counts.bots} BOTS · ${Math.max(0, limit - members.length)} OPEN SLOTS`;
    if (!teams && this.view === 'teams') this.view = 'overview';
    this.root.dataset.view = this.view;
    for (const [view, button] of Object.entries(this.viewButtons)) {
      button.disabled = view === 'teams' && !teams;
      button.title = view === 'teams' && !teams ? 'Available in Team Deathmatch and Search & Destroy' : '';
      button.setAttribute('aria-pressed', String(view === this.view));
    }
    for (const [filter, button] of Object.entries(this.filterButtons)) {
      button.textContent = `${filter.toUpperCase()} (${counts[filter]})`;
      button.setAttribute('aria-pressed', String(filter === this.filter));
    }
    this.hint.textContent = teams
      ? (selfIsHost ? `Assign teams in List or Teams view. Up to ${Math.min(MAX_TEAM_PLAYERS, limit)} per team within the ${limit}-player map limit. Changes reset readiness.` : 'The host assigns teams. Team changes reset readiness.')
      : 'Select an operator in Overview to see details in List view.';
    const filtered = members.filter(member => (!this.query || (member.name || '').toLowerCase().includes(this.query))
      && (this.filter === 'all' || (this.filter === 'humans' && !member.bot)
      || (this.filter === 'bots' && member.bot) || (this.filter === 'waiting' && !member.bot && !member.ready)));
    this.results.textContent = `${filtered.length} / ${members.length} shown`;
    // Heartbeat/ping updates must preserve focus, open native selects and scroll.
    const signature = JSON.stringify([this.view, this.filter, this.query, state.gameMode, state.map, state.phase, state.selfId, state.host,
      members.map(({ id, name, bot, ready, team, difficulty }) => [id, name, bot, ready, team, difficulty])]);
    if (signature !== this.signature) {
      this.signature = signature;
      const scrollTop = this.list.scrollTop;
      this.list.replaceChildren();
      this.list.setAttribute('role', this.view === 'teams' ? 'group' : 'list');
      if (!filtered.length) el('p', 'vb-roster-empty', this.list).textContent = 'No operators match this filter.';
      else if (this.view === 'teams') {
        for (const team of ['alpha', 'bravo']) {
          const group = el('section', 'vb-roster-team', this.list);
          group.dataset.team = team;
          el('h4', '', group).textContent = `${team.toUpperCase()} · ${teamCounts[team]} OPERATORS`;
          const list = el('div', 'vb-roster-team-list', group);
          list.setAttribute('role', 'list');
          list.setAttribute('aria-label', `${team} operators`);
          const rows = filtered.filter(member => member.team === team);
          for (const member of rows) this.renderMember(list, member, state, selfIsHost, teams, teamCounts);
          if (!rows.length) el('p', 'vb-roster-empty', group).textContent = 'No matching operators.';
        }
      } else for (const member of filtered) this.renderMember(this.list, member, state, selfIsHost, teams, teamCounts);
      this.list.scrollTop = scrollTop;
    }
    for (const ping of this.list.querySelectorAll('.vb-roster-ping')) {
      const member = members.find(row => String(row.id) === ping.dataset.memberId);
      ping.textContent = Number.isFinite(member?.ping) ? `${member.ping} ms` : 'Measuring...';
      ping.setAttribute('aria-label', Number.isFinite(member?.ping) ? `Ping: ${member.ping} milliseconds` : 'Measuring ping');
    }
  }

  renderMember(parent, member, state, selfIsHost, teamSelection, teamCounts) {
    const isSelf = state.selfId != null && String(member.id) === String(state.selfId);
    const isHost = state.host != null && String(member.id) === String(state.host);
    const isBot = !!member.bot;

    const item = el('div', `vb-roster-item${isSelf ? ' is-self' : ''}`, parent);
    item.setAttribute('role', 'listitem');
    item.dataset.memberId = String(member.id);
    item.dataset.team = member.team || '';
    item.tabIndex = -1;

    const portrait = el('span', `vb-operator-icon${isBot ? ' is-bot' : ''}`, item);
    portrait.setAttribute('aria-hidden', 'true');
    const leftColumn = el('div', 'vb-roster-left', item);
    const name = el('span', 'vb-roster-name', leftColumn);
    name.textContent = member.name || (isBot ? 'TACTICAL BOT' : 'OPERATOR');
    name.title = name.textContent;

    if (isSelf) {
      const badge = el('span', 'vb-badge vb-badge-you', leftColumn);
      badge.textContent = 'YOU';
    }
    if (isHost) {
      const badge = el('span', 'vb-badge vb-badge-host', leftColumn);
      badge.textContent = 'HOST';
    }
    if (isBot) {
      const badge = el('span', 'vb-badge vb-badge-bot', leftColumn);
      badge.textContent = 'BOT';
    }

    const rightColumn = el('div', 'vb-roster-right', item);
    if (isBot) {
      if (state.phase === 'waiting' && selfIsHost) {
        const select = el('select', 'vb-bot-difficulty', rightColumn);
        select.setAttribute('aria-label', `Difficulty for ${member.name || 'BOT'}`);
        select.dataset.botId = String(member.id);
        for (const [id, profile] of Object.entries(BOT_DIFFICULTIES)) {
          const option = el('option', '', select);
          option.value = id; option.textContent = profile.label;
        }
        select.value = member.difficulty || DEFAULT_BOT_DIFFICULTY;
        select.addEventListener('change', () => this.onBotDifficulty?.(member.id, select.value));
      } else {
        const badge = el('span', 'vb-bot-difficulty-label', rightColumn);
        badge.textContent = botDifficulty(member.difficulty).label;
      }
    }
    if (teamSelection) {
      if (state.phase === 'waiting' && selfIsHost) {
        const select = el('select', 'vb-team-select', rightColumn);
        select.setAttribute('aria-label', `Team for ${member.name || 'OPERATOR'}`);
        for (const team of ['alpha', 'bravo']) {
          const option = el('option', '', select);
          option.value = team;
          option.textContent = team.toUpperCase();
          option.disabled = member.team !== team && teamCounts[team] >= MAX_TEAM_PLAYERS;
        }
        select.value = member.team || 'alpha';
        select.dataset.team = select.value;
        select.addEventListener('change', () => this.onTeam?.(member.id, select.value));
      } else {
        const label = el('span', 'vb-team-label', rightColumn);
        label.dataset.team = member.team || '';
        label.textContent = member.team?.toUpperCase() || 'AUTO TEAM';
      }
    }
    if (!isBot) {
      const ping = el('span', 'vb-roster-ping', rightColumn);
      ping.dataset.memberId = String(member.id);
      ping.textContent = Number.isFinite(member.ping) ? `${member.ping} ms` : 'Measuring…';
      ping.setAttribute('aria-label', Number.isFinite(member.ping) ? `Ping: ${member.ping} milliseconds` : 'Measuring ping');
    }
    const readyPill = el('span', 'vb-ready-pill', rightColumn);
    if (isBot) {
      readyPill.classList.add('bot');
      readyPill.textContent = 'AUTO-READY';
    } else if (member.ready) {
      readyPill.classList.add('ready');
      readyPill.textContent = 'READY';
    } else {
      readyPill.classList.add('not-ready');
      readyPill.textContent = 'WAITING';
    }

    const compact = el('div', 'vb-roster-compact', item);
    if (teamSelection) {
      const team = el('span', 'vb-team-label', compact);
      team.dataset.team = member.team || '';
      team.textContent = member.team?.toUpperCase() || 'AUTO TEAM';
    }
    if (isBot) el('span', 'vb-compact-difficulty', compact).textContent = botDifficulty(member.difficulty).label;
    const status = el('span', `vb-compact-status ${isBot ? 'bot' : member.ready ? 'ready' : 'waiting'}`, compact);
    status.textContent = isBot ? 'AUTO' : member.ready ? 'READY' : 'WAITING';
    const inspect = el('button', 'vb-roster-inspect', item);
    inspect.type = 'button';
    inspect.setAttribute('aria-label', `Details for ${name.textContent}`);
    inspect.addEventListener('click', () => {
      this.setView('list');
      const row = [...this.list.querySelectorAll('.vb-roster-item')].find(row => row.dataset.memberId === String(member.id));
      row?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      row?.focus({ preventScroll: true });
    });
  }
}
