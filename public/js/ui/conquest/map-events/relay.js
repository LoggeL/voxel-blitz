/**
 * Signal Rock relay on the HUD (docs/conquest.md "Signal Rock relay"; design
 * docs/design/conquest/events/relay/). Reads only the decoded `ev` row (phase,
 * owner `team`, `leftMs` to the next scan, mast damage as `progress`) and the
 * server's `map_event` notes (`scan`, `planted`, `damaged`).
 *
 *   map badge   the relay hexagon at the bunker in the owner's colour (red
 *               once the mast is down), its arc the scan charge for the
 *               owner's side; none while the mast groans; while held, the
 *               scan circle (180 m round the mast, dashed) and, for 1.5 s
 *               after each scan, a ring sweeping out to it; while the mast
 *               groans, its fall line north across the road in hazard stripes,
 *               and the wreck line once down
 *   marker      RELAY · SCAN 12 S for the owner, RELAY for the rival, MAST ·
 *               3 S while it groans
 *   banners     RELAY SECURED / RELAY LOST from the definition, plus the
 *               notes: SCAN · 3 ENEMIES MARKED (owner) / ENEMY RELAY SCAN ·
 *               2 MARKED (rival), CHARGE PLANTED with its fuse, MAST DAMAGED
 */
import { RELAY_EVENT, RELAY_SITE, relayCrushLine, relayHeld, relayScanSeconds } from '../../../../../shared/map-events/relay.js';

const T = RELAY_EVENT.tuning;
const COLORS = Object.freeze({ own: '#4cc3ff', enemy: '#ff8a3d', hazard: '#ffb020', danger: '#ff4b4b', neutral: '#d8d8d8', wreck: '#c9c2b4' });
/** A scan's ring sweeps out over this long after it fires (presentation only). */
const SWEEP_MS = 1500;
/**
 * The viewer's team as the last map-item pass saw it: paintMap gets no team,
 * and mapItems runs every frame before the minimap and the full map paint.
 */
const viewer = { team: null };

const sideOf = (team, selfTeam) => (team && selfTeam ? (team === selfTeam ? 'own' : 'enemy') : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function noteBanner(ev, { nowMs, selfTeam }) {
  const name = RELAY_EVENT.name, d = ev.data ?? {};
  if (ev.note === 'scan') {
    const n = d.n | 0, side = sideOf(d.team, selfTeam);
    if (!n || !side) return null;
    return side === 'own'
      ? { key: 'event:relay:scan', tone: 'own', icon: 'event-relay', title: `${name} · SCAN`, detail: `${plural(n, 'ENEMY', 'ENEMIES')} MARKED`, priority: 2, holdMs: 2200, event: 'relay' }
      : { key: 'event:relay:scan', tone: 'enemy', icon: 'event-relay', title: 'ENEMY RELAY SCAN', detail: `${n} OF YOUR SIDE MARKED NEAR SIGNAL ROCK`, priority: 2, holdMs: 2200, event: 'relay' };
  }
  if (ev.note === 'planted') {
    const fuse = Number(d.fuseMs) || T.charge.fuseMs, own = sideOf(d.team, selfTeam) === 'own';
    return { key: 'event:relay:planted', tone: 'hazard', icon: 'charge', title: `${name} · ${own ? 'CHARGE PLANTED' : 'CHARGE ON THE MAST'}`,
      detail: own ? 'CLEAR THE MAST' : 'GET OFF THE MAST FOOT', priority: 6, holdMs: fuse + 400, event: 'relay',
      countdown: { until: nowMs + fuse, total: fuse, label: 'BLOWS IN' } };
  }
  if (ev.note === 'damaged') {
    return { key: 'event:relay:damaged', tone: 'hazard', icon: 'event-relay', title: `${name} · MAST DAMAGED`,
      detail: `FEET AT ${Math.max(0, d.share | 0)} %`, priority: 4, holdMs: 3000, event: 'relay' };
  }
  return null;
}

export const RELAY_PRESENTER = Object.freeze({
  banner(ev, ctx, base) {
    if (ev.note) return noteBanner(ev, ctx);
    // The step into the director (a held relay's last blow) is followed by the groan in the same tick.
    if (ev.phase === 'armed' && ev.reason === 'mast') return null;
    if (ev.phase === 'done' && base) return { ...base, tone: 'danger' };
    return undefined;
  },

  mapItems(event, cq, selfTeam) {
    viewer.team = selfTeam ?? null;
    // While the mast groans the minimap shows only its fall line: the badge would cover it at that scale.
    if (event.phase === 'idle' || event.phase === 'warning' || event.phase === 'armed') return [];
    const held = relayHeld(event), side = sideOf(event.team, selfTeam);
    const tone = held ? side ?? 'neutral' : 'danger';
    const scan = held && side === 'own' && Number.isFinite(event.leftMs) ? 1 - Math.min(1, event.leftMs / T.scan.everyMs) : 0;
    return [{ kind: 'event', id: 'relay', x: RELAY_SITE.bunker.x, z: RELAY_SITE.bunker.z, glyph: 'event-relay', label: 'RELAY', phase: event.phase,
      tone, progress: scan, pulse: 0, faded: event.phase === 'done' }];
  },

  paintMap(ctx, event, { nowMs = 0, px = 1 } = {}) {
    const unit = 1 / Math.max(1e-6, px);  // canvas px -> metres: strokes keep their screen width at every zoom
    const c = RELAY_SITE.mastCentre;
    if (relayHeld(event)) {
      const color = COLORS[sideOf(event.team, viewer.team) ?? 'neutral'];
      ctx.beginPath(); ctx.arc(c.x, c.z, T.scan.radiusM, 0, Math.PI * 2);
      ctx.fillStyle = `${color}0f`; ctx.fill();
      ctx.setLineDash([5 * unit, 4 * unit]); ctx.lineWidth = 1.2 * unit; ctx.strokeStyle = `${color}8c`; ctx.stroke(); ctx.setLineDash([]);
      const age = Number.isFinite(event.leftMs) ? T.scan.everyMs - event.leftMs : Infinity;
      if (age >= 0 && age < SWEEP_MS) {
        const k = age / SWEEP_MS;
        ctx.beginPath(); ctx.arc(c.x, c.z, Math.max(1, T.scan.radiusM * k), 0, Math.PI * 2);
        ctx.globalAlpha = 1 - k; ctx.lineWidth = 3 * unit; ctx.strokeStyle = color; ctx.stroke(); ctx.globalAlpha = 1;
      }
      return;
    }
    if (event.phase !== 'warning' && event.phase !== 'armed' && event.phase !== 'done') return;
    // At least 6 screen px wide, so the line reads on the minimap's 170 m range too.
    const line = relayCrushLine(T.fall), w = Math.max(line.w * 2, 6 * unit);
    ctx.translate(line.ax - w / 2, line.bz);
    const len = line.az - line.bz;
    if (event.phase === 'done') {
      ctx.fillStyle = `${COLORS.wreck}b3`; ctx.fillRect(w / 2 - Math.max(1.5, 1.5 * unit), 0, Math.max(3, 3 * unit), len);
      return;
    }
    // The fall line, pulsing hazard stripes.
    ctx.globalAlpha = 0.55 + 0.35 * (Math.sin(nowMs / 160) + 1) / 2;
    ctx.beginPath(); ctx.rect(0, 0, w, len); ctx.save(); ctx.clip();
    ctx.fillStyle = '#14100acc'; ctx.fillRect(0, 0, w, len);
    ctx.fillStyle = COLORS.hazard;
    const period = Math.max(4, 5 * unit), half = period / 2;
    for (let s = -w; s < len + w; s += period) { ctx.beginPath(); ctx.moveTo(0, s); ctx.lineTo(w, s - w); ctx.lineTo(w, s - w + half); ctx.lineTo(0, s + half); ctx.fill(); }
    ctx.restore();
    ctx.lineWidth = 1.2 * unit; ctx.strokeStyle = COLORS.hazard; ctx.strokeRect(0, 0, w, len);
  },

  marker(model, event, ctx) {
    if (relayHeld(event)) {
      const s = relayScanSeconds(event);
      return { ...model, name: sideOf(event.team, ctx?.selfTeam) === 'own' && s != null ? `RELAY · SCAN ${s} S` : 'RELAY' };
    }
    if (event.phase === 'warning' && Number.isFinite(event.leftMs)) return { ...model, name: `MAST · ${Math.ceil(event.leftMs / 1000)} S` };
    return model;
  },
});
