/** Circular, heading-up minimap with a rotating compass ring (bottom left). */
import { el } from '../hud-support.js';
import { minimapPlacement } from '../conquest-hud-state.js';
import { imageReady, overviewImage, paintFlag, paintUnit, paintVectorBase, sortItems } from './map-painter.js';

export const MINIMAP_RANGE_M = 170;

export class Minimap {
  constructor(parent, { onOpen = null } = {}) {
    this.root = el('div', 'cq-minimap', parent);
    this.root.setAttribute('role', 'img');
    this.root.setAttribute('aria-label', 'Minimap: flags, squad, team, spotted enemies and vehicles around you');
    this.canvas = el('canvas', 'cq-minimap-canvas', this.root);
    this.ring = el('div', 'cq-minimap-ring', this.root);
    this.compass = {};
    for (const dir of ['N', 'E', 'S', 'W']) {
      const n = el('span', `cq-compass cq-compass-${dir}`, this.ring);
      n.textContent = dir;
      this.compass[dir] = n;
    }
    this.context = this.canvas.getContext?.('2d') ?? null;
    this.image = overviewImage();
    if (onOpen) this.root.addEventListener('click', () => onOpen());
    this._px = 0;
  }

  _resize() {
    const css = this.root.clientWidth || 184;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (px !== this._px) { this._px = px; this.canvas.width = px; this.canvas.height = px; }
    return { css, px, dpr };
  }

  /** items: mapItems(); center: self position; yaw: view yaw. */
  draw({ items = [], center = null, yaw = 0, size = { x: 768, z: 768 }, meta = null, rangeM = MINIMAP_RANGE_M, nowMs = 0 } = {}) {
    const ctx = this.context;
    if (!ctx || !center) return;
    const { css, px } = this._resize();
    const R = px / 2;
    const s = R / rangeM;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R - 1, 0, Math.PI * 2); ctx.clip();
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const a = s * c, b = s * sn, cc = -s * sn, d = s * c;
    ctx.setTransform(a, b, cc, d, R - (a * center.x + cc * center.z), R - (b * center.x + d * center.z));
    paintVectorBase(ctx, meta, (x, z) => ({ x, y: z }), 1);
    if (imageReady(this.image)) {
      ctx.globalAlpha = 0.92;
      ctx.drawImage(this.image, 0, 0, size.x, size.z);
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Range rings for scale.
    ctx.strokeStyle = '#ffffff1c'; ctx.lineWidth = 1;
    for (const f of [0.5, 1]) { ctx.beginPath(); ctx.arc(R, R, (R - 2) * f, 0, Math.PI * 2); ctx.stroke(); }
    const scale = px / css;
    const pulse = (Math.sin(nowMs / 160) + 1) * 0.75;
    for (const item of sortItems(items)) {
      const p = minimapPlacement(item, center, yaw, s);
      const pos = { x: R + p.x, y: R + p.y };
      if (item.kind === 'flag') {
        // Flags past the rim stay pinned to the edge so direction is always readable.
        const dist = Math.hypot(p.x, p.y), max = R - 12 * scale;
        if (dist > max) { pos.x = R + p.x / dist * max; pos.y = R + p.y / dist * max; }
        paintFlag(ctx, item, pos, dist > max ? 0 : item.radius * s, { letterSize: 10 * scale, pulse: item.contested ? pulse : 0 });
      } else if (item.kind === 'hq') {
        const dist = Math.hypot(p.x, p.y);
        if (dist > R - 10 * scale) continue;
        paintUnit(ctx, item, pos, 0, 0.8 * scale);
      } else {
        if (Math.hypot(p.x, p.y) > R - 4 * scale) continue;
        paintUnit(ctx, item, pos, item.kind === 'self' ? 0 : -p.heading, scale);
      }
    }
    ctx.restore();
    // Compass letters ride the rim opposite the rotation.
    const rim = css / 2 + 1;
    for (const [dir, angle] of [['N', 0], ['E', -Math.PI / 2], ['S', Math.PI], ['W', Math.PI / 2]]) {
      // World direction at yaw `angle` relative to the view: screen bearing = angle - yaw (left positive).
      const bearing = angle - yaw;
      const x = -Math.sin(bearing) * rim, y = -Math.cos(bearing) * rim;
      this.compass[dir].style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
}
