/**
 * Redrock Dam breach on the HUD (docs/conquest.md "Redrock Dam breach";
 * design docs/design/conquest/events/dam/). Reads the decoded `ev` row
 * (phase, team, leftMs and extra = [chargeMask] while armed, [chargeMask,
 * sinceDs] while the water runs) and the flood field the world FX built
 * (LOCAL_FLOOD 'dam', the same tables the server runs) for the basin's level
 * and the wave front; the banner words come from the definition
 * (shared/map-events/dam.js).
 *
 *   map     the crest middle in amber hazard stripes while the charges are
 *           armed and the siren runs; once breached the gap with break marks,
 *           the reservoir fading to dry lake bed as it drains, the canyon in
 *           flood blue down to the wave front (a white crest line)
 *   items   the event badge plus a beeping charge pip per planted charge for
 *           both sides (the planters guard it, the rivals defuse it)
 *   banner  once breached the countdown to the wave at the trestle (FLOOD AT
 *           TRESTLE n S) and the trestle named the last southern crossing
 *   marker  the world marker counts the fuse or the siren down; once breached
 *           it reads DAM · FLOOD while the wave runs, then DAM · BREACHED
 */
import { DAM_TUNING } from '../../../../../shared/map-events/dam.js';
import { LOCAL_FLOOD } from '../../../../../shared/world/flood-field.js';
import { canyonFloorHalf, riverCentreX, riverHalfAt } from '../../../../../shared/world/redrock-terrain.js';

export const DAM_COLORS = Object.freeze({
  hazard: '#ffb020', danger: '#ff4b4b', ink: '#14100a', mark: '#f4f1e8', bed: '#a77b52', flood: '#3f8fd0', foam: '#e8f6ff',
});

/** Where the HUD counts the wave to (the trestle's crossing), and the front's pace (m/s) while no field is built yet. */
export const DAM_HUD = Object.freeze({ trestleZ: 500, paceMps: 6.6 });

const LAKE = DAM_TUNING.flood.lake, CANYON = DAM_TUNING.flood.canyon;

/** The field the world FX built (null before it or in a test). */
const damField = () => LOCAL_FLOOD.get('dam')?.field ?? null;

/** Seconds until the wave reaches canyon row `z`, from `t` s after the breach. */
export function damArrivalIn(z, t) {
  const field = damField();
  const at = field ? field.arrival(Math.round(riverCentreX(z)), z) : Math.max(0, z - CANYON.z0) / DAM_HUD.paceMps;
  return Number.isFinite(at) ? Math.max(0, at - t) : null;
}

/** Read model of a decoded dam row: {phase, charges: [bool, bool], t s since the breach, drain 0..1, front z or 0, breached, armed}. */
export function damMapState(event) {
  if (!event || event.id !== 'dam') return null;
  const [mask = 0, sinceDs = 0] = Array.isArray(event.extra) ? event.extra : [];
  const phase = event.phase, breached = phase === 'active' || phase === 'done';
  const t = phase === 'done' ? Infinity : phase === 'active' ? Math.max(0, sinceDs / 10) : 0;
  const field = damField();
  // The basin: H(t) = sill + h0 / (1 + t / tau)^2 (the field's own lakeLevel when built).
  const level = field ? field.lakeLevel(t) : t === Infinity ? LAKE.sill : LAKE.sill + LAKE.h0 / (1 + t / LAKE.tauS) ** 2;
  const front = !breached ? 0 : phase === 'done' ? CANYON.z1
    : field ? field.front(t) : Math.min(CANYON.z1, CANYON.z0 + DAM_HUD.paceMps * t);
  return {
    phase, t, charges: DAM_TUNING.charges.map((_, i) => !!(mask & (1 << i))),
    drain: breached ? Math.max(0, Math.min(1, (LAKE.top - level) / LAKE.h0)) : 0, front: front | 0,
    breached, armed: phase === 'armed' || phase === 'warning',
  };
}

const STEP = 4;

/** The reservoir outline from the river's own shape (redrock-terrain.js), as one closed path. */
function lakePath(ctx, scale = 1) {
  const { z1 } = LAKE;
  const left = [], right = [];
  for (let z = 200; z <= z1 + 1; z += STEP) {
    const cx = riverCentreX(z), h = riverHalfAt(z) * scale;
    left.push([cx - h, z]); right.push([cx + h, z]);
  }
  ctx.beginPath();
  left.forEach(([x, z], i) => (i ? ctx.lineTo(x, z) : ctx.moveTo(x, z)));
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
}

/** The flooded canyon floor from the dam foot down to `zEnd`. */
function canyonPath(ctx, zEnd) {
  const z0 = CANYON.z0 - 2;
  if (zEnd <= z0) return false;
  const left = [], right = [];
  for (let z = z0; z <= zEnd; z += STEP) {
    const cx = riverCentreX(z);
    left.push([cx - canyonFloorHalf(z, -1) + 2, z]); right.push([cx + canyonFloorHalf(z, 1) - 2, z]);
  }
  ctx.beginPath();
  left.forEach(([x, z], i) => (i ? ctx.lineTo(x, z) : ctx.moveTo(x, z)));
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  return true;
}

function stripes(ctx, x0, z0, w, h, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath(); ctx.rect(x0, z0, w, h); ctx.clip();
  ctx.fillStyle = DAM_COLORS.ink; ctx.fillRect(x0, z0, w, h);
  ctx.strokeStyle = DAM_COLORS.hazard; ctx.lineWidth = Math.min(w, h) / 5;
  ctx.beginPath();
  for (let d = -h; d < w + h; d += Math.min(w, h) / 2.5) { ctx.moveTo(x0 + d, z0); ctx.lineTo(x0 + d - h, z0 + h); }
  ctx.stroke();
  ctx.restore();
}

/** World-space overlay (minimap and full map), under the markers. */
export function paintDam(ctx, event, { nowMs = 0, px = 1 } = {}) {
  const s = damMapState(event);
  if (!ctx || !s) return;
  const b = DAM_TUNING.breach;
  const x0 = b.x0, x1 = b.x1 + 1, z0 = b.z0, z1 = 390;
  const line = m => Math.max(m / Math.max(px, 1e-3), 0.25);
  if (s.armed) {
    const pulse = s.phase === 'warning' ? 0.55 + 0.45 * Math.abs(Math.sin(nowMs / 160)) : 0.5;
    // The siren: the flood path down the canyon floor in thin red hatching (where the bots clear out).
    if (s.phase === 'warning' && canyonPath(ctx, CANYON.z1)) {
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = DAM_COLORS.danger; ctx.lineWidth = line(1.2);
      ctx.beginPath();
      for (let d = CANYON.z0 - 120; d < CANYON.z1; d += 7) { ctx.moveTo(300, d); ctx.lineTo(468, d + 168); }
      ctx.stroke();
      ctx.restore();
    }
    stripes(ctx, x0, z0, x1 - x0, z1 - z0, pulse);
    ctx.strokeStyle = DAM_COLORS.hazard; ctx.lineWidth = line(2); ctx.strokeRect(x0, z0, x1 - x0, z1 - z0);
    return;
  }
  if (!s.breached) return;
  // The lake bed shows through as the water goes: the shallow shores dry
  // first, the pool shrinks into the old river bed (no grey blue-tan blend).
  if (s.drain > 0) {
    ctx.save();
    ctx.globalAlpha = 0.85 * Math.min(1, s.drain * 4); ctx.fillStyle = DAM_COLORS.bed; lakePath(ctx); ctx.fill();
    if (s.drain < 1) { ctx.globalAlpha = 0.9; ctx.fillStyle = DAM_COLORS.flood; lakePath(ctx, Math.max(0.12, 1 - s.drain)); ctx.fill(); }
    ctx.restore();
  }
  // The canyon in flood down to the front (all of it once the wave is out).
  const end = s.phase === 'done' ? CANYON.z1 : s.front;
  if (canyonPath(ctx, end)) {
    ctx.save(); ctx.globalAlpha = 0.62; ctx.fillStyle = DAM_COLORS.flood; ctx.fill(); ctx.restore();
  }
  if (s.phase === 'active' && s.front > CANYON.z0 && s.front < CANYON.z1) {
    const cx = riverCentreX(s.front), hw = canyonFloorHalf(s.front, 1) + 2;
    ctx.strokeStyle = DAM_COLORS.foam; ctx.lineWidth = line(2.4);
    ctx.beginPath(); ctx.moveTo(cx - hw, s.front); ctx.lineTo(cx + hw, s.front); ctx.stroke();
  }
  // The gap: open water through the crest, jagged break marks on both abutments.
  ctx.fillStyle = DAM_COLORS.flood; ctx.fillRect(x0 + 0.5, z0, x1 - x0 - 1, z1 - z0);
  ctx.strokeStyle = DAM_COLORS.mark; ctx.lineWidth = line(1.6); ctx.lineJoin = 'miter';
  const teeth = 4, step = (z1 - z0) / teeth, tooth = 2.2;
  for (const [edge, dir] of [[x0, 1], [x1, -1]]) {
    ctx.beginPath();
    for (let i = 0; i <= teeth; i++) {
      const x = edge + (i % 2 ? dir * tooth : 0), z = z0 + i * step;
      if (i) ctx.lineTo(x, z); else ctx.moveTo(x, z);
    }
    ctx.stroke();
  }
}

export const DAM_PRESENTER = Object.freeze({
  paintMap: paintDam,

  /** Breached: the countdown to the wave at the trestle, the trestle the last southern crossing. */
  banner(ev, ctx, base) {
    if (!base || ev?.phase !== 'active' || ev.note) return undefined;
    // The live phase change banners at the breach; a joiner's (from the snapshot) carries the seconds since.
    const t = ev.fromSnapshot && Array.isArray(ev.extra) ? Math.max(0, (ev.extra[1] ?? 0) / 10) : 0;
    const left = damArrivalIn(DAM_HUD.trestleZ, t);
    if (!(left > 1)) return { ...base, detail: 'LAST SOUTHERN CROSSING: TRESTLE' };
    const until = (ctx?.nowMs ?? 0) + left * 1000;
    return { ...base, detail: 'LAST SOUTHERN CROSSING: TRESTLE', holdMs: Math.max(base.holdMs ?? 0, Math.min(8000, left * 1000 + 400)),
      countdown: { until, total: Math.max(1, left * 1000), label: 'FLOOD AT TRESTLE' } };
  },

  /** The event badge, plus a charge pip per planted charge that both sides see. */
  mapItems(event, cq, selfTeam) {
    const s = damMapState(event);
    if (!s || s.phase === 'idle') return [];
    const a = event.anchor;
    const tone = s.armed ? 'hazard' : s.breached ? 'danger' : 'neutral';
    const items = [{ kind: 'event', id: 'dam', x: a.x, z: a.z, glyph: 'flood', label: 'DAM', phase: s.phase, tone, progress: event.progress,
      pulse: s.phase === 'warning' ? 1 : 0, faded: s.phase === 'done' }];
    if (s.phase === 'armed') {
      DAM_TUNING.charges.forEach((c, i) => {
        if (!s.charges[i]) return;
        items.push({ kind: 'event-point', id: `dam:charge:${c.id}`, x: c.x, z: c.z, glyph: 'charge', progress: 0,
          rel: event.team && selfTeam ? (event.team === selfTeam ? 'own' : 'enemy') : null });
      });
    }
    return items;
  },

  marker(model, event) {
    const s = damMapState(event);
    if (!s) return model;
    if (s.breached) return { ...model, name: s.phase === 'active' && s.front < CANYON.z1 ? 'DAM · FLOOD' : 'DAM · BREACHED' };
    if (s.phase === 'armed' && !Number.isFinite(event.leftMs)) return { ...model, name: `DAM · ${s.charges.filter(Boolean).length}/2 SET` };
    return model;
  },
});
