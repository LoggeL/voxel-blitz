import { el, formatClock } from './hud-support.js';
import { isTeamMode } from '../../../shared/modes.js';

function upper(value, fallback) {
  return String(value || fallback).toUpperCase();
}

/** Snapshot-driven final match presentation. It owns no timers or match state. */
export class MatchResultOverlay {
  constructor() {
    this.dom = {};
  }

  build(hud) {
    this.dispose();
    const root = el('section', 'vb-match-result hidden', hud, 'match-result-screen');
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('aria-live', 'assertive');
    root.setAttribute('role', 'status');

    const scan = el('div', 'vb-match-result-scan', root);
    const panel = el('div', 'vb-match-result-panel', root);
    const eyebrow = el('div', 'vb-match-result-eyebrow', panel, 'match-result-eyebrow');
    const title = el('div', 'vb-match-result-title', panel, 'match-result-title');
    const rule = el('div', 'vb-match-result-rule', panel);
    const detail = el('div', 'vb-match-result-detail', panel, 'match-result-detail');
    const score = el('div', 'vb-match-result-score', panel, 'match-result-score');
    const countdown = el('div', 'vb-match-result-countdown', panel, 'match-result-countdown');

    this.dom = { root, scan, panel, eyebrow, title, rule, detail, score, countdown };
    this.hide();
    return this.dom;
  }

  update(match, selfRow, players, serverNow) {
    const winner = match?.winner;
    if (match?.phase !== 'post' || winner == null || winner === '') {
      this.hide();
      return null;
    }

    const mode = match.mode || 'fun';
    const teamMode = isTeamMode(mode);
    const selfId = selfRow?.id == null ? null : String(selfRow.id);
    const victory = teamMode
      ? !!selfRow?.team && String(selfRow.team) === String(winner)
      : selfId !== null && selfId === String(winner);
    const outcome = selfRow ? (victory ? 'victory' : 'defeat') : 'complete';
    const winnerName = teamMode
      ? upper(winner, 'TEAM')
      : this._nameFor(winner, players);

    this.dom.eyebrow.textContent = mode === 'snd' ? 'OPERATION COMPLETE' : 'MATCH COMPLETE';
    this.dom.title.textContent = outcome === 'victory'
      ? 'VICTORY'
      : (outcome === 'defeat' ? 'DEFEAT' : 'RESULT');
    this.dom.detail.textContent = teamMode
      ? `${winnerName} SECURED THE MATCH`
      : `${winnerName} COMPLETED THE ARSENAL`;
    this.dom.score.textContent = teamMode
      ? `${match?.scores?.alpha ?? 0}  —  ${match?.scores?.bravo ?? 0}`
      : 'GUN GAME WINNER';

    const now = Number.isFinite(serverNow) ? serverNow : Date.now();
    const remaining = Number.isFinite(match.phaseEndsAt)
      ? Math.max(0, (match.phaseEndsAt - now) / 1000)
      : null;
    this.dom.countdown.textContent = remaining === null
      ? 'NEXT MATCH STARTING'
      : `NEXT MATCH IN ${formatClock(remaining)}`;

    this.dom.root.className = `vb-match-result is-${outcome}`;
    this.dom.root.setAttribute('aria-hidden', 'false');
    return outcome;
  }

  hide() {
    const root = this.dom.root;
    if (!root || root.classList.contains('hidden')) return;
    root.className = 'vb-match-result hidden';
    root.setAttribute('aria-hidden', 'true');
  }

  dispose() {
    this.dom.root?.remove();
    this.dom = {};
  }

  _nameFor(id, players) {
    const row = (Array.isArray(players) ? players : [])
      .find((player) => String(player?.id) === String(id));
    return upper(row?.name || id, 'OPERATOR');
  }
}
