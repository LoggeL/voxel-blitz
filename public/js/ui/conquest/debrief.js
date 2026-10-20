/**
 * Conquest result debrief (design docs/design/conquest/ribbons/, result variant
 * A "three columns"): MVP per team and the top squad, the local player's score
 * by category, ribbons, medals and career XP with the level bar. Every value is
 * read from the post-match results rows (score, squad, `cqr`, `cqm`, `cqp`,
 * `cxp`, see decodeConquestResult); sums and shares are the only arithmetic.
 */
import { MEDALS, RIBBONS, RIBBON_IDS, SCORE_CATEGORY_IDS, TEAM_DISPLAY, decodeConquestResult } from '../../../../shared/conquest-contract.js';
import { careerLevel, careerLevelXp } from '../../../../shared/career.js';
import { el } from '../hud-support.js';
import { relativeTeam, squadName } from './scoring.js';
import { medalBadge, ribbonBar } from './ribbons.js';

export const SCORE_CATEGORY_LABELS = Object.freeze({ combat: 'COMBAT', objective: 'OBJECTIVE', vehicles: 'VEHICLES', support: 'SUPPORT', ribbons: 'RIBBONS' });
const TEAMS = ['alpha', 'bravo'];
/** Ribbons of one kind a medal asks for (MEDALS), for the empty medal line. */
const MEDAL_RIBBON_COUNT = Math.min(...Object.values(MEDALS).filter(m => m.ribbon).map(m => m.count));
const fmt = n => Math.round(n).toLocaleString('en-US');
const nameOf = row => String(row?.name || row?.id || 'OPERATOR');
const score = row => Math.max(0, row?.score | 0);
const teamRows = rows => (Array.isArray(rows) ? rows : []).filter(r => r && !r.npcRole && TEAMS.includes(r.team));
/** Higher score first; equal scores in id order, so every client picks the same row. */
const byScore = (a, b) => score(b) - score(a) || (String(a.id) < String(b.id) ? -1 : 1);

/** Top scorer of each team ({team, id, name, score}); a team without points has no MVP. */
export function conquestTeamMvps(results) {
  const rows = teamRows(results);
  return TEAMS.map(team => {
    const best = rows.filter(r => r.team === team && score(r) > 0).sort(byScore)[0];
    return best ? { team, id: String(best.id), name: nameOf(best), score: score(best) } : null;
  }).filter(Boolean);
}

/** The squad with the highest summed score over both teams, members by score. */
export function conquestTopSquad(results) {
  const squads = new Map();
  for (const row of teamRows(results)) {
    const squad = row.squad | 0;
    if (squad <= 0) continue;
    const key = `${row.team}:${squad}`;
    const entry = squads.get(key) || { team: row.team, squad, score: 0, members: [] };
    entry.score += score(row);
    entry.members.push(row);
    squads.set(key, entry);
  }
  const best = [...squads.values()].filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.team < b.team ? -1 : a.team > b.team ? 1 : a.squad - b.squad))[0];
  if (!best) return null;
  return { team: best.team, squad: best.squad, name: `${squadName(best.squad)} SQUAD`, score: best.score,
    members: best.members.sort(byScore).map(r => ({ id: String(r.id), name: nameOf(r), score: score(r) })) };
}

/** Level bar from `cxp`: XP before this match, after it, and the level span the bar shows. */
export function careerProgressModel(career) {
  if (!career || !Number.isFinite(career.xp)) return null;
  const xp = Math.max(0, career.xp), gained = Math.min(xp, Math.max(0, career.gained | 0));
  const before = xp - gained;
  const level = careerLevel(xp), startLevel = careerLevel(before);
  const levelStart = careerLevelXp(level), nextLevel = careerLevelXp(level + 1);
  const span = Math.max(1, nextLevel - levelStart);
  // A level-up starts the bar at the new level's floor: all of it is this match's XP.
  const from = level > startLevel ? 0 : (before - levelStart) / span;
  return { xp, gained, before, level, startLevel, levelUp: level > startLevel, levelStart, nextLevel,
    from: Math.max(0, Math.min(1, from)), to: Math.max(0, Math.min(1, (xp - levelStart) / span)) };
}

/** The local player's debrief from its results row, or null without one. */
export function conquestPersonalSummary(row) {
  if (!row) return null;
  const decoded = decodeConquestResult(row);
  const categories = SCORE_CATEGORY_IDS.map(id => ({ id, label: SCORE_CATEGORY_LABELS[id] ?? id.toUpperCase(), pts: decoded.categories[id] }));
  const top = Math.max(1, ...categories.map(c => c.pts));
  for (const c of categories) c.share = c.pts / top;
  return {
    total: score(row), categories,
    ribbons: RIBBON_IDS.map(id => ({ id, label: RIBBONS[id].label.replace(/ RIBBON$/, ''), count: decoded.ribbons[id] })),
    ribbonCount: RIBBON_IDS.reduce((sum, id) => sum + decoded.ribbons[id], 0),
    medals: decoded.medals.map(id => ({ id, label: MEDALS[id].label })),
    career: careerProgressModel(decoded.career),
  };
}

/** The debrief band of the result screen; `update` re-renders only when the rows change. */
export class ConquestDebrief {
  constructor(parent) {
    this.root = el('div', 'vb-result-debrief', parent);
    this.root.hidden = true;
    const doc = this.root.ownerDocument ?? globalThis.document;
    this.doc = doc;
    const panel = (cls, title) => {
      const node = el('section', `vb-debrief-panel ${cls}`, this.root);
      el('h3', 'vb-debrief-title', node).textContent = title;
      return node;
    };
    this.mvp = panel('vb-debrief-mvp', 'MVP');
    this.mvpCards = el('div', 'vb-debrief-mvp-cards', this.mvp);
    this.squad = el('div', 'vb-debrief-squad', this.mvp);
    this.you = panel('vb-debrief-you', 'YOUR MATCH');
    this.bars = el('div', 'vb-debrief-bars', this.you);
    this.total = el('div', 'vb-debrief-total', this.you);
    this.awards = panel('vb-debrief-awards', 'RIBBONS & MEDALS');
    this.ribbons = el('div', 'vb-debrief-ribbons', this.awards);
    this.medals = el('div', 'vb-debrief-medals', this.awards);
    this.career = el('div', 'vb-debrief-career', this.awards);
    this._sig = '';
  }

  update(results, selfId, selfTeam) {
    const rows = teamRows(results);
    const self = selfId == null ? null : rows.find(r => String(r.id) === String(selfId)) ?? null;
    const sig = JSON.stringify([selfId, selfTeam, rows.map(r => [r.id, r.name, r.team, r.score, r.squad, r.cqr, r.cqm, r.cqp, r.cxp])]);
    this.root.hidden = rows.length === 0;
    if (sig === this._sig) return;
    this._sig = sig;
    this._renderMvp(rows, selfTeam);
    this._renderSelf(conquestPersonalSummary(self));
  }

  _renderMvp(rows, selfTeam) {
    this.mvpCards.textContent = '';
    const mvps = conquestTeamMvps(rows);
    for (const team of TEAMS) {
      const mvp = mvps.find(m => m.team === team);
      const card = el('div', 'vb-debrief-mvp-card', this.mvpCards);
      card.dataset.rel = relativeTeam(team, selfTeam);
      el('span', 'vb-debrief-eyebrow', card).textContent = `${TEAM_DISPLAY[team]} MVP`;
      el('strong', 'vb-debrief-name', card).textContent = mvp ? mvp.name : '—';
      el('span', 'vb-debrief-value', card).textContent = mvp ? `${fmt(mvp.score)} PTS` : 'NO SCORE';
    }
    this.squad.textContent = '';
    const top = conquestTopSquad(rows);
    this.squad.hidden = !top;
    if (!top) return;
    this.squad.dataset.rel = relativeTeam(top.team, selfTeam);
    const head = el('div', 'vb-debrief-squad-head', this.squad);
    el('span', 'vb-debrief-eyebrow', head).textContent = `TOP SQUAD · ${TEAM_DISPLAY[top.team]}`;
    el('strong', 'vb-debrief-name', head).textContent = top.name;
    el('span', 'vb-debrief-value', head).textContent = `${fmt(top.score)} PTS`;
    const list = el('ol', 'vb-debrief-squad-list', this.squad);
    for (const member of top.members) {
      const item = el('li', '', list);
      el('span', '', item).textContent = member.name;
      el('b', '', item).textContent = fmt(member.score);
    }
  }

  _renderSelf(summary) {
    this.you.hidden = !summary;
    this.awards.hidden = !summary;
    this.bars.textContent = '';
    this.total.textContent = '';
    this.ribbons.textContent = '';
    this.medals.textContent = '';
    this.career.textContent = '';
    if (!summary) return;
    for (const c of summary.categories) {
      const row = el('div', 'vb-debrief-bar', this.bars);
      row.dataset.category = c.id;
      el('span', 'vb-debrief-bar-label', row).textContent = c.label;
      const track = el('span', 'vb-debrief-bar-track', row);
      el('i', '', track).style.setProperty('--share', `${(c.share * 100).toFixed(1)}%`);
      el('b', 'vb-debrief-bar-value', row).textContent = fmt(c.pts);
    }
    el('span', '', this.total).textContent = 'TOTAL';
    el('b', '', this.total).textContent = `${fmt(summary.total)} PTS`;
    for (const r of summary.ribbons) {
      const cell = el('div', 'vb-debrief-ribbon', this.ribbons);
      cell.dataset.earned = String(r.count > 0);
      cell.title = `${RIBBONS[r.id].label} · ${RIBBONS[r.id].detail}`;
      ribbonBar(this.doc, cell, r.id, { earned: r.count > 0 });
      el('span', 'vb-debrief-ribbon-label', cell).textContent = r.label;
      el('b', 'vb-debrief-ribbon-count', cell).textContent = r.count > 0 ? `×${r.count}` : '';
    }
    if (summary.medals.length) {
      for (const m of summary.medals) {
        const cell = el('div', 'vb-debrief-medal', this.medals);
        medalBadge(this.doc, cell, m.id);
        el('span', '', cell).textContent = m.label;
      }
    } else el('span', 'vb-debrief-empty', this.medals).textContent = `NO MEDALS · ${MEDAL_RIBBON_COUNT} OF ONE RIBBON EARN ITS MEDAL`;
    const career = summary.career;
    this.career.dataset.state = career ? (career.levelUp ? 'level-up' : 'progress') : 'guest';
    if (!career) {
      el('span', 'vb-debrief-empty', this.career).textContent = 'SIGN IN TO EARN CAREER XP';
      return;
    }
    const head = el('div', 'vb-debrief-career-head', this.career);
    el('span', 'vb-debrief-eyebrow', head).textContent = career.levelUp ? `LEVEL UP · LV ${career.startLevel} → LV ${career.level}` : 'CAREER PROGRESSION';
    const levels = el('div', 'vb-debrief-career-levels', this.career);
    el('b', '', levels).textContent = `LV ${career.level}`;
    const meter = el('span', 'vb-debrief-xp', levels);
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-valuemin', String(career.levelStart));
    meter.setAttribute('aria-valuemax', String(career.nextLevel));
    meter.setAttribute('aria-valuenow', String(career.xp));
    meter.style.setProperty('--from', `${(career.from * 100).toFixed(1)}%`);
    meter.style.setProperty('--to', `${(career.to * 100).toFixed(1)}%`);
    el('i', 'vb-debrief-xp-before', meter);
    el('i', 'vb-debrief-xp-gained', meter);
    el('b', '', levels).textContent = `LV ${career.level + 1}`;
    el('div', 'vb-debrief-xp-text', this.career).textContent = `+${fmt(career.gained)} XP · ${fmt(career.xp)} / ${fmt(career.nextLevel)} XP`;
  }
}
