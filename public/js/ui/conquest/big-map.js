/**
 * North-up full map (M) and the deploy map. Draws the whole battlefield with
 * flag zones, HQs, squad, team, spotted enemies, vehicles and optional deploy
 * spawn points (selectable by pointer).
 */
import { el } from '../hud-support.js';
import { CQ_COLORS } from '../conquest-hud-state.js';
import { drawIcon } from './icons.js';
import { imageReady, overviewImage, paintFlag, paintUnit, paintVectorBase, sortItems, toneColor } from './map-painter.js';

/** Flag name size on the north-up maps, in CSS px (scaled down from the max on small maps). */
const LABEL_MIN_PX = 8;
const LABEL_MAX_PX = 11;
/** Below this map size (phone landscape deploy) names only clutter the spawn markers; the spawn list names flags. */
const LABEL_MIN_MAP_PX = 220;

export class NorthUpMap {
  constructor(parent, className = 'cq-northmap', { onPick = null } = {}) {
    this.root = el('div', className, parent);
    this.canvas = el('canvas', 'cq-northmap-canvas', this.root);
    this.context = this.canvas.getContext?.('2d') ?? null;
    this.image = overviewImage();
    this.spawnHits = [];
    this._px = 0;
    if (onPick) {
      this.canvas.addEventListener('pointerdown', event => {
        const rect = this.canvas.getBoundingClientRect?.();
        if (!rect || !rect.width) return;
        const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
        let best = null, bestD = 0.045;
        for (const hit of this.spawnHits) {
          const d = Math.hypot(hit.u - x, hit.v - y);
          if (d < bestD) { bestD = d; best = hit; }
        }
        if (best) { event.preventDefault?.(); onPick(best.spawn); }
      });
    }
  }

  _resize() {
    const css = Math.max(120, Math.min(this.root.clientWidth || 560, this.root.clientHeight || 560));
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (px !== this._px) { this._px = px; this.canvas.width = px; this.canvas.height = px; }
    return { css, px };
  }

  /** Map square → canvas: the full world, with a little margin. */
  draw({ items = [], size = { x: 768, z: 768 }, meta = null, spawns = null, selected = null, nowMs = 0, labels = true } = {}) {
    const ctx = this.context;
    if (!ctx) return;
    const { css, px } = this._resize();
    const scale = px / css;
    const extent = Math.max(size.x, size.z);
    const s = px / extent;
    const toCanvas = (x, z) => ({ x: x * s, y: z * s });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.save();
    ctx.setTransform(s, 0, 0, s, 0, 0);
    paintVectorBase(ctx, meta, (x, z) => ({ x, y: z }), 1);
    if (imageReady(this.image)) ctx.drawImage(this.image, 0, 0, size.x, size.z);
    ctx.restore();
    // Combat area outline.
    const area = meta?.combatArea;
    if (area) {
      const a = toCanvas(area.minX, area.minZ), b = toCanvas(area.maxX, area.maxZ);
      ctx.save(); ctx.setLineDash([6 * scale, 5 * scale]); ctx.strokeStyle = '#ff5b4c88'; ctx.lineWidth = 1.5 * scale;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.restore();
    }
    // Grid.
    ctx.strokeStyle = '#ffffff12'; ctx.lineWidth = 1;
    for (let g = 1; g < 6; g++) {
      const v = px * g / 6;
      ctx.beginPath(); ctx.moveTo(v, 0); ctx.lineTo(v, px); ctx.moveTo(0, v); ctx.lineTo(px, v); ctx.stroke();
    }
    const pulse = (Math.sin(nowMs / 160) + 1) * 0.75;
    const sorted = sortItems(items);
    // Flags and HQs are fixed; hull and spawn badges that land on a flag diamond, an HQ or each other step
    // aside (a short leader line keeps the true spot), so flag letters stay readable.
    const fixed = [];
    const badges = [];
    for (const item of sorted) {
      const c = toCanvas(item.x, item.z);
      if (item.kind === 'flag') fixed.push({ x: c.x, y: c.y, r: 15 * scale });
      else if (item.kind === 'hq') fixed.push({ x: c.x, y: c.y, r: 12 * scale });
      else if (item.kind === 'vehicle') badges.push({ item, x: c.x, y: c.y, ox: c.x, oy: c.y, r: 9.5 * scale });
    }
    const spawnEntries = [];
    for (const spawn of spawns || []) {
      if (!Number.isFinite(spawn.x) || !Number.isFinite(spawn.z)) continue;
      const c = toCanvas(spawn.x, spawn.z);
      const active = selected === spawn.spawn;
      const r = (active ? 17 : 13) * scale;
      spawnEntries.push({ spawn, active, x: c.x, y: c.y, ox: c.x, oy: c.y, r });
      // Flag and HQ spawns are the flag / HQ itself and stay put; squad and hull spawns are badges.
      if (spawn.kind === 'flag' || spawn.kind === 'hq') fixed.push({ x: c.x, y: c.y, r: r + 1 });
    }
    const spawnBadges = spawnEntries.filter(e => e.spawn.kind !== 'flag' && e.spawn.kind !== 'hq');
    // A hull with a spawn badge on it is the same marker twice: the spawn badge replaces it.
    const spawnHulls = new Set(spawnBadges.filter(b => b.spawn.kind === 'vehicle').map(b => String(b.spawn.id)));
    const movable = [...badges.filter(b => !spawnHulls.has(String(b.item.id))), ...spawnBadges];
    declutter(movable, fixed, { px, maxShift: 30 * scale });
    for (const item of sorted) {
      const c = toCanvas(item.x, item.z);
      if (item.kind === 'flag') {
        paintFlag(ctx, item, c, item.radius * s, { letterSize: 15 * scale, pulse: item.contested ? pulse : 0 });
      } else if (item.kind === 'hq') {
        ctx.beginPath(); ctx.arc(c.x, c.y, item.radius * s, 0, Math.PI * 2);
        ctx.fillStyle = `${toneColor(item.rel)}1f`; ctx.fill();
        ctx.setLineDash([4 * scale, 4 * scale]); ctx.strokeStyle = `${toneColor(item.rel)}99`; ctx.lineWidth = 1.5 * scale; ctx.stroke(); ctx.setLineDash([]);
        paintUnit(ctx, item, c, 0, 1.15 * scale);
      } else if (item.kind === 'vehicle') {
        const badge = badges.find(b => b.item === item);
        if (!badge || spawnHulls.has(String(item.id))) continue;
        leader(ctx, badge, scale);
        paintUnit(ctx, item, { x: badge.x, y: badge.y }, item.yaw ?? 0, 1.1 * scale);
      } else {
        paintUnit(ctx, item, c, item.kind === 'self' ? item.yaw : item.yaw ?? 0, 1.1 * scale);
      }
    }
    this.spawnHits = [];
    for (const entry of spawnEntries) {
      const { spawn, active, r } = entry;
      leader(ctx, entry, scale);
      ctx.save();
      ctx.beginPath(); ctx.arc(entry.x, entry.y, r, 0, Math.PI * 2);
      ctx.fillStyle = spawn.ok ? (active ? '#ffd166' : '#0d1a22e8') : '#2a1d1de0';
      ctx.fill();
      ctx.lineWidth = (active ? 3 : 2) * scale;
      ctx.strokeStyle = spawn.ok ? (active ? '#fff7d6' : CQ_COLORS.own) : '#8a5151';
      ctx.stroke();
      const glyph = spawn.kind === 'hq' ? 'hq' : spawn.kind === 'squad' ? 'squad' : spawn.kind === 'vehicle' ? (spawn.type || 'tank') : null;
      if (glyph) drawIcon(ctx, glyph, entry.x, entry.y, r * 1.15, active ? '#101418' : spawn.ok ? CQ_COLORS.own : '#9a7070');
      else {
        ctx.fillStyle = active ? '#101418' : spawn.ok ? CQ_COLORS.own : '#9a7070';
        ctx.font = `800 ${r * 1.1}px "Rajdhani", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(spawn.id, entry.x, entry.y + 1);
      }
      ctx.restore();
      this.spawnHits.push({ spawn: spawn.spawn, u: entry.x / px, v: entry.y / px });
    }
    // Flag names last, on top of every marker: shrunk on small maps (phone deploy / landscape full map), placed
    // below, above or beside the flag where no badge, HQ or other name sits, and on a dark plate.
    if (labels && css >= LABEL_MIN_MAP_PX) {
      const labelPx = Math.max(LABEL_MIN_PX, Math.min(LABEL_MAX_PX, css / 32)) * scale;
      const blockers = [...movable, ...fixed].map(b => ({ left: b.x - b.r, right: b.x + b.r, top: b.y - b.r, bottom: b.y + b.r }));
      const labelRects = [];
      const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      ctx.font = `700 ${labelPx}px "Rajdhani", system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (const item of sorted) {
        if (item.kind !== 'flag' || !item.name) continue;
        const c = toCanvas(item.x, item.z);
        const text = item.name.toUpperCase();
        const w = ctx.measureText(text).width + 8 * scale, h = labelPx * 1.25;
        const gap = Math.max(item.radius * s, 12 * scale) + 5 * scale;
        const inside = r => r.left >= 0 && r.right <= px && r.top >= 0 && r.bottom <= px;
        const at = (cx, top) => { const x = Math.max(w / 2 + 2 * scale, Math.min(px - w / 2 - 2 * scale, cx)); return { x, left: x - w / 2, right: x + w / 2, top, bottom: top + h }; };
        const candidates = [at(c.x, c.y + gap), at(c.x, c.y - gap - h), at(c.x + gap + w / 2, c.y - h / 2), at(c.x - gap - w / 2, c.y - h / 2),
          at(c.x, c.y + gap + 16 * scale), at(c.x, c.y - gap - h - 16 * scale)].filter(inside);
        const clearOfLabels = candidates.filter(r => !labelRects.some(o => hit(r, o)));
        const spot = clearOfLabels.find(r => !blockers.some(o => hit(r, o))) ?? clearOfLabels[0];
        if (!spot) continue;
        labelRects.push(spot);
        ctx.fillStyle = '#081016b8';
        ctx.fillRect(spot.left, spot.top - 1 * scale, w, h);
        ctx.lineWidth = 3 * scale; ctx.strokeStyle = '#081016e0'; ctx.strokeText(text, spot.x, spot.top + 1 * scale);
        ctx.fillStyle = '#eef3f6'; ctx.fillText(text, spot.x, spot.top + 1 * scale);
      }
    }
  }
}

/** A thin line from a displaced badge back to its true map position. */
function leader(ctx, badge, scale) {
  if (Math.hypot(badge.x - badge.ox, badge.y - badge.oy) < 1) return;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(badge.ox, badge.oy); ctx.lineTo(badge.x, badge.y);
  ctx.strokeStyle = '#eef3f6b0'; ctx.lineWidth = 1.2 * scale; ctx.stroke();
  ctx.beginPath(); ctx.arc(badge.ox, badge.oy, 2 * scale, 0, Math.PI * 2); ctx.fillStyle = '#eef3f6'; ctx.fill();
  ctx.restore();
}

/**
 * Push movable badges (circles {x, y, r}) off the fixed markers and off each
 * other, at most `maxShift` px from their true spot and inside the map square.
 * Deterministic: a badge exactly on a marker steps toward the map centre's
 * opposite side (outward), ties broken by list order.
 */
export function declutter(movable, fixed, { px, maxShift = 30, iterations = 24, margin = 2 } = {}) {
  const push = (b, dx, dy, need) => {
    let d = Math.hypot(dx, dy);
    if (d < 1e-3) { const out = Math.atan2(b.oy - px / 2, b.ox - px / 2) || 0; dx = Math.cos(out); dy = Math.sin(out); d = 1; }
    b.x += dx / d * need; b.y += dy / d * need;
  };
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < movable.length; i++) {
      const b = movable[i];
      for (const f of fixed) {
        const need = b.r + f.r + margin - Math.hypot(b.x - f.x, b.y - f.y);
        if (need > 0.25) { push(b, b.x - f.x, b.y - f.y, need); moved = true; }
      }
      for (let j = 0; j < i; j++) {
        const o = movable[j];
        const need = b.r + o.r + margin - Math.hypot(b.x - o.x, b.y - o.y);
        if (need > 0.25) {
          // Split the step, the later badge moving more, so equal spots separate deterministically.
          const dx = b.x - o.x || (i - j), dy = b.y - o.y;
          push(b, dx, dy, need * 0.6); push(o, -dx, -dy, need * 0.4); moved = true;
        }
      }
    }
    for (const b of movable) {
      const dx = b.x - b.ox, dy = b.y - b.oy, d = Math.hypot(dx, dy);
      if (d > maxShift) { b.x = b.ox + dx / d * maxShift; b.y = b.oy + dy / d * maxShift; }
      b.x = Math.max(b.r, Math.min(px - b.r, b.x)); b.y = Math.max(b.r, Math.min(px - b.r, b.y));
    }
    if (!moved) break;
  }
  return movable;
}

/** Full-screen map overlay toggled with the bigMap binding (M) or the touch map button. */
export class BigMap {
  constructor(parent) {
    this.root = el('section', 'cq-bigmap', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Battlefield map');
    const panel = el('div', 'cq-bigmap-panel', this.root);
    const head = el('div', 'cq-bigmap-head', panel);
    el('h2', '', head).textContent = 'BATTLEFIELD';
    this.hint = el('span', 'cq-bigmap-hint', head);
    this.close = el('button', 'cq-bigmap-close', head);
    this.close.type = 'button';
    this.close.textContent = '✕';
    this.close.setAttribute('aria-label', 'Close map');
    this.close.addEventListener('click', () => this.setOpen(false));
    this.map = new NorthUpMap(panel, 'cq-northmap cq-bigmap-map');
    const legend = el('div', 'cq-bigmap-legend', panel);
    for (const [cls, text] of [['own', 'FRIENDLY'], ['squad', 'SQUAD'], ['enemy', 'ENEMY FLAG'], ['spotted', 'SPOTTED'], ['neutral', 'NEUTRAL']]) {
      const item = el('span', `cq-legend cq-legend-${cls}`, legend);
      el('i', '', item);
      el('span', '', item).textContent = text;
    }
    this.open = false;
  }

  setOpen(open) {
    this.open = !!open;
    this.root.hidden = !this.open;
    return this.open;
  }
  toggle() { return this.setOpen(!this.open); }

  draw(args) { if (this.open) this.map.draw(args); }
}
