import { el, MAP_LABELS } from './hud-support.js';
import { GUN_GAME_WEAPON_ORDER, isTeamMode, isTrainingDummyId, MODE_RULES } from '../../../shared/modes.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { gunLevel, MODE_TITLES, rankPlayers } from './mode-presentation.js';
import { treeNode } from '../../../shared/career.js';
import { TEAM_DISPLAY } from '../../../shared/conquest-contract.js';
import { scoreboardRow } from './conquest/scoring.js';

/** Conquest live columns: squad, score, kills, deaths, objective score, vehicles destroyed, revives. */
const CONQUEST_COLUMNS = Object.freeze(['SQ', 'PLAYER', 'SCORE', 'K', 'D', 'OBJ', 'VEH', 'REV']);
const COLUMN_LABELS = Object.freeze({ K: 'Kills', D: 'Deaths', SQ: 'Squad', OBJ: 'Objective score', VEH: 'Vehicles destroyed', REV: 'Revives' });

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
    const identified = new Map((match.corpses || []).filter(body => body.identified && body.playerId != null && !body.fake)
      .map(body => [String(body.playerId), body]));
    const roster = (players || []).filter((p) => p && !isTrainingDummyId(p.id))
      .map(p => mode === 'ttt' ? {...p,
        tttDead: identified.has(String(p.id)) || (match.phase === 'post' && p.state === 'dead'),
        tttRole: match.phase === 'post' ? match.revealedRoles?.[p.id] : identified.get(String(p.id))?.role,
        tttPost: match.phase === 'post',
      } : p);
    const signature = JSON.stringify([mode, match?.map, match?.scores, match?.conquest?.tickets, match?.attackers, selfId, match.continuation?.id,
      roster.map((p) => [p.id, p.name, p.team, p.bot, p.kills, p.deaths, p.score, p.state, p.bomb, p.local, p.ping, p.tttRole, p.tttDead, p.tttPost, p.karma,
        mode === 'conquest' ? [p.cq?.[1], p.squad, p.cqs] : null])]);
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
      // Bastion is co-op: every human defends on alpha against unlisted NPCs.
      const squad = mode === 'bastion';
      const selfTeam = roster.find(p => p.local === true || (selfId != null && String(p.id) === String(selfId)))?.team;
      for (const team of squad ? ['alpha'] : ['alpha', 'bravo']) {
        const section = el('section', `vb-scoreboard-team vb-sb-${team}`, this.body);
        if (mode === 'conquest' && selfTeam) section.dataset.rel = team === selfTeam ? 'own' : 'enemy';
        const heading = el('h3', `vb-sb-team-heading vb-badge-${team}`, section);
        const role = mode === 'snd' ? (match.attackers === team ? 'ATTACK' : 'DEFEND') : '';
        const teamPlayers = ranked.filter((p) => p.team === team);
        const label = squad ? 'SQUAD' : mode === 'conquest' ? TEAM_DISPLAY[team] : team.toUpperCase();
        heading.textContent = this.resultPresentation || squad ? label : `${label} ${(mode === 'conquest' ? match?.conquest?.tickets?.[team] : match?.scores?.[team]) ?? 0}`;
        el('span', '', heading).textContent = this.resultPresentation
          ? this.playerCounts(teamPlayers) : role || (mode === 'conquest' ? 'TICKETS' : mode === 'tdm' ? `FIRST TO ${MODE_RULES.tdm.scoreLimit}` : '');
        if (this.resultPresentation) this.resultGroup(section, teamPlayers, mode, selfId, label);
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
      ? [...(mode === 'ttt' ? [] : ['#']), 'PLAYER', ...(mode === 'gungame' ? ['WEAPON'] : mode === 'ttt' ? [] : mode === 'conquest' ? ['SCORE', 'K', 'D', 'OBJ', 'VEH', 'REV'] : ['K', 'D']), ...(mode === 'snd' ? ['STATUS'] : [])]
      : mode === 'conquest' ? [...CONQUEST_COLUMNS]
      : mode === 'training' ? ['PLAYER']
      : mode === 'gungame' ? ['#', 'PLAYER', 'WEAPON']
        : mode === 'snd' ? ['PLAYER', 'K', 'D', 'STATUS']
          : mode === 'tdm' ? ['PLAYER', 'KILLS', 'DEATHS']
            : mode === 'ttt' ? ['PLAYER']
            : ['#', 'PLAYER', 'KILLS', 'DEATHS'];
    if (mode === 'ttt') columns.push('STATUS', 'KARMA');
    columns.push('PING');
    if (this.resultPresentation) columns.push('VOTE');
    for (const column of columns) {
      const th = el('th', '', head);
      th.scope = 'col';
      th.textContent = column;
      if (COLUMN_LABELS[column]) th.setAttribute('aria-label', COLUMN_LABELS[column]);
    }
    const body = el('tbody', '', table);
    const conquest = mode === 'conquest';
    // Conquest groups each team by squad (squadless players last), best squad score first.
    if (conquest && !this.resultPresentation) players = groupBySquad(players);
    let lastSquad = null;
    for (const [index, player] of players.entries()) {
      const stats = conquest ? scoreboardRow(player) : null;
      if (conquest && !this.resultPresentation && stats.squad !== lastSquad) {
        lastSquad = stats.squad;
        const heading = el('tr', 'vb-sb-squad-row', body);
        const cell = el('td', '', heading);
        cell.colSpan = columns.length;
        cell.textContent = stats.squad > 0 ? `SQUAD ${squadName(stats.squad)}` : 'NO SQUAD';
      }
      const team = isTeamMode(mode) ? player.team : null;
      const self = player.local === true || (selfId != null && String(player.id) === String(selfId));
      const dead = (mode === 'snd' && player.state === 'dead') || (mode === 'ttt' && player.tttDead);
      const tr = el('tr', [self ? 'vb-me' : '', dead ? 'dead' : '', team ? `vb-team-${team}` : ''].filter(Boolean).join(' '), body);
      tr.dataset.pid = String(player.id);
      if (this.resultPresentation) tr.dataset.bot = String(!!player.bot);
      // TTT rows are sorted by name, so a rank would read as a false placement.
      if (mode !== 'ttt' && (this.resultPresentation || (!isTeamMode(mode) && mode !== 'training'))) el('td', 'vb-sb-rank', tr).textContent = String(index + 1);
      if (conquest && !this.resultPresentation) {
        const squadCell = el('td', 'vb-sb-squad', tr);
        squadCell.textContent = stats.squad > 0 ? squadName(stats.squad).slice(0, 1) : '—';
        if (stats.kit) squadCell.title = stats.kit.toUpperCase();
      }
      const name = el('td', 'vb-sb-name', tr);
      name.textContent = String(player.name || 'PLAYER');
      if (mode==='ttt' && player.tttRole) {
        const badge=el('span','vb-ttt-role-badge',name);
        badge.dataset.role=player.tttRole;badge.textContent=player.tttRole.toUpperCase();
      }
      const plate = player.cosmetics?.nameplate && player.cosmetics.nameplate !== 'standard' ? treeNode(player.cosmetics.nameplate) : null;
      if (plate?.kind === 'nameplate') {
        const badge = el('span', 'vb-sb-nameplate', name);
        badge.textContent = plate.badge;
        badge.style.setProperty('--item-color', plate.color || '#9fb6cc');
      }
      if (self) el('span', 'vb-sb-you', name).textContent = 'YOU';
      if (mode === 'snd' && player.bomb) el('span', 'vb-sb-bomb-badge', name).textContent = 'BOMB';
      if (mode === 'gungame') {
        const level = gunLevel(player);
        const cell = el('td', 'vb-sb-progress', tr);
        el('strong', '', cell).textContent = `${level}/${GUN_GAME_WEAPON_ORDER.length}`;
        el('span', '', cell).textContent = WEAPONS[GUN_GAME_WEAPON_ORDER[level - 1]]?.name || '';
      } else if (conquest) {
        for (const value of [stats.score, stats.kills, stats.deaths, stats.objective, stats.vehicles, stats.revives]) {
          el('td', 'vb-sb-number', tr).textContent = String(value);
        }
      } else if (mode !== 'training' && mode !== 'ttt') {
        el('td', 'vb-sb-number', tr).textContent = String(player.kills | 0);
        el('td', 'vb-sb-number', tr).textContent = String(player.deaths | 0);
        if (mode === 'snd') el('td', 'vb-sb-state', tr).textContent = dead ? 'OUT' : 'ALIVE';
      }
      if (mode === 'ttt') {
        el('td', 'vb-sb-state', tr).textContent = dead ? 'TOT' : player.tttPost ? 'LEBT' : 'UNBEKANNT';
        el('td', 'vb-sb-number', tr).textContent = String(player.karma ?? 1000);
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

const SQUAD_NAMES = Object.freeze(['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL']);
/** Squad display name (squad ids are 1-based per team). */
export const squadName = id => SQUAD_NAMES[(id | 0) - 1] || String(id | 0);

/** Stable squad grouping: squads by total score, members in their ranked order, squadless last. */
export function groupBySquad(players) {
  const groups = new Map();
  for (const player of players) {
    const squad = scoreboardRow(player).squad;
    if (!groups.has(squad)) groups.set(squad, []);
    groups.get(squad).push(player);
  }
  const total = list => list.reduce((sum, p) => sum + (p.score | 0), 0);
  return [...groups.entries()]
    .sort(([a, listA], [b, listB]) => (a === 0) - (b === 0) || total(listB) - total(listA) || a - b)
    .flatMap(([, list]) => list);
}
