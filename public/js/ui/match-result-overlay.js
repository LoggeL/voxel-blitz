import { el, formatClock, MAP_LABELS } from './hud-support.js';
import { isTeamMode } from '../../../shared/modes.js';
import { Scoreboard } from './scoreboard.js';
import { MODE_TITLES } from './mode-presentation.js';
import { TEAM_DISPLAY } from '../../../shared/conquest-contract.js';
import { conquestMvps, relativeTeam, ticketGraphModel } from './conquest/scoring.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function upper(value, fallback) {
  return String(value || fallback).toUpperCase();
}

/** Snapshot-driven final match presentation. It owns no timers or match state. */
export class MatchResultOverlay {
  constructor({ onContinue = () => false } = {}) {
    this.dom = {};
    this.onContinue = onContinue;
    this.scoreboard = new Scoreboard();
    this.roundId = null;
  }

  build(hud) {
    this.dispose();
    const root = el('section', 'vb-match-result hidden', hud, 'match-result-screen');
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Round result');

    const scan = el('div', 'vb-match-result-scan', root);
    const panel = el('div', 'vb-match-result-panel', root);
    const hero = el('div', 'vb-match-result-hero', panel);
    const intro = el('div', 'vb-match-result-intro', hero);
    const eyebrow = el('div', 'vb-match-result-eyebrow', intro, 'match-result-eyebrow');
    const title = el('div', 'vb-match-result-title', intro, 'match-result-title');
    const rule = el('div', 'vb-match-result-rule', intro);
    const detail = el('div', 'vb-match-result-detail', intro, 'match-result-detail');
    const traitors = el('div', 'vb-match-result-detail', intro, 'match-result-traitors');
    traitors.hidden = true;
    const summary = el('div', 'vb-match-result-summary', hero);
    const modeLabel = el('div', 'vb-match-result-mode', summary);
    const score = el('div', 'vb-match-result-score', summary, 'match-result-score');
    const mapLabel = el('div', 'vb-match-result-map', summary);
    const rosterCount = el('div', 'vb-match-result-roster-count', summary, 'match-result-roster-count');
    // Conquest: ticket graph over the match and MVP per category.
    const conquest = el('div', 'vb-result-conquest', panel);
    conquest.hidden = true;
    const graphBox = el('figure', 'vb-result-graph', conquest);
    const graphTitle = el('figcaption', 'vb-result-graph-title', graphBox);
    graphTitle.textContent = 'TICKETS';
    const doc = globalThis.document;
    const graph = doc.createElementNS(SVG_NS, 'svg');
    graph.setAttribute('class', 'vb-result-graph-svg');
    graph.setAttribute('preserveAspectRatio', 'none');
    graph.setAttribute('role', 'img');
    graphBox.appendChild(graph);
    const mvps = el('div', 'vb-result-mvps', conquest);
    const scoreboard = this.scoreboard.build(panel, { id: 'match-result-scoreboard', bodyId: 'match-result-scores', presentation: 'result' });
    scoreboard.style.display = 'block';
    const footer = el('div', 'vb-match-result-footer', panel);
    const voting = el('div', 'vb-match-result-voting', footer);
    const voteCounts = el('div', 'vb-match-result-vote-counts', voting);
    const approvals = el('div', 'vb-match-result-approvals', voteCounts, 'match-result-approvals');
    approvals.setAttribute('aria-live', 'polite');
    const needed = el('div', 'vb-match-result-needed', voteCounts, 'match-result-needed');
    const meter = el('div', 'vb-match-result-meter', voting, 'match-result-meter');
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', 'Player approvals');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    el('div', 'vb-match-result-meter-fill', meter);
    const threshold = el('div', 'vb-match-result-threshold', meter);
    threshold.setAttribute('aria-hidden', 'true');
    const votingHint = el('div', 'vb-match-result-voting-hint', voting);
    const botNote = el('span', 'vb-match-result-bot-note', votingHint);
    botNote.textContent = 'BOTS CANNOT VOTE';
    const countdownHint = el('span', '', votingHint);
    const action = el('div', 'vb-match-result-action', footer);
    const approve = el('button', 'vb-match-result-approve', action, 'match-result-approve');
    approve.type = 'button';
    approve.addEventListener('click', () => {
      if (!approve.disabled && this.roundId) this.onContinue(this.roundId);
    });
    const countdown = el('div', 'vb-match-result-countdown', action, 'match-result-countdown');

    this.dom = { root, scan, panel, eyebrow, title, rule, detail, traitors, score, modeLabel, mapLabel, rosterCount, conquest, graph, mvps,
      scoreboard, approvals, needed, meter, threshold, votingHint, countdownHint, approve, countdown };
    this.hide();
    return this.dom;
  }

  update(match, selfRow, players, serverNow) {
    const winner = match?.winner ?? match?.roundWinner;
    if (match?.phase !== 'post') {
      this.hide();
      return null;
    }
    const wasHidden = this.dom.root.classList.contains('hidden');

    const mode = match.mode || 'fun';
    this.dom.root.dataset.mode = mode;
    this.dom.modeLabel.textContent = MODE_TITLES[mode] || mode.toUpperCase();
    this.dom.mapLabel.textContent = MAP_LABELS[match.map] || '';
    const teamMode = isTeamMode(mode);
    const selfId = selfRow?.id == null ? null : String(selfRow.id);
    const victory = mode === 'ttt' ? selfRow?.ttt?.role === winner : teamMode
      ? !!selfRow?.team && String(selfRow.team) === String(winner)
      : selfId !== null && selfId === String(winner);
    const outcome = selfRow && winner != null ? (victory ? 'victory' : 'defeat') : 'complete';
    const roundOnly = mode === 'snd' && !match.winner;
    const results = (Array.isArray(match.results) ? match.results : players || []).filter(p => p && !p.npcRole);
    this.dom.root.dataset.largeRoster = String(results.length > 12);
    this.dom.rosterCount.textContent = this.scoreboard.playerCounts(results);
    const winnerName = mode === 'conquest' ? (TEAM_DISPLAY[winner] || 'NOBODY') : teamMode
      ? upper(winner, 'TEAM')
      : this._nameFor(winner, results);

    this.dom.eyebrow.textContent = roundOnly ? `ROUND ${match.round} COMPLETE` : mode === 'snd' ? 'OPERATION COMPLETE' : 'MATCH COMPLETE';
    this.dom.title.textContent = outcome === 'victory'
      ? 'VICTORY'
      : (outcome === 'defeat' ? 'DEFEAT' : 'RESULT');
    this.dom.detail.textContent = teamMode
      ? `${winnerName} SECURED THE ${roundOnly ? 'ROUND' : 'MATCH'}`
      : mode === 'duel' ? `${winnerName} WON THE DUEL` : `${winnerName} COMPLETED THE ARSENAL`;
    this.dom.score.textContent = teamMode
      ? `${match?.scores?.alpha ?? 0}  —  ${match?.scores?.bravo ?? 0}`
      : mode === 'duel' ? `FIRST TO ${match.killLimit} KILLS` : 'GUN GAME WINNER';
    this.dom.score.classList.toggle('is-team-score', teamMode);
    if (teamMode) {
      this.dom.score.textContent = '';
      el('span', 'vb-result-alpha-score', this.dom.score).textContent = (mode === 'conquest' ? match?.conquest?.tickets?.alpha : match?.scores?.alpha) ?? 0;
      el('span', 'vb-result-score-separator', this.dom.score).textContent = ':';
      el('span', 'vb-result-bravo-score', this.dom.score).textContent = (mode === 'conquest' ? match?.conquest?.tickets?.bravo : match?.scores?.bravo) ?? 0;
    }

    if (mode === 'ttt') {
      this.dom.detail.textContent = `${winner === 'traitor' ? 'TRAITORS' : 'INNOCENTS'} GEWINNEN`;
      this.dom.score.textContent = `RUNDE ${match.round}`;
      const roster = match.roleRoster || results.map(p=>({...p,role:match.revealedRoles?.[p.id]}));
      this.dom.traitors.textContent = `TRAITORS: ${roster.filter(p=>p.role==='traitor').map(p=>p.name).join(', ') || 'Keine'}`;
    }
    this.dom.traitors.hidden = mode !== 'ttt';
    this._conquest(mode === 'conquest' ? match : null, selfRow, results);
    if (mode === 'conquest') {
      const selfTeam = selfRow?.team;
      this.dom.score.textContent = '';
      // Own side left in blue, whichever side the local player fought for.
      const own = selfTeam === 'bravo' ? 'bravo' : 'alpha', enemy = own === 'alpha' ? 'bravo' : 'alpha';
      for (const [team, cls] of [[own, 'vb-result-alpha-score'], [null, 'vb-result-score-separator'], [enemy, 'vb-result-bravo-score']]) {
        const span = el('span', cls, this.dom.score);
        if (!team) { span.textContent = ':'; continue; }
        span.dataset.rel = relativeTeam(team, selfTeam);
        span.textContent = String(match?.conquest?.tickets?.[team] ?? 0);
        span.title = `${TEAM_DISPLAY[team]} tickets`;
      }
      if (winner == null) {
        this.dom.title.textContent = 'DRAW';
        this.dom.detail.textContent = 'TICKETS AND FLAGS EVEN';
      } else this.dom.detail.textContent = `${winnerName} HOLDS THE FRONTIER`;
    }
    if (mode === 'bastion') {
      const b = match.bastion || {};
      const reason = b.reason;
      this.dom.eyebrow.textContent = `BASTION · ${MAP_LABELS[match.map] || match.map || ''}`;
      this.dom.detail.textContent = victory ? 'EXTRACTION COMPLETE'
        : reason === 'objective' ? `${b.core?.name || 'OBJECTIVE'} DESTROYED`
        : reason === 'team' ? 'DEFENDERS ELIMINATED'
        : reason === 'missed' ? 'EVAC MISSED'
        : reason === 'abandoned' ? 'RUN ABANDONED'
        : reason === 'core' ? 'REACTOR DESTROYED' : 'DEFENDERS ELIMINATED';
      const stage = b.stage;
      this.dom.score.textContent = stage
        ? `STAGE ${(stage.index ?? 0) + 1} / ${stage.count || 1} · WAVE ${b.wave || 1}`
        : `WAVE ${b.wave || 1}`;
    }

    this.scoreboard.update(results, match, selfId);
    const continuation = match.continuation;
    this.roundId = continuation?.id || null;
    const approved = continuation?.approved?.includes(selfId) === true;
    const selfIsBot = selfRow?.bot === true || results.some(p => String(p.id) === selfId && p.bot);
    this.dom.approve.disabled = !selfId || !this.roundId || approved || selfIsBot;
    this.dom.approve.textContent = approved ? 'APPROVED' : 'CONTINUE';
    this.dom.approve.setAttribute('aria-pressed', String(approved));
    const thresholdPercent = Math.round((continuation?.ratio ?? 0.4) * 100);
    this.dom.approvals.textContent = continuation
      ? `${continuation.approved.length} / ${continuation.eligible} PLAYERS APPROVED · ${continuation.required} REQUIRED (${thresholdPercent}%)`
      : '';
    const remainingVotes = continuation ? Math.max(0, continuation.required - continuation.approved.length) : 0;
    this.dom.needed.textContent = continuation ? remainingVotes ? `${remainingVotes} MORE NEEDED` : 'READY' : '';
    const approvalPercent = continuation?.eligible > 0
      ? Math.min(100, continuation.approved.length / continuation.eligible * 100) : 0;
    this.dom.meter.style.setProperty('--approval-progress', `${approvalPercent}%`);
    this.dom.meter.style.setProperty('--approval-threshold', `${thresholdPercent}%`);
    this.dom.meter.setAttribute('aria-valuenow', String(Math.round(approvalPercent)));
    this.dom.meter.setAttribute('aria-valuetext', this.dom.approvals.textContent);
    this.dom.threshold.textContent = `${thresholdPercent}%`;
    this.dom.countdownHint.textContent = `${Math.round((continuation?.countdownMs ?? 5000) / 1000)}s countdown at ${thresholdPercent}%`;
    const now = Number.isFinite(serverNow) ? serverNow : Date.now();
    const remaining = Number.isFinite(match.phaseEndsAt)
      ? Math.max(0, (match.phaseEndsAt - now) / 1000)
      : null;
    this.dom.countdown.textContent = remaining === null
      ? 'WAITING FOR APPROVALS'
      : `NEXT ${roundOnly ? 'ROUND' : 'MATCH'} IN ${formatClock(remaining)}`;

    this.dom.root.className = `vb-match-result is-${outcome}`;
    this.dom.root.setAttribute('aria-hidden', 'false');
    if (wasHidden && !this.dom.approve.disabled) this.dom.approve.focus({ preventScroll: true });
    return outcome;
  }

  _conquest(match, selfRow, results) {
    const { conquest, graph, mvps } = this.dom;
    if (!conquest) return;
    conquest.hidden = !match;
    if (!match) return;
    const selfTeam = selfRow?.team;
    const own = selfTeam === 'bravo' ? 'bravo' : 'alpha';
    const model = ticketGraphModel(match.conquest?.ticketGraph, { width: 480, height: 110, maxTickets: match.conquest?.maxTickets });
    graph.textContent = '';
    graph.parentNode.hidden = !model;
    if (model) {
      graph.setAttribute('viewBox', `0 0 ${model.width} ${model.height}`);
      graph.setAttribute('aria-label', `Tickets over ${Math.round(model.durationMs / 60000)} minutes: ${TEAM_DISPLAY.alpha} ${model.final.alpha}, ${TEAM_DISPLAY.bravo} ${model.final.bravo}`);
      for (let i = 1; i < 4; i++) {
        const grid = globalThis.document.createElementNS(SVG_NS, 'line');
        for (const [k, v] of Object.entries({ x1: 0, x2: model.width, y1: model.height * i / 4, y2: model.height * i / 4, class: 'vb-result-graph-grid' })) grid.setAttribute(k, String(v));
        graph.appendChild(grid);
      }
      for (const team of ['alpha', 'bravo']) {
        const line = globalThis.document.createElementNS(SVG_NS, 'polyline');
        line.setAttribute('points', model[team]);
        line.setAttribute('class', `vb-result-graph-line is-${team === own ? 'own' : 'enemy'}`);
        graph.appendChild(line);
      }
    }
    mvps.textContent = '';
    for (const mvp of conquestMvps(results)) {
      const card = el('div', 'vb-result-mvp', mvps);
      card.dataset.rel = relativeTeam(mvp.team, selfTeam);
      el('span', 'vb-result-mvp-title', card).textContent = mvp.title;
      el('strong', 'vb-result-mvp-name', card).textContent = mvp.name;
      el('span', 'vb-result-mvp-value', card).textContent = `${mvp.value} ${({ score: 'PTS', kills: 'KILLS', objective: 'OBJ', vehicles: 'VEHICLES', revives: 'REVIVES' })[mvp.key]}`;
    }
  }

  hide() {
    this.roundId = null;
    const root = this.dom.root;
    if (!root || root.classList.contains('hidden')) return;
    root.className = 'vb-match-result hidden';
    root.setAttribute('aria-hidden', 'true');
  }

  dispose() {
    this.scoreboard.dispose();
    this.roundId = null;
    this.dom.root?.remove();
    this.dom = {};
  }

  _nameFor(id, players) {
    const row = (Array.isArray(players) ? players : [])
      .find((player) => String(player?.id) === String(id));
    return upper(row?.name || id, 'OPERATOR');
  }
}
