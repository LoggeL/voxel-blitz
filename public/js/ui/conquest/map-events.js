/**
 * Conquest map events on the HUD (docs/conquest.md "Map events"; design
 * docs/design/conquest/events/framework/, variant A). Everything here reads
 * the authoritative event state (`match.conquest.ev` / `evp` decoded into
 * cq.mapEvents) or a server `map_event` event; nothing is predicted.
 *
 *   banner   the objective banner with the event's glyph badge at its left:
 *            "REDROCK DAM · CHARGES ARMED", "BREACH IN 12 S · 240 M NE" and
 *            a draining countdown bar through a timed phase; a player who
 *            joins mid-event gets the same banner from the snapshot
 *   maps     a hexagon badge with the glyph at the event's anchor (pulsing
 *            while it warns, its progress as an arc), a small disc per usable
 *            interaction point; presenters paint their own world overlays
 *   world    the hexagon marker with the short name, distance and countdown
 *            (edge-clamped), and the point markers within reach
 *   prompt   HOLD <VERB> on the interact ring through interactModel (the
 *            `use` support intent, conquest-hud-state.js)
 *
 * Per-event wording and art come from the definition (name, short, glyph,
 * texts); a presenter (./map-events/registry.js) overrides any part.
 */
import {
  MAP_EVENT_DEFS, MAP_EVENT_KIND, mapEventDef, mapEventGlyph,
} from '../../../../shared/conquest-map-events.js';
import { drawIcon } from './icons.js';
import { clampToEdge } from './projection.js';
import { MAP_EVENT_PRESENTERS } from './map-events/registry.js';

export const MAP_EVENT_COLORS = Object.freeze({
  hazard: '#ffb020', danger: '#ff4b4b', own: '#4cc3ff', enemy: '#ff8a3d', neutral: '#d8d8d8', ink: '#14100a',
});
/** Phase words after the event name when its definition has no text for the phase. */
export const MAP_EVENT_PHASE_TITLES = Object.freeze({ armed: 'ARMED', warning: 'IMMINENT', active: 'UNDER WAY', done: 'OVER', cooldown: 'STANDING DOWN' });
const PRIORITY = Object.freeze({ armed: 5, warning: 7, active: 8, done: 4, cooldown: 2 });
const HOLD_MS = Object.freeze({ armed: 3200, warning: 3600, active: 4200, done: 3200, cooldown: 2400 });
/** A timed banner holds through its countdown, at most this long (the world marker keeps counting). */
export const MAP_EVENT_BANNER_MAX_HOLD_MS = 15000;
/** Point markers show within this many metres; usable points also on the maps. */
export const MAP_EVENT_POINT_MARKER_M = 60;
/** Phases that open a banner from the snapshot for a player who missed the event. */
const STATE_BANNER_PHASES = new Set(['armed', 'warning', 'active']);
const LIVE_PHASES = new Set(['armed', 'warning', 'active']);

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** 8-point compass bearing from `from` to `to` (north is -z, east +x, as the minimap's rim letters). */
export function compassBearing(from, to) {
  const angle = Math.atan2(to.x - from.x, -(to.z - from.z));
  return COMPASS[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
}

/** "240 M NE" from a viewer to a point, or ''. */
export function whereText(from, to) {
  if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(to.x)) return '';
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  return d < 8 ? 'HERE' : `${Math.round(d)} M ${compassBearing(from, to)}`;
}

export const mapEventPresenter = (id, presenters = MAP_EVENT_PRESENTERS) => presenters?.[id] ?? null;

/** Side of the event relative to the viewer: 'own' | 'enemy' | null. */
const sideOf = (team, selfTeam) => (team && selfTeam ? (team === selfTeam ? 'own' : 'enemy') : null);

/**
 * Banner tone of an event phase: amber while it is armed or warns, red once
 * a levolution or a call-in strikes, team-relative for a control or supply
 * event that a side holds.
 */
export function mapEventTone(def, phase, team, selfTeam) {
  if (phase === 'armed' || phase === 'warning') return 'hazard';
  const side = sideOf(team, selfTeam);
  if (phase === 'active') {
    if (def?.kind === 'control' || def?.kind === 'supply') return side ?? 'hazard';
    return 'danger';
  }
  return side ?? 'neutral';
}

/** The definition's texts of a phase change: `texts['<phase>:<reason>']` first, then `texts[phase]`, or null. */
export const mapEventTexts = (def, phase, reason = null) => (reason ? def?.texts?.[`${phase}:${reason}`] : null) ?? def?.texts?.[phase] ?? null;

/** {title, detail, countdown} of a phase from the definition's texts (team variants applied). */
export function mapEventText(def, phase, team, selfTeam, reason = null) {
  const t = mapEventTexts(def, phase, reason) ?? {};
  const side = sideOf(team, selfTeam);
  const v = side ? t[side] ?? {} : {};
  return { title: v.title ?? t.title ?? MAP_EVENT_PHASE_TITLES[phase] ?? String(phase || '').toUpperCase(),
    detail: v.detail ?? t.detail ?? '', countdown: t.countdown ?? null };
}

/**
 * Banner for a `map_event` event (or the snapshot's pseudo event), or null.
 * `ctx`: {nowMs, selfTeam, selfId, defs, presenters, where: () => '240 M NE'}.
 * Each phase supersedes the event's earlier banners, so a queued
 * "charges armed" never shows after "breach".
 */
export function mapEventBanner(ev, { nowMs = 0, selfTeam = null, selfId = null, defs = MAP_EVENT_DEFS, presenters = MAP_EVENT_PRESENTERS, where = null } = {}) {
  if (ev?.kind !== MAP_EVENT_KIND || typeof ev.event !== 'string') return null;
  const def = mapEventDef(ev.event, defs);
  if (!def) return null;
  const presenter = mapEventPresenter(def.id, presenters);
  let base = null;
  // A phase change banners; `idle` (called off, defused) only when the definition words it.
  if (!ev.note && ev.phase && (ev.phase !== 'idle' || mapEventTexts(def, 'idle', ev.reason))) {
    const text = mapEventText(def, ev.phase, ev.team ?? null, selfTeam, ev.reason ?? null);
    const timed = Number.isFinite(ev.endsAt) && ev.endsAt > nowMs && (ev.phase === 'armed' || ev.phase === 'warning' || !!text.countdown);
    const total = def.durations?.[`${ev.phase}Ms`] ?? (timed ? ev.endsAt - nowMs : null);
    // A later phase drops the event's earlier banners still queued (a called-off event its armed / warning ones).
    const at = ev.phase === 'idle' ? 2 : ['armed', 'warning', 'active', 'done', 'cooldown'].indexOf(ev.phase);
    const prior = ['armed', 'warning', 'active'].slice(0, Math.max(0, at));
    base = {
      key: `event:${def.id}:${ev.phase}${ev.reason ? `:${ev.reason}` : ''}`, tone: mapEventTone(def, ev.phase, ev.team ?? null, selfTeam), icon: mapEventGlyph(def),
      title: `${def.name} · ${text.title}`, detail: text.detail, priority: PRIORITY[ev.phase] ?? 3, event: def.id,
      holdMs: timed ? Math.min(MAP_EVENT_BANNER_MAX_HOLD_MS, Math.max(1200, ev.endsAt - nowMs + 400)) : HOLD_MS[ev.phase] ?? 3000,
      ...(timed ? { countdown: { until: ev.endsAt, total: Math.max(1, total ?? ev.endsAt - nowMs), ...(text.countdown ? { label: text.countdown } : {}) } } : {}),
      ...(prior.length ? { supersedes: prior.map(p => `event:${def.id}:${p}`) } : {}),
      ...(typeof where === 'function' && LIVE_PHASES.has(ev.phase) ? { where } : {}),
    };
  }
  if (typeof presenter?.banner === 'function') {
    const out = presenter.banner(ev, { nowMs, selfTeam, selfId, def, where }, base);
    if (out !== undefined) return out;
  }
  return base;
}

/**
 * Phase changes seen in the snapshot: `seen` (event id -> phase) is the
 * HUD's memory of what it has shown, from events and snapshots alike.
 * Returns {seen, fresh}: `fresh` lists pseudo `map_event` events for the
 * phases worth a banner the viewer has not had (a joiner mid-event).
 */
export function syncMapEventPhases(cq, seen = new Map(), nowMs = 0) {
  const next = new Map();
  const fresh = [];
  for (const e of cq?.mapEvents?.events ?? []) {
    next.set(e.id, e.phase);
    if (seen.get(e.id) === e.phase || !STATE_BANNER_PHASES.has(e.phase)) continue;
    fresh.push({ kind: MAP_EVENT_KIND, event: e.id, phase: e.phase, ...(e.team ? { team: e.team } : {}),
      ...(Number.isFinite(e.leftMs) ? { endsAt: nowMs + e.leftMs } : {}), fromSnapshot: true });
  }
  return { seen: next, fresh };
}

/** The marker point of a decoded event: its anchor, with a height from its flag when the anchor has none. */
export function mapEventPoint(event, cq) {
  const a = event?.anchor;
  if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.z)) return null;
  if (Number.isFinite(a.y)) return a;
  const flag = event.def?.flag ? (cq?.flags ?? []).find(f => f.id === event.def.flag) : null;
  return { x: a.x, y: Number.isFinite(flag?.y) ? flag.y : null, z: a.z };
}

/**
 * Map items (minimap and full map): kind 'event' badges for the events on
 * the wire (not idle), kind 'event-point' for interaction points the
 * viewer's team may use. `nowMs` drives the warning pulse.
 */
export function mapEventMapItems(cq, selfTeam, { nowMs = 0, presenters = MAP_EVENT_PRESENTERS } = {}) {
  const out = [];
  const events = cq?.mapEvents?.events ?? [];
  for (const e of events) {
    const presenter = mapEventPresenter(e.id, presenters);
    if (typeof presenter?.mapItems === 'function') { out.push(...(presenter.mapItems(e, cq, selfTeam) ?? [])); continue; }
    const p = mapEventPoint(e, cq);
    if (!p || e.phase === 'idle') continue;
    const tone = mapEventTone(e.def, e.phase, e.team, selfTeam);
    out.push({ kind: 'event', id: e.id, x: p.x, z: p.z, glyph: mapEventGlyph(e.def), label: e.def.short, phase: e.phase, tone,
      progress: e.progress, pulse: e.phase === 'warning' ? (Math.sin(nowMs / 160) + 1) / 2 : 0, faded: e.phase === 'done' || e.phase === 'cooldown' });
  }
  for (const pt of cq?.mapEvents?.points ?? []) {
    if (!selfTeam || !pt.teams.includes(selfTeam)) continue;
    out.push({ kind: 'event-point', id: `${pt.event}:${pt.index}`, x: pt.x, z: pt.z, glyph: pt.glyph, progress: pt.progress,
      rel: pt.userTeam ? (pt.userTeam === selfTeam ? 'own' : 'enemy') : null });
  }
  return out;
}

const TONE_COLORS = Object.freeze({ hazard: MAP_EVENT_COLORS.hazard, danger: MAP_EVENT_COLORS.danger, own: MAP_EVENT_COLORS.own,
  enemy: MAP_EVENT_COLORS.enemy, neutral: MAP_EVENT_COLORS.neutral });
export const mapEventToneColor = tone => TONE_COLORS[tone] ?? MAP_EVENT_COLORS.hazard;

function hexPath(ctx, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 3;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

/**
 * Paint one map event item at the context origin (map-painter.js paintUnit
 * translates there first). `size` is the painter's unit scale.
 */
export function paintMapEventUnit(ctx, item, size = 1) {
  if (!ctx || !item) return;
  if (item.kind === 'event') {
    const color = mapEventToneColor(item.tone);
    const r = 9 * size;
    if (item.faded) ctx.globalAlpha = 0.6;
    if (item.pulse > 0) {
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.45 * item.pulse;
      hexPath(ctx, r + (3 + 3 * item.pulse) * size);
      ctx.lineWidth = 1.5 * size; ctx.strokeStyle = color; ctx.stroke();
      ctx.restore();
    }
    hexPath(ctx, r);
    ctx.fillStyle = '#14100ae6'; ctx.fill();
    ctx.lineWidth = 1.8 * size; ctx.strokeStyle = color; ctx.stroke();
    drawIcon(ctx, item.glyph || 'event', 0, 0, 11 * size, color);
    if (item.progress > 0 && item.progress < 0.999) {
      ctx.beginPath();
      ctx.arc(0, 0, r + 2.5 * size, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * item.progress);
      ctx.lineWidth = 2 * size; ctx.strokeStyle = color; ctx.stroke();
    }
    return;
  }
  if (item.kind === 'event-point') {
    const color = item.rel === 'enemy' ? MAP_EVENT_COLORS.enemy : item.rel === 'own' ? MAP_EVENT_COLORS.own : MAP_EVENT_COLORS.hazard;
    ctx.beginPath(); ctx.arc(0, 0, 5.5 * size, 0, Math.PI * 2);
    ctx.fillStyle = '#14100ae6'; ctx.fill();
    ctx.lineWidth = 1.4 * size; ctx.strokeStyle = color; ctx.stroke();
    drawIcon(ctx, item.glyph || 'event', 0, 0, 7.5 * size, color);
    if (item.progress > 0 && item.progress < 0.999) {
      ctx.beginPath();
      ctx.arc(0, 0, 7.5 * size, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * item.progress);
      ctx.lineWidth = 1.6 * size; ctx.strokeStyle = color; ctx.stroke();
    }
  }
}

/**
 * The presenters' world-space overlays (flood plains, a closed road) on the
 * minimap and the full map, under the markers; the context already maps
 * world x/z to canvas (as for paintBridge), `px` canvas px per metre.
 */
export function paintMapEvents(ctx, mapEvents, { nowMs = 0, px = 1, presenters = MAP_EVENT_PRESENTERS } = {}) {
  if (!ctx || !mapEvents?.events?.length) return;
  for (const e of mapEvents.events) {
    const presenter = mapEventPresenter(e.id, presenters);
    if (typeof presenter?.paintMap !== 'function') continue;
    ctx.save();
    try { presenter.paintMap(ctx, e, { nowMs, px }); } finally { ctx.restore(); }
  }
}

/**
 * World marker models (WorldMarkers unit kinds 'event' / 'event-point'):
 * the event hexagon edge-clamped with "<SHORT> · 12 S · 240 M" and the
 * points within MAP_EVENT_POINT_MARKER_M the viewer's team may use.
 */
export function mapEventMarkerModels(cq, { self, selfTeam, projector, insets = undefined, nowMs = 0, presenters = MAP_EVENT_PRESENTERS } = {}) {
  if (!projector || !self || !Number.isFinite(self.x)) return [];
  const out = [];
  for (const e of cq?.mapEvents?.events ?? []) {
    if (!LIVE_PHASES.has(e.phase)) continue;
    const p = mapEventPoint(e, cq);
    if (!p) continue;
    const y = Number.isFinite(p.y) ? p.y : self.y;
    const s = clampToEdge(projector.project(p.x, y + 4, p.z), projector.width, projector.height, insets);
    if (!s) continue;
    const distance = Math.round(Math.hypot(p.x - self.x, y - self.y, p.z - self.z));
    const seconds = Number.isFinite(e.leftMs) && (e.phase === 'warning' || e.phase === 'armed') ? Math.ceil(e.leftMs / 1000) : null;
    let model = { kind: 'event', id: `event:${e.id}`, glyph: mapEventGlyph(e.def), tone: mapEventTone(e.def, e.phase, e.team, selfTeam),
      name: seconds != null ? `${e.def.short} · ${seconds} S` : e.def.short, distance, phase: e.phase, ...s };
    const presenter = mapEventPresenter(e.id, presenters);
    if (typeof presenter?.marker === 'function') model = presenter.marker(model, e, { nowMs, selfTeam }) ?? model;
    if (model) out.push(model);
  }
  for (const pt of cq?.mapEvents?.points ?? []) {
    if (!selfTeam || !pt.teams.includes(selfTeam)) continue;
    const distance = Math.hypot(pt.x - self.x, (pt.y ?? self.y) - self.y, pt.z - self.z);
    if (distance > MAP_EVENT_POINT_MARKER_M) continue;
    const q = projector.project(pt.x, (pt.y ?? self.y) + 1.4, pt.z);
    if (!q.inside) continue;
    out.push({ kind: 'event-point', id: `point:${pt.event}:${pt.index}`, glyph: pt.glyph, tone: pt.userTeam && pt.userTeam !== selfTeam ? 'enemy' : 'hazard',
      name: pt.verb, distance: Math.round(distance), progress: pt.progress, x: q.x, y: q.y, edge: false, angle: 0 });
  }
  return out;
}
