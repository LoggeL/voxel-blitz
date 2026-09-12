import { el, formatClock, MAP_LABELS } from './hud-support.js';
import { isTeamMode } from '../../../shared/modes.js';
import { Scoreboard } from './scoreboard.js';
import { MODE_TITLES } from './mode-presentation.js';

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
    const summary = el('div', 'vb-match-result-summary', hero);
    const modeLabel = el('div', 'vb-match-result-mode', summary);
    const score = el('div', 'vb-match-result-score', summary, 'match-result-score');
    const mapLabel = el('div', 'vb-match-result-map', summary);
    const rosterCount = el('div', 'vb-match-result-roster-count', summary, 'match-result-roster-count');
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

    this.dom = { root, scan, panel, eyebrow, title, rule, detail, score, modeLabel, mapLabel, rosterCount,
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
    const victory = teamMode
      ? !!selfRow?.team && String(selfRow.team) === String(winner)
      : selfId !== null && selfId === String(winner);
    const outcome = selfRow && winner != null ? (victory ? 'victory' : 'defeat') : 'complete';
    const roundOnly = mode === 'snd' && !match.winner;
    const results = (Array.isArray(match.results) ? match.results : players || []).filter(p => p && !p.npcRole);
    this.dom.root.dataset.largeRoster = String(results.length > 12);
    this.dom.rosterCount.textContent = this.scoreboard.playerCounts(results);
    const winnerName = teamMode
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
      el('span', 'vb-result-alpha-score', this.dom.score).textContent = match?.scores?.alpha ?? 0;
      el('span', 'vb-result-score-separator', this.dom.score).textContent = ':';
      el('span', 'vb-result-bravo-score', this.dom.score).textContent = match?.scores?.bravo ?? 0;
    }

    if (mode === 'bastion') {
      this.dom.eyebrow.textContent = 'BASTION · REACTOR 9';
      this.dom.detail.textContent = victory ? 'REACTOR SECURED' : match.bastion?.reason === 'core' ? 'REACTOR DESTROYED' : 'DEFENDERS ELIMINATED';
      this.dom.score.textContent = `WAVE ${match.bastion?.wave || 1} / 8 · CORE ${Math.ceil(match.bastion?.core?.hp || 0)} HP`;
    }

    this.scoreboard.update(results, match, selfId);
    const continuation = match.continuation;
    this.roundId = continuation?.id || null;
    const approved = continuation?.approved?.includes(selfId) === true;
    const selfIsBot = selfRow?.bot === true || results.some(p => String(p.id) === selfId && p.bot);
    this.dom.approve.disabled = !selfId || !this.roundId || approved || selfIsBot;
    this.dom.approve.textContent = approved ? 'APPROVED' : 'CONTINUE';
    this.dom.approve.setAttribute('aria-pressed', String(approved));
    this.dom.approvals.textContent = continuation
      ? `${continuation.approved.length} / ${continuation.eligible} PLAYERS APPROVED · ${continuation.required} REQUIRED (40%)`
      : '';
    const remainingVotes = continuation ? Math.max(0, continuation.required - continuation.approved.length) : 0;
    this.dom.needed.textContent = continuation ? remainingVotes ? `${remainingVotes} MORE NEEDED` : 'READY' : '';
    const approvalPercent = continuation?.eligible > 0
      ? Math.min(100, continuation.approved.length / continuation.eligible * 100) : 0;
    const thresholdPercent = Math.round((continuation?.ratio ?? 0.4) * 100);
    this.dom.meter.style.setProperty('--approval-progress', `${approvalPercent}%`);
    this.dom.meter.style.setProperty('--approval-threshold', `${thresholdPercent}%`);
    this.dom.meter.setAttribute('aria-valuenow', String(Math.round(approvalPercent)));
    this.dom.meter.setAttribute('aria-valuetext', this.dom.approvals.textContent);
    this.dom.threshold.textContent = `${thresholdPercent}%`;
    this.dom.countdownHint.textContent = `5s countdown at ${thresholdPercent}%`;
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
