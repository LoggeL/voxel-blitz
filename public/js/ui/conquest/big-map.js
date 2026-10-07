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
    // Flag names shrink with small maps (phone deploy / landscape full map) and never print over each other:
    // a name that would collide goes above its flag, or is left out (the letter still identifies the flag).
    const labelPx = Math.max(LABEL_MIN_PX, Math.min(LABEL_MAX_PX, css / 32)) * scale;
    const labelRects = [];
    for (const item of sortItems(items)) {
      const c = toCanvas(item.x, item.z);
      if (item.kind === 'flag') {
        paintFlag(ctx, item, c, item.radius * s, { letterSize: 15 * scale, pulse: item.contested ? pulse : 0 });
        if (labels && item.name && css >= LABEL_MIN_MAP_PX) {
          const text = item.name.toUpperCase();
          ctx.font = `700 ${labelPx}px "Rajdhani", system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          const w = ctx.measureText(text).width + 4 * scale, h = labelPx * 1.15;
          const x = Math.max(w / 2 + 2 * scale, Math.min(px - w / 2 - 2 * scale, c.x));
          const gap = item.radius * s + 6 * scale;
          const spot = [c.y + gap, c.y - gap - h].map(y => ({ left: x - w / 2, right: x + w / 2, top: y, bottom: y + h }))
            .find(r => r.top >= 0 && r.bottom <= px && !labelRects.some(o => r.left < o.right && o.left < r.right && r.top < o.bottom && o.top < r.bottom));
          if (spot) {
            labelRects.push(spot);
            ctx.lineWidth = 3 * scale; ctx.strokeStyle = '#081016e0'; ctx.strokeText(text, x, spot.top);
            ctx.fillStyle = '#eef3f6'; ctx.fillText(text, x, spot.top);
          }
        }
      } else if (item.kind === 'hq') {
        ctx.beginPath(); ctx.arc(c.x, c.y, item.radius * s, 0, Math.PI * 2);
        ctx.fillStyle = `${toneColor(item.rel)}1f`; ctx.fill();
        ctx.setLineDash([4 * scale, 4 * scale]); ctx.strokeStyle = `${toneColor(item.rel)}99`; ctx.lineWidth = 1.5 * scale; ctx.stroke(); ctx.setLineDash([]);
        paintUnit(ctx, item, c, 0, 1.15 * scale);
      } else {
        paintUnit(ctx, item, c, item.kind === 'self' ? item.yaw : item.yaw ?? 0, 1.1 * scale);
      }
    }
    this.spawnHits = [];
    for (const spawn of spawns || []) {
      if (!Number.isFinite(spawn.x) || !Number.isFinite(spawn.z)) continue;
      const c = toCanvas(spawn.x, spawn.z);
      const active = selected === spawn.spawn;
      const r = (active ? 17 : 13) * scale;
      ctx.save();
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = spawn.ok ? (active ? '#ffd166' : '#0d1a22e8') : '#2a1d1de0';
      ctx.fill();
      ctx.lineWidth = (active ? 3 : 2) * scale;
      ctx.strokeStyle = spawn.ok ? (active ? '#fff7d6' : CQ_COLORS.own) : '#8a5151';
      ctx.stroke();
      const glyph = spawn.kind === 'hq' ? 'hq' : spawn.kind === 'squad' ? 'squad' : spawn.kind === 'vehicle' ? (spawn.type || 'tank') : null;
      if (glyph) drawIcon(ctx, glyph, c.x, c.y, r * 1.15, active ? '#101418' : spawn.ok ? CQ_COLORS.own : '#9a7070');
      else {
        ctx.fillStyle = active ? '#101418' : spawn.ok ? CQ_COLORS.own : '#9a7070';
        ctx.font = `800 ${r * 1.1}px "Rajdhani", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(spawn.id, c.x, c.y + 1);
      }
      ctx.restore();
      this.spawnHits.push({ spawn: spawn.spawn, u: c.x / px, v: c.y / px });
    }
  }
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
