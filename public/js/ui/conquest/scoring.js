/**
 * Light Conquest scoring read model for the scoreboard and the result
 * overlay: team-relative naming, per-player columns from cq / cqs, MVPs and
 * the ticket graph. It imports only the frozen contract, so the menu-path
 * modules that use it (scoreboard, result overlay) stay off the vehicle and
 * world registries.
 */
import { CONQUEST_RULES, TEAM_DISPLAY, decodeConquestPlayer, decodeConquestStats } from '../../../../shared/conquest-contract.js';

/** 'own' | 'enemy' | 'neutral' of a team id relative to the local team. */
export function relativeTeam(team, selfTeam) {
  if (team !== 'alpha' && team !== 'bravo') return 'neutral';
  if (selfTeam !== 'alpha' && selfTeam !== 'bravo') return team === 'alpha' ? 'own' : 'enemy';
  return team === selfTeam ? 'own' : 'enemy';
}
export const teamDisplayName = team => TEAM_DISPLAY[team] ?? 'NEUTRAL';

const SQUAD_NAMES = Object.freeze(['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL']);
/** Squad display name (squad ids are 1-based per team). */
export const squadName = id => SQUAD_NAMES[(id | 0) - 1] || String(id | 0);

/** Per-player Conquest columns from the row: score, K, D, objective, vehicles, revives, squad. */
export function scoreboardRow(player) {
  const stats = decodeConquestStats(player);
  const info = decodeConquestPlayer(player);
  return { score: player?.score | 0, kills: player?.kills | 0, deaths: player?.deaths | 0, objective: stats.objective,
    vehicles: stats.vehicles, revives: stats.revives, captures: stats.captures,
    squad: (info ? info.squad : player?.squad) | 0, kit: info?.kit ?? (typeof player?.kit === 'string' ? player.kit : null) };
}

/** MVP per category from final rows; ties go to the higher score, then id order. */
export function conquestMvps(players = []) {
  const rows = (players || []).filter(p => p && (p.team === 'alpha' || p.team === 'bravo')).map(p => ({ player: p, ...scoreboardRow(p) }));
  const categories = [
    ['score', 'MVP', r => r.score], ['kills', 'TOP GUN', r => r.kills], ['objective', 'OBJECTIVE', r => r.objective],
    ['vehicles', 'TANK BUSTER', r => r.vehicles], ['revives', 'MEDIC', r => r.revives],
  ];
  return categories.map(([key, title, value]) => {
    let best = null;
    for (const r of rows) {
      const v = value(r);
      if (!(v > 0)) continue;
      if (!best || v > best.value || (v === best.value && (r.score > best.row.score || (r.score === best.row.score && String(r.player.id) < String(best.row.player.id))))) best = { row: r, value: v };
    }
    return best ? { key, title, id: String(best.row.player.id), name: String(best.row.player.name || best.row.player.id), team: best.row.player.team, value: best.value } : null;
  }).filter(Boolean);
}

/** Ticket graph polylines from results.conquest.ticketGraph ([[tMs, alpha, bravo], ...]). */
export function ticketGraphModel(graph, { width = 320, height = 90, maxTickets = CONQUEST_RULES.tickets } = {}) {
  const points = (Array.isArray(graph) ? graph : []).filter(p => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite));
  if (points.length < 2) return null;
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const span = Math.max(1, t1 - t0);
  const top = Math.max(maxTickets, ...points.map(p => Math.max(p[1], p[2])));
  const line = index => points.map(p => `${((p[0] - t0) / span * width).toFixed(1)},${(height - p[index] / top * height).toFixed(1)}`).join(' ');
  return { alpha: line(1), bravo: line(2), durationMs: span, final: { alpha: points.at(-1)[1], bravo: points.at(-1)[2] }, width, height };
}
