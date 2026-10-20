/**
 * Flag radars on the HUD (docs/conquest.md "Flag radars"; design
 * docs/design/conquest/radar/, variant A with B's owner map and C's swept
 * state). Reads only the decoded `ev` row (phase, owner `team`, `leftMs` to
 * the next sweep, damage as `progress`) and the server's `map_event` notes
 * (`sweep` {team, ids}, `damaged`); the server decides what a sweep marks.
 *
 *   maps     round the FLAG while a side owns the radar: the 240 m ground
 *            ring, the dashed 400 m air ring and a sweep line that turns once
 *            per sweep (it points north as the sweep fires, then a flash), in
 *            the owner's colour (cyan for the own side, orange for the
 *            enemy's); the hexagon badge at the structure (its arc the sweep
 *            charge), hazard-pulsing while it groans, faded once down
 *   marker   RADAR D · SWEEP 6 S for the owner, RADAR D for the rival,
 *            RADAR D · 2 S while it groans
 *   chip     top right, only in a hull inside an enemy radar's ring: ENEMY
 *            RADAR D / SWEEP IN 6 S with a draining bar, then RADAR · SWEPT
 *            / SPOTTED 5 S (red) while the sweep's mark on that hull lasts
 *   banners  a low-priority ONLINE / ENEMY RADAR on a capture, FAILING with
 *            the groan's countdown, "<NAME> DESTROYED · D LOSES ITS SWEEP";
 *            none for the bridge into the groan (armed) or a neutral flag
 */
import { isAircraftType, isDroneType } from '../../../../../shared/vehicle-defs.js';
import { RADAR_TUNING as T, radarCentre, radarOnline, radarSweepSeconds } from '../../../../../shared/map-events/radar.js';
import { el } from '../../hud-support.js';
import { svgIcon } from '../icons.js';

const COLORS = Object.freeze({ own: '#4cc3ff', enemy: '#ff8a3d', neutral: '#d8d8d8' });
/** The flash round the ring after a sweep fires (presentation only). */
const FLASH_MS = 1200;
/** The sweep line's trailing wedge (radians). */
const WEDGE = Math.PI / 4;
/** A sweep note counts for the row's last sweep when it arrived at most this long before it (snapshot lag). */
const NOTE_SLACK_MS = 1500;
/**
 * The viewer's team as the last map-item pass saw it: paintMap gets no team,
 * and mapItems runs every frame before the minimap and the full map paint.
 */
const viewer = { team: null };
/** The latest sweep note per radar: id -> {atMs, team, ids} (the chip's SWEPT state). */
const sweeps = new Map();
/** The chip of each HUD (one presenter serves every radar id: built once, updated once a frame). */
const chips = new WeakMap();

const sideOf = (team, selfTeam) => (team && selfTeam ? (team === selfTeam ? 'own' : 'enemy') : null);
const siteOf = event => event?.def?.tuning?.site ?? null;
const nameOf = def => String(def?.name ?? 'RADAR').toUpperCase();

/** Forget the sweep notes (a rematch, tests). */
export function resetRadarHud() { sweeps.clear(); viewer.team = null; }

/** The sweep line's angle (canvas radians, north up: -z is -PI/2) from the time left to the next sweep. */
export function radarSweepAngle(event) {
  const left = Number.isFinite(event?.leftMs) ? Math.max(0, Math.min(T.everyMs, event.leftMs)) : T.everyMs;
  return -Math.PI / 2 + (1 - left / T.everyMs) * Math.PI * 2;
}

/**
 * The chip for a viewer in `hull` (a vehicle row {id, type, x, z} or null):
 * the nearest enemy radar whose ring holds the hull. Returns null or
 * {id, state 'wait' | 'swept', head, text, share 0..1}.
 */
export function radarChipModel(cq, selfTeam, hull, nowMs = 0, notes = sweeps) {
  if (!hull || !selfTeam || !Number.isFinite(hull.x)) return null;
  const air = isAircraftType(hull.type) || isDroneType(hull.type);
  let best = null;
  for (const event of cq?.mapEvents?.events ?? []) {
    const site = siteOf(event);
    if (!site || !radarOnline(event) || event.team === selfTeam) continue;
    const c = radarCentre(site);
    const d = c ? Math.hypot(hull.x - c.x, hull.z - c.z) : Infinity;
    if (d > (air ? T.airM : T.groundM) || (best && d >= best.d)) continue;
    best = { d, event, site };
  }
  if (!best) return null;
  const { event, site } = best, note = notes.get(event.id);
  // The time since the last sweep is the row's (authoritative); the note only says whom it caught.
  const age = Number.isFinite(event.leftMs) ? T.everyMs - event.leftMs : Infinity;
  const caught = note && note.team === event.team && note.atMs >= nowMs - age - NOTE_SLACK_MS && note.ids?.includes(String(hull.id));
  const marked = caught ? T.revealMs - age : 0;
  if (marked > 0) {
    return { id: event.id, state: 'swept', head: 'RADAR · SWEPT', text: `SPOTTED ${Math.ceil(marked / 1000)} S`, share: marked / T.revealMs };
  }
  const s = radarSweepSeconds(event) ?? Math.ceil(T.everyMs / 1000);
  return { id: event.id, state: 'wait', head: `ENEMY RADAR ${site.flag}`, text: `SWEEP IN ${s} S`,
    share: Number.isFinite(event.leftMs) ? Math.max(0, Math.min(1, event.leftMs / T.everyMs)) : 1 };
}

/** Paint the rings and the sweep of an owned radar (world metres; `unit` metres per screen px). */
export function paintRadarRings(ctx, event, { nowMs = 0, px = 1, selfTeam = viewer.team } = {}) {
  const site = siteOf(event), c = site ? radarCentre(site) : null;
  if (!c || !radarOnline(event)) return false;
  const unit = 1 / Math.max(1e-6, px), color = COLORS[sideOf(event.team, selfTeam) ?? 'neutral'];
  ctx.beginPath(); ctx.arc(c.x, c.z, T.groundM, 0, Math.PI * 2);
  ctx.fillStyle = `${color}0d`; ctx.fill();
  ctx.lineWidth = 1.6 * unit; ctx.strokeStyle = `${color}b3`; ctx.stroke();
  ctx.beginPath(); ctx.arc(c.x, c.z, T.airM, 0, Math.PI * 2);
  ctx.setLineDash([6 * unit, 5 * unit]); ctx.lineWidth = 1.1 * unit; ctx.strokeStyle = `${color}73`; ctx.stroke(); ctx.setLineDash([]);
  // The sweep line and its fading wedge: one turn per sweep, north as it fires.
  const a = radarSweepAngle(event);
  for (let k = 0; k < 4; k++) {
    const a0 = a - WEDGE * (k + 1) / 4, a1 = a - WEDGE * k / 4;
    ctx.beginPath(); ctx.moveTo(c.x, c.z); ctx.arc(c.x, c.z, T.groundM, a0, a1); ctx.closePath();
    ctx.globalAlpha = 0.42 * (1 - k / 4); ctx.fillStyle = color; ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.moveTo(c.x, c.z); ctx.lineTo(c.x + Math.cos(a) * T.groundM, c.z + Math.sin(a) * T.groundM);
  ctx.lineWidth = 2 * unit; ctx.strokeStyle = color; ctx.stroke();
  const age = Number.isFinite(event.leftMs) ? T.everyMs - event.leftMs : Infinity;
  if (age >= 0 && age < FLASH_MS) {
    const k = age / FLASH_MS;
    ctx.beginPath(); ctx.arc(c.x, c.z, T.groundM, 0, Math.PI * 2);
    ctx.globalAlpha = 1 - k; ctx.lineWidth = (2 + 4 * (1 - k)) * unit; ctx.strokeStyle = color; ctx.stroke(); ctx.globalAlpha = 1;
  }
  void nowMs;
  return true;
}

export const RADAR_PRESENTER = Object.freeze({
  banner(ev, { nowMs = 0, selfTeam, def }, base) {
    if (ev.note === 'sweep') {
      sweeps.set(ev.event, { atMs: nowMs, team: ev.data?.team ?? null, ids: (ev.data?.ids ?? []).map(String) });
      return null;
    }
    const name = nameOf(def);
    if (ev.note === 'damaged') {
      return { key: `event:${ev.event}:damaged`, tone: 'hazard', icon: 'event-radar', title: `${name} · DAMAGED`,
        detail: `${Math.max(0, ev.data?.share | 0)} % LEFT`, priority: 2, holdMs: 2600, event: ev.event };
    }
    if (ev.note) return null;
    // The bridge into the groan (the last blow) and a flag going neutral carry no banner.
    if (ev.phase === 'armed' || ev.phase === 'idle') return null;
    if (!base) return undefined;
    const flag = def?.flag ?? '';
    if (ev.phase === 'active') {
      // A joiner learns the radars from the map, not from a banner per radar.
      if (ev.fromSnapshot) return null;
      const own = sideOf(ev.team, selfTeam) === 'own';
      return { ...base, title: own ? `${name} · ONLINE` : `ENEMY ${name}`, priority: 2, holdMs: 2600 };
    }
    if (ev.phase === 'warning') return { ...base, title: `${name} · FAILING` };
    if (ev.phase === 'done') return { ...base, title: `${name} DESTROYED`, detail: `${flag} LOSES ITS SWEEP`, tone: 'danger' };
    return undefined;
  },

  mapItems(event, cq, selfTeam) {
    viewer.team = selfTeam ?? null;
    const a = event.anchor, site = siteOf(event);
    if (!a || !site) return [];
    const online = radarOnline(event), side = sideOf(event.team, selfTeam);
    const tone = event.phase === 'warning' ? 'hazard' : event.phase === 'done' ? 'danger' : online ? side ?? 'neutral' : 'neutral';
    const charge = online && Number.isFinite(event.leftMs) ? 1 - Math.min(1, event.leftMs / T.everyMs) : 0;
    return [{ kind: 'event', id: event.id, x: a.x, z: a.z, glyph: 'event-radar', label: `RADAR ${site.flag}`, phase: event.phase, tone,
      progress: charge, pulse: event.phase === 'warning' ? (Math.sin((globalThis.performance?.now?.() ?? 0) / 160) + 1) / 2 : 0,
      faded: event.phase === 'done' }];
  },

  paintMap(ctx, event, opts = {}) { paintRadarRings(ctx, event, opts); },

  marker(model, event, ctx) {
    const site = siteOf(event), label = `RADAR ${site?.flag ?? ''}`.trim();
    if (radarOnline(event)) {
      const s = radarSweepSeconds(event), own = sideOf(event.team, ctx?.selfTeam) === 'own';
      return { ...model, name: own && s != null ? `${label} · SWEEP ${s} S` : label, tone: own ? 'own' : 'enemy' };
    }
    if (event.phase === 'warning' && Number.isFinite(event.leftMs)) return { ...model, name: `${label} · ${Math.ceil(event.leftMs / 1000)} S`, tone: 'hazard' };
    return { ...model, name: label };
  },

  /** HUD hook (ConquestHud._render, every frame): the chip of a hull inside an enemy radar's ring. */
  hud({ hud, cq, selfTeam, living, nowMs = 0 }) {
    if (!hud?.root) return;
    let ui = chips.get(hud);
    if (ui && ui.cq === cq && ui.nowMs === nowMs) return;
    if (!ui) {
      const root = el('div', 'cq-radar-chip', hud.root);
      const icon = svgIcon(globalThis.document, 'event-radar', 'vb-cq-icon cq-radar-glyph');
      if (icon) root.appendChild(icon);
      const text = el('div', 'cq-radar-text', root);
      ui = { root, head: el('b', 'cq-radar-head', text), line: el('span', 'cq-radar-line', text), bar: el('i', 'cq-radar-bar', el('span', 'cq-radar-track', text)), key: '' };
      chips.set(hud, ui);
    }
    ui.cq = cq; ui.nowMs = nowMs;
    const model = living ? radarChipModel(cq, selfTeam, hud.seated?.row ?? null, nowMs) : null;
    ui.root.hidden = !model;
    if (!model) return;
    const key = `${model.state}|${model.head}|${model.text}`;
    if (key !== ui.key) {
      ui.key = key;
      ui.root.dataset.state = model.state;
      ui.head.textContent = model.head;
      ui.line.textContent = model.text;
    }
    if (ui.bar.style) ui.bar.style.width = `${Math.round(model.share * 1000) / 10}%`;
  },
});

/** The presenter of every radar id (the HUD registry spreads it into its radar slot). */
export const RADAR_PRESENTERS = Object.freeze({
  'radar-aldric': RADAR_PRESENTER, 'radar-ridge': RADAR_PRESENTER, 'radar-mesa': RADAR_PRESENTER, 'radar-palmera': RADAR_PRESENTER,
});
