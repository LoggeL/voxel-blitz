// Diegetic titan cockpit HUD (docs/titanfall.md §7.2, §8.1; concepts docs/design/titanfall/cockpit/diegetic/,
// chosen C "corner pods" with A's glass cluster). In the first-person cockpit no flat DOM panel floats over the
// cabin: every titan readout lives inside it.
//
//   glass   a projection on the viewport glass, camera-locked at the aim point and pixel-aligned (one canvas
//           texel per drawn pixel): reticle, hull / shield / doom arc, ammo with charge or heat, dash pips,
//           hit markers, lock / rider / battery / OOB warnings, the eject prompt and toasts
//   pods    four armoured screens on the hatch struts (weapon, core + level badge, dash + hull, abilities +
//           smoke with their rebinding-aware key labels) and a kill feed screen on the right pillar
//   brow    a segmented display on the brow strut: the attrition score bar and the match clock
//
// Every value comes from the titan-ui HUD model (titan-hud-state.js titanHudModel, published by titan-ui.js
// each frame through publishCockpitHud), the same object the DOM HUD paints; without a fresh one (capture
// pages) the cockpit's own titanModel(row). The stock pieces (crosshair position, hit marker, kill feed rows,
// career badge) are read from their DOM nodes, which stay the source and are only hidden (titanfall.css,
// body[data-titanfall-cockpit]). titan-ui.js hides the DOM titan HUD only while a cockpit drew this HUD
// (cockpitHudLive) from the own titan's first-person seat; chase, on foot, embark, eject and spectating keep
// the DOM HUD.
//
// Cost: three extra draws (pods, brow, glass) plus the kill feed screen (four), a few hundred triangles; the
// canvases redraw only when their quantised inputs change (pods ≤ 15 Hz, brow and feed ≤ 4 Hz but a new kill
// feed row at once, glass ≤ 20 Hz but a hit marker, alert or toast at once); the steady state allocates
// nothing. Built by titan-cockpit.js (makeTitanCockpit) and placed by its view-model pass (pods, brow, feed
// sway with the cabin; phone portrait darkens the pods and the feed, the glass carries what matters there).
import * as THREE from '../vendor/three.module.js';
import { TITAN_CHASSIS } from '../../../shared/titan-contract.js';

/** Tuning (presentation only). */
export const COCKPIT_HUD = Object.freeze({
  podHz: 15,          // pod canvas redraws per second at most (gauges ≥ 10 Hz)
  browHz: 4,          // score / clock / kill feed screen (a new feed row redraws at once)
  glassHz: 20,        // glass projection (a hit marker, alert or toast redraws at once)
  liveMs: 400,        // the DOM titan HUD stays hidden while a cockpit drew this HUD this recently
  modelMs: 600,       // a published HUD model older than this falls back to the cockpit row
  glassDepth: 0.98,   // eye metres: behind the hatch ring face, so the struts and pods cover the projection
  portraitAspect: 0.8, // phone portrait: pods and feed dark (the touch layout owns the console band)
  toastMs: 1600,      // an ability-ready toast on the glass
  // Own primary shots (titan-weapon-feel.js): the reticle opens by bloom × these pixels and closes
  // with this time constant; a doom confirm holds the kill mark this long.
  bloom: Object.freeze({ ring: 14, gap: 16, tau: 0.09 }),
  confirmMs: 650,
});

/** Programs of the HUD meshes (titan-cockpit.js adds them to TITAN_COCKPIT_WARMUP_MATERIALS). */
export const COCKPIT_HUD_WARMUP_MATERIALS = Object.freeze(['titan-cockpit-hud-pods', 'titan-cockpit-hud-panels', 'titan-cockpit-hud-glass']);

const FONT = "'Rajdhani', 'Bahnschrift', 'Arial Narrow', 'Roboto Condensed', sans-serif";
const INK = Object.freeze({
  bg: '#04080b', dim: '#1d2a33', rule: '#173341', white: '#eef6fb', sub: '#9fb3c0', ok: '#7fe07a', shield: '#4fc3ff',
  amber: '#ffab2e', danger: '#ff3b4f', shadow: 'rgba(2,6,9,0.82)', glassDim: 'rgba(170,200,215,0.32)',
  alpha: '#38bdf8', bravo: '#fb923c',
});
const ACCENT = Object.freeze({ titan_ion: '#62d6ff', titan_scorch: '#ffa24a', titan_northstar: '#8ff5e6', titan_ronin: '#aab6ff', titan_legion: '#dfe76c' });

// ---------------------------------------------------------------------------------- shared state

const now = () => globalThis.performance?.now?.() ?? Date.now();
const shared = { model: null, keys: {}, at: -Infinity, shownAt: -Infinity, stock: null };

/** titan-ui.js, every frame: the painted HUD model (titanHudModel) and the key labels; null clears. */
export function publishCockpitHud(model, keys = null, atMs = now()) {
  shared.model = model ?? null;
  if (keys) shared.keys = keys;
  shared.at = model ? atMs : -Infinity;
}
/** Key labels (bindingLabel, rebinding-aware) the cockpit MFDs print. */
export const cockpitHudKeys = () => shared.keys;
/** True while a titan cockpit drew its diegetic HUD within COCKPIT_HUD.liveMs (titan-ui hides the DOM titan HUD). */
export const cockpitHudLive = (atMs = now()) => atMs - shared.shownAt <= COCKPIT_HUD.liveMs;
/** Test and capture hook: replace the stock DOM reader ({ aim(out), hit(), feedKey(), feed(rows), badge() }), null restores it. */
export function setCockpitHudStock(source) { shared.stock = source ?? null; }
/** Clears the published model and the live flag (titan-ui dispose). */
export function resetCockpitHud() { shared.model = null; shared.keys = {}; shared.at = -Infinity; shared.shownAt = -Infinity; }

// ---------------------------------------------------------------------------------- stock DOM reader

/** Reads the stock HUD nodes the cockpit replaces; no allocation unless a node changed. */
function domStock() {
  const refs = { ch: null, hm: null, kf: null, badge: null, at: -Infinity };
  const cache = { left: null, top: null, gap: null, x: 0.5, y: 0.5, g: 6, kfFirst: null, kfCount: -1, kfKey: 0, badgeAt: -Infinity, badge: '' };
  const doc = () => globalThis.document ?? null;
  const refresh = () => {
    const t = now();
    if (t - refs.at < 1000 && (!refs.ch || refs.ch.isConnected !== false)) return;
    refs.at = t;
    const d = doc();
    refs.ch = d?.getElementById?.('crosshair') ?? null;
    refs.hm = d?.getElementById?.('hitmarker') ?? null;
    refs.kf = d?.getElementById?.('killfeed') ?? null;
    refs.badge = d?.querySelector?.('.vb-career-badge') ?? null;
  };
  const text = node => (node?.textContent ?? '').trim().toUpperCase();
  return {
    aim(out) {
      refresh();
      const ch = refs.ch, style = ch?.style;
      const left = style?.left || '', top = style?.top || '';
      if (left !== cache.left) { cache.left = left; const v = parseFloat(left); cache.x = Number.isFinite(v) ? v / 100 : 0.5; }
      if (top !== cache.top) { cache.top = top; const v = parseFloat(top); cache.y = Number.isFinite(v) ? v / 100 : 0.5; }
      const gap = style?.getPropertyValue?.('--gap') || '';
      if (gap !== cache.gap) { cache.gap = gap; const v = parseFloat(gap); cache.g = Number.isFinite(v) ? v : 6; }
      out.x = cache.x; out.y = cache.y; out.gap = cache.g;
      out.hidden = !!ch && (style?.opacity === '0' || !!ch.classList?.contains?.('vb-dead'));
      return out;
    },
    /** 0 none, 1 body, 2 head, 3 armour, 4 kill. */
    hit() {
      const list = refs.hm?.classList;
      if (!list?.contains?.('vb-show')) return 0;
      // Conquest HUD vehicle hits: vb-armor-hit (effective, armour mark) and vb-armor-spark (no effect, plain).
      return list.contains('vb-kill') ? 4 : list.contains('vb-hs') ? 2 : list.contains('vb-armor-hit') || list.contains('vb-armor') ? 3 : 1;
    },
    /** Changes whenever a kill feed row is added or removed. */
    feedKey() {
      const kf = refs.kf;
      const first = kf?.firstElementChild ?? null, count = kf?.childElementCount ?? 0;
      if (first !== cache.kfFirst || count !== cache.kfCount) { cache.kfFirst = first; cache.kfCount = count; cache.kfKey++; }
      return cache.kfKey;
    },
    /** The feed rows, newest first: { killer, victim, weapon, marker }. */
    feed(rows) {
      rows.length = 0;
      const kf = refs.kf;
      if (!kf) return rows;
      for (const row of kf.children ?? []) {
        if (rows.length >= 6) break;
        const cls = row.className ?? '';
        if (cls.includes?.('kf-body-found')) continue;
        const vehicle = cls.includes?.('kf-vehicle-destroyed');
        const kids = [...(row.children ?? [])];
        const killer = text(kids.find(k => k.tagName === 'B'));
        const weapon = text(row.querySelector?.('.kf-weapon-name'));
        const victimNode = [...kids].reverse().find(k => k.tagName === 'SPAN' && !String(k.className ?? '').includes('kf-weapon'));
        const marker = kids.filter(k => k.tagName === 'EM').map(text).join(' · ');
        rows.push({ killer: killer || (vehicle ? '' : '?'), victim: text(victimNode), weapon: vehicle ? `${weapon}` : weapon, marker, vehicle });
      }
      return rows;
    },
    badge() {
      refresh();
      const t = now();
      if (t - cache.badgeAt > 1000) { cache.badgeAt = t; cache.badge = text(refs.badge); }
      return cache.badge;
    },
  };
}
const defaultStock = domStock();
const stock = () => shared.stock ?? defaultStock;

// ---------------------------------------------------------------------------------- change detection

/** Field-by-field signature of quantised inputs (no allocation for small ints and existing strings). */
class Sig {
  constructor() { this.v = []; this.i = 0; this.changed = false; }
  begin() { this.i = 0; this.changed = false; return this; }
  p(x) { if (this.v[this.i] !== x) { this.v[this.i] = x; this.changed = true; } this.i++; return this; }
  end() { if (this.v.length !== this.i) { this.v.length = this.i; this.changed = true; } return this.changed; }
}
const q = (x, n = 100) => Math.round((Number.isFinite(x) ? x : 0) * n);

// ---------------------------------------------------------------------------------- canvas helpers

const fonts = new Map();
function font(size, weight = 700) {
  const key = size * 10 + weight / 100;
  let value = fonts.get(key);
  if (!value) { value = `${weight} ${size}px ${FONT}`; fonts.set(key, value); }
  return value;
}
/** Text with a dark outline (legible over sky, smoke and fire). */
function say(g, value, x, y, size, color, align = 'left', weight = 700, outline = true) {
  if (value == null || value === '') return;
  g.font = font(size, weight); g.textAlign = align; g.textBaseline = 'middle';
  if (outline) { g.lineJoin = 'round'; g.lineWidth = Math.max(3, size * 0.2); g.strokeStyle = INK.shadow; g.strokeText?.(value, x, y); }
  g.fillStyle = color; g.fillText(value, x, y);
}
const widthOf = (g, value, size, weight = 700) => {
  g.font = font(size, weight);
  const w = g.measureText?.(value)?.width;
  return Number.isFinite(w) ? w : String(value).length * size * 0.52;
};
/** A key chip: an outlined box with the key label. */
function chip(g, value, x, y, size, color = INK.white, align = 'left') {
  if (!value) return 0;
  const w = Math.max(size * 1.2, widthOf(g, value, size) + size * 0.6), h = size * 1.35;
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  g.fillStyle = 'rgba(4,8,11,0.75)'; g.fillRect(x0, y - h / 2, w, h);
  g.strokeStyle = color; g.lineWidth = Math.max(1.5, size * 0.09); g.strokeRect(x0, y - h / 2, w, h);
  say(g, value, x0 + w / 2, y + size * 0.04, size, color, 'center', 700, false);
  return w;
}
function cells(g, x, y, w, h, frac, color, count, dim = INK.dim, gap = 3) {
  const cw = w / count;
  for (let i = 0; i < count; i++) {
    g.fillStyle = (i + 0.5) / count <= frac ? color : dim;
    g.fillRect(x + i * cw, y, cw - gap, h);
  }
}
function arcStroke(g, cx, cy, r, a0, a1, width, color) {
  g.lineCap = 'butt';
  g.beginPath(); g.arc(cx, cy, r, a0, a1, a1 < a0); g.lineWidth = width; g.strokeStyle = color; g.stroke();
}
function chevron(g, x, y, s, fill, color) {
  const path = () => { g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.55, y - s); g.lineTo(x + s * 1.25, y); g.lineTo(x + s * 0.55, y + s); g.lineTo(x, y + s); g.lineTo(x + s * 0.7, y); g.closePath(); };
  path(); g.fillStyle = INK.dim; g.fill();
  if (fill > 0) { g.save(); g.beginPath(); g.rect(x, y - s, s * 1.25 * fill, s * 2); g.clip(); path(); g.fillStyle = color; g.fill(); g.restore(); }
}
const hullColor = s => (s.doomed ? INK.danger : s.hpFrac > 0.5 ? INK.ok : s.hpFrac > 0.25 ? INK.amber : INK.danger);
const chargeLabel = (type, w) => (w?.charge > 0 ? (type === 'titan_legion' ? (w.charge >= 1 ? 'SPUN UP' : 'SPIN') : w.charge >= 1 ? 'CHARGED' : 'CHARGE')
  : type === 'titan_scorch' ? 'THERMAL' : 'HEAT');
/** Charge / spin arc colour: building amber, full white-cyan (ready to fire); heat goes red near the top. */
const chargeColor = w => ((w?.charge ?? 0) > 0 ? ((w.charge >= 1) ? '#c8f4ff' : INK.amber) : (w?.heat ?? 0) > 0.85 ? INK.danger : INK.amber);
const firstWords = label => { const words = String(label ?? '').toUpperCase().split(/\s+/).filter(Boolean); return [words[0] ?? '', words.slice(1).join(' ')]; };
const teamInk = team => (team === 'bravo' ? INK.bravo : INK.alpha);

// ---------------------------------------------------------------------------------- atlases

/** Pod atlas (1024 x 528): four 512 x 256 pods and a white strip (bezel colour) at the bottom. */
const POD_ATLAS = Object.freeze({ width: 1024, height: 528, white: [8, 516, 1008, 8] });
const POD = Object.freeze({ weapon: [0, 0, 512, 256], core: [512, 0, 512, 256], status: [0, 256, 512, 256], abilities: [512, 256, 512, 256] });
/** Panel atlas (1024 x 592): the brow score display, the kill feed screen and the white strip. */
const PANEL_ATLAS = Object.freeze({ width: 1024, height: 592, white: [520, 580, 496, 8] });
const PANEL = Object.freeze({ score: [0, 0, 1024, 120], feed: [0, 128, 448, 448] });
const regionUv = (atlas, [x, y, w, h]) => [x / atlas.width, 1 - (y + h) / atlas.height, (x + w) / atlas.width, 1 - y / atlas.height];
const whiteUv = atlas => { const [x, y, w, h] = atlas.white; return [(x + w / 2) / atlas.width, 1 - (y + h / 2) / atlas.height]; };

/** A screen panel: dark face, scanlines and a soft frame around `draw(w, h)`. */
function panel(g, [x, y, w, h], doomed, draw) {
  g.save(); g.translate(x, y);
  g.fillStyle = INK.bg; g.fillRect(0, 0, w, h);
  g.beginPath(); g.rect(0, 0, w, h); g.clip();
  draw(w, h);
  g.fillStyle = 'rgba(0,0,0,0.16)';
  for (let k = 0; k < h; k += 4) g.fillRect(0, k, w, 1);
  g.strokeStyle = doomed ? '#5a1018' : '#16394a'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
  g.restore();
}

function drawWeaponPod(g, v, ink) {
  const s = v.titan, w = s?.weapon;
  panel(g, POD.weapon, s?.doomed, (W, H) => {
    say(g, 'WEAPON', 24, 30, 24, ink, 'left', 700, false);
    if (!s) { say(g, 'STANDBY', 24, 130, 40, INK.sub, 'left', 700, false); return; }
    say(g, w?.label ?? 'ARMAMENT', 24, 72, 36, INK.white, 'left', 700, false);
    const reloading = (w?.reload ?? 0) > 0 && w?.ammo === 0;
    const low = w?.magazine && w.ammo != null && w.ammo <= Math.max(1, Math.round(w.magazine * 0.22));
    const ammo = reloading ? 'RELOAD' : w?.ammoText ?? '∞';
    say(g, ammo, 24, 150, reloading ? 52 : 96, reloading ? INK.amber : low ? INK.amber : INK.white, 'left', 700, false);
    if (!reloading && w?.magazine) say(g, `/ ${w.magazine}`, 34 + widthOf(g, ammo, 96), 166, 34, INK.sub, 'left', 600, false);
    const count = Math.max(4, Math.min(24, w?.magazine ?? 16));
    cells(g, 236, 128, W - 260, 30, reloading ? w.reload : w?.frac ?? 1, reloading ? INK.amber : INK.shield, count);
    const heat = Math.max(w?.charge ?? 0, w?.heat ?? 0);
    if (heat > 0) {
      say(g, chargeLabel(v.type, w), 236, 186, 22, INK.sub, 'left', 700, false);
      cells(g, 236, 202, W - 260, 22, heat, heat > 0.85 ? INK.danger : INK.amber, 20);
    }
  });
}

function drawCorePod(g, v, ink, t) {
  const s = v.titan, c = s?.core;
  panel(g, POD.core, s?.doomed, (W, H) => {
    const cx = 122, cy = 128, r = 86;
    arcStroke(g, cx, cy, r, 0, Math.PI * 2, 16, INK.dim);
    const color = c?.active ? INK.white : c?.ready ? (Math.floor(t * 4) % 2 ? INK.amber : '#ffe2a8') : INK.amber;
    if (c) arcStroke(g, cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (c.active ? 1 : c.frac), 16, color);
    say(g, c?.active ? 'ON' : `${c?.pct ?? 0}%`, cx, cy + 4, 48, c?.ready || c?.active ? INK.amber : INK.white, 'center', 700, false);
    say(g, 'CORE', 236, 38, 26, ink, 'left', 700, false);
    say(g, c?.label ?? 'CORE', 236, 82, 30, INK.white, 'left', 700, false);
    const keyW = v.touch ? 0 : chip(g, c?.key, 236, 136, 34, c?.ready ? INK.amber : INK.white);
    say(g, c?.active ? 'ACTIVE' : c?.ready ? 'READY' : 'CHARGING', 236 + (keyW ? keyW + 14 : 0), 138, 28, c?.ready || c?.active ? INK.amber : INK.sub, 'left', 700, false);
    if (v.badge) { g.fillStyle = '#0c1820'; g.fillRect(228, 184, W - 248, 46); say(g, v.badge, 240, 208, 24, INK.sub, 'left', 700, false); }
  });
}

function drawStatusPod(g, v, ink, t) {
  const s = v.titan;
  panel(g, POD.status, s?.doomed, (W, H) => {
    say(g, 'DASH', 24, 36, 26, ink, 'left', 700, false);
    if (!v.touch) chip(g, s?.dash?.key, 96, 36, 22);
    (s?.dash?.cells ?? []).forEach((fill, i) => chevron(g, W - 70 - ((s.dash.cells.length - 1 - i) * 62), 36, 22, fill, INK.shield));
    if (!s) return;
    if (s.doomed) {
      const alarm = Math.floor(t * 3) % 2 === 0;
      say(g, 'DOOMED', 24, 98, 50, alarm ? INK.danger : '#ff8899', 'left', 700, false);
      cells(g, 24, 130, W - 48, 26, s.doomFrac, INK.danger, 14);
      say(g, v.touch ? 'TAP EJECT ×3' : `PRESS ${s.eject?.key ?? 'X'} ×3 · EJECT`, 24, 196, 32, INK.white, 'left', 700, false);
      if (s.eject?.taps) say(g, `${s.eject.taps}/3`, W - 24, 196, 32, INK.amber, 'right', 700, false);
      return;
    }
    const hull = hullColor(s);
    say(g, 'HULL', 24, 94, 24, INK.white, 'left', 600, false);
    say(g, s.healthText, W - 24, 94, 32, hull, 'right', 700, false);
    cells(g, 24, 114, W - 48, 26, s.hpFrac, hull, 16);
    say(g, 'SHIELD', 24, 176, 24, INK.white, 'left', 600, false);
    say(g, String(Math.ceil(s.shield)), W - 24, 176, 32, INK.shield, 'right', 700, false);
    cells(g, 24, 196, W - 48, 18, s.shieldMax > 0 ? s.shield / s.shieldMax : 0, INK.shield, 16);
  });
}

function drawAbilityPod(g, v) {
  const s = v.titan;
  panel(g, POD.abilities, s?.doomed, (W, H) => {
    (s?.abilities ?? []).forEach((slot, i) => {
      const x = 14 + i * 128, y = 16, w = 118, h = H - 32;
      const ready = slot.state === 'ready', active = slot.state === 'active';
      g.fillStyle = '#0b161d'; g.fillRect(x, y, w, h);
      g.fillStyle = ready ? 'rgba(255,171,46,0.30)' : active ? 'rgba(79,195,255,0.38)' : 'rgba(79,195,255,0.20)';
      g.fillRect(x, y + h * (1 - slot.ready), w, h * slot.ready);
      g.strokeStyle = ready ? INK.amber : active ? INK.shield : '#2a3a44'; g.lineWidth = 4; g.strokeRect(x + 2, y + 2, w - 4, h - 4);
      if (!v.touch) chip(g, slot.key, x + w / 2, y + 34, 34, ready ? INK.amber : INK.white, 'center');
      const [a, b] = firstWords(slot.label);
      say(g, a, x + w / 2, y + (v.touch ? 50 : 96), 22, INK.white, 'center', 700, false);
      say(g, b, x + w / 2, y + (v.touch ? 76 : 122), 20, INK.sub, 'center', 600, false);
      say(g, ready ? 'READY' : active ? 'ON' : `${slot.readyPct}%`, x + w / 2, y + h - 30, 32, ready ? INK.amber : active ? INK.shield : INK.white, 'center', 700, false);
    });
    const sx = 404, sm = s?.smoke;
    say(g, 'SMOKE', sx + 48, 34, 22, INK.white, 'center', 700, false);
    if (!v.touch) chip(g, sm?.key, sx + 48, 76, 28, (sm?.charges ?? 0) > 0 ? INK.amber : INK.sub, 'center');
    for (let i = 0; i < (sm?.max ?? 0); i++) {
      g.fillStyle = sm.active && i === sm.charges ? INK.shield : i < sm.charges ? INK.amber : INK.dim;
      g.fillRect(sx + 22, 116 + i * 40, 52, 30);
    }
  });
}

function drawScore(g, v, t) {
  const top = v.top;
  panel(g, PANEL.score, false, (W, H) => {
    if (!top) { say(g, 'ATTRITION', W / 2, H / 2, 40, INK.sub, 'center', 700, false); return; }
    const own = teamInk(top.own.team), enemy = teamInk(top.enemy.team);
    say(g, top.own.label, 26, 40, 30, own, 'left', 700, false);
    say(g, String(top.own.score), 380, 40, 52, own, 'right', 700, false);
    cells(g, 26, 78, 354, 18, top.own.frac, own, 24);
    say(g, top.enemy.label, W - 26, 40, 30, enemy, 'right', 700, false);
    say(g, String(top.enemy.score), W - 380, 40, 52, enemy, 'left', 700, false);
    g.save(); g.translate(W - 26, 0); g.scale(-1, 1); cells(g, 0, 78, 354, 18, top.enemy.frac, enemy, 24); g.restore();
    const urgent = top.urgent && Math.floor(t * 2) % 2 === 0;
    say(g, top.clock, W / 2, 46, 64, top.urgent ? (urgent ? INK.danger : '#ff8899') : INK.white, 'center', 700, false);
    say(g, `/ ${top.limit}`, W / 2, 96, 22, INK.sub, 'center', 600, false);
  });
}

function drawFeed(g, rows, ink) {
  panel(g, PANEL.feed, false, (W, H) => {
    say(g, 'KILL FEED', 22, 30, 26, ink, 'left', 700, false);
    g.fillStyle = INK.rule; g.fillRect(22, 52, W - 44, 3);
    if (!rows.length) { say(g, 'NO CONTACTS', 22, 100, 26, INK.dim, 'left', 700, false); return; }
    rows.forEach((row, i) => {
      const y = 92 + i * 62;
      if (i % 2 === 0) { g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(14, y - 30, W - 28, 60); }
      let x = 22;
      if (row.killer) { say(g, row.killer, x, y - 8, 30, INK.white, 'left', 700, false); x += widthOf(g, row.killer, 30) + 10; }
      say(g, '›', x, y - 10, 34, ink, 'left', 700, false); x += 22;
      say(g, row.victim || '—', x, y - 8, 30, row.vehicle ? INK.amber : '#ffb3bd', 'left', 700, false);
      say(g, row.weapon, 22, y + 20, 19, INK.sub, 'left', 600, false);
      if (row.marker) say(g, row.marker, W - 22, y + 20, 19, INK.amber, 'right', 700, false);
    });
  });
}

// ---------------------------------------------------------------------------------- glass layout

/** Glass box in layout units around the aim point (x right, y down): the canvas covers it. */
const GLASS = Object.freeze({ left: 330, right: 330, top: 350, bottom: 220, design: 1000, narrow: 620, minUnit: 0.45, maxUnit: 1.6 });
const ARC = Object.freeze({ cy: -62, hull: 190, shield: 172, from: Math.PI / 2 + 0.66, sweep: -1.32, segments: 20 });
const RING = 92;

function drawGlass(g, v, a, t) {
  const s = v.titan, U = a.unit, k = a.textScale;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, a.width, a.height);
  if (!s) return;
  g.setTransform(U, 0, 0, U, a.ox, a.oy);
  const ink = ACCENT[v.type] ?? '#62d6ff';
  const line = (x0, y0, x1, y1, width, color) => {
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineWidth = width + 3; g.strokeStyle = INK.shadow; g.stroke();
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineWidth = width; g.strokeStyle = color; g.stroke();
  };
  // Reticle: four ring arcs, the cross with the weapon spread gap, a centre dot.
  if (!a.aimHidden) {
    // An own shot blooms the reticle open and brightens it (a.bloom 0..1, COCKPIT_HUD.bloom).
    const B = COCKPIT_HUD.bloom, ring = RING + a.bloom * B.ring;
    for (let k = 0; k < 4; k++) {
      const c = k * Math.PI / 2 + Math.PI / 4;
      arcStroke(g, 0, 0, ring, c - 0.5, c + 0.5, 5, INK.shadow);
      arcStroke(g, 0, 0, ring, c - 0.5, c + 0.5, 2.2 + a.bloom * 1.6, a.bloom > 0.15 ? '#ffe2a8' : 'rgba(255,171,46,0.85)');
    }
    const gap = Math.max(4, Math.min(40 + B.gap, a.gap / U + a.bloom * B.gap));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) line(dx * gap, dy * gap, dx * (gap + 14), dy * (gap + 14), 3, INK.amber);
    g.fillStyle = INK.amber; g.fillRect(-1.5, -1.5, 3, 3);
  }
  // Hit marker (stock #hitmarker: body, head, armour, kill).
  if (a.hit) {
    const kill = a.hit === 4, color = kill ? INK.danger : a.hit === 2 ? INK.amber : a.hit === 3 ? INK.shield : INK.white;
    const r0 = kill ? 12 : 16, r1 = kill ? 38 : 30;
    for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) line(dx * r0 * 0.707, dy * r0 * 0.707, dx * r1 * 0.707, dy * r1 * 0.707, kill ? 5 : 3.5, color);
  }
  // Hull (outer) and shield (inner) arc under the reticle; doomed: the hull band is the red doom countdown.
  const lit = (frac, i) => (i + 0.5) / ARC.segments <= frac;
  const hullFrac = s.doomed ? s.doomFrac : s.hpFrac, hull = hullColor(s), alarm = Math.floor(t * 3) % 2 === 0;
  const shieldFrac = s.shieldMax > 0 ? s.shield / s.shieldMax : 0;
  for (let i = 0; i < ARC.segments; i++) {
    const a0 = ARC.from + ARC.sweep * (i / ARC.segments) - 0.008, a1 = ARC.from + ARC.sweep * ((i + 1) / ARC.segments) + 0.008;
    arcStroke(g, 0, ARC.cy, ARC.hull, a0, a1, 22, INK.shadow);
    arcStroke(g, 0, ARC.cy, ARC.hull, a0, a1, 16, lit(hullFrac, i) ? (s.doomed && !alarm ? '#7a1a22' : hull) : 'rgba(40,58,68,0.7)');
    arcStroke(g, 0, ARC.cy, ARC.shield, a0, a1, 12, INK.shadow);
    arcStroke(g, 0, ARC.cy, ARC.shield, a0, a1, 7, lit(shieldFrac, i) ? INK.shield : 'rgba(40,58,68,0.55)');
  }
  const below = ARC.cy + ARC.hull + (a.portrait ? 20 : 26);
  if (a.portrait && s.shield > 0) {
    // Phone portrait: the lower strut sits close under the arc, so hull and shield share one line.
    say(g, s.healthText, -6, below, 26 * k, s.doomed ? INK.danger : INK.white, 'right');
    say(g, `SHIELD ${Math.ceil(s.shield)}`, 6, below, 19 * k, INK.shield, 'left');
  } else {
    say(g, s.healthText, 0, below, 28 * k, s.doomed ? INK.danger : INK.white, 'center');
    if (s.shield > 0) say(g, `SHIELD ${Math.ceil(s.shield)}`, 0, below + 24 * k, 19 * k, INK.shield, 'center');
  }
  // Ammo (right of the reticle): count, magazine column, charge / heat arc.
  const w = s.weapon;
  if (w) {
    const reloading = (w.reload ?? 0) > 0 && w.ammo === 0;
    const low = w.magazine && w.ammo != null && w.ammo <= Math.max(1, Math.round(w.magazine * 0.22));
    const count = Math.max(4, Math.min(24, w.magazine ?? 16)), h = 104, ch = h / count;
    for (let i = 0; i < count; i++) {
      const on = (i + 0.5) / count <= (reloading ? w.reload : w.frac);
      g.fillStyle = INK.shadow; g.fillRect(126, 52 - (i + 1) * ch - 1, 14, ch + 1);
      g.fillStyle = on ? (reloading ? INK.amber : low ? INK.amber : INK.shield) : 'rgba(40,58,68,0.7)';
      g.fillRect(128, 52 - (i + 1) * ch + 1, 10, ch - 2);
    }
    const ammo = reloading ? 'RELOAD' : w.ammoText;
    say(g, ammo, 152, -6, (reloading ? 30 : 54) * k, reloading || low ? INK.amber : INK.white, 'left');
    if (!reloading && w.magazine) say(g, `/ ${w.magazine}`, 154, 34 * k, 20 * k, INK.sub, 'left');
    const heat = Math.max(w.charge ?? 0, w.heat ?? 0);
    if (heat > 0) {
      arcStroke(g, 0, 0, RING + 13, 0.62, -0.62, 10, INK.shadow);
      arcStroke(g, 0, 0, RING + 13, 0.62, 0.62 - 1.24 * heat, w.charge >= 1 ? 8 : 6, chargeColor(w));
      say(g, chargeLabel(v.type, w), 150, 70, 15, w.charge >= 1 ? '#c8f4ff' : INK.amber, 'left');
    }
  }
  // Dash pips (left of the reticle) with the key.
  const pips = s.dash?.cells ?? [];
  pips.forEach((fill, i) => {
    const x = -176 - (pips.length - 1 - i) * 38;
    g.save(); g.translate(x, 0);
    g.beginPath(); g.moveTo(-2, -22); g.lineTo(18, -22); g.lineTo(40, 0); g.lineTo(18, 22); g.lineTo(-2, 22); g.lineTo(18, 0); g.closePath();
    g.lineWidth = 5; g.strokeStyle = INK.shadow; g.stroke();
    g.fillStyle = fill >= 1 ? ink : 'rgba(40,58,68,0.7)'; g.fill();
    g.restore();
  });
  if (!v.touch && s.dash?.key) say(g, s.dash.key, -160 - (pips.length - 1) * 19, 42, 16, INK.sub, 'center');
  // Core cue and lock above the reticle.
  const c = s.core, squeezed = (a.portrait || a.short) && s.doomed;   // phone doom block takes the core line
  if (squeezed) { /* the doom block */ } else if (c?.active) say(g, 'CORE ONLINE', 0, -150, 26 * k, INK.amber, 'center');
  else if (c?.ready) {
    const pulse = Math.floor(t * 2) % 2 === 0;
    say(g, v.touch ? 'CORE READY' : `CORE READY · ${c.key}`, 0, -150, 28 * k, pulse ? INK.amber : '#ffe2a8', 'center');
  } else if (a.portrait && c) say(g, `CORE ${c.pct}%`, 0, -150, 22 * k, INK.sub, 'center');
  if (s.lock && s.lock.state < 3) {
    const color = s.lock.state === 2 ? INK.danger : INK.amber;
    say(g, s.lock.label, 0, -118, 22 * k, color, 'center');
    line(-130, -118, -78, -118, 2.5, color); line(78, -118, 130, -118, 2.5, color);
  }
  // Alert band at the top of the glass: eject prompt, missile, rider, battery, OOB, toasts.
  const alert = a.alert, dy = a.portrait ? 44 : a.short ? 26 : 0;   // portrait / phone landscape: the strut sits lower
  if (s.doomed) {
    const dy = a.portrait || a.short ? 80 : 0;
    say(g, 'DOOMED', 0, -292 + dy, 46 * k, alarm ? INK.danger : '#ff8899', 'center');
    for (let i = 0; i < 7; i++) {
      g.fillStyle = INK.shadow; g.fillRect(-133 + i * 38 - 2, -264 + dy, 34, 16);
      g.fillStyle = (i + 0.5) / 7 <= s.doomFrac ? INK.danger : 'rgba(40,58,68,0.7)'; g.fillRect(-133 + i * 38, -262 + dy, 30, 12);
    }
    const prompt = v.touch ? 'TAP EJECT ×3' : `PRESS ${s.eject?.key ?? 'X'} ×3 · EJECT`;
    say(g, prompt, 0, -230 + dy, 28 * k, INK.white, 'center');
    if (s.eject?.taps) say(g, `${s.eject.taps}/3`, widthOf(g, prompt, 28 * k) / 2 + 34 * k, -230 + dy, 28 * k, INK.amber, 'center');
  } else if (alert.text) {
    const color = alert.kind === 'danger' ? (alarm ? INK.danger : '#ff8899') : INK.amber;
    const half = widthOf(g, alert.text, 32 * k) / 2;
    say(g, alert.text, 0, -250 + dy, 32 * k, color, 'center');
    if (half + 110 < GLASS.right) { line(-half - 110, -250 + dy, -half - 22, -250 + dy, 2.5, color); line(half + 22, -250 + dy, half + 110, -250 + dy, 2.5, color); }
  }
  // Phone portrait: the pods and the feed screen go dark (the touch buttons carry the abilities, the brow the score),
  // so the newest kill feed row rides the top of the glass.
  const kill = a.feedTop;
  if (a.portrait && kill && !s.doomed) {
    const size = 21 * k, y = -238, killer = kill.killer ?? '', victim = kill.victim || '—';
    const wk = killer ? widthOf(g, killer, size) + 8 * k : 0, wa = widthOf(g, '›', size) + 8 * k, wv = widthOf(g, victim, size);
    let x = -(wk + wa + wv) / 2;
    if (killer) { say(g, killer, x, y, size, INK.white, 'left'); x += wk; }
    say(g, '›', x, y, size, ink, 'left'); x += wa;
    say(g, victim, x, y, size, kill.vehicle ? INK.amber : '#ffb3bd', 'left');
  }
}

/** Alert of the moment: { text, kind } (doom has its own block). */
function pickAlert(v, toast, out) {
  const s = v.titan;
  out.text = ''; out.kind = 'info';
  if (!s || s.doomed) return out;
  if (s.lock?.state === 3) { out.text = s.lock.label; out.kind = 'danger'; }
  else if (v.rider) { out.text = v.rider; out.kind = 'danger'; }
  else if (s.batteryOut) { out.text = 'BATTERY STOLEN'; out.kind = 'danger'; }
  else if (v.oob) { out.text = v.oob; out.kind = 'danger'; }
  else if (v.toast) out.text = v.toast;
  else if (toast) out.text = toast;
  return out;
}

// ---------------------------------------------------------------------------------- geometry

/** Panel placement per frame class: [u, v, distance] in 16:9 cockpit NDC; widths in NDC (heights follow the region). */
const LAYOUT = Object.freeze({
  atlas: { weapon: [-0.775, 0.73, 0.6], core: [0.775, 0.73, 0.6], status: [-0.775, -0.7, 0.62], abilities: [0.775, -0.7, 0.62],
    feed: [0.805, 0.08, 0.66], score: [0, 0.9, 0.64] },
  ogre: { weapon: [-0.775, 0.72, 0.58], core: [0.775, 0.72, 0.58], status: [-0.775, -0.7, 0.6], abilities: [0.775, -0.7, 0.6],
    feed: [0.805, 0.04, 0.64], score: [0, 0.87, 0.6] },
  stryder: { weapon: [-0.78, 0.735, 0.6], core: [0.78, 0.735, 0.6], status: [-0.78, -0.7, 0.62], abilities: [0.78, -0.7, 0.62],
    feed: [0.81, 0.06, 0.66], score: [0, 0.915, 0.64] },
});
const WIDTH = Object.freeze({ pod: 0.29, feed: 0.26, score: 0.6 });
const TAN = Object.freeze({ v: Math.tan(THREE.MathUtils.degToRad(75 / 2)) });
const tanH169 = TAN.v * 16 / 9;
const SHADE = new THREE.Vector3(0.25, 0.8, 0.55).normalize();
const TILT = 0.3;
const HOUSING = 0x3e454e, BEZEL = 0x15191d, RIM = 0x5d6671, BOLT = 0x9aa3ad, ARM = 0x343a42;

class PanelKit {
  constructor(atlas) { this.atlas = atlas; this.pos = []; this.uv = []; this.col = []; this.white = whiteUv(atlas); }
  _push(geometry, color, uvRegion = null) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv, c = new THREE.Color(color);
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      if (uvRegion) {
        const [u0, v0, u1, v1] = uvRegion;
        this.uv.push(u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
        this.col.push(1, 1, 1);
      } else {
        const k = n ? 0.55 + 0.45 * Math.max(0, n.getX(i) * SHADE.x + n.getY(i) * SHADE.y + n.getZ(i) * SHADE.z) : 1;
        this.uv.push(this.white[0], this.white[1]);
        this.col.push(c.r * k, c.g * k, c.b * k);
      }
    }
    if (g !== geometry) g.dispose();
    geometry.dispose();
  }
  box(center, size, basis, color) {
    const g = new THREE.BoxGeometry(...size);
    g.applyMatrix4(new THREE.Matrix4().makeBasis(...basis).setPosition(center));
    this._push(g, color);
  }
  bar(a, b, width, color) {
    const len = a.distanceTo(b);
    if (len < 1e-4) return;
    const g = new THREE.BoxGeometry(width, len, width);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    this._push(g, color);
  }
  screen(center, w, h, basis, region) {
    const g = new THREE.PlaneGeometry(w, h);
    g.applyMatrix4(new THREE.Matrix4().makeBasis(...basis).setPosition(center));
    this._push(g, 0xffffff, regionUv(this.atlas, region));
  }
  /** A bolted screen housing facing the eye at 16:9 NDC (u, v), `d` metres out, `nw` NDC wide; arm toward `anchor`. */
  mount(u, v, d, nw, region, anchor) {
    const center = new THREE.Vector3(u * tanH169 * d, v * TAN.v * d, -d);
    // Mostly square to the view axis (a face turned fully to the eye stretches at the wide cockpit FOV), tilted a little toward the seat.
    const normal = center.clone().negate().normalize().multiplyScalar(TILT).add(new THREE.Vector3(0, 0, 1 - TILT)).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), normal).normalize();
    const up = new THREE.Vector3().crossVectors(normal, right);
    const basis = [right, up, normal];
    const w = nw * tanH169 * d, h = w * region[3] / region[2];
    const at = (x, y, z) => center.clone().addScaledVector(right, x).addScaledVector(up, y).addScaledVector(normal, z);
    if (anchor) this.bar(at(0, 0, -0.03), new THREE.Vector3(...anchor), 0.035, ARM);
    this.box(at(0, 0, -0.022), [w + 0.05, h + 0.05, 0.036], basis, HOUSING);
    this.box(at(0, 0, -0.002), [w + 0.022, h + 0.022, 0.01], basis, BEZEL);
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) this.box(at(sx * (w / 2 + 0.017), sy * (h / 2 + 0.017), 0), [0.012, 0.012, 0.01], basis, BOLT);
    this.box(at(0, h / 2 + 0.019, 0.001), [w * 0.4, 0.006, 0.006], basis, RIM);
    this.screen(at(0, 0, 0.004), w, h, basis, region);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Eye-space geometry of the pods, the brow display and the kill feed screen for a frame class. */
export function cockpitHudGeometry(type, cabin) {
  const chassis = TITAN_CHASSIS[type] ?? 'atlas', L = LAYOUT[chassis] ?? LAYOUT.atlas;
  const W = cabin?.W ?? 1.36, R = cabin?.R ?? 0.82, D = cabin?.D ?? 1.05, F = cabin?.F ?? -1.45;
  const pods = new PanelKit(POD_ATLAS), brow = new PanelKit(PANEL_ATLAS), feed = new PanelKit(PANEL_ATLAS);
  const side = (u, v) => [Math.sign(u) * (W - 0.02), v > 0 ? R - 0.04 : F + 0.62, -D + 0.12];
  for (const name of ['weapon', 'core', 'status', 'abilities']) {
    const [u, v, d] = L[name];
    pods.mount(u, v, d, WIDTH.pod, POD[name], side(u, v));
  }
  { const [u, v, d] = L.feed; feed.mount(u, v, d, WIDTH.feed, PANEL.feed, [W - 0.02, v * 0.3, -D + 0.1]); }
  {
    const [u, v, d] = L.score;
    brow.mount(u, v, d, WIDTH.score, PANEL.score, null);
    const y = v * TAN.v * d;
    for (const s of [-1, 1]) brow.bar(new THREE.Vector3(s * WIDTH.score * tanH169 * d * 0.36, y + 0.02, -d - 0.02), new THREE.Vector3(s * 0.32, R, -d - 0.02), 0.03, ARM);
  }
  return { pods: pods.build(), brow: brow.build(), feed: feed.build() };
}

// ---------------------------------------------------------------------------------- the HUD

function canvasTexture(width, height, { mipmaps = true } = {}) {
  const canvas = globalThis.document?.createElement?.('canvas');
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || typeof ctx.fillRect !== 'function' || typeof ctx.arc !== 'function' || typeof ctx.fillText !== 'function') return null;
  canvas.width = width; canvas.height = height;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (mipmaps) texture.anisotropy = 4;
  else { texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; }
  return { canvas, ctx, texture };
}

/**
 * The diegetic HUD of one titan cockpit: { meshes (cabin-placed, swayed), glass (camera-locked), update(rowModel, now, row),
 * dispose, debug }. `nearDepth(material)` puts a material into the cockpit's depth slice; `group` + `eye` locate the seat
 * eye (the glass hides from cameras away from it, as the cabin does).
 */
export function createCockpitHud({ type, cabin = null, group, eye, nearDepth = m => m, eyeTolerance = 2.5 }) {
  const geometry = cockpitHudGeometry(type, cabin);
  const ink = ACCENT[type] ?? '#62d6ff';
  const podTex = canvasTexture(POD_ATLAS.width, POD_ATLAS.height), panelTex = canvasTexture(PANEL_ATLAS.width, PANEL_ATLAS.height);
  for (const t of [podTex, panelTex]) if (t) { t.ctx.fillStyle = '#ffffff'; t.ctx.fillRect(0, t.canvas.height - 16, t.canvas.width, 16); }
  let glassTex = canvasTexture(8, 8, { mipmaps: false });
  if (glassTex) { glassTex.texture.premultiplyAlpha = true; glassTex.texture.name = 'titan-cockpit-hud-glass'; }
  const basic = (name, map, extra = {}) => nearDepth(new THREE.MeshBasicMaterial({ name, map: map ?? null, vertexColors: true, toneMapped: false, ...extra }));
  const materials = {
    pods: basic('titan-cockpit-hud-pods', podTex?.texture),
    panels: basic('titan-cockpit-hud-panels', panelTex?.texture),
    glass: nearDepth(new THREE.MeshBasicMaterial({ name: 'titan-cockpit-hud-glass', map: glassTex?.texture ?? null, transparent: true,
      depthWrite: false, toneMapped: false, premultipliedAlpha: true, opacity: glassTex ? 1 : 0 })),
  };
  const mesh = (name, geo, material, portraitDark) => {
    const m = new THREE.Mesh(geo, material);
    m.name = `cockpit-overlay-${type}-hud-${name}`;
    m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
    m.userData.portraitDark = portraitDark;
    return m;
  };
  const meshes = [mesh('pods', geometry.pods, materials.pods, true), mesh('brow', geometry.brow, materials.panels, false),
    mesh('feed', geometry.feed, materials.panels, true)];
  const quad = new THREE.PlaneGeometry(2, 2);
  const glass = mesh('glass', quad, materials.glass, false);
  glass.renderOrder = 5;

  // Glass placement: camera-locked at the aim point, pixel aligned, in the cockpit's depth slice.
  const g = {
    aim: { x: 0.5, y: 0.5, gap: 6, hidden: false }, bufferW: 0, bufferH: 0, unit: 1, width: 8, height: 8, ox: 4, oy: 4,
    portrait: false, hit: 0, alert: { text: '', kind: 'info' }, aimHidden: false, gap: 6, textScale: 1, feedTop: null, short: false,
    bloom: 0, bloomAt: 0, confirmUntil: -Infinity,
    eye: new THREE.Vector3(), cam: new THREE.Vector3(), size: new THREE.Vector2(), m: new THREE.Matrix4(), t: new THREE.Matrix4(),
  };
  const placeGlass = (renderer, camera) => {
    g.eye.set(eye[0], eye[1], eye[2]).applyMatrix4(group.matrixWorld);
    g.cam.setFromMatrixPosition(camera.matrixWorld);
    if (!camera.isPerspectiveCamera || g.cam.distanceTo(g.eye) > eyeTolerance) { glass.matrixWorld.makeScale(0, 0, 0); return; }
    shared.shownAt = now();
    const target = renderer?.getRenderTarget?.();
    if (target) g.size.set(target.width, target.height); else renderer?.getDrawingBufferSize?.(g.size);
    if (!(g.size.x > 0 && g.size.y > 0)) g.size.set(1920, 1080);
    g.bufferW = g.size.x; g.bufferH = g.size.y;
    const portrait = camera.aspect < COCKPIT_HUD.portraitAspect, flip = portrait !== g.portrait;
    g.portrait = portrait;
    // A new buffer size (first draw, resize, render scale) re-lays the glass before this draw.
    if (resizeGlass() || flip) redrawGlass(state.lastT, true);
    // Pixel rect of the canvas (one texel per pixel), the aim point at (ox, oy) inside it.
    const ax = Math.round(g.aim.x * g.bufferW), ay = Math.round(g.aim.y * g.bufferH);
    const left = ax - Math.round(g.ox), top = ay - Math.round(g.oy);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1), tanH = tanV * camera.aspect, d = COCKPIT_HUD.glassDepth;
    const cx = ((left + g.width / 2) / g.bufferW) * 2 - 1, cy = 1 - ((top + g.height / 2) / g.bufferH) * 2;
    const hx = g.width / g.bufferW, hy = g.height / g.bufferH;
    g.t.makeScale(hx * tanH * d, hy * tanV * d, 1).setPosition(cx * tanH * d, cy * tanV * d, -d);
    glass.matrixWorld.multiplyMatrices(camera.matrixWorld, g.t);
  };
  glass.onBeforeRender = (renderer, scene, camera) => placeGlass(renderer, camera);

  // Live state: signatures per region and canvas.
  const sig = { weapon: new Sig(), core: new Sig(), status: new Sig(), abilities: new Sig(), score: new Sig(), feed: new Sig(), glass: new Sig() };
  const view = { type, titan: null, top: null, rider: null, oob: null, toast: null, touch: false, badge: '' };
  const state = { lastT: 0, podAt: -Infinity, panelAt: -Infinity, glassAt: -Infinity, feedKey: -1, feedRows: [], slots: [null, null, null], coreReady: false,
    toast: null, toastUntil: 0, draws: { pods: 0, panels: 0, glass: 0 } };

  const resolve = (rowModel, t) => {
    const pub = shared.model;
    const fresh = !!pub && now() - shared.at <= COCKPIT_HUD.modelMs && pub.layout === 'titan' && pub.titan?.type === type;
    view.titan = fresh ? pub.titan : rowModel ?? null;
    view.top = pub?.top ?? null;
    view.rider = fresh ? pub.rider ?? null : rowModel?.rider ? 'ENEMY PILOT ON BOARD' : null;
    view.oob = fresh ? pub.oob?.label ?? null : null;
    view.toast = fresh ? pub.toast ?? null : null;
    view.touch = fresh ? !!pub.touch : false;
  };
  const edgeToasts = t => {
    const s = view.titan;
    if (!s) return;
    s.abilities?.forEach((slot, i) => {
      const before = state.slots[i];
      if (before === 'cooling' && slot.state === 'ready') { state.toast = `${slot.label} READY`; state.toastUntil = t + COCKPIT_HUD.toastMs / 1000; }
      state.slots[i] = slot.state;
    });
    if (state.toast && t > state.toastUntil) state.toast = null;
  };

  const redrawPods = (t, force) => {
    const s = view.titan, w = s?.weapon, c = s?.core, blink = Math.floor(t * 4) % 2, doomBlink = Math.floor(t * 3) % 2;
    let dirty = false;
    if (sig.weapon.begin().p(w?.label).p(w?.ammoText).p(q(w?.frac)).p(q(w?.reload)).p(q(w?.charge)).p(q(w?.heat)).p(!!s).p(!!s?.doomed).end() || force) { drawWeaponPod(podTex.ctx, view, ink); dirty = true; }
    if (sig.core.begin().p(c?.pct).p(!!c?.ready).p(!!c?.active).p(c?.ready ? blink : 0).p(c?.key).p(c?.label).p(view.badge).p(view.touch).p(!!s?.doomed).end() || force) { drawCorePod(podTex.ctx, view, ink, t); dirty = true; }
    if (sig.status.begin().p(!!s?.doomed).p(s?.doomed ? doomBlink : 0).p(q(s?.doomFrac)).p(s?.healthText).p(q(s?.hpFrac, 16)).p(Math.ceil(s?.shield ?? 0))
      .p(q(s?.dash?.cells?.[0], 20)).p(q(s?.dash?.cells?.[1], 20)).p(q(s?.dash?.cells?.[2], 20)).p(s?.dash?.key).p(s?.eject?.taps ?? 0).p(s?.eject?.key).p(view.touch).end() || force) {
      drawStatusPod(podTex.ctx, view, ink, t); dirty = true;
    }
    const ab = s?.abilities;
    if (sig.abilities.begin().p(ab?.length ?? 0).p(ab?.[0]?.readyPct).p(ab?.[0]?.state).p(ab?.[0]?.key).p(ab?.[1]?.readyPct).p(ab?.[1]?.state).p(ab?.[1]?.key)
      .p(ab?.[2]?.readyPct).p(ab?.[2]?.state).p(ab?.[2]?.key).p(s?.smoke?.charges).p(!!s?.smoke?.active).p(s?.smoke?.key).p(view.touch).p(!!s?.doomed).end() || force) {
      drawAbilityPod(podTex.ctx, view); dirty = true;
    }
    if (dirty) { podTex.texture.needsUpdate = true; state.draws.pods++; }
  };
  const redrawPanels = (t, force) => {
    let dirty = false;
    const top = view.top;
    if (sig.score.begin().p(top?.own?.score).p(top?.enemy?.score).p(top?.clock).p(top?.own?.team).p(top?.limit).p(q(top?.own?.frac, 24)).p(q(top?.enemy?.frac, 24))
      .p(top?.urgent ? Math.floor(t * 2) % 2 : -1).end() || force) { drawScore(panelTex.ctx, view, t); dirty = true; }
    const key = stock().feedKey?.() ?? 0;
    if (key !== state.feedKey || force) {
      state.feedKey = key;
      stock().feed?.(state.feedRows);
      drawFeed(panelTex.ctx, state.feedRows, ink); dirty = true;
    }
    if (dirty) { panelTex.texture.needsUpdate = true; state.draws.panels++; }
  };
  const resizeGlass = () => {
    // Layout units in CSS pixels (legible at every DPR), drawn at buffer pixels (crisp); short phones get a floor and bigger text.
    const ratio = g.bufferH / (globalThis.innerHeight > 0 ? globalThis.innerHeight : g.bufferH);
    const cssW = g.bufferW / ratio, cssH = g.bufferH / ratio, narrow = cssW < cssH;
    const unitCss = Math.max(GLASS.minUnit, Math.min(GLASS.maxUnit, cssH / GLASS.design, cssW / (narrow ? GLASS.narrow : GLASS.design * 1.2)));
    const u = Math.max(0.2, Math.round(unitCss * ratio * 32) / 32);
    g.textScale = Math.min(1.3, Math.max(1, 0.6 / unitCss));
    g.short = !narrow && cssH < 500;   // phone landscape: the brow strut reaches lower into the glass
    const width = Math.min(g.bufferW, Math.ceil((GLASS.left + GLASS.right) * u)), height = Math.min(g.bufferH, Math.ceil((GLASS.top + GLASS.bottom) * u));
    if (u === g.unit && width === g.width && height === g.height) return false;
    g.unit = u; g.width = width; g.height = height; g.ox = Math.round(width / 2); g.oy = Math.round(GLASS.top * u);
    const next = canvasTexture(width, height, { mipmaps: false });
    if (next) {
      next.texture.premultiplyAlpha = true; next.texture.name = 'titan-cockpit-hud-glass';
      glassTex?.texture.dispose();
      glassTex = next; materials.glass.map = next.texture;
    }
    return true;
  };
  const redrawGlass = (t, force) => {
    if (!glassTex) return;
    const st = stock();
    st.aim?.(g.aim);
    g.aimHidden = !!g.aim.hidden; g.gap = g.aim.gap; g.feedTop = state.feedRows[0] ?? null;
    // A doom confirm (confirm()) holds the kill mark over whatever the stock marker shows.
    const hit = t < g.confirmUntil ? 4 : st.hit?.() ?? 0;
    g.bloom *= Math.exp(-Math.max(0, t - g.bloomAt) / COCKPIT_HUD.bloom.tau);
    g.bloomAt = t;
    if (g.bloom < 0.03) g.bloom = 0;
    pickAlert(view, state.toast, g.alert);
    const s = view.titan, w = s?.weapon, c = s?.core;
    const resized = g.bufferW > 0 && resizeGlass();
    const urgent = hit !== g.hit;
    g.hit = hit;
    const changed = sig.glass.begin().p(!!s).p(g.hit).p(g.aimHidden).p(q(g.bloom, 12)).p(Math.round(g.gap)).p(g.alert.text).p(g.alert.kind === 'danger' ? Math.floor(t * 3) % 2 : -1)
      .p(s?.healthText).p(q(s?.hpFrac, 20)).p(q(s?.shieldMax > 0 ? s.shield / s.shieldMax : 0, 20)).p(Math.ceil(s?.shield ?? 0))
      .p(!!s?.doomed).p(s?.doomed ? Math.floor(t * 3) % 2 : -1).p(q(s?.doomFrac, 20)).p(s?.eject?.taps ?? 0).p(s?.eject?.key)
      .p(w?.ammoText).p(q(w?.frac, 48)).p(q(w?.reload, 48)).p(q(Math.max(w?.charge ?? 0, w?.heat ?? 0), 40))
      .p(q(s?.dash?.cells?.[0], 1)).p(q(s?.dash?.cells?.[1], 1)).p(q(s?.dash?.cells?.[2], 1)).p(s?.dash?.key)
      .p(!!c?.ready).p(!!c?.active).p(c?.ready ? Math.floor(t * 2) % 2 : -1).p(c?.key).p(g.portrait ? c?.pct : -1).p(g.portrait)
      .p(s?.lock?.state ?? 0).p(view.touch).p(g.portrait ? state.feedKey : -1).end();
    if (!changed && !resized && !force) return;
    if (!urgent && !resized && !force && t - state.glassAt < 1 / COCKPIT_HUD.glassHz && g.alert.kind !== 'danger') {
      sig.glass.v.length = 0;   // retry next frame (rate cap)
      return;
    }
    state.glassAt = t;
    drawGlass(glassTex.ctx, view, g, t);
    glassTex.texture.needsUpdate = true; state.draws.glass++;
  };

  let first = true;
  return {
    meshes, glass, materials,
    /** Per frame while the cockpit is shown: the cockpit's row model (titanModel), now (s), the presented row. */
    update(rowModel, t, row = null) {
      state.lastT = t;
      resolve(rowModel, t);
      view.badge = stock().badge?.() ?? '';
      edgeToasts(t);
      if (podTex && (first || t - state.podAt >= 1 / COCKPIT_HUD.podHz)) { state.podAt = t; redrawPods(t, first); }
      if (panelTex) {
        const feedChanged = (stock().feedKey?.() ?? 0) !== state.feedKey;
        if (first || feedChanged || t - state.panelAt >= 1 / COCKPIT_HUD.browHz) { state.panelAt = t; redrawPanels(t, first); }
      }
      redrawGlass(t, first);
      first = false;
      void row;
    },
    /** An own primary shot: bloom (0..1) opens the reticle; the glass redraws at once. */
    shot(bloom = 0) {
      if (!(bloom > 0)) return;
      g.bloom = Math.min(1, Math.max(g.bloom, bloom));
      g.bloomAt = state.lastT;
      redrawGlass(state.lastT, true);
    },
    /** An enemy titan doomed by the own shots: the kill mark and a toast. */
    confirm(label = 'TITAN DOOMED') {
      g.confirmUntil = state.lastT + COCKPIT_HUD.confirmMs / 1000;
      state.toast = label; state.toastUntil = state.lastT + COCKPIT_HUD.toastMs / 1000;
      redrawGlass(state.lastT, true);
    },
    /** Test hook: what the HUD shows and how often it redrew. */
    debug: () => ({ view, glass: { unit: g.unit, width: g.width, height: g.height, alert: g.alert.text, hit: g.hit, aim: { ...g.aim } },
      feed: state.feedRows.slice(), draws: { ...state.draws }, canvases: { pods: podTex?.canvas ?? null, panels: panelTex?.canvas ?? null, glass: glassTex?.canvas ?? null } }),
    dispose() {
      for (const m of [...meshes, glass]) { m.removeFromParent(); m.geometry.dispose(); }
      for (const m of Object.values(materials)) m.dispose();
      podTex?.texture.dispose(); panelTex?.texture.dispose(); glassTex?.texture.dispose();
    },
  };
}
